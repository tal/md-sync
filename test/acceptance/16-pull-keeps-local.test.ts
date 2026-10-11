// Acceptance 16: a remote event arriving with unflushed local changes pulls them in without committing the local
// changes.
import { afterEach, expect, test } from 'bun:test';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier, setupTestEnv, startDaemon,
} from '../harness';

afterEach(cleanupAll);


test('a pull-only run keeps unflushed tracked edits and untracked files uncommitted', async () => {
  const t = await setupTestEnv('pull-keeps-local');
  const r = await createRemote(t, { files: { 'local.md': 'l\n' } });
  const n = await fakeNtfy();
  remoteNotifier(r, n);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, ntfy: n, config: { idleMs: 60_000 } });

  const m = A.mark();
  await a.write('local.md', 'l\nunflushed edit\n');
  await a.write('new.md', 'brand new\n');
  await A.waitForLog(is('local change'), { since: m });

  const m2 = A.mark();
  const pushed = await r.push({ 'remote.md': 'r' }, 'remote edit');
  await A.waitForLog(is('ntfy event', { sha: pushed }), { since: m2 });
  const done = await A.waitForSync({ since: m2, reason: 'ntfy' });
  expect(done).toMatchObject({ kind: 'pull-only', outcome: 'ok', commitStep: 'not-applicable', commitsIn: 1, commitsOut: 0 });

  expect(await a.read('remote.md')).toBe('r');
  expect((await a.porcelain()).sort()).toEqual([' M local.md', '?? new.md']);
  expect(await a.read('local.md')).toBe('l\nunflushed edit\n');
  expect(await a.read('new.md')).toBe('brand new\n');
  expect(await a.stashList()).toEqual([]);
  expect(await a.head()).toBe(pushed);
  expect(await r.head()).toBe(pushed);
  expect((await r.log()).filter((c) => c.authorName === 'mdsync-A')).toEqual([]);
  expect(A.logs.slice(m).some(is('committed'))).toBe(false);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'local.md', 'new.md', 'remote.md'].includes(p));
}, 90_000);
