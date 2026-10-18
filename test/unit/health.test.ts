import { describe, expect, test } from 'bun:test';
import { ntfyText } from '../../src/commands/status';
import { computeHealth, FAILING_CONSECUTIVE_FAILURES, type HealthInput, NTFY_SILENT_MS, STALE_OK_FALLBACK_MULTIPLE } from '../../src/health';
import type { LastRun, NtfyHealth, StateFile } from '../../src/state';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

const lastRun: LastRun = {
  runId: 1, kind: 'pull-only', mode: 'normal', reasons: ['fallback'], outcome: 'ok', commitStep: 'not-applicable', committed: 'none', commitsIn: 0,
  commitsOut: 0, head: 'a'.repeat(40), conflicts: [], overriddenDeletes: [], keptStashes: [], startedAt: iso(60_000),
  durationMs: 100, finishedAt: iso(60_000),
};
const state: StateFile = { version: 1, dir: '/d', pid: 1, updatedAt: iso(0), consecutiveFailures: 0, keptStashes: [],
  lastRun, lastOkAt: iso(60_000) };
const live: NtfyHealth = { state: 'connected', since: iso(HOUR), lastConnectedAt: iso(HOUR), lastMessageAt: iso(30_000), reconnects: 0 };
const input = (o: Partial<HealthInput> = {}): HealthInput =>
  ({ daemon: 'running', state, ntfy: live, fallbackMs: HOUR, notSynced: 0, nowMs: NOW, ...o });
const withState = (o: Partial<StateFile>): Partial<HealthInput> => ({ state: { ...state, ...o } });

describe('computeHealth', () => {
  test('healthy: running, recent ok sync, live ntfy (or ntfy off / not recorded yet)', () => {
    expect(computeHealth(input())).toEqual({ status: 'healthy', issues: [] });
    expect(computeHealth(input({ ntfy: 'off' }))).toEqual({ status: 'healthy', issues: [] });
    expect(computeHealth(input({ ntfy: 'unknown' }))).toEqual({ status: 'healthy', issues: [] });
    expect(computeHealth(input({ ...withState({ lastRun: undefined, lastOkAt: undefined }) })).status).toBe('healthy');
  });

  test('unknown without a state file, unless something already fails', () => {
    expect(computeHealth(input({ state: 'none', ntfy: 'unknown' }))).toEqual({ status: 'unknown', issues: ['no state file'] });
    expect(computeHealth(input({ state: 'none', daemon: 'stopped' }))).toEqual({ status: 'failing',
      issues: ['daemon not running', 'no state file'] });
  });

  test('failing rules', () => {
    const cases: [Partial<HealthInput>, string][] = [
      [{ daemon: 'stopped' }, 'daemon not running'],
      [{ daemon: 'stale-lock' }, 'daemon not running (stale lock)'],
      [withState({ stuck: { head: 'h', remote: 'r', outcome: 'failed', error: 'rebase refused', since: 'S' } }),
        'stuck since S: rebase refused'],
      [withState({ consecutiveFailures: FAILING_CONSECUTIVE_FAILURES }), '3 failed syncs in a row'],
      [withState({ lastOkAt: iso(STALE_OK_FALLBACK_MULTIPLE * HOUR + 60_000) }), 'last successful sync 3 h ago'],
      [withState({ lastOkAt: undefined }), 'no successful sync yet'],
    ];
    for (const [o, issue] of cases) {
      const h = computeHealth(input(o));
      expect(h.status, issue).toBe('failing');
      expect(h.issues, issue).toContain(issue);
    }
    // the stale-ok limit follows fallbackMs
    expect(computeHealth(input({ ...withState({ lastOkAt: iso(4 * 60_000) }), fallbackMs: 60_000 })).issues)
      .toEqual(['last successful sync 4 min ago']);
    expect(computeHealth(input(withState({ lastOkAt: iso(3 * HOUR) }))).status).toBe('healthy');
  });

  test('degraded rules', () => {
    const cases: [Partial<HealthInput>, string][] = [
      [withState({ consecutiveFailures: 1 }), '1 failed sync in a row'],
      [withState({ lastRun: { ...lastRun, outcome: 'conflict-resolved' } }), 'last sync: conflict-resolved'],
      [{ ntfy: { ...live, state: 'disconnected', lastError: 'HTTP 503' } }, 'ntfy disconnected: HTTP 503'],
      [{ ntfy: { ...live, lastMessageAt: iso(NTFY_SILENT_MS + 60_000) } }, 'ntfy silent for 6 min'],
      [{ ntfy: { state: 'connected', since: iso(HOUR), reconnects: 0 } }, 'ntfy silent for 1 h'],
      [withState({ keptStashes: [{ sha: 's', reason: 'failed', at: 'a' }] }), '1 kept stash'],
      [{ notSynced: 2 }, '2 paths not synced'],
    ];
    for (const [o, issue] of cases) expect(computeHealth(input(o)), issue).toEqual({ status: 'degraded', issues: [issue] });
    expect(computeHealth(input({ ntfy: { ...live, lastMessageAt: iso(NTFY_SILENT_MS - 1_000) } })).status).toBe('healthy');
    expect(computeHealth(input({ notSynced: 'unknown' })).status).toBe('healthy');
  });

  test('failing outranks degraded, and every issue is listed', () => {
    const h = computeHealth(input({ daemon: 'stopped', notSynced: 1, ...withState({ consecutiveFailures: 1 }) }));
    expect(h).toEqual({ status: 'failing', issues: ['daemon not running', '1 failed sync in a row', '1 path not synced'] });
  });

  test('issues never carry credentials from a remote URL', () => {
    const h = computeHealth(input(withState({ stuck: { head: 'h', remote: 'r', outcome: 'failed', since: 'S',
      error: 'push to https://user:ghp_secret@github.com/x/y failed' } })));
    expect(h.issues.join('\n')).not.toContain('ghp_secret');
  });
});

describe('ntfyText', () => {
  test('connected, with last event and last message', () => {
    expect(ntfyText({ ...live, since: '2026-10-18T11:00:00.000Z', lastEventAt: '2026-10-18T11:30:00.000Z',
      lastEventSha: 'b'.repeat(40), lastMessageAt: '2026-10-18T11:59:30.000Z', reconnects: 2 }))
      .toBe(`connected since 2026-10-18T11:00:00Z, last event 2026-10-18T11:30:00Z (${'b'.repeat(12)}), last message 2026-10-18T11:59:30Z, 2 reconnects`);
  });

  test('disconnected with its error; nothing yet; off and unknown', () => {
    expect(ntfyText({ state: 'disconnected', since: '2026-10-18T11:00:00.000Z', lastError: 'HTTP 503', reconnects: 0 }))
      .toBe('disconnected since 2026-10-18T11:00:00Z, error: HTTP 503, no events yet, no messages yet');
    expect(ntfyText('off')).toBe('off');
    expect(ntfyText({ state: 'unknown' })).toBe('configured (not recorded by the daemon yet)');
  });
});
