import { saveLegacyRescue } from '../helpers/legacy-rescue';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { conflictStamp, shortHostname } from '../../src/host';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { overridePidVisibility } from '../../src/live-git';
import { FRESH_LOCK_WAIT_MS, NAMESPACED_STALE_MS, preflight, STALE_GIT_LOCK_MS } from '../../src/preflight';
import { pendingRescues } from '../../src/rescue';
import { readJournal, updateJournal } from '../../src/state';
import {
  backdate, cleanupAll, cloneRemote, type Clone, createRemote, holdLiveGit, type LogLine, makeAutostashConflict,
  makeLeftoverAutostash, makeStoppedRebase, type Remote, setupTestEnv, type TestEnv,
} from '../harness';

let t: TestEnv;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const FIXED = Date.UTC(2026, 9, 8, 12, 34, 56);
const clock = { now: () => FIXED, setTimeout: () => 0, clearTimeout: () => {} };
const TAG = `(conflict ${shortHostname()} ${conflictStamp(new Date(FIXED))})`;

const FIVE = 'l1\nl2\nl3\nl4\nl5\n';
const LOCAL = 'l1\nl2\nLOCAL three\nl4\nl5\n';
const REMOTE = 'l1\nl2\nREMOTE three\nl4\nl5\n';
const SEED = { 'README.md': '# notes\n', 'note.md': FIVE, 'other.md': 'other\n', 'notes.md': 'tracked notes\n' };

beforeAll(async () => {
  t = await setupTestEnv('preflight');
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

async function fixture(o: { seed?: Record<string, string> | 'empty' } = {}): Promise<Fx> {
  const remote = o.seed === 'empty' ? await createRemote(t, { seed: 'empty' }) : await createRemote(t, { files: o.seed ?? SEED });
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  return { remote, c, ...await contextFor(c, remote) };
}

function recovered(logs: LogLine[], action: string): LogLine[] {
  return logs.filter((l) => l.msg === 'recovered' && l.action === action);
}

describe('P1 git locks', () => {
  test('constants', () => {
    expect(STALE_GIT_LOCK_MS).toBe(60_000);
    expect(FRESH_LOCK_WAIT_MS).toBe(10_000);
  });

  test('a stale index.lock with no live git is removed', async () => {
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    backdate(lock, 120_000);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['stale-index-lock-removed']);
    expect(existsSync(lock)).toBe(false);
    const r = recovered(fx.logs, 'stale-index-lock-removed')[0];
    expect(r?.path).toBe(lock);
    expect(r?.ageMs as number).toBeGreaterThanOrEqual(120_000);
  });

  test('a stale ref lock is removed', async () => {
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'refs', 'heads', 'main.lock');
    writeFileSync(lock, '');
    backdate(lock, 120_000);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['stale-ref-lock-removed']);
    expect(existsSync(lock)).toBe(false);
  });

  test('a lock held while a live git runs in the repo is left alone (busy lock-live-git)', async () => {
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    backdate(lock, 120_000);
    const holder = await holdLiveGit(fx.c.dir);
    try {
      const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
      expect(pf).toEqual({ kind: 'busy', reason: 'lock-live-git' });
      expect(existsSync(lock)).toBe(true);
      const held = fx.logs.find((l) => l.msg === 'git lock held');
      expect(held?.pids as number[]).toContain(holder.pid);
      expect(held?.detection).toBe('scanned');
    } finally {
      await holder.release();
    }
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    expect(existsSync(lock)).toBe(false);
  });

  test('a fresh lock that never clears is busy after the poll and is not removed', async () => {
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    const started = Date.now();
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf).toEqual({ kind: 'busy', reason: 'lock-fresh' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(FRESH_LOCK_WAIT_MS - 50);
    expect(existsSync(lock)).toBe(true);
    expect(fx.logs.some((l) => l.msg === 'git lock held' && l.path === lock)).toBe(true);
  }, 30_000);

  test('the stale threshold itself: 5 s under it the lock is still fresh (kept), 5 s over it is removed', async () => {
    // r3 mutation lens: locks were only ever 0 s or 120 s old in the tests, so removing them at 15 s passed.
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    backdate(lock, STALE_GIT_LOCK_MS - 5_000);
    expect(await preflight(fx.ctx, { keptStashes: [], cloned: 'none' })).toEqual({ kind: 'busy', reason: 'lock-fresh' });
    expect(existsSync(lock)).toBe(true);
    backdate(lock, STALE_GIT_LOCK_MS + 5_000);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' && pf.actions).toEqual(['stale-index-lock-removed']);
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  test('a fresh lock that clears during the poll lets the run continue', async () => {
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    setTimeout(() => rmSync(lock, { force: true }), 600);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual([]);
  });
});

describe('P2 interrupted operations', () => {
  test('stopped rebase + agent edits during the stop: aborted, every edit kept', async () => {
    const fx = await fixture();
    const { local } = await makeStoppedRebase(t, fx.c, fx.remote,
      { path: 'note.md', local: LOCAL, remote: REMOTE, dirty: { 'other.md': 'local dirty\n' } });
    // git's own conflict write predates stopped-sha; the agent writes after it (probe e9)
    backdate(join(fx.c.dir, '.git', 'rebase-merge', 'stopped-sha'), 5_000);
    const conflicted = (await fx.c.read('note.md')) ?? '';
    expect(conflicted).toContain('<<<<<<<');
    await fx.c.write('note.md', `${conflicted}agent appended\n`);
    await fx.c.write('notes.md', 'agent edit of a tracked file\n');
    await fx.c.write('agent-new.md', 'agent new file\n');

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind !== 'ready') return;
    expect(pf.actions).toEqual(['rebase-aborted']);
    expect(recovered(fx.logs, 'rebase-aborted')).toHaveLength(1);
    expect(existsSync(join(fx.c.dir, '.git', 'rebase-merge'))).toBe(false);
    // `rebase --quit` leaves REBASE_HEAD, AUTO_MERGE and MERGE_MSG; `--abort` removed them, and so does P2 (chaos round 1)
    for (const f of ['REBASE_HEAD', 'AUTO_MERGE', 'MERGE_MSG']) expect({ f, exists: existsSync(join(fx.c.dir, '.git', f)) }).toEqual({ f, exists: false });
    expect(await out(fx.c, ['ls-files', '-u'])).toBe('');
    expect(await fx.c.head()).toBe(local);
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(await fx.c.stashList()).toEqual([]);
    expect(await fx.c.read('note.md')).toBe(LOCAL);
    const copy = `note ${TAG}.md`;
    expect(pf.conflicts).toEqual([copy]);
    expect(await fx.c.read(copy)).toBe(`${conflicted}agent appended\n`);
    expect(await fx.c.read('other.md')).toBe('local dirty\n');
    expect(await fx.c.read('notes.md')).toBe('agent edit of a tracked file\n');
    expect(await fx.c.read('agent-new.md')).toBe('agent new file\n');
    expect(pendingRescues(fx.ctx.paths)).toEqual([]);
  });

  test('a live git in the repo makes an in-progress rebase busy, untouched', async () => {
    const fx = await fixture();
    await makeStoppedRebase(t, fx.c, fx.remote, { path: 'note.md', local: LOCAL, remote: REMOTE });
    const holder = await holdLiveGit(fx.c.dir);
    try {
      expect(await preflight(fx.ctx, { keptStashes: [], cloned: 'none' })).toEqual({ kind: 'busy', reason: 'live-git' });
      expect(existsSync(join(fx.c.dir, '.git', 'rebase-merge'))).toBe(true);
    } finally {
      await holder.release();
    }
  });

  test('an interrupted merge is aborted', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'note.md': REMOTE }, 'remote');
    await fx.c.write('note.md', LOCAL);
    await out(fx.c, ['commit', '-q', '-am', 'local']);
    await out(fx.c, ['fetch', '-q', 'origin']);
    const m = await fx.c.git(['merge', 'origin/main']);
    expect(m.code).not.toBe(0);
    expect(existsSync(join(fx.c.dir, '.git', 'MERGE_HEAD'))).toBe(true);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['merge-aborted']);
    expect(existsSync(join(fx.c.dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(await fx.c.read('note.md')).toBe(LOCAL);
  });

  // git's own writes happened a while ago; the person's work during the stop comes after
  async function ageGitOutput(c: Clone, files: readonly string[], state: string): Promise<void> {
    for (const f of files) if (existsSync(join(c.dir, f))) backdate(join(c.dir, f), 10_000);
    backdate(state, 10_000);
    await c.git(['update-index', '-q', '--refresh']);   // stat-only change: as `git status` would
  }

  test('a stopped merge with staged work (hand-resolved, new note, staged edit): every staged byte is kept', async () => {
    const fx = await fixture({ seed: { ...SEED, 'clean.md': 'c1\nc2\nc3\nc4\nc5\n' } });
    await fx.remote.push({ 'note.md': REMOTE, 'clean.md': 'c1\nc2\nc3\nc4\nREMOTE c5\n' }, 'remote');
    await fx.c.write('note.md', LOCAL);
    await fx.c.write('clean.md', 'LOCAL c1\nc2\nc3\nc4\nc5\n');
    await out(fx.c, ['commit', '-q', '-am', 'local']);
    await out(fx.c, ['fetch', '-q', 'origin']);
    expect((await fx.c.git(['merge', 'origin/main'])).code).not.toBe(0);
    const mergeHead = join(fx.c.dir, '.git', 'MERGE_HEAD');
    await ageGitOutput(fx.c, ['note.md', 'clean.md'], mergeHead);
    await fx.c.write('note.md', 'RESOLVED BY HAND\n');
    await fx.c.write('new.md', 'BRAND NEW NOTE\n');
    await fx.c.write('other.md', 'STAGED EDIT\n');
    await out(fx.c, ['add', 'note.md', 'new.md', 'other.md']);

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind !== 'ready') return;
    expect(pf.actions).toEqual(['merge-aborted']);
    expect(existsSync(mergeHead)).toBe(false);
    // back in place as uncommitted edits on top of the pre-merge HEAD; git's clean auto-merge is not kept
    expect(await fx.c.read('note.md')).toBe('RESOLVED BY HAND\n');
    expect(await fx.c.read('new.md')).toBe('BRAND NEW NOTE\n');
    expect(await fx.c.read('other.md')).toBe('STAGED EDIT\n');
    expect(await fx.c.read('clean.md')).toBe('LOCAL c1\nc2\nc3\nc4\nc5\n');
    expect(pf.conflicts).toEqual([]);
    expect((await fx.c.porcelain()).sort()).toEqual([' M note.md', ' M other.md', '?? new.md']);
    // `merge --quit` (never --abort) and a move with checked writes: nothing to rescue, nothing overwritten
    expect(fx.logs.filter((l) => l.msg === 'rescued files')).toEqual([]);
  });

  test('a stopped merge with no work since git stopped saves nothing (git output is not a copy)', async () => {
    const fx = await fixture({ seed: { ...SEED, 'clean.md': 'c1\nc2\nc3\nc4\nc5\n' } });
    await fx.remote.push({ 'note.md': REMOTE, 'clean.md': 'c1\nc2\nc3\nc4\nREMOTE c5\n', 'added.md': 'remote add\n' }, 'remote');
    await fx.c.write('note.md', LOCAL);
    await fx.c.write('clean.md', 'LOCAL c1\nc2\nc3\nc4\nc5\n');
    await out(fx.c, ['commit', '-q', '-am', 'local']);
    await out(fx.c, ['fetch', '-q', 'origin']);
    expect((await fx.c.git(['merge', 'origin/main'])).code).not.toBe(0);
    await ageGitOutput(fx.c, ['note.md', 'clean.md', 'added.md'], join(fx.c.dir, '.git', 'MERGE_HEAD'));
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.conflicts : pf).toEqual([]);
    expect(fx.logs.filter((l) => l.msg === 'rescued files')).toEqual([]);
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('rebase -i stopped at edit, amended with a new file, plus a staged edit: both kept', async () => {
    const fx = await fixture();
    for (const i of [1, 2, 3]) {
      await fx.c.write(`n${i}.md`, `n${i}\n`);
      await out(fx.c, ['add', '-A']);
      await out(fx.c, ['commit', '-q', '-m', `c${i}`]);
    }
    const orig = await fx.c.head();
    const rb = await fx.c.git(['-c', "sequence.editor=sed -i.bak -e '1s/^pick/edit/'", 'rebase', '-i', 'HEAD~3']);
    expect(rb.code).toBe(0);
    const stoppedSha = join(fx.c.dir, '.git', 'rebase-merge', 'stopped-sha');
    expect(existsSync(stoppedSha)).toBe(true);
    await ageGitOutput(fx.c, ['n1.md'], stoppedSha);
    await fx.c.write('extra.md', 'AMENDED EXTRA\n');
    await out(fx.c, ['add', 'extra.md']);
    await out(fx.c, ['commit', '-q', '--amend', '-m', 'c1 amended']);
    await fx.c.write('n1.md', 'N1 SECOND PASS\n');
    await out(fx.c, ['add', 'n1.md']);

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['rebase-aborted']);
    expect(await fx.c.head()).toBe(orig);
    expect(await fx.c.read('extra.md')).toBe('AMENDED EXTRA\n');
    expect(await fx.c.read('n1.md')).toBe('N1 SECOND PASS\n');
    expect((await fx.c.porcelain()).sort()).toEqual([' M n1.md', '?? extra.md']);
  });

  // Where some content survives after preflight: worktree files whose text contains it.
  async function holders(c: Clone, needle: string): Promise<string[]> {
    const out: string[] = [];
    for (const f of await c.files()) if (((await c.read(f)) ?? '').includes(needle)) out.push(f);
    return out.sort();
  }

  // local: 'a note' then 'a other'; upstream (pushed, fetched as origin/main) changed line 1 of both files
  async function twoConflictingPicks(fx: Fx): Promise<{ orig: string }> {
    await fx.remote.push({ 'note.md': 'B1\nl2\nl3\n', 'other.md': 'B1\no2\no3\n' }, 'b edits');
    await fx.c.write('note.md', 'A1\nl2\nl3\n');
    await out(fx.c, ['commit', '-q', '-am', 'a note']);
    await fx.c.write('other.md', 'A1\no2\no3\n');
    await out(fx.c, ['commit', '-q', '-am', 'a other']);
    await out(fx.c, ['fetch', '-q', 'origin']);
    return { orig: await fx.c.head() };
  }

  test('a hand resolution committed by --continue at an EARLIER stop of the same rebase is kept', async () => {
    const fx = await fixture({ seed: { ...SEED, 'note.md': 'l1\nl2\nl3\n', 'other.md': 'o1\no2\no3\n' } });
    const { orig } = await twoConflictingPicks(fx);
    expect((await fx.c.git(['rebase', 'origin/main'])).code).not.toBe(0);
    await fx.c.write('note.md', 'RESOLVED-BY-HAND\nl2\nl3\n');
    await out(fx.c, ['add', 'note.md']);
    expect((await fx.c.git(['-c', 'core.editor=true', 'rebase', '--continue'])).code).not.toBe(0);   // stops on other.md
    const stoppedSha = join(fx.c.dir, '.git', 'rebase-merge', 'stopped-sha');
    expect(existsSync(stoppedSha)).toBe(true);
    await ageGitOutput(fx.c, ['other.md'], stoppedSha);
    // The resolution was written before the latest stop; only the content says whose it is.
    backdate(join(fx.c.dir, 'note.md'), 20_000);
    await fx.c.git(['update-index', '-q', '--refresh']);

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['rebase-aborted']);
    expect(await fx.c.head()).toBe(orig);
    const kept = await holders(fx.c, 'RESOLVED-BY-HAND');
    expect(kept).toEqual([`note ${TAG}.md`]);
    expect(await fx.c.read('note.md')).toBe('A1\nl2\nl3\n');
  });

  test('an amend at an `edit` stop survives a --continue that stops later on a conflict', async () => {
    const fx = await fixture({ seed: { ...SEED, 'note.md': 'l1\nl2\nl3\n', 'other.md': 'o1\no2\no3\n' } });
    await fx.remote.push({ 'other.md': 'B1\no2\no3\n' }, 'b other');
    await fx.c.write('note.md', 'l1\nl2\nA3\n');
    await out(fx.c, ['commit', '-q', '-am', 'a note']);
    await fx.c.write('other.md', 'A1\no2\no3\n');
    await out(fx.c, ['commit', '-q', '-am', 'a other']);
    const orig = await fx.c.head();
    await out(fx.c, ['fetch', '-q', 'origin']);
    expect((await fx.c.git(['-c', "sequence.editor=sed -i.bak -e '1s/^pick/edit/'", 'rebase', '-i', 'origin/main'])).code).toBe(0);
    await fx.c.write('note.md', 'l1\nAMENDED-WORK\nA3\n');
    await out(fx.c, ['commit', '-q', '--amend', '-a', '--no-edit']);
    expect((await fx.c.git(['-c', 'core.editor=true', 'rebase', '--continue'])).code).not.toBe(0);   // stops on other.md
    const stoppedSha = join(fx.c.dir, '.git', 'rebase-merge', 'stopped-sha');
    await ageGitOutput(fx.c, ['other.md'], stoppedSha);
    backdate(join(fx.c.dir, 'note.md'), 20_000);
    await fx.c.git(['update-index', '-q', '--refresh']);

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['rebase-aborted']);
    expect(await fx.c.head()).toBe(orig);
    expect(await holders(fx.c, 'AMENDED-WORK')).toEqual([`note ${TAG}.md`]);
  });

  test('a rebase killed mid-pick: the clean merge git wrote for that pick is not turned into a copy', async () => {
    const fx = await fixture({ seed: { ...SEED, 'note.md': 'l1\nl2\nl3\nl4\nl5\n' } });
    await fx.remote.push({ 'note.md': 'B1\nl2\nl3\nl4\nl5\n' }, 'b line 1');
    await fx.c.write('note.md', 'l1\nl2\nl3\nl4\nA5\n');
    await out(fx.c, ['commit', '-q', '-am', 'a line 5']);
    const orig = await fx.c.head();
    await out(fx.c, ['fetch', '-q', 'origin']);
    // git dies inside the pick's commit step (power loss, OOM, docker kill): no stopped-sha, the merge is staged
    const hooks = join(fx.c.dir, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'prepare-commit-msg'), '#!/bin/sh\nkill -9 $PPID\nsleep 5\n', { mode: 0o755 });
    await fx.c.git(['rebase', 'origin/main']);
    rmSync(join(hooks, 'prepare-commit-msg'));
    expect(existsSync(join(fx.c.dir, '.git', 'rebase-merge'))).toBe(true);
    expect(existsSync(join(fx.c.dir, '.git', 'rebase-merge', 'stopped-sha'))).toBe(false);
    expect(await fx.c.read('note.md')).toBe('B1\nl2\nl3\nl4\nA5\n');
    await Bun.sleep(1_100);   // the pick's writes are newer than the rebase dir: mtimes can't tell them apart

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['rebase-aborted']);
    expect(pf.kind === 'ready' ? pf.conflicts : pf).toEqual([]);
    expect(await fx.c.head()).toBe(orig);
    expect(await fx.c.conflictCopies()).toEqual([]);
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('a cherry-pick sequence: a resolution committed at an earlier stop is kept when the abort rewinds it', async () => {
    const fx = await fixture({ seed: { ...SEED, 'note.md': 'l1\nl2\nl3\n', 'other.md': 'o1\no2\no3\n' } });
    const start = await fx.c.head();
    await out(fx.c, ['checkout', '-q', '-b', 'side']);
    await fx.c.write('note.md', 'S1\nl2\nl3\n');
    await out(fx.c, ['commit', '-q', '-am', 's note']);
    await fx.c.write('other.md', 'S1\no2\no3\n');
    await out(fx.c, ['commit', '-q', '-am', 's other']);
    await out(fx.c, ['checkout', '-q', 'main']);
    await fx.c.write('note.md', 'M1\nl2\nl3\n');
    await fx.c.write('other.md', 'M1\no2\no3\n');
    await out(fx.c, ['commit', '-q', '-am', 'm']);
    const before = await fx.c.head();
    expect(before).not.toBe(start);
    expect((await fx.c.git(['cherry-pick', 'side~1', 'side'])).code).not.toBe(0);   // stops on note.md
    await fx.c.write('note.md', 'PICK-RESOLVED\nl2\nl3\n');
    await out(fx.c, ['add', 'note.md']);
    expect((await fx.c.git(['-c', 'core.editor=true', 'cherry-pick', '--continue'])).code).not.toBe(0);   // stops on other.md
    expect(existsSync(join(fx.c.dir, '.git', 'sequencer', 'head'))).toBe(true);
    const pickHead = join(fx.c.dir, '.git', 'CHERRY_PICK_HEAD');
    await ageGitOutput(fx.c, ['other.md'], pickHead);
    backdate(join(fx.c.dir, 'note.md'), 20_000);
    await fx.c.git(['update-index', '-q', '--refresh']);

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['cherry-pick-aborted']);
    expect(await fx.c.head()).toBe(before);   // the abort rewinds to where the sequence started
    expect(await holders(fx.c, 'PICK-RESOLVED')).toEqual([`note ${TAG}.md`]);
  });
});

// In a container only our own PID namespace is visible, so a host user's git on the bind-mounted folder can't be
// seen: an empty scan proves less, and locks and interrupted ops must be much older before they count as abandoned.
describe('container: only our own PID namespace is visible', () => {
  afterEach(() => overridePidVisibility('detect'));

  test('a 90 s old index.lock is left alone (a host commit editor may hold it); a 15 min old one is removed', async () => {
    overridePidVisibility('own-namespace');
    const fx = await fixture();
    const lock = join(fx.c.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    backdate(lock, 90_000);
    expect(await preflight(fx.ctx, { keptStashes: [], cloned: 'none' })).toEqual({ kind: 'busy', reason: 'lock-unknown' });
    expect(existsSync(lock)).toBe(true);
    backdate(lock, NAMESPACED_STALE_MS + 300_000);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['stale-index-lock-removed']);
    expect(existsSync(lock)).toBe(false);
  });

  test('a merge stopped 90 s ago is not aborted (a host user may be resolving it); one stopped long ago is', async () => {
    overridePidVisibility('own-namespace');
    const fx = await fixture();
    await fx.remote.push({ 'note.md': REMOTE }, 'remote');
    await fx.c.write('note.md', LOCAL);
    await out(fx.c, ['commit', '-q', '-am', 'local']);
    await out(fx.c, ['fetch', '-q', 'origin']);
    expect((await fx.c.git(['merge', 'origin/main'])).code).not.toBe(0);
    const mergeHead = join(fx.c.dir, '.git', 'MERGE_HEAD');
    backdate(mergeHead, 90_000);
    expect(await preflight(fx.ctx, { keptStashes: [], cloned: 'none' })).toEqual({ kind: 'busy', reason: 'live-git-unknown' });
    expect(existsSync(mergeHead)).toBe(true);
    backdate(mergeHead, NAMESPACED_STALE_MS + 300_000);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['merge-aborted']);
  });
});

describe('P3 pending rescues', () => {
  test('a standalone manifest left by a crash is restored', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'incoming.md': 'remote\n' }, 'incoming');
    await out(fx.c, ['fetch', '-q', 'origin']);
    await fx.c.write('incoming.md', 'mine\n');
    const m = await saveLegacyRescue(fx.ctx, 'rebase', ['refs/remotes/origin/main'],
      { scope: 'untracked-only', unmerged: { kind: 'skip' }, owner: 'standalone' });
    expect(m).not.toBe('nothing');
    await fx.c.remove('incoming.md');   // the destructive op ran, then the daemon died
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['rescue-restored']);
    expect(await fx.c.read('incoming.md')).toBe('mine\n');
    expect(pendingRescues(fx.ctx.paths)).toEqual([]);
  });

  test('a journal-owned manifest waits for P4 while its journal exists', async () => {
    const fx = await fixture();
    await fx.c.write('README.md', 'dirty\n');
    const m = await saveLegacyRescue(fx.ctx, 'rebase-conflict', ['HEAD'], { scope: 'full', unmerged: { kind: 'skip' }, owner: 'journal' });
    expect(m).not.toBe('nothing');
    const head = await fx.c.head();
    updateJournal(fx.ctx.paths.journal, 'rebase', { op: 'rebase-conflict', phase: 'aborting', local: head, remote: head,
      target: 'none', stash: 'none', copies: [], overridden: [], startedAt: 'x' });
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['journal-resumed']);
    expect(pendingRescues(fx.ctx.paths)).toEqual([]);
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
    expect(await fx.c.read('README.md')).toBe('dirty\n');
    expect(fx.logs.some((l) => l.msg === 'recovered' && l.action === 'journal-resumed' && l.op === 'rebase-conflict'
      && l.phase === 'aborting')).toBe(true);
  });
});

describe('P5 leftovers', () => {
  test('autostash conflict (unmerged + autostash, nothing in progress) is replayed', async () => {
    const fx = await fixture();
    await makeAutostashConflict(t, fx.c, fx.remote, { path: 'note.md', local: LOCAL, remote: REMOTE });
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind !== 'ready') return;
    expect(pf.actions).toEqual(['stash-conflict-resumed']);
    const copy = `note ${TAG}.md`;
    expect(pf.conflicts).toEqual([copy]);
    expect(await fx.c.read('note.md')).toBe(REMOTE);
    expect(await fx.c.read(copy)).toBe(LOCAL);
    expect(await fx.c.stashList()).toEqual([]);
    expect(await out(fx.c, ['ls-files', '-u'])).toBe('');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('refused autostash (stash only) is replayed into the worktree, uncommitted', async () => {
    const fx = await fixture();
    await makeLeftoverAutostash(t, fx.c, fx.remote, { dirty: { 'README.md': 'dirty readme\n', 'other.md': 'dirty other\n' } });
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind !== 'ready') return;
    expect(pf.actions).toEqual(['stash-conflict-resumed']);
    expect(pf.conflicts).toEqual([]);
    expect(await fx.c.read('README.md')).toBe('dirty readme\n');
    expect(await fx.c.read('other.md')).toBe('dirty other\n');
    expect((await fx.c.porcelain()).sort()).toEqual([' M README.md', ' M other.md']);
    expect(await fx.c.stashList()).toEqual([]);
  });

  test('a kept stash is never replayed again', async () => {
    const fx = await fixture();
    const sha = await makeLeftoverAutostash(t, fx.c, fx.remote, { dirty: { 'README.md': 'dirty readme\n' } });
    const pf = await preflight(fx.ctx, { keptStashes: [sha], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual([]);
    expect(await fx.c.stashList()).toHaveLength(1);
    expect(await fx.c.read('README.md')).toBe('# notes\n');
  });

  test('unmerged entries with no mdsync stash: conservative recovery keeps a marked copy', async () => {
    const fx = await fixture();
    await fx.c.write('note.md', LOCAL);
    await out(fx.c, ['stash', 'push', '-q', '-m', 'my own stash']);
    await fx.remote.push({ 'note.md': REMOTE }, 'remote');
    await out(fx.c, ['pull', '-q', '--ff-only', 'origin', 'main']);
    const pop = await fx.c.git(['stash', 'pop']);
    expect(pop.code).not.toBe(0);
    expect(await out(fx.c, ['ls-files', '-u'])).not.toBe('');
    const marked = (await fx.c.read('note.md')) ?? '';
    expect(marked).toContain('<<<<<<<');

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind !== 'ready') return;
    expect(pf.actions).toEqual(['unmerged-recovered']);
    const copy = `note ${TAG}.md`;
    expect(pf.conflicts).toEqual([copy]);
    expect(await fx.c.read(copy)).toBe(marked);
    expect(await fx.c.read('note.md')).toBe(REMOTE);
    expect(await out(fx.c, ['ls-files', '-u'])).toBe('');
    expect(await fx.c.stashList()).toHaveLength(1);   // the user's own stash is never touched
    expect(fx.logs.some((l) => l.msg === 'conflict' && l.kind === 'rescue')).toBe(true);
  });
});

describe('P1b interrupted first checkout', () => {
  test('no index under a born HEAD: index rebuilt, missing and half-written files restored, real edits kept', async () => {
    // A first clone killed during its checkout: HEAD on main, no .git/index, part of the files. The next `add -A`
    // used to stage every missing file as a deletion, and S6 pushed that (r3).
    const big = 'x'.repeat(5_000) + '\n';
    const fx = await fixture({ seed: { ...SEED, 'big.md': big, 'd/deep.md': 'deep\n' } });
    rmSync(join(fx.c.dir, '.git', 'index'));
    rmSync(join(fx.c.dir, 'note.md'));
    rmSync(join(fx.c.dir, 'd'), { recursive: true });
    writeFileSync(join(fx.c.dir, 'big.md'), big.slice(0, 1_000));      // killed mid-write
    writeFileSync(join(fx.c.dir, 'other.md'), 'an edit made since\n');  // not a prefix of HEAD's: kept beside a copy
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['clone-completed']);
    expect(existsSync(join(fx.c.dir, '.git', 'index'))).toBe(true);
    expect(await fx.c.read('note.md')).toBe(FIVE);
    expect(await fx.c.read('d/deep.md')).toBe('deep\n');
    expect(await fx.c.read('big.md')).toBe(big);
    // an agent's file at an incoming path that differs: HEAD's version at the path, the agent's in a conflict copy
    // (add/add, committed); nothing is overwritten and nothing is pending
    expect(await fx.c.read('other.md')).toBe('other\n');
    const copies = await fx.c.conflictCopies();
    expect(copies).toHaveLength(1);
    expect(await fx.c.read(copies[0] as string)).toBe('an edit made since\n');
    expect(await fx.c.porcelain()).toEqual([]);
    expect(recovered(fx.logs, 'clone-completed')[0]?.count).toBe(3);
    expect(recovered(fx.logs, 'clone-completed')[0]?.paths).toEqual(['big.md', 'd/deep.md', 'note.md']);
    // and a repo with its index is left alone
    const again = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(again.kind === 'ready' && again.actions).toEqual([]);
  });
});

describe('P6 branch', () => {
  test('a clean detached HEAD goes back to the branch', async () => {
    const fx = await fixture();
    await out(fx.c, ['checkout', '-q', '--detach']);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['branch-fixed']);
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    const l = recovered(fx.logs, 'branch-fixed')[0];
    expect(l?.from).toBe('detached HEAD');
    expect(l?.to).toBe('main');
  });

  test('another branch with local changes is refused, untouched', async () => {
    const fx = await fixture();
    await out(fx.c, ['checkout', '-q', '-b', 'feature']);
    await fx.c.write('README.md', 'dirty\n');
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf).toEqual({ kind: 'failed', error: 'checked out feature, expected main, and the worktree has changes', keptStashes: [] });
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feature');
    expect(await fx.c.read('README.md')).toBe('dirty\n');
  });

  test('an unborn HEAD on another branch name is pointed at the branch', async () => {
    const fx = await fixture({ seed: 'empty' });
    await out(fx.c, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    if (pf.kind === 'ready') expect(pf.actions).toEqual(['branch-fixed']);
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  });

  test('a commit made on a detached HEAD on top of the branch is adopted, not abandoned', async () => {
    // P6 used to check out the branch over it: the note vanished from disk and the commit from every branch (r3).
    const fx = await fixture();
    await out(fx.c, ['checkout', '-q', '--detach']);
    await fx.c.write('note-detached.md', 'written on a detached HEAD\n');
    await out(fx.c, ['add', '-A']);
    await out(fx.c, ['commit', '-qm', 'detached work']);
    const sha = await out(fx.c, ['rev-parse', 'HEAD']);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' && pf.actions).toEqual(['branch-fixed']);
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(await out(fx.c, ['rev-parse', 'main'])).toBe(sha);
    expect(await fx.c.read('note-detached.md')).toBe('written on a detached HEAD\n');
    expect(recovered(fx.logs, 'branch-fixed')[0]?.adopted).toBe(1);
  });

  test('a detached HEAD whose commits diverge from the branch, or another branch with local-only commits: refused', async () => {
    const fx = await fixture();
    const base = await out(fx.c, ['rev-parse', 'HEAD']);
    await fx.c.write('on-main.md', 'main\n');
    await out(fx.c, ['add', '-A']);
    await out(fx.c, ['commit', '-qm', 'on main']);
    await out(fx.c, ['checkout', '-q', '--detach', base]);
    await fx.c.write('on-detached.md', 'detached\n');
    await out(fx.c, ['add', '-A']);
    await out(fx.c, ['commit', '-qm', 'detached']);
    const detached = await out(fx.c, ['rev-parse', 'HEAD']);
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('failed');
    if (pf.kind === 'failed') expect(pf.error).toContain('checked out detached HEAD, which has 1 commit(s) that main does not have');
    expect(await out(fx.c, ['rev-parse', 'HEAD'])).toBe(detached);
    expect(await fx.c.read('on-detached.md')).toBe('detached\n');

    // the notes a fork branch holds (mdsync's own `main` on a `master` remote, then "branch": "master") stay put
    await out(fx.c, ['checkout', '-q', '-b', 'feature']);
    const pf2 = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf2.kind === 'failed' && pf2.error.startsWith('checked out feature, which has 1 commit(s) that main does not have')).toBe(true);
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/feature');
  });

  test('a branch whose commits are all on the remote is left for B as before (fresh clone of main, "branch": "notes")', async () => {
    const fx = await fixture();
    await out(fx.c, ['push', '-q', 'origin', 'HEAD:refs/heads/notes']);
    await out(fx.c, ['fetch', '-q', 'origin']);
    await fx.c.write('README.md', '# main moved on\n');
    await out(fx.c, ['commit', '-qam', 'main only']);
    await out(fx.c, ['push', '-q', 'origin', 'main']);
    const ctx = { ...fx.ctx, branch: 'notes', config: { ...fx.ctx.config, branch: 'notes' } };
    const pf = await preflight(ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind === 'ready' && pf.actions).toEqual(['branch-fixed']);
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/notes');
  });

  test('no local or remote B but other remote branches: refused instead of forking a new B', async () => {
    const remote = await createRemote(t, { seed: 'empty' });
    const seedDir = join(t.root, `seed-${++n}`);
    mkdirSync(seedDir);
    const sh = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: seedDir, env: t.env });
    sh(['init', '-q', '-b', 'master']);
    writeFileSync(join(seedDir, 'README.md'), 'on master\n');
    sh(['add', '-A']);
    sh(['commit', '-qm', 'master']);
    sh(['push', '-q', remote.url, 'master']);
    Bun.spawnSync(['git', 'symbolic-ref', 'HEAD', 'refs/heads/master'], { cwd: remote.path, env: t.env });
    const c = await cloneRemote(t, remote, `clone-${++n}`);
    const { ctx } = await contextFor(c, remote);
    const pf = await preflight(ctx, { keptStashes: [], cloned: 'none' });
    const error = 'origin has no branch main (its default branch is master); set "branch": "master" in the config, or '
      + 'create main on the remote';
    expect(pf).toEqual({ kind: 'failed', keptStashes: [], error });
    expect(await out(c, ['branch', '--list', 'main'])).toBe('');
    // nor may an unborn `main` get a first commit of its own there (a remote whose HEAD names a missing `main`)
    await out(c, ['checkout', '-q', '--orphan', 'main']);
    await out(c, ['rm', '-rq', '--cached', '.']);
    expect(await preflight(ctx, { keptStashes: [], cloned: 'none' })).toEqual({ kind: 'failed', keptStashes: [], error });
  });

  test('no branch yet: created from origin', async () => {
    const fx = await fixture();
    await out(fx.c, ['checkout', '-q', '--detach']);
    await out(fx.c, ['branch', '-q', '-D', 'main']);
    mkdirSync(join(fx.c.dir, 'untracked-dir'), { recursive: true });
    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('ready');
    expect(await out(fx.c, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(await out(fx.c, ['rev-parse', 'main'])).toBe(await out(fx.c, ['rev-parse', 'origin/main']));
    expect((await fx.c.git(['config', '--local', '--get-regexp', '^branch\\.'])).code).toBe(1);   // --no-track: no config written
  });
});

test('a clean repo is ready with no actions', async () => {
  const fx = await fixture();
  expect(await preflight(fx.ctx, { keptStashes: [], cloned: 'none' })).toEqual({ kind: 'ready', actions: [], conflicts: [],
    overriddenDeletes: [], keptStashes: [] });
});
