// Zero-config defaults read from the checkout (src/repo-defaults.ts): dir from the current directory (only at the top
// of a worktree), remote from origin, branch from what is checked out; never searched above an explicit folder.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigLayers, InstanceInput } from '../../src/config';
import { createLogger } from '../../src/log';
import { canonicalDir, statePathsFor } from '../../src/paths';
import { hasUserinfo, withRepoDefaults } from '../../src/repo-defaults';
import { writeJournal } from '../../src/state';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-repo-defaults-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
};
const env = { ...process.env, XDG_STATE_HOME: join(root, 'state') };
const log = createLogger({ level: 'error', sink: 'stderr', write: () => {} });

function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: gitEnv });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

let n = 0;
// A repo with one commit on `branch` and an origin, like a clone.
function repo(o: { branch?: string; origin?: string | 'none' } = {}): string {
  const dir = join(root, `r${++n}`);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', o.branch ?? 'main');
  writeFileSync(join(dir, 'a.md'), 'a\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'one');
  if (o.origin !== 'none') sh(dir, 'remote', 'add', 'origin', o.origin ?? `/remotes/r${n}.git`);
  return dir;
}

function layers(cli: InstanceInput = {}, instance: InstanceInput = {}): Omit<ConfigLayers, 'repo'> {
  return { cli, instance, instancePath: 'none' };
}

const fromCwd = (cwd: string, l = layers()) => withRepoDefaults({ layers: l, cwd, env, log, dir: 'from-layers' });
const forDir = (dir: string, l = layers()) => withRepoDefaults({ layers: l, cwd: root, env, log, dir });

describe('dir from the current directory', () => {
  test('the top of a checkout: dir, remote and branch all come from it', async () => {
    const dir = repo({ branch: 'notes', origin: 'git@example.invalid:me/notes.git' });
    const r = await fromCwd(dir);
    expect(r.kind === 'ok' && r.layers.detected).toEqual({ dir, remote: 'git@example.invalid:me/notes.git', branch: 'notes' });
  });

  test('not a git repository: refused, naming the folder and --dir', async () => {
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(await fromCwd(plain)).toEqual({ kind: 'refused', key: 'dir',
      message: `no dir given and ${plain} is not a git repository; pass --dir` });
  });

  test('a subfolder of a checkout: refused (it would sync only part of the repo), naming the top', async () => {
    const dir = repo();
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const r = await fromCwd(sub);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') {
      expect(r.key).toBe('dir');
      expect(r.message).toContain(`is inside the git repository ${dir}, not at its top`);
    }
  });

  test('a dir from a flag or the instance file wins, and the current directory is never looked at', async () => {
    const dir = repo({ branch: 'feature' });
    const plain = join(root, 'plain-2');
    mkdirSync(plain, { recursive: true });
    for (const l of [layers({ dir }), layers({}, { dir })]) {
      const r = await fromCwd(plain, l);
      expect(r.kind === 'ok' && r.layers.detected).toEqual({ remote: `/remotes/r${n}.git`, branch: 'feature' });
    }
  });
});

describe('remote and branch from an explicit folder', () => {
  test('only keys no flag or instance file sets are read', async () => {
    const dir = repo({ branch: 'feature' });
    const r = await forDir(dir, layers({ remote: '/given.git' }, { branch: 'main' }));
    expect(r.kind === 'ok' && r.layers.detected).toEqual({});
    const r2 = await forDir(dir, layers({ remote: '/given.git' }));
    expect(r2.kind === 'ok' && r2.layers.detected).toEqual({ branch: 'feature' });
  });

  test('no origin: no remote (the missing-key error names it later)', async () => {
    const dir = repo({ origin: 'none' });
    const r = await forDir(dir);
    expect(r.kind === 'ok' && r.layers.detected).toEqual({ branch: 'main' });
  });

  test('a missing or empty folder (a fresh clone): nothing read and no branch (the missing-key error names it)', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    for (const dir of [join(root, 'missing'), empty]) {
      const r = await forDir(dir);
      expect(r.kind === 'ok' && r.layers.detected).toEqual({});
    }
  });

  test('a folder without its own .git inside another repo: never that repo\'s branch or origin', async () => {
    const parent = repo({ branch: 'feature', origin: '/parent.git' });
    const inner = join(parent, 'notes');
    mkdirSync(inner);
    const r = await forDir(inner);
    expect(r.kind === 'ok' && r.layers.detected).toEqual({});
  });

  test('an unborn branch counts: its first commit lands there', async () => {
    const dir = join(root, 'unborn');
    mkdirSync(dir, { recursive: true });
    sh(dir, 'init', '-q', '-b', 'trunk');
    const r = await forDir(dir);
    expect(r.kind === 'ok' && r.layers.detected).toEqual({ branch: 'trunk' });
  });

  test('HEAD naming a ref git rejects (an interrupted clone): refused, naming --branch (P6 repairs HEAD once given)', async () => {
    const dir = repo();
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    const r = await forDir(dir);
    expect(r.kind === 'refused' && r.key).toBe('branch');
    if (r.kind === 'refused') {
      expect(r.message).toStartWith(`HEAD in ${dir} does not name a valid branch, as an interrupted clone leaves it (`);
      expect(r.message).toEndWith('; pass --branch (or set "branch" in the config file)');
    }
    const given = await forDir(dir, layers({ branch: 'main' }));
    expect(given.kind === 'ok' && given.layers.detected).toEqual({ remote: `/remotes/r${n}.git` });
  });
});

describe('a detached HEAD', () => {
  test('refused with no branch given, naming the folder and --branch', async () => {
    const dir = repo();
    sh(dir, 'checkout', '-q', '--detach');
    const r = await forDir(dir);
    expect(r).toEqual({ kind: 'refused', key: 'branch', message: `${dir} has a detached HEAD, so there is no checked-out `
      + `branch to sync; check out a branch (git -C ${dir} switch <branch>) or pass --branch (or set "branch" in the config file)` });
    // a given branch needs no detection
    const given = await forDir(dir, layers({ branch: 'main' }));
    expect(given.kind === 'ok' && given.layers.detected).toEqual({ remote: `/remotes/r${n}.git` });
  });

  test('a committed repo file that names the branch: no refusal, that branch (the repo layer is a layer too)', async () => {
    const dir = repo({ branch: 'feature' });
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config', 'mdsync.json'), '{"branch":"notes"}\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-qm', 'repo config');
    sh(dir, 'checkout', '-q', '--detach');
    const r = await forDir(dir);
    expect(r.kind === 'ok' && r.layers.detected?.branch).toBe('notes');
  });

  test('a rebase in progress: the branch being rebased', async () => {
    const dir = repo({ branch: 'notes' });
    sh(dir, 'checkout', '-q', '--detach');
    mkdirSync(join(dir, '.git', 'rebase-merge'));
    writeFileSync(join(dir, '.git', 'rebase-merge', 'head-name'), 'refs/heads/notes\n');
    const r = await forDir(dir);
    expect(r.kind === 'ok' && r.layers.detected?.branch).toBe('notes');
  });

  test('an mdsync move interrupted before it re-attached HEAD: the branch in its journal', async () => {
    const dir = repo({ branch: 'notes' });
    const sha = sh(dir, 'rev-parse', 'HEAD');
    sh(dir, 'checkout', '-q', '--detach');
    const paths = statePathsFor(canonicalDir(dir), env);
    mkdirSync(paths.stateDir, { recursive: true });
    writeJournal(paths.journal, { move: { op: 'move', reason: 'branch-fix', phase: 'writing', from: sha,
      head: { sha, ref: 'detached' }, to: sha, base: sha, ref: { kind: 'update', ref: 'refs/heads/notes', old: sha, head: 'attach' },
      index: 'changed-paths', temps: [], copies: [], startedAt: new Date().toISOString() } });
    const r = await forDir(dir);
    expect(r.kind === 'ok' && r.layers.detected?.branch).toBe('notes');
  });
});

test('hasUserinfo: URLs with a user (or token) before the host', () => {
  expect(hasUserinfo('https://user:token@github.com/me/notes.git')).toBe(true);
  expect(hasUserinfo('https://ghp_abc@github.com/me/notes.git')).toBe(true);
  expect(hasUserinfo('ssh://git@github.com/me/notes.git')).toBe(true);
  expect(hasUserinfo('https://github.com/me/notes.git')).toBe(false);
  expect(hasUserinfo('git@github.com:me/notes.git')).toBe(false);   // scp-like: the user is not a secret
  expect(hasUserinfo('/srv/git/notes.git')).toBe(false);
});
