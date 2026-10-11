import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type ChildRun = { proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>; lines: string[]; exited: Promise<number> };

// A child that starts the guard (stall 1.5 s, checks every 250 ms), then runs `body`.
function child(body: string): ChildRun {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-liveness-')));
  roots.push(dir);
  const script = join(dir, 'child.ts');
  writeFileSync(script, `
    import { startLivenessGuard } from ${JSON.stringify(resolve(import.meta.dir, '../../src/liveness.ts'))};
    startLivenessGuard({ stallMs: 1_500, beatMs: 100, checkMs: 250 });
    console.log('started');
    ${body}
  `);
  const proc = Bun.spawn(['bun', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const lines: string[] = [];
  const exited = (async () => {
    const text = await new Response(proc.stdout).text();
    lines.push(...text.split('\n').filter((l) => l !== ''));
    return proc.exited;
  })();
  return { proc, lines, exited };
}

async function withKill<T>(c: ChildRun, ms: number, p: Promise<T>): Promise<T> {
  const killer = setTimeout(() => c.proc.kill('SIGKILL'), ms);
  try {
    return await p;
  } finally {
    clearTimeout(killer);
  }
}

test('a main thread that stops running is killed (SIGKILL) and logs `event loop stalled`', async () => {
  // A blocked main thread ignores timers and JS signal handlers alike; only another thread can still act.
  const c = child(`
    process.on('SIGTERM', () => {});
    await Bun.sleep(500);
    const end = Date.now() + 30_000;
    while (Date.now() < end) { /* a native deadlock looks like this from JS */ }
    console.log('survived');
  `);
  const started = performance.now();
  await withKill(c, 20_000, c.exited);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(c.proc.signalCode).toBe('SIGKILL');
  expect(c.lines[0]).toBe('started');
  const stalled = JSON.parse(c.lines[1] ?? '{}') as Record<string, unknown>;
  expect(stalled).toMatchObject({ level: 'error', msg: 'event loop stalled' });
  expect(Object.keys(stalled).slice(0, 3)).toEqual(['ts', 'level', 'msg']);
  expect(stalled.stalledMs).toBeGreaterThanOrEqual(1_500);
  expect(c.lines).not.toContain('survived');
}, 30_000);

test('a healthy process is left alone, and the guard never keeps it alive', async () => {
  const c = child(`
    await Bun.sleep(4_000);
    console.log('done');
  `);
  expect(await withKill(c, 20_000, c.exited)).toBe(0);
  expect(c.lines).toEqual(['started', 'done']);
}, 30_000);

test('a suspended process (laptop sleep, SIGSTOP) is not mistaken for a stalled loop', async () => {
  const c = child(`
    for (let i = 0; i < 60; i++) await Bun.sleep(100);
    console.log('done');
  `);
  await Bun.sleep(800);
  c.proc.kill('SIGSTOP');
  await Bun.sleep(3_000);   // twice the stall limit
  c.proc.kill('SIGCONT');
  expect(await withKill(c, 20_000, c.exited)).toBe(0);
  expect(c.lines).toEqual(['started', 'done']);
}, 30_000);

test('onReady fires once the worker is running and watching', async () => {
  const { startLivenessGuard } = await import('../../src/liveness');
  let ready = 0;
  const g = startLivenessGuard({ stallMs: 60_000, onReady: () => { ready++; } });
  try {
    const end = Date.now() + 5_000;
    while (ready === 0 && Date.now() < end) await Bun.sleep(20);
    expect(ready).toBe(1);
  } finally {
    g.stop();
  }
});
