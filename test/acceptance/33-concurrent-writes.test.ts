// Writes that land while mdsync moves the worktree (D28). Since the D28 close no git
// command writes the folder: a move surveys, classifies, journals, then switches each path with a checked write.
// `MDSYNC_TEST_MOVE_PAUSE_MS` holds a move between its plan (M2–M4) and its first write (M5), so an agent's write lands
// in exactly the window that used to be lost: after the snapshot, before the switch. Every write must be kept: merged
// into the new version, left in place, or in a conflict copy. (Before the close, these tests drove `git rebase
// --autostash` through a `git` wrapper; that command no longer runs.)
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, closeSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  backdate, cleanupAll, cloneRemote, type Clone, createRemote, type Daemon, type LogLine, makeAutostashConflict, makeStoppedRebase,
  type Remote, setupTestEnv, startDaemon,
} from '../harness';

afterEach(cleanupAll);

const SIX = 'l1\nl2\nl3\nl4\nl5\nl6\n';
const PAUSE = { MDSYNC_TEST_MOVE_PAUSE_MS: '1500' };
const QUIET = { idleMs: 600_000, maxWaitMs: 1_200_000 };   // no backup commit in the middle of a scene

// Every worktree file's content, and the remote's: where a written token survives.
async function everywhere(c: Clone, r: Remote): Promise<string> {
  let all = '';
  for (const p of await c.files()) all += `${(await c.read(p)) ?? ''}\n`;
  for (const p of await r.tree()) all += `${(await r.show(p)) ?? ''}\n`;
  return all;
}

// Waits for the move of `reason` to pause, then runs the agent's write.
async function inThePause(A: Daemon, since: number, reason: string, write: () => void): Promise<void> {
  await A.waitForLog((l: LogLine) => l.msg === 'worktree move paused' && l.reason === reason, { since, timeoutMs: 60_000 });
  write();
}

test('writes into the paused gap of a pull (append, rewrite, atomic save) are merged or copied, never lost', async () => {
  const t = await setupTestEnv('cw-pull');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'a.md': SIX, 'r.md': SIX, 's.md': SIX } });
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: PAUSE, config: QUIET });
  await r.push({ 'a.md': SIX.replace('l1\n', 'l1 remote\n'), 'r.md': SIX.replace('l1\n', 'l1 remote\n'),
    's.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
  const m = A.mark();
  const flush = A.flush(['--wait']);
  await inThePause(A, m, 'pull', () => {
    appendFileSync(join(a.dir, 'a.md'), 'agent appended in the gap\n');                 // in place
    writeFileSync(join(a.dir, 'r.md'), 'agent rewrote the whole note in the gap\n');     // truncate + rewrite
    writeFileSync(join(a.dir, '.s.md.swp'), SIX.replace('l6\n', 'l6 agent atomic save\n'));
    renameSync(join(a.dir, '.s.md.swp'), join(a.dir, 's.md'));                          // an editor's atomic save
  });
  expect((await flush).code).toBe(0);
  // merged with the remote's hunk where they don't overlap; a conflicting rewrite is kept in a copy
  expect(await a.read('a.md')).toBe(`${SIX.replace('l1\n', 'l1 remote\n')}agent appended in the gap\n`);
  expect(await a.read('s.md')).toBe(SIX.replace('l1\n', 'l1 remote\n').replace('l6\n', 'l6 agent atomic save\n'));
  expect(await a.read('r.md')).toBe(SIX.replace('l1\n', 'l1 remote\n'));
  const copies = await a.conflictCopies();
  expect(copies.filter((p) => p.startsWith('r (conflict '))).toHaveLength(1);
  expect(await a.read(copies.find((p) => p.startsWith('r (conflict ')) as string)).toBe('agent rewrote the whole note in the gap\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  const all = await everywhere(a, r);
  for (const tok of ['agent appended in the gap', 'agent rewrote the whole note in the gap', 'l6 agent atomic save', 'l1 remote']) {
    expect({ tok, kept: all.includes(tok) }).toEqual({ tok, kept: true });
  }
  expect(await r.show('a.md')).toBe(`${SIX.replace('l1\n', 'l1 remote\n')}agent appended in the gap\n`);
}, 120_000);

test('a write into the paused gap of a conflict replay is merged into the new version', async () => {
  const t = await setupTestEnv('cw-conflict-replay');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'note.md': SIX } });
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: PAUSE, config: QUIET });
  await r.push({ 'note.md': SIX.replace('l3\n', 'l3 remote\n') }, 'remote');
  await a.write('note.md', SIX.replace('l3\n', 'l3 local\n'));   // committed by the flush: the replay conflicts
  const m = A.mark();
  const flush = A.flush(['--wait']);
  await inThePause(A, m, 'conflict-replay', () => appendFileSync(join(a.dir, 'note.md'), 'agent appended during the replay\n'));
  expect((await flush).code).toBe(0);
  expect(A.logs.slice(m).some((l: LogLine) => l.msg === 'conflict' && l.kind === 'rebase')).toBe(true);
  expect(await a.read('note.md')).toBe(`${SIX.replace('l3\n', 'l3 remote\n')}agent appended during the replay\n`);
  const copies = await a.conflictCopies();
  expect(await Promise.all(copies.map((p) => a.read(p)))).toContain(SIX.replace('l3\n', 'l3 local\n'));
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await r.show('note.md')).toBe(`${SIX.replace('l3\n', 'l3 remote\n')}agent appended during the replay\n`);
}, 120_000);

test('a rewrite of a conflicted file in the paused gap of a stash replay (P5) is kept, and so is the stashed edit', async () => {
  // r4 chaos: the old replay's `reset --hard` destroyed an agent's rewrite of a file git's autostash apply had left in
  // conflict. Now the put at that path checks its bytes right before the switch, and finds the agent's.
  const t = await setupTestEnv('cw-stash-replay');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'note.md': SIX } });
  const a = await cloneRemote(t, r, 'a');
  await makeAutostashConflict(t, a, r, { path: 'note.md', local: SIX.replace('l3\n', 'l3 local\n'), remote: SIX.replace('l3\n', 'l3 remote\n') });
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: PAUSE, config: QUIET, wait: 'none' });
  await inThePause(A, 0, 'stash-replay', () => writeFileSync(join(a.dir, 'note.md'), 'agent rewrote the conflicted note\n'));
  const done = await A.waitForSync({ reason: 'startup', timeoutMs: 60_000 });
  expect(['ok', 'conflict-resolved']).toContain(String(done.outcome));
  const files = await Promise.all((await a.files()).map(async (p) => (await a.read(p)) ?? ''));
  expect(files).toContain('agent rewrote the conflicted note\n');
  // the stashed edit is in a copy, or (when the replay kept its stash because a write raced it) still in the stash
  const stash = (await a.git(['stash', 'list', '--format=%H'])).stdout.trim().split('\n').filter((x) => x !== '');
  const inStash = await Promise.all(stash.map(async (s) => (await a.git(['show', `${s}:note.md`])).stdout));
  expect([...files, ...inStash].some((c) => c.includes('l3 local'))).toBe(true);
  expect((await a.git(['ls-files', '-u'])).stdout).toBe('');
}, 120_000);

test('a rewrite of a conflicted file in the paused gap of P2 (a stopped rebase quit, then moved) is kept in a copy', async () => {
  // r4 chaos: `rebase --abort` destroyed an agent's rewrite of the conflicted file. P2 now quits the op (no worktree
  // write) and moves to the abort target with checked writes; what git wrote there is replaced, an agent's bytes are not.
  const t = await setupTestEnv('cw-op-quit');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'note.md': SIX } });
  const a = await cloneRemote(t, r, 'a');
  await makeStoppedRebase(t, a, r, { path: 'note.md', local: SIX.replace('l3\n', 'l3 local\n'), remote: SIX.replace('l3\n', 'l3 remote\n') });
  backdate(join(a.dir, '.git', 'rebase-merge', 'stopped-sha'), 10_000);   // a rebase stopped long ago: P2 recovers it
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: PAUSE, config: QUIET, wait: 'none' });
  await inThePause(A, 0, 'op-quit', () => writeFileSync(join(a.dir, 'note.md'), 'agent rewrote the conflicted note\n'));
  const done = await A.waitForSync({ reason: 'startup', timeoutMs: 60_000 });
  expect(['ok', 'conflict-resolved']).toContain(String(done.outcome));
  expect(A.logs.some((l: LogLine) => l.msg === 'recovered' && l.action === 'rebase-aborted')).toBe(true);
  const contents = await Promise.all((await a.files()).map(async (p) => (await a.read(p)) ?? ''));
  expect(contents).toContain('agent rewrote the conflicted note\n');
  expect(contents.some((c) => c.includes('l3 local'))).toBe(true);
  expect(await a.read('note.md')).not.toContain('<<<<<<<');
}, 120_000);

test('a write through a descriptor opened before the switch and issued a second later is kept (settle: late copy)', async () => {
  const t = await setupTestEnv('cw-late');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'a.md': SIX } });
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: QUIET });
  await r.push({ 'a.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
  const fd = openSync(join(a.dir, 'a.md'), 'a');   // a logger holding the old version open
  const m = A.mark();
  try {
    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await a.read('a.md')).toBe(SIX.replace('l1\n', 'l1 remote\n'));
    await Bun.sleep(1_000);
    writeSync(fd, 'written through the old descriptor\n');
  } finally {
    closeSync(fd);
  }
  const raced = await A.waitForLog((l: LogLine) => l.msg === 'worktree write raced' && l.kind === 'late', { since: m, timeoutMs: 30_000 });
  expect(await a.read(String(raced.copy))).toBe(`${SIX}written through the old descriptor\n`);
  expect(await a.read('a.md')).toBe(SIX.replace('l1\n', 'l1 remote\n'));
}, 120_000);

test('a path that keeps changing through the whole move ends in an identity copy, and the run is ok', async () => {
  const t = await setupTestEnv('cw-changing');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'a.md': SIX } });
  const a = await cloneRemote(t, r, 'a');
  // rounds 1 and 2 both pause, so the writer changes the path in both and round 3 is in identity mode: unpaused, a
  // fast round 2 (Linux) can fall between two saves and end the move with a plain conflict copy
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: { ...PAUSE, MDSYNC_TEST_MOVE_PAUSE_ROUNDS: '2' }, config: QUIET });
  await r.push({ 'a.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
  let n = 0;
  let writing: 'on' | 'off' = 'on';
  const writer = (async () => {
    while (writing === 'on') {
      writeFileSync(join(a.dir, 'a.md'), `${SIX}agent write ${++n}\n`);
      await Bun.sleep(20);
    }
  })();
  const m = A.mark();
  let code: number;
  try {
    code = (await A.flush(['--wait'])).code;
  } finally {
    writing = 'off';
    await writer;
  }
  expect(code).toBe(0);
  const done = A.logs.slice(m).find((l: LogLine) => l.msg === 'sync done');
  expect(['ok', 'conflict-resolved']).toContain(String(done?.outcome));
  const changing = A.logs.slice(m).find((l: LogLine) => l.msg === 'worktree write raced' && l.kind === 'changing');
  expect(changing).toBeDefined();
  expect(await a.read(String(changing?.copy))).toMatch(/^l1\nl2\nl3\nl4\nl5\nl6\nagent write \d+\n$/);
  expect(await a.read('a.md')).toMatch(/agent write \d+\n$|^l1 remote\n/);   // the writer's last save, or the move's version
}, 120_000);

test('a committed copy whose original was rewritten, appended to or renamed in the paused gap is written, and no commit deletes it', async () => {
  // Chaos round 2 (seeds 121, 138, 141, 149, 157, 158, 160, 164): round 1 committed a copy of each uncommitted edit,
  // then the agent changed or renamed the original before the copy's link, so the link was refused. Round 2 never wrote
  // the committed copy: HEAD had it, the disk did not, and the next commit pushed a delete no agent made.
  const t = await setupTestEnv('cw-copy-link');
  const r = await createRemote(t, { files: { 'README.md': '# n\n', 'o.md': SIX, 'p.md': SIX, 'q.md': SIX } });
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: PAUSE, config: { ...QUIET, fallbackMs: 2_000 } });
  const LOCAL = SIX.replace('l3\n', 'l3 local\n');
  for (const p of ['o.md', 'p.md', 'q.md']) await a.write(p, LOCAL);   // uncommitted (QUIET): a pull-only run's autostash case
  const m = A.mark();
  await r.push({ 'o.md': SIX.replace('l3\n', 'l3 remote\n'), 'p.md': SIX.replace('l3\n', 'l3 remote\n'),
    'q.md': SIX.replace('l3\n', 'l3 remote\n') }, 'remote');
  await inThePause(A, m, 'pull', () => {
    writeFileSync(join(a.dir, 'o.md'), 'agent rewrote o in the gap\n');
    appendFileSync(join(a.dir, 'p.md'), 'agent appended to p in the gap\n');
    renameSync(join(a.dir, 'q.md'), join(a.dir, 'q-moved.md'));
  });
  await A.waitForLog((l: LogLine) => l.msg === 'sync done', { since: m, timeoutMs: 60_000 });
  const committed = (await a.git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'])).stdout.split('\0').filter((p) => p.includes('(conflict '));
  expect(committed).toHaveLength(3);
  for (const c of committed) expect({ c, bytes: await a.read(c) }).toEqual({ c, bytes: LOCAL });   // round 1's snapshots
  expect((await a.porcelain()).filter((l) => /^.D/.test(l))).toEqual([]);
  expect((await A.flush(['--wait'])).code).toBe(0);
  const deletes = Bun.spawnSync(['git', 'log', '--diff-filter=D', '--no-renames', '--name-only', '-z', '--format=', 'refs/heads/main'],
    { cwd: r.path, env: t.env }).stdout.toString().split('\0').map((p) => p.trim()).filter((p) => p !== '');
  expect(deletes).toEqual([]);
  const tree = await r.tree();
  for (const c of committed) expect(tree).toContain(c);
  const all = await everywhere(a, r);
  for (const tok of ['agent rewrote o in the gap', 'agent appended to p in the gap', 'l3 local', 'l3 remote']) {
    expect({ tok, kept: all.includes(tok) }).toEqual({ tok, kept: true });
  }
  expect(await r.show('q-moved.md')).toBe(LOCAL);
  expect(await r.show('q.md')).toBe(SIX.replace('l3\n', 'l3 remote\n'));   // the rename's delete lost to the remote edit
}, 120_000);
