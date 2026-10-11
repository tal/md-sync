import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../../src/context';
import { GitNotFoundError, createGitClient } from '../../src/git';
import { createLogger } from '../../src/log';
import { mergeFile, mergeRepoConfig } from '../../src/merge-file';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-merge-file-')));
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'PATH'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const enc = new TextEncoder();
const dec = new TextDecoder();
let n = 0;

beforeAll(() => {
  // a user-level conflictStyle must not leak in: GLOBAL_ARGS pins merge.conflictStyle=merge
  writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n[merge]\n\tconflictStyle = zdiff3\n');
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

function makeCtx(): { ctx: RunContext; tmp: string } {
  const dir = join(root, `repo-${++n}`);
  mkdirSync(dir);
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: dir, env: process.env }).exitCode).toBe(0);
  const tmp = join(root, `state-${n}`, 'abc.tmp');
  const git = createGitClient({ cwd: dir, identity: { name: 't', email: 't@test.invalid' },
    log: createLogger({ level: 'error', sink: 'stdout', write: () => {} }) });
  // mergeFile only reads ctx.git and ctx.paths.tmp
  const ctx = { realDir: dir, git, paths: { tmp } } as unknown as RunContext;
  return { ctx, tmp };
}

const lines = (...ls: string[]) => enc.encode(ls.map((l) => l + '\n').join(''));
const BASE = lines('1', '2', '3', '4', '5');

describe('mergeFile', () => {
  test('non-overlapping edits merge cleanly, and the temp dir is removed', async () => {
    const { ctx, tmp } = makeCtx();
    const r = await mergeFile(ctx, lines('L1', '2', '3', '4', '5'), BASE, lines('1', '2', '3', '4', 'R5'));
    expect(r.kind).toBe('clean');
    if (r.kind === 'clean') expect(dec.decode(r.content)).toBe('L1\n2\n3\n4\nR5\n');
    expect(existsSync(tmp)).toBe(true);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('edits separated by one unchanged line merge cleanly', async () => {
    const { ctx } = makeCtx();
    const r = await mergeFile(ctx, lines('1', 'L2', '3', '4', '5'), BASE, lines('1', '2', '3', 'R4', '5'));
    expect(r.kind).toBe('clean');
    if (r.kind === 'clean') expect(dec.decode(r.content)).toBe('1\nL2\n3\nR4\n5\n');
  });

  test('one overlapping edit is one conflict', async () => {
    const { ctx, tmp } = makeCtx();
    const r = await mergeFile(ctx, lines('1', '2', 'L3', '4', '5'), BASE, lines('1', '2', 'R3', '4', '5'));
    expect(r).toEqual({ kind: 'conflict', count: 1 });
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('edits on adjacent lines conflict', async () => {
    const { ctx } = makeCtx();
    const r = await mergeFile(ctx, lines('1', 'L2', '3', '4', '5'), BASE, lines('1', '2', 'R3', '4', '5'));
    expect(r).toEqual({ kind: 'conflict', count: 1 });
  });

  test('several separate conflicts are counted', async () => {
    const { ctx } = makeCtx();
    const base = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i');
    const r = await mergeFile(ctx, lines('A1', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I1'), base,
      lines('A2', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I2'));
    expect(r).toEqual({ kind: 'conflict', count: 2 });
  });

  test('add/add with an empty base', async () => {
    const { ctx } = makeCtx();
    expect(await mergeFile(ctx, lines('same'), new Uint8Array(0), lines('same'))).toEqual({ kind: 'clean', content: lines('same') });
    expect((await mergeFile(ctx, lines('mine'), new Uint8Array(0), lines('theirs'))).kind).toBe('conflict');
  });

  test('a NUL byte in any input is binary, without running git', async () => {
    const { ctx, tmp } = makeCtx();
    const bin = new Uint8Array([0x61, 0x00, 0x62]);
    expect(await mergeFile(ctx, bin, BASE, BASE)).toEqual({ kind: 'binary' });
    expect(await mergeFile(ctx, BASE, bin, BASE)).toEqual({ kind: 'binary' });
    expect(await mergeFile(ctx, BASE, BASE, bin)).toEqual({ kind: 'binary' });
    expect(existsSync(tmp)).toBe(false);   // never got as far as the temp dir
  });

  test('CRLF content is preserved byte for byte', async () => {
    const { ctx } = makeCtx();
    const crlf = (...ls: string[]) => enc.encode(ls.map((l) => l + '\r\n').join(''));
    const r = await mergeFile(ctx, crlf('L1', '2', '3', '4', '5'), crlf('1', '2', '3', '4', '5'), crlf('1', '2', '3', '4', 'R5'));
    expect(r.kind).toBe('clean');
    if (r.kind === 'clean') expect([...r.content]).toEqual([...crlf('L1', '2', '3', '4', 'R5')]);
  });

  test('non-UTF-8 bytes and a missing final newline survive a clean merge', async () => {
    const { ctx } = makeCtx();
    const base = new Uint8Array([0x61, 0x0a, 0x62, 0x0a, 0x63, 0x0a, 0x64]);
    const local = new Uint8Array([0xff, 0x0a, 0x62, 0x0a, 0x63, 0x0a, 0x64]);
    const remote = new Uint8Array([0x61, 0x0a, 0x62, 0x0a, 0x63, 0x0a, 0xfe]);
    const r = await mergeFile(ctx, local, base, remote);
    expect(r.kind).toBe('clean');
    if (r.kind === 'clean') expect([...r.content]).toEqual([0xff, 0x0a, 0x62, 0x0a, 0x63, 0x0a, 0xfe]);
  });

  test('conflict markers use the plain merge style with local/base/remote labels', async () => {
    // mergeFile itself reports only the count; this checks the argv/labels through the same client
    const { ctx } = makeCtx();
    const dir = join(root, `labels-${n}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'l'), '1\nL\n3\n');
    writeFileSync(join(dir, 'b'), '1\n2\n3\n');
    writeFileSync(join(dir, 'r'), '1\nR\n3\n');
    const out = await ctx.git.run(['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'remote',
      join(dir, 'l'), join(dir, 'b'), join(dir, 'r')]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe('1\n<<<<<<< local\nL\n=======\nR\n>>>>>>> remote\n3\n');
  });

  test('a temp dir that cannot be created is an error result', async () => {
    const { ctx } = makeCtx();
    const locked = join(root, `ro-${n}`);
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const bad = { ...ctx, paths: { tmp: join(locked, 'x.tmp') } } as unknown as RunContext;
      const r = await mergeFile(bad, lines('a'), lines('b'), lines('c'));
      expect(r.kind).toBe('error');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test('leftover merge-<n> dirs from an earlier process are skipped, not reused', async () => {
    const { ctx, tmp } = makeCtx();
    mkdirSync(tmp, { recursive: true });
    for (let i = 1; i <= 200; i++) mkdirSync(join(tmp, `merge-${i}`));
    const r = await mergeFile(ctx, lines('L1', '2', '3', '4', '5'), BASE, lines('1', '2', '3', '4', 'R5'));
    expect(r.kind).toBe('clean');
    expect(readdirSync(tmp).length).toBe(200);
  });

  test('a missing git binary propagates GitNotFoundError', async () => {
    const { ctx } = makeCtx();
    process.env.PATH = join(root, 'no-bin');
    try {
      await expect(mergeFile(ctx, lines('a'), lines('b'), lines('c'))).rejects.toBeInstanceOf(GitNotFoundError);
    } finally {
      process.env.PATH = savedEnv.get('PATH');
    }
  });
});

describe('merging the files that decide what gets staged', () => {
  test("'union' keeps both sides' lines where they conflict (.gitignore, .gitattributes)", async () => {
    const { ctx } = makeCtx();
    const r = await mergeFile(ctx, lines('*.tmp', 'secret.md'), lines('*.tmp'), lines('*.tmp', 'drafts/'), 'union');
    expect(r.kind).toBe('clean');
    if (r.kind === 'clean') expect(dec.decode(r.content).split('\n').filter((l) => l !== '').sort()).toEqual(['*.tmp', 'drafts/', 'secret.md']);
    expect((await mergeFile(ctx, lines('*.tmp', 'secret.md'), lines('*.tmp'), lines('*.tmp', 'drafts/'))).kind).toBe('conflict');
  });

  test('mergeRepoConfig: `ignore` unioned, one-sided key changes kept, a key both changed takes the remote value', () => {
    const j = (v: unknown) => enc.encode(JSON.stringify(v));
    const out = mergeRepoConfig(j({ ignore: ['a', 'l'], idleMs: 1, fallbackMs: 7 }), j({ ignore: ['a'], idleMs: 1, fallbackMs: 5 }),
      j({ ignore: ['a', 'r'], idleMs: 2, fallbackMs: 6 }));
    expect(out).not.toBe('unmergeable');
    if (out !== 'unmergeable') expect(JSON.parse(dec.decode(out))).toEqual({ ignore: ['a', 'r', 'l'], idleMs: 2, fallbackMs: 6 });
    // an add/add (no base) and a key only local added
    const add = mergeRepoConfig(j({ ignore: ['private/**'], maxWaitMs: 9 }), new Uint8Array(), j({ ignore: ['drafts/**'] }));
    if (add !== 'unmergeable') expect(JSON.parse(dec.decode(add))).toEqual({ ignore: ['drafts/**', 'private/**'], maxWaitMs: 9 });
    expect(mergeRepoConfig(enc.encode('{"ignore": [}'), j({}), j({}))).toBe('unmergeable');
    expect(mergeRepoConfig(j([1]), j({}), j({}))).toBe('unmergeable');
  });
});
