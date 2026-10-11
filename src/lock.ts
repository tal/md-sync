// Folder lock with boot-id / start-time staleness and a takeover guard.
// Everything here is synchronous: acquiring never awaits, and release() is safe in process.on('exit').
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { errCode } from './fsutil';
import type { Logger } from './log';
import type { StatePaths } from './paths';

export const PROC_START_TOLERANCE_MS = 2_000;
export const TAKEOVER_GUARD_STALE_MS = 10_000;

const MAX_PASSES = 3;
const UNPARSABLE_RETRIES = 5;
const UNPARSABLE_RETRY_MS = 100;
const UNPARSABLE_STALE_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

export type LockPurpose = 'daemon' | 'one-off';
export type LockOwner = { pid: number; startedAt: string; dir: string; purpose: LockPurpose;
  bootId: string | 'unknown';        // linux: /proc/sys/kernel/random/boot_id; darwin: `sysctl -n kern.bootsessionuuid`
  procStart: number | 'unknown';     // owner's own process start time, ms epoch (see processStartMs)
  procStartTicks: number | 'unknown' };   // linux: start in clock ticks since boot (immune to wall-clock steps)
export type LockHandle = { path: string; release(): void };          // idempotent, sync (safe in process.on('exit'))
export type AcquireResult = { kind: 'acquired'; handle: LockHandle } | { kind: 'busy'; owner: LockOwner };
export type Liveness = 'alive' | 'stale-dead-pid' | 'stale-boot-id' | 'stale-pid-reused' | 'stale-self-pid' | 'stale-unparsable';

// The fs facade acquireLock and release() go through. Tests inject one to interleave two acquirers.
export type LockFs = {
  openSync(path: string, flags: 'wx' | 'r'): number;
  writeSync(fd: number, data: string): number;
  fsyncSync(fd: number): void;
  fstatSync(fd: number): { ino: number; mtimeMs: number };
  readFileSync(fd: number): string;     // utf8, from the fd's current position
  closeSync(fd: number): void;
  unlinkSync(path: string): void;
};

// Internal overload of acquireLock (unit tests only).
export type LockInternals = {
  fs?: LockFs;
  self?: { pid: number; bootId: string | 'unknown'; procStart: number | 'unknown';   // who we claim to be
    procStartTicks?: number | 'unknown' };
  liveness?: (owner: LockOwner) => Liveness;
  pidAlive?: (pid: number) => boolean;                                                 // for the guard's pid
  now?: () => number;
  sleep?: (ms: number) => void;
};

const realFs: LockFs = {
  openSync: (path, flags) => openSync(path, flags, 0o600),
  writeSync: (fd, data) => writeSync(fd, data),
  fsyncSync: (fd) => fsyncSync(fd),
  fstatSync: (fd) => fstatSync(fd),
  readFileSync: (fd) => readFileSync(fd, 'utf8'),
  closeSync: (fd) => closeSync(fd),
  unlinkSync: (path) => unlinkSync(path),
};

// ---------------------------------------------------------------------------------------------------------------
// Liveness probes

// kill(pid,0): ok => true; EPERM => true; ESRCH => false. Any other error counts as alive (never steal on doubt).
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) !== 'ESRCH';
  }
}

function runProbe(argv: string[]): string | 'failed' {
  try {
    const r = Bun.spawnSync(argv, {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' },
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : 'failed';
  } catch {
    return 'failed';
  }
}

function firstWorking(candidates: string[][]): string | 'failed' {
  for (const argv of candidates) {
    const out = runProbe(argv);
    if (out !== 'failed') return out;
  }
  return 'failed';
}

let bootIdCache: string | 'unknown' | undefined;

export function currentBootId(): string | 'unknown' {
  if (bootIdCache !== undefined) return bootIdCache;
  let id = '';
  try {
    if (process.platform === 'linux') {
      id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } else if (process.platform === 'darwin') {
      const out = firstWorking([['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], ['sysctl', '-n', 'kern.bootsessionuuid']]);
      id = out === 'failed' ? '' : out;
    }
  } catch {
    id = '';
  }
  bootIdCache = id === '' ? 'unknown' : id;
  return bootIdCache;
}

// /proc/<pid>/stat field 22 (starttime): clock ticks since boot. The comm field (2) may hold spaces and ')'.
export function parseStartTicks(stat: string): number | 'unknown' {
  const close = stat.lastIndexOf(')');
  if (close === -1) return 'unknown';
  const fields = stat.slice(close + 2).split(' ');   // fields[0] is field 3 (state)
  const raw = fields[22 - 3];
  const ticks = raw === undefined || !/^\d+$/.test(raw) ? NaN : Number(raw);
  return Number.isSafeInteger(ticks) ? ticks : 'unknown';
}

function linuxStartTicks(pid: number): number | 'unknown' {
  return parseStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'));
}

// Wall-clock ms: btime is recomputed from the current realtime clock on every read, so this moves with every clock
// step. Liveness compares processStartTicks instead whenever the lock carries ticks.
function linuxStartMs(pid: number): number | 'unknown' {
  const ticks = linuxStartTicks(pid);
  const btime = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1];
  if (ticks === 'unknown' || btime === undefined) return 'unknown';
  return Math.round((ticks / 100) * 1000 + Number(btime) * 1000);
}

// `ps -o etime=`: [[dd-]hh:]mm:ss
export function parseEtime(s: string): number | 'unknown' {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (m === null) return 'unknown';
  const [d, h, min, sec] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? '0')) as [number, number, number, number];
  return (((d * 24 + h) * 60 + min) * 60 + sec) * 1000;
}

function darwinStartMs(pid: number): number | 'unknown' {
  const out = firstWorking([['/bin/ps', '-o', 'etime=', '-p', String(pid)], ['ps', '-o', 'etime=', '-p', String(pid)]]);
  if (out === 'failed') return 'unknown';
  const elapsed = parseEtime(out);
  return elapsed === 'unknown' ? 'unknown' : Date.now() - elapsed;
}

export function processStartMs(pid: number): number | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    if (process.platform === 'linux') return linuxStartMs(pid);
    if (process.platform === 'darwin') return darwinStartMs(pid);
  } catch {
    // unreadable /proc entry (gone, hidepid): unknown
  }
  return 'unknown';
}

// linux only ('unknown' elsewhere): /proc/<pid>/stat field 22, the start time in clock ticks since boot.
export function processStartTicks(pid: number): number | 'unknown' {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'linux') return 'unknown';
  try {
    return linuxStartTicks(pid);
  } catch {
    return 'unknown';
  }
}

// Our own start time never changes; caching also keeps darwin's 1 s etime jitter out of repeated lock writes.
let ownStartCache: number | 'unknown' | undefined;
function ownProcStart(): number | 'unknown' {
  if (ownStartCache === undefined) ownStartCache = processStartMs(process.pid);
  return ownStartCache;
}

let ownTicksCache: number | 'unknown' | undefined;
function ownProcStartTicks(): number | 'unknown' {
  if (ownTicksCache === undefined) ownTicksCache = processStartTicks(process.pid);
  return ownTicksCache;
}

export type LivenessProbe = { selfPid: number; bootId(): string | 'unknown'; pidAlive(pid: number): boolean;
  processStartMs(pid: number): number | 'unknown'; processStartTicks(pid: number): number | 'unknown' };

// ownerLiveness with injected probes (unit tests).
export function livenessWith(owner: LockOwner, p: LivenessProbe): Liveness {
  if (owner.pid === p.selfPid) return 'stale-self-pid';
  const boot = p.bootId();
  if (owner.bootId !== 'unknown' && boot !== 'unknown' && owner.bootId !== boot) return 'stale-boot-id';
  if (!p.pidAlive(owner.pid)) return 'stale-dead-pid';
  // Boot ticks first: same boot (checked above) and exact, where wall-clock ms move with every clock step.
  if (owner.procStartTicks !== 'unknown') {
    const ticks = p.processStartTicks(owner.pid);
    if (ticks !== 'unknown') return ticks === owner.procStartTicks ? 'alive' : 'stale-pid-reused';
  }
  if (owner.procStart !== 'unknown') {
    const start = p.processStartMs(owner.pid);
    if (start !== 'unknown' && Math.abs(start - owner.procStart) > PROC_START_TOLERANCE_MS) return 'stale-pid-reused';
  }
  return 'alive';
}

export function ownerLiveness(owner: LockOwner): Liveness {
  return livenessWith(owner, { selfPid: process.pid, bootId: currentBootId, pidAlive, processStartMs, processStartTicks });
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and writing lock files

type RawRead = { raw: string; ino: number; mtimeMs: number };

// Content, inode and mtime from a single fd. ENOENT => 'none'; other errors are thrown.
function readRaw(fs: LockFs, path: string): RawRead | 'none' {
  let fd: number;
  try {
    fd = fs.openSync(path, 'r');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return 'none';
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    return { raw: fs.readFileSync(fd), ino: st.ino, mtimeMs: st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function parseOwner(raw: string): LockOwner | 'unparsable' {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return 'unparsable';
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'unparsable';
  const o = v as Record<string, unknown>;
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0 || typeof o.startedAt !== 'string') {
    return 'unparsable';
  }
  return {
    pid: o.pid,
    startedAt: o.startedAt,
    dir: typeof o.dir === 'string' ? o.dir : '',
    purpose: o.purpose === 'one-off' ? 'one-off' : 'daemon',
    bootId: typeof o.bootId === 'string' && o.bootId !== '' ? o.bootId : 'unknown',
    procStart: typeof o.procStart === 'number' && Number.isFinite(o.procStart) ? o.procStart : 'unknown',
    procStartTicks: typeof o.procStartTicks === 'number' && Number.isSafeInteger(o.procStartTicks) && o.procStartTicks >= 0
      ? o.procStartTicks : 'unknown',   // absent in locks written before ticks were recorded
  };
}

export function readLockOwner(lockPath: string): { owner: LockOwner; ino: number; raw: string } | 'none' | 'unparsable' {
  const r = readRaw(realFs, lockPath);
  if (r === 'none') return 'none';
  const owner = parseOwner(r.raw);
  return owner === 'unparsable' ? 'unparsable' : { owner, ino: r.ino, raw: r.raw };
}

// openSync(path,'wx') + write + fsync. EEXIST => 'exists'; a failed write removes the half-written file and throws.
function createExclusive(fs: LockFs, path: string, content: string): { ino: number } | 'exists' {
  let fd: number;
  try {
    fd = fs.openSync(path, 'wx');
  } catch (e) {
    if (errCode(e) === 'EEXIST') return 'exists';
    throw e;
  }
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
    const { ino } = fs.fstatSync(fd);
    fs.closeSync(fd);
    return { ino };
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(path); } catch { /* best effort */ }
    throw e;
  }
}

function unlinkIfPresent(fs: LockFs, path: string): void {
  try {
    fs.unlinkSync(path);
  } catch (e) {
    if (errCode(e) !== 'ENOENT') throw e;
  }
}

function makeHandle(fs: LockFs, path: string, ino: number, owner: LockOwner): LockHandle {
  let state: 'held' | 'released' = 'held';
  return {
    path,
    release(): void {
      if (state === 'released') return;
      state = 'released';
      try {
        const cur = readRaw(fs, path);
        if (cur === 'none' || cur.ino !== ino) return;
        const o = parseOwner(cur.raw);
        if (o !== 'unparsable' && o.pid === owner.pid && o.startedAt === owner.startedAt) fs.unlinkSync(path);
      } catch {
        // release runs from exit handlers: never throw
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Acquire

function unknownOwner(dir: string): LockOwner {
  return { pid: 0, startedAt: '', dir, purpose: 'daemon', bootId: 'unknown', procStart: 'unknown', procStartTicks: 'unknown' };
}

export function acquireLock(paths: StatePaths, realDir: string, purpose: LockPurpose, log: Logger,
  o: LockInternals = {}): AcquireResult {
  const fs = o.fs ?? realFs;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleepSync(ms));
  const selfPid = o.self?.pid ?? process.pid;
  const alive = o.pidAlive ?? pidAlive;
  const liveness = o.liveness
    ?? ((owner: LockOwner) => livenessWith(owner, { selfPid, bootId: currentBootId, pidAlive: alive, processStartMs,
      processStartTicks }));

  const me: LockOwner = {
    pid: selfPid,
    startedAt: new Date(now()).toISOString(),
    dir: realDir,
    purpose,
    bootId: o.self !== undefined ? o.self.bootId : currentBootId(),
    procStart: o.self !== undefined ? o.self.procStart : ownProcStart(),
    procStartTicks: o.self !== undefined ? (o.self.procStartTicks ?? 'unknown') : ownProcStartTicks(),
  };
  const content = JSON.stringify(me);
  const acquired = (ino: number): AcquireResult => ({ kind: 'acquired', handle: makeHandle(fs, paths.lock, ino, me) });

  // Step 5 helper: the takeover guard. 'held' means we created it and must unlink it.
  const takeGuard = (): 'held' | 'busy' => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (createExclusive(fs, paths.lockGuard, JSON.stringify({ pid: selfPid, at: new Date(now()).toISOString() })) !== 'exists') {
        return 'held';
      }
      if (attempt === 1) return 'busy';
      const g = readRaw(fs, paths.lockGuard);
      if (g !== 'none') {
        const gp = guardPid(g.raw);
        const dead = gp === 'unknown' || gp === selfPid || !alive(gp);
        if (now() - g.mtimeMs <= TAKEOVER_GUARD_STALE_MS || !dead) return 'busy';
        unlinkIfPresent(fs, paths.lockGuard);
      }
    }
    return 'busy';
  };

  let lastOwner: LockOwner = unknownOwner(realDir);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    // 1. create
    const created = createExclusive(fs, paths.lock, content);
    if (created !== 'exists') return acquired(created.ino);

    // 2. read the current owner (and its inode) from one fd
    let seen = readRaw(fs, paths.lock);
    if (seen === 'none') continue;
    let owner = parseOwner(seen.raw);

    // 3. unparsable: maybe mid-write; re-read, then judge by age
    let file: 'present' | 'vanished' = 'present';
    for (let i = 0; i < UNPARSABLE_RETRIES && owner === 'unparsable'; i++) {
      sleep(UNPARSABLE_RETRY_MS);
      const again = readRaw(fs, paths.lock);
      if (again === 'none') {
        file = 'vanished';
        break;
      }
      seen = again;
      owner = parseOwner(again.raw);
    }
    if (file === 'vanished') continue;

    let reason: Liveness;
    if (owner === 'unparsable') {
      if (now() - seen.mtimeMs <= UNPARSABLE_STALE_MS) return { kind: 'busy', owner: unknownOwner(realDir) };
      reason = 'stale-unparsable';
    } else {
      lastOwner = owner;
      // 4. a live owner wins
      reason = liveness(owner);
      if (reason === 'alive') return { kind: 'busy', owner };
    }

    // 5. take over under the guard, only if the lock is still exactly what we judged stale
    if (takeGuard() === 'busy') return { kind: 'busy', owner: lastOwner };
    let ino: number | 'retry' = 'retry';
    try {
      const now2 = readRaw(fs, paths.lock);
      if (now2 !== 'none' && now2.ino === seen.ino && now2.raw === seen.raw) {
        unlinkIfPresent(fs, paths.lock);
        log.warn('stale lock removed', { pid: owner === 'unparsable' ? 0 : owner.pid, path: paths.lock, reason });
        const mine = createExclusive(fs, paths.lock, content);
        if (mine !== 'exists') ino = mine.ino;
      }
    } finally {
      try { unlinkIfPresent(fs, paths.lockGuard); } catch { /* the lock outcome stands */ }
    }
    if (ino !== 'retry') return acquired(ino);
  }
  return { kind: 'busy', owner: lastOwner };
}

function guardPid(raw: string): number | 'unknown' {
  try {
    const v = JSON.parse(raw) as { pid?: unknown };
    return typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 ? v.pid : 'unknown';
  } catch {
    return 'unknown';
  }
}
