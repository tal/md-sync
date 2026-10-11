import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DRAIN_MS, KILL_GRACE_MS, LOCAL_TIMEOUT_MS, SpawnNotFoundError, killChildrenGracefully, liveChildPids, spawnTracked,
} from '../../src/spawn';

const SPAWN_TS = resolve(import.meta.dir, '../../src/spawn.ts');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-spawn-')));
const leftoverGroups = new Set<number>();
const dec = new TextDecoder();
const env = { ...process.env };

afterAll(() => {
  for (const pgid of leftoverGroups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  rmSync(root, { recursive: true, force: true });
});

// spawnTracked registers the child synchronously, so the new pid is visible right after the call.
function spawnAndCapturePid(argv: string[], o: Parameters<typeof spawnTracked>[1]) {
  const before = new Set(liveChildPids());
  const promise = spawnTracked(argv, o);
  const pid = [...liveChildPids()].find((p) => !before.has(p));
  return { promise, pid };
}

function pgidOf(pid: number): number {
  const r = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]);
  return Number(r.stdout.toString().trim());
}

describe('constants', () => {
  test('pinned values', () => {
    expect(LOCAL_TIMEOUT_MS).toBe(300_000);
    expect(KILL_GRACE_MS).toBe(5_000);
    expect(DRAIN_MS).toBe(2_000);
  });
});

describe('stallMs (no-output limit)', () => {
  test('output keeps a long child alive; silence kills it; timeoutMs still bounds the whole run', async () => {
    const ticking = await spawnTracked(['sh', '-c', 'for i in 1 2 3 4 5 6 7; do echo tick >&2; sleep 0.2; done'],
      { cwd: root, env, timeoutMs: 10_000, stallMs: 600 });
    expect({ code: ticking.code, timedOut: ticking.timedOut }).toEqual({ code: 0, timedOut: 'in-time' });
    const t0 = performance.now();
    const silent = await spawnTracked(['sh', '-c', 'sleep 5'], { cwd: root, env, timeoutMs: 10_000, stallMs: 400 });
    expect(silent.timedOut).toBe('timed-out');
    expect(performance.now() - t0).toBeLessThan(4_000);
    const whole = await spawnTracked(['sh', '-c', 'while :; do echo tick; sleep 0.1; done'],
      { cwd: root, env, timeoutMs: 700, stallMs: 400 });
    expect(whole.timedOut).toBe('timed-out');
  }, 30_000);
});

describe('spawnTracked basics', () => {
  test('pipes input to stdin and collects stdout as bytes', async () => {
    const input = new Uint8Array([0x61, 0x0d, 0x0a, 0x00, 0xff, 0x62]);   // CRLF, NUL and a non-UTF-8 byte survive
    const r = await spawnTracked(['cat'], { cwd: root, env, input, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect([...r.stdout]).toEqual([...input]);
    expect(r.stderr.byteLength).toBe(0);
    expect(r.timedOut).toBe('in-time');
    expect(r.drain).toBe('complete');
    expect(r.spawnError).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('stdin is ignored (EOF) without input', async () => {
    const r = await spawnTracked(['cat'], { cwd: root, env, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.byteLength).toBe(0);
  });

  test('reports a non-zero exit code and stderr', async () => {
    const r = await spawnTracked(['sh', '-c', 'echo oops >&2; exit 3'], { cwd: root, env, timeoutMs: 10_000 });
    expect(r.code).toBe(3);
    expect(dec.decode(r.stderr)).toBe('oops\n');
    expect(r.timedOut).toBe('in-time');
  });

  test('uses cwd and env (undefined values dropped)', async () => {
    const r = await spawnTracked(['sh', '-c', 'pwd; printf "%s|%s" "$MDSYNC_T1" "${MDSYNC_T2-unset}"'],
      { cwd: root, env: { ...env, MDSYNC_T1: 'one', MDSYNC_T2: undefined }, timeoutMs: 10_000 });
    expect(dec.decode(r.stdout)).toBe(`${root}\none|unset`);
  });

  test('collects large output completely', async () => {
    const r = await spawnTracked(['head', '-c', '3000000', '/dev/zero'], { cwd: root, env, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    expect(r.stdout.byteLength).toBe(3_000_000);
    expect(r.drain).toBe('complete');
  });

  test('registry holds the pid only while the child runs', async () => {
    const { promise, pid } = spawnAndCapturePid(['sleep', '0.3'], { cwd: root, env, timeoutMs: 10_000 });
    expect(pid).toBeDefined();
    expect(liveChildPids().has(pid!)).toBe(true);
    await promise;
    await Bun.sleep(10);
    expect(liveChildPids().has(pid!)).toBe(false);
  });
});

describe('detached children', () => {
  test('each child leads its own process group', async () => {
    const { promise, pid } = spawnAndCapturePid(['sleep', '0.5'], { cwd: root, env, timeoutMs: 10_000 });
    expect(pgidOf(pid!)).toBe(pid!);
    expect(pgidOf(pid!)).not.toBe(pgidOf(process.pid));
    await promise;
  });

  test('a detached child survives a SIGINT sent to our process group (terminal Ctrl-C)', async () => {
    const helper = join(root, 'sigint-helper.ts');
    writeFileSync(helper, `
import { spawnTracked } from ${JSON.stringify(SPAWN_TS)};
process.on('SIGINT', () => { console.log(JSON.stringify({ sigint: 'received' })); });
const tracked = spawnTracked(['sh', '-c', 'sleep 1; echo survived'], { cwd: '/', env: process.env, timeoutMs: 20000 });
// control: a non-detached child shares our group and must die from the same SIGINT
const plain = Bun.spawn(['sh', '-c', 'sleep 1; echo plain'], { stdout: 'pipe', stderr: 'ignore' });
console.log(JSON.stringify({ ready: 'yes' }));
const r = await tracked;
await plain.exited;
console.log(JSON.stringify({ code: r.code, out: new TextDecoder().decode(r.stdout), plainSignal: plain.signalCode ?? 'none' }));
`);
    const proc = Bun.spawn([process.execPath, helper], { cwd: root, stdout: 'pipe', stderr: 'pipe', detached: true });
    leftoverGroups.add(proc.pid);
    const reader = proc.stdout.getReader();
    let text = '';
    while (!text.includes('"ready"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += dec.decode(chunk.value);
    }
    expect(text).toContain('"ready"');
    await Bun.sleep(100);
    process.kill(-proc.pid, 'SIGINT');
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += dec.decode(chunk.value);
    }
    expect(await proc.exited).toBe(0);
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toContainEqual({ sigint: 'received' });
    expect(lines.at(-1)).toEqual({ code: 0, out: 'survived\n', plainSignal: 'SIGINT' });
  });
});

describe('timeouts', () => {
  test('timeout sends SIGTERM to the group', async () => {
    const r = await spawnTracked(['sleep', '30'], { cwd: root, env, timeoutMs: 200 });
    expect(r.timedOut).toBe('timed-out');
    expect(r.code).toBe(143);
    expect(r.durationMs).toBeLessThan(KILL_GRACE_MS);
  });

  test('a child ignoring SIGTERM gets SIGKILL after KILL_GRACE_MS', async () => {
    const t0 = Date.now();
    const r = await spawnTracked(['sh', '-c', 'trap "" TERM; sleep 30; true'], { cwd: root, env, timeoutMs: 200 });
    expect(r.timedOut).toBe('timed-out');
    expect(r.code).toBe(137);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(KILL_GRACE_MS);
  }, 20_000);

  test('timeout kills grandchildren too (whole group)', async () => {
    const marker = join(root, 'grandchild-alive');
    const { promise, pid } = spawnAndCapturePid(['sh', '-c', `(sleep 2; touch '${marker}') & sleep 30`],
      { cwd: root, env, timeoutMs: 200 });
    const r = await promise;
    expect(r.timedOut).toBe('timed-out');
    await Bun.sleep(2_500);
    expect(await Bun.file(marker).exists()).toBe(false);
    leftoverGroups.add(pid!);
  }, 10_000);
});

describe('drain', () => {
  test('a grandchild holding the pipes open truncates the drain after DRAIN_MS', async () => {
    const { promise, pid } = spawnAndCapturePid(['sh', '-c', 'sleep 30 & echo out'], { cwd: root, env, timeoutMs: 10_000 });
    leftoverGroups.add(pid!);
    const r = await promise;
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe('in-time');
    expect(r.drain).toBe('truncated');
    expect(dec.decode(r.stdout)).toBe('out\n');
    expect(r.durationMs).toBeGreaterThanOrEqual(DRAIN_MS - 50);
    expect(r.durationMs).toBeLessThan(DRAIN_MS + 2_000);
  }, 10_000);
});

describe('spawn errors', () => {
  test('a missing executable throws SpawnNotFoundError', async () => {
    const p = spawnTracked(['mdsync-no-such-binary-xyz'], { cwd: root, env, timeoutMs: 1_000 });
    await expect(p).rejects.toBeInstanceOf(SpawnNotFoundError);
    await p.catch((e: SpawnNotFoundError) => expect(e.file).toBe('mdsync-no-such-binary-xyz'));
  });

  test('a missing absolute executable throws SpawnNotFoundError', async () => {
    await expect(spawnTracked([join(root, 'nope', 'git')], { cwd: root, env, timeoutMs: 1_000 }))
      .rejects.toBeInstanceOf(SpawnNotFoundError);
  });

  test('a non-executable file is a spawnError result, not a throw', async () => {
    const script = join(root, 'not-executable.sh');
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    chmodSync(script, 0o644);
    const r = await spawnTracked([script], { cwd: root, env, timeoutMs: 1_000 });
    expect(r.code).toBe(-1);
    expect(r.spawnError).toMatch(/EACCES|permission/i);
    expect(r.timedOut).toBe('in-time');
    expect(r.stdout.byteLength).toBe(0);
  });

  test('a missing cwd is a spawnError result, not SpawnNotFoundError', async () => {
    const r = await spawnTracked(['echo', 'hi'], { cwd: join(root, 'missing-dir'), env, timeoutMs: 1_000 });
    expect(r.code).toBe(-1);
    expect(r.spawnError).toContain('cwd not found');
  });
});

describe('killChildrenGracefully', () => {
  test('SIGTERMs every live group; results report 143, not a timeout', async () => {
    const a = spawnTracked(['sleep', '30'], { cwd: root, env, timeoutMs: 60_000 });
    const b = spawnTracked(['sleep', '30'], { cwd: root, env, timeoutMs: 60_000 });
    await Bun.sleep(50);
    const t0 = Date.now();
    await killChildrenGracefully(1_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.code).toBe(143);
    expect(rb.code).toBe(143);
    expect(ra.timedOut).toBe('in-time');
  });

  test('SIGKILLs a group that ignores SIGTERM after the grace period', async () => {
    const p = spawnTracked(['sh', '-c', 'trap "" TERM; sleep 30; true'], { cwd: root, env, timeoutMs: 60_000 });
    await Bun.sleep(100);
    const t0 = Date.now();
    await killChildrenGracefully(300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    const r = await p;
    expect(r.code).toBe(137);
  });

  test('is a no-op with no children', async () => {
    await killChildrenGracefully(10);
  });
});
