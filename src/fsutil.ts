// Small helpers shared by many modules, one copy each: error codes, lstat kinds, path prefixes,
// record guards, $HOME and blocking fd writes. No src/ imports, so any module may use it.
import { lstatSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';

export type FsKind = 'file' | 'symlink' | 'dir' | 'missing';

const EAGAIN_RETRIES = 20;

export function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}

// lstat kind: a symlink is never followed.
export function kindAt(abs: string): FsKind {
  try {
    const st = lstatSync(abs);
    return st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

// The first non-blank line of git's output, trimmed: the one-line reason in an error message.
export function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

// The symlink-resolved path, or the path as given when it cannot be resolved (missing, unreadable).
export function realpathOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// 'a/b/c' -> ['a', 'a/b']
export function properPrefixes(p: string): string[] {
  const out: string[] = [];
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i));
  return out;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
}

// The whole text, or nothing more once the reader is gone: EPIPE and other errors drop the rest, EAGAIN (a full
// non-blocking pipe) retries briefly first. Never throws.
export function writeAllSync(fd: number, text: string | Uint8Array): void {
  const buf = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  let off = 0;
  let retries = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (errCode(e) === 'EAGAIN' && retries++ < EAGAIN_RETRIES) {
        Bun.sleepSync(1);
        continue;
      }
      return;
    }
  }
}
