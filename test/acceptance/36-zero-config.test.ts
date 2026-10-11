// Zero-config `md-sync run` (changelog 2026-10-09_zero-config-run): started inside a checkout with no flags and no
// config file, it syncs that folder with its origin, on the branch checked out there. Outside a checkout's top, or on
// a detached HEAD, it refuses (exit 2) instead of guessing.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  cleanupAll, cloneRemote, createRemote, DEFAULT_AUTHOR, emptyDir, expectNoMdsyncArtifacts, runCli, setupTestEnv, startDaemon, type Clone,
} from '../harness';

afterEach(cleanupAll);

async function ok(c: Clone, args: string[]): Promise<string> {
  const r = await c.git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const headRef = (c: Clone): Promise<string> => ok(c, ['symbolic-ref', '-q', 'HEAD']);

// ProgramArguments (launchd) or the ExecStart words (systemd) of an `install-service --print` unit.
function unitArgs(text: string): string[] {
  if (process.platform === 'darwin') {
    const block = text.split('<key>ProgramArguments</key>')[1]?.split('</array>')[0] ?? '';
    return [...block.matchAll(/<string>(.*?)<\/string>/g)]
      .map((m) => (m[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? '';
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? '').replace(/\\(.)/g, '$1'));
}

const fromRun = (args: string[]): string[] => args.slice(args.indexOf('run'));

test('`md-sync run` with no flags and no config file syncs the checkout it starts in, with its origin', async () => {
  const t = await setupTestEnv('zero-config-run');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, launch: 'from-cwd' });
  expect(existsSync(join(t.configHome, 'mdsync'))).toBe(false);   // no config file anywhere
  const start = await A.waitForLog('daemon starting');
  expect({ dir: start.dir, remote: start.remote, branch: start.branch, sources: start.sources }).toEqual({
    dir: a.dir, remote: r.url, branch: 'main', sources: { dir: 'default', remote: 'origin', branch: 'checkout' } });

  await a.write('notes/zero.md', 'no config needed\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await r.show('notes/zero.md')).toBe('no config needed\n');
  expect((await r.log())[0]?.authorName).toBe(DEFAULT_AUTHOR);
  expect(await A.stop()).toBe(0);

  // sync-once the same way, started elsewhere through --cwd
  await a.write('notes/once.md', 'one-off\n');
  const once = await runCli(t, ['sync-once', '--cwd', a.dir]);
  expect({ code: once.code, stderr: once.stderr.trim() }).toEqual({ code: 0, stderr: '' });
  expect(await r.show('notes/once.md')).toBe('one-off\n');
  await expectNoMdsyncArtifacts(t, [a], r, (p) => p === 'README.md' || p.startsWith('notes/'));
}, 120_000);

test('a checkout on another branch syncs that branch, main untouched; flush, status and print-workflow agree', async () => {
  const t = await setupTestEnv('zero-config-branch');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  await ok(a, ['checkout', '-q', '-b', 'notes']);
  await a.write('first.md', 'on notes\n');
  await ok(a, ['add', '-A']);
  await ok(a, ['commit', '-q', '-m', 'first on notes']);
  await ok(a, ['push', '-q', 'origin', 'notes']);
  const mainBefore = await r.head();

  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, launch: 'from-cwd' });
  const start = await A.waitForLog('daemon starting');
  expect({ branch: start.branch, sources: start.sources })
    .toEqual({ branch: 'notes', sources: { dir: 'default', remote: 'origin', branch: 'checkout' } });
  await a.write('second.md', 'daemon on notes\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await r.show('second.md', 'refs/heads/notes')).toBe('daemon on notes\n');
  expect(await r.head()).toBe(mainBefore);
  expect(await headRef(a)).toBe('refs/heads/notes');   // P6 never switched the folder to main
  expect(await A.stop()).toBe(0);

  // no daemon: a one-off flush, status and the workflow use the checked-out branch too (not the old default main)
  await a.write('third.md', 'one-off on notes\n');
  const f = await runCli(t, ['flush', '--wait'], { cwd: a.dir });
  expect({ code: f.code, oneOff: f.logs.some((l) => l.msg === 'one-off run') }).toEqual({ code: 0, oneOff: true });
  expect(await r.show('third.md', 'refs/heads/notes')).toBe('one-off on notes\n');
  expect(await r.head()).toBe(mainBefore);
  expect(await headRef(a)).toBe('refs/heads/notes');
  const st = await runCli(t, ['status', '--format', 'json'], { cwd: a.dir });
  expect(JSON.parse(st.stdout)).toMatchObject({ unpushed: 0, pending: [] });
  expect((await runCli(t, ['print-workflow'], { cwd: a.dir })).stdout).toContain('branches: [notes]');

  const authors = (await ok(a, ['log', '--format=%an', 'origin/notes'])).split('\n');
  expect([...new Set(authors)].sort()).toEqual(['Test Helper', DEFAULT_AUTHOR].sort());
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'first.md', 'second.md', 'third.md'].includes(p),
    { branches: ['main', 'notes'] });
}, 120_000);

test('a detached HEAD with no branch given: exit 2 naming --branch before anything starts; --branch fixes it', async () => {
  const t = await setupTestEnv('zero-config-detached');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  await ok(a, ['checkout', '-q', '--detach']);
  const res = await runCli(t, ['run'], { cwd: a.dir });
  expect(res.code).toBe(2);
  expect(res.stderr).toContain(`md-sync: ${a.dir} has a detached HEAD, so there is no checked-out branch to sync; `
    + `check out a branch (git -C ${a.dir} switch <branch>) or pass --branch`);
  expect(res.logs.some((l) => l.msg === 'config invalid' && l.key === 'branch')).toBe(true);
  expect(existsSync(join(t.stateHome, 'mdsync'))).toBe(false);   // no lock, no state: refused before the daemon

  const fixed = await runCli(t, ['sync-once', '--branch', 'main'], { cwd: a.dir });
  expect(fixed.code).toBe(0);
  expect(await headRef(a)).toBe('refs/heads/main');
}, 120_000);

test('no dir given outside the top of a checkout: exit 2 and the folder is never synced; no origin: missing remote', async () => {
  const t = await setupTestEnv('zero-config-not-a-repo');
  const plain = emptyDir(t, 'plain');
  writeFileSync(join(plain, 'private.md'), 'not for git\n');
  const hint = `(no config file at ${join(t.configHome, 'mdsync', 'config.json')})`;
  const cases = [['run'], ['sync-once'], ['install-service', '--print']];
  const results = await Promise.all(cases.map((args) => runCli(t, args, { cwd: plain })));
  cases.forEach((args, i) => {
    expect({ args, code: results[i]?.code }).toEqual({ args, code: 2 });
    expect(results[i]?.stderr).toContain(`md-sync: no dir given and ${plain} is not a git repository; pass --dir ${hint}`);
  });
  expect(existsSync(join(plain, '.git'))).toBe(false);

  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  const sub = join(a.dir, 'sub');
  mkdirSync(sub);
  const inside = await runCli(t, ['run'], { cwd: sub });
  expect(inside.code).toBe(2);
  expect(inside.stderr).toContain(`is inside the git repository ${a.dir}, not at its top; run md-sync from ${a.dir} or pass --dir`);

  const local = emptyDir(t, 'local');
  const init = Bun.spawnSync(['git', 'init', '-q'], { cwd: local, env: t.env });
  expect(init.exitCode).toBe(0);
  const noOrigin = await runCli(t, ['run'], { cwd: local });
  expect(noOrigin.code).toBe(2);
  expect(noOrigin.stderr).toContain('missing required config key "remote"');
  expect(existsSync(join(t.stateHome, 'mdsync'))).toBe(false);
}, 120_000);

test('install-service from a checkout pins its folder and origin; an origin with credentials is never written or logged', async () => {
  const t = await setupTestEnv('zero-config-service');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'a');
  // the unit runs from / or ~, so the folder and the remote go into it; the branch is read at each start
  const unit = await runCli(t, ['install-service', '--print'], { cwd: a.dir });
  expect(unit.code).toBe(0);
  expect(fromRun(unitArgs(unit.stdout))).toEqual(['run', '--remote', r.url, '--dir', a.dir]);
  // a configured dir pins nothing: the daemon reads origin from it, and the file keeps the last word on `remote`
  const cfg = join(t.configHome, 'mdsync', 'svc.json');
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ dir: a.dir }));
  const configured = await runCli(t, ['install-service', '--config', cfg, '--print']);
  expect(configured.code).toBe(0);
  expect(fromRun(unitArgs(configured.stdout))).toEqual(['run', '--config', cfg]);

  const secret = 'secret-token-123';
  await ok(a, ['remote', 'set-url', 'origin', `https://me:${secret}@127.0.0.1:9/notes.git`]);
  const withToken = await runCli(t, ['install-service', '--print'], { cwd: a.dir });
  expect(withToken.code).toBe(0);
  expect(withToken.stdout + withToken.stderr).not.toContain(secret);
  expect(fromRun(unitArgs(withToken.stdout))).toEqual(['run', '--dir', a.dir]);   // the daemon reads origin itself

  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, launch: 'from-cwd', wait: 'none' });
  const start = await A.waitForLog('daemon starting', { timeoutMs: 60_000 });
  expect({ remote: start.remote, sources: start.sources }).toEqual({ remote: 'https://***@127.0.0.1:9/notes.git',
    sources: { dir: 'default', remote: 'origin', branch: 'checkout' } });
  await A.waitForSync({ timeoutMs: 60_000 });   // the startup pull fails on the network, and logs it
  await A.stop();
  expect(`${JSON.stringify(A.logs)}\n${A.stderr()}\n${A.nonJsonStdout().join('\n')}`).not.toContain(secret);
}, 120_000);
