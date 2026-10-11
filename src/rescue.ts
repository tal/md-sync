// Restore legacy rescue manifests left by older versions. Current worktree moves use their own journal.
// Saved bytes live in <hash>.rescue/<id>/ outside the repo; incomplete manifests are discarded.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunContext } from './context';
import { isRecord, kindAt } from './fsutil';
import { hashPaths, headSha, indexEntries, lsTree, parseNul } from './git';
import { validateRelPath } from './ipc';
import type { StatePaths } from './paths';
import { type Digest, digestAt, sha256Hex, type Version } from './cas';
import { applyOps, clearMovePart, copyNamer, type CopyNamer, type WorktreeOp } from './move';
import { addLocalOnly, type MoveJournal, mutateJournal } from './state';

export type RescueReason = 'rebase-abort' | 'am-abort' | 'merge-abort' | 'cherry-pick-abort' | 'revert-abort'
                         | 'rebase' | 'checkout' | 'rebase-conflict' | 'stash-replay' | 'unmerged-recovery';
export type RescueEntry = {
  path: string;
  base: string | 'none';               // index stage-0 blob sha at save time ('none': untracked or unmerged)
  restore: 'auto' | 'copy-always' | 'shadowed';
  shadowRoot?: string;                 // 'shadowed': the folder path that is a blob/symlink in git
  saved: { kind: 'file'; file: string /* <n>.bin */; rawSha256: string; symlink: 'symlink' | 'regular' } | { kind: 'deleted' };
};
export type RescueManifest = { id: string; reason: RescueReason; owner: 'journal' | 'standalone'; createdAt: string;
  repo: string | 'unknown';            // repoIdentity() at save time; 'unknown' in manifests from older versions
  entries: RescueEntry[] };
export type RescueRestore = { restored: string[]; copies: string[]; reDeleted: string[]; overridden: string[] };

const MANIFEST = 'manifest.json';
const enc = new TextEncoder();


const repoIds = new WeakMap<RunContext, string>();

// The clone a manifest belongs to: its root commit(s). The state hash keys on the folder path only, and in a
// container that path is always /data, so a shared or reused state volume can hold another repo's rescues; they
// must never be restored (and then committed) here. 'unknown' (unborn HEAD) matches anything.
export async function repoIdentity(ctx: RunContext): Promise<string | 'unknown'> {
  const hit = repoIds.get(ctx);
  if (hit !== undefined) return hit;
  const r = await ctx.git.run(['rev-list', '--max-parents=0', 'HEAD', '--']);
  const roots = r.code === 0 ? r.stdout.split('\n').filter((l) => l !== '').sort() : [];
  if (roots.length === 0) return 'unknown';
  const id = roots.join(',');
  repoIds.set(ctx, id);
  return id;
}

async function readSaved(abs: string, kind: 'file' | 'symlink'): Promise<Uint8Array> {
  return kind === 'symlink' ? enc.encode(await readlink(abs)) : Bun.file(abs).bytes();
}

type Current = { kind: 'missing' } | { kind: 'dir' } | { kind: 'file' | 'symlink'; raw: string };

async function currentAt(abs: string): Promise<Current> {
  const k = kindAt(abs);
  if (k === 'missing' || k === 'dir') return { kind: k };
  try {
    return { kind: k, raw: sha256Hex(await readSaved(abs, k)) };
  } catch {
    return { kind: 'missing' };
  }
}

function sameAsSaved(cur: Current, saved: Extract<RescueEntry['saved'], { kind: 'file' }>): boolean {
  if (cur.kind !== 'file' && cur.kind !== 'symlink') return false;
  return cur.raw === saved.rawSha256 && (cur.kind === 'symlink') === (saved.symlink === 'symlink');
}

// A copy whose original (or own name) is gitignored or matches `ignore` now is local-only for good: recorded,
// so it stays local even after the original becomes tracked. On doubt (check-ignore failed) it stays local too.
async function registerLocalOnly(ctx: RunContext, copyOf: ReadonlyMap<string, string>): Promise<void> {
  if (copyOf.size === 0) return;
  const probe = [...new Set([...copyOf.keys(), ...copyOf.values()])];
  const r = await ctx.git.run(['check-ignore', '-z', '--stdin'], { input: probe.map((p) => `${p}\0`).join('') });
  const ignored: Set<string> | 'unknown' = r.code === 0 ? new Set(parseNul(r.stdout)) : r.code === 1 ? new Set() : 'unknown';
  const local = [...copyOf].filter(([copy, orig]) => ignored === 'unknown' || ignored.has(copy) || ignored.has(orig)
    || ctx.ignore.matches(copy) || ctx.ignore.matches(orig)).map(([copy]) => copy);
  addLocalOnly(ctx.paths.localOnly, local);
}

const ORDER: Record<string, number> = { deleted: 0, auto: 1, 'copy-always': 2, shadowed: 3 };

function orderOf(e: RescueEntry): number {
  return e.saved.kind === 'deleted' ? ORDER.deleted! : ORDER[e.restore]!;
}

function savedVersion(dir: string, saved: Extract<RescueEntry['saved'], { kind: 'file' }>): Version {
  if (saved.symlink === 'symlink') return { kind: 'symlink', target: readFileSync(join(dir, saved.file), 'utf8') };
  return { kind: 'file', src: join(dir, saved.file), exec: 'plain' };
}

// Every restore write is a checked put: in place only while the path still holds exactly the bytes the
// row classified (or nothing), and a copy only where nothing is. A path that changed in between gets a copy instead.
async function applyRestore(ctx: RunContext, ops: readonly WorktreeOp[]): Promise<{ skipped: string[] }> {
  if (ops.length === 0) return { skipped: [] };
  const h = await headSha(ctx.git);
  const head = { sha: h, ref: 'detached' as const };
  const base = h === 'unborn' ? ctx.emptyTree : h;
  const j: MoveJournal = { op: 'move', reason: 'rescue-restore', phase: 'writing', from: h === 'unborn' ? 'empty' : h, head, to: base,
    base, ref: { kind: 'none' }, index: 'changed-paths', temps: [], copies: [], startedAt: new Date(ctx.clock.now()).toISOString() };
  mutateJournal(ctx.paths.journal, (cur) => ({ ...cur, move: j }));
  const a = await applyOps(ctx, ops, j, { onChanged: 'skip' });
  if (a.kind !== 'applied') {
    clearMovePart(ctx, a.asides ?? []);
    throw new Error(`restoring a rescue failed: ${a.error}`);
  }
  clearMovePart(ctx, a.asides);
  return { skipped: a.skipped };
}

export async function rescueRestore(ctx: RunContext, m: RescueManifest): Promise<RescueRestore> {
  const g = ctx.git;
  const dir = join(ctx.paths.rescue, m.id);
  const abs = (p: string): string => join(ctx.realDir, p);
  const out: RescueRestore = { restored: [], copies: [], reDeleted: [], overridden: [] };

  const here = await repoIdentity(ctx);
  if (m.repo !== 'unknown' && here !== 'unknown' && m.repo !== here) {
    // Saved for another repository: left on disk untouched, never written into this one.
    ctx.log.warn('rescue skipped', { id: m.id, reason: 'other-repo', path: dir });
    return out;
  }

  let namer: CopyNamer | undefined;
  const copyDest = async (p: string): Promise<string> => {
    if (namer === undefined) {
      const head = await headSha(g);
      const known = new Set<string>((await indexEntries(g)).keys());
      if (head !== 'unborn') for (const p2 of (await lsTree(g, head)).keys()) known.add(p2);
      namer = copyNamer(ctx, known);
    }
    return namer(p);
  };
  const curBlob = async (p: string): Promise<string | 'missing'> => (await hashPaths(g, [p])).get(p) ?? 'missing';
  const copyOf = new Map<string, string>();   // copy -> the path it was saved from

  const inPlace: WorktreeOp[] = [];
  const inPlaceEntries = new Map<string, RescueEntry>();
  const deletes: WorktreeOp[] = [];
  const copies: { op: WorktreeOp; dest: string; path: string }[] = [];
  const entries = [...m.entries].sort((a, b) => orderOf(a) - orderOf(b));
  // the deleted rows first: a shadowed note goes back in place only once the file at its folder's path is gone
  for (const e of entries) {
    if (e.saved.kind !== 'deleted') continue;
    const k = kindAt(abs(e.path));
    if (k === 'missing' || k === 'dir') continue;   // still deleted (a folder there is someone's new content)
    if (e.base !== 'none' && (await curBlob(e.path)) === e.base) {
      deletes.push({ op: 'put', path: e.path, expect: digestAt(ctx.realDir, e.path) as Digest, want: { kind: 'absent' } });
    } else {
      out.overridden.push(e.path);
      ctx.log.info('delete overridden', { path: e.path, deletedBy: 'local' });
    }
  }
  const del = await applyRestore(ctx, deletes);
  for (const op of deletes) if (!del.skipped.includes(op.path)) out.reDeleted.push(op.path);
  for (const p of del.skipped) out.overridden.push(p);

  for (const e of entries) {
    if (e.saved.kind === 'deleted') continue;
    const saved = e.saved;
    const cur = await currentAt(abs(e.path));
    if (sameAsSaved(cur, saved)) continue;
    const want = savedVersion(dir, saved);

    let target: 'in-place' | 'copy' = 'copy';
    if (e.restore === 'auto') {
      if (e.base !== 'none' && cur.kind !== 'missing' && cur.kind !== 'dir' && (await curBlob(e.path)) === e.base) target = 'in-place';
      else if (e.base === 'none' && cur.kind === 'missing') target = 'in-place';
    } else if (e.restore === 'shadowed') {
      const root = kindAt(abs(e.shadowRoot ?? e.path));
      if ((root === 'dir' || root === 'missing') && cur.kind === 'missing') target = 'in-place';
    }
    if (target === 'in-place') {
      const seen = digestAt(ctx.realDir, e.path);
      if (seen.kind !== 'dir' && seen.kind !== 'other') {
        inPlace.push({ op: 'put', path: e.path, expect: seen, want });
        inPlaceEntries.set(e.path, e);
        continue;
      }
    }
    const dest = await copyDest(e.path);
    copies.push({ op: { op: 'put', path: dest, expect: { kind: 'absent' }, want }, dest, path: e.path });
  }

  const put = await applyRestore(ctx, inPlace);
  for (const op of inPlace) {
    if (!put.skipped.includes(op.path)) {
      out.restored.push(op.path);
      continue;
    }
    // changed since it was classified (or a file now sits where a folder is needed): a copy instead
    const e = inPlaceEntries.get(op.path);
    if (e === undefined || e.saved.kind !== 'file') continue;
    const dest = await copyDest(e.path);
    copies.push({ op: { op: 'put', path: dest, expect: { kind: 'absent' }, want: savedVersion(dir, e.saved) }, dest, path: e.path });
  }
  const cp = await applyRestore(ctx, copies.map((c) => c.op));
  for (const c of copies) {
    if (cp.skipped.includes(c.dest)) continue;
    out.copies.push(c.dest);
    copyOf.set(c.dest, c.path);
  }

  await registerLocalOnly(ctx, copyOf);
  await rm(dir, { recursive: true, force: true });
  if (out.restored.length + out.copies.length + out.reDeleted.length + out.overridden.length > 0) {
    ctx.log.warn('rescued files', { reason: m.reason, ...out });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// pending

const REASONS: readonly string[] = ['rebase-abort', 'am-abort', 'merge-abort', 'cherry-pick-abort', 'revert-abort',
  'rebase', 'checkout', 'rebase-conflict', 'stash-replay', 'unmerged-recovery'];

// Paths are repo-relative, as git listed them: never absolute, '..', '.git' or empty segments. A manifest is restored
// by joining them to the folder, so anything else could write outside it.
function validEntry(v: unknown): v is RescueEntry {
  if (!isRecord(v) || typeof v.path !== 'string' || typeof v.base !== 'string') return false;
  if (validateRelPath(v.path) !== 'ok') return false;
  if (v.restore !== 'auto' && v.restore !== 'copy-always' && v.restore !== 'shadowed') return false;
  if (v.shadowRoot !== undefined && (typeof v.shadowRoot !== 'string' || validateRelPath(v.shadowRoot) !== 'ok')) return false;
  const s = v.saved;
  if (!isRecord(s)) return false;
  if (s.kind === 'deleted') return true;
  return s.kind === 'file' && typeof s.file === 'string' && /^\d+\.bin$/.test(s.file) && typeof s.rawSha256 === 'string'
    && (s.symlink === 'symlink' || s.symlink === 'regular');
}

function readManifest(dir: string, id: string): RescueManifest | 'invalid' {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
  } catch {
    return 'invalid';
  }
  if (!isRecord(v) || v.id !== id || !REASONS.includes(String(v.reason)) || typeof v.createdAt !== 'string'
    || (v.owner !== 'journal' && v.owner !== 'standalone') || !Array.isArray(v.entries) || !v.entries.every(validEntry)
    || (v.repo !== undefined && typeof v.repo !== 'string')) {
    return 'invalid';
  }
  return { ...(v as Omit<RescueManifest, 'repo'>), repo: typeof v.repo === 'string' && v.repo !== '' ? v.repo : 'unknown' };
}

// '<epochMs>-<pid>-<n>' -> sortable numbers
function idKey(id: string): number[] {
  return id.split('-').map((x) => Number(x) || 0);
}

function compareIds(a: string, b: string): number {
  const [ka, kb] = [idKey(a), idKey(b)];
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Complete manifests only, oldest first; incomplete or unreadable dirs are deleted.
export function pendingRescues(paths: StatePaths): RescueManifest[] {
  let names: string[];
  try {
    names = readdirSync(paths.rescue);
  } catch {
    return [];
  }
  const out: RescueManifest[] = [];
  for (const name of names.sort(compareIds)) {
    const dir = join(paths.rescue, name);
    if (kindAt(dir) !== 'dir') continue;
    const m = readManifest(dir, name);
    if (m === 'invalid') {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    out.push(m);
  }
  return out;
}
