import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { conflictStamp, shortHostname } from '../../src/host';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { outcomeLevel, syncRun } from '../../src/sync';
import type { CommitPlan, RunOptions, RunRequest, StuckRecord } from '../../src/types';
import {
  backdate, cleanupAll, cloneRemote, type Clone, createRemote, holdLiveGit, type LogLine, makeStoppedRebase,
  raceUploadPack, type Remote, setupTestEnv, type TestEnv,
} from '../harness';

let t: TestEnv;
let n = 0;
let runId = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const FIXED = Date.UTC(2026, 9, 8, 12, 34, 56);
const clock = { now: () => FIXED, setTimeout: () => 0, clearTimeout: () => {} };
const TAG = `(conflict ${shortHostname()} ${conflictStamp(new Date(FIXED))})`;

const FIVE = 'l1\nl2\nl3\nl4\nl5\n';
const LOCAL = 'l1\nl2\nLOCAL three\nl4\nl5\n';
const REMOTE = 'l1\nl2\nREMOTE three\nl4\nl5\n';
const SEED = { 'README.md': '# notes\n', 'note.md': FIVE, 'x.md': 'x\n' };

const NORMAL: RunOptions = { mode: 'normal', stuck: 'none', keptStashes: [], integrated: 'none', cloned: 'none' };
const PULL: RunRequest = { kind: 'pull-only', reasons: ['ntfy'] };
function commitReq(o: Partial<CommitPlan> = {}): RunRequest {
  return { kind: 'commit', reasons: ['flush'],
    commit: { scope: { kind: 'all' }, messages: [], tag: 'none', sources: ['flush'], ...o } };
}

beforeAll(async () => {
  t = await setupTestEnv('sync');
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

async function contextFor(c: Clone, remote: Remote): Promise<{ ctx: RunContext; logs: LogLine[] }> {
  const config: ReadyConfig = { dir: c.dir, remote: remote.url, branch: 'main', idleMs: 60_000, fallbackMs: 3_600_000,
    maxWaitMs: 120_000, autoCommit: 'timers', ignore: [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => logs.push(JSON.parse(l) as LogLine) });
  return { ctx: await createRunContext({ config, realDir: c.dir, paths, log, clock }), logs };
}

async function fixture(o: { seed?: Record<string, string> } = {}): Promise<Fx> {
  const remote = await createRemote(t, { files: o.seed ?? SEED });
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  return { remote, c, ...await contextFor(c, remote) };
}

function run(fx: Fx, req: RunRequest, opts: RunOptions = NORMAL) {
  return syncRun(fx.ctx, req, ++runId, opts);
}

function gitCalls(logs: LogLine[]): string[][] {
  return logs.filter((l) => l.msg === 'git').map((l) => l.args as string[]);
}

function done(logs: LogLine[]): LogLine | undefined {
  return logs.filter((l) => l.msg === 'sync done').at(-1);
}

test('outcomeLevel', () => {
  expect(outcomeLevel('ok')).toBe('info');
  expect(outcomeLevel('conflict-resolved')).toBe('info');
  expect(outcomeLevel('network-error')).toBe('warn');
  expect(outcomeLevel('busy')).toBe('warn');
  expect(outcomeLevel('failed')).toBe('error');
  expect(outcomeLevel('data-guard-stop')).toBe('error');
});

describe('plain runs', () => {
  test('nothing to do', async () => {
    const fx = await fixture();
    const head = await fx.c.head();
    const res = await run(fx, PULL);
    expect(res).toMatchObject({ kind: 'pull-only', mode: 'normal', reasons: ['ntfy'], outcome: 'ok', commitStep: 'not-applicable',
      commitsIn: 0, commitsOut: 0, head, committed: 'none', conflicts: [], overriddenDeletes: [], keptStashes: [], integrated: head });
    expect(res.error).toBeUndefined();
    expect(res.startedAt).toBe(new Date(FIXED).toISOString());
    expect(fx.logs.find((l) => l.msg === 'sync start')).toMatchObject({ runId: res.runId, kind: 'pull-only', reasons: ['ntfy'], mode: 'normal' });
    expect(done(fx.logs)).toMatchObject({ level: 'info', outcome: 'ok', conflicts: 0, head });
    expect(fx.logs.some((l) => l.msg === 'up to date')).toBe(true);
    expect(gitCalls(fx.logs).some((a) => a.includes('rebase') || a[0] === 'push')).toBe(false);
  });

  test('clean pull: fast-forward to the remote, nothing pushed', async () => {
    const fx = await fixture();
    const pushed = await fx.remote.push({ 'r.md': 'remote\n' }, 'remote adds r');
    const res = await run(fx, PULL);
    expect(res).toMatchObject({ outcome: 'ok', commitsIn: 1, commitsOut: 0, head: pushed });
    expect(await fx.c.read('r.md')).toBe('remote\n');
    expect(fx.logs.some((l) => l.msg === 'rebasing')).toBe(true);
  });

  test('commit run pushes', async () => {
    const fx = await fixture();
    await fx.c.write('a.md', 'a\n');
    const res = await run(fx, commitReq({ messages: ['add a'] }));
    expect(res).toMatchObject({ outcome: 'ok', commitStep: 'committed', commitsOut: 1 });
    expect(res.committed).toBe(res.head);
    expect(await fx.remote.head()).toBe(res.head);
    expect((await fx.remote.log())[0]?.subject).toBe('add a');
    expect(await fx.remote.show('a.md')).toBe('a\n');
    expect(fx.logs.some((l) => l.msg === 'pushed' && l.head === res.head && l.commitsOut === 1)).toBe(true);
    expect(await out(fx.c, ['rev-parse', 'refs/remotes/origin/main'])).toBe(res.head);
  });

  test('commit run with nothing staged still pulls', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'r.md': 'remote\n' }, 'remote');
    const res = await run(fx, commitReq());
    expect(res).toMatchObject({ outcome: 'ok', commitStep: 'nothing-staged', committed: 'none', commitsIn: 1, commitsOut: 0 });
  });

  test('pull-only run keeps unflushed local changes uncommitted', async () => {
    const fx = await fixture();
    await fx.c.write('x.md', 'local edit\n');
    await fx.c.write('new.md', 'untracked\n');
    const pushed = await fx.remote.push({ 'remote.md': 'r\n' }, 'remote');
    const res = await run(fx, PULL);
    expect(res).toMatchObject({ outcome: 'ok', head: pushed, commitsOut: 0 });
    expect((await fx.c.porcelain()).sort()).toEqual([' M x.md', '?? new.md']);
    expect(await fx.c.read('remote.md')).toBe('r\n');
    expect((await fx.remote.log()).some((c) => c.authorName === 'mdsync-test')).toBe(false);
  });
});

describe('failures and retries', () => {
  test('non-fast-forward push is retried after a re-fetch and succeeds', async () => {
    const fx = await fixture();
    const race = await raceUploadPack(t, fx.remote);
    const saved = new Map(Object.keys(race.env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, race.env);
    try {
      await race.arm();
      await fx.c.write('mine.md', 'mine\n');
      const res = await run(fx, commitReq());
      expect(res.outcome).toBe('ok');
      expect(race.fired()).toBe(true);
      const rejected = fx.logs.filter((l) => l.msg === 'push rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({ attempt: 1, delayMs: 500, reason: 'fetch first' });
      expect(res.commitsIn).toBeGreaterThanOrEqual(1);
      expect(await fx.remote.head()).toBe(res.head);
      const subjects = (await fx.remote.log()).map((c) => c.subject);
      expect(subjects).toContain('race commit');
      expect(await fx.remote.show('mine.md')).toBe('mine\n');
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('unreachable remote: local commit kept, network-error; pushed once the remote is back', async () => {
    const fx = await fixture();
    await fx.remote.setUnreachable();
    await fx.c.write('a.md', 'a\n');
    const res = await run(fx, commitReq());
    expect(res).toMatchObject({ outcome: 'network-error', commitStep: 'committed', commitsOut: 0 });
    expect(res.error).toContain('fetch failed');
    expect(fx.logs.some((l) => l.msg === 'network error' && l.op === 'fetch' && l.timedOut === 'in-time')).toBe(true);
    expect(done(fx.logs)?.level).toBe('warn');
    await fx.remote.restore();
    const again = await run(fx, PULL);
    expect(again).toMatchObject({ outcome: 'ok', commitsOut: 1 });
    expect(await fx.remote.show('a.md')).toBe('a\n');
  });

  test('a live git holding a lock makes the run busy without touching the lock', async () => {
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    backdate(lock, 120_000);
    const holder = await holdLiveGit(fx.c.dir);
    try {
      const res = await run(fx, commitReq());
      expect(res).toMatchObject({ outcome: 'busy', commitStep: 'not-reached' });
      expect(res.error).toContain('lock-live-git');
      expect(existsSync(lock)).toBe(true);
    } finally {
      await holder.release();
    }
  });

  test('a remembered S5 failure at the same {head, remote} is returned without rebasing', async () => {
    const fx = await fixture();
    await fx.c.write('note.md', LOCAL);
    await out(fx.c, ['commit', '-q', '-am', 'local']);
    const r = await fx.remote.push({ 'note.md': REMOTE }, 'remote');
    const h = await fx.c.head();
    const stuck: StuckRecord = { head: h, remote: r, outcome: 'failed', error: 'boom', since: '2026-10-08T00:00:00.000Z' };
    const res = await run(fx, PULL, { mode: 'normal', stuck, keptStashes: [], integrated: 'none', cloned: 'none' });
    expect(res).toMatchObject({ outcome: 'failed', stuck: 'unchanged', s5: { head: h, remote: r } });
    expect(res.error).toBe('unchanged since 2026-10-08T00:00:00.000Z: boom');
    expect(gitCalls(fx.logs).some((a) => a.includes('rebase'))).toBe(false);
    expect(done(fx.logs)?.level).toBe('debug');
    expect(await fx.c.head()).toBe(h);
  });

  test('shutdown mode: no fetch, one push attempt, non-ff deferred', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'r.md': 'remote\n' }, 'remote');
    await fx.c.write('a.md', 'a\n');
    const res = await run(fx, { kind: 'commit', reasons: ['shutdown'],
      commit: { scope: { kind: 'all' }, messages: [], tag: 'auto', sources: ['shutdown'] } },
      { mode: 'shutdown', stuck: 'none', keptStashes: [], integrated: 'none', cloned: 'none' });
    expect(res).toMatchObject({ outcome: 'failed', mode: 'shutdown', commitStep: 'committed', error: 'push deferred to the next start' });
    expect(gitCalls(fx.logs).some((a) => a[0] === 'fetch')).toBe(false);
    expect(gitCalls(fx.logs).filter((a) => a[0] === 'push')).toHaveLength(1);
    expect(fx.logs.some((l) => l.msg === 'push deferred' && l.reason === 'non-ff' && l.ahead === 1)).toBe(true);
  });

  test('shutdown mode never creates B on a remote whose history is on other branches; an empty remote gets it', async () => {
    // S6-only skipped S3's "origin has no branch main" check, so a stop pushed the fork next to the remote's master.
    const fx = await fixture();
    const bare = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: fx.remote.path, env: t.env });
    bare(['branch', '-m', 'main', 'master']);
    bare(['symbolic-ref', 'HEAD', 'refs/heads/master']);
    await out(fx.c, ['update-ref', '-d', 'refs/remotes/origin/main']);
    await fx.c.write('a.md', 'a\n');
    const shutdownReq: RunRequest = { kind: 'commit', reasons: ['shutdown'],
      commit: { scope: { kind: 'all' }, messages: [], tag: 'auto', sources: ['shutdown'] } };
    const res = await run(fx, shutdownReq, { mode: 'shutdown', stuck: 'none', keptStashes: [], integrated: 'none', cloned: 'none' });
    expect(res).toMatchObject({ outcome: 'failed', commitStep: 'committed', commitsOut: 0 });
    expect(res.error).toContain('origin has no branch main (its default branch is master)');
    expect(gitCalls(fx.logs).filter((a) => a[0] === 'push')).toHaveLength(0);
    expect(bare(['for-each-ref', '--format=%(refname)', 'refs/heads']).stdout.toString().trim()).toBe('refs/heads/master');

    bare(['update-ref', '-d', 'refs/heads/master']);   // now the remote has no branches at all
    await fx.c.write('b.md', 'b\n');
    const res2 = await run(fx, shutdownReq, { mode: 'shutdown', stuck: 'none', keptStashes: [], integrated: 'none', cloned: 'none' });
    expect(res2).toMatchObject({ outcome: 'ok', commitsOut: 3 });
    expect(await fx.remote.head()).toBe(res2.head);
  });

  test('shutdown mode pushes when the remote has not moved', async () => {
    const fx = await fixture();
    await fx.c.write('a.md', 'a\n');
    const res = await run(fx, { kind: 'commit', reasons: ['shutdown'],
      commit: { scope: { kind: 'all' }, messages: [], tag: 'auto', sources: ['shutdown'] } },
      { mode: 'shutdown', stuck: 'none', keptStashes: [], integrated: 'none', cloned: 'none' });
    expect(res).toMatchObject({ outcome: 'ok', commitsOut: 1 });
    expect(await fx.remote.head()).toBe(res.head);
    expect((await fx.remote.log())[0]?.subject).toMatch(/ \(auto\)$/);
  });
});

describe('remote history rewrites (S3 before)', () => {
  // A local unpushed commit on top of a remote that had a secret; the remote is then force-pushed without it and
  // fetched by something other than the run (the tracking ref already points at the rewrite).
  async function rewritten(): Promise<{ fx: Fx; withSecret: string }> {
    const fx = await fixture();
    await fx.remote.push({ 'secret.md': 'API_KEY=x\n' }, 'oops secret');
    await out(fx.c, ['pull', '-q', '--ff-only']);
    const withSecret = await fx.c.head();
    await fx.c.write('note.md', LOCAL);
    await out(fx.c, ['commit', '-q', '-am', 'local']);
    const helper = await cloneRemote(t, fx.remote, `rewrite-${++n}`);
    await out(helper, ['reset', '-q', '--hard', 'HEAD~1']);
    await helper.write('c.md', 'c\n');
    await out(helper, ['add', '-A']);
    await out(helper, ['commit', '-q', '-m', 'rewritten']);
    await out(helper, ['push', '-q', '-f', 'origin', 'HEAD:main']);
    await out(fx.c, ['fetch', '-q', 'origin']);   // an editor's autofetch, or a run that fetched and then died
    return { fx, withSecret };
  }

  test('the state file\'s last integrated commit is used when the tracking ref already moved', async () => {
    const { fx, withSecret } = await rewritten();
    await out(fx.c, ['reflog', 'expire', '--expire=now', '--all']);   // no reflog: only the state knows
    const res = await run(fx, commitReq(), { ...NORMAL, integrated: withSecret });
    expect(res.outcome).toBe('ok');
    expect(fx.logs.find((l) => l.msg === 'remote history rewritten')).toMatchObject({ before: withSecret, localCommits: 1 });
    expect(await fx.remote.tree()).toEqual(['README.md', 'c.md', 'note.md', 'x.md']);
    expect(res.integrated).toBe(await fx.remote.head() as string);
  });

  test('with no state, the tracking ref\'s reflog (fork point) finds it', async () => {
    const { fx, withSecret } = await rewritten();
    const res = await run(fx, commitReq());
    expect(res.outcome).toBe('ok');
    expect(fx.logs.find((l) => l.msg === 'remote history rewritten')).toMatchObject({ before: withSecret });
    expect(await fx.remote.show('secret.md')).toBeUndefined();
  });

  test('a stale state entry (HEAD no longer contains it) is ignored', async () => {
    const fx = await fixture();
    const other = await fx.remote.push({ 'a.md': 'a\n' }, 'a');   // never integrated here
    await out(fx.c, ['fetch', '-q', 'origin']);
    await out(fx.c, ['reset', '-q', '--hard', 'origin/main']);
    const res = await run(fx, PULL, { ...NORMAL, integrated: 'f'.repeat(40) });
    expect(res.outcome).toBe('ok');
    expect(fx.logs.some((l) => l.msg === 'remote history rewritten')).toBe(false);
    expect(res.integrated).toBe(other);
  });
});

describe('conflicts', () => {
  test('rebase conflict: remote kept, one copy with the local version, everything pushed', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'note.md': REMOTE }, 'remote edits line 3');
    await fx.c.write('note.md', LOCAL);
    const res = await run(fx, commitReq({ messages: ['local edit'] }));
    const copy = `note ${TAG}.md`;
    expect(res).toMatchObject({ outcome: 'conflict-resolved', commitStep: 'committed', conflicts: [copy], commitsOut: 1 });
    expect(res.s5).toBeUndefined();
    expect(await fx.remote.head()).toBe(res.head);
    expect(await fx.remote.show('note.md')).toBe(REMOTE);
    expect(await fx.remote.show(copy)).toBe(LOCAL);
    expect((await fx.remote.log())[0]?.subject).toMatch(/ \(conflict\)$/);
    expect(await fx.c.porcelain()).toEqual([]);
    expect(await fx.c.stashList()).toEqual([]);
    expect(done(fx.logs)).toMatchObject({ outcome: 'conflict-resolved', conflicts: 1 });
  });

  test('non-overlapping edits merge: no copy, ok', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'note.md': 'l1\nl2\nl3\nl4\nREMOTE five\n' }, 'remote line 5');
    await fx.c.write('note.md', 'LOCAL one\nl2\nl3\nl4\nl5\n');
    const res = await run(fx, commitReq());
    expect(res).toMatchObject({ outcome: 'ok', conflicts: [] });
    expect(await fx.remote.show('note.md')).toBe('LOCAL one\nl2\nl3\nl4\nREMOTE five\n');
    expect(fx.logs.some((l) => l.msg === 'conflict')).toBe(false);
  });

  test('edit vs delete: local delete overridden by the remote edit', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'x.md': 'remote edit\n' }, 'remote edits x');
    await fx.c.remove('x.md');
    const res = await run(fx, commitReq());
    expect(res.outcome).toBe('conflict-resolved');
    expect(res.overriddenDeletes).toEqual([{ path: 'x.md', deletedBy: 'local' }]);
    expect(await fx.c.read('x.md')).toBe('remote edit\n');
    expect(await fx.remote.show('x.md')).toBe('remote edit\n');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('edit vs delete: local edit restored over the remote delete', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'x.md': null }, 'remote deletes x');
    await fx.c.write('x.md', 'local edit\n');
    const res = await run(fx, commitReq());
    expect(res.outcome).toBe('conflict-resolved');
    expect(res.overriddenDeletes).toEqual([{ path: 'x.md', deletedBy: 'remote' }]);
    expect(await fx.remote.show('x.md')).toBe('local edit\n');
    expect(await fx.remote.head()).toBe(res.head);
  });

  test('autostash conflict in a pull-only run: copy committed and pushed, the edit is nowhere lost', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'note.md': REMOTE }, 'remote');
    await fx.c.write('note.md', LOCAL);   // uncommitted
    const res = await run(fx, PULL);
    const copy = `note ${TAG}.md`;
    expect(res).toMatchObject({ outcome: 'conflict-resolved', commitStep: 'not-applicable', conflicts: [copy], commitsOut: 1 });
    expect(await fx.c.read('note.md')).toBe(REMOTE);
    expect(await fx.c.read(copy)).toBe(LOCAL);
    expect(await fx.remote.show(copy)).toBe(LOCAL);
    expect(await fx.c.stashList()).toEqual([]);
    expect(await out(fx.c, ['ls-files', '-u'])).toBe('');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('stopped rebase left by a crash: recovered, replayed and pushed in one run', async () => {
    const fx = await fixture();
    await makeStoppedRebase(t, fx.c, fx.remote, { path: 'note.md', local: LOCAL, remote: REMOTE });
    const res = await run(fx, PULL);
    const copy = `note ${TAG}.md`;
    expect(res).toMatchObject({ outcome: 'conflict-resolved', conflicts: [copy], commitsOut: 1 });
    expect(fx.logs.some((l) => l.msg === 'recovered' && l.action === 'rebase-aborted')).toBe(true);
    expect(await fx.remote.show('note.md')).toBe(REMOTE);
    expect(await fx.remote.show(copy)).toBe(LOCAL);
    expect(existsSync(join(fx.c.dir, '.git', 'rebase-merge'))).toBe(false);
  });

  test('untracked files at incoming paths: identical removed, different renamed and committed', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'new.md': 'remote new\n', 'same.md': 'same\n' }, 'remote adds');
    await fx.c.write('new.md', 'my new\n');
    await fx.c.write('same.md', 'same\n');
    const res = await run(fx, PULL);
    const copy = `new ${TAG}.md`;
    expect(res).toMatchObject({ outcome: 'conflict-resolved', conflicts: [copy], commitsOut: 1 });
    expect(await fx.c.read('new.md')).toBe('remote new\n');
    expect(await fx.c.read(copy)).toBe('my new\n');
    expect(await fx.c.read('same.md')).toBe('same\n');
    expect(await fx.remote.show(copy)).toBe('my new\n');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  // The path is in the merge base: the local side deleted it in a commit. The replay happens in memory, so R's
  // version of the path never reaches the worktree, and the move (which sees only paths that differ between H and the
  // new tip) never touches the file: no set-aside, no collision.
  test('stop syncing a file but keep it (git rm --cached + .gitignore): the local file survives a pull', async () => {
    const fx = await fixture({ seed: { ...SEED, 'private.md': 'private notes\n' } });
    await out(fx.c, ['rm', '-q', '--cached', 'private.md']);
    await fx.c.write('.gitignore', 'private.md\n');
    await fx.remote.push({ 'other.md': 'other\n' }, 'remote push');
    const res = await run(fx, commitReq());
    expect(res).toMatchObject({ outcome: 'ok', commitStep: 'committed', conflicts: [] });
    expect(await fx.c.read('private.md')).toBe('private notes\n');
    expect(await fx.remote.show('private.md')).toBeUndefined();
    expect(await fx.remote.show('.gitignore')).toBe('private.md\n');
    expect(await fx.c.porcelain()).toEqual([]);
    expect(fx.logs.filter((l) => l.msg === 'collision').map((l) => l.action)).toEqual([]);
  });

  test('a locally deleted file put back with the same bytes (unpushed delete) survives a pull', async () => {
    const fx = await fixture();
    await fx.c.remove('x.md');
    await out(fx.c, ['commit', '-q', '-am', 'delete x']);
    await fx.c.write('x.md', 'x\n');   // restored from the Trash
    await fx.remote.push({ 'other.md': 'other\n' }, 'remote push');
    const res = await run(fx, PULL);
    expect(res).toMatchObject({ outcome: 'ok', conflicts: [] });
    expect(await fx.c.read('x.md')).toBe('x\n');
    expect(await fx.c.porcelain()).toEqual(['?? x.md']);
    expect(await fx.remote.show('x.md')).toBeUndefined();
  });

  test('a locally deleted file the remote edited: the edit wins at the path, the kept local file becomes a copy', async () => {
    const fx = await fixture();
    await fx.c.remove('x.md');
    await out(fx.c, ['commit', '-q', '-am', 'delete x']);
    await fx.c.write('x.md', 'x\n');
    await fx.remote.push({ 'x.md': 'x edited remotely\n' }, 'remote edit');
    const res = await run(fx, PULL);
    expect(res.outcome).toBe('conflict-resolved');
    expect(await fx.c.read('x.md')).toBe('x edited remotely\n');
    const bodies = await Promise.all((await fx.c.conflictCopies()).map((p) => fx.c.read(p)));
    expect(bodies).toContain('x\n');
  });
});

describe('unborn HEAD', () => {
  test('empty remote: first commit creates the branch; a second empty clone checks it out', async () => {
    const remote = await createRemote(t, { seed: 'empty' });
    const a = await cloneRemote(t, remote, `clone-${++n}`);
    const b = await cloneRemote(t, remote, `clone-${++n}`);
    const fa: Fx = { remote, c: a, ...await contextFor(a, remote) };
    const fb: Fx = { remote, c: b, ...await contextFor(b, remote) };

    await a.write('a.md', 'from A\n');
    const ra = await run(fa, commitReq());
    expect(ra).toMatchObject({ outcome: 'ok', commitStep: 'committed', commitsOut: 1 });
    expect(fa.logs.some((l) => l.msg === 'remote branch missing' && l.branch === 'main')).toBe(true);
    expect(await remote.head()).toBe(ra.head);

    await b.write('a.md', 'B had its own a.md\n');   // untracked, at the incoming path
    const rb = await run(fb, PULL);
    const copy = `a ${TAG}.md`;
    expect(rb).toMatchObject({ outcome: 'conflict-resolved', commitsIn: 1, conflicts: [copy], commitsOut: 1 });
    expect(await b.read('a.md')).toBe('from A\n');
    expect(await b.read(copy)).toBe('B had its own a.md\n');
    expect(await out(b, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(await remote.show(copy)).toBe('B had its own a.md\n');
    expect(await b.porcelain()).toEqual([]);
  });

  test('empty remote, nothing local: ok and nothing to push', async () => {
    const remote = await createRemote(t, { seed: 'empty' });
    const a = await cloneRemote(t, remote, `clone-${++n}`);
    const fa: Fx = { remote, c: a, ...await contextFor(a, remote) };
    const res = await run(fa, PULL);
    expect(res).toMatchObject({ outcome: 'ok', head: 'unborn', commitsOut: 0 });
  });
});
