// Replays recorded and synthesized ntfy server responses (test/fixtures/ntfy/<case>/, see its README.md) through a real
// HTTP server and real fetch, with startNtfy's timers on a manual clock. The cases pin current behavior: a case's `gap`
// names behavior that looks wrong and is not fixed here.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createLogger, type Logger } from '../../src/log';
import { startNtfy } from '../../src/ntfy';
import type { Clock, TimerHandle } from '../../src/types';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'ntfy');
const CASE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Bun.serve sets these itself, and sends any streamed body with chunked encoding whatever the case says.
const SERVER_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'date']);

// ---- case.json ----

const Chunk = z.union([z.string(), z.strictObject({ repeat: z.string().min(1), times: z.int().positive() })]);

const HttpResponse = z.strictObject({
  status: z.int().min(200).max(599),
  headers: z.record(z.string(), z.string()).default({}),
  chunks: z.array(Chunk).optional(),
  bodyFile: z.string().regex(/^body\.[a-z0-9]+$/, 'expected body.<ext> in the case folder').optional(),
  splitAt: z.array(z.int().positive()).min(1).optional(),
  end: z.enum(['close', 'hang', 'reset']),
}).superRefine((r, ctx) => {
  if ((r.chunks === undefined) === (r.bodyFile === undefined)) ctx.addIssue({ code: 'custom', message: 'give exactly one of chunks or bodyFile' });
  if (r.splitAt !== undefined && r.bodyFile === undefined) ctx.addIssue({ code: 'custom', path: ['splitAt'], message: 'splitAt needs bodyFile' });
  for (const k of Object.keys(r.headers)) {
    if (SERVER_HEADERS.has(k.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['headers', k], message: 'the server sets this header; leave it out' });
  }
});

const Disconnect = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  error: z.string().min(1),
  retryInMs: z.int().min(0),
});

const CaseFile = z.strictObject({
  note: z.string().min(1),
  source: z.string().regex(/^(captured: \S+ \d{4}-\d{2}-\d{2}\b.*|synthesized: \S.*)$/,
    'expected "captured: <host> <YYYY-MM-DD>" or "synthesized: <what it is based on>"'),
  gap: z.string().min(1).optional(),
  url: z.string().startsWith('/').default('/{topic}'),
  response: z.unknown(),
  expect: z.strictObject({
    connects: z.int().min(0),
    shas: z.array(z.string().regex(/^[0-9a-f]{7,64}$/)),
    ignored: z.array(z.enum(['not-message', 'bad-json', 'not-sha'])),
    disconnects: z.array(Disconnect).min(1).max(5),
    advanceMs: z.int().positive().optional(),
  }),
});

type Script =
  | { kind: 'refused' }
  | { kind: 'no-headers' }
  | { kind: 'http'; status: number; headers: Record<string, string>; segments: Uint8Array[]; end: 'close' | 'hang' | 'reset' };
type Case = Omit<z.infer<typeof CaseFile>, 'response'> & { script: Script };

const enc = new TextEncoder();

function check<T>(schema: z.ZodType<T>, raw: unknown, where: string): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`${where} is malformed:\n${z.prettifyError(r.error)}`);
  return r.data;
}

// readBody: a body file's bytes, or 'missing'. `where` names the file in every error.
function parseCase(raw: unknown, where: string, readBody: (file: string) => Uint8Array | 'missing'): Case {
  const { response, ...c } = check(CaseFile, raw, where);
  const keys = typeof response === 'object' && response !== null ? Object.keys(response) : [];
  const fail = (msg: string): never => { throw new Error(`${where} is malformed:\n✖ ${msg}\n  → at response`); };
  let script: Script;
  if (keys.includes('network')) {
    check(z.strictObject({ network: z.literal('refused') }), response, `${where} (response)`);
    script = { kind: 'refused' };
  } else if ((response as { end?: unknown } | null)?.end === 'no-headers') {
    check(z.strictObject({ end: z.literal('no-headers') }), response, `${where} (response)`);
    script = { kind: 'no-headers' };
  } else {
    const r = check(HttpResponse, response, `${where} (response)`);
    let segments: Uint8Array[];
    if (r.bodyFile !== undefined) {
      const bytes = readBody(r.bodyFile);
      if (bytes === 'missing') return fail(`bodyFile ${r.bodyFile} does not exist`);
      const cuts = [0, ...(r.splitAt ?? []), bytes.byteLength];
      if (cuts.some((n, i) => i > 0 && n <= (cuts[i - 1] ?? 0))) fail(`splitAt must increase and stay below ${bytes.byteLength}`);
      segments = cuts.slice(1).map((n, i) => bytes.subarray(cuts[i], n));
    } else {
      segments = (r.chunks ?? []).map((ch) => enc.encode(typeof ch === 'string' ? ch : ch.repeat.repeat(ch.times)));
    }
    if (segments.length === 0 && r.end !== 'close') fail(`end "${r.end}" needs a body: Bun.serve sends no headers before the first chunk`);
    script = { kind: 'http', status: r.status, headers: r.headers, segments, end: r.end };
  }
  if (script.kind === 'http' && script.end === 'reset' && c.expect.disconnects.length > 1) {
    fail('end "reset" stops the server, so it allows only one attempt (one entry in expect.disconnects)');
  }
  return { ...c, script };
}

function loadCase(name: string): Case {
  const dir = join(FIXTURES, name);
  const where = `test/fixtures/ntfy/${name}/case.json`;
  if (!CASE_NAME.test(name)) throw new Error(`test/fixtures/ntfy/${name}: case names are lowercase-kebab-case`);
  if (!existsSync(join(dir, 'case.json'))) throw new Error(`${where} is missing`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
  } catch (e) {
    throw new Error(`${where} is not JSON: ${(e as Error).message}`);
  }
  const used = new Set(['case.json']);
  const c = parseCase(raw, where, (file) => {
    used.add(file);
    return existsSync(join(dir, file)) ? new Uint8Array(readFileSync(join(dir, file))) : 'missing';
  });
  const stray = readdirSync(dir).filter((f) => !used.has(f));
  if (stray.length > 0) throw new Error(`test/fixtures/ntfy/${name} has files case.json does not use: ${stray.join(', ')}`);
  return c;
}

// ---- test plumbing (adapted from ntfy-client.test.ts) ----

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
  pending(): number { return this.#timers.size; }
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

async function until(pred: () => boolean, label = 'condition', timeoutMs = 3_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(2);
  }
}

const disconnects = (lines: Line[]): Line[] => lines.filter((l) => l.msg === 'ntfy disconnected');

// ---- the client side: real fetch, with the body passed through an observer ----

// What the client has read of one response. `reads` is 'waiting' once startNtfy has consumed every byte handed to it
// and asked for more, so its watchdog kick and parsing for those bytes are done. `readEnds` holds the byte offset at the
// end of every read, which proves where chunk boundaries fell.
type Observer = { received: number; readEnds: number[]; reads: 'reading' | 'waiting'; body: 'open' | 'ended' };

function observedFetch(observers: Observer[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const obs: Observer = { received: 0, readEnds: [], reads: 'reading', body: 'open' };
    observers.push(obs);
    const res = await fetch(input, init);
    const inner = res.body?.getReader();
    if (inner === undefined) {
      obs.body = 'ended';
      return res;
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        obs.reads = 'waiting';
        let r: Awaited<ReturnType<typeof inner.read>>;
        try {
          r = await inner.read();
        } catch (e) {
          obs.body = 'ended';
          throw e;   // the same error object reaches startNtfy
        }
        obs.reads = 'reading';
        if (obs.body === 'ended') return;   // cancelled while the read was pending
        if (r.done) {
          obs.body = 'ended';
          ctrl.close();
          return;
        }
        obs.received += r.value.byteLength;
        obs.readEnds.push(obs.received);
        ctrl.enqueue(r.value);
      },
      cancel(reason) {
        obs.body = 'ended';
        return inner.cancel(reason);
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

// ---- the server side ----

type Life = { state: 'running' | 'closed' };
type Served = { path: string; script: 'sending' | 'done' };
type Stub = { port: number; served: Served[]; close(): Promise<void> };

async function closedPort(): Promise<Stub> {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null) });
  const port = s.port ?? 0;
  await s.stop(true);
  return { port, served: [], close: async () => {} };
}

// One request per attempt. Chunk k+1 goes out only once the client has read and processed chunks 0..k, so the client
// never sees two chunks merged into one read.
function stubServer(script: Exclude<Script, { kind: 'refused' }>, observers: Observer[], life: Life): Stub {
  const served: Served[] = [];
  const parked: Array<() => void> = [];
  const caughtUp = async (obs: Observer, sent: number): Promise<void> => {
    while (life.state === 'running' && obs.body === 'open' && (obs.received < sent || obs.reads !== 'waiting')) await Bun.sleep(1);
  };
  let state: 'up' | 'down' = 'up';
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch(req) {
      const u = new URL(req.url);
      const s: Served = { path: u.pathname + u.search, script: 'sending' };
      served.push(s);
      if (script.kind === 'no-headers') {
        s.script = 'done';
        return new Promise<Response>((resolve) => parked.push(() => resolve(new Response(null, { status: 503 }))));
      }
      const { status, headers, segments, end } = script;
      const obs = observers[served.length - 1];
      if (obs === undefined) throw new Error('a request arrived without a matching fetch');
      if (end === 'close' && segments.length <= 1) {
        s.script = 'done';
        return new Response(segments[0] ?? null, { status, headers });   // a fixed body, sent with Content-Length
      }
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          void (async () => {
            let sent = 0;
            for (const [k, seg] of segments.entries()) {
              if (k > 0) await caughtUp(obs, sent);
              if (life.state === 'closed' || obs.body === 'ended') return;
              ctrl.enqueue(seg);
              sent += seg.byteLength;
            }
            if (end === 'close') {
              ctrl.close();
            } else if (end === 'reset') {
              await caughtUp(obs, sent);
              if (life.state === 'running') void server.stop(true);   // drops the socket mid-body: ECONNRESET at the client
            }
            s.script = 'done';
          })().catch(() => {});   // the client went away mid-send
        },
      });
      return new Response(body, { status, headers });
    },
  });
  return {
    port: server.port ?? 0,
    served,
    async close() {
      if (state === 'down') return;
      state = 'down';
      for (const release of parked) release();
      await server.stop(true);
    },
  };
}

// ---- the runner ----

async function runCase(name: string): Promise<void> {
  const c = loadCase(name);
  const { expect: want, script } = c;
  const { log, lines, raw } = testLog();
  const clock = new ManualClock();
  const observers: Observer[] = [];
  const life: Life = { state: 'running' };
  const topic = `mdsync-fixture-${crypto.randomUUID().replaceAll('-', '')}`;
  const stub = script.kind === 'refused' ? await closedPort() : stubServer(script, observers, life);
  const rel = c.url.replaceAll('{topic}', topic);
  const query = new URL(rel, 'http://x').search.replace(/^\?/, '');
  const connects: string[] = [];
  const shas: string[] = [];
  const h = startNtfy({
    url: `http://127.0.0.1:${stub.port}${rel}`, log, clock, fetchImpl: observedFetch(observers),
    onConnect: (n) => connects.push(n), onSha: (s) => shas.push(s),
  });

  const total = script.kind === 'http' ? script.segments.reduce((n, s) => n + s.byteLength, 0) : 0;
  // still open with nothing more to come: only the watchdog can end it
  const idle = (i: number): boolean => {
    if (script.kind === 'no-headers') return stub.served.length > i;
    if (script.kind !== 'http' || script.end !== 'hang') return false;
    const obs = observers[i];
    return stub.served[i]?.script === 'done' && obs !== undefined && obs.received === total && obs.reads === 'waiting';
  };

  try {
    const n = want.disconnects.length;
    let advance: 'unused' | 'used' = 'unused';
    for (let i = 0; i < n; i++) {
      await until(() => observers.length > i, `fetch ${i + 1}`);
      await until(() => disconnects(lines).length > i || idle(i), `attempt ${i + 1} to end or go idle`);
      if (disconnects(lines).length === i) {
        if (want.advanceMs === undefined) throw new Error(`${name}: attempt ${i + 1} is still open after its script ran; set expect.advanceMs`);
        advance = 'used';
        clock.advance(want.advanceMs - 1);
        await Bun.sleep(10);
        expect(disconnects(lines).length).toBe(i);   // nothing fires early
        clock.advance(1);
        await until(() => disconnects(lines).length > i, `attempt ${i + 1} to end ${want.advanceMs} ms later`);
      }
      if (i + 1 < n) clock.advance(Number(disconnects(lines)[i]?.retryInMs));
    }
    if (want.advanceMs !== undefined && advance === 'unused') throw new Error(`${name}: expect.advanceMs is set but every attempt ended on its own`);
    await Bun.sleep(10);
    expect(observers.length).toBe(n);   // the next retry waits on the manual clock

    expect({
      connects: connects.length,
      shas,
      ignored: lines.filter((l) => l.msg === 'ntfy message ignored').map((l) => l.reason),
      disconnects: disconnects(lines).map((l) => ({ level: l.level, error: l.error, retryInMs: l.retryInMs })),
    }).toEqual({ connects: want.connects, shas: want.shas, ignored: want.ignored, disconnects: want.disconnects });

    expect(connects).toEqual(connects.map((_, i) => (i === 0 ? 'first' : 'reconnect')));
    expect(lines.filter((l) => l.msg === 'ntfy connected').length).toBe(connects.length);
    expect(lines.filter((l) => l.msg === 'callback failed')).toEqual([]);

    // every request went to <path>/sse with the query kept
    const sse = rel.replace(/\?.*$/, '').replace(/\/+$/, '') + '/sse' + (query === '' ? '' : `?${query}`);
    expect(stub.served.map((s) => s.path)).toEqual(script.kind === 'refused' ? [] : Array(n).fill(sse));

    // chunk boundaries really reached the client as separate reads (including splits inside a UTF-8 sequence)
    if (script.kind === 'http' && script.segments.length > 1) {
      const ends = script.segments.map((_, k) => script.segments.slice(0, k + 1).reduce((s, x) => s + x.byteLength, 0));
      observers.forEach((obs) => {
        for (const e of ends) if (e <= obs.received) expect(obs.readEnds).toContain(e);
      });
    }

    // the topic path and the query (self-hosted ntfy's ?auth=) are secrets
    const secrets = [...(c.url.includes('{topic}') ? [topic] : []), ...(query === '' ? [] : [query]),
      ...[...new URLSearchParams(query).values()].filter((v) => v.length >= 4)];
    for (const s of secrets) expect(raw.filter((l) => l.includes(s))).toEqual([]);
  } finally {
    await h.stop();
    life.state = 'closed';
    await stub.close();
  }
  expect(clock.pending()).toBe(0);   // stop() left no watchdog or backoff timer behind
}

const cases = existsSync(FIXTURES)
  ? readdirSync(FIXTURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  : [];

describe('ntfy fixtures', () => {
  test('the fixture folder has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) test(name, () => runCase(name));
});

describe('fixture loader', () => {
  const where = 'test/fixtures/ntfy/x/case.json';
  const valid = {
    note: 'n', source: 'synthesized: test', response: { status: 200, chunks: ['data: x\n\n'], end: 'close' },
    expect: { connects: 1, shas: [], ignored: ['bad-json'], disconnects: [{ level: 'warn', error: 'stream ended', retryInMs: 1_000 }] },
  };
  const parse = (o: unknown): Case => parseCase(o, where, () => 'missing');

  test('a valid case parses', () => {
    expect(parse(valid).script).toMatchObject({ kind: 'http', status: 200, end: 'close' });
  });

  test('a malformed case fails naming the file and the key', () => {
    expect(() => parse({ ...valid, response: { ...valid.response, status: 99 } })).toThrow(/x\/case\.json \(response\) is malformed:[\s\S]*status/);
    expect(() => parse({ ...valid, response: { ...valid.response, headers: { 'Content-Length': '5' } } })).toThrow(/server sets this header/);
    expect(() => parse({ ...valid, response: { status: 200, bodyFile: 'body.sse', end: 'close' } })).toThrow(/body\.sse does not exist/);
    expect(() => parse({ ...valid, expect: { ...valid.expect, retry: 1 } })).toThrow(/x\/case\.json is malformed:[\s\S]*retry/);
    expect(() => parse({ ...valid, source: 'from the internet' })).toThrow(/captured: <host>/);
  });
});
