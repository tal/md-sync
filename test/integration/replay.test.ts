// In-memory commit replay: the same result as `git rebase`, from raw commit objects, with
// objects written durably and nothing written into the worktree.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { parseRawCommit, replayCommits } from '../../src/replay';
import { cleanupAll, cloneRemote, type Clone, createRemote, type LogLine, type Remote, setupTestEnv, type TestEnv } from '../harness';

// real repos and git processes: the 5 s default is too tight on a loaded machine
setDefaultTimeout(60_000);

let t: TestEnv;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const FIVE = 'l1\nl2\nl3\nl4\nl5\n';

beforeAll(async () => {
  t = await setupTestEnv('replay');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

type Fx = { remote: Remote; c: Clone; ctx: RunContext; logs: LogLine[] };

async function out(c: Clone, args: string[], env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawnSync(['git', ...args], { cwd: c.dir, env: { ...t.env, ...env } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

async function fixture(): Promise<Fx> {
  return fixtureOn(await createRemote(t, { files: { 'README.md': '# notes\n', 'note.md': FIVE, 'other.md': 'o\n' } }));
}

async function fixtureOn(remote: Remote): Promise<Fx> {
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  const config: ReadyConfig = { dir: c.dir, remote: remote.url, branch: 'main', idleMs: 60_000, fallbackMs: 3_600_000,
    maxWaitMs: 120_000, autoCommit: 'timers', ignore: [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (line) => { logs.push(JSON.parse(line) as LogLine); } });
  return { remote, c, ctx: await createRunContext({ config, realDir: c.dir, paths, log }), logs };
}

async function commit(c: Clone, files: Record<string, string>, msg: string, env: Record<string, string> = {}): Promise<string> {
  for (const [p, body] of Object.entries(files)) await c.write(p, body);
  await out(c, ['add', '-A']);
  await out(c, ['commit', '-q', '-m', msg], env);
  return out(c, ['rev-parse', 'HEAD']);
}

async function fetchRemote(c: Clone): Promise<string> {
  await out(c, ['fetch', '-q', 'origin']);
  return out(c, ['rev-parse', 'refs/remotes/origin/main']);
}

describe('replayCommits', () => {
  test('a clean replay keeps messages, authors and author dates; the committer is the configured identity', async () => {
    const fx = await fixture();
    const env = { GIT_AUTHOR_NAME: 'Agent Smith', GIT_AUTHOR_EMAIL: 'smith@example.invalid', GIT_AUTHOR_DATE: '1700000000 +0530' };
    await commit(fx.c, { 'a.md': 'a\n' }, 'first local\n\nwith a body', env);
    const h = await commit(fx.c, { 'note.md': FIVE.replace('l5', 'L5') }, 'second local', env);
    await fx.remote.push({ 'note.md': FIVE.replace('l1', 'R1') }, 'remote');
    const r = await fetchRemote(fx.c);
    const before = await fx.c.porcelain();
    const res = await replayCommits(fx.ctx, { local: h, onto: r, upstream: r });
    expect(res).toMatchObject({ kind: 'clean', replayed: 2, dropped: 0, skipped: 0 });
    if (res.kind !== 'clean') return;
    expect(await out(fx.c, ['rev-parse', `${res.tip}~2`])).toBe(r);
    const fmt = await out(fx.c, ['log', '-2', '--format=%an|%ae|%at %ai|%cn|%B%x00', res.tip]);
    const [second, first] = fmt.split('\0').map((x) => x.trim());
    expect(second).toBe('Agent Smith|smith@example.invalid|1700000000 2023-11-15 03:43:20 +0530|mdsync-test|second local');
    expect(first).toBe('Agent Smith|smith@example.invalid|1700000000 2023-11-15 03:43:20 +0530|mdsync-test|first local\n\nwith a body');
    expect(await out(fx.c, ['show', `${res.tip}:note.md`])).toBe('R1\nl2\nl3\nl4\nL5');
    // nothing but objects: HEAD, the index and the worktree are untouched
    expect(await out(fx.c, ['rev-parse', 'HEAD'])).toBe(h);
    expect(await fx.c.porcelain()).toEqual(before);
    // the object-writing calls are durable (git's default fsyncs refs, not loose objects)
    const calls = fx.logs.filter((l) => l.msg === 'git').map((l) => l.args as string[]);
    for (const c of calls.filter((a) => a.includes('merge-tree') || a.includes('commit-tree'))) {
      expect(c.slice(0, 4)).toEqual(['-c', 'core.fsync=committed', '-c', 'core.fsyncMethod=batch']);
    }
  });

  test('commits that become empty are dropped; nothing left means tip == onto', async () => {
    const fx = await fixture();
    const h = await commit(fx.c, { 'note.md': FIVE.replace('l3', 'same') }, 'local');
    await fx.remote.push({ 'note.md': FIVE.replace('l3', 'same'), 'other.md': 'o2\n' }, 'remote did the same and more');
    const r = await fetchRemote(fx.c);
    const res = await replayCommits(fx.ctx, { local: h, onto: r, upstream: r });
    expect(res.kind).toBe('clean');
    if (res.kind !== 'clean') return;
    expect(res.tip).toBe(r);
    expect(res.replayed).toBe(0);
    expect(res.dropped + res.skipped).toBe(1);
  });

  test('a commit whose patch is already upstream is skipped, even when upstream later edited the same lines', async () => {
    // a device that pushed and crashed before recording it: replayed, its change conflicts with the later remote edit
    const fx = await fixture();
    const h = await commit(fx.c, { 'note.md': FIVE.replace('l2', 'pushed') }, 'local, already pushed');
    const helper = await cloneRemote(t, fx.remote, `helper-${++n}`);
    await out(helper, ['fetch', '-q', fx.c.dir, h]);
    await out(helper, ['cherry-pick', '-x', 'FETCH_HEAD']);   // -x: a distinct commit with the same patch
    await helper.write('note.md', FIVE.replace('l2', 'pushed, then edited'));
    await out(helper, ['commit', '-qam', 'later edit of the same line']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    const res = await replayCommits(fx.ctx, { local: h, onto: r, upstream: r });
    expect(res).toMatchObject({ kind: 'clean', tip: r, replayed: 0, skipped: 1 });
  });

  test('a conflict goes to the planner, also behind a merge; a bad argument is failed, never a conflict', async () => {
    const fx = await fixture();
    const h = await commit(fx.c, { 'note.md': FIVE.replace('l3', 'local') }, 'local');
    await fx.remote.push({ 'note.md': FIVE.replace('l3', 'remote') }, 'remote');
    const r = await fetchRemote(fx.c);
    const res = await replayCommits(fx.ctx, { local: h, onto: r, upstream: r });
    expect(res).toEqual({ kind: 'conflict', at: h, paths: ['note.md'] });

    // a plain merge is linearized like `git rebase` does it: the conflicting commit behind it still conflicts
    await out(fx.c, ['checkout', '-q', '-b', 'side', `${h}~1`]);
    await commit(fx.c, { 'side.md': 's\n' }, 'side');
    await out(fx.c, ['checkout', '-q', 'main']);
    await out(fx.c, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    const m = await out(fx.c, ['rev-parse', 'HEAD']);
    expect(await replayCommits(fx.ctx, { local: m, onto: r, upstream: r })).toEqual({ kind: 'conflict', at: h, paths: ['note.md'] });

    const bad = await replayCommits(fx.ctx, { local: h, onto: 'deadbeef', upstream: r });
    expect(bad.kind).toBe('failed');
  });

  test('a user log.showSignature=true and a signed commit: the author is read from the raw object, intact', async () => {
    const fx = await fixture();
    const g = join(t.root, `gitconfig-sig-${++n}`);
    writeFileSync(g, `[init]\n\tdefaultBranch = main\n[user]\n\tname = Test Helper\n\temail = helper@test.invalid\n[log]\n\tshowSignature = true\n`);
    // a commit object with a gpgsig header (the signature itself is never checked)
    const tree = await out(fx.c, ['write-tree']);
    const parent = await out(fx.c, ['rev-parse', 'HEAD']);
    const raw = `tree ${await (async () => {
      await fx.c.write('signed.md', 'signed\n');
      await out(fx.c, ['add', 'signed.md']);
      return out(fx.c, ['write-tree']);
    })()}\nparent ${parent}\nauthor Signer <s@s> 1700000000 +0000\ncommitter Signer <s@s> 1700000000 +0000\n`
      + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----\n\nsigned commit\n';
    void tree;
    const signed = Bun.spawnSync(['git', 'hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: fx.c.dir, env: t.env,
      stdin: new TextEncoder().encode(raw) }).stdout.toString().trim();
    await fx.remote.push({ 'other.md': 'remote o\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    process.env.GIT_CONFIG_GLOBAL = g;
    try {
      const res = await replayCommits(fx.ctx, { local: signed, onto: r, upstream: parent });
      expect(res.kind).toBe('clean');
      if (res.kind !== 'clean') return;
      const p = Bun.spawnSync(['git', 'cat-file', 'commit', res.tip], { cwd: fx.c.dir, env: t.env }).stdout.toString();
      expect(p).toContain('author Signer <s@s> 1700000000 +0000\n');
      expect(p).not.toContain('gpgsig');
      expect(p.endsWith('\nsigned commit\n')).toBe(true);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = t.env.GIT_CONFIG_GLOBAL;
    }
  });

  test('an ISO-8859-1 commit keeps its encoding header and its message bytes', async () => {
    const fx = await fixture();
    await fx.c.write('latin.md', 'x\n');
    await out(fx.c, ['add', 'latin.md']);
    const msg = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);   // "café\n" in Latin-1
    const c = Bun.spawnSync(['git', '-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '-q', '-F', '-'], { cwd: fx.c.dir, env: t.env,
      stdin: msg });
    expect(c.exitCode).toBe(0);
    const h = await out(fx.c, ['rev-parse', 'HEAD']);
    await fx.remote.push({ 'other.md': 'remote o\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    const res = await replayCommits(fx.ctx, { local: h, onto: r, upstream: r });
    expect(res.kind).toBe('clean');
    if (res.kind !== 'clean') return;
    const raw = Bun.spawnSync(['git', 'cat-file', 'commit', res.tip], { cwd: fx.c.dir, env: t.env }).stdout;
    const text = Buffer.from(raw).toString('latin1');
    expect(text).toContain('\nencoding ISO-8859-1\n');
    expect([...raw.subarray(raw.length - msg.length)]).toEqual([...msg]);
  });
});

// Review round 5 (d28-semantics-2, -4, -5): the replay against `git rebase --autostash` on a twin clone, which is what
// the replay promises ("the same result as git rebase").
describe('replayCommits matches git rebase', () => {
  const BOB = { GIT_AUTHOR_NAME: 'Bob Q', GIT_AUTHOR_EMAIL: 'bob@example.invalid', GIT_AUTHOR_DATE: '1700000000 +0200',
    GIT_COMMITTER_NAME: 'Bob Q', GIT_COMMITTER_EMAIL: 'bob@example.invalid', GIT_COMMITTER_DATE: '1700000000 +0200' };
  const fmt = (c: Clone, range: string): Promise<string> => out(c, ['log', '--format=%an <%ae> %ad | %s', '--date=raw', range]);
  // the same local history on A and its twin B: B runs the old `git rebase`, A the replay
  async function twins(seed: Record<string, string> | 'empty'): Promise<{ remote: Remote; a: Fx; b: Clone }> {
    const remote = await createRemote(t, seed === 'empty' ? { seed: 'empty' } : { files: seed });
    const a = await fixtureOn(remote);
    return { remote, a, b: await cloneRemote(t, remote, `twin-${++n}`) };
  }
  async function oldRebase(b: Clone): Promise<void> {
    await out(b, ['fetch', '-q', 'origin']);
    await out(b, ['-c', 'rebase.updateRefs=false', 'rebase', '--no-autosquash', '--no-verify', 'origin/main'], BOB);
  }

  test('a local merge is linearized, every commit keeps its author and message (no squash into one "(conflict)" commit)', async () => {
    const { remote, a, b } = await twins({ 'README.md': '# r\n' });
    for (const c of [a.c, b]) {
      await out(c, ['checkout', '-q', '-b', 'side']);
      await commit(c, { 'side.md': 'side\n' }, 'side work', BOB);
      await out(c, ['checkout', '-q', 'main']);
      await commit(c, { 'main.md': 'main\n' }, 'main work', BOB);
      await out(c, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], BOB);
    }
    await remote.push({ 'other.md': 'x\n' }, 'remote adds other');
    await oldRebase(b);
    const r = await fetchRemote(a.c);
    const res = await replayCommits(a.ctx, { local: await a.c.head(), onto: r, upstream: r });
    expect(res).toMatchObject({ kind: 'clean', replayed: 2 });
    if (res.kind !== 'clean') return;
    expect(await fmt(a.c, `${r}..${res.tip}`)).toBe(await fmt(b, 'origin/main..HEAD'));
    expect(await out(a.c, ['rev-parse', `${res.tip}^{tree}`])).toBe(await out(b, ['rev-parse', 'HEAD^{tree}']));
  });

  test('a merge with content of its own (a hand-resolved conflict) goes to the planner, which keeps it', async () => {
    const fx = await fixture();
    await out(fx.c, ['checkout', '-q', '-b', 'side']);
    await commit(fx.c, { 'note.md': FIVE.replace('l2', 'side') }, 'side');
    await out(fx.c, ['checkout', '-q', 'main']);
    await commit(fx.c, { 'note.md': FIVE.replace('l2', 'main') }, 'main');
    await out(fx.c, ['merge', '-q', 'side']).catch(() => '');   // conflicts
    await fx.c.write('note.md', FIVE.replace('l2', 'resolved by hand'));
    await out(fx.c, ['commit', '-qam', 'merge side, resolved']);
    await fx.remote.push({ 'other.md': 'x\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    expect(await replayCommits(fx.ctx, { local: await fx.c.head(), onto: r, upstream: r })).toEqual({ kind: 'has-merges' });
  });

  test('unrelated histories (two first commits into an empty remote): the root commits replay onto the remote', async () => {
    const { remote, a, b } = await twins('empty');
    for (const c of [a.c, b]) {
      await commit(c, { 'a1.md': 'a1\n' }, 'first on A', BOB);
      await commit(c, { 'a2.md': 'a2\n' }, 'second on A', BOB);
    }
    const d = await cloneRemote(t, remote, `first-${++n}`);
    await commit(d, { 'd.md': 'd\n' }, 'D first');
    await out(d, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    await oldRebase(b);
    const r = await fetchRemote(a.c);
    const res = await replayCommits(a.ctx, { local: await a.c.head(), onto: r, upstream: r });
    expect(res).toMatchObject({ kind: 'clean', replayed: 2 });
    if (res.kind !== 'clean') return;
    expect(await fmt(a.c, res.tip)).toBe(await fmt(b, 'HEAD'));
    expect(await out(a.c, ['rev-parse', `${res.tip}^{tree}`])).toBe(await out(b, ['rev-parse', 'HEAD^{tree}']));
  });

  test('author headers another tool wrote are copied byte for byte, as rebase copies them (never rejected or rewritten)', async () => {
    for (const author of ['author  <bot@example.invalid> 1700000000 +0000', 'author "Alice" <alice@example.invalid> 1700000000 +0000',
      'author Alice Jr., <alice@example.invalid> 1700000000 +0000', 'author Alice <alice@example.invalid> 1700000000']) {
      const fx = await fixture();
      await fx.c.write('x.md', 'x\n');
      await out(fx.c, ['add', '-A']);
      const body = `tree ${await out(fx.c, ['write-tree'])}\nparent ${await fx.c.head()}\n${author}\n`
        + 'committer Bob Q <bob@example.invalid> 1700000000 +0000\n\ntool commit\n';
      const sha = Bun.spawnSync(['git', 'hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { cwd: fx.c.dir, env: t.env,
        stdin: new TextEncoder().encode(body) }).stdout.toString().trim();
      await out(fx.c, ['update-ref', 'HEAD', sha]);
      await fx.remote.push({ 'r.md': 'r\n' }, 'remote adds r');
      const r = await fetchRemote(fx.c);
      const res = await replayCommits(fx.ctx, { local: sha, onto: r, upstream: r });
      expect({ author, kind: res.kind }).toEqual({ author, kind: 'clean' });
      if (res.kind !== 'clean') continue;
      const raw = await out(fx.c, ['cat-file', 'commit', res.tip]);
      expect(raw.split('\n').find((l) => l.startsWith('author'))).toBe(author);
      expect(raw).toContain('committer mdsync-test <test@test.invalid> ');
      const calls = fx.logs.filter((l) => l.msg === 'git').map((l) => l.args as string[]).filter((a) => a.includes('hash-object') && a.includes('commit'));
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.slice(0, 4)).toEqual(['-c', 'core.fsync=committed', '-c', 'core.fsyncMethod=batch']);
    }
  });

  test('a commit that starts empty is kept (rebase --keep-empty); one that becomes empty is dropped', async () => {
    const { remote, a, b } = await twins({ 'README.md': '# r\n', 'note.md': FIVE });
    for (const c of [a.c, b]) {
      await out(c, ['commit', '-q', '--allow-empty', '-m', 'checkpoint: reviewed all notes'], BOB);
      await commit(c, { 'y.md': 'y\n' }, 'add y', BOB);
      await commit(c, { 'note.md': FIVE.replace('l3', 'same') }, 'becomes empty', BOB);
    }
    await remote.push({ 'r.md': 'r\n', 'note.md': FIVE.replace('l3', 'same') }, 'remote adds r');
    await oldRebase(b);
    const r = await fetchRemote(a.c);
    const res = await replayCommits(a.ctx, { local: await a.c.head(), onto: r, upstream: r });
    expect(res).toMatchObject({ kind: 'clean', replayed: 2, dropped: 1 });
    if (res.kind !== 'clean') return;
    expect(await fmt(a.c, `${r}..${res.tip}`)).toBe(await fmt(b, 'origin/main..HEAD'));
    expect(await fmt(a.c, `${r}..${res.tip}`)).toContain('checkpoint: reviewed all notes');
  });
});

describe('parseRawCommit', () => {
  test('headers, a continuation header and the message bytes', () => {
    const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const PARENT = 'a'.repeat(40);
    const raw = new TextEncoder().encode(`tree ${TREE}\nparent ${PARENT}\nauthor A B <a@b> 12 -0100\ncommitter C <c@c> 13 +0000\n`
      + 'gpgsig x\n y\nencoding UTF-8\n\nsubject\n\nbody\n');
    const r = parseRawCommit(raw);
    expect(r).not.toBe('invalid');
    if (r === 'invalid') return;
    expect(r.tree).toBe(TREE);
    expect(r.parents).toEqual([PARENT]);
    expect(new TextDecoder().decode(r.author)).toBe('A B <a@b> 12 -0100');   // as stored, never re-parsed
    expect(r.encoding).toBe('UTF-8');
    expect(new TextDecoder().decode(r.message)).toBe('subject\n\nbody\n');
    expect(parseRawCommit(new TextEncoder().encode(`tree ${TREE}\n\nno author\n`))).toBe('invalid');
  });
});
