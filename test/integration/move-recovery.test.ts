// Crash and error recovery of the worktree move, review round 5: each test
// reproduces one confirmed finding (d28-data-1 … -7) with a simulated SIGKILL (`moveTestHooks`) or an I/O error at
// exactly the point the review found, and asserts what a resumed or retried move leaves: the remote's changes on disk
// under the HEAD that names them, every local edit kept, nothing left in the temp folder, nothing junk committed.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { createLogger } from '../../src/log';
import { handleRebaseConflict } from '../../src/conflict';
import { reprobe, volumeCaps } from '../../src/exchange';
import { type MoveInput, moveTestHooks, moveWorktree, resumeMove, SETTLE_GRACE_MS, settlePending, SimulatedCrash } from '../../src/move';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { type MoveJournal, mutateJournal, readJournal } from '../../src/state';
import {
  cleanupAll, cloneRemote, type Clone, createRemote, emptyDir, type LogLine, openClone, type Remote, setupTestEnv, type TestEnv,
} from '../harness';

setDefaultTimeout(60_000);

let t: TestEnv;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'MDSYNC_TEST_EXCHANGE_MODE', 'MDSYNC_TEST_MOVE_PAUSE_MS'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const SIX = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const ROOT = process.getuid?.() === 0;   // root ignores a read-only folder: the EACCES cases can't be made

beforeAll(async () => {
  t = await setupTestEnv('move-recovery');
  process.env.GIT_CONFIG_NOSYSTEM = t.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = t.env.GIT_CONFIG_GLOBAL;
});

afterEach(() => {
  delete moveTestHooks.afterOp;
  delete moveTestHooks.inWritePass;
  exchangeMode('probed');
  delete process.env.MDSYNC_TEST_MOVE_PAUSE_MS;
});

// The volume probe is cached per filesystem and process: a capped mode needs the cache dropped, both ways.
function exchangeMode(m: 'copy-only' | 'rename-only' | 'probed'): void {
  if (m === 'probed') delete process.env.MDSYNC_TEST_EXCHANGE_MODE;
  else process.env.MDSYNC_TEST_EXCHANGE_MODE = m;
  reprobe(t.root);
  if (m !== 'probed') expect(volumeCaps(emptyDir(t, `probe-${++n}`)).mode).toBe(m);   // in effect for this filesystem
  if (m === 'copy-only') expect(volumeCaps(emptyDir(t, `probe-${++n}`)).noReplace).toBe('excl-open');
}

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
}, 120_000);

type Fx = { remote: Remote; c: Clone; ctx: RunContext; logs: LogLine[] };

async function out(c: Clone, args: string[]): Promise<string> {
  const r = await c.git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function contextFor(c: Clone, remote: Remote | string): Promise<{ ctx: RunContext; logs: LogLine[] }> {
  const config: ReadyConfig = { dir: c.dir, remote: typeof remote === 'string' ? remote : remote.url, branch: 'main', idleMs: 60_000,
    fallbackMs: 3_600_000, maxWaitMs: 120_000, autoCommit: 'timers', ignore: [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (line) => { logs.push(JSON.parse(line) as LogLine); } });
  return { ctx: await createRunContext({ config, realDir: c.dir, paths, log }), logs };
}

async function fixture(seed: Record<string, string> = { 'README.md': '# notes\n', 'note.md': SIX, 'other.md': 'other\n' }): Promise<Fx> {
  const remote = await createRemote(t, { files: seed });
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  return { remote, c, ...(await contextFor(c, remote)) };
}

async function fetchRemote(c: Clone): Promise<string> {
  await out(c, ['fetch', '-q', 'origin']);
  return out(c, ['rev-parse', 'refs/remotes/origin/main']);
}

function pull(h: string, to: string): MoveInput {
  return { reason: 'pull', from: h, to, ref: { kind: 'update', ref: 'refs/heads/main', old: h, head: 'as-is' }, index: 'changed-paths',
    edits: 'merge', copies: 'commit' };
}

function movePart(fx: { ctx: RunContext }): MoveJournal {
  const j = readJournal(fx.ctx.paths.journal);
  if (j === 'none' || j.move === undefined) throw new Error('no move part');
  return j.move;
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((x) => /^\.mdsync-\d+-\d+\.d$/.test(x)).flatMap((d) => readdirSync(join(dir, d)).map((f) => `${d}/${f}`));
}

async function settleNow(fx: { ctx: RunContext }): Promise<void> {
  const j = readJournal(fx.ctx.paths.journal);
  if (j === 'none' || j.settle === undefined) return;
  // These tests exercise settlement after expiry; the late-descriptor test covers the real grace period.
  mutateJournal(fx.ctx.paths.journal, (x) => ({ ...x, settle: (x.settle ?? []).map((e) => ({
    ...e, since: Date.now() - SETTLE_GRACE_MS - 1,
  })) }));
  await settlePending(fx.ctx, 'due');
}

// what the device's next commit run would stage (temp folders excluded, as staging excludes them)
async function nextCommit(c: Clone): Promise<string> {
  await out(c, ['add', '-A', '--', '.', ':(exclude,glob)**/.mdsync-*.d/**']);
  return out(c, ['diff', '--cached', '--name-status']);
}

// A crash at the n-th switch of `path` (counting the forward put and the undo's), as a SIGKILL there would leave it.
function crashAtSwitch(path: string, nth: number): void {
  let seen = 0;
  moveTestHooks.afterOp = (_k, p) => (p === path && ++seen === nth ? 'crash' : 'go');
}

describe.if(!ROOT)('d28-data-1: a crash during M9\'s undo', () => {
  test('a modified path: the resumed part fails as undone (HEAD stays at from), and the next move takes the remote edit', async () => {
    const fx = await fixture({ 'README.md': '# n\n', 'x.md': 'x v1\n', 'ro/keep.md': 'k\n' });
    const h = await fx.c.head();
    await fx.remote.push({ 'x.md': 'x v2 (the remote edit)\n', 'ro/new.md': 'blocked\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    chmodSync(join(fx.c.dir, 'ro'), 0o555);   // ro/new.md's create fails (EACCES): M9 undoes x.md's put
    crashAtSwitch('x.md', 2);                 // the 2nd switch at x.md is the undo's
    try {
      await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
    } finally {
      chmodSync(join(fx.c.dir, 'ro'), 0o755);
    }
    expect(movePart(fx).phase).toBe('undoing');
    const res = await resumeMove(fx.ctx, movePart(fx));
    expect(res.kind).toBe('failed');
    expect(await fx.c.head()).toBe(h);
    const j = readJournal(fx.ctx.paths.journal);
    expect(j === 'none' || j.move === undefined).toBe(true);
    // before: 'moved' with HEAD == R over x v1, and the next commit pushed the revert of v2
    expect(await nextCommit(fx.c)).toBe('');
    await out(fx.c, ['reset', '-q']);
    const again = await moveWorktree(fx.ctx, pull(h, r));
    expect(again.kind).toBe('moved');
    expect(await fx.c.head()).toBe(r);
    expect(await fx.c.read('x.md')).toBe('x v2 (the remote edit)\n');
    expect(await fx.c.read('ro/new.md')).toBe('blocked\n');
    expect(await fx.c.porcelain()).toEqual([]);
    await settleNow(fx);
    expect(tempFiles(fx.c.dir)).toEqual([]);
  });

  test('a created path: the undo\'s delete never marks it done as absent; the next move writes it', async () => {
    const fx = await fixture({ 'README.md': '# n\n', 'ro/keep.md': 'k\n' });
    const h = await fx.c.head();
    await fx.remote.push({ 'a-new.md': 'a brand new remote note\n', 'ro/new.md': 'blocked\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    chmodSync(join(fx.c.dir, 'ro'), 0o555);
    crashAtSwitch('a-new.md', 2);             // the undo's delete of the create
    try {
      await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
    } finally {
      chmodSync(join(fx.c.dir, 'ro'), 0o755);
    }
    const res = await resumeMove(fx.ctx, movePart(fx));
    expect(res.kind).toBe('failed');
    expect(await fx.c.head()).toBe(h);
    expect(await nextCommit(fx.c)).toBe('');   // before: HEAD == R and the next commit staged "D a-new.md"
    await out(fx.c, ['reset', '-q']);
    const again = await moveWorktree(fx.ctx, pull(h, r));
    expect(again.kind).toBe('moved');
    expect(await fx.c.read('a-new.md')).toBe('a brand new remote note\n');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('an unborn first sync: a crash after some undo deletes; nothing staged as deleted, the next move populates the folder', async () => {
    const files: Record<string, string> = { 'README.md': '# n\n', 'zz/new.md': 'blocked\n' };
    for (let k = 0; k < 5; k++) files[`a${k}.md`] = `note ${k}\n`;
    const remote = await createRemote(t, { files });
    const dir = emptyDir(t, `unborn-${++n}`);
    const c = openClone(t, dir);
    await out(c, ['init', '-q', '-b', 'main']);
    await out(c, ['remote', 'add', 'origin', remote.url]);
    const r = await fetchRemote(c);
    mkdirSync(join(dir, 'zz'));
    chmodSync(join(dir, 'zz'), 0o555);       // zz/new.md's create fails: the undo deletes every create before it
    const { ctx } = await contextFor(c, remote);
    const created = new Set<string>();
    let undone = 0;
    moveTestHooks.afterOp = (_k, p) => {
      if (created.has(p)) return ++undone === 3 ? 'crash' : 'go';   // three undo deletes, then SIGKILL
      created.add(p);
      return 'go';
    };
    const unborn: MoveInput = { reason: 'unborn', from: 'empty', to: r, ref: { kind: 'update', ref: 'refs/heads/main', old: 'zero',
      head: 'as-is' }, index: 'reset', edits: 'merge', copies: 'commit' };
    try {
      await expect(moveWorktree(ctx, unborn)).rejects.toBeInstanceOf(SimulatedCrash);
    } finally {
      chmodSync(join(dir, 'zz'), 0o755);
    }
    const res = await resumeMove(ctx, movePart({ ctx }));
    expect(res.kind).toBe('failed');
    expect((await c.git(['rev-parse', '-q', '--verify', 'HEAD'])).code).not.toBe(0);   // still unborn
    delete moveTestHooks.afterOp;
    const again = await moveWorktree(ctx, unborn);
    expect(again.kind).toBe('moved');
    expect(await c.porcelain()).toEqual([]);
    for (let k = 0; k < 5; k++) expect(await c.read(`a${k}.md`)).toBe(`note ${k}\n`);
  });
});

describe('d28-data-2: copy-only, a crash between C5c\'s rename aside and its create', () => {
  // The put of a merged uncommitted edit finished; the process is put back to the instant between C5c's two steps
  // (path absent, temp = the merged version, aside = the old inode holding the edit), or to an O_EXCL copy create cut
  // part-way (excl-open filesystems: the path holds a strict prefix of the merged version).
  for (const cut of ['absent', 'prefix'] as const) {
    test(`the path ${cut === 'absent' ? 'is absent' : 'holds a prefix of the new version'}: the resume finishes the switch, the edit is kept`, async () => {
      exchangeMode('copy-only');
      const fx = await fixture();
      const h = await fx.c.head();
      await fx.remote.push({ 'note.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
      const r = await fetchRemote(fx.c);
      await fx.c.write('note.md', SIX.replace('l6\n', 'l6 LOCAL-EDIT\n'));   // merges cleanly with the remote hunk
      crashAtSwitch('note.md', 1);
      await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
      const j = movePart(fx);
      const temp = j.temps.find((x) => x.path === 'note.md' && x.kind === 'temp')?.name as string;
      const merged = readFileSync(join(fx.c.dir, 'note.md'));
      expect(merged.toString()).toContain('LOCAL-EDIT');
      renameSync(join(fx.c.dir, 'note.md'), join(fx.c.dir, temp));
      if (cut === 'prefix') writeFileSync(join(fx.c.dir, 'note.md'), merged.subarray(0, 9));
      const res = await resumeMove(fx.ctx, j);
      expect(res.kind).toBe('moved');
      if (res.kind !== 'moved') return;
      expect(res.overridden).toEqual([]);   // before: [{note.md, deletedBy: 'local'}], and the edit only in the aside
      const want = SIX.replace('l1\n', 'l1 remote\n').replace('l6\n', 'l6 LOCAL-EDIT\n');
      expect(await fx.c.read('note.md')).toBe(want);
      expect(fx.logs.some((l) => l.msg === 'delete overridden')).toBe(false);
      await settleNow(fx);
      expect(await fx.c.read('note.md')).toBe(want);
      expect(await fx.c.conflictCopies()).toEqual([]);
      expect(tempFiles(fx.c.dir)).toEqual([]);
      expect(await fx.c.porcelain()).toEqual([' M note.md']);
    });
  }

  test('a create cut part-way through its O_EXCL copy: the resume completes it, no add/add copy of a fragment', async () => {
    exchangeMode('copy-only');   // excl-open: the only no-replace create a crash can cut part-way
    const fx = await fixture();
    const h = await fx.c.head();
    await fx.remote.push({ 'new.md': 'a new note with some bytes\n'.repeat(40) }, 'remote');
    const r = await fetchRemote(fx.c);
    crashAtSwitch('new.md', 1);
    await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
    const j = movePart(fx);
    const temp = j.temps.find((x) => x.path === 'new.md' && x.kind === 'temp')?.name as string;
    copyFileSync(join(fx.c.dir, 'new.md'), join(fx.c.dir, temp));   // copyExcl had not unlinked the temp yet
    truncateSync(join(fx.c.dir, 'new.md'), 100);
    const res = await resumeMove(fx.ctx, j);
    expect(res.kind).toBe('moved');
    expect(await fx.c.read('new.md')).toBe('a new note with some bytes\n'.repeat(40));
    expect(await fx.c.conflictCopies()).toEqual([]);
    expect(await fx.c.porcelain()).toEqual([]);
  });
});

describe('d28-data-3: every object a ref is moved to is written durably', () => {
  test('the copies commit of a pull, a merged blob, and the conflict replay\'s C', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    await fx.remote.push({ 'note.md': SIX.replace('l3\n', 'l3 remote\n'), 'other.md': 'other\nremote\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    await fx.c.write('note.md', SIX.replace('l3\n', 'l3 local\n'));   // conflicts: a committed copy
    await fx.c.write('other.md', 'local\nother\n');                    // merges: a merged blob
    fx.logs.length = 0;
    const mv = await moveWorktree(fx.ctx, pull(h, r));
    expect(mv).toMatchObject({ kind: 'moved' });
    expect(mv.kind === 'moved' && mv.commit !== 'none').toBe(true);
    const moveWrites = objectWriters(fx.logs);
    expect(moveWrites.map((w) => w.call)).toEqual(expect.arrayContaining(['write-tree', 'commit-tree', 'hash-object -w']));

    await out(fx.c, ['add', '-A']);
    await out(fx.c, ['commit', '-qm', 'local']);
    await fx.remote.push({ 'other.md': 'other\nremote\nagain\n' }, 'remote 2');
    await fx.c.write('other.md', 'local\nother\nremote\nmine\n');
    await out(fx.c, ['commit', '-qam', 'local 2']);
    const l2 = await fx.c.head();
    const r2 = await fetchRemote(fx.c);
    fx.logs.length = 0;
    const cr = await handleRebaseConflict(fx.ctx, { local: l2, remote: r2, entry: 'replay-conflict' });
    expect(cr.kind).toBe('resolved');
    const replayWrites = objectWriters(fx.logs);
    expect(replayWrites.map((w) => w.call)).toEqual(expect.arrayContaining(['write-tree', 'commit-tree']));
    // before: write-tree and commit-tree ran without core.fsync=committed, then HEAD was moved to their commit
    expect([...moveWrites, ...replayWrites].filter((w) => w.durable === 'no')).toEqual([]);
  });
});

function objectWriters(logs: readonly LogLine[]): { call: string; durable: 'yes' | 'no' }[] {
  const res: { call: string; durable: 'yes' | 'no' }[] = [];
  for (const l of logs) {
    if (l.msg !== 'git') continue;
    const args = l.args as string[];
    const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? '';
    const writes = sub === 'commit-tree' || sub === 'write-tree' || sub === 'merge-tree' || (sub === 'hash-object' && args.includes('-w'));
    if (!writes) continue;
    res.push({ call: `${sub}${sub === 'hash-object' ? ' -w' : ''}`, durable: args.includes('core.fsync=committed') ? 'yes' : 'no' });
  }
  return res;
}

describe('d28-data-4: identity mode terminates without hard links (W5)', () => {
  for (const mode of ['copy-only', 'rename-only'] as const) {
    test(`${mode}: a path rewritten every 50 ms through the whole move ends moved, its bytes kept`, async () => {
      exchangeMode(mode);
      const fx = await fixture();
      const h = await fx.c.head();
      await fx.remote.push({ 'note.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
      const r = await fetchRemote(fx.c);
      let i = 0;
      let last = '';
      const rewrite = () => {
        last = `rewrite ${++i}\n`;
        writeFileSync(join(fx.c.dir, 'note.md'), last);
      };
      const timer = setInterval(rewrite, 50);
      // The pause makes round 1 see a change. A fast round 2 (Linux) can fall between two timer writes and finish with a
      // plain conflict copy, so a write inside round 2's write pass makes the third round's identity mode certain.
      let round = 0;
      moveTestHooks.afterSurvey = (n) => { round = n; };
      moveTestHooks.inWritePass = () => {
        if (round === 2) rewrite();
        return 'go';
      };
      process.env.MDSYNC_TEST_MOVE_PAUSE_MS = '200';
      let mv;
      try {
        mv = await moveWorktree(fx.ctx, pull(h, r));
      } finally {
        delete moveTestHooks.afterSurvey;
        delete moveTestHooks.inWritePass;
        delete process.env.MDSYNC_TEST_MOVE_PAUSE_MS;
        await Bun.sleep(120);
        clearInterval(timer);
      }
      expect(mv.kind).toBe('moved');   // before (copy-only): busy, and every resume busy again, two more copies each time
      expect(fx.logs.some((l) => l.msg === 'worktree write raced' && l.kind === 'changing')).toBe(true);
      await settleNow(fx);
      const all = await Promise.all((await fx.c.files()).map((f) => fx.c.read(f)));
      expect(all).toContain(last);
      expect(tempFiles(fx.c.dir)).toEqual([]);
    }, 30_000);
  }
});

describe('d28-data-5: a temp cut short by a crash in the write pass', () => {
  test('is ours, never a replaced inode: no `late` copy of junk after the resume and the settle', async () => {
    const BIG = 'remote line\n'.repeat(4000);
    const fx = await fixture();
    const h = await fx.c.head();
    await fx.remote.push({ 'a-new.md': 'new\n', 'note.md': BIG }, 'remote');
    const r = await fetchRemote(fx.c);
    // SIGKILL in the middle of C1 for note.md: its O_EXCL temp holds only part of the new version
    moveTestHooks.inWritePass = (_k, p, temp) => {
      if (p !== 'note.md') return 'go';
      truncateSync(join(fx.c.dir, temp), 1000);
      return 'crash';
    };
    await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
    delete moveTestHooks.inWritePass;
    const res = await resumeMove(fx.ctx, movePart(fx));
    expect(res.kind).toBe('moved');
    await settleNow(fx);
    expect(await fx.c.conflictCopies()).toEqual([]);   // before: 'note (conflict …).md', 1000 bytes, committed as `late`
    expect(fx.logs.some((l) => l.msg === 'worktree write raced')).toBe(false);
    expect(await fx.c.read('note.md')).toBe(BIG);
    expect(await fx.c.porcelain()).toEqual([]);
    expect(tempFiles(fx.c.dir)).toEqual([]);
  });

  test('a crash after the pass completed but before its mark: the whole temps are unlinked, nothing switched', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    await fx.remote.push({ 'note.md': SIX.replace('l1\n', 'l1 remote\n'), 'other.md': 'other remote\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    let k = 0;
    moveTestHooks.inWritePass = () => (++k === 2 ? 'crash' : 'go');
    await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
    delete moveTestHooks.inWritePass;
    const res = await resumeMove(fx.ctx, movePart(fx));
    expect(res.kind).toBe('moved');
    await settleNow(fx);
    expect(await fx.c.conflictCopies()).toEqual([]);
    expect(await fx.c.read('other.md')).toBe('other remote\n');
    expect(tempFiles(fx.c.dir)).toEqual([]);
  });
});

describe('d28-data-6: a failed write pass or put leaves no temps behind', () => {
  test('a write error part-way through the pass (ENOSPC): three failed attempts, no temp left, even before the settle', async () => {
    const BIG = 'x'.repeat(2_000_000);
    const fx = await fixture({ 'README.md': '# n\n', 'a.md': 'a\n', 'z.md': 'z\n' });
    const h = await fx.c.head();
    await fx.remote.push({ 'a.md': BIG, 'z.md': 'z remote\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    moveTestHooks.inWritePass = (_k, p) => (p === 'z.md' ? 'fail' : 'go');   // a.md's 2 MB temp is written first
    for (let k = 0; k < 3; k++) {
      const mv = await moveWorktree(fx.ctx, pull(h, r));
      expect(mv.kind).toBe('failed');
      expect(tempFiles(fx.c.dir)).toEqual([]);   // before: one more 2 MB temp per attempt, unjournaled
    }
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
    expect(await fx.c.head()).toBe(h);
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test.if(!ROOT)('a put that fails with EACCES: the temps of the puts after it are unlinked, nothing is left after the settle', async () => {
    const fx = await fixture({ 'README.md': '# n\n', 'ro/keep.md': 'k\n', 'zz/deep/a.md': 'a\n', 'zz/deep/b.md': 'b\n' });
    const h = await fx.c.head();
    await fx.remote.push({ 'ro/new.md': 'blocked\n', 'zz/deep/a.md': 'a remote\n', 'zz/deep/b.md': 'b remote\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    chmodSync(join(fx.c.dir, 'ro'), 0o555);
    let mv;
    try {
      mv = await moveWorktree(fx.ctx, pull(h, r));
    } finally {
      chmodSync(join(fx.c.dir, 'ro'), 0o755);
    }
    expect(mv.kind).toBe('failed');
    await settleNow(fx);
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
    expect(tempFiles(fx.c.dir)).toEqual([]);   // before: the temps of zz/deep/a.md and b.md ("a remote", "b remote")
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('writeTemp unlinks a temp it created when the write fails part-way', async () => {
    const { writeTemp } = await import('../../src/cas');
    const dir = emptyDir(t, `wt-${++n}`);
    mkdirSync(join(dir, 'src-is-a-folder'));
    const r = writeTemp(dir, 'temp-1', { kind: 'file', src: join(dir, 'src-is-a-folder'), exec: 'plain' });   // read fails: EISDIR
    expect(r).not.toBe('written');
    expect(readdirSync(dir)).toEqual(['src-is-a-folder']);
  });
});

describe('d28-data-7: a crash between a rename-follow\'s create and the old name\'s delete', () => {
  test('the resumed move deletes the old name: the edit is in the new one, nothing comes back', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    const helper = await cloneRemote(t, fx.remote, `renamer-${++n}`);
    await out(helper, ['mv', 'note.md', 'renamed.md']);
    await helper.write('renamed.md', SIX.replace('l1\n', 'l1 remote\n'));
    await out(helper, ['add', '-A']);
    await out(helper, ['commit', '-qm', 'rename']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    await fx.c.write('note.md', SIX.replace('l6\n', 'l6 local\n'));
    crashAtSwitch('renamed.md', 1);
    await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
    const res = await resumeMove(fx.ctx, movePart(fx));
    expect(res.kind).toBe('moved');
    expect(await fx.c.read('note.md')).toBeUndefined();   // before: kept as edit-restored, and the next commit added it back
    expect(await fx.c.read('renamed.md')).toBe(SIX.replace('l1\n', 'l1 remote\n').replace('l6\n', 'l6 local\n'));
    expect(await fx.c.porcelain()).toEqual([' M renamed.md']);
    expect(fx.logs.some((l) => l.msg === 'delete overridden')).toBe(false);
  });

  test('an old name edited again after the plan is kept (an edit wins over a delete)', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    const helper = await cloneRemote(t, fx.remote, `renamer-${++n}`);
    await out(helper, ['mv', 'note.md', 'renamed.md']);
    await out(helper, ['commit', '-qm', 'rename']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    await fx.c.write('note.md', SIX.replace('l6\n', 'l6 local\n'));
    crashAtSwitch('renamed.md', 1);
    await expect(moveWorktree(fx.ctx, pull(h, r))).rejects.toBeInstanceOf(SimulatedCrash);
    await fx.c.write('note.md', SIX.replace('l6\n', 'l6 local, then more\n'));   // after the crash, before the restart
    const res = await resumeMove(fx.ctx, movePart(fx));
    expect(res.kind).toBe('moved');
    expect(await fx.c.read('note.md')).toBe(SIX.replace('l6\n', 'l6 local, then more\n'));
  });
});
