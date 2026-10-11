// SIGHUP config reload.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, startDaemon, type Daemon, type LogLine,
} from '../harness';

afterEach(cleanupAll);

const at = (l: LogLine): number => Date.parse(l.ts);

async function rewriteConfig(d: Daemon, patch: Record<string, unknown>): Promise<void> {
  const cfg = (await Bun.file(d.configPath).json()) as Record<string, unknown>;
  await Bun.write(d.configPath, `${JSON.stringify({ ...cfg, ...patch }, null, 2)}\n`);
}

// Runs `write`, waits for the idle backup run it causes, and returns ms from the change being seen (a `local change`,
// or a status check arming the timers: with the poll backend the watcher may never report a write that the reload's
// status check already saw) to the timer firing.
async function idleCommit(d: Daemon, write: () => Promise<void>): Promise<number> {
  const m = d.mark();
  await write();
  const change = await d.waitForLog((l) => is('local change')(l) || is('backup timers armed')(l), { since: m });
  const fired = await d.waitForLog(is('backup timer fired', { timer: 'idle' }), { since: m, timeoutMs: 30_000 });
  expect(await d.waitForSync({ since: m, reason: 'idle' })).toMatchObject({ outcome: 'ok', commitStep: 'committed' });
  return at(fired) - at(change);
}

test('SIGHUP applies a new idleMs live; an invalid file keeps the last good config', async () => {
  const t = await setupTestEnv('sighup-idle');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 60_000, maxWaitMs: 120_000 } });

  await rewriteConfig(A, { idleMs: 1500 });
  let m = A.mark();
  A.signal('SIGHUP');
  const reloaded = await A.waitForLog(is('config reloaded', { trigger: 'sighup' }), { since: m });
  expect(reloaded.changed).toEqual(['idleMs']);
  const first = await idleCommit(A, () => a.write('a.md', 'a\n'));
  expect(first).toBeGreaterThanOrEqual(1500 - 50);
  expect(first).toBeLessThan(20_000);   // not the 60 s it started with (poll: at least two scan intervals)

  await rewriteConfig(A, { idleMs: 'soon' });
  m = A.mark();
  A.signal('SIGHUP');
  const failed = await A.waitForLog(is('config reload failed', { trigger: 'sighup' }), { since: m });
  expect((failed.issues as string[]).some((i) => i.includes('idleMs'))).toBe(true);
  expect(A.logs.slice(m).some(is('config reloaded'))).toBe(false);
  // Still 1500 ms (the last good value), not the 60 s it started with or the 300 s default.
  const second = await idleCommit(A, () => a.write('b.md', 'b\n'));
  expect(second).toBeGreaterThanOrEqual(1500 - 50);
  expect(second).toBeLessThan(20_000);

  const log = await r.log();
  expect(log.slice(0, 2).map((c) => c.files)).toEqual([['b.md'], ['a.md']]);
  for (const c of log.slice(0, 2)) expect(c.subject).toMatch(/ \(auto\)$/);
  expect(A.proc.exitCode).toBeNull();
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'a.md', 'b.md'].includes(p));
}, 120_000);

test('a dir change on SIGHUP needs a restart; the daemon keeps syncing the original folder', async () => {
  const t = await setupTestEnv('sighup-dir');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });

  const elsewhere = join(t.root, 'elsewhere');
  await rewriteConfig(A, { dir: elsewhere });
  const m = A.mark();
  A.signal('SIGHUP');
  const restart = await A.waitForLog(is('config change requires restart'), { since: m });
  expect(restart.keys).toContain('dir');

  await a.write('c.md', 'still here\n');
  const f = await A.flush(['--wait']);
  expect({ code: f.code, stderr: f.stderr }).toEqual({ code: 0, stderr: f.stderr });
  expect(await r.show('c.md')).toBe('still here\n');
  expect(existsSync(elsewhere)).toBe(false);
  expect(A.proc.exitCode).toBeNull();
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'c.md'].includes(p));
}, 90_000);

// Open descriptors of a process: /proc on Linux, lsof elsewhere.
function openFds(pid: number): number {
  if (process.platform === 'linux') return readdirSync(`/proc/${pid}/fd`).length;
  const r = Bun.spawnSync(['lsof', '-n', '-P', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  return r.stdout.toString().split('\n').filter((l) => l.trim() !== '').length;
}

test('an ignore change on SIGHUP swaps the watcher matcher in place: no new watcher, no leaked descriptors', async () => {
  const t = await setupTestEnv('sighup-ignore');
  const files: Record<string, string> = { 'drafts/x.md': 'draft\n' };
  for (let i = 0; i < 30; i++) files[`d${i}/f.md`] = `f${i}\n`;
  const r = await createRemote(t, { files });
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 60_000, maxWaitMs: 120_000 } });
  await A.waitForSync({ reason: 'startup' });
  await Bun.sleep(500);
  const before = openFds(A.proc.pid);

  for (let i = 0; i < 6; i++) {
    await rewriteConfig(A, { ignore: i % 2 === 0 ? ['drafts'] : [] });
    const m = A.mark();
    A.signal('SIGHUP');
    expect((await A.waitForLog(is('config reloaded', { trigger: 'sighup' }), { since: m })).changed).toEqual(['ignore']);
  }
  await Bun.sleep(500);
  expect(A.logs.filter(is('watcher started')).length).toBe(1);
  // recreating the watcher per reload kept one descriptor per watched path on macOS (about 60 here, every time)
  expect(openFds(A.proc.pid) - before).toBeLessThan(30);

  // the final matcher (no ignore) is live: a draft edit arms the backup timers
  const m = A.mark();
  await a.write('drafts/x.md', 'edited\n');
  await A.waitForLog(is('local change'), { since: m });
  expect(A.proc.exitCode).toBeNull();
}, 120_000);
