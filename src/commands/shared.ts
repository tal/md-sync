// Config layers, target-dir resolution, instance layer from the state file, the CLI logger, stderr/stdout helpers and
// the run bookkeeping shared by the daemon and the one-off runner.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type ConfigIssue, type DirectLayers, formatIssue, type InstanceInput, type Loaded, loadInstanceFile, requireKeys,
  type ResolvedConfig, resolveConfig, validateCliLayer,
} from '../config';
import { realpathOrSame, writeAllSync } from '../fsutil';
import { type GitClient, stashIndexOf } from '../git';
import { shortHostname } from '../host';
import { createLogger, type Logger, parseLogLevel } from '../log';
import { type AcquireResult, acquireLock, type LockOwner, ownerLiveness, readLockOwner } from '../lock';
import {
  canonicalDir, defaultConfigPath, dirHash, findSyncedAncestor, realpathLoose, resolveDirInput, stateDirIn, type StatePaths, statePathsFor,
  xdgStateHome,
} from '../paths';
import { withRepoDefaults } from '../repo-defaults';
import { installedStateHomes } from '../service';
import { type KeptStash, readState, type StateFile } from '../state';
import type { LogLevel, RunRequest, RunResult, StuckRecord } from '../types';

// parseArgs `values` for every flag in cli.ts (kebab-case, as parsed).
export type CliValues = {
  cwd?: string; config?: string; 'log-level'?: string;
  remote?: string; dir?: string; branch?: string; 'ntfy-url'?: string; 'author-name'?: string; 'author-email'?: string; 'ssh-key'?: string;
  'idle-ms'?: string; 'fallback-ms'?: string; 'max-wait-ms'?: string; 'auto-commit'?: string; ignore?: string[];
  message?: string; wait?: boolean; format?: string; json?: boolean; print?: boolean;
  help?: boolean; version?: boolean;
};

export type CommandEnv = {
  values: CliValues;
  paths: readonly string[];   // flush's positional paths; empty for every other command
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
  logLevelFlag: LogLevel | 'unset';   // --log-level as given (install-service re-emits it)
};

export type { DirectLayers };
export type Exit = { kind: 'exit'; code: number };

// ---------------------------------------------------------------------------------------------------------------
// Output

// Human-readable error line: `md-sync: <text>` on stderr.
export function stderrLine(text: string): void {
  writeAllSync(2, `md-sync: ${text}\n`);
}

export function stdoutText(text: string): void {
  writeAllSync(1, text);
}

export function stderrText(text: string): void {
  writeAllSync(2, text);
}

// ---------------------------------------------------------------------------------------------------------------
// Logger

// --log-level > MDSYNC_LOG_LEVEL > info. An invalid --log-level is a usage error. An invalid MDSYNC_LOG_LEVEL
// only warns: it comes from the environment (a hook runner's, a unit's), and failing on it made every `flush` from
// that environment exit 2.
export function createCliLogger(values: CliValues, env: NodeJS.ProcessEnv, sink: 'stdout' | 'stderr'):
  { kind: 'ok'; log: Logger; flag: LogLevel | 'unset' } | Exit {
  let flag: LogLevel | 'unset' = 'unset';
  if (values['log-level'] !== undefined) {
    const l = parseLogLevel(values['log-level']);
    if (l === 'invalid') {
      stderrLine(`invalid --log-level "${values['log-level']}" (expected debug, info, warn or error)`);
      return { kind: 'exit', code: 2 };
    }
    flag = l;
  }
  let level: LogLevel = flag === 'unset' ? 'info' : flag;
  if (flag === 'unset') {
    const fromEnv = parseLogLevel(env.MDSYNC_LOG_LEVEL);
    if (fromEnv === 'invalid') {
      stderrLine(`ignoring invalid MDSYNC_LOG_LEVEL "${env.MDSYNC_LOG_LEVEL}" (expected debug, info, warn or error)`);
    } else {
      level = fromEnv;
    }
  }
  return { kind: 'ok', log: createLogger({ level, sink }), flag };
}

// ---------------------------------------------------------------------------------------------------------------
// Config issues

// One `md-sync: <issue>` stderr line per issue and one `config invalid` log line per layer/file; returns exit code 2.
export function reportIssues(log: Logger, issues: readonly ConfigIssue[]): 2 {
  const groups = new Map<string, ConfigIssue[]>();
  for (const i of issues) {
    stderrLine(formatIssue(i));
    const k = `${i.layer}\0${i.file ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    log.error('config invalid', {
      layer: first.layer, ...(first.file !== undefined ? { file: first.file } : {}), issues: group.map(formatIssue),
    });
  }
  return 2;
}

function notFound(path: string): ConfigIssue {
  return { layer: 'instance', key: '(file)', message: 'config file not found', file: path };
}

function reportNotFound(log: Logger, path: string): 2 {
  stderrLine(`config file not found: ${path}`);
  log.error('config invalid', { layer: 'instance', file: path, issues: [formatIssue(notFound(path))] });
  return 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Layers for run, sync-once, install-service and print-workflow: --config, else the default file if it exists.

export function loadDirectLayers(c: CommandEnv): { kind: 'ok'; layers: DirectLayers } | Exit {
  const issues: ConfigIssue[] = [];
  const cli = validateCliLayer(c.values as Record<string, unknown>, c.cwd);
  if (cli.kind === 'invalid') issues.push(...cli.issues);

  let instance: InstanceInput = {};
  let instancePath: string | 'none' = 'none';
  if (c.values.config !== undefined) {
    const path = resolveDirInput(c.values.config, c.cwd);
    const inst = loadInstanceFile(path);
    if (inst.kind === 'missing') return { kind: 'exit', code: reportNotFound(c.log, path) };
    if (inst.kind === 'invalid') issues.push(...inst.issues);
    else { instance = inst.value; instancePath = path; }
  } else {
    const path = defaultConfigPath(c.env);
    const inst = loadInstanceFile(path);
    if (inst.kind === 'invalid') issues.push(...inst.issues);
    else if (inst.kind === 'ok') { instance = inst.value; instancePath = path; }
  }
  if (issues.length > 0) return { kind: 'exit', code: reportIssues(c.log, issues) };
  return { kind: 'ok', layers: { cli: cli.kind === 'ok' ? cli.value : {}, instance, instancePath } };
}

// run, sync-once and install-service: those layers plus the zero-config defaults read from the checkout (dir from the
// current directory, remote from its origin, branch from what is checked out; src/repo-defaults.ts). A refusal (no dir
// and the current directory is not the top of a checkout, a detached HEAD and no branch) is a config error: exit 2.
export async function loadStartupLayers(c: CommandEnv): Promise<{ kind: 'ok'; layers: DirectLayers } | Exit> {
  const loaded = loadDirectLayers(c);
  if (loaded.kind === 'exit') return loaded;
  const d = await withRepoDefaults({ layers: loaded.layers, cwd: c.cwd, env: c.env, log: c.log, dir: 'from-layers' });
  if (d.kind === 'refused') {
    // like a missing key: say where the config file was looked for, for a user who wrote it somewhere else
    const message = d.key === 'dir' && loaded.layers.instancePath === 'none'
      ? `${d.message} (no config file at ${defaultConfigPath(c.env)})` : d.message;
    stderrLine(message);
    c.log.error('config invalid', { key: d.key, issues: [message] });
    return { kind: 'exit', code: 2 };
  }
  return { kind: 'ok', layers: d.layers };
}

// run, sync-once and install-service: the provisional config (no repo layer) must have `dir`, `remote` and `branch`.
// `branch` has no default: a fresh clone (nothing checked out yet) needs it from a flag or the instance file.
export function requireRunKeys(log: Logger, layers: DirectLayers, env: NodeJS.ProcessEnv):
  { kind: 'ok'; config: ResolvedConfig & { dir: string; remote: string; branch: string } } | Exit {
  const { config } = resolveConfig({ ...layers, repo: {} }, shortHostname());
  const missing = requireKeys(config, ['dir', 'remote', 'branch'],
    layers.instancePath === 'none' ? defaultConfigPath(env) : undefined);
  if (missing.length > 0 || config.dir === undefined || config.remote === undefined || config.branch === undefined) {
    return { kind: 'exit', code: reportIssues(log, missing) };
  }
  return { kind: 'ok', config: { ...config, dir: config.dir, remote: config.remote, branch: config.branch } };
}

// ---------------------------------------------------------------------------------------------------------------
// Target dir for flush, status and uninstall-service plus their instance layer.

export type Target = {
  realDir: string;                       // realpath, or path.resolve when the dir does not exist
  dirState: 'present' | 'missing';
  paths: StatePaths;
  layers: DirectLayers;
  instance: 'file' | 'state' | 'none';   // where the instance layer came from ('none' => one-off warning)
  // An instance file found through the state file or the default path that does not validate. It is left out of
  // `layers` rather than failing the command: a flush is delivered over the socket without it, status and
  // uninstall-service need only the folder. Only a one-off run, which needs the config, refuses.
  invalidInstance: { path: string; issues: ConfigIssue[] } | 'none';
};

// A missing dir keeps the realpath of its longest existing ancestor, so `uninstall-service --dir /tmp/notes` after the
// folder was deleted still hashes /private/tmp/notes like install-service did (macOS /tmp, a symlinked home).
function realOrResolved(dir: string): { realDir: string; dirState: 'present' | 'missing' } {
  try {
    return { realDir: canonicalDir(dir), dirState: 'present' };
  } catch {
    return { realDir: realpathLoose(resolve(dir)), dirState: 'missing' };
  }
}

function sameRealDir(a: string, realDir: string): boolean {
  return realOrResolved(a).realDir === realDir;
}

export function resolveTarget(c: CommandEnv): { kind: 'ok'; target: Target } | Exit {
  const issues: ConfigIssue[] = [];
  const cliLoaded = validateCliLayer(c.values as Record<string, unknown>, c.cwd);
  if (cliLoaded.kind === 'invalid') issues.push(...cliLoaded.issues);
  const cli: InstanceInput = cliLoaded.kind === 'ok' ? cliLoaded.value : {};

  let explicit: { path: string; value: InstanceInput } | 'none' = 'none';
  if (c.values.config !== undefined) {
    const path = resolveDirInput(c.values.config, c.cwd);
    const inst = loadInstanceFile(path);
    if (inst.kind === 'missing') return { kind: 'exit', code: reportNotFound(c.log, path) };
    if (inst.kind === 'invalid') issues.push(...inst.issues);
    else explicit = { path, value: inst.value };
  }
  if (issues.length > 0) return { kind: 'exit', code: reportIssues(c.log, issues) };

  // The default file is read lazily: only when nothing more specific names the folder or the instance layer.
  const defaultPath = defaultConfigPath(c.env);
  let defaultFile: Loaded<InstanceInput> | 'unread' = 'unread';
  const readDefault = (): Loaded<InstanceInput> => {
    if (defaultFile === 'unread') defaultFile = loadInstanceFile(defaultPath);
    return defaultFile;
  };

  let dir: string | 'none' = cli.dir ?? (explicit !== 'none' ? explicit.value.dir ?? 'none' : 'none');
  if (dir === 'none') {
    dir = findSyncedAncestor(realpathOrSame(c.cwd), c.env);
  }
  if (dir === 'none') {
    const d = readDefault();
    if (d.kind === 'invalid') return { kind: 'exit', code: reportIssues(c.log, d.issues) };
    if (d.kind === 'ok' && d.value.dir !== undefined) dir = d.value.dir;
  }
  if (dir === 'none') {
    stderrLine('cannot determine the synced folder; pass --dir or --config');
    return { kind: 'exit', code: 2 };
  }

  const { realDir, dirState } = realOrResolved(dir);
  const paths = statePathsFor(realDir, c.env);

  if (explicit !== 'none') {
    return { kind: 'ok', target: { realDir, dirState, paths, instance: 'file', invalidInstance: 'none',
      layers: { cli, instance: explicit.value, instancePath: explicit.path } } };
  }

  // The state file remembers the daemon's own instance file and CLI overrides.
  const state = readState(paths.state);
  if (state !== 'none' && state.instance !== undefined) {
    let instance: InstanceInput = {};
    let instancePath: string | 'none' = 'none';
    let invalidInstance: Target['invalidInstance'] = 'none';
    const p = state.instance.configPath;
    if (p !== 'none' && existsSync(p)) {
      const inst = loadInstanceFile(p);
      if (inst.kind === 'invalid') invalidInstance = { path: p, issues: inst.issues };
      if (inst.kind === 'ok') { instance = inst.value; instancePath = p; }
    }
    const stored = validateCliLayer(state.instance.cli as Record<string, unknown>, realDir);
    const storedCli = stored.kind === 'ok' ? stored.value : {};   // written by us; a damaged record is ignored
    return { kind: 'ok', target: { realDir, dirState, paths, instance: 'state', invalidInstance,
      layers: { cli: { ...storedCli, ...cli }, instance, instancePath } } };
  }

  // The default file applies only when it describes this folder (or names no folder at all).
  const d = readDefault();
  if (d.kind === 'invalid') {
    return { kind: 'ok', target: { realDir, dirState, paths, instance: 'none',
      invalidInstance: { path: defaultPath, issues: d.issues }, layers: { cli, instance: {}, instancePath: 'none' } } };
  }
  if (d.kind === 'ok' && (d.value.dir === undefined || sameRealDir(d.value.dir, realDir))) {
    return { kind: 'ok', target: { realDir, dirState, paths, instance: 'file', invalidInstance: 'none',
      layers: { cli, instance: d.value, instancePath: defaultPath } } };
  }
  return { kind: 'ok', target: { realDir, dirState, paths, instance: 'none', invalidInstance: 'none',
    layers: { cli, instance: {}, instancePath: 'none' } } };
}

// status and uninstall-service go on without an invalid instance file; they say so once.
export function warnInvalidInstance(t: Target): void {
  if (t.invalidInstance === 'none') return;
  for (const i of t.invalidInstance.issues) stderrLine(`ignoring invalid config file: ${formatIssue(i)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Other state dirs

// State dirs, other than this environment's, where a daemon or one-off for the same folder may hold its socket and
// lock: the default one (when XDG_STATE_HOME is set here) and the XDG_STATE_HOME recorded in this folder's installed
// unit (when it is not, or differs). A flush from a hook started with another environment otherwise misses the
// daemon's socket and starts a second sync of the same folder, without the daemon's `ignore` list or author.
export function otherStatePaths(realDir: string, env: NodeJS.ProcessEnv): StatePaths[] {
  const current = xdgStateHome(env);
  const defaultHome = xdgStateHome({ ...env, XDG_STATE_HOME: undefined });
  const others = [...new Set([defaultHome, ...installedStateHomes(dirHash(realDir), env)])].filter((h) => h !== current);
  return [...others.map((home) => statePathsFor(realDir, { ...env, XDG_STATE_HOME: home })),
    ...renamedStatePaths(realDir, env, [current, ...others])];
}

// State paths of a live owner that locked this same folder under another spelling. After a case-only rename of the
// folder or a parent (case-insensitive disks), the old spelling still resolves to this folder but hashes differently;
// until that daemon notices and restarts under the new path, flush and status must still find it, or a
// flush would start a second sync of the folder.
export function renamedStatePaths(realDir: string, env: NodeJS.ProcessEnv, homes: readonly string[]): StatePaths[] {
  const out: StatePaths[] = [];
  for (const home of homes) {
    let names: string[];
    try {
      names = readdirSync(stateDirIn(home)).filter((n) => n.endsWith('.lock'));
    } catch {
      continue;
    }
    for (const n of names) {
      const r = readLockOwner(join(stateDirIn(home), n));
      if (r === 'none' || r === 'unparsable' || r.owner.dir === realDir) continue;
      let real: string;
      try {
        real = realpathSync(r.owner.dir);
      } catch {
        continue;
      }
      if (real === realDir) out.push(statePathsFor(r.owner.dir, { ...env, XDG_STATE_HOME: home }));
    }
  }
  return out;
}

// A live lock owner for the same folder under one of those dirs.
export function liveOwnerElsewhere(others: readonly StatePaths[]): { owner: LockOwner; stateDir: string } | 'none' {
  for (const p of others) {
    const r = readLockOwner(p.lock);
    if (r !== 'none' && r !== 'unparsable' && ownerLiveness(r.owner) === 'alive') return { owner: r.owner, stateDir: p.stateDir };
  }
  return 'none';
}

// The one-off run's lock for this folder, unless a live owner holds it under another state dir (`others`) or here.
export function acquireOneOffLock(paths: StatePaths, realDir: string, others: readonly StatePaths[], log: Logger): AcquireResult {
  const elsewhere = liveOwnerElsewhere(others);
  if (elsewhere !== 'none') return { kind: 'busy', owner: elsewhere.owner };
  return acquireLock(paths, realDir, 'one-off', log);
}

// ---------------------------------------------------------------------------------------------------------------
// Run bookkeeping (the daemon's onRunEnd steps 1–2; the one-off runner uses the same rules)

export function freshState(realDir: string): StateFile {
  return { version: 1, dir: realDir, pid: process.pid, updatedAt: new Date().toISOString(), consecutiveFailures: 0,
    keptStashes: [] };
}

export function loadStateOrFresh(paths: StatePaths, realDir: string): StateFile {
  const s = readState(paths.state);
  return s === 'none' ? freshState(realDir) : { ...s, dir: realDir };
}

export function isOkOutcome(o: RunResult['outcome']): boolean {
  return o === 'ok' || o === 'conflict-resolved';
}

// RunResult.keptStashes carries no reason; it follows from the outcome (a resolved run kept a stash only on a raced write).
function keptReason(o: RunResult['outcome']): KeptStash['reason'] {
  if (o === 'data-guard-stop') return 'data-guard-stop';
  return isOkOutcome(o) ? 'write-raced' : 'failed';
}

// Shas no longer in refs/stash are dropped. A git failure keeps the entry (never forget a stash on doubt).
async function pruneKept(git: GitClient | 'none', kept: KeptStash[]): Promise<KeptStash[]> {
  if (git === 'none') return kept;
  const out: KeptStash[] = [];
  for (const k of kept) {
    let where: number | 'absent' = 0;
    try { where = await stashIndexOf(git, k.sha); } catch { /* keep */ }
    if (where !== 'absent') out.push(k);
  }
  return out;
}

export function nextStuck(prev: StuckRecord | 'none', res: RunResult, nowIso: string): StuckRecord | 'none' {
  if ((res.outcome === 'failed' || res.outcome === 'data-guard-stop') && res.s5 !== undefined) {
    const same = prev !== 'none' && prev.head === res.s5.head && prev.remote === res.s5.remote;
    // A replayed failure's error is "unchanged since <since>: <error>"; stored as the error, every replay nested one
    // more prefix (about 42 bytes a run, for as long as the device stayed stuck).
    const error = same && res.stuck === 'unchanged' ? prev.error : res.error ?? '';
    return { head: res.s5.head, remote: res.s5.remote, outcome: res.outcome, error, since: same ? prev.since : nowIso };
  }
  return 'none';
}

// Whether a run counts as a sync for the run record. The settle timer's run ('settle' only) runs preflight and
// nothing else: it never fetched, committed or pushed, so when it ends ok it says nothing about the last sync. Counted,
// it replaced a failed run's `last error`, cleared its stuck record and cancelled its backoff retry five seconds after
// any run that had replaced a file, so an unpushed commit waited for an unrelated trigger.
export type RunBookkeeping = 'sync' | 'settle-only';

export function runBookkeeping(req: Pick<RunRequest, 'kind' | 'reasons'>): RunBookkeeping {
  return req.kind === 'pull-only' && req.reasons.length > 0 && req.reasons.every((r) => r === 'settle') ? 'settle-only' : 'sync';
}

// lastRun, consecutiveFailures, lastOkAt, keptStashes (appended + pruned) and stuck. The caller writes the file. A
// settle-only run that ended ok changes only keptStashes and integrated; one that failed (its preflight did) is
// recorded, but never touches the stuck record: it did not reach S5, so it says nothing about {H, R}.
export async function recordRun(o: { state: StateFile; res: RunResult; stuck: StuckRecord | 'none';
  git: GitClient | 'none'; bookkeeping?: RunBookkeeping }): Promise<{ state: StateFile; stuck: StuckRecord | 'none' }> {
  const nowIso = new Date().toISOString();
  const { res } = o;
  const neutral = o.bookkeeping === 'settle-only' && isOkOutcome(res.outcome) ? 'neutral' : 'counted';
  const s: StateFile = { ...o.state, pid: process.pid, updatedAt: nowIso };
  if (neutral === 'counted') {   // a neutral run leaves the run record the last sync's
    s.lastRun = { ...res, finishedAt: nowIso };
    if (isOkOutcome(res.outcome)) {
      s.consecutiveFailures = 0;
      s.lastOkAt = nowIso;
    } else {
      s.consecutiveFailures = o.state.consecutiveFailures + 1;
    }
  }
  const kept = [...o.state.keptStashes];
  for (const sha of res.keptStashes) {
    if (!kept.some((k) => k.sha === sha)) kept.push({ sha, reason: keptReason(res.outcome), at: nowIso });
  }
  s.keptStashes = await pruneKept(o.git, kept);
  if (res.integrated !== undefined) s.integrated = res.integrated;
  const stuck = o.bookkeeping === 'settle-only' ? o.stuck : nextStuck(o.stuck, res, nowIso);
  if (stuck === 'none') delete s.stuck;
  else s.stuck = stuck;
  return { state: s, stuck };
}
