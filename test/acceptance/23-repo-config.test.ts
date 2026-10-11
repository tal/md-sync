// The committed repo config `.config/mdsync.json`.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { statePathsFor } from '../../src/paths';
import {
  allowAuthor, cleanupAll, cloneRemote, createRemote, DEFAULT_AUTHOR, expectNoMdsyncArtifacts, is, runCli, setupTestEnv,
  startDaemon,
} from '../harness';

afterEach(cleanupAll);

const REPO_CONFIG = '.config/mdsync.json';
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

test('repo ignore applies from the first run; instance-only and unknown keys are ignored; an invalid update keeps the last good one', async () => {
  const t = await setupTestEnv('repo-config');
  const r = await createRemote(t, {
    files: { 'README.md': '# notes\n', [REPO_CONFIG]: json({ ignore: ['scratch/**'], authorName: 'evil', futureKey: 1 }) },
  });
  const a = await cloneRemote(t, r, 'A');
  // Only ignored content is dirty when the daemon starts.
  await a.write('scratch/s.md', 'scratch before start\n');

  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  expect(A.logs.some(is('repo config key ignored', { key: 'authorName', reason: 'instance-only' }))).toBe(true);
  expect(A.logs.some(is('repo config key ignored', { key: 'futureKey', reason: 'unknown' }))).toBe(true);
  expect(A.logs.some(is('repo config invalid'))).toBe(false);

  // A flush right after start: its run begins only after the startup run's onRunEnd, so every startup-time status
  // check is logged before its `sync start`. None of them may see scratch/ as a change.
  let m = A.mark();
  const empty = await A.flush(['--wait']);
  expect(empty.code).toBe(0);
  const flushRun = await A.waitForSync({ since: m, reason: 'flush' });
  expect(flushRun).toMatchObject({ outcome: 'ok', commitStep: 'nothing-staged' });
  const flushStart = A.logs.findIndex((l) => l.msg === 'sync start' && l.runId === flushRun.runId);
  expect(flushStart).toBeGreaterThan(0);
  const early = A.logs.slice(0, flushStart);
  expect(early.filter((l) => l.msg === 'local change' || l.msg === 'backup timers armed' || l.msg === 'committed')).toEqual([]);

  await a.write('keep.md', 'keep\n');
  await a.write('scratch/late.md', 'scratch after start\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect((await r.log())[0]).toMatchObject({ authorName: 'mdsync-A', files: ['keep.md'] });

  // An invalid later version: logged, and the last good ignore stays in force.
  m = A.mark();
  await r.push({ [REPO_CONFIG]: json({ ignore: 'scratch/**', idleMs: 5 }) }, 'break the repo config');
  expect((await A.flush(['--wait'])).code).toBe(0);
  await A.waitForLog(is('repo config invalid', { keeping: 'last-good' }), { since: m });
  await a.write('after.md', 'after\n');
  await a.write('scratch/after.md', 'scratch after the bad config\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect((await r.log())[0]).toMatchObject({ authorName: 'mdsync-A', files: ['after.md'] });

  const tree = await r.tree();
  expect(tree.filter((p) => p.startsWith('scratch/'))).toEqual([]);
  expect((await a.porcelain()).sort()).toEqual(['?? scratch/after.md', '?? scratch/late.md', '?? scratch/s.md']);
  await expectNoMdsyncArtifacts(t, [a], r,
    (p) => ['README.md', REPO_CONFIG, 'keep.md', 'after.md'].includes(p) || p.startsWith('scratch/'));
}, 120_000);

test('sync-once honors the repo ignore', async () => {
  const t = await setupTestEnv('repo-config-sync-once');
  const r = await createRemote(t, { files: { 'README.md': '# notes\n', [REPO_CONFIG]: json({ ignore: ['scratch/**'] }) } });
  const a = await cloneRemote(t, r, 'A');
  const author = DEFAULT_AUTHOR;
  allowAuthor(t, author);
  await a.write('scratch/s.md', 'scratch\n');
  await a.write('n.md', 'n\n');

  const res = await runCli(t, ['sync-once', '--dir', a.dir, '--remote', r.url]);
  expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: res.stderr });
  expect(res.logs.find(is('one-off run'))).toMatchObject({ source: 'sync-once', dir: a.dir });
  expect(res.logs.find(is('sync done'))).toMatchObject({ kind: 'commit', outcome: 'ok', commitStep: 'committed' });

  const log = await r.log();
  expect(log[0]).toMatchObject({ authorName: author, files: ['n.md'] });
  expect(log[0]?.subject).toMatch(/^sync \S+ \S+Z$/);   // a commit run, but not a backup: no "(auto)"
  expect(await r.tree()).not.toContain('scratch/s.md');
  expect(await a.porcelain()).toEqual(['?? scratch/s.md']);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', REPO_CONFIG, 'n.md', 'scratch/s.md'].includes(p));
}, 90_000);

for (const observeRemoval of ['reload', 'startup', 'one-off'] as const) {
  test(`repo config removed during ${observeRemoval} stays empty after an invalid replacement and restart`, async () => {
    const t = await setupTestEnv(`repo-config-removal-${observeRemoval}`);
    const r = await createRemote(t, { files: { 'README.md': '# notes\n', [REPO_CONFIG]: json({ ignore: ['scratch/**'] }) } });
    const a = await cloneRemote(t, r, 'A');
    let A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
    // First persist the valid ignore layer, then observe its removal by each entry point.
    expect((await A.flush(['--wait'])).code).toBe(0);
    if (observeRemoval === 'reload') {
      const mark = A.mark();
      await r.push({ [REPO_CONFIG]: null }, 'remove repo config');
      expect((await A.flush(['--wait'])).code).toBe(0);
      await A.waitForLog(is('config reloaded', { trigger: 'repo-config' }), { since: mark });
    } else {
      expect(await A.stop()).toBe(0);
      await a.remove(REPO_CONFIG);
      expect((await a.git(['add', '-A'])).code).toBe(0);
      expect((await a.git(['commit', '-qm', 'remove repo config'])).code).toBe(0);
      expect((await a.git(['push', '-q', 'origin', 'main'])).code).toBe(0);
      if (observeRemoval === 'one-off') {
        expect((await runCli(t, ['flush', '--dir', a.dir, '--wait'])).code).toBe(0);
      } else {
        A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
      }
    }
    const state = JSON.parse(readFileSync(statePathsFor(a.dir, t.env).state, 'utf8'));
    expect(state.repoConfig).toEqual({ blob: 'none', layer: {} });

    await r.push({ [REPO_CONFIG]: json({ ignore: 5 }) }, 'invalid replacement');
    if (observeRemoval === 'one-off') {
      expect((await runCli(t, ['flush', '--dir', a.dir, '--wait'])).code).toBe(0);
      await a.write('scratch/before.md', 'before restart\n');
      expect((await runCli(t, ['flush', '--dir', a.dir, '--wait'])).code).toBe(0);
    } else {
      const mark = A.mark();
      expect((await A.flush(['--wait'])).code).toBe(0);
      await A.waitForLog('repo config invalid', { since: mark });
      await a.write('scratch/before.md', 'before restart\n');
      expect((await A.flush(['--wait'])).code).toBe(0);
      expect(await A.stop()).toBe(0);
    }
    expect(await r.show('scratch/before.md')).toBe('before restart\n');
    const B = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
    await a.write('scratch/after.md', 'after restart\n');
    expect((await B.flush(['--wait'])).code).toBe(0);
    expect(await r.show('scratch/after.md')).toBe('after restart\n');
    await expectNoMdsyncArtifacts(t, [a], r,
      (p) => ['README.md', REPO_CONFIG, 'scratch/before.md', 'scratch/after.md'].includes(p));
  }, 120_000);
}
