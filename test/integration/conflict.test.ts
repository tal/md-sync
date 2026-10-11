import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { copyCommittable, foldPrecheck, handleRebaseConflict, replayStash, resumeJournal } from '../../src/conflict';
import { createRunContext, type RunContext } from '../../src/context';
import { conflictStamp, shortHostname } from '../../src/host';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { moveTestHooks } from '../../src/move';
import { preflight } from '../../src/preflight';
import { type Journal, readJournal, updateJournal } from '../../src/state';
import {
  cleanupAll, cloneRemote, type Clone, CONFLICT_COPY_RE, createRemote, type LogLine, makeAutostashConflict,
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
const SEED = { 'README.md': '# notes\n', 'note.md': FIVE, 'other.md': 'other\n', 'x.md': 'x\n' };

beforeAll(async () => {
  t = await setupTestEnv('conflict');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

type Fx = { remote: Remote; c: Clone; ctx: RunContext; logs: LogLine[]; onLog: { fn: (l: LogLine) => void } };

async function out(c: Clone, args: string[]): Promise<string> {
  const r = await c.git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function fixture(o: { seed?: Record<string, string>; ignore?: string[] } = {}): Promise<Fx> {
  const remote = await createRemote(t, { files: o.seed ?? SEED });
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  const config: ReadyConfig = { dir: c.dir, remote: remote.url, branch: 'main', idleMs: 60_000, fallbackMs: 3_600_000,
    maxWaitMs: 120_000, ignore: o.ignore ?? [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const onLog = { fn: (_l: LogLine): void => {} };
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (line) => {
    const l = JSON.parse(line) as LogLine;
    logs.push(l);
    onLog.fn(l);
  } });
  const ctx = await createRunContext({ config, realDir: c.dir, paths, log, clock });
  return { remote, c, ctx, logs, onLog };
}

async function commitAll(c: Clone, msg: string): Promise<string> {
  await out(c, ['add', '-A']);
  await out(c, ['commit', '-q', '-m', msg]);
  return c.head();
}

async function fetchRemote(c: Clone): Promise<string> {
  await out(c, ['fetch', '-q', 'origin']);
  return out(c, ['rev-parse', 'refs/remotes/origin/main']);
}

async function treeFiles(c: Clone, rev: string): Promise<string[]> {
  return (await out(c, ['ls-tree', '-r', '--name-only', '-z', rev])).split('\0').filter((p) => p !== '').sort();
}

// git argv without the per-call `-c` options (durable writes put them before the subcommand)
function gitCalls(logs: LogLine[]): string[][] {
  return logs.filter((l) => l.msg === 'git').map((l) => (l.args as string[]).filter((a, i, all) => a !== '-c' && all[i - 1] !== '-c'));
}

async function contents(c: Clone): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of await c.files()) m.set(f, (await c.read(f)) ?? '');
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// crash simulation: snapshot the repo and the state files after every mutating git call (or journal change)

type Snap = { dir: string; journal: string | 'none'; after: string };
const MUTATING = new Set(['reset', 'stash', 'checkout-index', 'commit-tree', 'rebase', 'update-ref', 'checkout', 'symbolic-ref']);

function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return '';
}

function startSnapshots(fx: Fx): { snaps: Snap[]; stop(): void } {
  const snaps: Snap[] = [];
  let state: 'on' | 'off' = 'on';
  let lastJournal = 'none';
  fx.onLog.fn = (l) => {
    if (state === 'off' || l.msg !== 'git') return;
    const args = l.args as string[];
    const journal = existsSync(fx.ctx.paths.journal) ? readFileSync(fx.ctx.paths.journal, 'utf8') : 'none';
    if (!MUTATING.has(subcommand(args)) && journal === lastJournal) return;
    lastJournal = journal;
    const dir = join(t.root, `snap-${++n}`);
    cpSync(fx.c.dir, join(dir, 'repo'), { recursive: true, verbatimSymlinks: true });
    if (journal !== 'none') writeFileSync(join(dir, 'journal.json'), journal);
    if (existsSync(fx.ctx.paths.rescue)) cpSync(fx.ctx.paths.rescue, join(dir, 'rescue'), { recursive: true, verbatimSymlinks: true });
    snaps.push({ dir, journal, after: args.join(' ') });
  };
  return { snaps, stop: () => { state = 'off'; fx.onLog.fn = () => {}; } };
}

function restoreSnapshot(fx: Fx, s: Snap): void {
  rmSync(fx.c.dir, { recursive: true, force: true });
  cpSync(join(s.dir, 'repo'), fx.c.dir, { recursive: true, verbatimSymlinks: true });
  rmSync(fx.ctx.paths.journal, { force: true });
  rmSync(fx.ctx.paths.rescue, { recursive: true, force: true });
  rmSync(fx.ctx.paths.tmp, { recursive: true, force: true });
  if (s.journal !== 'none') writeFileSync(fx.ctx.paths.journal, s.journal);
  if (existsSync(join(s.dir, 'rescue'))) cpSync(join(s.dir, 'rescue'), fx.ctx.paths.rescue, { recursive: true, verbatimSymlinks: true });
}

function phaseKey(journal: string | 'none'): string {
  if (journal === 'none') return 'none';
  const j = JSON.parse(journal) as { rebase?: { phase: string }; stash?: { phase: string }; move?: { phase: string; reason: string } };
  return `rebase:${j.rebase?.phase ?? '-'} stash:${j.stash?.phase ?? '-'} move:${j.move === undefined ? '-' : `${j.move.reason}/${j.move.phase}`}`;
}

// No part a run would have to resume (the settle part only waits out a grace period).
function noOpenParts(j: Journal | 'none'): boolean {
  return j === 'none' || (j.move === undefined && j.rebase === undefined && j.stash === undefined);
}

// Every git call the code under test made: none may write the worktree.
function worktreeWriters(logs: readonly LogLine[]): string[] {
  const bad: string[] = [];
  for (const l of logs) {
    if (l.msg !== 'git') continue;
    const args = (l.args as string[]).filter((a, i, all) => a !== '-c' && all[i - 1] !== '-c');
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    const joined = args.join(' ');
    if (sub === 'rebase' && !joined.includes('--quit')) bad.push(joined);
    if (sub === 'checkout' || (sub === 'stash' && /\b(apply|pop)\b/.test(joined)) || sub === 'clean') bad.push(joined);
    if (sub === 'reset' && joined.includes('--hard')) bad.push(joined);
    if (sub === 'checkout-index' && !joined.includes('--prefix=')) bad.push(joined);
    if (/ --abort( |$)/.test(joined)) bad.push(joined);
  }
  return bad;
}

function rescueDirEmpty(fx: Fx): boolean {
  return !existsSync(fx.ctx.paths.rescue) || readdirSync(fx.ctx.paths.rescue).length === 0;
}

// ---------------------------------------------------------------------------------------------------------------

describe('handleRebaseConflict', () => {
  test('replay conflict: one verified commit on R, local in one copy, uncommitted work rides along, nothing left behind', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'note.md': REMOTE }, 'remote');
    await fx.c.write('note.md', LOCAL);
    const local = await commitAll(fx.c, 'local');
    await fx.c.write('other.md', 'local dirty\n');
    const r = await fetchRemote(fx.c);
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'replay-conflict', paths: ['note.md'] });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    const copy = `note ${TAG}.md`;
    expect(res.copies).toEqual([copy]);
    expect(res.overridden).toEqual([]);
    expect(res.stash).toBe('none');
    expect(res.commit).not.toBe('none');
    expect(await fx.c.head()).toBe(res.commit);
    expect(await out(fx.c, ['rev-parse', `${res.commit}^`])).toBe(r);
    expect(await out(fx.c, ['log', '-1', '--format=%s'])).toMatch(/ \(conflict\)$/);
    expect(await treeFiles(fx.c, 'HEAD')).toEqual([...await treeFiles(fx.c, r), copy].sort());
    expect(await fx.c.read('note.md')).toBe(REMOTE);
    expect(await fx.c.read(copy)).toBe(LOCAL);
    expect(await fx.c.read('other.md')).toBe('local dirty\n');
    expect(await fx.c.porcelain()).toEqual([' M other.md']);
    expect(await fx.c.stashList()).toEqual([]);
    expect(noOpenParts(readJournal(fx.ctx.paths.journal))).toBe(true);
    expect(rescueDirEmpty(fx)).toBe(true);
    expect(worktreeWriters(fx.logs)).toEqual([]);

    // C is built (and verified) before anything moves HEAD or the worktree, and HEAD moves last (compare-and-swap)
    const calls = gitCalls(fx.logs);
    const built = calls.findIndex((a) => a[0] === 'commit-tree');
    const ref = calls.findIndex((a) => a[0] === 'update-ref');
    expect(built).toBeGreaterThan(-1);
    expect(ref).toBeGreaterThan(built);
    expect(fx.logs.some((l) => l.msg === 'committed' && l.source === 'conflict' && l.sha === res.commit)).toBe(true);
    const conflict = fx.logs.find((l) => l.msg === 'conflict');
    expect(conflict?.kind).toBe('rebase');
    expect(conflict?.copies).toEqual([copy]);
    expect(conflict?.paths).toEqual(['note.md']);
  });

  test('a copy name is never a path that only the merge base has (an older copy both sides renamed away)', async () => {
    // r4 chaos: within the same minute the namer picked `README (conflict <host> <stamp>).md` for a new conflict on
    // README.md. Both sides had renamed the earlier copy of that name away, so only the base had it: it was a changed
    // path, the data guard stopped the replay, and the device stayed stuck at {H, R}.
    const old = `note ${TAG}.md`;
    const fx = await fixture({ seed: { ...SEED, [old]: 'an older copy\n' } });
    await fx.remote.push({ 'note.md': REMOTE, [old]: null, 'moved-remote.md': 'an older copy\n' }, 'remote');
    await fx.c.write('note.md', LOCAL);
    await fx.c.remove(old);
    await fx.c.write('moved-local.md', 'an older copy\n');
    const local = await commitAll(fx.c, 'local');
    const r = await fetchRemote(fx.c);
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'precheck' });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.copies).toHaveLength(1);
    expect(res.copies[0]).not.toBe(old);
    expect(await fx.c.read(res.copies[0] ?? '')).toBe(LOCAL);
    expect(await fx.c.read('note.md')).toBe(REMOTE);
  });

  test('precheck entry: non-overlapping edits merge in place, no copy and no conflict log', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'note.md': 'l1\nl2\nl3\nl4\nREMOTE five\n' }, 'remote line 5');
    await fx.c.write('note.md', 'LOCAL one\nl2\nl3\nl4\nl5\n');
    const local = await commitAll(fx.c, 'local line 1');
    const r = await fetchRemote(fx.c);
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'precheck' });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.copies).toEqual([]);
    expect(res.stash).toBe('none');
    expect(await fx.c.read('note.md')).toBe('LOCAL one\nl2\nl3\nl4\nREMOTE five\n');
    expect(await fx.c.conflictCopies()).toEqual([]);
    expect(await out(fx.c, ['rev-parse', 'HEAD^'])).toBe(r);
    expect(fx.logs.some((l) => l.msg === 'conflict')).toBe(false);
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('edit vs delete: local delete is overridden by the remote edit', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'x.md': 'remote edit\n' }, 'remote edits x');
    await fx.c.remove('x.md');
    const local = await commitAll(fx.c, 'local deletes x');
    const r = await fetchRemote(fx.c);
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'precheck' });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.overridden).toEqual([{ path: 'x.md', deletedBy: 'local' }]);
    expect(res.copies).toEqual([]);
    expect(await fx.c.read('x.md')).toBe('remote edit\n');
    expect(fx.logs.some((l) => l.msg === 'delete overridden' && l.path === 'x.md' && l.deletedBy === 'local')).toBe(true);
    // nothing local to replay: HEAD is R itself
    expect(res.commit).toBe('none');
    expect(await fx.c.head()).toBe(r);
  });

  test('edit vs delete: local edit is restored over the remote delete', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'x.md': null }, 'remote deletes x');
    await fx.c.write('x.md', 'local edit\n');
    const local = await commitAll(fx.c, 'local edits x');
    const r = await fetchRemote(fx.c);
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'precheck' });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.overridden).toEqual([{ path: 'x.md', deletedBy: 'remote' }]);
    expect(await fx.c.read('x.md')).toBe('local edit\n');
    expect(await treeFiles(fx.c, 'HEAD')).toContain('x.md');
    expect(fx.logs.some((l) => l.msg === 'delete overridden' && l.path === 'x.md' && l.deletedBy === 'remote')).toBe(true);
  });

  test('a local-only gitlink plus an unrelated conflict replays like any local add (no data guard stop)', async () => {
    // r3: the gitlink row came first, so a nested repo `add -A` committed once stopped every later conflict replay.
    const fx = await fixture();
    await fx.remote.push({ 'note.md': REMOTE }, 'remote edit');
    const sub = await out(fx.c, ['rev-parse', 'HEAD']);
    await out(fx.c, ['update-index', '--add', '--cacheinfo', `160000,${sub},vendored`]);
    await fx.c.write('note.md', LOCAL);
    await out(fx.c, ['add', 'note.md']);
    await out(fx.c, ['commit', '-q', '-m', 'local with gitlink']);
    const local = await fx.c.head();
    const r = await fetchRemote(fx.c);
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'precheck' });
    expect(res.kind).toBe('resolved');
    expect(await out(fx.c, ['ls-tree', 'HEAD', 'vendored'])).toBe(`160000 commit ${sub}\tvendored`);
    expect(await out(fx.c, ['rev-parse', 'HEAD^'])).toBe(r);
    expect(await fx.c.read('note.md')).toBe(REMOTE);
  });

  test('data guard stop (gitlink in the local commits): repo left at L, worktree and journal untouched', async () => {
    const fx = await fixture();
    // the remote adds a file where the local commits add a gitlink: both sides changed the gitlink path
    await fx.remote.push({ 'note.md': REMOTE, vendored: 'a file\n' }, 'remote edit');
    const sub = await out(fx.c, ['rev-parse', 'HEAD']);
    await out(fx.c, ['update-index', '--add', '--cacheinfo', `160000,${sub},vendored`]);
    await fx.c.write('note.md', LOCAL);
    await out(fx.c, ['add', 'note.md']);
    await out(fx.c, ['commit', '-q', '-m', 'local with gitlink']);   // not add -A: it would drop the dir-less gitlink
    const local = await fx.c.head();
    await fx.c.write('other.md', 'dirty\n');
    const r = await fetchRemote(fx.c);
    const before = await fx.c.porcelain();
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'precheck' });
    expect(res.kind).toBe('data-guard-stop');
    expect(await fx.c.head()).toBe(local);
    expect(await fx.c.porcelain()).toEqual(before);
    expect(await fx.c.read('other.md')).toBe('dirty\n');
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');   // nothing was journaled, let alone written
    const stop = fx.logs.find((l) => l.msg === 'data guard stop');
    expect(stop?.phase).toBe('plan');
    expect(stop?.paths).toEqual(['vendored']);
  });
});

describe('a conflict replay whose move fails partway (R13)', () => {
  test.if(process.getuid?.() !== 0)('is undone as far as is safe: L back, the files it created gone, nothing to commit', async () => {
    // r4: `reset --hard L` left the replay target's new files (untracked to L's index) on disk. The move writes path by
    // path and moves HEAD and the index only at the end: a put the filesystem refuses undoes the puts before it.
    const fx = await fixture({ seed: { ...SEED, 'ro/keep.md': 'keep\n' } });
    await fx.c.write('note.md', LOCAL);
    const l = await commitAll(fx.c, 'local');
    await fx.remote.push({ 'note.md': REMOTE, 'new.md': 'new from R\n', 'ro/new.md': 'blocked\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    chmodSync(join(fx.c.dir, 'ro'), 0o555);
    let res;
    try {
      res = await handleRebaseConflict(fx.ctx, { local: l, remote: r, entry: 'precheck' });
    } finally {
      chmodSync(join(fx.c.dir, 'ro'), 0o755);
    }
    expect(res.kind).toBe('failed');
    expect(await fx.c.head()).toBe(l);
    expect(await fx.c.read('new.md')).toBeUndefined();
    expect(await fx.c.read('note.md')).toBe(LOCAL);
    expect(await fx.c.conflictCopies()).toEqual([]);
    expect(await fx.c.porcelain()).toEqual([]);
    expect(noOpenParts(readJournal(fx.ctx.paths.journal))).toBe(true);
    expect(worktreeWriters(fx.logs)).toEqual([]);
  });
});

describe('binary files (NUL bytes) never merge: remote at the path, local in a copy', () => {
  // r3 mutation lens: nothing drove a binary file through makeMerger, so "local wins" passed every test.
  const L = '\u0000local bytes\u0000';
  const R = '\u0000remote bytes\u0000';

  test('replayStash', async () => {
    const fx = await fixture({ seed: { ...SEED, 'img.bin': '\u0000base\u0000' } });
    await makeAutostashConflict(t, fx.c, fx.remote, { path: 'img.bin', local: L, remote: R });
    const stash = await out(fx.c, ['rev-parse', 'refs/stash']);
    const res = await replayStash(fx.ctx, { stash, unmerged: { kind: 'skip' } });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.copies).toEqual([`img ${TAG}.bin`]);
    expect(await fx.c.read('img.bin')).toBe(R);
    expect(await fx.c.read(`img ${TAG}.bin`)).toBe(L);
  });

  test('handleRebaseConflict', async () => {
    const fx = await fixture();
    await fx.remote.push({ 'img.bin': R }, 'remote binary');
    await fx.c.write('img.bin', L);
    await out(fx.c, ['add', 'img.bin']);
    await out(fx.c, ['commit', '-q', '-m', 'local binary']);
    const local = await fx.c.head();
    const r = await fetchRemote(fx.c);
    const res = await handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'precheck' });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.copies).toEqual([`img ${TAG}.bin`]);
    expect(await out(fx.c, ['show', 'HEAD:img.bin'])).toBe(R);
    expect(await fx.c.read(`img ${TAG}.bin`)).toBe(L);
  });
});

describe('replayStash', () => {
  test('data guard stop at the plan phase: HEAD unchanged, the stash kept and reported, no journal, nothing committed', async () => {
    // r3 mutation lens: disabling this guard passed every test. The stash adds a gitlink where the remote adds a file.
    const fx = await fixture();
    const sub = await out(fx.c, ['rev-parse', 'HEAD']);
    await out(fx.c, ['update-index', '--add', '--cacheinfo', `160000,${sub},vendored`]);
    await fx.c.write('note.md', LOCAL);
    const stash = await out(fx.c, ['stash', 'create']);
    await out(fx.c, ['stash', 'store', '-m', 'autostash', stash]);
    await out(fx.c, ['reset', '-q', '--hard']);
    await fx.remote.push({ 'note.md': REMOTE, vendored: 'a file\n' }, 'remote edit');
    await out(fx.c, ['merge', '-q', '--ff-only', await fetchRemote(fx.c)]);
    const head = await fx.c.head();
    const res = await replayStash(fx.ctx, { stash, unmerged: { kind: 'skip' } });
    expect(res).toMatchObject({ kind: 'data-guard-stop', stash: 'kept', keptStashes: [stash] });
    expect(await fx.c.head()).toBe(head);
    expect(await out(fx.c, ['rev-parse', 'refs/stash'])).toBe(stash);
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
    const stop = fx.logs.find((l) => l.msg === 'data guard stop');
    expect({ phase: stop?.phase, paths: stop?.paths }).toEqual({ phase: 'plan', paths: ['vendored'] });
    expect(fx.logs.some((l) => l.msg === 'stash kept' && l.stash === stash)).toBe(true);
  });

  test('autostash conflict: remote kept at the path, local in a committed copy, stash dropped', async () => {
    const fx = await fixture();
    await makeAutostashConflict(t, fx.c, fx.remote, { path: 'note.md', local: LOCAL, remote: REMOTE });
    const stash = await out(fx.c, ['rev-parse', 'refs/stash']);
    const head0 = await fx.c.head();
    // git's conflict output at note.md is AUTO_MERGE:note.md byte for byte: the policy P5 passes
    const res = await replayStash(fx.ctx, { stash, unmerged: { kind: 'auto-merge', tree: await out(fx.c, ['rev-parse', 'AUTO_MERGE']) } });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    const copy = `note ${TAG}.md`;
    expect(res.copies).toEqual([copy]);
    expect(res.stash).toBe('dropped');
    expect(res.commit).not.toBe('none');
    expect(await fx.c.head()).toBe(res.commit);
    expect(await out(fx.c, ['rev-parse', 'HEAD^'])).toBe(head0);
    expect(await treeFiles(fx.c, 'HEAD')).toEqual([...await treeFiles(fx.c, head0), copy].sort());
    expect(await fx.c.read('note.md')).toBe(REMOTE);
    expect(await fx.c.read(copy)).toBe(LOCAL);
    expect(await fx.c.stashList()).toEqual([]);
    expect(await out(fx.c, ['ls-files', '-u'])).toBe('');
    expect(await fx.c.porcelain()).toEqual([]);
    expect(noOpenParts(readJournal(fx.ctx.paths.journal))).toBe(true);
    expect(fx.logs.find((l) => l.msg === 'conflict')?.kind).toBe('stash');
    expect(worktreeWriters(fx.logs)).toEqual([]);
  });

  test('refused autostash (no unmerged entries): edits back in the worktree, uncommitted', async () => {
    const fx = await fixture();
    const stash = await makeLeftoverAutostash(t, fx.c, fx.remote, { dirty: { 'README.md': 'dirty readme\n' } });
    const head0 = await fx.c.head();
    const res = await replayStash(fx.ctx, { stash, unmerged: { kind: 'skip' } });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.copies).toEqual([]);
    expect(res.commit).toBe('none');
    expect(res.stash).toBe('dropped');
    expect(await fx.c.head()).toBe(head0);
    expect(await fx.c.read('README.md')).toBe('dirty readme\n');
    expect(await fx.c.porcelain()).toEqual([' M README.md']);
    expect(await fx.c.stashList()).toEqual([]);
  });

  test('an unreferenced stash is never replayed', async () => {
    const fx = await fixture();
    await fx.c.write('README.md', 'dirty\n');
    const sha = await out(fx.c, ['stash', 'create']);
    const res = await replayStash(fx.ctx, { stash: sha, unmerged: { kind: 'skip' } });
    expect(res.kind).toBe('failed');
    expect(await fx.c.read('README.md')).toBe('dirty\n');
  });

  test('never writes over a directory: a folder at a stash path forces a copy', async () => {
    const fx = await fixture({ seed: { 'README.md': '# notes\n', 'a.md': 'a\n' } });
    await fx.c.write('a.md', 'stashed edit\n');
    const stash = await out(fx.c, ['stash', 'create']);
    await out(fx.c, ['stash', 'store', '-m', 'autostash', stash]);
    await out(fx.c, ['reset', '-q', '--hard']);
    await fx.c.remove('a.md');
    await fx.c.write('a.md/keep.md', 'keep\n');
    const res = await replayStash(fx.ctx, { stash, unmerged: { kind: 'skip' } });
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    const copy = `a ${TAG}.md`;
    expect(res.copies).toContain(copy);
    expect(await fx.c.read(copy)).toBe('stashed edit\n');
    expect(await treeFiles(fx.c, 'HEAD')).toContain(copy);       // committable copy
    expect(await fx.c.read('a.md/keep.md')).toBe('keep\n');       // the folder's file survived
    expect(worktreeWriters(fx.logs)).toEqual([]);
    expect(await fx.c.stashList()).toEqual([]);
  });
});

describe('journal resume', () => {
  // A crash (SIGKILL) after the n-th switch of a move: nothing is undone and the journal stays for P4.
  async function crashAfter<T>(n: number, fn: () => Promise<T>): Promise<T> {
    moveTestHooks.afterOp = (k) => (k >= n ? 'crash' : 'go');
    try {
      return await fn();
    } finally {
      delete moveTestHooks.afterOp;
    }
  }

  test('conflict replay: a crash after every switch resumes to the same end state, never a duplicate copy', async () => {
    const setup = async (): Promise<{ fx: Fx; local: string; r: string }> => {
      const fx = await fixture({ seed: { ...SEED, 'gone.md': 'g\n', 'y.md': 'y\n' } });
      await fx.remote.push({ 'note.md': REMOTE, 'gone.md': null, 'new.md': 'new from R\n', 'y.md': 'y remote\n' }, 'remote');
      await fx.c.write('note.md', LOCAL);
      const local = await commitAll(fx.c, 'local');
      await fx.c.write('other.md', 'local dirty\n');
      return { fx, local, r: await fetchRemote(fx.c) };
    };
    const ref = await setup();
    const want = await handleRebaseConflict(ref.fx.ctx, { local: ref.local, remote: ref.r, entry: 'replay-conflict' });
    expect(want.kind).toBe('resolved');
    if (want.kind !== 'resolved') return;
    const refFiles = await contents(ref.fx.c);
    const refTree = await treeFiles(ref.fx.c, 'HEAD');
    for (let n = 1; n <= 6; n++) {
      const { fx, local, r } = await setup();
      const crashed = await crashAfter(n, () => handleRebaseConflict(fx.ctx, { local, remote: r, entry: 'replay-conflict' }));
      const label = `crash after switch ${n}`;
      if (crashed.kind === 'resolved') continue;   // fewer switches than n: nothing to resume
      expect(crashed.kind, label).toBe('failed');
      expect(readJournal(fx.ctx.paths.journal), label).toMatchObject({ move: { reason: 'conflict-replay', phase: 'writing' } });
      expect(await fx.c.head(), label).toBe(local);   // HEAD and the index move last
      const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
      expect(pf.kind, label).toBe('ready');
      expect(noOpenParts(readJournal(fx.ctx.paths.journal)), label).toBe(true);
      expect(await treeFiles(fx.c, 'HEAD'), label).toEqual(refTree);
      expect(await contents(fx.c), label).toEqual(refFiles);
      expect(await fx.c.porcelain(), label).toEqual([' M other.md']);
      expect(worktreeWriters(fx.logs), label).toEqual([]);
    }
  }, 60_000);

  test('a legacy rebase part whose target the filesystem refuses: back to L, edits restored, part cleared', async () => {
    const fx = await fixture();
    const local = await fx.c.head();
    await fx.c.write('other.md', 'local dirty\n');
    const stash = await out(fx.c, ['stash', 'create']);
    await out(fx.c, ['stash', 'store', '-m', 'mdsync pre-conflict', stash]);
    // A target with a 300-byte file name (git itself has no NAME_MAX) and a changed x.md that the move writes first.
    const idx = join(t.root, `refused-${++n}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    const git = (args: string[], input?: string): string => {
      const r = Bun.spawnSync(['git', ...args], { cwd: fx.c.dir, env, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    git(['read-tree', local]);
    const blob = git(['hash-object', '-w', '--stdin'], 'from the target\n');
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},x.md`]);
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${'z'.repeat(300)}.md`]);
    const target = git(['commit-tree', '-p', local, '-m', 'replay', git(['write-tree'])]);
    rmSync(idx, { force: true });
    updateJournal(fx.ctx.paths.journal, 'rebase', { op: 'rebase-conflict', phase: 'stashed', local, remote: local, target,
      stash, copies: [], overridden: [], startedAt: 'x' });

    const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(pf.kind).toBe('failed');
    if (pf.kind === 'failed') expect(pf.error).toContain('move');
    expect(await fx.c.head()).toBe(local);
    expect(await fx.c.read('x.md')).toBe('x\n');
    expect(await fx.c.read('other.md')).toBe('local dirty\n');
    expect(await fx.c.stashList()).toEqual([]);
    expect(noOpenParts(readJournal(fx.ctx.paths.journal))).toBe(true);
    expect(rescueDirEmpty(fx)).toBe(true);
    expect((await fx.c.porcelain()).sort()).toEqual([' M other.md']);
    expect(worktreeWriters(fx.logs)).toEqual([]);

    // nothing left to resume: the next run starts clean
    const again = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
    expect(again.kind === 'ready' ? again.actions.filter((a) => a !== 'journal-resumed') : again).toEqual([]);
  });

  test('stash replay: a crash after every switch resumes without a duplicate copy, and the stash is dropped once', async () => {
    const setup = async (): Promise<{ fx: Fx; stash: string; head0: string }> => {
      const fx = await fixture({ seed: { ...SEED, 'y.md': 'y\n' } });
      await makeAutostashConflict(t, fx.c, fx.remote, { path: 'note.md', local: LOCAL, remote: REMOTE });
      return { fx, stash: await out(fx.c, ['rev-parse', 'refs/stash']), head0: await fx.c.head() };
    };
    const ref = await setup();
    const want = await replayStash(ref.fx.ctx, { stash: ref.stash,
      unmerged: { kind: 'auto-merge', tree: await out(ref.fx.c, ['rev-parse', 'AUTO_MERGE']) } });
    expect(want.kind).toBe('resolved');
    if (want.kind !== 'resolved') return;
    const refFiles = await contents(ref.fx.c);
    for (let k = 1; k <= 4; k++) {
      const { fx, stash } = await setup();
      const tree = await out(fx.c, ['rev-parse', 'AUTO_MERGE']);
      const crashed = await crashAfter(k, () => replayStash(fx.ctx, { stash, unmerged: { kind: 'auto-merge', tree } }));
      if (crashed.kind === 'resolved') continue;
      const label = `crash after switch ${k}`;
      expect(readJournal(fx.ctx.paths.journal), label).toMatchObject({ move: { reason: 'stash-replay' } });
      const pf = await preflight(fx.ctx, { keptStashes: [], cloned: 'none' });
      expect(pf.kind, label).toBe('ready');
      expect(noOpenParts(readJournal(fx.ctx.paths.journal)), label).toBe(true);
      expect(await fx.c.stashList(), label).toEqual([]);
      expect(await out(fx.c, ['ls-files', '-u']), label).toBe('');
      const copies = await fx.c.conflictCopies();
      expect(copies.length, label).toBe(1);
      expect(await fx.c.read('note.md'), label).toBe(REMOTE);
      expect(await fx.c.read(copies[0]!), label).toBe(LOCAL);
      expect(await contents(fx.c), label).toEqual(refFiles);
      expect((await fx.c.log()).filter((c) => / \(conflict\)$/.test(c.subject)), label).toHaveLength(1);
    }
  }, 60_000);

  test('a legacy stash part with a written-but-different file keeps the stash (conflict write raced)', async () => {
    const fx = await fixture();
    const stash = await makeLeftoverAutostash(t, fx.c, fx.remote, { dirty: { 'README.md': 'dirty readme\n' } });
    const head = await fx.c.head();
    const work = await out(fx.c, ['rev-parse', `${stash}^{tree}`]);
    await fx.c.write('README.md', 'an agent wrote this after the replay\n');
    updateJournal(fx.ctx.paths.journal, 'stash', { op: 'stash-replay', phase: 'written', stash, head, target: head, workTree: work,
      writes: ['README.md'], deletes: [], copies: [], overridden: [], startedAt: 'x' });
    const j = readJournal(fx.ctx.paths.journal);
    expect(j).not.toBe('none');
    if (j === 'none') return;
    const res = await resumeJournal(fx.ctx, j);
    expect(res.kind).toBe('resolved');
    if (res.kind !== 'resolved') return;
    expect(res.stash).toBe('kept');
    expect(res.keptStashes).toEqual([stash]);
    expect(await fx.c.read('README.md')).toBe('an agent wrote this after the replay\n');
    expect(await fx.c.stashList()).toHaveLength(1);
    expect(fx.logs.some((l) => l.msg === 'conflict write raced' && l.path === 'README.md')).toBe(true);
    expect(fx.logs.some((l) => l.msg === 'stash kept' && l.stash === stash)).toBe(true);
    expect(noOpenParts(readJournal(fx.ctx.paths.journal))).toBe(true);
  });

  test('a legacy stash part in an impossible state: stash kept and recorded, part cleared', async () => {
    const fx = await fixture();
    await fx.c.write('README.md', 'dirty\n');
    const stash = await out(fx.c, ['stash', 'create']);
    await out(fx.c, ['stash', 'store', '-m', 'autostash', stash]);
    const head = await fx.c.head();
    updateJournal(fx.ctx.paths.journal, 'stash', { op: 'stash-replay', phase: 'written', stash, head: '0'.repeat(40),
      target: '1'.repeat(40), workTree: fx.ctx.emptyTree, writes: [], deletes: [], copies: [], overridden: [], startedAt: 'x' });
    const j = readJournal(fx.ctx.paths.journal);
    if (j === 'none') throw new Error('journal missing');
    const res = await resumeJournal(fx.ctx, j);
    expect(res.kind).toBe('failed');
    expect(res.keptStashes).toEqual([stash]);
    expect(await fx.c.head()).toBe(head);
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
  });
});

describe('copyCommittable', () => {
  test('ignore config and gitignore keep a copy local', async () => {
    const fx = await fixture({ ignore: ['private/**'] });
    writeFileSync(join(fx.c.dir, '.gitignore'), '*.secret\n');
    expect(await copyCommittable(fx.ctx, 'a.md', `a ${TAG}.md`)).toBe('commit');
    expect(await copyCommittable(fx.ctx, 'private/a.md', `private/a ${TAG}.md`)).toBe('local-only');
    expect(await copyCommittable(fx.ctx, 'k.secret', `k ${TAG}.secret`)).toBe('local-only');
    mkdirSync(join(fx.c.dir, 'sub'), { recursive: true });
    expect(await copyCommittable(fx.ctx, 'sub/b.md', `sub/b ${TAG}.md`)).toBe('commit');
  });
});

describe('foldPrecheck', () => {
  test('flags a local spelling that case-clashes with a remote path, nothing else', async () => {
    const fx = await fixture({ seed: { 'README.md': '# notes\n' } });
    const ctx: RunContext = { ...fx.ctx, ignoreCase: 'case-insensitive' };
    const g = ctx.git;
    const base = await fx.c.head();
    const blob = async (s: string): Promise<string> => g.ok(['hash-object', '-w', '--stdin'], { input: s });
    const readme = await blob('# notes\n');
    const tree = async (files: Record<string, string>): Promise<string> => g.ok(['mktree'],
      { input: Object.entries(files).map(([p, sha]) => `100644 blob ${sha}\t${p}\n`).join('') });
    const commit = async (files: Record<string, string>): Promise<string> =>
      g.ok(['commit-tree', await tree(files), '-p', base, '-m', 'c']);
    const a = await blob('a\n');
    const b = await blob('b\n');

    const l1 = await commit({ 'README.md': readme, 'Notes.md': a });
    const r1 = await commit({ 'README.md': readme, 'notes.md': b });
    expect(await foldPrecheck(ctx, l1, r1)).toEqual([['Notes.md', 'notes.md']]);

    const l2 = await commit({ 'README.md': readme, 'b.md': b });
    const r2 = await commit({ 'README.md': readme, 'a.md': a, 'A.md': b });   // remote-internal duplicate
    expect(await foldPrecheck(ctx, l2, r2)).toEqual([]);

    const l3 = await commit({ 'readme.md': readme });                        // local case-only rename
    const r3 = await commit({ 'README.md': readme, 'other.md': a });
    expect(await foldPrecheck(ctx, l3, r3)).toEqual([]);
  });
});

test('CONFLICT_COPY_RE matches every copy this module names', () => {
  expect(CONFLICT_COPY_RE.test(`note ${TAG}.md`)).toBe(true);
});
