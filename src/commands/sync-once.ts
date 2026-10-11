// `sync-once` and the one-off runner it shares with `flush` when no daemon is running.
import { mkdirSync, rmSync } from 'node:fs';
import { ensureRepo } from '../bootstrap';
import { resolveConfig } from '../config';
import { loadEffectiveConfig } from '../context';
import { createGitClient, type GitClient, requireGitVersion, setNetworkDeadline } from '../git';
import { shortHostname } from '../host';
import { errorText, type Logger } from '../log';
import type { LockHandle } from '../lock';
import { canonicalDir, ensureStateDir, type StatePaths, statePathsFor } from '../paths';
import { settlePending } from '../move';
import { killChildrenGracefully } from '../spawn';
import { rememberRepoConfig, writeState } from '../state';
import { syncRun } from '../sync';
import type { RunRequest } from '../types';
import {
  acquireOneOffLock, type CommandEnv, type DirectLayers, isOkOutcome, loadStartupLayers, loadStateOrFresh, otherStatePaths,
  recordRun, requireRunKeys, stderrLine,
} from './shared';

export const SYNC_ONCE_REQUEST: RunRequest = {
  kind: 'commit',
  commit: { scope: { kind: 'all' }, messages: [], tag: 'none', sources: ['sync-once'] },
  reasons: ['sync-once'],
};

type StopSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';

// First signal: finish the current git op, skip the remaining network steps (the network deadline is set to now, so
// no further fetch or push is spawned), write state, release the lock. Second signal: kill children, release, exit 1.
function installOneOffSignals(log: Logger, lock: LockHandle, settleWait: AbortController): () => void {
  let received: 'none' | 'once' = 'none';
  const handler = (sig: StopSignal): void => {
    if (received === 'none') {
      received = 'once';
      log.info('shutdown requested', { signal: sig });
      setNetworkDeadline(Date.now());
      settleWait.abort();   // the next run's P4 settles what is left
      return;
    }
    log.warn('forced exit', { signal: sig });
    void killChildrenGracefully().finally(() => {
      lock.release();
      process.exit(1);
    });
  };
  const sigs: StopSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const bound = sigs.map((s) => [s, () => handler(s)] as const);
  for (const [s, fn] of bound) process.on(s, fn);
  return () => { for (const [s, fn] of bound) process.off(s, fn); };
}

// Steps 1–5 of the one-off run. The caller has acquired the lock; it is released here.
export async function runOneOff(o: { source: 'flush' | 'sync-once'; lock: LockHandle; layers: DirectLayers;
  realDir: string; paths: StatePaths; log: Logger; req: RunRequest }): Promise<number> {
  const { log, realDir, paths, lock } = o;
  process.on('exit', () => lock.release());
  const settleWait = new AbortController();
  const removeSignals = installOneOffSignals(log, lock, settleWait);
  try {
    log.info('one-off run', { source: o.source, dir: realDir });
    rmSync(paths.stateTmp, { force: true });
    rmSync(paths.tmp, { recursive: true, force: true });
    mkdirSync(paths.tmp, { recursive: true, mode: 0o700 });

    const provisional = resolveConfig({ ...o.layers, repo: {} }, shortHostname()).config;
    const git: GitClient = createGitClient({ cwd: realDir,
      sshKey: provisional.sshKey, identity: { name: provisional.authorName, email: provisional.authorEmail }, log });
    await requireGitVersion(git);   // merge-tree --merge-base and --attr-source
    const boot = await ensureRepo({ realDir, config: provisional, log, git },
      o.source === 'flush' ? 'existing-only' : 'may-clone');
    if (boot.kind === 'failed') {
      stderrLine(boot.error);
      return 1;
    }

    const before = loadStateOrFresh(paths, realDir);
    const lastGood = before.repoConfig;
    const eff = await loadEffectiveConfig({ layers: o.layers, realDir, paths, log,
      ...(lastGood !== undefined ? { lastGoodRepo: lastGood.layer } : {}) });
    const res = await syncRun(eff.ctx, o.req, 1,
      { mode: 'normal', stuck: 'none', keptStashes: before.keptStashes.map((k) => k.sha), integrated: before.integrated ?? 'none',
        cloned: boot.cloned === 'cloned' ? 'fresh-clone' : 'none' });
    // no daemon fires a settle timer: wait out the grace of the inodes this run's move replaced (at most
    // SETTLE_GRACE_MS), so no temp folder is left behind. A signal skips the wait.
    await settlePending(eff.ctx, 'all', { signal: settleWait.signal }).catch((e: unknown) => {
      log.error('callback failed', { source: 'one-off.settle', error: e });
    });

    const { state } = await recordRun({ state: loadStateOrFresh(paths, realDir), res, stuck: 'none', git: eff.ctx.git });
    delete state.nextRetryAt;   // no daemon holds the folder, so a recorded retry time is stale
    rememberRepoConfig(state, eff.repo);
    writeState(paths, state);

    if (isOkOutcome(res.outcome)) return 0;
    stderrLine(`${o.source} failed: ${res.outcome}${res.error !== undefined ? `: ${res.error}` : ''}`);
    return 1;
  } catch (e) {
    log.error('fatal', { error: e });
    stderrLine(errorText(e));
    return 1;
  } finally {
    removeSignals();
    lock.release();
  }
}

export async function syncOnceCommand(c: CommandEnv): Promise<number> {
  const loaded = await loadStartupLayers(c);
  if (loaded.kind === 'exit') return loaded.code;
  const ready = requireRunKeys(c.log, loaded.layers, c.env);
  if (ready.kind === 'exit') return ready.code;

  mkdirSync(ready.config.dir, { recursive: true });
  const realDir = canonicalDir(ready.config.dir);
  const paths = statePathsFor(realDir, c.env);
  ensureStateDir(paths);
  const got = acquireOneOffLock(paths, realDir, otherStatePaths(realDir, c.env), c.log);
  if (got.kind === 'busy') {
    c.log.error('lock busy', { pid: got.owner.pid, dir: realDir, purpose: got.owner.purpose });
    stderrLine(`another mdsync (pid ${got.owner.pid}) is already syncing ${realDir}`);
    return 1;
  }
  return runOneOff({ source: 'sync-once', lock: got.handle, layers: loaded.layers, realDir, paths, log: c.log,
    req: SYNC_ONCE_REQUEST });
}
