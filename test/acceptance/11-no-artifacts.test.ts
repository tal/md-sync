// Acceptance 11 (repo hygiene): the synced repo contains nothing mdsync
// wrote except commits of user content, across every write path.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogMsg } from '../../src/log';
import {
  CONFLICT_COPY_RE, cleanupAll, cloneRemote, createRemote, emptyDir, expectNoMdsyncArtifacts, fakeNtfy, openClone,
  remoteNotifier, setupTestEnv, startDaemon, waitFor, type Daemon, type LogLine, type TestEnv,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

const FIVE = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
const edit = (who: string): string => FIVE.replace('line 3\n', `line 3 edited by ${who}\n`);
const USER_FILES = new Set(['README.md', 'note.md', 'stash.md', 'a-flush.md', 'a-idle.md', 'collide.md', 'a-term.md']);

// Every entry under dir (recursively) whose basename matches.
function namesUnder(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (match(e.name)) out.push(childRel);
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
    }
  };
  walk(dir, '');
  return out;
}

async function expectAuthorsAllowed(t: TestEnv, dirs: string[], allowed: ReadonlySet<string>): Promise<void> {
  for (const dir of dirs) {
    const r = await openClone(t, dir).git(['log', '--all', '--format=%an%n%cn']);
    expect({ dir, code: r.code }).toEqual({ dir, code: 0 });
    const names = [...new Set(r.stdout.split('\n').filter((n) => n !== ''))];
    expect({ dir, strangers: names.filter((n) => !allowed.has(n)) }).toEqual({ dir, strangers: [] });
  }
}

test('every write path leaves only user content commits in the synced repo', async () => {
  const t = await setupTestEnv('11-no-artifacts');
  const remote = await createRemote(t, { files: { 'README.md': '# notes\n', 'note.md': FIVE, 'stash.md': FIVE } });
  const ntfy = await fakeNtfy();
  remoteNotifier(remote, ntfy);

  // A: the daemon clones into an empty dir; a short idle timer gives a backup commit.
  const dirA = emptyDir(t, 'a');
  const A = await startDaemon(t, { name: 'A', dir: dirA, remote, ntfy, config: { idleMs: 1_500, maxWaitMs: 60_000 } });
  const ca = openClone(t, dirA);
  await A.waitForLog(on('cloned'));
  expect(await ca.read('note.md')).toBe(FIVE);
  // B: no ntfy, so its unflushed edit meets the remote only inside its own flush (REBASE CONFLICT).
  const cb = await cloneRemote(t, remote, 'b');
  const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote });
  // C: ntfy, so pushes reach its uncommitted work through pull-only runs (STASH CONFLICT, incoming collision).
  const cc = await cloneRemote(t, remote, 'c');
  const C = await startDaemon(t, { name: 'C', dir: cc.dir, remote, ntfy });

  const caughtUp = (d: Daemon, since: number, head: string): Promise<LogLine> =>
    d.waitForLog(on('sync done', { head }), { since });

  // 1. A flush.
  let mC = C.mark();
  await ca.write('a-flush.md', 'flushed\n');
  expect((await A.flush(['-m', 'flush from A', '--wait'])).code).toBe(0);
  await caughtUp(C, mC, await remote.head());

  // 2. An idle backup commit.
  let mA = A.mark();
  mC = C.mark();
  await ca.write('a-idle.md', 'committed by the idle timer\n');
  await A.waitForLog(on('backup timer fired', { timer: 'idle' }), { since: mA });
  await A.waitForSync({ since: mA, reason: 'idle', outcome: 'ok' });
  const [idle] = await remote.log();
  expect(idle?.subject).toMatch(/^sync \S+ \S+Z \(auto\)$/);
  expect(idle?.files).toEqual(['a-idle.md']);
  await caughtUp(C, mC, idle?.sha ?? 'none');

  // 3. REBASE CONFLICT: B's unflushed edit vs A's pushed edit, resolved inside B's flush.
  await cb.write('note.md', edit('B'));
  mC = C.mark();
  await ca.write('note.md', edit('A'));
  expect((await A.flush(['-m', 'A edits note', '--wait'])).code).toBe(0);
  await caughtUp(C, mC, await remote.head());
  mA = A.mark();
  mC = C.mark();
  const mB = B.mark();
  expect((await B.flush(['-m', 'B edits note', '--wait'])).code).toBe(0);
  await B.waitForLog(on('conflict', { kind: 'rebase' }), { since: mB });
  await B.waitForLog(on('committed', { source: 'conflict' }), { since: mB });
  const bHead = await remote.head();
  expect(await cb.head()).toBe(bHead);
  await caughtUp(A, mA, bHead);
  await caughtUp(C, mC, bHead);

  // 4. STASH CONFLICT: C's uncommitted edit vs A's push, in a pull-only run; the copy is committed.
  await cc.write('stash.md', edit('C'));
  mA = A.mark();
  mC = C.mark();
  await ca.write('stash.md', edit('A'));
  expect((await A.flush(['-m', 'A edits stash', '--wait'])).code).toBe(0);
  await C.waitForLog(on('conflict', { kind: 'stash' }), { since: mC });
  const stashRun = await C.waitForSync({ since: mC, reason: 'ntfy', outcome: 'conflict-resolved' });
  expect(await cc.stashList()).toEqual([]);
  expect(await remote.head()).toBe(stashRun.head as string);
  await caughtUp(A, mA, stashRun.head as string);

  // 5. Incoming collision: C's untracked file at a path A then pushes.
  await cc.write('collide.md', 'C local, untracked\n');
  mA = A.mark();
  mC = C.mark();
  await ca.write('collide.md', 'A version\n');
  expect((await A.flush(['-m', 'A adds collide', '--wait'])).code).toBe(0);
  const collision = await C.waitForLog(on('collision', { incoming: 'collide.md', action: 'renamed' }), { since: mC });
  const collideRun = await C.waitForSync({ since: mC, reason: 'ntfy', outcome: 'conflict-resolved' });
  expect(await cc.read('collide.md')).toBe('A version\n');
  expect(await remote.show(String(collision.copy))).toBe('C local, untracked\n');
  await caughtUp(A, mA, collideRun.head as string);

  // 6. SIGTERM with a pending change: shutdown commit (auto) + push.
  mA = A.mark();
  mC = C.mark();
  await ca.write('a-term.md', 'pending at SIGTERM\n');
  expect(await A.stop()).toBe(0);
  const termCommit = await A.waitForLog(on('committed', { source: 'shutdown' }), { since: mA });
  expect(String(termCommit.subject)).toMatch(/ \(auto\)$/);
  await A.waitForLog(on('shutdown complete'), { since: mA });
  expect(await remote.show('a-term.md')).toBe('pending at SIGTERM\n');
  await caughtUp(C, mC, await remote.head());
  expect(await C.stop()).toBe(0);
  expect(await B.stop()).toBe(0);

  // One copy per conflict mechanism reached the remote.
  expect((await remote.tree()).filter((p) => CONFLICT_COPY_RE.test(p)).length).toBe(3);

  await expectNoMdsyncArtifacts(t, [ca, cb, cc], remote, (p) => USER_FILES.has(p));
  await expectAuthorsAllowed(t, [ca.dir, cb.dir, cc.dir, remote.path],
    new Set(['Test Helper', 'mdsync-A', 'mdsync-B', 'mdsync-C']));
}, 180_000);

test.skipIf(process.platform !== 'darwin')(
  'a global core.fsmonitor=true never starts fsmonitor--daemon in the synced repo (macOS)',
  async () => {
    const t = await setupTestEnv('11-fsmonitor');
    const remote = await createRemote(t);
    const globalConfig = t.env.GIT_CONFIG_GLOBAL;
    if (globalConfig === undefined) throw new Error('harness env has no GIT_CONFIG_GLOBAL');
    const originalConfig = readFileSync(globalConfig, 'utf8');
    // Set after the seed push, so no harness git command touches a worktree index while it is on.
    appendFileSync(globalConfig, '[core]\n\tfsmonitor = true\n');

    // Control: plain git with this config does start the daemon, so the assertion below is not vacuous.
    const control = openClone(t, join(t.root, 'fsmonitor-control'));
    expect((await openClone(t, t.root).git(['init', '-q', control.dir])).code).toBe(0);
    expect((await control.git(['status', '--porcelain'])).code).toBe(0);
    await waitFor(() => namesUnder(join(control.dir, '.git'), (n) => n.startsWith('fsmonitor--daemon')).length > 0,
      { timeoutMs: 10_000, label: 'control fsmonitor--daemon' });
    await control.git(['fsmonitor--daemon', 'stop']);

    const dir = emptyDir(t, 'a');
    const A = await startDaemon(t, { name: 'A', dir, remote });
    const ca = openClone(t, dir);
    await ca.write('f.md', 'written with fsmonitor configured\n');
    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await remote.show('f.md')).toBe('written with fsmonitor configured\n');
    expect(await A.stop()).toBe(0);
    expect(namesUnder(join(dir, '.git'), (n) => n.startsWith('fsmonitor--daemon'))).toEqual([]);

    writeFileSync(globalConfig, originalConfig);
    await expectNoMdsyncArtifacts(t, [ca], remote, (p) => p === 'README.md' || p === 'f.md');
  },
  120_000,
);
