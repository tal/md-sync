import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureRepo } from '../../src/bootstrap';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, loadEffectiveConfig } from '../../src/context';
import { createGitClient } from '../../src/git';
import { shortHostname } from '../../src/host';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { preflight } from '../../src/preflight';
import {
  cleanupAll, cloneRemote, CONFLICT_COPY_RE, createRemote, DEFAULT_AUTHOR, emptyDir, type LogLine, type Remote, setupTestEnv, type TestEnv,
} from '../harness';

let t: TestEnv;
let remote: Remote;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  t = await setupTestEnv('bootstrap');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
  remote = await createRemote(t);
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

function input(realDir: string, o: { remote?: string; branch?: string } = {}) {
  const config: ReadyConfig = { dir: realDir, branch: o.branch ?? 'main', idleMs: 60_000, fallbackMs: 3_600_000,
    maxWaitMs: 120_000, autoCommit: 'timers', ignore: [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid',
    ...(o.remote !== undefined ? { remote: o.remote } : {}) };
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => logs.push(JSON.parse(l) as LogLine) });
  return { o: { realDir, config, log, git: createGitClient({ cwd: realDir, identity: { name: 'x', email: 'x@x' }, log }) }, logs };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...t.env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} exited ${code}`);
  return out.trim();
}

const msgs = (logs: LogLine[], msg: string) => logs.filter((l) => l.msg === msg);

describe('ensureRepo', () => {
  test('clones into an empty dir; .git/config equals a plain clone', async () => {
    const dir = emptyDir(t, `empty-${++n}`);
    const { o, logs } = input(dir, { remote: remote.url });
    expect(await ensureRepo(o, 'may-clone')).toEqual({ kind: 'ready', cloned: 'cloned' });
    expect(await git(dir, ['rev-parse', 'HEAD'])).toBe((await remote.head()) as string);
    expect(msgs(logs, 'cloning')[0]!.remote).toBe(remote.url);
    expect(msgs(logs, 'cloned')[0]!.head).toBe((await remote.head()) as string);
    const ref = await cloneRemote(t, remote, `reference-${n}`);
    const cfg = (d: string) => git(d, ['config', '--local', '--list']);
    expect(await cfg(dir)).toBe(await cfg(ref.dir));
  });

  test('the clone runs with --no-checkout; files an agent writes before the first run are kept', async () => {
    // A plain clone paused in its checkout replaced a file an agent had just written with the remote's bytes, and
    // exited 0. The clone now writes no file at all; the first run's P1b populates the folder with a move.
    const r = await createRemote(t, { files: { 'README.md': '# notes\n', 'note.md': 'remote note\n', 'd/x.md': 'x\n' } });
    const dir = emptyDir(t, `agent-${++n}`);
    const { o, logs } = input(dir, { remote: r.url });
    expect(await ensureRepo(o, 'may-clone')).toEqual({ kind: 'ready', cloned: 'cloned' });
    const clone = logs.find((l) => l.msg === 'git' && (l.args as string[]).includes('clone'));
    expect(clone?.args).toContain('--no-checkout');
    expect(readdirSync(dir)).toEqual(['.git']);
    expect(existsSync(join(dir, '.git', 'index'))).toBe(false);
    // an agent writes into the folder before the first run: one file identical to the remote's, one different
    writeFileSync(join(dir, 'README.md'), '# notes\n');
    writeFileSync(join(dir, 'note.md'), 'agent note\n');
    const paths = statePathsFor(dir, t.env);
    ensureStateDir(paths);
    const ctx = await createRunContext({ config: { ...o.config, dir }, realDir: dir, paths, log: o.log });
    const ino = statSync(join(dir, 'README.md')).ino;
    const pf = await preflight(ctx, { keptStashes: [], cloned: 'fresh-clone' });
    expect(pf.kind === 'ready' ? pf.actions : pf).toEqual(['clone-completed']);
    expect(logs.filter((l) => l.msg === 'recovered')).toEqual([]);   // after this process's own clone: `cloned` said it
    expect(statSync(join(dir, 'README.md')).ino).toBe(ino);           // identical: kept as it is, never rewritten
    expect(readFileSync(join(dir, 'note.md'), 'utf8')).toBe('remote note\n');
    const copies = readdirSync(dir).filter((f) => CONFLICT_COPY_RE.test(f));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0] as string), 'utf8')).toBe('agent note\n');
    expect(readFileSync(join(dir, 'd', 'x.md'), 'utf8')).toBe('x\n');
    expect(await git(dir, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
  });

  test('an empty remote leaves an unborn HEAD pointing at the configured branch', async () => {
    const empty = await createRemote(t, { seed: 'empty' });
    const dir = emptyDir(t, `empty-${++n}`);
    const { o, logs } = input(dir, { remote: empty.url, branch: 'notes' });
    expect(await ensureRepo(o, 'may-clone')).toEqual({ kind: 'ready', cloned: 'cloned' });
    expect(await git(dir, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/notes');
    expect(msgs(logs, 'cloned')[0]!.head).toBe('unborn');
  });

  test('an existing clone is accepted; a matching URL (modulo / and .git) logs nothing', async () => {
    const c = await cloneRemote(t, remote, `existing-${++n}`);
    const { o, logs } = input(c.dir, { remote: `${remote.url.replace(/\.git$/, '')}/.git/` });
    expect(await ensureRepo(o, 'existing-only')).toEqual({ kind: 'ready', cloned: 'existing' });
    expect(msgs(logs, 'remote mismatch')).toEqual([]);
  });

  test('a different origin URL warns with the set-url hint (redacted) and never rewrites .git/config', async () => {
    const c = await cloneRemote(t, remote, `mismatch-${++n}`);
    const before = readFileSync(join(c.dir, '.git', 'config'));
    const { o, logs } = input(c.dir, { remote: 'https://user:hunter2@example.com/notes.git' });
    expect(await ensureRepo(o, 'may-clone')).toEqual({ kind: 'ready', cloned: 'existing' });
    const warn = msgs(logs, 'remote mismatch');
    expect(warn).toHaveLength(1);
    expect(warn[0]!.level).toBe('warn');
    expect(warn[0]!.configured).toBe('https://***@example.com/notes.git');
    expect(warn[0]!.actual).toBe(remote.url);
    expect(warn[0]!.hint).toBe(`git -C ${c.dir} remote set-url origin https://***@example.com/notes.git`);
    expect(JSON.stringify(logs)).not.toContain('hunter2');
    expect(readFileSync(join(c.dir, '.git', 'config')).equals(before)).toBe(true);
  });

  test('no origin remote fails', async () => {
    const dir = emptyDir(t, `noorigin-${++n}`);
    await git(dir, ['init', '-q']);
    const { o } = input(dir, { remote: remote.url });
    expect(await ensureRepo(o, 'may-clone')).toEqual({ kind: 'failed', retry: 'final', error: `no "origin" remote in ${dir}` });
  });

  test('a dir inside another repository fails', async () => {
    const parent = emptyDir(t, `parent-${++n}`);
    await git(parent, ['init', '-q']);
    const dir = join(parent, 'sub');
    mkdirSync(join(dir, '.git'), { recursive: true });   // an empty .git dir: plain git would walk up to the parent
    const real = realpathSync(dir);
    const { o } = input(real, { remote: remote.url });
    // mdsync's git never searches above the folder (the ceiling): it is simply not a repository
    const r = await ensureRepo(o, 'may-clone');
    expect(r.kind === 'failed' && r.retry === 'final' && r.error.startsWith(`${real} is not a git repository`)).toBe(true);
    // a client that does search upward finds the parent, which is refused too
    const up = { ...o, git: createGitClient({ cwd: real, identity: { name: 'x', email: 'x@x' }, log: o.log, discovery: 'search-up' }) };
    expect(await ensureRepo(up, 'may-clone')).toEqual({ kind: 'failed', retry: 'final', error: `${real} is inside another repository` });
  });

  test('a non-empty non-repo dir fails in both modes', async () => {
    const dir = emptyDir(t, `full-${++n}`);
    writeFileSync(join(dir, 'x.md'), 'x');
    expect(await ensureRepo(input(dir, { remote: remote.url }).o, 'may-clone'))
      .toEqual({ kind: 'failed', retry: 'final', error: `${dir} is not empty and is not a git repository` });
    expect(await ensureRepo(input(dir, { remote: remote.url }).o, 'existing-only'))
      .toEqual({ kind: 'failed', retry: 'final', error: `${dir} is not a git repository` });
    const empty = emptyDir(t, `empty-${++n}`);
    expect(await ensureRepo(input(empty, { remote: remote.url }).o, 'existing-only'))
      .toEqual({ kind: 'failed', retry: 'final', error: `${empty} is not a git repository` });
  });

  test('an empty folder we cannot write (a bind mount Docker created as root) fails at once, saying what to do', async () => {
    if (process.getuid?.() === 0) return;   // root writes anywhere
    const dir = emptyDir(t, `ro-${++n}`);
    chmodSync(dir, 0o555);
    try {
      const { o } = input(dir, { remote: join(t.root, 'does-not-exist.git') });
      const r = await ensureRepo(o, 'may-clone');
      expect(r).toMatchObject({ kind: 'failed', retry: 'final' });
      if (r.kind === 'failed') expect(r.error).toContain(`${dir} is not writable by uid ${process.getuid?.()}`);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test('a failed clone logs `clone failed` with the failure kind', async () => {
    const dir = emptyDir(t, `bad-${++n}`);
    const { o, logs } = input(dir, { remote: join(t.root, 'does-not-exist.git') });
    const r = await ensureRepo(o, 'may-clone');
    expect(r).toMatchObject({ kind: 'failed', retry: 'retryable' });   // the daemon retries it on the network backoff
    const f = msgs(logs, 'clone failed');
    expect(f).toHaveLength(1);
    expect(f[0]!.failure).toBe('network');
    expect(String(f[0]!.error)).toContain('git clone exited 128');
    expect(msgs(logs, 'network error')[0]).toMatchObject({ op: 'clone', timedOut: 'in-time' });
  });
});

// context.ts has no test file of its own; bootstrap is its first consumer.
describe('createRunContext / loadEffectiveConfig', () => {
  async function repoWithConfig(text: string | 'none') {
    const r = await createRemote(t, { files: text === 'none' ? { 'README.md': 'r\n' } : { '.config/mdsync.json': text } });
    const c = await cloneRemote(t, r, `ctx-${++n}`);
    const logs: LogLine[] = [];
    const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => logs.push(JSON.parse(l) as LogLine) });
    const paths = statePathsFor(c.dir, t.env);
    return { c, r, logs, log, paths };
  }

  test('the repo layer is read from the committed blob and feeds ignore and the context', async () => {
    const { c, r, logs, log, paths } = await repoWithConfig(JSON.stringify({ ignore: ['drafts'], idleMs: 5_000,
      authorName: 'nope', future: 1 }));
    await c.write('.config/mdsync.json', '{"ignore": ["worktree-only"]}');   // the worktree copy is never read
    const eff = await loadEffectiveConfig({ realDir: c.dir, paths, log,
      layers: { cli: {}, instance: { dir: c.dir, remote: r.url, authorEmail: 'me@test.invalid' }, instancePath: 'none',
        detected: { branch: 'main' } } });   // what the commands read from the checkout (no built-in branch)
    expect(eff.config.ignore).toEqual(['drafts']);
    expect(eff.config.idleMs).toBe(5_000);
    expect(eff.config.authorName).toBe(DEFAULT_AUTHOR);
    expect(eff.sources).toMatchObject({ ignore: 'repo', idleMs: 'repo', authorEmail: 'instance', branch: 'checkout' });
    expect(eff.repo.blob).toBe(await git(c.dir, ['rev-parse', 'HEAD:.config/mdsync.json']));
    expect(eff.repo.layer).toEqual({ ignore: ['drafts'], idleMs: 5_000 });
    expect(eff.ctx.ignore.matches('drafts/x.md')).toBe(true);
    expect(eff.ctx.config).toEqual(eff.config);
    expect(logs.filter((l) => l.msg === 'repo config key ignored').map((l) => [l.key, l.reason]))
      .toEqual([['authorName', 'instance-only'], ['future', 'unknown']]);
  });

  test('an invalid repo config keeps the last good layer (or defaults) and still reports its blob', async () => {
    const { c, r, logs, log, paths } = await repoWithConfig('{"idleMs": "soon"}');
    const layers = { cli: {}, instance: { dir: c.dir, remote: r.url, branch: 'main' }, instancePath: 'none' as const };
    const a = await loadEffectiveConfig({ realDir: c.dir, paths, log, layers });
    expect(a.config.idleMs).toBe(300_000);
    expect(a.repo.layer).toEqual({});
    expect(a.repo.blob).not.toBe('none');
    expect(a.repo.state).toBe('unknown');
    expect(a.ctx.repoRules).toBe('unknown');
    const b = await loadEffectiveConfig({ realDir: c.dir, paths, log, layers, lastGoodRepo: { idleMs: 7_000 } });
    expect(b.config.idleMs).toBe(7_000);
    expect(b.repo.state).toBe('last-good');
    expect(b.ctx.repoRules).toBe('known');
    expect(logs.filter((l) => l.msg === 'repo config invalid').map((l) => [l.level, l.keeping]))
      .toEqual([['warn', 'defaults'], ['warn', 'last-good']]);
    expect(String((logs.find((l) => l.msg === 'repo config invalid')!.issues as string[])[0])).toContain('idleMs');
  });

  test('no branch from any layer: loadEffectiveConfig refuses (the commands report the missing key first)', async () => {
    const { c, r, log, paths } = await repoWithConfig('none');
    await expect(loadEffectiveConfig({ realDir: c.dir, paths, log,
      layers: { cli: {}, instance: { dir: c.dir, remote: r.url }, instancePath: 'none' } })).rejects.toThrow('no branch to sync');
  });

  test('no repo config: blob none; CLI > instance precedence; context fields', async () => {
    const { c, r, log, paths } = await repoWithConfig('none');
    const eff = await loadEffectiveConfig({ realDir: c.dir, paths, log, lastGoodRepo: { idleMs: 9_000 },
      layers: { cli: { ignore: ['cli'] }, instance: { dir: c.dir, remote: r.url, ignore: ['inst'], authorName: 'Me', branch: 'main' },
        instancePath: 'none' } });
    expect(eff.repo).toEqual({ blob: 'none', layer: {}, state: 'absent' });
    expect(eff.ctx.repoRules).toBe('known');
    expect(eff.config.idleMs).toBe(300_000);
    expect(eff.config.ignore).toEqual(['cli']);
    const ctx = eff.ctx;
    expect(ctx.realDir).toBe(c.dir);
    expect(ctx.gitDir).toBe(join(c.dir, '.git'));
    expect(ctx.branch).toBe('main');
    expect(ctx.host).toBe(shortHostname());
    expect(ctx.objectFormat).toBe('sha1');
    expect(ctx.emptyTree).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    const expectedCase = (await git(c.dir, ['config', '--get', 'core.ignorecase']).catch(() => 'false')) === 'true'
      ? 'case-insensitive' : 'case-sensitive';
    expect(ctx.ignoreCase).toBe(expectedCase);
    expect(ctx.git.cwd).toBe(c.dir);
    // identity reaches commits made through the context's client
    await c.write('x.md', 'x');
    await ctx.git.ok(['add', 'x.md']);
    await ctx.git.ok(['commit', '-qm', 'via ctx']);
    expect(await git(c.dir, ['log', '-1', '--format=%an|%cn'])).toBe('Me|Me');
  });

  test('ignoreCase follows core.ignorecase', async () => {
    const { c, r, log, paths } = await repoWithConfig('none');
    await git(c.dir, ['config', 'core.ignorecase', 'false']);
    const cfg: ReadyConfig = { dir: c.dir, remote: r.url, branch: 'main', idleMs: 60_000, fallbackMs: 3_600_000,
      maxWaitMs: 120_000, autoCommit: 'timers', ignore: [], authorName: 'a', authorEmail: 'a@a' };
    expect((await createRunContext({ config: cfg, realDir: c.dir, paths, log })).ignoreCase).toBe('case-sensitive');
    await git(c.dir, ['config', 'core.ignorecase', 'true']);
    expect((await createRunContext({ config: cfg, realDir: c.dir, paths, log })).ignoreCase).toBe('case-insensitive');
  });
});
