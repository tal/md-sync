// Acceptance 3: overlapping concurrent edits keep the first-pushed version at the path
// plus exactly one conflict copy; non-overlapping edits merge; an uncommitted edit hit by a pull is a STASH CONFLICT.
import { afterEach, describe, expect, test } from 'bun:test';
import type { LogMsg } from '../../src/log';
import {
  CONFLICT_COPY_RE, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier,
  setupTestEnv, startDaemon, type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

const FIVE = 'line 1\nline 2\nline 3\nline 4\nline 5\n';
const edit = (line: number, who: string): string => FIVE.replace(`line ${line}\n`, `line ${line} edited by ${who}\n`);
const notePaths = (p: string): boolean => p === 'note.md';

describe('03 conflict copy', () => {
  test('overlapping edits: first-pushed version at the path, the other side in one conflict copy', async () => {
    const t = await setupTestEnv('03-conflict-copy');
    const remote = await createRemote(t, { files: { 'note.md': FIVE } });
    const ca = await cloneRemote(t, remote, 'a');
    const cb = await cloneRemote(t, remote, 'b');
    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote });
    const aVersion = edit(3, 'A');
    const bVersion = edit(3, 'B');

    await ca.write('note.md', aVersion);
    expect((await A.flush(['--wait'])).code).toBe(0);

    await cb.write('note.md', bVersion);
    const mB = B.mark();
    expect((await B.flush(['--wait'])).code).toBe(0);
    const conflict = await B.waitForLog(on('conflict', { kind: 'rebase' }), { since: mB });
    const copies = conflict.copies as string[];
    expect(copies.length).toBe(1);
    await B.waitForSync({ since: mB, reason: 'flush', outcome: 'conflict-resolved' });

    expect((await A.flush(['--wait'])).code).toBe(0);

    const remoteCopies = (await remote.tree()).filter((p) => CONFLICT_COPY_RE.test(p));
    expect(remoteCopies).toEqual(copies);
    const [copy = ''] = copies;
    expect(await remote.show('note.md')).toBe(aVersion);
    expect(await remote.show(copy)).toBe(bVersion);
    for (const c of [ca, cb]) {
      expect({ dir: c.dir, note: await c.read('note.md') }).toEqual({ dir: c.dir, note: aVersion });
      expect({ dir: c.dir, copies: await c.conflictCopies() }).toEqual({ dir: c.dir, copies });
      expect({ dir: c.dir, copy: await c.read(copy) }).toEqual({ dir: c.dir, copy: bVersion });
      expect({ dir: c.dir, pending: await c.porcelain() }).toEqual({ dir: c.dir, pending: [] });
    }
    expect(await ca.head()).toBe(await remote.head());
    expect(await cb.head()).toBe(await remote.head());

    await expectNoMdsyncArtifacts(t, [ca, cb], remote, notePaths);
  }, 120_000);

  test('edits on lines 1 and 5 merge cleanly: no copy, no conflict log', async () => {
    const t = await setupTestEnv('03-conflict-merge');
    const remote = await createRemote(t, { files: { 'note.md': FIVE } });
    const ca = await cloneRemote(t, remote, 'a');
    const cb = await cloneRemote(t, remote, 'b');
    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote });
    const merged = FIVE.replace('line 1\n', 'line 1 edited by A\n').replace('line 5\n', 'line 5 edited by B\n');

    await ca.write('note.md', edit(1, 'A'));
    expect((await A.flush(['--wait'])).code).toBe(0);

    await cb.write('note.md', edit(5, 'B'));
    const mB = B.mark();
    expect((await B.flush(['--wait'])).code).toBe(0);
    await B.waitForSync({ since: mB, reason: 'flush', outcome: 'ok' });
    expect(B.logs.slice(mB).filter(on('conflict'))).toEqual([]);

    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await remote.show('note.md')).toBe(merged);
    expect((await remote.tree()).filter((p) => CONFLICT_COPY_RE.test(p))).toEqual([]);
    for (const c of [ca, cb]) {
      expect({ dir: c.dir, note: await c.read('note.md') }).toEqual({ dir: c.dir, note: merged });
      expect({ dir: c.dir, copies: await c.conflictCopies() }).toEqual({ dir: c.dir, copies: [] });
    }

    await expectNoMdsyncArtifacts(t, [ca, cb], remote, notePaths);
  }, 120_000);

  test('stash conflict: an uncommitted edit hit by a pull-only run becomes a committed conflict copy', async () => {
    const t = await setupTestEnv('03-conflict-stash');
    const remote = await createRemote(t, { files: { 'note.md': FIVE } });
    const ntfy = await fakeNtfy();
    remoteNotifier(remote, ntfy);
    const ca = await cloneRemote(t, remote, 'a');
    const cb = await cloneRemote(t, remote, 'b');
    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote, ntfy });
    const aVersion = edit(3, 'A');
    const bVersion = edit(3, 'B');

    // B's edit stays uncommitted (idleMs 60 s, no flush) when A's push arrives.
    await cb.write('note.md', bVersion);
    const mB = B.mark();
    await ca.write('note.md', aVersion);
    expect((await A.flush(['--wait'])).code).toBe(0);

    await B.waitForLog(on('ntfy event'), { since: mB });
    const conflict = await B.waitForLog(on('conflict', { kind: 'stash' }), { since: mB });
    const copies = conflict.copies as string[];
    expect(copies.length).toBe(1);
    const done = await B.waitForSync({ since: mB, reason: 'ntfy', outcome: 'conflict-resolved' });
    const [copy = ''] = copies;

    expect(await cb.read('note.md')).toBe(aVersion);
    expect(await cb.read(copy)).toBe(bVersion);
    expect(await cb.stashList()).toEqual([]);
    // The copy is committed and pushed even by a pull-only run; nothing else of B's is.
    expect(await remote.show(copy)).toBe(bVersion);
    expect(await remote.show('note.md')).toBe(aVersion);
    expect(await remote.head()).toBe(done.head as string);
    expect(await cb.porcelain()).toEqual([]);

    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await ca.read(copy)).toBe(bVersion);
    expect(await ca.read('note.md')).toBe(aVersion);

    await expectNoMdsyncArtifacts(t, [ca, cb], remote, notePaths);
  }, 120_000);

  test('stash conflict in a pull-only run: only the copy is committed, the other unflushed edits stay uncommitted (D1)', async () => {
    // r3 mutation lens: committing every replayed write (not just the copies) passed every test, because every
    // stash-conflict scenario had only the conflicted file dirty.
    const t = await setupTestEnv('03-stash-other');
    const remote = await createRemote(t, { files: { 'note.md': FIVE, 'other.md': 'other\n' } });
    const ntfy = await fakeNtfy();
    remoteNotifier(remote, ntfy);
    const ca = await cloneRemote(t, remote, 'a');
    const cb = await cloneRemote(t, remote, 'b');
    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote, ntfy });
    await cb.write('note.md', edit(3, 'B'));
    await cb.write('other.md', 'other, unflushed edit by B\n');
    const mB = B.mark();
    await ca.write('note.md', edit(3, 'A'));
    expect((await A.flush(['--wait'])).code).toBe(0);
    await B.waitForLog(on('conflict', { kind: 'stash' }), { since: mB });
    await B.waitForSync({ since: mB, reason: 'ntfy', outcome: 'conflict-resolved' });
    expect((await remote.tree()).filter((p) => CONFLICT_COPY_RE.test(p))).toHaveLength(1);
    expect(await remote.show('other.md')).toBe('other\n');
    expect(await cb.read('other.md')).toBe('other, unflushed edit by B\n');
    expect(await cb.porcelain()).toEqual([' M other.md']);
  }, 120_000);

  test('binary conflict: the first-pushed bytes stay at the path, the other side goes to exactly one copy', async () => {
    // r3 mutation lens: "local wins, remote bytes dropped" passed every test and the data guard.
    const t = await setupTestEnv('03-binary');
    const remote = await createRemote(t, { files: { 'README.md': '# n\n', 'img.bin': '\u0000base\u0000' } });
    const ca = await cloneRemote(t, remote, 'a');
    const cb = await cloneRemote(t, remote, 'b');
    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote });
    const aBytes = '\u0000edited by A\u0000';
    const bBytes = '\u0000edited by B\u0000';
    await ca.write('img.bin', aBytes);
    expect((await A.flush(['--wait'])).code).toBe(0);
    await cb.write('img.bin', bBytes);
    expect((await B.flush(['--wait'])).code).toBe(0);
    expect(await remote.show('img.bin')).toBe(aBytes);
    const copies = (await remote.tree()).filter((p) => CONFLICT_COPY_RE.test(p));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/^img \(conflict .+\)\.bin$/);
    expect(await remote.show(copies[0] ?? '')).toBe(bBytes);
  }, 120_000);
});
