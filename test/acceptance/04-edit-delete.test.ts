// Acceptance 4: an edit on one side and a delete on the other keeps the edited file,
// and the delete is logged as overridden.
import { afterEach, describe, expect, test } from 'bun:test';
import type { LogMsg } from '../../src/log';
import {
  cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier, setupTestEnv, startDaemon,
  type Clone, type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

const ORIGINAL = '# x\n\noriginal\n';
const userPaths = (p: string): boolean => p === 'README.md' || p === 'x.md';

async function expectEverywhere(clones: Clone[], show: (rel: string) => Promise<string | undefined>, want: string): Promise<void> {
  expect(await show('x.md')).toBe(want);
  for (const c of clones) expect({ dir: c.dir, x: await c.read('x.md') }).toEqual({ dir: c.dir, x: want });
}

describe('04 edit vs delete', () => {
  test('(a) A edits and pushes first, B deletes and flushes: the edit wins, deletedBy local', async () => {
    const t = await setupTestEnv('04-edit-delete-a');
    const remote = await createRemote(t, { files: { 'README.md': '# notes\n', 'x.md': ORIGINAL } });
    const ca = await cloneRemote(t, remote, 'a');
    const cb = await cloneRemote(t, remote, 'b');
    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote });
    const aEdit = '# x\n\nedited by A\n';

    await ca.write('x.md', aEdit);
    expect((await A.flush(['--wait'])).code).toBe(0);

    await cb.remove('x.md');
    const mB = B.mark();
    expect((await B.flush(['--wait'])).code).toBe(0);
    await B.waitForLog(on('delete overridden', { path: 'x.md', deletedBy: 'local' }), { since: mB });
    await B.waitForSync({ since: mB, reason: 'flush', outcome: 'conflict-resolved' });

    expect((await A.flush(['--wait'])).code).toBe(0);
    await expectEverywhere([ca, cb], (rel) => remote.show(rel), aEdit);
    expect(await cb.porcelain()).toEqual([]);
    expect(await cb.head()).toBe(await remote.head());

    await expectNoMdsyncArtifacts(t, [ca, cb], remote, userPaths);
  }, 120_000);

  test('(b) B deletes and pushes first, A edits and flushes: the edit wins, deletedBy remote', async () => {
    const t = await setupTestEnv('04-edit-delete-b');
    const remote = await createRemote(t, { files: { 'README.md': '# notes\n', 'x.md': ORIGINAL } });
    const ca = await cloneRemote(t, remote, 'a');
    const cb = await cloneRemote(t, remote, 'b');
    const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote });
    const aEdit = '# x\n\nedited by A after B deleted it\n';

    await cb.remove('x.md');
    expect((await B.flush(['--wait'])).code).toBe(0);
    expect(await remote.show('x.md')).toBeUndefined();

    await ca.write('x.md', aEdit);
    const mA = A.mark();
    expect((await A.flush(['--wait'])).code).toBe(0);
    await A.waitForLog(on('delete overridden', { path: 'x.md', deletedBy: 'remote' }), { since: mA });
    await A.waitForSync({ since: mA, reason: 'flush', outcome: 'conflict-resolved' });

    expect((await B.flush(['--wait'])).code).toBe(0);
    await expectEverywhere([ca, cb], (rel) => remote.show(rel), aEdit);
    expect(await ca.head()).toBe(await remote.head());
    expect(await cb.head()).toBe(await remote.head());

    await expectNoMdsyncArtifacts(t, [ca, cb], remote, userPaths);
  }, 120_000);

  test('(c) an uncommitted delete in B vs a remote edit, via a pull-only run: the file comes back edited', async () => {
    const t = await setupTestEnv('04-edit-delete-c');
    const remote = await createRemote(t, { files: { 'README.md': '# notes\n', 'x.md': ORIGINAL } });
    const ntfy = await fakeNtfy();
    remoteNotifier(remote, ntfy);
    const cb = await cloneRemote(t, remote, 'b');
    const B = await startDaemon(t, { name: 'B', dir: cb.dir, remote, ntfy });
    const remoteEdit = '# x\n\nedited on another device\n';

    await cb.remove('x.md');   // stays uncommitted: idleMs 60 s, no flush
    const mB = B.mark();
    const pushed = await remote.push({ 'x.md': remoteEdit }, 'edit x.md elsewhere');

    const event = await B.waitForLog(on('ntfy event'), { since: mB });
    expect(event.sha).toBe(pushed);
    await B.waitForLog(on('delete overridden', { path: 'x.md', deletedBy: 'local' }), { since: mB });
    await B.waitForSync({ since: mB, reason: 'ntfy', outcome: 'conflict-resolved' });

    expect(await cb.read('x.md')).toBe(remoteEdit);
    expect(await remote.show('x.md')).toBe(remoteEdit);
    expect(await cb.stashList()).toEqual([]);
    expect(await cb.porcelain()).toEqual([]);
    expect(await cb.head()).toBe(pushed);

    await expectNoMdsyncArtifacts(t, [cb], remote, userPaths);
  }, 120_000);
});
