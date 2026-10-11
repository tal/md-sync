// Staging, committing, index ops, and trees/commits built in a temporary index.
import { lstatSync, type Stats } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { buildCommitMessage, subjectOf } from './commit-message';
import type { RunContext } from './context';
import { GitError, classifyFailure, lsTree, parseNul, type GitResult, type TreeEntry, unmergedPaths } from './git';
import { RAW_PATHS, splitByIndex, unstageable, unstageableSet } from './pending';
import { readLocalOnly, writeLocalOnly } from './state';
import type { ChangeEntry, CommitPlan, CommitScope, CommitSource } from './types';

export type StageResult = { kind: 'staged'; changes: ChangeEntry[] } | { kind: 'nothing' };
export type IndexOp = { op: 'set'; path: string; mode: string; sha: string } | { op: 'remove'; path: string };
export type BuiltTree = { tree: string; entries: Map<string, TreeEntry> };

const LARGE_FILE_BYTES = 5 * 1024 * 1024;

type DropReason = 'ignored' | 'missing';

function check(args: string[], r: GitResult, okCodes: readonly number[] = [0]): void {
  if (!okCodes.includes(r.code)) throw new GitError(args, r, classifyFailure(r, 'local'));
}

function lstatOrNone(abs: string): Stats | 'none' {
  try {
    return lstatSync(abs);
  } catch {
    return 'none';
  }
}

// 'a//b/./c/' -> 'a/b/c'; '' for anything that names the repo root or leaves it.
function normalizeRel(p: string): string {
  const n = posix.normalize(p.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (n === '.' || n === '' || n === '..' || n.startsWith('../') || n.startsWith('/')) return '';
  return n;
}

// Paths `git check-ignore` reports as ignored (exit 0: prints them; 1: none). Tracked paths are never reported.
export async function checkIgnored(ctx: RunContext, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const args = ['check-ignore', '-z', '--stdin'];
  const r = await ctx.git.run(args, { input: paths.map((p) => `${p}\0`).join('') });
  check(args, r, [0, 1]);
  return new Set(r.code === 0 ? parseNul(r.stdout) : []);
}

// Local-only copies the user has since deleted (or moved) are forgotten.
function pruneLocalOnly(ctx: RunContext): void {
  const reg = readLocalOnly(ctx.paths.localOnly);
  const kept = [...reg].filter((c) => lstatOrNone(join(ctx.realDir, c)) !== 'none');
  if (kept.length !== reg.size) writeLocalOnly(ctx.paths.localOnly, kept);
}

// Logged once per path and process: the folder stays there, and every commit run would say it again.
const warnedNested = new Set<string>();

const ADD_TRIES = 3;
const VANISHED_RE = /unable to stat '[^']*': No such file or directory|open\("[^"]*"\): No such file or directory/;

// `git add` lists the folder, then lstats and opens each entry it listed: one that vanished in between (an editor's
// atomic-save temp renamed away, a note deleted) makes it exit 128 ("unable to stat '<p>': No such file or directory",
// or `open("<p>")` failing while it hashes), and the run failed although nothing was wrong (chaos seed 111). The add
// is run again: the next listing no longer has it.
async function addRetrying(ctx: RunContext, args: string[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const r = await ctx.git.run(args, { durable: 'durable' });   // its blobs go into the commit HEAD moves to
    if (r.code === 0) return;
    if (attempt < ADD_TRIES && VANISHED_RE.test(r.stderr)) continue;
    throw new GitError(args, r, classifyFailure(r, 'local'));
  }
}

export async function stageForCommit(ctx: RunContext, scope: CommitScope): Promise<StageResult> {
  if ((await unmergedPaths(ctx.git)).length > 0) throw new Error('unmerged entries present');

  const untracked = parseNul(await ctx.git.ok(['ls-files', '-z', '--others', '--exclude-standard']));
  pruneLocalOnly(ctx);
  const skip = await unstageable(ctx, untracked);
  if (skip.caseCollided.length > 0) ctx.log.warn('case collision', { paths: skip.caseCollided, action: 'unstaged' });
  for (const p of skip.nested) {
    if (warnedNested.has(p)) continue;
    warnedNested.add(p);
    ctx.log.warn('nested repository not synced', { path: p });
  }
  const never = [...unstageableSet(skip)];
  const excludes = [...ctx.ignore.pathspecExcludes, ...never.map((p) => `:(exclude,literal)${p}`)];

  if (scope.kind === 'all') {
    await addRetrying(ctx, ['add', '-A', '--', '.', ...excludes]);
  } else {
    await ctx.git.ok(['reset', '-q']);
    const dropped: { path: string; reason: DropReason }[] = [];
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const raw of scope.paths) {
      const p = normalizeRel(raw);
      if (p === '') {
        dropped.push({ path: raw, reason: 'missing' });
        continue;
      }
      if (seen.has(p)) continue;
      seen.add(p);
      if (ctx.ignore.matches(p)) dropped.push({ path: p, reason: 'ignored' });
      else candidates.push(p);
    }
    const gitIgnored = await checkIgnored(ctx, candidates);
    const kept: string[] = [];
    // A path some index entry spells differently (an NFD-named note, another letter case) is staged by that spelling.
    const split = await splitByIndex(ctx, candidates);
    const spelledInIndex = new Set(candidates.filter((p) => !split.other.includes(p)));
    // Only paths neither ignored, spelled in the index nor on disk can still be tracked: one batched ls-files says
    // which. An empty answer settles all of them; a path the answer does not name by its exact bytes (git folds case
    // or normalizes Unicode in pathspecs) is asked about on its own, as before.
    const probe = candidates.filter((p) => !gitIgnored.has(p) && !spelledInIndex.has(p)
      && lstatOrNone(join(ctx.realDir, p)) === 'none');
    const stillTracked = new Set<string>();
    if (probe.length > 0) {
      const listed = parseNul(await ctx.git.ok(['ls-files', '-z', '--', ...probe.map((p) => `:(literal)${p}`)]));
      if (listed.length > 0) {
        for (const p of probe) {
          if (listed.some((e) => e === p || e.startsWith(`${p}/`))
            || (await ctx.git.ok(['ls-files', '-z', '--', `:(literal)${p}`])) !== '') stillTracked.add(p);
        }
      }
    }
    for (const p of candidates) {
      if (gitIgnored.has(p)) {
        dropped.push({ path: p, reason: 'ignored' });
      } else if (spelledInIndex.has(p) || lstatOrNone(join(ctx.realDir, p)) !== 'none' || stillTracked.has(p)) {
        kept.push(p);
      } else {
        dropped.push({ path: p, reason: 'missing' });
      }
    }
    if (dropped.length > 0) ctx.log.info('flush paths dropped', { dropped });
    if (kept.length === 0) return { kind: 'nothing' };
    const asGiven = kept.filter((p) => !spelledInIndex.has(p));
    if (asGiven.length > 0) await addRetrying(ctx, ['add', '-A', '--', ...asGiven.map((p) => `:(literal)${p}`), ...excludes]);
    const tracked = (await splitByIndex(ctx, kept.filter((p) => spelledInIndex.has(p)))).tracked;
    if (tracked.length > 0) await addRetrying(ctx, [...RAW_PATHS, 'add', '-A', '--', ...tracked.map((p) => `:(literal)${p}`), ...excludes]);
  }
  // The excludes are only a first line: on macOS git rewrites an NFD exclude into NFC, and `add` then staged the NFD
  // entry of an NFC+NFD pair with the other spelling's bytes. Index entries of never-staged paths are put back to HEAD
  // (through stdin, which git does not rewrite).
  if (never.length > 0) await resetIndexEntries(ctx, never);

  const quiet = ['diff', '--cached', '--quiet'];
  const q = await ctx.git.run(quiet);
  check(quiet, q, [0, 1]);
  if (q.code === 0) return { kind: 'nothing' };

  const fields = parseNul(await ctx.git.ok(['diff', '--cached', '--name-status', '--no-renames', '-z']));
  const changes: ChangeEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push({ status: fields[i]!, path: fields[i + 1]! });

  for (const c of changes) {
    if (c.status !== 'A' && c.status !== 'M') continue;
    const st = lstatOrNone(join(ctx.realDir, c.path));
    if (st !== 'none' && st.size > LARGE_FILE_BYTES) ctx.log.warn('large file', { path: c.path, bytes: st.size });
  }
  return { kind: 'staged', changes };
}

// Index entries of `paths` back to HEAD's (removed when HEAD has none), exact spellings.
async function resetIndexEntries(ctx: RunContext, paths: readonly string[]): Promise<void> {
  const head = await ctx.git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  const tree = head.code === 0 ? await lsTree(ctx.git, head.stdout.trim()) : new Map<string, TreeEntry>();
  const zero = '0'.repeat(ctx.objectFormat === 'sha256' ? 64 : 40);
  const lines = paths.map((p) => {
    const e = tree.get(p);
    return e !== undefined ? `${e.mode} ${e.sha} 0\t${p}\0` : `0 ${zero} 0\t${p}\0`;
  });
  await ctx.git.ok(['update-index', '-z', '--index-info'], { input: lines.join('') });
}

export async function commitIndex(ctx: RunContext, message: string): Promise<string> {
  await ctx.git.ok(['commit', '-q', '--no-verify', '--cleanup=whitespace', '-F', '-'], { input: message, durable: 'durable' });
  return (await ctx.git.ok(['rev-parse', '--verify', 'HEAD'])).trim();
}

function primarySource(sources: readonly CommitSource[]): CommitSource {
  return sources.find((s) => s !== 'backup') ?? 'backup';
}

export async function commitRun(ctx: RunContext, plan: CommitPlan):
  Promise<{ kind: 'committed'; sha: string; changes: ChangeEntry[] } | { kind: 'nothing' }> {
  const staged = await stageForCommit(ctx, plan.scope);
  if (staged.kind === 'nothing') {
    ctx.log.debug('nothing to commit');
    return { kind: 'nothing' };
  }
  const message = buildCommitMessage({ plan, host: ctx.host, now: new Date(ctx.clock.now()), changes: staged.changes });
  const sha = await commitIndex(ctx, message);
  ctx.log.info('committed', { sha, files: staged.changes.length, subject: subjectOf(message),
    source: primarySource(plan.sources) });
  return { kind: 'committed', sha, changes: staged.changes };
}

// Real index, or o.indexFile. Sets first, then removes (as in buildTree). update-index silently drops an entry
// that clashes file-vs-directory with another one, so callers verify trees built this way.
export async function applyIndexOps(ctx: RunContext, ops: readonly IndexOp[], o?: { indexFile?: string }): Promise<void> {
  const sets = ops.filter((op) => op.op === 'set');
  const removes = ops.filter((op) => op.op === 'remove');
  const ro = { indexFile: o?.indexFile };
  if (sets.length > 0) {
    await ctx.git.ok(['update-index', '-z', '--index-info'],
      { ...ro, input: sets.map((s) => `${s.mode} ${s.sha} 0\t${s.path}\0`).join('') });
  }
  if (removes.length > 0) {
    await ctx.git.ok(['update-index', '-z', '--force-remove', '--stdin'],
      { ...ro, input: removes.map((r) => `${r.path}\0`).join('') });
  }
}

let indexSeq = 0;

// A tree built from `parent` plus `ops` in a temporary index under <hash>.tmp/ (never .git/index). Its objects are
// written durably: the move's copies commit, the conflict replay's C and the stash replay's copies commit are
// built here, and a ref is moved to them next. git's default fsyncs the ref but not loose objects, so a power loss
// could leave the branch naming a tree or commit that is not on disk, and every later run failed until a person
// repaired the repository.
export async function buildTree(ctx: RunContext, parent: string | 'empty', ops: readonly IndexOp[]): Promise<BuiltTree> {
  await mkdir(ctx.paths.tmp, { recursive: true, mode: 0o700 });
  const indexFile = join(ctx.paths.tmp, `idx-${process.pid}-${++indexSeq}`);
  try {
    await ctx.git.ok(parent === 'empty' ? ['read-tree', '--empty'] : ['read-tree', parent], { indexFile });
    await applyIndexOps(ctx, ops, { indexFile });
    const tree = (await ctx.git.ok(['write-tree'], { indexFile, durable: 'durable' })).trim();
    return { tree, entries: await lsTree(ctx.git, tree) };
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
    await rm(`${indexFile}.lock`, { force: true }).catch(() => {});
  }
}

export async function commitTree(ctx: RunContext, tree: string, parent: string | 'none', message: string): Promise<string> {
  const args = ['commit-tree', '--no-gpg-sign', '-F', '-', ...(parent === 'none' ? [] : ['-p', parent]), tree];
  return (await ctx.git.ok(args, { input: message, durable: 'durable' })).trim();
}
