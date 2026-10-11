// Content and repo states that used to lose or leak data (review round 3):
// a rebase whose checkout fails partway, conflicts on files that decide what gets staged, gitlinks and nested repos,
// an invalid committed repo config, a remote history rewrite, and commits on a detached HEAD.
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFLICT_COPY_RE, cleanupAll, cloneRemote, createRemote, HAS_LFS, lfsStore, runCli, setupTestEnv, startDaemon, type LogLine,
} from '../harness';

afterEach(cleanupAll);

const SIX = 'l1\nl2\nl3\nl4\nl5\nl6\n';

// Root ignores permissions: the read-only folder would not stop the checkout.
test.if(process.getuid?.() !== 0)('a pull whose worktree move fails partway leaves local notes and edits on disk and never commits the damage', async () => {
  // git checked out part of R (deleting local-only files, rewriting edited ones) before it hit a file it could not
  // write; HEAD and the index stayed at L, so the next commit run committed "delete b.md" and "x.md back to R".
  // Since the worktree move, no git command writes the folder: the move fails on the read-only folder and undoes what it put from
  // git (M9), HEAD and the index never move, and there is no partial checkout to undo any more.
  const t = await setupTestEnv('partial-checkout');
  const r = await createRemote(t, { files: { 'x.md': SIX, 'docs/keep.md': 'keep\n' } });
  const b = await cloneRemote(t, r, 'b');
  const B = await startDaemon(t, { name: 'B', dir: b.dir, remote: r });
  await r.push({ 'docs/new.md': 'new\n', 'x.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
  const docs = join(b.dir, 'docs');
  chmodSync(docs, 0o555);
  try {
    await b.write('b.md', 'b note\n');
    await b.write('x.md', SIX.replace('l6\n', 'l6 B edit\n'));
    const m = B.mark();
    const f1 = await B.flush(['--wait']);
    expect(f1.code).toBe(1);
    expect(B.logs.slice(m).find((l: LogLine) => l.msg === 'sync done')?.outcome).toBe('failed');
    // HEAD stayed at B's own commit (never at R with B's note missing), and the worktree matches it again
    expect((await b.git(['show', 'HEAD:b.md'])).stdout).toBe('b note\n');
    expect((await b.git(['show', 'HEAD:x.md'])).stdout).toBe(SIX.replace('l6\n', 'l6 B edit\n'));
    expect((await b.git(['merge-base', '--is-ancestor', 'refs/remotes/origin/main', 'HEAD'])).code).not.toBe(0);
    expect(await b.read('b.md')).toBe('b note\n');
    expect(await b.read('x.md')).toBe(SIX.replace('l6\n', 'l6 B edit\n'));
    expect(await b.porcelain()).toEqual([]);
    const local = await b.log();
    // a second run while the folder is still read-only commits nothing (no deletion, no revert)
    expect((await B.flush(['--wait'])).code).toBe(1);
    expect((await b.log())[0]?.sha).toBe(local[0]?.sha);
    expect(await b.read('b.md')).toBe('b note\n');
  } finally {
    chmodSync(docs, 0o755);
  }
  await b.write('c.md', 'c\n');   // a new commit, so the run is not skipped as stuck at the same {H, R}
  expect((await B.flush(['--wait'])).code).toBe(0);
  expect(await r.tree()).toEqual(['b.md', 'c.md', 'docs/keep.md', 'docs/new.md', 'x.md']);
  expect(await r.show('b.md')).toBe('b note\n');
  expect(await r.show('x.md')).toBe(SIX.replace('l1\n', 'l1 remote\n').replace('l6\n', 'l6 B edit\n'));
}, 120_000);

void CONFLICT_COPY_RE;

test('a first clone killed during its checkout: the restarted daemon finishes it instead of pushing every missing file as deleted', async () => {
  // git clone moves HEAD to the branch before its checkout and writes .git/index last: a kill in between left a born
  // HEAD, no index and part of the files, and the first commit run pushed the deletion of the rest.
  const t = await setupTestEnv('clone-killed');
  const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`n/${i}.md`, `note ${i}\n`]));
  const r = await createRemote(t, { files: { 'README.md': '# notes\n', ...files } });
  const a = await cloneRemote(t, r, 'a');
  rmSync(join(a.dir, '.git', 'index'));
  for (let i = 0; i < 40; i += 2) rmSync(join(a.dir, 'n', `${i}.md`));
  const before = await r.head();
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  expect(A.logs.some((l: LogLine) => l.msg === 'recovered' && l.action === 'clone-completed')).toBe(true);
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await r.head()).toBe(before);
  expect((await r.tree()).length).toBe(41);
  expect(await a.porcelain()).toEqual([]);
  expect(await a.read('n/0.md')).toBe('note 0\n');
}, 120_000);

test('concurrent edits to .gitignore or to the repo config `ignore` list keep both sides\' rules, so nothing they kept out is pushed', async () => {
  // The replay kept the remote file at the path and moved the losing device's version into a conflict copy that git
  // never reads: the files its rules kept out (a secret, private notes) went out with the next commit run.
  const t = await setupTestEnv('rules-conflict');
  const r = await createRemote(t, { files: { '.gitignore': '*.tmp\n', '.config/mdsync.json': '{\n  "ignore": ["*.log"]\n}\n',
    'README.md': '# n\n' } });
  const a = await cloneRemote(t, r, 'a');
  const b = await cloneRemote(t, r, 'b');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const B = await startDaemon(t, { name: 'B', dir: b.dir, remote: r });

  await a.write('.gitignore', '*.tmp\ndrafts/\n');
  await a.write('.config/mdsync.json', '{\n  "ignore": ["*.log", "drafts-a/**"]\n}\n');
  expect((await A.flush(['--wait'])).code).toBe(0);

  await b.write('.gitignore', '*.tmp\nsecret.md\n');
  await b.write('.config/mdsync.json', '{\n  "ignore": ["*.log", "private/**"]\n}\n');
  expect((await B.flush(['--wait'])).code).toBe(0);   // the rule files themselves, before anything they protect
  await b.write('secret.md', 'API_KEY=hunter2\n');
  await b.write('private/x.md', 'diary\n');
  await b.write('ok.md', 'ok\n');
  expect((await B.flush(['--wait'])).code).toBe(0);
  expect((await B.flush(['--wait'])).code).toBe(0);

  const tree = await r.tree();
  expect(tree.filter((p) => CONFLICT_COPY_RE.test(p))).toEqual([]);
  expect(tree).toContain('ok.md');
  expect(tree).not.toContain('secret.md');
  expect(tree).not.toContain('private/x.md');
  expect((await r.show('.gitignore'))?.split('\n').filter((l) => l !== '').sort()).toEqual(['*.tmp', 'drafts/', 'secret.md']);
  expect(JSON.parse(await r.show('.config/mdsync.json') ?? '{}')).toEqual({ ignore: ['*.log', 'drafts-a/**', 'private/**'] });
}, 120_000);

test('a repository cloned or initialized inside the folder is never committed as an empty gitlink; it is reported as not synced', async () => {
  // `add -A` committed it as a gitlink: nothing inside synced, other devices got an empty folder that ignored new
  // files, nothing was logged, and a later conflict replay stopped on the gitlink for good.
  const t = await setupTestEnv('nested-repo');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const inner = join(a.dir, 'vendor', 'lib');
  await a.write('vendor/lib/inner.md', 'inner\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'inner']]) {
    expect(Bun.spawnSync(['git', ...args], { cwd: inner, env: t.env }).exitCode).toBe(0);
  }
  await a.write('vendor/lib/a-notes.md', 'notes inside\n');
  await a.write('top.md', 'top\n');
  const m = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(0);
  await a.write('top2.md', 'top2\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await r.tree()).toEqual(['README.md', 'top.md', 'top2.md']);
  expect(A.logs.slice(m).filter((l: LogLine) => l.msg === 'nested repository not synced').map((l) => l.path)).toEqual(['vendor/lib']);
  const st = await runCli(t, ['status', '--dir', a.dir, '--format', 'json']);
  const json = JSON.parse(st.stdout) as { pending: unknown[]; notSynced: string[] };
  expect(json.notSynced).toContain('vendor/lib');
  expect(json.pending).toEqual([]);
}, 120_000);

test('an invalid committed repo config keeps the last valid `ignore` list across one-off runs; with none known, nothing is committed', async () => {
  // A daemon kept its in-memory last good layer, but every restart and every one-off run fell back to the defaults
  // and pushed what the `ignore` list had kept out.
  const t = await setupTestEnv('repo-config-invalid');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', '.config/mdsync.json': '{ "ignore": ["private/**"] }\n' } });
  const b = await cloneRemote(t, r, 'b');
  const once = (dir: string) => runCli(t, ['sync-once', '--dir', dir, '--remote', r.url]);
  await b.write('private/x.md', 'diary\n');
  expect((await once(b.dir)).code).toBe(0);
  await r.push({ '.config/mdsync.json': '{ "ignore": ["private/**"], }\n' }, 'a trailing comma');
  expect((await once(b.dir)).code).toBe(0);   // pulls the invalid file
  await b.write('private/y.md', 'more diary\n');
  const res = await once(b.dir);
  expect(res.code).toBe(0);
  expect(res.logs.find((l) => l.msg === 'repo config invalid')?.keeping).toBe('last-good');
  expect((await r.tree()).filter((p) => p.startsWith('private/'))).toEqual([]);

  // a device that never saw a valid version commits nothing until the file is fixed
  const c = await cloneRemote(t, r, 'c');
  await c.write('private/z.md', 'c diary\n');
  const refused = await once(c.dir);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain('nothing is committed until it is fixed');
  expect((await r.tree()).filter((p) => p.startsWith('private/'))).toEqual([]);
  await r.push({ '.config/mdsync.json': '{ "ignore": ["private/**"] }\n' }, 'fixed');
  await c.write('ok.md', 'ok\n');
  expect((await once(c.dir)).code).toBe(1);   // this run pulls the fix; its own commit step was refused before that
  expect((await once(c.dir)).code).toBe(0);
  expect(await r.show('ok.md')).toBe('ok\n');
  expect((await r.tree()).filter((p) => p.startsWith('private/'))).toEqual([]);
}, 120_000);

test('a force-pushed history rewrite (a purged secret) is respected: only the commits made here since the last sync are replayed', async () => {
  // S5 rebased onto R with R as the upstream: every commit the rewrite removed counted as local work and was pushed
  // back within one sync (`git pull --rebase` uses the fork point and does not).
  const t = await setupTestEnv('force-push');
  const r = await createRemote(t);
  await r.push({ 'b.md': 'b\n' }, 'b');
  const clean = await r.head();
  await r.push({ 'secret.md': 'API_KEY=hunter2\n' }, 'oops secret');
  await r.push({ 'c.md': 'c\n' }, 'c');
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  await r.setUnreachable();
  await a.write('note.md', 'unpushed note\n');
  expect((await A.flush(['--wait'])).code).toBe(1);   // committed here, not pushed
  await r.restore();

  const helper = join(t.root, 'rewrite');
  const git = (args: string[], cwd = helper): void => {
    const p = Bun.spawnSync(['git', ...args], { cwd, env: t.env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  };
  git(['clone', '-q', r.url, helper], t.root);
  git(['reset', '-q', '--hard', String(clean)]);
  await Bun.write(join(helper, 'c.md'), 'c\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'c (history rewritten without the secret)']);
  git(['push', '-qf', 'origin', 'HEAD:main']);

  const m = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(A.logs.slice(m).some((l: LogLine) => l.msg === 'remote history rewritten' && l.localCommits === 1)).toBe(true);
  expect(await r.tree()).toEqual(['README.md', 'b.md', 'c.md', 'note.md']);
  expect((await r.log()).map((c) => c.subject).some((s) => s.includes('oops secret'))).toBe(false);
  expect(await a.files()).toEqual(['README.md', 'b.md', 'c.md', 'note.md']);
}, 120_000);

// A remote with a secret committed and an unpushed local note on device A; `rewrite()` force-pushes history without
// the secret (and with `extra` files), as a helper device would.
async function rewriteSetup(name: string) {
  const t = await setupTestEnv(name);
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'sub/keep.md': 'keep\n' } });
  await r.push({ 'b.md': 'b\n' }, 'b');
  const clean = await r.head();
  await r.push({ 'secret.md': 'API_KEY=hunter2\n' }, 'oops secret');
  await r.push({ 'c.md': 'c\n' }, 'c');
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  await r.setUnreachable();
  await a.write('note.md', 'unpushed note\n');
  expect((await A.flush(['--wait'])).code).toBe(1);   // committed here, not pushed
  await r.restore();
  const helper = join(t.root, 'rewrite');
  const git = (args: string[], cwd = helper): void => {
    const p = Bun.spawnSync(['git', ...args], { cwd, env: t.env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  };
  const rewrite = async (extra: Record<string, string> = {}): Promise<void> => {
    git(['clone', '-q', r.url, helper], t.root);
    git(['reset', '-q', '--hard', String(clean)]);
    for (const [p, c] of Object.entries({ 'c.md': 'c\n', ...extra })) await Bun.write(join(helper, p), c);
    git(['add', '-A']);
    git(['commit', '-qm', 'c (history rewritten without the secret)']);
    git(['push', '-qf', 'origin', 'HEAD:main']);
  };
  const noSecret = async (): Promise<void> => {
    expect(await r.show('secret.md')).toBeUndefined();
    expect((await r.log()).map((c) => c.subject).some((s) => s.includes('oops secret'))).toBe(false);
  };
  return { t, r, a, A, rewrite, noSecret };
}

test('a rewrite fetched by another tool first (an editor\'s autofetch) is still detected: the purged secret stays purged', async () => {
  // r4: S3 took refs/remotes/origin/B as "before". A plain `git fetch` had already moved it to the rewritten R, so
  // no rewrite was seen, S5 rebased with R as the upstream, and S6 pushed the secret back.
  const { a, A, r, rewrite, noSecret } = await rewriteSetup('rewrite-external-fetch');
  await rewrite();
  expect((await a.git(['fetch', '-q', 'origin'])).code).toBe(0);
  const m = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(A.logs.slice(m).some((l: LogLine) => l.msg === 'remote history rewritten' && l.localCommits === 1)).toBe(true);
  await noSecret();
  expect(await r.tree()).toEqual(['README.md', 'b.md', 'c.md', 'note.md', 'sub/keep.md']);
}, 120_000);

test.if(process.getuid?.() !== 0)('a rewrite fetched by a run that then failed is still detected by the next run', async () => {
  // r4: the failed run's fetch moved origin/B to the rewritten R; the next run compared against that.
  const { a, A, r, rewrite, noSecret } = await rewriteSetup('rewrite-failed-run');
  await rewrite({ 'sub/new.md': 'new\n' });
  const sub = join(a.dir, 'sub');
  chmodSync(sub, 0o555);   // the rebase's checkout of R fails on sub/new.md
  try {
    const m = A.mark();
    expect((await A.flush(['--wait'])).code).toBe(1);
    expect(A.logs.slice(m).some((l: LogLine) => l.msg === 'remote history rewritten')).toBe(true);
  } finally {
    chmodSync(sub, 0o755);
  }
  await a.write('d.md', 'd\n');   // a new commit, so the run is not skipped as stuck at the same {H, R}
  const m2 = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(A.logs.slice(m2).some((l: LogLine) => l.msg === 'remote history rewritten' && l.localCommits === 2)).toBe(true);
  await noSecret();
  expect(await r.tree()).toEqual(['README.md', 'b.md', 'c.md', 'd.md', 'note.md', 'sub/keep.md', 'sub/new.md']);
}, 120_000);


test.if(HAS_LFS)('Git LFS: the objects are uploaded with the push, so the other device checks the file out', async () => {
  // Every hook is disabled, git-lfs's pre-push too: the remote got a pointer to content that existed only on the
  // device that committed it, and every other device failed its pull with a smudge error.
  const t = await setupTestEnv('lfs');
  expect(Bun.spawnSync(['git', 'lfs', 'install', '--skip-repo'], { env: t.env }).exitCode).toBe(0);   // test gitconfig
  const r = await createRemote(t, { files: { 'README.md': '# n\n', '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' } });
  const a = await cloneRemote(t, r, 'a');
  const b = await cloneRemote(t, r, 'b');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const B = await startDaemon(t, { name: 'B', dir: b.dir, remote: r });
  const bytes = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
  await a.write('photo.bin', bytes);
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await r.show('photo.bin')).toContain('version https://git-lfs.github.com/spec/v1');
  expect((await B.flush(['--wait'])).code).toBe(0);
  expect([...new Uint8Array(await Bun.file(join(b.dir, 'photo.bin')).arrayBuffer())]).toEqual([...bytes]);
  expect(await b.porcelain()).toEqual([]);
}, 120_000);

test.if(HAS_LFS)('Git LFS: an incoming object the server does not have yet is a network error, retried, never stuck, nothing left behind', async () => {
  // r4: the smudge failed inside the rebase (case c), the run was remembered as stuck at {H, R} so the object arriving
  // later changed nothing, and the failed replay reset left R's new files for the next commit run to commit.
  const t = await setupTestEnv('lfs-missing-object');
  expect(Bun.spawnSync(['git', 'lfs', 'install', '--skip-repo'], { env: t.env }).exitCode).toBe(0);
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'x.md': 'x\n',
    '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' } });
  const store = lfsStore(t);
  const a = await cloneRemote(t, r, 'a');
  await store.configure(a);
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  // another device pushed a pointer whose upload never happened, plus plain edits
  const h = await cloneRemote(t, r, 'helper');
  const bytes = new Uint8Array(8192).map((_, i) => (i * 31) % 251);
  await h.write('z.bin', bytes);
  await h.write('x.md', 'x remote\n');
  await h.write('new.md', 'new\n');
  for (const args of [['add', '-A'], ['commit', '-qm', 'remote'], ['-c', 'core.hooksPath=/dev/null', 'push', '-q', 'origin', 'main']]) {
    expect((await h.git(args)).code).toBe(0);
  }
  await a.write('local.md', 'local\n');
  const m = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(1);
  const done = A.logs.slice(m).find((l: LogLine) => l.msg === 'sync done');
  expect(done?.outcome).toBe('network-error');
  expect(String(done?.error)).toContain('LFS download failed');
  expect(await a.porcelain()).toEqual([]);
  expect(await a.read('x.md')).toBe('x\n');
  expect(await a.read('new.md')).toBeUndefined();

  const oid = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  store.add(oid, join(h.dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid));
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect([...new Uint8Array(await Bun.file(join(a.dir, 'z.bin')).arrayBuffer())]).toEqual([...bytes]);
  expect(await a.read('x.md')).toBe('x remote\n');
  expect(await a.porcelain()).toEqual([]);
  expect(await r.tree()).toEqual(['.gitattributes', 'README.md', 'local.md', 'new.md', 'x.md', 'z.bin']);
}, 120_000);
