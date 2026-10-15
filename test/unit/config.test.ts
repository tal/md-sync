import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CONFIG_FLAGS, INSTANCE_ONLY_KEYS, InstanceSchema, REPO_CONFIG_PATH, RepoSchema, SHARED_KEYS, changedKeys, formatIssue,
  issuesFromZod, loadInstanceFile, parseRepoConfig, readRepoConfigBlob, readRepoConfigText, requireKeys, resolveConfig,
  validateCliLayer,
} from '../../src/config';
import type { ConfigLayers, InstanceInput, RepoInput, ResolvedConfig } from '../../src/config';
import type { GitClient } from '../../src/git';
import { createLogger } from '../../src/log';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-config-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let fileN = 0;
function writeConfig(content: unknown, dir = root): string {
  const p = join(dir, `config-${++fileN}.json`);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

function capture() {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(l) });
  return { log, events: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function layers(o: Partial<ConfigLayers> = {}): ConfigLayers {
  return { cli: {}, instance: {}, instancePath: 'none', repo: {}, ...o };
}

const sample = {
  branch: ['b-cli', 'b-inst', 'b-repo', undefined],   // no built-in branch
  ntfyUrl: ['https://cli.example/t', 'https://inst.example/t', 'https://repo.example/t', undefined],
  idleMs: [1_001, 1_002, 1_003, 300_000],
  fallbackMs: [2_001, 2_002, 2_003, 3_600_000],
  maxWaitMs: [3_001, 3_002, 3_003, 1_800_000],
  autoCommit: ['off', 'timers', 'off', 'timers'],   // two values: each layer still differs from the one below it
  ignore: [['cli/*'], ['inst/*'], ['repo/*'], []],
  remote: ['/r/cli.git', '/r/inst.git', undefined, undefined],
  dir: ['/d/cli', '/d/inst', undefined, undefined],
  authorName: ['n-cli', 'n-inst', undefined, 'mdsync@hosty'],
  sshKey: ['/key-cli', '/key-inst', undefined, undefined],
  authorEmail: ['e-cli', 'e-inst', undefined, 'mdsync@hosty.local'],
} as const;
type Key = keyof typeof sample;
const keys = Object.keys(sample) as Key[];

describe('key sets and schemas', () => {
  test('shared and instance-only keys partition the config keys', () => {
    expect([...SHARED_KEYS].sort()).toEqual(['autoCommit', 'branch', 'fallbackMs', 'idleMs', 'ignore', 'maxWaitMs', 'ntfyUrl']);
    expect([...INSTANCE_ONLY_KEYS].sort()).toEqual(['authorEmail', 'authorName', 'dir', 'remote', 'sshKey']);
    expect(Object.keys(CONFIG_FLAGS).sort()).toEqual([...SHARED_KEYS, ...INSTANCE_ONLY_KEYS].sort());
  });

  test('InstanceSchema is strict; RepoSchema strips unknown keys', () => {
    expect(InstanceSchema.safeParse({ bogus: 1 }).success).toBe(false);
    const r = RepoSchema.safeParse({ bogus: 1, dir: '/x', idleMs: 5_000 });
    expect(r.success && r.data).toEqual({ idleMs: 5_000 });
  });

  test('timer bounds: integers in [1000, 2^31-1]', () => {
    const ok = (v: unknown) => InstanceSchema.safeParse({ idleMs: v }).success;
    expect(ok(999)).toBe(false);
    expect(ok(1_000)).toBe(true);
    expect(ok(2 ** 31 - 1)).toBe(true);
    expect(ok(2 ** 31)).toBe(false);
    expect(ok(1_000.5)).toBe(false);
    expect(ok('5000')).toBe(false);
    for (const k of ['fallbackMs', 'maxWaitMs']) {
      expect(InstanceSchema.safeParse({ [k]: 999 }).success).toBe(false);
      expect(InstanceSchema.safeParse({ [k]: 2 ** 31 }).success).toBe(false);
    }
  });

  test("autoCommit is 'timers' or 'off', in the instance and the repo schema", () => {
    for (const v of ['timers', 'off']) {
      expect(InstanceSchema.safeParse({ autoCommit: v }).success).toBe(true);
      expect(RepoSchema.safeParse({ autoCommit: v }).success).toBe(true);
    }
    for (const v of ['on', 'OFF', '', false, true, 0, null]) {
      expect(InstanceSchema.safeParse({ autoCommit: v }).success).toBe(false);
      expect(RepoSchema.safeParse({ autoCommit: v }).success).toBe(false);
    }
  });

  test('ignore rejects negation and blanks; ntfyUrl must be http(s); branch must be a ref name', () => {
    expect(InstanceSchema.safeParse({ ignore: ['drafts/', '*.tmp'] }).success).toBe(true);
    expect(InstanceSchema.safeParse({ ignore: ['!keep.md'] }).success).toBe(false);
    expect(InstanceSchema.safeParse({ ignore: ['   '] }).success).toBe(false);
    expect(InstanceSchema.safeParse({ ntfyUrl: 'https://ntfy.sh/abc' }).success).toBe(true);
    expect(InstanceSchema.safeParse({ ntfyUrl: 'http://localhost:8080/abc' }).success).toBe(true);
    expect(InstanceSchema.safeParse({ ntfyUrl: 'ftp://ntfy.sh/abc' }).success).toBe(false);
    expect(InstanceSchema.safeParse({ ntfyUrl: 'ntfy.sh/abc' }).success).toBe(false);
    for (const b of ['main', 'feature/x', 'v1.2']) expect(InstanceSchema.safeParse({ branch: b }).success).toBe(true);
    for (const b of ['', '-x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b']) {
      expect(InstanceSchema.safeParse({ branch: b }).success).toBe(false);
    }
  });
});

describe('resolveConfig precedence', () => {
  const full = (i: 0 | 1 | 2): InstanceInput => {
    const o: Record<string, unknown> = {};
    for (const k of keys) if (sample[k][i] !== undefined) o[k] = sample[k][i];
    return o as InstanceInput;
  };

  test('cli > instance > repo > default, per key', () => {
    for (const k of keys) {
      const cli = full(0), instance = full(1), repo = full(2) as RepoInput;
      const expectAt = (l: ConfigLayers, layer: string, idx: 0 | 1 | 2 | 3) => {
        const { config, sources } = resolveConfig(l, 'hosty');
        expect(config[k]).toEqual(sample[k][idx] as never);
        expect(sources[k]).toBe(layer as never);
      };
      expectAt(layers({ cli, instance, repo }), 'cli', 0);
      delete cli[k];
      expectAt(layers({ cli, instance, repo }), 'instance', 1);
      delete instance[k];
      if (sample[k][2] !== undefined) {
        expectAt(layers({ cli, instance, repo }), 'repo', 2);
        delete (repo as Record<string, unknown>)[k];
      }
      expectAt(layers({ cli, instance, repo }), 'default', 3);
    }
  });

  test('the repo layer never supplies instance-only keys', () => {
    const repo = { remote: '/evil.git', dir: '/evil', authorName: 'x', authorEmail: 'y' } as unknown as RepoInput;
    const { config, sources } = resolveConfig(layers({ repo }), 'h');
    expect(config.remote).toBeUndefined();
    expect(config.dir).toBeUndefined();
    expect(config.authorName).toBe('mdsync@h');
    expect(config.authorEmail).toBe('mdsync@h.local');
    expect(sources.remote).toBe('default');
  });

  test('defaults', () => {
    const { config } = resolveConfig(layers(), 'box');
    expect(config).toEqual({
      idleMs: 300_000, fallbackMs: 3_600_000, maxWaitMs: 1_800_000, autoCommit: 'timers', ignore: [],
      authorName: 'mdsync@box', authorEmail: 'mdsync@box.local',
    });
    expect('ntfyUrl' in config).toBe(false);
    expect('remote' in config).toBe(false);
    expect('branch' in config).toBe(false);   // no built-in branch: a layer or the checkout names it
  });

  test('ignore replaces lower layers, never merges (an empty array replaces too)', () => {
    const repo: RepoInput = { ignore: ['r1', 'r2'] };
    expect(resolveConfig(layers({ cli: { ignore: ['c'] }, instance: { ignore: ['i'] }, repo }), 'h').config.ignore).toEqual(['c']);
    expect(resolveConfig(layers({ instance: { ignore: ['i'] }, repo }), 'h').config.ignore).toEqual(['i']);
    expect(resolveConfig(layers({ instance: { ignore: [] }, repo }), 'h').config.ignore).toEqual([]);
    expect(resolveConfig(layers({ repo }), 'h').config.ignore).toEqual(['r1', 'r2']);
  });

  test('values read from the checkout rank below the repo layer, above the defaults, with their own sources', () => {
    const detected = { dir: '/d/cwd', remote: '/r/origin.git', branch: 'checked-out' };
    const zero = resolveConfig(layers({ detected }), 'h');
    expect({ dir: zero.config.dir, remote: zero.config.remote, branch: zero.config.branch }).toEqual(detected);
    expect({ dir: zero.sources.dir, remote: zero.sources.remote, branch: zero.sources.branch })
      .toEqual({ dir: 'default', remote: 'origin', branch: 'checkout' });
    // a committed repo-file branch outranks the checkout; flags and the instance file outrank both
    const repo = resolveConfig(layers({ detected, repo: { branch: 'b-repo' } }), 'h');
    expect([repo.config.branch, repo.sources.branch]).toEqual(['b-repo', 'repo']);
    const given = resolveConfig(layers({ detected, cli: { dir: '/d/cli' }, instance: { remote: '/r/inst.git', branch: 'b-inst' } }), 'h');
    expect([given.config.dir, given.config.remote, given.config.branch]).toEqual(['/d/cli', '/r/inst.git', 'b-inst']);
    expect([given.sources.dir, given.sources.remote, given.sources.branch]).toEqual(['cli', 'instance', 'instance']);
    // nothing read (a fresh clone): no branch at all, never a built-in one
    const fresh = resolveConfig(layers({ detected: {} }), 'h');
    expect('branch' in fresh.config).toBe(false);
    expect(requireKeys(fresh.config, ['branch']).map((i) => formatIssue(i)))
      .toEqual(['missing required config key "branch" (pass --branch or set "branch" in the config file)']);
  });

  test('the resolved ignore array is a copy', () => {
    const instance: InstanceInput = { ignore: ['a'] };
    const { config } = resolveConfig(layers({ instance }), 'h');
    config.ignore.push('b');
    expect(instance.ignore).toEqual(['a']);
  });
});

describe('loadInstanceFile', () => {
  test('ok: values, relative dir against the file dir, ~ expanded', () => {
    const sub = join(root, 'cfgdir');
    mkdirSync(sub, { recursive: true });
    const p = writeConfig({ dir: 'notes', remote: 'git@h:x.git', idleMs: 120_000, ignore: [' drafts/ '] }, sub);
    const r = loadInstanceFile(p);
    expect(r).toEqual({ kind: 'ok', value: { dir: join(sub, 'notes'), remote: 'git@h:x.git', idleMs: 120_000, ignore: ['drafts/'] } });

    const home = loadInstanceFile(writeConfig({ dir: '~/agent-notes' }));
    expect(home.kind === 'ok' && home.value.dir).toBe(join(homedir(), 'agent-notes'));
    const abs = loadInstanceFile(writeConfig({ dir: '/abs/x/../y' }));
    expect(abs.kind === 'ok' && abs.value.dir).toBe('/abs/y');
  });

  test('missing file => missing', () => {
    expect(loadInstanceFile(join(root, 'nope.json'))).toEqual({ kind: 'missing' });
  });

  test('bad JSON, a non-object, or an unreadable path => (file) issue', () => {
    for (const content of ['{ not json', '[]', '"x"', 'null']) {
      const p = writeConfig(content);
      const r = loadInstanceFile(p);
      expect(r.kind).toBe('invalid');
      if (r.kind !== 'invalid') continue;
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ layer: 'instance', key: '(file)', file: p });
      expect(formatIssue(r.issues[0]!)).toStartWith(`invalid config file ${p}: `);
    }
    const dirPath = join(root, 'is-a-dir.json');
    mkdirSync(dirPath, { recursive: true });
    const r = loadInstanceFile(dirPath);
    expect(r.kind === 'invalid' && r.issues[0]?.key).toBe('(file)');
  });

  test('a UTF-8 BOM is tolerated', () => {
    const r = loadInstanceFile(writeConfig('﻿{"branch":"main"}'));
    expect(r).toEqual({ kind: 'ok', value: { branch: 'main' } });
  });

  test('strict unknown keys and invalid values: every bad key is named', () => {
    const p = writeConfig({ idelMs: 5, idleMs: '300000', ignore: ['ok', '!no'], remote: 'x' });
    const r = loadInstanceFile(p);
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    const byKey = Object.fromEntries(r.issues.map((i) => [i.key, i]));
    expect(Object.keys(byKey).sort()).toEqual(['idelMs', 'idleMs', 'ignore.1']);
    expect(formatIssue(byKey.idelMs!)).toBe(`invalid config key "idelMs" in ${p}: unknown key`);
    expect(formatIssue(byKey.idleMs!)).toBe(`invalid config key "idleMs" in ${p}: Invalid input: expected number, received string`);
    expect(byKey['ignore.1']!.message).toBe('negated patterns are not supported');
    for (const i of r.issues) expect(i).toMatchObject({ layer: 'instance', file: p });
  });

  test('an invalid autoCommit names the key (a start refuses)', () => {
    const p = writeConfig({ autoCommit: 'never' });
    const r = loadInstanceFile(p);
    expect(r.kind === 'invalid' && r.issues.map((i) => [i.key, i.layer, i.file])).toEqual([['autoCommit', 'instance', p]]);
    if (r.kind === 'invalid') expect(formatIssue(r.issues[0]!)).toStartWith(`invalid config key "autoCommit" in ${p}: `);
    expect(loadInstanceFile(writeConfig({ autoCommit: 'off' }))).toEqual({ kind: 'ok', value: { autoCommit: 'off' } });
  });

  test('timer bounds through the file', () => {
    const low = loadInstanceFile(writeConfig({ idleMs: 999 }));
    expect(low.kind === 'invalid' && low.issues.map((i) => i.key)).toEqual(['idleMs']);
    const high = loadInstanceFile(writeConfig({ maxWaitMs: 2 ** 31 }));
    expect(high.kind === 'invalid' && high.issues.map((i) => i.key)).toEqual(['maxWaitMs']);
  });
});

describe('validateCliLayer', () => {
  const cwd = '/work/here';

  test('parseArgs values (kebab-case) map to config keys; numeric flags are coerced; absent flags stay absent', () => {
    const r = validateCliLayer({
      'idle-ms': '120000', 'max-wait-ms': '1800000', 'ntfy-url': 'https://ntfy.sh/t', 'author-name': 'Tal',
      ignore: ['a/', '*.tmp'], branch: undefined, message: 'not a config key', wait: true, config: '/x.json',
    }, cwd);
    expect(r).toEqual({ kind: 'ok', value: {
      idleMs: 120_000, maxWaitMs: 1_800_000, ntfyUrl: 'https://ntfy.sh/t', authorName: 'Tal', ignore: ['a/', '*.tmp'],
    } });
  });

  test('camelCase input is accepted too, and a single --ignore string becomes an array', () => {
    expect(validateCliLayer({ fallbackMs: 60_000, ignore: 'x' }, cwd)).toEqual({ kind: 'ok', value: { fallbackMs: 60_000, ignore: ['x'] } });
  });

  test('relative --dir resolves against cwd; ~ expands', () => {
    expect(validateCliLayer({ dir: 'notes' }, cwd)).toEqual({ kind: 'ok', value: { dir: '/work/here/notes' } });
    expect(validateCliLayer({ dir: '../n' }, cwd)).toEqual({ kind: 'ok', value: { dir: '/work/n' } });
    expect(validateCliLayer({ dir: '~/n' }, cwd)).toEqual({ kind: 'ok', value: { dir: join(homedir(), 'n') } });
  });

  test('invalid values name the key and the flag', () => {
    const r = validateCliLayer({ 'idle-ms': '999', 'fallback-ms': 'soon', 'max-wait-ms': '', ignore: ['ok', '!x'] }, cwd);
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    const byKey = Object.fromEntries(r.issues.map((i) => [i.key, i]));
    expect(Object.keys(byKey).sort()).toEqual(['fallbackMs', 'idleMs', 'ignore.1', 'maxWaitMs']);
    expect(byKey.idleMs).toMatchObject({ layer: 'cli', flag: '--idle-ms' });
    expect(byKey['ignore.1']).toMatchObject({ layer: 'cli', flag: '--ignore' });
    expect(formatIssue(byKey.idleMs!)).toBe('invalid config key "idleMs" (--idle-ms): Too small: expected number to be >=1000');
    // not a number at all: said plainly (it used to be "expected number, received NaN")
    expect(formatIssue(byKey.fallbackMs!)).toBe('invalid config key "fallbackMs" (--fallback-ms): expected a whole number of milliseconds, got "soon"');
    expect(byKey.maxWaitMs!.message).toBe('expected a whole number of milliseconds, got ""');
    expect(byKey.fallbackMs!.file).toBeUndefined();
  });

  test('--auto-commit takes timers or off; anything else names the key and the flag', () => {
    expect(validateCliLayer({ 'auto-commit': 'off' }, cwd)).toEqual({ kind: 'ok', value: { autoCommit: 'off' } });
    expect(validateCliLayer({ 'auto-commit': 'timers' }, cwd)).toEqual({ kind: 'ok', value: { autoCommit: 'timers' } });
    const r = validateCliLayer({ 'auto-commit': 'no' }, cwd);
    expect(r.kind === 'invalid' && r.issues).toMatchObject([{ layer: 'cli', key: 'autoCommit', flag: '--auto-commit' }]);
    expect(CONFIG_FLAGS.autoCommit).toBe('--auto-commit');
  });

  test('2^31 is rejected from the CLI as well', () => {
    const r = validateCliLayer({ 'max-wait-ms': String(2 ** 31) }, cwd);
    expect(r.kind === 'invalid' && r.issues[0]?.key).toBe('maxWaitMs');
  });
});

describe('issuesFromZod key formatting', () => {
  test('nested path, array index and unrecognized_keys (top-level and nested)', () => {
    const schema = z.object({ a: z.object({ b: z.number(), c: z.object({}).strict() }), list: z.array(z.string()) }).strict();
    const r = schema.safeParse({ a: { b: 'x', c: { extra: 1 } }, list: ['ok', 3], top: true, top2: 1 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const issues = issuesFromZod(r.error, 'instance', { file: '/p/c.json' });
    const keysOut = issues.map((i) => i.key).sort();
    expect(keysOut).toEqual(['a.b', 'a.c.extra', 'list.1', 'top', 'top2']);
    expect(issues.find((i) => i.key === 'top')!.message).toBe('unknown key');
    expect(issues.find((i) => i.key === 'a.c.extra')!.message).toBe('unknown key');
    expect(formatIssue(issues.find((i) => i.key === 'top2')!)).toBe('invalid config key "top2" in /p/c.json: unknown key');
  });

  test('a root-level issue is keyed (file)', () => {
    const r = z.object({}).safeParse([]);
    expect(!r.success && issuesFromZod(r.error, 'repo')[0]?.key).toBe('(file)');
  });
});

describe('parseRepoConfig', () => {
  test('warns for instance-only and unknown keys, keeps the shared ones', () => {
    const { log, events } = capture();
    const r = parseRepoConfig(JSON.stringify({
      remote: 'x', dir: 'y', authorName: 'n', authorEmail: 'e', futureKey: 1, idleMs: 60_000, ignore: ['tmp/'],
    }), log);
    expect(r).toEqual({ kind: 'ok', value: { idleMs: 60_000, ignore: ['tmp/'] } });
    const warned = events().filter((e) => e.msg === 'repo config key ignored');
    expect(warned.map((e) => [e.key, e.reason, e.level])).toEqual([
      ['remote', 'instance-only', 'warn'], ['dir', 'instance-only', 'warn'], ['authorName', 'instance-only', 'warn'],
      ['authorEmail', 'instance-only', 'warn'], ['futureKey', 'unknown', 'warn'],
    ]);
  });

  test('an instance-only key with a bad value is still only a warning', () => {
    const { log } = capture();
    expect(parseRepoConfig('{"dir": 5}', log)).toEqual({ kind: 'ok', value: {} });
  });

  test('autoCommit is a shared key: kept from the repo file, an invalid value is invalid', () => {
    const { log, events } = capture();
    expect(parseRepoConfig('{"autoCommit": "off"}', log)).toEqual({ kind: 'ok', value: { autoCommit: 'off' } });
    expect(events().filter((e) => e.msg === 'repo config key ignored')).toEqual([]);
    const r = parseRepoConfig('{"autoCommit": "sometimes"}', log);
    expect(r.kind === 'invalid' && r.issues.map((i) => [i.key, i.layer])).toEqual([['autoCommit', 'repo']]);
  });

  test('invalid values and bad JSON are invalid, naming the key and the repo file', () => {
    const { log } = capture();
    const r = parseRepoConfig('{"idleMs": 10, "branch": "a..b"}', log);
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.issues.map((i) => i.key).sort()).toEqual(['branch', 'idleMs']);
    for (const i of r.issues) expect(i).toMatchObject({ layer: 'repo', file: REPO_CONFIG_PATH });
    expect(formatIssue(r.issues.find((i) => i.key === 'idleMs')!))
      .toBe(`invalid config key "idleMs" in ${REPO_CONFIG_PATH}: Too small: expected number to be >=1000`);

    const bad = parseRepoConfig('{"idleMs": ', log);
    expect(bad.kind === 'invalid' && bad.issues[0]).toMatchObject({ layer: 'repo', key: '(file)' });
    const arr = parseRepoConfig('[1]', log);
    expect(arr.kind === 'invalid' && arr.issues[0]?.key).toBe('(file)');
  });
});

describe('requireKeys / formatIssue / changedKeys', () => {
  const base = resolveConfig(layers(), 'h').config;

  test('requireKeys reports each missing key', () => {
    expect(requireKeys(base, ['dir', 'remote']).map((i) => i.key)).toEqual(['dir', 'remote']);
    expect(requireKeys({ ...base, dir: '/d' }, ['dir', 'remote']).map((i) => i.key)).toEqual(['remote']);
    expect(requireKeys({ ...base, dir: '/d', remote: 'r' }, ['dir', 'remote'])).toEqual([]);
    expect(requireKeys(base, [])).toEqual([]);
    const [issue] = requireKeys(base, ['remote']);
    expect(issue!.message).toBe('missing required config key');
    expect(formatIssue(issue!)).toBe('missing required config key "remote" (pass --remote or set "remote" in the config file)');
  });

  test('requireKeys: a dir from the current directory and a remote from origin satisfy it; no origin still fails', () => {
    const zero = resolveConfig(layers({ detected: { dir: '/d/cwd', remote: '/r/origin.git', branch: 'notes' } }), 'h').config;
    expect(requireKeys(zero, ['dir', 'remote'])).toEqual([]);
    const noOrigin = resolveConfig(layers({ detected: { dir: '/d/cwd', branch: 'notes' } }), 'h').config;
    expect(requireKeys(noOrigin, ['dir', 'remote']).map((i) => formatIssue(i)))
      .toEqual(['missing required config key "remote" (pass --remote or set "remote" in the config file)']);
  });

  test('formatIssue forms', () => {
    expect(formatIssue({ layer: 'instance', key: 'idleMs', file: '/p/config.json', message: 'Invalid input: expected number, received string' }))
      .toBe('invalid config key "idleMs" in /p/config.json: Invalid input: expected number, received string');
    expect(formatIssue({ layer: 'cli', key: 'idleMs', flag: '--idle-ms', message: 'boom' }))
      .toBe('invalid config key "idleMs" (--idle-ms): boom');
    expect(formatIssue({ layer: 'instance', key: 'idelMs', file: '/p', message: 'unknown key' }))
      .toBe('invalid config key "idelMs" in /p: unknown key');
    expect(formatIssue({ layer: 'repo', key: 'x', message: 'm' })).toBe('invalid config key "x": m');
  });

  test('changedKeys compares values (arrays by content) in canonical key order', () => {
    const a: ResolvedConfig = { ...base, ignore: ['x', 'y'] };
    expect(changedKeys(a, { ...a, ignore: ['x', 'y'] })).toEqual([]);
    expect(changedKeys(a, { ...a, ignore: ['y', 'x'] })).toEqual(['ignore']);
    expect(changedKeys(a, { ...a, ignore: ['x'] })).toEqual(['ignore']);
    expect(changedKeys(a, { ...a, ntfyUrl: 'https://n/t', idleMs: 5_000, dir: '/d' })).toEqual(['dir', 'ntfyUrl', 'idleMs']);
    expect(changedKeys({ ...a, remote: 'r' }, a)).toEqual(['remote']);
    expect(changedKeys(a, { ...a, authorEmail: 'z', branch: 'dev' })).toEqual(['branch', 'authorEmail']);
    expect(changedKeys(a, { ...a, autoCommit: 'off', ignore: [] })).toEqual(['autoCommit', 'ignore']);
  });
});

describe('repo config blob (real git)', () => {
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
  };
  const dec = new TextDecoder();

  // Minimal GitClient over Bun.spawn, so this test does not depend on git.ts.
  function client(cwd: string): GitClient {
    const run = async (args: string[], o?: { input?: Uint8Array | string }) => {
      const p = Bun.spawn(['git', ...args], { cwd, env, stdin: o?.input === undefined ? 'ignore' : new Blob([o.input]),
        stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout: new Uint8Array(stdout), stderr, timedOut: 'in-time' as const, durationMs: 0 };
    };
    return {
      cwd,
      run: async (args, o) => { const r = await run(args, o); return { ...r, stdout: dec.decode(r.stdout) }; },
      bytes: (args, o) => run(args, o),
      ok: async (args, o) => {
        const r = await run(args, o);
        if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
        return dec.decode(r.stdout).replace(/\n+$/, '');
      },
    };
  }

  async function sh(cwd: string, ...args: string[]): Promise<void> {
    const p = Bun.spawn(['git', ...args], { cwd, env, stdout: 'ignore', stderr: 'pipe' });
    if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(p.stderr).text()}`);
  }

  test('reads the committed HEAD blob, not the worktree; absent, unborn or a tree => none', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    await sh(repo, 'init', '-q', '-b', 'main');
    const g = client(repo);
    expect(await readRepoConfigBlob(g)).toBe('none');                       // unborn

    writeFileSync(join(repo, 'README.md'), '# x\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-qm', 'one');
    expect(await readRepoConfigBlob(g)).toBe('none');                       // absent

    mkdirSync(join(repo, '.config'), { recursive: true });
    const text = '{"idleMs": 60000}\n';
    writeFileSync(join(repo, REPO_CONFIG_PATH), text);
    expect(await readRepoConfigBlob(g)).toBe('none');                       // only in the worktree
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-qm', 'two');
    const blob = await readRepoConfigBlob(g);
    expect(blob).toMatch(/^[0-9a-f]{40}$/);
    expect(await readRepoConfigText(g, blob as string)).toBe(text.trimEnd());

    writeFileSync(join(repo, REPO_CONFIG_PATH), '{"idleMs": 1}\n');        // uncommitted edit is ignored
    expect(await readRepoConfigBlob(g)).toBe(blob);

    rmSync(join(repo, REPO_CONFIG_PATH));
    mkdirSync(join(repo, REPO_CONFIG_PATH), { recursive: true });
    writeFileSync(join(repo, REPO_CONFIG_PATH, 'inner'), 'x\n');
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-qm', 'three');
    expect(await readRepoConfigBlob(g)).toBe('none');                       // a tree at that path
  });

  test('readRepoConfigText rejects an unknown blob', async () => {
    const repo = join(root, 'repo2');
    mkdirSync(repo, { recursive: true });
    await sh(repo, 'init', '-q', '-b', 'main');
    await expect(readRepoConfigText(client(repo), '0'.repeat(40))).rejects.toThrow();
  });
});

 test('SSH keys resolve per instance and CLI, reject invalid paths, and stay out of shared config', () => {
  const file = writeConfig({ sshKey: "keys/notes' key" });
  const loaded = loadInstanceFile(file);
  expect(loaded).toEqual({ kind: 'ok', value: { sshKey: join(root, "keys/notes' key") } });
  expect(validateCliLayer({ 'ssh-key': '~/key' }, '/work')).toEqual({ kind: 'ok', value: { sshKey: join(homedir(), 'key') } });
  expect(validateCliLayer({ 'ssh-key': 'key' }, '/work')).toEqual({ kind: 'ok', value: { sshKey: '/work/key' } });
  for (const sshKey of ['', '  ', 'a\ncommand', 'a\0b']) expect(InstanceSchema.safeParse({ sshKey }).success).toBe(false);
  const { log, events } = capture();
  expect(parseRepoConfig('{"sshKey":"/other"}', log)).toEqual({ kind: 'ok', value: {} });
  expect(events().some(e => e.key === 'sshKey' && e.reason === 'instance-only')).toBe(true);
});
