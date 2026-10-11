// Daemon liveness under folder churn, config reloads while the watcher is degraded, and files that are never staged.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, startDaemon, type Daemon, type LogLine,
} from '../harness';

afterEach(cleanupAll);

// Open descriptors of a process: /proc on Linux, lsof elsewhere.
function fdCount(pid: number): number {
  if (process.platform === 'linux') return readdirSync(`/proc/${pid}/fd`).length;
  const r = Bun.spawnSync(['lsof', '-p', String(pid)]);
  return r.stdout.toString().split('\n').filter((l) => l.trim() !== '').length - 1;
}

const count = (d: Daemon, msg: string, since = 0): number => d.logs.slice(since).filter((l) => l.msg === msg).length;

test('deleting and recreating a populated folder 50 times: the daemon keeps answering flushes, no descriptor creep', async () => {
  // On macOS, chokidar's per-path fs.watch deadlocked the event loop after 2 to 40 deletions: no runs, no IPC, SIGTERM
  // ignored, while `status` still said running. It also kept one descriptor per deleted folder.
  const t = await setupTestEnv('folder-churn');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const before = fdCount(A.proc.pid);
  for (let cycle = 0; cycle < 50; cycle++) {
    await Bun.spawn(['sh', '-c', 'mkdir -p "$0/proj" && for i in $(seq 0 29); do echo "c$1" > "$0/proj/x$i.md"; done',
      a.dir, String(cycle)]).exited;
    await Bun.sleep(150);
    await Bun.spawn(['rm', '-rf', join(a.dir, 'proj')]).exited;
    await Bun.sleep(150);
    if (cycle % 10 === 9) {
      await a.write(`probe-${cycle}.md`, `cycle ${cycle}\n`);
      const f = await A.flush(['--wait']);
      expect({ cycle, code: f.code, stderr: f.stderr.trim() }).toEqual({ cycle, code: 0, stderr: '' });
      expect(await r.show(`probe-${cycle}.md`)).toBe(`cycle ${cycle}\n`);
    }
  }
  await Bun.sleep(1_000);
  expect(fdCount(A.proc.pid) - before).toBeLessThan(15);
  expect(await A.stop()).toBe(0);   // and SIGTERM still works
  await expectNoMdsyncArtifacts(t, [a], r, (p) => p === 'README.md' || p.startsWith('probe-'));
}, 240_000);

test('config reloads never recreate the watcher, even while it is degraded', async () => {
  // Each reload while degraded used to close and recreate the watcher: one descriptor leaked per watched path (macOS),
  // and the new watcher hit the same error right away.
  const t = await setupTestEnv('degraded-reload');
  const r = await createRemote(t, { files: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`n${i}.md`, `${i}\n`])) });
  const a = await cloneRemote(t, r, 'A');
  mkdirSync(join(a.dir, 'locked'));
  writeFileSync(join(a.dir, 'locked', 'x.md'), 'x\n');
  chmodSync(join(a.dir, 'locked'), 0o000);   // an unreadable folder: chokidar (Linux) reports EACCES and degrades
  try {
    const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { ignore: ['drafts/**'] } });
    if (process.platform === 'linux') await A.waitForLog('watcher degraded');
    const started = count(A, 'watcher started');
    const fds = fdCount(A.proc.pid);
    for (let i = 0; i < 8; i++) {
      const config = JSON.parse(await Bun.file(A.configPath).text()) as Record<string, unknown>;
      config.ignore = i % 2 === 0 ? ['drafts/**', 'tmp/**'] : ['drafts/**'];
      writeFileSync(A.configPath, `${JSON.stringify(config, null, 2)}\n`);
      const m = A.mark();
      A.signal('SIGHUP');
      await A.waitForLog((l: LogLine) => l.msg === 'config reloaded' && Array.isArray(l.changed) && l.changed.includes('ignore'),
        { since: m });
    }
    await Bun.sleep(500);
    expect(count(A, 'watcher started')).toBe(started);
    expect(fdCount(A.proc.pid) - fds).toBeLessThan(10);
  } finally {
    chmodSync(join(a.dir, 'locked'), 0o755);
  }
}, 120_000);

test('a local-only conflict copy does not make every pull arm the backup timers and run an empty commit', async () => {
  const t = await setupTestEnv('local-only-quiet');
  const r = await createRemote(t, { files: { 'note.md': 'x\n', '.gitignore': 'secret.md\n' } });
  const a = await cloneRemote(t, r, 'A');
  await a.write('secret (conflict otherhost 2026-10-08 1200).md', 'local secret\n');   // what a collision or rescue leaves
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r,
    config: { idleMs: 1_000, maxWaitMs: 5_000, fallbackMs: 3_000 } });
  const m = A.mark();
  await A.waitForSync({ since: m, reason: 'fallback' });
  await A.waitForSync({ since: A.mark(), reason: 'fallback' });
  await Bun.sleep(2_000);   // an idle commit run would follow a fallback within idleMs
  const runs = A.logs.slice(m).filter((l) => l.msg === 'sync done');
  expect(runs.filter((l) => Array.isArray(l.reasons) && (l.reasons.includes('idle') || l.reasons.includes('max-wait')))).toEqual([]);
  expect(count(A, 'backup timers armed', m)).toBe(0);
  expect(await r.tree()).toEqual(['.gitignore', 'note.md']);
}, 60_000);

test('the liveness guard is armed in a running daemon (its worker reports in)', async () => {
  // r3 mutation lens: never starting the guard passed every test (liveness.test checks the guard on its own).
  const t = await setupTestEnv('liveness-armed');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const l = await A.waitForLog('liveness guard started');
  expect(l.stallMs).toBe(60_000);
  expect(A.logs.some((x) => x.msg === 'liveness guard unavailable')).toBe(false);
}, 60_000);
