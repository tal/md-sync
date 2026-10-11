// Serialized sync runner: trigger merging, the dirty flag, carry, hold, waiters and a watchdog.
import { errorText, type Logger } from './log';
import { killChildrenGracefully } from './spawn';
import {
  realClock,
  type Clock,
  type CommitScope,
  type CommitSource,
  type CommitTag,
  type RunMode,
  type RunRequest,
  type RunResult,
  type TimerHandle,
  type Trigger,
  type TriggerLabel,
  type Waiter,
} from './types';

export const RUN_WATCHDOG_MS = 1_800_000;

export type QueueHooks = {
  onRunStart(req: RunRequest, runId: number): void;
  onRunEnd(req: RunRequest, res: RunResult, consumed: readonly Trigger[]): Promise<void>;   // awaited inside the queue
};

type CommitTrigger = Extract<Trigger, { kind: 'commit' }>;

export function triggerLabel(t: Trigger): TriggerLabel {
  if (t.kind === 'pull-only') return t.reason;
  if (t.source === 'backup') return t.timer;
  return t.source;
}

function pushUnique<T>(xs: T[], x: T): void {
  if (!xs.includes(x)) xs.push(x);
}

// Pure. Carried triggers count as earlier arrivals than `ts`.
export function mergeTriggers(carried: readonly Trigger[], ts: readonly Trigger[]): { req: RunRequest; waiters: Waiter[] } {
  const reasons: TriggerLabel[] = [];
  const waiters: Waiter[] = [];
  const commits: CommitTrigger[] = [];
  for (const t of [...carried, ...ts]) {
    pushUnique(reasons, triggerLabel(t));
    if (t.kind !== 'commit') continue;
    commits.push(t);
    if (t.source === 'flush' && t.waiter !== undefined) waiters.push(t.waiter);
  }
  if (commits.length === 0) return { req: { kind: 'pull-only', reasons }, waiters };

  // `paths: []` means "no paths", so it widens the scope to everything.
  const pathScoped = commits.every((t) => t.source === 'flush' && (t.paths?.length ?? 0) > 0);
  let scope: CommitScope = { kind: 'all' };
  if (pathScoped) {
    const paths: string[] = [];
    for (const t of commits) if (t.source === 'flush') for (const p of t.paths ?? []) pushUnique(paths, p);
    scope = { kind: 'paths', paths };
  }
  const messages: string[] = [];
  const sources: CommitSource[] = [];
  for (const t of commits) {
    pushUnique(sources, t.source);
    if (t.source === 'flush' && t.message !== undefined && t.message !== '') messages.push(t.message);
  }
  const tag: CommitTag = commits.every((t) => t.source === 'backup' || t.source === 'shutdown') ? 'auto' : 'none';
  return { req: { kind: 'commit', commit: { scope, messages, tag, sources }, reasons }, waiters };
}

function stripWaiter(t: CommitTrigger): CommitTrigger {
  if (t.source !== 'flush') return t;
  const out: CommitTrigger = { kind: 'commit', source: 'flush' };
  if (t.message !== undefined) out.message = t.message;
  if (t.paths !== undefined) out.paths = [...t.paths];
  return out;
}

// A `failed` result for a run that was never completed: the runner rejected (the queue knows neither the run mode
// nor HEAD) or the daemon could not attempt it at all.
export function failedRunResult(req: RunRequest, runId: number, o: { mode: RunMode; error: string; startedMs: number; durationMs: number }): RunResult {
  return {
    runId,
    kind: req.kind,
    mode: o.mode,
    reasons: [...req.reasons],
    outcome: 'failed',
    commitStep: req.kind === 'commit' ? 'not-reached' : 'not-applicable',
    commitsIn: 0,
    commitsOut: 0,
    head: 'unknown',
    committed: 'none',
    conflicts: [],
    overriddenDeletes: [],
    keptStashes: [],
    error: o.error,
    startedAt: new Date(o.startedMs).toISOString(),
    durationMs: o.durationMs,
  };
}

export class SyncQueue {
  readonly #run: (req: RunRequest, runId: number) => Promise<RunResult>;
  readonly #log: Logger;
  readonly #clock: Clock;
  readonly #watchdogMs: number;
  #hooks: Partial<QueueHooks>;
  #activity: 'idle' | 'running' = 'idle';
  #hold: 'held' | 'released' = 'released';
  #pending: Trigger[] = [];
  #carried: CommitTrigger[] = [];
  #lastRunId = 0;
  #idleWaiters: (() => void)[] = [];

  constructor(o: { run: (req: RunRequest, runId: number) => Promise<RunResult>; log: Logger; hooks?: Partial<QueueHooks>;
                   clock?: Clock; watchdogMs?: number /* RUN_WATCHDOG_MS */ }) {
    this.#run = o.run;
    this.#log = o.log;
    this.#hooks = { ...o.hooks };
    this.#clock = o.clock ?? realClock;
    this.#watchdogMs = o.watchdogMs ?? RUN_WATCHDOG_MS;
  }

  request(t: Trigger): void {
    try {
      const state = this.#hold === 'held' ? 'held' : this.#activity === 'running' ? 'pending' : 'started';
      this.#log.debug('sync queued', { trigger: triggerLabel(t), state });
      if (state === 'started') this.#start([t]);
      else this.#pending.push(t);
    } catch (e) {
      this.#callbackFailed('queue.request', e);
    }
  }

  carry(ts: readonly Trigger[]): void {
    for (const t of ts) if (t.kind === 'commit') this.#carried.push(stripWaiter(t));
  }

  hold(): void {
    this.#hold = 'held';
  }

  release(): void {
    if (this.#hold === 'released') return;
    this.#hold = 'released';
    if (this.#activity === 'idle') this.#next();
  }

  activity(): 'idle' | 'running' {
    return this.#activity;
  }

  hasPending(): 'pending' | 'none' {
    return this.#pending.length > 0 ? 'pending' : 'none';
  }

  whenIdle(): Promise<void> {
    if (this.#activity === 'idle' && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  setHooks(h: Partial<QueueHooks>): void {
    this.#hooks = { ...this.#hooks, ...h };
  }

  #start(ts: Trigger[]): void {
    const carried = this.#carried;
    this.#carried = [];
    const { req, waiters } = mergeTriggers(carried, ts);
    const runId = ++this.#lastRunId;
    this.#activity = 'running';
    void this.#execute(req, runId, [...carried, ...ts], waiters);
  }

  async #execute(req: RunRequest, runId: number, consumed: readonly Trigger[], waiters: Waiter[]): Promise<void> {
    try {
      this.#hooks.onRunStart?.(req, runId);
    } catch (e) {
      this.#callbackFailed('queue.onRunStart', e);
    }
    const startedMs = this.#clock.now();
    // Covers onRunEnd too: it runs git (status, repo config) and could hang just like the run.
    const watchdog: TimerHandle = this.#clock.setTimeout(() => this.#stuck(runId, startedMs), this.#watchdogMs);
    let res: RunResult;
    try {
      res = await this.#run(req, runId);
    } catch (e) {
      this.#callbackFailed('queue.run', e);
      res = failedRunResult(req, runId, { mode: 'normal', error: errorText(e), startedMs,
        durationMs: Math.max(0, this.#clock.now() - startedMs) });
    }
    try {
      await this.#hooks.onRunEnd?.(req, res, consumed);
    } catch (e) {
      this.#callbackFailed('queue.onRunEnd', e);
    }
    this.#clock.clearTimeout(watchdog);
    // After onRunEnd, so a `flush --wait` client returns only once state, carry and retry are settled.
    for (const w of waiters) {
      try {
        w(res);
      } catch (e) {
        this.#callbackFailed('queue.waiter', e);
      }
    }
    this.#next();
  }

  #next(): void {
    if (this.#hold === 'released' && this.#pending.length > 0) {
      const ts = this.#pending;
      this.#pending = [];
      this.#start(ts);
      return;
    }
    this.#activity = 'idle';
    if (this.#pending.length > 0) return;   // held: whenIdle waits for release() and that run
    const ws = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const w of ws) w();
  }

  #stuck(runId: number, startedMs: number): void {
    this.#log.error('run stuck', { runId, elapsedMs: this.#clock.now() - startedMs });
    killChildrenGracefully().catch((e: unknown) => this.#callbackFailed('queue.watchdog', e));
  }

  #callbackFailed(source: string, e: unknown): void {
    this.#log.error('callback failed', { source, error: e });
  }
}
