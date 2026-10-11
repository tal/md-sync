// The Linux watcher backend (poll), run through the daemon on every platform (MDSYNC_TEST_WATCHER;
// review round 4): gitignored folders created after the start, writing sessions longer than idleMs, and a folder
// un-ignored by a reload.
import { afterEach, expect, test } from 'bun:test';
import { is, cleanupAll, cloneRemote, createRemote, type Daemon, setupTestEnv, startDaemon, waitFor } from '../harness';

afterEach(cleanupAll);

const POLL = { MDSYNC_TEST_WATCHER: 'poll' };

async function rewriteConfig(d: Daemon, patch: Record<string, unknown>): Promise<void> {
  const cfg = (await Bun.file(d.configPath).json()) as Record<string, unknown>;
  await Bun.write(d.configPath, `${JSON.stringify({ ...cfg, ...patch }, null, 2)}\n`);
}

test('a gitignored folder created after the start (npm install) is pruned from the scans', async () => {
  // r4: `status --ignored=matching` lists only folders that exist, and the list was refreshed only on a .gitignore
  // change: a 50k-file node_modules was scanned every 2 s until a restart (0.3% -> 15% of a core).
  const t = await setupTestEnv('poll-late-ignored');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', '.gitignore': 'node_modules/\n' } });
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: POLL });
  const m = A.mark();
  for (let i = 0; i < 50; i++) await a.write(`node_modules/pkg${i % 5}/f${i}.js`, `${i}\n`);
  const refreshed = await A.waitForLog((l) => is('ignored dirs refreshed')(l) && (l.dirs as string[]).includes('node_modules'),
    { since: m, timeoutMs: 20_000 });
  expect(refreshed.count).toBe(1);
  expect(A.logs.slice(m).some(is('backup timers armed'))).toBe(false);   // nothing to commit there
}, 60_000);

test('a writing session longer than idleMs is one backup commit, not one per poll interval', async () => {
  // r4: the idle timer ran from when a scan reported the writes; with writes every 400 ms and a scan every ~2.25 s,
  // idleMs 1500 expired between two scans: 5 (auto) commits for one burst.
  const t = await setupTestEnv('poll-burst');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: POLL, config: { idleMs: 1_500, maxWaitMs: 120_000 } });
  const m = A.mark();
  for (let i = 0; i < 16; i++) {
    await a.write(`burst/n${i}.md`, `note ${i}\n`);
    await Bun.sleep(400);
  }
  const lastWrite = Date.now();
  const fired = await A.waitForLog(is('backup timer fired', { timer: 'idle' }), { since: m, timeoutMs: 30_000 });
  expect(Date.parse(fired.ts)).toBeGreaterThanOrEqual(lastWrite);
  await A.waitForSync({ since: m, reason: 'idle', outcome: 'ok' });
  await Bun.sleep(1_000);
  expect(A.logs.slice(m).filter(is('backup timer fired'))).toHaveLength(1);
  const [newest] = await r.log();
  expect(newest?.files.length).toBe(16);
}, 90_000);

test('a note created in a folder a reload un-ignored, right after the reload, is committed', async () => {
  // r4: the first scan after the reload judged new entries by the old rules, so drafts/new.md was taken for a file
  // that predated the reload (covered by the reload's status check) and never reported; nothing armed the timers.
  const t = await setupTestEnv('poll-unignore');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: POLL,
    config: { idleMs: 1_500, maxWaitMs: 120_000, ignore: ['drafts'] } });
  await rewriteConfig(A, { ignore: [] });
  const m = A.mark();
  A.signal('SIGHUP');
  await A.waitForLog(is('config reloaded', { trigger: 'sighup' }), { since: m });
  await Bun.sleep(400);
  await a.write('drafts/new.md', 'new\n');
  await waitFor(async () => (await r.show('drafts/new.md')) === 'new\n' || undefined, { timeoutMs: 30_000, label: 'drafts/new.md pushed' });
  expect(await a.porcelain()).toEqual([]);
}, 60_000);
