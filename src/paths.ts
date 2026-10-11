// Home expansion, XDG dirs, dir canonicalization and the per-folder state file paths.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homeOf } from './fsutil';

// '~' | '~/x'. '~user' forms are left alone.
export function expandHome(p: string, home?: string): string {
  if (p !== '~' && !p.startsWith('~/')) return p;
  const h = home ?? homedir();
  return p === '~' ? h : join(h, p.slice(2));
}

export function resolveDirInput(p: string, base: string): string {
  return resolve(base, expandHome(p));
}

export function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  const v = env.XDG_CONFIG_HOME;
  return v !== undefined && isAbsolute(v) ? v : join(homeOf(env), '.config');
}

export function xdgStateHome(env: NodeJS.ProcessEnv): string {
  const v = env.XDG_STATE_HOME;
  return v !== undefined && isAbsolute(v) ? v : join(homeOf(env), '.local', 'state');
}

export function defaultConfigPath(env: NodeJS.ProcessEnv): string {
  return join(xdgConfigHome(env), 'mdsync', 'config.json');
}

// Throws ENOENT when the dir does not exist. Also fixes letter case on case-insensitive filesystems.
export function canonicalDir(dir: string): string {
  return realpathSync(dir);
}

// realpath of the longest existing prefix, with the rest appended: a deleted folder (or a file in one) still maps to
// the path its realpath had (/tmp/notes -> /private/tmp/notes on macOS), so its state hash does not change.
export function realpathLoose(abs: string): string {
  if (existsSync(abs)) {
    try { return realpathSync(abs); } catch { /* fall through */ }
  }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realpathLoose(parent), basename(abs));
}

export function dirHash(realDir: string): string {
  return createHash('sha256').update(realDir).digest('hex').slice(0, 16);
}

export type StatePaths = {
  stateDir: string;   // <stateHome>/mdsync
  hash: string;
  lock: string;       // <hash>.lock
  lockGuard: string;  // <hash>.lock.takeover   (exists only during a stale-lock takeover)
  sock: string;       // <hash>.sock
  state: string;      // <hash>.json
  stateTmp: string;   // <hash>.json.tmp        (atomic write; removed after the lock is acquired)
  journal: string;    // <hash>.journal.json
  log: string;        // <hash>.log  (launchd stdout/stderr)
  tmp: string;        // <hash>.tmp/      scratch + temporary index files, wiped after the lock is acquired
  rescue: string;     // <hash>.rescue/   saved worktree edits (persistent until restored)
  localOnly: string;  // <hash>.local-only.json  conflict copies made as local-only
};

// mdsync's own folder inside a state home ($XDG_STATE_HOME or its default).
export function stateDirIn(stateHome: string): string {
  return join(stateHome, 'mdsync');
}

export function statePathsFor(realDir: string, env: NodeJS.ProcessEnv): StatePaths {
  const stateDir = stateDirIn(xdgStateHome(env));
  const hash = dirHash(realDir);
  const at = (suffix: string): string => join(stateDir, hash + suffix);
  return {
    stateDir,
    hash,
    lock: at('.lock'),
    lockGuard: at('.lock.takeover'),
    sock: at('.sock'),
    state: at('.json'),
    stateTmp: at('.json.tmp'),
    journal: at('.journal.json'),
    log: at('.log'),
    tmp: at('.tmp'),
    rescue: at('.rescue'),
    localOnly: at('.local-only.json'),
  };
}

// mkdir -p; the mdsync dir itself is 0700 (parents get the default mode). It must be a real directory that we own:
// whoever can write it could plant a socket (catching flushes), a lock, or a rescue manifest that preflight restores
// into the synced folder. Anything else throws (the command exits 1) rather than being used.
export function ensureStateDir(p: StatePaths): void {
  mkdirSync(dirname(p.stateDir), { recursive: true });
  mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(p.stateDir);
  if (!st.isDirectory()) throw new Error(`state dir ${p.stateDir} is not a directory (a symlink?); refusing to use it`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`state dir ${p.stateDir} is owned by uid ${st.uid}, not ${uid}; refusing to use it `
      + `(chown it to ${uid}, or set XDG_STATE_HOME to a directory of your own)`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(p.stateDir, 0o700);
}

// Walks cwdReal → '/' and returns the first ancestor a (cwdReal included) whose <hash(a)>.{sock,lock,json} exists.
export function findSyncedAncestor(cwdReal: string, env: NodeJS.ProcessEnv): string | 'none' {
  let dir = resolve(cwdReal);
  for (;;) {
    const p = statePathsFor(dir, env);
    if (existsSync(p.sock) || existsSync(p.lock) || existsSync(p.state)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return 'none';
    dir = parent;
  }
}
