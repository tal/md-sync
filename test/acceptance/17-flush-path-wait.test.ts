// Acceptance 17: a flush with paths commits only the named paths, and `flush --wait` exits non-zero when the push
// fails.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { statePathsFor } from '../../src/paths';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, runCli, setupTestEnv, startDaemon,
} from '../harness';

afterEach(cleanupAll);


test('(a) --path values resolve against cwd and only those paths are committed', async () => {
  const t = await setupTestEnv('flush-path');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  await a.write('a.md', 'a\n');
  await a.write('sub/b.md', 'b\n');
  await a.write('c.md', 'c\n');

  const m = A.mark();
  const res = await runCli(t, ['flush', '../a.md', 'b.md', '-m', 'partial', '--wait'],
    { cwd: join(a.dir, 'sub') });
  expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: res.stderr });
  expect(A.logs.slice(m).find(is('flush received'))).toMatchObject({ paths: 2, message: 'given', wait: 'wait' });

  const log = await r.log();
  expect(log[0]?.subject).toBe('partial');
  expect(log[0]?.authorName).toBe('mdsync-A');
  expect([...(log[0]?.files ?? [])].sort()).toEqual(['a.md', 'sub/b.md']);
  expect(await r.tree()).not.toContain('c.md');
  expect(await a.porcelain()).toEqual(['?? c.md']);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'a.md', 'sub/b.md', 'c.md'].includes(p));
}, 90_000);

test('(b) a --path outside the synced folder is a usage error', async () => {
  const t = await setupTestEnv('flush-path-outside');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  mkdirSync(join(a.dir, 'sub'));
  await a.write('in.md', 'in\n');
  const before = await r.head();

  const m = A.mark();
  const res = await runCli(t, ['flush', '../../outside.md', '--wait'], { cwd: join(a.dir, 'sub') });
  expect(res.code).toBe(2);
  expect(res.stderr).toContain('path outside synced folder');
  expect(A.logs.slice(m).some(is('flush received'))).toBe(false);
  expect(await r.head()).toBe(before);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'in.md'].includes(p));
}, 90_000);

test('(c) flush --wait exits 1 when the push fails, and the commit pushes once the remote is back', async () => {
  const t = await setupTestEnv('flush-wait-fail');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });

  await r.setUnreachable();
  await a.write('x.md', 'x\n');
  const m = A.mark();
  const failed = await A.flush(['--wait']);
  expect(failed.code).toBe(1);
  expect(failed.stderr).toContain('network-error');
  expect(A.logs.slice(m).some(is('committed', { source: 'flush' }))).toBe(true);
  expect((await a.log('origin/main..HEAD')).map((c) => c.files)).toEqual([['x.md']]);

  await r.restore();
  const ok = await A.flush(['--wait']);
  expect({ code: ok.code, stderr: ok.stderr }).toEqual({ code: 0, stderr: ok.stderr });
  expect(await r.show('x.md')).toBe('x\n');
  expect(await r.head()).toBe(await a.head());
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'x.md'].includes(p));
}, 90_000);

test('(d) with no daemon running, the one-off flush --wait exits 1 when the push fails', async () => {
  const t = await setupTestEnv('flush-wait-fail-oneoff');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');

  await r.setUnreachable();
  await a.write('y.md', 'y\n');
  const res = await runCli(t, ['flush', '--dir', a.dir, '--wait']);
  expect(res.code).toBe(1);
  expect(res.logs.find(is('one-off run'))).toMatchObject({ source: 'flush', dir: a.dir });
  expect(res.logs.find(is('sync done'))).toMatchObject({ kind: 'commit', outcome: 'network-error', commitStep: 'committed' });
  expect(`${res.stdout}\n${res.stderr}`).toContain('network-error');
  // The commit is kept locally and the lock is released.
  expect((await a.log('origin/main..HEAD')).map((c) => c.files)).toEqual([['y.md']]);
  expect(existsSync(statePathsFor(a.dir, t.env).lock)).toBe(false);

  await r.restore();   // nothing was pushed, so the remote holds only the seed
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'y.md'].includes(p));
}, 90_000);

test('(e) a push the remote refuses (a hook, a protected branch): flush --wait exits 1 and names it; the commit stays local', async () => {
  // r3 mutation lens: reporting `[remote rejected]` as done let flush --wait exit 0 and passed every test.
  const t = await setupTestEnv('flush-remote-rejected');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const hook = join(r.path, 'hooks', 'pre-receive');
  mkdirSync(join(r.path, 'hooks'), { recursive: true });
  await Bun.write(hook, '#!/bin/sh\necho "protected branch" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  await a.write('x.md', 'x\n');
  const m = A.mark();
  const f = await A.flush(['--wait']);
  expect(f.code).toBe(1);
  expect(f.stderr).toContain('push rejected by remote');
  expect(A.logs.slice(m).some(is('push rejected by remote'))).toBe(true);
  expect(await r.show('x.md')).toBeUndefined();
  expect((await a.log())[0]?.files).toEqual(['x.md']);
}, 120_000);
