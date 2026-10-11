// RunContext construction and the effective (repo-layer-included) config.
import {
  type ConfigLayerName, type ConfigLayers, type LoadedRepoConfig, loadRepoConfig, type ReadyConfig, readRepoConfigBlob,
  type RepoInput, type ResolvedConfig, resolveConfig,
} from './config';
import { absoluteGitDir, createGitClient, emptyTree, type GitClient, objectFormat } from './git';
import { shortHostname } from './host';
import { compileIgnore, type IgnoreMatcher } from './ignore';
import type { Logger } from './log';
import type { StatePaths } from './paths';
import { type Clock, realClock } from './types';

export type RunContext = {
  config: ReadyConfig;
  realDir: string;
  gitDir: string;                    // absolute
  branch: string;                    // = config.branch
  host: string;
  paths: StatePaths;
  ignore: IgnoreMatcher;
  git: GitClient;                    // cwd = realDir, identity = config.author*
  objectFormat: 'sha1' | 'sha256';
  emptyTree: string;
  ignoreCase: 'case-insensitive' | 'case-sensitive';   // git config --get core.ignorecase == 'true'
  // 'unknown': the committed repo config is invalid and no earlier valid one is known here, so its `ignore` list is
  // unknown too; commit runs refuse to stage rather than push what it may protect.
  repoRules: 'known' | 'unknown';
  log: Logger;
  clock: Clock;
};

export async function createRunContext(o: { config: ReadyConfig; realDir: string; paths: StatePaths; log: Logger;
  clock?: Clock; repoRules?: RunContext['repoRules'] }): Promise<RunContext> {
  const git = createGitClient({ cwd: o.realDir, sshKey: o.config.sshKey, identity: { name: o.config.authorName, email: o.config.authorEmail },
    log: o.log });
  const [gitDir, format, empty, ignorecase] = await Promise.all([
    absoluteGitDir(git), objectFormat(git), emptyTree(git), git.run(['config', '--get', 'core.ignorecase']),
  ]);
  const config: ReadyConfig = { ...o.config, ignore: [...o.config.ignore] };
  return {
    config,
    realDir: o.realDir,
    gitDir,
    branch: config.branch,
    host: shortHostname(),
    paths: o.paths,
    ignore: compileIgnore(config.ignore),
    git,
    objectFormat: format,
    emptyTree: empty,
    ignoreCase: ignorecase.code === 0 && ignorecase.stdout.trim() === 'true' ? 'case-insensitive' : 'case-sensitive',
    repoRules: o.repoRules ?? 'known',
    log: o.log,
    clock: o.clock ?? realClock,
  };
}

// repo.state: 'valid' (the committed file parsed; persist it as the last good layer), 'last-good' (invalid, the
// given last good layer is used), 'unknown' (invalid and none known), 'absent' (no committed file).
export type Effective = { config: ReadyConfig; sources: Record<keyof ResolvedConfig, ConfigLayerName>; ctx: RunContext;
  repo: LoadedRepoConfig };

// The only way commands and the daemon build a context: the repo layer is read from the committed HEAD blob first,
// so identity and `ignore` include it from the very first run.
export async function loadEffectiveConfig(o: { layers: Omit<ConfigLayers, 'repo'>; realDir: string; paths: StatePaths;
  log: Logger; clock?: Clock; lastGoodRepo?: RepoInput }): Promise<Effective> {
  const host = shortHostname();
  const provisional = resolveConfig({ ...o.layers, repo: {} }, host).config;
  // Read-only calls; the identity is irrelevant here.
  const reader = createGitClient({ cwd: o.realDir,
    sshKey: provisional.sshKey, identity: { name: provisional.authorName, email: provisional.authorEmail }, log: o.log });

  const blob = await readRepoConfigBlob(reader);
  const repo = await loadRepoConfig(reader, blob, o.log, o.lastGoodRepo);

  const { config: resolved, sources } = resolveConfig({ ...o.layers, repo: repo.layer }, host);
  // run, sync-once and flush refuse earlier without a branch (missing key, detached HEAD); this is the backstop
  if (resolved.branch === undefined) throw new Error(`no branch to sync in ${o.realDir}; pass --branch or set "branch" in the config file`);
  const config: ReadyConfig = { ...resolved, dir: resolved.dir ?? o.realDir, branch: resolved.branch };
  const ctx = await createRunContext({ config, realDir: o.realDir, paths: o.paths, log: o.log, clock: o.clock,
    repoRules: repo.state === 'unknown' ? 'unknown' : 'known' });
  return { config, sources, ctx, repo };
}
