// Acceptance 12: runs on macOS, Linux and in the example container. The CI matrix runs the whole
// suite on ubuntu + macos and test/container-smoke.sh covers the container; this file asserts the platform-specific
// pieces on the current OS.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendFlush, startIpcServer, type FlushRequest } from '../../src/ipc';
import { liveGitIn, pidVisibility } from '../../src/live-git';
import { currentBootId, ownerLiveness, processStartMs, processStartTicks, type LockOwner } from '../../src/lock';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import {
  execArgv, launchdLabel, renderLaunchdPlist, renderSystemdUnit, serviceArgv, serviceEnv, serviceKindFor,
} from '../../src/service';
import { spawnTracked } from '../../src/spawn';
import { cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, holdLiveGit, psStartMs, setupTestEnv } from '../harness';

afterEach(cleanupAll);

const userPaths = (p: string): boolean => p === 'README.md';
const dec = new TextDecoder();

describe(`platform pieces on ${process.platform}`, () => {
  test('liveGitIn finds a holdLiveGit pid with its cwd inside the repo', async () => {
    const t = await setupTestEnv('platform-live-git');
    const r = await createRemote(t);
    const a = await cloneRemote(t, r, 'A');
    const other = await cloneRemote(t, r, 'B');
    const holder = await holdLiveGit(a.dir);

    const scan = await liveGitIn(a.dir);
    expect(scan.kind).toBe('scanned');
    expect(scan.kind === 'scanned' ? scan.pids : []).toContain(holder.pid);
    expect(await liveGitIn(other.dir)).toEqual({ kind: 'scanned', pids: [], visibility: pidVisibility() });
    expect(await liveGitIn(a.dir, { exclude: new Set([holder.pid]) })).toEqual({ kind: 'scanned', pids: [], visibility: pidVisibility() });

    await holder.release();
    await expectNoMdsyncArtifacts(t, [a, other], r, userPaths);
  });

  test('the per-folder socket path in the state dir works', async () => {
    const t = await setupTestEnv('platform-socket');
    const r = await createRemote(t);
    const a = await cloneRemote(t, r, 'A');
    const paths = statePathsFor(a.dir, t.env);
    ensureStateDir(paths);
    const log = createLogger({ level: 'debug', sink: 'stdout', write: () => {} });
    const req: FlushRequest = { type: 'flush', v: 1, message: 'm', paths: ['a.md'], wait: 'wait' };

    const server = startIpcServer({
      sockPath: paths.sock, log,
      onFlush: (got, reply, end) => {
        reply({ type: 'queued' });
        reply({ type: 'result', outcome: 'ok', head: 'h', commitsOut: got.paths?.length ?? 0 });
        end();
      },
    });
    try {
      expect(existsSync(paths.sock)).toBe(true);
      expect(await sendFlush(paths.sock, req, { queuedTimeoutMs: 10_000 })).toEqual({
        kind: 'replies', replies: [{ type: 'queued' }, { type: 'result', outcome: 'ok', head: 'h', commitsOut: 1 }],
      });
    } finally {
      server.stopAccepting();
      server.closeAll();
    }
    expect(existsSync(paths.sock)).toBe(false);
    expect(await sendFlush(paths.sock, req, { queuedTimeoutMs: 10_000 })).toEqual({ kind: 'no-daemon' });
    await expectNoMdsyncArtifacts(t, [a], r, userPaths);
  });

  test('service renders the unit kind for this OS', async () => {
    const t = await setupTestEnv('platform-service');
    const r = await createRemote(t);
    const a = await cloneRemote(t, r, 'A');
    const kind = serviceKindFor(process.platform);
    expect(kind).toBe(process.platform === 'darwin' ? 'launchd' : 'systemd');

    const paths = statePathsFor(a.dir, t.env);
    const argv = serviceArgv(execArgv(), join(t.configHome, 'mdsync', 'A.json'), { dir: a.dir }, 'unset');
    expect(argv).toContain('run');
    const env = serviceEnv({ ...t.env, GIT_TOKEN: 'never-in-a-unit' });
    expect(Object.keys(env)).not.toContain('GIT_TOKEN');
    expect(Object.values(env)).not.toContain('never-in-a-unit');
    expect(env.XDG_STATE_HOME).toBe(t.stateHome);

    if (kind === 'launchd') {
      const plist = renderLaunchdPlist({ label: launchdLabel(paths.hash), argv, env, logPath: paths.log });
      expect(plist).toContain(`<string>dev.mdsync.${paths.hash}</string>`);
      expect(plist).not.toContain('never-in-a-unit');
      const file = join(t.root, 'unit.plist');
      writeFileSync(file, plist);
      const lint = await spawnTracked(['plutil', '-lint', file], { cwd: t.root, env: t.env, timeoutMs: 30_000 });
      expect({ code: lint.code, out: dec.decode(lint.stdout).trim() }).toEqual({ code: 0, out: `${file}: OK` });
    } else {
      const unit = renderSystemdUnit({ realDir: a.dir, argv, env });
      expect(unit).toContain('[Service]');
      expect(unit).toContain('KillMode=mixed');
      expect(unit).toMatch(/^ExecStart="/m);
      expect(unit).not.toContain('never-in-a-unit');
    }
    await expectNoMdsyncArtifacts(t, [a], r, userPaths);
  });

  // No repo involved, so no expectNoMdsyncArtifacts here.
  test('currentBootId() and processStartMs() are known, and ownerLiveness uses both', () => {
    const boot = currentBootId();
    expect(boot).not.toBe('unknown');
    const start = processStartMs(process.pid);
    expect(typeof start).toBe('number');
    const expected = psStartMs(process.pid);   // not Date.now() - uptime: uptime stops while a Mac sleeps
    expect(typeof expected).toBe('number');
    expect(Math.abs(Number(start) - Number(expected))).toBeLessThan(3_000);

    // The test runner's parent: alive, not us.
    const ppid = process.ppid;
    const parentStart = processStartMs(ppid);
    expect(typeof parentStart).toBe('number');
    const ticks = processStartTicks(ppid);
    expect(typeof ticks).toBe(process.platform === 'linux' ? 'number' : 'string');
    const owner: LockOwner = {
      pid: ppid, startedAt: new Date().toISOString(), dir: '/nowhere', purpose: 'daemon', bootId: boot, procStart: parentStart,
      procStartTicks: ticks,
    };
    expect(ownerLiveness(owner)).toBe('alive');
    expect(ownerLiveness({ ...owner, bootId: '00000000-0000-0000-0000-000000000000' })).toBe('stale-boot-id');
    expect(ownerLiveness({ ...owner, procStart: Number(parentStart) - 3_600_000,
      procStartTicks: ticks === 'unknown' ? 'unknown' : ticks + 360_000 })).toBe('stale-pid-reused');
  });
});
