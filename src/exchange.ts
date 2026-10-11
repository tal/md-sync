// Atomic exchange and no-replace rename of two directory entries through `bun:ffi` (`renamex_np` on macOS,
// `renameat2` on Linux), and the per-filesystem probe that picks `exchange`, `rename-only` or `copy-only`.
// Synchronous: the callers' check-then-switch blocks never yield.
import {
  closeSync, constants, fdatasyncSync, linkSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, renameSync,
  symlinkSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { errCode, kindAt } from './fsutil';

export type ExchangeMode = 'exchange' | 'rename-only' | 'copy-only';
export type VolumeCaps = { mode: ExchangeMode; noReplace: 'native' | 'link' | 'excl-open' };   // how C2 creates without replacing

const RENAME_SWAP = 0x2;        // darwin renamex_np
const RENAME_EXCL = 0x4;
const RENAME_NOREPLACE = 1;     // linux renameat2
const RENAME_EXCHANGE = 2;
const AT_FDCWD = -100;
const ERRNO_NAMES: Record<string, Record<number, string>> = {
  darwin: { 1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 13: 'EACCES', 17: 'EEXIST', 18: 'EXDEV', 20: 'ENOTDIR', 21: 'EISDIR',
    22: 'EINVAL', 28: 'ENOSPC', 30: 'EROFS', 45: 'ENOTSUP', 62: 'ELOOP', 63: 'ENAMETOOLONG', 66: 'ENOTEMPTY', 69: 'EDQUOT',
    78: 'ENOSYS', 92: 'EILSEQ' },
  linux: { 1: 'EPERM', 2: 'ENOENT', 5: 'EIO', 13: 'EACCES', 17: 'EEXIST', 18: 'EXDEV', 20: 'ENOTDIR', 21: 'EISDIR',
    22: 'EINVAL', 28: 'ENOSPC', 30: 'EROFS', 36: 'ENAMETOOLONG', 38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP', 84: 'EILSEQ',
    95: 'ENOTSUP', 122: 'EDQUOT' },
};
// errnos that mean "this filesystem (or this build) can't do it": the probe runs again, nothing is demoted on one call
export const UNSUPPORTED_ERRNOS: ReadonlySet<string> = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP']);

type Native = {
  exchange(a: string, b: string): number;      // 0, or an errno
  noReplace(a: string, b: string): number;
};

let native: Native | { error: string } | undefined;

function cstr(s: string): Uint8Array {
  return new TextEncoder().encode(`${s}\0`);
}

function errnoName(n: number): string {
  return ERRNO_NAMES[process.platform]?.[n] ?? `E${n}`;
}

function loadNative(): Native | { error: string } {
  if (native !== undefined) return native;
  try {
    const ffi = require('bun:ffi') as typeof import('bun:ffi');
    const { dlopen, FFIType, ptr, read } = ffi;
    if (process.platform === 'darwin') {
      const lib = dlopen('/usr/lib/libSystem.B.dylib', {
        renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __error: { args: [], returns: FFIType.ptr },
      });
      const call = (a: string, b: string, flags: number): number => {
        const pa = cstr(a);
        const pb = cstr(b);
        const r = lib.symbols.renamex_np(ptr(pa), ptr(pb), flags);
        if (r === 0) return 0;
        const e = lib.symbols.__error();
        return e === null ? -1 : read.i32(e, 0);
      };
      native = { exchange: (a, b) => call(a, b, RENAME_SWAP), noReplace: (a, b) => call(a, b, RENAME_EXCL) };
    } else if (process.platform === 'linux') {
      const lib = dlopen('libc.so.6', {
        renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        __errno_location: { args: [], returns: FFIType.ptr },
      });
      const call = (a: string, b: string, flags: number): number => {
        const pa = cstr(a);
        const pb = cstr(b);
        const r = lib.symbols.renameat2(AT_FDCWD, ptr(pa), AT_FDCWD, ptr(pb), flags);
        if (r === 0) return 0;
        const e = lib.symbols.__errno_location();
        return e === null ? -1 : read.i32(e, 0);
      };
      native = { exchange: (a, b) => call(a, b, RENAME_EXCHANGE), noReplace: (a, b) => call(a, b, RENAME_NOREPLACE) };
    } else {
      native = { error: `no atomic exchange on ${process.platform}` };
    }
  } catch (e) {
    native = { error: e instanceof Error ? e.message.split('\n')[0] ?? 'bun:ffi unavailable' : String(e) };
  }
  return native;
}

// Test hook: MDSYNC_TEST_EXCHANGE_MODE caps what the probe may return. `copy-only` also caps the no-replace
// create at `excl-open`, as on exFAT (no link, and RENAME_EXCL refused onto an absent name): an O_EXCL copy
// that a crash can cut part-way is then what the tests run.
function capped(mode: ExchangeMode): ExchangeMode {
  const cap = process.env.MDSYNC_TEST_EXCHANGE_MODE;
  if (cap === 'copy-only') return 'copy-only';
  if (cap === 'rename-only' && mode === 'exchange') return 'rename-only';
  return mode;
}

// Swaps the two entries atomically. 'unsupported': this process has no native exchange at all.
export function exchange(a: string, b: string): 'exchanged' | 'unsupported' | { errno: string } {
  const n = loadNative();
  if ('error' in n) return 'unsupported';
  const r = n.exchange(a, b);
  return r === 0 ? 'exchanged' : { errno: errnoName(r) };
}

// Renames a to b only when nothing is at b ('exists' otherwise; a case or NFC/NFD alias counts as existing).
// 'link' mode: link + unlink (a symlink is re-created from its target, since link() on macOS follows it); a folder
// falls back to a checked rename (its target is a fresh copy name nobody else creates). 'excl-open': O_EXCL create,
// copy, unlink a.
export function renameNoReplace(a: string, b: string, caps: VolumeCaps): 'renamed' | 'exists' | { errno: string } {
  let st;
  try {
    st = lstatSync(a);
  } catch (e) {
    return { errno: errCode(e) ?? 'EIO' };
  }
  if (caps.noReplace === 'native') {
    const n = loadNative();
    if (!('error' in n)) {
      const r = n.noReplace(a, b);
      if (r === 0) return 'renamed';
      const name = errnoName(r);
      if (name === 'EEXIST' || name === 'ENOTEMPTY') return 'exists';
      if (!UNSUPPORTED_ERRNOS.has(name)) return { errno: name };
      // the native flag failed after all (a misread errno, or a filesystem the probe did not see): fall through
    }
  }
  try {
    if (st.isDirectory()) {
      if (existsNoFollow(b)) return 'exists';
      renameSync(a, b);
      return 'renamed';
    }
    if (st.isSymbolicLink()) {
      symlinkSync(readlinkSync(a), b);
      unlinkSync(a);
      return 'renamed';
    }
    if (caps.noReplace !== 'excl-open') {
      try {
        linkSync(a, b);
        unlinkSync(a);
        return 'renamed';
      } catch (e) {
        const c = errCode(e);
        if (c === 'EEXIST') return 'exists';
        if (c !== 'EPERM' && c !== 'ENOTSUP' && c !== 'EMLINK' && c !== 'EOPNOTSUPP') throw e;
      }
    }
    copyExcl(a, b, st.mode & 0o777);
    unlinkSync(a);
    return 'renamed';
  } catch (e) {
    const c = errCode(e) ?? 'EIO';
    return c === 'EEXIST' ? 'exists' : { errno: c };
  }
}

function existsNoFollow(p: string): boolean {
  return kindAt(p) !== 'missing';
}

// O_CREAT|O_EXCL create of b holding a's bytes, fdatasynced.
export function copyExcl(a: string, b: string, mode: number): void {
  const src = openSync(a, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const dst = openSync(b, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND, mode);
    try {
      const buf = new Uint8Array(65_536);
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
}

// ---------------------------------------------------------------------------------------------------------------
// The per-filesystem probe

const cache = new Map<string, { caps: VolumeCaps; error: string | 'none' }>();
let probeSeq = 0;

function devOf(dir: string): string {
  return String(lstatSync(dir).dev);
}

function probe(tempDir: string): { caps: VolumeCaps; error: string | 'none' } {
  const n = loadNative();
  const base = join(tempDir, `probe-${process.pid}-${++probeSeq}`);
  const p1 = `${base}-1`;
  const p2 = `${base}-2`;
  const p3 = `${base}-3`;
  const p4 = `${base}-4`;
  const p5 = `${base}-5`;
  const errors: string[] = 'error' in n ? [n.error] : [];
  let exch: 'works' | 'fails' = 'fails';
  let excl: 'works' | 'fails' = 'fails';
  let link: 'works' | 'fails' = 'fails';
  try {
    writeFileSync(p1, PROBE_ONE, { flag: 'wx' });
    writeFileSync(p2, PROBE_TWO, { flag: 'wx' });
    if (!('error' in n)) {
      const r = n.exchange(p1, p2);
      if (r === 0 && readFileSync(p1, 'utf8') === PROBE_TWO && readFileSync(p2, 'utf8') === PROBE_ONE) exch = 'works';
      else if (r !== 0) errors.push(`exchange: ${errnoName(r)}`);
      writeFileSync(p3, PROBE_ONE, { flag: 'wx' });
      const q = n.noReplace(p3, p4);   // onto an ABSENT name: exFAT refuses only this case
      if (q === 0 && existsNoFollow(p4) && !existsNoFollow(p3)) excl = 'works';
      else if (q !== 0) errors.push(`no-replace: ${errnoName(q)}`);
    }
    try {
      linkSync(p2, p5);
      if (lstatSync(p5).ino === lstatSync(p2).ino) link = 'works';
    } catch (e) {
      errors.push(`link: ${errCode(e) ?? 'error'}`);
    }
  } catch (e) {
    errors.push(`probe: ${errCode(e) ?? String(e)}`);
  } finally {
    for (const p of [p1, p2, p3, p4, p5]) {
      try { unlinkSync(p); } catch { /* not created */ }
    }
  }
  const mode = capped(exch === 'works' && link === 'works' ? 'exchange' : link === 'works' ? 'rename-only' : 'copy-only');
  const noReplace: VolumeCaps['noReplace'] = process.env.MDSYNC_TEST_EXCHANGE_MODE === 'copy-only' ? 'excl-open'
    : excl === 'works' ? 'native' : link === 'works' && mode !== 'copy-only' ? 'link' : 'excl-open';
  return { caps: { mode, noReplace }, error: mode === 'exchange' ? 'none' : errors.join('; ') || `capped by MDSYNC_TEST_EXCHANGE_MODE` };
}

// Bytes of the probe files: whoever finds a leftover probe file (a crash mid-probe) may delete it by content.
export const PROBE_ONE = 'mdsync exchange probe 1\n';
export const PROBE_TWO = 'mdsync exchange probe 2\n';

// Probed once per st_dev per process, inside `tempDir` (a folder on that filesystem that only this process writes).
export function volumeCaps(tempDir: string): VolumeCaps {
  return volumeProbe(tempDir).caps;
}

// The caps and, when the mode is not `exchange`, why (for `worktree exchange unavailable`).
export function volumeProbe(tempDir: string): { caps: VolumeCaps; error: string | 'none'; dev: string } {
  const dev = devOf(tempDir);
  let hit = cache.get(dev);
  if (hit === undefined) {
    hit = probe(tempDir);
    cache.set(dev, hit);
  }
  return { ...hit, dev };
}

// A real call failed with an "unsupported" errno: the next volumeCaps for this filesystem probes again. One errno
// never demotes a volume by itself (it is read in a second FFI call, and the runtime may make syscalls in between).
export function reprobe(dirOnVolume: string): void {
  try {
    cache.delete(devOf(dirOnVolume));
  } catch {
    // gone: nothing cached for it matters
  }
}
