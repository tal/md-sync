import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELIVERY_WAIT_MS,
  IPC_READ_TIMEOUT_MS,
  sendFlush,
  startIpcServer,
  validateRelPath,
  type FlushRequest,
  type IpcReply,
  type IpcServer,
} from '../../src/ipc';
import { createLogger, type Logger } from '../../src/log';

type Line = { level: string; msg: string; [k: string]: unknown };

function testLog(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  return { log: createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(JSON.parse(l) as Line) }), lines };
}

const dirs: string[] = [];
const servers: IpcServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stopAccepting();
    s.closeAll();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sockPath(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-ipc-')));
  dirs.push(d);
  return join(d, 's.sock');
}

type OnFlush = (req: FlushRequest, reply: (r: IpcReply) => void, end: () => void) => void;

function serve(path: string, onFlush: OnFlush) {
  const { log, lines } = testLog();
  const server = startIpcServer({ sockPath: path, log, onFlush });
  servers.push(server);
  return { server, lines };
}

// A hand-driven client for protocol edge cases. send() queues what the socket doesn't take at once.
async function raw(path: string) {
  let text = '';
  let closed!: () => void;
  const done = new Promise<void>((r) => { closed = r; });
  let queue: Uint8Array[] = [];
  const pump = (s: { write(b: Uint8Array): number }): void => {
    while (queue.length > 0) {
      const head = queue[0] as Uint8Array;
      const n = s.write(head);
      if (n < 0) { queue = []; return; }
      if (n < head.byteLength) { queue[0] = head.subarray(n); return; }
      queue.shift();
    }
  };
  const s = await Bun.connect({
    unix: path,
    socket: { data(_s, d) { text += d.toString(); }, drain(sock) { pump(sock); }, close() { closed(); } },
  });
  return {
    send: (x: string | Uint8Array): void => {
      queue.push(typeof x === 'string' ? new TextEncoder().encode(x) : x);
      pump(s);
    },
    end: (): void => { s.end(); },
    closed: done,
    replies: (): unknown[] => text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as unknown),
  };
}

async function until(pred: () => boolean, label = 'condition', timeoutMs = 3_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

const wait = (o: Partial<FlushRequest> = {}): FlushRequest => ({ type: 'flush', v: 1, wait: 'wait', ...o });

describe('constants', () => {
  test('pinned values', () => {
    expect(DELIVERY_WAIT_MS).toBe(540_000);
    expect(IPC_READ_TIMEOUT_MS).toBe(10_000);
  });
});

describe('validateRelPath', () => {
  test('accepts repo-relative POSIX paths', () => {
    for (const p of ['a.md', 'notes/a.md', 'dir', 'a b/c (conflict x 2026-10-08 1200).md', '.gitignore', '.github/x.yml', 'x/.gitkeep', '..foo', 'a..b/c']) {
      expect(validateRelPath(p)).toBe('ok');
    }
  });

  test('rejects empty, NUL, absolute, ./, .. and .git', () => {
    for (const p of ['', 'a\0b', '/etc/passwd', './a.md', '../a.md', 'a/../../b', 'a/..', '.git', '.git/config', 'sub/.git/HEAD', '.GIT/config', 'a/./b', 'a//b', 'a/']) {
      expect(validateRelPath(p)).not.toBe('ok');
    }
  });
});

describe('startIpcServer + sendFlush', () => {
  test('round trip with wait: queued, then result, then the server ends the connection', async () => {
    const path = sockPath();
    const got: FlushRequest[] = [];
    const { lines } = serve(path, (req, reply, end) => {
      got.push(req);
      reply({ type: 'queued' });
      setTimeout(() => {
        reply({ type: 'result', outcome: 'ok', head: 'abc', commitsOut: 1 });
        end();
      }, 30);
    });
    expect(lines.find((l) => l.msg === 'ipc listening')).toMatchObject({ level: 'debug', socket: path });
    const r = await sendFlush(path, wait({ message: 'did X', paths: ['notes/a.md'] }), { queuedTimeoutMs: 2_000 });
    expect(r).toEqual({ kind: 'replies', replies: [{ type: 'queued' }, { type: 'result', outcome: 'ok', head: 'abc', commitsOut: 1 }] });
    expect(got).toEqual([{ type: 'flush', v: 1, wait: 'wait', message: 'did X', paths: ['notes/a.md'] }]);
  });

  test('no-wait: the client returns after queued', async () => {
    const path = sockPath();
    serve(path, (_req, reply, end) => {
      reply({ type: 'queued' });
      end();
    });
    const r = await sendFlush(path, { type: 'flush', v: 1, wait: 'no-wait' }, { queuedTimeoutMs: 2_000 });
    expect(r).toEqual({ kind: 'replies', replies: [{ type: 'queued' }] });
  });

  test('a wait result with an error field', async () => {
    const path = sockPath();
    serve(path, (_req, reply, end) => {
      reply({ type: 'queued' });
      reply({ type: 'result', outcome: 'network-error', head: 'abc', commitsOut: 0, error: 'Could not resolve host' });
      end();
    });
    const r = await sendFlush(path, wait(), { queuedTimeoutMs: 2_000 });
    expect(r).toEqual({ kind: 'replies', replies: [
      { type: 'queued' },
      { type: 'result', outcome: 'network-error', head: 'abc', commitsOut: 0, error: 'Could not resolve host' },
    ] });
  });

  test('paths: [] and an empty message are the same as omitting them', async () => {
    const path = sockPath();
    const got: FlushRequest[] = [];
    serve(path, (req, reply, end) => { got.push(req); reply({ type: 'queued' }); end(); });
    await sendFlush(path, { type: 'flush', v: 1, wait: 'no-wait', message: '', paths: [] }, { queuedTimeoutMs: 2_000 });
    expect(got).toEqual([{ type: 'flush', v: 1, wait: 'no-wait' }]);
  });

  test('no-daemon for a missing socket path', async () => {
    const path = sockPath();
    expect(await sendFlush(path, wait(), { queuedTimeoutMs: 2_000 })).toEqual({ kind: 'no-daemon' });
  });

  test('no-daemon for a long socket path whose folder does not exist yet (any runtime errno)', async () => {
    // Bun 1.4 on macOS fails such a connect with EINVAL instead of ENOENT once the path is 104 bytes or longer
    // (sun_path): a first `md-sync flush` with no daemon then exited 1 instead of doing the one-off run.
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-ipc-')));
    dirs.push(d);
    const path = join(d, 'x'.repeat(60), 'state', 'mdsync', '0123456789abcdef.sock');
    expect(path.length).toBeGreaterThanOrEqual(104);
    expect(await sendFlush(path, wait(), { queuedTimeoutMs: 2_000 })).toEqual({ kind: 'no-daemon' });
  });

  test('no-daemon for a stale socket left by a killed process', async () => {
    const path = sockPath();
    const child = Bun.spawn([process.execPath, '-e',
      `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); console.log('ready'); setInterval(() => {}, 1000);`],
      { stdout: 'pipe', stderr: 'ignore' });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill('SIGKILL');
    await child.exited;
    expect(existsSync(path)).toBe(true);
    expect(await sendFlush(path, wait(), { queuedTimeoutMs: 2_000 })).toEqual({ kind: 'no-daemon' });
  });

  test('startIpcServer replaces a stale path', async () => {
    const path = sockPath();
    writeFileSync(path, 'stale');
    serve(path, (_req, reply, end) => { reply({ type: 'queued' }); end(); });
    expect(await sendFlush(path, { type: 'flush', v: 1, wait: 'no-wait' }, { queuedTimeoutMs: 2_000 })).toEqual({ kind: 'replies', replies: [{ type: 'queued' }] });
  });

  test('stopAccepting: the socket path goes away, new connects get no-daemon, open connections stay writable', async () => {
    const path = sockPath();
    let pending: ((r: IpcReply) => void) | undefined;
    let finish: (() => void) | undefined;
    const { server } = serve(path, (_req, reply, end) => {
      reply({ type: 'queued' });
      pending = reply;
      finish = end;
    });
    const inFlight = sendFlush(path, wait(), { queuedTimeoutMs: 2_000 });
    await until(() => pending !== undefined, 'request received');
    server.stopAccepting();
    server.stopAccepting();   // idempotent
    expect(existsSync(path)).toBe(false);
    expect(await sendFlush(path, wait(), { queuedTimeoutMs: 2_000 })).toEqual({ kind: 'no-daemon' });
    pending?.({ type: 'result', outcome: 'conflict-resolved', head: 'def', commitsOut: 2 });
    finish?.();
    expect(await inFlight).toEqual({ kind: 'replies', replies: [{ type: 'queued' }, { type: 'result', outcome: 'conflict-resolved', head: 'def', commitsOut: 2 }] });
  });

  test('closeAll ends open connections; replies after that are ignored', async () => {
    const path = sockPath();
    let late: ((r: IpcReply) => void) | undefined;
    const { server } = serve(path, (_req, reply) => { reply({ type: 'queued' }); late = reply; });
    const inFlight = sendFlush(path, wait(), { queuedTimeoutMs: 2_000 });
    await until(() => late !== undefined, 'request received');
    await Bun.sleep(20);
    server.closeAll();
    expect(await inFlight).toEqual({ kind: 'replies', replies: [{ type: 'queued' }] });
    late?.({ type: 'result', outcome: 'ok', head: 'x', commitsOut: 0 });   // must not throw
  });

  test('a reply to a client that already went away is ignored', async () => {
    const path = sockPath();
    let reply: ((r: IpcReply) => void) | undefined;
    let end: (() => void) | undefined;
    serve(path, (_req, r, e) => { reply = r; end = e; });
    const c = await raw(path);
    c.send(JSON.stringify(wait()) + '\n');
    await until(() => reply !== undefined, 'request received');
    c.end();
    await c.closed;
    await Bun.sleep(20);
    reply?.({ type: 'queued' });
    end?.();
  });

  test('client timeout when the daemon never answers', async () => {
    const path = sockPath();
    serve(path, () => {});
    const t0 = performance.now();
    expect(await sendFlush(path, wait(), { queuedTimeoutMs: 200 })).toEqual({ kind: 'timeout' });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
  });

  test('after queued, a wait request is not bound by queuedTimeoutMs', async () => {
    const path = sockPath();
    serve(path, (_req, reply, end) => {
      reply({ type: 'queued' });
      setTimeout(() => { reply({ type: 'result', outcome: 'ok', head: 'h', commitsOut: 0 }); end(); }, 300);
    });
    const r = await sendFlush(path, wait(), { queuedTimeoutMs: 100 });
    expect(r.kind === 'replies' && r.replies.map((x) => x.type)).toEqual(['queued', 'result']);
  });

  test('after queued, a wait request gives up after resultTimeoutMs (a frozen daemon never answers)', async () => {
    const path = sockPath();
    serve(path, (_req, reply) => reply({ type: 'queued' }));
    const t0 = performance.now();
    const r = await sendFlush(path, wait(), { queuedTimeoutMs: 2_000, resultTimeoutMs: 300 });
    expect(r).toEqual({ kind: 'result-timeout', replies: [{ type: 'queued' }] });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(290);
  });

  test('a connection closed without any reply yields an empty reply list', async () => {
    const path = sockPath();
    serve(path, (_req, _reply, end) => end());
    expect(await sendFlush(path, wait(), { queuedTimeoutMs: 2_000 })).toEqual({ kind: 'replies', replies: [] });
  });

  test('a throwing onFlush gets an error reply and an ipc error log', async () => {
    const path = sockPath();
    const { lines } = serve(path, () => { throw new Error('handler broke'); });
    const r = await sendFlush(path, wait(), { queuedTimeoutMs: 2_000 });
    expect(r).toEqual({ kind: 'replies', replies: [{ type: 'error', error: 'handler broke' }] });
    expect(lines.find((l) => l.msg === 'ipc error')).toMatchObject({ level: 'warn', error: 'handler broke' });
  });
});

describe('bad requests', () => {
  async function badRequest(payload: string | Uint8Array): Promise<{ replies: unknown[]; lines: Line[]; calls: number }> {
    const path = sockPath();
    let calls = 0;
    const { lines } = serve(path, () => { calls++; });
    const c = await raw(path);
    c.send(payload);
    await c.closed;
    return { replies: c.replies(), lines, calls };
  }

  test('invalid JSON', async () => {
    const r = await badRequest('{nope\n');
    expect(r.replies).toEqual([{ type: 'error', error: 'invalid JSON' }]);
    expect(r.lines.find((l) => l.msg === 'ipc bad request')).toMatchObject({ level: 'warn', error: 'invalid JSON' });
    expect(r.calls).toBe(0);
  });

  test('wrong type, version, wait mode, message or paths', async () => {
    const cases: [unknown, string][] = [
      [[1, 2], 'request is not a JSON object'],
      [{ type: 'status', v: 1, wait: 'wait' }, 'unknown request type'],
      [{ type: 'flush', v: 2, wait: 'wait' }, 'unsupported protocol version'],
      [{ type: 'flush', v: 1, wait: true }, 'wait must be "wait" or "no-wait"'],
      [{ type: 'flush', v: 1, wait: 'wait', message: 5 }, 'message must be a string'],
      [{ type: 'flush', v: 1, wait: 'wait', paths: 'a.md' }, 'paths must be an array'],
      [{ type: 'flush', v: 1, wait: 'wait', paths: [1] }, 'paths must be strings'],
    ];
    for (const [req, error] of cases) {
      const r = await badRequest(JSON.stringify(req) + '\n');
      expect(r.replies).toEqual([{ type: 'error', error }]);
      expect(r.calls).toBe(0);
    }
  });

  test('a path that fails validateRelPath', async () => {
    const r = await badRequest(JSON.stringify(wait({ paths: ['ok.md', '../escape.md'] })) + '\n');
    expect(r.replies).toEqual([{ type: 'error', error: `invalid path "../escape.md": ${validateRelPath('../escape.md')}` }]);
    expect(r.calls).toBe(0);
  });

  test('a request line over 1 MiB', async () => {
    const r = await badRequest(new Uint8Array(1024 * 1024 + 10).fill(0x61));
    expect(r.replies).toEqual([{ type: 'error', error: 'request line too long' }]);
  });

  test('a request split across writes is reassembled; only the first line counts', async () => {
    const path = sockPath();
    const got: FlushRequest[] = [];
    serve(path, (req, reply, end) => { got.push(req); reply({ type: 'queued' }); end(); });
    const c = await raw(path);
    const line = JSON.stringify(wait({ message: 'ünïcødé ✓' }));
    const bytes = new TextEncoder().encode(line + '\n' + JSON.stringify(wait({ message: 'second' })) + '\n');
    const cut = line.indexOf('✓') + 1;   // inside a multi-byte character
    c.send(bytes.subarray(0, cut));
    await Bun.sleep(20);
    c.send(bytes.subarray(cut));
    await c.closed;
    expect(got).toEqual([wait({ message: 'ünïcødé ✓' })]);
    expect(c.replies()).toEqual([{ type: 'queued' }]);
  });

  test(`read timeout: no request line within IPC_READ_TIMEOUT_MS -> error reply and close`, async () => {
    const path = sockPath();
    let calls = 0;
    const { lines } = serve(path, () => { calls++; });
    const c = await raw(path);
    c.send('{"type":"flush"');   // never terminated
    const t0 = performance.now();
    await c.closed;
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(IPC_READ_TIMEOUT_MS - 100);
    expect(c.replies()).toEqual([{ type: 'error', error: 'request timeout' }]);
    expect(lines.find((l) => l.msg === 'ipc bad request')).toMatchObject({ error: 'request timeout' });
    expect(calls).toBe(0);
  }, 20_000);
});
