import { saveLegacyRescue, type RescueOptions } from '../helpers/legacy-rescue';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ReadyConfig } from '../../src/config';
import { createRunContext, type RunContext } from '../../src/context';
import { conflictStamp, shortHostname } from '../../src/host';
import { createLogger } from '../../src/log';
import { ensureStateDir, statePathsFor } from '../../src/paths';
import { pendingRescues, type RescueManifest, rescueRestore } from '../../src/rescue';
import {
  cleanupAll, cloneRemote, type Clone, createRemote, type LogLine, type Remote, setupTestEnv, type TestEnv,
} from '../harness';

let t: TestEnv;
let remote: Remote;
let n = 0;
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const FIXED = Date.UTC(2026, 9, 8, 12, 34, 56);
let now = FIXED;
const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
const TAG = `(conflict ${shortHostname()} ${conflictStamp(new Date(FIXED))})`;

const FULL: RescueOptions = { scope: 'full', unmerged: { kind: 'skip' }, owner: 'standalone' };
const UNTRACKED: RescueOptions = { scope: 'untracked-only', unmerged: { kind: 'skip' }, owner: 'standalone' };

beforeAll(async () => {
  t = await setupTestEnv('rescue');
  for (const k of ENV_KEYS) process.env[k] = t.env[k];
  remote = await createRemote(t, { files: { 'README.md': '# notes\n', 'a.md': 'a\n', 'b.md': 'b\n', 'projects': 'p\n' } });
});

afterAll(async () => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await cleanupAll();
});

type Setup = { c: Clone; ctx: RunContext; logs: LogLine[] };

async function setup(): Promise<Setup> {
  now = FIXED;
  const c = await cloneRemote(t, remote, `clone-${++n}`);
  const config: ReadyConfig = { dir: c.dir, remote: remote.url, branch: 'main', idleMs: 60_000, fallbackMs: 3_600_000,
    maxWaitMs: 120_000, autoCommit: 'timers', ignore: [], authorName: 'mdsync-test', authorEmail: 'test@test.invalid' };
  const paths = statePathsFor(c.dir, t.env);
  ensureStateDir(paths);
  const logs: LogLine[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => logs.push(JSON.parse(l) as LogLine) });
  return { c, ctx: await createRunContext({ config, realDir: c.dir, paths, log, clock }), logs };
}

async function git(c: Clone, args: string[]): Promise<string> {
  const r = await c.git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const read = (c: Clone, rel: string) => readFileSync(join(c.dir, rel), 'utf8');
const exists = (c: Clone, rel: string) => existsSync(join(c.dir, rel));

function saved(m: RescueManifest | 'nothing'): RescueManifest {
  if (m === 'nothing') throw new Error('expected a manifest');
  return m;
}

const summary = (m: RescueManifest) => m.entries.map((e) => [e.path, e.restore, e.saved.kind, e.base === 'none' ? 'none' : 'sha']);

describe('legacy rescue fixtures', () => {
  test("a clean worktree saves nothing and creates no dir; a touched-but-unchanged file doesn't count", async () => {
    const { c, ctx } = await setup();
    expect(await saveLegacyRescue(ctx, 'rebase-abort', [], FULL)).toBe('nothing');
    utimesSync(join(c.dir, 'a.md'), new Date(), new Date(Date.now() + 10_000));
    expect(await saveLegacyRescue(ctx, 'rebase-abort', [], FULL)).toBe('nothing');
    expect(existsSync(ctx.paths.rescue) ? readdirSync(ctx.paths.rescue) : []).toEqual([]);
  });

  test('tracked-dirty edits and deletions (full scope only); manifest written last, owner recorded', async () => {
    const { c, ctx } = await setup();
    await c.write('a.md', 'edited\n');
    await c.remove('b.md');
    expect(await saveLegacyRescue(ctx, 'rebase', [], UNTRACKED)).toBe('nothing');
    const m = saved(await saveLegacyRescue(ctx, 'rebase-conflict', [], { ...FULL, owner: 'journal' }));
    expect(summary(m)).toEqual([['a.md', 'auto', 'file', 'sha'], ['b.md', 'auto', 'deleted', 'sha']]);
    expect(m.owner).toBe('journal');
    expect(m.reason).toBe('rebase-conflict');
    expect(m.createdAt).toBe(new Date(FIXED).toISOString());
    const dir = join(ctx.paths.rescue, m.id);
    expect(readdirSync(dir).sort()).toEqual(['0.bin', 'manifest.json']);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).toEqual(m);
    expect(readFileSync(join(dir, '0.bin'), 'utf8')).toBe('edited\n');
    expect(m.id).toMatch(new RegExp(`^${FIXED}-${process.pid}-\\d+$`));
  });

  test('exceptTree skips edits a stash already holds', async () => {
    const { c, ctx } = await setup();
    await c.write('a.md', 'in stash\n');
    await c.write('b.md', 'in stash too\n');
    const S = await git(c, ['stash', 'create']);
    await c.write('b.md', 'edited after the stash\n');
    const m = saved(await saveLegacyRescue(ctx, 'rebase-conflict', [], { ...FULL, exceptTree: S }));
    expect(summary(m)).toEqual([['b.md', 'auto', 'file', 'sha']]);
  });

  test('gitWrote: what a half-done checkout of those trees left (their content, their absence) is not an edit', async () => {
    // S5 case (c): a rebase that stopped partway through checking out R deleted a local-only note and rewrote an
    // edited one; saving those as edits made the restore after `rebase --abort` delete the note again.
    const { c, ctx } = await setup();
    const head = await git(c, ['rev-parse', 'HEAD']);
    await c.remove('b.md');
    await c.write('a.md', 'R version\n');
    await git(c, ['add', '-A']);
    await git(c, ['commit', '-qm', 'R']);
    const R = await git(c, ['rev-parse', 'HEAD']);
    await git(c, ['reset', '-q', '--hard', head]);
    await c.remove('b.md');                       // what checking out R did to the local note
    await c.write('a.md', 'R version\n');         // ... and to the local edit
    await c.write('README.md', 'a real edit\n');  // an edit neither tree holds
    expect(summary(saved(await saveLegacyRescue(ctx, 'rebase-conflict', [], FULL))).map((e) => e[0])).toEqual(['README.md', 'a.md', 'b.md']);
    const m = saved(await saveLegacyRescue(ctx, 'rebase-conflict', [], { ...FULL, gitWrote: [R] }));
    expect(summary(m)).toEqual([['README.md', 'auto', 'file', 'sha']]);
  });

  test('at-risk untracked files, including one sitting where a tree needs a folder', async () => {
    const { c, ctx } = await setup();
    const head = await git(c, ['rev-parse', 'HEAD']);
    await c.write('d/x.md', 'dx\n');
    await c.write('new.md', 'n\n');
    await git(c, ['add', '-A']);
    await git(c, ['commit', '-qm', 'target']);
    const T = await git(c, ['rev-parse', 'HEAD']);
    await git(c, ['reset', '-q', '--hard', head]);
    await c.write('new.md', 'local untracked\n');
    await c.write('d', 'local file d\n');
    await c.write('unrelated.md', 'u\n');
    const m = saved(await saveLegacyRescue(ctx, 'rebase', [T], UNTRACKED));
    expect(summary(m)).toEqual([['d', 'auto', 'file', 'none'], ['new.md', 'auto', 'file', 'none']]);
  });
});

describe('rescueRestore', () => {
  test('a tracked parent absent from disk sends a legacy copy beside that parent', async () => {
    const { c, ctx } = await setup();
    await c.remove('projects');   // HEAD and the index still reserve this path as a file
    const id = `${FIXED}-${process.pid}-prefix`;
    const dir = join(ctx.paths.rescue, id);
    mkdirSync(dir, { recursive: true });
    const bytes = new TextEncoder().encode('saved local edit\n');
    writeFileSync(join(dir, '0.bin'), bytes);
    const m: RescueManifest = { id, reason: 'rebase-abort', owner: 'standalone', repo: 'unknown',
      createdAt: new Date(FIXED).toISOString(), entries: [{ path: 'projects/n.md', base: 'none', restore: 'copy-always',
        saved: { kind: 'file', file: '0.bin', rawSha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
          symlink: 'regular' } }] };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));

    const copy = `projects ${TAG}/n.md`;
    expect((await rescueRestore(ctx, m)).copies).toEqual([copy]);
    expect(read(c, copy)).toBe('saved local edit\n');
    expect(exists(c, 'projects')).toBe(false);
    expect(await git(c, ['show', 'HEAD:projects'])).toBe('p');
    expect(pendingRescues(ctx.paths)).toEqual([]);
  });

  test('cur == saved: nothing to do, the dir is removed, no log', async () => {
    const { c, ctx, logs } = await setup();
    await c.write('a.md', 'edited\n');
    const m = saved(await saveLegacyRescue(ctx, 'checkout', [], FULL));
    expect(await rescueRestore(ctx, m)).toEqual({ restored: [], copies: [], reDeleted: [], overridden: [] });
    expect(existsSync(join(ctx.paths.rescue, m.id))).toBe(false);
    expect(logs.filter((l) => l.msg === 'rescued files')).toEqual([]);
  });

  test('auto: base back at the path -> written in place; changed by the op -> conflict copy', async () => {
    const { c, ctx, logs } = await setup();
    await c.write('a.md', 'mine a\n');
    await c.write('b.md', 'mine b\n');
    const m = saved(await saveLegacyRescue(ctx, 'rebase-abort', [], FULL));
    await git(c, ['checkout', '--', 'a.md', 'b.md']);   // the destructive op puts the base back
    await c.write('b.md', 'theirs b\n');               // ...and something else changed b.md
    const r = await rescueRestore(ctx, m);
    expect(r).toEqual({ restored: ['a.md'], copies: [`b ${TAG}.md`], reDeleted: [], overridden: [] });
    expect(read(c, 'a.md')).toBe('mine a\n');
    expect(read(c, 'b.md')).toBe('theirs b\n');
    expect(read(c, `b ${TAG}.md`)).toBe('mine b\n');
    const log = logs.filter((l) => l.msg === 'rescued files');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ level: 'warn', reason: 'rebase-abort', restored: ['a.md'], copies: [`b ${TAG}.md`] });
  });

  test('auto, untracked: missing after the op -> written back; the tree version there -> copy', async () => {
    const { c, ctx } = await setup();
    const head = await git(c, ['rev-parse', 'HEAD']);
    await c.write('one.md', 'tree one\n');
    await c.write('two.md', 'tree two\n');
    await git(c, ['add', '-A']);
    await git(c, ['commit', '-qm', 'target']);
    const T = await git(c, ['rev-parse', 'HEAD']);
    await git(c, ['reset', '-q', '--hard', head]);
    await c.write('one.md', 'local one\n');
    await c.write('two.md', 'local two\n');
    const m = saved(await saveLegacyRescue(ctx, 'checkout', [T], UNTRACKED));
    await c.remove('one.md');
    await git(c, ['reset', '-q', '--hard', T]);        // overwrites both untracked files
    await c.remove('one.md');
    const r = await rescueRestore(ctx, m);
    expect(r).toEqual({ restored: ['one.md'], copies: [`two ${TAG}.md`], reDeleted: [], overridden: [] });
    expect(read(c, 'one.md')).toBe('local one\n');
    expect(read(c, 'two.md')).toBe('tree two\n');
    expect(read(c, `two ${TAG}.md`)).toBe('local two\n');
  });

  test('an untracked file where the op created a folder ends up as a copy', async () => {
    const { c, ctx } = await setup();
    const head = await git(c, ['rev-parse', 'HEAD']);
    await c.write('d/x.md', 'dx\n');
    await git(c, ['add', '-A']);
    await git(c, ['commit', '-qm', 'target']);
    const T = await git(c, ['rev-parse', 'HEAD']);
    await git(c, ['reset', '-q', '--hard', head]);
    await c.write('d', 'local file d\n');
    const m = saved(await saveLegacyRescue(ctx, 'rebase', [T], UNTRACKED));
    await git(c, ['reset', '-q', '--hard', T]);        // silently deletes the untracked file `d`
    expect(lstatSync(join(c.dir, 'd')).isDirectory()).toBe(true);
    expect(await rescueRestore(ctx, m)).toEqual({ restored: [], copies: [`d ${TAG}`], reDeleted: [], overridden: [] });
    expect(read(c, `d ${TAG}`)).toBe('local file d\n');
  });

  test('deleted: re-deleted when the base came back, kept (overridden) when it changed, nothing when still gone', async () => {
    const { c, ctx, logs } = await setup();
    await c.remove('a.md');
    await c.remove('b.md');
    await c.remove('README.md');
    const m = saved(await saveLegacyRescue(ctx, 'merge-abort', [], FULL));
    await git(c, ['checkout', '--', 'a.md', 'b.md']);
    await c.write('b.md', 'remote edit\n');
    const r = await rescueRestore(ctx, m);
    expect(r).toEqual({ restored: [], copies: [], reDeleted: ['a.md'], overridden: ['b.md'] });
    expect(exists(c, 'a.md')).toBe(false);
    expect(read(c, 'b.md')).toBe('remote edit\n');
    expect(logs.filter((l) => l.msg === 'delete overridden').map((l) => [l.path, l.deletedBy])).toEqual([['b.md', 'local']]);
  });

  test('shadowed: files under a folder that replaced a tracked file survive reset --hard (probe e11)', async () => {
    const { c, ctx } = await setup();
    await c.remove('projects');
    await c.write('projects/alpha.md', 'alpha\n');
    await c.write('projects/beta.md', 'beta\n');
    const m = saved(await saveLegacyRescue(ctx, 'rebase', [], UNTRACKED));
    expect(summary(m)).toEqual([
      ['projects', 'auto', 'deleted', 'sha'],
      ['projects/alpha.md', 'shadowed', 'file', 'none'],
      ['projects/beta.md', 'shadowed', 'file', 'none'],
    ]);
    expect(m.entries.filter((e) => e.restore === 'shadowed').every((e) => e.shadowRoot === 'projects')).toBe(true);
    await git(c, ['reset', '-q', '--hard']);
    expect(lstatSync(join(c.dir, 'projects')).isFile()).toBe(true);   // the notes are gone
    const r = await rescueRestore(ctx, m);
    expect(r).toEqual({ restored: ['projects/alpha.md', 'projects/beta.md'], copies: [], reDeleted: ['projects'], overridden: [] });
    expect(read(c, 'projects/alpha.md')).toBe('alpha\n');
    expect(read(c, 'projects/beta.md')).toBe('beta\n');
  });

  test('shadowed: when a changed file is back at the folder path, the notes go under one copy folder', async () => {
    const { c, ctx } = await setup();
    await c.remove('projects');
    await c.write('projects/alpha.md', 'alpha\n');
    await c.write('projects/sub/beta.md', 'beta\n');
    const m = saved(await saveLegacyRescue(ctx, 'rebase', [], UNTRACKED));
    await git(c, ['reset', '-q', '--hard']);
    await c.write('projects', 'remote changed projects\n');
    const r = await rescueRestore(ctx, m);
    expect(r).toEqual({ restored: [], copies: [`projects ${TAG}/alpha.md`, `projects ${TAG}/sub/beta.md`],
      reDeleted: [], overridden: ['projects'] });
    expect(read(c, 'projects')).toBe('remote changed projects\n');
    expect(read(c, `projects ${TAG}/sub/beta.md`)).toBe('beta\n');
  });

  test('symlinks are saved and restored as links', async () => {
    const { c, ctx } = await setup();
    const head = await git(c, ['rev-parse', 'HEAD']);
    await c.write('link', 'placeholder\n');
    await git(c, ['add', '-A']);
    await git(c, ['commit', '-qm', 'target']);
    const T = await git(c, ['rev-parse', 'HEAD']);
    await git(c, ['reset', '-q', '--hard', head]);
    symlinkSync('a.md', join(c.dir, 'link'));
    const m = saved(await saveLegacyRescue(ctx, 'checkout', [T], UNTRACKED));
    expect(m.entries[0]!.saved).toMatchObject({ kind: 'file', symlink: 'symlink' });
    await c.remove('link');
    expect((await rescueRestore(ctx, m)).restored).toEqual(['link']);
    expect(lstatSync(join(c.dir, 'link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(c.dir, 'link'))).toBe('a.md');
  });
});

describe('unmerged entries', () => {
  // note.md conflicts: local "L" vs incoming "R"; returns the clone mid-merge
  async function conflicted(): Promise<Setup> {
    const s = await setup();
    const { c } = s;
    await git(c, ['checkout', '-q', '-b', 'side']);
    await c.write('a.md', 'side a\n');
    await git(c, ['commit', '-qam', 'side']);
    await git(c, ['checkout', '-q', 'main']);
    await c.write('a.md', 'main a\n');
    await git(c, ['commit', '-qam', 'main']);
    expect((await c.git(['merge', 'side'])).code).not.toBe(0);
    expect(read(c, 'a.md')).toContain('<<<<<<< ');
    return s;
  }

  test("'skip' never saves git's own conflict output", async () => {
    const { ctx } = await conflicted();
    expect(await saveLegacyRescue(ctx, 'rebase-conflict', [], FULL)).toBe('nothing');
  });

  test("'edited-since': an edit after the reference mtime is saved and always restored as a copy", async () => {
    const { c, ctx } = await conflicted();
    const ref = statSync(join(c.dir, 'a.md')).mtimeMs;
    const opts: RescueOptions = { ...FULL, unmerged: { kind: 'edited-since', refMtimeMs: ref } };
    expect(await saveLegacyRescue(ctx, 'merge-abort', [], opts)).toBe('nothing');
    writeFileSync(join(c.dir, 'a.md'), `${read(c, 'a.md')}agent append\n`);
    utimesSync(join(c.dir, 'a.md'), new Date(), new Date(ref + 5_000));
    const m = saved(await saveLegacyRescue(ctx, 'merge-abort', [], opts));
    expect(summary(m)).toEqual([['a.md', 'copy-always', 'file', 'none']]);
    await git(c, ['merge', '--abort']);
    const r = await rescueRestore(ctx, m);
    expect(r.copies).toEqual([`a ${TAG}.md`]);
    expect(read(c, `a ${TAG}.md`)).toContain('agent append\n');
    expect(read(c, 'a.md')).toBe('main a\n');
  });

  test("'edited-since' without a reference: hand-resolved files are saved, marker files and stage copies are not", async () => {
    const { c, ctx } = await conflicted();
    const opts: RescueOptions = { ...FULL, unmerged: { kind: 'edited-since', refMtimeMs: 'none' } };
    expect(await saveLegacyRescue(ctx, 'merge-abort', [], opts)).toBe('nothing');            // markers still there
    await c.write('a.md', 'main a\n');                                                  // == stage 2 (ours)
    expect(await saveLegacyRescue(ctx, 'merge-abort', [], opts)).toBe('nothing');
    await c.write('a.md', 'resolved by hand\n');
    expect(summary(saved(await saveLegacyRescue(ctx, 'merge-abort', [], opts)))).toEqual([['a.md', 'copy-always', 'file', 'none']]);
  });
});

describe('pendingRescues', () => {
  test('complete manifests oldest first; an incomplete dir is ignored and deleted', async () => {
    const { c, ctx } = await setup();
    await c.write('a.md', 'first\n');
    now = FIXED + 2_000;
    const later = saved(await saveLegacyRescue(ctx, 'rebase', [], FULL));
    now = FIXED + 1_000;
    const earlier = saved(await saveLegacyRescue(ctx, 'checkout', [], { ...FULL, owner: 'journal' }));
    const partial = join(ctx.paths.rescue, `${FIXED}-${process.pid}-999`);
    mkdirSync(partial);
    writeFileSync(join(partial, '0.bin'), 'half-written');
    writeFileSync(join(ctx.paths.rescue, 'stray-file'), '');
    const got = pendingRescues(ctx.paths);
    expect(got.map((m) => [m.id, m.owner])).toEqual([[earlier.id, 'journal'], [later.id, 'standalone']]);
    expect(existsSync(partial)).toBe(false);
    expect(got[0]).toEqual(earlier);
  });

  test('a corrupt manifest counts as incomplete', async () => {
    const { ctx } = await setup();
    const dir = join(ctx.paths.rescue, `${FIXED}-1-1`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"id":');
    expect(pendingRescues(ctx.paths)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test('a planted manifest whose paths leave the folder is rejected, and nothing is written outside it', async () => {
    const { c, ctx } = await setup();
    for (const [i, entry] of [
      { path: '../../escaped.txt', base: 'none', restore: 'auto' },
      { path: '/tmp/abs.txt', base: 'none', restore: 'auto' },
      { path: '.git/hooks/post-checkout', base: 'none', restore: 'auto' },
      { path: 'ok.md', base: 'none', restore: 'shadowed', shadowRoot: '../x' },
    ].entries()) {
      const id = `${FIXED}-1-${i + 10}`;
      const dir = join(ctx.paths.rescue, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '0.bin'), 'PLANTED');
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, reason: 'rebase', owner: 'standalone',
        createdAt: new Date(FIXED).toISOString(), entries: [{ ...entry,
          saved: { kind: 'file', file: '0.bin', rawSha256: 'x', symlink: 'regular' } }] }));
    }
    expect(pendingRescues(ctx.paths)).toEqual([]);
    expect(readdirSync(ctx.paths.rescue)).toEqual([]);
    expect(existsSync(join(c.dir, '..', '..', 'escaped.txt'))).toBe(false);
  });

  test('a manifest saved for another repository (shared or reused state dir) is never restored here', async () => {
    const a = await setup();
    await a.c.write('a.md', 'from repo A\n');
    const m = saved(await saveLegacyRescue(a.ctx, 'rebase', [], FULL));
    expect(m.repo).not.toBe('unknown');

    const other = await createRemote(t, { files: { 'a.md': 'other repo\n' } });
    const b = await cloneRemote(t, other, `other-${++n}`);
    const logs: LogLine[] = [];
    const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => logs.push(JSON.parse(l) as LogLine) });
    const config: ReadyConfig = { ...a.ctx.config, dir: b.dir, remote: other.url };
    const ctxB = await createRunContext({ config, realDir: b.dir, paths: a.ctx.paths, log, clock });   // same state dir
    expect(await rescueRestore(ctxB, m)).toEqual({ restored: [], copies: [], reDeleted: [], overridden: [] });
    expect(read(b, 'a.md')).toBe('other repo\n');
    expect((await b.files()).filter((f) => f.includes('conflict'))).toEqual([]);
    expect(logs.find((l) => l.msg === 'rescue skipped')).toMatchObject({ id: m.id, reason: 'other-repo' });
    expect(pendingRescues(a.ctx.paths).map((x) => x.id)).toEqual([m.id]);   // kept for its own repo
    await rescueRestore(a.ctx, m);
    expect(read(a.c, 'a.md')).toBe('from repo A\n');
  });

  test('a missing rescue dir is empty', () => {
    expect(pendingRescues(statePathsFor(join(t.root, 'nowhere'), { ...t.env, XDG_STATE_HOME: join(t.root, 'no-state') }))).toEqual([]);
  });
});
