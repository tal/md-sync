// Acceptance 8: a push rejected as non-fast-forward re-fetches, rebases and
// succeeds. The race is injected by an upload-pack wrapper that pushes from a helper clone right after our fetch.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogMsg } from '../../src/log';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, raceUploadPack, runCli, setupTestEnv, startDaemon, waitFor,
  type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

test('a push rejected as non-fast-forward retries and succeeds', async () => {
  const t = await setupTestEnv('08-non-ff-retry');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const race = await raceUploadPack(t, remote);
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, env: race.env });
  await race.arm();
  expect(race.fired()).toBe(false);

  await ca.write('a.md', 'pushed after a race\n');
  const m = A.mark();
  expect((await A.flush(['-m', 'after race', '--wait'])).code).toBe(0);

  const rejected = await A.waitForLog(on('push rejected', { attempt: 1, reason: 'fetch first' }), { since: m });
  const pushed = await A.waitForLog(on('pushed'), { since: m });
  expect(A.logs.indexOf(pushed)).toBeGreaterThan(A.logs.indexOf(rejected));
  await A.waitForSync({ since: m, reason: 'flush', outcome: 'ok' });
  expect(race.fired()).toBe(true);

  const [newest, previous] = await remote.log();
  expect({ subject: newest?.subject, author: newest?.authorName }).toEqual({ subject: 'after race', author: 'mdsync-A' });
  expect({ subject: previous?.subject, author: previous?.authorName }).toEqual({ subject: 'race commit', author: 'Test Helper' });
  expect(await ca.head()).toBe(await remote.head());
  expect(await ca.read('race.md')).toBe(await remote.show('race.md'));
  expect(await ca.read('a.md')).toBe('pushed after a race\n');
  expect(await ca.porcelain()).toEqual([]);

  await expectNoMdsyncArtifacts(t, [ca], remote, (p) => ['README.md', 'a.md', 'race.md'].includes(p));
}, 120_000);

test('two races in a row: both rejections are retried after their backoff, and the third push lands', async () => {
  // r3 mutation lens: giving up after one retry, or retrying without the backoff sleep, passed every test.
  const t = await setupTestEnv('08-non-ff-twice');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const race = await raceUploadPack(t, remote);
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, env: race.env });
  await race.arm(2);
  await ca.write('a.md', 'after two races\n');
  const m = A.mark();
  expect((await A.flush(['-m', 'after races', '--wait'])).code).toBe(0);
  const lines = A.logs.slice(m);
  const rejected = lines.filter(on('push rejected'));
  expect(rejected.map((l) => l.attempt)).toEqual([1, 2]);
  expect(rejected.map((l) => l.delayMs)).toEqual([500, 1_000]);
  // each retry fetches again only after its delay
  const fetchesAfter = (l: LogLine): LogLine | undefined => lines.slice(lines.indexOf(l) + 1)
    .find((x) => x.msg === 'git' && Array.isArray(x.args) && (x.args as string[]).includes('fetch'));
  for (const r of rejected) {
    const next = fetchesAfter(r);
    expect(next).toBeDefined();
    expect(Date.parse(String(next?.ts)) - Date.parse(r.ts)).toBeGreaterThanOrEqual(Number(r.delayMs) - 20);
  }
  expect(race.fired()).toBe(true);
  expect((await remote.log())[0]?.subject).toBe('after races');
  expect(await ca.head()).toBe(await remote.head());
}, 120_000);

test('a push that loses the ref update race on the remote ("cannot lock ref … is at X but expected Y") is retried like a non-fast-forward', async () => {
  // r4: the remote's `cannot lock ref` was taken for a local lock: the run ended busy, `flush --wait` exited 1 and
  // the commit waited 30 s or more for a retry.
  const t = await setupTestEnv('08-remote-ref-race');
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const helper = await cloneRemote(t, remote, 'helper');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
  // A's push waits in pre-receive (after the ref advertisement, before the ref update) while the helper pushes
  const armed = join(t.root, 'hold-next-push');
  const hook = join(remote.path, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\ncat >/dev/null\nif [ -e '${armed}' ]; then rm -f '${armed}'; sleep 2; fi\nexit 0\n`);
  chmodSync(hook, 0o755);
  writeFileSync(armed, '');
  await ca.write('mine.md', 'written on A\n');
  const m = A.mark();
  const flush = A.flush(['--wait']);
  await waitFor(() => !existsSync(armed), { timeoutMs: 30_000, label: 'A push held in pre-receive' });
  await helper.write('other.md', 'written on B\n');
  expect((await helper.git(['add', '-A'])).code).toBe(0);
  expect((await helper.git(['commit', '-qm', 'B'])).code).toBe(0);
  expect((await helper.git(['push', '-q', 'origin', 'HEAD:main'])).code).toBe(0);
  const f = await flush;
  expect(f.stderr).toBe('');
  expect(f.code).toBe(0);
  expect(A.logs.slice(m).some(on('push rejected', { attempt: 1 }))).toBe(true);
  expect(await remote.show('mine.md')).toBe('written on A\n');
  expect(await remote.show('other.md')).toBe('written on B\n');
  expect(await ca.head()).toBe(await remote.head());
}, 120_000);

test('a push rejected right after a pull that replaced a file: the settle run 5 s later keeps the retry, which then pushes', async () => {
  // review round 5 (d28-semantics-1): the pull's replaced inode waits out SETTLE_GRACE_MS, and the settle timer's run
  // (preflight only, outcome ok) counted as a sync: it cancelled the 30 s retry, reset the backoff and replaced the
  // failure in `status`. The unpushed commit then waited for an unrelated trigger (up to the hourly fallback).
  const t = await setupTestEnv('08-settle-keeps-retry');
  const remote = await createRemote(t, { files: { 'README.md': '# r\n', 'note.md': 'v1\n' } });
  const ca = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
  await remote.push({ 'note.md': 'v2 elsewhere\n' }, 'remote edits note');   // the pull replaces note.md: an aside
  const hook = join(remote.path, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho denied >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  await ca.write('local.md', 'local\n');
  const m = A.mark();
  await A.flush(['-m', 'local work']);
  const failed = await A.waitForSync({ since: m, reason: 'flush' });
  expect(failed.outcome).toBe('failed');
  expect(await ca.read('note.md')).toBe('v2 elsewhere\n');
  rmSync(hook);
  const settle = await A.waitForLog((l) => l.msg === 'sync done' && Array.isArray(l.reasons) && (l.reasons as string[]).includes('settle'),
    { since: m, timeoutMs: 20_000 });
  expect(settle.outcome).toBe('ok');
  const status = await runCli(t, ['status', '--dir', ca.dir]);
  expect(status.stdout).toContain('last error:');
  expect(status.stdout).toContain('retry at:');
  expect(status.stdout).toMatch(/last sync:.*failed/);
  // the retry runs at +30 s and pushes
  await A.waitForLog(on('pushed'), { since: m, timeoutMs: 45_000 });
  expect(A.logs.slice(m).some((l) => l.msg === 'sync start' && Array.isArray(l.reasons) && (l.reasons as string[]).includes('retry'))).toBe(true);
  expect(await remote.show('local.md')).toBe('local\n');
  expect(await ca.head()).toBe(await remote.head());
  const after = await runCli(t, ['status', '--dir', ca.dir]);
  expect(after.stdout).not.toContain('last error:');
  expect(after.stdout).not.toContain('retry at:');
}, 120_000);
