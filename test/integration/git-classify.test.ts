import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GitFailureKind, type GitResult, classifyFailure, createGitClient } from '../../src/git';
import { createLogger } from '../../src/log';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-git-classify-')));
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_TOKEN'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const identity = { name: 'mdsync-test', email: 'mdsync-test@test.invalid' };
const log = createLogger({ level: 'error', sink: 'stdout', write: () => {} });

beforeAll(() => {
  writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
});

afterAll(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function res(o: Partial<GitResult>): GitResult {
  return { code: 1, stdout: '', stderr: '', timedOut: 'in-time', durationMs: 1, ...o };
}

describe('probe strings', () => {
  const lockPath = '/home/u/notes/.git';
  const cases: [string, GitResult, 'fetch' | 'push' | 'clone' | 'local', GitFailureKind][] = [
    // locked
    ['commit with index.lock (128)',
      res({ code: 128, stderr: `fatal: Unable to create '${lockPath}/index.lock': File exists.\n\nAnother git process seems to be running in this repository, or the lock file may be stale\n` }),
      'local', 'locked'],
    ['fetch with a ref lock (1)',
      res({ code: 1, stderr: `error: cannot lock ref 'refs/remotes/origin/main': Unable to create '${lockPath}/refs/remotes/origin/main.lock': File exists.\n ! 1137a2e...421ca96 main       -> origin/main  (unable to update local ref)\n` }),
      'fetch', 'locked'],
    ['packed-refs.lock', res({ code: 128, stderr: `fatal: Unable to create '${lockPath}/packed-refs.lock': File exists.` }), 'local', 'locked'],
    ['commit: cannot lock ref HEAD', res({ code: 128, stderr: "fatal: cannot lock ref 'HEAD': is at abc but expected def" }), 'local', 'locked'],
    // non-ff
    ['push porcelain fetch first',
      res({ code: 1, stdout: 'To /r.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n',
        stderr: "error: failed to push some refs to '/r.git'\nhint: Updates were rejected because the remote contains work that you do not\n" }),
      'push', 'non-ff'],
    ['push porcelain non-fast-forward',
      res({ code: 1, stdout: 'To /r.git\n!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)\nDone\n' }),
      'push', 'non-ff'],
    ['push human-readable fetch first',
      res({ code: 1, stderr: 'To /r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'/r.git\'\n' }),
      'push', 'non-ff'],
    // r4: the remote ref moved between the advertisement and our update (another device pushed at the same moment)
    ['push lost the remote ref race (git receive-pack)',
      res({ code: 1, stdout: 'To /r.git\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (incorrect old value provided)\nDone\n',
        stderr: "remote: error: cannot lock ref 'refs/heads/main': is at f87825f14a4f6df84e44d5b85c0899d5035c3485 but expected 72d6e3ff995219d51bd0282bf37592de2a67311f        \nerror: failed to push some refs to '/r.git'\n" }),
      'push', 'non-ff'],
    ['push lost the remote ref race (GitHub)',
      res({ code: 1, stderr: "To github.com:u/notes.git\n ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main': is at abc but expected def)\nerror: failed to push some refs\n" }),
      'push', 'non-ff'],
    ['push: a local tracking-ref lock is still a lock',
      res({ code: 1, stderr: `error: cannot lock ref 'refs/remotes/origin/main': Unable to create '${lockPath}/refs/remotes/origin/main.lock': File exists.\n` }),
      'push', 'locked'],
    ['[rejected] for another reason is not non-ff',
      res({ code: 1, stdout: '!\trefs/heads/main:refs/heads/main\t[rejected] (stale info)\n' }), 'push', 'other'],
    // remote rejected
    ['hook / protected branch',
      res({ code: 1, stdout: '!\trefs/heads/main:refs/heads/main\t[remote rejected] (pre-receive hook declined)\nDone\n',
        stderr: 'remote: GH006: Protected branch update failed\n' }),
      'push', 'remote-rejected'],
    ['denyCurrentBranch',
      res({ code: 1, stdout: '!\trefs/heads/main:refs/heads/main\t[remote rejected] (branch is currently checked out)\n' }),
      'push', 'remote-rejected'],
    // missing remote ref
    ['empty remote fetch', res({ code: 128, stderr: "fatal: couldn't find remote ref refs/heads/main\n" }), 'fetch', 'missing-remote-ref'],
    // auth
    ['https no credentials', res({ code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }), 'fetch', 'auth'],
    ['https bad token', res({ code: 128, stderr: "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/o/r.git/'\n" }), 'push', 'auth'],
    ['could not read Password', res({ code: 128, stderr: "fatal: could not read Password for 'https://x@h': No such device or address\n" }), 'clone', 'auth'],
    ['ssh key refused (auth wins over the network line that follows)',
      res({ code: 128, stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n' }),
      'fetch', 'auth'],
    ['terminal prompts disabled alone', res({ code: 128, stderr: 'fatal: terminal prompts disabled\n' }), 'push', 'auth'],
    // network (text)
    ['missing local path', res({ code: 128, stderr: "fatal: '/x/r.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n" }), 'fetch', 'network'],
    ['unable to access', res({ code: 128, stderr: "fatal: unable to access 'https://h/r.git/': Failed to connect to h port 443 after 3 ms: Couldn't connect to server\n" }), 'fetch', 'network'],
    ['dns', res({ code: 128, stderr: "fatal: unable to access 'https://nope.invalid/r.git/': Could not resolve host: nope.invalid\n" }), 'clone', 'network'],
    ['ssh dns', res({ code: 128, stderr: 'ssh: Could not resolve hostname nope: nodename nor servname provided, or not known\nfatal: Could not read from remote repository.\n' }), 'fetch', 'network'],
    ['ssh refused', res({ code: 128, stderr: 'ssh: connect to host h port 22: Connection refused\n' }), 'push', 'network'],
    ['ssh timed out', res({ code: 128, stderr: 'ssh: connect to host h port 22: Connection timed out\n' }), 'push', 'network'],
    ['macOS timeout', res({ code: 128, stderr: 'ssh: connect to host h port 22: Operation timed out\n' }), 'fetch', 'network'],
    ['hung up', res({ code: 128, stderr: 'fatal: The remote end hung up unexpectedly\n' }), 'fetch', 'network'],
    ['early EOF', res({ code: 128, stderr: 'fatal: early EOF\nfatal: fetch-pack: invalid index-pack output\n' }), 'fetch', 'network'],
    // network (structural)
    ['timeout, network op', res({ code: 143, timedOut: 'timed-out' }), 'push', 'network'],
    ['timeout, local op', res({ code: 137, timedOut: 'timed-out' }), 'local', 'network'],
    ['spawn error, network op', res({ code: -1, spawnError: 'EMFILE' }), 'fetch', 'network'],
    ['shutdown deadline (not spawned)', res({ code: -1, spawnError: 'shutdown deadline reached' }), 'push', 'network'],
    ['spawn error, local op', res({ code: -1, spawnError: 'EMFILE' }), 'local', 'other'],
    ['unknown 128 on a network op', res({ code: 128, stderr: 'fatal: repository \'https://h/r.git/\' not found\n' }), 'clone', 'network'],
    // other
    ['unknown 128 on a local op', res({ code: 128, stderr: 'fatal: Needed a single revision\n' }), 'local', 'other'],
    ['network text on a local op still counts', res({ code: 128, stderr: 'fatal: early EOF\n' }), 'local', 'network'],
    ['fetch exit 1 with no known text', res({ code: 1, stderr: 'error: something odd\n' }), 'fetch', 'other'],
    ['invalid upstream', res({ code: 128, stderr: 'fatal: invalid upstream \'origin/main\'\n' }), 'local', 'other'],
  ];

  for (const [name, r, op, kind] of cases) {
    test(`${name} -> ${kind}`, () => {
      expect(classifyFailure(r, op)).toBe(kind);
    });
  }

  test('rule order: locked beats non-ff, non-ff beats remote-rejected, missing ref beats network 128', () => {
    expect(classifyFailure(res({ stdout: '[rejected] (fetch first)', stderr: "cannot lock ref 'refs/heads/main'" }), 'push')).toBe('locked');
    expect(classifyFailure(res({ stdout: '[rejected] (non-fast-forward)\n[remote rejected] (hook)' }), 'push')).toBe('non-ff');
    expect(classifyFailure(res({ code: 128, stderr: "fatal: couldn't find remote ref refs/heads/main" }), 'fetch')).toBe('missing-remote-ref');
    expect(classifyFailure(res({ code: 128, stderr: 'fatal: Authentication failed\nfatal: unable to access' }), 'fetch')).toBe('auth');
  });

  test('matches stdout as well as stderr', () => {
    expect(classifyFailure(res({ stdout: 'early EOF' }), 'local')).toBe('network');
    expect(classifyFailure(res({ stdout: "couldn't find remote ref x" }), 'fetch')).toBe('missing-remote-ref');
  });
});

// The same rules against what this machine's git actually prints (LC_ALL=C via the client).
describe('real git failures', () => {
  let n = 0;
  const run = (cwd: string, args: string[]) => createGitClient({ cwd, identity, log }).run(args, { kind: 'network' });
  const local = (cwd: string, args: string[]) => createGitClient({ cwd, identity, log }).run(args);

  async function setup(): Promise<{ bare: string; a: string; b: string }> {
    const base = join(root, `s${++n}`);
    mkdirSync(base);
    const bare = join(base, 'r.git');
    expect((await local(base, ['init', '-q', '--bare', '-b', 'main', bare])).code).toBe(0);
    const a = join(base, 'a');
    const b = join(base, 'b');
    for (const dir of [a, b]) expect((await run(base, ['clone', '-q', '--', bare, dir])).code).toBe(0);
    return { bare, a, b };
  }

  async function commit(dir: string, msg: string): Promise<void> {
    writeFileSync(join(dir, `${msg}.md`), msg);
    expect((await local(dir, ['add', '-A'])).code).toBe(0);
    expect((await local(dir, ['commit', '-q', '--no-verify', '-m', msg])).code).toBe(0);
  }

  const push = (dir: string) => run(dir, ['push', '--porcelain', '--no-verify', 'origin', 'refs/heads/main:refs/heads/main']);
  const fetch = (dir: string) => run(dir, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);

  test('empty remote: fetch -> missing-remote-ref', async () => {
    const { a } = await setup();
    const r = await fetch(a);
    expect(r.code).toBe(128);
    expect(classifyFailure(r, 'fetch')).toBe('missing-remote-ref');
  });

  test('remote moved ahead: push -> non-ff (fetch first), then after a fetch -> non-ff (non-fast-forward)', async () => {
    const { a, b } = await setup();
    await commit(a, 'one');
    expect((await push(a)).code).toBe(0);
    expect((await fetch(b)).code).toBe(0);
    expect((await local(b, ['reset', '-q', '--hard', 'origin/main'])).code).toBe(0);
    await commit(a, 'two');
    expect((await push(a)).code).toBe(0);
    await commit(b, 'three');
    const first = await push(b);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain('(fetch first)');
    expect(classifyFailure(first, 'push')).toBe('non-ff');
    expect((await fetch(b)).code).toBe(0);
    const second = await push(b);
    expect(second.stdout).toContain('(non-fast-forward)');
    expect(classifyFailure(second, 'push')).toBe('non-ff');
  });

  test('checked-out branch on a non-bare remote: push -> remote-rejected', async () => {
    const base = join(root, `s${++n}`);
    mkdirSync(base);
    const origin = join(base, 'origin');
    expect((await local(base, ['init', '-q', '-b', 'main', origin])).code).toBe(0);
    await commit(origin, 'seed');
    const a = join(base, 'a');
    expect((await run(base, ['clone', '-q', '--', origin, a])).code).toBe(0);
    await commit(a, 'x');
    const r = await push(a);
    expect(r.code).toBe(1);
    expect(classifyFailure(r, 'push')).toBe('remote-rejected');
  });

  test('unreachable local remote: fetch -> network (128)', async () => {
    const { a } = await setup();
    const r = await run(a, ['fetch', '--no-tags', join(root, 'gone.git'), '+refs/heads/main:refs/remotes/origin/main']);
    expect(r.code).toBe(128);
    expect(classifyFailure(r, 'fetch')).toBe('network');
  });

  test('refused HTTP connection: fetch -> network', async () => {
    const { a } = await setup();
    const r = await run(a, ['fetch', '--no-tags', 'http://127.0.0.1:1/r.git']);
    expect(r.code).toBe(128);
    expect(classifyFailure(r, 'fetch')).toBe('network');
  });

  test('stale index.lock: commit -> locked; ref lock: fetch -> locked', async () => {
    const { a, b } = await setup();
    await commit(a, 'one');
    expect((await push(a)).code).toBe(0);
    writeFileSync(join(b, '.git', 'index.lock'), '');
    writeFileSync(join(b, 'x.md'), 'x');
    const add = await local(b, ['add', '-A']);
    expect(add.code).toBe(128);
    expect(classifyFailure(add, 'local')).toBe('locked');
    mkdirSync(join(b, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(b, '.git', 'refs', 'remotes', 'origin', 'main.lock'), '');
    const f = await fetch(b);
    expect(f.code).not.toBe(0);
    expect(classifyFailure(f, 'fetch')).toBe('locked');
  });
});
