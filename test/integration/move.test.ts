// The worktree move: survey, classes, plan, checked writes, index and ref, undo,
// resume and settle, on real temp repos. No git command may write the worktree (W1): every test checks the git log.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { createLogger } from '../../src/log';
import { type Digest, digestAt, sha256Hex } from '../../src/cas';
import {
  applyOps, clearMovePart, copyNamer, type MoveJournal, moveTestHooks, moveWorktree, type MoveInput, MOVE_ROUNDS, processTempDir,
  recoverOrphanTemps, resumeMove, SETTLE_GRACE_MS, settlePending,
} from '../../src/move';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { mutateJournal, readJournal, readLocalOnly, type SettleEntry } from '../../src/state';
import { replayCommits } from '../../src/replay';
import {
  cleanupAll, cloneRemote, type Clone, CONFLICT_COPY_RE, createRemote, type LogLine, type Remote, setupTestEnv, type TestEnv,
} from '../harness';

// real repos and git processes: the 5 s default is too tight on a loaded machine
setDefaultTimeout(60_000);

let t: TestEnv;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const SIX = 'l1\nl2\nl3\nl4\nl5\nl6\n';

beforeAll(async () => {
  t = await setupTestEnv('move');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
}, 120_000);

type Fx = { remote: Remote; c: Clone; ctx: RunContext; logs: LogLine[] };

async function out(c: Clone, args: string[]): Promise<string> {
  const r = await c.git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function fixture(o: { seed?: Record<string, string>; ignore?: string[] } = {}): Promise<Fx> {
  const remote = await createRemote(t, { files: o.seed ?? { 'README.md': '# notes\n', 'note.md': SIX, 'other.md': 'other\n' } });
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  const config: ReadyConfig = { dir: c.dir, remote: remote.url, branch: 'main', idleMs: 60_000, fallbackMs: 3_600_000,
    maxWaitMs: 120_000, autoCommit: 'timers', ignore: o.ignore ?? [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (line) => { logs.push(JSON.parse(line) as LogLine); } });
  const ctx = await createRunContext({ config, realDir: c.dir, paths, log });
  return { remote, c, ctx, logs };
}

async function fetchRemote(c: Clone): Promise<string> {
  await out(c, ['fetch', '-q', 'origin']);
  return out(c, ['rev-parse', 'refs/remotes/origin/main']);
}

function pullInput(h: string, to: string): MoveInput {
  return { reason: 'pull', from: h, to, ref: { kind: 'update', ref: 'refs/heads/main', old: h, head: 'as-is' }, index: 'changed-paths',
    edits: 'merge', copies: 'commit' };
}

// Every git call the move made: none may write the worktree (W1).
function worktreeWriters(logs: readonly LogLine[]): string[] {
  const bad: string[] = [];
  for (const l of logs) {
    if (l.msg !== 'git') continue;
    const args = (l.args as string[]).filter((a, i, all) => a !== '-c' && all[i - 1] !== '-c');
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    const joined = args.join(' ');
    if (sub === 'rebase' && !joined.includes('--quit')) bad.push(joined);
    if (sub === 'checkout' || sub === 'stash' && /\b(apply|pop)\b/.test(joined) || sub === 'clean') bad.push(joined);
    if (sub === 'reset' && joined.includes('--hard')) bad.push(joined);
    if (sub === 'read-tree' && /(^| )-u( |$)|-m -u/.test(joined)) bad.push(joined);
    if (sub === 'checkout-index' && !joined.includes('--prefix=')) bad.push(joined);
    if (/ --abort( |$)/.test(joined)) bad.push(joined);
  }
  return bad;
}

async function settleNow(fx: Fx): Promise<void> {
  const j = readJournal(fx.ctx.paths.journal);
  if (j === 'none' || j.settle === undefined) return;
  // These tests exercise settlement after expiry; the late-descriptor test covers the real grace period.
  mutateJournal(fx.ctx.paths.journal, (x) => ({ ...x, settle: (x.settle ?? []).map((e) => ({
    ...e, since: Date.now() - SETTLE_GRACE_MS - 1,
  })) }));
  await settlePending(fx.ctx, 'due');
}

function tempFolders(dir: string): string[] {
  return readdirSync(dir).filter((x) => /^\.mdsync-\d+-\d+\.d$/.test(x));
}

describe('a pull', () => {
  test('clean paths take the new version, an uncommitted edit merges, a conflicting one is copied and committed', async () => {
    const fx = await fixture({ seed: { 'README.md': '# notes\n', 'note.md': SIX, 'other.md': 'other\n', 'gone.md': 'g\n', 'c.md': SIX } });
    const h = await fx.c.head();
    await fx.remote.push({ 'note.md': SIX.replace('l1\n', 'l1 remote\n'), 'other.md': 'other remote\n', 'gone.md': null,
      'new.md': 'new\n', 'c.md': SIX.replace('l3\n', 'l3 remote\n') }, 'remote');
    const r = await fetchRemote(fx.c);
    await fx.c.write('note.md', SIX.replace('l6\n', 'l6 local\n'));     // merges with the remote hunk
    await fx.c.write('c.md', SIX.replace('l3\n', 'l3 local\n'));        // conflicts
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    expect(await fx.c.read('note.md')).toBe(SIX.replace('l1\n', 'l1 remote\n').replace('l6\n', 'l6 local\n'));
    expect(await fx.c.read('other.md')).toBe('other remote\n');
    expect(await fx.c.read('gone.md')).toBeUndefined();
    expect(await fx.c.read('new.md')).toBe('new\n');
    expect(await fx.c.read('c.md')).toBe(SIX.replace('l3\n', 'l3 remote\n'));
    expect(mv.copies).toHaveLength(1);
    expect(await fx.c.read(mv.copies[0] as string)).toBe(SIX.replace('l3\n', 'l3 local\n'));
    expect(mv.commit).not.toBe('none');
    expect(await fx.c.head()).toBe(mv.final);
    expect(await out(fx.c, ['rev-parse', `${mv.final}^`])).toBe(r);
    expect((await fx.c.porcelain()).filter((l) => !l.includes('.mdsync-'))).toEqual([' M note.md']);
    expect(fx.logs.find((l) => l.msg === 'conflict')?.kind).toBe('stash');
    expect(worktreeWriters(fx.logs)).toEqual([]);
    expect(readJournal(fx.ctx.paths.journal)).toMatchObject({ settle: expect.any(Array) });
    await settleNow(fx);
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
    expect(tempFolders(fx.c.dir)).toEqual([]);
  }, 30_000);

  test('a write between the survey and the switch is never overwritten: the next round merges it', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    await fx.remote.push({ 'note.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
    const r = await fetchRemote(fx.c);
    process.env.MDSYNC_TEST_MOVE_PAUSE_MS = '300';
    try {
      const p = moveWorktree(fx.ctx, pullInput(h, r));
      await Bun.sleep(150);
      appendFileSync(join(fx.c.dir, 'note.md'), 'agent line\n');
      const mv = await p;
      expect(mv.kind).toBe('moved');
    } finally {
      delete process.env.MDSYNC_TEST_MOVE_PAUSE_MS;
    }
    expect(await fx.c.read('note.md')).toBe(`${SIX.replace('l1\n', 'l1 remote\n')}agent line\n`);
    expect(worktreeWriters(fx.logs)).toEqual([]);
  }, 30_000);

  test('untracked files in the way: identical kept, different copied (committed), ignored ones copied local-only', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', '.gitignore': 'secret*\n' } });
    const h = await fx.c.head();
    await fx.c.write('same.md', 'same\n');
    await fx.c.write('diff.md', 'local diff\n');
    const hh = await cloneRemote(t, fx.remote, `pusher-${++n}`);
    await hh.write('same.md', 'same\n');
    await hh.write('diff.md', 'remote diff\n');
    await hh.write('secret-key.md', 'remote secret\n');
    await out(hh, ['add', '-f', '-A']);
    await out(hh, ['commit', '-qm', 'in']);
    await out(hh, ['push', '-q', 'origin', 'HEAD:main']);
    await fx.c.write('secret-key.md', 'local secret\n');
    const r = await fetchRemote(fx.c);
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    expect(await fx.c.read('same.md')).toBe('same\n');
    expect(await fx.c.read('diff.md')).toBe('remote diff\n');
    expect(await fx.c.read('secret-key.md')).toBe('remote secret\n');
    const copies = (await fx.c.files()).filter((p) => CONFLICT_COPY_RE.test(p)).sort();
    expect(copies).toHaveLength(2);
    const diffCopy = copies.find((p) => p.startsWith('diff')) as string;
    const secretCopy = copies.find((p) => p.startsWith('secret')) as string;
    expect(await fx.c.read(diffCopy)).toBe('local diff\n');
    expect(await fx.c.read(secretCopy)).toBe('local secret\n');
    expect(await treeOf(fx.c, 'HEAD')).toContain(diffCopy);
    expect(await treeOf(fx.c, 'HEAD')).not.toContain(secretCopy);
    expect([...readLocalOnly(fx.ctx.paths.localOnly)]).toEqual([secretCopy]);
    const col = fx.logs.filter((l) => l.msg === 'collision');
    expect(col.find((l) => l.incoming === 'same.md')?.action).toBe('kept-identical');
    expect(col.find((l) => l.incoming === 'diff.md')?.action).toBe('renamed');
    expect(worktreeWriters(fx.logs)).toEqual([]);
  }, 30_000);
});

async function treeOf(c: Clone, rev: string): Promise<string[]> {
  return (await out(c, ['ls-tree', '-r', '--name-only', '-z', rev])).split('\0').filter((p) => p !== '');
}

async function moveTo(fx: Fx, files: Record<string, string | null>, o: { edits?: 'merge' | 'copy' } = {}): Promise<{ h: string; r: string;
  mv: Awaited<ReturnType<typeof moveWorktree>> }> {
  const h = await fx.c.head();
  await fx.remote.push(files, 'remote');
  const r = await fetchRemote(fx.c);
  const mv = await moveWorktree(fx.ctx, { ...pullInput(h, r), ...(o.edits !== undefined ? { edits: o.edits } : {}) });
  return { h, r, mv };
}

describe('paths in the way and folder/file transitions (the old collision rules)', () => {
  test('a tracked folder the remote turns into a file: tracked entries go, untracked ones move with the folder', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'd/x.md': 'x\n', 'd/y.md': 'y\n' } });
    await fx.c.write('d/untracked.md', 'mine\n');
    await fx.remote.push({ d: null }, 'remove the folder');   // the harness writes in key order: two commits
    const { mv } = await moveTo(fx, { d: 'd is a file now\n' });
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    expect(await fx.c.read('d')).toBe('d is a file now\n');
    const copy = (await fx.c.files()).find((p) => p.endsWith('/untracked.md') && CONFLICT_COPY_RE.test(p.split('/')[0] as string));
    expect(copy).toBeDefined();
    expect(await fx.c.read(copy as string)).toBe('mine\n');
    expect(fx.logs.find((l) => l.msg === 'collision')).toMatchObject({ incoming: 'd', action: 'moved-folder' });
    expect(worktreeWriters(fx.logs)).toEqual([]);

    // and without untracked files inside: the folder just goes, the file arrives in the same run
    const fx2 = await fixture({ seed: { 'README.md': '# n\n', 'e/x.md': 'x\n' } });
    await fx2.remote.push({ e: null }, 'remove the folder');
    const m2 = await moveTo(fx2, { e: 'e file\n' });
    expect(m2.mv.kind).toBe('moved');
    expect(await fx2.c.read('e')).toBe('e file\n');
    expect(await fx2.c.conflictCopies()).toEqual([]);
  });

  test('a local file where the remote needs a folder, and a local folder where it needs a file', async () => {
    const fx = await fixture();
    await fx.c.write('topic', 'local topic file\n');
    await fx.c.write('area/n.md', 'local area note\n');
    const { mv } = await moveTo(fx, { 'topic/x.md': 'remote topic note\n', area: 'remote area file\n' });
    expect(mv.kind).toBe('moved');
    expect(await fx.c.read('topic/x.md')).toBe('remote topic note\n');
    expect(await fx.c.read('area')).toBe('remote area file\n');
    const files = await fx.c.files();
    const topicCopy = files.find((p) => p.startsWith('topic (conflict ')) as string;
    expect(await fx.c.read(topicCopy)).toBe('local topic file\n');
    const areaCopy = files.find((p) => p.startsWith('area (conflict ')) as string;
    expect(areaCopy).toMatch(/^area \(conflict [^/]+\)\/n\.md$/);
    expect(await fx.c.read(areaCopy)).toBe('local area note\n');
    expect(await fx.c.porcelain()).toEqual([]);   // both copies committed (copies-only commit)
  });

  test('an uncommitted edit of a note the remote deletes stays (edit wins), and a gitlink gets its folder', async () => {
    const fx = await fixture();
    await fx.c.write('other.md', 'edited locally\n');
    const h = await fx.c.head();
    const sub = h;
    const helper = await cloneRemote(t, fx.remote, `gl-${++n}`);
    await out(helper, ['rm', '-q', 'other.md']);
    await out(helper, ['update-index', '--add', '--cacheinfo', `160000,${sub},vendor/lib`]);
    await out(helper, ['commit', '-qm', 'delete other, add a gitlink']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    expect(await fx.c.read('other.md')).toBe('edited locally\n');
    expect(mv.overridden).toEqual([{ path: 'other.md', deletedBy: 'remote' }]);
    expect(lstatSync(join(fx.c.dir, 'vendor/lib')).isDirectory()).toBe(true);
    expect((await fx.c.porcelain()).sort()).toEqual(['?? other.md']);
  });

  test('a remote rename of an edited note: the edit lands in the new name, the old name goes, no delete overridden', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'old.md': SIX } });
    const h = await fx.c.head();
    const helper = await cloneRemote(t, fx.remote, `mv-${++n}`);
    await out(helper, ['mv', 'old.md', 'new.md']);
    await helper.write('new.md', SIX.replace('l1\n', 'l1 remote\n'));
    await out(helper, ['commit', '-qam', 'rename and edit']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    await fx.c.write('old.md', SIX.replace('l6\n', 'l6 local\n'));
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    expect(await fx.c.read('old.md')).toBeUndefined();
    expect(await fx.c.read('new.md')).toBe(SIX.replace('l1\n', 'l1 remote\n').replace('l6\n', 'l6 local\n'));
    expect(mv.overridden).toEqual([]);
    expect(fx.logs.some((l) => l.msg === 'delete overridden')).toBe(false);
    expect(await fx.c.porcelain()).toEqual([' M new.md']);
  });
});

describe('repo settings and attributes', () => {
  test('`to` adds eol=crlf: CRLF is written (the move smudges with to\'s attributes)', async () => {
    const fx = await fixture();
    const { mv } = await moveTo(fx, { '.gitattributes': '*.txt eol=crlf\n', 'w.txt': 'one\ntwo\n' });
    expect(mv.kind).toBe('moved');
    expect(readFileSync(join(fx.c.dir, 'w.txt'), 'latin1')).toBe('one\r\ntwo\r\n');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('`to` adds a filter driven by a configured driver: the smudged bytes are written', async () => {
    const fx = await fixture();
    await out(fx.c, ['config', 'filter.upper.smudge', 'tr a-z A-Z']);
    await out(fx.c, ['config', 'filter.upper.clean', 'tr A-Z a-z']);
    const { mv } = await moveTo(fx, { '.gitattributes': '*.up filter=upper\n', 'x.up': 'shout\n' });
    expect(mv.kind).toBe('moved');
    expect(await fx.c.read('x.up')).toBe('SHOUT\n');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('core.fileMode=false with every file executable on disk: remote deletes and edits still apply', async () => {
    const fx = await fixture();
    await out(fx.c, ['config', 'core.fileMode', 'false']);
    for (const f of await fx.c.files()) chmodSync(join(fx.c.dir, f), 0o755);
    const { mv } = await moveTo(fx, { 'other.md': null, 'note.md': SIX.replace('l1', 'R1') });
    expect(mv.kind).toBe('moved');
    expect(await fx.c.read('other.md')).toBeUndefined();
    expect(await fx.c.read('note.md')).toBe(SIX.replace('l1', 'R1'));
    expect(await fx.c.conflictCopies()).toEqual([]);
  });

  test('core.symlinks=false: a symlink is a plain file holding its target, and moves like one', async () => {
    const fx = await fixture();
    await out(fx.c, ['config', 'core.symlinks', 'false']);
    const h = await fx.c.head();
    const helper = await cloneRemote(t, fx.remote, `sl-${++n}`);
    symlinkSync('note.md', join(helper.dir, 'link.md'));
    await out(helper, ['add', 'link.md']);
    await out(helper, ['commit', '-qm', 'symlink']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    expect(lstatSync(join(fx.c.dir, 'link.md')).isFile()).toBe(true);
    expect(await fx.c.read('link.md')).toBe('note.md');
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test('changed paths use stdin for checkout and index updates (ARG_MAX)', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    const helper = await cloneRemote(t, fx.remote, `bulk-${++n}`);
    const paths = Array.from({ length: 128 }, (_, i) => `bulk/n${i}.md`);
    mkdirSync(join(helper.dir, 'bulk'));
    for (const [i, path] of paths.entries()) writeFileSync(join(helper.dir, path), `${i}\n`);
    await out(helper, ['add', '-A']);
    await out(helper, ['commit', '-qm', 'bulk import']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    const git = fx.ctx.git;
    const inputs = new Map<string, string>();
    fx.ctx.git = { ...git, run: (args, options) => {
      if (args.includes('checkout-index') || args.includes('update-index')) {
        const command = args.includes('checkout-index') ? 'checkout-index' : 'update-index';
        if (options?.input !== undefined) {
          const input = typeof options.input === 'string' ? options.input : new TextDecoder().decode(options.input);
          inputs.set(command, (inputs.get(command) ?? '') + input);
        }
      }
      return git.run(args, options);
    } };
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    // Assert the transport directly: even one path on argv fails, without moving 25,000 real files.
    for (const line of fx.logs.filter((l) => l.msg === 'git')) {
      expect((line.args as string[]).some((arg) => arg.includes('bulk/'))).toBe(false);
    }
    for (const path of paths) {
      expect(inputs.get('checkout-index')).toContain(`${path}\0`);
      expect(inputs.get('update-index')).toContain(`\t${path}\0`);
    }
    expect(await fx.c.read('bulk/n127.md')).toBe('127\n');
    expect(await fx.c.porcelain()).toEqual([]);
    expect(worktreeWriters(fx.logs)).toEqual([]);
  }, 30_000);
});

describe('termination, the done map and resume', () => {
  test('a path rewritten every 50 ms through the whole move: moved (never busy), an identity copy holds the bytes', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    await fx.remote.push({ 'note.md': SIX.replace('l1\n', 'l1 remote\n') }, 'remote');
    const r = await fetchRemote(fx.c);
    let i = 0;
    let last = '';
    const timer = setInterval(() => {
      last = `rewrite ${++i}\n`;
      writeFileSync(join(fx.c.dir, 'note.md'), last);
    }, 50);
    process.env.MDSYNC_TEST_MOVE_PAUSE_MS = '200';
    let mv;
    try {
      mv = await moveWorktree(fx.ctx, pullInput(h, r));
    } finally {
      delete process.env.MDSYNC_TEST_MOVE_PAUSE_MS;
      await Bun.sleep(120);
      clearInterval(timer);
    }
    expect(mv.kind).toBe('moved');
    // the writer's last bytes are at the path (it kept writing) or in the identity copy that holds its inode
    const all = await Promise.all((await fx.c.files()).map((f) => fx.c.read(f)));
    expect(all).toContain(last);
    expect(fx.logs.some((l) => l.msg === 'worktree write raced' && l.kind === 'changing')).toBe(true);
  }, 30_000);

  test('the journal phases: a crash at the index step, at the ref step and after it resume forward', async () => {
    for (const step of ['index', 'ref', 'ref-moved'] as const) {
      const fx = await fixture();
      const h = await fx.c.head();
      await fx.remote.push({ 'note.md': SIX.replace('l1\n', 'l1 remote\n'), 'new.md': 'n\n' }, 'remote');
      const r = await fetchRemote(fx.c);
      await fx.c.write('other.md', 'mine\n');
      moveTestHooks.atStep = (s) => (s === step ? 'crash' : 'go');
      try {
        await expect(moveWorktree(fx.ctx, pullInput(h, r))).rejects.toThrow('simulated crash');
      } finally {
        delete moveTestHooks.atStep;
      }
      const j = readJournal(fx.ctx.paths.journal);
      if (j === 'none' || j.move === undefined) throw new Error(`no move part after a crash at ${step}`);
      expect(j.move.phase).toBe(step === 'ref-moved' ? 'ref' : step);
      expect(await fx.c.head()).toBe(step === 'ref-moved' ? r : h);
      const res = await resumeMove(fx.ctx, j.move);
      expect(res.kind).toBe('moved');
      expect(await fx.c.head()).toBe(r);
      expect(await fx.c.read('note.md')).toBe(SIX.replace('l1\n', 'l1 remote\n'));
      expect(await fx.c.read('other.md')).toBe('mine\n');
      expect(await fx.c.porcelain()).toEqual([' M other.md']);
      const after = readJournal(fx.ctx.paths.journal);
      expect(after === 'none' || after.move === undefined).toBe(true);
    }
  }, 60_000);

  test('the index keeps the stat data of the entries the move did not touch', async () => {
    const fx = await fixture();
    const stat = async (): Promise<string> => (await out(fx.c, ['ls-files', '--debug', 'README.md']));
    const before = await stat();
    const { mv } = await moveTo(fx, { 'note.md': SIX.replace('l2', 'R2') });
    expect(mv.kind).toBe('moved');
    expect(await stat()).toBe(before);
  });
});

describe('undo and settle', () => {
  test.if(process.getuid?.() !== 0)('M9: a put on a read-only folder fails: content from git goes back, merges and copies stay, nothing exchanged back', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'note.md': SIX, 'c.md': SIX, 'ro/keep.md': 'k\n', 'x.md': 'x\n' } });
    const h = await fx.c.head();
    await fx.remote.push({ 'x.md': 'x remote\n', 'note.md': SIX.replace('l1\n', 'l1 remote\n'), 'c.md': SIX.replace('l3\n', 'l3 R\n'),
      'ro/new.md': 'blocked\n' }, 'remote');
    const r = await fetchRemote(fx.c);
    await fx.c.write('note.md', SIX.replace('l6\n', 'l6 local\n'));   // merges
    await fx.c.write('c.md', SIX.replace('l3\n', 'l3 L\n'));            // conflicts: a copy
    chmodSync(join(fx.c.dir, 'ro'), 0o555);
    let mv;
    try {
      mv = await moveWorktree(fx.ctx, pullInput(h, r));
    } finally {
      chmodSync(join(fx.c.dir, 'ro'), 0o755);
    }
    expect(mv.kind).toBe('failed');
    expect(await fx.c.head()).toBe(h);
    expect(await fx.c.read('x.md')).toBe('x\n');                                       // from git: back
    expect(await fx.c.read('note.md')).toContain('l6 local');                          // holds the edit: kept
    const copies = await fx.c.conflictCopies();
    expect(await Promise.all(copies.map((c) => fx.c.read(c)))).toContain(SIX.replace('l3\n', 'l3 L\n'));   // the copy stays
    const j = readJournal(fx.ctx.paths.journal);
    expect(j === 'none' || j.move === undefined).toBe(true);
    expect(worktreeWriters(fx.logs)).toEqual([]);
  });

  test('settle: a write through a descriptor opened before the switch and issued later is kept as a late copy', async () => {
    const fx = await fixture();
    const fd = openSync(join(fx.c.dir, 'note.md'), 'a');   // an agent holds the old version open
    const { mv } = await moveTo(fx, { 'note.md': SIX.replace('l1\n', 'l1 remote\n') });
    expect(mv.kind).toBe('moved');
    await Bun.sleep(1_000);
    writeSync(fd, 'WRITTEN A SECOND LATER\n');
    closeSync(fd);
    expect((await settlePending(fx.ctx, 'due')).late).toEqual([]);   // not due yet: the grace has not passed
    await Bun.sleep(SETTLE_GRACE_MS);
    const s = await settlePending(fx.ctx, 'due');
    expect(s.late).toHaveLength(1);
    expect(await fx.c.read(s.late[0] as string)).toBe(`${SIX}WRITTEN A SECOND LATER\n`);
    expect(fx.logs.some((l) => l.msg === 'worktree write raced' && l.kind === 'late')).toBe(true);
    expect(tempFolders(fx.c.dir)).toEqual([]);
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
  }, 30_000);

  test('an orphan temp folder (the state dir was wiped mid-move) becomes `recovered (conflict …)`, local-only', async () => {
    const fx = await fixture();
    const orphan = join(fx.c.dir, '.mdsync-99999-1.d');
    mkdirSync(orphan);
    writeFileSync(join(orphan, '1'), SIX);                 // a blob of HEAD's tree: in a commit, pruned
    writeFileSync(join(orphan, '2'), 'an ignored .env that was in the way\n');
    const r = await recoverOrphanTemps(fx.ctx);
    expect(r).not.toBe('none');
    if (r === 'none') return;
    expect(r.count).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    const kept = r.paths[0] as string;
    expect(kept).toMatch(/^recovered \(conflict [^/]+\)\/2$/);
    expect(await fx.c.read(kept)).toBe('an ignored .env that was in the way\n');
    expect([...readLocalOnly(fx.ctx.paths.localOnly)]).toEqual([kept]);
  });
});

describe('spellings on a case-insensitive filesystem', () => {
  const ci = process.platform === 'darwin';
  test.if(ci)('a remote case-only rename: no delete, the disk spelling follows', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'Notes.md': 'old\n' } });
    const h = await fx.c.head();
    const helper = await cloneRemote(t, fx.remote, `case-${++n}`);
    await out(helper, ['mv', 'Notes.md', 'notes.md']);
    await helper.write('notes.md', 'new\n');
    await out(helper, ['add', '-A']);
    await out(helper, ['commit', '-qm', 'case rename']);
    await out(helper, ['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    const ino = lstatSync(join(fx.c.dir, 'Notes.md')).ino;
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    expect(readdirSync(fx.c.dir).filter((x) => x.toLowerCase() === 'notes.md')).toEqual(['notes.md']);
    expect(await fx.c.read('notes.md')).toBe('new\n');
    expect(lstatSync(join(fx.c.dir, 'notes.md')).ino).not.toBe(ino);
    expect(await fx.c.conflictCopies()).toEqual([]);
    expect(await fx.c.porcelain()).toEqual([]);
  });

  test.if(ci)('remote case twins: one disk entry, both index entries, moved', async () => {
    const fx = await fixture();
    const h = await fx.c.head();
    const helper = await cloneRemote(t, fx.remote, `twins-${++n}`);
    const g = (args: string[], input?: string): string => Bun.spawnSync(['git', '-c', 'core.precomposeunicode=false', ...args],
      { cwd: helper.dir, env: t.env, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) }).stdout.toString().trim();
    for (const [p, body] of [['Case.md', 'upper\n'], ['case.md', 'lower\n']] as const) {
      g(['update-index', '--add', '--cacheinfo', `100644,${g(['hash-object', '-w', '--stdin'], body)},${p}`]);
    }
    g(['commit', '-qm', 'twins']);
    g(['push', '-q', 'origin', 'HEAD:main']);
    const r = await fetchRemote(fx.c);
    const mv = await moveWorktree(fx.ctx, pullInput(h, r));
    expect(mv.kind).toBe('moved');
    expect(readdirSync(fx.c.dir).filter((x) => x.toLowerCase() === 'case.md')).toHaveLength(1);
    expect((await out(fx.c, ['ls-files', '-z'])).split('\0').filter((x) => x.toLowerCase() === 'case.md').sort()).toEqual(['Case.md', 'case.md']);
    expect(await fx.c.head()).toBe(r);
  });
});

// Chaos round 1 after the D28 close (32-chaos seeds 100–119): each test reproduces one root cause deterministically.
describe('chaos round 1 regressions', () => {
  const noTemps = (lines: string[]): string[] => lines.filter((l) => !l.includes('.mdsync-'));
  const inoOf = (fx: Fx, p: string): bigint => lstatSync(join(fx.c.dir, p), { bigint: true }).ino;

  test('seed 110: an edited note renamed away between the survey and the classification comes back with the remote edit', async () => {
    const fx = await fixture();
    await fx.c.write('note.md', SIX.replace('l6\n', 'l6 local\n'));   // device A's uncommitted edit
    // the agent renames it while the move materializes (after M2 hashed it, before M3 re-reads it)
    moveTestHooks.afterSurvey = (round) => {
      if (round === 1) renameSync(join(fx.c.dir, 'note.md'), join(fx.c.dir, 'moved.md'));
    };
    let mv;
    try {
      ({ mv } = await moveTo(fx, { 'note.md': SIX.replace('l1\n', 'l1 remote\n') }));
    } finally {
      delete moveTestHooks.afterSurvey;
    }
    expect(mv.kind).toBe('moved');
    // either serial order keeps the remote edit: an edit against a local delete is delete-overridden (the edit wins over the delete)
    expect(await fx.c.read('note.md')).toBe(SIX.replace('l1\n', 'l1 remote\n'));
    expect(await fx.c.read('moved.md')).toBe(SIX.replace('l6\n', 'l6 local\n'));
    expect(fx.logs.some((l) => l.msg === 'delete overridden' && l.path === 'note.md')).toBe(true);
    expect(noTemps(await fx.c.porcelain())).toEqual(['?? moved.md']);   // no ` D note.md` for the next commit to push
    expect(worktreeWriters(fx.logs)).toEqual([]);
  });

  // A settle entry as a move leaves it: `bytes` sit at a fresh name in the process's temp folder, replacing `replaced`.
  function lateAside(fx: Fx, path: string, bytes: string, replaced: string, n0: number): SettleEntry {
    const name = `${processTempDir()}/chaos-${n0}`;
    mkdirSync(join(fx.c.dir, processTempDir()), { recursive: true });
    writeFileSync(join(fx.c.dir, name), bytes);
    const b = new TextEncoder().encode(replaced);
    const e: SettleEntry = { name, path, ino: String(lstatSync(join(fx.c.dir, name), { bigint: true }).ino),
      expect: { kind: 'file', size: b.length, sha256: sha256Hex(b) }, copy: 'none', since: Date.now() - SETTLE_GRACE_MS - 1 };
    mutateJournal(fx.ctx.paths.journal, (j) => ({ ...j, settle: [...(j.settle ?? []), e] }));
    return e;
  }

  test('seeds 105/117: a late write whose folder became a file is kept under a copy of that folder; the call never fails', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'd/e': 'd/e is a file in HEAD\n' } });
    lateAside(fx, 'd/e/g.md', 'replaced\nLATE WRITE\n', 'replaced\n', 1);
    const s = await settlePending(fx.ctx, 'due');   // threw `conflictCopyPath: no free name` and failed every run
    expect(s.late).toHaveLength(1);
    const copy = s.late[0] as string;
    expect(copy).toMatch(/^d\/e \(conflict [^()]+\)\/g\.md$/);
    expect(await fx.c.read(copy)).toBe('replaced\nLATE WRITE\n');
    expect(s.dueAt).toBe('none');
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
    expect(tempFolders(fx.c.dir)).toEqual([]);
  });

  test('seeds 105/117, S5: bytes written during settle\'s unlink are copied out under the renamed folder, never dropped', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'd/e': 'd/e is a file in HEAD\n' } });
    const e = lateAside(fx, 'd/e/g.md', 'replaced\n', 'replaced\n', 2);
    const fd = openSync(join(fx.c.dir, e.name), 'a');   // a writer that opened the old version before the switch
    moveTestHooks.settle = { afterUnlink: () => writeSync(fd, 'WRITTEN DURING THE UNLINK\n') };
    let s;
    try {
      s = await settlePending(fx.ctx, 'due');
    } finally {
      delete moveTestHooks.settle;
      closeSync(fd);
    }
    expect(s.late).toHaveLength(1);
    expect(s.late[0]).toMatch(/^d\/e \(conflict [^()]+\)\/g\.md$/);
    expect(await fx.c.read(s.late[0] as string)).toBe('replaced\nWRITTEN DURING THE UNLINK\n');
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
  });

  test.if(process.getuid?.() !== 0)('an entry that can\'t be kept anywhere now stays, due after another grace; others still settle', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'd/e': 'd/e is a file in HEAD\n' } });
    const stuck = lateAside(fx, 'd/e/g.md', 'replaced\nLATE\n', 'replaced\n', 3);
    const clean = lateAside(fx, 'README.md', '# n\n', '# n\n', 4);
    chmodSync(join(fx.c.dir, 'd'), 0o555);
    chmodSync(fx.c.dir, 0o555);
    let s;
    try {
      s = await settlePending(fx.ctx, 'due');
    } finally {
      chmodSync(fx.c.dir, 0o755);
      chmodSync(join(fx.c.dir, 'd'), 0o755);
    }
    expect(s.late).toEqual([]);
    expect(typeof s.dueAt === 'number' && s.dueAt > Date.now() + SETTLE_GRACE_MS / 2).toBe(true);   // not overdue: no hot loop
    const j = readJournal(fx.ctx.paths.journal);
    expect(j !== 'none' && j.settle?.map((x) => x.name)).toEqual([stuck.name]);   // the clean one went
    expect(existsSync(join(fx.c.dir, clean.name))).toBe(false);
    mutateJournal(fx.ctx.paths.journal, (x) => ({ ...x, settle: (x.settle ?? []).map((y) => ({ ...y, since: Date.now() - SETTLE_GRACE_MS - 1 })) }));
    const again = await settlePending(fx.ctx, 'due');
    expect(again.late).toHaveLength(1);
    expect(await fx.c.read(again.late[0] as string)).toBe('replaced\nLATE\n');
    expect(readJournal(fx.ctx.paths.journal)).toBe('none');
  });

  test('copyNamer: a copy under a folder that is a file (in HEAD, or on disk) goes under a copy of that folder', async () => {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'd/e': 'file\n' } });
    writeFileSync(join(fx.c.dir, 'x'), 'an untracked file\n');
    const name = copyNamer(fx.ctx, ['README.md', 'd/e'], '2026-10-08 1234');
    const host = fx.ctx.host;
    expect(name('d/e/g.md')).toBe(`d/e (conflict ${host} 2026-10-08 1234)/g.md`);
    expect(name('d/e/h.md')).toBe(`d/e (conflict ${host} 2026-10-08 1234)/h.md`);   // the same copy folder
    expect(name('x/y/z.md')).toBe(`x (conflict ${host} 2026-10-08 1234)/y/z.md`);
    expect(name('d/f.md')).toBe(`d/f (conflict ${host} 2026-10-08 1234).md`);        // unchanged where nothing blocks
  });

  test('seed 103: a conflict copy edited within the grace: no second copy, no inode shared by two worktree names', async () => {
    const fx = await fixture();
    await fx.c.write('note.md', SIX.replace('l3\n', 'l3 local\n'));
    const { mv } = await moveTo(fx, { 'note.md': SIX.replace('l3\n', 'l3 remote\n') });
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    const copy = mv.copies[0] as string;
    appendFileSync(join(fx.c.dir, copy), 'the agent edits the conflict copy\n');
    await settleNow(fx);
    expect(fx.logs.filter((l) => l.msg === 'worktree write raced')).toEqual([]);
    expect(await fx.c.conflictCopies()).toEqual([copy]);
    expect(lstatSync(join(fx.c.dir, copy)).nlink).toBe(1);
    expect(await fx.c.read(copy)).toBe(`${SIX.replace('l3\n', 'l3 local\n')}the agent edits the conflict copy\n`);
    expect(tempFolders(fx.c.dir)).toEqual([]);
  });

  test('a move that fails after a copy was made leaves the copy an inode of its own (M9)', async () => {
    const fx = await fixture();
    await fx.c.write('note.md', SIX.replace('l3\n', 'l3 local\n'));
    const h = await fx.c.head();
    await fx.remote.push({ 'note.md': SIX.replace('l3\n', 'l3 remote\n') }, 'remote');
    const r = await fetchRemote(fx.c);
    let fired: 'no' | 'yes' = 'no';
    moveTestHooks.afterOp = (_n, path) => {
      if (path === 'note.md' && fired === 'no') {   // right after the copy, before note.md's put
        fired = 'yes';
        appendFileSync(join(fx.c.dir, 'note.md'), 'agent\n');   // the put finds other bytes: changed
        Bun.spawnSync(['git', 'update-ref', 'refs/heads/main', r], { cwd: fx.c.dir, env: t.env });   // and M6 fails the move
      }
      return 'go';
    };
    let mv;
    try {
      mv = await moveWorktree(fx.ctx, pullInput(h, r));
    } finally {
      delete moveTestHooks.afterOp;
    }
    expect(mv.kind).toBe('failed');
    const copies = await fx.c.conflictCopies();
    expect(copies).toHaveLength(1);
    const copy = copies[0] as string;
    expect(inoOf(fx, copy)).not.toBe(inoOf(fx, 'note.md'));
    expect(await fx.c.read('note.md')).toBe(`${SIX.replace('l3\n', 'l3 local\n')}agent\n`);
    expect(await fx.c.read(copy)).toBe(`${SIX.replace('l3\n', 'l3 local\n')}agent\n`);   // a snapshot: nothing lost
    await settleNow(fx);
    expect(lstatSync(join(fx.c.dir, 'note.md')).nlink).toBe(1);   // the copy's old link waited in the temp folder until now
    expect(fx.logs.filter((l) => l.msg === 'worktree write raced')).toEqual([]);
    expect(tempFolders(fx.c.dir)).toEqual([]);
  });

  test('applyOps: a copy whose put was skipped (the path changed) gets an inode of its own; a done put records it', async () => {
    const fx = await fixture();
    await fx.c.write('note.md', 'conflicted\n');
    await fx.c.write('other.md', 'conflicted too\n');
    const head = await fx.c.head();
    const j: MoveJournal = { op: 'move', reason: 'unmerged-recovery', phase: 'writing', from: head, head: { sha: head, ref: 'refs/heads/main' },
      to: head, base: head, ref: { kind: 'none' }, index: 'reset', temps: [], copies: [], startedAt: new Date().toISOString() };
    const src = join(fx.ctx.paths.tmp, 'want-head');
    mkdirSync(fx.ctx.paths.tmp, { recursive: true });
    writeFileSync(src, SIX);
    const want = { kind: 'file', src, exec: 'plain' } as const;
    const seen = (p: string): Digest => digestAt(fx.c.dir, p) as Digest;
    moveTestHooks.afterOp = (_n, path) => {
      if (path === 'note.md' && (readFileSync(join(fx.c.dir, 'note.md'), 'utf8')) === 'conflicted\n') appendFileSync(join(fx.c.dir, 'note.md'), 'agent\n');
      return 'go';
    };
    let a;
    try {
      a = await applyOps(fx.ctx, [
        { op: 'copy', path: 'note.md', copy: 'note (c).md', expect: seen('note.md') },
        { op: 'put', path: 'note.md', expect: seen('note.md'), want, copy: 'note (c).md' },
        { op: 'copy', path: 'other.md', copy: 'other (c).md', expect: seen('other.md') },
        { op: 'put', path: 'other.md', expect: seen('other.md'), want: { kind: 'absent' }, copy: 'other (c).md' },
      ], j, { onChanged: 'skip' });
    } finally {
      delete moveTestHooks.afterOp;
    }
    expect(a.kind).toBe('applied');
    if (a.kind !== 'applied') return;
    expect(a.skipped).toEqual(['note.md']);
    expect(inoOf(fx, 'note (c).md')).not.toBe(inoOf(fx, 'note.md'));
    expect(await fx.c.read('note (c).md')).toBe('conflicted\nagent\n');
    expect(await fx.c.read('other.md')).toBeUndefined();
    expect(a.asides.find((x) => x.path === 'other.md')?.copy).toBe('other (c).md');
    clearMovePart(fx.ctx, a.asides);
    appendFileSync(join(fx.c.dir, 'other (c).md'), 'edited within the grace\n');
    await settleNow(fx);
    expect(fx.logs.filter((l) => l.msg === 'worktree write raced')).toEqual([]);
    expect(tempFolders(fx.c.dir)).toEqual([]);
  });
});

// Chaos round 2 (32-chaos seeds 120–165): a committed conflict copy whose link round 1 refused (the agent changed or
// renamed the original between M3's hash and M5's link) was never written. M8 gave HEAD and the index the copy, the
// disk never got it, and the next commit pushed a delete nobody made (seeds 121, 138, 141, 149, 157, 158, 160, 164).
describe('chaos round 2 regressions', () => {
  const LOCAL = SIX.replace('l3\n', 'l3 local\n');
  const REMOTE = SIX.replace('l3\n', 'l3 remote\n');
  const noTemps = (lines: string[]): string[] => lines.filter((l) => !l.includes('.mdsync-'));

  // a.md and note.md both hold uncommitted edits that conflict with the remote's. Round 1 links a.md's copy first; the
  // agent's op on note.md runs right after it, so note.md's link (the next op) finds other bytes, or nothing.
  async function copyLinkScene(agent: (dir: string) => void): Promise<{ fx: Fx; mv: Awaited<ReturnType<typeof moveWorktree>>;
    committed: string[] }> {
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'a.md': SIX, 'note.md': SIX } });
    await fx.c.write('a.md', LOCAL);
    await fx.c.write('note.md', LOCAL);
    let fired: 'no' | 'yes' = 'no';
    moveTestHooks.afterOp = (_n, path) => {
      if (path === 'a.md' && fired === 'no') {   // a.md's copy is the round's first op
        fired = 'yes';
        agent(fx.c.dir);
      }
      return 'go';
    };
    let mv;
    try {
      ({ mv } = await moveTo(fx, { 'a.md': REMOTE, 'note.md': REMOTE }));
    } finally {
      delete moveTestHooks.afterOp;
    }
    expect(String(fired)).toBe('yes');   // the hook ran (set in a closure: tsc narrows the let)
    const committed = mv.kind === 'moved' ? (await treeOf(fx.c, mv.final)).filter((p) => CONFLICT_COPY_RE.test(p)) : [];
    return { fx, mv, committed };
  }

  // Every committed copy is on disk with the bytes that were committed: the next commit has nothing to delete.
  async function expectCommittedCopiesOnDisk(fx: Fx, committed: readonly string[]): Promise<void> {
    for (const c of committed) {
      expect({ c, bytes: await fx.c.read(c) }).toEqual({ c, bytes: (await fx.c.git(['show', `HEAD:${c}`])).stdout });
    }
    expect(noTemps(await fx.c.porcelain()).filter((l) => l.startsWith(' D') || l.startsWith('D'))).toEqual([]);
  }

  test('seed 121: the original rewritten before its link: the committed copy is written from its blob', async () => {
    const { fx, mv, committed } = await copyLinkScene((dir) => writeFileSync(join(dir, 'note.md'), 'agent rewrote the note\n'));
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    expect(mv.commit).not.toBe('none');
    expect(committed).toHaveLength(2);   // a.md's and note.md's (round 1's survey bytes)
    await expectCommittedCopiesOnDisk(fx, committed);
    const noteCopy = committed.find((p) => p.startsWith('note (')) as string;
    expect(await fx.c.read(noteCopy)).toBe(LOCAL);   // the snapshot round 1 committed
    // round 2 measured the rewrite against `from`: it conflicts too, so it is kept in an uncommitted copy
    const later = noTemps(await fx.c.porcelain());
    expect(later).toHaveLength(1);
    expect(later[0]).toMatch(/^\?\? note \(conflict .+\)\.md$/);
    expect(await fx.c.read(later[0]?.slice(3) as string)).toBe('agent rewrote the note\n');
    expect(await fx.c.read('note.md')).toBe(REMOTE);
    expect(await fx.c.read('a.md')).toBe(REMOTE);
    expect(worktreeWriters(fx.logs)).toEqual([]);
    await settleNow(fx);
    expect(tempFolders(fx.c.dir)).toEqual([]);
  });

  test('seeds 138–160: the original appended to before its link: the committed copy is written, the append is kept', async () => {
    const { fx, mv, committed } = await copyLinkScene((dir) => appendFileSync(join(dir, 'note.md'), 'agent appended\n'));
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    await expectCommittedCopiesOnDisk(fx, committed);
    expect(await fx.c.read(committed.find((p) => p.startsWith('note (')) as string)).toBe(LOCAL);
    const later = noTemps(await fx.c.porcelain());
    expect(later).toHaveLength(1);
    expect(await fx.c.read(later[0]?.slice(3) as string)).toBe(`${LOCAL}agent appended\n`);
    expect(worktreeWriters(fx.logs)).toEqual([]);
  });

  test('seed 164: the original renamed away before its link: the committed copy is written, the remote edit restored', async () => {
    const { fx, mv, committed } = await copyLinkScene((dir) => renameSync(join(dir, 'note.md'), join(dir, 'moved.md')));
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    await expectCommittedCopiesOnDisk(fx, committed);
    expect(await fx.c.read(committed.find((p) => p.startsWith('note (')) as string)).toBe(LOCAL);
    expect(await fx.c.read('note.md')).toBe(REMOTE);   // the local delete (the rename's) loses to the remote edit
    expect(await fx.c.read('moved.md')).toBe(LOCAL);
    expect(noTemps(await fx.c.porcelain())).toEqual(['?? moved.md']);
    expect(fx.logs.some((l) => l.msg === 'delete overridden' && l.path === 'note.md')).toBe(true);
    expect(worktreeWriters(fx.logs)).toEqual([]);
  });

  test('a committed copy that was linked and then deleted by the agent stays deleted in a later round', async () => {
    // note.md's copy is made; then the agent deletes that copy and appends to other.md, whose put then finds other
    // bytes, so the move runs a second round. The copy is the person's from its link on: their delete stands.
    const fx = await fixture({ seed: { 'README.md': '# n\n', 'note.md': SIX, 'other.md': SIX } });
    await fx.c.write('note.md', LOCAL);
    let fired: 'no' | 'yes' = 'no';
    moveTestHooks.afterOp = (_n, path) => {
      if (path === 'note.md' && fired === 'no') {   // right after note.md's copy, the round's first op
        fired = 'yes';
        const copy = readdirSync(fx.c.dir).find((x) => x.startsWith('note (conflict ')) as string;
        rmSync(join(fx.c.dir, copy));
        appendFileSync(join(fx.c.dir, 'other.md'), 'agent appended\n');
      }
      return 'go';
    };
    let mv;
    try {
      ({ mv } = await moveTo(fx, { 'note.md': REMOTE, 'other.md': SIX.replace('l1\n', 'l1 remote\n') }));
    } finally {
      delete moveTestHooks.afterOp;
    }
    expect(String(fired)).toBe('yes');   // the hook ran (set in a closure: tsc narrows the let)
    expect(mv.kind).toBe('moved');
    if (mv.kind !== 'moved') return;
    const committed = (await treeOf(fx.c, mv.final)).filter((p) => CONFLICT_COPY_RE.test(p));
    expect(committed).toHaveLength(1);
    expect(await fx.c.read(committed[0] as string)).toBeUndefined();
    expect(await fx.c.read('other.md')).toBe(`${SIX.replace('l1\n', 'l1 remote\n')}agent appended\n`);   // round 2 merged it
    expect(noTemps(await fx.c.porcelain()).sort()).toEqual([` D ${committed[0]}`, ' M other.md'].sort());
    expect(worktreeWriters(fx.logs)).toEqual([]);
  });

  test('a folder that moves whole, removed or replaced by a file before its move-aside: its committed copies are written', async () => {
    // The same defect for a folder: `d` holds an untracked note and the remote turns `d` into a file, so `d` moves whole
    // to its copy folder and the note's copy is committed. The agent acts on `d` right after the round's first op (the
    // delete of the tracked `d/x.md`). Skipped as 'missing', or moved as a file, the copy was in HEAD and not on disk.
    for (const agent of ['rm -r', 'replace with a file'] as const) {
      const fx = await fixture({ seed: { 'README.md': '# n\n', 'd/x.md': 'x\n' } });
      await fx.c.write('d/u.md', 'mine\n');
      await fx.remote.push({ d: null }, 'remove the folder');
      let fired: 'no' | 'yes' = 'no';
      moveTestHooks.afterOp = (_n, path) => {
        if (path === 'd/x.md' && fired === 'no') {
          fired = 'yes';
          rmSync(join(fx.c.dir, 'd'), { recursive: true, force: true });
          if (agent === 'replace with a file') writeFileSync(join(fx.c.dir, 'd'), 'agent file\n');
        }
        return 'go';
      };
      let mv;
      try {
        ({ mv } = await moveTo(fx, { d: 'd is a file now\n' }));
      } finally {
        delete moveTestHooks.afterOp;
      }
      expect(String(fired)).toBe('yes');
      expect(mv.kind).toBe('moved');
      if (mv.kind !== 'moved') return;
      const committed = (await treeOf(fx.c, mv.final)).filter((p) => p.includes('(conflict '));
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatch(/^d \(conflict [^/]+\)\/u\.md$/);
      await expectCommittedCopiesOnDisk(fx, committed);
      expect(await fx.c.read('d')).toBe('d is a file now\n');
      const rest = noTemps(await fx.c.porcelain());
      if (agent === 'rm -r') {
        expect(rest).toEqual([]);
      } else {
        // the agent's file at `d` conflicts with the remote's: kept in an uncommitted copy of its own
        expect(rest).toHaveLength(1);
        expect(await fx.c.read(rest[0]?.slice(3) as string)).toBe('agent file\n');
      }
      expect(worktreeWriters(fx.logs)).toEqual([]);
    }
  });
});

void [MOVE_ROUNDS, applyOps, replayCommits, existsSync, renameSync, rmSync];
