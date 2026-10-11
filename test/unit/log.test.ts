import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LOG_MSGS, createLogger, errorText, parseLogLevel, redact } from '../../src/log';
import type { LogMsg } from '../../src/log';
import type { LogLevel } from '../../src/types';

const LOG_TS = resolve(import.meta.dir, '../../src/log.ts');
const SRC = resolve(import.meta.dir, '../../src');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-log-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function capture(level: LogLevel = 'debug') {
  const lines: string[] = [];
  const log = createLogger({ level, sink: 'stdout', write: (l) => lines.push(l) });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, lines, parsed };
}

// The msg of every log call in src/: `.info('x'`, `log[level]('x'`, and the hand-built `msg: 'x'` line liveness.ts
// writes from its worker thread (which bypasses the LogMsg type).
function emittedMsgs(): Set<string> {
  const out = new Set<string>();
  for (const f of new Bun.Glob('**/*.ts').scanSync(SRC)) {
    if (f === 'log.ts') continue;
    const text = readFileSync(join(SRC, f), 'utf8');
    for (const m of text.matchAll(/(?:\.(?:debug|info|warn|error)\(|\]\(|\bmsg: )\s*'([^']+)'/g)) out.add(m[1]!);
  }
  return out;
}

describe('LOG_MSGS', () => {
  test('every entry is emitted by some log call in src/ (no stale msgs)', () => {
    const emitted = emittedMsgs();
    expect(LOG_MSGS.length).toBeGreaterThan(60);
    expect(LOG_MSGS.filter((m) => !emitted.has(m))).toEqual([]);
  });

  test('every msg src/ emits is in the set, including ones built without the logger', () => {
    const known = new Set<string>(LOG_MSGS);
    expect([...emittedMsgs()].filter((m) => !known.has(m))).toEqual([]);
  });

  test('has no duplicates', () => {
    expect(new Set(LOG_MSGS).size).toBe(LOG_MSGS.length);
  });

  test('git events describe real commands from the git wrapper only', () => {
    const emitters = [...new Bun.Glob('**/*.ts').scanSync(SRC)].filter((f) =>
      /(?:\.(?:debug|info|warn|error)\(|\]\(|\bmsg: )\s*'git'/.test(readFileSync(join(SRC, f), 'utf8')));
    expect(emitters).toEqual(['git.ts']);
  });

  test('LogMsg rejects strings outside the set (type level)', () => {
    const ok: LogMsg = 'sync done';
    // @ts-expect-error not a LogMsg
    const bad: LogMsg = 'sync finished';
    expect([ok, bad].length).toBe(2);
  });
});

describe('line format', () => {
  test('one JSON object per line: ts, level, msg, then fields', () => {
    const { log, lines } = capture();
    log.info('pushed', { head: 'abc123', commitsOut: 2 });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).not.toContain('\n');
    expect(line).toMatch(/^\{"ts":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z","level":"info","msg":"pushed","head":"abc123","commitsOut":2\}$/);
  });

  test('without fields', () => {
    const { log, parsed } = capture();
    log.debug('nothing to commit');
    expect(Object.keys(parsed()[0]!)).toEqual(['ts', 'level', 'msg']);
  });

  test('undefined fields are omitted; reserved keys cannot override ts/level/msg', () => {
    const { log, parsed } = capture();
    log.warn('sync done', { error: undefined, msg: 'hijack', level: 'debug', ts: 'x', outcome: 'ok' });
    expect(parsed()[0]).toMatchObject({ level: 'warn', msg: 'sync done', outcome: 'ok' });
    expect(parsed()[0]!.ts).not.toBe('x');
    expect('error' in parsed()[0]!).toBe(false);
  });

  test('Error values become single-line redacted text; nested values are cleaned', () => {
    const { log, parsed } = capture();
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    log.error('fatal', {
      error: new Error('fetch failed\nfatal: https://u:secret@host/repo.git\n'),
      nested: { url: 'https://x:y@h/p', list: ['ssh://git@h/x', 1, null] },
      big: 10n,
      bytes: new Uint8Array(5),
      nan: Number.NaN,
      circ,
      fn: () => 1,
    });
    const line = parsed()[0]!;
    expect(line.error).toBe('fetch failed fatal: https://***@host/repo.git');
    expect(line.nested).toEqual({ url: 'https://***@h/p', list: ['ssh://***@h/x', 1, null] });
    expect(line.big).toBe('10');
    expect(line.bytes).toBe('<5 bytes>');
    expect(line.nan).toBe('NaN');
    expect(line.circ).toEqual({ a: 1, self: '[circular]' });
    expect('fn' in line).toBe(false);
  });

  test('a string `error` field is made single-line; other strings keep newlines (escaped)', () => {
    const { log, lines, parsed } = capture();
    log.debug('git', { args: ['fetch'], stderr: 'line1\nline2', error: 'a\n  b\r\nc' });
    expect(lines[0]).not.toContain('\n');
    expect(parsed()[0]!.stderr).toBe('line1\nline2');
    expect(parsed()[0]!.error).toBe('a b c');
  });

  test('a non-string, non-Error `error` field is still a string', () => {
    const { log, parsed } = capture();
    log.error('callback failed', { source: 'onSha', error: { code: 'EPIPE' } });
    log.error('callback failed', { source: 'onSha', error: 7 });
    expect(parsed().map((l) => l.error)).toEqual(['{"code":"EPIPE"}', '7']);
  });

  test('a field whose getter throws keeps the event and drops the fields', () => {
    const { log, parsed } = capture();
    const evil = { get boom(): string { throw new Error('getter'); } };
    expect(() => log.warn('ipc error', { evil })).not.toThrow();
    expect(parsed()[0]).toMatchObject({ level: 'warn', msg: 'ipc error', fields: 'unserializable' });
  });

  test('the same object twice (not circular) is serialized both times', () => {
    const { log, parsed } = capture();
    const shared = { k: 'v' };
    log.info('conflict', { a: shared, b: [shared, shared] });
    expect(parsed()[0]).toMatchObject({ a: { k: 'v' }, b: [{ k: 'v' }, { k: 'v' }] });
  });
});

describe('levels', () => {
  test('filters below the current level', () => {
    const { log, parsed } = capture('warn');
    log.debug('git');
    log.info('pushed');
    log.warn('network error');
    log.error('fatal');
    expect(parsed().map((l) => l.level)).toEqual(['warn', 'error']);
  });

  test('setLevel changes the filter and the level property', () => {
    const { log, parsed } = capture('error');
    expect(log.level).toBe('error');
    log.info('pushed');
    log.setLevel('debug');
    expect(log.level).toBe('debug');
    log.debug('git');
    expect(parsed().map((l) => l.msg)).toEqual(['git']);
  });

  test('parseLogLevel', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('info')).toBe('info');
    expect(parseLogLevel('warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
    expect(parseLogLevel(' WARN ')).toBe('warn');
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel('verbose')).toBe('invalid');
    expect(parseLogLevel('warning')).toBe('invalid');
  });
});

describe('redaction', () => {
  const savedToken = process.env.GIT_TOKEN;
  afterEach(() => {
    if (savedToken === undefined) delete process.env.GIT_TOKEN;
    else process.env.GIT_TOKEN = savedToken;
  });

  test('URL userinfo is replaced with ***', () => {
    expect(redact('https://user:tok@github.com/o/r.git')).toBe('https://***@github.com/o/r.git');
    expect(redact('fatal: unable to access \'https://x-access-token:ghp_abc@github.com/o/r/\': 403'))
      .toBe('fatal: unable to access \'https://***@github.com/o/r/\': 403');
    expect(redact('a ssh://git@host/x b http://u@h/ c')).toBe('a ssh://***@host/x b http://***@h/ c');
    expect(redact('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(redact('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(redact('mail me at a@b.c')).toBe('mail me at a@b.c');
  });

  test('addSecret: a topic path becomes /*** everywhere, including redact() and errorText()', () => {
    const { log, parsed } = capture();
    log.addSecret('/mdsync-topic-7f3a9c');
    log.warn('ntfy disconnected', { error: 'GET https://ntfy.sh/mdsync-topic-7f3a9c/sse failed', retryInMs: 1000 });
    expect(parsed()[0]!.error).toBe('GET https://ntfy.sh/***/sse failed');
    expect(redact('https://ntfy.example/mdsync-topic-7f3a9c')).toBe('https://ntfy.example/***');
    expect(errorText(new Error('x /mdsync-topic-7f3a9c y'))).toBe('x /*** y');
  });

  test('addSecret: a bare literal becomes ***; empty and "/" are ignored', () => {
    const { log, parsed } = capture();
    log.addSecret('bare-secret-91d2');
    log.addSecret('');
    log.addSecret('/');
    log.info('ntfy connected', { host: 'h', note: 'k=bare-secret-91d2', path: '/a/b' });
    expect(parsed()[0]).toMatchObject({ note: 'k=***', path: '/a/b' });
  });

  test('the GIT_TOKEN value never survives redaction', () => {
    process.env.GIT_TOKEN = 'ghp_TESTTOKEN123';
    expect(redact('remote said ghp_TESTTOKEN123 twice: ghp_TESTTOKEN123')).toBe('remote said *** twice: ***');
    const { log, lines } = capture();
    log.error('auth failed', { op: 'fetch', error: 'bad credentials ghp_TESTTOKEN123' });
    expect(lines[0]).not.toContain('ghp_TESTTOKEN123');
  });
});

describe('errorText', () => {
  test('Error message, single line, redacted', () => {
    expect(errorText(new Error('one\ntwo\n'))).toBe('one two');
    expect(errorText(new Error('see https://a:b@h/x'))).toBe('see https://***@h/x');
  });

  test('built-in JS error classes keep their name; empty messages fall back to the name', () => {
    expect(errorText(new TypeError('x is undefined'))).toBe('TypeError: x is undefined');
    class CustomError extends Error { override name = 'CustomError'; }
    expect(errorText(new CustomError('boom'))).toBe('boom');
    expect(errorText(new CustomError(''))).toBe('CustomError');
  });

  test('non-Error values', () => {
    expect(errorText('plain\nstring')).toBe('plain string');
    expect(errorText({ code: 'E', n: 1 })).toBe('{"code":"E","n":1}');
    expect(errorText(42)).toBe('42');
    expect(errorText(undefined)).toBe('undefined');
    const circ: Record<string, unknown> = {};
    circ.c = circ;
    expect(errorText(circ)).toBe('[object Object]');
  });
});

describe('sinks', () => {
  test('a throwing custom writer never makes the logger throw', () => {
    const log = createLogger({ level: 'debug', sink: 'stdout', write: () => { throw new Error('sink broken'); } });
    expect(() => log.error('fatal', { error: 'x' })).not.toThrow();
  });

  async function runChild(script: string) {
    const file = join(root, `child-${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(file, `import { createLogger } from ${JSON.stringify(LOG_TS)};\n${script}`);
    return Bun.spawn([process.execPath, file], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  }

  test('sink stderr writes JSON lines to fd 2 and nothing to stdout', async () => {
    const p = await runChild(`const log = createLogger({ level: 'info', sink: 'stderr' });
log.info('daemon ready', { socket: '/s', head: 'h' }); log.debug('git');`);
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(0);
    expect(out).toBe('');
    const lines = err.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'info', msg: 'daemon ready', socket: '/s', head: 'h' });
  });

  test('sink stdout writes newline-terminated lines', async () => {
    const p = await runChild(`const log = createLogger({ level: 'info', sink: 'stdout' });
log.info('pushed', { head: 'a' }); log.warn('push deferred', { reason: 'deadline', ahead: 1 });`);
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trim().split('\n').map((l) => JSON.parse(l).msg)).toEqual(['pushed', 'push deferred']);
  });

  test('EPIPE on a closed stdout is swallowed', async () => {
    const p = await runChild(`const log = createLogger({ level: 'info', sink: 'stdout' });
for (let i = 0; i < 20000; i++) log.info('pushed', { head: 'x'.repeat(200), i });
process.stderr.write('finished\\n');`);
    const reader = p.stdout.getReader();
    await reader.read();
    await reader.cancel();
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(0);
    expect(err).toBe('finished\n');
  });
});
