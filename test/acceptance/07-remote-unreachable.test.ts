// Acceptance 7: with the remote unreachable local commits pile up; once it is
// back, they all push, in order.
import { afterEach, expect, test } from 'bun:test';
import type { LogMsg } from '../../src/log';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, startDaemon, type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

test('commits pile up while the remote is unreachable, then all push in order', async () => {
  const t = await setupTestEnv('07-remote-unreachable');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
  const localBefore = (await ca.log()).length;
  const remoteBefore = await remote.log();

  await remote.setUnreachable();
  for (const round of [1, 2]) {
    await ca.write(`r${round}.md`, `round ${round}\n`);
    const m = A.mark();
    expect((await A.flush(['-m', `round ${round}`])).code).toBe(0);
    await A.waitForLog(on('committed', { subject: `round ${round}`, source: 'flush' }), { since: m });
    await A.waitForSync({ since: m, reason: 'flush', outcome: 'network-error' });
    await A.waitForLog(on('retry scheduled', { after: 'network-error' }), { since: m });
    expect((await ca.log()).length).toBe(localBefore + round);
  }
  expect((await remote.log()).map((c) => c.sha)).toEqual(remoteBefore.map((c) => c.sha));

  await remote.restore();
  const m = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(0);
  await A.waitForLog(on('pushed'), { since: m });

  const after = await remote.log();
  expect(after.length).toBe(remoteBefore.length + 2);
  expect(after.slice(0, 2).map((c) => c.subject)).toEqual(['round 2', 'round 1']);
  expect(after.slice(0, 2).map((c) => c.files)).toEqual([['r2.md'], ['r1.md']]);
  expect(await ca.head()).toBe(await remote.head());
  expect(await ca.porcelain()).toEqual([]);

  await expectNoMdsyncArtifacts(t, [ca], remote, (p) => ['README.md', 'r1.md', 'r2.md'].includes(p));
}, 120_000);

test('flushes during a short outage do not push the automatic retry out to the 10-minute cap', async () => {
  // Every failed run used to advance the backoff: six flushes in a second meant a retry 10 minutes later.
  const t = await setupTestEnv('07-backoff-flushes');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
  await remote.setUnreachable();
  const m = A.mark();
  for (let i = 0; i < 6; i++) {
    await ca.write(`f${i}.md`, `flush ${i}\n`);
    expect((await A.flush(['--wait'])).code).toBe(1);
  }
  // the client gets its result before the run's end hook logs the retry: wait for all six
  await A.waitForLog(() => A.logs.slice(m).filter(on('retry scheduled')).length >= 6, { since: m });
  const delays = A.logs.slice(m).filter(on('retry scheduled')).map((l) => Number(l.delayMs));
  expect(delays.length).toBe(6);
  expect(Math.max(...delays)).toBeLessThanOrEqual(30_000);
  await remote.restore();
  // no manual flush: the pending retry (≤ 30 s away) pulls and pushes everything
  const r = A.mark();
  await A.waitForLog(on('pushed'), { since: r, timeoutMs: 45_000 });
  expect((await remote.tree()).filter((p) => p.startsWith('f')).length).toBe(6);
  expect(await ca.head()).toBe(await remote.head());
}, 120_000);

test('a failed automatic retry doubles the next delay (30 s, then 60 s)', async () => {
  // r3 mutation lens: never advancing the backoff step (a retry every 30 s for good) passed every test.
  const t = await setupTestEnv('07-backoff-grows');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
  await remote.setUnreachable();
  await ca.write('f.md', 'f\n');
  const m = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(1);
  const first = await A.waitForLog(on('retry scheduled'), { since: m });
  expect(first.delayMs).toBe(30_000);
  const retryRun = await A.waitForSync({ since: m, reason: 'retry', timeoutMs: 45_000 });
  expect(retryRun.outcome).toBe('network-error');
  const second = await A.waitForLog(on('retry scheduled'), { since: A.logs.indexOf(retryRun) });
  expect(second.delayMs).toBe(60_000);
}, 120_000);
