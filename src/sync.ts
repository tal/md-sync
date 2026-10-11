// One sync run, S0–S7. Never throws: every path returns a RunResult.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NON_FF_DELAYS_MS, sleep } from './backoff';
import { commitRun } from './commit';
import { isOkOutcome } from './commands/shared';
import { REPO_CONFIG_PATH } from './config';
import { type ConflictResult, foldPrecheck, handleRebaseConflict } from './conflict';
import type { RunContext } from './context';
import {
  classifyFailure, effectiveTimeoutMs, GitError, type GitFailureKind, type GitResult, headSha, isAncestor, LFS_SMUDGE_FAILED,
  lsTree, NON_FF_RE, networkDeadline, revCount, revParse, unmergedPaths,
} from './git';
import { errorText } from './log';
import { moveWorktree, type MoveResult, settlePending, SETTLE_GRACE_MS } from './move';
import { aheadCount, unstageable } from './pending';
import { preflight } from './preflight';
import { replayCommits } from './replay';
import { foldClashes } from './replay-plan';
import { readJournal } from './state';
import type {
  CommitStep, LogLevel, OverriddenDelete, RunOptions, RunRequest, RunResult, SyncOutcome,
} from './types';

// What `git lfs` prints when git-lfs is not installed: nothing to fetch or push then.
const LFS_MISSING = "'lfs' is not a git command";

export function outcomeLevel(o: SyncOutcome): LogLevel {
  switch (o) {
    case 'ok':
    case 'conflict-resolved':
      return 'info';
    case 'network-error':
    case 'busy':
      return 'warn';
    case 'failed':
    case 'data-guard-stop':
      return 'error';
  }
}

// What S5 decided, before S5z folds it into the run.
type S5Outcome = ConflictResult | { kind: 'network-error'; error: string };

type Ending = { outcome: SyncOutcome; error?: string; s5?: { head: string; remote: string }; stuck?: 'unchanged' };

// Remote state after S3. `not-fetched`: S3 has not run in this run (shutdown mode).
type RemoteRef = { kind: 'not-fetched' } | { kind: 'fetched'; sha: string | 'none' };

function gitFailText(r: GitResult): string {
  if (r.spawnError !== undefined) return r.spawnError;
  if (r.timedOut === 'timed-out') return `timed out after ${r.durationMs} ms`;
  const lines = `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.find((l) => l.includes('[rejected]') || l.includes('[remote rejected]'))
    ?? lines[0] ?? `exit ${r.code}`;
}

function failureOutcome(k: GitFailureKind): SyncOutcome {
  if (k === 'locked') return 'busy';
  if (k === 'network' || k === 'auth') return 'network-error';
  return 'failed';
}

// Logs a network or auth failure of `op` (other kinds are logged by the caller's own ending).
function logNetworkOrAuth(ctx: RunContext, op: 'fetch' | 'push', k: GitFailureKind, r: GitResult, error: string): void {
  if (k === 'network') ctx.log.warn('network error', { op, error, timedOut: r.timedOut });
  if (k === 'auth') ctx.log.error('auth failed', { op, error });
}

// The ending of a failed remote op: logged, and worded `<prefix>: <git's reason>`.
function remoteFailureEnding(ctx: RunContext, op: 'fetch' | 'push', k: GitFailureKind, r: GitResult, prefix: string): Ending {
  const error = gitFailText(r);
  logNetworkOrAuth(ctx, op, k, r, error);
  return { outcome: failureOutcome(k), error: `${prefix}: ${error}` };
}

export async function syncRun(ctx: RunContext, req: RunRequest, runId: number, opts: RunOptions): Promise<RunResult> {
  const g = ctx.git;
  const startMs = ctx.clock.now();
  const startedAt = new Date(startMs).toISOString();
  const conflicts: string[] = [];
  const overridden: OverriddenDelete[] = [];
  const keptStashes: string[] = [];
  let commitStep: CommitStep = req.kind === 'commit' ? 'not-reached' : 'not-applicable';
  let committed: string | 'none' = 'none';
  let commitsIn = 0;
  let commitsOut = 0;
  let lastHead: string | 'unborn' = 'unborn';
  const settleOnly: 'settle-only' | 'normal' = req.reasons.length > 0 && req.reasons.every((r) => r === 'settle') ? 'settle-only' : 'normal';

  const addKept = (shas: readonly string[] | undefined): void => {
    for (const s of shas ?? []) if (!keptStashes.includes(s)) keptStashes.push(s);
  };
  const absorbResolved = (x: Extract<ConflictResult, { kind: 'resolved' }>): void => {
    conflicts.push(...x.copies);
    overridden.push(...x.overridden);
    addKept(x.keptStashes);
  };

  const finish = async (e: Ending): Promise<RunResult> => {
    let head: string | 'unborn' = lastHead;
    let integrated: string | 'none' = 'none';
    try {
      head = await headSha(g);
      integrated = await integratedRemote(ctx, head);
    } catch {
      // keep the last head we saw
    }
    const durationMs = Math.max(0, ctx.clock.now() - startMs);
    const settleDueAt = settleDue(ctx);
    const result: RunResult = {
      runId, kind: req.kind, mode: opts.mode, reasons: [...req.reasons], outcome: e.outcome, commitStep, commitsIn, commitsOut,
      head, committed, conflicts: [...conflicts], overriddenDeletes: [...overridden], keptStashes: [...keptStashes],
      ...(e.s5 !== undefined ? { s5: e.s5 } : {}),
      ...(e.stuck !== undefined ? { stuck: e.stuck } : {}),
      ...(integrated !== 'none' ? { integrated } : {}),
      ...(settleDueAt !== 'none' ? { settleDueAt } : {}),
      ...(e.error !== undefined ? { error: errorText(e.error) } : {}),
      startedAt, durationMs,
    };
    const fields = { runId, kind: req.kind, mode: opts.mode, reasons: result.reasons, outcome: e.outcome, commitStep, commitsIn,
      commitsOut, head, conflicts: conflicts.length, durationMs,
      ...(result.error !== undefined ? { error: result.error } : {}), ...(e.stuck !== undefined ? { stuck: e.stuck } : {}) };
    const level = e.stuck !== undefined || (settleOnly === 'settle-only' && isOkOutcome(e.outcome)) ? 'debug' : outcomeLevel(e.outcome);
    ctx.log[level]('sync done', fields);
    return result;
  };

  ctx.log[settleOnly === 'settle-only' ? 'debug' : 'info']('sync start', { runId, kind: req.kind, reasons: req.reasons, mode: opts.mode });
  try {
    // S0 (P4 also settles the replaced inodes whose grace has passed)
    const pf = await preflight(ctx, { keptStashes: opts.keptStashes, cloned: opts.cloned });
    if (pf.kind === 'busy') return finish({ outcome: 'busy', error: `repository busy (${pf.reason})` });
    if (pf.kind === 'failed' || pf.kind === 'data-guard-stop') {
      addKept(pf.keptStashes);
      return finish({ outcome: pf.kind, error: pf.error });
    }
    conflicts.push(...pf.conflicts);
    overridden.push(...pf.overriddenDeletes);
    addKept(pf.keptStashes);
    // the settle timer's run: preflight only, no network
    if (settleOnly === 'settle-only') return finish({ outcome: conflicts.length > 0 || overridden.length > 0 ? 'conflict-resolved' : 'ok' });

    // S2. The committed repo config is invalid and no valid one was ever seen here: staging under the defaults pushed
    // whatever its `ignore` list keeps out. The run goes on as a pull (it may bring a fixed version) and then fails.
    const refused: string | 'none' = req.kind === 'commit' && ctx.repoRules === 'unknown'
      ? `${REPO_CONFIG_PATH} at HEAD is invalid and no earlier valid version is known on this device, so neither is its `
        + '"ignore" list: nothing is committed until it is fixed (commit a fixed version with git, or fix it on another device)'
      : 'none';
    if (req.kind === 'commit' && refused === 'none') {
      try {
        const c = await commitRun(ctx, req.commit);
        if (c.kind === 'committed') {
          commitStep = 'committed';
          committed = c.sha;
        } else {
          commitStep = 'nothing-staged';
        }
      } catch (e) {
        if (e instanceof GitError && e.failure === 'locked') return finish({ outcome: 'busy', error: errorText(e) });
        return finish({ outcome: 'failed', error: errorText(e) });
      }
    }

    let remote: RemoteRef = { kind: 'not-fetched' };
    let attempt = 0;
    let blockedRetry = 0;

    if (opts.mode !== 'shutdown') {
      for (;;) {
        // S3. Where the remote stood when this device last integrated it, so a rewrite can be told apart.
        const before = await lastIntegrated(ctx, opts.integrated);
        const f = await g.run(['fetch', '--progress', '--no-tags', 'origin',
          `+refs/heads/${ctx.branch}:refs/remotes/origin/${ctx.branch}`], { kind: 'network' });
        let r: string | 'none';
        if (f.code === 0) {
          r = await revParse(g, `refs/remotes/origin/${ctx.branch}`);
        } else {
          const k = classifyFailure(f, 'fetch');
          if (k === 'missing-remote-ref') {
            // Only an empty remote gets B created by our first push. A remote with history on other branches (an
            // existing repo whose default is `master`) would otherwise quietly fork into a new `main` that nothing
            // else reads.
            const other = await remoteDefaultBranch(ctx);
            if (other.kind === 'failed') {
              return finish(remoteFailureEnding(ctx, 'fetch', classifyFailure(other.result, 'fetch'), other.result, 'fetch failed'));
            }
            if (other.kind === 'has-branches') return finish({ outcome: 'failed', error: noBranchError(ctx, other.name) });
            r = 'none';
            ctx.log.info('remote branch missing', { branch: ctx.branch });
            await g.run(['update-ref', '-d', `refs/remotes/origin/${ctx.branch}`]);
          } else {
            return finish(remoteFailureEnding(ctx, 'fetch', k, f, 'fetch failed'));
          }
        }
        remote = { kind: 'fetched', sha: r };

        // S4
        const h = await headSha(g);
        lastHead = h;
        // A remote whose new history does not contain what we last saw was rewritten (a force-push that purged a
        // secret, a reset to an older commit). Only the commits made here since `before` are local work: rebasing
        // onto R with R as the upstream replayed every rewritten-away commit and pushed it back (a purged secret
        // returned within one sync), and the fast-forward check undid a rewind.
        let rewritten: string | 'none' = 'none';
        if (r !== 'none' && before !== 'none' && before !== r && h !== 'unborn'
          && (await isAncestor(g, before, r)) === 'not-ancestor') {
          rewritten = before;
          ctx.log.warn('remote history rewritten', { before, after: r, localCommits: await revCount(g, `${before}..${h}`) });
        }
        if (r !== 'none') {
          if (h === 'unborn') {
            // S4u
            const lfs = await fetchLfsObjects(ctx, r);
            if (lfs !== 'ok') return finish(lfs);
            commitsIn += await revCount(g, r);
            await g.ok(['reset', '-q']);   // index only: drops entries staged before a crash between S2's add and commit (e7)
            // untracked or ignored files where R has files: identical -> kept; different -> a conflict copy (committed
            // when copyCommittable); a folder in the way moves whole. No checkout, nothing overwritten.
            const mv = await moveWorktree(ctx, { reason: 'unborn', from: 'empty', to: r,
              ref: { kind: 'update', ref: `refs/heads/${ctx.branch}`, old: 'zero', head: 'as-is' }, index: 'reset', edits: 'merge',
              copies: 'commit' });
            if (mv.kind === 'moved') {
              conflicts.push(...mv.copies, ...mv.raced);
              overridden.push(...mv.overridden);
            } else if (mv.kind === 'busy') {
              return finish({ outcome: 'busy', error: mv.error });
            } else if (mv.kind === 'data-guard-stop') {
              return finish({ outcome: 'data-guard-stop', error: mv.error });
            } else {
              return finish({ outcome: mv.error.includes(LFS_SMUDGE_FAILED) ? 'network-error' : 'failed',
                error: `moving the folder to ${ctx.branch} failed: ${mv.error}` });
            }
          } else if (rewritten === 'none' && (await isAncestor(g, r, h)) === 'ancestor') {
            ctx.log.debug('up to date', { head: h });   // probe W8: never replay with nothing incoming
          } else if (opts.stuck !== 'none' && opts.stuck.head === h && opts.stuck.remote === r) {
            return finish({ outcome: opts.stuck.outcome, error: `unchanged since ${opts.stuck.since}: ${opts.stuck.error}`,
              s5: { head: h, remote: r }, stuck: 'unchanged' });
          } else {
            const incoming = await revCount(g, `${h}..${r}`);
            commitsIn += incoming;

            // S5
            const lfs = await fetchLfsObjects(ctx, r);
            if (lfs !== 'ok') return finish(lfs);
            ctx.log.debug('rebasing', { onto: r, commitsIn });   // msg kept for log consumers; no `git rebase` runs
            let x: S5Outcome | 'retry' = 'retry';
            while (x === 'retry') {
              x = await s5(ctx, { h, r, rewritten });
              if (x === 'retry') {
                // a person's half-finished merge or apply left unmerged entries with nothing in progress: P5 recovers them
                if (blockedRetry > 0) {
                  x = { kind: 'failed', error: 'unmerged entries', stash: 'none' };
                  break;
                }
                blockedRetry = 1;
                const pf2 = await preflight(ctx, { keptStashes: [...opts.keptStashes, ...keptStashes], cloned: 'none' });
                if (pf2.kind === 'ready') {
                  conflicts.push(...pf2.conflicts);
                  overridden.push(...pf2.overriddenDeletes);
                  addKept(pf2.keptStashes);
                  if ((await headSha(g)) !== h) {
                    x = { kind: 'failed', error: 'HEAD moved while recovering unmerged entries', stash: 'none' };
                    break;
                  }
                  continue;
                }
                if (pf2.kind === 'busy') x = { kind: 'busy', error: `repository busy (${pf2.reason})` };
                else x = { kind: pf2.kind, error: pf2.error, stash: pf2.keptStashes.length > 0 ? 'kept' : 'none', keptStashes: pf2.keptStashes };
              }
            }

            // S5z: no rescue to restore, no set-aside files to settle, no collision copies to commit: the move did it all
            if (x.kind === 'busy') return finish({ outcome: 'busy', error: x.error });
            if (x.kind === 'network-error') return finish({ outcome: 'network-error', error: x.error });
            if (x.kind === 'failed' || x.kind === 'data-guard-stop') {
              addKept(x.keptStashes);
              // An LFS object the server could not hand out after all (the prefetch above normally catches it): a
              // network error, retried, never remembered as stuck at {H, R} once the object is there.
              if (x.kind === 'failed' && x.error.includes(LFS_SMUDGE_FAILED)) return finish({ outcome: 'network-error', error: x.error });
              return finish({ outcome: x.kind, error: x.error, s5: { head: h, remote: r } });
            }
            absorbResolved(x);
          }
        }

        // S6
        const pushed = await pushStep(ctx, remote, opts, attempt);
        if (pushed.kind === 'retry') {
          attempt += 1;
          await sleep(pushed.delayMs);
          continue;
        }
        if (pushed.kind === 'done') {
          commitsOut += pushed.commitsOut;
          break;
        }
        return finish(pushed.ending);
      }
    } else {
      // S6 only: no fetch, no rebase, one push attempt
      const pushed = await pushStep(ctx, remote, opts, attempt);
      if (pushed.kind === 'done') commitsOut += pushed.commitsOut;
      else if (pushed.kind === 'stop') return finish(pushed.ending);
    }

    // S7
    if (opts.mode === 'shutdown') await settlePending(ctx, 'all');   // the daemon exits next: no temp folder is left
    if (refused !== 'none') return finish({ outcome: 'failed', error: refused });
    return finish({ outcome: conflicts.length > 0 || overridden.length > 0 ? 'conflict-resolved' : 'ok' });
  } catch (e) {
    // a move interrupted by the exception keeps its journal part: the next run's P4 resumes it
    return finish({ outcome: 'failed', error: errorText(e) });
  }
}

// The earliest due time of the journal's settle part (the daemon arms its settle timer for it).
function settleDue(ctx: RunContext): number | 'none' {
  const j = readJournal(ctx.paths.journal);
  if (j === 'none' || j.settle === undefined || j.settle.length === 0) return 'none';
  return Math.min(...j.settle.map((e) => e.since + SETTLE_GRACE_MS));
}

// S5: the local commits replayed in memory onto R, then the folder moved from H to the result.
// 'retry': unmerged entries with nothing in progress; the caller recovers them through preflight once.
async function s5(ctx: RunContext, o: { h: string; r: string; rewritten: string | 'none' }): Promise<S5Outcome | 'retry'> {
  const g = ctx.git;
  const { h, r, rewritten } = o;
  if ((await unmergedPaths(g)).length > 0) return 'retry';
  if (ctx.ignoreCase === 'case-insensitive') {
    const clashes = await foldPrecheck(ctx, h, r, rewritten);   // probe e4
    // Paths that differ only in case or Unicode normalization (committed on a case-sensitive device, or by plain git
    // on a Mac) share one file on disk: a per-commit replay keeps both in the tree; the planner's clash rule (c) turns
    // the local spelling into a copy, and the guard tolerates remote-internal duplicates.
    const dupes = [...(await unstageable(ctx, [])).caseCollided, ...foldClashes((await lsTree(g, r)).keys()).flat()];
    if (clashes.length > 0 || dupes.length > 0) {
      ctx.log.warn('case collision', { paths: [...new Set([...clashes.flat(), ...dupes])], action: 'replay' });
      return handleRebaseConflict(ctx, { local: h, remote: r, entry: 'precheck', base: rewritten });
    }
  }
  // with R as the upstream after a rewrite, every rewritten-away commit counted as local work and was pushed back
  const rp = await replayCommits(ctx, { local: h, onto: r, upstream: rewritten !== 'none' ? rewritten : r });
  if (rp.kind === 'conflict' || rp.kind === 'has-merges') {
    return handleRebaseConflict(ctx, { local: h, remote: r, entry: 'replay-conflict', base: rewritten,
      ...(rp.kind === 'conflict' ? { paths: rp.paths } : {}) });
  }
  if (rp.kind === 'failed') return { kind: 'failed', error: `replaying the local commits failed: ${rp.error}`, stash: 'none' };
  // uncommitted edits: kept where T leaves the path alone, three-way merged where T changes it, a conflict copy on a
  // conflict (committed when copyCommittable), exactly the old autostash + stash-replay outcome
  const mv: MoveResult = await moveWorktree(ctx, { reason: 'pull', from: h, to: rp.tip,
    ref: { kind: 'update', ref: `refs/heads/${ctx.branch}`, old: h, head: 'as-is' }, index: 'changed-paths', edits: 'merge',
    copies: 'commit' });
  if (mv.kind === 'moved') {
    return { kind: 'resolved', copies: [...mv.copies, ...mv.raced], overridden: mv.overridden, commit: mv.commit, stash: 'none' };
  }
  if (mv.kind === 'busy') return { kind: 'busy', error: mv.error };
  return { kind: mv.kind, error: mv.error, stash: 'none' };
}

// The commit `before` for S3's rewrite check: the newest origin/B this device integrated (HEAD contains it). That is
// `known` (RunResult.integrated of an earlier run, kept in the state file) or the tracking ref, whichever is newer.
// When HEAD contains neither (no state yet), the tracking ref's reflog (`merge-base --fork-point`, as
// `git pull --rebase` does), then the tracking ref itself. The tracking ref alone was wrong whenever it moved without
// the run that moved it integrating the result: an editor's autofetch, or a run that fetched a rewrite and then
// failed in S5 or was killed. The next run then saw no rewrite, rebased with R as the upstream and pushed every
// rewritten-away commit (a purged secret) back.
async function lastIntegrated(ctx: RunContext, known: string | 'none'): Promise<string | 'none'> {
  const g = ctx.git;
  const ref = `refs/remotes/origin/${ctx.branch}`;
  const [tracking, head] = await Promise.all([revParse(g, ref), headSha(g)]);
  if (head === 'unborn') return tracking;
  // the two probes are independent; `known` equal to the tracking ref has the same answer
  const [trackingAnc, knownAnc] = await Promise.all([
    tracking !== 'none' ? isAncestor(g, tracking, 'HEAD') : 'none' as const,
    known !== 'none' && known !== tracking ? isAncestor(g, known, 'HEAD') : 'none' as const,
  ]);
  const t = trackingAnc === 'ancestor' ? tracking : 'none';
  const k = known !== 'none' && known !== t && (known === tracking ? trackingAnc : knownAnc) === 'ancestor' ? known : 'none';
  if (t !== 'none' && k !== 'none') return (await isAncestor(g, k, t)) === 'ancestor' ? t : k;
  if (t !== 'none' || k !== 'none') return t !== 'none' ? t : k;
  if (tracking === 'none') return 'none';
  const fp = await g.run(['merge-base', '--fork-point', ref, 'HEAD']);
  return fp.code === 0 && fp.stdout.trim() !== '' ? fp.stdout.trim() : tracking;
}

// RunResult.integrated: origin/B when HEAD contains it ('none' otherwise: fetched but not integrated, or unborn).
async function integratedRemote(ctx: RunContext, head: string | 'unborn'): Promise<string | 'none'> {
  if (head === 'unborn') return 'none';
  const tracking = await revParse(ctx.git, `refs/remotes/origin/${ctx.branch}`);
  if (tracking === 'none') return 'none';
  return (await isAncestor(ctx.git, tracking, head)) === 'ancestor' ? tracking : 'none';
}

function noBranchError(ctx: RunContext, other: string): string {
  return `origin has no branch ${ctx.branch} (its default branch is ${other}); set "branch": "${other}" in the config, `
    + `or create ${ctx.branch} on the remote`;
}

// The remote's default branch (its HEAD), or the first branch it lists; 'empty' when it has no branches at all.
async function remoteDefaultBranch(ctx: RunContext): Promise<{ kind: 'empty' } | { kind: 'has-branches'; name: string; heads: string[] }
  | { kind: 'failed'; result: GitResult }> {
  const r = await ctx.git.run(['ls-remote', '--symref', 'origin'], { kind: 'network' });
  if (r.code !== 0) return { kind: 'failed', result: r };
  const heads: string[] = [];
  let head: string | 'none' = 'none';
  for (const line of r.stdout.split('\n')) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym?.[1] !== undefined) head = sym[1];
    const ref = /^[0-9a-f]+\trefs\/heads\/(.+)$/.exec(line);
    if (ref?.[1] !== undefined) heads.push(ref[1]);
  }
  if (heads.length === 0) return { kind: 'empty' };
  return { kind: 'has-branches', name: head !== 'none' && heads.includes(head) ? head : heads[0] ?? '', heads };
}

// ---------------------------------------------------------------------------------------------------------------
// Git LFS objects of R, downloaded before anything checks R out (S4u, S5). As a network op (stall limit, progress
// forced), a big object on a slow link is not killed by the local-op cap the checkout runs under, and an object
// the server can't hand out (yet) is a network error before the checkout starts: never a half checkout, a failed
// conflict replay or a run remembered as stuck. Only when this clone or R uses LFS: `git lfs fetch` creates .git/lfs,
// which turns on S6's `git lfs push`.
async function fetchLfsObjects(ctx: RunContext, r: string): Promise<'ok' | Ending> {
  const g = ctx.git;
  if (!existsSync(join(ctx.gitDir, 'lfs'))) {
    const uses = await g.run(['grep', '-q', '-F', '-e', 'filter=lfs', r, '--', ':(glob)**/.gitattributes']);
    if (uses.code !== 0) return 'ok';
  }
  const f = await g.run(['lfs', 'fetch', 'origin', r], { kind: 'network' });
  if (f.code === 0 || f.stderr.includes(LFS_MISSING)) return 'ok';
  const error = gitFailText(f);
  ctx.log.warn('network error', { op: 'fetch', error, timedOut: f.timedOut });
  return { outcome: 'network-error', error: `LFS download failed: ${error}` };
}

// ---------------------------------------------------------------------------------------------------------------
// S6: push

type PushStep =
  | { kind: 'done'; commitsOut: number }
  | { kind: 'retry'; delayMs: number }
  | { kind: 'stop'; ending: Ending };

async function pushStep(ctx: RunContext, remote: RemoteRef, opts: RunOptions, attempt: number): Promise<PushStep> {
  const g = ctx.git;
  const h = await headSha(g);
  if (h === 'unborn') return { kind: 'done', commitsOut: 0 };
  let ahead: number;
  if (remote.kind === 'fetched') {
    ahead = remote.sha === 'none' ? await revCount(g, h) : await revCount(g, `${remote.sha}..${h}`);
  } else {
    const a = await aheadCount(ctx);
    ahead = a === 'no-remote-branch' ? await revCount(g, h) : a;
    if (a === 'no-remote-branch' && ahead > 0 && effectiveTimeoutMs('network') !== 'deadline-reached') {
      // S6 only (shutdown) never fetched, so nothing has checked that B may be created: only a remote with no
      // branches at all gets it (D32). Pushing anyway published a fork `main` next to the remote's `master`.
      const other = await remoteDefaultBranch(ctx);
      if (other.kind === 'failed') {
        return { kind: 'stop', ending: remoteFailureEnding(ctx, 'fetch', classifyFailure(other.result, 'fetch'), other.result, 'push failed') };
      }
      if (other.kind === 'has-branches' && !other.heads.includes(ctx.branch)) {
        ctx.log.warn('push deferred', { reason: 'no-remote-branch', ahead });
        return { kind: 'stop', ending: { outcome: 'failed', error: noBranchError(ctx, other.name) } };
      }
    }
  }
  if (ahead === 0) return { kind: 'done', commitsOut: 0 };
  if (effectiveTimeoutMs('network') === 'deadline-reached') {
    ctx.log.warn('push deferred', { reason: 'deadline', ahead });
    return { kind: 'stop', ending: { outcome: 'failed', error: 'push deferred: shutdown deadline' } };
  }

  // Git LFS objects first: every hook is off (GLOBAL_ARGS), git-lfs's pre-push included, so a plain push published
  // pointers to content that existed only here, and every other device then failed its checkout.
  if (existsSync(join(ctx.gitDir, 'lfs'))) {
    const l = await g.run(['lfs', 'push', 'origin', ctx.branch], { kind: 'network' });
    if (l.code !== 0 && !l.stderr.includes(LFS_MISSING)) {
      const error = gitFailText(l);
      ctx.log.warn('network error', { op: 'push', error, timedOut: l.timedOut });
      return { kind: 'stop', ending: { outcome: 'network-error', error: `LFS upload failed: ${error}` } };
    }
  }
  const p = await g.run(['push', '--porcelain', '--progress', '--no-verify', 'origin',
    `refs/heads/${ctx.branch}:refs/heads/${ctx.branch}`], { kind: 'network' });
  if (p.code === 0) {
    await g.run(['update-ref', `refs/remotes/origin/${ctx.branch}`, h]);
    ctx.log.info('pushed', { head: h, commitsOut: ahead });
    return { kind: 'done', commitsOut: ahead };
  }
  const k = classifyFailure(p, 'push');
  const error = gitFailText(p);
  if (k === 'non-ff') {
    if (opts.mode === 'shutdown' || networkDeadline() !== 'none') {
      ctx.log.warn('push deferred', { reason: 'non-ff', ahead });
      return { kind: 'stop', ending: { outcome: 'failed', error: 'push deferred to the next start' } };
    }
    if (attempt < NON_FF_DELAYS_MS.length) {
      const delayMs = NON_FF_DELAYS_MS[attempt] ?? 0;
      const reason = NON_FF_RE.exec(`${p.stdout}\n${p.stderr}`)?.[1] === 'fetch first' ? 'fetch first' : 'non-fast-forward';
      ctx.log.info('push rejected', { attempt: attempt + 1, delayMs, reason });
      return { kind: 'retry', delayMs };
    }
    return { kind: 'stop', ending: { outcome: 'failed', error: `push rejected as non-fast-forward after ${NON_FF_DELAYS_MS.length} retries` } };
  }
  if (k === 'remote-rejected') {
    ctx.log.error('push rejected by remote', { error });
    return { kind: 'stop', ending: { outcome: 'failed', error: `push rejected by remote: ${error}` } };
  }
  return { kind: 'stop', ending: remoteFailureEnding(ctx, 'push', k, p, 'push failed') };
}
