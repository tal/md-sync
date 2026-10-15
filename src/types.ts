// Shared unions, records and the real clock.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SyncKind = 'commit' | 'pull-only';
export type RunMode = 'normal' | 'shutdown';           // 'shutdown': no fetch/rebase, one push attempt
export type CommitSource = 'flush' | 'backup' | 'sync-once' | 'shutdown';
export type BackupTimerName = 'idle' | 'max-wait';
export type PullReason = 'startup' | 'ntfy' | 'ntfy-connect' | 'ntfy-reconnect' | 'fallback' | 'wake' | 'retry'
  | 'network'                                          // the machine joined a network (NetworkWatcher)
  | 'settle'                                           // the settle timer: preflight only, no fetch
  | 'shutdown';                                        // autoCommit off: push what is already committed, commit nothing
export type TriggerLabel = 'flush' | BackupTimerName | 'sync-once' | 'shutdown' | PullReason;
export type WaitMode = 'wait' | 'no-wait';
export type SyncOutcome = 'ok' | 'conflict-resolved' | 'network-error' | 'busy' | 'failed' | 'data-guard-stop';
export type CommitStep = 'committed' | 'nothing-staged' | 'not-reached' | 'not-applicable';  // not-applicable: pull-only
export type DaemonPhase = 'starting' | 'running' | 'stopping';
export type Waiter = (result: RunResult) => void;

export type Trigger =
  | { kind: 'commit'; source: 'flush'; message?: string; paths?: string[]; waiter?: Waiter }
  | { kind: 'commit'; source: 'backup'; timer: BackupTimerName }
  | { kind: 'commit'; source: 'sync-once' | 'shutdown' }
  | { kind: 'pull-only'; reason: PullReason };

export type CommitScope = { kind: 'all' } | { kind: 'paths'; paths: string[] };  // paths: repo-relative POSIX
export type CommitTag = 'auto' | 'none';                                          // 'auto' => " (auto)" suffix
export type CommitPlan = { scope: CommitScope; messages: string[]; tag: CommitTag; sources: CommitSource[] };

export type RunRequest =
  | { kind: 'commit'; commit: CommitPlan; reasons: TriggerLabel[] }
  | { kind: 'pull-only'; reasons: TriggerLabel[] };

export type StuckRecord = { head: string; remote: string; outcome: 'failed' | 'data-guard-stop'; error: string; since: string };
export type RunOptions = { mode: RunMode; stuck: StuckRecord | 'none'; keptStashes: readonly string[];
  integrated: string | 'none';     // RunResult.integrated of an earlier run (the state file); 'none': unknown
  cloned: 'fresh-clone' | 'none' };   // 'fresh-clone': this process's bootstrap just cloned the folder (P1b logs no `recovered`)

export type ChangeEntry = { status: string; path: string };          // status = git name-status letter(s)
export type OverriddenDelete = { path: string; deletedBy: 'local' | 'remote' };

export type RunResult = {
  runId: number;
  kind: SyncKind;
  mode: RunMode;
  reasons: TriggerLabel[];
  outcome: SyncOutcome;
  commitStep: CommitStep;
  commitsIn: number;              // remote commits newly integrated (summed over retries)
  commitsOut: number;             // commits pushed by this run
  head: string;                   // full sha, or 'unborn'
  committed: string | 'none';     // sha of the step-2 (S2) commit
  conflicts: string[];            // conflict-copy paths created by this run (any mechanism)
  overriddenDeletes: OverriddenDelete[];
  keptStashes: string[];          // stash shas this run left in refs/stash after a replay it could not finish
  s5?: { head: string; remote: string };   // set when a failed/data-guard-stop outcome came from S5 or its handlers
  stuck?: 'unchanged';            // the run returned a remembered S5 failure without retrying it
  integrated?: string;            // the origin/B commit HEAD contains when the run ends (S3's rewrite check)
  settleDueAt?: number;           // ms epoch: the earliest replaced inode still waiting to settle (the daemon's settle timer)
  error?: string;                 // redacted, single line; set for every outcome except ok / conflict-resolved
  startedAt: string;              // ISO
  durationMs: number;
};

export type TimerHandle = unknown;
export type Clock = {
  now(): number;                                   // ms epoch
  setTimeout(fn: () => void, ms: number): TimerHandle;   // ms > MAX_TIMER_MS is chained, never passed through
  clearTimeout(h: TimerHandle): void;
};
export const MAX_TIMER_MS = 2_147_483_647;

// Bun fires a setTimeout longer than MAX_TIMER_MS after ~1 ms, so long delays are split into
// MAX_TIMER_MS hops toward a fixed due time. The handle is mutable so clearTimeout cancels whichever
// hop is pending. globalThis timers are looked up per call so tests can stub them.
type RealTimer = { pending: ReturnType<typeof globalThis.setTimeout> | undefined; state: 'scheduled' | 'done' };

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const delay = Number.isFinite(ms) || ms === Infinity ? Math.max(0, ms) : 0;
    const due = Date.now() + delay;
    const handle: RealTimer = { pending: undefined, state: 'scheduled' };
    const hop = (wait: number): void => {
      handle.pending = globalThis.setTimeout(() => {
        if (handle.state === 'done') return;
        const left = due - Date.now();
        if (left > 0 && wait >= MAX_TIMER_MS) {
          hop(Math.min(left, MAX_TIMER_MS));
          return;
        }
        handle.state = 'done';
        handle.pending = undefined;
        fn();
      }, wait);
    };
    hop(Math.min(delay, MAX_TIMER_MS));
    return handle;
  },
  clearTimeout(h: TimerHandle): void {
    if (typeof h !== 'object' || h === null || !('state' in h)) return;
    const t = h as RealTimer;
    t.state = 'done';
    if (t.pending !== undefined) globalThis.clearTimeout(t.pending);
    t.pending = undefined;
  },
};

export class UsageError extends Error {           // -> exit 2
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UsageError';
  }
}
