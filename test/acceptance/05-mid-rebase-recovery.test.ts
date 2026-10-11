// Acceptance 5: killing the daemon mid-rebase and restarting it recovers
// automatically, with a clean tree and nothing lost — including edits agents made while git was stopped.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LogMsg } from '../../src/log';
import {
  CONFLICT_COPY_RE, backdate, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, makeAutostashConflict,
  makeLeftoverAutostash, makeStoppedRebase, setupTestEnv, startDaemon, waitNoLiveGit,
  type Clone, type LogLine, type Remote, type TestEnv,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

const TIMEOUT_MS = 180_000;
// Long timers: no backup commit may land in the middle of a recovery scenario.
const QUIET = { idleMs: 600_000, maxWaitMs: 1_200_000 };
const BASE = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
const LOCAL = 'line 1\nline 2\nline 3 committed locally\nline 4\nline 5\n';
const REMOTE = 'line 1\nline 2\nline 3 pushed remotely\nline 4\nline 5\n';
const OTHER_DIRTY = 'local dirty';
const NOTES_BASE = '# notes\n';
const NOTES_AGENT = '# notes\n\nedited by an agent while the daemon was down\n';
const AGENT_NEW = 'created by an agent while the daemon was down\n';
const AGENT_APPEND = 'agent append while git was stopped\n';
const SEED = { 'note.md': BASE, 'notes.md': NOTES_BASE, 'other.md': 'other base\n' };
const USER_FILES = new Set(['note.md', 'notes.md', 'other.md', 'agent-new.md', 'remote-ff.md']);
const userPaths = (p: string): boolean => USER_FILES.has(p);

async function expectCleanGitState(c: Clone): Promise<void> {
  const gitDir = join(c.dir, '.git');
  const leftovers = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
    .filter((n) => existsSync(join(gitDir, n)));
  expect({ dir: c.dir, leftovers }).toEqual({ dir: c.dir, leftovers: [] });
  const unmerged = await c.git(['ls-files', '-u', '-z']);
  expect({ dir: c.dir, unmerged: unmerged.stdout }).toEqual({ dir: c.dir, unmerged: '' });
  expect({ dir: c.dir, stashes: await c.stashList() }).toEqual({ dir: c.dir, stashes: [] });
}

// Where a written content survives: worktree files and remote paths whose content matches.
async function whereIs(c: Clone, r: Remote, matches: (content: string) => boolean): Promise<string[]> {
  const hits: string[] = [];
  for (const p of await c.files()) {
    const s = await c.read(p);
    if (s !== undefined && matches(s)) hits.push(`worktree:${p}`);
  }
  for (const p of await r.tree()) {
    const s = await r.show(p);
    if (s !== undefined && matches(s)) hits.push(`remote:${p}`);
  }
  return hits;
}

async function expectNothingLost(c: Clone, r: Remote): Promise<void> {
  const exact = [LOCAL, REMOTE, OTHER_DIRTY, NOTES_AGENT, AGENT_NEW];
  for (const want of exact) {
    const hits = await whereIs(c, r, (s) => s === want);
    expect({ content: want, hits: hits.length > 0 ? 'found' : 'lost' }).toEqual({ content: want, hits: 'found' });
  }
  const appended = await whereIs(c, r, (s) => s.includes(AGENT_APPEND));
  expect({ content: AGENT_APPEND, hits: appended.length > 0 ? 'found' : 'lost' })
    .toEqual({ content: AGENT_APPEND, hits: 'found' });
}

// A stopped `git rebase --autostash` (the daemon died in it), then agents keep writing while git is stopped:
// an untracked file, a tracked edit, and an append to the conflicted file (markers included).
async function stoppedRebaseWithAgentEdits(t: TestEnv, c: Clone, r: Remote): Promise<void> {
  await makeStoppedRebase(t, c, r, { path: 'note.md', local: LOCAL, remote: REMOTE, dirty: { 'other.md': OTHER_DIRTY } });
  // The agent's writes come well after git stopped (P2 compares against stopped-sha's mtime, probe e9).
  const stoppedSha = join(c.dir, '.git', 'rebase-merge', 'stopped-sha');
  if (existsSync(stoppedSha)) backdate(stoppedSha, 10_000);
  await c.write('agent-new.md', AGENT_NEW);
  await c.write('notes.md', NOTES_AGENT);
  const conflicted = (await c.read('note.md')) ?? '';
  expect(conflicted).toContain('<<<<<<<');
  await c.write('note.md', conflicted + AGENT_APPEND);
}

describe('05 mid-rebase recovery', () => {
  test('(a) a stopped rebase plus agent edits: abort, replay, keep every edit', async () => {
    const t = await setupTestEnv('05-recovery-a');
    const remote = await createRemote(t, { files: SEED });
    const ca = await cloneRemote(t, remote, 'a');
    await stoppedRebaseWithAgentEdits(t, ca, remote);

    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, config: QUIET });
    const recovered = await A.waitForLog(on('recovered', { action: 'rebase-aborted' }));
    const startup = await A.waitForSync({ reason: 'startup' });
    expect(startup.outcome).toBe('conflict-resolved');
    expect(A.logs.indexOf(recovered)).toBeLessThan(A.logs.indexOf(startup));

    await expectCleanGitState(ca);
    expect(await remote.show('note.md')).toBe(REMOTE);
    const remoteCopies = (await remote.tree()).filter((p) => CONFLICT_COPY_RE.test(p));
    expect(remoteCopies.length).toBe(1);
    expect(await remote.show(remoteCopies[0] ?? '')).toBe(LOCAL);
    expect(await ca.read('note.md')).toBe(REMOTE);

    // The agent's append survives in an uncommitted conflict copy.
    const pending = await ca.porcelain();
    const appendCopies: string[] = [];
    for (const p of await ca.conflictCopies()) {
      if (((await ca.read(p)) ?? '').includes(AGENT_APPEND)) appendCopies.push(p);
    }
    expect(appendCopies.length).toBe(1);
    expect(pending).toContain(`?? ${appendCopies[0]}`);
    expect(await remote.show(appendCopies[0] ?? '')).toBeUndefined();

    expect(await ca.read('other.md')).toBe(OTHER_DIRTY);
    expect(await ca.read('notes.md')).toBe(NOTES_AGENT);
    expect(await ca.read('agent-new.md')).toBe(AGENT_NEW);
    await expectNothingLost(ca, remote);

    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await ca.porcelain()).toEqual([]);
    expect(await ca.head()).toBe(await remote.head());
    await expectNothingLost(ca, remote);

    await expectNoMdsyncArtifacts(t, [ca], remote, userPaths);
  }, TIMEOUT_MS);

  test('(b) an autostash conflict left with no daemon running is resumed at start', async () => {
    const t = await setupTestEnv('05-recovery-b');
    const remote = await createRemote(t, { files: SEED });
    const ca = await cloneRemote(t, remote, 'a');
    await makeAutostashConflict(t, ca, remote, { path: 'note.md', local: LOCAL, remote: REMOTE });

    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, config: QUIET });
    const recovered = await A.waitForLog(on('recovered', { action: 'stash-conflict-resumed' }));
    const startup = await A.waitForSync({ reason: 'startup' });
    expect(startup.outcome).toBe('conflict-resolved');
    expect(A.logs.indexOf(recovered)).toBeLessThan(A.logs.indexOf(startup));

    await expectCleanGitState(ca);
    expect(await remote.show('note.md')).toBe(REMOTE);
    expect(await ca.read('note.md')).toBe(REMOTE);
    // The STASH CONFLICT copy is committed and pushed.
    const remoteCopies = (await remote.tree()).filter((p) => CONFLICT_COPY_RE.test(p));
    expect(remoteCopies.length).toBe(1);
    expect(await remote.show(remoteCopies[0] ?? '')).toBe(LOCAL);
    expect(await ca.read(remoteCopies[0] ?? '')).toBe(LOCAL);

    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await ca.porcelain()).toEqual([]);
    expect(await ca.head()).toBe(await remote.head());

    await expectNoMdsyncArtifacts(t, [ca], remote, userPaths);
  }, TIMEOUT_MS);

  // Each kill point gets a fresh scenario; the stopped rebase guarantees all three log points occur, in this order.
  const KILL_POINTS = [
    { name: 'recovered', pred: on('recovered') },
    { name: 'rebasing', pred: on('rebasing') },
    { name: 'committed {source:conflict}', pred: on('committed', { source: 'conflict' }) },
  ] as const;

  for (const [i, kill] of KILL_POINTS.entries()) {
    test(`(c) SIGKILL right after \`${kill.name}\`, then restart: invariants hold, nothing lost`, async () => {
      const t = await setupTestEnv(`05-recovery-c${i}`);
      const remote = await createRemote(t, { files: SEED });
      const ca = await cloneRemote(t, remote, 'a');
      await stoppedRebaseWithAgentEdits(t, ca, remote);

      const first = await startDaemon(t, { name: 'A', dir: ca.dir, remote, config: QUIET, wait: 'none' });
      await first.waitForLog(kill.pred, { timeoutMs: 60_000 });
      first.signal('SIGKILL');
      await first.exited;
      // Detached git children outlive the daemon; let them finish before the restart inspects the repo.
      await waitNoLiveGit(ca.dir, { timeoutMs: 60_000 });

      const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, config: QUIET });
      const startup = await A.waitForSync({ reason: 'startup' });
      expect(['ok', 'conflict-resolved']).toContain(startup.outcome as string);

      await expectCleanGitState(ca);
      expect(await remote.show('note.md')).toBe(REMOTE);
      expect(await ca.read('note.md')).toBe(REMOTE);
      await expectNothingLost(ca, remote);

      expect((await A.flush(['--wait'])).code).toBe(0);
      expect(await ca.porcelain()).toEqual([]);
      expect(await ca.head()).toBe(await remote.head());
      await expectCleanGitState(ca);
      await expectNothingLost(ca, remote);

      await expectNoMdsyncArtifacts(t, [ca], remote, userPaths);
    }, TIMEOUT_MS);
  }

  test('(d) a refused autostash apply (stash only, no unmerged entries) is replayed at start', async () => {
    const t = await setupTestEnv('05-recovery-d');
    const remote = await createRemote(t, { files: SEED });
    const ca = await cloneRemote(t, remote, 'a');
    const dirty = '# notes\n\ndirty edit that only the autostash holds\n';
    await makeLeftoverAutostash(t, ca, remote, { dirty: { 'notes.md': dirty } });
    expect(await ca.read('notes.md')).toBe(NOTES_BASE);

    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote, config: QUIET });
    await A.waitForLog(on('recovered', { action: 'stash-conflict-resumed' }));
    await A.waitForSync({ reason: 'startup' });

    expect(await ca.read('notes.md')).toBe(dirty);
    expect(await ca.porcelain()).toEqual([' M notes.md']);
    expect(await ca.stashList()).toEqual([]);
    await expectCleanGitState(ca);
    // Uncommitted: the pull-only startup run committed nothing of it.
    expect(await remote.show('notes.md')).toBe(NOTES_BASE);
    expect((await remote.log()).filter((c) => c.authorName === 'mdsync-A')).toEqual([]);

    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await remote.show('notes.md')).toBe(dirty);
    expect(await ca.porcelain()).toEqual([]);

    await expectNoMdsyncArtifacts(t, [ca], remote, userPaths);
  }, TIMEOUT_MS);
});
