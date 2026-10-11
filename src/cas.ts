// Per-path checked writes: casPut, linkCopy, moveAside, and settleAside/copyOut for replaced
// inodes. Everything here is synchronous, so nothing else runs between a check and its switch. Paths are relative to
// `root` (the worktree top). A put replaces an entry only when a check right before the switch finds exactly the
// bytes the plan classified (W2 a/b), and a check right after it proves that what came out is that inode (W2 c).
// Nothing unverified is ever unlinked; replaced inodes stay linked under their temp name until settle (W3).
import {
  closeSync, constants, fdatasyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync,
  renameSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { copyExcl, exchange, renameNoReplace, reprobe, UNSUPPORTED_ERRNOS, type VolumeCaps } from './exchange';
import { errCode, properPrefixes } from './fsutil';

export const TEMP_DIR_RE = /(^|\/)\.mdsync-\d+-\d+\.d(\/|$)/;

export type Version = { kind: 'file'; src: string; exec: 'exec' | 'plain' }   // src: a file (absolute) holding the bytes
  | { kind: 'symlink'; target: string } | { kind: 'absent' };
export type Digest = { kind: 'file' | 'symlink'; size: number; sha256: string } | { kind: 'absent' };   // what the path must hold
export type Expect = Digest
  | { kind: 'inode'; copy: string }                               // identity mode: the inode `copy` hard-links
  | { kind: 'snapshot'; copy: string; digest: Digest };           // identity mode without a hard link (copy-only, or link()
                                                                  //   refused): `copy` is a byte snapshot with `digest`; the
                                                                  //   path's inode moves aside whole, with no content check
export type Seen = Digest | { kind: 'dir' } | { kind: 'other' };
export type Aside = { name: string; path: string; ino: string;   // a replaced inode, still linked at `name` (decimal ino)
  expect: Digest | 'inode';                                      // what the plan replaced ('inode': captured by identity)
  copy: string | 'none';                                         // a conflict copy that hard-links the same inode
  since: number };                                               // ms epoch of the switch
export type CasResult =
  | { kind: 'done'; aside: Aside | 'none' }                      // the path holds `want`
  | { kind: 'changed'; seen: Seen }                              // the path did not hold `expect`: nothing was replaced
  | { kind: 'raced'; kept: string; path: 'want' | 'changed' }    // someone's write landed in our window and is kept at `kept`
  | { kind: 'error'; error: string };                            // a real I/O error: nothing was replaced
// Test-only injection points: a writer runs at exactly that moment.
export type CasHooks = { afterCheck?: () => void; beforeUnlink?: () => void; afterUnlink?: () => void };

// errnos that mean the folder changed between the check and the call: the path is surveyed again.
const CHANGED_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'ENOTEMPTY', 'ELOOP']);
const CHUNK = 65_536;

class Changed extends Error {
  constructor(readonly seen: Seen) {
    super('changed');
  }
}

function abs(root: string, rel: string): string {
  return join(root, rel);
}

function fail(e: unknown): CasResult {
  const c = errCode(e) ?? 'EIO';
  if (CHANGED_ERRNOS.has(c)) return { kind: 'changed', seen: { kind: 'other' } };
  return { kind: 'error', error: `${c}: ${e instanceof Error ? e.message : String(e)}` };
}

export function sha256Hex(b: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(b).digest('hex');
}

// size and sha256 of everything readable through fd, read from offset 0 (the fd's own position is not used)
export function hashFd(fd: number): { size: number; sha256: string } {
  const h = new Bun.CryptoHasher('sha256');
  const buf = new Uint8Array(CHUNK);
  let off = 0;
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, off);
    if (n === 0) break;
    h.update(n === buf.length ? buf : buf.subarray(0, n));
    off += n;
  }
  return { size: off, sha256: h.digest('hex') };
}

export function readFd(fd: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let off = 0;
  for (;;) {
    const buf = new Uint8Array(CHUNK);
    const n = readSync(fd, buf, 0, buf.length, off);
    if (n === 0) break;
    parts.push(buf.subarray(0, n));
    off += n;
  }
  const out = new Uint8Array(off);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function digestEq(a: Seen, b: Seen): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  if (a.kind === 'dir' || a.kind === 'other' || b.kind === 'dir' || b.kind === 'other') return a.kind === b.kind;
  return a.kind === b.kind && a.size === b.size && a.sha256 === b.sha256;
}

export function symlinkDigest(target: string): Digest {
  const b = new TextEncoder().encode(target);
  return { kind: 'symlink', size: b.length, sha256: sha256Hex(b) };
}

// What is at `rel` now: a file's size and sha256 (read through a descriptor), a symlink's target, a folder, nothing.
export function digestAt(root: string, rel: string): Seen {
  const p = abs(root, rel);
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    const c = errCode(e);
    if (c === 'ENOENT' || c === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'other' };
  }
  if (st.isSymbolicLink()) {
    try {
      return symlinkDigest(readlinkSync(p));
    } catch {
      return { kind: 'other' };
    }
  }
  if (st.isDirectory()) return { kind: 'dir' };
  if (!st.isFile()) return { kind: 'other' };
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { kind: 'other' };
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) return fst.isDirectory() ? { kind: 'dir' } : { kind: 'other' };
    return { kind: 'file', ...hashFd(fd) };
  } finally {
    closeSync(fd);
  }
}

// The digest of a version (its materialized bytes, or a symlink target).
export function versionDigest(v: Version): Digest {
  if (v.kind === 'absent') return { kind: 'absent' };
  if (v.kind === 'symlink') return symlinkDigest(v.target);
  const fd = openSync(v.src, constants.O_RDONLY);
  try {
    return { kind: 'file', ...hashFd(fd) };
  } finally {
    closeSync(fd);
  }
}

// C1: write `want` to the fresh, journaled temp name (O_EXCL), then fdatasync. The umask applies as it does for git.
// A failure after the create (ENOSPC, EIO, a source that can't be read) unlinks the temp again: it was created here,
// never switched in, so whatever it holds is ours. Left behind, each retry of a run on a full disk added more.
export function writeTemp(root: string, temp: string, want: Version): 'written' | { error: string } {
  const t = abs(root, temp);
  let created: 'created' | 'none' = 'none';
  try {
    if (want.kind === 'symlink') {
      symlinkSync(want.target, t);
      return 'written';
    }
    if (want.kind !== 'file') return 'written';
    const src = openSync(want.src, constants.O_RDONLY);
    try {
      const dst = openSync(t, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, want.exec === 'exec' ? 0o777 : 0o666);
      created = 'created';
      try {
        const buf = new Uint8Array(CHUNK);
        for (;;) {
          const n = readSync(src, buf, 0, buf.length, null);
          if (n === 0) break;
          let off = 0;
          while (off < n) off += writeSync(dst, buf, off, n - off);
        }
        fdatasyncSync(dst);
      } finally {
        closeSync(dst);
      }
    } finally {
      closeSync(src);
    }
    return 'written';
  } catch (e) {
    if (created === 'created') tryUnlink(t);
    return { error: `${errCode(e) ?? 'EIO'}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Unlinks a temp only while it holds exactly our version (rule (a): never switched in).
export function unlinkOwnTemp(root: string, temp: string, want: Digest): 'unlinked' | 'kept' | 'missing' {
  const seen = digestAt(root, temp);
  if (seen.kind === 'absent') return 'missing';
  if (want.kind === 'absent' || !digestEq(seen, want)) return 'kept';
  try {
    unlinkSync(abs(root, temp));
    return 'unlinked';
  } catch {
    return 'kept';
  }
}

// C1b: mkdir -p dirname(rel), lstat-checking each prefix: one that exists and is not a folder (a file, or a symlink,
// which git never writes through either) is in the way. Returns the folders created.
export function ensureParents(root: string, rel: string): string[] {
  const made: string[] = [];
  for (const d of properPrefixes(rel)) {
    let st;
    try {
      st = lstatSync(abs(root, d));
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw e;
      try {
        mkdirSync(abs(root, d));
        made.push(d);
        continue;
      } catch (e2) {
        if (errCode(e2) !== 'EEXIST') throw e2;
        st = lstatSync(abs(root, d));
      }
    }
    if (!st.isDirectory()) throw new Changed({ kind: 'other' });
  }
  return made;
}

type Checked = { ino: string; fd: number | 'none' };

// C3: the path must hold exactly `expect`. A file is read through the descriptor that stays open until the switch.
function check(root: string, rel: string, expect: Expect): Checked {
  const p = abs(root, rel);
  if (expect.kind === 'absent') {
    try {
      lstatSync(p);
    } catch (e) {
      const c = errCode(e);
      if (c === 'ENOENT') return { ino: 'none', fd: 'none' };
      if (c === 'ENOTDIR') throw new Changed({ kind: 'other' });
      throw e;
    }
    throw new Changed(digestAt(root, rel));
  }
  if (expect.kind === 'snapshot') {
    // whatever regular file is there now: the copy is a snapshot of it, and the aside keeps every later byte
    const st = lstatSync(p, { bigint: true });
    if (!st.isFile()) throw new Changed(st.isDirectory() ? { kind: 'dir' } : { kind: 'other' });
    return { ino: String(st.ino), fd: 'none' };
  }
  if (expect.kind === 'inode') {
    const st = lstatSync(p, { bigint: true });
    if (st.isSymbolicLink()) {
      const want = readlinkSync(abs(root, expect.copy));
      if (readlinkSync(p) !== want) throw new Changed({ kind: 'other' });
      return { ino: String(st.ino), fd: 'none' };
    }
    if (!st.isFile()) throw new Changed(st.isDirectory() ? { kind: 'dir' } : { kind: 'other' });
    const copy = lstatSync(abs(root, expect.copy), { bigint: true });
    if (copy.ino !== st.ino) throw new Changed({ kind: 'other' });
    return { ino: String(st.ino), fd: 'none' };
  }
  if (expect.kind === 'symlink') {
    const st = lstatSync(p, { bigint: true });
    if (!st.isSymbolicLink()) throw new Changed(st.isDirectory() ? { kind: 'dir' } : { kind: 'other' });
    const d = symlinkDigest(readlinkSync(p));
    if (!digestEq(d, expect)) throw new Changed(d);
    return { ino: String(st.ino), fd: 'none' };
  }
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new Changed(st.isDirectory() ? { kind: 'dir' } : { kind: 'other' });
    const h = hashFd(fd);
    if (h.size !== expect.size || h.sha256 !== expect.sha256) throw new Changed({ kind: 'file', ...h });
    return { ino: String(st.ino), fd };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

function inoAt(p: string): string | 'none' {
  try {
    return String(lstatSync(p, { bigint: true }).ino);
  } catch {
    return 'none';
  }
}

function nlinkOf(p: string): number {
  try {
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return Number(fstatSync(fd).nlink);
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
}

function tryUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // gone already
  }
}

// A snapshot identity put's aside settles against the snapshot's bytes: unchanged since, it is unlinked (the copy holds
// them); anything written into the inode after the snapshot makes it `late`, a second copy.
function asideOf(name: string, path: string, ino: string, expect: Expect, copy: string | undefined): Aside {
  if (expect.kind === 'snapshot') return { name, path, ino, expect: expect.digest, copy: 'none', since: Date.now() };
  return { name, path, ino, expect: expect.kind === 'inode' ? 'inode' : expect,
    copy: expect.kind === 'inode' ? expect.copy : copy ?? 'none', since: Date.now() };
}

// casPut: put `want` at `path`, which must hold `expect`. The caller journaled both names and already wrote `temp`
// (C1, writeTemp) in the round's write pass. `t.copy`: a conflict copy that hard-links the inode at `path` (the plan's
// copy of this path's local version): the aside records it, so settle's S2 knows every later write into that inode
// is kept by the copy.
export function casPut(root: string, path: string, expect: Expect, want: Version, t: { temp: string; aside: string; copy?: string },
  caps: VolumeCaps, hooks: CasHooks = {}): CasResult {
  const p = abs(root, path);
  const temp = abs(root, t.temp);
  const aside = abs(root, t.aside);
  const dropTemp = (): void => {
    if (want.kind !== 'absent') tryUnlink(temp);
  };
  if (expect.kind === 'absent' && want.kind === 'absent') {
    const seen = digestAt(root, path);
    return seen.kind === 'absent' ? { kind: 'done', aside: 'none' } : { kind: 'changed', seen };
  }
  let c: Checked;
  try {
    if (want.kind !== 'absent') ensureParents(root, path);   // C1b
    c = check(root, path, expect);                         // C3
  } catch (e) {
    dropTemp();
    if (e instanceof Changed) return { kind: 'changed', seen: e.seen };
    return fail(e);
  }
  try {
    hooks.afterCheck?.();
    if (want.kind === 'absent') {                          // C4: the inode moves aside, and the path is free
      try {
        renameSync(p, aside);
      } catch (e) {
        return fail(e);
      }
      if (inoAt(aside) !== c.ino) {
        // an atomic save landed between C3 and C4: put it back where it was
        const back = renameNoReplace(aside, p, caps);
        if (back === 'renamed') return { kind: 'changed', seen: digestAt(root, path) };
        return { kind: 'raced', kept: t.aside, path: 'changed' };
      }
      return { kind: 'done', aside: asideOf(t.aside, path, c.ino, expect, t.copy) };
    }
    if (expect.kind === 'absent') {                        // C2: the create is atomic, no window at all
      const r = renameNoReplace(temp, p, caps);
      if (r === 'renamed') return { kind: 'done', aside: 'none' };
      dropTemp();
      if (r === 'exists') return { kind: 'changed', seen: digestAt(root, path) };
      return CHANGED_ERRNOS.has(r.errno) ? { kind: 'changed', seen: digestAt(root, path) } : { kind: 'error', error: r.errno };
    }
    if (caps.mode === 'exchange') return c5(root, path, p, temp, t, expect, c);
    // a snapshot identity put moves the inode whole (C5c without a content check): C5' would need the link the copy
    // could not make, and an inode check against a byte copy never passes (the move stayed busy for good)
    if (caps.mode === 'rename-only' && expect.kind !== 'snapshot') return c5r(root, path, p, temp, aside, t, expect, c, caps);
    return c5c(path, p, temp, aside, t, expect, c, caps);
  } finally {
    if (c.fd !== 'none') closeSync(c.fd);
  }
}

// C5, exchange mode: path = our inode; temp = whatever was there. NEVER exchanged back: a read-modify-write writer
// may already have read our version, and its save would replace the raced one.
function c5(root: string, path: string, p: string, temp: string, t: { temp: string; aside: string; copy?: string }, expect: Expect,
  c: Checked): CasResult {
  const tempIno = inoAt(temp);
  const r = exchange(temp, p);
  if (r !== 'exchanged') {
    // Confirmed by lstat that nothing switched: a misread errno only costs a re-survey, and an "unsupported" one
    // re-probes the filesystem (only the probe changes its mode).
    if (r === 'unsupported' || UNSUPPORTED_ERRNOS.has(r.errno)) reprobe(dirname(temp));
    if (inoAt(temp) === tempIno) {
      tryUnlink(temp);   // still our version, never switched in (rule (a))
      return r !== 'unsupported' && !CHANGED_ERRNOS.has(r.errno) && !UNSUPPORTED_ERRNOS.has(r.errno)
        ? { kind: 'error', error: r.errno } : { kind: 'changed', seen: digestAt(root, path) };
    }
  }
  if (inoAt(temp) === c.ino) return { kind: 'done', aside: asideOf(t.temp, path, c.ino, expect, t.copy) };
  return { kind: 'raced', kept: t.temp, path: 'want' };
}

// C5', rename-only mode: link the checked inode aside, verify it, then rename the new version over the path. The one
// residual window of this mode: an atomic save landing between the link and the rename.
function c5r(root: string, path: string, p: string, temp: string, aside: string, t: { temp: string; aside: string; copy?: string },
  expect: Expect, c: Checked, caps: VolumeCaps): CasResult {
  if (expect.kind === 'symlink') {
    try {
      renameSync(temp, p);
    } catch (e) {
      tryUnlink(temp);
      return fail(e);
    }
    return { kind: 'done', aside: 'none' };
  }
  try {
    linkSync(p, aside);
  } catch (e) {
    const code = errCode(e);
    if (code === 'EPERM' || code === 'EMLINK' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      return c5c(path, p, temp, aside, t, expect, c, caps);   // this inode can't be linked: move it whole instead
    }
    tryUnlink(temp);
    return fail(e);
  }
  if (inoAt(aside) !== c.ino) {
    // the path was replaced after C3 (or became a symlink, whose target link() followed): the aside is someone
    // else's inode. Unlinked only while another name still links it.
    tryUnlink(temp);
    if (nlinkOf(aside) >= 2) {
      tryUnlink(aside);
      return { kind: 'changed', seen: digestAt(root, path) };
    }
    return { kind: 'raced', kept: t.aside, path: 'changed' };
  }
  try {
    renameSync(temp, p);
  } catch (e) {
    // the aside links the inode that is still at the path (rule (c)): safe to drop
    if (inoAt(p) === c.ino) tryUnlink(aside);
    tryUnlink(temp);
    return fail(e);
  }
  return { kind: 'done', aside: asideOf(t.aside, path, c.ino, expect, t.copy) };
}

// C5c, copy-only mode (no hard links, no exchange): the inode moves aside whole, then the new version is created
// without replacing anything. Readers can see the path absent for a few µs; nothing is lost.
function c5c(path: string, p: string, temp: string, aside: string, t: { temp: string; aside: string; copy?: string }, expect: Expect,
  c: Checked, caps: VolumeCaps): CasResult {
  const asideRel = t.aside;
  try {
    renameSync(p, aside);
  } catch (e) {
    tryUnlink(temp);
    return fail(e);
  }
  const keptBefore: 'kept' | 'none' = inoAt(aside) !== c.ino ? 'kept' : 'none';   // someone's save replaced it after C3
  let r: ReturnType<typeof renameNoReplace>;
  try {
    r = inoAt(temp) === 'none' ? { errno: 'ENOENT' } : renameNoReplace(temp, p, caps);
  } catch (e) {
    r = { errno: errCode(e) ?? 'EIO' };
  }
  if (r === 'exists') {
    tryUnlink(temp);
    return { kind: 'raced', kept: asideRel, path: 'changed' };
  }
  if (r !== 'renamed') {
    // put the old entry back where it was, if the name is still free
    const back = renameNoReplace(aside, p, caps);
    tryUnlink(temp);
    if (back === 'renamed') return CHANGED_ERRNOS.has(r.errno) ? { kind: 'changed', seen: { kind: 'other' } } : { kind: 'error', error: r.errno };
    return { kind: 'raced', kept: asideRel, path: 'changed' };
  }
  if (keptBefore === 'kept') return { kind: 'raced', kept: asideRel, path: 'want' };
  return { kind: 'done', aside: asideOf(asideRel, path, c.ino, expect, t.copy) };
}

// A conflict copy of what is at `path`: a hard link (it shares the inode, so every later in-place write to the
// original lands in the copy too), a new symlink with the same target, or (no hard links) a byte copy.
export function linkCopy(root: string, path: string, copy: string, expect: Digest | 'any', caps: VolumeCaps):
  { kind: 'linked'; ino: string } | { kind: 'copied' } | 'changed' | 'taken' {
  const p = abs(root, path);
  const q = abs(root, copy);
  let ino: string;
  let kind: 'file' | 'symlink';
  try {
    const st = lstatSync(p, { bigint: true });
    if (st.isSymbolicLink()) kind = 'symlink';
    else if (st.isFile()) kind = 'file';
    else return 'changed';
    ino = String(st.ino);
    if (expect !== 'any') {
      if (expect.kind === 'absent' || expect.kind !== kind) return 'changed';
      const c = check(root, path, expect);
      if (c.fd !== 'none') closeSync(c.fd);
      if (c.ino !== ino) return 'changed';
    }
    ensureParents(root, copy);
  } catch (e) {
    if (e instanceof Changed) return 'changed';
    const code = errCode(e);
    if (code !== undefined && CHANGED_ERRNOS.has(code)) return 'changed';
    throw e;
  }
  if (kind === 'symlink') {   // never hard-linked: link() on macOS would link the target
    try {
      symlinkSync(readlinkSync(p), q);
      return { kind: 'copied' };
    } catch (e) {
      const code = errCode(e);
      if (code === 'EEXIST') return 'taken';
      if (code !== undefined && CHANGED_ERRNOS.has(code)) return 'changed';
      throw e;
    }
  }
  if (caps.mode !== 'copy-only') {
    try {
      linkSync(p, q);
      if (inoAt(q) === ino && inoAt(p) === ino) return { kind: 'linked', ino };
      if (nlinkOf(q) >= 2) tryUnlink(q);
      return 'changed';
    } catch (e) {
      const code = errCode(e);
      if (code === 'EEXIST') return 'taken';
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'changed';
      if (code !== 'EPERM' && code !== 'EMLINK' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw e;
    }
  }
  try {
    copyExcl(p, q, lstatSync(p).mode & 0o777);
    return { kind: 'copied' };
  } catch (e) {
    const code = errCode(e);
    if (code === 'EEXIST') return 'taken';
    if (code !== undefined && CHANGED_ERRNOS.has(code)) return 'changed';
    throw e;
  }
}

// Moves whatever is at `path` (a file, a symlink or a whole folder) to the fresh name `to`, never replacing anything.
export function moveAside(root: string, path: string, to: string, caps: VolumeCaps = { mode: 'rename-only', noReplace: 'link' }):
  'moved' | 'taken' | 'missing' {
  try {
    lstatSync(abs(root, path));
  } catch {
    return 'missing';
  }
  try {
    ensureParents(root, to);
  } catch (e) {
    if (e instanceof Changed) return 'taken';
    throw e;
  }
  const r = renameNoReplace(abs(root, path), abs(root, to), caps);
  if (r === 'renamed') return 'moved';
  if (r === 'exists') return 'taken';
  if (r.errno === 'ENOENT') return 'missing';
  throw Object.assign(new Error(`moveAside ${path}: ${r.errno}`), { code: r.errno });
}

// A replaced version's bytes match what the plan replaced. A size below 0 is one a resumed journal did not record
// (only the sha256 is known).
function sameBytes(h: { size: number; sha256: string }, e: Digest): boolean {
  return e.kind !== 'absent' && h.sha256 === e.sha256 && (e.size < 0 || h.size === e.size);
}

// Settle one replaced inode once its grace has passed. 'late': the inode holds a write that reached
// it after the switch and is kept at a.name (the caller moves it to a conflict copy). 'writing': a write reached it
// during the unlink; the caller re-reads through fd until it is stable, then copies it out (copyOut).
export function settleAside(root: string, a: Aside, hooks: CasHooks = {}):
  { kind: 'clean' } | { kind: 'late'; kept: string } | { kind: 'writing'; fd: number } {
  const p = abs(root, a.name);
  let lst;
  try {
    lst = lstatSync(p, { bigint: true });
  } catch {
    return { kind: 'clean' };   // only a replayed journal gets here: nobody else touches temp names
  }
  if (lst.isSymbolicLink()) {   // nothing writes into a symlink in place: it settles at once
    if (a.expect !== 'inode' && sameBytes(symlinkDigest(readlinkSync(p)) as { size: number; sha256: string }, a.expect)) {
      tryUnlink(p);
      return { kind: 'clean' };
    }
    if (a.copy !== 'none') {
      try {
        if (readlinkSync(abs(root, a.copy)) === readlinkSync(p)) {
          tryUnlink(p);
          return { kind: 'clean' };
        }
      } catch {
        // the copy is gone: keep this one
      }
    }
    return { kind: 'late', kept: a.name };
  }
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);                           // S1
  } catch (e) {
    if (errCode(e) === 'ENOENT') return { kind: 'clean' };
    return { kind: 'late', kept: a.name };
  }
  let keepFd: 'close' | 'keep' = 'close';
  try {
    const st = fstatSync(fd, { bigint: true });
    if (String(st.ino) !== a.ino) return { kind: 'late', kept: a.name };   // never unlink an unknown inode
    // S2: the copy links the inode, so it keeps every late write. A copy an agent renamed still links it (nlink >= 2,
    // through our own descriptor): keeping a second name for it would make two worktree names share one inode.
    if (a.copy !== 'none' && (inoAt(abs(root, a.copy)) === a.ino || st.nlink >= 2n)) {
      tryUnlink(p);
      return { kind: 'clean' };
    }
    if (a.expect === 'inode') return { kind: 'late', kept: a.name };                         // S3
    const before = hashFd(fd);
    if (!sameBytes(before, a.expect)) return { kind: 'late', kept: a.name };
    hooks.beforeUnlink?.();
    unlinkSync(p);                                                                            // S4
    hooks.afterUnlink?.();
    if (sameBytes(hashFd(fd), a.expect)) return { kind: 'clean' };
    keepFd = 'keep';
    return { kind: 'writing', fd };                                                           // S5
  } finally {
    if (keepFd === 'close') closeSync(fd);
  }
}

// S5: the bytes of an unlinked inode a write reached, copied into a create-only conflict copy `copy` (the caller
// re-read them until stable first). fd stays open (the caller closes it): when this name can't be made, the caller
// still holds the only reference to those bytes and tries another.
export function copyOut(root: string, fd: number, copy: string): string {
  const bytes = readFd(fd);
  ensureParents(root, copy);
  const out = openSync(abs(root, copy), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o666);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(out, bytes, off, bytes.length - off);
    fdatasyncSync(out);
  } finally {
    closeSync(out);
  }
  return copy;
}
