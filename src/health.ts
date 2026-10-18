// One verdict on a folder's sync health for `status`, so a dashboard reads it instead of re-deriving the rules.
import { redact } from './log';
import type { NtfyHealth, StateFile } from './state';

export type HealthStatus = 'healthy' | 'degraded' | 'failing' | 'unknown';
export type Health = { status: HealthStatus; issues: string[] };

export const FAILING_CONSECUTIVE_FAILURES = 3;
export const STALE_OK_FALLBACK_MULTIPLE = 3;      // no ok sync for 3 catch-up intervals: pulls have stopped landing
export const NTFY_SILENT_MS = 5 * 60_000;         // ntfy keepalives come every 45 s; five minutes of nothing is a dead stream

// 'unknown' (in ntfy): configured, but the daemon has not recorded the subscription (not started yet, or an older version).
export type HealthInput = {
  daemon: 'running' | 'stopped' | 'stale-lock';
  state: StateFile | 'none';
  ntfy: NtfyHealth | 'unknown' | 'off';
  fallbackMs: number;
  notSynced: number | 'unknown';
  nowMs: number;
};

const ago = (ms: number): string => ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;

// Failing outranks unknown (no state file), which outranks degraded. Issue text never names the ntfy URL or a remote's
// credentials: errors are redacted on the way in, and again here.
export function computeHealth(h: HealthInput): Health {
  const failing: string[] = [];
  const degraded: string[] = [];
  if (h.daemon === 'stopped') failing.push('daemon not running');
  if (h.daemon === 'stale-lock') failing.push('daemon not running (stale lock)');
  const s = h.state;
  if (s !== 'none') {
    if (s.stuck !== undefined) failing.push(`stuck since ${s.stuck.since}: ${s.stuck.error}`);
    if (s.consecutiveFailures >= FAILING_CONSECUTIVE_FAILURES) failing.push(`${s.consecutiveFailures} failed syncs in a row`);
    else if (s.consecutiveFailures > 0) degraded.push(`${s.consecutiveFailures} failed sync${s.consecutiveFailures === 1 ? '' : 's'} in a row`);
    const okMs = s.lastOkAt === undefined ? Number.NaN : Date.parse(s.lastOkAt);
    if (s.lastOkAt === undefined) {
      if (s.lastRun !== undefined) failing.push('no successful sync yet');
    } else if (!Number.isNaN(okMs) && h.nowMs - okMs > STALE_OK_FALLBACK_MULTIPLE * h.fallbackMs) {
      failing.push(`last successful sync ${ago(h.nowMs - okMs)} ago`);
    }
    if (s.lastRun !== undefined && s.lastRun.outcome !== 'ok') degraded.push(`last sync: ${s.lastRun.outcome}`);
    if (s.keptStashes.length > 0) degraded.push(`${s.keptStashes.length} kept stash${s.keptStashes.length === 1 ? '' : 'es'}`);
  }
  if (h.ntfy !== 'off' && h.ntfy !== 'unknown') {
    if (h.ntfy.state === 'disconnected') {
      degraded.push(`ntfy disconnected${h.ntfy.lastError !== undefined ? `: ${h.ntfy.lastError}` : ''}`);
    } else {
      const lastMs = Date.parse(h.ntfy.lastMessageAt ?? h.ntfy.since);
      if (!Number.isNaN(lastMs) && h.nowMs - lastMs > NTFY_SILENT_MS) degraded.push(`ntfy silent for ${ago(h.nowMs - lastMs)}`);
    }
  }
  if (typeof h.notSynced === 'number' && h.notSynced > 0) degraded.push(`${h.notSynced} path${h.notSynced === 1 ? '' : 's'} not synced`);
  const issues = [...failing, ...degraded].map(redact);
  const status: HealthStatus = failing.length > 0 ? 'failing' : s === 'none' ? 'unknown' : degraded.length > 0 ? 'degraded' : 'healthy';
  return { status, issues: s === 'none' ? [...issues, 'no state file'] : issues };
}
