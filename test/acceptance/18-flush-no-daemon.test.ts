// Acceptance 18: `flush` with no daemon running does a one-off commit run itself.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { statePathsFor } from '../../src/paths';
import { launchdLabel, launchdPlistPath, renderLaunchdPlist, renderSystemdUnit, systemdUnitPath } from '../../src/service';
import {
  allowAuthor, cleanupAll, cloneRemote, createRemote, DEFAULT_AUTHOR, expectNoMdsyncArtifacts, is, runCli, setupTestEnv,
  startDaemon,
} from '../harness';

afterEach(cleanupAll);


test('(a) a plain clone with no daemon: flush does a one-off commit run and releases the lock', async () => {
  const t = await setupTestEnv('flush-no-daemon');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  allowAuthor(t, DEFAULT_AUTHOR);
  await a.write('o1.md', 'offline one\n');
  await a.write('notes/o2.md', 'offline two\n');

  const res = await runCli(t, ['flush', '--dir', a.dir, '-m', 'offline']);
  expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: res.stderr });
  expect(res.logs.find(is('one-off run'))).toMatchObject({ source: 'flush', dir: a.dir });
  expect(res.logs.some(is('one-off without instance config'))).toBe(true);
  expect(res.logs.find(is('sync done'))).toMatchObject({ kind: 'commit', outcome: 'ok', commitStep: 'committed', commitsOut: 1 });

  const log = await r.log();
  expect(log[0]).toMatchObject({ subject: 'offline', authorName: DEFAULT_AUTHOR });
  expect([...(log[0]?.files ?? [])].sort()).toEqual(['notes/o2.md', 'o1.md']);
  expect(await r.head()).toBe(await a.head());
  expect(await a.porcelain()).toEqual([]);
  const paths = statePathsFor(a.dir, t.env);
  expect(existsSync(paths.lock)).toBe(false);
  expect(existsSync(paths.sock)).toBe(false);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'o1.md', 'notes/o2.md'].includes(p));
}, 90_000);

test('(b) the target folder comes from --config, then from a cwd inside the folder', async () => {
  const t = await setupTestEnv('flush-no-daemon-resolve');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  allowAuthor(t, DEFAULT_AUTHOR);

  // --config with a relative `dir` (resolved against the file's own dir), run from outside the folder.
  const cfgDir = join(t.root, 'cfg');
  mkdirSync(cfgDir);
  const cfg = join(cfgDir, 'notes.json');
  writeFileSync(cfg, `${JSON.stringify({ dir: '../A' })}\n`);
  await a.write('via-config.md', 'c\n');
  const viaConfig = await runCli(t, ['flush', '--config', cfg, '-m', 'via config'], { cwd: t.root });
  expect({ code: viaConfig.code, stderr: viaConfig.stderr }).toEqual({ code: 0, stderr: viaConfig.stderr });
  expect(viaConfig.logs.find(is('one-off run'))).toMatchObject({ source: 'flush', dir: a.dir });
  expect((await r.log())[0]).toMatchObject({ subject: 'via config', files: ['via-config.md'] });

  // The state file written by that run marks the folder, so a flush from a subdirectory needs no flags.
  await a.write('sub/via-cwd.md', 'w\n');
  const viaCwd = await runCli(t, ['flush', '-m', 'via cwd'], { cwd: join(a.dir, 'sub') });
  expect({ code: viaCwd.code, stderr: viaCwd.stderr }).toEqual({ code: 0, stderr: viaCwd.stderr });
  expect(viaCwd.logs.find(is('one-off run'))).toMatchObject({ source: 'flush', dir: a.dir });
  expect((await r.log())[0]).toMatchObject({ subject: 'via cwd', files: ['sub/via-cwd.md'] });
  expect(existsSync(statePathsFor(a.dir, t.env).lock)).toBe(false);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'via-config.md', 'sub/via-cwd.md'].includes(p));
}, 90_000);

test('(c) a one-off flush rebuilds the stopped daemon\'s instance config from the state file', async () => {
  const t = await setupTestEnv('flush-no-daemon-instance');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  // startDaemon writes <configHome>/mdsync/A.json: not the default config.json, so only the state file can name it.
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { ignore: ['private/**'] } });
  expect(await A.stop()).toBe(0);

  await a.write('private/s.md', 'secret\n');
  await a.write('n.md', 'n\n');
  const res = await runCli(t, ['flush', '--dir', a.dir]);
  expect({ code: res.code, stderr: res.stderr }).toEqual({ code: 0, stderr: res.stderr });
  expect(res.logs.find(is('one-off run'))).toMatchObject({ source: 'flush', dir: a.dir });
  expect(res.logs.some(is('one-off without instance config'))).toBe(false);

  const tree = await r.tree();
  expect(tree).toContain('n.md');
  expect(tree).not.toContain('private/s.md');
  expect((await r.log())[0]).toMatchObject({ authorName: 'mdsync-A', files: ['n.md'] });
  expect(await a.porcelain()).toEqual(['?? private/s.md']);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'n.md', 'private/s.md'].includes(p));
}, 90_000);

test('(e) a flush or sync-once from an environment without the daemon\'s XDG_STATE_HOME finds the daemon, never races it', async () => {
  // A hook started by a GUI app does not read the shell rc that set XDG_STATE_HOME for install-service. It used to
  // miss the socket and run a second sync of the same folder, without the daemon's `ignore` list or author.
  const t = await setupTestEnv('flush-other-state-home');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { ignore: ['*.tmp'] } });
  // what install-service writes: the unit records the XDG_STATE_HOME it was installed with
  const hash = statePathsFor(a.dir, t.env).hash;
  const unitEnv = { PATH: '/usr/bin:/bin', XDG_STATE_HOME: t.stateHome };
  if (process.platform === 'darwin') {
    const plist = launchdPlistPath(hash, t.home);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, renderLaunchdPlist({ label: launchdLabel(hash), argv: ['md-sync', 'run'], env: unitEnv, logPath: '/dev/null' }));
  } else {
    const unit = systemdUnitPath(hash, t.env);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, renderSystemdUnit({ realDir: a.dir, argv: ['md-sync', 'run'], env: unitEnv }));
  }
  const elsewhere = { XDG_STATE_HOME: '' };   // unset: the default ~/.local/state

  await a.write('scratch.tmp', 'ignored by the daemon\n');
  await a.write('note.md', 'from the hook\n');
  const m = A.mark();
  const f = await runCli(t, ['flush', '--dir', a.dir, '--wait'], { env: elsewhere });
  expect({ code: f.code, stderr: f.stderr.trim() }).toEqual({ code: 0, stderr: '' });
  expect(f.logs.some(is('one-off run'))).toBe(false);
  expect(A.logs.slice(m).some(is('flush received'))).toBe(true);
  expect(await r.show('note.md')).toBe('from the hook\n');
  expect(await r.tree()).not.toContain('scratch.tmp');

  const once = await runCli(t, ['sync-once', '--dir', a.dir, '--remote', r.url], { env: elsewhere });
  expect(once.code).toBe(1);
  expect(once.stderr).toContain('is already syncing');
  expect(once.logs.some(is('one-off run'))).toBe(false);
  expect(existsSync(statePathsFor(a.dir, { ...t.env, XDG_STATE_HOME: '' }).lock)).toBe(false);
}, 120_000);
