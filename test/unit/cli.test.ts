// CLI parsing, dispatch, exit codes and the shared command helpers, including run bookkeeping.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { parseCli, USAGE } from '../../src/cli';
import { flushRelPath } from '../../src/commands/flush';
import { nextStuck, recordRun, resolveTarget, type CommandEnv } from '../../src/commands/shared';
import { createLogger } from '../../src/log';
import { statePathsFor } from '../../src/paths';
import { writeState, type StateFile } from '../../src/state';
import type { RunResult } from '../../src/types';
import { UsageError } from '../../src/types';
import { cleanupAll, setupTestEnv, type TestEnv, writeJson } from '../harness';

afterEach(cleanupAll);

function result(over: Partial<RunResult> = {}): RunResult {
  return {
    runId: 1, kind: 'commit', mode: 'normal', reasons: ['flush'], outcome: 'ok', commitStep: 'committed',
    commitsIn: 0, commitsOut: 1, head: 'a'.repeat(40), committed: 'a'.repeat(40), conflicts: [], overriddenDeletes: [],
    keptStashes: [], startedAt: '2026-10-08T00:00:00.000Z', durationMs: 5, ...over,
  };
}

describe('parseCli', () => {
  test('package executable and usage use md-sync', () => {
    expect(pkg.bin).toEqual({ 'md-sync': 'src/cli.ts' });
    expect(USAGE).toStartWith('Usage: md-sync <command>');
  });
  test('a command with config flags before and after it', () => {
    const p = parseCli(['--dir', '/x', 'run', '--idle-ms', '5000', '--ignore', 'a', '--ignore', 'b']);
    expect(p).toEqual({ kind: 'command', command: 'run',
      values: { dir: '/x', 'idle-ms': '5000', ignore: ['a', 'b'] }, paths: [] });
  });

  test('flush: -m, positional paths, --wait and --no-wait', () => {
    expect(parseCli(['flush', '-m', 'did X', 'a.md', 'b/c.md', '--wait'])).toEqual({
      kind: 'command', command: 'flush', values: { message: 'did X', wait: true }, paths: ['a.md', 'b/c.md'] });
    expect(parseCli(['flush', '--no-wait'])).toEqual({ kind: 'command', command: 'flush', values: { wait: false }, paths: [] });
  });

  test('--cwd is a global flag', () => {
    expect(parseCli(['--cwd', '/x', 'status'])).toEqual({ kind: 'command', command: 'status', values: { cwd: '/x' }, paths: [] });
  });

  test('--help and --version win over everything else', () => {
    expect(parseCli(['--help'])).toEqual({ kind: 'help' });
    expect(parseCli(['status', '-h'])).toEqual({ kind: 'help' });
    expect(parseCli(['--version'])).toEqual({ kind: 'version' });
  });

  test('usage errors', () => {
    const bad: string[][] = [
      [],                                  // no command
      ['bogus'],                           // unknown command
      ['run', 'extra'],                    // stray positional
      ['run', '--bogus'],                  // unknown flag
      ['run', '--idle-ms'],                // missing value
      ['status', '--message', 'x'],        // flush-only flag
      ['flush', '--format', 'json'],       // status-only flag
      ['status', '--print'],               // install-service-only flag
      ['flush', '--no-print'],
      ['status', '--format', 'yaml'],
    ];
    for (const argv of bad) expect(() => parseCli(argv), argv.join(' ')).toThrow(UsageError);
  });

  test('the usage text names every command', () => {
    for (const c of ['run', 'sync-once', 'status', 'flush', 'install-service', 'uninstall-service', 'print-workflow']) {
      expect(USAGE).toContain(`  ${c} `);
    }
  });
});

describe('flushRelPath', () => {
  test('relative to cwd, through symlinks, and missing files', async () => {
    const t = await setupTestEnv('cli-relpath');
    const root = join(t.root, 'notes');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'a.md'), 'a');
    symlinkSync(root, join(t.root, 'link'));
    expect(flushRelPath('../a.md', join(root, 'sub'), root)).toBe('a.md');
    expect(flushRelPath('b.md', join(root, 'sub'), root)).toBe('sub/b.md');                  // does not exist yet
    expect(flushRelPath('gone/deeper/c.md', root, root)).toBe('gone/deeper/c.md');           // missing folders too
    expect(flushRelPath(join(t.root, 'link', 'a.md'), t.root, root)).toBe('a.md');          // symlinked folder
    expect(flushRelPath('a.md', join(t.root, 'link'), root)).toBe('a.md');                   // symlinked cwd
    expect(flushRelPath('../../outside.md', join(root, 'sub'), root)).toBe('outside');
    expect(flushRelPath('.', root, root)).toBe('the-folder');                                // the folder itself
    expect(flushRelPath('.git/config', root, root)).toBe('outside');
    expect(flushRelPath('/etc/hosts', root, root)).toBe('outside');
  });

  test('from a cwd outside the folder, a relative path that misses it is taken relative to the folder', async () => {
    const t = await setupTestEnv('cli-relpath-outside');
    const root = join(t.root, 'notes');
    mkdirSync(join(root, 'sub'), { recursive: true });
    expect(flushRelPath('notes/a.md', t.root, root)).toBe('a.md');     // cwd-relative lands inside: it wins
    expect(flushRelPath('a.md', t.root, root)).toBe('a.md');           // `flush --dir ~/notes --path a.md` from elsewhere
    expect(flushRelPath('sub/b.md', t.root, root)).toBe('sub/b.md');
    expect(flushRelPath('../x.md', t.root, root)).toBe('outside');
    expect(flushRelPath(join(t.root, 'x.md'), t.root, root)).toBe('outside');   // absolute paths never fall back
    expect(flushRelPath('../../x.md', join(root, 'sub'), root)).toBe('outside'); // cwd inside: no fallback
  });

  test('from a cwd outside the folder, a path that exists there is what the caller meant: rejected, not re-rooted', async () => {
    const t = await setupTestEnv('cli-relpath-exists');
    const project = join(t.root, 'project');
    const root = join(t.root, 'notes');
    mkdirSync(project, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(project, 'todo.md'), 'the project todo\n');
    writeFileSync(join(root, 'todo.md'), 'a notes todo\n');
    expect(flushRelPath('todo.md', project, root)).toBe('outside');
    expect(flushRelPath('other.md', project, root)).toBe('other.md');   // nothing at project/other.md: folder-relative
  });
});

describe('run bookkeeping', () => {
  const base: StateFile = { version: 1, dir: '/d', pid: 1, updatedAt: '', consecutiveFailures: 2, keptStashes: [] };

  test('an ok run resets failures and sets lastOkAt; a failed one counts up', async () => {
    const ok = await recordRun({ state: base, res: result(), stuck: 'none', git: 'none' });
    expect(ok.state).toMatchObject({ consecutiveFailures: 0, pid: process.pid });
    expect(ok.state.lastOkAt).toBeString();
    expect(ok.state.lastRun).toMatchObject({ runId: 1, outcome: 'ok' });
    const bad = await recordRun({ state: base, res: result({ outcome: 'network-error', error: 'x' }), stuck: 'none', git: 'none' });
    expect(bad.state.consecutiveFailures).toBe(3);
    expect(bad.state.lastOkAt).toBeUndefined();
  });

  test('the integrated remote commit is kept from the last run that reported one (S3 rewrite check)', async () => {
    const i1 = 'a'.repeat(40);
    const r1 = await recordRun({ state: base, res: result({ integrated: i1 }), stuck: 'none', git: 'none' });
    expect(r1.state.integrated).toBe(i1);
    const r2 = await recordRun({ state: r1.state, res: result({ outcome: 'failed', error: 'x' }), stuck: 'none', git: 'none' });
    expect(r2.state.integrated).toBe(i1);
  });

  test('kept stashes get a reason from the outcome and are never duplicated', async () => {
    const s1 = 'b'.repeat(40);
    const s2 = 'c'.repeat(40);
    const r1 = await recordRun({ state: base, res: result({ outcome: 'data-guard-stop', keptStashes: [s1] }), stuck: 'none', git: 'none' });
    const r2 = await recordRun({ state: r1.state, res: result({ outcome: 'conflict-resolved', keptStashes: [s1, s2] }), stuck: 'none', git: 'none' });
    expect(r2.state.keptStashes.map((k) => [k.sha, k.reason])).toEqual([[s1, 'data-guard-stop'], [s2, 'write-raced']]);
    const r3 = await recordRun({ state: base, res: result({ outcome: 'failed', keptStashes: [s1] }), stuck: 'none', git: 'none' });
    expect(r3.state.keptStashes[0]?.reason).toBe('failed');
  });

  test('stuck record: set from an S5 failure, keeps `since` while head/remote stay, cleared otherwise', () => {
    const s5 = { head: 'h1', remote: 'r1' };
    const first = nextStuck('none', result({ outcome: 'failed', error: 'boom', s5 }), 't1');
    expect(first).toEqual({ head: 'h1', remote: 'r1', outcome: 'failed', error: 'boom', since: 't1' });
    expect(nextStuck(first, result({ outcome: 'failed', error: 'boom', s5 }), 't2')).toMatchObject({ since: 't1' });
    expect(nextStuck(first, result({ outcome: 'failed', s5: { head: 'h2', remote: 'r1' } }), 't3')).toMatchObject({ since: 't3' });
    expect(nextStuck(first, result({ outcome: 'ok' }), 't4')).toBe('none');
    expect(nextStuck(first, result({ outcome: 'failed', error: 'S2' }), 't5')).toBe('none');   // not from S5
    // r4: a replayed failure keeps the original error, so the record never nests "unchanged since …: " prefixes
    let rec = first;
    for (let i = 0; i < 5; i++) {
      rec = nextStuck(rec, result({ outcome: 'failed', error: `unchanged since t1: ${rec === 'none' ? '' : rec.error}`, s5,
        stuck: 'unchanged' }), `t${i + 6}`);
    }
    expect(rec).toEqual({ head: 'h1', remote: 'r1', outcome: 'failed', error: 'boom', since: 't1' });
  });
});

describe('resolveTarget', () => {
  const lines: string[] = [];
  const env = (t: TestEnv, values: CommandEnv['values'], cwd = t.root): CommandEnv => ({
    values, paths: [], cwd, env: t.env, logLevelFlag: 'unset',
    log: createLogger({ level: 'debug', sink: 'stderr', write: (l) => lines.push(l) }),
  });

  test('--dir, then --config, then a synced ancestor of cwd, then the default file', async () => {
    const t = await setupTestEnv('cli-target');
    const a = join(t.root, 'a');
    const b = join(t.root, 'b');
    const c = join(t.root, 'c');
    for (const d of [a, b, c]) mkdirSync(join(d, 'sub'), { recursive: true });
    const cfgB = join(t.configHome, 'mdsync', 'b.json');
    writeJson(cfgB, { dir: b, ignore: ['b/**'] });
    writeJson(join(t.configHome, 'mdsync', 'config.json'), { dir: c, ignore: ['c/**'] });

    const byDir = resolveTarget(env(t, { dir: a }));
    expect(byDir.kind === 'ok' && byDir.target.realDir).toBe(a);
    // the default file names another folder, so it does not apply to --dir a
    expect(byDir.kind === 'ok' && byDir.target.instance).toBe('none');

    const byConfig = resolveTarget(env(t, { config: cfgB }));
    expect(byConfig.kind === 'ok' && byConfig.target.realDir).toBe(b);
    expect(byConfig.kind === 'ok' && byConfig.target.layers.instance.ignore).toEqual(['b/**']);

    // a state file marks `a` as synced: cwd inside it wins over the default file
    const pa = statePathsFor(a, t.env);
    mkdirSync(pa.stateDir, { recursive: true });
    writeState(pa, { version: 1, dir: a, pid: 1, updatedAt: '', consecutiveFailures: 0, keptStashes: [],
      instance: { configPath: cfgB, cli: { authorName: 'from-state' } } });
    const byCwd = resolveTarget(env(t, {}, join(a, 'sub')));
    expect(byCwd.kind === 'ok' && byCwd.target.realDir).toBe(a);
    // the instance layer is rebuilt from the state file; flags given now override the stored ones
    expect(byCwd.kind === 'ok' && byCwd.target.instance).toBe('state');
    expect(byCwd.kind === 'ok' && byCwd.target.layers.instance.ignore).toEqual(['b/**']);
    expect(byCwd.kind === 'ok' && byCwd.target.layers.cli.authorName).toBe('from-state');
    const flagged = resolveTarget(env(t, { 'author-name': 'now' }, join(a, 'sub')));
    expect(flagged.kind === 'ok' && flagged.target.layers.cli.authorName).toBe('now');

    const byDefault = resolveTarget(env(t, {}, t.root));
    expect(byDefault.kind === 'ok' && byDefault.target.realDir).toBe(c);
    expect(byDefault.kind === 'ok' && byDefault.target.instance).toBe('file');
  });

  test('a deleted folder reached through a symlink keeps the hash it had (uninstall-service after rm -rf)', async () => {
    const t = await setupTestEnv('cli-target-gone');
    const real = join(t.root, 'real');
    mkdirSync(join(real, 'notes'), { recursive: true });
    symlinkSync(real, join(t.root, 'link'));
    const viaLink = join(t.root, 'link', 'notes');
    const before = resolveTarget(env(t, { dir: viaLink }));
    rmSync(join(real, 'notes'), { recursive: true });
    const after = resolveTarget(env(t, { dir: viaLink }));
    expect(after.kind === 'ok' && after.target.dirState).toBe('missing');
    expect(after.kind === 'ok' && after.target.paths.hash).toBe(before.kind === 'ok' ? before.target.paths.hash : 'x');
    expect(after.kind === 'ok' && after.target.realDir).toBe(join(realpathSync(real), 'notes'));
  });
});

