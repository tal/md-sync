// Empty remotes and unborn HEADs (probes W5/e7).
import { afterEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  is, CONFLICT_COPY_RE, cleanupAll, cloneRemote, createRemote, emptyDir, expectNoMdsyncArtifacts, openClone, runCli,
  setupTestEnv, startDaemon, type Clone,
} from '../harness';

afterEach(cleanupAll);


async function localConfig(c: Clone): Promise<string[]> {
  return (await c.git(['config', '--local', '--list'])).stdout.split('\n').filter((l) => l !== '').sort();
}

async function headRef(c: Clone): Promise<string> {
  return (await c.git(['symbolic-ref', '-q', 'HEAD'])).stdout.trim();
}

test('a daemon clone of an empty remote: unborn HEAD on the configured branch, untouched config, first push creates it', async () => {
  const t = await setupTestEnv('empty-remote-clone');
  const r = await createRemote(t, { seed: 'empty' });
  // The remote advertises an unborn `trunk`, so the clone starts on the wrong branch and bootstrap must fix it.
  const bare = openClone(t, r.path);
  expect((await bare.git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'])).code).toBe(0);
  const plain = await cloneRemote(t, r, 'plain');

  const dir = emptyDir(t, 'A');
  const A = await startDaemon(t, { name: 'A', dir, remote: r });
  const a = openClone(t, dir);
  expect(A.logs.find(is('cloned'))).toMatchObject({ head: 'unborn' });
  expect(A.logs.some(is('remote branch missing', { branch: 'main' }))).toBe(true);
  expect(A.logs.find((l) => l.msg === 'sync done' && Array.isArray(l.reasons) && l.reasons.includes('startup')))
    .toMatchObject({ outcome: 'ok', head: 'unborn' });
  expect(await a.head()).toBe('unborn');
  expect(await headRef(a)).toBe('refs/heads/main');
  expect(await localConfig(a)).toEqual(await localConfig(plain));

  await a.write('first.md', 'first note\n');
  const f = await A.flush(['--wait']);
  expect({ code: f.code, stderr: f.stderr }).toEqual({ code: 0, stderr: f.stderr });
  expect(await r.head()).toBe(await a.head());
  expect(await r.tree()).toEqual(['first.md']);
  expect((await r.log()).map((c) => c.authorName)).toEqual(['mdsync-A']);
  expect(await headRef(a)).toBe('refs/heads/main');
  expect(await localConfig(a)).toEqual(await localConfig(plain));
  await expectNoMdsyncArtifacts(t, [a, plain], r, (p) => p === 'first.md');
}, 120_000);

test('two devices\' first commits into an empty remote (unrelated histories, W5) keep both as an add/add copy', async () => {
  const t = await setupTestEnv('empty-remote-two-firsts');
  const r = await createRemote(t, { seed: 'empty' });
  const A = await startDaemon(t, { name: 'A', dir: emptyDir(t, 'A'), remote: r });
  const B = await startDaemon(t, { name: 'B', dir: emptyDir(t, 'B'), remote: r });
  const a = openClone(t, A.dir);
  const b = openClone(t, B.dir);
  expect(await a.head()).toBe('unborn');
  expect(await b.head()).toBe('unborn');

  await a.write('start.md', 'from A\n');
  await b.write('start.md', 'from B\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  const m = B.mark();
  const fb = await B.flush(['--wait']);
  expect({ code: fb.code, stderr: fb.stderr }).toEqual({ code: 0, stderr: fb.stderr });
  expect((await B.waitForSync({ since: m, reason: 'flush' })).outcome).toBe('conflict-resolved');
  expect(B.logs.slice(m).find(is('conflict'))?.copies).toHaveLength(1);

  expect(await r.show('start.md')).toBe('from A\n');
  const copies = (await r.tree()).filter((p) => CONFLICT_COPY_RE.test(p));
  expect(copies).toHaveLength(1);
  const copy = copies[0] as string;
  expect(await r.show(copy)).toBe('from B\n');

  expect((await A.flush(['--wait'])).code).toBe(0);
  for (const c of [a, b]) {
    expect(await c.read('start.md')).toBe('from A\n');
    expect(await c.read(copy)).toBe('from B\n');
  }
  await expectNoMdsyncArtifacts(t, [a, b], r, (p) => p === 'start.md');
}, 120_000);

test('an unborn HEAD with a staged index and a remote that gained a commit: the pull-only run succeeds (probe e7)', async () => {
  const t = await setupTestEnv('empty-remote-staged-unborn');
  const r = await createRemote(t, { seed: 'empty' });
  const a = await cloneRemote(t, r, 'A');
  // A crash between S2's `git add` and its commit leaves staged entries on an unborn HEAD.
  await a.write('staged.md', 'staged before the crash\n');
  expect((await a.git(['add', '--', 'staged.md'])).code).toBe(0);
  const remoteSha = await r.push({ 'remote.md': 'from the remote\n' }, 'remote first');

  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const startup = await A.waitForSync({ reason: 'startup' });
  expect(startup).toMatchObject({ kind: 'pull-only', outcome: 'ok', commitStep: 'not-applicable', commitsIn: 1, commitsOut: 0 });
  expect(await a.head()).toBe(remoteSha);
  expect(await headRef(a)).toBe('refs/heads/main');
  expect(await a.read('remote.md')).toBe('from the remote\n');
  expect(await a.read('staged.md')).toBe('staged before the crash\n');
  expect(await a.porcelain()).toEqual(['?? staged.md']);
  expect(await r.head()).toBe(remoteSha);
  expect((await r.log()).filter((c) => c.authorName === 'mdsync-A')).toEqual([]);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => p === 'remote.md' || p === 'staged.md');
}, 120_000);

test('a fresh clone needs its branch named; `main` on a remote with only `master`: a clear error, no new branch pushed', async () => {
  const t = await setupTestEnv('remote-master-only');
  const bare = join(t.root, 'remote-master.git');
  const git = (cwd: string, args: string[]): void => {
    const p = Bun.spawnSync(['git', ...args], { cwd, env: t.env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  };
  git(t.root, ['init', '-q', '--bare', '-b', 'master', bare]);
  const seed = join(t.root, 'seed');
  git(t.root, ['clone', '-q', bare, seed]);
  writeFileSync(join(seed, 'old.md'), 'years of notes\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'existing history']);
  git(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);

  const dir = emptyDir(t, 'mastercopy');
  // nothing is checked out yet and there is no default branch: refused before anything is cloned
  const unnamed = await runCli(t, ['sync-once', '--dir', dir, '--remote', bare]);
  expect(unnamed.code).toBe(2);
  expect(unnamed.stderr).toContain('missing required config key "branch" (pass --branch or set "branch" in the config file');
  expect(existsSync(join(dir, '.git'))).toBe(false);
  const res = await runCli(t, ['sync-once', '--dir', dir, '--remote', bare, '--branch', 'main']);
  expect(res.code).toBe(1);
  expect(res.stderr).toContain('origin has no branch main (its default branch is master)');
  expect(res.stderr).toContain('"branch": "master"');
  expect(res.logs.some(is('pushed'))).toBe(false);
  const heads = Bun.spawnSync(['git', 'for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: bare, env: t.env });
  expect(heads.stdout.toString().trim().split('\n')).toEqual(['refs/heads/master']);
  // with the branch configured, it syncs
  const ok = await runCli(t, ['sync-once', '--dir', dir, '--remote', bare, '--branch', 'master']);
  expect(ok.code).toBe(0);
}, 120_000);

test('a daemon on a `master` remote configured for `main`: notes are never forked onto `main`, not even by a stop, and sync once the config names master', async () => {
  // P6 created a local main from master, S2 committed notes there, a stop pushed it as a new remote branch, and after
  // "branch": "master" P6 switched back to master: the notes vanished from the folder (r3).
  const t = await setupTestEnv('remote-master-daemon');
  const bare = join(t.root, 'remote-master.git');
  const git = (cwd: string, args: string[]): string => {
    const p = Bun.spawnSync(['git', ...args], { cwd, env: t.env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  git(t.root, ['init', '-q', '--bare', '-b', 'master', bare]);
  const seed = join(t.root, 'seed');
  git(t.root, ['clone', '-q', bare, seed]);
  writeFileSync(join(seed, 'README.md'), '# old repo\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
  const remote = { url: bare, path: bare } as unknown as Parameters<typeof startDaemon>[1]['remote'];
  const dir = emptyDir(t, 'notes');
  const A = await startDaemon(t, { name: 'A', dir, remote });
  writeFileSync(join(dir, 'agent-note.md'), 'written by an agent\n');
  const f = await A.flush(['--wait']);
  expect(f.code).toBe(1);
  expect(f.stderr).toContain('origin has no branch main (its default branch is master)');
  expect(await A.stop()).toBe(0);
  expect(git(bare, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/master');
  expect(git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe('refs/heads/master');

  const B = await startDaemon(t, { name: 'A', dir, remote, config: { branch: 'master' } });
  expect((await B.flush(['--wait'])).code).toBe(0);
  expect(git(bare, ['show', 'master:agent-note.md'])).toBe('written by an agent');
  expect(Bun.file(join(dir, 'agent-note.md')).size).toBeGreaterThan(0);
}, 120_000);

test('a first clone killed before its checkout (HEAD -> refs/heads/.invalid): the next run completes it', async () => {
  // SIGKILL, `docker stop` or a power loss mid-clone leaves `.git` with HEAD pointing at git's placeholder. Every run
  // then failed with "No such ref: HEAD", while the daemon still reported ready.
  const t = await setupTestEnv('interrupted-clone');
  const r = await createRemote(t, { files: { 'notes.md': 'from the remote\n' } });
  const dir = emptyDir(t, 'A');
  const git = (args: string[]): void => {
    const p = Bun.spawnSync(['git', ...args], { cwd: dir, env: t.env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  };
  git(['init', '-q']);
  git(['remote', 'add', 'origin', r.url]);
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
  writeFileSync(join(dir, 'new.md'), 'written after the crash\n');

  // HEAD names no branch git accepts, so there is none to read: it has to be named, then P6 repairs HEAD
  const unnamed = await runCli(t, ['sync-once', '--dir', dir, '--remote', r.url]);
  expect(unnamed.code).toBe(2);
  expect(unnamed.stderr).toContain(`HEAD in ${dir} does not name a valid branch, as an interrupted clone leaves it`);
  expect(unnamed.stderr).toContain('pass --branch (or set "branch" in the config file)');
  const res = await runCli(t, ['sync-once', '--dir', dir, '--remote', r.url, '--branch', 'main']);
  expect({ code: res.code, stderr: res.stderr.trim() }).toEqual({ code: 0, stderr: '' });
  expect(res.logs.some(is('recovered', { action: 'branch-fixed', from: '.invalid', to: 'main' }))).toBe(true);
  const a = openClone(t, dir);
  expect(await headRef(a)).toBe('refs/heads/main');
  expect(await a.read('notes.md')).toBe('from the remote\n');
  expect(await r.show('new.md')).toBe('written after the crash\n');
  expect(await a.head()).toBe(await r.head());
}, 120_000);

test('a first clone that fails on the network is retried on the backoff, not by a restart loop; SIGTERM ends the wait', async () => {
  const t = await setupTestEnv('clone-retry');
  const r = await createRemote(t, { files: { 'notes.md': 'remote\n' } });
  await r.setUnreachable();
  const A = await startDaemon(t, { name: 'A', dir: emptyDir(t, 'A'), remote: r, wait: 'none' });
  await A.waitForLog('clone failed');
  expect(await A.waitForLog('retry scheduled')).toMatchObject({ delayMs: 30_000, failures: 1, after: 'network-error' });
  await Bun.sleep(1_000);
  expect(A.proc.exitCode).toBeNull();   // still up: lock and socket held, no restart storm
  await r.restore();
  await A.waitForLog('daemon ready', { timeoutMs: 45_000 });
  // the clone is `--no-checkout`: the startup run's P1b populates the folder
  await A.waitForSync({ reason: 'startup', timeoutMs: 60_000 });
  expect(await openClone(t, A.dir).read('notes.md')).toBe('remote\n');

  const B = await startDaemon(t, { name: 'B', dir: emptyDir(t, 'B'), remote: r, wait: 'none' });
  await r.setUnreachable();
  await B.waitForLog('retry scheduled', { timeoutMs: 60_000 });
  const t0 = performance.now();
  expect(await B.stop()).toBe(0);
  expect(performance.now() - t0).toBeLessThan(10_000);
  await r.restore();

  // a folder that needs a person (not empty, not a repo) still fails at once, with a JSON line saying why
  const busy = emptyDir(t, 'C');
  writeFileSync(join(busy, 'mine.md'), 'not a clone\n');
  const C = await startDaemon(t, { name: 'C', dir: busy, remote: r, wait: 'none' });
  expect(await C.exited).toBe(1);
  expect(C.logs.find(is('startup failed'))?.error).toContain('is not empty and is not a git repository');
}, 120_000);
