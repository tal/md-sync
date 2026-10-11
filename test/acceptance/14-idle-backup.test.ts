// Acceptance 14: with no flush, a change is committed after idleMs of quiet, with (auto) in the message.
import { afterEach, expect, test } from 'bun:test';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, startDaemon, type Daemon, type LogLine,
} from '../harness';

afterEach(cleanupAll);

const at = (l: LogLine): number => Date.parse(l.ts);
const AUTO_SUBJECT = /^sync \S+ \S+Z \(auto\)$/;
const TIMER_SLACK_MS = 50;   // log timestamps are taken a moment after the timer is (re)started

function lastBefore(d: Daemon, from: number, line: LogLine, pred: (l: LogLine) => boolean): LogLine {
  const found = d.logs.slice(from, d.logs.indexOf(line)).filter(pred).at(-1);
  if (found === undefined) throw new Error('no matching log line before the given one');
  return found;
}

test('a change with no flush is committed idleMs after the last local change, tagged (auto)', async () => {
  const t = await setupTestEnv('idle-backup');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 1500, maxWaitMs: 60_000 } });
  const seed = await r.head();
  const m = A.mark();

  await a.write('a.md', 'quiet now\n');
  const fired = await A.waitForLog(is('backup timer fired', { timer: 'idle' }), { since: m });
  const committed = await A.waitForLog(is('committed', { source: 'backup' }), { since: m });
  const done = await A.waitForSync({ since: m, reason: 'idle' });
  expect(done).toMatchObject({ kind: 'commit', outcome: 'ok', commitStep: 'committed', commitsOut: 1 });

  // Nothing ran before the timer fired, and the commit came at least idleMs after the last time the idle timer was
  // (re)started: a `local change`, or a status check that armed the timers (the startup run's post-run check can see
  // the write before the watcher reports it; with the poll backend the watcher may then never report it at all).
  const beforeFire = A.logs.slice(m, A.logs.indexOf(fired)).map((l) => l.msg);
  expect(beforeFire.filter((x) => x === 'sync start' || x === 'committed' || x === 'pushed')).toEqual([]);
  const lastChange = lastBefore(A, m, committed, (l) => is('local change')(l) || is('backup timers armed')(l));
  expect(at(committed) - at(lastChange)).toBeGreaterThanOrEqual(1500 - TIMER_SLACK_MS);

  const log = await r.log();
  expect(log).toHaveLength(2);
  expect(log[1]?.sha).toBe(seed as string);
  expect(log[0]).toMatchObject({ sha: committed.sha, authorName: 'mdsync-A', files: ['a.md'] });
  expect(log[0]?.subject).toMatch(AUTO_SUBJECT);
  expect(log[0]?.subject).toBe(String(committed.subject));
  expect(log[0]?.body).toContain('A\ta.md');
  expect(await a.porcelain()).toEqual([]);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => p === 'README.md' || p === 'a.md');
}, 90_000);

test('a write before idleMs has passed restarts the idle timer', async () => {
  const t = await setupTestEnv('idle-restart');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 3000, maxWaitMs: 60_000 } });
  const m = A.mark();

  await a.write('a.md', 'first\n');
  await A.waitForLog(is('local change'), { since: m });
  const m2 = A.mark();
  await a.write('b.md', 'second\n');   // deliberate cadence: well inside the 3 s idle window
  const second = await A.waitForLog(is('local change'), { since: m2 });
  const fired = await A.waitForLog(is('backup timer fired', { timer: 'idle' }), { since: m });
  expect(A.logs.indexOf(fired)).toBeGreaterThan(A.logs.indexOf(second));
  expect(at(fired) - at(second)).toBeGreaterThanOrEqual(3000 - TIMER_SLACK_MS);
  const done = await A.waitForSync({ since: m, reason: 'idle' });
  expect(done).toMatchObject({ outcome: 'ok', commitStep: 'committed' });

  const log = await r.log();
  expect(log).toHaveLength(2);   // one backup commit for both writes
  expect([...(log[0]?.files ?? [])].sort()).toEqual(['a.md', 'b.md']);
  expect(log[0]?.subject).toMatch(AUTO_SUBJECT);
  expect(A.logs.slice(m).filter(is('backup timer fired'))).toHaveLength(1);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'a.md', 'b.md'].includes(p));
}, 90_000);
