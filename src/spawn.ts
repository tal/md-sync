// Detached child processes with timeouts, bounded pipe drain and a registry for group kills.
import { statSync } from 'node:fs';
import type { Subprocess } from 'bun';
import { errCode } from './fsutil';
import { realClock } from './types';

export const LOCAL_TIMEOUT_MS = 300_000;
export const KILL_GRACE_MS = 5_000;
export const DRAIN_MS = 2_000;

export type SpawnResult = { code: number; stdout: Uint8Array; stderr: Uint8Array; timedOut: 'timed-out' | 'in-time';
  drain: 'complete' | 'truncated'; spawnError?: string; durationMs: number };

export class SpawnNotFoundError extends Error {
  readonly file: string;
  constructor(file: string, options?: ErrorOptions) {
    super(`executable not found: ${file}`, options);
    this.name = 'SpawnNotFoundError';
    this.file = file;
  }
}

const SIGKILL_EXIT = 128 + 9;
const EMPTY = new Uint8Array(0);

// pid === pgid for every entry (detached => setsid). An entry leaves when its leader exits.
const children = new Map<number, Subprocess>();
const childPids = new Set<number>();

export function liveChildPids(): ReadonlySet<number> {
  return childPids;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals, proc: Subprocess): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      // already gone
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}

function delay(ms: number): { done: Promise<void>; cancel(): void } {
  let resolveFn: () => void = () => {};
  const done = new Promise<void>((r) => { resolveFn = r; });
  const h = realClock.setTimeout(() => resolveFn(), ms);
  return { done, cancel: () => { realClock.clearTimeout(h); resolveFn(); } };
}

type Collector = { chunks: Uint8Array[]; done: Promise<void>; cancel(): void };

function collect(stream: ReadableStream<Uint8Array>, onData: () => void): Collector {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        chunks.push(r.value);
        onData();
      }
    } catch {
      // cancelled or broken pipe: keep what was read
    }
  })();
  return { chunks, done, cancel: () => { reader.cancel().catch(() => {}); } };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return EMPTY;
  if (chunks.length === 1) return chunks[0]!;
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// timeoutMs bounds the whole run. stallMs, when set, bounds the time without any output on stdout or stderr: a git
// transfer run with --progress reports at least once a second while bytes move, so a slow but working link is not
// killed (it used to be, at a fixed 120 s, then restarted from zero), while a dead one still is.
export async function spawnTracked(argv: string[], o: { cwd: string; env: Record<string, string | undefined>;
  input?: Uint8Array; timeoutMs: number; stallMs?: number }): Promise<SpawnResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const file = argv[0];
  if (file === undefined) throw new Error('spawnTracked: empty argv');

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined) env[k] = v;

  let proc: Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(argv, {
      cwd: o.cwd,
      env,
      stdin: o.input ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    }) as Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'>;
  } catch (e) {
    // Bun reports a missing cwd as ENOENT too; only a missing executable is SpawnNotFoundError.
    if (errCode(e) === 'ENOENT' && isDir(o.cwd)) throw new SpawnNotFoundError(file, { cause: e });
    const why = errCode(e) === 'ENOENT' ? `cwd not found: ${o.cwd}` : errMessage(e);
    return { code: -1, stdout: EMPTY, stderr: EMPTY, timedOut: 'in-time', drain: 'complete', spawnError: why, durationMs: elapsed() };
  }

  const pid = proc.pid;
  children.set(pid, proc);
  childPids.add(pid);
  void proc.exited.finally(() => {
    children.delete(pid);
    childPids.delete(pid);
  });

  // Timeout: SIGTERM the group, SIGKILL it after KILL_GRACE_MS, and stop waiting for an unkillable
  // leader KILL_GRACE_MS after that so the promise always settles.
  let timedOut: SpawnResult['timedOut'] = 'in-time';
  let result: 'pending' | 'settled' = 'pending';
  let abandonTimer: unknown;
  let abandon: () => void = () => {};
  const abandoned = new Promise<number>((r) => { abandon = () => r(SIGKILL_EXIT); });
  const expire = (): void => {
    if (timedOut === 'timed-out' || result === 'settled') return;
    timedOut = 'timed-out';
    signalGroup(pid, 'SIGTERM', proc);
    // Not cleared on leader exit: group members that ignored SIGTERM still get the SIGKILL.
    realClock.setTimeout(() => {
      if (groupAlive(pid)) signalGroup(pid, 'SIGKILL', proc);
      if (result === 'pending') abandonTimer = realClock.setTimeout(abandon, KILL_GRACE_MS);
    }, KILL_GRACE_MS);
  };
  const timeout = realClock.setTimeout(expire, Math.max(0, o.timeoutMs));
  let stall: unknown;
  const progress = (): void => {
    if (o.stallMs === undefined || timedOut === 'timed-out') return;
    realClock.clearTimeout(stall);
    stall = realClock.setTimeout(expire, Math.max(0, o.stallMs));
  };
  progress();

  const out = collect(proc.stdout, progress);
  const err = collect(proc.stderr, progress);

  const code = await Promise.race([proc.exited, abandoned]);
  result = 'settled';
  realClock.clearTimeout(timeout);
  realClock.clearTimeout(stall);
  realClock.clearTimeout(abandonTimer);

  const grace = delay(DRAIN_MS);
  const drain = await Promise.race([
    Promise.all([out.done, err.done]).then(() => 'complete' as const),
    grace.done.then(() => 'truncated' as const),
  ]);
  grace.cancel();
  if (drain === 'truncated') {
    out.cancel();
    err.cancel();
  }

  return { code, stdout: concat(out.chunks), stderr: concat(err.chunks), timedOut, drain, durationMs: elapsed() };
}

export async function killChildrenGracefully(graceMs = 2_000): Promise<void> {
  const targets = [...children.entries()];
  if (targets.length === 0) return;
  for (const [pid, proc] of targets) signalGroup(pid, 'SIGTERM', proc);
  const grace = delay(graceMs);
  await Promise.race([Promise.all(targets.map(([, p]) => p.exited)), grace.done]);
  grace.cancel();
  const survivors = targets.filter(([pid]) => groupAlive(pid));
  if (survivors.length === 0) return;
  for (const [pid, proc] of survivors) signalGroup(pid, 'SIGKILL', proc);
  const settle = delay(1_000);
  await Promise.race([Promise.all(survivors.map(([, p]) => p.exited)), settle.done]);
  settle.cancel();
}
