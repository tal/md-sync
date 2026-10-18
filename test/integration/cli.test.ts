// CLI parsing, dispatch, exit codes and the shared command helpers, including run bookkeeping.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { USAGE } from '../../src/cli';
import { statePathsFor } from '../../src/paths';
import { launchdLabel, launchdPlistPath, systemdUnitName, systemdUnitPath } from '../../src/service';
import { cleanupAll, cloneRemote, createRemote, runCli, setupTestEnv, writeJson } from '../harness';

afterEach(cleanupAll);

describe('the cli process', () => {
  test('--version, --help and no command', async () => {
    const t = await setupTestEnv('cli-basics');
    const v = await runCli(t, ['--version']);
    expect({ code: v.code, out: v.stdout }).toEqual({ code: 0, out: `md-sync ${pkg.version}\n` });
    const h = await runCli(t, ['--help']);
    expect({ code: h.code, out: h.stdout }).toEqual({ code: 0, out: USAGE });
    const none = await runCli(t, []);
    expect({ code: none.code, out: none.stdout, err: none.stderr }).toEqual({ code: 2, out: '', err: USAGE });
  });

  test('--cwd resolves relative --dir and rejects non-directories', async () => {
    const t = await setupTestEnv('cli-cwd');
    const sub = join(t.root, 'sub');
    mkdirSync(sub);
    const bad = await runCli(t, ['status', '--cwd', join(t.root, 'nope')]);
    expect({ code: bad.code, err: bad.stderr.includes('--cwd') }).toEqual({ code: 2, err: true });
    // relative --dir is taken from --cwd: "." is `sub`, which is no synced folder, so status reports that path
    const r = await runCli(t, ['status', '--cwd', sub, '--dir', 'missing']);
    expect(r.stdout).toContain(join(realpathSync(sub), 'missing'));
  });

  test('usage and config errors exit 2 with an `md-sync:` line', async () => {
    const t = await setupTestEnv('cli-errors');
    const cases: [string[], string][] = [
      [['run', '--bogus'], 'md-sync: '],
      [['status', '--message', 'x'], '--message is only valid for flush'],
      [['run', '--log-level', 'loud', '--dir', t.root], 'invalid --log-level'],
      [['run', '--dir', join(t.root, 'x')], 'missing required config key "remote"'],
      [['flush', '--config', join(t.root, 'nope.json')], 'config file not found'],
      [['status'], 'cannot determine the synced folder; pass --dir or --config'],
      [['sync-once', '--dir', t.root, '--remote', 'r', '--max-wait-ms', '999'], 'invalid config key "maxWaitMs" (--max-wait-ms)'],
    ];
    const results = await Promise.all(cases.map(([args]) => runCli(t, args)));
    cases.forEach(([args, text], i) => {
      expect({ args, code: results[i]?.code }).toEqual({ args, code: 2 });
      expect(results[i]?.stderr).toContain(text);
    });
    // an invalid MDSYNC_LOG_LEVEL comes from the environment (a hook runner's): it warns, it never fails the command
    const env = await runCli(t, ['status', '--dir', t.root], { env: { MDSYNC_LOG_LEVEL: 'chatty' } });
    expect(env.code).toBe(0);
    expect(env.stderr).toContain('ignoring invalid MDSYNC_LOG_LEVEL "chatty"');
  });

  test('ordinary mistakes get plain messages', async () => {
    const t = await setupTestEnv('cli-messages');
    const unknown = await runCli(t, ['run', '--dirr', 'x']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("md-sync: unknown option '--dirr'");
    expect(unknown.stderr).not.toContain('TypeError');
    expect(unknown.stderr).not.toContain('positional argument');
    const bare = await runCli(t, ['run', '--dir']);
    expect(bare.stderr).toContain("md-sync: option '--dir <value>' argument missing");
    const minutes = await runCli(t, ['run', '--dir', t.root, '--remote', 'r', '--idle-ms', '5m']);
    expect(minutes.code).toBe(2);
    expect(minutes.stderr).toContain('invalid config key "idleMs" (--idle-ms): expected a whole number of milliseconds, got "5m"');
    expect(minutes.stderr).not.toContain('NaN');
    const noFile = await runCli(t, ['run']);
    expect(noFile.stderr).toContain(`no config file at ${join(t.configHome, 'mdsync', 'config.json')}`);
    const remote = await createRemote(t);
    const a = await cloneRemote(t, remote, 'a');
    const itself = await runCli(t, ['flush', '--dir', a.dir, a.dir]);
    expect(itself.code).toBe(2);
    expect(itself.stderr).toContain('is the synced folder itself, not a file in it');
  });

  test('an invalid instance file names the key and the file, and logs `config invalid`', async () => {
    const t = await setupTestEnv('cli-bad-instance');
    const cfg = join(t.configHome, 'mdsync', 'x.json');
    writeJson(cfg, { remote: 'r', dir: join(t.root, 'd'), idelMs: 5 });
    const r = await runCli(t, ['run', '--config', cfg]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`invalid config key "idelMs" in ${cfg}: unknown key`);
    expect(r.logs.find((l) => l.msg === 'config invalid')).toMatchObject({ layer: 'instance', file: cfg });
  });

  test('print-workflow: branch from --branch, then the instance file, never a default; logs never reach stdout', async () => {
    const t = await setupTestEnv('cli-workflow');
    const plain = await runCli(t, ['print-workflow']);   // no flag, no file, no checkout here: no branch to print
    expect({ code: plain.code, out: plain.stdout }).toEqual({ code: 2, out: '' });
    expect(plain.stderr).toContain('missing required config key "branch" (pass --branch or set "branch" in the config file');
    writeJson(join(t.configHome, 'mdsync', 'config.json'), { branch: 'notes' });
    expect((await runCli(t, ['print-workflow'])).stdout).toContain('branches: [notes]');
    const flag = await runCli(t, ['print-workflow', '--branch', 'trunk']);
    expect(flag.code).toBe(0);
    expect(flag.stdout).toContain('mdsync-notify');
    expect(flag.stdout).toContain('branches: [trunk]');
    expect(flag.stdout.split('\n').some((l) => l.startsWith('{'))).toBe(false);
  });

  test('print-workflow: with no CLI or instance branch, the committed repo config of the clone decides', async () => {
    const t = await setupTestEnv('cli-workflow-repo');
    const r = await createRemote(t, { files: { '.config/mdsync.json': '{"branch":"notes"}\n' } });
    const c = await cloneRemote(t, r, 'notes');
    const cfg = join(t.configHome, 'mdsync', 'notes.json');
    writeJson(cfg, { dir: c.dir, remote: r.url });
    expect((await runCli(t, ['print-workflow', '--config', cfg])).stdout).toContain('branches: [notes]');
    writeJson(cfg, { dir: c.dir, remote: r.url, branch: 'inst' });   // the instance file outranks the repo file
    expect((await runCli(t, ['print-workflow', '--config', cfg])).stdout).toContain('branches: [inst]');
    writeJson(cfg, { dir: c.dir, remote: r.url });
    await c.git(['checkout', '-q', '-b', 'side']);   // the repo file still outranks the checked-out branch
    expect((await runCli(t, ['print-workflow', '--config', cfg])).stdout).toContain('branches: [notes]');
    writeJson(cfg, { dir: join(t.root, 'not-cloned-yet'), remote: r.url });   // nothing checked out: no branch
    const fresh = await runCli(t, ['print-workflow', '--config', cfg]);
    expect(fresh.code).toBe(2);
    expect(fresh.stderr).toContain('missing required config key "branch"');
  });

  test('install-service --print renders the unit with the instance file and overrides, never GIT_TOKEN', async () => {
    const t = await setupTestEnv('cli-service');
    const cfg = join(t.configHome, 'mdsync', 'svc.json');
    // a folder not cloned yet: nothing is checked out, so the branch is named (there is no default)
    writeJson(cfg, { remote: 'git@example.invalid:me/notes.git', dir: join(t.root, 'svc'), branch: 'main' });
    const r = await runCli(t, ['install-service', '--config', cfg, '--idle-ms', '5000', '--print'],
      { env: { GIT_TOKEN: 'never-in-a-unit-123' } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(cfg);
    expect(r.stdout).toContain('--idle-ms');
    expect(r.stdout).toContain('5000');
    expect(r.stdout).not.toContain('never-in-a-unit');
    expect(r.stdout).toContain(process.platform === 'darwin' ? '<key>ProgramArguments</key>' : 'KillMode=mixed');
    // a preview creates nothing: not the folder, not a state dir
    expect(existsSync(join(t.root, 'svc'))).toBe(false);
    expect(existsSync(join(t.stateHome, 'mdsync'))).toBe(false);
  });

  test('status on a plain clone: stopped daemon, pending changes, JSON and text', async () => {
    const t = await setupTestEnv('cli-status');
    const remote = await createRemote(t);
    const a = await cloneRemote(t, remote, 'a');
    await a.write('new.md', 'x\n');
    const json = await runCli(t, ['status', '--dir', a.dir, '--format', 'json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ dir: a.dir, daemon: { state: 'stopped' }, lastRun: null,
      consecutiveFailures: 0, keptStashes: [], unpushed: 0, pending: [{ xy: '??', path: 'new.md' }],
      health: { status: 'failing', issues: ['daemon not running', 'no state file'] }, ntfy: 'off', fallbackMs: 3_600_000,
      lastOkAt: null, nextRetryAt: null, stuck: null });
    const text = await runCli(t, ['status', '--dir', a.dir]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^daemon:\s+not running$/m);
    expect(text.stdout).toMatch(/^pending:\s+1 change$/m);
    expect(text.stdout).toContain('  ?? new.md\n');
    expect(text.stdout).toMatch(/^unpushed:\s+0 commits$/m);
    expect(text.stdout).toMatch(/^health:\s+failing \(daemon not running; no state file\)$/m);
    expect(text.stdout).not.toMatch(/^ntfy:/m);
  });

  test('status reports the ntfy record from the state file, and `unknown` before the daemon writes one', async () => {
    const t = await setupTestEnv('cli-status-ntfy');
    const remote = await createRemote(t);
    const a = await cloneRemote(t, remote, 'a');
    const topicUrl = 'https://ntfy.example/status-secret-topic';
    const paths = statePathsFor(a.dir, t.env);
    const before = JSON.parse((await runCli(t, ['status', '--dir', a.dir, '--json', '--ntfy-url', topicUrl])).stdout) as Record<string, unknown>;
    expect(before.ntfy).toEqual({ state: 'unknown' });
    const ntfy = { state: 'disconnected', since: '2026-10-18T11:00:00.000Z', lastError: 'HTTP 503', reconnects: 3 };
    writeJson(paths.state, { version: 1, dir: a.dir, pid: 1, updatedAt: '2026-10-18T11:00:00.000Z', consecutiveFailures: 0,
      keptStashes: [], ntfy });
    const json = await runCli(t, ['status', '--dir', a.dir, '--json', '--ntfy-url', topicUrl]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ntfy, health: { status: 'failing',
      issues: ['daemon not running', 'ntfy disconnected: HTTP 503'] } });
    const text = await runCli(t, ['status', '--dir', a.dir, '--ntfy-url', topicUrl]);
    expect(text.stdout).toMatch(/^ntfy:\s+disconnected since 2026-10-18T11:00:00Z, error: HTTP 503, no events yet, no messages yet, 3 reconnects$/m);
    expect(json.stdout + text.stdout + text.stderr).not.toContain('status-secret-topic');
  });

  test('status: names the installed unit, and never repeats the repo-config warnings the daemon reports', async () => {
    const t = await setupTestEnv('cli-status-unit');
    const remote = await createRemote(t, { files: { '.config/mdsync.json': '{"authorName":"x","futureKey":1}\n' } });
    const a = await cloneRemote(t, remote, 'a');
    const hash = statePathsFor(a.dir, t.env).hash;
    const plain = await runCli(t, ['status', '--dir', a.dir]);
    expect(plain.code).toBe(0);
    expect(plain.stderr).not.toContain('repo config key ignored');
    expect(plain.stdout).not.toMatch(/^service:/m);
    const unit = process.platform === 'darwin' ? launchdPlistPath(hash, t.home) : systemdUnitPath(hash, t.env);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'installed\n');
    const withUnit = await runCli(t, ['status', '--dir', a.dir]);
    const name = process.platform === 'darwin' ? launchdLabel(hash) : systemdUnitName(hash);
    expect(withUnit.stdout).toMatch(new RegExp(`^service:\\s+${name.replaceAll('.', '\\.')}`, 'm'));
  });

  test('status --format json never reports an unreadable folder as clean', async () => {
    const t = await setupTestEnv('cli-status-unknown');
    const missing = await runCli(t, ['status', '--dir', join(t.root, 'not-yet'), '--format', 'json']);
    expect(missing.code).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ repo: { state: 'unavailable', why: 'folder does not exist' },
      unpushed: 'unknown', pending: 'unknown' });
    const plain = join(t.root, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'a.md'), 'x\n');
    const notRepo = await runCli(t, ['status', '--dir', plain, '--format', 'json']);
    expect(JSON.parse(notRepo.stdout)).toMatchObject({ repo: { state: 'unavailable', why: 'not a git repository' },
      unpushed: 'unknown', pending: 'unknown' });
    const remote = await createRemote(t);
    const a = await cloneRemote(t, remote, 'a');
    const ok = JSON.parse((await runCli(t, ['status', '--dir', a.dir, '--format', 'json'])).stdout) as Record<string, unknown>;
    expect(ok.repo).toEqual({ state: 'ok', head: await a.head() });
    expect(ok.pending).toEqual([]);
  });

  test('flush --path outside the folder exits 2 before contacting anything', async () => {
    const t = await setupTestEnv('cli-flush-outside');
    const remote = await createRemote(t);
    const a = await cloneRemote(t, remote, 'a');
    const r = await runCli(t, ['flush', '--dir', a.dir, join(t.root, 'elsewhere.md')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('path outside synced folder');
    expect(r.logs.some((l) => l.msg === 'one-off run')).toBe(false);
  });
});
