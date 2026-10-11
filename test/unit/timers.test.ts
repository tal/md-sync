import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { BackupTimers, IntervalTimer, WakeDetector } from '../../src/timers';
import { MAX_TIMER_MS, realClock, type BackupTimerName, type Clock, type TimerHandle } from '../../src/types';

class ManualClock implements Clock {
  t = 1_000_000;
  #seq = 0;
  #timers = new Map<number, { due: number; fn: () => void }>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.#seq;
    this.#timers.set(id, { due: this.t + Math.max(0, ms), fn });
    return id;
  }
  clearTimeout(h: TimerHandle): void { this.#timers.delete(h as number); }
  // Moves time forward, firing due timers in order (each sees now() == its due time).
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const e of this.#timers) if (e[1].due <= end && (next === undefined || e[1].due < next[1].due)) next = e;
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].due);
      next[1].fn();
    }
    this.t = end;
  }
  // Moves time forward without firing anything (a suspended process).
  jump(ms: number): void { this.t += ms; }
  pending(): number { return this.#timers.size; }
}

const IDLE = 10_000;
const MAX = 30_000;

function setup(idleMs = IDLE, maxWaitMs = MAX) {
  const clock = new ManualClock();
  const fired: [BackupTimerName, number][] = [];
  const t0 = clock.now();
  const timers = new BackupTimers({ idleMs, maxWaitMs, clock, onFire: (name) => fired.push([name, clock.now() - t0]) });
  return { clock, fired, timers, t0 };
}

describe('BackupTimers', () => {
  test('the idle period is never shorter than the floor (the watcher reports writes up to one poll interval late)', () => {
    // r4: with the poll backend, idleMs 1500 fired between two scans of a writing session: 5 commits for one burst.
    const clock = new ManualClock();
    const fired: number[] = [];
    let floor = 4_500;
    const timers = new BackupTimers({ idleMs: 1_500, maxWaitMs: 60_000, clock, onFire: () => fired.push(clock.now()),
      idleFloorMs: () => floor });
    const t0 = clock.now();
    timers.noteChange();
    clock.advance(2_250);   // the next scan sees more writes
    timers.noteChange();
    clock.advance(4_499);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([t0 + 2_250 + 4_500]);
    floor = 0;   // fsevents: the configured idleMs applies
    timers.afterRun('clean');
    const t1 = clock.now();
    timers.noteChange();
    clock.advance(1_500);
    expect(fired.at(-1)).toBe(t1 + 1_500);
  });

  test('starts disarmed with no anchor', () => {
    const { timers } = setup();
    expect(timers.status()).toBe('disarmed');
    expect(timers.firstDirtyAt()).toBe('none');
  });

  test('noteChange arms both and sets the anchor once', () => {
    const { clock, timers, t0 } = setup();
    timers.noteChange();
    expect(timers.status()).toBe('armed');
    expect(timers.firstDirtyAt()).toBe(t0);
    clock.advance(3_000);
    timers.noteChange();
    expect(timers.firstDirtyAt()).toBe(t0);
  });

  test('idle restarts on every change', () => {
    const { clock, fired, timers } = setup();
    timers.noteChange();
    clock.advance(IDLE - 1);
    timers.noteChange();
    clock.advance(IDLE - 1);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([['idle', 2 * IDLE - 1]]);
  });

  test('max-wait is not reset by changes', () => {
    const { clock, fired, timers } = setup();
    while (fired.length === 0) {
      timers.noteChange();
      clock.advance(5_000);
    }
    expect(fired).toEqual([['max-wait', MAX]]);
  });

  test('a change after a fire (before afterRun) re-fires an overdue max-wait: the anchor is kept', () => {
    const { clock, fired, timers } = setup();
    while (fired.length === 0) {
      timers.noteChange();
      clock.advance(5_000);
    }
    timers.noteChange();
    clock.advance(0);
    expect(fired.map(([n]) => n)).toEqual(['max-wait', 'max-wait']);
  });

  test('firing stops both timers and keeps the anchor until afterRun', () => {
    const { clock, fired, timers, t0 } = setup();
    timers.noteChange();
    clock.advance(IDLE);
    expect(fired).toEqual([['idle', IDLE]]);
    expect(timers.status()).toBe('disarmed');
    expect(timers.firstDirtyAt()).toBe(t0);
    clock.advance(MAX * 2);
    expect(fired.length).toBe(1);   // max-wait was stopped too
    expect(clock.pending()).toBe(0);
  });

  test("onCommitRunStart('all') stops both (anchor kept); 'paths' does nothing", () => {
    const { clock, fired, timers, t0 } = setup();
    timers.noteChange();
    timers.onCommitRunStart('paths');
    expect(timers.status()).toBe('armed');
    timers.onCommitRunStart('all');
    expect(timers.status()).toBe('disarmed');
    expect(timers.firstDirtyAt()).toBe(t0);
    clock.advance(MAX * 2);
    expect(fired).toEqual([]);
  });

  test("afterRun('clean') clears everything", () => {
    const { clock, fired, timers } = setup();
    timers.noteChange();
    timers.afterRun('clean');
    expect(timers.status()).toBe('disarmed');
    expect(timers.firstDirtyAt()).toBe('none');
    clock.advance(MAX * 2);
    expect(fired).toEqual([]);
  });

  test("anchor: a path-limited run + afterRun('dirty') keeps max-wait at firstDirtyAt + maxWaitMs", () => {
    const { clock, fired, timers, t0 } = setup();
    timers.noteChange();
    clock.advance(5_000);
    timers.onCommitRunStart('paths');   // flush of other paths: timers untouched
    clock.advance(2_000);
    timers.afterRun('dirty');
    expect(timers.firstDirtyAt()).toBe(t0);
    clock.advance(1_000);
    timers.noteChange();                // idle restarts at 8 s and fires at 18 s; max-wait stays at 30 s
    clock.advance(10_000);
    expect(fired).toEqual([['idle', 18_000]]);
    timers.afterRun('dirty');           // that run failed: re-arm (idle due 28 s), same anchor (max-wait due 30 s)
    expect(timers.firstDirtyAt()).toBe(t0);
    clock.advance(5_000);
    timers.noteChange();                // idle due 33 s
    clock.advance(10_000);
    expect(fired).toEqual([['idle', 18_000], ['max-wait', MAX]]);
  });

  test('an overdue max-wait fires immediately (asynchronously) when re-armed', () => {
    const { clock, fired, timers } = setup();
    timers.noteChange();
    clock.advance(IDLE);                // idle fires, both stop
    clock.advance(MAX);                 // a long run: nothing armed
    expect(fired).toEqual([['idle', IDLE]]);
    timers.afterRun('dirty');
    expect(fired.length).toBe(1);       // not synchronous
    clock.advance(0);
    expect(fired).toEqual([['idle', IDLE], ['max-wait', IDLE + MAX]]);
  });

  test('noteChange also fires an overdue max-wait right away', () => {
    const { clock, fired, timers } = setup();
    timers.noteChange();
    clock.advance(IDLE);
    clock.advance(MAX);
    timers.noteChange();
    clock.advance(0);
    expect(fired.map(([n]) => n)).toEqual(['idle', 'max-wait']);
  });

  test("afterRun('dirty-after-full-commit') re-anchors and starts both fresh", () => {
    const { clock, fired, timers, t0 } = setup();
    timers.noteChange();
    clock.advance(IDLE);                 // idle fires at 10 s
    timers.onCommitRunStart('all');
    clock.advance(5_000);
    timers.afterRun('dirty-after-full-commit');
    expect(timers.firstDirtyAt()).toBe(t0 + 15_000);
    clock.advance(IDLE);
    expect(fired).toEqual([['idle', IDLE], ['idle', 25_000]]);
    timers.afterRun('dirty');
    while (fired.length === 2) {
      timers.noteChange();
      clock.advance(5_000);
    }
    expect(fired.at(-1)).toEqual(['max-wait', 15_000 + MAX]);
  });

  test('armIfDisarmed leaves a running idle timer alone', () => {
    const { clock, fired, timers } = setup();
    timers.noteChange();
    clock.advance(6_000);
    timers.armIfDisarmed();
    clock.advance(4_000);
    expect(fired).toEqual([['idle', IDLE]]);
  });

  test('armIfDisarmed arms from scratch with a new anchor', () => {
    const { clock, fired, timers, t0 } = setup();
    clock.advance(1_000);
    timers.armIfDisarmed();
    expect(timers.firstDirtyAt()).toBe(t0 + 1_000);
    clock.advance(IDLE);
    expect(fired).toEqual([['idle', 1_000 + IDLE]]);
  });

  test('setDurations reschedules running timers from their original start and anchor', () => {
    const { clock, fired, timers } = setup();
    timers.noteChange();
    clock.advance(4_000);
    timers.setDurations(6_000, 20_000);   // idle started at 0 -> due 6 s
    clock.advance(2_000);
    expect(fired).toEqual([['idle', 6_000]]);

    timers.afterRun('dirty');             // re-arm at 6 s: idle due 12 s, max-wait due 0 + 20 s
    clock.advance(5_000);
    timers.noteChange();                  // idle due 17 s
    clock.advance(1_000);                 // now 12 s
    timers.setDurations(60_000, 3_000);   // both overdue -> fire now; the first one stops the other
    clock.advance(0);
    expect(fired.length).toBe(2);
    expect(fired[1]?.[1]).toBe(12_000);
    expect(timers.status()).toBe('disarmed');
  });

  test('setDurations while disarmed only changes future durations', () => {
    const { clock, fired, timers } = setup();
    timers.setDurations(1_000, 2_000);
    expect(timers.status()).toBe('disarmed');
    timers.noteChange();
    clock.advance(1_000);
    expect(fired).toEqual([['idle', 1_000]]);
  });

  test('clear is idempotent and drops the anchor', () => {
    const { timers } = setup();
    timers.clear();
    timers.noteChange();
    timers.clear();
    timers.clear();
    expect(timers.status()).toBe('disarmed');
    expect(timers.firstDirtyAt()).toBe('none');
  });
});

describe('IntervalTimer', () => {
  test('fires every ms after start until stopped', () => {
    const clock = new ManualClock();
    const at: number[] = [];
    const t0 = clock.now();
    const it = new IntervalTimer({ ms: 1_000, clock, onFire: () => at.push(clock.now() - t0) });
    clock.advance(5_000);
    expect(at).toEqual([]);   // not started
    it.start();
    it.start();               // idempotent
    clock.advance(3_500);
    expect(at).toEqual([6_000, 7_000, 8_000]);
    it.stop();
    clock.advance(10_000);
    expect(at.length).toBe(3);
    expect(clock.pending()).toBe(0);
  });

  test('setMs keeps the last start and fires now if overdue', () => {
    const clock = new ManualClock();
    const at: number[] = [];
    const t0 = clock.now();
    const it = new IntervalTimer({ ms: 10_000, clock, onFire: () => at.push(clock.now() - t0) });
    it.start();
    clock.advance(4_000);
    it.setMs(6_000);
    clock.advance(2_000);
    expect(at).toEqual([6_000]);
    clock.advance(5_000);   // 11 s; next due 12 s
    it.setMs(1_000);        // overdue: fires now
    clock.advance(0);
    expect(at).toEqual([6_000, 11_000]);
    clock.advance(1_000);
    expect(at).toEqual([6_000, 11_000, 12_000]);
  });

  test('setMs on a stopped timer does not start it', () => {
    const clock = new ManualClock();
    let n = 0;
    const it = new IntervalTimer({ ms: 1_000, clock, onFire: () => { n++; } });
    it.setMs(500);
    clock.advance(5_000);
    expect(n).toBe(0);
    it.start();
    clock.advance(1_000);
    expect(n).toBe(2);
  });

  test('onFire may stop the timer', () => {
    const clock = new ManualClock();
    let n = 0;
    const it: IntervalTimer = new IntervalTimer({ ms: 1_000, clock, onFire: () => { n++; it.stop(); } });
    it.start();
    clock.advance(10_000);
    expect(n).toBe(1);
  });
});

describe('WakeDetector', () => {
  test('regular ticks never report a wake', () => {
    const clock = new ManualClock();
    const gaps: number[] = [];
    const w = new WakeDetector({ clock, onWake: (g) => gaps.push(g) });
    w.start();
    clock.advance(15_000 * 100);
    expect(gaps).toEqual([]);
  });

  test('a gap larger than tick + slack (75 s) is reported with the full gap', () => {
    const clock = new ManualClock();
    const gaps: number[] = [];
    const w = new WakeDetector({ clock, onWake: (g) => gaps.push(g) });
    w.start();
    clock.advance(15_000);
    clock.jump(3_600_000);   // suspended: the 30 s tick fires an hour late
    clock.advance(0);
    expect(gaps).toEqual([3_600_000]);   // measured from the previous tick
    clock.advance(15_000 * 10);
    expect(gaps.length).toBe(1);
  });

  test('threshold: exactly tick + slack is not a wake, one ms more is', () => {
    const clock = new ManualClock();
    const gaps: number[] = [];
    const w = new WakeDetector({ tickMs: 1_000, slackMs: 5_000, clock, onWake: (g) => gaps.push(g) });
    w.start();
    clock.jump(6_000);
    clock.advance(0);
    expect(gaps).toEqual([]);
    clock.jump(6_001);
    clock.advance(0);
    expect(gaps).toEqual([6_001]);
  });

  test('stop cancels the tick', () => {
    const clock = new ManualClock();
    const w = new WakeDetector({ clock, onWake: () => {} });
    w.start();
    expect(clock.pending()).toBe(1);
    w.stop();
    expect(clock.pending()).toBe(0);
  });
});

describe('realClock', () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  afterEach(() => {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    setSystemTime();
  });

  const T = Date.parse('2026-01-01T00:00:00Z');   // setSystemTime(new Date(0)) would reset the mock

  function stubTimers() {
    const calls: { fn: () => void; ms: number; id: number }[] = [];
    const cleared: number[] = [];
    let seq = 0;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      const id = ++seq;
      calls.push({ fn, ms, id });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { cleared.push(id); }) as unknown as typeof clearTimeout;
    return { calls, cleared };
  }

  test('chains a delay longer than MAX_TIMER_MS in MAX_TIMER_MS hops', () => {
    setSystemTime(new Date(T));
    const { calls } = stubTimers();
    let fired = 0;
    realClock.setTimeout(() => { fired++; }, 2 * MAX_TIMER_MS + 5);
    expect(calls.map((c) => c.ms)).toEqual([MAX_TIMER_MS]);

    setSystemTime(new Date(T + 1));   // Bun firing a too-large timer early: just re-hop
    calls[0]?.fn();
    expect(fired).toBe(0);
    expect(calls[1]?.ms).toBe(MAX_TIMER_MS);

    setSystemTime(new Date(T + MAX_TIMER_MS + 1));
    calls[1]?.fn();
    expect(fired).toBe(0);
    expect(calls[2]?.ms).toBe(MAX_TIMER_MS);

    setSystemTime(new Date(T + 2 * MAX_TIMER_MS + 1));
    calls[2]?.fn();
    expect(fired).toBe(0);
    expect(calls[3]?.ms).toBe(4);

    setSystemTime(new Date(T + 2 * MAX_TIMER_MS + 5));
    calls[3]?.fn();
    expect(fired).toBe(1);
    expect(calls.length).toBe(4);
  });

  test('a short delay passes straight through', () => {
    const { calls } = stubTimers();
    let fired = 0;
    realClock.setTimeout(() => { fired++; }, 250);
    expect(calls.map((c) => c.ms)).toEqual([250]);
    calls[0]?.fn();
    expect(fired).toBe(1);
  });

  test('clearTimeout cancels whichever hop is pending', () => {
    setSystemTime(new Date(T));
    const { calls, cleared } = stubTimers();
    let fired = 0;
    const h = realClock.setTimeout(() => { fired++; }, 3 * MAX_TIMER_MS);
    setSystemTime(new Date(T + MAX_TIMER_MS));
    calls[0]?.fn();
    realClock.clearTimeout(h);
    expect(cleared).toEqual([calls[1]?.id ?? -1]);
    calls[1]?.fn();   // a callback that slipped through is ignored
    expect(fired).toBe(0);
  });

  test('a real long timer does not fire early', async () => {
    let fired = 0;
    const h = realClock.setTimeout(() => { fired++; }, MAX_TIMER_MS + 1_000);
    await Bun.sleep(30);
    realClock.clearTimeout(h);
    expect(fired).toBe(0);
  });
});
