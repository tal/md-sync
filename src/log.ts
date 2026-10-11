// JSON-lines logger with a level filter and redaction.
import { writeAllSync } from './fsutil';
import type { LogLevel } from './types';

// The closed set of `msg` values. They are API for log consumers: add or rename one on purpose
// (test/unit/log.test.ts checks this list against the log calls in src/).
export const LOG_MSGS = [
  'fatal',
  'callback failed',
  'config invalid',
  'config reloaded',
  'config reload failed',
  'config change requires restart',
  'repo config key ignored',
  'repo config invalid',
  'one-off without instance config',
  'startup failed',
  'daemon starting',
  'daemon ready',
  'lock busy',
  'waiting for lock',
  'stale lock removed',
  'cloning',
  'cloned',
  'clone failed',
  'remote mismatch',
  'one-off run',
  'sync queued',
  'sync start',
  'sync done',
  'retry scheduled',
  'flush deferred',
  'run stuck',
  'committed',
  'nothing to commit',
  'flush paths dropped',
  'large file',
  'case collision',
  'nested repository not synced',
  'remote branch missing',
  'remote history rewritten',
  'up to date',
  'rebasing',
  'pushed',
  'push rejected',
  'push rejected by remote',
  'push deferred',
  'network error',
  'auth failed',
  'recovered',
  'git lock held',
  'live git detection unavailable',
  'rescued files',
  'rescue skipped',
  'collision',
  'conflict',
  'delete overridden',
  'data guard stop',
  'stash kept',
  'conflict write raced',
  'worktree write raced',
  'worktree exchange unavailable',
  'worktree move paused',
  'worktree operation failed',
  'worktree operation skipped',
  'local change',
  'backup timers armed',
  'backup timer fired',
  'wake detected',
  'network changed',
  'watcher started',
  'ignored dirs refreshed',
  'watcher error',
  'watcher degraded',
  'ntfy connected',
  'ntfy disconnected',
  'ntfy message ignored',
  'ntfy event',
  'ntfy echo ignored',
  'ipc listening',
  'ipc bad request',
  'ipc error',
  'flush received',
  'shutdown requested',
  'shutdown complete',
  'folder moved',
  'forced exit',
  'event loop stalled',
  'liveness guard unavailable',
  'liveness guard started',
  'git',
] as const;

export type LogFields = Record<string, unknown>;
export type LogMsg = (typeof LOG_MSGS)[number];
export type Logger = {
  readonly level: LogLevel;
  debug(msg: LogMsg, f?: LogFields): void; info(msg: LogMsg, f?: LogFields): void;
  warn(msg: LogMsg, f?: LogFields): void;  error(msg: LogMsg, f?: LogFields): void;
  setLevel(l: LogLevel): void;
  addSecret(s: string): void;      // extra literal to redact (ntfy topic path); replaced with '***' ('/***' if it starts with '/')
};

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED_KEYS = new Set(['ts', 'level', 'msg']);
const MAX_DEPTH = 8;

// Process-wide, so `redact()` (and `errorText()`) hide a secret no matter which logger registered it.
const secrets = new Set<string>();
let secretsSorted: string[] = [];

function registerSecret(s: string): void {
  if (s.replace(/^\/+/, '') === '' || secrets.has(s)) return;
  secrets.add(s);
  secretsSorted = [...secrets].sort((a, b) => b.length - a.length);
}

export function redact(s: string): string {
  let out = s.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');
  for (const secret of secretsSorted) {
    if (out.includes(secret)) out = out.split(secret).join(secret.startsWith('/') ? '/***' : '***');
  }
  const token = process.env.GIT_TOKEN;
  if (token !== undefined && token.length >= 8 && out.includes(token)) out = out.split(token).join('***');
  return out;
}

function singleLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

const NAMED_ERRORS = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError']);

export function errorText(e: unknown): string {
  let s: string;
  if (e instanceof Error) {
    s = e.message === '' ? e.name : NAMED_ERRORS.has(e.name) ? `${e.name}: ${e.message}` : e.message;
  } else if (typeof e === 'string') {
    s = e;
  } else {
    try {
      s = JSON.stringify(e) ?? String(e);
    } catch {
      s = String(e);
    }
  }
  return redact(singleLine(s));
}

export function parseLogLevel(s: string | undefined): LogLevel | 'invalid' {
  if (s === undefined) return 'info';
  const v = s.trim().toLowerCase();
  if (v === '') return 'info';
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'invalid';
}

function clean(v: unknown, key: string, depth: number, stack: Set<object>): unknown {
  if (key === 'error' && v !== undefined) return errorText(v);   // any `error` field: single-line, redacted string
  switch (typeof v) {
    case 'string': return redact(v);
    case 'number': return Number.isFinite(v) ? v : String(v);
    case 'bigint': return v.toString();
    case 'boolean': return v;
    case 'undefined': case 'function': case 'symbol': return undefined;
  }
  if (v === null) return null;
  if (v instanceof Error) return errorText(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
  if (ArrayBuffer.isView(v)) return `<${v.byteLength} bytes>`;   // never log file contents
  const obj = v as object;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (stack.has(obj)) return '[circular]';
  stack.add(obj);
  try {
    if (Array.isArray(obj) || obj instanceof Set) {
      return [...(obj as Iterable<unknown>)].map((x) => clean(x, '', depth + 1, stack) ?? null);
    }
    const entries = obj instanceof Map ? [...obj.entries()].map(([k, x]) => [String(k), x] as const) : Object.entries(obj);
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries) {
      const c = clean(x, k, depth + 1, stack);
      if (c !== undefined) out[k] = c;
    }
    return out;
  } finally {
    stack.delete(obj);
  }
}

// EPIPE (reader gone) and anything else: drop the line. EAGAIN: brief retry, then drop.
function fdWriter(fd: number): (line: string) => void {
  return (line) => writeAllSync(fd, `${line}\n`);
}

function formatLine(level: LogLevel, msg: LogMsg, f: LogFields | undefined): string {
  const obj: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
  if (f) {
    const stack = new Set<object>();
    for (const [k, v] of Object.entries(f)) {
      if (RESERVED_KEYS.has(k)) continue;
      const c = clean(v, k, 0, stack);
      if (c !== undefined) obj[k] = c;
    }
  }
  return JSON.stringify(obj);
}

export function createLogger(o: { level: LogLevel; sink: 'stdout' | 'stderr'; write?: (line: string) => void }): Logger {
  let current: LogLevel = o.level;
  const write = o.write ?? fdWriter(o.sink === 'stdout' ? 1 : 2);
  const emit = (level: LogLevel, msg: LogMsg, f?: LogFields): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[current]) return;
    try {
      let line: string;
      try {
        line = formatLine(level, msg, f);
      } catch {
        // a field whose getter or toJSON throws: keep the event, drop the fields
        line = JSON.stringify({ ts: new Date().toISOString(), level, msg, fields: 'unserializable' });
      }
      write(line);
    } catch {
      // the logger never throws
    }
  };
  return {
    get level() { return current; },
    debug: (msg, f) => emit('debug', msg, f),
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
    setLevel(l) { current = l; },
    addSecret(s) { registerSecret(s); },
  };
}
