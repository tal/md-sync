// A network change cuts the backoff short: a laptop that rejoins
// Wi-Fi pushes and resubscribes within seconds, not when the network backoff and the ntfy backoff run out.
import { afterEach, expect, test } from 'bun:test';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNetwork, fakeNtfy, setupTestEnv, startDaemon,
  type LogLine,
} from '../harness';

afterEach(cleanupAll);

const hasReason = (l: LogLine, r: string): boolean => Array.isArray(l.reasons) && (l.reasons as unknown[]).includes(r);
const at = (l: LogLine): number => Date.parse(l.ts);

test('rejoining a network pushes and reconnects ntfy at once, well before the scheduled retry', async () => {
  const t = await setupTestEnv('35-network-reconnect');
  const remote = await createRemote(t);
  const ntfy = await fakeNtfy();
  const net = fakeNetwork(t, ['en0|192.0.2.10']);
  const a = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote, ntfy, env: net.env });

  // The outage: the push fails, and the automatic retry is 30 s away.
  await remote.setUnreachable();
  await a.write('offline.md', 'written offline\n');
  const m = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(1);
  await A.waitForSync({ since: m, reason: 'flush', outcome: 'network-error' });
  const retry = await A.waitForLog(is('retry scheduled', { after: 'network-error' }), { since: m });
  expect(retry.delayMs).toBe(30_000);
  const due = at(retry) + Number(retry.delayMs);

  // Wi-Fi drops. A removal alone is no reason to sync.
  const down = A.mark();
  net.set([]);
  await Bun.sleep(1_500);   // 7 ticks of 200 ms: the empty snapshot has settled into the base
  expect(A.logs.slice(down).filter((l) => l.msg === 'network changed' || is('sync queued', { trigger: 'network' })(l)))
    .toEqual([]);

  // Wi-Fi is back, with the same address.
  await remote.restore();
  const up = A.mark();
  net.set(['en0|192.0.2.10']);
  const changed = await A.waitForLog('network changed', { since: up });
  expect(changed).toMatchObject({ level: 'info', added: 1, removed: 0 });
  await A.waitForLog(is('sync queued', { trigger: 'network' }), { since: up });
  const pushed = await A.waitForLog('pushed', { since: up });
  const run = await A.waitForLog((l) => l.msg === 'sync done' && hasReason(l, 'network'), { since: up });
  expect(run).toMatchObject({ outcome: 'ok', commitsOut: 1 });
  expect(hasReason(run, 'retry')).toBe(false);
  expect(A.logs.indexOf(pushed)).toBeLessThan(A.logs.indexOf(run));
  const reconnected = await A.waitForLog(is('ntfy connected', { attempt: 'reconnect' }), { since: up });

  // All of it well before the retry was due, and the retry never ran.
  for (const l of [changed, pushed, run, reconnected]) expect(due - at(l)).toBeGreaterThan(Number(retry.delayMs) / 2);
  expect(A.logs.slice(m).some((l) => l.msg === 'sync done' && hasReason(l, 'retry'))).toBe(false);
  expect(await remote.show('offline.md')).toBe('written offline\n');
  expect(await a.head()).toBe(await remote.head());

  // Counts only: never an address or an interface name.
  expect(JSON.stringify(A.logs)).not.toContain('192.0.2.10');
  expect(JSON.stringify(A.logs.filter((l) => l.msg === 'network changed'))).not.toContain('en0');
  await expectNoMdsyncArtifacts(t, [a], remote, (p) => ['README.md', 'offline.md'].includes(p));
}, 90_000);
