// `status`: read-only report from the state file, the lock and git.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEffectiveConfig } from '../context';
import { headSha, parseNul } from '../git';
import { isoUtc } from '../host';
import { homeOf, kindAt } from '../fsutil';
import { createLogger, errorText } from '../log';
import { ownerLiveness, readLockOwner } from '../lock';
import { aheadCount, indexGitlinks, type PendingEntry, pendingChanges, unstageable } from '../pending';
import { launchdLabel, launchdPlistPath, serviceKindFor, systemdUnitCandidates, systemdUnitName } from '../service';
import { withRepoDefaults } from '../repo-defaults';
import { readState, type StateFile } from '../state';
import { type CommandEnv, renamedStatePaths, resolveTarget, stdoutText, warnInvalidInstance } from './shared';
import { xdgStateHome } from '../paths';

export type DaemonStatus = { state: 'running'; pid: number } | { state: 'stopped' } | { state: 'stale-lock'; pid: number };
// notSynced: paths that are never staged (`unstageable` in pending.ts): local-only conflict copies and index paths that differ
// only in case or Unicode normalization.
type RepoStatus = { kind: 'repo'; head: string; unpushed: number | 'no-remote-branch'; pending: PendingEntry[]; notSynced: string[] }
  | { kind: 'not-a-repo'; why: string };

// A one-off run holding the lock is not a daemon: it reports 'stopped' (and says so in the text form).
function daemonStatus(lockPath: string): { status: DaemonStatus; oneOff: number | 'none' } {
  const r = readLockOwner(lockPath);
  if (r === 'none') return { status: { state: 'stopped' }, oneOff: 'none' };
  if (r === 'unparsable') return { status: { state: 'stale-lock', pid: 0 }, oneOff: 'none' };
  if (ownerLiveness(r.owner) !== 'alive') return { status: { state: 'stale-lock', pid: r.owner.pid }, oneOff: 'none' };
  if (r.owner.purpose === 'one-off') return { status: { state: 'stopped' }, oneOff: r.owner.pid };
  return { status: { state: 'running', pid: r.owner.pid }, oneOff: 'none' };
}

// `unpushed` counts against the branch the daemon syncs: the checked-out one when no config names it. With none (a
// detached HEAD and no branch configured), the repo part is unavailable and says why; status itself never fails.
async function repoStatus(t: Parameters<typeof loadEffectiveConfig>[0], c: CommandEnv): Promise<RepoStatus> {
  if (kindAt(join(t.realDir, '.git')) === 'missing') return { kind: 'not-a-repo', why: 'not a git repository' };
  try {
    const d = await withRepoDefaults({ layers: t.layers, cwd: c.cwd, env: c.env, log: c.log, dir: t.realDir });
    if (d.kind === 'refused') return { kind: 'not-a-repo', why: d.message };
    // the daemon reports repo-config warnings; status would repeat them on every call
    const { ctx } = await loadEffectiveConfig({ ...t, layers: d.layers, log: createLogger({ level: 'error', sink: 'stderr' }) });
    const [head, unpushed, pending] = await Promise.all([headSha(ctx.git), aheadCount(ctx), pendingChanges(ctx)]);
    const never = await unstageable(ctx, parseNul(await ctx.git.ok(['ls-files', '-z', '--others', '--exclude-standard'])));
    return { kind: 'repo', head, unpushed, pending,
      notSynced: [...never.localOnly, ...never.caseCollided, ...never.nested, ...await indexGitlinks(ctx)].sort() };
  } catch (e) {
    return { kind: 'not-a-repo', why: errorText(e) };
  }
}

function line(label: string, value: string): string {
  return `${`${label}:`.padEnd(12)} ${value}\n`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The installed unit for this folder, so `launchctl kill SIGHUP gui/$(id -u)/<name>` and its log can be found.
type ServiceStatus = { kind: 'launchd'; name: string; log: string } | { kind: 'systemd'; name: string } | 'none';

function serviceStatus(hash: string, logPath: string, env: NodeJS.ProcessEnv): ServiceStatus {
  const kind = serviceKindFor(process.platform);
  if (kind === 'launchd' && existsSync(launchdPlistPath(hash, homeOf(env)))) return { kind, name: launchdLabel(hash), log: logPath };
  if (kind === 'systemd' && systemdUnitCandidates(hash, env).some((u) => existsSync(u))) return { kind, name: systemdUnitName(hash) };
  return 'none';
}

function renderText(dir: string, d: { status: DaemonStatus; oneOff: number | 'none' }, s: StateFile | 'none',
  repo: RepoStatus, svc: ServiceStatus): string {
  let out = line('dir', dir);
  const daemon = d.status.state === 'running' ? `running (pid ${d.status.pid})`
    : d.status.state === 'stale-lock' ? `not running (stale lock, pid ${d.status.pid})`
    : d.oneOff !== 'none' ? `not running (one-off run in progress, pid ${d.oneOff})` : 'not running';
  out += line('daemon', daemon);
  if (svc !== 'none') {
    out += line('service', svc.kind === 'launchd' ? `${svc.name} (log: ${svc.log})` : `${svc.name} (journalctl --user -u ${svc.name})`);
  }
  const last = s !== 'none' ? s.lastRun : undefined;
  if (last !== undefined) {
    const when = Number.isNaN(Date.parse(last.finishedAt)) ? last.finishedAt : isoUtc(new Date(last.finishedAt));
    out += line('last sync', `${when}  ${last.outcome}  (${last.kind}; in ${last.commitsIn}, out ${last.commitsOut}; ${last.durationMs} ms)`);
  } else {
    out += line('last sync', 'never');
  }
  const head = repo.kind === 'repo' ? repo.head : last?.head;
  if (head !== undefined) out += line('head', head === 'unborn' || head === 'unknown' ? head : head.slice(0, 12));
  if (last?.error !== undefined) out += line('last error', last.error);
  if (s !== 'none' && s.stuck !== undefined) out += line('stuck', `${s.stuck.outcome} since ${s.stuck.since}: ${s.stuck.error}`);
  if (s !== 'none' && s.nextRetryAt !== undefined) out += line('retry at', s.nextRetryAt);
  if (repo.kind === 'repo') {
    out += line('unpushed', repo.unpushed === 'no-remote-branch' ? 'no remote branch yet' : plural(repo.unpushed, 'commit', 'commits'));
  }
  if (s !== 'none' && s.keptStashes.length > 0) out += line('kept stashes', `${s.keptStashes.length} (git -C ${dir} stash list)`);
  if (repo.kind === 'repo') {
    out += line('pending', plural(repo.pending.length, 'change', 'changes'));
    for (const e of repo.pending) out += `  ${e.xy} ${e.path}\n`;
    if (repo.notSynced.length > 0) {
      out += line('not synced', `${plural(repo.notSynced.length, 'path', 'paths')} (local-only conflict copies, case duplicates, nested repositories)`);
      for (const p of repo.notSynced) out += `     ${p}\n`;
    }
  } else {
    out += line('pending', `unknown (${repo.why})`);
  }
  return out;
}

export async function statusCommand(c: CommandEnv): Promise<number> {
  const format = c.values.format ?? 'text';
  const t = resolveTarget(c);
  if (t.kind === 'exit') return t.code;
  warnInvalidInstance(t.target);
  const { realDir, paths, layers } = t.target;

  let d = daemonStatus(paths.lock);
  // a daemon still running under the folder's old spelling (a case-only rename) until it restarts
  if (d.status.state !== 'running') {
    for (const a of renamedStatePaths(realDir, c.env, [xdgStateHome(c.env)])) {
      const da = daemonStatus(a.lock);
      if (da.status.state === 'running') d = da;
    }
  }
  const s = existsSync(paths.state) ? readState(paths.state) : 'none';
  const repo = t.target.dirState === 'present'
    ? await repoStatus({ layers, realDir, paths, log: c.log }, c)
    : { kind: 'not-a-repo' as const, why: 'folder does not exist' };
  const svc = serviceStatus(paths.hash, paths.log, c.env);

  if (format === 'json') {
    // An unreadable folder is 'unknown', never an empty `pending` list: a monitor must not read it as clean.
    const json = {
      dir: realDir,
      daemon: d.status,
      ...(d.oneOff !== 'none' ? { oneOff: { pid: d.oneOff } } : {}),
      service: svc === 'none' ? null : svc,
      repo: repo.kind === 'repo' ? { state: 'ok', head: repo.head } : { state: 'unavailable', why: repo.why },
      lastRun: s !== 'none' ? s.lastRun ?? null : null,
      ...(s !== 'none' && s.lastOkAt !== undefined ? { lastOkAt: s.lastOkAt } : {}),
      consecutiveFailures: s !== 'none' ? s.consecutiveFailures : 0,
      ...(s !== 'none' && s.nextRetryAt !== undefined ? { nextRetryAt: s.nextRetryAt } : {}),
      ...(s !== 'none' && s.stuck !== undefined ? { stuck: s.stuck } : {}),
      keptStashes: s !== 'none' ? s.keptStashes : [],
      unpushed: repo.kind === 'repo' ? repo.unpushed : 'unknown',
      pending: repo.kind === 'repo' ? repo.pending : 'unknown',
      notSynced: repo.kind === 'repo' ? repo.notSynced : 'unknown',
    };
    stdoutText(`${JSON.stringify(json)}\n`);
    return 0;
  }
  stdoutText(renderText(realDir, d, s, repo, svc));
  return 0;
}
