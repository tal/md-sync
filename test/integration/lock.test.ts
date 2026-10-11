import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync,
  utimesSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PROC_START_TOLERANCE_MS, TAKEOVER_GUARD_STALE_MS, acquireLock, currentBootId, livenessWith, ownerLiveness, parseEtime,
  parseStartTicks, pidAlive, processStartMs, processStartTicks, readLockOwner,
} from '../../src/lock';
import type { LivenessProbe, LockFs, LockInternals, LockOwner } from '../../src/lock';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { psStartMs } from '../harness';
import type { StatePaths } from '../../src/paths';

const LOCK_TS = resolve(import.meta.dir, '../../src/lock.ts');
const LOG_TS = resolve(import.meta.dir, '../../src/log.ts');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-lock-')));
const children = new Set<Bun.Subprocess>();

afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
let paths: StatePaths;
let dir: string;
beforeEach(() => {
  dir = join(root, `synced-${++n}`);
  paths = statePathsFor(dir, { HOME: root, XDG_STATE_HOME: join(root, 'state') });
  ensureStateDir(paths);
});
afterEach(() => {
  rmSync(paths.lock, { force: true });
  rmSync(paths.lockGuard, { force: true });
});

function capture() {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(l) });
  return { log, events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function sleeper(): Bun.Subprocess {
  const c = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
  children.add(c);
  return c;
}

async function deadPid(): Promise<number> {
  const c = Bun.spawn(['true']);
  await c.exited;
  return c.pid;
}

function ownerFor(pid: number, extra: Partial<LockOwner> = {}): LockOwner {
  return { pid, startedAt: new Date().toISOString(), dir, purpose: 'daemon', bootId: currentBootId(),
    procStart: processStartMs(pid), procStartTicks: 'unknown', ...extra };
}

function writeLock(content: LockOwner | string): void {
  writeFileSync(paths.lock, typeof content === 'string' ? content : JSON.stringify(content));
}

const noSleep: LockInternals = { sleep: () => {} };
const lockFileOwner = () => JSON.parse(readFileSync(paths.lock, 'utf8')) as LockOwner;

describe('probes', () => {
  test('pidAlive: self, EPERM (pid 1), dead, invalid', async () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(1)).toBe(true);                       // EPERM for non-root counts as alive
    expect(pidAlive(await deadPid())).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
  });

  test('currentBootId and processStartMs are known on this platform and stable', () => {
    const boot = currentBootId();
    expect(boot).not.toBe('unknown');
    expect(currentBootId()).toBe(boot);
    const start = processStartMs(process.pid);
    expect(typeof start).toBe('number');
    // not Date.now() - process.uptime(): on macOS uptime stops while the machine sleeps
    const expected = psStartMs(process.pid);
    expect(typeof expected).toBe('number');
    expect(Math.abs((start as number) - Number(expected))).toBeLessThan(3_000);
    expect(processStartMs(0)).toBe('unknown');
  });

  test('processStartMs of a fresh child is about now; of a dead pid unknown', async () => {
    const before = Date.now();
    const c = sleeper();
    const start = processStartMs(c.pid);
    expect(typeof start).toBe('number');
    expect(Math.abs((start as number) - before)).toBeLessThan(PROC_START_TOLERANCE_MS);
    c.kill('SIGKILL');
    await c.exited;
    expect(processStartMs(c.pid)).toBe('unknown');
  });

  test('parseEtime', () => {
    expect(parseEtime('00:00')).toBe(0);
    expect(parseEtime('05:03')).toBe(303_000);
    expect(parseEtime(' 1:02:03\n')).toBe(3_723_000);
    expect(parseEtime('2-01:02:03')).toBe((2 * 86_400 + 3_723) * 1000);
    expect(parseEtime('garbage')).toBe('unknown');
    expect(parseEtime('')).toBe('unknown');
  });
});

describe('ownerLiveness', () => {
  test('alive: a live pid with matching (or unknown) boot id and start time', () => {
    const c = sleeper();
    expect(ownerLiveness(ownerFor(c.pid))).toBe('alive');
    expect(ownerLiveness(ownerFor(c.pid, { bootId: 'unknown', procStart: 'unknown' }))).toBe('alive');
  });

  test('EPERM pid counts as alive', () => {
    expect(ownerLiveness(ownerFor(1, { procStart: 'unknown' }))).toBe('alive');
    expect(ownerLiveness(ownerFor(1))).toBe('alive');      // pid 1's real start time matches itself
  });

  test('stale reasons, checked in order', async () => {
    const c = sleeper();
    const dead = await deadPid();
    expect(ownerLiveness(ownerFor(process.pid, { bootId: 'other-boot' }))).toBe('stale-self-pid');
    expect(ownerLiveness(ownerFor(dead, { bootId: 'other-boot', procStart: 'unknown' }))).toBe('stale-boot-id');
    expect(ownerLiveness(ownerFor(c.pid, { bootId: 'other-boot' }))).toBe('stale-boot-id');
    expect(ownerLiveness(ownerFor(dead, { procStart: 'unknown' }))).toBe('stale-dead-pid');
    const real = processStartMs(c.pid) as number;
    expect(ownerLiveness(ownerFor(c.pid, { procStart: real - 60_000 }))).toBe('stale-pid-reused');
    expect(ownerLiveness(ownerFor(c.pid, { procStart: real + PROC_START_TOLERANCE_MS + 5_000 }))).toBe('stale-pid-reused');
    expect(ownerLiveness(ownerFor(c.pid, { procStart: real + 500 }))).toBe('alive');
  });
});

describe('acquireLock', () => {
  test('acquires a free lock and writes the owner record (fixed key order)', () => {
    const { log } = capture();
    const r = acquireLock(paths, dir, 'daemon', log);
    expect(r.kind).toBe('acquired');
    const raw = readFileSync(paths.lock, 'utf8');
    const o = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(o)).toEqual(['pid', 'startedAt', 'dir', 'purpose', 'bootId', 'procStart', 'procStartTicks']);
    expect(o).toMatchObject({ pid: process.pid, dir, purpose: 'daemon', bootId: currentBootId(),
      procStartTicks: processStartTicks(process.pid) });
    expect(typeof o.procStart).toBe('number');
    expect(r.kind === 'acquired' && r.handle.path).toBe(paths.lock);
    const read = readLockOwner(paths.lock);
    expect(read !== 'none' && read !== 'unparsable' && read.owner.pid).toBe(process.pid);
    expect(read !== 'none' && read !== 'unparsable' && read.raw).toBe(raw);
    if (r.kind === 'acquired') {
      r.handle.release();
      expect(existsSync(paths.lock)).toBe(false);
      r.handle.release();                                  // idempotent
    }
  });

  test('busy when a live process owns it; the file is untouched', () => {
    const c = sleeper();
    const owner = ownerFor(c.pid, { purpose: 'one-off' });
    writeLock(owner);
    const before = readFileSync(paths.lock, 'utf8');
    const r = acquireLock(paths, dir, 'daemon', capture().log);
    expect(r).toEqual({ kind: 'busy', owner });
    expect(readFileSync(paths.lock, 'utf8')).toBe(before);
  });

  test('busy for a lock held by another mdsync process; acquired after that process is killed', async () => {
    const script = `
      import { acquireLock } from ${JSON.stringify(LOCK_TS)};
      import { createLogger } from ${JSON.stringify(LOG_TS)};
      const r = acquireLock(JSON.parse(process.env.P), process.env.D, 'daemon', createLogger({ level: 'error', sink: 'stderr' }));
      console.log(r.kind);
      setInterval(() => {}, 1000);`;
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, P: JSON.stringify(paths), D: dir }, stdout: 'pipe', stderr: 'inherit',
    });
    children.add(child);
    const reader = child.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.trim()).toBe('acquired');

    const busy = acquireLock(paths, dir, 'one-off', capture().log);
    expect(busy.kind).toBe('busy');
    expect(busy.kind === 'busy' && busy.owner).toMatchObject({ pid: child.pid, purpose: 'daemon' });

    child.kill('SIGKILL');
    await child.exited;
    const { log, events } = capture();
    const r = acquireLock(paths, dir, 'one-off', log);
    expect(r.kind).toBe('acquired');
    expect(lockFileOwner()).toMatchObject({ pid: process.pid, purpose: 'one-off' });
    expect(events()).toEqual([expect.objectContaining({
      level: 'warn', msg: 'stale lock removed', pid: child.pid, path: paths.lock, reason: 'stale-dead-pid',
    })]);
    if (r.kind === 'acquired') r.handle.release();
  });

  test('stale: dead pid, self pid, boot id, pid reuse', async () => {
    const c = sleeper();
    const cases: [LockOwner, string][] = [
      [ownerFor(await deadPid(), { procStart: 'unknown' }), 'stale-dead-pid'],
      [ownerFor(process.pid), 'stale-self-pid'],
      [ownerFor(c.pid, { bootId: 'a-previous-boot' }), 'stale-boot-id'],
      [ownerFor(c.pid, { procStart: (processStartMs(c.pid) as number) - 3_600_000 }), 'stale-pid-reused'],
    ];
    for (const [owner, reason] of cases) {
      writeLock(owner);
      const { log, events } = capture();
      const r = acquireLock(paths, dir, 'daemon', log);
      expect(r.kind).toBe('acquired');
      expect(events()).toEqual([expect.objectContaining({ msg: 'stale lock removed', pid: owner.pid, reason })]);
      expect(lockFileOwner().pid).toBe(process.pid);
      expect(existsSync(paths.lockGuard)).toBe(false);
      if (r.kind === 'acquired') r.handle.release();
    }
  });

  test('unparsable and older than 5 s => stale-unparsable', () => {
    writeLock('{"pid": 12');
    const old = (Date.now() - 10_000) / 1000;
    utimesSync(paths.lock, old, old);
    let sleeps = 0;
    const { log, events } = capture();
    const r = acquireLock(paths, dir, 'daemon', log, { sleep: () => { sleeps++; } });
    expect(r.kind).toBe('acquired');
    expect(sleeps).toBe(5);
    expect(events()).toEqual([expect.objectContaining({ msg: 'stale lock removed', pid: 0, reason: 'stale-unparsable' })]);
    if (r.kind === 'acquired') r.handle.release();
  });

  test('unparsable and fresh => busy with pid 0, after 5 re-reads 100 ms apart', () => {
    writeLock('');
    const waits: number[] = [];
    const r = acquireLock(paths, dir, 'daemon', capture().log, { sleep: (ms) => { waits.push(ms); } });
    expect(r.kind).toBe('busy');
    expect(r.kind === 'busy' && r.owner.pid).toBe(0);
    expect(waits).toEqual([100, 100, 100, 100, 100]);
    expect(readFileSync(paths.lock, 'utf8')).toBe('');
  });

  test('an unparsable lock that finishes being written during the re-reads is judged normally', () => {
    const c = sleeper();
    const owner = ownerFor(c.pid);
    writeLock('');
    let calls = 0;
    const r = acquireLock(paths, dir, 'daemon', capture().log, { sleep: () => { if (++calls === 2) writeLock(owner); } });
    expect(r).toEqual({ kind: 'busy', owner });
    expect(calls).toBe(2);
  });

  test('a lock that disappears during the re-reads is simply created', () => {
    writeLock('');
    const r = acquireLock(paths, dir, 'daemon', capture().log, { sleep: () => rmSync(paths.lock, { force: true }) });
    expect(r.kind).toBe('acquired');
    if (r.kind === 'acquired') r.handle.release();
  });

  test('unrelated fs errors are thrown', () => {
    const missing = statePathsFor(join(root, 'x'), { HOME: root, XDG_STATE_HOME: join(root, 'no-such-state') });
    expect(() => acquireLock(missing, dir, 'daemon', capture().log)).toThrow();
  });
});

describe('release', () => {
  function acquire() {
    const r = acquireLock(paths, dir, 'daemon', capture().log);
    if (r.kind !== 'acquired') throw new Error('expected acquired');
    return r.handle;
  }

  test('does not remove a lock file that was replaced (different inode)', () => {
    const h = acquire();
    const mine = readFileSync(paths.lock, 'utf8');
    unlinkSync(paths.lock);
    writeFileSync(paths.lock, mine);                     // same bytes, new inode
    h.release();
    expect(existsSync(paths.lock)).toBe(true);
  });

  test('does not remove our inode once its pid or startedAt changed', () => {
    for (const patch of [{ pid: 4242 }, { startedAt: '2000-01-01T00:00:00.000Z' }]) {
      const h = acquire();
      writeFileSync(paths.lock, JSON.stringify({ ...lockFileOwner(), ...patch }));   // truncate in place: same inode
      h.release();
      expect(existsSync(paths.lock)).toBe(true);
      rmSync(paths.lock);
    }
  });

  test('a lock that is already gone is fine', () => {
    const h = acquire();
    unlinkSync(paths.lock);
    expect(() => h.release()).not.toThrow();
  });
});

describe('takeover guard', () => {
  test('an abandoned guard (old, dead pid) is removed and the takeover proceeds', async () => {
    writeLock(ownerFor(await deadPid(), { procStart: 'unknown' }));
    writeFileSync(paths.lockGuard, JSON.stringify({ pid: await deadPid(), at: new Date().toISOString() }));
    const old = (Date.now() - TAKEOVER_GUARD_STALE_MS - 5_000) / 1000;
    utimesSync(paths.lockGuard, old, old);
    const r = acquireLock(paths, dir, 'daemon', capture().log);
    expect(r.kind).toBe('acquired');
    expect(existsSync(paths.lockGuard)).toBe(false);
    if (r.kind === 'acquired') r.handle.release();
  });

  test('an abandoned guard with unparsable content counts as dead', async () => {
    writeLock(ownerFor(await deadPid(), { procStart: 'unknown' }));
    writeFileSync(paths.lockGuard, '');
    const old = (Date.now() - TAKEOVER_GUARD_STALE_MS - 5_000) / 1000;
    utimesSync(paths.lockGuard, old, old);
    expect(acquireLock(paths, dir, 'daemon', capture().log).kind).toBe('acquired');
  });

  test('a fresh guard, or an old one whose pid is alive, means busy and is left alone', async () => {
    const c = sleeper();
    const stale = ownerFor(await deadPid(), { procStart: 'unknown' });
    writeLock(stale);
    writeFileSync(paths.lockGuard, JSON.stringify({ pid: await deadPid(), at: new Date().toISOString() }));
    expect(acquireLock(paths, dir, 'daemon', capture().log)).toEqual({ kind: 'busy', owner: stale });
    expect(existsSync(paths.lockGuard)).toBe(true);

    writeFileSync(paths.lockGuard, JSON.stringify({ pid: c.pid, at: new Date().toISOString() }));
    const old = (Date.now() - TAKEOVER_GUARD_STALE_MS - 5_000) / 1000;
    utimesSync(paths.lockGuard, old, old);
    expect(acquireLock(paths, dir, 'daemon', capture().log).kind).toBe('busy');
    expect(existsSync(paths.lockGuard)).toBe(true);
    expect(JSON.parse(readFileSync(paths.lock, 'utf8'))).toEqual(stale);
  });
});

describe('interleaved acquirers (injected fs)', () => {
  const DEAD = 999_001;
  const A = 999_101;
  const B = 999_102;
  // Owners other than DEAD are alive; the self-pid rule still applies through `self`.
  const liveness = (o: LockOwner) => (o.pid === DEAD ? 'stale-dead-pid' as const : 'alive' as const);
  const self = (pid: number) => ({ pid, bootId: 'boot', procStart: 1 });

  const realFs: LockFs = {
    openSync: (p, f) => openSync(p, f, 0o600),
    writeSync: (fd, d) => writeSync(fd, d),
    fsyncSync: (fd) => fsyncSync(fd),
    fstatSync: (fd) => fstatSync(fd),
    readFileSync: (fd) => readFileSync(fd, 'utf8'),
    closeSync: (fd) => closeSync(fd),
    unlinkSync: (p) => unlinkSync(p),
  };

  // Runs `hook` once, just before the n-th matching open on `path` with `flags`.
  function hookedFs(path: () => string, flags: 'wx' | 'r', nth: number, hook: () => void): LockFs {
    let seen = 0;
    return {
      ...realFs,
      openSync: (p, f) => {
        if (p === path() && f === flags && ++seen === nth) hook();
        return realFs.openSync(p, f);
      },
    };
  }

  test('both read a dead owner; B completes its takeover before A takes the guard => only B acquires', () => {
    writeLock(ownerFor(DEAD, { procStart: 'unknown' }));
    let b: ReturnType<typeof acquireLock> | undefined;
    const fsA = hookedFs(() => paths.lockGuard, 'wx', 1, () => {
      b = acquireLock(paths, dir, 'daemon', capture().log, { ...noSleep, self: self(B), liveness });
    });
    const { log, events } = capture();
    const a = acquireLock(paths, dir, 'daemon', log, { ...noSleep, fs: fsA, self: self(A), liveness });
    expect(b?.kind).toBe('acquired');
    expect(a.kind).toBe('busy');
    expect(a.kind === 'busy' && a.owner.pid).toBe(B);
    expect(lockFileOwner().pid).toBe(B);
    expect(events().filter((e) => e.msg === 'stale lock removed')).toEqual([]);   // A removed nothing
    expect(existsSync(paths.lockGuard)).toBe(false);
  });

  test('B arrives while A holds the guard => B is busy, A acquires', () => {
    writeLock(ownerFor(DEAD, { procStart: 'unknown' }));
    let b: ReturnType<typeof acquireLock> | undefined;
    // A's 2nd read-open of the lock is the re-read under the guard.
    const fsA = hookedFs(() => paths.lock, 'r', 2, () => {
      expect(existsSync(paths.lockGuard)).toBe(true);
      b = acquireLock(paths, dir, 'daemon', capture().log, { ...noSleep, self: self(B), liveness });
    });
    const a = acquireLock(paths, dir, 'daemon', capture().log, { ...noSleep, fs: fsA, self: self(A), liveness });
    expect(a.kind).toBe('acquired');
    expect(b?.kind).toBe('busy');
    expect(lockFileOwner().pid).toBe(A);
    expect(existsSync(paths.lockGuard)).toBe(false);
  });

  test('a lock re-created between our unlink and create sends us back to step 1', () => {
    writeLock(ownerFor(DEAD, { procStart: 'unknown' }));
    // A's 2nd exclusive create of the lock is the one right after its unlink; B sneaks in first (no guard needed).
    const fsA = hookedFs(() => paths.lock, 'wx', 2, () => {
      expect(acquireLock(paths, dir, 'daemon', capture().log, { ...noSleep, self: self(B), liveness }).kind).toBe('acquired');
    });
    const a = acquireLock(paths, dir, 'daemon', capture().log, { ...noSleep, fs: fsA, self: self(A), liveness });
    expect(a.kind === 'busy' && a.owner.pid).toBe(B);
    expect(lockFileOwner().pid).toBe(B);
    expect(existsSync(paths.lockGuard)).toBe(false);
  });

  test('gives up after 3 passes when the lock keeps flickering', () => {
    let creates = 0;
    const flicker: LockFs = {
      ...realFs,
      openSync: (p, f) => {
        if (p === paths.lock && f === 'wx') {
          creates++;
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        }
        if (p === paths.lock && f === 'r') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return realFs.openSync(p, f);
      },
    };
    const r = acquireLock(paths, dir, 'daemon', capture().log, { ...noSleep, fs: flicker });
    expect(r.kind).toBe('busy');
    expect(creates).toBe(3);
  });
});

describe('linux start time: boot ticks, not wall-clock ms', () => {
  test('parseStartTicks reads field 22 even when comm holds spaces and parens', () => {
    const rest = 'S 1 1234 1234 0 -1 4194560 2219 0 0 0 7 3 0 0 20 0 1 0 987654 12345678 900';
    expect(parseStartTicks(`4242 (bun) ${rest}`)).toBe(987654);
    expect(parseStartTicks(`4242 (we(ird) name)) ${rest}`)).toBe(987654);
    expect(parseStartTicks('4242 (bun) S 1')).toBe('unknown');
    expect(parseStartTicks('garbage')).toBe('unknown');
  });

  // /proc/stat btime is recomputed from the realtime clock on every read, so an NTP step or `date -s` moves every
  // ms start time computed from it, for live processes too.
  const live = (o: { ms: number | 'unknown'; ticks: number | 'unknown' }): LivenessProbe => ({
    selfPid: 1, bootId: () => 'boot', pidAlive: () => true, processStartMs: () => o.ms, processStartTicks: () => o.ticks });
  const owner: LockOwner = { pid: 4242, startedAt: '2026-10-08T00:00:00.000Z', dir: '/d', purpose: 'daemon', bootId: 'boot',
    procStart: 1_790_001_234_560, procStartTicks: 987_654 };

  test('a wall-clock step after the owner started does not make a live lock look stale', () => {
    expect(livenessWith(owner, live({ ms: owner.procStart as number + 5_000, ticks: 987_654 }))).toBe('alive');
    expect(livenessWith(owner, live({ ms: owner.procStart as number - 86_400_000, ticks: 987_654 }))).toBe('alive');
  });

  test('different boot ticks are a reused pid, whatever the ms say', () => {
    expect(livenessWith(owner, live({ ms: owner.procStart as number, ticks: 987_655 }))).toBe('stale-pid-reused');
  });

  test('a lock without ticks (older mdsync, or darwin) falls back to ms within the tolerance', () => {
    const legacy: LockOwner = { ...owner, procStartTicks: 'unknown' };
    expect(livenessWith(legacy, live({ ms: owner.procStart as number + 500, ticks: 987_654 }))).toBe('alive');
    expect(livenessWith(legacy, live({ ms: owner.procStart as number + PROC_START_TOLERANCE_MS + 1, ticks: 987_654 })))
      .toBe('stale-pid-reused');
    expect(livenessWith(owner, live({ ms: owner.procStart as number + 500, ticks: 'unknown' }))).toBe('alive');
  });

  test('processStartTicks is a number on linux, unknown elsewhere', () => {
    expect(typeof processStartTicks(process.pid)).toBe(process.platform === 'linux' ? 'number' : 'string');
    expect(processStartTicks(0)).toBe('unknown');
  });

  test('a lock file without procStartTicks parses as unknown ticks', () => {
    writeLock(JSON.stringify({ pid: process.ppid, startedAt: 'x', dir, purpose: 'daemon', bootId: 'b', procStart: 1 }));
    const read = readLockOwner(paths.lock);
    expect(read !== 'none' && read !== 'unparsable' ? read.owner.procStartTicks : read).toBe('unknown');
  });
});
