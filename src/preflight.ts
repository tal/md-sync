// Recovery before every run, P1–P6: stale git locks, interrupted git ops, pending
// rescues, the conflict journal, leftover stashes / unmerged entries, and the checked-out branch.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type ConflictResult, copyNamer, replayStash, resumeJournal, stashT5, stashTail, type StashUnmerged } from './conflict';
import type { RunContext } from './context';
import { errCode, firstLine, kindAt, realpathOrSame } from './fsutil';
import {
  currentBranchRef, hashPaths, headSha, indexEntries, isAncestor, isMdsyncStash, lsTree, parseNul, revParse, stashIndexOf, stashTop,
  type TreeEntry,
  unmergedPaths, unmergedStages,
} from './git';
import { liveGitIn, type LiveGitScan } from './live-git';
import { errorText } from './log';
import {
  applyOps, checkoutVersions, clearMovePart, disposableFromQuit, moveWorktree, type MoveJournal, type MoveResult,
  recoverOrphanTemps, resumeMove, type ResumeOutcome, type RefStep, settlePending, surveyPath, type WorktreeOp,
} from './move';
import { trackedDirty } from './pending';
import { pendingRescues, rescueRestore } from './rescue';
import { mutateJournal, type QuitOp, type QuitTree, readJournal } from './state';
import type { OverriddenDelete } from './types';

export const STALE_GIT_LOCK_MS = 60_000;
export const FRESH_LOCK_WAIT_MS = 10_000;
// In a container only our own PID namespace is visible: a host user's git on the bind-mounted folder (a commit
// message editor holding index.lock, a `rebase -i` todo list) never shows up, so locks and interrupted ops must be
// this old before they count as abandoned.
export const NAMESPACED_STALE_MS = 600_000;
const LOCK_POLL_MS = 250;

export type RecoveryAction = 'stale-index-lock-removed' | 'stale-ref-lock-removed' | 'rebase-aborted'
  | 'am-aborted' | 'merge-aborted' | 'cherry-pick-aborted' | 'revert-aborted' | 'rescue-restored' | 'journal-resumed'
  | 'stash-conflict-resumed' | 'unmerged-recovered' | 'branch-fixed' | 'clone-completed' | 'orphan-temps';
  // 'rebase-quit' and 'partial-checkout-undone' are gone: P2 always quits, and there is no partial checkout
// 'move': a worktree move (resumed or started here) found the index locked, or the folder kept changing
export type BusyReason = 'lock-fresh' | 'lock-live-git' | 'lock-unknown' | 'live-git' | 'live-git-unknown' | 'move';
export type PreflightResult =
  | { kind: 'ready'; actions: RecoveryAction[]; conflicts: string[]; overriddenDeletes: OverriddenDelete[]; keptStashes: string[] }
  | { kind: 'busy'; reason: BusyReason }
  | { kind: 'failed'; error: string; keptStashes: string[] }
  | { kind: 'data-guard-stop'; error: string; keptStashes: string[] };

type Acc = { actions: RecoveryAction[]; conflicts: string[]; overridden: OverriddenDelete[]; kept: string[] };
type Stop = Exclude<PreflightResult, { kind: 'ready' }>;
type Step = 'continue' | Stop;

const FIXED_LOCKS = ['index.lock', 'HEAD.lock', 'ORIG_HEAD.lock', 'FETCH_HEAD.lock', 'packed-refs.lock', 'shallow.lock'];

function mtimeOf(absPath: string): number | 'none' {
  try {
    return lstatSync(absPath).mtimeMs;
  } catch {
    return 'none';
  }
}

function stopFrom(r: ConflictResult, acc: Acc): Stop {
  const kept = [...acc.kept, ...(r.keptStashes ?? [])];
  if (r.kind === 'busy') return { kind: 'busy', reason: 'move' };
  if (r.kind === 'data-guard-stop') return { kind: 'data-guard-stop', error: r.error, keptStashes: kept };
  return { kind: 'failed', error: r.kind === 'failed' ? r.error : 'unexpected replay result', keptStashes: kept };
}

function stopFromMove(r: Exclude<MoveResult, { kind: 'moved' }>, acc: Acc): Stop {
  if (r.kind === 'busy') return { kind: 'busy', reason: 'move' };
  return { kind: r.kind, error: r.error, keptStashes: acc.kept };
}

function absorbMove(acc: Acc, r: Extract<MoveResult, { kind: 'moved' }>): void {
  acc.conflicts.push(...r.copies, ...r.raced);
  acc.overridden.push(...r.overridden);
}

async function headStateOf(ctx: RunContext): Promise<{ sha: string | 'unborn'; ref: string | 'detached' }> {
  const sha = await headSha(ctx.git);
  const r = await ctx.git.run(['symbolic-ref', '-q', 'HEAD']);
  return { sha, ref: r.code === 0 ? r.stdout.trim() : 'detached' };
}

function absorb(acc: Acc, r: Extract<ConflictResult, { kind: 'resolved' }>): void {
  acc.conflicts.push(...r.copies);
  acc.overridden.push(...r.overridden);
  acc.kept.push(...(r.keptStashes ?? []));
}

// ---------------------------------------------------------------------------------------------------------------
// P0 the repository itself

// The synced folder must still be the repository the run context was built for. A folder whose .git was removed, or
// that was wiped and recreated, has no repository of its own: the ceiling in git.ts keeps git from finding a parent
// repo instead, and this stops the run with a plain message before anything else touches the folder.
async function p0Repo(ctx: RunContext): Promise<Step> {
  const r = await ctx.git.run(['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (r.code !== 0) {
    return { kind: 'failed', keptStashes: [], error: `${ctx.realDir} is no longer a git repository (its .git is gone, or `
      + 'the folder was recreated); put the repository back, or empty the folder and restart mdsync to clone it again' };
  }
  const [top = '', gitDir = ''] = r.stdout.split('\n').map((l) => l.trim());
  // Compared as realpaths: after a case-only rename of a parent, the old spelling still names this folder.
  if (realpathOrSame(top) !== realpathOrSame(ctx.realDir) || realpathOrSame(gitDir) !== realpathOrSame(ctx.gitDir)) {
    return { kind: 'failed', keptStashes: [], error: `${ctx.realDir} is no longer the repository mdsync started with `
      + `(git now finds ${gitDir}); restart mdsync` };
  }
  return 'continue';
}

// ---------------------------------------------------------------------------------------------------------------
// P1 git lock files

type GitLock = { path: string; ageMs: number; action: 'stale-index-lock-removed' | 'stale-ref-lock-removed' };

function walkLocks(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkLocks(p, out);
    else if (e.name.endsWith('.lock')) out.push(p);
  }
}

function findGitLocks(gitDir: string): GitLock[] {
  const paths = FIXED_LOCKS.map((n) => join(gitDir, n)).filter((p) => kindAt(p) !== 'missing');
  walkLocks(join(gitDir, 'refs'), paths);
  walkLocks(join(gitDir, 'logs'), paths);
  const out: GitLock[] = [];
  for (const path of paths) {
    const m = mtimeOf(path);
    if (m === 'none') continue;   // vanished since the listing
    out.push({ path, ageMs: Math.max(0, Date.now() - m), action: path === join(gitDir, 'index.lock') ? 'stale-index-lock-removed' : 'stale-ref-lock-removed' });
  }
  return out;
}

async function waitGone(path: string, ms: number): Promise<'gone' | 'present'> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (kindAt(path) === 'missing') return 'gone';
    if (Date.now() >= deadline) return 'present';
    await Bun.sleep(Math.min(LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

async function p1Locks(ctx: RunContext, acc: Acc): Promise<Step> {
  const locks = findGitLocks(ctx.gitDir);
  if (locks.length === 0) return 'continue';
  const scan = await liveGitIn(ctx.realDir);
  const pids = scan.kind === 'scanned' ? scan.pids : [];
  const held = (reason: BusyReason, which: readonly GitLock[]): Stop => {
    for (const l of which) ctx.log.warn('git lock held', { path: l.path, ageMs: l.ageMs, pids, detection: scan.kind });
    return { kind: 'busy', reason };
  };
  if (pids.length > 0) return held('lock-live-git', locks);

  // A fresh lock is usually an editor's git integration holding index.lock for milliseconds.
  for (const l of locks.filter((x) => x.ageMs < STALE_GIT_LOCK_MS)) {
    if ((await waitGone(l.path, FRESH_LOCK_WAIT_MS)) === 'present') {
      const m = mtimeOf(l.path);
      return held('lock-fresh', [{ ...l, ageMs: m === 'none' ? l.ageMs : Math.max(0, Date.now() - m) }]);
    }
  }
  const stale = locks.filter((x) => x.ageMs >= STALE_GIT_LOCK_MS && kindAt(x.path) !== 'missing');
  if (stale.length === 0) return 'continue';
  if (scan.kind === 'unknown') {
    ctx.log.warn('live git detection unavailable', { error: scan.error });
    return held('lock-unknown', stale);
  }
  const young = scan.visibility === 'own-namespace' ? stale.filter((x) => x.ageMs < NAMESPACED_STALE_MS) : [];
  if (young.length > 0) {
    ctx.log.warn('live git detection unavailable', { error: 'only this PID namespace is visible (a container)' });
    return held('lock-unknown', young);
  }
  for (const l of stale) {
    try {
      await unlink(l.path);
    } catch (e) {
      if (errCode(e) === 'ENOENT') continue;
      throw e;
    }
    ctx.log.warn('recovered', { action: l.action, path: l.path, ageMs: l.ageMs });
    acc.actions.push(l.action);
  }
  return 'continue';
}

// ---------------------------------------------------------------------------------------------------------------
// P1b a clone whose checkout never ran (or never finished)

// The normal end of every first clone: bootstrap clones with --no-checkout, which leaves a born HEAD and no index. A plain
// clone killed during its checkout leaves the same state with part of the files, and the next `add -A` pushed every
// missing file as a deletion. A worktree move from the empty tree populates the folder: an agent's file at an incoming
// path is kept (identical) or kept beside a conflict copy, a strict prefix of HEAD's version (git killed mid-write) is
// completed, and everything else is created without replacing anything. The index is written last.
async function p1bIndex(ctx: RunContext, acc: Acc, cloned: 'fresh-clone' | 'none'): Promise<Step> {
  if (kindAt(join(ctx.gitDir, 'index')) !== 'missing') return 'continue';
  const g = ctx.git;
  const head = await headSha(g);
  if (head === 'unborn') return 'continue';
  const j = readJournal(ctx.paths.journal);
  if (j !== 'none' && j.move !== undefined) return 'continue';   // P4 owns it
  const ref = await g.run(['symbolic-ref', '-q', 'HEAD']);
  const target = ref.code === 0 ? ref.stdout.trim() : 'HEAD';
  const incomplete = await incompleteFiles(ctx, head);
  const mv = await moveWorktree(ctx, { reason: 'clone-completion', from: 'empty', to: head,
    ref: { kind: 'update', ref: target, old: head, head: 'as-is' }, index: 'reset', edits: 'merge', copies: 'commit' });
  if (mv.kind !== 'moved') return stopFromMove(mv, acc);
  absorbMove(acc, mv);
  if (cloned !== 'fresh-clone') {
    ctx.log.warn('recovered', { action: 'clone-completed', paths: incomplete.slice(0, 50), count: incomplete.length });
  }
  acc.actions.push('clone-completed');
  return 'continue';
}

// HEAD's files that are missing, or whose bytes are a strict prefix of HEAD's (git was killed mid-write): what the
// clone completion writes (for its log).
async function incompleteFiles(ctx: RunContext, head: string): Promise<string[]> {
  const tree = await lsTree(ctx.git, head);
  const out: string[] = [];
  const present: string[] = [];
  for (const [p, e] of tree) {
    if (e.type !== 'blob') continue;
    const k = kindAt(join(ctx.realDir, p));
    if (k === 'missing') out.push(p);
    else if (k === 'file') present.push(p);
  }
  if (present.length === 0) return out;
  const blobs = await hashPaths(ctx.git, present);
  for (const p of present) {
    if (blobs.get(p) === tree.get(p)?.sha) continue;
    const want = await ctx.git.bytes(['cat-file', '--filters', `${head}:${p}`]);
    if (want.code !== 0) continue;
    const have = await Bun.file(join(ctx.realDir, p)).bytes();
    if (have.length < want.stdout.length && have.every((b, i) => want.stdout[i] === b)) out.push(p);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------------------------------------------
// P2 interrupted git operations

type OpName = 'rebase' | 'am' | 'merge' | 'cherry-pick' | 'revert';
type InProgress = { op: OpName; state: string; rebaseDir?: string };

function detectOp(gitDir: string): InProgress | 'none' {
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const dir = join(gitDir, d);
    if (kindAt(dir) === 'dir') {
      const am = d === 'rebase-apply' && existsSync(join(dir, 'applying'));
      return { op: am ? 'am' : 'rebase', state: dir, rebaseDir: dir };
    }
  }
  const files: [OpName, string][] = [['merge', 'MERGE_HEAD'], ['cherry-pick', 'CHERRY_PICK_HEAD'], ['revert', 'REVERT_HEAD']];
  for (const [op, f] of files) if (existsSync(join(gitDir, f))) return { op, state: join(gitDir, f) };
  return 'none';
}

function abortAction(op: OpName): RecoveryAction {
  switch (op) {
    case 'rebase': return 'rebase-aborted';
    case 'am': return 'am-aborted';
    case 'merge': return 'merge-aborted';
    case 'cherry-pick': return 'cherry-pick-aborted';
    case 'revert': return 'revert-aborted';
  }
}

function readRev(path: string): string {
  try {
    return readFileSync(path, 'utf8').split('\n')[0]?.trim() ?? '';
  } catch {
    return '';
  }
}

async function commitOrNone(ctx: RunContext, rev: string): Promise<string | 'none'> {
  return rev === '' ? 'none' : revParse(ctx.git, `${rev}^{commit}`);
}

// Picks that replay a commit onto the running tree (fixup/squash too: tree-wise they are the same). `exec`, `break`,
// `drop` and `noop` change nothing git would write; `merge`, `reset`, `label` and `update-ref` (rebase --rebase-merges)
// make the replay something this simulation does not model, so it stops there.
const PICK_CMDS = new Set(['pick', 'p', 'reword', 'r', 'edit', 'e', 'fixup', 'f', 'squash', 's']);
const NO_TREE_CMDS = new Set(['exec', 'x', 'break', 'b', 'drop', 'd', 'noop']);
// Above this many picks the simulation is skipped: what the op committed is then saved as conflict copies.
const MAX_SIMULATED_PICKS = 200;

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  } catch {
    return [];
  }
}

// `pick <sha> ...`, `fixup -C <sha> ...`: the commit a done line picked, 'other' for a no-op, 'stop' for a command
// the simulation can't follow.
function pickOf(line: string): { kind: 'pick'; sha: string } | { kind: 'other' } | { kind: 'stop' } {
  const words = line.split(/\s+/);
  const cmd = words[0] ?? '';
  if (NO_TREE_CMDS.has(cmd)) return { kind: 'other' };
  if (!PICK_CMDS.has(cmd)) return { kind: 'stop' };
  const sha = words.slice(1).find((w) => /^[0-9a-f]{7,64}$/.test(w));
  return sha === undefined ? { kind: 'stop' } : { kind: 'pick', sha };
}

// Paths whose entry differs between two commits: what a pick (or the other side of a merge) can change. In the
// result, every other path is whatever HEAD held, which may be someone's work.
async function changedBy(ctx: RunContext, from: string, to: string): Promise<string[]> {
  const r = await ctx.git.run(['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to, '--']);
  return r.code === 0 ? parseNul(r.stdout) : [];
}

// `git merge-tree --write-tree` of one cherry-pick (base = parent) or revert (base = the commit itself) onto `ours`:
// the tree git writes for it, conflicted paths with markers. 'none' when git can't tell (older git, a root commit).
async function pickTree(ctx: RunContext, ours: string, commit: string, kind: 'pick' | 'revert', strategy: readonly string[]):
  Promise<string | 'none'> {
  const parent = await revParse(ctx.git, `${commit}^1`);
  if (parent === 'none') return 'none';
  const [base, theirs] = kind === 'pick' ? [parent, commit] : [commit, parent];
  const r = await ctx.git.run(['merge-tree', '--write-tree', '--no-messages', ...strategy, `--merge-base=${base}`, ours, theirs]);
  if (r.code !== 0 && r.code !== 1) return 'none';
  const tree = r.stdout.split('\n')[0]?.trim() ?? '';
  return /^[0-9a-f]{40,64}$/.test(tree) ? tree : 'none';
}

// The trees an interrupted rebase has written so far, replayed from `onto` with clean picks only: every pick in
// `done` (the one in flight last) applied with merge-tree, conflicted ones with their markers. A pick git committed
// cleanly reproduces exactly; a hand resolution or an amend made at any stop does not, and nor does anything built
// on top of one.
async function simulatedRebase(ctx: RunContext, rebaseDir: string, onto: string): Promise<string[]> {
  const strategy = readLines(join(rebaseDir, 'strategy_opts')).flatMap((l) => l.split(/\s+/))
    .map((o) => o.replace(/^'|'$/g, '')).filter((o) => o.startsWith('--')).map((o) => `-X${o.slice(2)}`);
  const trees: string[] = [];
  let cur = onto;
  let picks = 0;
  for (const line of readLines(join(rebaseDir, 'done'))) {
    const pk = pickOf(line);
    if (pk.kind === 'other') continue;
    if (pk.kind === 'stop' || ++picks > MAX_SIMULATED_PICKS) break;
    const commit = await revParse(ctx.git, `${pk.sha}^{commit}`);
    if (commit === 'none') break;
    const tree = await pickTree(ctx, cur, commit, 'pick', strategy);
    if (tree === 'none') break;
    trees.push(tree);
    cur = tree;
  }
  return trees;
}

// What git itself writes for the op (its reproducible output) and where an abort would leave HEAD: G = orig-head
// (rebase), sequencer/head (a cherry-pick or revert of several commits), else HEAD.
async function quitScopeFor(ctx: RunContext, p: InProgress): Promise<{ target: string | 'unborn'; trees: QuitTree[] }> {
  const head = await headSha(ctx.git);
  if (p.rebaseDir !== undefined && p.op === 'rebase') {
    const orig = await commitOrNone(ctx, readRev(join(p.rebaseDir, 'orig-head')));
    const onto = await commitOrNone(ctx, readRev(join(p.rebaseDir, 'onto')));
    const target = orig !== 'none' ? orig : head;
    const trees: QuitTree[] = onto === 'none' ? []
      : [onto, ...await simulatedRebase(ctx, p.rebaseDir, onto)].map((rev) => ({ rev, paths: 'all' as const }));
    return { target, trees };
  }
  if (head === 'unborn') return { target: 'unborn', trees: [] };
  const other = p.op === 'am' ? 'none' : await commitOrNone(ctx, readRev(p.state));
  const trees: QuitTree[] = [];
  if (other !== 'none') {
    if (p.op === 'merge') {
      trees.push({ rev: other, paths: 'all' });
      const r = await ctx.git.run(['merge-tree', '--write-tree', '--no-messages', head, other]);
      const tree = r.code === 0 || r.code === 1 ? r.stdout.split('\n')[0]?.trim() ?? '' : '';
      if (/^[0-9a-f]{40,64}$/.test(tree)) trees.push({ rev: tree, paths: await changedBy(ctx, head, other) });
    } else {
      // a cherry-pick writes the picked commit's content, a revert its parent's
      const kind = p.op === 'revert' ? 'revert' : 'pick';
      const parent = await revParse(ctx.git, `${other}^1`);
      const source = kind === 'pick' ? other : parent;
      if (source !== 'none') trees.push({ rev: source, paths: 'all' });
      const tree = await pickTree(ctx, head, other, kind, []);
      if (tree !== 'none' && parent !== 'none') trees.push({ rev: tree, paths: await changedBy(ctx, parent, other) });
    }
  }
  // A cherry-pick or revert of several commits rewinds to where the sequence started (sequencer/head), dropping the
  // commits it made so far.
  const seq = p.op === 'cherry-pick' || p.op === 'revert'
    ? await commitOrNone(ctx, readRev(join(ctx.gitDir, 'sequencer', 'head'))) : 'none';
  return { target: seq !== 'none' ? seq : head, trees };
}

// P2 step 3 onward, from a planned part (written by step 1, or found by P4 after a crash): the op is quit if its state
// still exists, the folder moves to G with checked writes, then steps 4–5.
async function p2Continue(ctx: RunContext, acc: Acc, j: MoveJournal): Promise<Step> {
  const g = ctx.git;
  const quit = j.quit;
  if (quit === undefined) {
    clearMovePart(ctx, []);
    return 'continue';
  }
  const p = detectOp(ctx.gitDir);
  if (p !== 'none') {
    // `--quit` (never `--abort`, which resets the worktree): removes the op state and leaves HEAD, the index
    // and every file byte-identical
    const q = await g.run([p.op, '--quit']);
    if (q.code !== 0) {
      clearMovePart(ctx, []);
      return { kind: 'failed', error: `git ${p.op} --quit failed: ${errorText(firstLine(q.stderr) || `exit ${q.code}`)}`, keptStashes: acc.kept };
    }
  }
  const quitOp = p !== 'none' ? p.op : quit.op;   // none: quit before a crash, and its leftovers may still be there
  if (quitOp === 'rebase' || quitOp === 'am') await clearQuitLeftovers(ctx);
  const head = await headSha(g);
  if (head === 'unborn' || head !== j.from) {
    clearMovePart(ctx, []);
    return { kind: 'failed', error: `HEAD moved while recovering the interrupted ${quit.op}`, keptStashes: acc.kept };
  }
  const mv = await moveWorktree(ctx, { reason: 'op-quit', from: head, to: j.to, ref: j.ref, index: 'reset', edits: 'copy',
    copies: 'uncommitted', disposable: await disposableFromQuit(ctx, quit) });
  if (mv.kind !== 'moved') return stopFromMove(mv, acc);
  absorbMove(acc, mv);
  return p2Tail(ctx, acc, quit.op, quit.stashBefore);
}

// `rebase --quit` leaves REBASE_HEAD, AUTO_MERGE and MERGE_MSG behind, `am --quit` AUTO_MERGE (git 2.55; `--abort`
// removed them all). A stale MERGE_MSG prefills the person's next `git commit` with the old op's message, and a stale
// REBASE_HEAD reads as an op in progress to some tools. They are removed, as the abort did: git's own state files,
// never the worktree. The op's inputs were recorded before the quit (`quit.autoMerge` is a tree sha, not the ref).
async function clearQuitLeftovers(ctx: RunContext): Promise<void> {
  for (const ref of ['REBASE_HEAD', 'AUTO_MERGE']) await ctx.git.run(['update-ref', '-d', ref]);
  await unlink(join(ctx.gitDir, 'MERGE_MSG')).catch(() => {});
}

// P2 steps 4–5: the autostash a `rebase --quit` moved into refs/stash is replayed; then `recovered`.
async function p2Tail(ctx: RunContext, acc: Acc, op: QuitOp, stashBefore: string | 'none'): Promise<Step> {
  const top = await stashTop(ctx.git);
  if (top !== 'none' && top.sha !== stashBefore && top.subject === 'autostash') {
    const r = await replayStash(ctx, { stash: top.sha, unmerged: { kind: 'skip' } });
    if (r.kind !== 'resolved') return stopFrom(r, acc);
    absorb(acc, r);
  }
  const action = abortAction(op);
  ctx.log.warn('recovered', { action, op });
  acc.actions.push(action);
  return 'continue';
}

async function p2InProgress(ctx: RunContext, acc: Acc): Promise<Step> {
  const p = detectOp(ctx.gitDir);
  if (p === 'none') return 'continue';
  const g = ctx.git;

  const scan: LiveGitScan = await liveGitIn(ctx.realDir);
  if (scan.kind === 'scanned' && scan.pids.length > 0) return { kind: 'busy', reason: 'live-git' };
  if (scan.kind === 'unknown' || scan.visibility === 'own-namespace') {
    const [error, minAge] = scan.kind === 'unknown' ? [scan.error, STALE_GIT_LOCK_MS]
      : ['only this PID namespace is visible (a container)', NAMESPACED_STALE_MS];
    ctx.log.warn('live git detection unavailable', { error });
    const m = mtimeOf(p.state);
    if (m === 'none' || Date.now() - m < minAge) return { kind: 'busy', reason: 'live-git-unknown' };
  }

  // A move part of another reason (a crash mid-move, then a person's `git rebase`) is finished first: P2's own
  // planned part must never overwrite another move.
  const cur = readJournal(ctx.paths.journal);
  if (cur !== 'none' && cur.move !== undefined) {
    if (cur.move.reason === 'op-quit' && cur.move.phase === 'planned') return p2Continue(ctx, acc, cur.move);
    const r = await finishMovePart(ctx, acc, cur.move);
    if (r !== 'continue') return r;
  }

  // 1. read the op's state before quitting it (`--quit` deletes it; merge and cherry-pick --quit delete AUTO_MERGE too)
  const head = await headStateOf(ctx);
  if (head.sha === 'unborn') return { kind: 'failed', error: `an interrupted ${p.op} on an unborn HEAD`, keptStashes: acc.kept };
  const scope = await quitScopeFor(ctx, p);
  if (scope.target === 'unborn') return { kind: 'failed', error: `an interrupted ${p.op} with no target`, keptStashes: acc.kept };
  const stages = Object.fromEntries(await unmergedStages(g));
  const autoMerge = await revParse(g, 'AUTO_MERGE^{tree}');
  const stashBefore = await revParse(g, 'refs/stash');
  let ref: RefStep = { kind: 'none' };
  if (p.op === 'rebase' && p.rebaseDir !== undefined) {
    const headName = readRev(join(p.rebaseDir, 'head-name'));
    ref = headName.startsWith('refs/') ? { kind: 'update', ref: headName, old: scope.target, head: 'attach' }
      : { kind: 'update', ref: 'HEAD', old: head.sha, head: 'as-is' };
  } else if (scope.target !== head.sha) {
    ref = { kind: 'update', ref: head.ref === 'detached' ? 'HEAD' : head.ref, old: head.sha, head: 'as-is' };
  }
  const j: MoveJournal = { op: 'move', reason: 'op-quit', phase: 'planned', from: head.sha, head, to: scope.target,
    base: scope.target, ref, index: 'reset', temps: [], copies: [],
    quit: { op: p.op, trees: scope.trees, stages, autoMerge, stashBefore }, startedAt: new Date(ctx.clock.now()).toISOString() };
  mutateJournal(ctx.paths.journal, (x) => ({ ...x, move: j }));
  return p2Continue(ctx, acc, j);
}

// ---------------------------------------------------------------------------------------------------------------
// P3 pending rescues left by versions before the worktree move

async function p3Rescues(ctx: RunContext, acc: Acc): Promise<void> {
  const j = readJournal(ctx.paths.journal);
  const journal: 'present' | 'none' = j !== 'none' && (j.rebase !== undefined || j.stash !== undefined) ? 'present' : 'none';
  for (const m of pendingRescues(ctx.paths)) {
    if (m.owner === 'journal' && journal === 'present') continue;   // P4 owns it
    const r = await rescueRestore(ctx, m);
    acc.conflicts.push(...r.copies);
    acc.overridden.push(...r.overridden.map((path): OverriddenDelete => ({ path, deletedBy: 'local' })));
    ctx.log.warn('recovered', { action: 'rescue-restored', paths: r.restored, copies: r.copies });
    acc.actions.push('rescue-restored');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// P4 journal: the move part, the legacy parts, settle, orphaned temp folders

// resumeMove and whatever its reason has after the move part.
async function finishMovePart(ctx: RunContext, acc: Acc, j: MoveJournal): Promise<Step> {
  const r: ResumeOutcome = await resumeMove(ctx, j);
  ctx.log.warn('recovered', { action: 'journal-resumed', op: 'move', phase: j.phase, reason: j.reason });
  acc.actions.push('journal-resumed');
  switch (r.kind) {
    case 'moved':
      absorbMove(acc, r);
      return 'continue';
    case 'busy':
    case 'failed':
    case 'data-guard-stop':
      return stopFromMove(r, acc);
    case 'quit-tail':
      absorbMove(acc, r.result.kind === 'moved' ? r.result : { kind: 'moved', final: '', copies: [], overridden: [], raced: [], commit: 'none' });
      return p2Tail(ctx, acc, r.j.quit?.op ?? 'rebase', r.j.quit?.stashBefore ?? 'none');
    case 'stash-tail': {
      const y = await stashTail(ctx, r.j);
      if (y.kind !== 'resolved') return stopFrom(y, acc);
      absorb(acc, y);
      return 'continue';
    }
    case 'rerun':
      switch (r.reason) {
        case 'op-quit':
          return p2Continue(ctx, acc, r.j);
        case 'stash-replay': {
          const st = r.j.stash;
          if (st === undefined || (await stashIndexOf(ctx.git, st.sha)) === 'absent') {
            clearMovePart(ctx, []);
            return 'continue';
          }
          if (r.j.phase === 'index' || r.j.phase === 'ref') {
            const t5 = await stashT5(ctx, r.j);
            if (t5 !== 'ok') return stopFrom(t5, acc);
            const y = await stashTail(ctx, { ...r.j, phase: 'drop' });
            if (y.kind !== 'resolved') return stopFrom(y, acc);
            absorb(acc, y);
            return 'continue';
          }
          const y = await replayStash(ctx, { stash: st.sha, unmerged: await unmergedPolicy(ctx),
            reuse: { target: r.j.to, copies: r.j.copies } });
          if (y.kind !== 'resolved') return stopFrom(y, acc);
          absorb(acc, y);
          return 'continue';
        }
        default:
          return 'continue';   // unmerged-recovery (P5) and rescue-restore (P3) redo their own plan from the files
      }
  }
}

async function p4Journal(ctx: RunContext, acc: Acc): Promise<Step> {
  let j = readJournal(ctx.paths.journal);
  if (j !== 'none' && j.move !== undefined) {
    const r = await finishMovePart(ctx, acc, j.move);
    if (r !== 'continue') return r;
    j = readJournal(ctx.paths.journal);
  }
  if (j !== 'none' && (j.stash !== undefined || j.rebase !== undefined)) {
    const r = await resumeJournal(ctx, j);
    if (r.kind !== 'resolved') return stopFrom(r, acc);
    absorb(acc, r);
    for (const part of [j.stash, j.rebase]) {
      if (part === undefined) continue;
      ctx.log.warn('recovered', { action: 'journal-resumed', op: part.op, phase: part.phase, copies: r.copies });
    }
    acc.actions.push('journal-resumed');
    // Journal-owned manifests whose journal is gone (P3 skipped them while it existed).
    const after = readJournal(ctx.paths.journal);
    if (after === 'none' || (after.rebase === undefined && after.stash === undefined)) await p3Rescues(ctx, acc);
  }
  // replaced inodes whose grace has passed; entries not yet due never block (their paths hold the new version)
  const settled = await settlePending(ctx, 'due');
  acc.conflicts.push(...settled.late);
  const orphans = await recoverOrphanTemps(ctx);
  if (orphans !== 'none') {
    ctx.log.warn('recovered', { action: 'orphan-temps', paths: orphans.paths.slice(0, 50), count: orphans.count });
    acc.actions.push('orphan-temps');
  }
  return 'continue';
}

// ---------------------------------------------------------------------------------------------------------------
// P5 leftover stash / unmerged entries

// Conservative recovery: git's conflict output (markers included) and any agent edit stay in an uncommitted copy (a
// hard link), then each path goes back to HEAD's version with a checked put; the index follows (`reset -q`).
async function recoverUnmerged(ctx: RunContext, acc: Acc, unmerged: readonly string[]): Promise<Step> {
  const g = ctx.git;
  const head = await headStateOf(ctx);
  const headTree = head.sha === 'unborn' ? new Map<string, TreeEntry>() : await lsTree(g, head.sha);
  const name = copyNamer(ctx, [...headTree.keys(), ...(await indexEntries(g)).keys()]);
  const versions = head.sha === 'unborn' ? new Map() : await checkoutVersions(ctx, head.sha, unmerged.filter((p) => headTree.has(p)));
  const ops: WorktreeOp[] = [];
  const copies: string[] = [];
  for (const p of unmerged) {
    const cur = await surveyPath(ctx, head.sha === 'unborn' ? ctx.emptyTree : head.sha, p);
    if (cur.seen.kind !== 'file' && cur.seen.kind !== 'symlink') continue;   // a folder at p is left alone
    const copy = name(p);
    copies.push(copy);
    ops.push({ op: 'copy', path: p, copy, expect: cur.seen });
    ops.push({ op: 'put', path: p, expect: cur.seen, want: versions.get(p) ?? { kind: 'absent' }, copy });
  }
  if (ops.length > 0) {
    const j: MoveJournal = { op: 'move', reason: 'unmerged-recovery', phase: 'writing', from: head.sha === 'unborn' ? 'empty' : head.sha,
      head, to: head.sha === 'unborn' ? ctx.emptyTree : head.sha, base: head.sha === 'unborn' ? ctx.emptyTree : head.sha,
      ref: { kind: 'none' }, index: 'reset', temps: [], copies: [], startedAt: new Date(ctx.clock.now()).toISOString() };
    mutateJournal(ctx.paths.journal, (x) => ({ ...x, move: j }));
    const a = await applyOps(ctx, ops, j, { onChanged: 'skip' });
    if (a.kind !== 'applied') {
      if (a.kind === 'failed') clearMovePart(ctx, a.asides ?? []);
      return a.kind === 'busy' ? { kind: 'busy', reason: 'move' } : { kind: 'failed', error: a.error, keptStashes: acc.kept };
    }
    clearMovePart(ctx, a.asides);
    acc.conflicts.push(...a.raced);
  }
  await g.ok(['reset', '-q']);
  const made = copies.filter((c) => kindAt(join(ctx.realDir, c)) !== 'missing');
  acc.conflicts.push(...made);
  ctx.log.warn('recovered', { action: 'unmerged-recovered', paths: [...unmerged], copies: made });
  ctx.log.warn('conflict', { kind: 'rescue', paths: [...unmerged], copies: made });
  acc.actions.push('unmerged-recovered');
  return 'continue';
}

// Unmerged paths whose file is AUTO_MERGE:<p> are git's own conflict output; with none, there is nothing to tell.
async function unmergedPolicy(ctx: RunContext): Promise<StashUnmerged> {
  if ((await unmergedPaths(ctx.git)).length === 0) return { kind: 'skip' };
  return { kind: 'auto-merge', tree: await revParse(ctx.git, 'AUTO_MERGE^{tree}') };
}

async function p5Leftovers(ctx: RunContext, acc: Acc, kept: readonly string[]): Promise<Step> {
  const g = ctx.git;
  const top = await stashTop(g);
  const unmerged = await unmergedPaths(g);
  const eligible = top !== 'none' && isMdsyncStash(top.subject) && !kept.includes(top.sha) && !acc.kept.includes(top.sha);
  if (top !== 'none' && eligible) {
    const r = await replayStash(ctx, { stash: top.sha, unmerged: await unmergedPolicy(ctx) });
    if (r.kind !== 'resolved') return stopFrom(r, acc);
    absorb(acc, r);
    ctx.log.warn('recovered', { action: 'stash-conflict-resumed', copies: r.copies });
    acc.actions.push('stash-conflict-resumed');
    return 'continue';
  }
  if (unmerged.length > 0) return recoverUnmerged(ctx, acc, unmerged);
  return 'continue';
}

// ---------------------------------------------------------------------------------------------------------------
// P6 branch

// HEAD as a symref to a name git itself rejects: `git clone` writes `ref: refs/heads/.invalid` until its checkout, so
// a clone killed before that (SIGKILL, docker stop, power loss) leaves it behind and `symbolic-ref` fails (exit 128).
function invalidHeadRef(ctx: RunContext): string | 'none' {
  try {
    const m = /^ref: (\S+)\s*$/.exec(readFileSync(join(ctx.gitDir, 'HEAD'), 'utf8'));
    return m?.[1] ?? 'none';
  } catch {
    return 'none';
  }
}

// D32 for a clone: origin has history on other branches but none on B. Creating B here (P6 from the checked-out
// branch, or S2's first commit on an unborn B) forks the remote into a branch nothing else reads; every note committed
// there was stranded once the config named the real branch, and a shutdown push published the fork.
async function missingOnOrigin(ctx: RunContext): Promise<string | 'none'> {
  const g = ctx.git;
  if ((await revParse(g, `refs/remotes/origin/${ctx.branch}`)) !== 'none') return 'none';
  const strip = (ref: string): string => ref.trim().replace(/^refs\/remotes\/origin\//, '');
  const others = (await g.ok(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/'])).split('\n').map(strip)
    .filter((b) => b !== '' && b !== 'HEAD');
  if (others.length === 0) return 'none';
  const head = await g.run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  const name = head.code === 0 && others.includes(strip(head.stdout)) ? strip(head.stdout) : others[0] ?? '';
  return `origin has no branch ${ctx.branch} (its default branch is ${name}); set "branch": "${name}" in the config, `
    + `or create ${ctx.branch} on the remote`;
}

async function p6Branch(ctx: RunContext, acc: Acc): Promise<Step> {
  const g = ctx.git;
  const want = `refs/heads/${ctx.branch}`;
  const zero = '0'.repeat(ctx.objectFormat === 'sha256' ? 64 : 40);
  let cur: string | 'detached';
  try {
    cur = await currentBranchRef(g);
  } catch (e) {
    const bad = invalidHeadRef(ctx);
    if (bad === 'none' || (await headSha(g)) !== 'unborn') throw e;
    // An interrupted first clone: point the unborn HEAD at B; the next fetch and S4u complete the clone.
    await g.ok(['symbolic-ref', 'HEAD', want]);
    ctx.log.warn('recovered', { action: 'branch-fixed', from: bad.replace(/^refs\/heads\//, ''), to: ctx.branch });
    acc.actions.push('branch-fixed');
    return 'continue';
  }
  const fail = (error: string): Step => ({ kind: 'failed', error, keptStashes: acc.kept });
  const head = await headSha(g);
  if (cur === want) {
    const missing = head === 'unborn' ? await missingOnOrigin(ctx) : 'none';
    return missing === 'none' ? 'continue' : fail(missing);
  }
  const from = cur === 'detached' ? 'detached HEAD' : cur.replace(/^refs\/heads\//, '');
  let adopted = 0;
  if (cur !== 'detached' && head === 'unborn') {
    const missing = await missingOnOrigin(ctx);
    if (missing !== 'none') return fail(missing);
    await g.ok(['symbolic-ref', 'HEAD', want]);
  } else {
    if ((await trackedDirty(ctx)).length > 0) return fail(`checked out ${from}, expected ${ctx.branch}, and the worktree has changes`);
    if (head === 'unborn') return fail(`checked out ${from}, expected ${ctx.branch}`);
    const remote = `refs/remotes/origin/${ctx.branch}`;
    const local = await revParse(g, want);
    const tracking = await revParse(g, remote);
    // No `git checkout`: it silently overwrote ignored files in the way and anything written between its check and
    // its write. B moves with a compare-and-swap, and the folder with checked writes.
    const attach = async (old: string): Promise<void> => {
      await g.ok(['update-ref', '-m', 'mdsync: branch-fix', want, head, old]);
      await g.ok(['symbolic-ref', 'HEAD', want]);
    };
    if (local === 'none' && tracking === 'none') {
      const missing = await missingOnOrigin(ctx);
      if (missing !== 'none') return fail(missing);
      await attach(zero);   // B is created at HEAD: only refs move
    } else {
      // Local commits on what is checked out that neither B nor any remote branch has: switching would take their
      // files off the disk and leave them unsynced (on a detached HEAD, reachable from nothing but the reflog).
      // Commits a remote branch has are safe there (a fresh clone of `main` with "branch": "notes").
      const anchor = local !== 'none' ? local : tracking;
      const extra = Number((await g.ok(['rev-list', '--count', 'HEAD', ...(local !== 'none' ? [`^${local}`] : []),
        '--not', '--remotes', '--'])).trim());
      if (extra > 0) {
        if (cur !== 'detached' || (await isAncestor(g, anchor, 'HEAD')) !== 'ancestor') {
          const short = cur === 'detached' ? head.slice(0, 12) : from;
          return fail(`checked out ${from}, which has ${extra} commit(s) that ${ctx.branch} does not have; mdsync syncs `
            + `${ctx.branch} only: merge them into it (git checkout ${ctx.branch} && git merge ${short}), or check out `
            + `${ctx.branch} yourself`);
        }
        // Local work on a detached HEAD on top of B: B moves forward to it, so it is synced like any local commit.
        await attach(local !== 'none' ? local : zero);
        adopted = extra;
      } else {
        const to = local !== 'none' ? local : tracking;
        const mv = await moveWorktree(ctx, { reason: 'branch-fix', from: head, to,
          ref: { kind: 'update', ref: want, old: local !== 'none' ? local : 'zero', head: 'attach' }, index: 'changed-paths',
          edits: 'merge', copies: 'commit' });
        if (mv.kind !== 'moved') return stopFromMove(mv, acc);
        absorbMove(acc, mv);
      }
    }
  }
  ctx.log.warn('recovered', { action: 'branch-fixed', from, to: ctx.branch, ...(adopted > 0 ? { adopted } : {}) });
  acc.actions.push('branch-fixed');
  return 'continue';
}

// ---------------------------------------------------------------------------------------------------------------

export async function preflight(ctx: RunContext, o: { keptStashes: readonly string[]; cloned: 'fresh-clone' | 'none' }): Promise<PreflightResult> {
  const acc: Acc = { actions: [], conflicts: [], overridden: [], kept: [] };
  try {
    const p0 = await p0Repo(ctx);
    if (p0 !== 'continue') return p0;
    const p1 = await p1Locks(ctx, acc);
    if (p1 !== 'continue') return p1;
    const p1b = await p1bIndex(ctx, acc, o.cloned);
    if (p1b !== 'continue') return p1b;
    const p2 = await p2InProgress(ctx, acc);
    if (p2 !== 'continue') return p2;
    await p3Rescues(ctx, acc);
    const j = readJournal(ctx.paths.journal);
    if (j !== 'none' || hasTempFolder(ctx)) {
      const p4 = await p4Journal(ctx, acc);
      if (p4 !== 'continue') return p4;
    }
    const p5 = await p5Leftovers(ctx, acc, o.keptStashes);
    if (p5 !== 'continue') return p5;
    const p6 = await p6Branch(ctx, acc);
    if (p6 !== 'continue') return p6;
  } catch (e) {
    return { kind: 'failed', error: errorText(e), keptStashes: acc.kept };
  }
  return { kind: 'ready', actions: acc.actions, conflicts: acc.conflicts, overriddenDeletes: acc.overridden, keptStashes: acc.kept };
}

// P4 also runs for a `.mdsync-*.d` folder at the worktree top (one readdir): an orphan the journal no longer knows.
function hasTempFolder(ctx: RunContext): boolean {
  try {
    return readdirSync(ctx.realDir).some((n) => /^\.mdsync-\d+-\d+\.d$/.test(n));
  } catch {
    return false;
  }
}
