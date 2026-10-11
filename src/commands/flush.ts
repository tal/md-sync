// `flush`: hand the request to the running daemon over its socket, or do a one-off commit run.
import { isAbsolute, relative, resolve } from 'node:path';
import { DELIVERY_WAIT_MS, FLUSH_RESULT_WAIT_MS, type FlushRequest, type IpcReply, sendFlush, validateRelPath } from '../ipc';
import { kindAt, realpathOrSame } from '../fsutil';
import { ensureStateDir, realpathLoose, type StatePaths } from '../paths';
import { mergeTriggers } from '../queue';
import { withRepoDefaults } from '../repo-defaults';
import type { WaitMode } from '../types';
import { acquireOneOffLock, type CommandEnv, type DirectLayers, otherStatePaths, reportIssues, resolveTarget,
  stderrLine } from './shared';
import { runOneOff } from './sync-once';

const POLL_MS = 200;
const WAITING_NOTICE_MS = 5_000;
const QUEUED_TIMEOUT_MS = 10_000;

// A path from `relative()` that leaves its base: up out of it, or (another drive) absolute.
function escapesDir(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || isAbsolute(rel);
}

function relInside(realDir: string, abs: string): string | 'outside' | 'the-folder' {
  const rel = relative(realDir, realpathLoose(abs));
  if (rel === '') return 'the-folder';
  if (escapesDir(rel)) return 'outside';
  return validateRelPath(rel) === 'ok' ? rel : 'outside';
}

// Repo-relative POSIX path, or 'outside'. Resolved against cwd. When that lands outside the
// folder, cwd is itself outside it, and nothing exists at the cwd-relative path (`md-sync flush --dir ~/notes
// a.md` from a hook), a relative path is taken as relative to the folder instead. From inside the folder cwd always
// decides, and a file that does exist outside the folder is what the caller meant: rejected, never re-rooted.
export function flushRelPath(p: string, cwd: string, realDir: string): string | 'outside' | 'the-folder' {
  const cwdReal = realpathOrSame(cwd);
  const rel = relInside(realDir, resolve(cwdReal, p));
  if (rel !== 'outside' || isAbsolute(p)) return rel;
  if (!escapesDir(relative(realDir, cwdReal)) || kindAt(resolve(cwdReal, p)) !== 'missing') return 'outside';
  return relInside(realDir, resolve(realDir, p));
}

function describeReplies(replies: readonly IpcReply[], wait: WaitMode): { code: number; message?: string } {
  const err = replies.find((r) => r.type === 'error');
  if (err?.type === 'error') return { code: 1, message: err.error };
  if (wait === 'no-wait') {
    return replies.some((r) => r.type === 'queued') ? { code: 0 } : { code: 1, message: 'daemon closed the connection' };
  }
  const result = replies.find((r) => r.type === 'result');
  if (result?.type !== 'result') return { code: 1, message: 'daemon closed the connection without a result' };
  if (result.outcome === 'ok' || result.outcome === 'conflict-resolved') return { code: 0 };
  return { code: 1, message: `flush failed: ${result.outcome}${result.error !== undefined ? `: ${result.error}` : ''}` };
}

export async function flushCommand(c: CommandEnv): Promise<number> {
  const t = resolveTarget(c);
  if (t.kind === 'exit') return t.code;
  const { realDir, paths, layers } = t.target;

  const rels: string[] = [];
  for (const p of c.paths) {
    const rel = flushRelPath(p, c.cwd, realDir);
    if (rel === 'the-folder') {
      stderrLine(`--path ${p} is the synced folder itself, not a file in it (a flush without paths commits everything)`);
      return 2;
    }
    if (rel === 'outside') {
      stderrLine(`path outside synced folder: ${p}`);
      return 2;
    }
    if (!rels.includes(rel)) rels.push(rel);
  }
  const wait: WaitMode = c.values.wait === true ? 'wait' : 'no-wait';
  const message = c.values.message !== undefined && c.values.message.trim() !== '' ? c.values.message : undefined;
  const req: FlushRequest = { type: 'flush', v: 1, wait,
    ...(message !== undefined ? { message } : {}), ...(rels.length > 0 ? { paths: rels } : {}) };

  if (t.target.dirState === 'missing') {
    stderrLine(`${realDir} does not exist`);
    return 1;
  }

  const startedMs = Date.now();
  let notice: 'pending' | 'printed' = 'pending';
  let oneOffLayers: DirectLayers | 'unread' = 'unread';
  // read only when the main socket has no daemon: it lists lock files and reads installed units
  let others: StatePaths[] | 'unread' = 'unread';
  for (;;) {
    let r = await sendFlush(paths.sock, req, { queuedTimeoutMs: QUEUED_TIMEOUT_MS });
    if (r.kind === 'no-daemon' && others === 'unread') others = otherStatePaths(realDir, c.env);
    // a daemon started with another XDG_STATE_HOME (its unit's, or the default) listens there instead
    for (const o of others === 'unread' ? [] : others) {
      if (r.kind !== 'no-daemon') break;
      r = await sendFlush(o.sock, req, { queuedTimeoutMs: QUEUED_TIMEOUT_MS });
    }
    if (r.kind === 'replies') {
      const d = describeReplies(r.replies, wait);
      if (d.message !== undefined) stderrLine(d.message);
      return d.code;
    }
    if (r.kind === 'timeout') {
      stderrLine('daemon did not respond');
      return 1;
    }
    if (r.kind === 'result-timeout') {
      stderrLine(`flush queued, but no result within ${Math.round(FLUSH_RESULT_WAIT_MS / 60_000)} min`);
      return 1;
    }
    if (r.kind === 'error') {
      stderrLine(`flush not delivered: ${r.error}`);
      return 1;
    }

    // no daemon on the socket: do the run ourselves, unless someone else holds the folder. A one-off needs the
    // instance config; an invalid one means the flush is not delivered (exit 1: a hook runner may treat 2 as
    // "block the agent", and the file is not one this flush named).
    if (t.target.invalidInstance !== 'none') {
      reportIssues(c.log, t.target.invalidInstance.issues);
      stderrLine('flush not delivered: no daemon is running, and a one-off run needs a valid config');
      return 1;
    }
    // the remote and branch a zero-config daemon would use: what the checkout has, where no config sets them
    if (oneOffLayers === 'unread') {
      const d = await withRepoDefaults({ layers, cwd: c.cwd, env: c.env, log: c.log, dir: realDir });
      if (d.kind === 'refused') {
        stderrLine(`flush not delivered: ${d.message}`);
        return 1;
      }
      oneOffLayers = d.layers;
    }
    ensureStateDir(paths);
    const got = acquireOneOffLock(paths, realDir, others === 'unread' ? [] : others, c.log);
    if (got.kind === 'acquired') {
      if (t.target.instance === 'none') c.log.warn('one-off without instance config', { dir: realDir });
      const { req: runReq } = mergeTriggers([], [{ kind: 'commit', source: 'flush',
        ...(message !== undefined ? { message } : {}), ...(rels.length > 0 ? { paths: rels } : {}) }]);
      return runOneOff({ source: 'flush', lock: got.handle, layers: oneOffLayers, realDir, paths, log: c.log, req: runReq });
    }
    const owner = got.owner;
    const waited = Date.now() - startedMs;
    if (waited >= DELIVERY_WAIT_MS) {
      stderrLine(`${realDir} is busy (pid ${owner.pid}); flush not delivered`);
      return 1;
    }
    if (waited >= WAITING_NOTICE_MS && notice === 'pending') {
      notice = 'printed';
      stderrLine(`waiting for pid ${owner.pid} (${owner.purpose}) to release ${realDir}…`);
    }
    await Bun.sleep(POLL_MS);
  }
}
