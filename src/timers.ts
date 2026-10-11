// Backup timers, the fallback interval and the wake detector, all on an injectable Clock.
import { realClock, type BackupTimerName, type Clock, type CommitScope, type TimerHandle } from './types';

// One scheduled callback. `gen` makes a callback that was already queued when it got cancelled a no-op.
class Slot {
  #clock: Clock;
  #handle: TimerHandle | 'none' = 'none';
  #gen = 0;
  startedAt = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  running(): boolean {
    return this.#handle !== 'none';
  }

  // Due at startedAt + ms; an overdue slot fires on the next turn (delay 0), never synchronously.
  schedule(startedAt: number, ms: number, fn: () => void): void {
    this.cancel();
    this.startedAt = startedAt;
    const gen = this.#gen;
    const delay = Math.max(0, startedAt + ms - this.#clock.now());
    this.#handle = this.#clock.setTimeout(() => {
      if (gen !== this.#gen) return;
      this.#handle = 'none';
      this.#gen++;
      fn();
    }, delay);
  }

  cancel(): void {
    this.#gen++;
    if (this.#handle !== 'none') this.#clock.clearTimeout(this.#handle);
    this.#handle = 'none';
  }
}

export class BackupTimers {
  #idleMs: number;
  #maxWaitMs: number;
  readonly #onFire: (t: BackupTimerName) => void;
  readonly #clock: Clock;
  readonly #idleFloorMs: () => number;
  readonly #idle: Slot;
  readonly #maxWait: Slot;
  #anchor: number | 'none' = 'none';

  // idleFloorMs: the shortest idle period that still means "quiet". The watcher reports a write up to one poll
  // interval late, so an idle timer shorter than about two intervals fired between two scans of a writing session
  // and split one burst into several commits.
  constructor(o: { idleMs: number; maxWaitMs: number; onFire: (t: BackupTimerName) => void; clock?: Clock;
    idleFloorMs?: () => number }) {
    this.#idleMs = o.idleMs;
    this.#maxWaitMs = o.maxWaitMs;
    this.#onFire = o.onFire;
    this.#clock = o.clock ?? realClock;
    this.#idleFloorMs = o.idleFloorMs ?? (() => 0);
    this.#idle = new Slot(this.#clock);
    this.#maxWait = new Slot(this.#clock);
  }

  noteChange(): void {
    const now = this.#clock.now();
    const anchor = this.#ensureAnchor(now);
    this.#startIdle(now);
    if (!this.#maxWait.running()) this.#startMaxWait(anchor);
  }

  armIfDisarmed(): void {
    const now = this.#clock.now();
    const anchor = this.#ensureAnchor(now);
    if (!this.#idle.running()) this.#startIdle(now);
    if (!this.#maxWait.running()) this.#startMaxWait(anchor);
  }

  onCommitRunStart(scope: CommitScope['kind']): void {
    if (scope === 'all') this.#stopBoth();
  }

  afterRun(state: 'clean' | 'dirty-after-full-commit' | 'dirty'): void {
    switch (state) {
      case 'clean':
        this.clear();
        return;
      case 'dirty-after-full-commit': {
        // What is left are writes made during the run: a fresh anchor, both timers from now.
        const now = this.#clock.now();
        this.#stopBoth();
        this.#anchor = now;
        this.#startIdle(now);
        this.#startMaxWait(now);
        return;
      }
      case 'dirty':
        this.armIfDisarmed();
        return;
    }
  }

  clear(): void {
    this.#stopBoth();
    this.#anchor = 'none';
  }

  setDurations(idleMs: number, maxWaitMs: number): void {
    this.#idleMs = idleMs;
    this.#maxWaitMs = maxWaitMs;
    if (this.#idle.running()) this.#startIdle(this.#idle.startedAt);
    if (this.#maxWait.running() && this.#anchor !== 'none') this.#startMaxWait(this.#anchor);
  }

  status(): 'armed' | 'disarmed' {
    return this.#idle.running() || this.#maxWait.running() ? 'armed' : 'disarmed';
  }

  firstDirtyAt(): number | 'none' {
    return this.#anchor;
  }

  #ensureAnchor(now: number): number {
    if (this.#anchor === 'none') this.#anchor = now;
    return this.#anchor;
  }

  #startIdle(startedAt: number): void {
    this.#idle.schedule(startedAt, Math.max(this.#idleMs, this.#idleFloorMs()), () => this.#fire('idle'));
  }

  #startMaxWait(anchor: number): void {
    this.#maxWait.schedule(anchor, this.#maxWaitMs, () => this.#fire('max-wait'));
  }

  #stopBoth(): void {
    this.#idle.cancel();
    this.#maxWait.cancel();
  }

  // Firing either timer stops both; the anchor stays until afterRun.
  #fire(t: BackupTimerName): void {
    this.#stopBoth();
    this.#onFire(t);
  }
}

export class IntervalTimer {
  #ms: number;
  readonly #onFire: () => void;
  readonly #clock: Clock;
  readonly #slot: Slot;

  constructor(o: { ms: number; onFire: () => void; clock?: Clock }) {
    this.#ms = o.ms;
    this.#onFire = o.onFire;
    this.#clock = o.clock ?? realClock;
    this.#slot = new Slot(this.#clock);
  }

  start(): void {
    if (!this.#slot.running()) this.#arm(this.#clock.now());
  }

  stop(): void {
    this.#slot.cancel();
  }

  // A running timer keeps its last start: due at start + ms, or now if that has passed.
  setMs(ms: number): void {
    this.#ms = ms;
    if (this.#slot.running()) this.#arm(this.#slot.startedAt);
  }

  #arm(startedAt: number): void {
    this.#slot.schedule(startedAt, this.#ms, () => {
      this.#arm(this.#clock.now());   // re-arm first, so onFire may stop() it
      this.#onFire();
    });
  }
}

export class WakeDetector {
  readonly #tickMs: number;
  readonly #slackMs: number;
  readonly #onWake: (gapMs: number) => void;
  readonly #clock: Clock;
  readonly #slot: Slot;
  #lastTick = 0;

  constructor(o: { tickMs?: number /* 15000 */; slackMs?: number /* 60000 */; onWake: (gapMs: number) => void; clock?: Clock }) {
    this.#tickMs = o.tickMs ?? 15_000;
    this.#slackMs = o.slackMs ?? 60_000;
    this.#onWake = o.onWake;
    this.#clock = o.clock ?? realClock;
    this.#slot = new Slot(this.#clock);
  }

  start(): void {
    if (this.#slot.running()) return;
    this.#lastTick = this.#clock.now();
    this.#arm();
  }

  stop(): void {
    this.#slot.cancel();
  }

  #arm(): void {
    this.#slot.schedule(this.#clock.now(), this.#tickMs, () => this.#tick());
  }

  #tick(): void {
    const now = this.#clock.now();
    const gapMs = now - this.#lastTick;
    this.#lastTick = now;
    this.#arm();
    if (gapMs > this.#tickMs + this.#slackMs) this.#onWake(gapMs);
  }
}
