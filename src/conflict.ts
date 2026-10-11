// Conflict replay planning (moves via move.ts), stash replay, and the legacy journal resume.
// No git command writes the worktree: the conflict replay builds its one
// verified commit C in memory and then moves the folder to it with checked writes; the stash replay writes each path
// with a checked put that refuses anything an agent changed since.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { buildTree, commitTree, type IndexOp } from './commit';
import { buildConflictMessage, subjectOf } from './commit-message';
import { foldCase } from './conflict-name';
import type { RunContext } from './context';
import { kindAt, properPrefixes } from './fsutil';
import {
  headSha, indexEntries, lsTree, mergeBase, objectExists, parseNul, revParse, stashIndexOf, stashTop, type TreeEntry,
  unmergedStages, isMdsyncStash,
} from './git';
import { errorText } from './log';
import {
  applyOps, blobVersion, clearMovePart, copyCommittable, copyNamer, makeMerger, mergeAttrsOf, moveWorktree, type MoveResult,
  settleAsides, surveyPath, type WorktreeOp,
} from './move';
import {
  buildPlan, changedTriples, dataGuard, finalMap, foldClashes, type PathTriple, type Plan, type PlanEnv, planOps, type Side,
} from './replay-plan';
import { pendingRescues, type RescueManifest, type RescueReason, rescueRestore } from './rescue';
import {
  addLocalOnly, type Journal, type MoveJournal, mutateJournal, type RebaseJournal, readJournal, type StashJournal, updateJournal,
} from './state';
import type { OverriddenDelete } from './types';

export { copyCommittable, copyNamer, type CopyNamer } from './move';

// `keptStashes` names the stash shas behind `stash: 'kept'`, so callers can record
// them (S5z, P4, P5) without guessing which stash a nested replay kept.
export type ConflictResult =
  | { kind: 'resolved'; copies: string[]; overridden: OverriddenDelete[]; commit: string | 'none'; stash: 'dropped' | 'kept' | 'none';
      keptStashes?: string[] }
  | { kind: 'data-guard-stop'; error: string; stash: 'kept' | 'none'; keptStashes?: string[] }
  | { kind: 'failed'; error: string; stash: 'kept' | 'none'; keptStashes?: string[] }
  | { kind: 'busy'; error: string; keptStashes?: string[] };   // the index stayed locked, or churn outlasted MOVE_ROUNDS

const PRE_CONFLICT_MSG = 'mdsync pre-conflict';

type Resolved = Extract<ConflictResult, { kind: 'resolved' }>;

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sideOf(e: TreeEntry | undefined): Side {
  return e === undefined ? 'absent' : { mode: e.mode, sha: e.sha };
}

function sideEq(a: Side, b: Side): boolean {
  if (a === 'absent' || b === 'absent') return a === b;
  return a.mode === b.mode && a.sha === b.sha;
}

// Paths whose entry differs between two maps (mode, type or sha), or that only one map has.
function mapDiff(a: Map<string, TreeEntry>, b: Map<string, TreeEntry>): string[] {
  const out: string[] = [];
  for (const [p, e] of a) {
    const o = b.get(p);
    if (o === undefined || o.mode !== e.mode || o.sha !== e.sha || o.type !== e.type) out.push(p);
  }
  for (const p of b.keys()) if (!a.has(p)) out.push(p);
  return out.sort(byPath);
}

function withSets(base: Map<string, TreeEntry>, ops: readonly IndexOp[]): Map<string, TreeEntry> {
  const out = new Map(base);
  for (const op of ops) {
    if (op.op === 'remove') out.delete(op.path);
    else out.set(op.path, { mode: op.mode, type: op.mode === '160000' ? 'commit' : 'blob', sha: op.sha });
  }
  return out;
}

function nowDate(ctx: RunContext): Date {
  return new Date(ctx.clock.now());
}

function failed(error: string, kept: readonly string[] = []): ConflictResult {
  return kept.length > 0 ? { kind: 'failed', error, stash: 'kept', keptStashes: [...kept] } : { kind: 'failed', error, stash: 'none' };
}

function guardStop(error: string, kept: readonly string[] = []): ConflictResult {
  return kept.length > 0
    ? { kind: 'data-guard-stop', error, stash: 'kept', keptStashes: [...kept] }
    : { kind: 'data-guard-stop', error, stash: 'none' };
}

function keptOf(r: ConflictResult): string[] {
  return r.keptStashes ?? [];
}

function fromMove(mv: Exclude<MoveResult, { kind: 'moved' }>, kept: readonly string[] = []): ConflictResult {
  if (mv.kind === 'busy') return { kind: 'busy', error: mv.error };
  return mv.kind === 'data-guard-stop' ? guardStop(mv.error, kept) : failed(mv.error, kept);
}

function overriddenOf(plan: Plan): OverriddenDelete[] {
  const out: OverriddenDelete[] = [];
  for (const e of plan.entries) {
    const d = e.disposition;
    if (d.kind === 'delete-overridden' || d.kind === 'edit-restored') out.push({ path: e.triple.path, deletedBy: d.deletedBy });
  }
  return out;
}

function copyOrigins(plan: Plan): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of plan.entries) if (e.disposition.kind === 'conflict-copy') out.set(e.disposition.copyPath, e.triple.path);
  return out;
}

async function changedFiles(ctx: RunContext, from: string, to: string): Promise<number> {
  const r = await ctx.git.run(['diff-tree', '-r', '--name-only', '--no-renames', '-z', from, to, '--']);
  return r.code === 0 ? parseNul(r.stdout).length : 0;
}

async function logCommitted(ctx: RunContext, sha: string, parent: string): Promise<void> {
  const subject = subjectOf(await ctx.git.ok(['show', '-s', '--format=%s', sha, '--']));
  ctx.log.info('committed', { sha, files: await changedFiles(ctx, parent, sha), subject, source: 'conflict' });
}

function logOverridden(ctx: RunContext, overridden: readonly OverriddenDelete[]): void {
  for (const o of overridden) ctx.log.info('delete overridden', { path: o.path, deletedBy: o.deletedBy });
}

type Restored = { copies: string[]; overridden: OverriddenDelete[] };

async function restoreAll(ctx: RunContext, manifests: readonly RescueManifest[]): Promise<Restored> {
  const out: Restored = { copies: [], overridden: [] };
  for (const m of manifests) {
    const r = await rescueRestore(ctx, m);
    out.copies.push(...r.copies);
    out.overridden.push(...r.overridden.map((path): OverriddenDelete => ({ path, deletedBy: 'local' })));
  }
  return out;
}

function ownedManifests(ctx: RunContext, reason: RescueReason): RescueManifest[] {
  return pendingRescues(ctx.paths).filter((m) => m.owner === 'journal' && m.reason === reason);
}

// lstat(p) is a directory, or a proper prefix of p exists on disk and is not a directory: a put there would
// have to delete a folder, or write through a file or symlink.
function onDiskBlocked(ctx: RunContext, p: string): boolean {
  if (kindAt(join(ctx.realDir, p)) === 'dir') return true;
  for (const a of properPrefixes(p)) {
    const k = kindAt(join(ctx.realDir, a));
    if (k === 'missing') return false;
    if (k !== 'dir') return true;
  }
  return false;
}

async function headStateOf(ctx: RunContext): Promise<{ sha: string | 'unborn'; ref: string | 'detached' }> {
  const sha = await headSha(ctx.git);
  const r = await ctx.git.run(['symbolic-ref', '-q', 'HEAD']);
  return { sha, ref: r.code === 0 ? r.stdout.trim() : 'detached' };
}

// ---------------------------------------------------------------------------------------------------------------
// Case-fold precheck

export async function foldPrecheck(ctx: RunContext, local: string, remote: string, from: string | 'none' = 'none'): Promise<string[][]> {
  const m = from !== 'none' ? from : await mergeBase(ctx.git, local, remote);
  const base = m === 'unrelated' ? new Map<string, TreeEntry>() : await lsTree(ctx.git, m);
  const l = await lsTree(ctx.git, local);
  const r = await lsTree(ctx.git, remote);
  const f = new Set(r.keys());
  for (const t of changedTriples(base, l, r)) {
    if (t.local === 'absent') {
      if (sideEq(t.base, t.remote)) f.delete(t.path);
    } else {
      f.add(t.path);
    }
  }
  return foldClashes(f).filter((g) => g.some((p) => !r.has(p)));
}

// ---------------------------------------------------------------------------------------------------------------
// STASH REPLAY

// Two index spellings of one name (case, or NFC vs NFD) share one file on a case-insensitive disk, so one of them
// always looks modified, holding the other spelling's bytes. A stash takes that phantom along; replayed onto a remote
// edit of that spelling, it became a conflict copy of the other spelling's text. A "change" whose bytes are exactly
// another spelling's base entry is that phantom, not an edit.
function dropPhantoms(ctx: RunContext, triples: PathTriple[], base: Map<string, TreeEntry>): PathTriple[] {
  if (ctx.ignoreCase !== 'case-insensitive') return triples;
  const byFold = new Map<string, string[]>();
  for (const p of base.keys()) {
    const k = foldCase(p);
    const group = byFold.get(k);
    if (group === undefined) byFold.set(k, [p]);
    else group.push(p);
  }
  return triples.filter((t) => {
    if (t.local === 'absent' || t.base === 'absent') return true;
    const local = t.local;
    const others = (byFold.get(foldCase(t.path)) ?? []).filter((q) => q !== t.path);
    return !others.some((q) => base.get(q)?.sha === local.sha);
  });
}

// 'auto-merge': unmerged paths whose file is AUTO_MERGE:<p> (git's own conflict output) are disposable.
export type StashUnmerged = { kind: 'skip' } | { kind: 'auto-merge'; tree: string | 'none' };
// A resumed replay: the copies commit and the copy names are reused, never recomputed.
type StashReuse = { target: string; copies: MoveJournal['copies'] };

async function replayStashInner(ctx: RunContext, i: { stash: string; unmerged: StashUnmerged; reuse?: StashReuse }): Promise<ConflictResult> {
  const g = ctx.git;
  const s = i.stash;
  if ((await stashIndexOf(g, s)) === 'absent') return failed(`stash ${s} not found`);   // T1
  const head = await headStateOf(ctx);
  const h = head.sha;
  if (h === 'unborn') return failed(`cannot replay stash ${s} onto an unborn HEAD`);

  // T2
  const remote = await lsTree(g, h);
  const stashBase = await lsTree(g, `${s}^1`);
  const triples: PathTriple[] = dropPhantoms(ctx, changedTriples(stashBase, await lsTree(g, s), remote), stashBase);
  if ((await revParse(g, `${s}^3`)) !== 'none') {
    const seen = new Set(triples.map((t) => t.path));
    for (const [path, e] of await lsTree(g, `${s}^3`)) {
      if (!seen.has(path)) triples.push({ path, base: 'absent', local: { mode: e.mode, sha: e.sha }, remote: sideOf(remote.get(path)) });
    }
    triples.sort((a, b) => byPath(a.path, b.path));
  }
  const index = await indexEntries(g);
  const reusedNames = new Map((i.reuse?.copies ?? []).map((c) => [c.path, c.copy]));
  const fresh = copyNamer(ctx, [...remote.keys(), ...index.keys(), ...triples.map((t) => t.path), ...reusedNames.values()]);
  const nameCopy = (p: string): string => reusedNames.get(p) ?? fresh(p);
  const env: PlanEnv = { remote, ignoreCase: ctx.ignoreCase, blocked: (p) => onDiskBlocked(ctx, p) };
  // the stash replays onto H, so H's merge attributes apply, as in `stash apply` onto H
  const merger = makeMerger(ctx, { attrs: await mergeAttrsOf(ctx, h, triples.map((t) => t.path)) });
  const plan = await buildPlan(triples, merger, nameCopy, env);
  const guard = dataGuard(triples, plan, env);
  if (guard.kind === 'fail') {
    ctx.log.error('data guard stop', { phase: 'plan', paths: guard.paths, reason: guard.reason });
    ctx.log.error('stash kept', { stash: s, paths: guard.paths });
    return guardStop(`data guard stop (plan): ${guard.reason}: ${guard.paths.join(', ')}`, [s]);
  }

  // T3
  const p = planOps(plan);
  const origins = copyOrigins(plan);
  const overridden = overriddenOf(plan);
  const work = await buildTree(ctx, h, p.ops);
  const differing = mapDiff(work.entries, finalMap(plan, remote));
  if (differing.length > 0) {
    ctx.log.error('data guard stop', { phase: 'verify', paths: differing, reason: 'built tree does not match the plan' });
    ctx.log.error('stash kept', { stash: s, paths: differing });
    return guardStop(`data guard stop (verify): ${differing.join(', ')}`, [s]);
  }
  let target = h;
  let copiesRec: MoveJournal['copies'] = [];
  if (i.reuse !== undefined && i.reuse.target !== h && (await objectExists(g, i.reuse.target)) === 'present'
    && (await revParse(g, `${i.reuse.target}^`)) === h) {
    target = i.reuse.target;
    copiesRec = i.reuse.copies;
  } else {
    const commitCopies = new Set<string>();
    const localOnly: string[] = [];
    for (const c of p.copies) {
      if ((await copyCommittable(ctx, origins.get(c) ?? c, c)) === 'commit') commitCopies.add(c);
      else localOnly.push(c);
    }
    addLocalOnly(ctx.paths.localOnly, localOnly);
    if (commitCopies.size > 0) {
      const sets = p.ops.filter((op) => op.op === 'set' && commitCopies.has(op.path));
      const ct = await buildTree(ctx, h, sets);
      const off = mapDiff(ct.entries, withSets(remote, sets));
      if (off.length > 0) {
        ctx.log.error('data guard stop', { phase: 'verify', paths: off, reason: 'copies tree does not match HEAD plus the copies' });
        ctx.log.error('stash kept', { stash: s, paths: off });
        return guardStop(`data guard stop (verify): ${off.join(', ')}`, [s]);
      }
      target = await commitTree(ctx, ct.tree, h, buildConflictMessage({ host: ctx.host, now: nowDate(ctx), kind: 'stash',
        copies: [...commitCopies], overridden, replayedSubjects: [] }));
      copiesRec = sets.map((op) => ({ path: origins.get(op.path) ?? op.path, copy: op.path, blob: op.op === 'set' ? op.sha : '' }));
    }
  }

  // one checked put per written or deleted path (committed copies included: nothing arrives through a reset any more).
  // A path is written only while it holds git's version or H's: H's entry, S^1's, one of its stage blobs, or (an
  // unmerged path) AUTO_MERGE's. Anything else is an edit made after the stash was taken: it stays, and so does the stash.
  const stages = await unmergedStages(g);
  const autoMerge = i.unmerged.kind === 'auto-merge' && i.unmerged.tree !== 'none' ? await lsTree(g, i.unmerged.tree) : new Map<string, TreeEntry>();
  const ops: WorktreeOp[] = [];
  const skipped: string[] = [];
  // the planned writes and deletes, and every other path the stash changed or git left unmerged: what git's apply wrote
  // there (markers) goes back to the work tree's version (the old `reset --hard target` did that for every path)
  // Only a skipped write, delete or copy keeps the stash: at the other paths the plan keeps H's version, so whatever
  // stands there now (an edit, a folder) holds nothing of the stash.
  const required = new Set([...p.writes, ...p.deletes, ...copiesRec.map((c) => c.copy)]);
  const wants = [...new Set([...required, ...triples.map((t) => t.path), ...stages.keys()])];
  const skip = (w: string): void => {
    if (required.has(w)) skipped.push(w);
  };
  for (const w of wants) {
    const want = work.entries.get(w);
    const cur = await surveyPath(ctx, h, w);
    if (cur.seen.kind === 'dir' || cur.seen.kind === 'other') {
      skip(w);
      continue;
    }
    const curBlob = cur.seen.kind === 'absent' ? 'absent' : cur.blob;
    if (curBlob === (want?.sha ?? 'absent')) continue;   // already there (git's apply wrote it, or a resume)
    const theirs = new Set<string>();
    const add = (e: TreeEntry | undefined): void => {
      if (e !== undefined) theirs.add(e.sha);
    };
    add(remote.get(w));
    add(stashBase.get(w));
    for (const b of stages.get(w) ?? []) theirs.add(b);
    if (stages.has(w)) add(autoMerge.get(w));
    const gits = curBlob === 'absent' ? !remote.has(w) : theirs.has(curBlob);
    if (!gits) {
      skip(w);
      continue;
    }
    const version = want === undefined ? { kind: 'absent' as const } : await blobVersion(ctx, work.tree, w, want.sha, want.mode);
    ops.push({ op: 'put', path: w, expect: cur.seen, want: version });
  }

  // T4
  const j: MoveJournal = { op: 'move', reason: 'stash-replay', phase: 'writing', from: h, head, to: target, base: h,
    ref: target !== h ? { kind: 'update', ref: `refs/heads/${ctx.branch}`, old: h, head: 'as-is' } : { kind: 'none' },
    index: 'reset', temps: [], copies: copiesRec, stash: { sha: s, keep: 'drop', paths: [] },
    startedAt: nowDate(ctx).toISOString() };
  mutateJournal(ctx.paths.journal, (cur) => ({ ...cur, move: j }));
  const a = await applyOps(ctx, ops, j, { onChanged: 'skip' });
  if (a.kind !== 'applied') {
    if (a.kind === 'busy') return { kind: 'busy', error: a.error };   // the part stays at 'writing': P4 reruns the replay
    clearMovePart(ctx, a.asides ?? []);
    ctx.log.error('stash kept', { stash: s, paths: [] });
    return failed(a.error, [s]);
  }
  settleAsides(ctx, a.asides);

  // T5
  const keepPaths = [...new Set([...skipped, ...a.skipped.filter((w) => required.has(w)), ...a.raced])].sort(byPath);
  const decided: MoveJournal = { ...j, phase: 'index', stash: { sha: s, keep: keepPaths.length > 0 ? 'keep-stash' : 'drop', paths: keepPaths } };
  mutateJournal(ctx.paths.journal, (cur) => ({ ...cur, move: { ...(cur.move ?? decided), phase: 'index', stash: decided.stash } }));
  const t5 = await stashT5(ctx, decided);
  if (t5 !== 'ok') return t5;
  return stashTail(ctx, { ...decided, phase: 'drop' }, { copies: p.copies, overridden, origins: [...origins.values()].sort(byPath) });
}

// T5 from its step: the index is reset to the target, the branch moves to it, and the part goes to 'drop'. The part
// stays until the stash is dropped: cleared before the drop, a crash let P5 replay the same stash on top of `target`
// and push its copies twice (round 5).
export async function stashT5(ctx: RunContext, j: MoveJournal): Promise<'ok' | ConflictResult> {
  const g = ctx.git;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await g.run(['read-tree', '--reset', j.to]);
    if (r.code === 0) break;
    if (!/\.lock': File exists/.test(r.stderr) || Date.now() >= deadline) {
      return /\.lock': File exists/.test(r.stderr) ? { kind: 'busy', error: 'the index stayed locked (index.lock)' }
        : failed(`git read-tree --reset exited ${r.code}: ${r.stderr.trim()}`, [j.stash?.sha ?? '']);
    }
    await Bun.sleep(250);
  }
  await g.run(['update-index', '-q', '--refresh']);
  mutateJournal(ctx.paths.journal, (cur) => (cur.move === undefined ? cur : { ...cur, move: { ...cur.move, phase: 'ref' } }));
  if (j.ref.kind === 'update' && (await headSha(g)) !== j.to) {
    const zero = '0'.repeat(ctx.objectFormat === 'sha256' ? 64 : 40);
    const u = await g.run(['update-ref', '-m', 'mdsync: stash-replay', j.ref.ref, j.to, j.ref.old === 'zero' ? zero : j.ref.old]);
    if (u.code !== 0) {
      await g.run(['read-tree', '--reset', 'HEAD']);
      clearMovePart(ctx, []);
      return failed(`HEAD moved during the stash replay: ${u.stderr.trim()}`, j.stash !== undefined ? [j.stash.sha] : []);
    }
    await logCommitted(ctx, j.to, j.from);
  }
  mutateJournal(ctx.paths.journal, (cur) => (cur.move === undefined ? cur : { ...cur, move: { ...cur.move, phase: 'drop' } }));
  return 'ok';
}

// T8–T10: the keep decision journaled before the ref moved; then the stash is dropped or kept, and the part cleared.
export async function stashTail(ctx: RunContext, j: MoveJournal,
  o: { copies: string[]; overridden: OverriddenDelete[]; origins: string[] } = { copies: [], overridden: [], origins: [] }): Promise<ConflictResult> {
  const g = ctx.git;
  const st = j.stash ?? { sha: '', keep: 'drop' as const, paths: [] };
  let stash: Resolved['stash'] = 'dropped';
  const kept: string[] = [];
  if (st.keep === 'keep-stash') {
    for (const p of st.paths) ctx.log.warn('conflict write raced', { path: p });   // T8
    ctx.log.error('stash kept', { stash: st.sha, paths: st.paths });                // T9
    stash = 'kept';
    kept.push(st.sha);
  } else if (st.sha !== '') {
    const idx = await stashIndexOf(g, st.sha);
    if (idx !== 'absent') await g.ok(['stash', 'drop', '-q', `stash@{${idx}}`]);
  }
  clearMovePart(ctx, []);                                                           // T10
  const copies = o.copies.length > 0 ? o.copies : j.copies.map((c) => c.copy);
  if (copies.length > 0 || o.overridden.length > 0) {
    ctx.log.warn('conflict', { kind: 'stash', paths: o.origins, copies });
    logOverridden(ctx, o.overridden);
  }
  return { kind: 'resolved', copies, overridden: o.overridden, commit: j.to !== j.from ? j.to : 'none', stash, keptStashes: kept };
}

export async function replayStash(ctx: RunContext, i: { stash: string; unmerged: StashUnmerged; reuse?: StashReuse }): Promise<ConflictResult> {
  try {
    return await replayStashInner(ctx, i);
  } catch (e) {
    // The stash is still referenced (it is dropped only at T9); a move part written before the error resumes it.
    return failed(errorText(e));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// REBASE CONFLICT

async function replayedSubjects(ctx: RunContext, base: string | 'unrelated', local: string): Promise<string[]> {
  const range = base === 'unrelated' ? local : `${base}..${local}`;
  const r = await ctx.git.run(['log', '--format=%s', range, '--']);
  return r.code === 0 ? r.stdout.split('\n').filter((l) => l !== '') : [];
}

// entry 'replay-conflict': the in-memory replay hit a conflict or a merge commit; 'precheck': a case clash
// found before replaying. paths: the conflicting paths the replay reported (for the `conflict` log). base: the
// pre-fetch origin/B after a remote rewrite, where the local-only work starts ('none': the merge base).
export type RebaseConflictInput = { local: string; remote: string; entry: 'replay-conflict' | 'precheck'; paths?: string[];
  base?: string | 'none' };

async function handleRebaseConflictInner(ctx: RunContext, i: RebaseConflictInput): Promise<ConflictResult> {
  const g = ctx.git;
  const { local: l, remote: r } = i;
  if ((await headSha(g)) !== l) return failed(`HEAD is not at the local commit ${l}`);

  // R7–R9
  const mb = i.base !== undefined && i.base !== 'none' ? i.base : await mergeBase(g, l, r);
  const base = mb === 'unrelated' ? new Map<string, TreeEntry>() : await lsTree(g, mb);
  const localTree = await lsTree(g, l);
  const remote = await lsTree(g, r);
  const triples = changedTriples(base, localTree, remote);
  const index = await indexEntries(g);
  // The triples' paths too: a path only the merge base has (an older copy both sides renamed away) is a changed path,
  // and a copy named after it within the same minute stopped the replay at the data guard, for as long as {H, R} held.
  const nameCopy = copyNamer(ctx, [...remote.keys(), ...localTree.keys(), ...index.keys(), ...triples.map((t) => t.path)]);
  const env: PlanEnv = { remote, ignoreCase: ctx.ignoreCase, blocked: () => false };
  // R's merge attributes (a `merge=union` log, a configured driver), as the rebase onto R applied them
  const merger = makeMerger(ctx, { attrs: await mergeAttrsOf(ctx, r, triples.map((t) => t.path)) });
  const plan = await buildPlan(triples, merger, nameCopy, env);

  const guard = dataGuard(triples, plan, env);                                                         // R10
  if (guard.kind === 'fail') {
    ctx.log.error('data guard stop', { phase: 'plan', paths: guard.paths, reason: guard.reason });
    return guardStop(`data guard stop (plan): ${guard.reason}: ${guard.paths.join(', ')}`);
  }

  // R11
  const ops = planOps(plan);
  const built = await buildTree(ctx, r, ops.ops);
  const differing = mapDiff(built.entries, finalMap(plan, remote));
  if (differing.length > 0) {
    ctx.log.error('data guard stop', { phase: 'verify', paths: differing, reason: 'built tree does not match the plan' });
    return guardStop(`data guard stop (verify): ${differing.join(', ')}`);
  }
  const overridden = overriddenOf(plan);
  const remoteTree = await revParse(g, `${r}^{tree}`);
  const target = built.tree === remoteTree ? r : await commitTree(ctx, built.tree, r, buildConflictMessage({ host: ctx.host,
    now: nowDate(ctx), kind: 'rebase', copies: plan.copies, overridden, replayedSubjects: await replayedSubjects(ctx, mb, l) }));
  // I/O half of the guard: HEAD still equals L before the folder moves.
  if ((await headSha(g)) !== l) return failed(`HEAD moved during the conflict replay (expected ${l})`);

  // R13: the committed side is already in C (its copies included). The move writes C's version wherever the worktree
  // still holds L's, three-way merges every uncommitted edit onto C (a conflict: a copy, committed on top of C when
  // copyCommittable), and never overwrites anything else.
  const mv = await moveWorktree(ctx, { reason: 'conflict-replay', from: l, to: target,
    ref: { kind: 'update', ref: `refs/heads/${ctx.branch}`, old: l, head: 'as-is' }, index: 'changed-paths', edits: 'merge',
    copies: 'commit' });
  if (mv.kind !== 'moved') return fromMove(mv);
  if (target !== r) await logCommitted(ctx, target, r);                                                // R14

  // R16
  const origins = [...copyOrigins(plan).values()].sort(byPath);
  if (plan.copies.length > 0 || overridden.length > 0) {
    ctx.log.warn('conflict', { kind: 'rebase', paths: i.paths !== undefined && i.paths.length > 0 ? i.paths : origins, copies: plan.copies });
    logOverridden(ctx, overridden);
  }
  return { kind: 'resolved', copies: [...new Set([...plan.copies, ...mv.copies, ...mv.raced])],
    overridden: [...overridden, ...mv.overridden], commit: mv.commit !== 'none' ? mv.commit : target === r ? 'none' : target, stash: 'none' };
}

export async function handleRebaseConflict(ctx: RunContext, i: RebaseConflictInput): Promise<ConflictResult> {
  try {
    return await handleRebaseConflictInner(ctx, i);
  } catch (e) {
    // a move part (if any) stays: P4 resumes it by observed HEAD on the next run
    return failed(errorText(e));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Journal resume (legacy parts, written by versions before the worktree move): every `reset --hard` and `checkout-index -f`
// of the old rules is a checked put from the recorded trees. A put's expect is the current bytes when they are the
// pre-reset or the target version of the path; any other content is an edit, and it stays.

async function legacyPuts(ctx: RunContext, wants: ReadonlyMap<string, TreeEntry | 'absent'>, allowed: readonly Map<string, TreeEntry>[],
  attrRev: string): Promise<{ kind: 'ok'; skipped: string[] } | { kind: 'failed' | 'busy'; error: string }> {
  const g = ctx.git;
  const h = await headStateOf(ctx);
  const ops: WorktreeOp[] = [];
  const skipped: string[] = [];
  for (const [w, want] of wants) {
    const cur = await surveyPath(ctx, attrRev, w);
    if (cur.seen.kind === 'dir' || cur.seen.kind === 'other') {
      skipped.push(w);
      continue;
    }
    const curBlob = cur.seen.kind === 'absent' ? 'absent' : cur.blob;
    if (curBlob === (want === 'absent' ? 'absent' : want.sha)) continue;
    const ok = curBlob === 'absent' ? allowed.some((t) => !t.has(w)) : allowed.some((t) => t.get(w)?.sha === curBlob);
    if (!ok) {
      skipped.push(w);
      continue;
    }
    const version = want === 'absent' ? { kind: 'absent' as const } : await blobVersion(ctx, attrRev, w, want.sha, want.mode);
    ops.push({ op: 'put', path: w, expect: cur.seen, want: version });
  }
  if (ops.length === 0) return { kind: 'ok', skipped };
  const j: MoveJournal = { op: 'move', reason: 'rescue-restore', phase: 'writing', from: h.sha === 'unborn' ? 'empty' : h.sha, head: h,
    to: h.sha === 'unborn' ? attrRev : h.sha, base: h.sha === 'unborn' ? attrRev : h.sha, ref: { kind: 'none' }, index: 'changed-paths',
    temps: [], copies: [], startedAt: nowDate(ctx).toISOString() };
  mutateJournal(ctx.paths.journal, (cur) => ({ ...cur, move: j }));
  const a = await applyOps(ctx, ops, j, { onChanged: 'skip' });
  if (a.kind !== 'applied') {
    if (a.kind === 'failed') clearMovePart(ctx, a.asides ?? []);
    return { kind: a.kind, error: a.error };
  }
  clearMovePart(ctx, a.asides);
  void g;
  return { kind: 'ok', skipped: [...skipped, ...a.skipped] };
}

function writeStashPart(ctx: RunContext, j: StashJournal | 'clear'): void {
  updateJournal(ctx.paths.journal, 'stash', j);
}

function writeRebasePart(ctx: RunContext, j: RebaseJournal | 'clear'): void {
  updateJournal(ctx.paths.journal, 'rebase', j);
}

async function legacyStashFinish(ctx: RunContext, j: StashJournal, skipped: readonly string[], tail: Restored): Promise<ConflictResult> {
  const g = ctx.git;
  let stash: Resolved['stash'] = 'dropped';
  const kept: string[] = [];
  if (skipped.length > 0) {
    for (const w of skipped) ctx.log.warn('conflict write raced', { path: w });
    ctx.log.error('stash kept', { stash: j.stash, paths: [...skipped] });
    stash = 'kept';
    kept.push(j.stash);
  } else {
    const idx = await stashIndexOf(g, j.stash);
    if (idx !== 'absent') await g.ok(['stash', 'drop', '-q', `stash@{${idx}}`]);
  }
  writeStashPart(ctx, 'clear');
  if (j.copies.length > 0 || j.overridden.length > 0) {
    ctx.log.warn('conflict', { kind: 'stash', paths: [], copies: j.copies });
    logOverridden(ctx, j.overridden);
  }
  return { kind: 'resolved', copies: [...j.copies, ...tail.copies], overridden: [...j.overridden, ...tail.overridden],
    commit: j.target !== j.head ? j.target : 'none', stash, keptStashes: kept };
}

async function resumeStash(ctx: RunContext, j: StashJournal): Promise<ConflictResult> {
  const g = ctx.git;
  const owned = ownedManifests(ctx, 'stash-replay');
  const h = await headSha(g);

  if ((await stashIndexOf(g, j.stash)) === 'absent') {
    // Already dropped (T9 ran): the writes were verified.
    const r = await restoreAll(ctx, owned);
    writeStashPart(ctx, 'clear');
    return { kind: 'resolved', copies: [...j.copies, ...r.copies], overridden: [...j.overridden, ...r.overridden],
      commit: j.target !== j.head && h === j.target ? j.target : 'none', stash: 'dropped', keptStashes: [] };
  }
  if (j.phase === 'planned' && h === j.head) {
    await restoreAll(ctx, owned);
    writeStashPart(ctx, 'clear');
    return replayStash(ctx, { stash: j.stash, unmerged: { kind: 'skip' } });
  }
  if (j.phase === 'reset' && (h === j.head || h === j.target)) {
    // The reset may or may not have run, and the writes may be partial: three groups of checked puts.
    const headTree = await lsTree(g, j.head);
    const targetTree = await lsTree(g, j.target);
    const workTree = await lsTree(g, j.workTree);
    const wants = new Map<string, TreeEntry | 'absent'>();
    for (const p of new Set([...headTree.keys(), ...targetTree.keys()])) {
      const a = headTree.get(p);
      const b = targetTree.get(p);
      if (a?.sha !== b?.sha || a?.mode !== b?.mode) wants.set(p, b ?? 'absent');
    }
    for (const w of j.writes) wants.set(w, workTree.get(w) ?? 'absent');
    for (const d of j.deletes) wants.set(d, 'absent');
    const put = await legacyPuts(ctx, wants, [headTree, targetTree], j.workTree);
    if (put.kind !== 'ok') return put.kind === 'busy' ? { kind: 'busy', error: put.error } : failed(put.error, [j.stash]);
    await g.ok(['read-tree', '--reset', j.target]);
    await g.run(['update-index', '-q', '--refresh']);
    if ((await headSha(g)) === j.head && j.target !== j.head) {
      await g.ok(['update-ref', '-m', 'mdsync: stash-replay', `refs/heads/${ctx.branch}`, j.target, j.head]);
    }
    const r = await restoreAll(ctx, owned);
    return legacyStashFinish(ctx, j, put.skipped.filter((w) => j.writes.includes(w)), r);
  }
  if (j.phase === 'written' && h === j.target) {
    // T8: a written path that no longer holds its work-tree version raced an agent: the stash is kept
    const workTree = await lsTree(g, j.workTree);
    const raced: string[] = [];
    for (const w of j.writes) {
      const cur = await surveyPath(ctx, j.workTree, w);
      if ((cur.seen.kind === 'absent' ? 'absent' : cur.blob) !== (workTree.get(w)?.sha ?? 'absent')) raced.push(w);
    }
    const r = await restoreAll(ctx, owned);
    return legacyStashFinish(ctx, j, raced, r);
  }
  await restoreAll(ctx, owned);
  writeStashPart(ctx, 'clear');
  ctx.log.error('stash kept', { stash: j.stash, paths: [] });
  return failed(`stash journal state mismatch (phase ${j.phase}, HEAD ${h})`, [j.stash]);
}

async function legacyTail(ctx: RunContext, j: RebaseJournal, skip: ReadonlySet<string>, r: Restored): Promise<ConflictResult> {
  const copies = [...j.copies, ...r.copies];
  const overridden = [...j.overridden, ...r.overridden];
  let stash: Resolved['stash'] = 'none';
  const kept: string[] = [];
  if (j.stash !== 'none' && !skip.has(j.stash) && (await stashIndexOf(ctx.git, j.stash)) !== 'absent') {
    const y = await replayStash(ctx, { stash: j.stash, unmerged: { kind: 'skip' } });
    if (y.kind === 'failed' || y.kind === 'busy') return y;   // the rebase part stays; P4 retries the replay
    if (y.kind === 'data-guard-stop') {
      writeRebasePart(ctx, 'clear');   // the stash is kept and recorded: never replayed again
      return y;
    }
    copies.push(...y.copies);
    overridden.push(...y.overridden);
    stash = y.stash;
    kept.push(...keptOf(y));
  }
  writeRebasePart(ctx, 'clear');
  if (j.copies.length > 0 || j.overridden.length > 0) {
    ctx.log.warn('conflict', { kind: 'rebase', paths: [], copies: j.copies });
    logOverridden(ctx, j.overridden);
  }
  return { kind: 'resolved', copies, overridden, commit: j.target === j.remote || j.target === 'none' ? 'none' : j.target,
    stash, keptStashes: kept };
}

async function resumeRebase(ctx: RunContext, j: RebaseJournal, skip: ReadonlySet<string>): Promise<ConflictResult> {
  const g = ctx.git;
  const owned = ownedManifests(ctx, 'rebase-conflict');
  const h = await headSha(g);

  if (j.phase === 'aborting' || (j.phase === 'planned' && h === j.local)) {
    // Nothing destroyed; the next replay re-detects the conflict.
    const r = await restoreAll(ctx, owned);
    let y: ConflictResult | 'none' = 'none';
    const top = await stashTop(g);
    if (top !== 'none' && isMdsyncStash(top.subject) && top.subject !== 'autostash' && !skip.has(top.sha)
      && (await revParse(g, `${top.sha}^1`)) === j.local) {
      y = await replayStash(ctx, { stash: top.sha, unmerged: { kind: 'skip' } });
    }
    writeRebasePart(ctx, 'clear');
    if (y !== 'none' && y.kind !== 'resolved') return y;
    return { kind: 'resolved', copies: [...r.copies, ...(y === 'none' ? [] : y.copies)],
      overridden: [...r.overridden, ...(y === 'none' ? [] : y.overridden)], commit: 'none',
      stash: y === 'none' ? 'none' : y.stash, keptStashes: y === 'none' ? [] : keptOf(y) };
  }
  if (j.phase === 'committed' || (j.target !== 'none' && h === j.target)) {
    return legacyTail(ctx, j, skip, await restoreAll(ctx, owned));
  }
  if ((j.phase === 'stashed' || j.phase === 'reset') && h === j.local) {
    let stashSha = j.stash;
    if (j.stash !== 'none' && (await stashIndexOf(g, j.stash)) === 'absent') {
      // Crash between R12's journal write and `stash store` (probe e5): store it now.
      if ((await objectExists(g, j.stash)) === 'present') await g.ok(['stash', 'store', '-m', PRE_CONFLICT_MSG, j.stash]);
      else stashSha = 'none';
    }
    if (j.target === 'none' || (await objectExists(g, j.target)) === 'absent') {
      await restoreAll(ctx, owned);
      writeRebasePart(ctx, 'clear');
      return failed(`rebase journal target ${j.target} is missing`);
    }
    // Edits still in the worktree ride along: `stash create` never removed them, and a `reset --hard` killed partway
    // left HEAD at J.local.
    const mv = await moveWorktree(ctx, { reason: 'conflict-replay', from: j.local, to: j.target,
      ref: { kind: 'update', ref: `refs/heads/${ctx.branch}`, old: j.local, head: 'as-is' }, index: 'changed-paths', edits: 'merge',
      copies: 'commit' });
    if (mv.kind === 'busy') return fromMove(mv);
    if (mv.kind !== 'moved') {
      // The move was undone as far as is safe and HEAD is still L. The replay is abandoned (retrying the
      // same target would fail the same way on every run): the edits come back and the part is cleared.
      await restoreAll(ctx, owned);
      let kept: string[] = [];
      if (stashSha !== 'none' && (await stashIndexOf(g, stashSha)) !== 'absent') {
        kept = keptOf(await replayStash(ctx, { stash: stashSha, unmerged: { kind: 'skip' } }));
      }
      writeRebasePart(ctx, 'clear');
      return mv.kind === 'data-guard-stop' ? guardStop(mv.error, kept) : failed(`moving to the conflict replay failed: ${mv.error}`, kept);
    }
    const r = await restoreAll(ctx, owned);
    return legacyTail(ctx, { ...j, stash: stashSha, phase: 'committed' }, skip,
      { copies: [...r.copies, ...mv.copies, ...mv.raced], overridden: [...r.overridden, ...mv.overridden] });
  }

  // Anything else: put the worktree data back first, then give up on this replay.
  let y: ConflictResult | 'none' = 'none';
  if (j.stash !== 'none' && !skip.has(j.stash) && (await stashIndexOf(g, j.stash)) !== 'absent') {
    y = await replayStash(ctx, { stash: j.stash, unmerged: { kind: 'skip' } });
  }
  await restoreAll(ctx, owned);
  writeRebasePart(ctx, 'clear');
  return failed(`journal state mismatch: HEAD ${h}`, y === 'none' ? [] : keptOf(y));
}

function combine(results: readonly ConflictResult[]): ConflictResult {
  const kept = [...new Set(results.flatMap(keptOf))];
  const busy = results.find((r) => r.kind === 'busy');
  if (busy !== undefined) return { ...busy, keptStashes: kept };
  const bad = results.find((r) => r.kind === 'data-guard-stop') ?? results.find((r) => r.kind === 'failed');
  if (bad !== undefined && (bad.kind === 'data-guard-stop' || bad.kind === 'failed')) {
    return bad.kind === 'data-guard-stop' ? guardStop(bad.error, kept) : failed(bad.error, kept);
  }
  const ok = results.filter((r): r is Resolved => r.kind === 'resolved');
  const commits = ok.map((r) => r.commit).filter((c) => c !== 'none');
  const stash: Resolved['stash'] = kept.length > 0 ? 'kept' : ok.some((r) => r.stash === 'dropped') ? 'dropped' : 'none';
  return { kind: 'resolved', copies: ok.flatMap((r) => r.copies), overridden: ok.flatMap((r) => r.overridden),
    commit: commits[commits.length - 1] ?? 'none', stash, keptStashes: kept };
}

// The legacy `stash` and `rebase` parts: the stash part first, then the rebase part.
export async function resumeJournal(ctx: RunContext, j: Journal): Promise<ConflictResult> {
  try {
    const results: ConflictResult[] = [];
    const skip = new Set<string>();
    if (j.stash !== undefined) {
      const s = await resumeStash(ctx, j.stash);
      results.push(s);
      for (const k of keptOf(s)) skip.add(k);
      if (s.kind !== 'resolved') {
        skip.add(j.stash.stash);
        const still = readJournal(ctx.paths.journal);
        // A replay that failed mid-way keeps its part: finish it first, on the next run.
        if ((s.kind === 'failed' || s.kind === 'busy') && still !== 'none' && still.stash !== undefined) return s;
      }
    }
    if (j.rebase !== undefined) results.push(await resumeRebase(ctx, j.rebase, skip));
    return combine(results);
  } catch (e) {
    return failed(errorText(e));
  }
}

void lstatSync;
