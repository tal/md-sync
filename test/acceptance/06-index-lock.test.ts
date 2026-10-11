// Acceptance 6: a stale index.lock is cleaned up; a lock held by a live git
// process, or a fresh one, is left alone.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogMsg } from '../../src/log';
import {
  backdate, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, holdLiveGit, setupTestEnv, startDaemon,
  type LogLine,
} from '../harness';

afterEach(cleanupAll);

const on = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => l[k] === v);

const STALE_AGE_MS = 120_000;   // well past STALE_GIT_LOCK_MS (60 s)

async function setup(name: string) {
  const t = await setupTestEnv(name);
  const remote = await createRemote(t);
  const ca = await cloneRemote(t, remote, 'a');
  const A = await startDaemon(t, { name: 'A', dir: ca.dir, remote });
  return { t, remote, ca, A };
}

describe('06 git locks', () => {
  test('(a) a stale index.lock is removed and the commit is pushed', async () => {
    const { t, remote, ca, A } = await setup('06-index-lock-a');
    const lock = join(ca.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    backdate(lock, STALE_AGE_MS);
    await ca.write('a.md', 'after a stale lock\n');

    const m = A.mark();
    expect((await A.flush(['--wait'])).code).toBe(0);
    await A.waitForLog(on('recovered', { action: 'stale-index-lock-removed' }), { since: m });
    expect(existsSync(lock)).toBe(false);
    expect(await remote.show('a.md')).toBe('after a stale lock\n');
    expect(await ca.head()).toBe(await remote.head());

    await expectNoMdsyncArtifacts(t, [ca], remote, (p) => p === 'README.md' || p === 'a.md');
  }, 120_000);

  test('(b) a lock held by a live git is left alone; deferred flushes keep their message and paths', async () => {
    const { t, remote, ca, A } = await setup('06-index-lock-b');
    const holder = await holdLiveGit(ca.dir);
    const lock = join(ca.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    backdate(lock, STALE_AGE_MS);
    await ca.write('a.md', 'flushed by path\n');
    await ca.write('b.md', 'never named by a flush\n');

    let m = A.mark();
    const first = await A.flush(['--wait', 'a.md']);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain('busy');
    const held = await A.waitForLog(on('git lock held'), { since: m });
    expect(held.pids as number[]).toContain(holder.pid);
    expect(held.detection).toBe('scanned');
    await A.waitForSync({ since: m, outcome: 'busy' });
    expect(existsSync(lock)).toBe(true);

    // Still held: a no-wait flush is queued (exit 0), its run is busy, and its trigger is carried, not dropped.
    m = A.mark();
    const second = await A.flush(['-m', 'held', 'a.md']);
    expect(second.code).toBe(0);
    await A.waitForSync({ since: m, outcome: 'busy' });
    await A.waitForLog(on('flush deferred', { after: 'busy' }), { since: m });
    expect(existsSync(lock)).toBe(true);

    await holder.release();
    m = A.mark();
    const third = await A.flush(['--wait', 'a.md']);
    expect(third.code).toBe(0);
    await A.waitForLog(on('recovered', { action: 'stale-index-lock-removed' }), { since: m });
    await A.waitForSync({ since: m, reason: 'flush', outcome: 'ok' });
    expect(existsSync(lock)).toBe(false);

    const [newest] = await remote.log();
    expect(newest?.subject).toBe('held');
    expect(newest?.files).toEqual(['a.md']);
    expect(await ca.porcelain()).toEqual(['?? b.md']);

    await expectNoMdsyncArtifacts(t, [ca], remote, (p) => ['README.md', 'a.md', 'b.md'].includes(p));
  }, 120_000);

  test('(c) a fresh lock with no holder makes the run busy after the poll and is not removed', async () => {
    const { t, remote, ca, A } = await setup('06-index-lock-c');
    const lock = join(ca.dir, '.git', 'index.lock');
    writeFileSync(lock, '');
    await ca.write('c.md', 'behind a fresh lock\n');

    const m = A.mark();
    const r = await A.flush(['--wait']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('busy');
    const held = await A.waitForLog(on('git lock held'), { since: m });
    expect(held.pids).toEqual([]);
    expect(held.detection).toBe('scanned');
    const done = await A.waitForSync({ since: m, outcome: 'busy' });
    expect(done.durationMs as number).toBeGreaterThanOrEqual(9_000);   // FRESH_LOCK_WAIT_MS (10 s) poll
    expect(existsSync(lock)).toBe(true);
    expect(await remote.show('c.md')).toBeUndefined();

    // Once the lock is gone (its owner finished), the next flush goes through.
    rmSync(lock);
    expect((await A.flush(['--wait'])).code).toBe(0);
    expect(await remote.show('c.md')).toBe('behind a fresh lock\n');

    await expectNoMdsyncArtifacts(t, [ca], remote, (p) => p === 'README.md' || p === 'c.md');
  }, 120_000);

  test('(d) a stale ref lock is removed and the commit is pushed', async () => {
    const { t, remote, ca, A } = await setup('06-index-lock-d');
    const lock = join(ca.dir, '.git', 'refs', 'heads', 'main.lock');
    writeFileSync(lock, '');
    backdate(lock, STALE_AGE_MS);
    await ca.write('d.md', 'after a stale ref lock\n');

    const m = A.mark();
    expect((await A.flush(['--wait'])).code).toBe(0);
    await A.waitForLog(on('recovered', { action: 'stale-ref-lock-removed' }), { since: m });
    expect(existsSync(lock)).toBe(false);
    expect(await remote.show('d.md')).toBe('after a stale ref lock\n');
    expect(await ca.head()).toBe(await remote.head());

    await expectNoMdsyncArtifacts(t, [ca], remote, (p) => p === 'README.md' || p === 'd.md');
  }, 120_000);
});
