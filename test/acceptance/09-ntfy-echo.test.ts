// Acceptance 9: a daemon's own ntfy echo doesn't trigger a redundant sync,
// while another daemon on the same topic does sync.
import { afterEach, expect, test } from 'bun:test';
import type { LogMsg } from '../../src/log';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier, setupTestEnv, startDaemon,
  type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

const ECHO_WINDOW_MS = 2_000;

test("a daemon's own ntfy echo is ignored", async () => {
  const t = await setupTestEnv('09-ntfy-echo');
  const remote = await createRemote(t);
  const ntfy = await fakeNtfy();
  remoteNotifier(remote, ntfy);
  const ca = await cloneRemote(t, remote, 'a');
  const cb = await cloneRemote(t, remote, 'b');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, ntfy });
  const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote, ntfy });

  const m = A.mark();
  const mB = B.mark();
  await ca.write('echo.md', 'pushed by A\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  const pushed = await remote.head();
  expect(await ca.head()).toBe(pushed);

  const echo = await A.waitForLog(on('ntfy echo ignored', { sha: pushed }), { since: m, timeoutMs: 15_000 });
  // Deliberate observation window: nothing in A may react to its own push.
  await Bun.sleep(ECHO_WINDOW_MS);
  const after = A.logs.slice(A.logs.indexOf(echo) + 1);
  expect(after.filter(on('sync queued', { trigger: 'ntfy' }))).toEqual([]);
  expect(A.logs.slice(m).filter(on('ntfy event'))).toEqual([]);
  expect(A.logs.slice(m).filter((l) => l.msg === 'sync start' && Array.isArray(l.reasons)
    && (l.reasons as unknown[]).includes('ntfy'))).toEqual([]);

  // B does sync, as in item 1.
  await B.waitForLog(on('ntfy event', { sha: pushed }), { since: mB, timeoutMs: 15_000 });
  await B.waitForSync({ since: mB, reason: 'ntfy', timeoutMs: 15_000 });
  expect(await cb.read('echo.md')).toBe('pushed by A\n');
  expect(await cb.head()).toBe(pushed);

  await expectNoMdsyncArtifacts(t, [ca, cb], remote, (p) => p === 'README.md' || p === 'echo.md');
}, 120_000);
