// ntfy connect / reconnect catch-up runs.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { statePathsFor } from '../../src/paths';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier, runCli, setupTestEnv, startDaemon,
} from '../harness';

afterEach(cleanupAll);


test('every connect queues a catch-up run, and a dropped stream reconnects with another', async () => {
  const t = await setupTestEnv('ntfy-reconnect');
  const r = await createRemote(t);
  const n = await fakeNtfy();
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, ntfy: n });

  // First connect (startDaemon already waited for its catch-up run).
  const first = A.logs.findIndex(is('ntfy connected', { attempt: 'first' }));
  expect(first).toBeGreaterThanOrEqual(0);
  expect(A.logs.slice(first).some(is('sync queued', { trigger: 'ntfy-connect' }))).toBe(true);

  const m = A.mark();
  n.dropConnections();
  const disconnected = await A.waitForLog(is('ntfy disconnected'), { since: m });
  expect(typeof disconnected.retryInMs).toBe('number');
  const reconnected = await A.waitForLog(is('ntfy connected', { attempt: 'reconnect' }), { since: m, timeoutMs: 30_000 });
  expect(A.logs.indexOf(reconnected)).toBeGreaterThan(A.logs.indexOf(disconnected));
  await A.waitForLog(is('sync queued', { trigger: 'ntfy-reconnect' }), { since: A.logs.indexOf(reconnected) });
  expect(await A.waitForSync({ since: m, reason: 'ntfy-reconnect' })).toMatchObject({ kind: 'pull-only', outcome: 'ok' });
  await n.waitForConnections(1);

  // The new stream delivers pushes.
  remoteNotifier(r, n);
  const m2 = A.mark();
  const sha = await r.push({ 'remote.md': 'after reconnect\n' }, 'remote push');
  await A.waitForLog(is('ntfy event', { sha }), { since: m2 });
  await A.waitForSync({ since: m2, reason: 'ntfy' });
  expect(await a.read('remote.md')).toBe('after reconnect\n');
  expect(await a.head()).toBe(sha);

  // The state file records the subscription for other apps, and `status --json` reports it with the health verdict.
  const statePath = statePathsFor(a.dir, t.env).state;
  const stateText = readFileSync(statePath, 'utf8');
  expect((JSON.parse(stateText) as { ntfy: unknown }).ntfy).toMatchObject({ state: 'connected', reconnects: 1,
    lastEventSha: sha, lastError: expect.any(String), lastConnectedAt: expect.any(String),
    lastDisconnectedAt: expect.any(String), lastMessageAt: expect.any(String), lastEventAt: expect.any(String) });
  const status = await runCli(t, ['status', '--dir', a.dir, '--json']);
  const json = JSON.parse(status.stdout) as Record<string, unknown>;
  expect(json.ntfy).toMatchObject({ state: 'connected', lastEventSha: sha });
  expect(json.health).toMatchObject({ status: expect.stringMatching(/^(healthy|degraded)$/) });
  expect(json.fallbackMs).toEqual(expect.any(Number));

  // The topic is the shared secret: only the host is ever logged, stored or reported.
  const topic = n.topicUrl.slice(n.topicUrl.lastIndexOf('/') + 1);
  expect(JSON.stringify(A.logs)).not.toContain(topic);
  expect(A.stderr()).not.toContain(topic);
  expect(JSON.stringify((JSON.parse(stateText) as { ntfy: unknown }).ntfy)).not.toContain(topic);
  expect(status.stdout).not.toContain(topic);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'remote.md'].includes(p));
}, 90_000);

test('waking from sleep (here: SIGSTOP longer than the tick plus its slack) reconnects ntfy and pulls', async () => {
  // r3 mutation lens: a daemon that ignored every wake passed every test; only WakeDetector itself was tested.
  const t = await setupTestEnv('wake');
  const r = await createRemote(t);
  const ntfy = await fakeNtfy();
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, ntfy, env: { MDSYNC_TEST_WAKE_TICK_MS: '300' } });
  await A.waitForLog(is('ntfy connected', { attempt: 'first' }));
  process.kill(A.proc.pid, 'SIGSTOP');
  const sha = await r.push({ 'while-asleep.md': 'pushed while the laptop slept\n' }, 'while asleep');
  await Bun.sleep(3_000);   // > tick 300 ms + slack 1200 ms
  const m = A.mark();
  process.kill(A.proc.pid, 'SIGCONT');
  await A.waitForLog('wake detected', { since: m });
  await A.waitForLog(is('ntfy connected', { attempt: 'reconnect' }), { since: m });
  const run = await A.waitForSync({ since: m, reason: 'wake' });
  expect(['ok', 'conflict-resolved']).toContain(String(run.outcome));
  expect(await a.head()).toBe(sha);
  expect(await a.read('while-asleep.md')).toBe('pushed while the laptop slept\n');
}, 120_000);
