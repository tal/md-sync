// The compiled binary from `bun build --compile` passes an end-to-end smoke test, run in CI on Linux and macOS.
// Runs only with MDSYNC_BIN set (the harness then spawns that binary everywhere).
// On macOS the binary must be ad-hoc signed first (`codesign --force --sign -`).
import { afterEach, describe, expect, test } from 'bun:test';
import pkg from '../package.json' with { type: 'json' };
import {
  is, cleanupAll, cmd, createRemote, emptyDir, expectNoMdsyncArtifacts, fakeNtfy, openClone, remoteNotifier, runCli,
  setupTestEnv, startDaemon,
} from './harness';

afterEach(cleanupAll);

const BIN = process.env.MDSYNC_BIN ?? '';

describe.skipIf(BIN === '')('compiled binary smoke test', () => {
  test('version, workflow, two daemons syncing over ntfy, status, clean SIGTERM', async () => {
    expect(cmd()).toEqual([BIN]);
    const t = await setupTestEnv('smoke');

    const [version, workflow] = await Promise.all([runCli(t, ['--version']), runCli(t, ['print-workflow', '--branch', 'main'])]);
    expect({ code: version.code, out: version.stdout.trim() }).toEqual({ code: 0, out: `md-sync ${pkg.version}` });
    expect(workflow.code).toBe(0);
    expect(workflow.stdout).toContain('mdsync-notify');

    const r = await createRemote(t);
    const n = await fakeNtfy();
    remoteNotifier(r, n);
    const [A, B] = await Promise.all([
      startDaemon(t, { name: 'A', dir: emptyDir(t, 'A'), remote: r, ntfy: n }),
      startDaemon(t, { name: 'B', dir: emptyDir(t, 'B'), remote: r, ntfy: n }),
    ]);
    const a = openClone(t, A.dir);
    const b = openClone(t, B.dir);

    const m = B.mark();
    await a.write('smoke.md', 'hello from the binary\n');
    const f = await A.flush(['--wait']);
    expect({ code: f.code, stderr: f.stderr }).toEqual({ code: 0, stderr: f.stderr });
    await B.waitForLog(is('ntfy event'), { since: m });
    await B.waitForSync({ since: m, reason: 'ntfy' });
    expect(await b.read('smoke.md')).toBe('hello from the binary\n');

    const status = await runCli(t, ['status', '--dir', A.dir, '--format', 'json']);
    expect(status.code).toBe(0);
    const parsed = JSON.parse(status.stdout) as { dir: string; daemon: { state: string; pid?: number } };
    expect(parsed.dir).toBe(A.dir);
    expect(parsed.daemon).toEqual({ state: 'running', pid: A.proc.pid });

    expect(await Promise.all([A.stop(), B.stop()])).toEqual([0, 0]);
    for (const d of [A, B]) expect(d.logs.some(is('shutdown complete', { exitCode: 0 }))).toBe(true);
    await expectNoMdsyncArtifacts(t, [a, b], r, (p) => ['README.md', 'smoke.md'].includes(p));
  }, 120_000);
});
