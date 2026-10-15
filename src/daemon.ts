// Long-running orchestration: startup, triggers, timers, watcher, ntfy, IPC, SIGHUP, shutdown and callback guards.
// The only module that wires those pieces together.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { expBackoffMs, NETWORK_BACKOFF, sleep } from './backoff';
import { ensureRepo } from './bootstrap';
import {
  type AutoCommit, changedKeys, type DirectLayers, formatIssue, type LoadedRepoConfig, loadInstanceFile, loadRepoConfig,
  type ReadyConfig, readRepoConfigBlob, type RepoInput, type ResolvedConfig,
  resolveConfig,
} from './config';
import { createRunContext, loadEffectiveConfig, type RunContext } from './context';
import { createGitClient, headSha, isAncestor, requireGitVersion, setNetworkDeadline } from './git';
import { shortHostname } from './host';
import { DELIVERY_WAIT_MS, type FlushRequest, type IpcReply, type IpcServer, startIpcServer } from './ipc';
import { acquireLock, type LockHandle } from './lock';
import { errorText, type Logger } from './log';
import { SETTLE_GRACE_MS, settlePending } from './move';
import { type NetworkChange, NetworkWatcher } from './netwatch';
import { startNtfy, type NtfyHandle } from './ntfy';
import { canonicalDir, ensureStateDir, type StatePaths, statePathsFor } from './paths';
import { aheadCount, ignoredDirs, pendingChanges } from './pending';
import { failedRunResult, SyncQueue } from './queue';
import { type LivenessGuard, LOOP_STALL_MS, startLivenessGuard } from './liveness';
import { killChildrenGracefully } from './spawn';
import { rememberRepoConfig, type StateFile, writeState } from './state';
import { syncRun } from './sync';
import { BackupTimers, IntervalTimer, WakeDetector } from './timers';
import {
  type BackupTimerName, type Clock, type DaemonPhase, realClock, type RunMode, type RunRequest, type RunResult,
  type StuckRecord, type TimerHandle, type Trigger,
} from './types';
import { startWatcher, type WatcherBackend, type WatcherHandle } from './watcher';
import {
  isOkOutcome, liveOwnerElsewhere, loadStateOrFresh, otherStatePaths, recordRun, runBookkeeping, stderrLine,
} from './commands/shared';

export const SHUTDOWN_BUDGET_MS = 240_000;

const LOCK_POLL_MS = 200;
const DEGRADED_RECOVERY_MS = 60_000;
// A degraded watcher is recreated from its poll at most this often, never on a config reload: the error source (an
// unreadable folder, inotify limits) usually persists, and every recreation that fails again would only churn.
const DEGRADED_RETRY_MS = 600_000;
const RESTART_KEYS: ReadonlySet<keyof ResolvedConfig> = new Set(['dir', 'remote', 'branch']);
// How often the daemon checks that the synced folder's canonical path is still the one it started with.
export const FOLDER_CHECK_MS = 15_000;
// New folders seen by the poll watcher refresh the gitignored-dir list at most this often.
export const IGNORED_DIRS_REFRESH_MS = 30_000;

// When the settle timer fires for a run's settleDueAt. After a failed run an overdue entry is not settled at
// once: the retry's backoff paces the next attempt, so a run that keeps failing can't turn the settle timer into a
// loop of runs (chaos seed 105: ~2 failed runs a second, for good).
export function settleTimerDue(dueAt: number, run: 'ok' | 'failed', now: number): number {
  return run === 'ok' ? dueAt : Math.max(dueAt, now + SETTLE_GRACE_MS);
}

export function guard(log: Logger, source: string, fn: () => unknown | Promise<unknown>): void {
  const failed = (e: unknown): void => log.error('callback failed', { source, error: e });
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(failed);
  } catch (e) {
    failed(e);
  }
}

type StopSignal = 'SIGTERM' | 'SIGINT';
type RunEnd = { kind: 'run'; req: RunRequest; res: RunResult } | { kind: 'poll' };

function isGitignore(rel: string): boolean {
  return rel === '.gitignore' || rel.endsWith('/.gitignore');
}

function resultReply(r: RunResult): IpcReply {
  return { type: 'result', outcome: r.outcome, head: r.head, commitsOut: r.commitsOut,
    ...(r.error !== undefined ? { error: r.error } : {}) };
}

// Wait behind a live one-off (it can take several network timeouts), fail fast behind a daemon.
async function acquireDaemonLock(paths: StatePaths, realDir: string, log: Logger): Promise<LockHandle | 'busy'> {
  const startedMs = Date.now();
  let waiting: 'logged' | 'not-yet' = 'not-yet';
  for (;;) {
    const r = acquireLock(paths, realDir, 'daemon', log);
    if (r.kind === 'acquired') return r.handle;
    const { owner } = r;
    // pid 0: a lock file still being written (lock.ts gives it 5 s before calling it stale), so poll again.
    const waitable = owner.pid === 0 || owner.purpose === 'one-off';
    if (!waitable || Date.now() - startedMs >= DELIVERY_WAIT_MS) {
      log.error('lock busy', { pid: owner.pid, dir: realDir, purpose: owner.purpose });
      stderrLine(`another mdsync (pid ${owner.pid}) is already syncing ${realDir}`);
      return 'busy';
    }
    if (waiting === 'not-yet' && owner.pid !== 0) {
      waiting = 'logged';
      log.info('waiting for lock', { pid: owner.pid, purpose: owner.purpose });
    }
    await Bun.sleep(LOCK_POLL_MS);
  }
}

export async function runDaemon(o: { layers: DirectLayers; env: NodeJS.ProcessEnv; log: Logger;
  clock?: Clock }): Promise<number> {
  const { log } = o;
  const provisional = resolveConfig({ ...o.layers, repo: {} }, shortHostname()).config;
  if (provisional.dir === undefined) {
    stderrLine('missing required config key "dir"');
    return 2;
  }
  mkdirSync(provisional.dir, { recursive: true });
  const realDir = canonicalDir(provisional.dir);
  const paths = statePathsFor(realDir, o.env);
  ensureStateDir(paths);
  // one sync of a folder at a time, also across the state dirs we can see (another XDG_STATE_HOME)
  const elsewhere = liveOwnerElsewhere(otherStatePaths(realDir, o.env));
  if (elsewhere !== 'none') {
    log.error('lock busy', { pid: elsewhere.owner.pid, dir: realDir, purpose: elsewhere.owner.purpose });
    stderrLine(`another mdsync (pid ${elsewhere.owner.pid}) is already syncing ${realDir} (state in ${elsewhere.stateDir})`);
    return 1;
  }
  const lock = await acquireDaemonLock(paths, realDir, log);
  if (lock === 'busy') return 1;
  return new Daemon({ layers: o.layers, log, clock: o.clock ?? realClock, realDir, paths, lock,
    wakeTickMs: testWakeTick(o.env), watcherBackend: testWatcherBackend(o.env), network: testNetwork(o.env) }).start();
}

// Test hook: MDSYNC_TEST_WATCHER=poll|fsevents picks the watcher backend, so the Linux default
// (poll) runs on macOS too. Never set in production.
function testWatcherBackend(env: NodeJS.ProcessEnv): WatcherBackend | 'default' {
  const b = env.MDSYNC_TEST_WATCHER;
  return b === 'poll' || b === 'fsevents' ? b : 'default';
}

// Test hook: MDSYNC_TEST_WAKE_TICK_MS shrinks the wake detector's tick (slack: 4 ticks), so an
// acceptance test can stand for a laptop sleep with a few seconds of SIGSTOP instead of 75. Never set in production.
function testWakeTick(env: NodeJS.ProcessEnv): number | 'default' {
  const n = Number(env.MDSYNC_TEST_WAKE_TICK_MS);
  return Number.isInteger(n) && n >= 100 ? n : 'default';
}

type NetworkSource = { read: () => string[]; tickMs: number } | 'default';

// Test hook: MDSYNC_TEST_NETWORK_FILE=<path> makes the network watcher read its snapshot
// from that file (a JSON array of strings; missing or invalid is a failed read) every 200 ms, so an acceptance test can
// stand for a laptop leaving and rejoining Wi-Fi. Never set in production.
function testNetwork(env: NodeJS.ProcessEnv): NetworkSource {
  const file = env.MDSYNC_TEST_NETWORK_FILE;
  if (file === undefined || file === '') return 'default';
  return {
    tickMs: 200,
    read: () => {
      const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error('not a JSON array of strings');
      return v;
    },
  };
}

class Daemon {
  readonly #log: Logger;
  readonly #clock: Clock;
  readonly #realDir: string;
  readonly #paths: StatePaths;
  readonly #lock: LockHandle;
  readonly #host = shortHostname();
  #layers: DirectLayers;

  #phase: DaemonPhase = 'starting';
  #stop: 'none' | 'requested' | 'forced' = 'none';
  #reload: 'none' | 'pending' = 'none';
  #runMode: RunMode = 'normal';
  #runState: 'idle' | 'running' = 'idle';
  #startup: { kind: 'booting' } | { kind: 'ready' } | { kind: 'failed'; error: string } = { kind: 'booting' };

  #config: ReadyConfig | undefined;
  #ctx: RunContext | undefined;
  #repoBlob: string | 'none' = 'none';
  #repoLayer: RepoInput = {};
  #pendingConfig: { config: ReadyConfig; trigger: 'sighup' | 'repo-config' } | 'none' = 'none';
  #applying: Promise<void> = Promise.resolve();

  #state: StateFile;
  #stuck: StuckRecord | 'none' = 'none';   // in memory only: a restart retries a remembered S5 failure once

  #queue: SyncQueue;
  #ipc: IpcServer | undefined;
  #watcher: WatcherHandle | undefined;
  #watcherErrors: 'clean' | 'errored' = 'clean';
  #degraded: { poll: IntervalTimer; lastAttemptAt: number } | 'none' = 'none';
  #batching: { kind: 'idle' } | { kind: 'busy'; next: Set<string> } = { kind: 'idle' };
  #ntfy: NtfyHandle | undefined;
  #timers: BackupTimers | undefined;
  #fallback: IntervalTimer | undefined;
  #wake: WakeDetector | undefined;
  #network: NetworkWatcher | undefined;
  #folderCheck: IntervalTimer | undefined;
  readonly #wakeTickMs: number | 'default';
  readonly #networkSource: NetworkSource;
  #exitCode: 0 | 1 = 0;   // 1 when the daemon stops itself because the folder moved
  #retry: { handle: TimerHandle; dueAt: number } | 'none' = 'none';
  #settle: { handle: TimerHandle; dueAt: number } | 'none' = 'none';   // replaced inodes waiting out their grace
  #cloned: 'fresh-clone' | 'none' = 'none';   // the first run after this process's own clone (P1b logs no `recovered`)
  readonly #settleWait = new AbortController();   // a second signal skips the shutdown's settle wait
  #backoffStep = 0;   // advances only when a retry itself fails
  #buffered: string[] = [];
  #gitignorePrint: string | 'unknown' = 'unknown';
  #ignoredRefresh: { kind: 'idle'; lastAt: number } | { kind: 'scheduled'; handle: TimerHandle; lastAt: number } =
    { kind: 'idle', lastAt: Number.NEGATIVE_INFINITY };
  readonly #watcherBackend: WatcherBackend | 'default';

  #exit: { resolve: (code: number) => void; promise: Promise<number>; state: 'open' | 'resolved' };
  #liveness: LivenessGuard | 'none' = 'none';
  readonly #bootWait = new AbortController();   // a stop signal ends the wait between first-clone attempts

  constructor(o: { layers: DirectLayers; log: Logger; clock: Clock; realDir: string; paths: StatePaths; lock: LockHandle;
    wakeTickMs: number | 'default'; watcherBackend: WatcherBackend | 'default'; network: NetworkSource }) {
    this.#wakeTickMs = o.wakeTickMs;
    this.#networkSource = o.network;
    this.#watcherBackend = o.watcherBackend;
    this.#layers = o.layers;
    this.#log = o.log;
    this.#clock = o.clock;
    this.#realDir = o.realDir;
    this.#paths = o.paths;
    this.#lock = o.lock;
    this.#state = loadStateOrFresh(o.paths, o.realDir);
    let resolve: (code: number) => void = () => {};
    const promise = new Promise<number>((r) => { resolve = r; });
    this.#exit = { resolve, promise, state: 'open' };
    this.#queue = new SyncQueue({
      run: (req, runId) => this.#run(req, runId),
      log: o.log,
      clock: o.clock,
      hooks: {
        onRunStart: (req) => this.#onRunStart(req),
        onRunEnd: (req, res, consumed) => this.#onRunEnd(req, res, consumed),
      },
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Startup

  start(): Promise<number> {
    const log = this.#log;
    process.on('exit', () => {
      this.#ipc?.stopAccepting();
      this.#lock.release();
    });
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => guard(log, `signal.${sig}`, () => this.#onStopSignal(sig)));
    }
    process.on('SIGHUP', () => guard(log, 'signal.SIGHUP', () => this.#onHangup()));
    process.on('uncaughtException', (e) => this.#fatal(e));
    process.on('unhandledRejection', (e) => this.#fatal(e));
    try {
      this.#liveness = startLivenessGuard({ onError: (e) => log.warn('liveness guard unavailable', { error: e }),
        onReady: () => log.debug('liveness guard started', { stallMs: LOOP_STALL_MS }) });
    } catch (e) {
      log.warn('liveness guard unavailable', { error: e });
    }

    this.#state = { ...this.#state, pid: process.pid, updatedAt: new Date().toISOString(),
      instance: { configPath: this.#layers.instancePath, cli: this.#layers.cli } };
    this.#writeState();
    rmSync(this.#paths.stateTmp, { force: true });
    rmSync(this.#paths.tmp, { recursive: true, force: true });
    mkdirSync(this.#paths.tmp, { recursive: true, mode: 0o700 });

    this.#queue.hold();
    try {
      this.#ipc = startIpcServer({ sockPath: this.#paths.sock, log,
        onFlush: (req, reply, end) => this.#onFlush(req, reply, end) });
    } catch (e) {
      this.#fatal(e);
      return this.#exit.promise;
    }
    guard(log, 'daemon.boot', () => this.#boot());
    return this.#exit.promise;
  }

  async #boot(): Promise<void> {
    const log = this.#log;
    try {
      const provisional = resolveConfig({ ...this.#layers, repo: {} }, this.#host).config;
      const git = createGitClient({ cwd: this.#realDir,
        sshKey: provisional.sshKey, identity: { name: provisional.authorName, email: provisional.authorEmail }, log });
      // A first clone that fails on the network or on auth is retried on the network backoff, holding the lock and
      // the socket: exiting made launchd and systemd hit the remote again every 5 to 10 s, for as long as it lasted.
      // git 2.40 or newer: the replay needs `merge-tree --merge-base` and the move `--attr-source`
      await requireGitVersion(git);
      for (let attempt = 1; ; attempt++) {
        const boot = await ensureRepo({ realDir: this.#realDir, config: provisional, log, git },
          'may-clone');
        if (boot.kind === 'ready') {
          if (boot.cloned === 'cloned') this.#cloned = 'fresh-clone';
          break;
        }
        if (boot.retry === 'final') return await this.#failStartup(boot.error);
        if (this.#stop !== 'none') return await this.#failStartup(boot.error, 'stopped');
        const delayMs = expBackoffMs(attempt, NETWORK_BACKOFF);
        log.info('retry scheduled', { delayMs, failures: attempt, after: 'network-error' });
        if ((await sleep(delayMs, this.#bootWait.signal)) === 'aborted') return await this.#failStartup(boot.error, 'stopped');
      }

      // the last valid repo layer seen here, so an invalid committed one never drops its `ignore` list on a restart
      const eff = await loadEffectiveConfig({ layers: this.#layers, realDir: this.#realDir, paths: this.#paths, log,
        clock: this.#clock, ...(this.#state.repoConfig !== undefined ? { lastGoodRepo: this.#state.repoConfig.layer } : {}) });
      this.#config = eff.config;
      this.#ctx = eff.ctx;
      this.#repoBlob = eff.repo.blob;
      this.#repoLayer = eff.repo.layer;
      this.#rememberRepoLayer(eff.repo);
      this.#startup = { kind: 'ready' };
      // where dir, remote and branch came from: a zero-config start reports 'default', 'origin' and 'checkout' (the
      // logger redacts credentials in the remote URL)
      log.info('daemon starting', { version: pkg.version, dir: this.#realDir, remote: eff.config.remote,
        branch: eff.config.branch, sources: { dir: eff.sources.dir, remote: eff.sources.remote, branch: eff.sources.branch },
        pid: process.pid });

      if (this.#stop !== 'none') return await this.#shutdownSequence();
      await this.#startServices();
      if (this.#stop !== 'none') return await this.#shutdownSequence();

      this.#phase = 'running';
      // Arms the timers for changes left from before the start (after `running`, or the phase gate makes it a no-op).
      const [, head] = await Promise.all([this.#statusCheck({ kind: 'poll' }), headSha(eff.ctx.git)]);
      if (this.#phase !== 'running') return;   // a signal during the awaits above: the shutdown sequence owns the queue
      log.info('daemon ready', { socket: this.#paths.sock, head });
      this.#queue.request({ kind: 'pull-only', reason: 'startup' });
      this.#queue.release();
      await this.#applyPendingReload();
    } catch (e) {
      await this.#failStartup(errorText(e));
    }
  }

  // A SIGHUP that arrived while a run or the startup was in progress is applied once that is over.
  async #applyPendingReload(): Promise<void> {
    if (this.#reload !== 'pending') return;
    this.#reload = 'none';
    await this.#applySighup();
  }

  async #startServices(): Promise<void> {
    const config = this.#need().config;
    this.#timers = new BackupTimers({ idleMs: config.idleMs, maxWaitMs: config.maxWaitMs, clock: this.#clock,
      onFire: (t) => guard(this.#log, 'daemon.backupTimer', () => this.#onBackupTimer(t)),
      idleFloorMs: () => 2 * (this.#watcher?.latencyMs() ?? 0) });
    await this.#startWatcher();
    this.#startNtfy();
    this.#fallback = new IntervalTimer({ ms: config.fallbackMs, clock: this.#clock,
      onFire: () => guard(this.#log, 'daemon.fallback', () => this.#requestPull('fallback')) });
    this.#fallback.start();
    const tick = this.#wakeTickMs;
    this.#wake = new WakeDetector({ clock: this.#clock, ...(tick !== 'default' ? { tickMs: tick, slackMs: 4 * tick } : {}),
      onWake: (gapMs) => guard(this.#log, 'daemon.wake', () => this.#onWake(gapMs)) });
    this.#wake.start();
    const net = this.#networkSource;
    this.#network = new NetworkWatcher({ clock: this.#clock, ...(net !== 'default' ? net : {}),
      onChange: (c) => guard(this.#log, 'daemon.network', () => this.#onNetworkChange(c)) });
    this.#network.start();
    this.#folderCheck = new IntervalTimer({ ms: FOLDER_CHECK_MS, clock: this.#clock,
      onFire: () => guard(this.#log, 'daemon.folderCheck', () => this.#checkFolder()) });
    this.#folderCheck.start();
  }

  // A case-only rename of the folder or a parent (case-insensitive disks) keeps the old path working for git,
  // but FSEvents then reports the new spelling and Bun drops every event (it compares paths case-sensitively), and
  // flush/status hash the new spelling, so they miss this daemon. Exit 1 so the service manager restarts it under the
  // folder's new canonical path. A folder that is gone is left to P0, which fails the runs and says so.
  #checkFolder(): Promise<void> | void {
    if (this.#phase !== 'running' || this.#stop !== 'none') return;
    let now: string;
    try {
      now = canonicalDir(this.#realDir);
    } catch {
      return;
    }
    if (now === this.#realDir) return;
    this.#log.error('folder moved', { dir: this.#realDir, now });
    stderrLine(`the synced folder is now ${now} (was ${this.#realDir}); stopping so mdsync restarts there`);
    this.#exitCode = 1;
    return this.#beginStop();
  }

  // 'stopped': a SIGTERM while the first clone was still being retried, which is a clean exit (0).
  async #failStartup(error: string, why: 'failed' | 'stopped' = 'failed'): Promise<void> {
    if (why === 'failed') {
      stderrLine(error);
      this.#log.error('startup failed', { error });
    }
    this.#startup = { kind: 'failed', error };
    this.#queue.release();          // held flushes run and get `failed`
    await this.#queue.whenIdle();
    this.#ipc?.stopAccepting();
    this.#ipc?.closeAll();
    this.#lock.release();
    if (why === 'stopped') this.#log.info('shutdown complete', { exitCode: 0 });
    this.#resolveExit(why === 'stopped' ? 0 : 1);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Queue hooks

  #run(req: RunRequest, runId: number): Promise<RunResult> {
    if (this.#startup.kind === 'failed' || this.#ctx === undefined) {
      const error = this.#startup.kind === 'failed' ? this.#startup.error : 'daemon is not ready';
      return Promise.resolve(failedRunResult(req, runId, { mode: this.#runMode, error, startedMs: Date.now(), durationMs: 0 }));
    }
    const cloned = this.#cloned;
    this.#cloned = 'none';
    return syncRun(this.#ctx, req, runId,
      { mode: this.#runMode, stuck: this.#stuck, keptStashes: this.#state.keptStashes.map((k) => k.sha),
        integrated: this.#state.integrated ?? 'none', cloned });
  }

  #onRunStart(req: RunRequest): void {
    this.#runState = 'running';
    if (req.kind === 'commit' && this.#phase === 'running') this.#timers?.onCommitRunStart(req.commit.scope.kind);
  }

  async #onRunEnd(req: RunRequest, res: RunResult, consumed: readonly Trigger[]): Promise<void> {
    const ctx = this.#ctx;
    if (this.#startup.kind !== 'ready' || ctx === undefined) {
      this.#runState = 'idle';
      return;
    }
    // 1–2: state and stuck record. A settle-only run that ended ok is not a sync: the retry, its backoff and the
    // run record stay the last sync's.
    const bookkeeping = runBookkeeping(req);
    const rec = await recordRun({ state: this.#state, res, stuck: this.#stuck, git: ctx.git, bookkeeping });
    this.#state = rec.state;
    this.#stuck = rec.stuck;
    if (isOkOutcome(res.outcome) && bookkeeping === 'sync') {
      this.#clearRetry();
      this.#backoffStep = 0;
      delete this.#state.nextRetryAt;
    }
    this.#writeState();

    // 3: a commit run that never reached S2 keeps its triggers (message, scope) for the next run
    if (req.kind === 'commit' && res.commitStep === 'not-reached') {
      const commits = consumed.filter((t) => t.kind === 'commit');
      if (commits.length > 0) {
        this.#queue.carry(commits);
        this.#log.info('flush deferred', { after: res.outcome, triggers: commits.length });
      }
    }

    // 4
    if (this.#phase !== 'running') {
      this.#runState = 'idle';
      return;
    }
    // 5
    if (!isOkOutcome(res.outcome)) this.#scheduleRetry(res.outcome, req);
    if (res.settleDueAt !== undefined) {
      this.#armSettle(settleTimerDue(res.settleDueAt, isOkOutcome(res.outcome) ? 'ok' : 'failed', this.#clock.now()));
    }
    // 6
    this.#runState = 'idle';
    await this.#refreshIgnoredDirsIfChanged();
    await this.#statusCheck({ kind: 'run', req, res });
    await this.#drainBuffered();
    // 7
    await this.#reloadRepoConfig();
    await this.#applyPendingReload();
    await this.#applyPendingConfig();
  }

  // The backoff step advances only when the retry's own run fails. Any other failed run (a flush, a backup timer, an
  // ntfy pull) while a retry is pending keeps that retry: a few flushes during a short outage used to push the next
  // automatic attempt out to the 10-minute cap within seconds.
  #scheduleRetry(after: RunResult['outcome'], req: RunRequest): void {
    const failures = Math.max(1, this.#state.consecutiveFailures);
    const now = this.#clock.now();
    const fromRetry = req.reasons.includes('retry');
    if (this.#retry !== 'none' && !fromRetry) {
      this.#log.info('retry scheduled', { delayMs: Math.max(0, this.#retry.dueAt - now), failures, after });
      return;
    }
    this.#clearRetry();
    this.#backoffStep = fromRetry ? this.#backoffStep + 1 : Math.max(1, this.#backoffStep);
    const delayMs = expBackoffMs(this.#backoffStep, NETWORK_BACKOFF);
    this.#log.info('retry scheduled', { delayMs, failures, after });
    const handle = this.#clock.setTimeout(() => {
      this.#retry = 'none';
      guard(this.#log, 'daemon.retry', () => this.#requestPull('retry'));
    }, delayMs);
    this.#retry = { handle, dueAt: now + delayMs };
    this.#state.nextRetryAt = new Date(now + delayMs).toISOString();
    this.#writeState();
  }

  #clearRetry(): void {
    if (this.#retry !== 'none') this.#clock.clearTimeout(this.#retry.handle);
    this.#retry = 'none';
  }

  // The settle timer: a settle-only run once the earliest replaced inode is due. Re-armed, never stacked.
  // Without it, replaced inodes would wait in the temp folder until the next run, which can be an hour away.
  #armSettle(dueAt: number): void {
    if (this.#settle !== 'none') {
      if (this.#settle.dueAt <= dueAt + 50 && this.#settle.dueAt > this.#clock.now()) return;
      this.#clock.clearTimeout(this.#settle.handle);
    }
    const at = dueAt + 50;
    const handle = this.#clock.setTimeout(() => {
      this.#settle = 'none';
      guard(this.#log, 'daemon.settle', () => this.#requestPull('settle'));
    }, Math.max(0, at - this.#clock.now()));
    this.#settle = { handle, dueAt: at };
  }

  #clearSettle(): void {
    if (this.#settle !== 'none') this.#clock.clearTimeout(this.#settle.handle);
    this.#settle = 'none';
  }

  // ------------------------------------------------------------------------------------------------------------
  // Triggers

  #requestPull(reason: 'fallback' | 'retry' | 'wake' | 'network' | 'ntfy' | 'ntfy-connect' | 'ntfy-reconnect' | 'settle'): void {
    if (this.#phase !== 'running') return;
    this.#queue.request({ kind: 'pull-only', reason });
  }

  #onBackupTimer(timer: BackupTimerName): void {
    if (this.#phase !== 'running' || this.#autoCommit() === 'off') return;
    this.#log.info('backup timer fired', { timer });
    this.#queue.request({ kind: 'commit', source: 'backup', timer });
  }

  #onWake(gapMs: number): void {
    if (this.#phase !== 'running') return;
    this.#log.info('wake detected', { gapMs });
    this.#ntfy?.reconnectNow();
    this.#requestPull('wake');
  }

  // The machine joined a network: retry now rather than at the end of the backoff. The pending retry is left
  // alone: this run ending ok clears it, and a failed one keeps it without advancing the step (its reasons lack 'retry').
  #onNetworkChange(c: NetworkChange): void {
    if (this.#phase !== 'running') return;
    this.#log.info('network changed', { added: c.added, removed: c.removed });
    this.#ntfy?.reconnectNow();
    this.#requestPull('network');
  }

  #onFlush(req: FlushRequest, reply: (r: IpcReply) => void, end: () => void): void {
    guard(this.#log, 'daemon.onFlush', () => {
      this.#log.info('flush received', { paths: req.paths?.length ?? 0,
        message: req.message !== undefined && req.message !== '' ? 'given' : 'none', wait: req.wait });
      const t: Extract<Trigger, { source: 'flush' }> = { kind: 'commit', source: 'flush',
        ...(req.message !== undefined ? { message: req.message } : {}),
        ...(req.paths !== undefined && req.paths.length > 0 ? { paths: [...req.paths] } : {}) };
      reply({ type: 'queued' });
      if (req.wait === 'wait') {
        this.#queue.request({ ...t, waiter: (r) => { reply(resultReply(r)); end(); } });
      } else {
        end();
        this.#queue.request(t);
      }
    });
  }

  #startNtfy(): void {
    const url = this.#need().config.ntfyUrl;
    if (url === undefined) return;
    try {
      this.#log.addSecret(new URL(url).pathname.replace(/\/+$/, ''));
    } catch {
      // zod validated the URL; nothing to hide otherwise
    }
    this.#ntfy = startNtfy({ url, log: this.#log, clock: this.#clock,
      onConnect: (n) => guard(this.#log, 'daemon.onConnect', () => this.#requestPull(n === 'first' ? 'ntfy-connect' : 'ntfy-reconnect')),
      onSha: (sha) => guard(this.#log, 'daemon.onSha', () => this.#onSha(sha)) });
  }

  async #onSha(sha: string): Promise<void> {
    const ctx = this.#ctx;
    if (this.#phase !== 'running' || ctx === undefined) return;
    if ((await isAncestor(ctx.git, sha, 'HEAD')) === 'ancestor') {
      this.#log.debug('ntfy echo ignored', { sha });   // our own push, or already integrated
      return;
    }
    this.#log.info('ntfy event', { sha });
    this.#requestPull('ntfy');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Watcher → timers

  async #startWatcher(): Promise<void> {
    const { ctx } = this.#need();
    let dirs: string[] = [];
    try {
      dirs = await ignoredDirs(ctx);
    } catch (e) {
      this.#log.error('callback failed', { source: 'daemon.ignoredDirs', error: e });
    }
    this.#watcherErrors = 'clean';
    this.#watcher = await startWatcher({ root: this.#realDir, ignore: ctx.ignore, ignoredDirs: dirs, log: this.#log,
      onBatch: (rels) => guard(this.#log, 'daemon.onBatch', () => this.#onBatch(rels)),
      onError: () => guard(this.#log, 'daemon.onError', () => this.#onWatcherError()),
      onNewDirs: () => guard(this.#log, 'daemon.onNewDirs', () => this.#refreshIgnoredDirsSoon()),
      ...(this.#watcherBackend !== 'default' ? { backend: this.#watcherBackend } : {}) });
  }

  // A folder that appeared after the start (`npm install`'s node_modules, a build or cache dir) is in no
  // ignoredDirs list: `status --ignored=matching` only lists folders that exist. Unpruned, a gitignored tree of 50k
  // files was scanned on every poll until a restart (0.3% -> 15% of a core). The list is refreshed when the poll
  // backend sees new folders, at most once per IGNORED_DIRS_REFRESH_MS.
  #refreshIgnoredDirsSoon(): void {
    if (this.#ignoredRefresh.kind === 'scheduled') return;
    const wait = Math.max(0, this.#ignoredRefresh.lastAt + IGNORED_DIRS_REFRESH_MS - this.#clock.now());
    const handle = this.#clock.setTimeout(() => guard(this.#log, 'daemon.ignoredDirs', async () => {
      this.#ignoredRefresh = { kind: 'idle', lastAt: this.#clock.now() };
      const ctx = this.#ctx;
      if (ctx === undefined || this.#watcher === undefined || this.#phase !== 'running') return;
      const dirs = await ignoredDirs(ctx);
      this.#watcher?.setIgnoredDirs(dirs);
      this.#log.debug('ignored dirs refreshed', { count: dirs.length, dirs: dirs.slice(0, 20) });
    }), wait);
    this.#ignoredRefresh = { kind: 'scheduled', handle, lastAt: this.#ignoredRefresh.lastAt };
  }

  async #restartWatcher(): Promise<void> {
    const old = this.#watcher;
    this.#watcher = undefined;
    await old?.close();
    await this.#startWatcher();
    // A degraded poll stops only once a recreated watcher stays error-free for its first 60 s.
    if (this.#degraded !== 'none') {
      this.#clock.setTimeout(() => {
        if (this.#watcherErrors === 'clean' && this.#degraded !== 'none') {
          this.#degraded.poll.stop();
          this.#degraded = 'none';
        }
      }, DEGRADED_RECOVERY_MS);
    }
    await this.#statusCheck({ kind: 'poll' });   // events during the restart gap are not lost
  }

  // The matcher is swapped in place, degraded or not: recreating the watcher on every reload kept every old
  // descriptor (macOS) and, while degraded, failed again on the same error each time.
  async #applyIgnore(ctx: RunContext): Promise<void> {
    if (this.#watcher === undefined) {
      await this.#restartWatcher();
      return;
    }
    this.#watcher.setIgnore(ctx.ignore);
    await this.#statusCheck({ kind: 'poll' });   // newly un-ignored files may be pending
  }

  #onWatcherError(): void {
    this.#watcherErrors = 'errored';
    if (this.#degraded !== 'none' || this.#phase === 'stopping') return;
    const pollMs = Math.min(this.#need().config.idleMs, 60_000);
    this.#log.warn('watcher degraded', { pollMs });
    const poll = new IntervalTimer({ ms: pollMs, clock: this.#clock,
      onFire: () => guard(this.#log, 'daemon.degradedPoll', () => this.#degradedPoll()) });
    poll.start();
    this.#degraded = { poll, lastAttemptAt: this.#clock.now() };
  }

  async #degradedPoll(): Promise<void> {
    const d = this.#degraded;
    if (d === 'none' || this.#phase !== 'running' || this.#runState !== 'idle') return;
    if (this.#clock.now() - d.lastAttemptAt >= DEGRADED_RETRY_MS) {
      d.lastAttemptAt = this.#clock.now();
      this.#watcherErrors = 'clean';
      await this.#restartWatcher();   // includes a status check
      return;
    }
    await this.#statusCheck({ kind: 'poll' });
  }

  async #onBatch(rels: string[]): Promise<void> {
    if (this.#phase !== 'running') return;
    if (this.#runState === 'running') {
      this.#buffered.push(...rels);
      return;
    }
    await this.#processBatch(rels);
  }

  // One batch at a time: batches that arrive while `git status` runs are merged into a single follow-up.
  async #processBatch(rels: string[]): Promise<void> {
    if (this.#batching.kind === 'busy') {
      for (const r of rels) this.#batching.next.add(r);
      return;
    }
    this.#batching = { kind: 'busy', next: new Set() };
    try {
      let todo = rels;
      for (;;) {
        await this.#processBatchNow(todo);
        const next: Set<string> = this.#batching.kind === 'busy' ? this.#batching.next : new Set();
        if (next.size === 0) break;
        todo = [...next];
        this.#batching = { kind: 'busy', next: new Set() };
      }
    } finally {
      this.#batching = { kind: 'idle' };
    }
  }

  async #processBatchNow(rels: string[]): Promise<void> {
    const ctx = this.#ctx;
    const timers = this.#timers;
    if (ctx === undefined || timers === undefined || this.#phase !== 'running') return;
    if (rels.some(isGitignore)) this.#watcher?.setIgnoredDirs(await ignoredDirs(ctx));
    const entries = await pendingChanges(ctx, rels);   // drops gitignored files, our own git writes and no-op saves
    if (entries.length === 0 || this.#phase !== 'running') return;
    // autoCommit off: a change is only noted; flush or sync-once commits it
    if (this.#autoCommit() === 'off') {
      this.#log.debug('local change', { paths: rels.length, dirty: entries.length });
      return;
    }
    const before = timers.status();
    timers.noteChange();
    this.#log.debug('local change', { paths: rels.length, dirty: entries.length });
    if (before === 'disarmed') this.#logArmed('change');
  }

  async #drainBuffered(): Promise<void> {
    if (this.#buffered.length === 0) return;
    const rels = [...new Set(this.#buffered)];
    this.#buffered = [];
    await this.#processBatch(rels);
  }

  // The post-run status check. Two deliberate refinements keep a commit run that can't commit from re-firing
  // an overdue max-wait in a loop: a run that never reached S2 leaves arming to its scheduled retry (which carries
  // the commit), and what a scope-`all` run with nothing staged leaves behind can't be staged (case collisions), so
  // it disarms; new writes re-arm through the watcher.
  async #statusCheck(after: RunEnd): Promise<void> {
    const ctx = this.#ctx;
    const timers = this.#timers;
    if (this.#phase !== 'running' || ctx === undefined || timers === undefined) return;
    // autoCommit off: nothing arms the backup timers (a reload to 'off' cleared any that were armed)
    if (this.#autoCommit() === 'off') return;
    const entries = await pendingChanges(ctx);
    if (this.#autoCommit() === 'off') return;   // a reload during the status read
    let next: 'clean' | 'dirty-after-full-commit' | 'dirty' | 'leave' = 'dirty';
    if (entries.length === 0) {
      next = 'clean';
    } else if (after.kind === 'run' && after.req.kind === 'commit') {
      const step = after.res.commitStep;
      if (step === 'not-reached') next = 'leave';
      else if (after.req.commit.scope.kind === 'all') next = step === 'committed' ? 'dirty-after-full-commit' : 'clean';
    }
    if (next === 'leave') return;
    const before = timers.status();
    timers.afterRun(next);
    if (next !== 'clean' && timers.status() === 'armed' && (before === 'disarmed' || next === 'dirty-after-full-commit')) {
      this.#logArmed('post-run');
    }
  }

  #logArmed(reason: 'change' | 'post-run'): void {
    const c = this.#need().config;
    this.#log.debug('backup timers armed', { reason, idleMs: c.idleMs, maxWaitMs: c.maxWaitMs });
  }

  // Committed .gitignore changes (pulled or committed) can change which dirs the watcher should skip.
  async #refreshIgnoredDirsIfChanged(): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === undefined || this.#watcher === undefined) return;
    const r = await ctx.git.run(['ls-files', '-s', '-z', '--', ':(glob)**/.gitignore']);
    if (r.code !== 0) return;
    const print = r.stdout;
    if (this.#gitignorePrint !== 'unknown' && print !== this.#gitignorePrint) {
      this.#watcher.setIgnoredDirs(await ignoredDirs(ctx));
    }
    this.#gitignorePrint = print;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Config reload

  #onHangup(): Promise<void> | void {
    if (this.#phase === 'stopping' || this.#stop !== 'none') return;
    if (this.#phase === 'starting') {
      this.#reload = 'pending';
      return;
    }
    return this.#applySighup();
  }

  async #applySighup(): Promise<void> {
    if (this.#phase !== 'running') return;
    const path = this.#layers.instancePath;
    let instance = {};
    if (path !== 'none') {
      const r = loadInstanceFile(path);
      if (r.kind !== 'ok') {
        const issues = r.kind === 'missing' ? [`config file not found: ${path}`] : r.issues.map(formatIssue);
        this.#log.error('config reload failed', { trigger: 'sighup', issues });
        return;
      }
      instance = r.value;
    }
    this.#layers = { ...this.#layers, instance };
    await this.#changeConfig(resolveConfig({ ...this.#layers, repo: this.#repoLayer }, this.#host).config, 'sighup');
  }

  async #reloadRepoConfig(): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === undefined) return;
    const blob = await readRepoConfigBlob(ctx.git);
    if (blob === this.#repoBlob) return;
    this.#repoBlob = blob;
    const repo = await loadRepoConfig(ctx.git, blob, this.#log, ctx.repoRules === 'known' ? this.#repoLayer : undefined);
    if (repo.state === 'last-good' || repo.state === 'unknown') return;
    this.#rememberRepoLayer(repo);
    // a valid (or removed) file: its rules are known again, commit runs may stage
    if (ctx.repoRules === 'unknown') this.#ctx = { ...ctx, repoRules: 'known' };
    this.#repoLayer = repo.layer;
    await this.#changeConfig(resolveConfig({ ...this.#layers, repo: repo.layer }, this.#host).config, 'repo-config');
  }

  // dir, remote and branch need a restart; everything else applies while running and between runs.
  async #changeConfig(next: ResolvedConfig, trigger: 'sighup' | 'repo-config'): Promise<void> {
    const cur = this.#need().config;
    const restart = changedKeys(cur, next).filter((k) => RESTART_KEYS.has(k));
    if (restart.length > 0) this.#log.warn('config change requires restart', { keys: restart });
    const merged: ReadyConfig = { ...next, dir: cur.dir, branch: cur.branch };
    if (cur.remote !== undefined) merged.remote = cur.remote;
    else delete merged.remote;
    this.#pendingConfig = { config: merged, trigger };
    if (this.#runState === 'running') return;   // applied in onRunEnd
    await this.#applyPendingConfig();
  }

  #applyPendingConfig(): Promise<void> {
    this.#applying = this.#applying.then(() => this.#applyPendingConfigNow())
      .catch((e: unknown) => this.#log.error('callback failed', { source: 'daemon.applyConfig', error: e }));
    return this.#applying;
  }

  async #applyPendingConfigNow(): Promise<void> {
    const pending = this.#pendingConfig;
    if (pending === 'none' || this.#phase !== 'running') return;
    this.#pendingConfig = 'none';
    const cur = this.#need();
    const next = pending.config;
    const changed = changedKeys(cur.config, next);
    const has = (k: keyof ResolvedConfig): boolean => changed.includes(k);

    let ctx = cur.ctx;
    if (has('ignore') || has('authorName') || has('authorEmail') || has('sshKey')) {
      ctx = await createRunContext({ config: next, realDir: this.#realDir, paths: this.#paths, log: this.#log,
        clock: this.#clock, repoRules: cur.ctx.repoRules });
    }
    this.#config = next;
    this.#ctx = ctx;
    if (has('idleMs') || has('maxWaitMs')) this.#timers?.setDurations(next.idleMs, next.maxWaitMs);
    // 'off' cancels armed backup timers; back to 'timers', a status check arms them for changes already pending
    if (has('autoCommit') && next.autoCommit === 'off') this.#timers?.clear();
    if (has('fallbackMs')) this.#fallback?.setMs(next.fallbackMs);
    if (has('ntfyUrl')) {
      const old = this.#ntfy;
      this.#ntfy = undefined;
      await old?.stop();
      this.#startNtfy();
    }
    if (has('ignore')) await this.#applyIgnore(ctx);
    else if (has('autoCommit') && next.autoCommit === 'timers') await this.#statusCheck({ kind: 'poll' });
    this.#log.info('config reloaded', { trigger: pending.trigger, changed });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Shutdown

  #onStopSignal(sig: StopSignal): Promise<void> | void {
    if (this.#stop !== 'none') return this.#forcedExit(sig);
    this.#log.info('shutdown requested', { signal: sig });
    return this.#beginStop();
  }

  #beginStop(): Promise<void> | void {
    this.#stop = 'requested';
    this.#bootWait.abort();
    setNetworkDeadline(Date.now() + SHUTDOWN_BUDGET_MS);
    this.#runMode = 'shutdown';
    // While starting, startup continues to step 9 and shuts down from there.
    if (this.#phase === 'running') return this.#shutdownSequence();
  }

  async #shutdownSequence(): Promise<void> {
    if (this.#phase === 'stopping') return;
    this.#phase = 'stopping';
    await this.#stopServices();
    this.#queue.setHooks({ onRunStart: () => this.#ipc?.stopAccepting() });
    this.#queue.release();
    if (this.#queue.activity() === 'idle') this.#ipc?.stopAccepting();
    await this.#queue.whenIdle();
    this.#ipc?.stopAccepting();
    await this.#queue.whenIdle();

    const ctx = this.#ctx;
    if (ctx !== undefined && this.#stop !== 'forced') {
      try {
        const [changes, ahead, head] = await Promise.all([pendingChanges(ctx), aheadCount(ctx), headSha(ctx.git)]);
        const dirty = changes.length > 0;
        const born = head !== 'unborn';
        const unpushed = (typeof ahead === 'number' && ahead > 0) || (ahead === 'no-remote-branch' && born);
        if (this.#autoCommit() === 'off') {
          // Only flush and sync-once commit: pending edits stay in the worktree, and the shutdown-mode pull-only run
          // (preflight and one push attempt, no fetch) pushes commits that are already made.
          if (dirty) this.#log.info('changes left uncommitted', { changes: changes.length, reason: 'auto-commit-off' });
          if (unpushed) {
            this.#queue.request({ kind: 'pull-only', reason: 'shutdown' });
            await this.#queue.whenIdle();
          }
        } else if (dirty || unpushed) {
          this.#queue.request({ kind: 'commit', source: 'shutdown' });
          await this.#queue.whenIdle();
        }
      } catch (e) {
        this.#log.error('callback failed', { source: 'daemon.shutdown', error: e });
      }
      // Replaced inodes still waiting (no shutdown-mode run came, or a run before the signal moved the worktree):
      // settled here with the queue idle, at most SETTLE_GRACE_MS. A second signal skips the wait; the next start's P4
      // settles them.
      try {
        await settlePending(ctx, 'all', { signal: this.#settleWait.signal });   // a forced exit aborts the wait
      } catch (e) {
        this.#log.error('callback failed', { source: 'daemon.settle', error: e });
      }
    }
    if (this.#stop === 'forced') return;

    this.#ipc?.closeAll();
    delete this.#state.nextRetryAt;
    this.#state = { ...this.#state, pid: process.pid, updatedAt: new Date().toISOString() };
    this.#writeState();
    this.#ipc?.stopAccepting();
    this.#lock.release();
    this.#log.info('shutdown complete', { exitCode: this.#exitCode });
    this.#resolveExit(this.#exitCode);
  }

  async #stopServices(): Promise<void> {
    this.#clearRetry();
    this.#clearSettle();
    if (this.#ignoredRefresh.kind === 'scheduled') this.#clock.clearTimeout(this.#ignoredRefresh.handle);
    this.#ignoredRefresh = { kind: 'idle', lastAt: this.#ignoredRefresh.lastAt };
    this.#timers?.clear();
    this.#fallback?.stop();
    this.#wake?.stop();
    this.#network?.stop();
    this.#folderCheck?.stop();
    if (this.#degraded !== 'none') this.#degraded.poll.stop();
    this.#degraded = 'none';
    const watcher = this.#watcher;
    const ntfy = this.#ntfy;
    this.#watcher = undefined;
    this.#ntfy = undefined;
    await Promise.allSettled([watcher?.close(), ntfy?.stop()]);
  }

  async #forcedExit(sig: StopSignal | 'fatal'): Promise<void> {
    if (this.#stop === 'forced') return;
    this.#stop = 'forced';
    this.#settleWait.abort();
    if (sig !== 'fatal') this.#log.warn('forced exit', { signal: sig });
    this.#ipc?.stopAccepting();
    await killChildrenGracefully();
    this.#ipc?.closeAll();
    this.#ipc?.stopAccepting();
    this.#lock.release();
    this.#resolveExit(1);
  }

  #fatal(e: unknown): void {
    this.#log.error('fatal', { error: e });
    void this.#forcedExit('fatal');
  }

  #resolveExit(code: number): void {
    if (this.#exit.state === 'resolved') return;
    this.#exit.state = 'resolved';
    if (this.#liveness !== 'none') this.#liveness.stop();
    this.#exit.resolve(code);
  }

  // ------------------------------------------------------------------------------------------------------------

  #autoCommit(): AutoCommit {
    return this.#config?.autoCommit ?? 'timers';
  }

  #need(): { config: ReadyConfig; ctx: RunContext } {
    if (this.#config === undefined || this.#ctx === undefined) throw new Error('daemon used before its context was built');
    return { config: this.#config, ctx: this.#ctx };
  }

  #rememberRepoLayer(repo: LoadedRepoConfig): void {
    rememberRepoConfig(this.#state, repo);
    this.#writeState();
  }

  #writeState(): void {
    try {
      writeState(this.#paths, this.#state);
    } catch (e) {
      this.#log.error('callback failed', { source: 'daemon.writeState', error: e });
    }
  }
}
