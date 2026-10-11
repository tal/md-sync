import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyIndexOps, buildTree, commitIndex, commitRun, commitTree, type IndexOp, stageForCommit,
} from '../../src/commit';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { GitError, lsTree, type TreeEntry } from '../../src/git';
import { conflictStamp, shortHostname } from '../../src/host';
import { conflictCopyPath } from '../../src/conflict-name';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { pendingChanges } from '../../src/pending';
import { addLocalOnly, readLocalOnly } from '../../src/state';
import type { CommitPlan } from '../../src/types';
import {
  cleanupAll, cloneRemote, type Clone, createRemote, type LogLine, type Remote, setupTestEnv, type TestEnv,
} from '../harness';

let t: TestEnv;
let remote: Remote;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const FIXED = Date.UTC(2026, 9, 8, 12, 34, 56);
const clock = { now: () => FIXED, setTimeout: () => 0, clearTimeout: () => {} };

beforeAll(async () => {
  t = await setupTestEnv('commit');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
  remote = await createRemote(t, { files: { 'README.md': '# notes\n', 'notes/a.md': 'a\n', 'old.md': 'old\n' } });
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

type Setup = { c: Clone; ctx: RunContext; logs: LogLine[] };

async function setup(o: { ignore?: string[]; from?: Remote; ignoreCase?: RunContext['ignoreCase'] } = {}): Promise<Setup> {
  const c = await cloneRemote(t, o.from ?? remote, `clone-${++n}`);
  const config: ReadyConfig = { dir: c.dir, remote: (o.from ?? remote).url, branch: 'main', idleMs: 60_000,
    fallbackMs: 3_600_000, maxWaitMs: 120_000, ignore: o.ignore ?? [], authorName: 'mdsync-test',
    authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => logs.push(JSON.parse(l) as LogLine) });
  const ctx = await createRunContext({ config, realDir: c.dir, paths, log, clock });
  return { c, ctx: o.ignoreCase !== undefined ? { ...ctx, ignoreCase: o.ignoreCase } : ctx, logs };
}

async function out(c: Clone, args: string[]): Promise<string> {
  const r = await c.git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const staged = (c: Clone) => out(c, ['diff', '--cached', '--name-only']).then((s) => s.split('\n').filter((l) => l !== '').sort());
const plan = (p: Partial<CommitPlan> = {}): CommitPlan => ({ scope: { kind: 'all' }, messages: [], tag: 'none', sources: ['flush'], ...p });
const msgs = (logs: LogLine[], msg: string) => logs.filter((l) => l.msg === msg);

describe('stageForCommit', () => {
  test("scope 'all' stages adds, edits and deletes, minus the ignore excludes", async () => {
    const { c, ctx } = await setup({ ignore: ['drafts', '*.tmp'] });
    await c.write('new.md', 'n');
    await c.write('notes/a.md', 'a2\n');
    await c.remove('old.md');
    await c.write('drafts/x.md', 'x');
    await c.write('scratch.tmp', 't');
    const r = await stageForCommit(ctx, { kind: 'all' });
    expect(r).toEqual({ kind: 'staged', changes: [
      { status: 'A', path: 'new.md' }, { status: 'M', path: 'notes/a.md' }, { status: 'D', path: 'old.md' },
    ] });
    expect(await staged(c)).toEqual(['new.md', 'notes/a.md', 'old.md']);
  });

  test('a conflict copy of a gitignored or ignore-matched original is never staged (stays local)', async () => {
    const { c, ctx } = await setup({ ignore: ['journal.md'] });
    const name = (p: string): string => conflictCopyPath(p, shortHostname(), conflictStamp(new Date(FIXED)), () => false);
    await c.write('.gitignore', '.env\nprivate/\n');
    // The .env copy was made while .env was untracked and gitignored (so it was recorded as local-only); since
    // then another device force-added .env: the original is tracked now, and the copy must still stay local.
    await c.write(name('.env'), 'API_KEY=supersecret\n');
    addLocalOnly(ctx.paths.localOnly, [name('.env')]);
    await c.write('.env', 'API_KEY=shared\n');
    await out(c, ['add', '-f', '.env', '.gitignore']);
    await out(c, ['commit', '-q', '-m', 'force-added .env']);
    await c.write(name('journal.md'), 'PRIVATE JOURNAL\n');
    await c.write(`${name('private')}/key.md`, 'private key note\n');
    await c.write(name('notes/a.md'), 'a shared copy\n');
    await c.write(name(name('journal.md')), 'copy of a copy\n');
    const r = await stageForCommit(ctx, { kind: 'all' });
    expect(r).toEqual({ kind: 'staged', changes: [{ status: 'A', path: name('notes/a.md') }] });
    // a flush that names a local-only copy still never stages it
    const p = await stageForCommit(ctx, { kind: 'paths', paths: [name('.env'), name('notes/a.md')] });
    expect(p).toEqual({ kind: 'staged', changes: [{ status: 'A', path: name('notes/a.md') }] });
  });

  test('a copy of a TRACKED file that a .gitignore pattern matches is synced like the file itself', async () => {
    const { c, ctx } = await setup();
    const name = (p: string): string => conflictCopyPath(p, shortHostname(), conflictStamp(new Date(FIXED)), () => false);
    await c.write('.gitignore', '*.private.md\n');
    await c.write('budget.private.md', 'tracked before the ignore line\n');
    await out(c, ['add', '-f', 'budget.private.md', '.gitignore']);
    await out(c, ['commit', '-q', '-m', 'tracked private file']);
    await c.write(name('budget.private.md'), 'HAND-EDIT saved by a rescue\n');
    await c.write(name('untracked.private.md'), 'a copy of an untracked, ignored file\n');
    expect((await pendingChanges(ctx)).map((e) => e.path)).toEqual([name('budget.private.md')]);
    const r = await stageForCommit(ctx, { kind: 'all' });
    expect(r).toEqual({ kind: 'staged', changes: [{ status: 'A', path: name('budget.private.md') }] });
  });

  test('local-only copies never count as pending, and deleted ones are forgotten by the next commit run', async () => {
    const { c, ctx } = await setup({ ignore: ['journal.md'] });
    const name = (p: string): string => conflictCopyPath(p, shortHostname(), conflictStamp(new Date(FIXED)), () => false);
    await c.write(name('journal.md'), 'PRIVATE\n');
    expect(await pendingChanges(ctx)).toEqual([]);   // a backup timer armed for it would only fire an empty run
    addLocalOnly(ctx.paths.localOnly, [name('journal.md'), 'gone (conflict h 2026-10-08 1234).md']);
    expect(await stageForCommit(ctx, { kind: 'all' })).toEqual({ kind: 'nothing' });
    expect([...readLocalOnly(ctx.paths.localOnly)]).toEqual([name('journal.md')]);
  });

  // chaos seed 111: `git add -A` exits 128 "unable to stat" when an entry it listed vanished before its lstat (an
  // editor's atomic-save temp renamed away). The window is inside git, so the test injects git's own failure.
  test('an entry that vanished during `git add` (exit 128, unable to stat) is not a failed run: the add runs again', async () => {
    const { c, ctx } = await setup();
    await c.write('notes/new.md', 'new\n');
    const VANISHED = "fatal: unable to stat 'notes/.new.md.sb-123': No such file or directory\n";
    const flaky = (stderr: string, times: number): { ctx: RunContext; adds: string[] } => {
      const adds: string[] = [];
      const run: RunContext['git']['run'] = async (args, o) => {
        if (args.includes('add')) {
          adds.push(args.join(' '));
          if (adds.length <= times) return { code: 128, stdout: '', stderr, timedOut: 'in-time', durationMs: 1 };
        }
        return ctx.git.run(args, o);
      };
      const ok: RunContext['git']['ok'] = async (args, o) => {
        const r = await run(args, o);
        if (r.code !== 0) throw new GitError(args, r, 'other');
        return r.stdout.replace(/\n+$/, '');
      };
      return { ctx: { ...ctx, git: { cwd: ctx.git.cwd, run, ok, bytes: ctx.git.bytes } }, adds };
    };
    const twice = flaky(VANISHED, 2);
    expect(await stageForCommit(twice.ctx, { kind: 'all' })).toMatchObject({ kind: 'staged', changes: [{ status: 'A', path: 'notes/new.md' }] });
    expect(twice.adds).toHaveLength(3);
    // one that keeps happening, or any other failure of the add, is still an error
    await expect(stageForCommit(flaky(VANISHED, 99).ctx, { kind: 'all' })).rejects.toThrow(GitError);
    const other = flaky('fatal: something else\n', 1);
    await expect(stageForCommit(other.ctx, { kind: 'all' })).rejects.toThrow(GitError);
    expect(other.adds).toHaveLength(1);
  });

  test("nothing to stage -> 'nothing'", async () => {
    const { ctx } = await setup();
    expect(await stageForCommit(ctx, { kind: 'all' })).toEqual({ kind: 'nothing' });
  });

  test('refuses while unmerged entries exist', async () => {
    const { c, ctx } = await setup();
    await out(c, ['checkout', '-q', '-b', 'side']);
    await c.write('README.md', 'side\n');
    await out(c, ['commit', '-qam', 'side']);
    await out(c, ['checkout', '-q', 'main']);
    await c.write('README.md', 'main\n');
    await out(c, ['commit', '-qam', 'main']);
    expect((await c.git(['merge', 'side'])).code).not.toBe(0);
    await expect(stageForCommit(ctx, { kind: 'all' })).rejects.toThrow('unmerged entries present');
  });

  test("scope 'paths' commits only the named paths and unstages everything else", async () => {
    const { c, ctx, logs } = await setup({ ignore: ['drafts'] });
    await c.write('.git/info/exclude', 'secret.md\n');
    await c.write('a.md', 'a');
    await c.write('sub/b.md', 'b');
    await c.write('c.md', 'c');
    await c.write('drafts/d.md', 'd');
    await c.write('secret.md', 's');
    await c.remove('old.md');
    await out(c, ['add', 'c.md']);                          // staged before: must not ride along
    const r = await stageForCommit(ctx, { kind: 'paths',
      paths: ['./a.md', 'sub//b.md', 'a.md', 'drafts/d.md', 'secret.md', 'gone.md', 'old.md'] });
    expect(r).toEqual({ kind: 'staged', changes: [
      { status: 'A', path: 'a.md' }, { status: 'D', path: 'old.md' }, { status: 'A', path: 'sub/b.md' },
    ] });
    expect(await staged(c)).toEqual(['a.md', 'old.md', 'sub/b.md']);
    expect(msgs(logs, 'flush paths dropped')).toHaveLength(1);
    expect(msgs(logs, 'flush paths dropped')[0]!.dropped).toEqual([
      { path: 'drafts/d.md', reason: 'ignored' }, { path: 'secret.md', reason: 'ignored' },
      { path: 'gone.md', reason: 'missing' },
    ]);
  });

  test("scope 'paths' with nothing left -> 'nothing'", async () => {
    const { c, ctx } = await setup();
    await c.write('a.md', 'a');
    await out(c, ['add', 'a.md']);
    expect(await stageForCommit(ctx, { kind: 'paths', paths: ['missing.md'] })).toEqual({ kind: 'nothing' });
    expect(await staged(c)).toEqual([]);
  });

  test('a directory path stages its contents', async () => {
    const { c, ctx } = await setup({ ignore: ['*.tmp'] });
    await c.write('dir/x.md', 'x');
    await c.write('dir/y.tmp', 'y');
    await c.write('other.md', 'o');
    const r = await stageForCommit(ctx, { kind: 'paths', paths: ['dir'] });
    expect(r).toEqual({ kind: 'staged', changes: [{ status: 'A', path: 'dir/x.md' }] });
  });

  test('case-insensitive: index paths that differ only in case are never staged', async () => {
    const { c, ctx, logs } = await setup({ ignoreCase: 'case-insensitive' });
    const blob = await out(c, ['hash-object', '-w', 'notes/a.md']);
    await out(c, ['update-index', '--add', '--cacheinfo', `100644,${blob},Notes/A.md`]);
    await out(c, ['commit', '-qm', 'dup']);
    await c.write('notes/a.md', 'edited\n');
    await c.write('other.md', 'o');
    const r = await stageForCommit(ctx, { kind: 'all' });
    expect(r).toEqual({ kind: 'staged', changes: [{ status: 'A', path: 'other.md' }] });
    const cc = msgs(logs, 'case collision');
    expect(cc).toHaveLength(1);
    expect(cc[0]!.paths).toEqual(['Notes/A.md', 'notes/a.md']);
    expect(cc[0]!.action).toBe('unstaged');
  });

  test('large files are logged', async () => {
    const { c, ctx, logs } = await setup();
    await c.write('big.bin', new Uint8Array(5 * 1024 * 1024 + 1));
    await c.write('small.md', 's');
    await stageForCommit(ctx, { kind: 'all' });
    expect(msgs(logs, 'large file').map((l) => [l.path, l.bytes])).toEqual([['big.bin', 5 * 1024 * 1024 + 1]]);
  });
});

describe('commitRun / commitIndex', () => {
  test('commits with the built message, the configured identity, and logs `committed`', async () => {
    const { c, ctx, logs } = await setup();
    await c.write('a.md', 'a');
    const r = await commitRun(ctx, plan({ messages: [' did X ', 'did X'], sources: ['backup', 'flush'] }));
    expect(r.kind).toBe('committed');
    if (r.kind !== 'committed') return;
    expect(r.sha).toBe(await out(c, ['rev-parse', 'HEAD']));
    expect(r.changes).toEqual([{ status: 'A', path: 'a.md' }]);
    expect(await out(c, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s'])).toBe(
      'mdsync-test <test@test.invalid>|mdsync-test <test@test.invalid>|did X');
    expect(await out(c, ['log', '-1', '--format=%b'])).toBe('Changed files:\nA\ta.md');
    const done = msgs(logs, 'committed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ sha: r.sha, files: 1, subject: 'did X', source: 'flush' });
  });

  test('(auto) subject from a backup run', async () => {
    const { c, ctx, logs } = await setup();
    await c.write('a.md', 'a');
    await commitRun(ctx, plan({ tag: 'auto', sources: ['backup'] }));
    expect(await out(c, ['log', '-1', '--format=%s'])).toBe(`sync ${shortHostname()} 2026-10-08T12:34:56Z (auto)`);
    expect(msgs(logs, 'committed')[0]!.source).toBe('backup');
  });

  test("nothing staged -> 'nothing' and a debug log, no commit", async () => {
    const { c, ctx, logs } = await setup();
    const before = await out(c, ['rev-parse', 'HEAD']);
    expect(await commitRun(ctx, plan())).toEqual({ kind: 'nothing' });
    expect(await out(c, ['rev-parse', 'HEAD'])).toBe(before);
    expect(msgs(logs, 'nothing to commit')[0]!.level).toBe('debug');
  });

  test("a held index.lock surfaces as GitError with failure 'locked'", async () => {
    const { c, ctx } = await setup();
    await c.write('a.md', 'a');
    writeFileSync(join(c.dir, '.git', 'index.lock'), '');
    const err = await commitRun(ctx, plan()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).failure).toBe('locked');
  });

  test('commitIndex on an unborn branch', async () => {
    const empty = await createRemote(t, { seed: 'empty' });
    const { c, ctx } = await setup({ from: empty });
    await c.write('first.md', 'f');
    await out(c, ['add', '-A']);
    const sha = await commitIndex(ctx, 'first\n\nbody');
    expect(sha).toBe(await out(c, ['rev-parse', 'refs/heads/main']));
    expect(await out(c, ['log', '-1', '--format=%s'])).toBe('first');
  });
});

describe('index ops and temporary-index trees', () => {
  async function blob(c: Clone, content: string): Promise<string> {
    const p = join(c.dir, '..', `blob-${++n}`);
    writeFileSync(p, content);
    return out(c, ['hash-object', '-w', p]);
  }

  test('applyIndexOps sets and removes entries in the real index', async () => {
    const { c, ctx } = await setup();
    const sha = await blob(c, 'copy\n');
    await applyIndexOps(ctx, [{ op: 'set', path: 'x (conflict).md', mode: '100644', sha }, { op: 'remove', path: 'old.md' }]);
    const ls = await out(c, ['ls-files', '-s']);
    expect(ls).toContain(`100644 ${sha} 0\tx (conflict).md`);
    expect(ls).not.toContain('old.md');
  });

  test('buildTree = parent + ops, never touches .git/index, removes its temp index', async () => {
    const { c, ctx } = await setup();
    const head = await out(c, ['rev-parse', 'HEAD']);
    const indexBefore = readFileSync(join(c.dir, '.git', 'index'));
    const sha = await blob(c, 'new\n');
    const ops: IndexOp[] = [{ op: 'set', path: 'deep/new.md', mode: '100755', sha }, { op: 'remove', path: 'old.md' }];
    const t1 = await buildTree(ctx, head, ops);
    const expected = new Map<string, TreeEntry>(await lsTree(ctx.git, head));
    expected.delete('old.md');
    expected.set('deep/new.md', { mode: '100755', type: 'blob', sha });
    expect(t1.entries).toEqual(expected);
    expect(await out(c, ['rev-parse', `${head}^{tree}`])).not.toBe(t1.tree);
    expect(readFileSync(join(c.dir, '.git', 'index')).equals(indexBefore)).toBe(true);
    expect(readdirSync(ctx.paths.tmp)).toEqual([]);

    const t2 = await buildTree(ctx, 'empty', [{ op: 'set', path: 'only.md', mode: '100644', sha }]);
    expect([...t2.entries.keys()]).toEqual(['only.md']);
  });

  test('a file/dir clash is silently reshaped by update-index, so callers must verify', async () => {
    const { c, ctx } = await setup();
    const head = await out(c, ['rev-parse', 'HEAD']);
    const sha = await blob(c, 'x\n');
    const ops: IndexOp[] = [{ op: 'set', path: 'README.md/x.md', mode: '100644', sha }];
    const built = await buildTree(ctx, head, ops);
    const naive = new Map(await lsTree(ctx.git, head));
    naive.set('README.md/x.md', { mode: '100644', type: 'blob', sha });
    expect(built.entries).not.toEqual(naive);
  });

  test('commitTree with and without a parent uses the configured identity', async () => {
    const { c, ctx } = await setup();
    const head = await out(c, ['rev-parse', 'HEAD']);
    const tree = await out(c, ['rev-parse', `${head}^{tree}`]);
    const withParent = await commitTree(ctx, tree, head, 'subject line\n\nbody\n');
    expect(await out(c, ['log', '-1', '--format=%P|%an|%cn|%s', withParent])).toBe(`${head}|mdsync-test|mdsync-test|subject line`);
    const root = await commitTree(ctx, tree, 'none', 'root');
    expect(await out(c, ['log', '-1', '--format=%P|%s', root])).toBe('|root');
  });

  test('copies-only commit through a temporary index leaves other staged entries staged and uncommitted', async () => {
    // Building a copies tree must not consume unrelated entries in the real index.
    const { c, ctx } = await setup();
    await c.write('staged-work.md', 'not for this commit');
    await out(c, ['add', 'staged-work.md']);
    await c.write('x (conflict h 2026-10-08 1234).md', 'copy');
    const head = await out(c, ['rev-parse', 'HEAD']);
    const sha = await out(c, ['hash-object', '-w', 'x (conflict h 2026-10-08 1234).md']);
    const ops: IndexOp[] = [{ op: 'set', path: 'x (conflict h 2026-10-08 1234).md', mode: '100644', sha }];
    const built = await buildTree(ctx, head, ops);
    const commit = await commitTree(ctx, built.tree, head, 'copies');
    await out(c, ['update-ref', 'refs/heads/main', commit, head]);
    await applyIndexOps(ctx, ops);
    expect(await out(c, ['show', '--name-only', '--format=', 'HEAD'])).toBe('x (conflict h 2026-10-08 1234).md');
    expect(await staged(c)).toEqual(['staged-work.md']);
    expect(await c.porcelain()).toEqual(['A  staged-work.md']);
  });
});

test('fixture sanity: the state dir is outside the repo', async () => {
  const { c, ctx } = await setup();
  expect(ctx.paths.tmp.startsWith(c.dir)).toBe(false);
  expect(existsSync(ctx.paths.stateDir) && statSync(ctx.paths.stateDir).isDirectory()).toBe(true);
});
