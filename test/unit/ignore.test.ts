import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compileIgnore, compilePattern, MOVE_TEMP_EXCLUDE } from '../../src/ignore';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const PATHS = [
  'README.md', 'notes.txt', 'a.tmp', 'x/y/a.tmp', '.h.tmp', 'x.tmp/in.txt', 'a.tmpx',
  'drafts/a.md', 'x/drafts/a.md', 'drafts2/a.md', 'mydrafts/a.md', 'drafts.md',
  '.hidden.md', 'x/.y.md', '.dir/a.md', 'a/b/c.md', 'x/a/b/c.md',
];

// pattern -> the PATHS it must match (the probe tables, extended)
const TABLE: [string, string[]][] = [
  ['*.tmp', ['a.tmp', 'x/y/a.tmp', '.h.tmp', 'x.tmp/in.txt']],
  ['drafts', ['drafts/a.md', 'x/drafts/a.md']],
  ['drafts/', ['drafts/a.md', 'x/drafts/a.md']],
  ['/drafts', ['drafts/a.md']],
  ['./drafts/**', ['drafts/a.md']],
  ['**/*.md', ['README.md', 'drafts/a.md', 'x/drafts/a.md', 'drafts2/a.md', 'mydrafts/a.md', 'drafts.md', '.hidden.md',
    'x/.y.md', '.dir/a.md', 'a/b/c.md', 'x/a/b/c.md']],
  ['a/b', ['a/b/c.md']],
  ['.dir', ['.dir/a.md']],
];

describe('compilePattern', () => {
  test('each pattern compiles to <base> and <base>/**', () => {
    expect(compilePattern('*.tmp')).toEqual(['**/*.tmp', '**/*.tmp/**']);
    expect(compilePattern('drafts')).toEqual(['**/drafts', '**/drafts/**']);
    expect(compilePattern('drafts/')).toEqual(['**/drafts', '**/drafts/**']);
    expect(compilePattern('/drafts')).toEqual(['drafts', 'drafts/**']);
    expect(compilePattern('./drafts/**')).toEqual(['drafts/**', 'drafts/**/**']);
    expect(compilePattern('**/*.md')).toEqual(['**/*.md', '**/*.md/**']);
    expect(compilePattern('a/b')).toEqual(['a/b', 'a/b/**']);
    expect(compilePattern('  notes/tmp/  ')).toEqual(['notes/tmp', 'notes/tmp/**']);
  });
});

describe('compileIgnore matching (Bun.Glob)', () => {
  for (const [pat, expected] of TABLE) {
    test(`${JSON.stringify(pat)}`, () => {
      const m = compileIgnore([pat]);
      expect(PATHS.filter((p) => m.matches(p))).toEqual(expected);
    });
  }

  test('a matched directory itself also matches (watcher addDir events)', () => {
    const m = compileIgnore(['drafts']);
    expect(m.matches('drafts')).toBe(true);
    expect(m.matches('x/drafts')).toBe(true);
    expect(compileIgnore(['/drafts']).matches('x/drafts')).toBe(false);
  });

  test('matching is case-sensitive', () => {
    expect(compileIgnore(['drafts']).matches('Drafts/A.md')).toBe(false);
    expect(compileIgnore(['*.TMP']).matches('a.tmp')).toBe(false);
  });

  test('several patterns: any match wins; empty list matches nothing', () => {
    const m = compileIgnore(['*.tmp', '/drafts']);
    expect(m.matches('x/y/a.tmp')).toBe(true);
    expect(m.matches('drafts/a.md')).toBe(true);
    expect(m.matches('x/drafts/a.md')).toBe(false);
    expect(compileIgnore([]).matches('anything.md')).toBe(false);
  });

  test('exposes patterns, globs and pathspec excludes', () => {
    const m = compileIgnore(['*.tmp', '/drafts']);
    expect(m.patterns).toEqual(['*.tmp', '/drafts']);
    expect(m.globs).toEqual(['**/*.tmp', '**/*.tmp/**', 'drafts', 'drafts/**']);
    expect(m.pathspecExcludes).toEqual([
      ':(exclude,glob)**/*.tmp', ':(exclude,glob)**/*.tmp/**', ':(exclude,glob)drafts', ':(exclude,glob)drafts/**',
      MOVE_TEMP_EXCLUDE,
    ]);
    // the worktree move's temp folders are never staged or pending, also with an empty `ignore` list
    expect(compileIgnore([]).pathspecExcludes).toEqual([MOVE_TEMP_EXCLUDE]);
  });

  test('patterns that normalize to nothing are skipped (git would reject "/**")', () => {
    const m = compileIgnore(['/', '//', '*.tmp']);
    expect(m.patterns).toEqual(['/', '//', '*.tmp']);
    expect(m.globs).toEqual(['**/*.tmp', '**/*.tmp/**']);
    expect(m.matches('README.md')).toBe(false);
  });
});

describe('git pathspec excludes agree with Bun.Glob (real temp repo)', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-ignore-')));
  roots.push(repo);
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };
  const git = (args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'core.quotePath=false', ...args], { cwd: repo, env: gitEnv });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    return r.stdout.toString();
  };
  git(['init', '-q', '-b', 'main']);
  for (const p of PATHS) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), `${p}\n`);
  }
  const untracked = (excludes: readonly string[]) =>
    git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--', '.', ...excludes])
      .split('\0').filter((l) => l !== '').map((l) => l.slice(3)).sort();

  test('baseline: every file is untracked', () => {
    expect(untracked([])).toEqual([...PATHS].sort());
  });

  for (const [pat] of TABLE) {
    test(`${JSON.stringify(pat)}: git excludes exactly what matches() ignores`, () => {
      const m = compileIgnore([pat]);
      expect(untracked(m.pathspecExcludes)).toEqual(PATHS.filter((p) => !m.matches(p)).sort());
    });
  }

  test('combined patterns', () => {
    const m = compileIgnore(['*.tmp', '/drafts', '.dir']);
    expect(untracked(m.pathspecExcludes)).toEqual(PATHS.filter((p) => !m.matches(p)).sort());
  });
});
