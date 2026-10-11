// Unix-socket NDJSON flush protocol: daemon server and flush client.
import { lstatSync, unlinkSync } from 'node:fs';
import type { Socket } from 'bun';
import { errCode } from './fsutil';
import { errorText, type Logger } from './log';
import type { SyncOutcome, WaitMode } from './types';

export const DELIVERY_WAIT_MS = 540_000;
export const IPC_READ_TIMEOUT_MS = 10_000;
// The longest a `flush --wait` client waits for its result after `queued`: the run in flight plus ours, each bounded
// by the queue watchdog (2 × RUN_WATCHDOG_MS). A daemon that froze would otherwise keep the client waiting forever.
export const FLUSH_RESULT_WAIT_MS = 3_600_000;
const MAX_LINE_BYTES = 1024 * 1024;
const NL = 0x0a;

export type FlushRequest = { type: 'flush'; v: 1; message?: string; paths?: string[]; wait: WaitMode };
export type IpcReply =
  | { type: 'queued' }
  | { type: 'result'; outcome: SyncOutcome; head: string; commitsOut: number; error?: string }
  | { type: 'error'; error: string };
export type IpcServer = {
  stopAccepting(): void;     // listener.stop(false): Bun unlinks the socket path; open connections stay writable. Idempotent, sync.
  closeAll(): void;          // end every tracked connection
};
export type IpcClientResult = { kind: 'replies'; replies: IpcReply[] } | { kind: 'no-daemon' } | { kind: 'timeout' }
  | { kind: 'result-timeout'; replies: IpcReply[] }   // `queued`, then no result within resultTimeoutMs
  | { kind: 'error'; error: string };

export function validateRelPath(p: string): 'ok' | string {
  if (p === '') return 'empty path';
  if (p.includes('\0')) return 'path contains NUL';
  if (p.startsWith('/')) return 'absolute path';
  if (p.startsWith('./')) return "path starts with './'";
  for (const seg of p.split('/')) {
    if (seg === '..') return "path contains a '..' segment";
    if (seg.toLowerCase() === '.git') return "path contains a '.git' segment";   // .GIT is .git on a case-insensitive FS
    if (seg === '.') return "path contains a '.' segment";
    if (seg === '') return 'path contains an empty segment';
  }
  return 'ok';
}

function parseFlushRequest(v: unknown): FlushRequest | { invalid: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { invalid: 'request is not a JSON object' };
  const r = v as Record<string, unknown>;
  if (r.type !== 'flush') return { invalid: 'unknown request type' };
  if (r.v !== 1) return { invalid: 'unsupported protocol version' };
  if (r.wait !== 'wait' && r.wait !== 'no-wait') return { invalid: 'wait must be "wait" or "no-wait"' };
  const req: FlushRequest = { type: 'flush', v: 1, wait: r.wait };
  if (r.message !== undefined && r.message !== null) {
    if (typeof r.message !== 'string') return { invalid: 'message must be a string' };
    if (r.message !== '') req.message = r.message;
  }
  if (r.paths !== undefined && r.paths !== null) {
    if (!Array.isArray(r.paths)) return { invalid: 'paths must be an array' };
    const paths: string[] = [];
    for (const p of r.paths) {
      if (typeof p !== 'string') return { invalid: 'paths must be strings' };
      const why = validateRelPath(p);
      if (why !== 'ok') return { invalid: `invalid path ${JSON.stringify(p)}: ${why}` };
      paths.push(p);
    }
    if (paths.length > 0) req.paths = paths;   // `paths: []` is the same as omitting it
  }
  return req;
}

function parseReply(v: unknown): IpcReply | 'invalid' {
  if (typeof v !== 'object' || v === null) return 'invalid';
  const r = v as Record<string, unknown>;
  if (r.type === 'queued') return { type: 'queued' };
  if (r.type === 'error') return { type: 'error', error: String(r.error) };
  if (r.type === 'result' && typeof r.outcome === 'string' && typeof r.head === 'string' && typeof r.commitsOut === 'number') {
    const out: IpcReply = { type: 'result', outcome: r.outcome as SyncOutcome, head: r.head, commitsOut: r.commitsOut };
    if (typeof r.error === 'string') out.error = r.error;
    return out;
  }
  return 'invalid';
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// Splits a byte stream into '\n'-terminated lines, capped at MAX_LINE_BYTES each.
class LineReader {
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  push(chunk: Uint8Array): Uint8Array[] | 'too-long' {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let nl = chunk.indexOf(NL); nl !== -1; nl = chunk.indexOf(NL, start)) {
      const piece = chunk.subarray(start, nl);
      if (this.#bytes + piece.byteLength > MAX_LINE_BYTES) return 'too-long';
      lines.push(concat([...this.#chunks, piece], this.#bytes + piece.byteLength));
      this.#chunks = [];
      this.#bytes = 0;
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.byteLength > 0) {
      this.#chunks.push(rest.slice());   // copy: Bun may reuse the chunk's buffer
      this.#bytes += rest.byteLength;
      if (this.#bytes > MAX_LINE_BYTES) return 'too-long';
    }
    return lines;
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

// Writes with backpressure: Bun's socket.write may accept only part of a buffer; the rest goes out on drain.
class Outbox {
  #queue: Uint8Array[] = [];
  #after: 'keep-open' | 'end' | 'ended' = 'keep-open';

  send(s: Socket<undefined>, line: string): void {
    this.#queue.push(encoder.encode(line + '\n'));
    this.flush(s);
  }

  endWhenDrained(s: Socket<undefined>): void {
    if (this.#after === 'keep-open') this.#after = 'end';
    this.flush(s);
  }

  flush(s: Socket<undefined>): void {
    while (this.#queue.length > 0) {
      const head = this.#queue[0] as Uint8Array;
      const n = s.write(head);
      if (n < 0) {
        this.#queue = [];   // closed
        return;
      }
      if (n < head.byteLength) {
        this.#queue[0] = head.subarray(n);
        return;
      }
      this.#queue.shift();
    }
    if (this.#after === 'end') {
      this.#after = 'ended';
      s.end();
    }
  }
}

type Conn = {
  phase: 'reading' | 'handled' | 'closed';
  lines: LineReader;
  out: Outbox;
  timer: ReturnType<typeof setTimeout> | undefined;
};

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ENOENT: nothing to remove
  }
}

export function startIpcServer(o: { sockPath: string; log: Logger;
  onFlush: (req: FlushRequest, reply: (r: IpcReply) => void, end: () => void) => void }): IpcServer {
  const { sockPath, log } = o;
  const conns = new Map<Socket<undefined>, Conn>();
  let listening: 'listening' | 'stopped' = 'listening';

  const finish = (s: Socket<undefined>, c: Conn): void => {
    if (c.phase === 'closed') return;
    c.phase = 'closed';
    clearTimeout(c.timer);
    c.out.endWhenDrained(s);
  };
  const reject = (s: Socket<undefined>, c: Conn, error: string): void => {
    log.warn('ipc bad request', { error });
    c.phase = 'handled';
    clearTimeout(c.timer);
    c.out.send(s, JSON.stringify({ type: 'error', error } satisfies IpcReply));
    finish(s, c);
  };

  const handleLine = (s: Socket<undefined>, c: Conn, line: Uint8Array): void => {
    c.phase = 'handled';
    clearTimeout(c.timer);
    c.timer = undefined;
    let value: unknown;
    try {
      value = JSON.parse(utf8.decode(line));
    } catch {
      return reject(s, c, 'invalid JSON');
    }
    const req = parseFlushRequest(value);
    if ('invalid' in req) return reject(s, c, req.invalid);
    const reply = (r: IpcReply): void => {
      if (c.phase === 'closed') return;   // the client went away: ignore
      c.out.send(s, JSON.stringify(r));
    };
    try {
      o.onFlush(req, reply, () => finish(s, c));
    } catch (e) {
      log.warn('ipc error', { error: e });
      reply({ type: 'error', error: errorText(e) });
      finish(s, c);
    }
  };

  // Listening on an existing path throws EADDRINUSE; a live daemon's socket is never here, because we hold the lock.
  unlinkQuietly(sockPath);
  const listener = Bun.listen({
    unix: sockPath,
    socket: {
      open(s) {
        const c: Conn = { phase: 'reading', lines: new LineReader(), out: new Outbox(), timer: undefined };
        c.timer = setTimeout(() => {
          if (c.phase === 'reading') reject(s, c, 'request timeout');
        }, IPC_READ_TIMEOUT_MS);
        conns.set(s, c);
      },
      data(s, chunk) {
        const c = conns.get(s);
        if (c === undefined || c.phase !== 'reading') return;   // one request per connection
        const lines = c.lines.push(chunk);
        if (lines === 'too-long') return reject(s, c, 'request line too long');
        const first = lines[0];
        if (first !== undefined) handleLine(s, c, first);
      },
      drain(s) {
        conns.get(s)?.out.flush(s);
      },
      close(s) {
        const c = conns.get(s);
        if (c !== undefined) {
          c.phase = 'closed';
          clearTimeout(c.timer);
        }
        conns.delete(s);
      },
      error(_s, e) {
        log.warn('ipc error', { error: e });
      },
    },
  });
  log.debug('ipc listening', { socket: sockPath });

  return {
    stopAccepting(): void {
      if (listening === 'stopped') return;
      listening = 'stopped';
      try {
        listener.stop(false);
      } catch (e) {
        log.warn('ipc error', { error: e });
      }
      // Bun already unlinks the path; this covers a runtime that doesn't. Safe because the socket is
      // always removed before the lock is released, so no other daemon can have bound it yet.
      unlinkQuietly(sockPath);
    },
    closeAll(): void {
      for (const [s, c] of conns) {
        clearTimeout(c.timer);
        c.phase = 'closed';
        try {
          s.end();
        } catch {
          // already closed
        }
      }
      conns.clear();
    },
  };
}

// No socket file means no daemon. Checked before connecting, because the connect error for a missing path depends on
// the runtime: Bun 1.4 on macOS reports EINVAL, not ENOENT, when the path is 104 bytes or longer (sun_path) and its
// folder does not exist yet.
function socketMissing(sockPath: string): boolean {
  try {
    lstatSync(sockPath);
    return false;
  } catch (e) {
    const code = errCode(e);
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

// A missing or dead socket means no daemon is listening; anything else is an error.
function connectFailure(e: unknown): IpcClientResult {
  const code = errCode(e);
  return code === 'ENOENT' || code === 'ECONNREFUSED' ? { kind: 'no-daemon' } : { kind: 'error', error: errorText(e) };
}

// queuedTimeoutMs bounds the wait for the first reply. After `queued`, a `wait` request waits for its result as long
// as the daemon keeps the connection open (a sync can take several network timeouts), up to resultTimeoutMs.
export function sendFlush(sockPath: string, req: FlushRequest,
  o: { queuedTimeoutMs: number /* 10000 */; resultTimeoutMs?: number /* FLUSH_RESULT_WAIT_MS */ }): Promise<IpcClientResult> {
  if (socketMissing(sockPath)) return Promise.resolve({ kind: 'no-daemon' });
  return new Promise<IpcClientResult>((resolve) => {
    const replies: IpcReply[] = [];
    const lines = new LineReader();
    const out = new Outbox();
    let settled: 'pending' | 'settled' = 'pending';
    let sock: Socket<undefined> | undefined;
    let resultTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (r: IpcClientResult): void => {
      if (settled === 'settled') return;
      settled = 'settled';
      clearTimeout(timer);
      clearTimeout(resultTimer);
      if (sock !== undefined) {
        try {
          sock.end();
        } catch {
          // already closed
        }
      }
      resolve(r);
    };
    const timer = setTimeout(() => settle({ kind: 'timeout' }), o.queuedTimeoutMs);

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          out.send(s, JSON.stringify(req));
        },
        data(_s, chunk) {
          if (settled === 'settled') return;
          const got = lines.push(chunk);
          if (got === 'too-long') return settle({ kind: 'error', error: 'reply line too long' });
          for (const line of got) {
            let reply: IpcReply | 'invalid' = 'invalid';
            try {
              reply = parseReply(JSON.parse(utf8.decode(line)));
            } catch {
              // fall through as invalid
            }
            if (reply === 'invalid') return settle({ kind: 'error', error: 'invalid reply from daemon' });
            replies.push(reply);
            clearTimeout(timer);
            // a result or error ends the exchange, and so does `queued` when the caller does not wait for the result
            if (reply.type !== 'queued' || req.wait === 'no-wait') return settle({ kind: 'replies', replies });
            resultTimer ??= setTimeout(() => settle({ kind: 'result-timeout', replies: [...replies] }),
              o.resultTimeoutMs ?? FLUSH_RESULT_WAIT_MS);
          }
        },
        drain(s) {
          out.flush(s);
        },
        close() {
          settle({ kind: 'replies', replies });
        },
        error(_s, e) {
          settle({ kind: 'error', error: errorText(e) });
        },
        connectError(_s, e) {
          settle(connectFailure(e));
        },
      },
    }).catch((e: unknown) => {
      settle(connectFailure(e));
    });
  });
}
