// Config errors refuse to start with exit 2 and name the key.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { statePathsFor } from '../../src/paths';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, runCli, setupTestEnv, startDaemon, writeJson, type CliResult,
  type Clone, type Remote, type TestEnv,
} from '../harness';

afterEach(cleanupAll);

// A `run` that wrongly starts would block; this bounds it.
const RUN_TIMEOUT_MS = 30_000;

async function scene(name: string): Promise<{ t: TestEnv; r: Remote; a: Clone; cfg: string }> {
  const t = await setupTestEnv(name);
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const cfg = join(t.configHome, 'mdsync', 'notes.json');
  return { t, r, a, cfg };
}

// Nothing started: no daemon log lines, no lock, the repo untouched.
async function expectRefused(res: CliResult, s: { t: TestEnv; r: Remote; a: Clone }, layer: 'cli' | 'instance', key: string): Promise<void> {
  expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 2, stderr: res.stderr });
  expect(res.stderr).toContain(`invalid config key "${key}"`);
  const invalid = res.logs.find(is('config invalid'));
  expect(invalid).toMatchObject({ layer });
  expect((invalid?.issues as string[]).some((i) => i.includes(key))).toBe(true);
  expect(res.logs.filter((l) => ['daemon starting', 'daemon ready', 'sync start', 'cloning'].includes(l.msg))).toEqual([]);
  expect(existsSync(statePathsFor(s.a.dir, s.t.env).lock)).toBe(false);
  await expectNoMdsyncArtifacts(s.t, [s.a], s.r, (p) => p === 'README.md');
}

test('an unknown instance key refuses to start and names the key', async () => {
  const s = await scene('config-unknown-key');
  writeJson(s.cfg, { remote: s.r.url, dir: s.a.dir, idelMs: 5000 });
  const res = await runCli(s.t, ['run', '--config', s.cfg], { timeoutMs: RUN_TIMEOUT_MS });
  expect(res.stderr).toContain('unknown key');
  expect(res.stderr).toContain(s.cfg);
  await expectRefused(res, s, 'instance', 'idelMs');
}, 60_000);

test('an invalid instance value refuses to start and names the key', async () => {
  const s = await scene('config-bad-value');
  writeJson(s.cfg, { remote: s.r.url, dir: s.a.dir, idleMs: 'soon' });
  const res = await runCli(s.t, ['run', '--config', s.cfg], { timeoutMs: RUN_TIMEOUT_MS });
  await expectRefused(res, s, 'instance', 'idleMs');
}, 60_000);

for (const value of ['abc', '999', '2147483648']) {
  test(`--idle-ms ${value} is rejected with exit 2`, async () => {
    const s = await scene(`config-idle-ms-${value}`);
    writeJson(s.cfg, { remote: s.r.url, dir: s.a.dir });
    const res = await runCli(s.t, ['run', '--config', s.cfg, '--idle-ms', value], { timeoutMs: RUN_TIMEOUT_MS });
    expect(res.stderr).toContain('--idle-ms');
    await expectRefused(res, s, 'cli', 'idleMs');
  }, 60_000);
}

test('--fallback-ms 2592000000 (30 days, above the timer limit) is rejected with exit 2', async () => {
  const s = await scene('config-fallback-ms');
  writeJson(s.cfg, { remote: s.r.url, dir: s.a.dir });
  const res = await runCli(s.t, ['run', '--config', s.cfg, '--fallback-ms', '2592000000'], { timeoutMs: RUN_TIMEOUT_MS });
  expect(res.stderr).toContain('--fallback-ms');
  await expectRefused(res, s, 'cli', 'fallbackMs');
}, 60_000);

test('a typo saved into a running daemon\'s config file: flush still reaches it, status still reports, a one-off refuses', async () => {
  // The daemon keeps its last good config; flush, status and uninstall-service used to exit 2 on the file instead
  // (and a Claude Code Stop hook treats exit 2 as "block the agent").
  const s = await scene('config-typo-while-running');
  const A = await startDaemon(s.t, { name: 'A', dir: s.a.dir, remote: s.r });
  const good = JSON.parse(await Bun.file(A.configPath).text()) as Record<string, unknown>;
  writeJson(A.configPath, { ...good, idleMs: '5 min' });

  await s.a.write('hooked.md', 'from the agent\n');
  const m = A.mark();
  const f = await runCli(s.t, ['flush', '--dir', s.a.dir, '--wait']);
  expect({ code: f.code, stderr: f.stderr.trim() }).toEqual({ code: 0, stderr: '' });
  expect(A.logs.slice(m).some(is('flush received'))).toBe(true);
  expect(await s.r.show('hooked.md')).toBe('from the agent\n');
  const quiet = await runCli(s.t, ['flush', '--dir', s.a.dir], { env: { MDSYNC_LOG_LEVEL: 'verbose' } });
  expect(quiet.code).toBe(0);
  expect(quiet.stderr).toContain('ignoring invalid MDSYNC_LOG_LEVEL');

  const st = await runCli(s.t, ['status', '--dir', s.a.dir]);
  expect(st.code).toBe(0);
  expect(st.stdout).toMatch(/^daemon:\s+running/m);
  expect(st.stderr).toContain('ignoring invalid config file');
  expect(st.stderr).toContain('idleMs');

  // with no daemon, a one-off would need that config: not delivered, exit 1, and it says why
  expect(await A.stop()).toBe(0);
  await s.a.write('later.md', 'later\n');
  const off = await runCli(s.t, ['flush', '--dir', s.a.dir]);
  expect(off.code).toBe(1);
  expect(off.stderr).toContain('invalid config key "idleMs"');
  expect(off.logs.some(is('one-off run'))).toBe(false);
  expect(await s.r.show('later.md')).toBeUndefined();
}, 120_000);
