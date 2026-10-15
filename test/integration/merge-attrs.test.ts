// A path's `merge` attribute (gitattributes(5)) in the move's merger (review round 5
// d28-semantics-3): an uncommitted edit is merged the way the old `rebase --autostash` apply merged it, by git's own
// driver for the path: `merge=union` keeps both sides' lines in place, `-merge`/`merge=binary` never merge, and a
// configured `merge.<name>.driver` runs. Before, every uncommitted edit went through a plain line merge, so an append to
// a `merge=union` log became a conflict copy that was committed and pushed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { createLogger } from '../../src/log';
import { type MoveInput, moveWorktree } from '../../src/move';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { syncRun } from '../../src/sync';
import type { RunOptions } from '../../src/types';
import { cleanupAll, cloneRemote, type Clone, createRemote, type LogLine, type Remote, setupTestEnv, type TestEnv } from '../harness';

setDefaultTimeout(60_000);

let t: TestEnv;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const NORMAL: RunOptions = { mode: 'normal', stuck: 'none', keptStashes: [], integrated: 'none', cloned: 'none' };

beforeAll(async () => {
  t = await setupTestEnv('merge-attrs');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

type Fx = { remote: Remote; c: Clone; ctx: RunContext; logs: LogLine[] };

async function out(c: Clone, args: string[]): Promise<string> {
  const r = await c.git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function fixture(seed: Record<string, string>): Promise<Fx> {
  const remote = await createRemote(t, { files: seed });
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  const config: ReadyConfig = { dir: c.dir, remote: remote.url, branch: 'main', idleMs: 60_000, fallbackMs: 3_600_000,
    maxWaitMs: 120_000, autoCommit: 'timers', ignore: [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (line) => { logs.push(JSON.parse(line) as LogLine); } });
  return { remote, c, ctx: await createRunContext({ config, realDir: c.dir, paths, log }), logs };
}

async function pullWith(fx: Fx, remote: Record<string, string>, local: Record<string, string>): Promise<Awaited<ReturnType<typeof moveWorktree>>> {
  const h = await fx.c.head();
  await fx.remote.push(remote, 'remote');
  await out(fx.c, ['fetch', '-q', 'origin']);
  const r = await out(fx.c, ['rev-parse', 'refs/remotes/origin/main']);
  for (const [p, body] of Object.entries(local)) await fx.c.write(p, body);
  const i: MoveInput = { reason: 'pull', from: h, to: r, ref: { kind: 'update', ref: 'refs/heads/main', old: h, head: 'as-is' },
    index: 'changed-paths', edits: 'merge', copies: 'commit' };
  return moveWorktree(fx.ctx, i);
}

describe('the move merges an uncommitted edit by the path\'s merge attribute', () => {
  test('merge=union: both appended lines stay in place (remote first, as the autostash apply did), no copy', async () => {
    const fx = await fixture({ '.gitattributes': '*.md merge=union\n', 'log.md': 'l1\nl2\n' });
    const mv = await pullWith(fx, { 'log.md': 'l1\nl2\nREMOTE\n' }, { 'log.md': 'l1\nl2\nLOCAL\n' });
    expect(mv).toMatchObject({ kind: 'moved', copies: [], commit: 'none' });
    expect(await fx.c.read('log.md')).toBe('l1\nl2\nREMOTE\nLOCAL\n');
    expect(await fx.c.conflictCopies()).toEqual([]);
    expect(fx.logs.some((l) => l.msg === 'conflict')).toBe(false);
    expect(await fx.c.porcelain()).toEqual([' M log.md']);
  });

  test('-merge (and merge=binary): never merged, even where the lines would merge cleanly: a copy', async () => {
    for (const attr of ['-merge', 'merge=binary']) {
      const fx = await fixture({ '.gitattributes': `*.md ${attr}\n`, 'n.md': 'l1\nl2\nl3\nl4\n' });
      const mv = await pullWith(fx, { 'n.md': 'R1\nl2\nl3\nl4\n' }, { 'n.md': 'l1\nl2\nl3\nL4\n' });
      expect(mv.kind).toBe('moved');
      expect(await fx.c.read('n.md')).toBe('R1\nl2\nl3\nl4\n');
      const copies = await fx.c.conflictCopies();
      expect(copies).toHaveLength(1);
      expect(await fx.c.read(copies[0] as string)).toBe('l1\nl2\nl3\nL4\n');
    }
  });

  test('a configured merge driver runs (remote as %A, the local edit as %B)', async () => {
    const fx = await fixture({ '.gitattributes': '*.md merge=both\n', 'n.md': 'base\n' });
    await out(fx.c, ['config', 'merge.both.driver', 'cat %B >> %A']);
    const mv = await pullWith(fx, { 'n.md': 'remote\n' }, { 'n.md': 'local\n' });
    expect(mv).toMatchObject({ kind: 'moved', copies: [] });
    expect(await fx.c.read('n.md')).toBe('remote\nlocal\n');
  });

  test('an unknown driver name merges as text, as git does; no attribute at all is unchanged', async () => {
    const fx = await fixture({ '.gitattributes': '*.md merge=nosuchdriver\n', 'n.md': 'l1\nl2\nl3\nl4\n', 'p.txt': 'l1\nl2\nl3\nl4\n' });
    const mv = await pullWith(fx, { 'n.md': 'R1\nl2\nl3\nl4\n', 'p.txt': 'R1\nl2\nl3\nl4\n' },
      { 'n.md': 'l1\nl2\nl3\nL4\n', 'p.txt': 'l1\nl2\nl3\nL4\n' });
    expect(mv).toMatchObject({ kind: 'moved', copies: [] });
    expect(await fx.c.read('n.md')).toBe('R1\nl2\nl3\nL4\n');
    expect(await fx.c.read('p.txt')).toBe('R1\nl2\nl3\nL4\n');
  });
});

describe('a pull-only sync run (ntfy) with merge=union', () => {
  test('the same outcome as `git rebase --autostash`: one file holding both entries, nothing committed or pushed', async () => {
    const fx = await fixture({ '.gitattributes': '*.md merge=union\n', 'log.md': 'l1\nl2\n' });
    const twin = await cloneRemote(t, fx.remote, `twin-${++n}`);
    for (const c of [fx.c, twin]) await c.write('log.md', 'l1\nl2\nLOCAL\n');
    await fx.remote.push({ 'log.md': 'l1\nl2\nREMOTE\n' }, 'remote appends');
    await out(twin, ['fetch', '-q', 'origin']);
    await out(twin, ['rebase', '--autostash', 'origin/main']);
    const res = await syncRun(fx.ctx, { kind: 'pull-only', reasons: ['ntfy'] }, 1, NORMAL);
    expect(res.outcome).toBe('ok');
    expect(await fx.c.read('log.md')).toBe(await twin.read('log.md'));
    expect(await fx.c.read('log.md')).toBe('l1\nl2\nREMOTE\nLOCAL\n');
    expect(await fx.remote.tree()).toEqual(['.gitattributes', 'log.md']);
    expect(fx.logs.some((l) => l.msg === 'committed')).toBe(false);
  });
});
