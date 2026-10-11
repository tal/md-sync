// Acceptance 1: a file written in A shows up in B, with ntfy simulated.
import { afterEach, expect, test } from 'bun:test';
import type { LogMsg } from '../../src/log';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier, setupTestEnv, startDaemon,
  type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

test('a file written in A shows up in B after an ntfy event', async () => {
  const t = await setupTestEnv('01-propagate');
  const remote = await createRemote(t);
  const ntfy = await fakeNtfy();
  remoteNotifier(remote, ntfy);
  const ca = await cloneRemote(t, remote, 'a');
  const cb = await cloneRemote(t, remote, 'b');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, ntfy });
  const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote, ntfy });

  const content = '# From A\n\nwritten in clone A\n';
  await ca.write('notes/a.md', content);
  const mB = B.mark();
  const flushed = await A.flush(['--wait']);
  expect(flushed.code).toBe(0);
  const pushed = await remote.head();
  expect(await remote.show('notes/a.md')).toBe(content);

  const t0 = Date.now();
  const event = await B.waitForLog(on('ntfy event'), { since: mB, timeoutMs: 15_000 });
  expect(event.sha).toBe(pushed);
  await B.waitForSync({ since: mB, reason: 'ntfy', timeoutMs: Math.max(1, 15_000 - (Date.now() - t0)) });
  expect(await cb.read('notes/a.md')).toBe(content);
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(await cb.head()).toBe(pushed);
  expect(await cb.porcelain()).toEqual([]);

  await expectNoMdsyncArtifacts(t, [ca, cb], remote, (p) => p === 'README.md' || p === 'notes/a.md');
}, 120_000);
