// Acceptance 10: a second daemon on the same folder fails fast with a
// clear error, and the first one keeps working.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogMsg } from '../../src/log';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, runCli, setupTestEnv, startDaemon, waitFor,
  type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

const FAIL_FAST_MS = 3_000;

test('a second daemon on the same folder fails fast; the first keeps working', async () => {
  const t = await setupTestEnv('10-single-instance');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
  // <stateHome>/mdsync/<sha256(realDir)[0..16]>.lock
  const hash = new Bun.CryptoHasher('sha256').update(ca.dir).digest('hex').slice(0, 16);
  const lockPath = join(t.stateHome, 'mdsync', `${hash}.lock`);
  const lockOwner = (): unknown => (JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: unknown }).pid;
  expect(lockOwner()).toBe(A.proc.pid);

  // Same dir, different config file.
  const second = await startDaemon(t, { name: 'A2', dir: ca.dir, remote, wait: 'none' });
  const code = await Promise.race([second.exited, Bun.sleep(FAIL_FAST_MS).then(() => 'still running' as const)]);
  expect(code).toBe(1);
  const busy = await second.waitForLog(on('lock busy'));
  expect({ pid: busy.pid, dir: busy.dir, purpose: busy.purpose }).toEqual({ pid: A.proc.pid, dir: ca.dir, purpose: 'daemon' });
  await waitFor(() => second.stderr().includes('already syncing'), { timeoutMs: 5_000, label: 'stderr "already syncing"' });
  expect(lockOwner()).toBe(A.proc.pid);

  // A keeps working through its socket (a one-off would be busy behind A's lock).
  await ca.write('still.md', 'A is still syncing\n');
  const flushed = await A.flush(['--wait']);
  expect(flushed.code).toBe(0);
  expect(flushed.logs.filter(on('one-off run'))).toEqual([]);
  expect(await remote.show('still.md')).toBe('A is still syncing\n');

  // A one-off sync on the same folder fails too.
  const once = await runCli(t, ['sync-once', '--dir', ca.dir, '--remote', remote.url], { timeoutMs: 30_000 });
  expect(once.code).toBe(1);
  expect(once.logs.filter(on('lock busy'))).not.toEqual([]);
  expect(lockOwner()).toBe(A.proc.pid);
  await ca.write('later.md', 'after sync-once\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await remote.show('later.md')).toBe('after sync-once\n');

  await expectNoMdsyncArtifacts(t, [ca], remote, (p) => ['README.md', 'still.md', 'later.md'].includes(p));
}, 120_000);
