import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLOBAL_ARGS, GitError, GitNotFoundError, NETWORK_MAX_MS, callConfig, parseGitVersion, requireGitVersion, NETWORK_TIMEOUT_MS, SHUTDOWN_DEADLINE_ERROR, SHUTDOWN_NET_MARGIN_MS,
  absoluteGitDir, catBlob, classifyFailure, createGitClient, credentialEnv, currentBranchRef, effectiveTimeoutMs,
  emptyTree, gitArgv, gitEnv, hashPaths, headSha, indexEntries, isAncestor, isMdsyncStash, lsTree, mergeBase,
  networkDeadline, objectExists, objectFormat, parseNul, revCount, revParse, setNetworkDeadline, stashIndexOf, stashTop,
  unmergedPaths, unmergedStages, writeBlob,
} from '../../src/git';
import { createLogger } from '../../src/log';
import { LOCAL_TIMEOUT_MS, liveChildPids } from '../../src/spawn';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-git-args-')));
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
  'GIT_TOKEN', 'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'PATH'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const identity = { name: 'mdsync-test', email: 'mdsync-test@test.invalid' };
const logLines: string[] = [];
const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => logLines.push(l) });
let n = 0;

beforeAll(() => {
  writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
  for (const k of ENV_KEYS) if (k !== 'PATH') delete process.env[k];
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
});

afterAll(() => {
  setNetworkDeadline('none');
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  setNetworkDeadline('none');
  delete process.env.GIT_TOKEN;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
});

function sh(cwd: string, args: string[], input?: string): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 'Helper', GIT_AUTHOR_EMAIL: 'h@test.invalid',
      GIT_COMMITTER_NAME: 'Helper', GIT_COMMITTER_EMAIL: 'h@test.invalid' },
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function newRepo(name = 'repo'): string {
  const dir = join(root, `${name}-${++n}`);
  mkdirSync(dir);
  sh(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function commitFiles(dir: string, files: Record<string, string>, message: string): string {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', message]);
  return sh(dir, ['rev-parse', 'HEAD']).trim();
}

function envLines(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) m.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return m;
}

// `git -c alias.x='!env' x` prints the environment git hands to its children.
const ENV_ALIAS = ['-c', 'alias.mdsync-env=!env', 'mdsync-env'];

describe('argv', () => {
  test('GLOBAL_ARGS is exactly the pinned prefix', () => {
    expect([...GLOBAL_ARGS]).toEqual([
      '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'rerere.enabled=false',
      '-c', 'gc.autoDetach=false', '-c', 'maintenance.autoDetach=false',
      '-c', 'merge.conflictStyle=merge',
      '-c', 'log.showSignature=false',
    ]);
  });

  test('gitArgv puts GLOBAL_ARGS between git and the args', () => {
    expect(gitArgv(['status', '--porcelain'])).toEqual(['git', ...GLOBAL_ARGS, 'status', '--porcelain']);
    expect(gitArgv(['--no-optional-locks', 'status'])).toEqual(['git', ...GLOBAL_ARGS, '--no-optional-locks', 'status']);
  });

  test('every spawned git sees exactly the GLOBAL_ARGS settings as command-line config, in order', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const out = await g.ok(['config', '--list', '--show-origin']);
    const fromCmdline = out.split('\n').filter((l) => l.startsWith('command line:')).map((l) => l.slice('command line:\t'.length));
    const expected: string[] = [];
    for (let i = 0; i < GLOBAL_ARGS.length; i += 2) {
      expect(GLOBAL_ARGS[i]).toBe('-c');
      const kv = GLOBAL_ARGS[i + 1]!;
      const eq = kv.indexOf('=');
      expect(eq).toBeGreaterThan(0);
      expected.push(kv.slice(0, eq).toLowerCase() + kv.slice(eq));
    }
    expect(fromCmdline).toEqual(expected);
  });
});

describe('env', () => {
  test('fixed keys and identity on every call, base env passed through', () => {
    const env = gitEnv(identity, { kind: 'local' }, { PATH: '/bin', CUSTOM_HOOK: 'x', LC_ALL: 'de_DE.UTF-8' });
    expect(env).toEqual({
      PATH: '/bin', CUSTOM_HOOK: 'x',
      GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'C',
      GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_PAGER: 'cat',
      GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    });
  });

  test('defaults to process.env', () => {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'remote.origin.uploadpack';
    process.env.GIT_CONFIG_VALUE_0 = '/x/race.sh';
    const env = gitEnv(identity, { kind: 'local' });
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('remote.origin.uploadpack');
    expect(env.HOME).toBe(process.env.HOME);
  });

  test('repo-locating variables never pass through; the ceiling is prepended to inherited ones', () => {
    const base = { PATH: '/bin', GIT_DIR: '/other/.git', GIT_WORK_TREE: '/other', GIT_COMMON_DIR: '/c', GIT_INDEX_FILE: '/i',
      GIT_OBJECT_DIRECTORY: '/o', GIT_NAMESPACE: 'n', GIT_PREFIX: 'p/', GIT_CEILING_DIRECTORIES: '/mnt' };
    const env = gitEnv(identity, { kind: 'local', ceiling: '/home/u' }, base);
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE', 'GIT_PREFIX']) {
      expect(k in env).toBe(false);
    }
    expect(env.GIT_CEILING_DIRECTORIES).toBe('/home/u:/mnt');
    expect(gitEnv(identity, { kind: 'local', ceiling: '/home/u' }, {}).GIT_CEILING_DIRECTORIES).toBe('/home/u');
    expect(gitEnv(identity, { kind: 'local', indexFile: '/s/i' }, base).GIT_INDEX_FILE).toBe('/s/i');
  });

  test('a client never finds a parent repository: a folder without its own .git is not a repo', async () => {
    // A synced folder that lost its .git inside another repo made every call act on that repo (r3).
    const parent = newRepo('parent');
    commitFiles(parent, { 'p.md': 'p\n' }, 'parent');
    mkdirSync(join(parent, 'notes'));
    const g = createGitClient({ cwd: join(parent, 'notes'), identity, log });
    const r = await g.run(['rev-parse', '--show-toplevel']);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain('not a git repository');
    const up = createGitClient({ cwd: join(parent, 'notes'), identity, log, discovery: 'search-up' });
    expect((await up.ok(['rev-parse', '--show-toplevel'])).trim()).toBe(realpathSync(parent));
  });

  test('GIT_INDEX_FILE only with indexFile', () => {
    expect('GIT_INDEX_FILE' in gitEnv(identity, { kind: 'local' }, {})).toBe(false);
    expect('GIT_INDEX_FILE' in gitEnv(identity, { kind: 'local', indexFile: '' }, {})).toBe(false);
    expect(gitEnv(identity, { kind: 'local', indexFile: '/s/h.tmp/idx' }, {}).GIT_INDEX_FILE).toBe('/s/h.tmp/idx');
  });

  test('a spawned git gets the env, GIT_INDEX_FILE only when asked', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const plain = envLines(await g.ok(ENV_ALIAS));
    expect(plain.get('GIT_AUTHOR_NAME')).toBe(identity.name);
    expect(plain.get('GIT_COMMITTER_EMAIL')).toBe(identity.email);
    expect(plain.get('LC_ALL')).toBe('C');
    expect(plain.get('GIT_TERMINAL_PROMPT')).toBe('0');
    expect(plain.get('GIT_EDITOR')).toBe('true');
    expect(plain.has('GIT_INDEX_FILE')).toBe(false);

    const idx = join(root, `idx-${++n}`);
    const withIndex = envLines(await g.ok(ENV_ALIAS, { indexFile: idx }));
    expect(withIndex.get('GIT_INDEX_FILE')).toBe(idx);
  });

  test('a temporary index leaves the real index alone', async () => {
    const dir = newRepo();
    commitFiles(dir, { 'a.md': 'a\n' }, 'one');
    const g = createGitClient({ cwd: dir, identity, log });
    const idx = join(root, `idx-${++n}`);
    await g.ok(['read-tree', '--empty'], { indexFile: idx });
    expect((await g.ok(['ls-files', '-z'], { indexFile: idx }))).toBe('');
    expect(parseNul(await g.ok(['ls-files', '-z']))).toEqual(['a.md']);
  });
});

describe('credentialEnv', () => {
  const HELPER = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GIT_TOKEN"; }; f';

  test('nothing without a token', () => {
    expect(credentialEnv({})).toEqual({});
    expect(credentialEnv({ GIT_TOKEN: '' })).toEqual({});
  });

  test('reset + helper as entries 0 and 1 when there are none', () => {
    expect(credentialEnv({ GIT_TOKEN: 'tok' })).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: HELPER,
    });
  });

  test('appended after existing GIT_CONFIG_COUNT entries', () => {
    const base = { GIT_TOKEN: 'tok', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'remote.origin.uploadpack', GIT_CONFIG_VALUE_0: '/r.sh',
      GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '*' };
    const env = gitEnv(identity, { kind: 'network' }, base);
    expect(env.GIT_CONFIG_COUNT).toBe('4');
    expect(env.GIT_CONFIG_KEY_0).toBe('remote.origin.uploadpack');
    expect(env.GIT_CONFIG_VALUE_0).toBe('/r.sh');
    expect(env.GIT_CONFIG_KEY_1).toBe('safe.directory');
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_2).toBe('');
    expect(env.GIT_CONFIG_KEY_3).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_3).toBe(HELPER);
  });

  test('an unparsable GIT_CONFIG_COUNT counts as 0', () => {
    expect(credentialEnv({ GIT_TOKEN: 't', GIT_CONFIG_COUNT: 'abc' }).GIT_CONFIG_COUNT).toBe('2');
  });

  test('only network calls get the helper; the token never enters argv', () => {
    const base = { GIT_TOKEN: 'tok' };
    expect(gitEnv(identity, { kind: 'local' }, base).GIT_CONFIG_COUNT).toBeUndefined();
    expect(gitEnv(identity, { kind: 'network' }, base).GIT_CONFIG_COUNT).toBe('2');
    expect(gitArgv(['fetch']).join(' ')).not.toContain('tok');
  });

  test('end to end over HTTP: the helper answers with the token, earlier entries survive, nothing is logged', async () => {
    const seen: { auth: string | null; ua: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        seen.push({ auth: req.headers.get('authorization'), ua: req.headers.get('user-agent') });
        return new Response('no', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="t"' } });
      },
    });
    try {
      const dir = newRepo();
      const url = `http://127.0.0.1:${server.port}/notes.git`;
      const g = createGitClient({ cwd: dir, identity, log });
      const token = 'tok-' + crypto.randomUUID();
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'http.userAgent';
      process.env.GIT_CONFIG_VALUE_0 = 'mdsync-ua-probe';
      const mark = logLines.length;

      // no token: no helper, no prompt
      const anon = await g.run(['fetch', '--no-tags', url, '+refs/heads/main:refs/remotes/origin/main'], { kind: 'network' });
      expect(anon.code).toBe(128);
      expect(anon.stderr).toContain('could not read Username');
      expect(classifyFailure(anon, 'fetch')).toBe('auth');

      process.env.GIT_TOKEN = token;
      // local kind: still no helper
      const local = await g.run(['fetch', '--no-tags', url], { kind: 'local' });
      expect(local.stderr).toContain('could not read Username');

      seen.length = 0;
      const withToken = await g.run(['fetch', '--no-tags', url, '+refs/heads/main:refs/remotes/origin/main'], { kind: 'network' });
      expect(withToken.code).toBe(128);
      expect(withToken.stderr).toContain('Authentication failed');
      expect(classifyFailure(withToken, 'fetch')).toBe('auth');
      const expected = 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64');
      expect(seen.some((s) => s.auth === expected)).toBe(true);
      expect(seen.every((s) => s.ua === 'mdsync-ua-probe')).toBe(true);   // the pre-existing entry 0 still applied

      const logged = logLines.slice(mark).join('\n');
      expect(logged).toContain('"msg":"git"');
      expect(logged).not.toContain(token);
    } finally {
      server.stop(true);
    }
  });
});

describe('network deadline', () => {
  test('defaults: local and network timeouts, overrides', () => {
    expect(networkDeadline()).toBe('none');
    expect(effectiveTimeoutMs('local')).toBe(LOCAL_TIMEOUT_MS);
    expect(effectiveTimeoutMs('network')).toBe(NETWORK_TIMEOUT_MS);
    expect(effectiveTimeoutMs('network', 5_000)).toBe(5_000);
    expect(effectiveTimeoutMs('local', 7_000)).toBe(7_000);
    expect(NETWORK_TIMEOUT_MS).toBe(120_000);
    expect(NETWORK_MAX_MS).toBe(1_800_000);
  });

  test('clamps network ops to end SHUTDOWN_NET_MARGIN_MS before the deadline', () => {
    const now = 1_000_000;
    setNetworkDeadline(now + 240_000);
    expect(networkDeadline()).toBe(now + 240_000);
    expect(effectiveTimeoutMs('network', undefined, now)).toBe(NETWORK_TIMEOUT_MS);
    expect(effectiveTimeoutMs('network', undefined, now + 200_000)).toBe(240_000 - 200_000 - SHUTDOWN_NET_MARGIN_MS);
    expect(effectiveTimeoutMs('network', 10_000, now + 200_000)).toBe(10_000);
    expect(effectiveTimeoutMs('network', 60_000, now + 200_000)).toBe(25_000);
    expect(effectiveTimeoutMs('network', undefined, now + 240_000 - SHUTDOWN_NET_MARGIN_MS)).toBe('deadline-reached');
    expect(effectiveTimeoutMs('network', undefined, now + 239_000)).toBe('deadline-reached');
    expect(effectiveTimeoutMs('local', undefined, now + 239_000)).toBe(LOCAL_TIMEOUT_MS);   // local ops are never clamped
    setNetworkDeadline('none');
    expect(effectiveTimeoutMs('network', undefined, now + 239_000)).toBe(NETWORK_TIMEOUT_MS);
  });

  test('a network op that keeps reporting progress outlives its no-progress limit; a silent one does not', async () => {
    // A slow but working link used to be killed at a fixed 120 s and restarted from zero, forever.
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const ticking = ['-c', 'alias.ticking=!f() { for i in 1 2 3 4 5 6 7 8; do echo "Receiving objects: $i" >&2; sleep 0.2; done; }; f', 'ticking'];
    const busy = await g.run(ticking, { kind: 'network', timeoutMs: 600 });
    expect({ code: busy.code, timedOut: busy.timedOut }).toEqual({ code: 0, timedOut: 'in-time' });
    expect(busy.durationMs).toBeGreaterThan(1_200);
    const silent = await g.run(['-c', 'alias.silent=!sleep 3', 'silent'], { kind: 'network', timeoutMs: 600 });
    expect(silent.timedOut).toBe('timed-out');
    // local ops have no progress rule: the whole op is bounded
    const local = await g.run(ticking, { timeoutMs: 600 });
    expect(local.timedOut).toBe('timed-out');
  }, 30_000);

  test('past the deadline a network op is not spawned', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    setNetworkDeadline(Date.now() + SHUTDOWN_NET_MARGIN_MS - 1);
    const before = new Set(liveChildPids());
    const p = g.run(['version'], { kind: 'network' });
    expect([...liveChildPids()].filter((x) => !before.has(x))).toEqual([]);
    const r = await p;
    expect(r).toEqual({ code: -1, stdout: '', stderr: '', timedOut: 'in-time', durationMs: 0, spawnError: SHUTDOWN_DEADLINE_ERROR });
    expect(SHUTDOWN_DEADLINE_ERROR).toBe('shutdown deadline reached');
    expect(classifyFailure(r, 'push')).toBe('network');
    const b = await g.bytes(['version'], { kind: 'network' });
    expect(b.code).toBe(-1);
    expect(b.stdout).toBeInstanceOf(Uint8Array);
    expect(await g.ok(['version'])).toStartWith('git version');   // local ops still run
  });

  test('a network op running into the clamp is killed as a timeout', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    setNetworkDeadline(Date.now() + SHUTDOWN_NET_MARGIN_MS + 400);
    const started = Date.now();
    const r = await g.run(['-c', 'alias.mdsync-sleep=!sleep 20', 'mdsync-sleep'], { kind: 'network' });
    expect(r.timedOut).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(classifyFailure(r, 'fetch')).toBe('network');
  });
});

describe('client', () => {
  test('run never throws on failure; ok throws GitError with a local classification', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const r = await g.run(['rev-parse', '--verify', 'nope']);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain('Needed a single revision');
    let caught: unknown;
    try {
      await g.ok(['rev-parse', '--verify', 'nope']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitError);
    const ge = caught as GitError;
    expect(ge.args).toEqual(['rev-parse', '--verify', 'nope']);
    expect(ge.result.code).toBe(128);
    expect(ge.failure).toBe('other');
    expect(ge.message).toBe('git rev-parse exited 128: fatal: Needed a single revision');
  });

  test('a locked index makes ok throw with failure locked', async () => {
    const dir = newRepo();
    writeFileSync(join(dir, 'a.md'), 'a');
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    const g = createGitClient({ cwd: dir, identity, log });
    let caught: unknown;
    try {
      await g.ok(['add', '-A']);
    } catch (e) {
      caught = e;
    }
    expect((caught as GitError).failure).toBe('locked');
  });

  test('ok strips trailing newlines only; run and bytes return raw output', async () => {
    const dir = newRepo();
    const sha = commitFiles(dir, { ' lead.md': 'x\n', 'b.md': 'line\r\n\n' }, 'one');
    const g = createGitClient({ cwd: dir, identity, log });
    expect(await g.ok(['rev-parse', 'HEAD'])).toBe(sha);
    expect((await g.run(['rev-parse', 'HEAD'])).stdout).toBe(sha + '\n');
    expect(parseNul(await g.ok(['ls-files', '-z']))).toEqual([' lead.md', 'b.md']);   // leading space kept
    const blob = await g.bytes(['cat-file', 'blob', 'HEAD:b.md']);
    expect([...blob.stdout]).toEqual([...new TextEncoder().encode('line\r\n\n')]);
  });

  test('string and byte input go to stdin; commits carry the configured identity', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const tree = await emptyTree(g);
    const c = await g.ok(['commit-tree', '--no-gpg-sign', '-F', '-', tree], { input: 'subject line\n\nbody\n' });
    expect(await g.ok(['log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', c]))
      .toBe(`${identity.name} <${identity.email}>|${identity.name} <${identity.email}>|subject line`);
  });

  test('durable: per-call config before the subcommand, also in the debug log', async () => {
    expect(callConfig({})).toEqual([]);
    expect(callConfig({ durable: 'durable' })).toEqual(['-c', 'core.fsync=committed', '-c', 'core.fsyncMethod=batch']);
    const env = gitEnv(identity, { kind: 'local' }, {});
    expect([env.GIT_AUTHOR_NAME, env.GIT_COMMITTER_NAME]).toEqual([identity.name, identity.name]);
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const c = await g.ok(['commit-tree', '--no-gpg-sign', '-F', '-', await emptyTree(g)], { input: 'm\n', durable: 'durable' });
    expect(await g.ok(['log', '-1', '--format=%an|%cn', c])).toBe(`${identity.name}|${identity.name}`);
    const args = logLines.map((l) => JSON.parse(l) as { msg: string; args?: string[] }).filter((l) => l.msg === 'git' && l.args?.includes('commit-tree'));
    expect(args.at(-1)?.args?.slice(0, 4)).toEqual(['-c', 'core.fsync=committed', '-c', 'core.fsyncMethod=batch']);
  });

  test('requireGitVersion: 2.40 or newer (merge-tree --merge-base, --attr-source)', async () => {
    expect(parseGitVersion('git version 2.39.5\n')).toEqual([2, 39]);
    expect(parseGitVersion('git version 2.40.0')).toEqual([2, 40]);
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)')).toEqual([2, 50]);
    expect(parseGitVersion('nonsense')).toBe('unknown');
    const stub = (stdout: string) => ({ cwd: root, run: async () => ({ code: 0, stdout, stderr: '', timedOut: 'in-time' as const, durationMs: 1 }),
      bytes: async () => { throw new Error('unused'); }, ok: async () => stdout });
    await expect(requireGitVersion(stub('git version 2.39.5\n'))).rejects.toThrow('mdsync needs git 2.40 or newer (found 2.39.5)');
    await expect(requireGitVersion(stub('git version 2.40.0\n'))).resolves.toBeUndefined();
    await expect(requireGitVersion(stub('git version 2.50.1 (Apple Git-155)\n'))).resolves.toBeUndefined();
    await expect(requireGitVersion(createGitClient({ cwd: root, identity, log }))).resolves.toBeUndefined();   // this machine
  });

  test('cwd override', async () => {
    const a = newRepo();
    const b = newRepo();
    const g = createGitClient({ cwd: a, identity, log });
    expect(g.cwd).toBe(a);
    expect(await g.ok(['rev-parse', '--show-toplevel'], { cwd: b })).toBe(b);
  });

  test('logs a debug `git` line with args, code, durationMs, timedOut, and stderr only on failure', async () => {
    const dir = newRepo();
    const lines: string[] = [];
    const g = createGitClient({ cwd: dir, identity, log: createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(l) }) });
    await g.run(['rev-parse', '--git-dir']);
    await g.run(['rev-parse', '--verify', 'nope']);
    const [ok, bad] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ok).toMatchObject({ level: 'debug', msg: 'git', args: ['rev-parse', '--git-dir'], code: 0, timedOut: 'in-time' });
    expect(typeof ok!.durationMs).toBe('number');
    expect('stderr' in ok!).toBe(false);
    expect(bad).toMatchObject({ msg: 'git', code: 128 });
    expect(String(bad!.stderr)).toContain('Needed a single revision');
  });

  test('credentials in a URL argument are redacted in the log', async () => {
    const dir = newRepo();
    const lines: string[] = [];
    const g = createGitClient({ cwd: dir, identity, log: createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(l) }) });
    await g.run(['ls-remote', 'https://user:sekrit@127.0.0.1:1/x.git'], { kind: 'network', timeoutMs: 5_000 });
    expect(lines.join('\n')).not.toContain('sekrit');
  });

  test('a missing git binary throws GitNotFoundError', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    process.env.PATH = join(root, 'no-bin-here');
    try {
      await expect(g.run(['version'])).rejects.toBeInstanceOf(GitNotFoundError);
      await expect(g.ok(['version'])).rejects.toBeInstanceOf(GitNotFoundError);
    } finally {
      process.env.PATH = savedEnv.get('PATH');
    }
  });

  test('a missing cwd is a spawn error, not a throw', async () => {
    const g = createGitClient({ cwd: join(root, 'does-not-exist'), identity, log });
    const r = await g.run(['version']);
    expect(r.code).toBe(-1);
    expect(r.spawnError).toBeDefined();
    expect(classifyFailure(r, 'local')).toBe('other');
    expect(classifyFailure(r, 'fetch')).toBe('network');
  });
});

describe('helpers (real repo)', () => {
  test('parseNul', () => {
    expect(parseNul('')).toEqual([]);
    expect(parseNul('a\0b\0')).toEqual(['a', 'b']);
    expect(parseNul('a\0b')).toEqual(['a', 'b']);
    expect(parseNul('a\0\0')).toEqual(['a', '']);
  });

  test('headSha, revParse, currentBranchRef on unborn, born and detached HEADs', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    expect(await headSha(g)).toBe('unborn');
    expect(await revParse(g, 'HEAD')).toBe('none');
    expect(await currentBranchRef(g)).toBe('refs/heads/main');
    const sha = commitFiles(dir, { 'a.md': 'a\n' }, 'one');
    expect(await headSha(g)).toBe(sha);
    expect(await revParse(g, 'HEAD')).toBe(sha);
    expect(await revParse(g, 'HEAD:missing.md')).toBe('none');
    expect(await revParse(g, 'HEAD^3')).toBe('none');
    expect(await revParse(g, 'HEAD:a.md')).toMatch(/^[0-9a-f]{40}$/);
    sh(dir, ['checkout', '-q', '--detach']);
    expect(await currentBranchRef(g)).toBe('detached');
  });

  test('revParse outside a repository throws', async () => {
    const dir = join(root, `plain-${++n}`);
    mkdirSync(dir);
    const g = createGitClient({ cwd: dir, identity, log });
    process.env.GIT_CEILING_DIRECTORIES = root;
    try {
      await expect(revParse(g, 'HEAD')).rejects.toBeInstanceOf(GitError);
    } finally {
      delete process.env.GIT_CEILING_DIRECTORIES;
    }
  });

  test('objectExists, isAncestor, mergeBase, revCount', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const a = commitFiles(dir, { 'a.md': '1\n' }, 'a');
    const b = commitFiles(dir, { 'a.md': '2\n' }, 'b');
    sh(dir, ['checkout', '-q', '--orphan', 'other']);
    const o = commitFiles(dir, { 'o.md': 'o\n' }, 'o');
    expect(await objectExists(g, a)).toBe('present');
    expect(await objectExists(g, '0'.repeat(40))).toBe('absent');
    expect(await objectExists(g, 'zzz')).toBe('absent');
    expect(await isAncestor(g, a, b)).toBe('ancestor');
    expect(await isAncestor(g, b, a)).toBe('not-ancestor');
    expect(await isAncestor(g, '1'.repeat(40), b)).toBe('unknown');
    expect(await mergeBase(g, a, b)).toBe(a);
    expect(await mergeBase(g, b, o)).toBe('unrelated');
    expect(await revCount(g, `${a}..${b}`)).toBe(1);
    expect(await revCount(g, b)).toBe(2);
    expect(await revCount(g, `${b}..${a}`)).toBe(0);
    await expect(revCount(g, 'nope..HEAD')).rejects.toBeInstanceOf(GitError);
  });

  test('lsTree, catBlob, writeBlob, emptyTree, objectFormat, absoluteGitDir', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    commitFiles(dir, { 'a.md': 'a\n', 'sub/dir/b.md': 'b\r\n', ' sp ace.md': 's', 'ünï.md': 'u' }, 'one');
    symlinkSync('a.md', join(dir, 'link.md'));
    sh(dir, ['add', '-A']);
    sh(dir, ['commit', '-q', '-m', 'link']);
    mkdirSync(join(dir, 'sub', 'deeper'));
    const t = await lsTree(g, 'HEAD');
    expect([...t.keys()].sort()).toEqual([' sp ace.md', 'a.md', 'link.md', 'sub/dir/b.md', 'ünï.md'].sort());
    expect(t.get('a.md')).toEqual({ mode: '100644', type: 'blob', sha: await revParse(g, 'HEAD:a.md') as string });
    expect(t.get('link.md')!.mode).toBe('120000');
    expect(new TextDecoder().decode(await catBlob(g, t.get('sub/dir/b.md')!.sha))).toBe('b\r\n');
    // ls-tree --full-tree lists from the root even when run from a subdir
    expect((await lsTree(createGitClient({ cwd: join(dir, 'sub'), identity, log, discovery: 'search-up' }), 'HEAD')).has('a.md')).toBe(true);

    const bytes = new Uint8Array([0, 1, 2, 13, 10, 255]);
    const sha = await writeBlob(g, bytes);
    expect(await objectExists(g, sha)).toBe('present');
    expect([...await catBlob(g, sha)]).toEqual([...bytes]);
    await expect(catBlob(g, '0'.repeat(40))).rejects.toBeInstanceOf(GitError);

    expect(await emptyTree(g)).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect((await lsTree(g, await emptyTree(g))).size).toBe(0);
    expect(await objectFormat(g)).toBe('sha1');
    expect(await absoluteGitDir(g)).toBe(join(dir, '.git'));
  });

  test('objectFormat and emptyTree on a sha256 repo', async () => {
    const dir = join(root, `sha256-${++n}`);
    mkdirSync(dir);
    sh(dir, ['init', '-q', '--object-format=sha256']);
    const g = createGitClient({ cwd: dir, identity, log });
    expect(await objectFormat(g)).toBe('sha256');
    expect(await emptyTree(g)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hashPaths matches what git add stores, skips missing paths and dirs, handles symlinks and odd names', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const files = { 'a.md': 'a\n', 'sub/b.md': 'b\n', '"quoted.md': 'q', 'crlf.md': 'x\r\n' };
    commitFiles(dir, files, 'one');
    symlinkSync('a.md', join(dir, 'link.md'));
    writeFileSync(join(dir, 'nl\nname.md'), 'nl');
    sh(dir, ['add', '-A']);
    const idx = await indexEntries(g);
    const got = await hashPaths(g, ['a.md', 'sub/b.md', '"quoted.md', 'crlf.md', 'link.md', 'nl\nname.md', 'missing.md', 'sub', 'a.md']);
    expect([...got.keys()].sort()).toEqual(['"quoted.md', 'a.md', 'crlf.md', 'link.md', 'nl\nname.md', 'sub/b.md'].sort());
    for (const [p, sha] of got) expect(sha).toBe(idx.get(p)!.sha);
    expect((await hashPaths(g, [])).size).toBe(0);
  });

  test('hashPaths applies clean filters (autocrlf), as git add does', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    sh(dir, ['config', 'core.autocrlf', 'input']);
    writeFileSync(join(dir, 'w.md'), 'one\r\ntwo\r\n');
    sh(dir, ['add', '-A']);
    const idx = await indexEntries(g);
    expect((await hashPaths(g, ['w.md'])).get('w.md')).toBe(idx.get('w.md')!.sha);
    expect((await hashPaths(g, ['w.md'])).get('w.md')).toBe(await writeBlob(g, new TextEncoder().encode('one\ntwo\n')));
  });

  test('unmergedPaths, unmergedStages, indexEntries during a conflict', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    commitFiles(dir, { 'c.md': 'base\n', 'keep.md': 'k\n', 'del.md': 'd\n' }, 'base');
    sh(dir, ['checkout', '-q', '-b', 'side']);
    commitFiles(dir, { 'c.md': 'side\n', 'del.md': 'side edit\n' }, 'side');
    sh(dir, ['checkout', '-q', 'main']);
    sh(dir, ['rm', '-q', 'del.md']);
    commitFiles(dir, { 'c.md': 'main\n' }, 'main');
    expect(await unmergedPaths(g)).toEqual([]);
    const r = await g.run(['merge', 'side']);
    expect(r.code).toBe(1);
    expect((await unmergedPaths(g)).sort()).toEqual(['c.md', 'del.md']);
    const stages = await unmergedStages(g);
    expect(stages.get('c.md')).toHaveLength(3);
    expect(stages.get('del.md')).toHaveLength(2);   // stage 2 (ours) absent: deleted on main
    expect(stages.get('c.md')![0]).toBe(await revParse(g, 'HEAD~1:c.md') as string);   // stage 1 = base
    expect(stages.get('c.md')![1]).toBe(await revParse(g, 'HEAD:c.md') as string);     // stage 2 = ours
    const idx = await indexEntries(g);
    expect(idx.get('keep.md')!.stage).toBe(0);
    expect(idx.get('c.md')!.stage).toBe(1);
    expect(idx.get('del.md')!.stage).toBe(1);
  });

  test('stashTop, stashIndexOf, isMdsyncStash', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    commitFiles(dir, { 'a.md': 'a\n' }, 'one');
    expect(await stashTop(g)).toBe('none');
    expect(await stashIndexOf(g, '0'.repeat(40))).toBe('absent');

    writeFileSync(join(dir, 'a.md'), 'dirty 1\n');
    const s1 = (await g.ok(['stash', 'create'])).trim();
    await g.ok(['stash', 'store', '-m', 'mdsync pre-conflict', s1]);
    writeFileSync(join(dir, 'a.md'), 'dirty 2\n');
    const s2 = (await g.ok(['stash', 'create'])).trim();
    await g.ok(['stash', 'store', '-m', 'autostash', s2]);

    expect(await stashTop(g)).toEqual({ sha: s2, subject: 'autostash' });
    expect(await stashIndexOf(g, s2)).toBe(0);
    expect(await stashIndexOf(g, s1)).toBe(1);
    expect(await stashIndexOf(g, '0'.repeat(40))).toBe('absent');
    await g.ok(['stash', 'drop', '-q', 'stash@{0}']);
    expect(await stashTop(g)).toEqual({ sha: s1, subject: 'mdsync pre-conflict' });

    // `git stash push -m` records "On <branch>: <msg>"
    writeFileSync(join(dir, 'a.md'), 'dirty 3\n');
    await g.ok(['stash', 'push', '-q', '-m', 'mdsync pre-conflict']);
    expect((await stashTop(g) as { subject: string }).subject).toBe('On main: mdsync pre-conflict');

    expect(isMdsyncStash('autostash')).toBe(true);
    expect(isMdsyncStash('mdsync pre-conflict')).toBe(true);
    expect(isMdsyncStash('On main: mdsync pre-conflict')).toBe(true);
    expect(isMdsyncStash('WIP on main: abc123 one')).toBe(false);
    expect(isMdsyncStash('On main: my stuff')).toBe(false);
    expect(isMdsyncStash('')).toBe(false);
  });

  test('stashTop with refs/stash but no reflog is never an mdsync stash', async () => {
    const dir = newRepo();
    const g = createGitClient({ cwd: dir, identity, log });
    const sha = commitFiles(dir, { 'a.md': 'a\n' }, 'one');
    sh(dir, ['-c', 'core.logAllRefUpdates=false', 'update-ref', 'refs/stash', sha]);
    const top = await stashTop(g);
    expect(top).toEqual({ sha, subject: '' });
  });
});

test('per-repo SSH key safely reaches ssh and overrides inherited commands', async () => {
  const key = "/tmp/notes' key;$(false)";
  const env = gitEnv({ name: 't', email: 't@x' }, { kind: 'network', sshKey: key },
    { GIT_SSH_COMMAND: 'old', GIT_SSH_VARIANT: 'plink' });
  expect(env.GIT_SSH_VARIANT).toBe('ssh');
  const script = `ssh() { printf '%s\\n' "$@"; }; ${env.GIT_SSH_COMMAND}`;
  const p = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(await new Response(p.stdout).text()).toBe(`-i\n${key}\n-o\nIdentitiesOnly=yes\n-o\nBatchMode=yes\n-o\nControlPath=none\n`);
  expect(await p.exited).toBe(0);
  expect(gitEnv({ name: 't', email: 't@x' }, { kind: 'local' }, { GIT_SSH_COMMAND: 'old' }).GIT_SSH_COMMAND).toBe('old');
});

test('Git clients keep per-repo SSH identities isolated in child processes', async () => {
  const a = createGitClient({ cwd: root, identity, log, sshKey: '/keys/a' });
  const b = createGitClient({ cwd: root, identity, log, sshKey: '/keys/b' });
  const args = ['-c', 'alias.show-ssh=!printf "%s" "$GIT_SSH_COMMAND"', 'show-ssh'];
  const [first, second] = await Promise.all([a.ok(args), b.ok(args, { kind: 'network' })]);
  expect(first).toContain("-i '/keys/a'");
  expect(first).not.toContain('/keys/b');
  expect(second).toContain("-i '/keys/b'");
  expect(second).not.toContain('/keys/a');
});
