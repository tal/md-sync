import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as conflictName from '../../src/conflict-name';
import { liveGitIn, pidVisibility } from '../../src/live-git';
import { spawnTracked } from '../../src/spawn';
import {
  CONFLICT_COPY_RE, backdate, cleanupAll, cloneRemote, cmd, createRemote, emptyDir, expectNoMdsyncArtifacts, fakeNtfy,
  holdLiveGit, makeAutostashConflict, makeLeftoverAutostash, makeStoppedRebase, openClone, raceUploadPack, remoteNotifier,
  runCli, setupTestEnv, slowReceivePack, startDaemon, waitFor, waitNoLiveGit, type TestEnv,
} from '../harness';

afterEach(cleanupAll);

const dec = new TextDecoder();

async function sh(t: TestEnv, cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = await spawnTracked(['git', ...args], { cwd, env: { ...t.env, ...env }, timeoutMs: 30_000 });
  return { code: r.code, stdout: dec.decode(r.stdout), stderr: dec.decode(r.stderr) };
}

async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

type Sse = { status: number; events: string[]; ended(): 'open' | 'ended'; close(): void };

async function sseClient(topicUrl: string): Promise<Sse> {
  const ac = new AbortController();
  const res = await fetch(`${topicUrl}/sse`, { signal: ac.signal });
  const events: string[] = [];
  let ended: 'open' | 'ended' = 'open';
  const body = res.body;
  if (body === null) throw new Error('no body');
  const reader = body.getReader();
  const td = new TextDecoder();
  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += td.decode(r.value, { stream: true });
        let i = buf.indexOf('\n\n');
        while (i >= 0) {
          events.push(buf.slice(0, i));
          buf = buf.slice(i + 2);
          i = buf.indexOf('\n\n');
        }
      }
    } catch {
      // aborted
    }
    ended = 'ended';
  })();
  return { status: res.status, events, ended: () => ended, close: () => ac.abort() };
}

function dataOf(ev: string): Record<string, unknown> {
  const line = ev.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line?.slice(6) ?? 'null') as Record<string, unknown>;
}

// A stand-in for `md-sync run` that prints scripted JSON log lines; exercises the harness without the real daemon.
const FAKE_DAEMON = `
const mode = process.env.FAKE_MODE ?? 'normal';
const out = (s) => process.stdout.write(s + '\\n');
const log = (msg, f = {}) => out(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, ...f }));
const sync = (runId, reasons) => { log('sync start', { runId, reasons }); log('sync done', { runId, reasons, outcome: 'ok' }); };
out('argv: ' + process.argv.slice(2).join(' '));
process.stderr.write('fake stderr line\\n');
if (mode === 'crash') { log('fatal', { error: 'boom' }); process.exit(3); }
log('daemon starting', { pid: process.pid });
log('daemon ready', { socket: 's', head: 'h' });
if (mode === 'ntfy-late') {
  log('ntfy connected', { host: '127.0.0.1', attempt: 'first' });
  sync(1, ['startup']);
} else {
  sync(1, ['startup']);
}
if (mode === 'ntfy') {
  setTimeout(() => {
    log('ntfy connected', { host: '127.0.0.1', attempt: 'first' });
    setTimeout(() => sync(2, ['ntfy-connect']), 300);
  }, 300);
}
let n = 10;
setInterval(() => { if (mode === 'chatty') { n += 1; sync(n, ['fallback']); } }, 100);
process.on('SIGHUP', () => log('config reloaded', { trigger: 'sighup', changed: [] }));
process.on('SIGTERM', () => {
  if (mode === 'stubborn') return;
  log('shutdown requested', { signal: 'SIGTERM' });
  process.exit(0);
});
process.on('SIGINT', () => { log('shutdown requested', { signal: 'SIGINT' }); process.exit(0); });
`;

function fakeBin(t: TestEnv): string {
  const ts = join(t.root, 'fake-mdsync.ts');
  const bin = join(t.root, 'fake-mdsync');
  writeFileSync(ts, FAKE_DAEMON);
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${ts}' "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('setupTestEnv / cleanupAll', () => {
  test('creates an isolated env and removes it', async () => {
    const t = await setupTestEnv('env check/x');
    expect(t.root).toBe(realpathSync(t.root));
    expect(t.root.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(t.root).toContain('mdsync-test-env-check-x-');
    for (const d of [t.home, t.stateHome, t.configHome]) expect(statSync(d).isDirectory()).toBe(true);
    expect(Object.keys(t.env).sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'LC_ALL',
      'MDSYNC_LOG_LEVEL', 'PATH', 'TZ', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']);
    expect(t.env).toMatchObject({ HOME: t.home, XDG_STATE_HOME: t.stateHome, XDG_CONFIG_HOME: t.configHome,
      MDSYNC_LOG_LEVEL: 'debug', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(t.root, 'gitconfig'), TZ: 'UTC', LC_ALL: 'C' });
    const cfg = await sh(t, t.root, ['config', '--global', '--list']);
    expect(cfg.stdout.split('\n').filter(Boolean).sort())
      .toEqual(['init.defaultbranch=main', 'user.email=helper@test.invalid', 'user.name=Test Helper']);
    await cleanupAll();
    expect(existsSync(t.root)).toBe(false);
  });

  test('MDSYNC_KEEP_TMP=keep keeps the root', async () => {
    const t = await setupTestEnv('keep');
    await withEnv('MDSYNC_KEEP_TMP', 'keep', () => cleanupAll());
    expect(existsSync(t.root)).toBe(true);
    rmSync(t.root, { recursive: true, force: true });
  });
});

describe('remote', () => {
  test('seeded by default with README.md', async () => {
    const t = await setupTestEnv('remote-seeded');
    const r = await createRemote(t);
    expect(r.url).toBe(r.path);
    expect(r.path).toBe(realpathSync(join(t.root, 'remote.git')));
    const head = await r.head();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const log = await r.log();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ sha: head, subject: 'seed', authorName: 'Test Helper', files: ['README.md'] });
    expect(await r.tree()).toEqual(['README.md']);
    expect(await r.show('README.md')).toBe('# notes\n');
    expect(await r.show('missing.md')).toBeUndefined();
    const r2 = await createRemote(t, { files: { 'b.md': 'b\n', 'dir/a.md': 'a\n' } });
    expect(r2.path).not.toBe(r.path);
    expect(await r2.tree()).toEqual(['b.md', 'dir/a.md']);
    expect(await r2.show('dir')).toBeUndefined();
  });

  test('empty remote, then push creates main', async () => {
    const t = await setupTestEnv('remote-empty');
    const r = await createRemote(t, { seed: 'empty' });
    expect(await r.head()).toBe('none');
    expect(await r.log()).toEqual([]);
    expect(await r.tree()).toEqual([]);
    expect(await r.show('README.md')).toBeUndefined();
    const sha = await r.push({ 'x.md': 'x\n' }, 'first');
    expect(await r.head()).toBe(sha);
    expect(await r.tree()).toEqual(['x.md']);
  });

  test('push adds, edits and deletes; returns the new head; keeps the body', async () => {
    const t = await setupTestEnv('remote-push');
    const r = await createRemote(t, { files: { 'a.md': 'a\n', 'gone.md': 'g\n' } });
    const first = await r.head();
    const sha = await r.push({ 'a.md': 'a2\n', 'gone.md': null, 'n/new.md': 'new\n' }, 'subject line\n\nbody 1\nbody 2\n');
    expect(await r.head()).toBe(sha);
    expect(await r.tree()).toEqual(['a.md', 'n/new.md']);
    expect(await r.show('a.md')).toBe('a2\n');
    expect(await r.show('a.md', first as string)).toBe('a\n');
    expect(await r.tree(first as string)).toEqual(['a.md', 'gone.md']);
    const log = await r.log();
    expect(log.map((c) => c.subject)).toEqual(['subject line', 'seed']);
    expect(log[0]).toMatchObject({ sha, body: 'body 1\nbody 2', authorName: 'Test Helper' });
    expect([...(log[0]?.files ?? [])].sort()).toEqual(['a.md', 'gone.md', 'n/new.md']);
  });

  test('setUnreachable / restore', async () => {
    const t = await setupTestEnv('remote-away');
    const r = await createRemote(t);
    const c = await cloneRemote(t, r, 'A');
    const head = await r.head();
    await r.setUnreachable();
    expect(existsSync(r.path)).toBe(false);
    expect(existsSync(`${r.path}.away`)).toBe(true);
    const failed = await c.git(['fetch', 'origin']);
    expect(failed.code).not.toBe(0);
    expect(await r.head()).toBe(head);   // reads still see the moved repo
    await expect(r.push({ 'x.md': 'x' }, 'nope')).rejects.toThrow();
    await r.restore();
    expect(existsSync(r.path)).toBe(true);
    expect((await c.git(['fetch', 'origin'])).code).toBe(0);
  });
});

describe('clones', () => {
  test('cloneRemote and the Clone helpers', async () => {
    const t = await setupTestEnv('clone');
    const r = await createRemote(t, { files: { 'README.md': '# notes\n', 'note.md': 'n\n' } });
    const c = await cloneRemote(t, r, 'A');
    expect(c.dir).toBe(join(t.root, 'A'));
    expect(await c.files()).toEqual(['README.md', 'note.md']);
    expect(await c.head()).toBe((await r.head()) as string);
    expect(await c.porcelain()).toEqual([]);

    await c.write('sub/deep/x.md', 'x\n');
    await c.write('bin.dat', new Uint8Array([0, 1, 2, 255]));
    await c.write('with space é.md', 's\n');
    await c.write('note.md', 'changed\n');
    expect(await c.read('sub/deep/x.md')).toBe('x\n');
    expect(await c.read('nope.md')).toBeUndefined();
    expect(new Uint8Array(readFileSync(join(c.dir, 'bin.dat')))).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(await c.files()).toEqual(['README.md', 'bin.dat', 'note.md', 'sub/deep/x.md', 'with space é.md']);
    expect((await c.porcelain()).sort()).toEqual([' M note.md', '?? bin.dat', '?? sub/deep/x.md', '?? with space é.md']);

    await c.git(['add', '-A']);
    await c.git(['mv', 'README.md', 'README2.md']);
    expect(await c.porcelain()).toContain('R  README.md -> README2.md');
    expect((await c.git(['commit', '-q', '-m', 'local'])).code).toBe(0);
    const log = await c.log();
    expect(log.map((x) => x.subject)).toEqual(['local', 'seed']);
    expect(log[0]?.authorName).toBe('Test Helper');
    expect((await c.log('origin/main..HEAD')).map((x) => x.subject)).toEqual(['local']);

    await c.remove('sub');
    expect(existsSync(join(c.dir, 'sub'))).toBe(false);
    await c.write('note (conflict host 2026-10-08 1234).md', 'copy\n');
    await c.write('d/x (conflict host 2026-10-08 1234 2).txt', 'copy\n');
    expect(await c.conflictCopies()).toEqual(['d/x (conflict host 2026-10-08 1234 2).txt', 'note (conflict host 2026-10-08 1234).md']);

    expect(await c.stashList()).toEqual([]);
    await c.write('note.md', 'stash me\n');
    expect((await c.git(['stash', '-q'])).code).toBe(0);
    expect(await c.stashList()).toHaveLength(1);
  });

  test('emptyDir and openClone', async () => {
    const t = await setupTestEnv('empty-dir');
    const d = emptyDir(t, 'B');
    expect(d).toBe(join(t.root, 'B'));
    expect(statSync(d).isDirectory()).toBe(true);
    const r = await createRemote(t);
    expect((await sh(t, t.root, ['clone', '-q', r.url, d])).code).toBe(0);
    const c = openClone(t, d);
    expect(await c.files()).toEqual(['README.md']);
    expect(await c.head()).toBe((await r.head()) as string);
  });

  test('head() of an unborn clone', async () => {
    const t = await setupTestEnv('unborn');
    const r = await createRemote(t, { seed: 'empty' });
    const c = await cloneRemote(t, r, 'A');
    expect(await c.head()).toBe('unborn');
    expect(await c.log()).toEqual([]);
  });
});

describe('fake ntfy', () => {
  test('SSE open event, publish, POST, drop, client abort', async () => {
    const n = await fakeNtfy();
    expect(n.topicUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/);
    const topic = n.topicUrl.slice(n.topicUrl.lastIndexOf('/') + 1);
    const a = await sseClient(n.topicUrl);
    expect(a.status).toBe(200);
    await n.waitForConnections(1, { timeoutMs: 5_000 });
    const open = await waitFor(() => a.events[0]);
    expect(open.startsWith('event: open\ndata: ')).toBe(true);
    expect(dataOf(open)).toMatchObject({ event: 'open', topic });

    await n.publish('abc123');
    const msg = await waitFor(() => a.events.find((e) => e.includes('abc123')));
    expect(msg.startsWith('data: ')).toBe(true);
    const data = dataOf(msg);
    expect(data).toMatchObject({ event: 'message', topic, message: 'abc123' });
    expect(typeof data.id).toBe('string');
    expect(typeof data.time).toBe('number');

    const b = await sseClient(n.topicUrl);
    await n.waitForConnections(2, { timeoutMs: 5_000 });
    expect(n.connectionCount()).toBe(2);
    const posted = await fetch(n.topicUrl, { method: 'POST', body: 'def456' });
    expect(posted.status).toBe(200);
    await waitFor(() => a.events.find((e) => e.includes('def456')));
    await waitFor(() => b.events.find((e) => e.includes('def456')));
    expect((await fetch(`${n.topicUrl}x/sse`)).status).toBe(404);

    b.close();
    await waitFor(() => n.connectionCount() === 1, { timeoutMs: 5_000, label: 'abort removes the connection' });
    n.dropConnections();
    expect(n.connectionCount()).toBe(0);
    await waitFor(() => a.ended() === 'ended', { timeoutMs: 5_000 });

    const c = await sseClient(n.topicUrl);   // reconnect works after a drop
    await n.waitForConnections(1, { timeoutMs: 5_000 });
    c.close();
    await n.close();
    await expect(fetch(`${n.topicUrl}/sse`)).rejects.toThrow();
  });

  test('waitForConnections times out', async () => {
    const n = await fakeNtfy();
    await expect(n.waitForConnections(1, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });

  test('remoteNotifier publishes each new remote head, not the existing one', async () => {
    const t = await setupTestEnv('notifier');
    const r = await createRemote(t);
    const n = await fakeNtfy();
    const s = await sseClient(n.topicUrl);
    await n.waitForConnections(1);
    const notifier = remoteNotifier(r, n, 50);
    const sha = await r.push({ 'a.md': 'a\n' }, 'a');   // pushed right away: must not be swallowed as the baseline
    const ev = await waitFor(() => s.events.find((e) => e.includes(sha)), { timeoutMs: 5_000 });
    expect(dataOf(ev)).toMatchObject({ event: 'message', message: sha });
    const messages = (): unknown[] => s.events.map(dataOf).filter((d) => d.event === 'message').map((d) => d.message);
    expect(messages()).toEqual([sha]);
    const sha2 = await r.push({ 'b.md': 'b\n' }, 'b');
    await waitFor(() => messages().includes(sha2), { timeoutMs: 5_000 });
    await notifier.stop();
    await r.push({ 'c.md': 'c\n' }, 'c');
    await Bun.sleep(300);
    expect(messages()).toEqual([sha, sha2]);
  });
});

describe('git hooks for races', () => {
  test('raceUploadPack makes the push after a plain fetch non-fast-forward', async () => {
    const t = await setupTestEnv('race');
    const r = await createRemote(t);
    const c = await cloneRemote(t, r, 'A');
    const race = await raceUploadPack(t, r);
    expect(race.env).toEqual({
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.uploadpack', GIT_CONFIG_VALUE_0: join(t.root, 'race-upload-pack.sh'),
      RACE_ARM: join(t.root, 'race.arm'), RACE_HELPER: join(t.root, 'race-helper'),
    });
    expect(statSync(join(t.root, 'race-helper', '.git')).isDirectory()).toBe(true);
    await race.arm();
    expect(race.fired()).toBe(false);

    await c.write('mine.md', 'mine\n');
    await c.git(['add', '-A']);
    await c.git(['commit', '-q', '-m', 'mine']);
    // The identity mdsync passes must not leak into the race commit.
    const mdsyncIdentity = { GIT_AUTHOR_NAME: 'mdsync-A', GIT_COMMITTER_NAME: 'mdsync-A' };
    const env = { ...race.env, ...mdsyncIdentity };
    const before = await r.head();
    const fetched = await sh(t, c.dir, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], env);
    expect(fetched.code).toBe(0);
    expect(race.fired()).toBe(true);
    expect(await r.head()).not.toBe(before);
    const log = await r.log();
    expect(log[0]).toMatchObject({ subject: 'race commit', authorName: 'Test Helper', files: ['race.md'] });

    const pushed = await sh(t, c.dir, ['push', '--porcelain', 'origin', 'refs/heads/main:refs/heads/main'], env);
    expect(pushed.code).toBe(1);
    expect(pushed.stdout + pushed.stderr).toMatch(/\[rejected\][^\n]*\(fetch first\)/);

    // Not re-armed: the next fetch is plain, and a rebase + push goes through.
    expect((await sh(t, c.dir, ['fetch', '-q', 'origin'], env)).code).toBe(0);
    expect((await r.log())).toHaveLength(2);
    expect((await sh(t, c.dir, ['rebase', '-q', 'origin/main'], env)).code).toBe(0);
    expect((await sh(t, c.dir, ['push', '-q', 'origin', 'main'], env)).code).toBe(0);
    expect(await r.head()).toBe(await c.head());
  });

  test('slowReceivePack blocks a plain push until release', async () => {
    const t = await setupTestEnv('slow-push');
    const r = await createRemote(t);
    const c = await cloneRemote(t, r, 'A');
    const slow = await slowReceivePack(t);
    expect(slow.env).toEqual({
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.receivepack', GIT_CONFIG_VALUE_0: join(t.root, 'slow-receive-pack.sh'),
    });
    await c.write('p.md', 'p\n');
    await c.git(['add', '-A']);
    await c.git(['commit', '-q', '-m', 'p']);
    const before = await r.head();
    let state: 'pending' | 'done' = 'pending';
    const push = sh(t, c.dir, ['push', '-q', 'origin', 'main'], slow.env).finally(() => { state = 'done'; });
    await slow.started();
    expect(existsSync(join(t.root, 'push.started'))).toBe(true);
    await Bun.sleep(500);
    expect(state).toBe('pending');
    expect(await r.head()).toBe(before);
    await slow.release();
    const res = await push;
    expect(res.code).toBe(0);
    expect(await r.head()).toBe(await c.head());
  });
});

describe('stopped git states', () => {
  test('makeStoppedRebase leaves a stopped rebase with an autostash', async () => {
    const t = await setupTestEnv('stopped-rebase');
    const r = await createRemote(t, { files: { 'note.md': 'l1\nl2\nl3\n', 'README.md': '# r\n' } });
    const c = await cloneRemote(t, r, 'A');
    const shas = await makeStoppedRebase(t, c, r, {
      path: 'note.md', local: 'local\n', remote: 'remote\n', dirty: { 'other.md': 'local dirty', 'README.md': 'dirty readme\n' },
    });
    expect(shas.remote).toBe((await r.head()) as string);
    expect((await c.git(['log', '-1', '--format=%s', shas.local])).stdout.trim()).toBe('local edit note.md');
    expect((await c.git(['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(shas.local);
    const gitDir = join(c.dir, '.git');
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(true);
    expect(existsSync(join(gitDir, 'rebase-merge', 'autostash'))).toBe(true);
    expect((await c.git(['symbolic-ref', '-q', 'HEAD'])).code).not.toBe(0);   // detached
    expect((await c.git(['ls-files', '-u'])).stdout).toContain('\tnote.md');
    expect(await c.read('other.md')).toBe('local dirty');   // untracked: not stashed
    expect(await c.read('README.md')).toBe('# r\n');        // tracked: in the autostash
    expect(await c.read('note.md')).toContain('<<<<<<<');
  });

  test('makeStoppedRebase on an add/add path', async () => {
    const t = await setupTestEnv('stopped-rebase-add');
    const r = await createRemote(t);
    const c = await cloneRemote(t, r, 'A');
    await makeStoppedRebase(t, c, r, { path: 'new.md', local: 'mine\n', remote: 'theirs\n' });
    expect(existsSync(join(c.dir, '.git', 'rebase-merge'))).toBe(true);
    expect(existsSync(join(c.dir, '.git', 'rebase-merge', 'autostash'))).toBe(false);
  });

  test('makeAutostashConflict leaves UU + refs/stash autostash and no rebase', async () => {
    const t = await setupTestEnv('autostash-conflict');
    const r = await createRemote(t, { files: { 'note.md': 'l1\nl2\nl3\n' } });
    const c = await cloneRemote(t, r, 'A');
    await makeAutostashConflict(t, c, r, { path: 'note.md', local: 'mine\n', remote: 'theirs\n' });
    const gitDir = join(c.dir, '.git');
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false);
    expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false);
    expect(await c.porcelain()).toEqual(['UU note.md']);
    expect((await c.git(['log', '-g', '-1', '--format=%gs', 'refs/stash'])).stdout.trim()).toBe('autostash');
    expect(await c.head()).toBe((await r.head()) as string);
    const stash = (await c.git(['rev-parse', 'refs/stash'])).stdout.trim();
    expect((await c.git(['show', `${stash}:note.md`])).stdout).toBe('mine\n');
  });

  test('makeAutostashConflict rejects an untracked path', async () => {
    const t = await setupTestEnv('autostash-untracked');
    const r = await createRemote(t);
    const c = await cloneRemote(t, r, 'A');
    await expect(makeAutostashConflict(t, c, r, { path: 'fresh.md', local: 'a\n', remote: 'b\n' })).rejects.toThrow(/makeAutostashConflict/);
  });

  test('makeLeftoverAutostash leaves only refs/stash autostash after a fast-forward', async () => {
    const t = await setupTestEnv('leftover-autostash');
    const r = await createRemote(t, { files: { 'note.md': 'n\n', 'b.md': 'b\n' } });
    const c = await cloneRemote(t, r, 'A');
    const sha = await makeLeftoverAutostash(t, c, r, { dirty: { 'note.md': 'dirty note\n', 'b.md': 'dirty b\n' } });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await c.git(['rev-parse', 'refs/stash'])).stdout.trim()).toBe(sha);
    expect((await c.git(['log', '-g', '-1', '--format=%gs', 'refs/stash'])).stdout.trim()).toBe('autostash');
    expect((await c.git(['ls-files', '-u'])).stdout).toBe('');
    expect(await c.porcelain()).toEqual([]);
    expect(await c.head()).toBe((await r.head()) as string);
    expect(await c.read('note.md')).toBe('n\n');
    expect(await c.read('remote-ff.md')).toBeDefined();
    expect((await c.git(['show', `${sha}:note.md`])).stdout).toBe('dirty note\n');
    expect((await c.git(['show', `${sha}:b.md`])).stdout).toBe('dirty b\n');
    expect(existsSync(join(c.dir, '.git', 'rebase-merge'))).toBe(false);
  });

  test('makeLeftoverAutostash with nothing tracked to stash throws', async () => {
    const t = await setupTestEnv('leftover-empty');
    const r = await createRemote(t);
    const c = await cloneRemote(t, r, 'A');
    await expect(makeLeftoverAutostash(t, c, r, { dirty: { 'untracked.md': 'u\n' } })).rejects.toThrow(/nothing to stash/);
  });
});

describe('processes, files, polling', () => {
  test('holdLiveGit holds a git process with cwd in the repo; waitNoLiveGit', async () => {
    const t = await setupTestEnv('live-git');
    const r = await createRemote(t);
    const c = await cloneRemote(t, r, 'A');
    const other = await cloneRemote(t, r, 'B');
    const h = await holdLiveGit(c.dir);
    expect(h.pid).toBeGreaterThan(0);
    const comm = Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(h.pid)]).stdout.toString().trim();
    expect(comm).toMatch(/git$/);
    const scan = await liveGitIn(c.dir);
    expect(scan).toEqual({ kind: 'scanned', pids: [h.pid], visibility: pidVisibility() });
    expect(await liveGitIn(other.dir)).toEqual({ kind: 'scanned', pids: [], visibility: pidVisibility() });
    await expect(waitNoLiveGit(c.dir, { timeoutMs: 300 })).rejects.toThrow(/still live/);
    await waitNoLiveGit(other.dir, { timeoutMs: 5_000 });
    await h.release();
    let alive: 'alive' | 'gone' = 'alive';
    try {
      process.kill(h.pid, 0);
    } catch {
      alive = 'gone';
    }
    expect(alive).toBe('gone');
    await waitNoLiveGit(c.dir, { timeoutMs: 10_000 });
    await h.release();   // idempotent
  });

  test('backdate sets the mtime in the past', async () => {
    const t = await setupTestEnv('backdate');
    const p = join(t.root, 'x.lock');
    writeFileSync(p, '');
    backdate(p, 120_000);
    const age = Date.now() - statSync(p).mtimeMs;
    expect(age).toBeGreaterThan(118_000);
    expect(age).toBeLessThan(125_000);
  });

  test('waitFor', async () => {
    let i = 0;
    expect(await waitFor(() => (++i >= 3 ? i : undefined), { intervalMs: 5 })).toBe(3);
    let j = 0;
    expect(await waitFor(async () => ++j >= 2, { intervalMs: 5 })).toBe(true);   // false counts as not yet
    expect(await waitFor(() => 0)).toBe(0);
    expect(await waitFor(() => '')).toBe('');
    await expect(waitFor(() => undefined, { timeoutMs: 100, intervalMs: 10, label: 'never' })).rejects.toThrow(/timed out after 100 ms: never/);
    await expect(waitFor(() => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  test('CONFLICT_COPY_RE is re-exported from src/conflict-name.ts', () => {
    expect(CONFLICT_COPY_RE).toBe(conflictName.CONFLICT_COPY_RE);
    expect(CONFLICT_COPY_RE.test('a/note (conflict host 2026-10-08 1234).md')).toBe(true);
    expect(CONFLICT_COPY_RE.test('note.md')).toBe(false);
  });
});

describe('cli and daemon plumbing (fake binary)', () => {
  test('cmd() defaults to bun + src/cli.ts and honors MDSYNC_BIN', async () => {
    await withEnv('MDSYNC_BIN', undefined, async () => {
      expect(cmd()).toEqual([process.execPath, resolve(import.meta.dir, '../../src/cli.ts')]);
    });
    await withEnv('MDSYNC_BIN', '/x/mdsync', async () => {
      expect(cmd()).toEqual(['/x/mdsync']);
    });
  });

  test('runCli captures code, output and JSON logs from stdout and stderr', async () => {
    const t = await setupTestEnv('runcli');
    const bin = join(t.root, 'cli.sh');
    writeFileSync(bin, `#!/bin/sh
echo '{"ts":"t","level":"info","msg":"one-off run","source":"flush"}'
echo "plain $XDG_STATE_HOME $EXTRA $(pwd) $*"
echo '{"ts":"t","level":"warn","msg":"config invalid"}' >&2
echo 'md-sync: oops' >&2
exit 3
`);
    chmodSync(bin, 0o755);
    const sub = join(t.root, 'sub');
    mkdirSync(sub);
    const res = await withEnv('MDSYNC_BIN', bin, () => runCli(t, ['flush', '--wait'], { cwd: sub, env: { EXTRA: 'extra' } }));
    expect(res.code).toBe(3);
    expect(res.stdout).toContain(`plain ${t.stateHome} extra ${sub} flush --wait`);
    expect(res.stderr).toContain('md-sync: oops');
    expect(res.logs.map((l) => l.msg)).toEqual(['one-off run', 'config invalid']);
    expect(res.logs[0]).toMatchObject({ level: 'info', source: 'flush' });
  });

  test('startDaemon writes the config, waits for readiness and tracks logs', async () => {
    const t = await setupTestEnv('daemon-fake');
    const r = await createRemote(t);
    const bin = fakeBin(t);
    const dir = emptyDir(t, 'A');
    const d = await withEnv('MDSYNC_BIN', bin, () =>
      startDaemon(t, { name: 'A', dir, remote: r, config: { idleMs: 1500 }, args: ['--log-level', 'debug'], env: { FAKE_MODE: 'chatty' } }));
    expect(d.configPath).toBe(join(t.configHome, 'mdsync', 'A.json'));
    expect(JSON.parse(readFileSync(d.configPath, 'utf8'))).toEqual({
      remote: r.url, dir, branch: 'main', authorName: 'mdsync-A', authorEmail: 'A@test.invalid', idleMs: 1500, maxWaitMs: 120_000,
      fallbackMs: 3_600_000,
    });
    expect(d.logs.some((l) => l.msg === 'daemon ready')).toBe(true);
    expect(d.logs.some((l) => l.msg === 'sync done' && (l.reasons as string[]).includes('startup'))).toBe(true);
    expect(d.nonJsonStdout()[0]).toBe(`argv: run --config ${d.configPath} --log-level debug`);
    await waitFor(() => d.stderr().includes('fake stderr line'));

    const m = d.mark();
    expect(m).toBe(d.logs.length);
    const later = await d.waitForSync({ since: m, reason: 'fallback', outcome: 'ok' });
    expect(d.logs.indexOf(later)).toBeGreaterThanOrEqual(m);
    await expect(d.waitForSync({ since: m, outcome: 'failed', timeoutMs: 300 })).rejects.toThrow(/timed out after 300 ms/);
    expect((await d.waitForLog('daemon ready')).msg).toBe('daemon ready');   // since defaults to 0

    const hup = d.mark();
    d.signal('SIGHUP');
    await d.waitForLog('config reloaded', { since: hup });
    expect(await d.stop()).toBe(0);
    expect(d.logs.at(-1)?.msg).toBe('shutdown requested');
    await expect(d.waitForLog('never logged')).rejects.toThrow(/exited/);
  });

  test('startDaemon with ntfy waits for the first-connect catch-up run', async () => {
    const t = await setupTestEnv('daemon-ntfy');
    const r = await createRemote(t);
    const n = await fakeNtfy();
    const bin = fakeBin(t);
    const d = await withEnv('MDSYNC_BIN', bin, () =>
      startDaemon(t, { name: 'B', dir: emptyDir(t, 'B'), remote: r, ntfy: n, env: { FAKE_MODE: 'ntfy' } }));
    expect(JSON.parse(readFileSync(d.configPath, 'utf8')).ntfyUrl).toBe(n.topicUrl);
    expect(d.logs.some((l) => l.msg === 'sync done' && (l.reasons as string[]).includes('ntfy-connect'))).toBe(true);
    d.signalGroup('SIGINT');
    expect(await d.exited).toBe(0);
  });

  test('startDaemon with ntfy accepts a startup run that started after the connect', async () => {
    const t = await setupTestEnv('daemon-ntfy-late');
    const r = await createRemote(t);
    const n = await fakeNtfy();
    const bin = fakeBin(t);
    const d = await withEnv('MDSYNC_BIN', bin, () =>
      startDaemon(t, { name: 'C', dir: emptyDir(t, 'C'), remote: r, ntfy: n, env: { FAKE_MODE: 'ntfy-late' } }));
    expect(d.logs.map((l) => l.msg)).toContain('ntfy connected');
  });

  test('a daemon that exits early rejects startDaemon; wait none returns at once', async () => {
    const t = await setupTestEnv('daemon-crash');
    const r = await createRemote(t);
    const bin = fakeBin(t);
    await withEnv('MDSYNC_BIN', bin, async () => {
      await expect(startDaemon(t, { name: 'D', dir: emptyDir(t, 'D'), remote: r, env: { FAKE_MODE: 'crash' } }))
        .rejects.toThrow(/exited \(code 3\)/);
      const d = await startDaemon(t, { name: 'E', dir: emptyDir(t, 'E'), remote: r, env: { FAKE_MODE: 'crash' }, wait: 'none' });
      expect(await d.exited).toBe(3);
      expect(d.logs.map((l) => l.msg)).toEqual(['fatal']);
    });
  });

  test('cleanupAll SIGKILLs a daemon that ignores SIGTERM', async () => {
    const t = await setupTestEnv('daemon-stubborn');
    const r = await createRemote(t);
    const bin = fakeBin(t);
    const d = await withEnv('MDSYNC_BIN', bin, () =>
      startDaemon(t, { name: 'F', dir: emptyDir(t, 'F'), remote: r, env: { FAKE_MODE: 'stubborn' } }));
    d.signal('SIGTERM');
    await Bun.sleep(200);
    expect(d.proc.exitCode).toBeNull();
    await cleanupAll();
    expect(await d.exited).toBe(137);
    expect(existsSync(t.root)).toBe(false);
  });
});

describe('expectNoMdsyncArtifacts', () => {
  const userPaths = (p: string): boolean => p === 'README.md' || p.startsWith('notes/') || p === 'x.md';

  async function scene(name: string) {
    const t = await setupTestEnv(name);
    const r = await createRemote(t, { seed: 'empty' });
    const early = await cloneRemote(t, r, 'early');   // cloned while empty: no branch tracking config
    await r.push({ 'README.md': '# notes\n', 'notes/a.md': 'a\n' }, 'seed');
    const a = await cloneRemote(t, r, 'A');
    await a.write('notes/b.md', 'untracked user file\n');
    await a.write('notes/b (conflict host 2026-10-08 1234).md', 'copy\n');
    const stateDir = join(t.stateHome, 'mdsync');
    mkdirSync(join(stateDir, '0123456789abcdef.tmp'), { recursive: true });
    mkdirSync(join(stateDir, '0123456789abcdef.rescue'), { recursive: true });
    writeFileSync(join(stateDir, '0123456789abcdef.json'), '{}');
    writeFileSync(join(stateDir, '0123456789abcdef.lock'), '{}');
    return { t, r, clones: [early, a], a };
  }

  test('passes for clean clones, including one cloned from the empty remote', async () => {
    const { t, r, clones } = await scene('artifacts-ok');
    await expectNoMdsyncArtifacts(t, clones, r, userPaths);
  });

  test('allows configured daemon authors only', async () => {
    const { t, r, clones, a } = await scene('artifacts-authors');
    await a.write('x.md', 'x\n');
    await a.git(['add', 'x.md']);
    expect((await sh(t, a.dir, ['commit', '-q', '-m', 'x'], { GIT_AUTHOR_NAME: 'mdsync-A' })).code).toBe(0);
    expect((await a.git(['push', '-q', 'origin', 'main'])).code).toBe(0);
    await expect(expectNoMdsyncArtifacts(t, clones, r, userPaths)).rejects.toThrow();
    const bin = fakeBin(t);
    await withEnv('MDSYNC_BIN', bin, () => startDaemon(t, { name: 'A', dir: emptyDir(t, 'dA'), remote: r }));
    await expectNoMdsyncArtifacts(t, clones, r, userPaths);
  });

  const breakers: [string, (s: Awaited<ReturnType<typeof scene>>) => Promise<void>][] = [
    ['an mdsync file inside .git', async ({ a }) => { writeFileSync(join(a.dir, '.git', 'MDSYNC_STATE'), ''); }],
    ['an fsmonitor daemon file', async ({ a }) => { mkdirSync(join(a.dir, '.git', 'fsmonitor--daemon.ipc'), { recursive: true }); }],
    ['a lock file in the worktree', async ({ a }) => { await a.write('notes/x.lock', ''); }],
    ['a non-user worktree file', async ({ a }) => { await a.write('junk.txt', ''); }],
    ['an extra local config key', async ({ a }) => { await a.git(['config', '--local', 'remote.origin.tagopt', '--no-tags']); }],
    ['a changed info/exclude', async ({ a }) => { await a.write('.git/info/exclude', 'x\n'); }],
    ['an extra hook', async ({ a }) => { await a.write('.git/hooks/post-commit', '#!/bin/sh\n'); }],
    ['a non-user path on the remote', async ({ r }) => { await r.push({ 'junk.txt': 'j' }, 'junk'); }],
    ['a stray state-dir file', async ({ t }) => { writeFileSync(join(t.stateHome, 'mdsync', 'other.txt'), ''); }],
    ['a state-dir tmp entry that is not a dir', async ({ t }) => {
      writeFileSync(join(t.stateHome, 'mdsync', 'fedcba9876543210.tmp'), '');
    }],
  ];
  for (const [label, breakIt] of breakers) {
    test(`fails on ${label}`, async () => {
      const s = await scene(`artifacts-${label.replace(/\W+/g, '-')}`);
      await breakIt(s);
      await expect(expectNoMdsyncArtifacts(s.t, s.clones, s.r, userPaths)).rejects.toThrow();
    });
  }
});
