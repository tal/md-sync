// Golden fixtures: config files as real users write them, each with the outcome mdsync gives it
// (test/fixtures/config/README.md). MDSYNC_TEST_UPDATE_FIXTURES=1 rewrites every expected.json from current behavior.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatIssue, type Loaded, loadInstanceFile, parseRepoConfig } from '../../src/config';
import { isRecord } from '../../src/fsutil';
import { createLogger } from '../../src/log';

type Group = 'instance' | 'repo';
type Mode = 'compare' | 'update';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'config');
const GROUPS: readonly Group[] = ['instance', 'repo'];
const INPUT: Record<Group, string> = { instance: 'config.json', repo: 'mdsync.json' };
const KINDS: Record<Group, readonly string[]> = { instance: ['ok', 'invalid', 'missing'], repo: ['ok', 'invalid'] };
const MODE: Mode = process.env.MDSYNC_TEST_UPDATE_FIXTURES === '1' ? 'update' : 'compare';
const CASE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function cases(group: Group): string[] {
  return readdirSync(join(FIXTURES, group), { withFileTypes: true }).filter((e) => e.isDirectory())
    .map((e) => e.name).sort();
}

function outcome<T>(r: Loaded<T>): Record<string, unknown> {
  switch (r.kind) {
    case 'ok': return { kind: 'ok', value: r.value };
    case 'missing': return { kind: 'missing' };
    case 'invalid': return { kind: 'invalid', errors: r.issues.map(formatIssue) };
  }
}

function run(group: Group, dir: string): Record<string, unknown> {
  const input = join(dir, INPUT[group]);
  if (group === 'instance') return outcome(loadInstanceFile(input));
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(l) });
  // keep a BOM, so parseRepoConfig's own handling is what gets pinned (git's TextDecoder would drop it first)
  const r = parseRepoConfig(new TextDecoder('utf-8', { ignoreBOM: true }).decode(readFileSync(input)), log);
  const warnings = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.msg === 'repo config key ignored').map((e) => ({ key: e.key, reason: e.reason }));
  return { ...outcome(r), warnings };
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

// `$CASE` and `$HOME` stand for the case folder's realpath and the home dir; `$$` is a literal `$`.
function fromPlaceholders(v: unknown, dir: string): unknown {
  const sub: Record<string, string> = { $: '$', CASE: dir, HOME: homedir() };
  return mapStrings(v, (s) => s.replace(/\$(\$|CASE|HOME)/g, (_, name: string) => sub[name]!));
}

function toPlaceholders(v: unknown, dir: string): unknown {
  const home = homedir();
  return mapStrings(v, (s) => {
    const escaped = s.replace(/\$(?=\$|CASE|HOME)/g, '$$$$').replaceAll(dir, '$CASE');
    return home === '/' ? escaped : escaped.replaceAll(home, '$HOME');
  });
}

// Throws a message naming the case for any folder that is not a well-formed fixture.
function readExpected(group: Group, name: string, dir: string): Record<string, unknown> {
  const where = `${group}/${name}`;
  if (!CASE_NAME.test(name)) throw new Error(`${where}: case names are lowercase-kebab-case`);
  const extra = readdirSync(dir).filter((f) => f !== 'expected.json' && f !== INPUT[group]);
  if (extra.length > 0) throw new Error(`${where}: unexpected files ${extra.join(', ')} (inputs are named ${INPUT[group]})`);
  if (group === 'repo' && !existsSync(join(dir, INPUT.repo))) throw new Error(`${where}: no ${INPUT.repo}`);
  if (!existsSync(join(dir, 'expected.json'))) throw new Error(`${where}: no expected.json`);
  const e: unknown = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  if (!isRecord(e)) throw new Error(`${where}: expected.json is not an object`);
  if (typeof e.note !== 'string' || e.note.trim() === '') throw new Error(`${where}: expected.json needs a "note"`);
  if (e.gap !== undefined && (typeof e.gap !== 'string' || e.gap.trim() === '')) {
    throw new Error(`${where}: "gap" must be a non-empty string`);
  }
  if (MODE === 'update') return e;
  if (typeof e.kind !== 'string' || !KINDS[group].includes(e.kind)) {
    throw new Error(`${where}: "kind" must be one of ${KINDS[group].join(', ')}, got ${JSON.stringify(e.kind)}`);
  }
  const allowed = ['note', 'gap', 'kind', ...(e.kind === 'ok' ? ['value'] : e.kind === 'invalid' ? ['errors'] : []),
    ...(group === 'repo' ? ['warnings'] : [])];
  const unknown = Object.keys(e).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new Error(`${where}: unexpected keys ${unknown.join(', ')} for kind "${e.kind}"`);
  if (e.kind === 'ok' && !isRecord(e.value)) throw new Error(`${where}: kind "ok" needs a "value" object`);
  if (e.kind === 'invalid' && !(Array.isArray(e.errors) && e.errors.every((x) => typeof x === 'string'))) {
    throw new Error(`${where}: kind "invalid" needs an "errors" array of strings`);
  }
  if (group === 'repo' && !Array.isArray(e.warnings)) throw new Error(`${where}: repo cases need a "warnings" array`);
  return e;
}

test('fixture folders: only README.md, instance/ and repo/, each with cases', () => {
  expect(readdirSync(FIXTURES).sort()).toEqual(['README.md', 'instance', 'repo']);
  for (const group of GROUPS) expect(cases(group).length).toBeGreaterThan(0);
});

for (const group of GROUPS) {
  describe(group, () => {
    for (const name of cases(group)) {
      test(`${group}/${name}`, () => {
        const dir = realpathSync(join(FIXTURES, group, name));
        const expected = readExpected(group, name, dir);
        const actual = run(group, dir);
        const { note, gap } = expected;
        if (MODE === 'update') {
          const out = { note, ...(gap !== undefined ? { gap } : {}), ...(toPlaceholders(actual, dir) as object) };
          writeFileSync(join(dir, 'expected.json'), `${JSON.stringify(out, null, 2)}\n`);
          return;
        }
        const { note: _note, gap: _gap, ...want } = expected;
        expect(actual).toEqual(fromPlaceholders(want, dir) as Record<string, unknown>);
      });
    }
  });
}
