import { afterEach, describe, expect, test } from 'bun:test';
import { createLogger, type Logger } from '../../src/log';
import { startNtfy, type NtfyHandle } from '../../src/ntfy';
import type { Clock, TimerHandle } from '../../src/types';

type Line = { level: string; msg: string; [k: string]: unknown };

function testLog(): { log: Logger; lines: Line[]; raw: string[] } {
  const lines: Line[] = [];
  const raw: string[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => { raw.push(l); lines.push(JSON.parse(l) as Line); } });
  return { log, lines, raw };
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
      this.t = Math.max(this.t, next[1].due);
      next[1].fn();
    }
    this.t = end;
  }
}

async function until(pred: () => boolean, label = 'condition', timeoutMs = 2_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(2);
  }
}

type Call = { url: string; signal: AbortSignal; respond(r: Response): void; fail(e: unknown): void };

// fetch stand-in. 'honor-signal' rejects on abort like real fetch; 'ignore-signal' never settles on its own.
function fakeFetch(mode: 'honor-signal' | 'ignore-signal' = 'honor-signal') {
  const calls: Call[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? new AbortController().signal;
    if (mode === 'honor-signal') signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    calls.push({ url: String(url), signal, respond: resolve, fail: reject });
  })) as unknown as typeof fetch;
  return { calls, impl };
}

// contentType 'none': no content-type header at all (a bare proxy 200)
function sseBody(status = 200, contentType: string | 'none' = 'text/event-stream') {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; }, cancel() { cancelled++; } });
  const res = new Response(body, { status, ...(contentType !== 'none' ? { headers: { 'content-type': contentType } } : {}) });
  if (contentType === 'none') res.headers.delete('content-type');
  return {
    res,
    send(s: string): void { ctrl.enqueue(new TextEncoder().encode(s)); },
    end(): void { ctrl.close(); },
    cancelled: (): number => cancelled,
  };
}

const URL_ = 'https://ntfy.example/my-secret-topic-123/';
const SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const message = (m: string): string => `data: ${JSON.stringify({ id: 'i', time: 1, event: 'message', topic: 't', message: m })}\n\n`;

let handles: NtfyHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.map((h) => h.stop()));
  handles = [];
});

function start(o: { clock: ManualClock; fetch: ReturnType<typeof fakeFetch>; log: Logger }) {
  const connects: string[] = [];
  const shas: string[] = [];
  const h = startNtfy({
    url: URL_, log: o.log, clock: o.clock, fetchImpl: o.fetch.impl,
    onConnect: (n) => connects.push(n), onSha: (s) => shas.push(s),
  });
  handles.push(h);
  return { h, connects, shas };
}

const disconnects = (lines: Line[]): Line[] => lines.filter((l) => l.msg === 'ntfy disconnected');

describe('startNtfy', () => {
  test('connects to <url>/sse, reports first connect, delivers shas, logs ignored messages', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { connects, shas } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    expect(f.calls[0]?.url).toBe('https://ntfy.example/my-secret-topic-123/sse');
    const body = sseBody();
    f.calls[0]?.respond(body.res);
    await until(() => connects.length === 1, 'connect');
    expect(connects).toEqual(['first']);
    expect(lines.find((l) => l.msg === 'ntfy connected')).toMatchObject({ level: 'info', host: 'ntfy.example', attempt: 'first' });

    body.send(`event: open\ndata: ${JSON.stringify({ id: 'o', event: 'open', topic: 't' })}\n\n`);
    body.send(message(SHA.toUpperCase()).slice(0, 20));
    body.send(message(SHA.toUpperCase()).slice(20));
    body.send(message('not a sha'));
    await until(() => shas.length === 1, 'sha');
    await until(() => lines.filter((l) => l.msg === 'ntfy message ignored').length === 2, 'ignored');
    expect(shas).toEqual([SHA]);
    expect(lines.filter((l) => l.msg === 'ntfy message ignored').map((l) => [l.level, l.reason])).toEqual([['debug', 'not-message'], ['debug', 'not-sha']]);
  });

  test('a self-hosted topic URL with a query (`?auth=…`): /sse goes on the path, the query stays, neither is logged', async () => {
    const { log, raw } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const h = startNtfy({ url: 'https://ntfy.example/private-topic?auth=QmVhcmVyIHNlY3JldA', log, clock, fetchImpl: f.impl,
      onConnect: () => {}, onSha: () => {} });
    handles.push(h);
    await until(() => f.calls.length === 1, 'fetch');
    expect(f.calls[0]?.url).toBe('https://ntfy.example/private-topic/sse?auth=QmVhcmVyIHNlY3JldA');
    f.calls[0]?.fail(new Error('boom https://ntfy.example/private-topic/sse?auth=QmVhcmVyIHNlY3JldA'));
    await until(() => raw.some((l) => l.includes('ntfy disconnected')), 'disconnect');
    expect(raw.join('\n')).not.toContain('QmVhcmVyIHNlY3JldA');
    expect(raw.join('\n')).not.toContain('private-topic');
  });

  test('onData fires for every chunk (keepalives too) and onDisconnect gets the redacted error; neither after stop()', async () => {
    const { log } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const data: number[] = [];
    const drops: { error: string; retryInMs: number }[] = [];
    const h = startNtfy({ url: URL_, log, clock, fetchImpl: f.impl, onConnect: () => {}, onSha: () => {},
      onData: () => data.push(clock.now()), onDisconnect: (d) => drops.push(d) });
    handles.push(h);
    await until(() => f.calls.length === 1, 'fetch');
    f.calls[0]?.fail(new Error('connect to https://ntfy.example/my-secret-topic-123/sse failed'));
    await until(() => drops.length === 1, 'first drop');
    expect(drops[0]).toEqual({ error: 'connect to https://ntfy.example/***/sse failed', retryInMs: 1_000 });
    clock.advance(1_000);
    await until(() => f.calls.length === 2, 'retry');
    const body = sseBody();
    f.calls[1]?.respond(body.res);
    body.send(': keepalive\n\n');
    body.send(message(SHA));
    await until(() => data.length === 2, 'two chunks');
    expect(drops.length).toBe(1);
    await h.stop();
    expect(drops.length).toBe(1);
  });

  test('a fetch that never resolves is aborted by the 120 s watchdog', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    clock.advance(119_999);
    await Bun.sleep(5);
    expect(f.calls[0]?.signal.aborted).toBe(false);
    clock.advance(1);
    await until(() => disconnects(lines).length === 1, 'disconnect');
    expect(f.calls[0]?.signal.aborted).toBe(true);
    expect(disconnects(lines)[0]).toMatchObject({ level: 'warn', error: 'no data for 120 s', retryInMs: 1_000 });
    clock.advance(1_000);
    await until(() => f.calls.length === 2, 'retry fetch');
  });

  test('the watchdog also covers a fetch implementation that ignores the signal', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch('ignore-signal');
    start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    clock.advance(120_000);
    await until(() => disconnects(lines).length === 1, 'disconnect');
    expect(disconnects(lines)[0]).toMatchObject({ error: 'no data for 120 s' });
    const late = sseBody();
    f.calls[0]?.respond(late.res);   // arrives after the abort: its body is cancelled
    await until(() => late.cancelled() === 1, 'late body cancelled');
  });

  test('every chunk resets the watchdog; silence after the last one aborts the read', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const body = sseBody();
    f.calls[0]?.respond(body.res);
    await until(() => lines.some((l) => l.msg === 'ntfy connected'), 'connected');
    for (let i = 0; i < 3; i++) {
      clock.advance(100_000);
      body.send(': keepalive\n\n');
      await Bun.sleep(5);
    }
    expect(disconnects(lines)).toEqual([]);
    clock.advance(120_000);
    await until(() => disconnects(lines).length === 1, 'disconnect');
    expect(disconnects(lines)[0]).toMatchObject({ error: 'no data for 120 s' });
    expect(body.cancelled()).toBe(1);
  });

  test('non-2xx cancels the body and counts as a failure; the backoff grows', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { connects } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const b1 = sseBody(503);
    f.calls[0]?.respond(b1.res);
    await until(() => disconnects(lines).length === 1, 'first failure');
    expect(b1.cancelled()).toBe(1);
    expect(disconnects(lines)[0]).toMatchObject({ error: 'HTTP 503', retryInMs: 1_000 });
    clock.advance(1_000);
    await until(() => f.calls.length === 2, 'second fetch');
    f.calls[1]?.respond(sseBody(404).res);
    await until(() => disconnects(lines).length === 2, 'second failure');
    expect(disconnects(lines)[1]).toMatchObject({ error: 'HTTP 404', retryInMs: 2_000 });
    clock.advance(1_999);
    await Bun.sleep(5);
    expect(f.calls.length).toBe(2);
    clock.advance(1);
    await until(() => f.calls.length === 3, 'third fetch');
    expect(connects).toEqual([]);
    expect(lines.some((l) => l.msg === 'ntfy connected')).toBe(false);
  });

  test('a 200 that is not an event stream (a web app, a captive portal, a bare proxy) is a failure, never connected', async () => {
    const { log, lines, raw } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { connects } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const html = sseBody(200, 'text/html; charset=utf-8');
    f.calls[0]?.respond(html.res);
    await until(() => disconnects(lines).length === 1, 'first failure');
    expect(html.cancelled()).toBe(1);
    expect(disconnects(lines)[0]).toMatchObject({ level: 'warn', retryInMs: 1_000,
      error: 'not an event stream (text/html): check that ntfyUrl names a topic' });
    clock.advance(1_000);
    await until(() => f.calls.length === 2, 'second fetch');
    const bare = sseBody(200, 'none');
    f.calls[1]?.respond(bare.res);
    await until(() => disconnects(lines).length === 2, 'second failure');
    expect(bare.cancelled()).toBe(1);
    expect(disconnects(lines)[1]).toMatchObject({ retryInMs: 2_000,   // counted like a non-2xx: the backoff grows
      error: 'not an event stream (no content type): check that ntfyUrl names a topic' });
    clock.advance(2_000);
    await until(() => f.calls.length === 3, 'third fetch');
    f.calls[2]?.respond(sseBody(200, `application/${'x'.repeat(200)}; charset=utf-8`).res);
    await until(() => disconnects(lines).length === 3, 'third failure');
    expect(disconnects(lines)[2]?.error).toBe(`not an event stream (application/${'x'.repeat(88)}): check that ntfyUrl names a topic`);
    expect(connects).toEqual([]);
    expect(lines.some((l) => l.msg === 'ntfy connected')).toBe(false);
    expect(raw.join('\n')).not.toContain('my-secret-topic-123');
  });

  test('`text/event-stream; charset=utf-8` (as ntfy.sh sends it) connects, in any case', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { connects, shas } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const body = sseBody(200, ' Text/Event-Stream ; charset=utf-8');
    f.calls[0]?.respond(body.res);
    await until(() => connects.length === 1, 'connect');
    body.send(message(SHA));
    await until(() => shas.length === 1, 'sha');
    expect(lines.find((l) => l.msg === 'ntfy connected')).toMatchObject({ attempt: 'first' });
    expect(disconnects(lines)).toEqual([]);
  });

  test('stop() interrupts the backoff sleep and resolves once the loop exits', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { h } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    f.calls[0]?.fail(new TypeError('connection refused'));
    await until(() => disconnects(lines).length === 1, 'failure');
    const t0 = performance.now();
    await h.stop();
    expect(performance.now() - t0).toBeLessThan(500);
    clock.advance(10 * 60_000);
    await Bun.sleep(5);
    expect(f.calls.length).toBe(1);
    await h.stop();   // idempotent
  });

  test('stop() aborts an open stream without logging a disconnect', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { h } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const body = sseBody();
    f.calls[0]?.respond(body.res);
    await until(() => lines.some((l) => l.msg === 'ntfy connected'), 'connected');
    await h.stop();
    expect(body.cancelled()).toBe(1);
    expect(disconnects(lines)).toEqual([]);
  });

  test('stream end reconnects; the second connect reports reconnect', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { connects } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const b1 = sseBody();
    f.calls[0]?.respond(b1.res);
    await until(() => connects.length === 1, 'first connect');
    b1.end();
    await until(() => disconnects(lines).length === 1, 'disconnect');
    expect(disconnects(lines)[0]).toMatchObject({ error: 'stream ended', retryInMs: 1_000 });
    clock.advance(1_000);
    await until(() => f.calls.length === 2, 'second fetch');
    f.calls[1]?.respond(sseBody().res);
    await until(() => connects.length === 2, 'second connect');
    expect(connects).toEqual(['first', 'reconnect']);
    expect(lines.filter((l) => l.msg === 'ntfy connected').map((l) => l.attempt)).toEqual(['first', 'reconnect']);
  });

  test('a connection that lived >= 60 s resets the failure count', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    f.calls[0]?.fail(new TypeError('down'));
    await until(() => disconnects(lines).length === 1, 'failure 1');
    clock.advance(1_000);
    await until(() => f.calls.length === 2, 'fetch 2');
    f.calls[1]?.fail(new TypeError('down'));
    await until(() => disconnects(lines).length === 2, 'failure 2');
    expect(disconnects(lines)[1]?.retryInMs).toBe(2_000);
    clock.advance(2_000);
    await until(() => f.calls.length === 3, 'fetch 3');
    const short = sseBody();
    f.calls[2]?.respond(short.res);
    await until(() => lines.filter((l) => l.msg === 'ntfy connected').length === 1, 'connect 1');
    clock.advance(59_000);
    short.end();
    await until(() => disconnects(lines).length === 3, 'short-lived end');
    expect(disconnects(lines)[2]?.retryInMs).toBe(4_000);   // 59 s: no reset
    clock.advance(4_000);
    await until(() => f.calls.length === 4, 'fetch 4');
    const long = sseBody();
    f.calls[3]?.respond(long.res);
    await until(() => lines.filter((l) => l.msg === 'ntfy connected').length === 2, 'connect 2');
    for (let i = 0; i < 2; i++) {
      clock.advance(30_000);
      long.send(': keepalive\n\n');
      await Bun.sleep(5);
    }
    long.end();
    await until(() => disconnects(lines).length === 4, 'long-lived end');
    expect(disconnects(lines)[3]?.retryInMs).toBe(1_000);   // 60 s: reset, then the first failure
  });

  test('reconnectNow() drops a live connection and reconnects at once without counting a failure', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { h, connects } = start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const b1 = sseBody();
    f.calls[0]?.respond(b1.res);
    await until(() => connects.length === 1, 'connect');
    h.reconnectNow();
    await until(() => f.calls.length === 2, 'immediate refetch');
    expect(b1.cancelled()).toBe(1);
    expect(disconnects(lines)[0]).toMatchObject({ error: 'reconnect requested', retryInMs: 0 });
    f.calls[1]?.fail(new TypeError('down'));
    await until(() => disconnects(lines).length === 2, 'failure');
    expect(disconnects(lines)[1]?.retryInMs).toBe(1_000);   // the requested reconnect did not count
  });

  test('reconnectNow() skips the remaining backoff delay', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const { h } = start({ clock, fetch: f, log });
    for (let i = 0; i < 4; i++) {
      await until(() => f.calls.length === i + 1, `fetch ${i}`);
      f.calls[i]?.fail(new TypeError('down'));
      await until(() => disconnects(lines).length === i + 1, `failure ${i}`);
      if (i < 3) clock.advance(2 ** i * 1_000);
    }
    expect(disconnects(lines)[3]?.retryInMs).toBe(8_000);
    h.reconnectNow();
    await until(() => f.calls.length === 5, 'refetch without waiting');
  });

  test('a line longer than SSE_MAX_LINE aborts and reconnects', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    const body = sseBody();
    f.calls[0]?.respond(body.res);
    await until(() => lines.some((l) => l.msg === 'ntfy connected'), 'connected');
    body.send(`data: ${'x'.repeat(70_000)}`);
    await until(() => disconnects(lines).length === 1, 'disconnect');
    expect(disconnects(lines)[0]).toMatchObject({ error: 'SSE line too long', retryInMs: 1_000 });
    expect(body.cancelled()).toBe(1);
  });

  test('a throwing callback is logged and does not drop the connection', async () => {
    const { log, lines } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    const shas: string[] = [];
    const h = startNtfy({
      url: URL_, log, clock, fetchImpl: f.impl,
      onConnect: () => { throw new Error('connect hook'); },
      onSha: (s) => { shas.push(s); if (shas.length === 1) throw new Error('sha hook'); },
    });
    handles.push(h);
    await until(() => f.calls.length === 1, 'fetch');
    const body = sseBody();
    f.calls[0]?.respond(body.res);
    body.send(message(SHA) + message('abcdef1'));
    await until(() => shas.length === 2, 'both shas');
    expect(lines.filter((l) => l.msg === 'callback failed').map((l) => [l.source, l.error])).toEqual([
      ['ntfy.onConnect', 'connect hook'], ['ntfy.onSha', 'sha hook'],
    ]);
    expect(disconnects(lines)).toEqual([]);
  });

  test('the topic never appears in a log line', async () => {
    const { log, lines, raw } = testLog();
    const clock = new ManualClock();
    const f = fakeFetch();
    start({ clock, fetch: f, log });
    await until(() => f.calls.length === 1, 'fetch');
    f.calls[0]?.fail(new TypeError('Unable to connect to https://ntfy.example/my-secret-topic-123/sse'));
    await until(() => disconnects(lines).length === 1, 'failure');
    expect(raw.join('\n')).not.toContain('my-secret-topic-123');
    expect(String(disconnects(lines)[0]?.error)).toContain('ntfy.example/***');
  });
});
