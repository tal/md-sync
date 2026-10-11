#!/usr/bin/env bun
// Entry point: parseArgs, dispatch, exit codes and the top-level crash handler.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { flushCommand } from './commands/flush';
import { installServiceCommand, uninstallServiceCommand } from './commands/install-service';
import { printWorkflowCommand } from './commands/print-workflow';
import { runCommand } from './commands/run';
import { type CliValues, type CommandEnv, createCliLogger, stderrLine, stderrText, stdoutText } from './commands/shared';
import { statusCommand } from './commands/status';
import { syncOnceCommand } from './commands/sync-once';
import { errorText, type Logger } from './log';
import { killChildrenGracefully } from './spawn';
import { UsageError } from './types';

const COMMANDS = ['run', 'sync-once', 'status', 'flush', 'install-service', 'uninstall-service', 'print-workflow'] as const;
type Command = (typeof COMMANDS)[number];

const OPTIONS = {
  cwd: { type: 'string' },
  config: { type: 'string' },
  'log-level': { type: 'string' },
  remote: { type: 'string' },
  dir: { type: 'string' },
  branch: { type: 'string' },
  'ntfy-url': { type: 'string' },
  'author-name': { type: 'string' },
  'author-email': { type: 'string' },
  'ssh-key': { type: 'string' },
  'idle-ms': { type: 'string' },
  'fallback-ms': { type: 'string' },
  'max-wait-ms': { type: 'string' },
  ignore: { type: 'string', multiple: true },
  message: { type: 'string', short: 'm' },
  wait: { type: 'boolean' },
  format: { type: 'string' },
  print: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

// Flags that belong to one command; anywhere else they are a usage error.
const COMMAND_FLAGS: Readonly<Record<string, { command: Command; flag: string }>> = {
  message: { command: 'flush', flag: '--message' },
  wait: { command: 'flush', flag: '--wait' },
  format: { command: 'status', flag: '--format' },
  print: { command: 'install-service', flag: '--print' },
};

export const USAGE = `Usage: md-sync <command> [flags]

Commands:
  run                 sync a folder in the foreground (what services and containers run)
  sync-once           one commit run (stage, commit, fetch, rebase, push), then exit
  flush               commit now: hands the request to the running daemon, or syncs itself
  status              last sync, daemon state, unpushed commits and pending changes
  install-service     install and start a launchd agent (macOS) or systemd user unit (Linux)
  uninstall-service   stop and remove that service
  print-workflow      print the GitHub Action that announces pushes on ntfy

Global flags:
  --cwd <path>              run as if started in this folder (relative paths in other flags resolve from it)

Config flags (any command; they override the config file):
  --config <path>           instance config file (default: $XDG_CONFIG_HOME/mdsync/config.json)
  --dir <path>              the synced folder (default: the current folder, if it is the top of a git checkout)
  --remote <url>            git remote to clone and sync with (default: the folder's origin)
  --branch <name>           branch to sync (default: the checked-out branch; required for a new clone)
  --ntfy-url <url>          ntfy topic URL to subscribe to
  --idle-ms <ms>            commit after this much quiet (default: 300000)
  --max-wait-ms <ms>        commit at the latest this long after the first change (default: 1800000)
  --fallback-ms <ms>        pull at least this often (default: 3600000)
  --ignore <glob>           ignore pattern, repeatable (replaces lower layers)
  --author-name <name>      commit author name
  --author-email <email>    commit author email
  --ssh-key <path>          SSH private key for this repo
  --log-level <level>       debug, info, warn or error (env: MDSYNC_LOG_LEVEL)

flush [path...]:  -m, --message <text>   --wait | --no-wait   (no paths: commit everything pending)
status:           --format <text|json>
install-service:  --print (write the unit to stdout instead of installing it)

  -h, --help        show this help
  --version         print the version
`;

const USAGE_HINT = "run 'md-sync --help' for usage";

type Parsed =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'command'; command: Command; values: CliValues; paths: string[] };

function isCommand(s: string): s is Command {
  return (COMMANDS as readonly string[]).includes(s);
}

// Throws UsageError for anything that should exit 2.
export function parseCli(argv: readonly string[]): Parsed {
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: true, allowNegative: true });
  } catch (e) {
    // "TypeError: Unknown option '--dirr'. To specify a positional argument starting with a '-', place it at the end
    // of the command after '--', as in '-- \"--dirr\"." -> "unknown option '--dirr'"
    const raw = e instanceof Error ? e.message : errorText(e);
    const first = raw.split('. To specify a positional argument')[0] ?? raw;
    throw new UsageError(first.charAt(0).toLowerCase() + first.slice(1));
  }
  const values = parsed.values as CliValues;
  if (values.help === true) return { kind: 'help' };
  if (values.version === true) return { kind: 'version' };
  const [command, ...rest] = parsed.positionals;
  if (command === undefined) throw new UsageError('no command given');
  if (!isCommand(command)) throw new UsageError(`unknown command "${command}"`);
  const paths = command === 'flush' ? rest : [];
  if (command !== 'flush' && rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  for (const [key, owner] of Object.entries(COMMAND_FLAGS)) {
    if (values[key as keyof CliValues] !== undefined && owner.command !== command) {
      throw new UsageError(`${owner.flag} is only valid for ${owner.command}`);
    }
  }
  if (values.format !== undefined && values.format !== 'text' && values.format !== 'json') {
    throw new UsageError(`--format must be text or json, not "${values.format}"`);
  }
  return { kind: 'command', command, values, paths };
}

// status, print-workflow and (un)install-service keep stdout for their own output.
function sinkFor(command: Command): 'stdout' | 'stderr' {
  return command === 'run' || command === 'sync-once' || command === 'flush' ? 'stdout' : 'stderr';
}

async function dispatch(command: Command, c: CommandEnv): Promise<number> {
  switch (command) {
    case 'run': return runCommand(c);
    case 'sync-once': return syncOnceCommand(c);
    case 'status': return statusCommand(c);
    case 'flush': return flushCommand(c);
    case 'install-service': return installServiceCommand(c);
    case 'uninstall-service': return uninstallServiceCommand(c);
    case 'print-workflow': return printWorkflowCommand(c);
  }
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    if (argv.length === 0) {
      stderrText(USAGE);
      return 2;
    }
    stderrLine(`${e.message} (${USAGE_HINT})`);
    return 2;
  }
  if (parsed.kind === 'help') {
    stdoutText(USAGE);
    return 0;
  }
  if (parsed.kind === 'version') {
    stdoutText(`md-sync ${pkg.version}\n`);
    return 0;
  }

  if (parsed.values.cwd !== undefined) {
    const target = resolve(cwd, parsed.values.cwd);
    try {
      if (!statSync(target).isDirectory()) throw new Error('not a directory');
      process.chdir(target);
    } catch {
      stderrLine(`--cwd "${parsed.values.cwd}" is not a directory you can enter (resolved to ${target})`);
      return 2;
    }
    cwd = target;
  }

  const logger = createCliLogger(parsed.values, env, sinkFor(parsed.command));
  if (logger.kind === 'exit') return logger.code;
  const log = logger.log;
  // The daemon installs its own fatal handling; every other command logs `fatal` and exits 1.
  if (parsed.command !== 'run') installFatalHandlers(log);
  try {
    return await dispatch(parsed.command, { values: parsed.values, paths: parsed.paths, cwd, env, log, logLevelFlag: logger.flag });
  } catch (e) {
    if (e instanceof UsageError) {
      stderrLine(e.message);
      return 2;
    }
    log.error('fatal', { error: e });
    stderrLine(errorText(e));
    await killChildrenGracefully();
    return 1;
  }
}

function installFatalHandlers(log: Logger): void {
  const onFatal = (e: unknown): void => {
    log.error('fatal', { error: e });
    stderrLine(errorText(e));
    void killChildrenGracefully().finally(() => process.exit(1));
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2)).catch((e: unknown) => {
    stderrLine(`fatal: ${errorText(e)}`);
    return 1;
  });
  process.exit(code);
}
