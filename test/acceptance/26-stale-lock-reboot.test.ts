// A lock left by a previous boot, or by a pid that was since reused, is stale.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { currentBootId, processStartMs, processStartTicks, type Liveness, type LockOwner } from '../../src/lock';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, runCli, setupTestEnv, startDaemon,
} from '../harness';

afterEach(cleanupAll);

const OTHER_BOOT = '00000000-0000-4000-8000-000000000000';

// The lock names the test runner's parent: a live process that is not mdsync and not the daemon about to start.
async function staleLockScene(name: string, reason: Extract<Liveness, 'stale-boot-id' | 'stale-pid-reused'>) {
  const t = await setupTestEnv(name);
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const ppid = process.ppid;
  const parentStart = processStartMs(ppid);
  if (parentStart === 'unknown') throw new Error(`processStartMs(${ppid}) is unknown on ${process.platform}`);
  const ticks = processStartTicks(ppid);   // linux only
  const owner: LockOwner = {
    pid: ppid, startedAt: new Date(parentStart).toISOString(), dir: a.dir, purpose: 'daemon',
    ...(reason === 'stale-boot-id'
      ? { bootId: OTHER_BOOT, procStart: parentStart, procStartTicks: ticks }   // a reboot since the lock was written
      : { bootId: currentBootId(), procStart: parentStart - 3_600_000,          // same boot, but the pid was reused
        procStartTicks: ticks === 'unknown' ? 'unknown' : ticks + 360_000 }),
  };
  const paths = statePathsFor(a.dir, t.env);
  ensureStateDir(paths);
  writeFileSync(paths.lock, JSON.stringify(owner));
  return { t, r, a, ppid, paths };
}

for (const reason of ['stale-boot-id', 'stale-pid-reused'] as const) {
  test(`a lock naming a live unrelated pid (${reason}): status says stale, and the daemon takes it over`, async () => {
    const { t, r, a, ppid, paths } = await staleLockScene(`stale-lock-${reason}`, reason);

    const text = await runCli(t, ['status', '--dir', a.dir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(new RegExp(`^daemon:\\s+not running \\(stale lock, pid ${ppid}\\)\\s*$`, 'm'));
    const asJson = await runCli(t, ['status', '--dir', a.dir, '--format', 'json']);
    expect(asJson.code).toBe(0);
    expect((JSON.parse(asJson.stdout) as { daemon: unknown }).daemon).toEqual({ state: 'stale-lock', pid: ppid });

    const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
    expect(A.logs.find(is('stale lock removed'))).toMatchObject({ pid: ppid, reason, path: paths.lock });
    expect(A.logs.some(is('lock busy'))).toBe(false);
    const owner = JSON.parse(readFileSync(paths.lock, 'utf8')) as LockOwner;
    expect(owner).toMatchObject({ pid: A.proc.pid, purpose: 'daemon', dir: a.dir });
    process.kill(ppid, 0);   // throws if the unrelated owner was harmed

    const running = await runCli(t, ['status', '--dir', a.dir]);
    expect(running.stdout).toMatch(new RegExp(`^daemon:\\s+running \\(pid ${A.proc.pid}\\)\\s*$`, 'm'));
    await expectNoMdsyncArtifacts(t, [a], r, (p) => p === 'README.md');
  }, 90_000);
}
