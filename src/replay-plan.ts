// Pure per-path replay planner, final-tree computation and data guard.
// No git; only `env.blocked` may touch the disk.
import type { IndexOp } from './commit';
import { foldCase, type NameLimit, nameLimitFor, nameLimitText, overlongSegments } from './conflict-name';
import type { TreeEntry } from './git';

export type Side = { mode: string; sha: string } | 'absent';
export type PathTriple = { path: string; base: Side; local: Side; remote: Side };
export type CopyReason = 'content' | 'binary' | 'error' | 'add-add' | 'type' | 'path-clash' | 'case-clash' | 'blocked';
export type Disposition =
  | { kind: 'take-local' }                                   // write local at path (or delete if local absent)
  | { kind: 'same' }                                         // local == remote already
  | { kind: 'merged'; sha: string; mode: string }            // merge-file exit 0; the merger already wrote the blob
  | { kind: 'conflict-copy'; copyPath: string; reason: CopyReason }
  | { kind: 'delete-overridden'; deletedBy: 'local' }        // local deleted, remote modified: keep remote
  | { kind: 'edit-restored'; deletedBy: 'remote' };          // local modified, remote deleted: write local
export type PlanEntry = { triple: PathTriple; disposition: Disposition };
export type Plan = { entries: PlanEntry[]; copies: string[]; unsupported: string[] };
export type Merger = (t: PathTriple) => Promise<{ kind: 'clean'; sha: string } | { kind: 'conflict'; reason: 'content' | 'binary' | 'error' }>;
export type NameCopy = (path: string) => string;            // memoized per path within a plan (one copy dir per clashing ancestor)
export type PlanEnv = { remote: Map<string, TreeEntry>; ignoreCase: 'case-insensitive' | 'case-sensitive'; blocked: (path: string) => boolean;
  nameLimit?: NameLimit };   // default: the local filesystem's (nameLimitFor(process.platform))
export type PlanOps = { ops: IndexOp[]; writes: string[]; deletes: string[]; copies: string[] };
export type GuardResult = { kind: 'pass' } | { kind: 'fail'; paths: string[]; reason: string };

const GITLINK = '160000';
const SYMLINK = '120000';

type Present = Exclude<Side, 'absent'>;
type Keyer = (p: string) => string;

function sideOf(e: TreeEntry | undefined): Side {
  return e === undefined ? 'absent' : { mode: e.mode, sha: e.sha };
}

function eq(a: Side, b: Side): boolean {
  if (a === 'absent' || b === 'absent') return a === b;
  return a.mode === b.mode && a.sha === b.sha;
}

// F holds TreeEntry values; compare mode+sha against a Side ('absent' = not in F).
function holds(f: Map<string, TreeEntry>, path: string, s: Side): boolean {
  return eq(sideOf(f.get(path)), s);
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function keyer(ignoreCase: PlanEnv['ignoreCase']): Keyer {
  return ignoreCase === 'case-insensitive' ? foldCase : (p) => p;
}

// 'a/b/c' -> ['a', 'a/b']
function dirPrefixes(p: string): string[] {
  const out: string[] = [];
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i));
  return out;
}

function setOp(path: string, s: Present): IndexOp {
  return { op: 'set', path, mode: s.mode, sha: s.sha };
}

function treeEntry(mode: string, sha: string): TreeEntry {
  return { mode, type: mode === GITLINK ? 'commit' : 'blob', sha };
}

export function changedTriples(base: Map<string, TreeEntry>, local: Map<string, TreeEntry>, remote: Map<string, TreeEntry>): PathTriple[] {
  const out: PathTriple[] = [];
  for (const path of new Set([...base.keys(), ...local.keys()])) {
    const b = sideOf(base.get(path));
    const l = sideOf(local.get(path));
    if (!eq(b, l)) out.push({ path, base: b, local: l, remote: sideOf(remote.get(path)) });
  }
  return out.sort((x, y) => byPath(x.path, y.path));
}

// A clean merge keeps local's mode change, else the remote mode. With no base (add/add) local changed nothing.
function mergedMode(t: PathTriple, local: Present, remote: Present): string {
  return t.base !== 'absent' && local.mode !== t.base.mode ? local.mode : remote.mode;
}

async function decide(t: PathTriple, merge: Merger, nameCopy: NameCopy): Promise<Disposition | 'unsupported'> {
  const { base, local, remote } = t;
  if (eq(base, remote)) return { kind: 'take-local' };                                                // row 1
  if (eq(local, remote)) return { kind: 'same' };                                                     // row 2
  // A gitlink (an embedded repo `add -A` committed) changed on both sides has no merge; one side only is rows 1-2.
  // Checking this first made any local-only gitlink stop every conflict replay, for good.
  if ([base, local, remote].some((s) => s !== 'absent' && s.mode === GITLINK)) return 'unsupported';  // row 0
  if (local !== 'absent' && remote !== 'absent') {                                                    // row 3
    if (local.mode === SYMLINK || remote.mode === SYMLINK) return { kind: 'conflict-copy', copyPath: nameCopy(t.path), reason: 'type' };
    const r = await merge(t);
    if (r.kind === 'clean') return { kind: 'merged', sha: r.sha, mode: mergedMode(t, local, remote) };
    const reason: CopyReason = base === 'absent' && r.reason === 'content' ? 'add-add' : r.reason;
    return { kind: 'conflict-copy', copyPath: nameCopy(t.path), reason };
  }
  if (local === 'absent') return { kind: 'delete-overridden', deletedBy: 'local' };                   // row 4
  return { kind: 'edit-restored', deletedBy: 'remote' };                                              // row 5
}

// A planned write of local content at the triple's own path (the only entries the clash pass inspects).
function isSet(e: PlanEntry): boolean {
  const k = e.disposition.kind;
  return (k === 'take-local' && e.triple.local !== 'absent') || k === 'merged' || k === 'edit-restored';
}

function entryOps(e: PlanEntry): IndexOp[] {
  const { triple: t, disposition: d } = e;
  switch (d.kind) {
    case 'take-local':
      return [t.local === 'absent' ? { op: 'remove', path: t.path } : setOp(t.path, t.local)];
    case 'merged':
      return [{ op: 'set', path: t.path, mode: d.mode, sha: d.sha }];
    case 'edit-restored':
    case 'conflict-copy': {
      if (t.local === 'absent') throw new Error(`replay plan: ${d.kind} at ${t.path} has no local side`);
      return [setOp(d.kind === 'conflict-copy' ? d.copyPath : t.path, t.local)];
    }
    case 'same':
    case 'delete-overridden':
      return [];
  }
}

function applyOps(base: Map<string, TreeEntry>, ops: readonly IndexOp[]): Map<string, TreeEntry> {
  const out = new Map(base);
  for (const op of ops) if (op.op === 'remove') out.delete(op.path);
  for (const op of ops) if (op.op === 'set') out.set(op.path, treeEntry(op.mode, op.sha));
  return out;
}

export function planOps(plan: Plan): PlanOps {
  const ops: IndexOp[] = [];
  const writes: string[] = [];
  const deletes: string[] = [];
  const copies: string[] = [];
  for (const e of plan.entries) {
    for (const op of entryOps(e)) {
      ops.push(op);
      (op.op === 'remove' ? deletes : writes).push(op.path);
      if (e.disposition.kind === 'conflict-copy') copies.push(op.path);
    }
  }
  return { ops, writes, deletes, copies };
}

export function finalMap(plan: Plan, base: Map<string, TreeEntry>): Map<string, TreeEntry> {
  return applyOps(base, planOps(plan).ops);
}

export function foldClashes(paths: Iterable<string>): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const p of paths) {
    const k = foldCase(p);
    const g = groups.get(k);
    if (g) g.add(p);
    else groups.set(k, new Set([p]));
  }
  return [...groups.values()]
    .filter((g) => g.size >= 2)
    .map((g) => [...g].sort(byPath))
    .sort((a, b) => byPath(a[0] ?? '', b[0] ?? ''));
}

// Keys of F for the clash pass: files per key, and every proper directory prefix (as a key).
type FIndex = { files: Map<string, number>; dirs: Set<string> };

function indexF(f: Map<string, TreeEntry>, key: Keyer): FIndex {
  const files = new Map<string, number>();
  const dirs = new Set<string>();
  for (const p of f.keys()) {
    const k = key(p);
    files.set(k, (files.get(k) ?? 0) + 1);
    for (const d of dirPrefixes(p)) dirs.add(key(d));
  }
  return { files, dirs };
}

// (a)–(d) for a planned set at p. "The remote side keeps the original path": a set at a path the remote
// tree already has never causes a D/F or case clash, because the other path is new and is the one moved
// (if both are remote paths, it is a remote-side duplicate mdsync can't fix). `blocked` applies regardless.
function clashOf(p: string, f: FIndex, env: PlanEnv, key: Keyer, nameCopy: NameCopy): { copyPath: string; reason: CopyReason } | 'none' {
  if (!env.remote.has(p)) {
    for (const a of dirPrefixes(p)) {                                                           // (a)
      if (f.files.has(key(a))) return { copyPath: nameCopy(a) + p.slice(a.length), reason: 'path-clash' };
    }
    if (f.dirs.has(key(p))) return { copyPath: nameCopy(p), reason: 'path-clash' };             // (b)
    if (env.ignoreCase === 'case-insensitive' && (f.files.get(key(p)) ?? 0) >= 2) {             // (c)
      return { copyPath: nameCopy(p), reason: 'case-clash' };
    }
  }
  if (env.blocked(p)) return { copyPath: nameCopy(p), reason: 'blocked' };                      // (d)
  return 'none';
}

function copiesOf(entries: readonly PlanEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) if (e.disposition.kind === 'conflict-copy') out.push(e.disposition.copyPath);
  return out;
}

export async function buildPlan(triples: PathTriple[], merge: Merger, nameCopy: NameCopy, env: PlanEnv): Promise<Plan> {
  const memo = new Map<string, string>();
  const named: NameCopy = (p) => {
    let c = memo.get(p);
    if (c === undefined) memo.set(p, (c = nameCopy(p)));
    return c;
  };
  const blockedMemo = new Map<string, 'blocked' | 'free'>();
  const planEnv: PlanEnv = { ...env, blocked: (p) => {
    let b = blockedMemo.get(p);
    if (b === undefined) blockedMemo.set(p, (b = env.blocked(p) ? 'blocked' : 'free'));
    return b === 'blocked';
  } };
  const entries: PlanEntry[] = [];
  const unsupported: string[] = [];
  for (const triple of triples) {   // sequential: each merge may spawn git
    const d = await decide(triple, merge, named);
    if (d === 'unsupported') unsupported.push(triple.path);
    else entries.push({ triple, disposition: d });
  }

  // Clash pass: every pass converts at least one set and nothing becomes a set again, so this terminates.
  const key = keyer(env.ignoreCase);
  for (;;) {
    const f = indexF(applyOps(env.remote, entries.flatMap(entryOps)), key);
    let converted = 0;
    entries.forEach((e, i) => {
      if (!isSet(e)) return;
      const c = clashOf(e.triple.path, f, planEnv, key, named);
      if (c === 'none') return;
      entries[i] = { triple: e.triple, disposition: { kind: 'conflict-copy', copyPath: c.copyPath, reason: c.reason } };
      converted++;
    });
    if (converted === 0) break;
  }
  return { entries, copies: copiesOf(entries), unsupported };
}

function fail(paths: Iterable<string>, reason: string): GuardResult {
  return { kind: 'fail', paths: [...new Set(paths)].sort(byPath), reason };
}

// The disposition is one the per-path rules allow for this triple: nothing from either side is dropped.
function dispositionValid(e: PlanEntry): boolean {
  const { triple: t, disposition: d } = e;
  const { base, local, remote } = t;
  switch (d.kind) {
    case 'take-local':
      return eq(base, remote);                                  // remote unchanged: writing local loses nothing
    case 'same':
      return eq(local, remote);
    case 'merged':
      return local !== 'absent' && remote !== 'absent' && local.mode !== SYMLINK && remote.mode !== SYMLINK
        && d.mode === mergedMode(t, local, remote);
    case 'conflict-copy':
      return local !== 'absent' && d.copyPath !== '' && d.copyPath !== t.path;
    case 'delete-overridden':
      return local === 'absent' && remote !== 'absent';
    case 'edit-restored':
      return local !== 'absent' && remote === 'absent';
  }
}

export function dataGuard(triples: PathTriple[], plan: Plan, env: PlanEnv): GuardResult {
  if (plan.unsupported.length > 0) return fail(plan.unsupported, 'unsupported entry (gitlink)');

  // Every triple has exactly one entry, and that entry is for the same triple.
  const byTriple = new Map<string, PathTriple>();
  const dupTriples: string[] = [];
  for (const t of triples) {
    if (byTriple.has(t.path)) dupTriples.push(t.path);
    else byTriple.set(t.path, t);
  }
  if (dupTriples.length > 0) return fail(dupTriples, 'duplicate changed path');
  const covered = new Set<string>();
  const coverage: string[] = [];
  for (const e of plan.entries) {
    const t = byTriple.get(e.triple.path);
    const same = t !== undefined && eq(t.base, e.triple.base) && eq(t.local, e.triple.local) && eq(t.remote, e.triple.remote);
    if (!same || covered.has(e.triple.path)) coverage.push(e.triple.path);
    covered.add(e.triple.path);
  }
  for (const p of byTriple.keys()) if (!covered.has(p)) coverage.push(p);
  if (coverage.length > 0) return fail(coverage, 'plan does not cover every changed path exactly once');

  // The triples must describe env.remote, or "remote kept" below would check the wrong remote.
  const stale = triples.filter((t) => !eq(t.remote, sideOf(env.remote.get(t.path)))).map((t) => t.path);
  if (stale.length > 0) return fail(stale, 'changed path does not match the remote tree');

  const invalid = plan.entries.filter((e) => !dispositionValid(e)).map((e) => e.triple.path);
  if (invalid.length > 0) return fail(invalid, 'disposition does not account for both sides');

  // Conflict copies: unique, and never on a changed or remote path.
  const copies = copiesOf(plan.entries);
  if (copies.length !== plan.copies.length || copies.some((c, i) => plan.copies[i] !== c)) {
    return fail([...copies, ...plan.copies], 'plan copies do not match its conflict-copy entries');
  }
  const seenCopies = new Set<string>();
  const badCopies: string[] = [];
  for (const c of copies) {
    if (seenCopies.has(c) || byTriple.has(c) || env.remote.has(c)) badCopies.push(c);
    seenCopies.add(c);
  }
  if (badCopies.length > 0) return fail(badCopies, 'conflict copy path is not unique or overwrites a changed or remote path');

  const f = finalMap(plan, env.remote);

  // Every path the plan adds must be creatable here: a name over the filesystem's limit makes `reset --hard` fail
  // partway, after it has rewritten the rest of the worktree. The limit is this filesystem's own: a 90-character
  // Japanese note title is a legal Mac name, and refusing it stopped every later conflict replay on that Mac.
  const limit = env.nameLimit ?? nameLimitFor(process.platform);
  const tooLong = [...f.keys()].filter((p) => !env.remote.has(p) && overlongSegments(p, limit).length > 0);
  if (tooLong.length > 0) return fail(tooLong, `path segment longer than ${nameLimitText(limit)}`);

  // Local side accounted for: written as-is at its path or its copy, merged, equal to remote, or a deletion
  // that policy overrides. Remote side kept wherever the disposition keeps it.
  const localLost: string[] = [];
  const remoteLost: string[] = [];
  for (const { triple: t, disposition: d } of plan.entries) {
    switch (d.kind) {
      case 'take-local':
      case 'edit-restored':
        if (!holds(f, t.path, t.local)) localLost.push(t.path);
        break;
      case 'merged':
        if (!holds(f, t.path, { mode: d.mode, sha: d.sha })) localLost.push(t.path);
        break;
      case 'conflict-copy':
        if (!holds(f, d.copyPath, t.local)) localLost.push(t.path);
        if (!holds(f, t.path, t.remote)) remoteLost.push(t.path);
        break;
      case 'same':
      case 'delete-overridden':
        if (!holds(f, t.path, t.remote)) remoteLost.push(t.path);
        break;
    }
  }
  if (localLost.length > 0) return fail(localLost, 'local side missing from the final tree');
  for (const [p, r] of env.remote) {
    if (byTriple.has(p)) continue;
    const got = f.get(p);
    if (got === undefined || got.mode !== r.mode || got.sha !== r.sha || got.type !== r.type) remoteLost.push(p);
  }
  if (remoteLost.length > 0) return fail(remoteLost, 'remote side not kept in the final tree');

  // Representable: no file at a directory prefix of another path, exactly or (case-insensitive) by fold.
  // Under case-insensitivity a clash between two paths the remote tree already has is tolerated.
  const dfExact: string[] = [];
  for (const p of f.keys()) for (const d of dirPrefixes(p)) if (f.has(d)) dfExact.push(d, p);
  if (dfExact.length > 0) return fail(dfExact, 'file/directory clash in the final tree');
  if (env.ignoreCase === 'case-insensitive') {
    const fileByFold = new Map<string, string[]>();
    for (const p of f.keys()) {
      const k = foldCase(p);
      const g = fileByFold.get(k);
      if (g) g.push(p);
      else fileByFold.set(k, [p]);
    }
    const dfFold: string[] = [];
    for (const p of f.keys()) {
      for (const d of dirPrefixes(p)) {
        for (const file of fileByFold.get(foldCase(d)) ?? []) {
          if (!(env.remote.has(file) && env.remote.has(p))) dfFold.push(file, p);
        }
      }
    }
    if (dfFold.length > 0) return fail(dfFold, 'file/directory case clash in the final tree');
    const caseDup = foldClashes(f.keys()).filter((g) => g.some((p) => !env.remote.has(p))).flat();
    if (caseDup.length > 0) return fail(caseDup, 'case clash in the final tree');
  }
  return { kind: 'pass' };
}
