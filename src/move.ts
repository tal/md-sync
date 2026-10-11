// The worktree move: no git command writes the synced folder. A move from
// `from` to `to` surveys the paths that differ (and whatever sits in their way), classifies what it finds by content
// (git's own bytes, or an edit), plans with the replay planner, journals every temp name, then switches each
// path with a checked write (cas.ts). Only after the worktree reached its planned state, and its changed folders are
// on disk, do the index and the ref move (W4). A path that keeps changing is captured by inode (identity mode), so
// every move terminates (W5). Replaced inodes wait out SETTLE_GRACE_MS in the journal's settle part (W3).
import {
  closeSync, constants, fdatasyncSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Aside, type CasHooks, casPut, type CasResult, copyOut, type Digest, digestAt, digestEq, type Expect, hashFd, linkCopy, moveAside,
  readFd, type Seen, settleAside, sha256Hex, symlinkDigest, TEMP_DIR_RE, unlinkOwnTemp, type Version, versionDigest,
  writeTemp,
} from './cas';
import { buildTree, commitTree, type IndexOp } from './commit';
import { buildConflictMessage, subjectOf } from './commit-message';
import { REPO_CONFIG_PATH } from './config';
import { conflictCopyPath, foldCase } from './conflict-name';
import type { RunContext } from './context';
import { PROBE_ONE, PROBE_TWO, renameNoReplace, type VolumeCaps, volumeProbe } from './exchange';
import { errCode, firstLine, properPrefixes } from './fsutil';
import { catBlob, headSha, indexEntries, isOid, lsTree, parseNul, revParse, type TreeEntry, unmergedPaths, writeBlob } from './git';
import { conflictStamp } from './host';
import { errorText } from './log';
import { mergeFile, mergeRepoConfig } from './merge-file';
import { buildPlan, dataGuard, type Merger, type PathTriple, type Plan, type PlanEnv, type Side } from './replay-plan';
import {
  addLocalOnly, type MoveJournal, type MoveReason, type MoveTemp, mutateJournal, type QuitTree, readJournal, type RefStep,
  type SettleEntry,
} from './state';
import type { OverriddenDelete } from './types';

export type { MoveJournal, MoveReason, MoveTemp, RefStep, SettleEntry } from './state';
export type Disposable = (path: string, blob: string) => 'git-output' | 'edit';   // by content only, never by mtime
export type MoveInput = {
  reason: MoveReason;
  from: string | 'empty';           // where HEAD and the index are: the base every local edit is measured against
  to: string;                       // the commit to move to
  ref: RefStep;
  index: 'changed-paths' | 'reset'; // set only the changed entries (keeps stat data), or `read-tree --reset <final>`
  edits: 'merge' | 'copy';          // a local edit at a path `to` changes: three-way merged, or always copied (P2)
  copies: 'commit' | 'uncommitted'; // committable copies of edits go into a copies-only commit on `to`, or stay local
  disposable?: Disposable;          // more versions that count as git's output (P2: what the op wrote)
};
export type MoveResult =
  | { kind: 'moved'; final: string; copies: string[]; overridden: OverriddenDelete[]; raced: string[]; commit: string | 'none' }
  | { kind: 'busy'; error: string }        // the index stayed locked, or structural churn outlasted MOVE_ROUNDS: kept for P4
  | { kind: 'failed'; error: string }      // an I/O error, or HEAD moved: undone as far as is safe (M9)
  | { kind: 'data-guard-stop'; error: string };   // the plan failed the guard: nothing was written
export type WorktreeOp =
  | { op: 'put'; path: string; expect: Expect; want: Version; after?: string;    // C1–C5c; `after`: once that path's put is done
      copy?: string }                                                             //   `copy`: a copy op of this path before it
  | { op: 'copy'; path: string; copy: string; expect: Digest | 'any' }            // linkCopy
  | { op: 'move-aside'; path: string; to: string };                               // a folder (or a whole file) in the way
// `asides`: the replaced inodes; the caller hands them to the settle part when it clears its own part.
export type ApplyResult = { kind: 'applied'; raced: string[]; skipped: string[]; asides: Aside[] }
  | { kind: 'busy' | 'failed'; error: string; asides?: Aside[] };

export const MOVE_ROUNDS = 4;
export const SETTLE_GRACE_MS = 5_000;    // a replaced inode stays linked this long after its switch (W3)
export const SETTLE_STABLE_MS = 200;     // S5's re-read interval
const INDEX_LOCK_WAIT_MS = 10_000;       // FRESH_LOCK_WAIT_MS (preflight): M8 waits this long for a locked index
const YIELD_EVERY = 64;

const GITLINK = '160000';
const SYMLINK = '120000';
const EMPTY = new Uint8Array(0);

type Present = Exclude<Side, 'absent'>;

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers moved here from conflict.ts: the merger, copy names, and what a copy may be committed as.

// Files that decide what gets staged. A conflict copy of one is a file git (or mdsync) never reads: the losing side's
// rules vanished and the next commit run pushed the files they kept out. Their rules are merged so both sides' survive.
function mergeStyleOf(path: string): 'rule-lines' | 'repo-config' | 'normal' {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === '.gitignore' || name === '.gitattributes') return 'rule-lines';
  return path === REPO_CONFIG_PATH ? 'repo-config' : 'normal';
}

// A path's `merge` attribute (gitattributes(5)), read from `attrSource`: 'default' (unspecified, set, `text`, or a
// driver name git does not know, which git also merges as text) is mdsync's own line merge; any other value is merged
// by git itself (`union`, `binary`, `-merge`, a configured `merge.<name>.driver`), exactly as the rebase and the
// autostash apply did. Before, an uncommitted append to a `merge=union` log became a conflict copy (pushed), where the
// autostash merged both lines in place.
export type MergeAttrs = { attrSource: string; byGit: ReadonlySet<string> };

export async function mergeAttrsOf(ctx: RunContext, rev: string, paths: readonly string[]): Promise<MergeAttrs> {
  const byGit = new Set<string>();
  if (paths.length === 0) return { attrSource: rev, byGit };
  const r = await ctx.git.run([`--attr-source=${rev}`, 'check-attr', '-z', '--stdin', 'merge'],
    { input: paths.map((p) => `${p}\0`).join('') });
  if (r.code !== 0) return { attrSource: rev, byGit };   // unknown: the line merge (a conflict costs a copy, never a byte)
  const fallback = await gitConfigValue(ctx, 'merge.default');
  const known = new Map<string, 'by-git' | 'default'>();
  const kind = async (v: string): Promise<'by-git' | 'default'> => {
    if (v === 'set' || v === 'text') return 'default';
    if (v === 'unset' || v === 'binary' || v === 'union') return 'by-git';
    let k = known.get(v);
    if (k === undefined) {
      k = (await gitConfigValue(ctx, `merge.${v}.driver`)) !== 'unset' ? 'by-git' : 'default';
      known.set(v, k);
    }
    return k;
  };
  const f = parseNul(r.stdout);
  for (let k = 0; k + 2 < f.length; k += 3) {
    const v = f[k + 2] as string;   // 'unset' is `-merge` (git's binary driver); 'unspecified' falls back to merge.default
    if (v === 'unspecified' && fallback === 'unset') continue;
    if ((await kind(v === 'unspecified' ? fallback : v)) === 'by-git') byGit.add(f[k] as string);
  }
  return { attrSource: rev, byGit };
}

export function makeMerger(ctx: RunContext, o: { binary?: ReadonlySet<string>; attrs?: MergeAttrs } = {}): Merger {
  const read = async (s: Side): Promise<Uint8Array> => (s === 'absent' ? EMPTY : catBlob(ctx.git, s.sha));
  return async (t) => {
    if (o.binary?.has(t.path)) return { kind: 'conflict', reason: 'binary' };   // a filter attribute never merges
    const style = mergeStyleOf(t.path);
    if (o.attrs?.byGit.has(t.path) && style === 'normal') return mergeByGit(ctx, o.attrs.attrSource, t);
    const local = await read(t.local);
    const base = await read(t.base);
    const remote = await read(t.remote);
    if (style === 'repo-config') {
      const merged = mergeRepoConfig(local, base, remote);
      if (merged !== 'unmergeable') return { kind: 'clean', sha: await writeBlob(ctx.git, merged) };
    }
    const r = await mergeFile(ctx, local, base, remote, style === 'rule-lines' ? 'union' : 'normal');
    if (r.kind === 'clean') return { kind: 'clean', sha: await writeBlob(ctx.git, r.content) };
    return { kind: 'conflict', reason: r.kind === 'conflict' ? 'content' : r.kind };
  };
}

// One path merged by git's own machinery: `git --attr-source=<rev> merge-tree --write-tree --merge-base=<B> <R> <L>`
// over three single-path trees, so the attribute's driver runs as it does in a rebase or a stash apply (the remote,
// the side the folder moves to, is "ours"; the local edit "theirs"). Exit 1 is a conflict; anything else (a driver
// that failed) is one too: a copy, never a byte lost.
async function mergeByGit(ctx: RunContext, rev: string, t: PathTriple): ReturnType<Merger> {
  const tree = async (s: Side): Promise<string> => (s === 'absent' ? ctx.emptyTree
    : (await buildTree(ctx, 'empty', [{ op: 'set', path: t.path, mode: s.mode, sha: s.sha }])).tree);
  const [base, remote, local] = [await tree(t.base), await tree(t.remote), await tree(t.local)];
  const m = await ctx.git.run([`--attr-source=${rev}`, 'merge-tree', '--write-tree', '-z', '--name-only', '--no-messages',
    `--merge-base=${base}`, remote, local], { durable: 'durable' });
  const first = parseNul(m.stdout)[0] ?? '';
  if (m.code !== 0 || !isOid(first)) {
    return { kind: 'conflict', reason: m.code === 1 ? 'content' : 'error' };
  }
  const e = (await lsTree(ctx.git, first)).get(t.path);
  if (e === undefined) return { kind: 'conflict', reason: 'error' };
  return { kind: 'clean', sha: e.sha };
}

export type CopyNamer = (path: string) => string;

// Names that collide with nothing on disk, in `known` (target tree, index, ...), or chosen earlier by this namer:
// not the path, not a prefix or a descendant of one, compared with foldCase on a case-insensitive repo. When a folder
// of the path is a file (in `known`, chosen, or on disk), no name under it can exist: the copy goes under a copy name
// of that folder instead (`d/e/g.md` with a file `d/e` -> `d/e (conflict …)/g.md`, as the planner names clash
// copies). Before, every candidate was taken and the namer threw after 100 000 of them (chaos seeds 105, 117).
export function copyNamer(ctx: RunContext, known: Iterable<string>, stamp: string = conflictStamp(new Date(ctx.clock.now()))): CopyNamer {
  const key = ctx.ignoreCase === 'case-insensitive' ? foldCase : (p: string) => p;
  const paths = new Set<string>();
  const dirs = new Set<string>();
  const chosen = new Set<string>();
  for (const p of known) {
    const k = key(p);
    paths.add(k);
    for (const d of properPrefixes(k)) dirs.add(d);
  }
  // what is on disk at c: a file or symlink at one of its folders (ENOTDIR) counts as 'other'
  const disk = (c: string): 'none' | 'dir' | 'other' => {
    try {
      return lstatSync(join(ctx.realDir, c)).isDirectory() ? 'dir' : 'other';
    } catch (e) {
      return errCode(e) === 'ENOTDIR' ? 'other' : 'none';
    }
  };
  const taken = (c: string): boolean => {
    const k = key(c);
    if (paths.has(k) || dirs.has(k) || chosen.has(k)) return true;
    for (const d of properPrefixes(k)) if (paths.has(d) || chosen.has(d)) return true;
    for (const x of chosen) if (x.startsWith(`${k}/`)) return true;
    return disk(c) !== 'none';
  };
  const fileAbove = (p: string): string | 'none' => {
    for (const d of properPrefixes(p)) if (paths.has(key(d)) || chosen.has(key(d)) || disk(d) === 'other') return d;
    return 'none';
  };
  return (p) => {
    const above = fileAbove(p);
    const rest = above === 'none' ? '' : p.slice(above.length);
    const c = above === 'none' ? conflictCopyPath(p, ctx.host, stamp, taken)
      : `${conflictCopyPath(above, ctx.host, stamp, (d) => taken(`${d}${rest}`))}${rest}`;
    chosen.add(key(c));
    return c;
  };
}

export async function copyCommittable(ctx: RunContext, orig: string, copy: string): Promise<'commit' | 'local-only'> {
  if (ctx.ignore.matches(orig) || ctx.ignore.matches(copy)) return 'local-only';
  // check-ignore never reports tracked paths, so the original only counts when it was untracked (or ignored).
  const r = await ctx.git.run(['check-ignore', '-z', '--stdin'], { input: `${orig}\0${copy}\0` });
  if (r.code === 1) return 'commit';
  return 'local-only';   // 0: ignored; anything else: unknown, so the copy stays local (never pushes a secret)
}

// ---------------------------------------------------------------------------------------------------------------
// The temp folder: one per process, at the worktree top (or at the top of a mount inside it). Every name in
// it is journaled before it exists.

const PROC_TEMP = `.mdsync-${process.pid}-${Date.now()}.d`;
let tempSeq = 0;

export function processTempDir(): string {
  return PROC_TEMP;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

function devOf(abs: string): bigint | 'missing' {
  try {
    return lstatSync(abs, { bigint: true }).dev;
  } catch {
    return 'missing';
  }
}

// The temp folder for a path: the process folder at the top of the filesystem the path lives on (renames and
// exchanges never cross a filesystem).
function tempDirFor(root: string, rel: string): string {
  const top = devOf(root);
  let dir = parentOf(rel);
  while (dir !== '' && devOf(join(root, dir)) === 'missing') dir = parentOf(dir);
  if (dir === '') return PROC_TEMP;
  const dev = devOf(join(root, dir));
  if (dev === top || dev === 'missing') return PROC_TEMP;
  let mount = dir;
  for (let up = parentOf(mount); up !== '' && devOf(join(root, up)) === dev; up = parentOf(up)) mount = up;
  return `${mount}/${PROC_TEMP}`;
}

function newTempName(root: string, rel: string): string {
  return `${tempDirFor(root, rel)}/${++tempSeq}`;
}

function tempFolderOf(name: string): string {
  return parentOf(name);
}

function ensureTempFolders(root: string, names: readonly string[]): void {
  for (const dir of new Set(names.map(tempFolderOf))) {
    try {
      mkdirSync(join(root, dir));
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
    }
  }
}

const loggedDevs = new Set<string>();

function capsFor(ctx: RunContext, tempDir: string): VolumeCaps {
  const p = volumeProbe(join(ctx.realDir, tempDir));
  if (p.caps.mode !== 'exchange' && !loggedDevs.has(p.dev)) {
    loggedDevs.add(p.dev);
    ctx.log.info('worktree exchange unavailable', { dev: Number(p.dev), mode: p.caps.mode, error: p.error });
  }
  return p.caps;
}

// ---------------------------------------------------------------------------------------------------------------
// Small git helpers

function zeroOid(ctx: RunContext): string {
  return '0'.repeat(ctx.objectFormat === 'sha256' ? 64 : 40);
}

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

class GuardStop extends Error {}
class MoveFailed extends Error {}

function sideOf(e: TreeEntry | undefined): Side {
  return e === undefined ? 'absent' : { mode: e.mode, sha: e.sha };
}

function sideEq(a: Side, b: Side): boolean {
  if (a === 'absent' || b === 'absent') return a === b;
  return a.mode === b.mode && a.sha === b.sha;
}

// `diff-tree -r -z` records between two tree-ish: path -> {from, to} sides. Paths must be valid UTF-8: mdsync would
// write a different name, and the next commit would push a delete and a mangled add.
async function diffTrees(ctx: RunContext, a: string, b: string): Promise<Map<string, { fromSide: Side; toSide: Side }>> {
  const r = await ctx.git.bytes(['diff-tree', '-r', '-z', '--no-renames', a, b, '--']);
  if (r.code !== 0) throw new MoveFailed(`git diff-tree exited ${r.code}: ${firstLine(r.stderr)}`);
  const out = new Map<string, { fromSide: Side; toSide: Side }>();
  const bytes = r.stdout;
  let at = 0;
  const zero = zeroOid(ctx);
  while (at < bytes.length) {
    const metaEnd = bytes.indexOf(0, at);
    if (metaEnd < 0) break;
    const meta = new TextDecoder().decode(bytes.subarray(at, metaEnd)).replace(/^:/, '').split(' ');
    const pathEnd = bytes.indexOf(0, metaEnd + 1);
    if (pathEnd < 0) break;
    let path: string;
    try {
      path = utf8Fatal.decode(bytes.subarray(metaEnd + 1, pathEnd));
    } catch {
      throw new GuardStop(`path is not valid UTF-8: ${Buffer.from(bytes.subarray(metaEnd + 1, pathEnd)).toString('hex')}`);
    }
    at = pathEnd + 1;
    const [om, nm, oo, no] = meta;
    if (om === undefined || nm === undefined || oo === undefined || no === undefined) continue;
    out.set(path, {
      fromSide: om === '000000' || oo === zero ? 'absent' : { mode: om, sha: oo },
      toSide: nm === '000000' || no === zero ? 'absent' : { mode: nm, sha: no },
    });
  }
  return out;
}

// Renames between two tree-ish (`diff-tree -M`): source -> destination, used only to carry edits (M2).
async function renamePairs(ctx: RunContext, a: string, b: string): Promise<Map<string, string>> {
  const r = await ctx.git.run(['diff-tree', '-r', '-z', '-M', a, b, '--']);
  const out = new Map<string, string>();
  if (r.code !== 0) return out;
  const f = parseNul(r.stdout);
  for (let i = 0; i < f.length;) {
    const meta = (f[i] ?? '').split(' ');
    const status = meta[4] ?? '';
    if (status.startsWith('R') || status.startsWith('C')) {
      if (status.startsWith('R')) out.set(f[i + 1] ?? '', f[i + 2] ?? '');
      i += 3;
    } else {
      i += 2;
    }
  }
  return out;
}

async function gitConfigValue(ctx: RunContext, key: string): Promise<string | 'unset'> {
  const r = await ctx.git.run(['config', '--get', key]);
  return r.code === 0 ? r.stdout.trim() : 'unset';
}

// `git --attr-source=<rev> check-attr -z --stdin <attrs>` -> paths with any of `attrs` set to something other than
// unspecified/unset.
async function pathsWithAttr(ctx: RunContext, rev: string, paths: readonly string[], attrs: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (paths.length === 0) return out;
  const r = await ctx.git.run([`--attr-source=${rev}`, 'check-attr', '-z', '--stdin', ...attrs],
    { input: paths.map((p) => `${p}\0`).join('') });
  if (r.code !== 0) return new Set(paths);   // unknown: treat every path as filtered (never merge, never "only EOL")
  const f = parseNul(r.stdout);
  for (let k = 0; k + 2 < f.length; k += 3) {
    const v = f[k + 2];
    if (v !== 'unspecified' && v !== 'unset') out.add(f[k] as string);
  }
  return out;
}

// The blob `git add` would store for these bytes at `path`, with `rev`'s attributes (clean filters, eol).
async function hashBytes(ctx: RunContext, rev: string, path: string, bytes: Uint8Array): Promise<string> {
  return (await ctx.git.ok([`--attr-source=${rev}`, 'hash-object', '-w', '--stdin', `--path=${path}`],
    { input: bytes, durable: 'durable' })).trim();
}

let workSeq = 0;

// Exactly the bytes git's checkout writes for `rev`'s `paths` (every filter applied with `rev`'s attributes), into a
// fresh folder under the state dir: `GIT_INDEX_FILE=<tmp> read-tree <rev>` + `checkout-index --prefix`. Nothing is held
// in memory. Paths that fold together on a case-insensitive disk go into separate layers.
async function materialize(ctx: RunContext, rev: string, paths: readonly string[], dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();   // path -> absolute file holding its checkout bytes
  if (paths.length === 0) return out;
  const layers: { keys: Set<string>; dirs: Set<string>; paths: string[] }[] = [];
  const key = ctx.ignoreCase === 'case-insensitive' ? foldCase : (p: string) => p;
  for (const p of paths) {
    const k = key(p);
    const pre = properPrefixes(k);
    let layer = layers.find((l) => !l.keys.has(k) && !l.dirs.has(k) && !pre.some((d) => l.keys.has(d)));
    if (layer === undefined) {
      layer = { keys: new Set(), dirs: new Set(), paths: [] };
      layers.push(layer);
    }
    layer.keys.add(k);
    for (const d of pre) layer.dirs.add(d);
    layer.paths.push(p);
  }
  await mkdir(ctx.paths.tmp, { recursive: true, mode: 0o700 });
  for (const [n, layer] of layers.entries()) {
    const prefix = join(dir, String(n));
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    const indexFile = join(ctx.paths.tmp, `mat-${process.pid}-${++workSeq}.index`);
    try {
      await ctx.git.ok(['read-tree', rev], { indexFile });
      const r = await ctx.git.run([`--attr-source=${rev}`, 'checkout-index', '-z', '--stdin', `--prefix=${prefix}/`],
        { indexFile, input: layer.paths.map((p) => `${p}\0`).join('') });
      if (r.code !== 0) throw new MoveFailed(`git checkout-index into the state dir exited ${r.code}: ${firstLine(r.stderr)}`);
    } finally {
      await rm(indexFile, { force: true }).catch(() => {});
      await rm(`${indexFile}.lock`, { force: true }).catch(() => {});
    }
    for (const p of layer.paths) out.set(p, join(prefix, p));
  }
  return out;
}

function versionAt(abs: string, mode: string): Version {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return { kind: 'symlink', target: readlinkSync(abs) };
  return { kind: 'file', src: abs, exec: mode === '100755' ? 'exec' : 'plain' };
}

// A blob's checkout bytes at `path` with `rev`'s attributes, into a fresh file under `dir`.
async function smudge(ctx: RunContext, rev: string, path: string, blob: string, mode: string, dir: string): Promise<Version> {
  if (mode === SYMLINK && ctx.config !== undefined) {
    const target = new TextDecoder().decode(await catBlob(ctx.git, blob));
    if ((await symlinksEnabled(ctx)) === 'enabled') return { kind: 'symlink', target };
  }
  const r = await ctx.git.bytes([`--attr-source=${rev}`, 'cat-file', '--filters', `--path=${path}`, blob]);
  if (r.code !== 0) throw new MoveFailed(`git cat-file --filters ${path} exited ${r.code}: ${firstLine(r.stderr)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `v-${++workSeq}`);
  await Bun.write(file, r.stdout);
  return { kind: 'file', src: file, exec: mode === '100755' ? 'exec' : 'plain' };
}

const symlinkCache = new WeakMap<RunContext, 'enabled' | 'disabled'>();
async function symlinksEnabled(ctx: RunContext): Promise<'enabled' | 'disabled'> {
  const hit = symlinkCache.get(ctx);
  if (hit !== undefined) return hit;
  const v = (await gitConfigValue(ctx, 'core.symlinks')) === 'false' ? 'disabled' : 'enabled';
  symlinkCache.set(ctx, v);
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// On-disk names (case-insensitive repos: one disk entry per fold group)

type DirCache = Map<string, string[] | 'missing'>;

function readNames(root: string, rel: string, cache: DirCache): string[] | 'missing' {
  const hit = cache.get(rel);
  if (hit !== undefined) return hit;
  let names: string[] | 'missing';
  try {
    names = readdirSync(rel === '' ? root : join(root, rel));
  } catch {
    names = 'missing';
  }
  cache.set(rel, names);
  return names;
}

type Located = { disk: string; state: 'present' | 'missing' | { behind: string } };

// The real on-disk spelling of `rel` (case-insensitive: every component matched with foldCase), or where it would be
// created. A file or symlink at a prefix means `rel` is behind it: that prefix is what is in the way.
function locate(root: string, rel: string, ci: RunContext['ignoreCase'], cache: DirCache): Located {
  const comps = rel.split('/');
  let cur = '';
  for (let i = 0; i < comps.length; i++) {
    const comp = comps[i] as string;
    let name = comp;
    if (ci === 'case-insensitive') {
      const names = readNames(root, cur, cache);
      if (names === 'missing') return { disk: [cur, ...comps.slice(i)].filter((x) => x !== '').join('/'), state: 'missing' };
      const found = names.includes(comp) ? comp : names.find((n) => foldCase(n) === foldCase(comp));
      if (found === undefined) return { disk: [cur, ...comps.slice(i)].filter((x) => x !== '').join('/'), state: 'missing' };
      name = found;
    }
    const next = cur === '' ? name : `${cur}/${name}`;
    let st;
    try {
      st = lstatSync(join(root, next));
    } catch {
      return { disk: [next, ...comps.slice(i + 1)].join('/'), state: 'missing' };
    }
    if (i < comps.length - 1 && !st.isDirectory()) {
      return { disk: [next, ...comps.slice(i + 1)].join('/'), state: { behind: next } };
    }
    cur = next;
  }
  return { disk: cur, state: 'present' };
}

// ---------------------------------------------------------------------------------------------------------------
// Survey

type Look =
  | { kind: 'absent' }
  | { kind: 'dir' }
  | { kind: 'other' }
  | { kind: 'file'; digest: PresentDigest; exec: 'exec' | 'plain' }
  | { kind: 'symlink'; digest: PresentDigest; target: string };
type PresentDigest = Exclude<Digest, { kind: 'absent' }>;

type Slot = {
  key: string;
  path: string;                 // the git path its triple uses: to's spelling, else from's, else the disk name
  toPath: string | 'none';
  toSide: Side;
  fromPath: string | 'none';
  fromSide: Side;
  fromAll: { path: string; side: Side }[];
  extraTo: string[];            // to's other spellings of the group: index only
  role: 'tracked' | 'in-the-way';
  disk: string;
  look: Look;
};

function lookAt(root: string, rel: string): Look {
  const p = join(root, rel);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { kind: 'absent' };
  }
  if (st.isDirectory()) return { kind: 'dir' };
  if (st.isSymbolicLink()) {
    try {
      const target = readlinkSync(p);
      return { kind: 'symlink', digest: symlinkDigest(target) as PresentDigest, target };
    } catch {
      return { kind: 'other' };
    }
  }
  if (!st.isFile()) return { kind: 'other' };
  const d = digestAt(root, rel);
  if (d.kind !== 'file') return d.kind === 'dir' ? { kind: 'dir' } : d.kind === 'absent' ? { kind: 'absent' } : { kind: 'other' };
  return { kind: 'file', digest: d, exec: (st.mode & 0o100) !== 0 ? 'exec' : 'plain' };
}

function readBytes(root: string, rel: string): Uint8Array | 'gone' {
  try {
    const fd = openSync(join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return readFd(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return 'gone';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The executor (M5, and applyOps): ops with their journaled names

type PutKind = 'git' | 'create' | 'edit';   // 'git': replaced or deleted content from git (undone by M9); 'create':
                                            //   created where nothing was; 'edit': over an edit (never undone)
type XOp =
  | { op: 'put'; path: string; key: string; expect: Expect; want: Version; wantDigest: Digest; kind: PutKind;
      temp: string; aside: string; after?: string; spelling?: string;
      copy?: string }   // a copy that hard-links the inode this put replaces: its aside records it (settle S2)
  | { op: 'copy'; path: string; key: string; copy: string; expect: Digest | 'any'; origin: string }
  | { op: 'move-aside'; path: string; key: string; to: string; origin: string;
      gone: 'again' | 'fine' }   // 'again': a folder whose copies were planned (maybe committed) under `to`: gone, or
                                 //   no longer a folder, the next round plans it again; 'fine': an identity move
  | { op: 'rmdir'; path: string; key: string }
  | { op: 'mkdir'; path: string; key: string }
  | { op: 'rename'; path: string; key: string; to: string };   // a case-only rename to to's spelling

type Done = { op: Extract<XOp, { op: 'put' }>; aside: Aside | 'none' };

type RoundOut = {
  again: Set<string>;        // slot keys to survey again
  raced: string[];           // kept files (conflict copies)
  asides: Aside[];
  done: Done[];
  copies: Map<string, { copy: string; ino: string | 'none' }>;   // origin path -> the copy made
  moved: { path: string; to: string }[];
  error: string | 'none';
  changedDirs: Set<string>;
};

function pathKey(ctx: RunContext, p: string): string {
  return ctx.ignoreCase === 'case-insensitive' ? foldCase(p) : p;
}

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// A snapshot identity put is decided only at its switch (its copy turned out a byte copy): journaled as 'inode', a
// resumed aside then settles `late`, a second copy at most, never a loss.
function moveTempOf(o: Extract<XOp, { op: 'put' }>, which: 'temp' | 'aside'): MoveTemp {
  const e = o.expect;
  const exp = e.kind === 'inode' || e.kind === 'snapshot' ? 'inode' : e.kind === 'absent' ? 'absent' : e.sha256;
  const copy = e.kind === 'inode' || e.kind === 'snapshot' ? e.copy : o.copy;
  return { name: which === 'temp' ? o.temp : o.aside, path: o.path, kind: which, expect: exp,
    want: o.wantDigest.kind === 'absent' ? 'absent' : o.wantDigest.sha256, ...(copy !== undefined ? { copy } : {}) };
}

function pruneEmptyParents(root: string, rel: string, out: Set<string>): void {
  for (let dir = parentOf(rel); dir !== ''; dir = parentOf(dir)) {
    if (TEMP_DIR_RE.test(dir)) return;
    try {
      rmdirSync(join(root, dir));
      out.add(parentOf(dir));
    } catch {
      return;   // not empty (or gone): stop pruning
    }
  }
}

function fsyncDirs(root: string, dirs: Iterable<string>): void {
  for (const d of new Set(dirs)) {
    try {
      const fd = openSync(d === '' ? root : join(root, d), 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // gone, or not supported: the renames themselves are still atomic
    }
  }
}

// Kept files (raced or late) become conflict copies of their path, from the temp folder, never replacing anything.
// Never throws: naming or moving can fail (a file where the copy's folder would go, a name taken in between, an I/O
// error), so it tries the path's own folder, then the bare file name at the top. 'stuck': nothing worked, the file is
// still at `kept` and the caller keeps it in the settle part to try again after another grace. Before, a throw here
// escaped settle and failed every run (chaos seeds 105, 117).
function keepAsCopy(ctx: RunContext, kept: string, path: string, name: CopyNamer, kind: 'save' | 'late' | 'changing'):
  string | 'none' | 'stuck' {
  let error = 'no free name';
  for (const target of [path, path, path, baseOf(path), baseOf(path)]) {
    try {
      const copy = name(target);
      const r = moveAside(ctx.realDir, kept, copy);
      if (r === 'moved') {
        ctx.log.warn('worktree write raced', { path, kind, copy });
        return copy;
      }
      if (r === 'missing') return 'none';
      error = `${copy}: taken`;   // made by someone in between: the next try names another
    } catch (e) {
      error = errorText(e);
    }
  }
  ctx.log.warn('worktree write raced', { path, kind, copy: kept, error });
  return 'stuck';
}

// One switch pass over `ops` (the write pass ran before). Synchronous per path; yields every YIELD_EVERY paths.
// A pass that stops early (an error, or `stop` on a changed path) unlinks the temps of the puts it never reached: they
// hold exactly their `want` (rule (a)). Left behind, nothing removed them once the part was cleared.
async function runOps(ctx: RunContext, ops: readonly XOp[], caps: (tempDir: string) => VolumeCaps, name: CopyNamer,
  o: { onChanged: 'skip' | 'stop' }): Promise<RoundOut> {
  const root = ctx.realDir;
  const out: RoundOut = { again: new Set(), raced: [], asides: [], done: [], copies: new Map(), moved: [], error: 'none',
    changedDirs: new Set() };
  const blocked: string[] = [];
  const doneKeys = new Set<string>();
  const snapshots = new Map<string, Digest>();   // identity copies that are byte copies (no hard link): copy -> its digest
  const isBlocked = (key: string): boolean => blocked.some((b) => related(key, b));
  const block = (key: string): void => {
    blocked.push(key);
    out.again.add(key);
  };
  let n = 0;
  let reached = 0;
  for (const op of ops) {
    if (++n % YIELD_EVERY === 0) await Bun.sleep(0);
    if (out.error !== 'none' || (o.onChanged === 'stop' && out.again.size > 0)) break;
    reached = n;
    if (isBlocked(op.key)) {
      out.again.add(op.key);
      if (op.op === 'put') unlinkOwnTemp(root, op.temp, op.wantDigest);
      continue;
    }
    if (op.op === 'put' && op.after !== undefined && !doneKeys.has(pathKey(ctx, op.after))) {
      out.again.add(op.key);   // the put it waits for did not happen
      unlinkOwnTemp(root, op.temp, op.wantDigest);
      continue;
    }
    try {
      switch (op.op) {
        case 'put': {
          const snap = op.expect.kind === 'inode' ? snapshots.get(op.expect.copy) : undefined;
          const expect: Expect = snap !== undefined && op.expect.kind === 'inode' ? { kind: 'snapshot', copy: op.expect.copy, digest: snap }
            : op.expect;
          const r: CasResult = casPut(root, op.path, expect, op.want,
            { temp: op.temp, aside: op.aside, ...(op.copy !== undefined ? { copy: op.copy } : {}) }, caps(tempFolderOf(op.temp)));
          out.changedDirs.add(parentOf(op.path));
          if (r.kind === 'done') {
            doneKeys.add(op.key);
            out.done.push({ op, aside: r.aside });
            if (r.aside !== 'none') out.asides.push(r.aside);
            if (op.want.kind === 'absent') pruneEmptyParents(root, op.path, out.changedDirs);
            if (op.spelling !== undefined && op.spelling !== op.path && op.want.kind !== 'absent') caseRename(ctx, op.path, op.spelling);
          } else if (r.kind === 'raced') {
            const copy = keepAsCopy(ctx, r.kept, op.path, name, 'save');
            if (copy === 'stuck') {
              // it stays in the temp folder: the settle part keeps it (S3 'late', retried after the grace)
              out.asides.push({ name: r.kept, path: op.path, ino: inoOf(root, r.kept), expect: 'inode', copy: 'none', since: Date.now() });
            } else if (copy !== 'none') {
              out.raced.push(copy);
            }
            if (r.path === 'changed') block(op.key);
            else doneKeys.add(op.key);
            if (r.path === 'want') out.done.push({ op, aside: 'none' });
          } else if (r.kind === 'changed') {
            block(op.key);
          } else {
            out.error = `${op.path}: ${r.error}`;
          }
          break;
        }
        case 'copy': {
          const r = linkCopy(root, op.path, op.copy, op.expect, caps(tempDirFor(root, op.path)));
          out.changedDirs.add(parentOf(op.copy));
          if (r === 'changed' || r === 'taken') block(op.key);
          else out.copies.set(op.origin, { copy: op.copy, ino: r.kind === 'linked' ? r.ino : 'none' });
          // An identity copy that is a byte copy (copy-only mode, or link() refused for this inode) can't be the inode the
          // put checks for: its put moves the path's inode aside whole instead (copy-only). Before, the
          // inode check never passed, the move ended busy, and every resume added two more copies.
          if (op.expect === 'any' && r !== 'changed' && r !== 'taken' && r.kind === 'copied') {
            const d = digestAt(root, op.copy);
            if (d.kind === 'file') snapshots.set(op.copy, d);
          }
          break;
        }
        case 'move-aside': {
          // A folder that moves whole to its copy folder must still be one. Gone (an agent removed it), or replaced by
          // a file, it is planned again next round, where its committed copies are written from their blobs (M5).
          // Moved anyway, a file took the copy folder's name; skipped, the copies were in HEAD and not on disk, and
          // the next commit pushed their deletion (chaos round 2's defect, for a folder).
          if (op.gone === 'again' && lookAt(root, op.path).kind !== 'dir') {
            block(op.key);
            break;
          }
          const r = moveAside(root, op.path, op.to, caps(tempDirFor(root, op.path)));
          out.changedDirs.add(parentOf(op.path));
          out.changedDirs.add(parentOf(op.to));
          if (r === 'taken' || (r === 'missing' && op.gone === 'again')) block(op.key);
          else if (r === 'moved') out.moved.push({ path: op.path, to: op.to });
          break;
        }
        case 'rmdir': {
          try {
            rmdirSync(join(root, op.path));
            out.changedDirs.add(parentOf(op.path));
          } catch (e) {
            const c = errCode(e);
            if (c !== 'ENOENT' && c !== 'ENOTDIR') block(op.key);   // not empty: the put after it would fail
          }
          break;
        }
        case 'mkdir': {
          try {
            mkdirSync(join(root, op.path), { recursive: true });
          } catch (e) {
            ctx.log.debug('worktree operation failed', { action: 'mkdir-gitlink', path: op.path, error: e });
          }
          break;
        }
        case 'rename':
          caseRename(ctx, op.path, op.to);
          break;
      }
      if (moveTestHooks.afterOp?.(n, op.path) === 'crash') throw new SimulatedCrash(`simulated crash after ${op.path}`);
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      if (op.op === 'put') unlinkOwnTemp(root, op.temp, op.wantDigest);
      const c = errCode(e);
      if (c !== undefined && ['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ENOTEMPTY', 'ELOOP'].includes(c)) block(op.key);
      else out.error = `${op.path}: ${errorText(e)}`;
    }
  }
  for (const op of ops.slice(reached)) if (op.op === 'put') unlinkOwnTemp(root, op.temp, op.wantDigest);
  return out;
}

// A case-only rename of one entry to to's spelling (a case-insensitive filesystem renames the entry itself, keeping its
// inode, and can't replace another one).
function caseRename(ctx: RunContext, from: string, to: string): void {
  if (from === to || parentOf(from) !== parentOf(to) && foldCase(parentOf(from)) !== foldCase(parentOf(to))) return;
  if (baseOf(from) === baseOf(to)) return;
  try {
    renameSync(join(ctx.realDir, from), join(ctx.realDir, to));
  } catch (e) {
    ctx.log.debug('worktree operation failed', { action: 'case-rename', path: from, to, error: e });
  }
}

// C1 for every put of the round, before any switch. A failure here has switched nothing: every temp of the pass is
// ours and is unlinked (left behind, each retry on a full disk added more, and a restart made them a `recovered`
// folder). A completed pass is journaled (`written`): a temp journaled after that mark was never switched in, so a
// crash inside a pass that left one cut short is never read as a replaced inode (a `late` copy of junk, pushed).
function writePass(ctx: RunContext, ops: readonly XOp[]): 'ok' | string {
  let k = 0;
  for (const op of ops) {
    if (op.op !== 'put' || op.want.kind === 'absent') continue;
    const r = writeTemp(ctx.realDir, op.temp, op.want);
    const hook = r === 'written' ? moveTestHooks.inWritePass?.(++k, op.path, op.temp) ?? 'go' : 'go';
    if (hook === 'crash') throw new SimulatedCrash(`simulated crash in the write pass after ${op.path}`);
    if (r !== 'written' || hook === 'fail') {
      dropTemps(ctx, ops);
      return `${op.path}: ${r === 'written' ? 'ENOSPC: simulated' : r.error}`;
    }
  }
  mutateJournal(ctx.paths.journal, (j) => (j.move === undefined ? j : { ...j, move: { ...j.move, written: j.move.temps.length } }));
  return 'ok';
}

// Every temp of a write pass that did not complete: created by this process under a fresh journaled name, and never
// switched in, whatever it holds.
function dropTemps(ctx: RunContext, ops: readonly XOp[]): void {
  for (const op of ops) {
    if (op.op !== 'put' || op.want.kind === 'absent') continue;
    try {
      unlinkSync(join(ctx.realDir, op.temp));
    } catch {
      // never created
    }
  }
}

// Puts get their temp and aside names here, journaled (appended) before anything is created.
function nameTemps(ctx: RunContext, ops: XOp[]): MoveTemp[] {
  const temps: MoveTemp[] = [];
  for (const op of ops) {
    if (op.op !== 'put') continue;
    op.temp = newTempName(ctx.realDir, op.path);
    op.aside = newTempName(ctx.realDir, op.path);
    temps.push(moveTempOf(op, 'temp'), moveTempOf(op, 'aside'));
  }
  return temps;
}

function appendTemps(ctx: RunContext, temps: readonly MoveTemp[]): MoveJournal {
  let part: MoveJournal | undefined;
  mutateJournal(ctx.paths.journal, (j) => {
    if (j.move === undefined) throw new Error('move journal part is missing');
    part = { ...j.move, temps: [...j.move.temps, ...temps] };
    return { ...j, move: part };
  });
  ensureTempFolders(ctx.realDir, temps.map((t) => t.name));
  return part as MoveJournal;
}

async function pauseForTests(ctx: RunContext, reason: MoveReason): Promise<void> {
  const ms = Number(process.env.MDSYNC_TEST_MOVE_PAUSE_MS ?? '');
  if (!Number.isFinite(ms) || ms <= 0) return;
  ctx.log.debug('worktree move paused', { reason, pauseMs: ms });
  await Bun.sleep(ms);
}

// M9: undo the puts that replaced content from git, newest first, with forward checked puts restoring the replaced
// version from its aside (the old inode itself). Creates are deleted again. A put over an edit stays (the path keeps
// a version that contains the edit), and so does a copy. Nothing is exchanged or renamed back.
// The part is set to phase 'undoing' first. The undo's own temps are appended to it, and a temp of an undo put names
// `from`'s version (or absent) as its `want`: read as a done map after a crash, the resumed move marked those paths
// done, M8 gave the index and HEAD `to`'s entries over `from`'s bytes, and the next commit pushed reverts of remote
// edits and deletions of remote-added files. resumeMove finishes an 'undoing' part as failed instead.
async function undo(ctx: RunContext, done: readonly Done[], moved: readonly { path: string; to: string }[],
  caps: (tempDir: string) => VolumeCaps): Promise<Aside[]> {
  setPhase(ctx, 'undoing');
  const ops: XOp[] = [];
  for (const d of [...done].reverse()) {
    const o = d.op;
    if (o.kind === 'edit') continue;
    if (o.kind === 'create' || o.expect.kind === 'absent') {
      ops.push({ op: 'put', path: o.path, key: o.key, expect: o.wantDigest, want: { kind: 'absent' }, wantDigest: { kind: 'absent' },
        kind: 'git', temp: '', aside: '' });
      continue;
    }
    if (d.aside === 'none' || o.expect.kind === 'inode') continue;
    const asideAbs = join(ctx.realDir, d.aside.name);
    let want: Version;
    try {
      want = lstatSync(asideAbs).isSymbolicLink() ? { kind: 'symlink', target: readlinkSync(asideAbs) }
        : { kind: 'file', src: asideAbs, exec: (lstatSync(asideAbs).mode & 0o100) !== 0 ? 'exec' : 'plain' };
    } catch {
      continue;
    }
    ops.push({ op: 'put', path: o.path, key: o.key, expect: o.wantDigest, want, wantDigest: versionDigest(want), kind: 'git',
      temp: '', aside: '' });
  }
  let asides: Aside[] = [];
  if (ops.length > 0) {
    appendTemps(ctx, nameTemps(ctx, ops));
    if (writePass(ctx, ops) === 'ok') {
      const r = await runOps(ctx, ops, caps, copyNamer(ctx, []), { onChanged: 'skip' });
      // a path someone wrote after our put keeps their bytes: it is left as it is
      for (const path of r.again) ctx.log.debug('worktree operation skipped', { action: 'undo', path, reason: 'changed' });
      asides = r.asides;
    }
  }
  // a folder moved aside whole goes back when its name is free; otherwise it stays where it is (it is a copy)
  for (const m of [...moved].reverse()) {
    try {
      if (moveAside(ctx.realDir, m.to, m.path) !== 'moved') {
        ctx.log.warn('collision', { incoming: m.path, path: m.path, action: 'moved-folder', copy: m.to, committable: 'local-only' });
      }
    } catch {
      // the name is taken by a file now: the folder stays at its copy name
    }
  }
  return asides;
}

// A copy made by hard link (linkCopy) that still shares its inode with another worktree name once a move or applyOps
// is over gets an inode of its own. That happens when the put that should have replaced the original did not: the
// move failed (M9 keeps copies), applyOps skipped a path that changed, an agent renamed the original away before its
// put, or the original ended in a class the plan leaves alone. Without this, an in-place edit of one name silently
// changed the other, and an agent's rename spread the link to tracked notes (chaos seeds 100, 101, 103). Our own
// asides of the inode don't count: they live in the temp folder and settle on their own. The copy gets a snapshot of
// the shared bytes with a checked put (expect: those bytes, so a save that replaced the copy since is never touched).
// Its aside records the copy, so settle's S2 unlinks it at once while the other name still links the inode.
async function unshareCopies(ctx: RunContext, made: ReadonlyMap<string, { copy: string; ino: string | 'none' }>,
  ours: readonly Aside[], caps: (tempDir: string) => VolumeCaps, dir: string): Promise<{ asides: Aside[]; dirs: string[] }> {
  const root = ctx.realDir;
  const ops: Extract<XOp, { op: 'put' }>[] = [];
  for (const { copy, ino } of made.values()) {
    if (ino === 'none') continue;
    let snapshot: { bytes: Uint8Array; exec: 'exec' | 'plain' } | 'none' = 'none';
    try {
      const fd = openSync(join(root, copy), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd, { bigint: true });
        const mine = ours.filter((a) => a.ino === ino && inoOf(root, a.name) === ino).length;
        if (st.isFile() && String(st.ino) === ino && Number(st.nlink) - 1 - mine > 0) {
          snapshot = { bytes: readFd(fd), exec: (Number(st.mode) & 0o100) !== 0 ? 'exec' : 'plain' };
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;   // gone, or not a file: nothing shares it any more
    }
    if (snapshot === 'none') continue;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const src = join(dir, `u-${++workSeq}`);
    await Bun.write(src, snapshot.bytes);
    const want: Version = { kind: 'file', src, exec: snapshot.exec };
    const digest: Digest = { kind: 'file', size: snapshot.bytes.length, sha256: sha256Hex(snapshot.bytes) };
    ops.push({ op: 'put', path: copy, key: pathKey(ctx, copy), expect: digest, want, wantDigest: digest, kind: 'edit', temp: '',
      aside: '', copy });
  }
  if (ops.length === 0) return { asides: [], dirs: [] };
  appendTemps(ctx, nameTemps(ctx, ops));
  if (writePass(ctx, ops) !== 'ok') {
    for (const o of ops) unlinkOwnTemp(root, o.temp, o.wantDigest);
    return { asides: [], dirs: [] };
  }
  const r = await runOps(ctx, ops, caps, copyNamer(ctx, []), { onChanged: 'skip' });
  for (const path of r.again) ctx.log.debug('worktree operation skipped', { action: 'unshare', path, reason: 'changed' });
  if (r.error !== 'none') ctx.log.debug('worktree operation failed', {
    action: 'unshare', paths: [...made.values()].map((m) => m.copy), error: r.error });
  return { asides: r.asides, dirs: [...r.changedDirs] };
}

// Unsharing is a tidy-up: when it fails (the state dir or the journal can't be written), the move's own outcome stands.
async function tryUnshare(ctx: RunContext, made: ReadonlyMap<string, { copy: string; ino: string | 'none' }>,
  ours: readonly Aside[], caps: (tempDir: string) => VolumeCaps, dir: string): Promise<{ asides: Aside[]; dirs: string[] }> {
  try {
    return await unshareCopies(ctx, made, ours, caps, dir);
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    ctx.log.debug('worktree operation failed', { action: 'unshare', paths: [...made.values()].map((m) => m.copy), error: e });
    return { asides: [], dirs: [] };
  }
}

// Clears the move part and hands its asides to the settle part, in one journal write.
export function clearMovePart(ctx: RunContext, asides: readonly Aside[], o: { keep?: 'planned' } = {}): void {
  mutateJournal(ctx.paths.journal, (j) => {
    const next = { ...j };
    if (o.keep === 'planned' && j.move !== undefined) next.move = { ...j.move, phase: 'planned', temps: [], written: 0 };
    else delete next.move;
    next.settle = [...(j.settle ?? []), ...asides.map(toSettle)];
    return next;
  });
}

// Hands replaced inodes to the settle part and keeps the move part (an applyOps caller with more steps).
export function settleAsides(ctx: RunContext, asides: readonly Aside[]): void {
  if (asides.length === 0) return;
  mutateJournal(ctx.paths.journal, (j) => ({ ...j, settle: [...(j.settle ?? []), ...asides.map(toSettle)] }));
}

function toSettle(a: Aside): SettleEntry {
  return { name: a.name, path: a.path, ino: a.ino, expect: a.expect, copy: a.copy, since: a.since };
}

// ---------------------------------------------------------------------------------------------------------------
// M8: index, then ref

async function indexLocked(ctx: RunContext): Promise<'locked' | 'free'> {
  try {
    lstatSync(join(ctx.gitDir, 'index.lock'));
    return 'locked';
  } catch {
    return 'free';
  }
}

async function withIndexRetry(ctx: RunContext, fn: () => Promise<'ok' | 'locked' | string>): Promise<'ok' | 'busy' | string> {
  const deadline = Date.now() + INDEX_LOCK_WAIT_MS;
  for (;;) {
    const r = await fn();
    if (r !== 'locked') return r;
    if (Date.now() >= deadline) return 'busy';
    await Bun.sleep(250);
  }
}

const LOCK_RE = /index\.lock': File exists|Unable to create '[^']+\.lock'/;

// The index gets final's entries: only the changed paths (stat data of every other entry kept), or a full reset. No
// path list is ever put on a command line (20 000 paths overflow ARG_MAX).
async function indexStep(ctx: RunContext, from: string | 'empty', final: string, index: 'changed-paths' | 'reset'): Promise<'ok' | 'busy' | string> {
  const g = ctx.git;
  return withIndexRetry(ctx, async () => {
    if ((await indexLocked(ctx)) === 'locked') return 'locked';
    if (index === 'reset') {
      const r = await g.run(['read-tree', '--reset', final]);
      if (r.code !== 0) return LOCK_RE.test(r.stderr) ? 'locked' : `git read-tree --reset exited ${r.code}: ${firstLine(r.stderr)}`;
    } else {
      const changes = await diffTrees(ctx, from === 'empty' ? ctx.emptyTree : from, final);
      const removes = [...changes].filter(([, c]) => c.toSide === 'absent').map(([p]) => p);
      const sets = [...changes].filter(([, c]) => c.toSide !== 'absent');
      if (removes.length > 0) {
        const r = await g.run(['update-index', '-z', '--force-remove', '--stdin'], { input: removes.map((p) => `${p}\0`).join('') });
        if (r.code !== 0) return LOCK_RE.test(r.stderr) ? 'locked' : `git update-index --force-remove exited ${r.code}: ${firstLine(r.stderr)}`;
      }
      if (sets.length > 0) {
        const input = sets.map(([p, c]) => {
          const s = c.toSide as Present;
          return `${s.mode} ${s.sha} 0\t${p}\0`;
        }).join('');
        const r = await g.run(['update-index', '-z', '--index-info'], { input });
        if (r.code !== 0) return LOCK_RE.test(r.stderr) ? 'locked' : `git update-index --index-info exited ${r.code}: ${firstLine(r.stderr)}`;
      }
      const idx = await indexEntries(g);
      const off: string[] = [];
      for (const p of removes) if (idx.get(p)?.stage === 0) off.push(p);
      for (const [p, c] of sets) {
        const e = idx.get(p);
        const s = c.toSide as Present;
        if (e === undefined || e.stage !== 0 || e.mode !== s.mode || e.sha !== s.sha) off.push(p);
      }
      if (off.length > 0) return `index does not hold the moved entries: ${off.slice(0, 10).join(', ')}`;
    }
    await g.run(['update-index', '-q', '--refresh']);
    return 'ok';
  });
}

async function headState(ctx: RunContext): Promise<{ sha: string | 'unborn'; ref: string | 'detached' }> {
  const sha = await headSha(ctx.git);
  const r = await ctx.git.run(['symbolic-ref', '-q', 'HEAD']);
  return { sha, ref: r.code === 0 ? r.stdout.trim() : 'detached' };
}

async function refStep(ctx: RunContext, reason: MoveReason, ref: RefStep, final: string): Promise<'ok' | string> {
  if (ref.kind === 'none') return 'ok';
  const old = ref.old === 'zero' ? zeroOid(ctx) : ref.old;
  const args = ['update-ref', '-m', `mdsync: ${reason}`, ...(ref.ref === 'HEAD' ? ['--no-deref'] : []), ref.ref, final, old];
  const r = await ctx.git.run(args);
  if (r.code !== 0) {
    // already there (a resumed ref step): fine
    if ((await revParse(ctx.git, ref.ref)) === final) return 'ok';
    return `git update-ref exited ${r.code}: ${firstLine(r.stderr)}`;
  }
  if (ref.head === 'attach') {
    const s = await ctx.git.run(['symbolic-ref', 'HEAD', ref.ref]);
    if (s.code !== 0) return `git symbolic-ref exited ${s.code}: ${firstLine(s.stderr)}`;
  }
  return 'ok';
}

function setPhase(ctx: RunContext, phase: MoveJournal['phase']): void {
  mutateJournal(ctx.paths.journal, (j) => (j.move === undefined ? j : { ...j, move: { ...j.move, phase } }));
}

// M8 from the given phase: 'index' redoes the index step (idempotent), 'ref' only the ref step.
async function finishIndexAndRef(ctx: RunContext, j: MoveJournal, from: 'index' | 'ref', asides: readonly Aside[]):
  Promise<{ kind: 'ok' } | { kind: 'busy' | 'failed'; error: string }> {
  if (from === 'index') {
    setPhase(ctx, 'index');
    if (moveTestHooks.atStep?.('index') === 'crash') throw new SimulatedCrash('simulated crash at the index step');
    const r = await indexStep(ctx, j.from, j.to, j.index);
    if (r === 'busy') return { kind: 'busy', error: 'the index stayed locked (index.lock)' };
    if (r !== 'ok') return { kind: 'failed', error: r };
  }
  setPhase(ctx, 'ref');
  if (moveTestHooks.atStep?.('ref') === 'crash') throw new SimulatedCrash('simulated crash at the ref step');
  const now = await headState(ctx);
  if (now.sha !== j.head.sha || now.ref !== j.head.ref) {
    // A person moved HEAD: the index was set for a HEAD that is gone. Put it back to their HEAD (index only), clear
    // the part and let the next run sync their commit.
    if (now.sha !== 'unborn') await ctx.git.run(['read-tree', '--reset', now.sha]);
    clearMovePart(ctx, asides);
    return { kind: 'failed', error: 'HEAD moved during the worktree move' };
  }
  const r = await refStep(ctx, j.reason, j.ref, j.to);
  if (r === 'ok' && moveTestHooks.atStep?.('ref-moved') === 'crash') throw new SimulatedCrash('simulated crash after the ref step');
  if (r !== 'ok') {
    if (now.sha !== 'unborn') await ctx.git.run(['read-tree', '--reset', now.sha]);
    clearMovePart(ctx, asides);
    return { kind: 'failed', error: r };
  }
  return { kind: 'ok' };
}

// ---------------------------------------------------------------------------------------------------------------
// moveWorktree (M0–M9)

type Resume = { done: Map<string, Digest>; copies: MoveJournal['copies']; base: string;
  deletes: Map<string, string> };   // journaled deletes: path -> sha256 of the bytes the original plan deleted

type Cls =
  | { c: 'nothing'; why: 'already' | 'absent' | 'done' | 'gitlink' | 'other' }
  | { c: 'resurvey' }                                        // it changed kind twice since the survey: surveyed again
  | { c: 'kept-edit' }                                       // a path this move already wrote, edited since: it stays
  | { c: 'put'; why: 'clean' | 'prefix' | 'git-output' | 'create' }
  | { c: 'edit'; base: Side; local: Side }
  | { c: 'folder' }                                          // a folder where `to` needs a file (its entries are slots)
  | { c: 'mkdir' };                                          // a gitlink of `to` whose folder is absent

type RoundCopy = { origin: string; copy: string; slot: Slot; blob: string; folder: 'whole' | 'file'; folderDisk: string };
type Collision = { incoming: string; path: string; action: 'kept-identical' | 'renamed' | 'moved-folder'; copy?: string;
  committable: 'commit' | 'local-only' };

export async function moveWorktree(ctx: RunContext, i: MoveInput): Promise<MoveResult> {
  return new MoveRun(ctx, i, 'none').run();
}

class MoveRun {
  readonly g;
  readonly root: string;
  readonly workDir: string;
  journaled: 'yes' | 'no';
  readonly asides: Aside[] = [];
  readonly doneOps: Done[] = [];
  readonly moved: { path: string; to: string }[] = [];
  readonly capsCache = new Map<string, VolumeCaps>();
  // M0/M1 state
  head0: { sha: string | 'unborn'; ref: string | 'detached' } = { sha: 'unborn', ref: 'detached' };
  prior: MoveJournal | undefined;
  fileMode: 'trust' | 'ignore' = 'trust';
  symlinks: 'enabled' | 'disabled' = 'enabled';
  fromRev = '';
  base = '';
  dmap = new Map<string, { fromSide: Side; toSide: Side }>();
  renames = new Map<string, string>();
  index = new Map<string, { mode: string; sha: string; stage: number }>();
  fromTree = new Map<string, TreeEntry>();
  toTree = new Map<string, TreeEntry>();
  fromByKey = new Map<string, string[]>();
  toByKey = new Map<string, string[]>();
  indexKeys = new Set<string>();
  // survey and plan state
  readonly slots = new Map<string, Slot>();
  dirCache: DirCache = new Map();
  readonly changedIn = new Map<string, number[]>();   // slot key -> rounds it came back changed
  readonly doneMap: Map<string, Digest>;
  readonly madeCopies = new Map<string, { copy: string; ino: string | 'none' }>();   // origin disk path -> its copy
  readonly madeCopyKeys = new Set<string>();   // every copy name a copy op of this run made (linked or copied)
  readonly overridden: OverriddenDelete[] = [];
  readonly copies: string[] = [];
  readonly raced: string[] = [];
  readonly collisions: Collision[] = [];
  readonly editCopies: { origin: string; copy: string }[] = [];
  final: string;
  copiesCommit: string | 'none' = 'none';
  journalCopies: MoveJournal['copies'];
  readonly copiesKnown: Map<string, MoveJournal['copies'][number]>;
  nameRaw: CopyNamer = (p) => p;
  memo = new Map<string, string>();
  readonly fromFiles = new Map<string, string>();
  readonly toFiles = new Map<string, string>();
  readonly digests = new Map<string, Digest>();
  filtered = new Set<string>();
  resurvey = new Set<string>();   // slot keys M3 could not classify (they kept changing kind): surveyed again
  readonly blocking = new Map<string, string>();   // key of a file in the way of a folder `to` needs -> an incoming path under it

  constructor(readonly ctx: RunContext, readonly i: MoveInput, readonly resume: Resume | 'none') {
    this.g = ctx.git;
    this.root = ctx.realDir;
    this.workDir = join(ctx.paths.tmp, `move-${process.pid}-${++workSeq}`);
    this.journaled = resume === 'none' ? 'no' : 'yes';
    this.doneMap = new Map(resume === 'none' ? [] : resume.done);
    this.final = i.to;
    this.journalCopies = resume === 'none' ? [] : [...resume.copies];
    this.copiesKnown = new Map((resume === 'none' ? [] : resume.copies).map((c) => [c.copy, c]));
  }

  key(p: string): string {
    return pathKey(this.ctx, p);
  }

  // A copy this move made: linked or copied by a copy op, or moved with its folder. From then on it is the person's: no
  // later round writes it, so an edit or a delete of it (within the move) stands, as it would after the move.
  madeCopy(p: string): boolean {
    const k = this.key(p);
    return this.madeCopyKeys.has(k) || this.moved.some((m) => k.startsWith(`${this.key(m.to)}/`));
  }

  // After the copies commit (round 1), later rounds measure against `final`, as a resumed move does (its `to` is the
  // journaled final): a committed copy whose link was refused is then an incoming file, and a create-only put writes it
  // from its blob (M5). Measured against `to`, which lacks it, it was `nothing`: M8 still gave HEAD and the index the
  // copy, the disk never got it, and the next commit pushed its deletion (chaos round 2: seeds 121, 138, 141, 149,
  // 157, 158, 160, 164). Every other path is the same in both trees.
  async measureAgainstFinal(): Promise<void> {
    this.toTree = await lsTree(this.g, this.final);
    if (this.ctx.ignoreCase !== 'case-insensitive') return;
    this.toByKey = new Map();
    for (const p of this.toTree.keys()) this.toByKey.set(this.key(p), [...(this.toByKey.get(this.key(p)) ?? []), p]);
  }

  readonly caps = (tempDir: string): VolumeCaps => {
    let c = this.capsCache.get(tempDir);
    if (c === undefined) {
      if (devOf(join(this.root, tempDir)) === 'missing') return DEFAULT_CAPS;
      c = capsFor(this.ctx, tempDir);
      this.capsCache.set(tempDir, c);
    }
    return c;
  };

  async run(): Promise<MoveResult> {
    try {
      const m0 = await this.init();
      if (m0 !== 'ok') return m0;
      let candidates: string[] = [...this.dmap.keys()];
      for (let round = 1; ; round++) {
        if (round > MOVE_ROUNDS) {
          // only structural churn gets here (a path flipping between file and folder): the part stays at
          // 'writing', and P4 finishes the move forward. Nothing is undone.
          return { kind: 'busy', error: `the folder kept changing under the worktree move: ${candidates.slice(0, 5).join(', ')}` };
        }
        const live = await this.survey(candidates);                                  // M2
        moveTestHooks.afterSurvey?.(round);
        await this.materializeFor(live, round);
        const plan = await this.planRound(live, round);                              // M3
        if (round === 1 && this.resume === 'none') {
          await this.commitCopies(plan.copies);
          if (this.final !== this.i.to) await this.measureAgainstFinal();
        } else {
          await this.registerCopies(plan.copies);
        }
        for (const c of plan.copies) this.copies.push(c.copy);
        const temps = nameTemps(this.ctx, plan.ordered);                             // M4
        if (this.journaled === 'no') {
          mutateJournal(this.ctx.paths.journal, (j) => ({ ...j, move: { op: 'move', reason: this.i.reason, phase: 'writing',
            from: this.i.from, head: this.head0, to: this.final, base: this.base, ref: this.i.ref, index: this.i.index, temps,
            written: 0, copies: this.journalCopies, ...(this.prior?.quit !== undefined ? { quit: this.prior.quit } : {}),
            startedAt: new Date(this.ctx.clock.now()).toISOString() } }));
          ensureTempFolders(this.root, temps.map((t) => t.name));
          this.journaled = 'yes';
        } else {
          appendTemps(this.ctx, temps);
        }
        if (round === 1) await pauseForTests(this.ctx, this.i.reason);
        const wp = writePass(this.ctx, plan.ordered);                               // M5
        if (wp !== 'ok') return await this.fail(`worktree move failed: ${wp}`);
        const r = await runOps(this.ctx, plan.ordered, this.caps, (p) => this.nameRaw(p), { onChanged: 'skip' });
        this.asides.push(...r.asides);
        this.doneOps.push(...r.done);
        this.moved.push(...r.moved);
        this.raced.push(...r.raced);
        for (const [o, c] of r.copies) {
          this.madeCopies.set(o, c);
          this.madeCopyKeys.add(this.key(c.copy));
        }
        for (const d of r.done) this.doneMap.set(d.op.path, d.op.wantDigest);
        if (r.error !== 'none') return await this.fail(`worktree move failed: ${r.error}`);
        for (const k of this.resurvey) r.again.add(k);
        for (const k of r.again) this.changedIn.set(k, [...(this.changedIn.get(k) ?? []), round]);
        const now = await headState(this.ctx);                                       // M6
        if (now.sha !== this.head0.sha || now.ref !== this.head0.ref) return await this.fail('HEAD moved during the worktree move');
        if (r.again.size === 0) break;
        candidates = [...r.again].map((k) => this.slots.get(k)?.disk ?? k);
        // A committed copy that is not on disk yet (its link was refused: the original changed or went between M3's
        // hash and the link) is surveyed next round. Measured against `final`, it is an incoming file: a create-only
        // put writes it from its blob. One this move made is the person's, and is never surveyed again.
        for (const jc of this.journalCopies) {
          if (!this.madeCopy(jc.copy) && !this.doneMap.has(jc.copy) && !candidates.includes(jc.copy)) candidates.push(jc.copy);
        }
      }

      const un = await tryUnshare(this.ctx, this.madeCopies, this.asides, this.caps, join(this.workDir, 'unshare'));
      this.asides.push(...un.asides);

      // M7: the new entries are on disk before HEAD names `final`
      fsyncDirs(this.root, [...this.doneOps.map((d) => parentOf(d.op.path)), ...un.dirs,
        ...this.moved.flatMap((m) => [parentOf(m.path), parentOf(m.to)]), ...this.asides.map((a) => tempFolderOf(a.name))]);

      // M8
      const part = readJournal(this.ctx.paths.journal);
      const j = part === 'none' ? undefined : part.move;
      if (j === undefined) throw new MoveFailed('the move journal part vanished');
      const fin = await finishIndexAndRef(this.ctx, j, 'index', this.asides);
      if (fin.kind !== 'ok') return fin;
      clearMovePart(this.ctx, this.asides);
      await this.logOutcome();
      return { kind: 'moved', final: this.final, copies: [...new Set([...this.copies, ...this.editCopies.map((c) => c.copy)])],
        overridden: this.overridden, raced: this.raced, commit: this.copiesCommit };
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      if (e instanceof GuardStop) {
        if (this.journaled === 'yes') clearMovePart(this.ctx, this.asides, this.i.reason === 'op-quit' ? { keep: 'planned' } : {});
        return { kind: 'data-guard-stop', error: e.message };
      }
      const error = errorText(e);
      if (this.journaled === 'yes') {
        // Once M8 has begun, the index (and maybe the ref) already name `final`: an undo would put `from`'s bytes under
        // them. The part stays at 'index' or 'ref', and P4 finishes M8 forward.
        const j = readJournal(this.ctx.paths.journal);
        const phase = j === 'none' ? 'none' : j.move?.phase ?? 'none';
        if (phase === 'index' || phase === 'ref') return { kind: 'failed', error };
        try {
          return await this.fail(error);
        } catch {
          // the part stays: P4 resumes it
        }
      }
      return { kind: 'failed', error };
    } finally {
      await rm(this.workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // M9 then clear the part (op-quit: back to 'planned', so P4 retries).
  async fail(error: string): Promise<MoveResult> {
    const back = await undo(this.ctx, this.doneOps, this.moved, this.caps);
    const un = await tryUnshare(this.ctx, this.madeCopies, [...this.asides, ...back], this.caps, join(this.workDir, 'unshare'));
    clearMovePart(this.ctx, [...this.asides, ...back, ...un.asides], this.i.reason === 'op-quit' ? { keep: 'planned' } : {});
    return { kind: 'failed', error };
  }

  // M0 + M1
  async init(): Promise<'ok' | MoveResult> {
    const { ctx, i, g } = this;
    this.head0 = await headState(ctx);
    this.base = this.resume === 'none' ? i.to : this.resume.base;
    const expectHead = i.reason === 'clone-completion' ? this.base : i.from === 'empty' ? 'unborn' : i.from;
    if (this.head0.sha !== expectHead) return { kind: 'failed', error: `HEAD is ${this.head0.sha}, expected ${expectHead}` };
    const existing = readJournal(ctx.paths.journal);
    this.prior = existing === 'none' ? undefined : existing.move;
    if (this.resume === 'none' && this.prior !== undefined
      && !(this.prior.phase === 'planned' && this.prior.quit !== undefined && i.reason === 'op-quit')) {
      return { kind: 'failed', error: 'a worktree move is already in progress (P4 resumes it)' };
    }
    if (i.reason !== 'op-quit' && (await unmergedPaths(g)).length > 0) return { kind: 'failed', error: 'unmerged entries present' };
    this.fileMode = (await gitConfigValue(ctx, 'core.fileMode')) === 'false' ? 'ignore' : 'trust';
    this.symlinks = await symlinksEnabled(ctx);
    this.fromRev = i.from === 'empty' ? ctx.emptyTree : i.from;
    this.dmap = await diffTrees(ctx, this.fromRev, i.to);
    this.renames = i.from === 'empty' ? new Map() : await renamePairs(ctx, this.fromRev, i.to);
    this.index = await indexEntries(g);
    this.fromTree = i.from === 'empty' ? new Map() : await lsTree(g, i.from);
    this.toTree = await lsTree(g, i.to);
    if (i.reason === 'op-quit') {
      // the paths where the index or the worktree differs from `from`: what a person (or the op) staged or wrote
      const extra = new Set<string>([
        ...parseNul((await g.run(['diff-index', '--cached', '-z', '--name-only', '--no-renames', this.fromRev, '--'])).stdout),
        ...parseNul((await g.run(['diff-files', '-z', '--name-only', '--'])).stdout),
        ...(await unmergedPaths(g)),
      ]);
      for (const p of extra) {
        if (this.dmap.has(p) || TEMP_DIR_RE.test(p)) continue;
        this.dmap.set(p, { fromSide: sideOf(this.fromTree.get(p)), toSide: sideOf(this.toTree.get(p)) });
      }
    }
    if (ctx.ignoreCase === 'case-insensitive') {
      for (const p of this.fromTree.keys()) this.fromByKey.set(this.key(p), [...(this.fromByKey.get(this.key(p)) ?? []), p]);
      for (const p of this.toTree.keys()) this.toByKey.set(this.key(p), [...(this.toByKey.get(this.key(p)) ?? []), p]);
    }
    this.indexKeys = new Set([...this.index.keys()].map((p) => this.key(p)));
    this.nameRaw = copyNamer(ctx, [...this.toTree.keys(), ...this.fromTree.keys(), ...this.index.keys()]);
    return 'ok';
  }

  // Copy names: memoized within a round (the planner names one copy folder per clashing ancestor), named after what
  // is on disk (an untracked `Case.md` in the way of `case.md` gives `Case (conflict …).md`).
  nameCopy = (p: string): string => {
    let c = this.memo.get(p);
    if (c === undefined) {
      const s = this.slots.get(this.key(p));
      c = this.nameRaw(s !== undefined && s.look.kind !== 'absent' ? s.disk : p);
      this.memo.set(p, c);
    }
    return c;
  };

  makeSlot(p: string): Slot {
    const { ctx, root } = this;
    const k = this.key(p);
    const ci = ctx.ignoreCase;
    const fromSp = ci === 'case-insensitive' ? this.fromByKey.get(k) ?? [] : this.fromTree.has(p) ? [p] : [];
    const toSp = ci === 'case-insensitive' ? this.toByKey.get(k) ?? [] : this.toTree.has(p) ? [p] : [];
    const loc = locate(root, toSp[0] ?? fromSp[0] ?? p, ci, this.dirCache);
    const diskBase = loc.state === 'present' ? baseOf(loc.disk) : '';
    const toPath = toSp.length === 0 ? 'none' : toSp.length === 1 ? toSp[0] as string
      : toSp.find((s) => baseOf(s) === diskBase) ?? [...toSp].sort()[0] as string;
    const fromPath = fromSp.length === 0 ? 'none'
      : fromSp.find((s) => s === toPath) ?? fromSp.find((s) => baseOf(s) === diskBase) ?? fromSp[0] as string;
    const toSide = toPath === 'none' ? 'absent' : sideOf(this.toTree.get(toPath));
    const fromSide = fromPath === 'none' ? 'absent' : sideOf(this.fromTree.get(fromPath));
    return { key: k, path: toPath !== 'none' ? toPath : fromPath !== 'none' ? fromPath : loc.disk, toPath, toSide, fromPath, fromSide,
      fromAll: fromSp.map((s) => ({ path: s, side: sideOf(this.fromTree.get(s)) })), extraTo: toSp.filter((s) => s !== toPath),
      role: fromSide === 'absent' && !this.indexKeys.has(k) ? 'in-the-way' : 'tracked',
      disk: loc.disk, look: loc.state === 'present' ? lookAt(root, loc.disk) : { kind: 'absent' } };
  }

  // M2: S is the candidates, every prefix `to` needs as a folder that holds a file or symlink, and every entry under a
  // folder that sits where `to` needs a file. Every listing skips the temp folders. Returns the slots surveyed.
  async survey(candidates: readonly string[]): Promise<Slot[]> {
    this.dirCache = new Map();
    const queue = [...new Set(candidates)];
    const seen = new Set<string>();
    const out: Slot[] = [];
    while (queue.length > 0) {
      const p = queue.shift() as string;
      if (TEMP_DIR_RE.test(p) || p === '') continue;
      const k = this.key(p);
      if (seen.has(k)) continue;
      seen.add(k);
      const s = this.makeSlot(p);
      this.slots.set(k, s);
      out.push(s);
      if (s.toSide !== 'absent') {
        const incoming = s.toPath === 'none' ? p : s.toPath;
        for (const pre of properPrefixes(incoming)) {
          const loc = locate(this.root, pre, this.ctx.ignoreCase, this.dirCache);
          const inTheWay = typeof loc.state === 'object' ? loc.state.behind
            : loc.state === 'present' && lookAt(this.root, loc.disk).kind !== 'dir' ? loc.disk : 'none';
          if (inTheWay === 'none') continue;
          queue.push(inTheWay);
          if (!this.blocking.has(this.key(inTheWay))) this.blocking.set(this.key(inTheWay), incoming);
        }
      }
      if (s.toSide !== 'absent' && s.toSide.mode !== GITLINK && s.look.kind === 'dir') {
        const r = await this.g.run(['ls-files', '-z', '--cached', '--others', '--', `:(literal)${s.disk}/`]);
        for (const u of parseNul(r.stdout)) if (!TEMP_DIR_RE.test(u)) queue.push(u.replace(/\/+$/, ''));
      }
    }
    return out;
  }

  async materializeFor(live: readonly Slot[], round: number): Promise<void> {
    const needFrom: string[] = [];
    const needTo: string[] = [];
    for (const s of live) {
      for (const f of s.fromAll) if (f.side !== 'absent' && f.side.mode !== GITLINK && !this.fromFiles.has(f.path)) needFrom.push(f.path);
      if (s.toPath !== 'none' && s.toSide !== 'absent' && s.toSide.mode !== GITLINK && !this.toFiles.has(s.toPath)) needTo.push(s.toPath);
    }
    for (const [p, f] of await materialize(this.ctx, this.fromRev, needFrom, join(this.workDir, `from-${round}`))) this.fromFiles.set(p, f);
    // `final`: `to` until the copies commit, then `to` plus the committed copies (the same bytes for every other path)
    for (const [p, f] of await materialize(this.ctx, this.final, needTo, join(this.workDir, `to-${round}`))) this.toFiles.set(p, f);
    const hashRev = this.i.from === 'empty' ? this.i.to : this.fromRev;
    this.filtered = await pathsWithAttr(this.ctx, hashRev, live.filter((s) => s.look.kind === 'file').map((s) => s.path),
      ['filter', 'ident', 'working-tree-encoding']);
  }

  digestOf(file: string, mode: string): Digest {
    let d = this.digests.get(file);
    if (d === undefined) {
      d = versionDigest(versionAt(file, mode));
      this.digests.set(file, d);
    }
    return d;
  }

  async classify(s: Slot, attempt: 'first' | 'second' = 'first'): Promise<Cls> {
    const { i, root } = this;
    const look = s.look;
    if (s.toSide !== 'absent' && s.toSide.mode === GITLINK) return look.kind === 'absent' ? { c: 'mkdir' } : { c: 'nothing', why: 'gitlink' };
    if (s.fromSide !== 'absent' && s.fromSide.mode === GITLINK && s.toSide === 'absent') return { c: 'nothing', why: 'gitlink' };
    const doneWant = this.doneMap.get(s.disk);
    if (doneWant !== undefined) {
      const seen: Seen = look.kind === 'file' || look.kind === 'symlink' ? look.digest : look.kind === 'absent' ? { kind: 'absent' } : { kind: 'other' };
      return sameContent(seen, doneWant) ? { c: 'nothing', why: 'done' } : { c: 'kept-edit' };
    }
    if (this.madeCopy(s.disk) || this.madeCopy(s.path)) return { c: 'nothing', why: 'done' };   // the person's now
    if (look.kind === 'dir') return s.toSide !== 'absent' ? { c: 'folder' } : { c: 'nothing', why: 'other' };
    if (look.kind === 'other') return { c: 'nothing', why: 'other' };
    // a copy name a resumed move already made: its bytes are local content, never overwritten
    if (this.copiesKnown.has(s.path) && look.kind !== 'absent') return { c: 'nothing', why: 'done' };
    if (look.kind === 'absent') {
      if (s.toSide === 'absent') return { c: 'nothing', why: 'absent' };
      if (s.fromSide === 'absent' || i.reason === 'clone-completion') return { c: 'put', why: 'create' };
      return { c: 'edit', base: this.baseSide(s), local: 'absent' };   // a local delete of a path `to` changes
    }
    const toFile = s.toPath !== 'none' ? this.toFiles.get(s.toPath) : undefined;
    const localMode = this.modeOf(s, look);
    if (s.toSide !== 'absent' && toFile !== undefined && digestEq(look.digest, this.digestOf(toFile, s.toSide.mode))
      && localMode === s.toSide.mode) return { c: 'nothing', why: 'already' };
    if (i.reason !== 'op-quit') {
      for (const f of s.fromAll) {
        if (f.side === 'absent') continue;
        const file = this.fromFiles.get(f.path);
        if (file !== undefined && digestEq(look.digest, this.digestOf(file, f.side.mode)) && localMode === f.side.mode) {
          return { c: 'put', why: 'clean' };
        }
      }
    }
    if (i.reason === 'clone-completion' && look.kind === 'file' && toFile !== undefined && isStrictPrefix(root, s.disk, toFile)) {
      return { c: 'put', why: 'prefix' };   // git was killed mid-write: the new version starts with every byte of this one
    }
    // the blob git would store for these bytes, with from's attributes
    let blob: string;
    if (look.kind === 'symlink') {
      blob = await writeBlob(this.g, new TextEncoder().encode(look.target));
    } else {
      const bytes = readBytes(root, s.disk);
      if (bytes === 'gone') {
        // The file went between the survey and this read (an agent renamed or deleted it). It is measured again, never
        // dropped from the plan: dropped, M8 still gave the index `to`'s entry, and the next commit pushed a delete of
        // a remote edit (chaos seed 110). Absent now, it is a local delete (an edit `to` changed: delete-overridden).
        s.look = lookAt(root, s.disk);
        return attempt === 'first' ? this.classify(s, 'second') : { c: 'resurvey' };
      }
      const now: Digest = { kind: 'file', size: bytes.length, sha256: sha256Hex(bytes) };
      if (!digestEq(now, look.digest)) s.look = { ...look, digest: now as PresentDigest };
      blob = await hashBytes(this.ctx, i.from === 'empty' ? i.to : this.fromRev, s.path, bytes);
    }
    if (i.reason !== 'op-quit' && s.fromSide !== 'absent' && blob === s.fromSide.sha && localMode === s.fromSide.mode
      && !this.filtered.has(s.path)) {
      return { c: 'put', why: 'clean' };   // only an end-of-line rewrite separates the bytes from git's
    }
    if (i.disposable !== undefined && i.disposable(s.path, blob) === 'git-output') return { c: 'put', why: 'git-output' };
    return { c: 'edit', base: this.baseSide(s), local: { mode: localMode, sha: blob } };
  }

  // An edit's base is always from's side. (An op-quit's index stage-0 entry is not the base: measured against it, a
  // person's staged edit at a path the abort leaves alone became a conflict copy instead of staying in place as the
  // uncommitted edit it was. Against `from`, it stays; where G changes the path, it is copied either way.)
  baseSide(s: Slot): Side {
    return s.fromSide;
  }

  modeOf(s: Slot, look: Extract<Look, { kind: 'file' | 'symlink' }>): string {
    if (look.kind === 'symlink') return SYMLINK;
    const sides = [s.fromSide, s.toSide].filter((x): x is Present => x !== 'absent');
    // core.symlinks=false: a regular file whose bytes equal a symlink side's target is that symlink
    if (this.symlinks === 'disabled' && sides.some((x) => x.mode === SYMLINK)) return SYMLINK;
    if (this.fileMode === 'ignore') return sides.find((x) => x.mode === '100644' || x.mode === '100755')?.mode ?? '100644';
    return look.exec === 'exec' ? '100755' : '100644';
  }

  // A put at s: expect what the survey saw there, want to's version (or `want`).
  putFor(s: Slot, kind: PutKind, want?: Version): Extract<XOp, { op: 'put' }> {
    const look = s.look;
    const expect: Expect = look.kind === 'file' || look.kind === 'symlink' ? look.digest : { kind: 'absent' };
    let w: Version = { kind: 'absent' };
    if (want !== undefined) {
      w = want;
    } else if (s.toPath !== 'none' && s.toSide !== 'absent' && s.toSide.mode !== GITLINK) {
      const file = this.toFiles.get(s.toPath);
      if (file === undefined) throw new MoveFailed(`no materialized version of ${s.toPath}`);
      w = versionAt(file, s.toSide.mode);
    }
    const spelling = s.toPath !== 'none' && s.toPath !== s.disk ? s.toPath : undefined;
    return { op: 'put', path: s.disk, key: s.key, expect, want: w, wantDigest: versionDigest(w), kind, temp: '', aside: '',
      ...(spelling !== undefined ? { spelling } : {}) };
  }

  // A resumed move whose crash came between a rename-follow's put of the new name q and the delete of the old
  // name p: q is done and still holds what this move put there, and p still holds exactly the bytes the original plan
  // deleted it against (its journaled delete). p's edit is then saved: in q, when q's version is not `to`'s plain one
  // (merged, or the local version taken), or in the committed copy the plan made of p. Anything else keeps p (an edit
  // wins over a delete): at worst the old name comes back, never a lost edit.
  followWritten(p: Slot, q: Slot): boolean {
    if (this.resume === 'none') return false;
    const pSha = p.look.kind === 'file' || p.look.kind === 'symlink' ? p.look.digest.sha256 : 'none';
    if (pSha === 'none' || this.resume.deletes.get(p.disk) !== pSha) return false;
    const want = this.doneMap.get(q.disk);
    const qSha = q.look.kind === 'file' || q.look.kind === 'symlink' ? q.look.digest.sha256 : 'none';
    if (want === undefined || want.kind === 'absent' || want.sha256 !== qSha) return false;
    const toFile = q.toPath !== 'none' ? this.toFiles.get(q.toPath) : undefined;
    const plain = toFile !== undefined && q.toSide !== 'absent' ? this.digestOf(toFile, q.toSide.mode) : 'none';
    if (plain === 'none') return false;
    if (plain.kind !== 'absent' && plain.sha256 !== want.sha256) return true;
    const c = this.resume.copies.find((x) => x.path === p.disk);
    if (c === undefined) return false;
    const d = digestAt(this.root, c.copy);
    return (d.kind === 'file' || d.kind === 'symlink') && d.sha256 === pSha;
  }

  // The folder in the way that a conflict copy at `copyPath` moves with: a disk folder where `to` needs a file, under
  // whose copy name `copyPath` sits.
  folderAbove(s: Slot, copyPath: string): { disk: string; copy: string } | 'none' {
    for (const pre of properPrefixes(s.disk)) {
      const fs = this.slots.get(this.key(pre));
      if (fs === undefined || fs.look.kind !== 'dir' || fs.toSide === 'absent') continue;
      const copy = this.nameCopy(pre);
      if (copyPath.startsWith(`${copy}/`)) return { disk: fs.disk, copy };
    }
    return 'none';
  }

  async planRound(live: readonly Slot[], round: number): Promise<{ ordered: XOp[]; copies: RoundCopy[] }> {
    const { ctx, i } = this;
    this.memo = new Map();
    this.resurvey = new Set();
    const classes = new Map<string, { s: Slot; cls: Cls }>();
    const identity: Slot[] = [];
    for (const s of live) {
      const hist = this.changedIn.get(s.key) ?? [];
      if (round >= 3 && hist.includes(round - 1) && hist.includes(round - 2)) identity.push(s);
      else classes.set(s.key, { s, cls: await this.classify(s) });
    }
    // An edit of a note the remote renamed follows the rename, as the autostash's merge did: the triple moves to the
    // new name (with nothing on disk), and the old name is deleted once the new one is written.
    const followOf = new Map<string, Slot>();   // origin key -> destination slot
    const followDone: Slot[] = [];              // resumed follows whose new name was written before the crash
    for (const { s, cls } of classes.values()) {
      if (cls.c !== 'edit' || cls.local === 'absent' || s.toSide !== 'absent' || s.fromPath === 'none') continue;
      const q = this.renames.get(s.fromPath);
      if (q === undefined) continue;
      const qs = this.slots.get(this.key(q)) ?? this.makeSlot(q);
      if (qs.fromSide !== 'absent' || qs.toSide === 'absent') continue;
      if (qs.look.kind !== 'absent') {
        if (this.followWritten(s, qs)) {
          classes.delete(s.key);
          followDone.push(s);
        }
        continue;
      }
      this.slots.set(qs.key, qs);
      classes.delete(qs.key);   // its plain create is replaced by the edit's
      followOf.set(s.key, qs);
    }

    const triples: PathTriple[] = [];
    const bySlot = new Map<string, { s: Slot; q: Slot | 'none'; blob: string }>();   // triple path -> origin
    const putOps: XOp[] = [];
    // the old name's delete, which the crash cut off: a checked put against the bytes it holds (they are the ones the
    // original plan merged or copied, checked against its journal). Kept, the next commit pushed the old name back.
    for (const s of followDone) putOps.push(this.putFor(s, 'edit', { kind: 'absent' }));
    for (const { s, cls } of classes.values()) {
      switch (cls.c) {
        case 'edit': {
          const q = followOf.get(s.key) ?? 'none';
          const path = q === 'none' ? s.path : q.path;
          triples.push({ path, base: cls.base, local: cls.local, remote: q === 'none' ? s.toSide : q.toSide });
          bySlot.set(path, { s, q, blob: cls.local === 'absent' ? '' : cls.local.sha });
          break;
        }
        case 'put':
          putOps.push(this.putFor(s, cls.why === 'create' ? 'create' : 'git'));
          break;
        case 'folder':
          // its entries are slots of their own; once they are gone (deleted, or moved with the folder), the file goes
          // in. An empty folder is removed first.
          putOps.push({ op: 'rmdir', path: s.disk, key: s.key });
          putOps.push(this.putFor(s, 'create'));
          break;
        case 'mkdir':
          putOps.push({ op: 'mkdir', path: s.disk, key: s.key });
          break;
        case 'nothing':
          if (cls.why === 'already' && s.role === 'in-the-way') {
            this.collisions.push({ incoming: s.toPath === 'none' ? s.path : s.toPath, path: s.disk, action: 'kept-identical',
              committable: 'commit' });
          }
          break;
        case 'kept-edit':
          break;
        case 'resurvey':
          this.resurvey.add(s.key);
          break;
      }
      if ((cls.c === 'nothing' || cls.c === 'kept-edit') && s.toPath !== 'none' && s.look.kind !== 'absent' && s.disk !== s.toPath) {
        putOps.push({ op: 'rename', path: s.disk, key: s.key, to: s.toPath });   // a remote case-only rename
      }
    }
    triples.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // M3
    const env: PlanEnv = { remote: this.toTree, ignoreCase: ctx.ignoreCase, blocked: () => false };
    const tpaths = triples.map((t) => t.path);
    const merger: Merger = i.edits === 'copy' ? async () => ({ kind: 'conflict', reason: 'content' })
      : makeMerger(ctx, { binary: await pathsWithAttr(ctx, i.to, tpaths, ['filter']), attrs: await mergeAttrsOf(ctx, i.to, tpaths) });
    const plan: Plan = await buildPlan(triples, merger, this.nameCopy, env);
    const guard = dataGuard(triples, plan, env);
    if (guard.kind === 'fail') {
      ctx.log.error('data guard stop', { phase: 'plan', paths: guard.paths, reason: guard.reason });
      throw new GuardStop(`data guard stop (plan): ${guard.reason}: ${guard.paths.join(', ')}`);
    }
    const copies: RoundCopy[] = [];
    const folderMoves = new Map<string, string>();   // folder disk path -> copy folder
    for (const e of plan.entries) {
      const o = bySlot.get(e.triple.path);
      if (o === undefined) continue;
      const { s, q } = o;
      const d = e.disposition;
      switch (d.kind) {
        case 'conflict-copy': {
          const folder = this.folderAbove(s, d.copyPath);
          if (folder !== 'none') {
            folderMoves.set(folder.disk, folder.copy);
            copies.push({ origin: s.disk, copy: d.copyPath, slot: s, blob: o.blob, folder: 'whole', folderDisk: folder.disk });
            break;
          }
          copies.push({ origin: s.disk, copy: d.copyPath, slot: s, blob: o.blob, folder: 'file', folderDisk: '' });
          if (q !== 'none') {
            putOps.push(this.putFor(q, 'create'));
            putOps.push({ ...this.putFor(s, 'edit', { kind: 'absent' }), after: q.disk });
          } else {
            putOps.push(this.putFor(s, 'edit'));   // the remote keeps the path (an absent side deletes it)
          }
          break;
        }
        case 'merged': {
          const target = q === 'none' ? s : q;
          const want = await smudge(ctx, i.to, target.toPath === 'none' ? target.path : target.toPath, d.sha, d.mode,
            join(this.workDir, 'merged'));
          if (q !== 'none') {
            putOps.push(this.putFor(q, 'edit', want));
            putOps.push({ ...this.putFor(s, 'edit', { kind: 'absent' }), after: q.disk });
          } else {
            putOps.push(this.putFor(s, 'edit', want));
          }
          break;
        }
        case 'delete-overridden':
          this.overridden.push({ path: e.triple.path, deletedBy: 'local' });
          putOps.push(this.putFor(s, 'create'));
          break;
        case 'edit-restored':
          this.overridden.push({ path: e.triple.path, deletedBy: 'remote' });
          break;
        case 'take-local':
          if (q !== 'none' && e.triple.local !== 'absent') {
            const want = await smudge(ctx, i.to, q.toPath === 'none' ? q.path : q.toPath, e.triple.local.sha, e.triple.local.mode,
              join(this.workDir, 'merged'));
            putOps.push(this.putFor(q, 'edit', want));
            putOps.push({ ...this.putFor(s, 'edit', { kind: 'absent' }), after: q.disk });
          }
          break;
        case 'same':
          break;
      }
    }

    // identity mode: a path that changed in the two previous rounds is captured by inode, never compared by content.
    // An in-place writer keeps writing into the copy's inode (also through descriptors it opened earlier); a save
    // between the link and the exchange is raced and kept. So an identity put ends the churn on that path.
    const identityCopies: XOp[] = [];
    const identityMoves: XOp[] = [];
    for (const s of identity) {
      const look = lookAt(this.root, s.disk);
      if (s.toSide !== 'absent' && s.toSide.mode === GITLINK) continue;
      if (look.kind === 'file' || look.kind === 'symlink') {
        if (s.toSide === 'absent') continue;   // an edit wins over a delete: the file stays
        const copy = this.nameRaw(s.disk);
        identityCopies.push({ op: 'copy', path: s.disk, key: s.key, copy, expect: 'any', origin: s.disk });
        putOps.push({ ...this.putFor(s, 'edit'), expect: { kind: 'inode', copy } });
        this.editCopies.push({ origin: s.disk, copy });
        if ((await copyCommittable(ctx, s.disk, copy)) === 'local-only') addLocalOnly(ctx.paths.localOnly, [copy]);
        ctx.log.warn('worktree write raced', { path: s.disk, kind: 'changing', copy });
      } else if (look.kind === 'dir') {
        if (s.toSide === 'absent') continue;
        const copy = this.nameRaw(s.disk);
        identityMoves.push({ op: 'move-aside', path: s.disk, key: s.key, to: copy, origin: s.disk, gone: 'fine' });
        putOps.push({ ...this.putFor(s, 'create'), expect: { kind: 'absent' } });
        this.collisions.push({ incoming: s.path, path: s.disk, action: 'moved-folder', copy, committable: 'local-only' });
      } else if (look.kind === 'absent' && s.toSide !== 'absent') {
        putOps.push({ ...this.putFor(s, 'create'), expect: { kind: 'absent' } });
      }
    }

    // order: copies; deletes, deepest first; move-asides; the other puts, shallowest first, each followed by the
    // deletes waiting for it
    const copyOps: XOp[] = [];
    for (const c of copies) {
      if (c.folder === 'whole') continue;
      const prior = this.madeCopies.get(c.origin);
      if (prior !== undefined && prior.ino !== 'none' && inoOf(this.root, prior.copy) === prior.ino
        && inoOf(this.root, c.origin) === prior.ino) continue;   // an earlier round's copy links this inode already
      const look = c.slot.look;
      copyOps.push({ op: 'copy', path: c.origin, key: c.slot.key, copy: c.copy,
        expect: look.kind === 'file' || look.kind === 'symlink' ? look.digest : 'any', origin: c.origin });
    }
    const moveOps: XOp[] = [...folderMoves].map(([path, to]) => ({ op: 'move-aside', path, key: this.key(path), to, origin: path,
      gone: 'again' }));
    const isPut = (o: XOp): o is Extract<XOp, { op: 'put' }> => o.op === 'put';
    const deletes = putOps.filter((o) => isPut(o) && o.want.kind === 'absent' && o.after === undefined)
      .sort((a, b) => depth(b.path) - depth(a.path));
    const waiting = putOps.filter((o): o is Extract<XOp, { op: 'put' }> => isPut(o) && o.after !== undefined);
    const rest = putOps.filter((o) => !deletes.includes(o) && !waiting.includes(o as Extract<XOp, { op: 'put' }>))
      .sort((a, b) => depth(a.path) - depth(b.path) || rank(a) - rank(b));
    const ordered: XOp[] = [...copyOps, ...identityCopies, ...deletes, ...moveOps, ...identityMoves];
    for (const o of rest) {
      ordered.push(o);
      if (o.op === 'put') for (const w of waiting) if (this.key(w.after as string) === o.key) ordered.push(w);
    }
    for (const w of waiting) if (!ordered.includes(w)) ordered.push(w);
    // A put that replaces an inode a copy hard-links (this round's copy of the path, or an earlier round's that still
    // links it) records the copy in its aside. Settle then knows the copy keeps every write that reaches the inode
    // after the switch. Without it, an agent's edit of the conflict copy within the grace read as a late write, and
    // settle linked the same inode under a second copy name: two worktree names, one inode (chaos seed 103).
    const linkedCopy = new Map<string, string>();   // path -> copy name
    for (const o of copyOps) if (o.op === 'copy') linkedCopy.set(o.path, o.copy);
    for (const o of ordered) {
      if (o.op !== 'put' || o.expect.kind === 'inode' || o.expect.kind === 'absent') continue;
      const made = this.madeCopies.get(o.path);
      const copy = linkedCopy.get(o.path)
        ?? (made !== undefined && made.ino !== 'none' && inoOf(this.root, o.path) === made.ino ? made.copy : undefined);
      if (copy !== undefined) o.copy = copy;
    }
    return { ordered, copies };
  }

  // The copies commit (round 1 only: `final` is journaled before anything is written): committable copies of edits
  // and of files in the way go into one commit on `to` that holds nothing else; local-only ones are recorded.
  async commitCopies(copies: readonly RoundCopy[]): Promise<void> {
    const { ctx, i } = this;
    const commitable: { origin: string; copy: string; blob: string; mode: string; role: Slot['role'] }[] = [];
    const localOnly: string[] = [];
    for (const c of copies) {
      const verdict = await copyCommittable(ctx, c.origin, c.copy);
      this.noteCopy(c, verdict);
      const look = c.slot.look;
      if (verdict === 'local-only') localOnly.push(c.copy);
      else if (i.copies === 'commit' && c.blob !== '' && (look.kind === 'file' || look.kind === 'symlink')) {
        commitable.push({ origin: c.origin, copy: c.copy, blob: c.blob, role: c.slot.role,
          mode: look.kind === 'symlink' ? SYMLINK : this.modeOf(c.slot, look) });
      }
    }
    addLocalOnly(ctx.paths.localOnly, localOnly);
    if (commitable.length === 0) return;
    const sets: IndexOp[] = commitable.map((c) => ({ op: 'set', path: c.copy, mode: c.mode, sha: c.blob }));
    const t = await buildTree(ctx, i.to, sets);
    const expected = new Map(this.toTree);
    for (const c of commitable) expected.set(c.copy, { mode: c.mode, type: 'blob', sha: c.blob });
    const off = mapDiff(t.entries, expected);
    if (off.length > 0) {
      ctx.log.error('data guard stop', { phase: 'verify', paths: off, reason: 'copies tree does not match the target plus the copies' });
      throw new GuardStop(`data guard stop (verify): ${off.join(', ')}`);
    }
    const kind = commitable.every((c) => c.role === 'in-the-way') ? 'collision' : 'stash';
    this.copiesCommit = await commitTree(ctx, t.tree, i.to, buildConflictMessage({ host: ctx.host, now: new Date(ctx.clock.now()),
      kind, copies: commitable.map((c) => c.copy), overridden: this.overridden, replayedSubjects: [] }));
    this.final = this.copiesCommit;
    this.journalCopies = commitable.map((c) => ({ path: c.origin, copy: c.copy, blob: c.blob }));
  }

  // Copies planned after round 1 (or by a resumed move) stay uncommitted local changes.
  async registerCopies(copies: readonly RoundCopy[]): Promise<void> {
    for (const c of copies) {
      const verdict = await copyCommittable(this.ctx, c.origin, c.copy);
      this.noteCopy(c, verdict);
      if (verdict === 'local-only') addLocalOnly(this.ctx.paths.localOnly, [c.copy]);
    }
  }

  noteCopy(c: RoundCopy, verdict: 'commit' | 'local-only'): void {
    if (c.folder === 'whole') {
      if (this.collisions.some((x) => x.path === c.folderDisk && x.action === 'moved-folder')) return;
      const fs = this.slots.get(this.key(c.folderDisk));
      this.collisions.push({ incoming: fs !== undefined && fs.toPath !== 'none' ? fs.toPath : c.folderDisk, path: c.folderDisk,
        action: 'moved-folder', copy: this.nameCopy(c.folderDisk), committable: verdict });
      return;
    }
    if (c.slot.role === 'in-the-way') {
      // `incoming` names what arrives: the path itself, or for a file where `to` needs a folder, a path under it
      const incoming = c.slot.toPath !== 'none' ? c.slot.toPath : this.blocking.get(c.slot.key) ?? c.slot.path;
      this.collisions.push({ incoming, path: c.origin, action: 'renamed', copy: c.copy, committable: verdict });
    } else {
      this.editCopies.push({ origin: c.slot.path, copy: c.copy });
    }
  }

  async logOutcome(): Promise<void> {
    const { ctx, i } = this;
    for (const c of this.collisions) ctx.log.warn('collision', { ...c });
    const withCopy = this.collisions.filter((c) => c.copy !== undefined);
    if (withCopy.length > 0) ctx.log.warn('conflict', { kind: 'collision', paths: withCopy.map((c) => c.incoming), copies: withCopy.map((c) => c.copy) });
    if (this.editCopies.length > 0) {
      ctx.log.warn('conflict', { kind: i.reason === 'op-quit' ? 'rescue' : 'stash', paths: this.editCopies.map((c) => c.origin),
        copies: this.editCopies.map((c) => c.copy) });
    }
    for (const o of this.overridden) ctx.log.info('delete overridden', { path: o.path, deletedBy: o.deletedBy });
    if (this.copiesCommit !== 'none') {
      const subject = subjectOf(await this.g.ok(['show', '-s', '--format=%B', this.copiesCommit, '--']));
      ctx.log.info('committed', { sha: this.copiesCommit, files: this.journalCopies.length, subject, source: 'conflict' });
    }
  }
}

const DEFAULT_CAPS: VolumeCaps = { mode: 'rename-only', noReplace: 'link' };

// Test-only seam: `afterOp` runs after every switch of a move or applyOps; returning 'crash' stops the process's
// view of the move right there, as a SIGKILL would: nothing is undone and the journal stays for P4. `inWritePass` runs
// after C1 wrote each temp of a write pass ('crash': a SIGKILL inside the pass; 'fail': a write error such as ENOSPC).
// `afterSurvey` runs between a round's survey (M2) and its classification (M3), where an agent's rename or delete can
// land; `settle` is handed to settleAside (its writer injection points). Never set in production.
export const moveTestHooks: { afterOp?: (n: number, path: string) => 'crash' | 'go';
  atStep?: (step: 'index' | 'ref' | 'ref-moved') => 'crash' | 'go';
  afterSurvey?: (round: number) => void;
  inWritePass?: (n: number, path: string, temp: string) => 'crash' | 'fail' | 'go';   // after C1 wrote a temp: a SIGKILL, or
                                                                                      //   a write error (ENOSPC) right there
  settle?: CasHooks } = {};
export class SimulatedCrash extends Error {}

// rmdir before a put at the same depth, case-only renames after
function rank(o: XOp): number {
  return o.op === 'rmdir' ? 0 : o.op === 'rename' ? 2 : 1;
}

// Content equality that tolerates a size the journal did not record (-1: only the sha256 is known).
function sameContent(a: Seen, b: Digest): boolean {
  if (b.kind !== 'absent' && b.size < 0) return (a.kind === 'file' || a.kind === 'symlink') && a.sha256 === b.sha256;
  return digestEq(a, b);
}

function depth(p: string): number {
  let n = 0;
  for (let k = p.indexOf('/'); k !== -1; k = p.indexOf('/', k + 1)) n++;
  return n;
}

function inoOf(root: string, rel: string): string | 'none' {
  try {
    return String(lstatSync(join(root, rel), { bigint: true }).ino);
  } catch {
    return 'none';
  }
}

function isStrictPrefix(root: string, rel: string, wantFile: string): boolean {
  const have = readBytes(root, rel);
  if (have === 'gone') return false;
  let want: Uint8Array;
  try {
    want = readFileSync(wantFile);
  } catch {
    return false;
  }
  if (have.length >= want.length) return false;
  for (let k = 0; k < have.length; k++) if (have[k] !== want[k]) return false;
  return true;
}

function mapDiff(a: Map<string, TreeEntry>, b: Map<string, TreeEntry>): string[] {
  const out: string[] = [];
  for (const [p, e] of a) {
    const o = b.get(p);
    if (o === undefined || o.mode !== e.mode || o.sha !== e.sha) out.push(p);
  }
  for (const p of b.keys()) if (!a.has(p)) out.push(p);
  return out.sort();
}

// ---------------------------------------------------------------------------------------------------------------
// applyOps: M4–M7 and M9 for callers with their own plan (the stash replay, P5, P3)

export async function applyOps(ctx: RunContext, ops: readonly WorktreeOp[], j: MoveJournal, o: { onChanged: 'skip' | 'stop' }):
  Promise<ApplyResult> {
  const root = ctx.realDir;
  const capsCache = new Map<string, VolumeCaps>();
  const caps = (tempDir: string): VolumeCaps => {
    let c = capsCache.get(tempDir);
    if (c === undefined) {
      c = capsFor(ctx, tempDir);
      capsCache.set(tempDir, c);
    }
    return c;
  };
  const key = (p: string): string => pathKey(ctx, p);
  const xops: XOp[] = ops.map((op): XOp => {
    if (op.op === 'copy') return { op: 'copy', path: op.path, key: key(op.path), copy: op.copy, expect: op.expect, origin: op.path };
    if (op.op === 'move-aside') return { op: 'move-aside', path: op.path, key: key(op.path), to: op.to, origin: op.path, gone: 'fine' };
    return { op: 'put', path: op.path, key: key(op.path), expect: op.expect, want: op.want, wantDigest: versionDigest(op.want),
      kind: op.expect.kind === 'absent' ? 'create' : 'git', temp: '', aside: '', ...(op.after !== undefined ? { after: op.after } : {}),
      ...(op.copy !== undefined ? { copy: op.copy } : {}) };
  });
  mutateJournal(ctx.paths.journal, (cur) => ({ ...cur, move: { ...j, phase: 'writing', written: j.written ?? j.temps.length } }));
  appendTemps(ctx, nameTemps(ctx, xops));
  await pauseForTests(ctx, j.reason);
  const wp = writePass(ctx, xops);
  if (wp !== 'ok') return { kind: 'failed', error: wp };
  const name = copyNamer(ctx, []);
  const r = await runOps(ctx, xops, caps, name, o);
  const unshareDir = join(ctx.paths.tmp, `unshare-${process.pid}-${++workSeq}`);
  try {
    if (r.error !== 'none') {
      const back = await undo(ctx, r.done, r.moved, caps);
      const un = await tryUnshare(ctx, r.copies, [...r.asides, ...back], caps, unshareDir);
      return { kind: 'failed', error: `worktree write failed: ${r.error}`, asides: [...r.asides, ...back, ...un.asides] };
    }
    const un = await tryUnshare(ctx, r.copies, r.asides, caps, unshareDir);
    const asides = [...r.asides, ...un.asides];
    fsyncDirs(root, [...r.changedDirs, ...un.dirs, ...new Set(asides.map((a) => tempFolderOf(a.name)))]);
    if (o.onChanged === 'stop' && r.again.size > 0) {
      return { kind: 'busy', error: `changed while written: ${[...r.again].join(', ')}`, asides };
    }
    return { kind: 'applied', raced: r.raced, skipped: [...r.again], asides };
  } finally {
    await rm(unshareDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------
// resumeMove: P4 finishes a move part forward

export type ResumeOutcome =
  | MoveResult
  | { kind: 'rerun'; reason: MoveReason; j: MoveJournal }   // an applyOps caller (or P2's planned part): its caller reruns
  | { kind: 'stash-tail'; j: MoveJournal }                 // the stash replay's ref moved: T8–T10 are next
  | { kind: 'quit-tail'; j: MoveJournal; result: MoveResult };   // op-quit finished: P2 steps 4–5 are next

type Recovered = {
  done: Map<string, Digest>;   // path -> the want a switch put there (never from an 'undoing' part: see resumeMove)
  asides: Aside[];             // replaced inodes, kept for settle
  deletes: Map<string, string>;   // path -> sha256 of the bytes its journaled delete was planned against (rename-follow)
};

// The done map and the asides, from the journaled temps. A temp that still holds exactly its version (never switched
// in) is unlinked; every other existing name is an aside, kept for settle. Nothing else is unlinked here, except:
// - a temp journaled after the last completed write pass (`written`): its round never switched anything, so whatever
//   it holds is ours, whole or cut short by the crash. Read as a replaced inode, a cut-short temp became a `late`
//   conflict copy of junk that was committed and pushed;
// - an aside that is a second link of the inode still at its path (C5' cut between its link and its rename: rule (c)).
// A switch cut in two is finished here instead of re-surveyed: C5c moved the old inode aside and died before the
// create (the path is absent), or an O_EXCL copy create (copy-only `excl-open`, C2 or C5c) died part-way (the path
// holds a strict prefix of the temp). Re-surveyed, an absent path read as a local delete: the remote version was
// written, and settle then unlinked the aside holding the person's merged edit (the edit was only in the temp).
function recoverTemps(ctx: RunContext, j: MoveJournal): Recovered {
  const root = ctx.realDir;
  const done = new Map<string, Digest>();
  const asides: Aside[] = [];
  const deletes = new Map<string, string>();
  const keepWhole = new Set<string>();   // asides of a switch that began and could not be finished: kept as copies
  const shaAt = (p: string): string | 'absent' | 'other' => {
    const d = digestAt(root, p);
    return d.kind === 'file' || d.kind === 'symlink' ? d.sha256 : d.kind === 'absent' ? 'absent' : 'other';
  };
  const wantDigest = (t: MoveTemp): Digest => (t.want === 'absent' ? { kind: 'absent' } : { kind: 'file', size: -1, sha256: t.want });
  const unlinkName = (name: string): void => {
    try {
      unlinkSync(join(root, name));
    } catch {
      // gone
    }
  };
  const keep = (t: MoveTemp): void => {
    const ino = inoOf(root, t.name);
    if (ino === 'none') return;
    const expect: SettleEntry['expect'] = t.expect === 'inode' || keepWhole.has(t.name) ? 'inode'
      : t.expect === 'absent' ? { kind: 'absent' } : { kind: 'file', size: -1, sha256: t.expect };
    asides.push({ name: t.name, path: t.path, ino, expect, copy: t.copy ?? 'none', since: Date.now() });
  };
  const written = j.written ?? j.temps.length;
  for (const [k, t] of j.temps.entries()) {
    if (t.kind === 'temp' && t.want === 'absent' && t.expect !== 'absent' && t.expect !== 'inode') deletes.set(t.path, t.expect);
    if (k >= written) {
      if (t.kind === 'temp') unlinkName(t.name);
      else if (shaAt(t.name) !== 'absent') keep(t);   // can't exist (asides come from switches): kept, never unlinked
      continue;
    }
    const at = shaAt(t.name);
    let here = shaAt(t.path);
    if (t.kind === 'temp') {
      if (at === 'absent') {
        if (t.want !== 'absent' && here === t.want) done.set(t.path, wantDigest(t));   // a create that completed
        continue;
      }
      if (at === t.want) {
        if (t.want !== 'absent' && here !== t.want) {
          const pair = j.temps[k + 1];
          const aside = pair !== undefined && pair.kind === 'aside' && pair.path === t.path ? pair.name : 'none';
          const r = finishSwitch(ctx, t, aside);
          if (r === 'finished') here = shaAt(t.path);
          else if (r === 'unfinished' && aside !== 'none') keepWhole.add(aside);
        }
        if (t.want !== 'absent' && here === t.want) done.set(t.path, wantDigest(t));
        unlinkName(t.name);   // our version, never switched in (rule (a)), or copied in whole just now
        continue;
      }
      if (t.want !== 'absent' && here === t.want) done.set(t.path, wantDigest(t));   // exchanged: it holds the old inode
    } else {
      if (at === 'absent') continue;
      const ino = inoOf(root, t.name);
      if (ino !== 'none' && ino === inoOf(root, t.path) && !keepWhole.has(t.name)) {
        unlinkName(t.name);   // C5' cut before its rename: the path still links this inode (rule (c))
        continue;
      }
      if (t.want === 'absent' ? here === 'absent' : here === t.want) done.set(t.path, wantDigest(t));
    }
    keep(t);
  }
  return { done, asides, deletes };
}

// A switch that began and was cut short, finished from its temp (which holds exactly `want`):
// - C5c moved the old inode aside (its aside exists, another inode than the path's) and the path is still absent:
//   create `want` there without replacing anything;
// - an O_EXCL copy create (`excl-open` filesystems only: C2, or C5c's second step) died part-way: the path is a regular
//   file holding a strict prefix of `want`, so the rest is appended (O_APPEND; a writer that appended since makes it
//   no prefix, and it is surveyed as an edit).
// 'unfinished': the switch began (the old inode is aside) but the path could not be completed: its aside is kept whole
// as a copy. 'none': nothing to finish.
function finishSwitch(ctx: RunContext, t: MoveTemp, aside: string | 'none'): 'finished' | 'unfinished' | 'none' {
  const root = ctx.realDir;
  const asideIno = aside === 'none' ? 'none' : inoOf(root, aside);
  const pathIno = inoOf(root, t.path);
  const switched: 'began' | 'not-begun' = asideIno !== 'none' && asideIno !== pathIno ? 'began' : 'not-begun';
  const otherwise = switched === 'began' ? 'unfinished' : 'none';
  const temp = join(root, t.name);
  try {
    if (pathIno === 'none') {
      if (switched === 'not-begun') return 'none';   // a create (or a C5' cut before its link) that never ran: planned again
      const r = renameNoReplace(temp, join(root, t.path), capsFor(ctx, tempFolderOf(t.name)));
      return r === 'renamed' ? 'finished' : 'unfinished';
    }
    // Only an O_EXCL copy (excl-open) can be cut part-way. Elsewhere creates are atomic, and a prefix at the path is
    // someone else's file: never written into.
    if (switched === 'not-begun' && t.expect !== 'absent') return 'none';
    if (capsFor(ctx, tempFolderOf(t.name)).noReplace !== 'excl-open') return otherwise;
    const st = lstatSync(join(root, t.path));
    if (!st.isFile()) return otherwise;
    const want = readFileSync(temp);
    const have = readBytes(root, t.path);
    if (have === 'gone' || have.length >= want.length || !isPrefixOf(have, want)) return otherwise;
    const fd = openSync(join(root, t.path), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      let off = have.length;
      while (off < want.length) off += writeSync(fd, want, off, want.length - off);
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return 'finished';
  } catch {
    return otherwise;
  }
}

function isPrefixOf(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length > b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

function moved(j: MoveJournal): MoveResult {
  return { kind: 'moved', final: j.to, copies: j.copies.map((c) => c.copy), overridden: [], raced: [],
    commit: j.to !== j.base ? j.to : 'none' };
}

export async function resumeMove(ctx: RunContext, j: MoveJournal): Promise<ResumeOutcome> {
  try {
    const { done, asides, deletes } = recoverTemps(ctx, j);
    // The asides wait out their grace in the settle part, whatever happens to the move part next. Every journaled temp
    // is accounted for now (the cut-short ones are gone): a resumed round's temps come after the `written` mark.
    mutateJournal(ctx.paths.journal, (cur) => ({ ...cur, settle: [...(cur.settle ?? []), ...asides.map(toSettle)],
      ...(cur.move !== undefined ? { move: { ...cur.move, written: cur.move.temps.length } } : {}) }));
    if (j.phase === 'undoing') {
      // M9 was undoing a failed move when the process stopped. HEAD and the index are still at `from`, and every path
      // holds `from`'s version, `to`'s, or an edit. The temps are never a done map: an undo put's `want` is `from`'s
      // version (or absent), and marked done, M8 gave the index `to`'s entries over it. The part is cleared (op-quit:
      // back to 'planned', as M9 leaves it) and the run fails; the next run moves again from scratch, where `to`'s
      // bytes classify as `already` and `from`'s as `clean`.
      if (j.reason === 'stash-replay' || j.reason === 'unmerged-recovery' || j.reason === 'rescue-restore') {
        clearMovePart(ctx, []);
        return { kind: 'rerun', reason: j.reason, j };
      }
      clearMovePart(ctx, [], j.reason === 'op-quit' ? { keep: 'planned' } : {});
      return { kind: 'failed', error: 'the worktree move failed and was being undone when the process stopped' };
    }
    const head = await headSha(ctx.git);
    if (head === j.to && j.to !== j.head.sha) {
      // the ref moved: redo the index step (idempotent)
      const r = await indexStep(ctx, j.from, j.to, j.index);
      if (r === 'busy') return { kind: 'busy', error: 'the index stayed locked (index.lock)' };
      if (r !== 'ok') return { kind: 'failed', error: r };
      if (j.reason === 'stash-replay') {
        mutateJournal(ctx.paths.journal, (cur) => (cur.move === undefined ? cur : { ...cur, move: { ...cur.move, phase: 'drop' } }));
        return { kind: 'stash-tail', j: { ...j, phase: 'drop' } };
      }
      clearMovePart(ctx, []);
      return j.reason === 'op-quit' ? { kind: 'quit-tail', j, result: moved(j) } : moved(j);
    }
    if (j.phase === 'drop') return { kind: 'stash-tail', j };
    if (j.phase === 'planned') {
      if (head === j.head.sha) return { kind: 'rerun', reason: j.reason, j };
      clearMovePart(ctx, []);
      return { kind: 'failed', error: `move journal state mismatch: HEAD ${head}` };
    }
    if (j.reason === 'stash-replay' || j.reason === 'unmerged-recovery' || j.reason === 'rescue-restore') {
      // an applyOps caller: its plan is recomputed from the current files, so the paths already written are skipped
      if (j.reason === 'stash-replay' && (j.phase === 'index' || j.phase === 'ref') && head === j.head.sha) {
        return { kind: 'rerun', reason: j.reason, j };   // T5 from its step (conflict.ts)
      }
      clearMovePart(ctx, []);
      return { kind: 'rerun', reason: j.reason, j };
    }
    if (head !== j.head.sha) {
      clearMovePart(ctx, []);
      return { kind: 'failed', error: `move journal state mismatch: HEAD ${head}` };
    }
    if (j.phase === 'index' || j.phase === 'ref') {
      const fin = await finishIndexAndRef(ctx, j, j.phase, []);
      if (fin.kind !== 'ok') return fin;
      clearMovePart(ctx, []);
      return j.reason === 'op-quit' ? { kind: 'quit-tail', j, result: moved(j) } : moved(j);
    }
    // phase 'writing': the move again with the journal's inputs, `to` = the journaled final, and the done map. The
    // copies commit is reused, so copy names and commits are never recomputed.
    const input: MoveInput = { reason: j.reason, from: j.from, to: j.to, ref: j.ref, index: j.index,
      edits: j.reason === 'op-quit' ? 'copy' : 'merge', copies: 'uncommitted',
      ...(j.quit !== undefined ? { disposable: await disposableFromQuit(ctx, j.quit) } : {}) };
    const res = await new MoveRun(ctx, input, { done, copies: j.copies, base: j.base, deletes }).run();
    if (res.kind !== 'moved') return res;
    const out: MoveResult = { ...res, commit: j.to !== j.base ? j.to : 'none',
      copies: [...new Set([...j.copies.map((c) => c.copy), ...res.copies])] };
    return j.reason === 'op-quit' ? { kind: 'quit-tail', j, result: out } : out;
  } catch (e) {
    return { kind: 'failed', error: errorText(e) };
  }
}

// P2's disposable rule from the recorded quit inputs: a blob is git's output when it is p's entry in a reproducible
// tree (within its paths), one of p's stage blobs, or AUTO_MERGE:p (git's conflict output, byte for byte).
export async function disposableFromQuit(ctx: RunContext, quit: NonNullable<MoveJournal['quit']>): Promise<Disposable> {
  const byPath = new Map<string, Set<string>>();
  const add = (p: string, sha: string): void => {
    let s = byPath.get(p);
    if (s === undefined) byPath.set(p, (s = new Set()));
    s.add(sha);
  };
  for (const t of quit.trees as QuitTree[]) {
    let tree: Map<string, TreeEntry>;
    try {
      tree = await lsTree(ctx.git, t.rev);
    } catch {
      continue;
    }
    const only = t.paths === 'all' ? 'all' : new Set(t.paths);
    for (const [p, e] of tree) if (only === 'all' || only.has(p)) add(p, e.sha);
  }
  for (const [p, shas] of Object.entries(quit.stages)) for (const s of shas) add(p, s);
  if (quit.autoMerge !== 'none') {
    // Only for the unmerged paths: AUTO_MERGE is a whole tree, and its entry for any other path is whatever HEAD held
    // there, which may be a person's work (a hand resolution committed at an earlier stop of the same rebase).
    try {
      for (const [p, e] of await lsTree(ctx.git, quit.autoMerge)) if (Object.hasOwn(quit.stages, p)) add(p, e.sha);
    } catch {
      // AUTO_MERGE's tree is gone (gc): unmerged files then count as edits, which costs a copy, never a write
    }
  }
  return (path, blob) => (byPath.get(path)?.has(blob) ? 'git-output' : 'edit');
}

// ---------------------------------------------------------------------------------------------------------------
// Settle

async function knownPaths(ctx: RunContext): Promise<Set<string>> {
  const known = new Set<string>((await indexEntries(ctx.git)).keys());
  const head = await headSha(ctx.git);
  if (head !== 'unborn') for (const p of (await lsTree(ctx.git, head)).keys()) known.add(p);
  return known;
}

// Settles the replaced inodes whose grace has passed ('due'), or waits for the newest one first ('all', at most
// SETTLE_GRACE_MS; an abort skips the wait). Clean ones are unlinked; a late write is kept as a conflict copy. The
// journal is rewritten once; temp folders nothing needs any more are removed once empty. One entry never fails the
// call (settle entries never block a run): an entry that can't be settled now stays, due again after another
// grace, so a stuck one can't turn the settle timer into a hot loop either.
export async function settlePending(ctx: RunContext, when: 'due' | 'all', o: { signal?: AbortSignal } = {}):
  Promise<{ late: string[]; dueAt: number | 'none' }> {
  const read = (): SettleEntry[] => {
    const j = readJournal(ctx.paths.journal);
    return j === 'none' ? [] : j.settle ?? [];
  };
  let entries = read();
  if (when === 'all' && entries.length > 0) {
    const newest = Math.max(...entries.map((e) => e.since));
    const wait = Math.min(SETTLE_GRACE_MS, Math.max(0, newest + SETTLE_GRACE_MS - Date.now()));
    if (wait > 0 && o.signal?.aborted !== true) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        o.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
    entries = read();
  }
  const now = Date.now();
  const late: string[] = [];
  const settled = new Set<string>();
  const again = new Map<string, SettleEntry>();   // entry name -> the entry that replaces it (due after another grace)
  let namer: CopyNamer | undefined;
  const nameFor = async (): Promise<CopyNamer> => (namer ??= copyNamer(ctx, await knownPaths(ctx)));
  for (const e of entries) {
    if (e.since + SETTLE_GRACE_MS > now) continue;
    try {
      const r = settleAside(ctx.realDir, { ...e }, moveTestHooks.settle);
      if (r.kind === 'clean') {
        settled.add(e.name);
        continue;
      }
      let copy: string | 'none' | 'stuck';
      if (r.kind === 'late') {
        copy = keepAsCopy(ctx, r.kept, e.path, await nameFor(), 'late');
      } else {
        // a write reached the inode during the unlink: bytes are never copied out while they are still changing
        try {
          copy = await copyOutStable(ctx, r.fd, e, await nameFor(), again);
        } finally {
          closeSync(r.fd);
        }
      }
      if (copy === 'stuck') {
        if (!again.has(e.name)) again.set(e.name, { ...e, since: Date.now() });
        continue;
      }
      settled.add(e.name);
      if (copy !== 'none') {
        late.push(copy);
        if ((await copyCommittable(ctx, e.path, copy)) === 'local-only') addLocalOnly(ctx.paths.localOnly, [copy]);
      }
    } catch (err) {
      // the entry stays (its inode is still linked at e.name, or its bytes were kept elsewhere first): tried again later
      if (!settled.has(e.name) && !again.has(e.name)) again.set(e.name, { ...e, since: Date.now() });
      ctx.log.warn('worktree write raced', { path: e.path, kind: 'late', copy: e.name, error: errorText(err) });
    }
  }
  let remaining: SettleEntry[] = [];
  if (settled.size > 0 || again.size > 0) {
    const next = mutateJournal(ctx.paths.journal, (j) => ({ ...j, settle: (j.settle ?? []).filter((x) => !settled.has(x.name))
      .map((x) => again.get(x.name) ?? x) }));
    remaining = next.settle ?? [];
  } else {
    remaining = entries;
  }
  removeSettledFolders(ctx, [...new Set(entries.filter((e) => settled.has(e.name)).map((e) => tempFolderOf(e.name))), PROC_TEMP]);
  const dueAt = remaining.length === 0 ? 'none' : Math.min(...remaining.map((e) => e.since + SETTLE_GRACE_MS));
  return { late, dueAt };
}

// S5's caller: re-reads an unlinked inode through fd until two reads agree (at most SETTLE_GRACE_MS), then copies the
// bytes out to a create-only conflict copy: in the path's folder, else at the top. fd is the only reference left to
// those bytes, so when neither name can be made they go to a fresh temp-folder name that the settle part keeps (as a
// late write, journaled before it exists) instead. Before, a failed name dropped them (copyOut had closed fd).
async function copyOutStable(ctx: RunContext, fd: number, e: SettleEntry, name: CopyNamer, again: Map<string, SettleEntry>):
  Promise<string | 'none'> {
  let prev = hashFd(fd).sha256;
  const until = Date.now() + SETTLE_GRACE_MS;
  while (Date.now() < until) {
    await Bun.sleep(SETTLE_STABLE_MS);
    const cur = hashFd(fd).sha256;
    if (cur === prev) break;
    prev = cur;
  }
  let error = 'no free name';
  for (const target of [e.path, baseOf(e.path)]) {
    try {
      const copy = copyOut(ctx.realDir, fd, name(target));
      ctx.log.warn('worktree write raced', { path: e.path, kind: 'late', copy });
      return copy;
    } catch (err) {
      error = errorText(err);
    }
  }
  const temp = newTempName(ctx.realDir, e.path);
  const entry: SettleEntry = { name: temp, path: e.path, ino: 'pending', expect: 'inode', copy: 'none', since: Date.now() };
  mutateJournal(ctx.paths.journal, (j) => ({ ...j, settle: [...(j.settle ?? []), entry] }));   // journaled before it exists
  ensureTempFolders(ctx.realDir, [temp]);
  copyOut(ctx.realDir, fd, temp);
  again.set(temp, { ...entry, ino: inoOf(ctx.realDir, temp) });
  ctx.log.warn('worktree write raced', { path: e.path, kind: 'late', copy: temp, error });
  return 'none';   // e is settled: its bytes wait in the new entry
}

// Temp folders no journal part names any more are removed once empty (a leftover probe file is deleted by content).
function removeSettledFolders(ctx: RunContext, folders: readonly string[]): void {
  const j = readJournal(ctx.paths.journal);
  const keep = new Set<string>();
  if (j !== 'none') {
    for (const t of j.move?.temps ?? []) keep.add(tempFolderOf(t.name));
    for (const e of j.settle ?? []) keep.add(tempFolderOf(e.name));
  }
  for (const f of folders) {
    if (keep.has(f)) continue;
    const dir = join(ctx.realDir, f);
    try {
      for (const n of readdirSync(dir)) {
        if (!n.startsWith('probe-')) continue;
        const text = readFileSync(join(dir, n), 'utf8');
        if (text === PROBE_ONE || text === PROBE_TWO) unlinkSync(join(dir, n));
      }
      rmdirSync(dir);
    } catch {
      // not empty (someone's file, or an orphan for P4), or gone
    }
  }
}

// P4 step 4: temp folders no journal mentions and that this process does not own (the state dir was wiped mid-move).
// A file that is a blob of HEAD's or origin/B's tree is in a commit and is unlinked; the rest is renamed whole to
// `recovered (conflict …)` at the top and registered local-only (its original is unknown: maybe an ignored secret).
export async function recoverOrphanTemps(ctx: RunContext): Promise<{ paths: string[]; count: number } | 'none'> {
  const j = readJournal(ctx.paths.journal);
  const mentioned = new Set<string>();
  if (j !== 'none') {
    for (const t of j.move?.temps ?? []) mentioned.add(tempFolderOf(t.name));
    for (const e of j.settle ?? []) mentioned.add(tempFolderOf(e.name));
  }
  let names: string[];
  try {
    names = readdirSync(ctx.realDir);
  } catch {
    return 'none';
  }
  const orphans = names.filter((n) => /^\.mdsync-\d+-\d+\.d$/.test(n) && n !== PROC_TEMP && !mentioned.has(n));
  if (orphans.length === 0) return 'none';
  const blobs = new Set<string>();
  for (const rev of ['HEAD', `refs/remotes/origin/${ctx.branch}`]) {
    if ((await revParse(ctx.git, rev)) === 'none') continue;
    for (const e of (await lsTree(ctx.git, rev)).values()) blobs.add(e.sha);
  }
  const files = (top: string): string[] => {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(ctx.realDir, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r);
        else out.push(r);
      }
    };
    walk(top);
    return out;
  };
  const kept: string[] = [];
  for (const n of orphans) {
    let list: string[];
    try {
      list = files(n);
    } catch {
      continue;
    }
    for (const f of list) {
      const abs = join(ctx.realDir, f);
      let bytes: Uint8Array;
      try {
        bytes = lstatSync(abs).isSymbolicLink() ? new TextEncoder().encode(readlinkSync(abs)) : readFileSync(abs);
      } catch {
        continue;
      }
      const text = new TextDecoder().decode(bytes);
      if (text === PROBE_ONE || text === PROBE_TWO || blobs.has(await writeBlob(ctx.git, bytes))) {
        try {
          unlinkSync(abs);
        } catch {
          // gone
        }
      }
    }
    try {
      rmdirSync(join(ctx.realDir, n));
      continue;   // nothing was left
    } catch {
      // something is left: kept, renamed
    }
    const namer = copyNamer(ctx, await knownPaths(ctx));
    const copy = namer('recovered');
    if (moveAside(ctx.realDir, n, copy) !== 'moved') continue;
    const left = files(copy);
    addLocalOnly(ctx.paths.localOnly, left);
    kept.push(...left);
  }
  return kept.length === 0 ? 'none' : { paths: kept, count: kept.length };
}

// The materialized checkout bytes of `rev:path`s (applyOps callers build their `want` versions with it).
export async function checkoutVersions(ctx: RunContext, rev: string, paths: readonly string[]): Promise<Map<string, Version>> {
  const tree = await lsTree(ctx.git, rev);
  const dir = join(ctx.paths.tmp, `versions-${process.pid}-${++workSeq}`);
  const files = await materialize(ctx, rev, paths.filter((p) => tree.has(p) && tree.get(p)?.mode !== GITLINK), dir);
  const out = new Map<string, Version>();
  for (const [p, f] of files) out.set(p, versionAt(f, tree.get(p)?.mode ?? '100644'));
  return out;
}

// A blob's checkout bytes at `path`, with `rev`'s attributes (applyOps callers).
export async function blobVersion(ctx: RunContext, rev: string, path: string, blob: string, mode: string): Promise<Version> {
  return smudge(ctx, rev, path, blob, mode, join(ctx.paths.tmp, `versions-${process.pid}-${++workSeq}`));
}

// The survey of one path for applyOps callers: what is there, and the blob git would store for it.
export async function surveyPath(ctx: RunContext, rev: string, path: string): Promise<{ seen: Seen; blob: string | 'none'; mode: string }> {
  const look = lookAt(ctx.realDir, path);
  if (look.kind === 'absent') return { seen: { kind: 'absent' }, blob: 'none', mode: '' };
  if (look.kind === 'dir' || look.kind === 'other') return { seen: { kind: look.kind }, blob: 'none', mode: '' };
  if (look.kind === 'symlink') {
    return { seen: look.digest, blob: await writeBlob(ctx.git, new TextEncoder().encode(look.target)), mode: SYMLINK };
  }
  const bytes = readBytes(ctx.realDir, path);
  if (bytes === 'gone') return { seen: { kind: 'absent' }, blob: 'none', mode: '' };
  const seen: Digest = { kind: 'file', size: bytes.length, sha256: sha256Hex(bytes) };
  return { seen, blob: await hashBytes(ctx, rev, path, bytes), mode: look.exec === 'exec' ? '100755' : '100644' };
}

