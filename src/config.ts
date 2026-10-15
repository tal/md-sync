// Config schemas, layer loading and validation, precedence and diffing.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { errCode, isRecord } from './fsutil';
import type { GitClient } from './git';
import { errorText, type Logger } from './log';
import { resolveDirInput } from './paths';
import { MAX_TIMER_MS } from './types';

export const SHARED_KEYS = ['branch', 'ntfyUrl', 'idleMs', 'fallbackMs', 'ignore', 'maxWaitMs', 'autoCommit'] as const;
// 'timers': local changes arm the idleMs / maxWaitMs backup commits (and a stop commits what is pending). 'off': only
// `flush` and `sync-once` commit; pulls still run and carry uncommitted edits through.
export const AUTO_COMMIT_MODES = ['timers', 'off'] as const;
export type AutoCommit = (typeof AUTO_COMMIT_MODES)[number];
export const INSTANCE_ONLY_KEYS = ['remote', 'dir', 'authorName', 'authorEmail', 'sshKey'] as const;

const ms = z.number().int().min(1_000).max(MAX_TIMER_MS);   // larger values would fire after 1 ms in Bun (verified)
const glob = z.string().trim().min(1).refine((s) => !s.startsWith('!'), 'negated patterns are not supported');
const branchName = z.string().min(1).regex(/^(?!-)(?!.*\.\.)[^\s~^:?*\[\\]+$/, 'not a valid git branch name');
const SharedShape = {
  branch: branchName,
  ntfyUrl: z.url({ protocol: /^https?$/ }),
  idleMs: ms, fallbackMs: ms, maxWaitMs: ms,
  ignore: z.array(glob),
  autoCommit: z.enum(AUTO_COMMIT_MODES),
};
const InstanceOnlyShape = {
  sshKey: z.string().trim().min(1).regex(/^[^\0\r\n]+$/, 'not a valid private-key path'),
  remote: z.string().min(1), dir: z.string().min(1), authorName: z.string().min(1), authorEmail: z.string().min(1),
};
export const InstanceSchema = z.object({ ...SharedShape, ...InstanceOnlyShape }).partial().strict();
export const RepoSchema = z.object(SharedShape).partial();             // non-strict: strips unknown keys

export type InstanceInput = Partial<{ remote: string; dir: string; branch: string; ntfyUrl: string; idleMs: number;
  fallbackMs: number; ignore: string[]; authorName: string; authorEmail: string; sshKey: string; maxWaitMs: number;
  autoCommit: AutoCommit }>;
export type RepoInput = Partial<Pick<Required<InstanceInput>, 'branch' | 'ntfyUrl' | 'idleMs' | 'fallbackMs' | 'ignore' | 'maxWaitMs'
  | 'autoCommit'>>;
// Zero-config defaults read from the synced folder's own checkout when no flag or file sets them (src/repo-defaults.ts):
// `dir` is the current directory, `remote` its `origin` URL, `branch` the branch checked out there. Read once at
// startup, so they rank below the repo layer and above the built-in defaults (which have no `branch`).
export type DetectedInput = { dir?: string; remote?: string; branch?: string };
// 'origin' and 'checkout': `remote` and `branch` read from the checkout. A `dir` taken from the current directory
// reports 'default', like every built-in default. `branch` has no built-in default: it is never 'default'.
export type ConfigLayerName = 'cli' | 'instance' | 'repo' | 'origin' | 'checkout' | 'default';
export type ConfigIssue = { layer: 'cli' | 'instance' | 'repo'; key: string; message: string; flag?: string; file?: string };
export type ConfigLayers = { cli: InstanceInput; instance: InstanceInput; instancePath: string | 'none'; repo: RepoInput;
  detected?: DetectedInput };
// Every layer but the committed repo file, which is read only once the clone exists.
export type DirectLayers = Omit<ConfigLayers, 'repo'>;
export type ResolvedConfig = {
  remote?: string; dir?: string;                    // absolute, ~-expanded (not realpath'd)
  branch?: string;                                  // no default: a layer or the checkout names it, or nothing starts
  ntfyUrl?: string; idleMs: number; fallbackMs: number; maxWaitMs: number; autoCommit: AutoCommit;
  ignore: string[]; authorName: string; authorEmail: string; sshKey?: string;
};
export type ReadyConfig = ResolvedConfig & { dir: string; branch: string };
export type Loaded<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'invalid'; issues: ConfigIssue[] };

type ConfigKey = keyof ResolvedConfig;
type SharedKey = (typeof SHARED_KEYS)[number];

// Canonical key order: changedKeys() and resolveConfig() report keys in this order.
const CONFIG_KEYS = ['remote', 'dir', 'branch', 'ntfyUrl', 'idleMs', 'fallbackMs', 'maxWaitMs', 'autoCommit', 'ignore',
  'authorName', 'authorEmail', 'sshKey'] as const satisfies readonly ConfigKey[];

// The CLI flag for each config key. Also what install-service re-emits for CLI overrides.
export const CONFIG_FLAGS: Readonly<Record<ConfigKey, string>> = {
  remote: '--remote', dir: '--dir', branch: '--branch', ntfyUrl: '--ntfy-url',
  idleMs: '--idle-ms', fallbackMs: '--fallback-ms', maxWaitMs: '--max-wait-ms', autoCommit: '--auto-commit', ignore: '--ignore',
  authorName: '--author-name', authorEmail: '--author-email', sshKey: '--ssh-key',
};

export const REPO_CONFIG_PATH = '.config/mdsync.json';
const FILE_KEY = '(file)';
const MISSING_MESSAGE = 'missing required config key';
const NUMERIC_KEYS: ReadonlySet<ConfigKey> = new Set(['idleMs', 'fallbackMs', 'maxWaitMs']);

function isSharedKey(k: string): k is SharedKey {
  return (SHARED_KEYS as readonly string[]).includes(k);
}

const DETECTED_SOURCE: Readonly<Record<keyof DetectedInput, ConfigLayerName>> = { dir: 'default', remote: 'origin', branch: 'checkout' };

function isDetectedKey(k: string): k is keyof DetectedInput {
  return k in DETECTED_SOURCE;
}

export function isValidBranchName(s: string): boolean {
  return branchName.safeParse(s).success;
}

// zod output keeps keys whose value is undefined; layers must not contain them (an absent key never shadows).
function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

function parseJson(text: string): { kind: 'ok'; value: unknown } | { kind: 'invalid'; message: string } {
  try {
    return { kind: 'ok', value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (e) {
    return { kind: 'invalid', message: `invalid JSON: ${errorText(e)}` };
  }
}

// One ConfigIssue per zod issue; `unrecognized_keys` becomes one issue per key.
export function issuesFromZod(error: z.ZodError, layer: ConfigIssue['layer'],
  where: { file?: string; flagFor?: (key: string) => string | undefined } = {}): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  const push = (path: readonly PropertyKey[], message: string): void => {
    const key = path.length === 0 ? FILE_KEY : path.map(String).join('.');
    const issue: ConfigIssue = { layer, key, message };
    const flag = path.length > 0 ? where.flagFor?.(String(path[0])) : undefined;
    if (flag !== undefined) issue.flag = flag;
    if (where.file !== undefined) issue.file = where.file;
    out.push(issue);
  };
  for (const iss of error.issues) {
    if (iss.code === 'unrecognized_keys') {
      for (const k of iss.keys) push([...iss.path, k], 'unknown key');
    } else {
      push(iss.path, iss.message);
    }
  }
  return out;
}

export function loadInstanceFile(path: string): Loaded<InstanceInput> {
  const file = resolve(path);
  const fileIssue = (message: string): Loaded<InstanceInput> =>
    ({ kind: 'invalid', issues: [{ layer: 'instance', key: FILE_KEY, message, file }] });
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return fileIssue(errorText(e));
  }
  const json = parseJson(text);
  if (json.kind === 'invalid') return fileIssue(json.message);
  const r = InstanceSchema.safeParse(json.value);
  if (!r.success) return { kind: 'invalid', issues: issuesFromZod(r.error, 'instance', { file }) };
  const value: InstanceInput = compact(r.data);
  if (value.dir !== undefined) value.dir = resolveDirInput(value.dir, dirname(file));
  if (value.sshKey !== undefined) value.sshKey = resolveDirInput(value.sshKey, dirname(file));
  return { kind: 'ok', value };
}

// `raw` is parseArgs' `values` (kebab-case flag names) or an already-camelCased record; other keys are ignored.
// Absent (undefined) flags are skipped so they never shadow lower layers.
export function validateCliLayer(raw: Record<string, unknown>, cwd: string): Loaded<InstanceInput> {
  const picked: Record<string, unknown> = {};
  const notNumbers: ConfigIssue[] = [];
  for (const key of CONFIG_KEYS) {
    let v = raw[key] ?? raw[CONFIG_FLAGS[key].slice(2)];
    if (v === undefined) continue;
    if (NUMERIC_KEYS.has(key) && typeof v === 'string') {
      // `--idle-ms 5m` used to be reported as "expected number, received NaN"
      if (!/^\s*\d+\s*$/.test(v)) {
        notNumbers.push({ layer: 'cli', key, flag: CONFIG_FLAGS[key], message: `expected a whole number of milliseconds, got "${v}"` });
        continue;
      }
      v = Number(v);
    }
    if (key === 'ignore' && typeof v === 'string') v = [v];
    picked[key] = v;
  }
  const r = InstanceSchema.safeParse(picked);
  if (!r.success || notNumbers.length > 0) {
    const flagFor = (k: string): string | undefined => (CONFIG_KEYS as readonly string[]).includes(k)
      ? CONFIG_FLAGS[k as ConfigKey] : undefined;
    return { kind: 'invalid', issues: [...notNumbers, ...(r.success ? [] : issuesFromZod(r.error, 'cli', { flagFor }))] };
  }
  const value: InstanceInput = compact(r.data);
  if (value.dir !== undefined) value.dir = resolveDirInput(value.dir, cwd);
  if (value.sshKey !== undefined) value.sshKey = resolveDirInput(value.sshKey, cwd);
  return { kind: 'ok', value };
}

export function parseRepoConfig(text: string, log: Logger): Loaded<RepoInput> {
  const file = REPO_CONFIG_PATH;
  const json = parseJson(text);
  if (json.kind === 'invalid') return { kind: 'invalid', issues: [{ layer: 'repo', key: FILE_KEY, message: json.message, file }] };
  if (isRecord(json.value)) {
    for (const key of Object.keys(json.value)) {
      if ((INSTANCE_ONLY_KEYS as readonly string[]).includes(key)) {
        log.warn('repo config key ignored', { key, reason: 'instance-only' });
      } else if (!isSharedKey(key)) {
        log.warn('repo config key ignored', { key, reason: 'unknown' });
      }
    }
  }
  const r = RepoSchema.safeParse(json.value);
  if (!r.success) return { kind: 'invalid', issues: issuesFromZod(r.error, 'repo', { file }) };
  return { kind: 'ok', value: compact(r.data) };
}

// The committed HEAD blob, not the worktree. A tree (or anything else) at that path counts as absent.
export async function readRepoConfigBlob(g: GitClient): Promise<string | 'none'> {
  const r = await g.run(['cat-file', '--batch-check'], { input: `HEAD:${REPO_CONFIG_PATH}\n` });
  if (r.code !== 0) return 'none';
  const m = /^([0-9a-f]{40,64}) (\S+) \d+$/.exec(r.stdout.trim());
  return m?.[1] !== undefined && m[2] === 'blob' ? m[1] : 'none';
}

export async function readRepoConfigText(g: GitClient, blob: string): Promise<string> {
  return g.ok(['cat-file', 'blob', blob]);
}

// Absence is a known empty layer, and must replace any older saved config just like a valid file does.
export type LoadedRepoConfig = { blob: string | 'none'; layer: RepoInput;
  state: 'valid' | 'last-good' | 'unknown' | 'absent' };

export async function loadRepoConfig(g: GitClient, blob: string | 'none', log: Logger,
  lastGood?: RepoInput): Promise<LoadedRepoConfig> {
  if (blob === 'none') return { blob, layer: {}, state: 'absent' };
  let parsed: Loaded<RepoInput>;
  try {
    parsed = parseRepoConfig(await readRepoConfigText(g, blob), log);
  } catch (e) {
    parsed = { kind: 'invalid', issues: [{ layer: 'repo', key: '(file)', message: errorText(e), file: REPO_CONFIG_PATH }] };
  }
  if (parsed.kind === 'ok') return { blob, layer: parsed.value, state: 'valid' };
  const issues = parsed.kind === 'invalid' ? parsed.issues.map(formatIssue) : [];
  log.warn('repo config invalid', { issues, keeping: lastGood !== undefined ? 'last-good' : 'defaults' });
  return { blob, layer: lastGood ?? {}, state: lastGood !== undefined ? 'last-good' : 'unknown' };
}

export function resolveConfig(layers: ConfigLayers, host: string):
  { config: ResolvedConfig; sources: Record<keyof ResolvedConfig, ConfigLayerName> } {
  const defaults: Partial<ResolvedConfig> = {
    idleMs: 300_000, fallbackMs: 3_600_000, maxWaitMs: 1_800_000, autoCommit: 'timers', ignore: [],
    authorName: `mdsync@${host}`, authorEmail: `mdsync@${host}.local`,
  };
  const out: Record<string, unknown> = {};
  const sources = {} as Record<ConfigKey, ConfigLayerName>;
  for (const key of CONFIG_KEYS) {
    const repo = isSharedKey(key) ? (layers.repo as Record<string, unknown>)[key] : undefined;
    const detected: [ConfigLayerName, unknown][] = isDetectedKey(key) ? [[DETECTED_SOURCE[key], layers.detected?.[key]]] : [];
    const candidates: [ConfigLayerName, unknown][] = [
      ['cli', layers.cli[key]], ['instance', layers.instance[key]], ['repo', repo], ...detected, ['default', defaults[key]],
    ];
    const hit = candidates.find(([, v]) => v !== undefined);
    sources[key] = hit?.[0] ?? 'default';
    if (hit !== undefined) out[key] = Array.isArray(hit[1]) ? [...hit[1]] : hit[1];
  }
  return { config: out as ResolvedConfig, sources };
}

// `noFileAt`: the default config path, when no instance file was found there (said in the message, so a user who
// wrote the file elsewhere sees where mdsync looked).
export function requireKeys(c: ResolvedConfig, keys: readonly ('dir' | 'remote' | 'branch')[], noFileAt?: string): ConfigIssue[] {
  return keys.filter((k) => c[k] === undefined || c[k] === '')
    .map((key): ConfigIssue => ({ layer: 'instance', key, message: MISSING_MESSAGE, flag: CONFIG_FLAGS[key],
      ...(noFileAt !== undefined ? { file: noFileAt } : {}) }));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

export function changedKeys(a: ResolvedConfig, b: ResolvedConfig): (keyof ResolvedConfig)[] {
  return CONFIG_KEYS.filter((k) => !sameValue(a[k], b[k]));
}

export function formatIssue(i: ConfigIssue): string {
  if (i.message === MISSING_MESSAGE) {
    const flag = i.flag ?? (CONFIG_FLAGS as Partial<Record<string, string>>)[i.key];
    const how = `${flag !== undefined ? `pass ${flag} or ` : ''}set "${i.key}" in the config file`;
    return `${MISSING_MESSAGE} "${i.key}" (${how}${i.file !== undefined ? `; no config file at ${i.file}` : ''})`;
  }
  if (i.key === FILE_KEY) return `invalid config file${i.file !== undefined ? ` ${i.file}` : ''}: ${i.message}`;
  const where = i.flag !== undefined ? ` (${i.flag})` : i.file !== undefined ? ` in ${i.file}` : '';
  return `invalid config key "${i.key}"${where}: ${i.message}`;
}
