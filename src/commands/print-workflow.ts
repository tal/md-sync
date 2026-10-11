// `print-workflow`: the GitHub Action YAML for the configured branch.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireKeys, resolveConfig } from '../config';
import { createGitClient } from '../git';
import { shortHostname } from '../host';
import type { Logger } from '../log';
import { canonicalDir, defaultConfigPath } from '../paths';
import { committedBranch, PROBE_IDENTITY, withRepoDefaults } from '../repo-defaults';
import { renderWorkflow } from '../workflow-template';
import { type CommandEnv, loadDirectLayers, reportIssues, stderrLine, stdoutText } from './shared';

// The committed repo layer's `branch`, when the configured dir is already a clone (precedence: CLI > instance >
// repo > default). Anything unreadable counts as unset.
async function repoBranch(dir: string | undefined, log: Logger): Promise<string | 'unset'> {
  if (dir === undefined) return 'unset';
  let realDir: string;
  try {
    realDir = canonicalDir(dir);
  } catch {
    return 'unset';
  }
  if (!existsSync(join(realDir, '.git'))) return 'unset';
  const branch = await committedBranch(createGitClient({ cwd: realDir, identity: PROBE_IDENTITY, log }), log);
  return branch === 'none' ? 'unset' : branch;
}

export async function printWorkflowCommand(c: CommandEnv): Promise<number> {
  const loaded = loadDirectLayers(c);
  if (loaded.kind === 'exit') return loaded.code;
  const { cli, instance, instancePath } = loaded.layers;
  const given = cli.branch ?? instance.branch;
  if (given !== undefined) {
    stdoutText(renderWorkflow(given));
    return 0;
  }
  // the branch a daemon started the same way would sync: the repo file's, else the one checked out in the folder (the
  // current directory when no dir is configured). There is no default branch: without one, exit 2 like `run`.
  const d = await withRepoDefaults({ layers: loaded.layers, cwd: c.cwd, env: c.env, log: c.log, dir: 'from-layers' });
  if (d.kind === 'refused' && d.key === 'branch') {
    stderrLine(d.message);
    c.log.error('config invalid', { key: d.key, issues: [d.message] });
    return 2;
  }
  const layers = d.kind === 'ok' ? d.layers : loaded.layers;   // a dir refusal: no checkout to read, only the files
  const fromRepo = await repoBranch(cli.dir ?? instance.dir ?? layers.detected?.dir, c.log);
  const config = resolveConfig({ ...layers, repo: fromRepo === 'unset' ? {} : { branch: fromRepo } }, shortHostname()).config;
  if (config.branch === undefined) {
    return reportIssues(c.log, requireKeys(config, ['branch'], instancePath === 'none' ? defaultConfigPath(c.env) : undefined));
  }
  stdoutText(renderWorkflow(config.branch));
  return 0;
}
