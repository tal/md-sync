// Dirty-status, ahead-count, ignored-dir and never-staged queries. Read-only: never takes the
// index lock.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { copyOrigins, foldCase, isConflictCopy } from './conflict-name';
import { checkIgnored } from './commit';
import type { RunContext } from './context';
import { kindAt } from './fsutil';
import { classifyFailure, GitError, headSha, indexEntries, parseNul, revCount, revParse } from './git';
import { readLocalOnly } from './state';

export type PendingEntry = { xy: string; path: string };

// Paths that are never staged, so they never count as pending either: a backup timer armed
// for them would only fire an empty commit run, again after every pull.
export type Unstageable = {
  caseCollided: string[];   // index paths that share a foldCase with another index path (case-insensitive FS): the disk
                            //   holds one file for all of them, so all but one always look modified
  aliases: string[];        // untracked spellings of a tracked path (case-insensitive FS): git on macOS lists an
                            //   NFD-named tracked file as an untracked NFC name; it is the same file
  localOnly: string[];      // untracked conflict copies whose original is gitignored or matches `ignore`
  nested: string[];         // untracked folders holding a repository of their own (`git clone`/`git init` inside the
                            //   folder): `add -A` committed them as an empty gitlink, so nothing in them ever synced
};

type IndexFolds = { stamp: string; exact: Set<string>; byFold: Map<string, string[]> };
const foldCache = new WeakMap<RunContext, IndexFolds>();

function indexStamp(ctx: RunContext): string {
  try {
    const st = statSync(join(ctx.gitDir, 'index'));
    return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return 'none';
  }
}

// The index paths grouped by foldCase, reused while .git/index is unchanged (pendingChanges runs on every batch).
async function indexFolds(ctx: RunContext): Promise<IndexFolds> {
  const stamp = indexStamp(ctx);
  const hit = foldCache.get(ctx);
  if (hit !== undefined && stamp !== 'none' && hit.stamp === stamp) return hit;
  const exact = new Set((await indexEntries(ctx.git)).keys());
  const byFold = new Map<string, string[]>();
  for (const p of exact) {
    const k = foldCase(p);
    const g = byFold.get(k);
    if (g === undefined) byFold.set(k, [p]);
    else g.push(p);
  }
  const out: IndexFolds = { stamp, exact, byFold };
  foldCache.set(ctx, out);
  return out;
}

// `untracked`: the untracked paths to judge (all of them for staging, the `??` entries of a status for pendingChanges).
export async function unstageable(ctx: RunContext, untracked: readonly string[]): Promise<Unstageable> {
  let caseCollided: string[] = [];
  let aliases: string[] = [];
  if (ctx.ignoreCase === 'case-insensitive') {
    const f = await indexFolds(ctx);
    caseCollided = [...f.byFold.values()].filter((g) => g.length >= 2).flat().sort();
    aliases = untracked.filter((p) => !f.exact.has(p) && f.byFold.has(foldCase(p)));
  }
  // git lists an untracked nested repository as one `dir/` entry and never looks inside it
  const nested = untracked.filter((p) => p.endsWith('/') && kindAt(join(ctx.realDir, p, '.git')) !== 'missing')
    .map((p) => p.replace(/\/+$/, ''));
  const copies = untracked.filter(isConflictCopy);
  if (copies.length === 0) return { caseCollided, aliases, localOnly: [], nested };
  // Copies made as local-only stay local, whatever their original is now. For the rest: a copy's own name no
  // longer matches the pattern that kept its original off the remote, so the original decides. check-ignore never
  // reports tracked paths, so a tracked original (force-added, or tracked before its .gitignore line) keeps its
  // copies syncing, the same rule as copyCommittable.
  const registered = readLocalOnly(ctx.paths.localOnly);
  const origins = new Map(copies.map((c) => [c, copyOrigins(c)]));
  const probe = [...new Set([...origins.values()].flat())];
  const ignored = await checkIgnored(ctx, probe);
  const localOnly = copies.filter((c) => registered.has(c)
    || (origins.get(c) ?? []).some((o) => ignored.has(o) || ctx.ignore.matches(o)));
  return { caseCollided, aliases, localOnly, nested };
}

export function unstageableSet(u: Unstageable): Set<string> {
  return new Set([...u.caseCollided, ...u.aliases, ...u.localOnly, ...u.nested]);
}

// Gitlinks in the index (an embedded repo committed before mdsync stopped staging them): their content never syncs.
export async function indexGitlinks(ctx: RunContext): Promise<string[]> {
  return [...(await indexEntries(ctx.git))].filter(([, e]) => e.mode === '160000').map(([p]) => p).sort();
}

// git on macOS (core.precomposeunicode=true) turns every argv path into NFC, so a `:(literal)` pathspec never names an
// NFD-named index entry, and a typed path in another case never names a tracked file either. Calls that name tracked
// paths therefore use the exact index spellings and keep git from rewriting them.
export const RAW_PATHS = ['-c', 'core.precomposeunicode=false'] as const;

// Paths split by whether a spelling of them is tracked (case-insensitive repos): `tracked` holds the exact index
// spellings (all of a fold group), `other` the rest as given. Case-sensitive repos: everything is `other`.
export async function splitByIndex(ctx: RunContext, paths: readonly string[]): Promise<{ tracked: string[]; other: string[] }> {
  if (ctx.ignoreCase !== 'case-insensitive') return { tracked: [], other: [...paths] };
  const f = await indexFolds(ctx);
  const tracked = new Set<string>();
  const other: string[] = [];
  for (const p of paths) {
    const group = f.byFold.get(foldCase(p));
    if (group === undefined) other.push(p);
    else for (const q of group) tracked.add(q);
  }
  return { tracked: [...tracked], other };
}

// Above this many paths, one '.' pathspec is cheaper than a huge argv.
const MAX_LITERAL_PATHSPECS = 200;

// porcelain=v1 -z with --no-renames: one `XY <path>` record per entry, no second (orig) path.
function parsePorcelain(out: string): PendingEntry[] {
  const entries: PendingEntry[] = [];
  for (const rec of parseNul(out)) {
    if (rec.length < 4) continue;
    entries.push({ xy: rec.slice(0, 2), path: rec.slice(3) });
  }
  return entries;
}

async function statusOf(ctx: RunContext, pathspecs: readonly string[], spelling: 'precomposed' | 'raw'): Promise<PendingEntry[]> {
  const out = await ctx.git.ok([...(spelling === 'raw' ? RAW_PATHS : []), '--no-optional-locks', 'status', '--porcelain=v1',
    '-z', '--no-renames', '-uall', '--', ...pathspecs, ...ctx.ignore.pathspecExcludes]);
  return parsePorcelain(out);
}

export async function pendingChanges(ctx: RunContext, paths?: readonly string[]): Promise<PendingEntry[]> {
  if (paths !== undefined && paths.length === 0) return [];   // excludes alone would match everything
  let entries: PendingEntry[];
  if (paths === undefined || paths.length > MAX_LITERAL_PATHSPECS) {
    entries = await statusOf(ctx, ['.'], 'precomposed');
  } else {
    // tracked paths by their index spelling (an edit to an NFD-named note, through either spelling, is seen)
    const split = await splitByIndex(ctx, paths);
    entries = [];
    if (split.other.length > 0) entries.push(...await statusOf(ctx, split.other.map((p) => `:(literal)${p}`), 'precomposed'));
    if (split.tracked.length > 0) {
      const seen = new Set(entries.map((e) => `${e.xy}\0${e.path}`));
      for (const e of await statusOf(ctx, split.tracked.map((p) => `:(literal)${p}`), 'raw')) {
        if (!seen.has(`${e.xy}\0${e.path}`)) entries.push(e);
      }
    }
  }
  const untracked = entries.filter((e) => e.xy === '??').map((e) => e.path);
  if (entries.length === 0
    || (ctx.ignoreCase !== 'case-insensitive' && !untracked.some((p) => isConflictCopy(p) || p.endsWith('/')))) return entries;
  const skip = unstageableSet(await unstageable(ctx, untracked));
  return skip.size === 0 ? entries : entries.filter((e) => !skip.has(e.path) && !skip.has(e.path.replace(/\/+$/, '')));
}

// No `ignore` excludes: used for safety decisions, where every tracked change must count.
export async function trackedDirty(ctx: RunContext): Promise<PendingEntry[]> {
  const out = await ctx.git.ok(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--no-renames',
    '--untracked-files=no']);
  return parsePorcelain(out);
}

// Local commits not yet on refs/remotes/origin/B. An unborn HEAD has none.
export async function aheadCount(ctx: RunContext): Promise<number | 'no-remote-branch'> {
  const remote = `refs/remotes/origin/${ctx.branch}`;
  if ((await revParse(ctx.git, remote)) === 'none') return 'no-remote-branch';
  if ((await headSha(ctx.git)) === 'unborn') return 0;
  return revCount(ctx.git, `${remote}..HEAD`);
}

// Gitignored directories (repo-relative, no trailing '/'), so the watcher can skip them. `status --ignored=matching`
// reports exactly the directories a pattern matches; `ls-files --others --ignored --directory` would also report a
// plain directory whose current contents all happen to be ignored (`sub/` for `sub/node_modules/`), hiding new files.
export async function ignoredDirs(ctx: RunContext): Promise<string[]> {
  const out = await ctx.git.ok(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--ignored=matching',
    '--untracked-files=normal']);
  return parsePorcelain(out).filter((e) => e.xy === '!!' && e.path.endsWith('/'))
    .map((e) => e.path.replace(/\/+$/, '')).filter((p) => p !== '');
}
