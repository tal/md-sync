import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { aheadCount, ignoredDirs, pendingChanges, trackedDirty } from '../../src/pending';
import { cleanupAll, cloneRemote, type Clone, createRemote, type Remote, setupTestEnv, type TestEnv } from '../harness';

let t: TestEnv;
let remote: Remote;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  t = await setupTestEnv('pending');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
  remote = await createRemote(t, { files: { 'README.md': '# notes\n', 'drafts/d.md': 'tracked draft\n' } });
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

async function setup(o: { ignore?: string[]; from?: Remote } = {}): Promise<{ c: Clone; ctx: RunContext }> {
  const c = await cloneRemote(t, o.from ?? remote, `clone-${++n}`);
  const config: ReadyConfig = { dir: c.dir, remote: (o.from ?? remote).url, branch: 'main', idleMs: 60_000,
    fallbackMs: 3_600_000, maxWaitMs: 120_000, autoCommit: 'timers', ignore: o.ignore ?? [], authorName: 'mdsync-test',
    authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const log = createLogger({ level: 'error', sink: 'stdout', write: () => {} });
  return { c, ctx: await createRunContext({ config, realDir: c.dir, paths, log }) };
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : 1);

describe('pendingChanges', () => {
  test('lists modified, deleted and every untracked file (-uall), unquoted', async () => {
    const { c, ctx } = await setup();
    await c.write('README.md', 'changed\n');
    await c.remove('drafts/d.md');
    await c.write('deep/er/new file "q".md', 'x');
    const got = (await pendingChanges(ctx)).sort(byPath);
    expect(got).toEqual([
      { xy: ' M', path: 'README.md' },
      { xy: '??', path: 'deep/er/new file "q".md' },
      { xy: ' D', path: 'drafts/d.md' },
    ]);
  });

  test('applies the ignore excludes and .gitignore', async () => {
    const { c, ctx } = await setup({ ignore: ['drafts', '*.tmp'] });
    await c.write('.gitignore', 'secret.md\n');
    await c.git(['add', '.gitignore']);
    await c.git(['commit', '-qm', 'gi']);
    await c.write('drafts/d.md', 'edited tracked draft\n');
    await c.write('a.tmp', 'x');
    await c.write('secret.md', 's');
    await c.write('keep.md', 'k');
    expect(await pendingChanges(ctx)).toEqual([{ xy: '??', path: 'keep.md' }]);
  });

  test('limits to literal paths; an empty list is nothing; > 200 paths falls back to everything', async () => {
    const { c, ctx } = await setup();
    await c.write('a.md', 'a');
    await c.write('b.md', 'b');
    await c.write('[x].md', 'x');
    expect(await pendingChanges(ctx, ['a.md'])).toEqual([{ xy: '??', path: 'a.md' }]);
    expect(await pendingChanges(ctx, ['[x].md'])).toEqual([{ xy: '??', path: '[x].md' }]);   // literal, not a glob
    expect(await pendingChanges(ctx, ['nope.md'])).toEqual([]);
    expect(await pendingChanges(ctx, [])).toEqual([]);
    const many = Array.from({ length: 201 }, (_, i) => `n${i}.md`);
    expect((await pendingChanges(ctx, many)).map((e) => e.path).sort()).toEqual(['[x].md', 'a.md', 'b.md']);
  });

  test('clean tree is empty', async () => {
    const { ctx } = await setup();
    expect(await pendingChanges(ctx)).toEqual([]);
  });
});

describe('trackedDirty', () => {
  test('tracked changes only, and no ignore excludes', async () => {
    const { c, ctx } = await setup({ ignore: ['drafts'] });
    await c.write('drafts/d.md', 'edited\n');
    await c.write('untracked.md', 'u');
    await c.write('staged.md', 's');
    await c.git(['add', 'staged.md']);
    expect((await trackedDirty(ctx)).sort(byPath)).toEqual([
      { xy: ' M', path: 'drafts/d.md' },
      { xy: 'A ', path: 'staged.md' },
    ]);
  });
});

describe('aheadCount', () => {
  test('counts local commits not on origin/B', async () => {
    const { c, ctx } = await setup();
    expect(await aheadCount(ctx)).toBe(0);
    await c.write('x.md', 'x');
    await c.git(['add', '-A']);
    await c.git(['commit', '-qm', 'one']);
    await c.write('y.md', 'y');
    await c.git(['add', '-A']);
    await c.git(['commit', '-qm', 'two']);
    expect(await aheadCount(ctx)).toBe(2);
  });

  test("'no-remote-branch' for an empty remote, 0 for an unborn HEAD with a remote branch", async () => {
    const empty = await createRemote(t, { seed: 'empty' });
    const { c, ctx } = await setup({ from: empty });
    expect(await aheadCount(ctx)).toBe('no-remote-branch');
    await c.write('x.md', 'x');
    await c.git(['add', '-A']);
    await c.git(['commit', '-qm', 'first']);
    expect(await aheadCount(ctx)).toBe('no-remote-branch');

    const { c: c2, ctx: ctx2 } = await setup();
    await c2.git(['symbolic-ref', 'HEAD', 'refs/heads/unborn-branch']);
    expect(await aheadCount({ ...ctx2 })).toBe(0);
  });
});

describe('ignoredDirs', () => {
  test('gitignored directories, repo-relative, without the trailing slash', async () => {
    const { c, ctx } = await setup();
    await c.write('.gitignore', 'build/\nnode_modules\n*.log\n');
    await c.write('build/out.js', 'x');
    await c.write('sub/node_modules/pkg/index.js', 'x');
    await c.write('debug.log', 'x');
    await c.write('untracked/build/x.o', 'x');
    expect((await ignoredDirs(ctx)).sort()).toEqual(['build', 'sub/node_modules', 'untracked/build']);
  });

  test('a plain folder whose contents are all ignored is not itself ignored', async () => {
    const { c, ctx } = await setup();
    await c.write('.gitignore', 'node_modules/\n');
    await c.write('proj/node_modules/a.js', 'x');
    mkdirSync(join(c.dir, 'proj', 'empty'), { recursive: true });
    expect(await ignoredDirs(ctx)).toEqual(['proj/node_modules']);
  });
});
