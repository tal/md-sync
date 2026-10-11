import { describe, expect, test } from 'bun:test';
import { createLogger, type Logger } from '../../src/log';
import { RUN_WATCHDOG_MS, SyncQueue, mergeTriggers } from '../../src/queue';
import { spawnTracked } from '../../src/spawn';
import type { Clock, RunRequest, RunResult, TimerHandle, Trigger } from '../../src/types';

type Line = { level: string; msg: string; [k: string]: unknown };

function testLog(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  return { log: createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(JSON.parse(l) as Line) }), lines };
}

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
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { due: number; fn: () => void }] | undefined;
      for (const e of this.#timers) if (e[1].due <= end && (next === undefined || e[1].due < next[1].due)) next = e;
      if (next === undefined) break;
      this.#timers.delete(next[0]);
      this.t = next[1].due;
      next[1].fn();
    }
    this.t = end;
  }
  pending(): number { return this.#timers.size; }
}

type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function result(req: RunRequest, runId: number, over: Partial<RunResult> = {}): RunResult {
  return {
    runId, kind: req.kind, mode: 'normal', reasons: req.reasons, outcome: 'ok',
    commitStep: req.kind === 'commit' ? 'committed' : 'not-applicable', commitsIn: 0, commitsOut: 0,
    head: 'a'.repeat(40), committed: 'none', conflicts: [], overriddenDeletes: [], keptStashes: [],
    startedAt: new Date(0).toISOString(), durationMs: 1, ...over,
  };
}

// A runner whose runs finish only when the test says so.
function gatedRunner() {
  const calls: { req: RunRequest; runId: number; done: Deferred<RunResult> }[] = [];
  const run = (req: RunRequest, runId: number): Promise<RunResult> => {
    const done = deferred<RunResult>();
    calls.push({ req, runId, done });
    return done.promise;
  };
  const finish = async (i: number, over: Partial<RunResult> = {}): Promise<void> => {
    const c = calls[i];
    if (c === undefined) throw new Error(`run ${i} never started`);
    c.done.resolve(result(c.req, c.runId, over));
    await tick();
    await tick();
  };
  return { calls, run, finish };
}

const flush = (o: { message?: string; paths?: string[]; waiter?: (r: RunResult) => void } = {}): Trigger =>
  ({ kind: 'commit', source: 'flush', ...o });
const pull = (reason: 'startup' | 'ntfy' | 'retry' | 'fallback' | 'wake' = 'ntfy'): Trigger => ({ kind: 'pull-only', reason });
const backup = (timer: 'idle' | 'max-wait' = 'idle'): Trigger => ({ kind: 'commit', source: 'backup', timer });

describe('mergeTriggers', () => {
  test('pull-only triggers stay pull-only, reasons deduped in arrival order', () => {
    const { req, waiters } = mergeTriggers([], [pull('ntfy'), pull('fallback'), pull('ntfy'), pull('wake')]);
    expect(req).toEqual({ kind: 'pull-only', reasons: ['ntfy', 'fallback', 'wake'] });
    expect(waiters).toEqual([]);
  });

  test('any commit trigger makes a commit run; backup labels are the timer names', () => {
    const { req } = mergeTriggers([], [pull('ntfy'), backup('max-wait'), backup('idle')]);
    expect(req).toEqual({
      kind: 'commit',
      commit: { scope: { kind: 'all' }, messages: [], tag: 'auto', sources: ['backup'] },
      reasons: ['ntfy', 'max-wait', 'idle'],
    });
  });

  test('scope is the deduped path union only when every commit trigger is a flush with paths', () => {
    const both = mergeTriggers([], [flush({ paths: ['b.md', 'a.md'] }), pull(), flush({ paths: ['a.md', 'c/d.md'] })]).req;
    expect(both.kind === 'commit' && both.commit.scope).toEqual({ kind: 'paths', paths: ['b.md', 'a.md', 'c/d.md'] });

    const withAll = mergeTriggers([], [flush({ paths: ['a.md'] }), flush({})]).req;
    expect(withAll.kind === 'commit' && withAll.commit.scope).toEqual({ kind: 'all' });

    const withBackup = mergeTriggers([], [flush({ paths: ['a.md'] }), backup()]).req;
    expect(withBackup.kind === 'commit' && withBackup.commit.scope).toEqual({ kind: 'all' });

    const empty = mergeTriggers([], [flush({ paths: [] })]).req;
    expect(empty.kind === 'commit' && empty.commit.scope).toEqual({ kind: 'all' });
  });

  test('messages: flush messages in arrival order, carried first; empty ones dropped', () => {
    const { req } = mergeTriggers([flush({ message: 'carried' })], [flush({ message: 'one' }), backup(), flush({ message: '' }), flush({ message: 'two' })]);
    expect(req.kind === 'commit' && req.commit.messages).toEqual(['carried', 'one', 'two']);
    expect(req.reasons).toEqual(['flush', 'idle']);
  });

  test('tag is auto only when every commit source is backup or shutdown', () => {
    const tag = (ts: Trigger[]): string => {
      const { req } = mergeTriggers([], ts);
      return req.kind === 'commit' ? req.commit.tag : 'pull-only';
    };
    expect(tag([backup()])).toBe('auto');
    expect(tag([{ kind: 'commit', source: 'shutdown' }])).toBe('auto');
    expect(tag([backup(), { kind: 'commit', source: 'shutdown' }, pull()])).toBe('auto');
    expect(tag([backup(), flush()])).toBe('none');
    expect(tag([{ kind: 'commit', source: 'shutdown' }, flush({ message: 'm' })])).toBe('none');
    expect(tag([{ kind: 'commit', source: 'sync-once' }])).toBe('none');
  });

  test('sources deduped in arrival order; waiters collected from flushes', () => {
    const w1 = (): void => {};
    const w2 = (): void => {};
    const { req, waiters } = mergeTriggers([], [flush({ waiter: w1 }), backup(), flush({ waiter: w2 }), { kind: 'commit', source: 'shutdown' }]);
    expect(req.kind === 'commit' && req.commit.sources).toEqual(['flush', 'backup', 'shutdown']);
    expect(req.reasons).toEqual(['flush', 'idle', 'shutdown']);
    expect(waiters).toEqual([w1, w2]);
  });

  test('pure: inputs are not mutated and outputs do not alias them', () => {
    const paths = ['a.md'];
    const ts: Trigger[] = [flush({ paths })];
    const { req } = mergeTriggers([], ts);
    if (req.kind !== 'commit' || req.commit.scope.kind !== 'paths') throw new Error('expected paths scope');
    req.commit.scope.paths.push('x.md');
    expect(paths).toEqual(['a.md']);
  });
});

describe('SyncQueue', () => {
  test('request while idle starts a run at once; logs sync queued started', async () => {
    const { log, lines } = testLog();
    const r = gatedRunner();
    const q = new SyncQueue({ run: r.run, log });
    expect(q.activity()).toBe('idle');
    q.request(pull('startup'));
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]?.runId).toBe(1);
    expect(r.calls[0]?.req).toEqual({ kind: 'pull-only', reasons: ['startup'] });
    expect(q.activity()).toBe('running');
    expect(lines.find((l) => l.msg === 'sync queued')).toMatchObject({ level: 'debug', trigger: 'startup', state: 'started' });
    await r.finish(0);
    expect(q.activity()).toBe('idle');
  });

  test('dirty flag: triggers during a run cause exactly one more run, merged', async () => {
    const { log, lines } = testLog();
    const r = gatedRunner();
    const q = new SyncQueue({ run: r.run, log });
    q.request(pull('startup'));
    q.request(pull('ntfy'));
    q.request(flush({ message: 'a', paths: ['a.md'] }));
    q.request(flush({ message: 'b', paths: ['b.md'] }));
    q.request(pull('ntfy'));
    expect(r.calls.length).toBe(1);
    expect(q.hasPending()).toBe('pending');
    expect(lines.filter((l) => l.msg === 'sync queued').map((l) => l.state)).toEqual(['started', 'pending', 'pending', 'pending', 'pending']);
    await r.finish(0);
    expect(r.calls.length).toBe(2);
    expect(q.hasPending()).toBe('none');
    expect(r.calls[1]?.runId).toBe(2);
    expect(r.calls[1]?.req).toEqual({
      kind: 'commit',
      commit: { scope: { kind: 'paths', paths: ['a.md', 'b.md'] }, messages: ['a', 'b'], tag: 'none', sources: ['flush'] },
      reasons: ['ntfy', 'flush'],
    });
    await r.finish(1);
    expect(r.calls.length).toBe(2);
    expect(q.activity()).toBe('idle');
  });

  test('waiters resolve with the result of the run that consumed their trigger', async () => {
    const { log } = testLog();
    const r = gatedRunner();
    const q = new SyncQueue({ run: r.run, log });
    const got: [string, number][] = [];
    q.request(flush({ waiter: (res) => got.push(['first', res.runId]) }));
    q.request(flush({ waiter: (res) => got.push(['second', res.runId]) }));   // mid-run: waits for run 2
    await r.finish(0, { commitsOut: 1 });
    expect(got).toEqual([['first', 1]]);
    await r.finish(1);
    expect(got).toEqual([['first', 1], ['second', 2]]);
  });

  test('a rejecting runner becomes a failed result; waiters get it and the queue continues', async () => {
    const { log, lines } = testLog();
    let n = 0;
    const seen: RunResult[] = [];
    const q = new SyncQueue({
      log,
      run: async (req, runId) => {
        n++;
        if (n === 1) throw new Error('boom\nsecond line');
        return result(req, runId);
      },
      hooks: { onRunEnd: async (_req, res) => { seen.push(res); } },
    });
    let waited: RunResult | undefined;
    q.request(flush({ message: 'm', waiter: (res) => { waited = res; } }));
    q.request(pull('ntfy'));
    await q.whenIdle();
    expect(n).toBe(2);
    expect(waited).toMatchObject({ runId: 1, kind: 'commit', outcome: 'failed', commitStep: 'not-reached', error: 'boom second line' });
    expect(seen.map((s) => s.outcome)).toEqual(['failed', 'ok']);
    expect(lines.find((l) => l.msg === 'callback failed')).toMatchObject({ level: 'error', source: 'queue.run', error: 'boom second line' });
  });

  test('a failed pull-only safety-net result is not-applicable', async () => {
    const { log } = testLog();
    let res: RunResult | undefined;
    const q = new SyncQueue({
      log,
      run: () => Promise.reject(new Error('x')),
      hooks: { onRunEnd: async (_q, r) => { res = r; } },
    });
    q.request(pull('fallback'));
    await q.whenIdle();
    expect(res).toMatchObject({ kind: 'pull-only', outcome: 'failed', commitStep: 'not-applicable', reasons: ['fallback'] });
  });

  test('carry: never starts a run; folded into the next run of any kind with its message and paths', async () => {
    const { log } = testLog();
    const r = gatedRunner();
    const consumed: Trigger[][] = [];
    const q = new SyncQueue({ run: r.run, log, hooks: { onRunEnd: async (_req, _res, c) => { consumed.push([...c]); } } });
    let waiterCalls = 0;
    q.carry([flush({ message: 'kept', paths: ['n.md'], waiter: () => { waiterCalls++; } }), pull('ntfy')]);
    await tick();
    expect(r.calls.length).toBe(0);
    expect(q.activity()).toBe('idle');
    expect(q.hasPending()).toBe('none');
    await q.whenIdle();   // carry is ignored by whenIdle

    q.request(pull('retry'));
    expect(r.calls[0]?.req).toEqual({
      kind: 'commit',
      commit: { scope: { kind: 'paths', paths: ['n.md'] }, messages: ['kept'], tag: 'none', sources: ['flush'] },
      reasons: ['flush', 'retry'],
    });
    await r.finish(0);
    expect(waiterCalls).toBe(0);   // waiters are stripped
    expect(consumed[0]).toEqual([{ kind: 'commit', source: 'flush', message: 'kept', paths: ['n.md'] }, pull('retry')]);

    q.request(pull('ntfy'));   // the carry was cleared when consumed
    expect(r.calls[1]?.req).toEqual({ kind: 'pull-only', reasons: ['ntfy'] });
    await r.finish(1);
  });

  test('carry called from onRunEnd joins the run that the pending triggers start', async () => {
    const { log } = testLog();
    const r = gatedRunner();
    const q = new SyncQueue({ run: r.run, log });
    q.setHooks({
      onRunEnd: async (req, res, consumed) => {
        if (req.kind === 'commit' && res.commitStep === 'not-reached') q.carry(consumed);
      },
    });
    q.request(flush({ message: 'deferred', paths: ['a.md'] }));
    q.request(pull('ntfy'));
    await r.finish(0, { outcome: 'busy', commitStep: 'not-reached' });
    expect(r.calls[1]?.req).toEqual({
      kind: 'commit',
      commit: { scope: { kind: 'paths', paths: ['a.md'] }, messages: ['deferred'], tag: 'none', sources: ['flush'] },
      reasons: ['flush', 'ntfy'],
    });
    await r.finish(1);
  });

  test('hold/release: requests accumulate while held, then one merged run', async () => {
    const { log, lines } = testLog();
    const r = gatedRunner();
    const q = new SyncQueue({ run: r.run, log });
    q.hold();
    q.request(flush({ message: 'early' }));
    q.request(pull('ntfy'));
    await tick();
    expect(r.calls.length).toBe(0);
    expect(q.activity()).toBe('idle');
    expect(q.hasPending()).toBe('pending');
    expect(lines.filter((l) => l.msg === 'sync queued').map((l) => l.state)).toEqual(['held', 'held']);
    const idle = { state: 'waiting' as 'idle' | 'waiting' };
    void q.whenIdle().then(() => { idle.state = 'idle'; });
    await tick();
    expect(idle.state).toBe('waiting');   // pending triggers keep whenIdle waiting while held
    q.request(pull('startup'));
    q.release();
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]?.req.reasons).toEqual(['flush', 'ntfy', 'startup']);
    await r.finish(0);
    expect(idle.state).toBe('idle');
  });

  test('hold during a run: the pending run waits for release', async () => {
    const { log } = testLog();
    const r = gatedRunner();
    const q = new SyncQueue({ run: r.run, log });
    q.request(pull('startup'));
    q.hold();
    q.request(pull('ntfy'));
    await r.finish(0);
    expect(r.calls.length).toBe(1);
    expect(q.activity()).toBe('idle');
    q.release();
    expect(r.calls.length).toBe(2);
    await r.finish(1);
  });

  test('setHooks merges into the current hooks', async () => {
    const { log } = testLog();
    const events: string[] = [];
    const q = new SyncQueue({
      log,
      run: async (req, runId) => result(req, runId),
      hooks: { onRunStart: (_req, id) => { events.push(`start-${id}`); } },
    });
    q.setHooks({ onRunEnd: async (_req, res) => { events.push(`end-${res.runId}`); } });
    q.request(pull());
    await q.whenIdle();
    q.setHooks({ onRunStart: (_req, id) => { events.push(`start2-${id}`); } });
    q.request(pull());
    await q.whenIdle();
    expect(events).toEqual(['start-1', 'end-1', 'start2-2', 'end-2']);
  });

  test('onRunStart runs synchronously before run()', () => {
    const { log } = testLog();
    const order: string[] = [];
    const q = new SyncQueue({
      log,
      run: async (req, runId) => { order.push('run'); return result(req, runId); },
      hooks: { onRunStart: () => { order.push('start'); } },
    });
    q.request(pull());
    expect(order).toEqual(['start', 'run']);
  });

  test('onRunEnd is awaited before the next run starts and by whenIdle; waiters after it', async () => {
    const { log } = testLog();
    const r = gatedRunner();
    const gate = deferred<void>();
    const order: string[] = [];
    const q = new SyncQueue({
      run: r.run,
      log,
      hooks: { onRunEnd: async (_req, res) => { order.push(`end-start-${res.runId}`); if (res.runId === 1) await gate.promise; order.push(`end-done-${res.runId}`); } },
    });
    q.request(flush({ waiter: () => order.push('waiter-1') }));
    q.request(pull('ntfy'));
    const idle = { state: 'waiting' as 'idle' | 'waiting' };
    void q.whenIdle().then(() => { idle.state = 'idle'; });
    await r.finish(0);
    expect(r.calls.length).toBe(1);   // onRunEnd of run 1 still pending
    expect(q.activity()).toBe('running');
    expect(order).toEqual(['end-start-1']);
    gate.resolve();
    await tick();
    expect(order).toEqual(['end-start-1', 'end-done-1', 'waiter-1']);
    expect(r.calls.length).toBe(2);
    expect(idle.state).toBe('waiting');
    await r.finish(1);
    expect(idle.state).toBe('idle');
  });

  test('throwing hooks and waiters are logged as callback failed and never stop the queue', async () => {
    const { log, lines } = testLog();
    const q = new SyncQueue({
      log,
      run: async (req, runId) => result(req, runId),
      hooks: {
        onRunStart: () => { throw new Error('start hook'); },
        onRunEnd: async () => { throw new Error('end hook'); },
      },
    });
    q.request(flush({ waiter: () => { throw new Error('waiter'); } }));
    await q.whenIdle();
    q.request(pull());
    await q.whenIdle();
    const failed = lines.filter((l) => l.msg === 'callback failed').map((l) => [l.source, l.error]);
    expect(failed).toEqual([
      ['queue.onRunStart', 'start hook'], ['queue.onRunEnd', 'end hook'], ['queue.waiter', 'waiter'],
      ['queue.onRunStart', 'start hook'], ['queue.onRunEnd', 'end hook'],
    ]);
  });

  test('whenIdle resolves at once when idle', async () => {
    const { log } = testLog();
    const q = new SyncQueue({ log, run: async (req, runId) => result(req, runId) });
    await q.whenIdle();
    expect(q.activity()).toBe('idle');
  });

  test('watchdog: a stuck run logs run stuck once and kills our children, letting the run settle', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    let child: Promise<number> | undefined;
    const q = new SyncQueue({
      log,
      clock,
      run: async (req, runId) => {
        child = spawnTracked(['sleep', '30'], { cwd: '/', env: process.env, timeoutMs: 60_000 }).then((r) => r.code);
        await child;
        return result(req, runId, { outcome: 'failed', error: 'killed' });
      },
    });
    q.request(pull());
    await Bun.sleep(50);
    clock.advance(RUN_WATCHDOG_MS - 1);
    expect(lines.some((l) => l.msg === 'run stuck')).toBe(false);
    clock.advance(1);
    const stuck = lines.filter((l) => l.msg === 'run stuck');
    expect(stuck).toEqual([expect.objectContaining({ level: 'error', runId: 1, elapsedMs: RUN_WATCHDOG_MS })]);
    expect(await child).toBe(143);   // SIGTERM
    await q.whenIdle();
    clock.advance(RUN_WATCHDOG_MS * 2);
    expect(lines.filter((l) => l.msg === 'run stuck').length).toBe(1);
    expect(clock.pending()).toBe(0);   // the watchdog is cleared when the run ends
  });

  test('watchdogMs option overrides the default', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const r = gatedRunner();
    const q = new SyncQueue({ log, clock, run: r.run, watchdogMs: 5_000 });
    q.request(pull());
    clock.advance(5_000);
    expect(lines.filter((l) => l.msg === 'run stuck').length).toBe(1);
    await r.finish(0);
    expect(q.activity()).toBe('idle');
  });

  test('a run that finishes in time never logs run stuck', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const q = new SyncQueue({ log, clock, run: async (req, runId) => result(req, runId) });
    q.request(pull());
    await q.whenIdle();
    expect(clock.pending()).toBe(0);
    clock.advance(RUN_WATCHDOG_MS * 2);
    expect(lines.some((l) => l.msg === 'run stuck')).toBe(false);
  });
});
