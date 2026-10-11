// Git LFS transfers under the network no-output limit (review round 4): git-lfs prints no progress when its
// stderr is a pipe, so a long upload was silent and killed after NETWORK_TIMEOUT_MS, every retry from zero.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createGitClient, gitEnv } from '../../src/git';
import { createLogger } from '../../src/log';
import { cleanupAll, cloneRemote, createRemote, HAS_LFS, lfsStore, setupTestEnv, type TestEnv } from '../harness';

let t: TestEnv;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'HOME'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  t = await setupTestEnv('git-lfs');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

test('network ops force git-lfs progress; local ops and other env are left alone', () => {
  const id = { name: 'n', email: 'e' };
  expect(gitEnv(id, { kind: 'network' }, {}).GIT_LFS_FORCE_PROGRESS).toBe('1');
  expect(gitEnv(id, { kind: 'local' }, {}).GIT_LFS_FORCE_PROGRESS).toBeUndefined();
});

test.if(HAS_LFS)('a slow LFS upload that makes progress outlives the no-output limit; the same upload, silent, would not', async () => {
  expect(Bun.spawnSync(['git', 'lfs', 'install', '--skip-repo'], { env: t.env }).exitCode).toBe(0);
  const r = await createRemote(t, { files: { 'README.md': '# n\n', '.gitattributes': '*.bin filter=lfs diff=lfs merge=lfs -text\n' } });
  const a = await cloneRemote(t, r, 'a');
  const store = lfsStore(t, { uploadMs: 3_000 });
  await store.configure(a);
  await a.write('photo.bin', new Uint8Array(64 * 1024).map((_, i) => i % 251));
  expect((await a.git(['add', '-A'])).code).toBe(0);
  expect((await a.git(['commit', '-qm', 'photo'])).code).toBe(0);
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(l) });
  const g = createGitClient({ cwd: a.dir, identity: { name: 'n', email: 'e' }, log });
  // 1.5 s without output kills it (NETWORK_TIMEOUT_MS, shrunk); the upload takes 3 s
  const res = await g.run(['lfs', 'push', 'origin', 'main'], { kind: 'network', timeoutMs: 1_500 });
  expect(res.timedOut).toBe('in-time');
  expect(res.code).toBe(0);
  expect(res.durationMs).toBeGreaterThan(2_500);
  expect(`${res.stdout}${res.stderr}`).toContain('Uploading LFS objects');   // the progress git-lfs was made to print kept it alive
}, 60_000);
