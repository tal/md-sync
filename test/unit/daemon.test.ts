// guard(): callbacks never crash the daemon. The lifecycle itself is covered end to end
// by test/acceptance.
import { describe, expect, test } from 'bun:test';
import { freshState, recordRun, runBookkeeping } from '../../src/commands/shared';
import { guard, settleTimerDue } from '../../src/daemon';
import { createLogger } from '../../src/log';
import { SETTLE_GRACE_MS } from '../../src/move';
import type { RunResult, StuckRecord } from '../../src/types';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ level: 'debug', sink: 'stderr', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  return { log, lines };
}

test('a sync throw is logged as `callback failed` and does not escape', () => {
  const { log, lines } = capture();
  expect(() => guard(log, 'test.sync', () => { throw new Error('boom\nsecond line'); })).not.toThrow();
  expect(lines).toEqual([expect.objectContaining({ level: 'error', msg: 'callback failed', source: 'test.sync',
    error: 'boom second line' })]);
});

test('a rejection is logged too', async () => {
  const { log, lines } = capture();
  guard(log, 'test.async', async () => { await Bun.sleep(1); throw new TypeError('late'); });
  await Bun.sleep(20);
  expect(lines).toEqual([expect.objectContaining({ msg: 'callback failed', source: 'test.async', error: 'TypeError: late' })]);
});

test('a callback that succeeds logs nothing', async () => {
  const { log, lines } = capture();
  let ran = 0;
  guard(log, 'test.ok', () => { ran++; });
  guard(log, 'test.ok-async', async () => { ran++; });
  await Bun.sleep(5);
  expect({ ran, lines }).toEqual({ ran: 2, lines: [] });
});

// chaos seed 105: a settle entry that failed every run kept the settle timer overdue, and the daemon ran ~2 failed runs
// a second. After a failed run the timer waits at least one grace; after an ok run it fires when the entry is due.
test('settleTimerDue: an overdue settle time is not re-armed at once after a failed run', () => {
  const now = 1_000_000;
  expect(settleTimerDue(now - 60_000, 'ok', now)).toBe(now - 60_000);
  expect(settleTimerDue(now + 2_000, 'ok', now)).toBe(now + 2_000);
  expect(settleTimerDue(now - 60_000, 'failed', now)).toBe(now + SETTLE_GRACE_MS);
  expect(settleTimerDue(now + 60_000, 'failed', now)).toBe(now + 60_000);
});

// review round 5 (d28-semantics-1): the settle timer's run ('settle' only: preflight, no fetch, no push) counted as a
// sync. Five seconds after a failed run that had replaced a file it replaced `last error` with ok, cleared the stuck
// record and (in the daemon) cancelled the backoff retry, so an unpushed commit waited for an unrelated trigger.
describe('settle-only runs and the run record', () => {
  const run = (o: Partial<RunResult>): RunResult => ({ runId: 1, kind: 'pull-only', mode: 'normal', reasons: ['ntfy'], outcome: 'ok',
    commitStep: 'not-applicable', commitsIn: 0, commitsOut: 0, head: 'a'.repeat(40), committed: 'none', conflicts: [],
    overriddenDeletes: [], keptStashes: [], startedAt: new Date(0).toISOString(), durationMs: 1, ...o });
  const stuck: StuckRecord = { head: 'a'.repeat(40), remote: 'b'.repeat(40), outcome: 'failed', error: 'EACCES', since: 'then' };

  test('runBookkeeping: only a pull whose reasons are all `settle`', () => {
    expect(runBookkeeping({ kind: 'pull-only', reasons: ['settle'] })).toBe('settle-only');
    expect(runBookkeeping({ kind: 'pull-only', reasons: ['settle', 'settle'] })).toBe('settle-only');
    expect(runBookkeeping({ kind: 'pull-only', reasons: ['settle', 'retry'] })).toBe('sync');
    expect(runBookkeeping({ kind: 'pull-only', reasons: ['ntfy'] })).toBe('sync');
    expect(runBookkeeping({ kind: 'pull-only', reasons: [] })).toBe('sync');
  });

  test('an ok settle-only run leaves the last sync, its failure count and its stuck record as they were', async () => {
    const failed = await recordRun({ state: freshState('/x'), res: run({ outcome: 'failed', error: 'worktree move failed',
      s5: { head: stuck.head, remote: stuck.remote } }), stuck: 'none', git: 'none' });
    expect(failed.state.lastRun?.outcome).toBe('failed');
    const settle = await recordRun({ state: failed.state, res: run({ reasons: ['settle'], keptStashes: ['c'.repeat(40)] }),
      stuck: failed.stuck, git: 'none', bookkeeping: 'settle-only' });
    expect(settle.state.lastRun).toEqual(failed.state.lastRun);
    expect(settle.state.consecutiveFailures).toBe(1);
    expect(settle.state.lastOkAt).toBeUndefined();
    expect(settle.stuck).toEqual(failed.stuck);
    expect(settle.state.stuck).toEqual(failed.state.stuck);
    expect(failed.state.stuck?.error).toBe('worktree move failed');
    expect(settle.state.keptStashes.map((k) => k.sha)).toEqual(['c'.repeat(40)]);   // a stash its P4 kept is still recorded
    // counted as a sync (the old behavior), the same run wiped all of it
    const counted = await recordRun({ state: failed.state, res: run({ reasons: ['settle'] }), stuck: failed.stuck, git: 'none' });
    expect([counted.state.lastRun?.outcome, counted.state.consecutiveFailures, counted.stuck]).toEqual(['ok', 0, 'none']);
  });

  test('a failed settle-only run is recorded (its preflight failed), but never touches the stuck record', async () => {
    const settle = await recordRun({ state: { ...freshState('/x'), stuck }, res: run({ reasons: ['settle'], outcome: 'busy',
      error: 'repository busy (move)' }), stuck, git: 'none', bookkeeping: 'settle-only' });
    expect(settle.state.lastRun?.outcome).toBe('busy');
    expect(settle.state.consecutiveFailures).toBe(1);
    expect(settle.stuck).toEqual(stuck);
  });
});
