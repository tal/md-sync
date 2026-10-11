// Git wrapper: argv, env, credentials, network deadline, failure classification and tree/blob helpers.
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LogFields, Logger } from './log';
import { LOCAL_TIMEOUT_MS, SpawnNotFoundError, type SpawnResult, spawnTracked } from './spawn';

// A network op is killed after NETWORK_TIMEOUT_MS without any output (git runs with --progress for transfers), and
// after NETWORK_MAX_MS in any case.
export const NETWORK_TIMEOUT_MS = 120_000;
export const NETWORK_MAX_MS = 1_800_000;
export const SHUTDOWN_NET_MARGIN_MS = 15_000;

export const GLOBAL_ARGS = [
  '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false',
  '-c', 'core.hooksPath=/dev/null',      // no hooks at all: --no-verify does not stop post-checkout, post-commit,
                                         //   post-rewrite or reference-transaction (probe e10)
  '-c', 'core.fsmonitor=false',          // a global fsmonitor creates .git/fsmonitor--daemon* and a background git
  '-c', 'rerere.enabled=false',          // never auto-resolve from recorded resolutions
  '-c', 'gc.autoDetach=false', '-c', 'maintenance.autoDetach=false',   // auto-gc runs in the foreground, never orphaned
  '-c', 'merge.conflictStyle=merge',     // stable marker format for the marker check
  '-c', 'log.showSignature=false',       // a user's log.showSignature prefixes `log --format` output
] as const;

export const SHUTDOWN_DEADLINE_ERROR = 'shutdown deadline reached';

export type GitIdentity = { name: string; email: string };
export type GitRunKind = 'local' | 'network';
export type GitRunOpts = { input?: Uint8Array | string; kind?: GitRunKind; cwd?: string;
  durable?: 'durable';     // adds -c core.fsync=committed -c core.fsyncMethod=batch: loose objects fsynced
  indexFile?: string;      // sets GIT_INDEX_FILE (temporary index under <hash>.tmp/)
  timeoutMs?: number };    // overrides the default for this call (still clamped by the network deadline)
export type GitResult = { code: number; stdout: string; stderr: string; timedOut: 'timed-out' | 'in-time';
  durationMs: number; spawnError?: string };
export type GitBytesResult = Omit<GitResult, 'stdout'> & { stdout: Uint8Array };
export type GitClient = {
  readonly cwd: string;
  run(args: string[], o?: GitRunOpts): Promise<GitResult>;          // never throws on exit != 0
  bytes(args: string[], o?: GitRunOpts): Promise<GitBytesResult>;
  ok(args: string[], o?: GitRunOpts): Promise<string>;              // throws GitError if code != 0; trailing '\n's stripped
};

export type GitFailureKind = 'locked' | 'non-ff' | 'remote-rejected' | 'missing-remote-ref' | 'auth' | 'network' | 'other';

export class GitError extends Error {
  readonly args: string[];
  readonly result: GitResult;
  readonly failure: GitFailureKind;
  constructor(args: string[], result: GitResult, failure: GitFailureKind, message?: string) {
    super(message ?? gitErrorMessage(args, result));
    this.name = 'GitError';
    this.args = args;
    this.result = result;
    this.failure = failure;
  }
}

export class GitNotFoundError extends Error {
  constructor(options?: ErrorOptions) {
    super('git executable not found (is git installed and on PATH?)', options);
    this.name = 'GitNotFoundError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// argv, env, timeouts

type Env = Record<string, string | undefined>;

export function gitArgv(args: readonly string[]): string[] {
  return ['git', ...GLOBAL_ARGS, ...args];
}

// Per-call config placed before the subcommand: `durable` fsyncs loose objects too (git's default fsyncs refs but not
// objects, so a power loss could leave a ref naming a commit that is not on disk).
export function callConfig(o: Pick<GitRunOpts, 'durable'>): string[] {
  return o.durable === 'durable' ? ['-c', 'core.fsync=committed', '-c', 'core.fsyncMethod=batch'] : [];
}

// Appends two GIT_CONFIG_* entries after any existing ones: an empty credential.helper (resets inherited helpers),
// then a helper that answers `get` from $GIT_TOKEN. The token itself stays in the environment.
export function credentialEnv(env: Env): Record<string, string> {
  if (env.GIT_TOKEN === undefined || env.GIT_TOKEN === '') return {};
  const n = Number(env.GIT_CONFIG_COUNT ?? '0') || 0;
  return { GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'credential.helper', [`GIT_CONFIG_VALUE_${n}`]: '',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${n + 1}`]: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GIT_TOKEN"; }; f' };
}

// Variables that point git at a repository. Inherited from a caller (a git hook, a shell inside another repo) they
// would aim every call at that repo instead of the synced folder, so they never pass through; GIT_INDEX_FILE is set
// per call when a temporary index is wanted.
export const REPO_LOCATING_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE', 'GIT_PREFIX'] as const;

// ceiling: GIT_CEILING_DIRECTORIES, so git never searches above the synced folder for a repository. Without it, a
// synced folder that lost its .git (or was wiped and recreated) inside another repo made every call act on that
// repo: P6 switched its branch, S2 committed into it and S6 pushed it.
export function gitEnv(identity: GitIdentity, o: { kind: GitRunKind; indexFile?: string; ceiling?: string; sshKey?: string },
                       base: Env = process.env): Env {
  const inherited: Env = { ...base };
  for (const k of REPO_LOCATING_ENV) delete inherited[k];
  const ceilings = base.GIT_CEILING_DIRECTORIES;
  return {
    ...inherited,
    ...(o.ceiling !== undefined
      ? { GIT_CEILING_DIRECTORIES: ceilings !== undefined && ceilings !== '' ? `${o.ceiling}:${ceilings}` : o.ceiling } : {}),
    ...(o.sshKey !== undefined ? {
      GIT_SSH_COMMAND: `ssh -i '${o.sshKey.replaceAll("'", "'\\''")}' -o IdentitiesOnly=yes -o BatchMode=yes -o ControlPath=none`,
      GIT_SSH_VARIANT: 'ssh',
    } : {}),
    GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'C',
    GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_PAGER: 'cat',
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    ...(o.indexFile ? { GIT_INDEX_FILE: o.indexFile } : {}),
    // git-lfs prints no progress when stderr is not a terminal, so a long upload or download was silent and the
    // no-output limit (NETWORK_TIMEOUT_MS) killed it, every retry from zero.
    ...(o.kind === 'network' ? { GIT_LFS_FORCE_PROGRESS: '1', ...credentialEnv(base) } : {}),
  };
}

let deadlineAt: number | 'none' = 'none';

export function setNetworkDeadline(at: number | 'none'): void {
  deadlineAt = at;
}

export function networkDeadline(): number | 'none' {
  return deadlineAt;
}

// Network ops are clamped to end SHUTDOWN_NET_MARGIN_MS before the deadline; local ops never are.
export function effectiveTimeoutMs(kind: GitRunKind, override?: number, now: number = Date.now()): number | 'deadline-reached' {
  const base = override ?? (kind === 'network' ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  if (kind !== 'network' || deadlineAt === 'none') return base;
  const left = deadlineAt - now - SHUTDOWN_NET_MARGIN_MS;
  return left <= 0 ? 'deadline-reached' : Math.min(base, left);
}

// ---------------------------------------------------------------------------------------------------------------
// client

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_LOGGED_STDERR = 8_192;

function stripTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 10) end--;
  return end === s.length ? s : s.slice(0, end);
}

function toText(r: GitBytesResult): GitResult {
  return { ...r, stdout: decoder.decode(r.stdout) };
}

// First arg that is neither an option nor the value of a leading `-c`/`-C`.
function subcommandOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a === '-C') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return args[0] ?? '';
}

function firstStderrLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? '';
}

function gitErrorMessage(args: readonly string[], r: GitResult): string {
  const sub = subcommandOf(args);
  if (r.timedOut === 'timed-out') return `git ${sub} timed out after ${r.durationMs} ms`;
  if (r.spawnError !== undefined) return `git ${sub} could not run: ${r.spawnError}`;
  const line = firstStderrLine(r.stderr);
  return line === '' ? `git ${sub} exited ${r.code}` : `git ${sub} exited ${r.code}: ${line}`;
}

function logGit(log: Logger, args: readonly string[], r: GitBytesResult): void {
  const f: LogFields = { args, code: r.code, durationMs: r.durationMs, timedOut: r.timedOut };
  if (r.code !== 0) f.stderr = r.stderr.length > MAX_LOGGED_STDERR ? `${r.stderr.slice(0, MAX_LOGGED_STDERR)}…` : r.stderr;
  if (r.spawnError !== undefined) f.spawnError = r.spawnError;
  log.debug('git', f);
}

// discovery: 'this-dir' (the default) finds the repository at `cwd` only (GIT_CEILING_DIRECTORIES = dirname(cwd));
// 'search-up' lets git search parent folders, as plain git does (tests that run from a subfolder).
export type GitDiscovery = 'this-dir' | 'search-up';

export function createGitClient(o: { cwd: string; identity: GitIdentity; log: Logger; sshKey?: string; discovery?: GitDiscovery }): GitClient {
  const ceiling = (o.discovery ?? 'this-dir') === 'this-dir' ? dirname(o.cwd) : undefined;
  const exec = async (args: string[], ro: GitRunOpts = {}): Promise<GitBytesResult> => {
    const kind = ro.kind ?? 'local';
    const timeout = effectiveTimeoutMs(kind, ro.timeoutMs);
    if (timeout === 'deadline-reached') {
      const r: GitBytesResult = { code: -1, stdout: EMPTY, stderr: '', timedOut: 'in-time', durationMs: 0,
        spawnError: SHUTDOWN_DEADLINE_ERROR };
      logGit(o.log, args, r);
      return r;
    }
    const input = typeof ro.input === 'string' ? encoder.encode(ro.input) : ro.input;
    // network: `timeout` is the no-progress limit; the whole op is bounded by NETWORK_MAX_MS (and the shutdown deadline)
    const whole = kind === 'network' ? effectiveTimeoutMs('network', Math.max(timeout, NETWORK_MAX_MS)) : timeout;
    let s: SpawnResult;
    try {
      s = await spawnTracked(gitArgv([...callConfig(ro), ...args]), {
        cwd: ro.cwd ?? o.cwd,
        env: gitEnv(o.identity, { kind, sshKey: o.sshKey, indexFile: ro.indexFile, ...(ceiling !== undefined ? { ceiling } : {}) }),
        input,
        timeoutMs: whole === 'deadline-reached' ? timeout : whole,
        ...(kind === 'network' ? { stallMs: timeout } : {}),
      });
    } catch (e) {
      if (e instanceof SpawnNotFoundError) throw new GitNotFoundError({ cause: e });
      throw e;
    }
    const r: GitBytesResult = { code: s.code, stdout: s.stdout, stderr: decoder.decode(s.stderr), timedOut: s.timedOut,
      durationMs: s.durationMs };
    if (s.spawnError !== undefined) r.spawnError = s.spawnError;
    logGit(o.log, [...callConfig(ro), ...args], r);
    return r;
  };

  return {
    cwd: o.cwd,
    run: async (args, ro) => toText(await exec(args, ro)),
    bytes: exec,
    async ok(args, ro) {
      const r = toText(await exec(args, ro));
      if (r.code !== 0) throw new GitError(args, r, classifyFailure(r, 'local'));
      return stripTrailingNewlines(r.stdout);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// classification (probe-verified strings, matched with LC_ALL=C)

const LOCKED_RE = /Unable to create '[^']+\.lock': File exists|cannot lock ref/;
export const NON_FF_RE = /\[rejected\][^\n]*\((fetch first|non-fast-forward)\)/;
// A push whose ref update lost the race on the remote: another device pushed between the ref advertisement and our
// update (`remote: error: cannot lock ref 'refs/heads/B': is at X but expected Y`; porcelain `[remote rejected]
// (incorrect old value provided)`, or GitHub's `(cannot lock ref …)`). A lost compare-and-swap is a non-fast-forward,
// not a lock here: matched before LOCKED_RE, it gets S6's re-fetch, rebase and retry.
const REMOTE_CAS_RE = /^remote: error: cannot lock ref |\[remote rejected\][^\n]*\((incorrect old value provided|cannot lock ref|failed to update ref)/m;
const AUTH_STRINGS = ['Authentication failed', 'could not read Username', 'could not read Password',
  'terminal prompts disabled', 'Permission denied (publickey'];
// An LFS object the server can't hand out (yet): retried like a network failure, never remembered as stuck.
export const LFS_SMUDGE_FAILED = 'smudge filter lfs failed';
const NETWORK_STRINGS = ['Could not read from remote repository', 'unable to access', 'Could not resolve host',
  'does not appear to be a git repository', 'Connection refused', 'Connection timed out', 'Operation timed out',
  'The remote end hung up', 'early EOF', LFS_SMUDGE_FAILED];

// A full object id: 40 hex digits (sha1) or 64 (sha256).
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export function isOid(s: string): boolean {
  return OID_RE.test(s);
}

export function classifyFailure(r: GitResult, op: 'fetch' | 'push' | 'clone' | 'local'): GitFailureKind {
  const netOp = op !== 'local';
  if (r.timedOut === 'timed-out' || (r.spawnError !== undefined && netOp)) return 'network';
  const text = `${r.stdout}\n${r.stderr}`;
  if (op === 'push' && REMOTE_CAS_RE.test(text)) return 'non-ff';
  if (LOCKED_RE.test(text)) return 'locked';
  if (NON_FF_RE.test(text)) return 'non-ff';
  if (text.includes('[remote rejected]')) return 'remote-rejected';
  if (text.includes("couldn't find remote ref")) return 'missing-remote-ref';
  if (AUTH_STRINGS.some((s) => text.includes(s))) return 'auth';
  if (NETWORK_STRINGS.some((s) => text.includes(s))) return 'network';
  if (netOp && r.code === 128) return 'network';
  return 'other';
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

export type TreeEntry = { mode: string; type: 'blob' | 'commit'; sha: string };     // ls-tree -r omits trees

export function parseNul(s: string): string[] {
  const parts = s.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function fail(args: string[], r: GitResult): never {
  throw new GitError(args, r, classifyFailure(r, 'local'));
}

function bytesFail(args: string[], r: GitBytesResult): never {
  fail(args, toText(r));
}

// `<meta>\t<path>` records from ls-tree / ls-files -s / ls-files -u
function splitRecord(rec: string): { meta: string[]; path: string } | 'malformed' {
  const tab = rec.indexOf('\t');
  if (tab < 0) return 'malformed';
  return { meta: rec.slice(0, tab).split(' '), path: rec.slice(tab + 1) };
}

export async function lsTree(g: GitClient, rev: string): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  for (const rec of parseNul(await g.ok(['ls-tree', '-r', '-z', '--full-tree', rev]))) {
    const s = splitRecord(rec);
    if (s === 'malformed') continue;
    const [mode, type, sha] = s.meta;
    if (mode === undefined || sha === undefined || (type !== 'blob' && type !== 'commit')) continue;
    out.set(s.path, { mode, type, sha });
  }
  return out;
}

export async function catBlob(g: GitClient, sha: string): Promise<Uint8Array> {
  const args = ['cat-file', 'blob', sha];
  const r = await g.bytes(args);
  if (r.code !== 0) bytesFail(args, r);
  return r.stdout;
}

// Durable: a merged blob, or a symlink copy's blob, goes into a commit a ref is moved to next.
export async function writeBlob(g: GitClient, content: Uint8Array): Promise<string> {
  return (await g.ok(['hash-object', '-w', '--no-filters', '--stdin'], { input: content, durable: 'durable' })).trim();
}

// Blob shas as `git add` would store them (clean filters applied). Paths are repo-relative to g.cwd.
// Missing paths, directories and other non-files are left out of the map.
export async function hashPaths(g: GitClient, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const batch: string[] = [];
  const single: string[] = [];
  const links: string[] = [];
  for (const p of new Set(paths)) {
    let st;
    try {
      st = lstatSync(join(g.cwd, p));
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) links.push(p);
    else if (!st.isFile()) continue;
    // --stdin-paths reads lines, unquotes a leading '"' and drops a trailing CR: hash those one by one
    else if (p.includes('\n') || p.startsWith('"') || p.endsWith('\r')) single.push(p);
    else batch.push(p);
  }

  if (batch.length > 0) {
    const r = await g.run(['hash-object', '--stdin-paths'], { input: batch.join('\n') + '\n' });
    const shas = r.code === 0 ? r.stdout.split('\n').filter((l) => l !== '') : [];
    if (r.code === 0 && shas.length === batch.length) batch.forEach((p, i) => out.set(p, shas[i]!));
    else single.push(...batch);   // a file vanished mid-batch (or similar): retry per path, skipping failures
  }
  for (const p of single) {
    const r = await g.run(['hash-object', '--', p]);
    if (r.code === 0) out.set(p, r.stdout.trim());
  }
  // hash-object follows symlinks; git stores a symlink as a blob of its target text.
  for (const p of links) {
    let target: Uint8Array;
    try {
      target = encoder.encode(readlinkSync(join(g.cwd, p)));
    } catch {
      continue;
    }
    const r = await g.run(['hash-object', '--no-filters', '--stdin'], { input: target });
    if (r.code === 0) out.set(p, r.stdout.trim());
  }
  return out;
}

export async function revParse(g: GitClient, rev: string): Promise<string | 'none'> {
  const args = ['rev-parse', '-q', '--verify', rev];
  const r = await g.run(args);
  if (r.code === 0) return r.stdout.trim();
  if (r.code === 1) return 'none';
  fail(args, r);
}

export async function objectExists(g: GitClient, sha: string): Promise<'present' | 'absent'> {
  const args = ['cat-file', '-e', sha];
  const r = await g.run(args);
  if (r.code === 0) return 'present';
  if (r.code === 1 || (r.code === 128 && r.stderr.includes('Not a valid object name'))) return 'absent';
  fail(args, r);
}

export async function headSha(g: GitClient): Promise<string | 'unborn'> {
  const sha = await revParse(g, 'HEAD');
  return sha === 'none' ? 'unborn' : sha;
}

export async function isAncestor(g: GitClient, a: string, b: string): Promise<'ancestor' | 'not-ancestor' | 'unknown'> {
  const r = await g.run(['merge-base', '--is-ancestor', a, b]);
  return r.code === 0 ? 'ancestor' : r.code === 1 ? 'not-ancestor' : 'unknown';
}

export async function mergeBase(g: GitClient, a: string, b: string): Promise<string | 'unrelated'> {
  const args = ['merge-base', a, b];
  const r = await g.run(args);
  if (r.code === 0) return r.stdout.trim();
  if (r.code === 1) return 'unrelated';
  fail(args, r);
}

export async function revCount(g: GitClient, range: string): Promise<number> {
  const out = (await g.ok(['rev-list', '--count', range, '--'])).trim();
  const n = Number(out);
  if (!Number.isInteger(n) || out === '') throw new Error(`rev-list --count: unexpected output ${JSON.stringify(out)}`);
  return n;
}

type IndexRecord = { mode: string; sha: string; stage: number; path: string };

function parseIndexRecords(out: string): IndexRecord[] {
  const recs: IndexRecord[] = [];
  for (const rec of parseNul(out)) {
    const s = splitRecord(rec);
    if (s === 'malformed') continue;
    const [mode, sha, stage] = s.meta;
    if (mode === undefined || sha === undefined || stage === undefined) continue;
    recs.push({ mode, sha, stage: Number(stage), path: s.path });
  }
  return recs;
}

export async function unmergedPaths(g: GitClient): Promise<string[]> {
  const seen = new Set<string>();
  for (const r of parseIndexRecords(await g.ok(['ls-files', '-u', '-z']))) seen.add(r.path);
  return [...seen];
}

// path -> blob shas of the stages present, in stage order (1, 2, 3; missing stages are omitted)
export async function unmergedStages(g: GitClient): Promise<Map<string, string[]>> {
  const byPath = new Map<string, { stage: number; sha: string }[]>();
  for (const r of parseIndexRecords(await g.ok(['ls-files', '-u', '-z']))) {
    const list = byPath.get(r.path) ?? [];
    list.push({ stage: r.stage, sha: r.sha });
    byPath.set(r.path, list);
  }
  const out = new Map<string, string[]>();
  for (const [p, list] of byPath) out.set(p, list.sort((a, b) => a.stage - b.stage).map((e) => e.sha));
  return out;
}

// One entry per path: stage 0 when merged, else the lowest stage present.
export async function indexEntries(g: GitClient): Promise<Map<string, { mode: string; sha: string; stage: number }>> {
  const out = new Map<string, { mode: string; sha: string; stage: number }>();
  for (const r of parseIndexRecords(await g.ok(['ls-files', '-s', '-z']))) {
    const cur = out.get(r.path);
    if (cur === undefined || r.stage < cur.stage) out.set(r.path, { mode: r.mode, sha: r.sha, stage: r.stage });
  }
  return out;
}

export async function currentBranchRef(g: GitClient): Promise<string | 'detached'> {
  const args = ['symbolic-ref', '-q', 'HEAD'];
  const r = await g.run(args);
  if (r.code === 0) return r.stdout.trim();
  if (r.code === 1) return 'detached';
  fail(args, r);
}

export async function stashTop(g: GitClient): Promise<{ sha: string; subject: string } | 'none'> {
  const sha = await revParse(g, 'refs/stash');
  if (sha === 'none') return 'none';
  const r = await g.run(['log', '-g', '-1', '--format=%gs', 'refs/stash', '--']);
  // no reflog (or an unreadable one): an empty subject is never an mdsync stash, so nothing replays it
  return { sha, subject: r.code === 0 ? stripTrailingNewlines(r.stdout) : '' };
}

export async function stashIndexOf(g: GitClient, sha: string): Promise<number | 'absent'> {
  if ((await revParse(g, 'refs/stash')) === 'none') return 'absent';
  const shas = (await g.ok(['log', '-g', '--format=%H', 'refs/stash', '--'])).split('\n');
  const i = shas.indexOf(sha);
  return i < 0 ? 'absent' : i;
}

export function isMdsyncStash(subject: string): boolean {
  return subject === 'autostash' || subject === 'mdsync pre-conflict' || subject.endsWith(': mdsync pre-conflict');
}

export async function objectFormat(g: GitClient): Promise<'sha1' | 'sha256'> {
  const r = await g.run(['rev-parse', '--show-object-format']);
  return r.code === 0 && r.stdout.trim() === 'sha256' ? 'sha256' : 'sha1';
}

// The replay needs `merge-tree --merge-base` and the move `--attr-source`: git 2.40 or newer.
export const MIN_GIT: readonly [number, number] = [2, 40];

export function parseGitVersion(out: string): [number, number] | 'unknown' {
  const m = /git version (\d+)\.(\d+)/.exec(out);
  return m === null ? 'unknown' : [Number(m[1]), Number(m[2])];
}

export async function requireGitVersion(g: GitClient): Promise<void> {
  const args = ['version'];
  const r = await g.run(args);
  const v = r.code === 0 ? parseGitVersion(r.stdout) : 'unknown';
  if (v === 'unknown' || v[0] < MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] < MIN_GIT[1])) {
    const found = r.code === 0 ? r.stdout.trim().replace(/^git version /, '') : 'unknown';
    throw new GitError(args, { ...r, stderr: `mdsync needs git ${MIN_GIT.join('.')} or newer (found ${found})` }, 'other',
      `mdsync needs git ${MIN_GIT.join('.')} or newer (found ${found})`);
  }
}

export async function emptyTree(g: GitClient): Promise<string> {
  return (await g.ok(['hash-object', '-t', 'tree', '--stdin'], { input: EMPTY })).trim();
}

export async function absoluteGitDir(g: GitClient): Promise<string> {
  return (await g.ok(['rev-parse', '--absolute-git-dir'])).trim();
}
