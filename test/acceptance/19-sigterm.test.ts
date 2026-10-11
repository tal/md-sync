// Acceptance 19: SIGTERM with pending changes commits and pushes them before exiting.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { statePathsFor } from '../../src/paths';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, slowReceivePack, startDaemon,
  type LogLine, type TestEnv,
} from '../harness';

afterEach(cleanupAll);

const reasonsOf = (l: LogLine): unknown[] => (Array.isArray(l.reasons) ? l.reasons : []);

function indexAfter(lines: LogLine[], from: number, pred: (l: LogLine) => boolean): number {
  for (let i = Math.max(0, from); i < lines.length; i++) {
    const l = lines[i];
    if (l !== undefined && pred(l)) return i;
  }
  return -1;
}

function expectNoLockOrSocket(t: TestEnv, dir: string): void {
  const p = statePathsFor(dir, t.env);
  expect({ lock: existsSync(p.lock), sock: existsSync(p.sock) }).toEqual({ lock: false, sock: false });
}

test('(a) pending changes are committed (auto) and pushed before a clean exit', async () => {
  const t = await setupTestEnv('sigterm');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 60_000 } });

  const m = A.mark();
  await a.write('p.md', 'pending at shutdown\n');
  await A.waitForLog(is('local change'), { since: m });
  expect(await A.stop()).toBe(0);

  const seq = A.logs.slice(m);
  const iRequested = indexAfter(seq, 0, is('shutdown requested', { signal: 'SIGTERM' }));
  const iCommitted = indexAfter(seq, iRequested, is('committed', { source: 'shutdown' }));
  const iPushed = indexAfter(seq, iCommitted, is('pushed'));
  const iComplete = indexAfter(seq, iPushed, is('shutdown complete', { exitCode: 0 }));
  expect(iRequested).toBeGreaterThanOrEqual(0);
  expect(iCommitted).toBeGreaterThan(iRequested);
  expect(iPushed).toBeGreaterThan(iCommitted);
  expect(iComplete).toBeGreaterThan(iPushed);
  expect(String(seq[iCommitted]?.subject)).toMatch(/ \(auto\)$/);
  expect(seq.find((l) => l.msg === 'sync done' && reasonsOf(l).includes('shutdown'))).toMatchObject({ mode: 'shutdown', outcome: 'ok' });

  const log = await r.log();
  expect(log[0]).toMatchObject({ authorName: 'mdsync-A', files: ['p.md'] });
  expect(log[0]?.subject).toMatch(/^sync \S+ \S+Z \(auto\)$/);
  expect(await r.show('p.md')).toBe('pending at shutdown\n');
  expectNoLockOrSocket(t, a.dir);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'p.md'].includes(p));
}, 90_000);

test('(b) a terminal Ctrl-C (SIGINT to the group) during a push lets the push finish and exits 0', async () => {
  const t = await setupTestEnv('sigint-mid-push');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const slow = await slowReceivePack(t);
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: slow.env });

  await a.write('q.md', 'in flight\n');
  const f = await A.flush();
  expect(f.code).toBe(0);
  await slow.started();
  const m = A.mark();
  A.signalGroup('SIGINT');
  await A.waitForLog(is('shutdown requested', { signal: 'SIGINT' }), { since: m });
  await slow.release();
  expect(await A.exited).toBe(0);

  // The push in flight at the signal is the one that lands: its run ends ok, and nothing is pushed again by a
  // shutdown-mode run (a SIGINT that reached git would fail it, and the shutdown run would quietly re-push).
  const after = A.logs.slice(m);
  expect(after.filter(is('pushed')).length).toBe(1);
  const done = after.filter((l) => l.msg === 'sync done');
  expect(done.filter((l) => l.outcome !== 'ok')).toEqual([]);
  const inFlight = done.find((l) => reasonsOf(l).includes('flush'));
  expect(inFlight).toMatchObject({ mode: 'normal', outcome: 'ok', commitsOut: 1 });
  expect(done.filter((l) => l.mode === 'shutdown').every((l) => l.commitsOut === 0)).toBe(true);
  expect(after.some(is('forced exit'))).toBe(false);
  expect(after.some(is('shutdown complete', { exitCode: 0 }))).toBe(true);
  expect(await r.show('q.md')).toBe('in flight\n');
  expect(await r.head()).toBe(await a.head());
  expectNoLockOrSocket(t, a.dir);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'q.md'].includes(p));
}, 90_000);

test('(c) a flush --wait sent after SIGTERM, while a push is in flight, merges into the next run and exits 0', async () => {
  const t = await setupTestEnv('sigterm-late-flush');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const slow = await slowReceivePack(t);
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, env: slow.env });

  await a.write('x.md', 'first\n');
  expect((await A.flush()).code).toBe(0);
  await slow.started();
  const m = A.mark();
  A.signal('SIGTERM');
  await A.waitForLog(is('shutdown requested', { signal: 'SIGTERM' }), { since: m });

  await a.write('y.md', 'after the signal\n');
  const late = A.flush(['--wait', '-m', 'after term']);
  await A.waitForLog(is('flush received', { message: 'given', wait: 'wait' }), { since: m });
  await slow.release();
  const res = await late;
  expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: res.stderr });
  expect(await A.exited).toBe(0);

  const merged = A.logs.slice(m).find((l) => l.msg === 'sync done' && l.mode === 'shutdown' && reasonsOf(l).includes('flush'));
  expect(merged).toMatchObject({ kind: 'commit', outcome: 'ok', commitStep: 'committed', commitsOut: 1 });
  const log = await r.log();
  expect(log[0]).toMatchObject({ subject: 'after term', authorName: 'mdsync-A', files: ['y.md'] });
  expect(log[1]?.files).toEqual(['x.md']);
  expect(await r.head()).toBe(await a.head());
  expectNoLockOrSocket(t, a.dir);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'x.md', 'y.md'].includes(p));
}, 90_000);

test('(d) a clean tree with an unpushed commit (from a flush during an outage): SIGTERM pushes it before exiting', async () => {
  // r3 mutation lens: running the shutdown run only for a dirty tree passed every test (dirty or ahead).
  const t = await setupTestEnv('sigterm-ahead');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  await r.setUnreachable();
  await a.write('p.md', 'committed while offline\n');
  expect((await A.flush(['--wait'])).code).toBe(1);
  expect(await a.porcelain()).toEqual([]);
  await r.restore();
  const m = A.mark();
  expect(await A.stop()).toBe(0);
  const run = A.logs.slice(m).find((l) => l.msg === 'sync start' && l.mode === 'shutdown');
  expect(run).toBeDefined();
  expect(A.logs.slice(m).some(is('pushed'))).toBe(true);
  expect(await r.show('p.md')).toBe('committed while offline\n');
}, 120_000);
