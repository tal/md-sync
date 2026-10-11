// Legacy rescue producer used only to construct recovery fixtures. Current mdsync never saves rescues.
// Retain the old classification here so tests can create the files an interrupted older version left behind.
import { lstatSync, readFileSync } from 'node:fs';
import { mkdir, readlink, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { foldCase } from '../../src/conflict-name';
import type { RunContext } from '../../src/context';
import { errCode, type FsKind, kindAt, properPrefixes } from '../../src/fsutil';
import { hashPaths, headSha, indexEntries, lsTree, parseNul, type TreeEntry, unmergedStages } from '../../src/git';
import { repoIdentity, type RescueEntry, type RescueManifest, type RescueReason } from '../../src/rescue';

export type UnmergedPolicy = { kind: 'skip' } | { kind: 'edited-since'; refMtimeMs: number | 'none' };
export type RescueOptions = {
  scope: 'full' | 'untracked-only';     // 'untracked-only': skip the tracked-dirty row (autostash or a stash covers it)
  unmerged: UnmergedPolicy;
  owner: 'journal' | 'standalone';      // 'journal': restored by journal resume, not standalone recovery
  exceptTree?: string;                  // skip tracked-dirty entries whose current blob equals this tree's entry
  gitWrote?: readonly string[];         // the same for trees git itself may have checked out (part of): a rebase that
                                        //   stopped or failed mid-checkout leaves their content (or their absence)
                                        //   on disk, which is not an edit
  opWork?: OpWork;                      // content staged or committed during an interrupted op
};
// What an interrupted op's --abort would discard beyond unstaged edits: entries staged during the stop (a
// hand-resolved conflict, a `git add`ed note) and files committed during it (a `commit --amend` at an `edit` stop).
export type OpWork = {
  target: string;                       // the commit the abort resets to (rebase: orig-head; cherry-pick/revert: the
                                        //   sequence start, else HEAD)
  reproducible: readonly OpTree[];      // content the op itself writes (rebase: onto and the simulated clean replay of
                                        //   every pick so far; merge: MERGE_HEAD and its merge-tree result;
                                        //   cherry-pick/revert: the source and the paths the in-flight pick changes)
  refMtimeMs: number | 'none';          // uncommitted git output is not newer than this; 'none': keep all
};
// A tree or commit, and the paths of it that count ('all', or only the paths a pick changes: the rest of a pick's
// result is whatever HEAD held, which may be someone's work).
export type OpTree = { rev: string; paths: 'all' | readonly string[] };

const MANIFEST = 'manifest.json';
const GITLINK = '160000';
const MARKER_RE = /^<{7}( |$)/m;
const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');

type Kind = FsKind;
type Row = 'tracked-dirty' | 'op-work' | 'type-change' | 'unmerged' | 'at-risk' | 'shadowed';
type Planned = { path: string; base: string | 'none'; restore: RescueEntry['restore']; shadowRoot?: string;
  what: 'file' | 'deleted'; row: Row };

function mtimeAt(abs: string): number {
  try {
    return lstatSync(abs).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;   // vanished: let the save step decide
  }
}

function sha256(b: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(b).digest('hex');
}

let idSeq = 0;

async function makeRescueDir(ctx: RunContext): Promise<{ id: string; dir: string }> {
  await mkdir(ctx.paths.rescue, { recursive: true, mode: 0o700 });
  for (;;) {
    const id = `${ctx.clock.now()}-${process.pid}-${++idSeq}`;
    const dir = join(ctx.paths.rescue, id);
    try {
      await mkdir(dir, { mode: 0o700 });
      return { id, dir };
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
    }
  }
}

async function untrackedUnder(ctx: RunContext, dir: string): Promise<string[]> {
  // --others without excludes lists ignored files too; 'sub/' entries (nested repos) are left alone
  return parseNul(await ctx.git.ok(['ls-files', '-z', '--others', '--', `:(literal)${dir}/`]))
    .filter((p) => !p.endsWith('/'));
}

async function readSaved(abs: string, kind: 'file' | 'symlink'): Promise<Uint8Array> {
  return kind === 'symlink' ? enc.encode(await readlink(abs)) : Bun.file(abs).bytes();
}

export async function saveLegacyRescue(ctx: RunContext, reason: RescueReason, atRiskTrees: readonly string[],
  o: RescueOptions): Promise<RescueManifest | 'nothing'> {
  const g = ctx.git;
  const abs = (p: string): string => join(ctx.realDir, p);
  const kinds = new Map<string, Kind>();   // planning only: many tree paths share the same parent dirs
  const kind = (p: string): Kind => {
    let k = kinds.get(p);
    if (k === undefined) {
      k = kindAt(abs(p));
      kinds.set(p, k);
    }
    return k;
  };
  const index = await indexEntries(g);
  const stages = await unmergedStages(g);
  const head = await headSha(g);
  const atRisk: Map<string, TreeEntry>[] = [];
  for (const t of atRiskTrees) atRisk.push(await lsTree(g, t));
  const headTree = head === 'unborn' ? new Map<string, TreeEntry>() : await lsTree(g, head);

  const blobPaths = new Set<string>();
  for (const [p, e] of index) if (e.mode !== GITLINK) blobPaths.add(p);
  for (const t of [headTree, ...atRisk]) for (const [p, e] of t) if (e.type === 'blob') blobPaths.add(p);
  const stage0 = (p: string): string | 'none' => {
    const e = index.get(p);
    return e !== undefined && e.stage === 0 ? e.sha : 'none';
  };

  const planned = new Map<string, Planned>();
  const add = (e: Planned): void => {
    if (!planned.has(e.path)) planned.set(e.path, e);
  };

  // shadowed: untracked files under a folder that git knows as a file (outermost folder wins)
  for (const p of [...blobPaths].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))) {
    if (kind(p) !== 'dir') continue;
    for (const f of await untrackedUnder(ctx, p)) add({ path: f, base: 'none', restore: 'shadowed', shadowRoot: p, what: 'file', row: 'shadowed' });
  }

  // unmerged: only edits made after git's own conflict output
  if (o.unmerged.kind === 'edited-since') {
    const ref = o.unmerged.refMtimeMs;
    const present = [...stages.keys()].filter((p) => {
      const k = kind(p);
      return k === 'file' || k === 'symlink';
    });
    const blobs = await hashPaths(g, present);
    for (const p of present) {
      let mtime: number;
      try {
        mtime = lstatSync(abs(p)).mtimeMs;
      } catch {
        continue;
      }
      let since: 'edited-since' | 'resolved-by-hand' | 'git-output' = 'git-output';
      if (ref !== 'none' && mtime > ref) {
        since = 'edited-since';
      } else {
        const cur = blobs.get(p);
        const marker: 'marked' | 'unmarked' = kind(p) === 'file' && MARKER_RE.test(latin1.decode(readFileSync(abs(p))))
          ? 'marked' : 'unmarked';
        if (marker === 'unmarked' && cur !== undefined && !(stages.get(p) ?? []).includes(cur)) since = 'resolved-by-hand';
      }
      if (since !== 'git-output') add({ path: p, base: 'none', restore: 'copy-always', what: 'file', row: 'unmerged' });
    }
  }

  // type-change: a tracked file replaced by a folder
  const typeChanged = new Set<string>();
  for (const [p, e] of index) {
    if (e.mode === GITLINK || kind(p) !== 'dir') continue;
    typeChanged.add(p);
    add({ path: p, base: stage0(p), restore: 'auto', what: 'deleted', row: 'type-change' });
  }

  // tracked-dirty (full scope only)
  if (o.scope === 'full') {
    const listed = parseNul(await g.ok(['diff-files', '-z', '--name-only']))
      .filter((p) => !stages.has(p) && !typeChanged.has(p));
    const candidates = [...new Set(listed)];
    const cur = await hashPaths(g, candidates);
    const excepts: Map<string, TreeEntry>[] = [];
    for (const t of [...(o.exceptTree !== undefined ? [o.exceptTree] : []), ...(o.gitWrote ?? [])]) excepts.push(await lsTree(g, t));
    for (const p of candidates) {
      const k = kind(p);
      if (k === 'dir') continue;
      const blob = cur.get(p);   // undefined: missing
      if (k !== 'missing' && blob !== undefined && blob === stage0(p)) continue;   // stat-only change
      if (excepts.some((e) => blob === e.get(p)?.sha)) continue;                     // also both absent
      add({ path: p, base: stage0(p), restore: 'auto', what: k === 'missing' ? 'deleted' : 'file', row: 'tracked-dirty' });
    }
  }

  // op-work (full scope): files whose content differs from the abort target in the index or HEAD, written after
  // git stopped. Their bytes would exist nowhere after the abort (an amended commit only in the reflog).
  if (o.scope === 'full' && o.opWork !== undefined) {
    const w = o.opWork;
    const listed = parseNul(await g.ok(['diff-index', '--cached', '-z', '--name-only', '--no-renames', w.target, '--']))
      .filter((p) => !stages.has(p) && !typeChanged.has(p) && !planned.has(p));
    const target = await lsTree(g, w.target);
    const known = [target];
    for (const r of w.reproducible) {
      const t = await lsTree(g, r.rev);
      if (r.paths !== 'all') {
        const keep = new Set(r.paths);
        for (const p of [...t.keys()]) if (!keep.has(p)) t.delete(p);
      }
      known.push(t);
    }
    const cur = await hashPaths(g, listed);
    for (const p of listed) {
      const blob = cur.get(p);
      // a deletion or a folder leaves no bytes to lose; a version the abort or the op brings back is not unique
      if (blob === undefined || kind(p) === 'dir' || known.some((t) => t.get(p)?.sha === blob)) continue;
      // The mtime rule (git's own output predates the stop) holds for what is only staged or on disk. Content the op
      // committed (a hand resolution at an earlier stop, an amend at an `edit` stop) was written before the latest
      // stop too, so it is decided by content alone: not in any tree git writes for the op means someone wrote it.
      const origin: 'committed-by-op' | 'uncommitted' = headTree.get(p)?.sha === blob ? 'committed-by-op' : 'uncommitted';
      if (origin === 'uncommitted' && w.refMtimeMs !== 'none' && mtimeAt(abs(p)) <= w.refMtimeMs) continue;
      const at = target.get(p)?.sha;
      if (at === undefined) add({ path: p, base: 'none', restore: 'auto', what: 'file', row: 'op-work' });
      // made on top of the version the abort restores: back in place as an uncommitted edit; otherwise a copy
      else if (headTree.get(p)?.sha === at) add({ path: p, base: at, restore: 'auto', what: 'file', row: 'op-work' });
      else add({ path: p, base: 'none', restore: 'copy-always', what: 'file', row: 'op-work' });
    }
  }

  // at-risk untracked: files at paths the op will write (and files sitting where it needs a folder). On a
  // case-insensitive FS a path reached through another spelling (or Unicode normalization) of a tracked path is that
  // tracked file, not an untracked one: its bytes are committed or covered by the tracked-dirty row.
  const foldedIndex = ctx.ignoreCase === 'case-insensitive' ? new Set([...index.keys()].map(foldCase)) : undefined;
  const tracked = (q: string): boolean => index.has(q) || (foldedIndex !== undefined && foldedIndex.has(foldCase(q)));
  for (const t of atRisk) {
    for (const [p, e] of t) {
      if (e.type !== 'blob') continue;
      for (const q of [...properPrefixes(p), p]) {
        if (tracked(q)) continue;
        const k = kind(q);
        if (k === 'file' || k === 'symlink') add({ path: q, base: 'none', restore: 'auto', what: 'file', row: 'at-risk' });
        if (k !== 'dir') break;
      }
    }
  }

  if (planned.size === 0) return 'nothing';

  const { id, dir } = await makeRescueDir(ctx);
  try {
    const entries: RescueEntry[] = [];
    let n = 0;
    for (const e of [...planned.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const meta: Omit<RescueEntry, 'saved'> = { path: e.path, base: e.base, restore: e.restore,
        ...(e.shadowRoot !== undefined ? { shadowRoot: e.shadowRoot } : {}) };
      if (e.what === 'deleted') {
        entries.push({ ...meta, saved: { kind: 'deleted' } });
        continue;
      }
      const k = kindAt(abs(e.path));
      let bytes: Uint8Array;
      try {
        if (k !== 'file' && k !== 'symlink') throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
        bytes = await readSaved(abs(e.path), k);
      } catch (err) {
        const code = errCode(err);
        if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENOTDIR' && code !== 'EINVAL') throw err;
        // gone between listing and reading: a tracked file is now a deletion; anything else has nothing to save
        if (e.row === 'tracked-dirty' && k === 'missing') entries.push({ ...meta, saved: { kind: 'deleted' } });
        continue;
      }
      const file = `${n++}.bin`;
      await Bun.write(join(dir, file), bytes);
      entries.push({ ...meta, saved: { kind: 'file', file, rawSha256: sha256(bytes),
        symlink: k === 'symlink' ? 'symlink' : 'regular' } });
    }
    if (entries.length === 0) {
      await rm(dir, { recursive: true, force: true });
      return 'nothing';
    }
    const manifest: RescueManifest = { id, reason, owner: o.owner, createdAt: new Date(ctx.clock.now()).toISOString(),
      repo: await repoIdentity(ctx), entries };
    const tmp = join(dir, `${MANIFEST}.tmp`);
    await Bun.write(tmp, JSON.stringify(manifest, null, 2) + '\n');
    await rename(tmp, join(dir, MANIFEST));
    return manifest;
  } catch (e) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

