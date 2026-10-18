// ntfy subscription: a hand-written SSE parser and a reconnecting fetch client.
import { NTFY_BACKOFF, expBackoffMs } from './backoff';
import { errorText, type Logger } from './log';
import { realClock, type Clock, type TimerHandle } from './types';

export const SSE_MAX_LINE = 65_536;
const NO_PROGRESS_MS = 120_000;       // watchdog: connect, TLS, headers and every read
const HEALTHY_CONNECTION_MS = 60_000; // a connection that lived this long resets the failure count

export type SseEvent = { event: string; data: string; id?: string };

export class SseParser {
  readonly #maxLine: number;
  #buf = '';
  #start: 'bom-possible' | 'started' = 'bom-possible';
  #event = '';
  #data: string[] = [];
  #id: string | undefined;

  constructor(o?: { maxLine?: number /* SSE_MAX_LINE */ }) {
    this.#maxLine = o?.maxLine ?? SSE_MAX_LINE;
  }

  // Lines end in \n or \r\n. A chunk may end anywhere, including between \r and \n.
  push(chunk: string): SseEvent[] | 'line-too-long' {
    let text = this.#buf + chunk;
    if (this.#start === 'bom-possible' && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.#start = 'started';
    }
    const out: SseEvent[] = [];
    let pos = 0;
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', pos)) {
      const end = nl > pos && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      if (end - pos > this.#maxLine) return 'line-too-long';
      this.#line(text.slice(pos, end), out);
      pos = nl + 1;
    }
    this.#buf = pos === 0 ? text : text.slice(pos);
    const partial = this.#buf.endsWith('\r') ? this.#buf.length - 1 : this.#buf.length;
    if (partial > this.#maxLine) return 'line-too-long';
    return out;
  }

  #line(line: string, out: SseEvent[]): void {
    if (line === '') {
      this.#dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;   // comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event': this.#event = value; break;
      case 'data': this.#data.push(value); break;
      case 'id': if (!value.includes('\0')) this.#id = value; break;
      default: break;   // `retry` and unknown fields: mdsync has its own backoff
    }
  }

  // A block without any `data:` line is not an event (WHATWG SSE).
  #dispatch(out: SseEvent[]): void {
    if (this.#data.length > 0) {
      const ev: SseEvent = { event: this.#event === '' ? 'message' : this.#event, data: this.#data.join('\n') };
      if (this.#id !== undefined) ev.id = this.#id;
      out.push(ev);
    }
    this.#event = '';
    this.#data = [];
    this.#id = undefined;
  }
}

export type NtfyMessage = { kind: 'sha'; sha: string } | { kind: 'ignore'; reason: 'not-message' | 'bad-json' | 'not-sha' };

const SHA_RE = /^[0-9a-f]{7,64}$/;

export function parseNtfyEvent(ev: SseEvent): NtfyMessage {
  let json: unknown;
  try {
    json = JSON.parse(ev.data);
  } catch {
    return { kind: 'ignore', reason: 'bad-json' };
  }
  if (typeof json !== 'object' || json === null || (json as { event?: unknown }).event !== 'message') {
    return { kind: 'ignore', reason: 'not-message' };
  }
  const sha = String((json as { message?: unknown }).message).trim().toLowerCase();
  return SHA_RE.test(sha) ? { kind: 'sha', sha } : { kind: 'ignore', reason: 'not-sha' };
}

export type NtfyHandle = { stop(): Promise<void>; reconnectNow(): void };

type AbortCause = 'none' | 'watchdog' | 'reconnect' | 'line-too-long' | 'stop';
type Attempt = { connectedAt: number | 'never'; error: string };

const CAUSE_TEXT: Record<Exclude<AbortCause, 'none'>, string> = {
  watchdog: `no data for ${NO_PROGRESS_MS / 1000} s`,
  reconnect: 'reconnect requested',
  'line-too-long': 'SSE line too long',
  stop: 'stopped',
};

// The subscription URL: '/sse' goes on the path, and a query (self-hosted ntfy's `?auth=…`) stays a query.
export function sseUrlOf(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/sse`;
    return u.toString();
  } catch {
    return url.replace(/\/+$/, '') + '/sse';
  }
}

// host for logs; path and query are secrets (the topic, and self-hosted ntfy's `auth` token)
function urlParts(url: string): { host: string; path: string; query: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname.replace(/\/+$/, ''), query: u.search.replace(/^\?/, '') };
  } catch {
    return { host: 'invalid-url', path: '', query: '' };
  }
}

// The topic is the shared secret, and a query holds self-hosted ntfy's token: both are redacted from then on.
export function addNtfySecrets(log: Pick<Logger, 'addSecret'>, url: string): void {
  const { path, query } = urlParts(url);
  if (path !== '') log.addSecret(path);
  if (query !== '') log.addSecret(query);
}

// `text/html; charset=utf-8` -> 'text/html'. Cut to 100 chars: the header is the server's, and it goes into a log line.
function mediaTypeOf(header: string | null): string | 'none' {
  const type = (header ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return type === '' ? 'none' : type.slice(0, 100);
}

// Like backoff.sleep, but on the injected clock so tests drive the backoff too.
function sleepOn(clock: Clock, ms: number, signal: AbortSignal): Promise<'slept' | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clock.clearTimeout(timer);
      resolve('aborted');
    };
    const timer = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Settles on abort even if fetchImpl ignores the signal; a response that arrives too late is cancelled.
function fetchUntilAbort(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<Response> {
  const p = fetchImpl(url, { signal });
  return new Promise<Response>((resolve, reject) => {
    const onAbort = (): void => {
      p.then((res) => res.body?.cancel().catch(() => {}), () => {});
      reject(new Error('aborted'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (res) => { signal.removeEventListener('abort', onAbort); resolve(res); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// onData: every chunk read off a live stream (ntfy's keepalives and `open` events too). onDisconnect: each failed
// attempt or dropped stream, with the redacted text `ntfy disconnected` logs; never after stop().
export function startNtfy(o: { url: string; log: Logger; onConnect: (n: 'first' | 'reconnect') => void;
  onSha: (sha: string) => void; onData?: () => void; onDisconnect?: (d: { error: string; retryInMs: number }) => void;
  clock?: Clock; fetchImpl?: typeof fetch }): NtfyHandle {
  const { log } = o;
  const clock = o.clock ?? realClock;
  const fetchImpl = o.fetchImpl ?? fetch;
  const sseUrl = sseUrlOf(o.url);
  const { host } = urlParts(o.url);
  addNtfySecrets(log, o.url);

  let state: 'running' | 'stopped' = 'running';
  let conn = new AbortController();     // the current fetch + read
  let pause = new AbortController();    // the current backoff sleep
  let cause: AbortCause = 'none';
  let failures = 0;
  let next: 'first' | 'reconnect' = 'first';

  const abortWith = (c: Exclude<AbortCause, 'none'>): void => {
    if (cause === 'none') cause = c;
    conn.abort();
  };

  const guarded = (source: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      log.error('callback failed', { source, error: e });
    }
  };

  const connectOnce = async (): Promise<Attempt> => {
    const ac = conn;
    let connectedAt: Attempt['connectedAt'] = 'never';
    let watchdog: TimerHandle = clock.setTimeout(() => abortWith('watchdog'), NO_PROGRESS_MS);
    const kick = (): void => {
      clock.clearTimeout(watchdog);
      watchdog = clock.setTimeout(() => abortWith('watchdog'), NO_PROGRESS_MS);
    };
    const failed = (fallback: string): Attempt => ({ connectedAt, error: cause === 'none' ? fallback : CAUSE_TEXT[cause] });
    try {
      const res = await fetchUntilAbort(fetchImpl, sseUrl, ac.signal);
      if (!res.ok || res.body === null) {
        await res.body?.cancel().catch(() => {});
        return failed(res.ok ? 'empty response body' : `HTTP ${res.status}`);
      }
      // A 200 that is not an event stream is not a subscription: ntfy.sh serves its web app for a URL with no topic,
      // and captive portals and proxies answer 200 HTML or an empty 200. Counted as connected, every retry logged
      // `ntfy connected` and queued a catch-up sync. The text never includes the URL.
      const media = mediaTypeOf(res.headers.get('content-type'));
      if (media !== 'text/event-stream') {
        await res.body.cancel().catch(() => {});
        return failed(`not an event stream (${media === 'none' ? 'no content type' : media}): check that ntfyUrl names a topic`);
      }
      if (ac.signal.aborted) {
        await res.body.cancel().catch(() => {});
        return failed('aborted');
      }
      connectedAt = clock.now();
      const attempt = next;
      next = 'reconnect';
      log.info('ntfy connected', { host, attempt });
      guarded('ntfy.onConnect', () => o.onConnect(attempt));
      kick();

      const reader = res.body.getReader();
      const onAbort = (): void => { reader.cancel().catch(() => {}); };
      ac.signal.addEventListener('abort', onAbort, { once: true });
      if (ac.signal.aborted) onAbort();
      try {
        const decoder = new TextDecoder('utf-8');
        const parser = new SseParser();
        for (;;) {
          const { value, done } = await reader.read();
          if (done || ac.signal.aborted) return failed('stream ended');
          kick();
          guarded('ntfy.onData', () => o.onData?.());
          const events = parser.push(decoder.decode(value, { stream: true }));
          if (events === 'line-too-long') {
            abortWith('line-too-long');
            return failed('SSE line too long');
          }
          for (const ev of events) {
            if (state === 'stopped') break;
            const m = parseNtfyEvent(ev);
            if (m.kind === 'sha') guarded('ntfy.onSha', () => o.onSha(m.sha));
            else log.debug('ntfy message ignored', { reason: m.reason });
          }
        }
      } finally {
        ac.signal.removeEventListener('abort', onAbort);
      }
    } catch (e) {
      return failed(errorText(e));
    } finally {
      clock.clearTimeout(watchdog);
    }
  };

  const loop = (async (): Promise<void> => {
    while (state === 'running') {
      conn = new AbortController();
      pause = new AbortController();
      cause = 'none';
      let r: Attempt;
      try {
        r = await connectOnce();
      } catch (e) {
        r = { connectedAt: 'never', error: errorText(e) };
      }
      if (state !== 'running') break;
      if (r.connectedAt !== 'never' && clock.now() - r.connectedAt >= HEALTHY_CONNECTION_MS) failures = 0;
      // A requested reconnect (wake) is not a failure and does not wait.
      const requested = (cause as AbortCause) === 'reconnect';   // set by reconnectNow() while connectOnce ran
      if (!requested) failures++;
      const retryInMs = requested || pause.signal.aborted ? 0 : expBackoffMs(failures, NTFY_BACKOFF);
      log.warn('ntfy disconnected', { error: r.error, retryInMs });
      guarded('ntfy.onDisconnect', () => o.onDisconnect?.({ error: errorText(r.error), retryInMs }));
      if (retryInMs > 0) await sleepOn(clock, retryInMs, pause.signal);
    }
  })();

  return {
    stop(): Promise<void> {
      if (state === 'running') {
        state = 'stopped';
        abortWith('stop');
        pause.abort();
      }
      return loop;
    },
    reconnectNow(): void {
      if (state !== 'running') return;
      abortWith('reconnect');
      pause.abort();
    },
  };
}
