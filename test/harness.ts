// Integration-test harness: temp envs, bare remotes, clones, daemons, a fake ntfy server,
// git race/slow-push hooks and stopped-git-state builders. All waits are log-driven or waitFor-polled.
import { expect } from 'bun:test';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { InstanceInput } from '../src/config';
import { CONFLICT_COPY_RE } from '../src/conflict-name';
import { shortHostname } from '../src/host';
import { liveGitIn, type LiveGitScan } from '../src/live-git';
import type { LogMsg } from '../src/log';
import { killChildrenGracefully, spawnTracked } from '../src/spawn';
import type { LogLevel, SyncOutcome, TriggerLabel } from '../src/types';

export { CONFLICT_COPY_RE };

export type LogLine = { ts: string; level: LogLevel; msg: string; [field: string]: unknown };

// The authorName a daemon commits as with no instance config.
export const DEFAULT_AUTHOR = `mdsync@${shortHostname()}`;

// Matches a log line by msg and a subset of its fields.
export const is = (msg: LogMsg, fields: Record<string, unknown> = {}) => (l: LogLine): boolean =>
  l.msg === msg && Object.entries(fields).every(([k, v]) => Bun.deepEquals(l[k], v));

export type TestEnv = {
  root: string;
  home: string; stateHome: string; configHome: string;
  env: Record<string, string>;
};

const REPO_ROOT = resolve(import.meta.dir, '..');
const HELPER_NAME = 'Test Helper';
const HELPER_EMAIL = 'helper@test.invalid';
const GIT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_MS = 30_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- registries (cleanupAll) ----

const roots: string[] = [];
const daemons: Daemon[] = [];
const servers: FakeNtfy[] = [];
const notifiers: { stop(): Promise<void> }[] = [];
const holders: { release(): Promise<void> }[] = [];
const slowPushes: SlowPush[] = [];
const daemonAuthors = new Map<string, Set<string>>();   // root -> configured daemon authorName values
const remoteEnvs = new WeakMap<Remote, TestEnv>();
let seq = 0;

function nextId(): number {
  seq += 1;
  return seq;
}

// Writes pretty JSON, creating parent folders.
export function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
}

// expectNoMdsyncArtifacts accepts only Test Helper and these authors. startDaemon registers its daemon's;
// tests whose commits come from elsewhere (a one-off flush, sync-once) register them here.
export function allowAuthor(t: TestEnv, authorName: string): void {
  const authors = daemonAuthors.get(t.root) ?? new Set<string>();
  authors.add(authorName);
  daemonAuthors.set(t.root, authors);
}

export async function setupTestEnv(name: string): Promise<TestEnv> {
  const safe = name.replace(/[^A-Za-z0-9_.-]+/g, '-');
  const root = realpathSync(mkdtempSync(join(tmpdir(), `mdsync-test-${safe}-`)));
  roots.push(root);
  const home = join(root, 'home');
  const stateHome = join(root, 'state');
  const configHome = join(root, 'config');
  for (const d of [home, stateHome, configHome]) mkdirSync(d, { recursive: true });
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig,
    `[init]\n\tdefaultBranch = main\n[user]\n\tname = ${HELPER_NAME}\n\temail = ${HELPER_EMAIL}\n`);
  return {
    root, home, stateHome, configHome,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
      MDSYNC_LOG_LEVEL: 'debug',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitconfig,
      TZ: 'UTC',
      LC_ALL: 'C',
      // `MDSYNC_TEST_WATCHER=poll bun test test/acceptance` runs every daemon on the Linux watcher backend
      ...(process.env.MDSYNC_TEST_WATCHER !== undefined ? { MDSYNC_TEST_WATCHER: process.env.MDSYNC_TEST_WATCHER } : {}),
      // `MDSYNC_TEST_EXCHANGE_MODE=rename-only|copy-only` caps the worktree move's exchange probe
      ...(process.env.MDSYNC_TEST_EXCHANGE_MODE !== undefined
        ? { MDSYNC_TEST_EXCHANGE_MODE: process.env.MDSYNC_TEST_EXCHANGE_MODE } : {}),
    },
  };
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

async function settle(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.catch(() => {}), new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

export async function cleanupAll(): Promise<void> {
  for (const n of notifiers.splice(0)) await n.stop().catch(() => {});
  for (const d of daemons.splice(0)) {
    killGroup(d.proc.pid, 'SIGKILL');
    await settle(d.exited, 5_000);
  }
  for (const s of slowPushes.splice(0)) await s.release().catch(() => {});
  for (const h of holders.splice(0)) await h.release().catch(() => {});
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  await killChildrenGracefully(1_000);
  daemonAuthors.clear();
  const keep = process.env.MDSYNC_KEEP_TMP === 'keep';
  for (const root of roots.splice(0)) {
    if (keep) {
      process.stderr.write(`md-sync harness: kept ${root}\n`);
      continue;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---- git helpers ----

type GitOut = { code: number; stdout: string; stderr: string };

async function runGit(env: Record<string, string>, cwd: string, args: string[], input?: string): Promise<GitOut> {
  const r = await spawnTracked(['git', ...args], {
    cwd, env, input: input === undefined ? undefined : enc.encode(input), timeoutMs: GIT_TIMEOUT_MS,
  });
  const stderr = dec.decode(r.stderr) + (r.spawnError !== undefined ? `\n(spawn error: ${r.spawnError})` : '')
    + (r.timedOut === 'timed-out' ? '\n(timed out)' : '');
  return { code: r.code, stdout: dec.decode(r.stdout), stderr };
}

async function gitOk(env: Record<string, string>, cwd: string, args: string[], input?: string): Promise<string> {
  const r = await runGit(env, cwd, args, input);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}) in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout;
}

async function revOrNone(env: Record<string, string>, cwd: string, rev: string): Promise<string | 'none'> {
  const r = await runGit(env, cwd, ['rev-parse', '-q', '--verify', `${rev}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : 'none';
}

function splitNul(s: string): string[] {
  return s.split('\0').filter((x) => x !== '');
}

export type CommitInfo = { sha: string; subject: string; body: string; authorName: string; files: string[] };

const LOG_FORMAT = '%x1e%H%x1f%an%x1f%s%x1f%b%x1f';

function parseLog(out: string): CommitInfo[] {
  return out.split('\x1e').slice(1).map((chunk) => {
    const [sha = '', authorName = '', subject = '', body = '', rest = ''] = chunk.split('\x1f');
    const files = rest.split('\0').map((f) => f.replace(/^\n/, '')).filter((f) => f !== '');
    return { sha, subject, body: body.trimEnd(), authorName, files };
  });
}

async function logOf(env: Record<string, string>, cwd: string, rev: string): Promise<CommitInfo[]> {
  const out = await gitOk(env, cwd,
    ['-c', 'core.quotePath=false', 'log', '-z', '--name-only', '--no-renames', `--format=${LOG_FORMAT}`, rev, '--']);
  return parseLog(out);
}

// ---- remote ----

export type Remote = {
  path: string; url: string;
  head(): Promise<string | 'none'>;
  log(): Promise<CommitInfo[]>;
  show(rel: string, rev?: string): Promise<string | undefined>;
  tree(rev?: string): Promise<string[]>;
  push(files: Record<string, string | null>, message: string): Promise<string>;
  setUnreachable(): Promise<void>;
  restore(): Promise<void>;
};

export async function createRemote(t: TestEnv, o?: { seed?: 'seeded' | 'empty'; files?: Record<string, string> }): Promise<Remote> {
  const target = join(t.root, existsSync(join(t.root, 'remote.git')) ? `remote-${nextId()}.git` : 'remote.git');
  await gitOk(t.env, t.root, ['init', '-q', '--bare', '-b', 'main', target]);
  const path = realpathSync(target);
  const away = `${path}.away`;
  let reach: 'reachable' | 'unreachable' = 'reachable';
  // Reads inspect the bare repo wherever it currently is; pushes go through the url and fail while it is away.
  const where = (): string => (reach === 'reachable' ? path : away);

  const remote: Remote = {
    path,
    url: path,
    head: () => revOrNone(t.env, where(), 'refs/heads/main'),
    async log() {
      if ((await revOrNone(t.env, where(), 'refs/heads/main')) === 'none') return [];
      return logOf(t.env, where(), 'refs/heads/main');
    },
    async show(rel, rev = 'refs/heads/main') {
      // Missing path, missing rev or a tree at the path: undefined.
      const r = await runGit(t.env, where(), ['cat-file', 'blob', `${rev}:${rel}`]);
      return r.code === 0 ? r.stdout : undefined;
    },
    async tree(rev = 'refs/heads/main') {
      if ((await revOrNone(t.env, where(), rev)) === 'none') return [];
      return splitNul(await gitOk(t.env, where(), ['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev])).sort();
    },
    async push(files, message) {
      const helper = mkdtempSync(join(t.root, 'push-helper-'));
      try {
        await gitOk(t.env, t.root, ['clone', '-q', remote.url, helper]);
        for (const [rel, content] of Object.entries(files)) {
          const abs = join(helper, rel);
          if (content === null) {
            rmSync(abs, { recursive: true, force: true });
          } else {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, content);
          }
        }
        await gitOk(t.env, helper, ['add', '-A']);
        await gitOk(t.env, helper, ['commit', '-q', '--allow-empty', '--cleanup=verbatim', '-F', '-'], message);
        await gitOk(t.env, helper, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
        return (await gitOk(t.env, helper, ['rev-parse', 'HEAD'])).trim();
      } finally {
        rmSync(helper, { recursive: true, force: true });
      }
    },
    async setUnreachable() {
      if (reach === 'unreachable') return;
      renameSync(path, away);
      reach = 'unreachable';
    },
    async restore() {
      if (reach === 'reachable') return;
      renameSync(away, path);
      reach = 'reachable';
    },
  };
  remoteEnvs.set(remote, t);
  if ((o?.seed ?? 'seeded') === 'seeded') await remote.push(o?.files ?? { 'README.md': '# notes\n' }, 'seed');
  return remote;
}

// ---- clones ----

export type Clone = {
  dir: string;
  git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  write(rel: string, content: string | Uint8Array): Promise<void>;
  read(rel: string): Promise<string | undefined>;
  remove(rel: string): Promise<void>;
  files(): Promise<string[]>;
  head(): Promise<string>;
  log(range?: string): Promise<CommitInfo[]>;
  porcelain(): Promise<string[]>;
  conflictCopies(): Promise<string[]>;
  stashList(): Promise<string[]>;
};

// The worktree move's temp folders: replaced inodes wait there for SETTLE_GRACE_MS after a move.
const MOVE_TEMP_RE = /(^|\/)\.mdsync-\d+-\d+\.d(\/|$)/;

// Every non-directory entry under dir (symlinks not followed), as sorted POSIX paths; skips the top-level .git and,
// unless asked for, the move's temp folders (they settle on their own; expectNoMdsyncArtifacts checks they did).
function listFiles(dir: string, temps: 'skip-temps' | 'with-temps' = 'skip-temps'): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (rel === '' && e.name === '.git') continue;
      if (temps === 'skip-temps' && e.isDirectory() && MOVE_TEMP_RE.test(e.name)) continue;
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0');
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e === undefined || e === '') continue;
    const xy = e.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) {
      i += 1;
      lines.push(`${xy} ${parts[i] ?? ''} -> ${e.slice(3)}`);
    } else {
      lines.push(e);
    }
  }
  return lines;
}

export function openClone(t: TestEnv, dir: string): Clone {
  const g = (args: string[]) => runGit(t.env, dir, args);
  const ok = (args: string[]) => gitOk(t.env, dir, args);
  return {
    dir,
    git: g,
    async write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      await Bun.write(abs, content);
    },
    async read(rel) {
      try {
        return await Bun.file(join(dir, rel)).text();
      } catch {
        return undefined;
      }
    },
    async remove(rel) {
      rmSync(join(dir, rel), { recursive: true, force: true });
    },
    files: async () => listFiles(dir),
    async head() {
      const h = await revOrNone(t.env, dir, 'HEAD');
      return h === 'none' ? 'unborn' : h;
    },
    async log(range = 'HEAD') {
      if (range === 'HEAD' && (await revOrNone(t.env, dir, 'HEAD')) === 'none') return [];
      return logOf(t.env, dir, range);
    },
    // Unquoted paths (parsed from -z); renames render as `XY orig -> path`. No optional locks: never races the daemon.
    porcelain: async () => parsePorcelainZ(await ok(['--no-optional-locks', 'status', '--porcelain=v1', '-uall', '-z']))
      .filter((l) => !MOVE_TEMP_RE.test(l.slice(3))),
    conflictCopies: async () => listFiles(dir).filter((p) => CONFLICT_COPY_RE.test(p)),
    async stashList() {
      return (await ok(['stash', 'list'])).split('\n').filter((l) => l !== '');
    },
  };
}

export async function cloneRemote(t: TestEnv, r: Remote, name: string): Promise<Clone> {
  const dir = join(t.root, name);
  await gitOk(t.env, t.root, ['clone', '-q', r.url, dir]);
  return openClone(t, realpathSync(dir));
}

export function emptyDir(t: TestEnv, name: string): string {
  const dir = join(t.root, name);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

// ---- CLI ----

export type CliResult = { code: number; stdout: string; stderr: string; logs: LogLine[] };

export function cmd(): string[] {
  const bin = process.env.MDSYNC_BIN;
  return bin !== undefined && bin !== '' ? [bin] : [process.execPath, join(REPO_ROOT, 'src', 'cli.ts')];
}

function parseLogLine(line: string): LogLine | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === 'object' && v !== null && typeof (v as { msg?: unknown }).msg === 'string') return v as LogLine;
  } catch {
    // not JSON
  }
  return undefined;
}

function logsOf(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of text.split('\n')) {
    const l = parseLogLine(line);
    if (l !== undefined) out.push(l);
  }
  return out;
}

// logs: JSON lines from stdout, then from stderr (status / print-workflow / *-service log to stderr).
export async function runCli(t: TestEnv, args: string[], o?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<CliResult> {
  const r = await spawnTracked([...cmd(), ...args], {
    cwd: o?.cwd ?? t.root,
    env: { ...t.env, ...o?.env },
    timeoutMs: o?.timeoutMs ?? 120_000,
  });
  const stdout = dec.decode(r.stdout);
  const stderr = dec.decode(r.stderr) + (r.spawnError !== undefined ? `\n(spawn error: ${r.spawnError})` : '');
  return { code: r.code, stdout, stderr, logs: [...logsOf(stdout), ...logsOf(stderr)] };
}

// ---- daemons ----

// launch: 'config-file' (default) writes an instance file with dir, remote, author and test timers and passes --config;
// 'from-cwd' is the zero-config start: `md-sync run` with only `args`, no config file, started in `dir` (so dir, remote
// and branch come from that checkout, and the author is the default `mdsync@<hostname>`).
export type DaemonOpts = {
  name: string; dir: string; remote: Remote;
  config?: InstanceInput;
  args?: string[]; env?: Record<string, string>; ntfy?: FakeNtfy;
  wait?: 'ready' | 'none';
  launch?: 'config-file' | 'from-cwd';
};

export type Daemon = {
  name: string; dir: string; configPath: string | 'none'; proc: Bun.Subprocess;
  logs: LogLine[]; stderr(): string; nonJsonStdout(): string[];
  mark(): number;
  waitForLog(pred: string | ((l: LogLine) => boolean), o?: { since?: number; timeoutMs?: number }): Promise<LogLine>;
  waitForSync(o?: { since?: number; reason?: TriggerLabel; outcome?: SyncOutcome; timeoutMs?: number }): Promise<LogLine>;
  flush(args?: string[]): Promise<CliResult>;
  signal(sig: 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGKILL'): void;
  signalGroup(sig: 'SIGTERM' | 'SIGINT'): void;
  stop(): Promise<number>;
  exited: Promise<number>;
};

type LogWaiter = { pred: (l: LogLine) => boolean; since: number; resolve(l: LogLine): void; reject(e: Error): void };

function hasReason(l: LogLine, reason: TriggerLabel): boolean {
  return Array.isArray(l.reasons) && (l.reasons as unknown[]).includes(reason);
}

export async function startDaemon(t: TestEnv, o: DaemonOpts): Promise<Daemon> {
  const config: Record<string, unknown> = {
    remote: o.remote.url,
    dir: o.dir,
    branch: 'main',   // no default branch: a fresh clone (an empty `dir`) needs it named
    authorName: `mdsync-${o.name}`,
    authorEmail: `${o.name}@test.invalid`,
    idleMs: 60_000,
    maxWaitMs: 120_000,
    fallbackMs: 3_600_000,
    ...(o.ntfy !== undefined ? { ntfyUrl: o.ntfy.topicUrl } : {}),
    ...o.config,
  };
  const launch = o.launch ?? 'config-file';
  let configPath: string | 'none' = 'none';
  if (launch === 'config-file') {
    configPath = join(t.configHome, 'mdsync', `${o.name}.json`);
    writeJson(configPath, config);
  }
  allowAuthor(t, launch === 'config-file' ? String(config.authorName) : DEFAULT_AUTHOR);

  const proc = Bun.spawn([...cmd(), 'run', ...(configPath !== 'none' ? ['--config', configPath] : []), ...(o.args ?? [])], {
    cwd: launch === 'config-file' ? t.root : o.dir,
    env: { ...t.env, ...o.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });

  const logs: LogLine[] = [];
  const nonJson: string[] = [];
  let stderrText = '';
  let stream: 'open' | 'closed' = 'open';
  const waiters = new Set<LogWaiter>();

  const describeTail = (): string => {
    const tail = logs.slice(-25).map((l) => `${l.level} ${l.msg}${l.level === 'error' && l.error !== undefined ? ` (${String(l.error)})` : ''}`).join(' | ');
    const errTail = stderrText.trim().split('\n').slice(-10).join(' | ');
    return `last logs: [${tail}]; stderr: [${errTail}]`;
  };
  const push = (line: string): void => {
    if (line === '') return;
    const l = parseLogLine(line);
    if (l === undefined) {
      nonJson.push(line);
      return;
    }
    logs.push(l);
    const i = logs.length - 1;
    for (const w of [...waiters]) {
      if (i >= w.since && w.pred(l)) {
        waiters.delete(w);
        w.resolve(l);
      }
    }
  };

  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader();
    const td = new TextDecoder();
    let buf = '';
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done) break;
      buf += td.decode(r.value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    }
    push(buf + td.decode());
  })();
  void (async () => {
    const td = new TextDecoder();
    const reader = proc.stderr.getReader();
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (r.done) break;
      stderrText += td.decode(r.value, { stream: true });
    }
    stderrText += td.decode();
  })();
  const exited = proc.exited;
  void (async () => {
    await stdoutDone;
    const code = await exited;
    stream = 'closed';
    for (const w of [...waiters]) {
      waiters.delete(w);
      w.reject(new Error(`daemon ${o.name} exited (code ${code}) before the awaited log line; ${describeTail()}`));
    }
  })();

  const waitForLog: Daemon['waitForLog'] = (pred, wo) => {
    const test = typeof pred === 'string' ? (l: LogLine) => l.msg === pred : pred;
    const what = typeof pred === 'string' ? `"${pred}"` : 'predicate';
    const since = wo?.since ?? 0;
    for (let i = since; i < logs.length; i++) {
      const l = logs[i];
      if (l !== undefined && test(l)) return Promise.resolve(l);
    }
    if (stream === 'closed') {
      return Promise.reject(new Error(`daemon ${o.name} already exited; ${what} not logged; ${describeTail()}`));
    }
    const timeoutMs = wo?.timeoutMs ?? DEFAULT_WAIT_MS;
    return new Promise<LogLine>((resolveFn, rejectFn) => {
      const timer = setTimeout(() => {
        waiters.delete(w);
        rejectFn(new Error(`daemon ${o.name}: timed out after ${timeoutMs} ms waiting for ${what}; ${describeTail()}`));
      }, timeoutMs);
      const w: LogWaiter = {
        pred: test, since,
        resolve: (l) => { clearTimeout(timer); resolveFn(l); },
        reject: (e) => { clearTimeout(timer); rejectFn(e); },
      };
      waiters.add(w);
    });
  };

  const daemon: Daemon = {
    name: o.name, dir: o.dir, configPath, proc, logs,
    stderr: () => stderrText,
    nonJsonStdout: () => [...nonJson],
    mark: () => logs.length,
    waitForLog,
    waitForSync: (so) => waitForLog(
      (l) => l.msg === 'sync done'
        && (so?.reason === undefined || hasReason(l, so.reason))
        && (so?.outcome === undefined || l.outcome === so.outcome),
      { since: so?.since, timeoutMs: so?.timeoutMs },
    ),
    flush: (args = []) => runCli(t, ['flush', '--dir', o.dir, ...args]),
    signal(sig) {
      try {
        process.kill(proc.pid, sig);
      } catch {
        // already gone
      }
    },
    signalGroup(sig) {
      killGroup(proc.pid, sig);
    },
    async stop() {
      daemon.signal('SIGTERM');
      return exited;
    },
    exited,
  };
  daemons.push(daemon);

  if ((o.wait ?? 'ready') === 'ready') {
    await waitForLog('daemon ready', { timeoutMs: 60_000 });
    await daemon.waitForSync({ reason: 'startup', timeoutMs: 60_000 });
    if (o.ntfy !== undefined) {
      const connected = await waitForLog('ntfy connected', { timeoutMs: 60_000 });
      const ci = logs.indexOf(connected);
      // The first-connect catch-up run, or a startup run that started after the subscription (no push can fall in a gap).
      const startedAfterConnect = (runId: unknown): boolean =>
        logs.some((l, i) => i > ci && l.msg === 'sync start' && l.runId === runId);
      await waitForLog((l) => l.msg === 'sync done'
        && (hasReason(l, 'ntfy-connect') || (hasReason(l, 'startup') && startedAfterConnect(l.runId))),
      { timeoutMs: 60_000 });
    }
  }
  return daemon;
}

// ---- fake ntfy ----

export type FakeNtfy = {
  topicUrl: string;
  publish(message: string): Promise<void>;
  dropConnections(): void;
  connectionCount(): number;
  waitForConnections(n: number, o?: { timeoutMs?: number }): Promise<void>;
  close(): Promise<void>;
};

type SseConn = { controller: ReadableStreamDefaultController<Uint8Array> };

export async function fakeNtfy(): Promise<FakeNtfy> {
  const topic = `mdsynctest${crypto.randomUUID().replaceAll('-', '')}`;
  const conns = new Set<SseConn>();
  const eventId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const now = (): number => Math.floor(Date.now() / 1000);

  const send = (c: SseConn, text: string): void => {
    try {
      c.controller.enqueue(enc.encode(text));
    } catch {
      conns.delete(c);
    }
  };
  const broadcast = (message: string): void => {
    const data = JSON.stringify({ id: eventId(), time: now(), event: 'message', topic, message });
    for (const c of [...conns]) send(c, `data: ${data}\n\n`);
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === `/${topic}/sse`) {
        let conn: SseConn | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            conn = { controller };
            conns.add(conn);
            const open = JSON.stringify({ id: eventId(), time: now(), event: 'open', topic });
            send(conn, `event: open\ndata: ${open}\n\n`);
          },
          cancel() {
            if (conn !== undefined) conns.delete(conn);
          },
        });
        req.signal.addEventListener('abort', () => {
          if (conn !== undefined) conns.delete(conn);
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
      }
      if ((req.method === 'POST' || req.method === 'PUT') && path === `/${topic}`) {
        const body = await req.text();
        broadcast(body);
        return Response.json({ id: eventId(), time: now(), event: 'message', topic, message: body });
      }
      return new Response('not found', { status: 404 });
    },
  });

  const dropConnections = (): void => {
    for (const c of [...conns]) {
      conns.delete(c);
      try {
        c.controller.close();
      } catch {
        // already closed
      }
    }
  };
  let state: 'open' | 'closed' = 'open';
  const ntfy: FakeNtfy = {
    topicUrl: `http://127.0.0.1:${server.port}/${topic}`,
    async publish(message) {
      broadcast(message);
    },
    dropConnections,
    connectionCount: () => conns.size,
    async waitForConnections(n, o) {
      await waitFor(() => conns.size >= n, { timeoutMs: o?.timeoutMs ?? DEFAULT_WAIT_MS, label: `${n} ntfy connection(s)` });
    },
    async close() {
      if (state === 'closed') return;
      state = 'closed';
      dropConnections();
      await server.stop(true);
    },
  };
  servers.push(ntfy);
  return ntfy;
}

export function remoteNotifier(r: Remote, n: FakeNtfy, intervalMs = 200): { stop(): Promise<void> } {
  const t = remoteEnvs.get(r);
  const env = t?.env ?? { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
  // Baseline read synchronously, so a push made right after this call is always published.
  let last = 'none';
  if (existsSync(r.path)) {
    const base = Bun.spawnSync(['git', 'rev-parse', '-q', '--verify', 'refs/heads/main'], { cwd: r.path, env });
    if (base.exitCode === 0) last = base.stdout.toString().trim();
  }
  let state: 'running' | 'stopped' = 'running';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (!existsSync(r.path)) return;   // setUnreachable(): nothing to see
    const head = await revOrNone(env, r.path, 'refs/heads/main');
    if (state === 'running' && head !== 'none' && head !== last) {
      last = head;
      await n.publish(head).catch(() => {});
    }
  };
  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = tick().catch(() => {}).finally(() => {
        if (state === 'running') schedule();
      });
    }, intervalMs);
  };
  schedule();
  const handle = {
    async stop() {
      state = 'stopped';
      clearTimeout(timer);
      await inFlight;
    },
  };
  notifiers.push(handle);
  return handle;
}

// ---- network changes ----

export type FakeNetwork = { env: Record<string, string>; set(entries: string[]): void };

// The daemon's network watcher reads this file instead of the interfaces (MDSYNC_TEST_NETWORK_FILE). Written
// through a temp file and a rename, so a tick never reads half a file.
export function fakeNetwork(t: TestEnv, entries: string[] = ['en0|192.0.2.10']): FakeNetwork {
  const file = join(t.root, `network-${nextId()}.json`);
  const set = (next: string[]): void => {
    writeFileSync(`${file}.tmp`, JSON.stringify(next));
    renameSync(`${file}.tmp`, file);
  };
  set(entries);
  return { env: { MDSYNC_TEST_NETWORK_FILE: file }, set };
}

// ---- git race / slow push hooks ----

export type UploadPackRace = { env: Record<string, string>; arm(times?: number): Promise<void>; fired(): boolean };

// Probe-verified stand-in for git-upload-pack (probe e5). Serves the fetch, then, if the arm file exists, consumes it
// and pushes one commit from a helper clone before the fetch returns, so the caller's next push is non-fast-forward.
// The race commit is authored by the test helper, not the identity mdsync passes in its env.
const RACE_UPLOAD_PACK = `#!/bin/sh
# RACE_ARM: arm file (create it to trigger races; it holds how many, 1 when empty); RACE_HELPER: separate clone of
# the same remote; RACE_LOG (optional): argv/env debug log.
[ -n "$RACE_LOG" ] && { echo "argv: $*"; env | grep -E '^GIT_' | sort; } >> "$RACE_LOG"
git upload-pack "$@"
status=$?
claim() {
  n=$(cat "$RACE_ARM" 2>/dev/null) || return 1
  if [ "\${n:-1}" -gt 1 ] 2>/dev/null; then echo $((n - 1)) > "$RACE_ARM"; else rm "$RACE_ARM" 2>/dev/null; fi
}
if [ "$status" -eq 0 ] && [ -n "$RACE_ARM" ] && claim; then
  (
    unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_PARAMETERS \\
          GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PROTOCOL
    export GIT_AUTHOR_NAME='${HELPER_NAME}' GIT_AUTHOR_EMAIL='${HELPER_EMAIL}' \\
           GIT_COMMITTER_NAME='${HELPER_NAME}' GIT_COMMITTER_EMAIL='${HELPER_EMAIL}'
    cd "$RACE_HELPER" &&
    git pull -q --rebase origin main &&
    echo "race $$" >> race.md && git add race.md &&
    git commit -q -m "race commit" &&
    git push -q origin main
  ) >/dev/null 2>&1 </dev/null
fi
exit $status
`;

export async function raceUploadPack(t: TestEnv, r: Remote): Promise<UploadPackRace> {
  const script = join(t.root, 'race-upload-pack.sh');
  const helper = join(t.root, 'race-helper');
  const arm = join(t.root, 'race.arm');
  writeFileSync(script, RACE_UPLOAD_PACK);
  chmodSync(script, 0o755);
  await gitOk(t.env, t.root, ['clone', '-q', r.url, helper]);
  return {
    env: {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.uploadpack', GIT_CONFIG_VALUE_0: script,
      RACE_ARM: arm, RACE_HELPER: helper,
    },
    async arm(times = 1) {
      writeFileSync(arm, times === 1 ? '' : String(times));
    },
    fired: () => !existsSync(arm),
  };
}

export type SlowPush = { env: Record<string, string>; started(): Promise<void>; release(): Promise<void> };

export async function slowReceivePack(t: TestEnv): Promise<SlowPush> {
  const script = join(t.root, 'slow-receive-pack.sh');
  const startedFile = join(t.root, 'push.started');
  const releaseFile = join(t.root, 'push.release');
  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
  writeFileSync(script, `#!/bin/sh
: > ${q(startedFile)}
i=0
while [ ! -e ${q(releaseFile)} ] && [ $i -lt 600 ]; do
  [ -d ${q(t.root)} ] || exit 1
  sleep 0.1
  i=$((i + 1))
done
exec git receive-pack "$@"
`);
  chmodSync(script, 0o755);
  const slow: SlowPush = {
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.receivepack', GIT_CONFIG_VALUE_0: script },
    async started() {
      await waitFor(() => existsSync(startedFile), { timeoutMs: DEFAULT_WAIT_MS, label: 'slow push started' });
    },
    async release() {
      if (existsSync(t.root)) writeFileSync(releaseFile, '');
    },
  };
  slowPushes.push(slow);
  return slow;
}

// ---- Git LFS ----

export const HAS_LFS = Bun.spawnSync(['git', 'lfs', 'version']).exitCode === 0;

// A git-lfs custom transfer agent standing in for an LFS server (lfs.standalonetransferagent, set in the clone's own
// config): objects live as <store>/<oid>. An upload takes `uploadMs`, reported in progress events every 250 ms, as a
// slow uplink would; a download of an object the store lacks fails like a server's 404.
export type LfsStore = { dir: string; configure(c: Clone): Promise<void>; add(oid: string, from: string): void };

export function lfsStore(t: TestEnv, o: { uploadMs?: number } = {}): LfsStore {
  const dir = join(t.root, `lfs-store-${nextId()}`);
  mkdirSync(dir, { recursive: true });
  const agent = join(t.root, 'lfs-agent.ts');
  writeFileSync(agent, `const store = process.argv[2];
const uploadMs = Number(process.argv[3]);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.event === 'init') out({});
    else if (m.event === 'terminate') process.exit(0);
    else if (m.event === 'upload') {
      const steps = Math.max(1, Math.round(uploadMs / 250));
      for (let k = 1; k <= steps; k++) {
        await Bun.sleep(uploadMs / steps);
        out({ event: 'progress', oid: m.oid, bytesSoFar: Math.round((m.size * k) / steps), bytesSinceLast: Math.round(m.size / steps) });
      }
      await Bun.write(store + '/' + m.oid, Bun.file(m.path));
      out({ event: 'complete', oid: m.oid });
    } else if (m.event === 'download') {
      const src = Bun.file(store + '/' + m.oid);
      if (!(await src.exists())) {
        out({ event: 'complete', oid: m.oid, error: { code: 404, message: 'Object does not exist on the server' } });
        continue;
      }
      const dest = store + '/../dl-' + m.oid + '-' + Date.now();
      await Bun.write(dest, src);
      out({ event: 'complete', oid: m.oid, path: dest });
    }
  }
}
`);
  return {
    dir,
    async configure(c) {
      for (const [k, v] of [['lfs.standalonetransferagent', 'mdsync-test'], ['lfs.customtransfer.mdsync-test.path', process.execPath],
        ['lfs.customtransfer.mdsync-test.args', `${agent} ${dir} ${o.uploadMs ?? 0}`]]) {
        await gitOk(t.env, c.dir, ['config', k as string, v as string]);
      }
    },
    add(oid, from) {
      writeFileSync(join(dir, oid), readFileSync(from));
    },
  };
}

// ---- stopped git states ----

async function cloneGitOk(t: TestEnv, c: Clone, args: string[]): Promise<string> {
  return gitOk(t.env, c.dir, args);
}

export async function makeStoppedRebase(t: TestEnv, c: Clone, r: Remote, o: { path: string; local: string; remote: string;
  dirty?: Record<string, string> }): Promise<{ local: string; remote: string }> {
  const remoteSha = await r.push({ [o.path]: o.remote }, `remote edit ${o.path}`);
  await c.write(o.path, o.local);
  await cloneGitOk(t, c, ['add', '-A', '--', `:(literal)${o.path}`]);
  await cloneGitOk(t, c, ['commit', '-q', '-m', `local edit ${o.path}`]);
  const localSha = (await cloneGitOk(t, c, ['rev-parse', 'HEAD'])).trim();
  for (const [rel, content] of Object.entries(o.dirty ?? {})) await c.write(rel, content);
  await cloneGitOk(t, c, ['fetch', '-q', 'origin']);
  const rb = await c.git(['rebase', '--autostash', 'origin/main']);
  const gitDir = join(c.dir, '.git');
  if (rb.code !== 1 || !existsSync(join(gitDir, 'rebase-merge'))) {
    throw new Error(`makeStoppedRebase: expected exit 1 with .git/rebase-merge, got ${rb.code}: ${rb.stderr.trim()}`);
  }
  return { local: localSha, remote: remoteSha };
}

export async function makeAutostashConflict(t: TestEnv, c: Clone, r: Remote, o: { path: string; local: string; remote: string }): Promise<void> {
  await r.push({ [o.path]: o.remote }, `remote edit ${o.path}`);
  await c.write(o.path, o.local);
  await cloneGitOk(t, c, ['fetch', '-q', 'origin']);
  const rb = await c.git(['rebase', '--autostash', 'origin/main']);
  const unmerged = splitNul(await cloneGitOk(t, c, ['ls-files', '-u', '-z']));
  const subject = (await c.git(['log', '-g', '-1', '--format=%gs', 'refs/stash'])).stdout.trim();
  if (rb.code !== 0 || unmerged.length === 0 || subject !== 'autostash') {
    throw new Error(`makeAutostashConflict: expected exit 0 + unmerged entries + refs/stash 'autostash' (is ${o.path} tracked?), `
      + `got exit ${rb.code}, ${unmerged.length} unmerged, stash '${subject}': ${rb.stderr.trim()}`);
  }
}

// Untracked keys in `dirty` are not captured by `stash create` (exactly like a real autostash) and stay in the worktree.
// The fast-forward target is a helper commit that adds `remote-ff.md`.
export async function makeLeftoverAutostash(t: TestEnv, c: Clone, r: Remote, o: { dirty: Record<string, string> }): Promise<string> {
  for (const [rel, content] of Object.entries(o.dirty)) await c.write(rel, content);
  const sha = (await cloneGitOk(t, c, ['stash', 'create'])).trim();
  if (sha === '') throw new Error('makeLeftoverAutostash: `git stash create` found nothing to stash (dirty paths must be tracked)');
  await cloneGitOk(t, c, ['stash', 'store', '-m', 'autostash', sha]);
  await cloneGitOk(t, c, ['reset', '-q', '--hard']);
  await r.push({ 'remote-ff.md': `fast-forward ${nextId()}\n` }, 'remote fast-forward');
  await cloneGitOk(t, c, ['fetch', '-q', 'origin']);
  await cloneGitOk(t, c, ['merge', '-q', '--ff-only', 'origin/main']);
  const unmerged = splitNul(await cloneGitOk(t, c, ['ls-files', '-u', '-z']));
  const subject = (await cloneGitOk(t, c, ['log', '-g', '-1', '--format=%gs', 'refs/stash'])).trim();
  if (unmerged.length !== 0 || subject !== 'autostash') {
    throw new Error(`makeLeftoverAutostash: unexpected state (${unmerged.length} unmerged, stash '${subject}')`);
  }
  return sha;
}

// ---- processes, files, polling ----

// Not spawned through spawn.ts: liveGitIn excludes spawn.ts children by default, and this one must be found.
export async function holdLiveGit(dir: string): Promise<{ pid: number; release(): Promise<void> }> {
  const proc = Bun.spawn(['git', 'hash-object', '--stdin'], {
    cwd: dir,
    env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  let state: 'held' | 'released' = 'held';
  const holder = {
    pid: proc.pid,
    async release() {
      if (state === 'released') return;
      state = 'released';
      try {
        await proc.stdin.end();
      } catch {
        proc.kill('SIGKILL');
      }
      await settle(proc.exited, 5_000);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    },
  };
  holders.push(holder);
  return holder;
}

export function backdate(path: string, ageMs: number): void {
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(path, at, at);
}

// Resolves with the first result that is not undefined, null or false. Errors thrown by fn propagate.
// A process's start time from `ps -o lstart` (wall clock, 1 s resolution), the reference for processStartMs checks.
// `Date.now() - process.uptime() * 1000` is not one: on macOS uptime stops while the machine sleeps, so after a lid
// close it was off by the length of the sleep (round 3: 149 638 ms).
// ps prints in UTC here and the fields are read as UTC: tests change process.env.TZ, and a local-time round trip was
// off by the zone's offset.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function psStartMs(pid: number): number | 'unknown' {
  const r = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  const m = /^\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})$/.exec(r.stdout.toString().trim());
  if (r.exitCode !== 0 || m === null || !MONTHS.includes(m[1] ?? '')) return 'unknown';
  return Date.UTC(Number(m[6]), MONTHS.indexOf(m[1] ?? ''), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>,
  o?: { timeoutMs?: number; intervalMs?: number; label?: string }): Promise<T> {
  const timeoutMs = o?.timeoutMs ?? DEFAULT_WAIT_MS;
  const intervalMs = o?.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms${o?.label ? `: ${o.label}` : ''}`);
    await Bun.sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export async function waitNoLiveGit(dir: string, o?: { timeoutMs?: number }): Promise<void> {
  const real = realpathSync(dir);
  let last: LiveGitScan | undefined;
  try {
    await waitFor(async () => {
      last = await liveGitIn(real);
      return last.kind === 'scanned' && last.pids.length === 0;
    }, { timeoutMs: o?.timeoutMs ?? DEFAULT_WAIT_MS, intervalMs: 100 });
  } catch {
    throw new Error(`waitNoLiveGit: git still live in ${real}: ${JSON.stringify(last)}`);
  }
}

// ---- artifact checks ----

const BRANCH_TRACKING = ['branch.main.remote=origin', 'branch.main.merge=refs/heads/main'];
const STATE_ENTRY_RE = /^[0-9a-f]{16}\.(lock|lock\.takeover|sock|json|json\.tmp|journal\.json|log|tmp|rescue|local-only\.json)$/;

function walkNames(dir: string, visit: (rel: string) => void, rel = ''): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    visit(childRel);
    if (e.isDirectory()) walkNames(join(dir, e.name), visit, childRel);
  }
}

function lsSorted(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function bytesOrNone(p: string): string {
  return existsSync(p) ? readFileSync(p).toString('base64') : 'none';
}

// Files git itself keeps at the top of .git while mdsync runs (beyond what a fresh clone has).
const GIT_TOP_FILES = new Set(['HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'COMMIT_EDITMSG', 'AUTO_MERGE', 'index', 'packed-refs',
  'description', 'config']);
const GIT_TOP_DIRS = new Set(['objects', 'refs', 'logs', 'hooks', 'info', 'branches']);

async function refNames(env: Record<string, string>, dir: string): Promise<string[]> {
  return (await gitOk(env, dir, ['for-each-ref', '--format=%(refname)'])).split('\n').filter((l) => l !== '').sort();
}

// Every entry under a clone's .git must be one git keeps for user-content syncing: objects, the synced branch's refs
// and reflogs, refs/stash, and the top-level files above. Anything else (a journal, info/attributes, an extra ref) is
// an mdsync artifact, whatever its name.
function unexpectedGitEntries(gitDir: string, okRef: (refname: string) => boolean, refInfo: readonly string[]): string[] {
  const bad: string[] = [];
  for (const e of readdirSync(gitDir, { withFileTypes: true })) {
    if (e.isDirectory() ? !GIT_TOP_DIRS.has(e.name) : !GIT_TOP_FILES.has(e.name)) bad.push(e.name);
  }
  for (const n of lsSorted(join(gitDir, 'info'))) if (!refInfo.includes(n)) bad.push(`info/${n}`);
  for (const top of ['refs', 'logs']) {
    const base = join(gitDir, top);
    if (!existsSync(base)) continue;
    walkNames(base, (rel) => {
      if (lstatSync(join(base, rel)).isDirectory()) return;
      const name = top === 'logs' ? rel : `refs/${rel}`;   // logs/HEAD, logs/refs/...
      if (top === 'logs' && name === 'HEAD') return;
      if (!okRef(name)) bad.push(`${top}/${rel}`);
    });
  }
  return bad;
}

// The settle of a move's replaced inodes (SETTLE_GRACE_MS after the move): no temp folder and no settle part left.
async function waitForSettle(t: TestEnv, clones: Clone[]): Promise<void> {
  const stateDir = join(t.stateHome, 'mdsync');
  const pending = (): boolean => clones.some((c) => readdirSync(c.dir).some((n) => MOVE_TEMP_RE.test(n)))
    || (existsSync(stateDir) && readdirSync(stateDir).some((n) => {
      if (!n.endsWith('.journal.json')) return false;
      try {
        const j = JSON.parse(readFileSync(join(stateDir, n), 'utf8')) as { settle?: unknown[] };
        return Array.isArray(j.settle) && j.settle.length > 0;
      } catch {
        return false;
      }
    }));
  const deadline = Date.now() + SETTLE_WAIT_MS;
  while (pending() && Date.now() < deadline) await Bun.sleep(200);
}

const SETTLE_WAIT_MS = 5_000 + 5_000;   // SETTLE_GRACE_MS + 5 s

export async function expectNoMdsyncArtifacts(t: TestEnv, clones: Clone[], r: Remote, userPaths: (p: string) => boolean,
  o: { branches?: readonly string[] } = {}): Promise<void> {
  await waitForSettle(t, clones);
  const branches = o.branches ?? ['main'];
  const ref = join(t.root, `artifact-ref-${nextId()}`);
  await gitOk(t.env, t.root, ['clone', '-q', r.url, ref]);
  const refInfo = lsSorted(join(ref, '.git', 'info'));
  const okRef = (name: string): boolean => name === 'refs/stash' || name === 'refs/remotes/origin/HEAD'
    || branches.some((b) => name === `refs/heads/${b}` || name === `refs/remotes/origin/${b}`);
  const configOf = async (dir: string): Promise<string[]> =>
    (await gitOk(t.env, dir, ['config', '--local', '--list'])).split('\n').filter((l) => l !== '').sort();
  const [refConfig, cloneReads, tree, remoteRefs, remoteLog] = await Promise.all([
    configOf(ref),
    Promise.all(clones.map((c) => Promise.all([configOf(c.dir), refNames(t.env, c.dir)]))),
    r.tree(), refNames(t.env, r.path), r.log(),
  ]);
  const refHooks = lsSorted(join(ref, '.git', 'hooks'));
  const refExclude = bytesOrNone(join(ref, '.git', 'info', 'exclude'));
  const allowed = (p: string): boolean => userPaths(p) || CONFLICT_COPY_RE.test(p);

  for (const [i, c] of clones.entries()) {
    const gitDir = join(c.dir, '.git');
    const [config, refs] = cloneReads[i] as [string[], string[]];
    // A clone of a then-empty remote has no branch.main tracking entries; nothing else may differ.
    const expectedConfig = BRANCH_TRACKING.every((l) => config.includes(l))
      ? refConfig : refConfig.filter((l) => !BRANCH_TRACKING.includes(l));
    expect({ clone: c.dir, config }).toEqual({ clone: c.dir, config: expectedConfig });
    expect({ clone: c.dir, hooks: lsSorted(join(gitDir, 'hooks')) }).toEqual({ clone: c.dir, hooks: refHooks });
    expect({ clone: c.dir, exclude: bytesOrNone(join(gitDir, 'info', 'exclude')) })
      .toEqual({ clone: c.dir, exclude: refExclude });

    const gitNames: string[] = [];
    if (lstatSync(gitDir).isDirectory()) {
      walkNames(gitDir, (rel) => {
        const base = rel.slice(rel.lastIndexOf('/') + 1);
        if (base.toLowerCase().includes('mdsync') || base.startsWith('fsmonitor--daemon')) gitNames.push(rel);
      });
    }
    expect({ clone: c.dir, mdsyncNamesInGitDir: gitNames }).toEqual({ clone: c.dir, mdsyncNamesInGitDir: [] });
    expect({ clone: c.dir, unexpectedGitEntries: unexpectedGitEntries(gitDir, okRef, refInfo) })
      .toEqual({ clone: c.dir, unexpectedGitEntries: [] });
    expect({ clone: c.dir, unexpectedRefs: refs.filter((n) => !okRef(n)) })
      .toEqual({ clone: c.dir, unexpectedRefs: [] });

    const files = listFiles(c.dir, 'with-temps');
    const lockOrSock = files.filter((p) => p.endsWith('.lock') || p.endsWith('.sock'));
    expect({ clone: c.dir, lockOrSock }).toEqual({ clone: c.dir, lockOrSock: [] });
    expect({ clone: c.dir, unexpectedFiles: files.filter((p) => !allowed(p)) })
      .toEqual({ clone: c.dir, unexpectedFiles: [] });
  }

  expect({ remote: r.path, unexpectedFiles: tree.filter((p) => !allowed(p)) })
    .toEqual({ remote: r.path, unexpectedFiles: [] });
  // Only the synced branch: a tag or an extra branch pushed by mdsync is an artifact too.
  expect({ remote: r.path, unexpectedRefs: remoteRefs.filter((n) => !branches.some((b) => n === `refs/heads/${b}`)) })
    .toEqual({ remote: r.path, unexpectedRefs: [] });
  const authors = new Set([HELPER_NAME, ...(daemonAuthors.get(t.root) ?? [])]);
  const strangers = [...new Set(remoteLog.map((ci) => ci.authorName))].filter((a) => !authors.has(a));
  expect({ remote: r.path, unexpectedAuthors: strangers }).toEqual({ remote: r.path, unexpectedAuthors: [] });

  const stateDir = join(t.stateHome, 'mdsync');
  const badState = existsSync(stateDir)
    ? readdirSync(stateDir, { withFileTypes: true })
      .filter((e) => {
        const m = STATE_ENTRY_RE.exec(e.name);
        if (m === null) return true;
        const wantDir = m[1] === 'tmp' || m[1] === 'rescue';
        return wantDir !== e.isDirectory();
      })
      .map((e) => e.name)
    : [];
  expect({ stateDir, unexpected: badState }).toEqual({ stateDir, unexpected: [] });
  rmSync(ref, { recursive: true, force: true });
}
