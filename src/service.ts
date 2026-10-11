// launchd / systemd unit rendering, install and uninstall.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { InstanceInput } from './config';
import { homeOf } from './fsutil';
import { resolveDirInput, xdgConfigHome } from './paths';
import { LOCAL_TIMEOUT_MS, SpawnNotFoundError, spawnTracked } from './spawn';
import type { LogLevel } from './types';

export type ServiceKind = 'launchd' | 'systemd';
export type ServiceOpResult = { kind: 'ok' } | { kind: 'failed'; error: string };

// Test seam (like lock.ts's injected fs): runs launchctl / systemctl. Defaults to spawnTracked.
export type ServiceCommandResult = { code: number; stdout: string; stderr: string };
export type ServiceRunner = (argv: string[], env: NodeJS.ProcessEnv) => Promise<ServiceCommandResult>;

export function serviceKindFor(platform: NodeJS.Platform): ServiceKind | 'unsupported' {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return 'unsupported';
}

// A compiled binary embeds its entry under /$bunfs/, so the executable alone is the command.
export function execArgv(o: { main: string; execPath: string } = { main: Bun.main, execPath: process.execPath }): string[] {
  return o.main.startsWith('/$bunfs/') ? [o.execPath] : [o.execPath, o.main];
}

// Config-layer flags in a fixed order, so units are stable across installs.
const OVERRIDE_FLAGS: readonly (readonly [keyof InstanceInput, string])[] = [
  ['remote', '--remote'],
  ['dir', '--dir'],
  ['branch', '--branch'],
  ['ntfyUrl', '--ntfy-url'],
  ['idleMs', '--idle-ms'],
  ['fallbackMs', '--fallback-ms'],
  ['ignore', '--ignore'],
  ['authorName', '--author-name'],
  ['authorEmail', '--author-email'],
  ['sshKey', '--ssh-key'],
  ['maxWaitMs', '--max-wait-ms'],
];

// parseArgs (strict) rejects `--flag -value` as ambiguous; `--flag=-value` is the unambiguous spelling.
function flag(name: string, value: string): string[] {
  return value.startsWith('-') ? [`${name}=${value}`] : [name, value];
}

export function serviceArgv(exec: string[], configPath: string | 'none', overrides: InstanceInput,
  logLevel: LogLevel | 'unset'): string[] {
  const argv = [...exec, 'run'];
  if (configPath !== 'none') argv.push(...flag('--config', resolve(configPath)));
  for (const [key, name] of OVERRIDE_FLAGS) {
    const v = overrides[key];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) argv.push(...flag(name, item));
    } else if (key === 'dir' || key === 'sshKey') {
      argv.push(...flag(name, resolveDirInput(String(v), process.cwd())));
    } else {
      argv.push(...flag(name, String(v)));
    }
  }
  if (logLevel !== 'unset') argv.push('--log-level', logLevel);
  return argv;
}

export function launchdLabel(hash: string): string {
  return `dev.mdsync.${hash}`;
}

// `home` defaults to the user's home; installService passes $HOME so tests can redirect it.
export function launchdPlistPath(hash: string, home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${launchdLabel(hash)}.plist`);
}

export function systemdUnitName(hash: string): string {
  return `mdsync-${hash}.service`;
}

export function systemdUnitPath(hash: string, env: NodeJS.ProcessEnv): string {
  return join(xdgConfigHome(env), 'systemd', 'user', systemdUnitName(hash));
}

// Where a unit may have been written: this environment's XDG_CONFIG_HOME, and the default ~/.config the user manager
// searches when its own environment has none.
export function systemdUnitCandidates(hash: string, env: NodeJS.ProcessEnv): string[] {
  return [...new Set([systemdUnitPath(hash, env), systemdUnitPath(hash, { ...env, XDG_CONFIG_HOME: undefined })])];
}

function readText(path: string): string | 'none' {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return 'none';
  }
}

// The XDG_STATE_HOME recorded in this folder's installed unit(s), if any: where that daemon keeps its socket and lock.
// A flush started with another environment (a GUI app's hook, no shell rc) looks there too.
export function installedStateHomes(hash: string, env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>();
  const plist = readText(launchdPlistPath(hash, homeOf(env)));
  if (plist !== 'none') {
    const m = /<key>XDG_STATE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
    if (m?.[1] !== undefined) out.add(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  }
  const units = systemdUnitCandidates(hash, env);
  for (const unit of units) {
    const text = readText(unit);
    if (text === 'none') continue;
    const m = /^Environment="XDG_STATE_HOME=(.*)"$/m.exec(text);
    if (m?.[1] !== undefined) {
      out.add(m[1].replace(/%%/g, '%').replace(/\\x([0-9a-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\(["\\])/g, '$1'));
    }
  }
  return [...out].filter((h) => h.startsWith('/'));
}

const FALLBACK_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// Only what the daemon needs from the install-time environment. GIT_TOKEN is never written into a unit.
export function serviceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const git = env.PATH !== undefined ? Bun.which('git', { PATH: env.PATH }) : Bun.which('git');
  const dirs = [...(git ? [dirname(git)] : []), dirname(process.execPath), ...FALLBACK_PATH];
  const out: Record<string, string> = { PATH: [...new Set(dirs)].join(':') };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'MDSYNC_LOG_LEVEL'] as const) {
    const v = env[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderLaunchdPlist(o: { label: string; argv: string[]; env: Record<string, string>; logPath: string }): string {
  const str = (s: string): string => `<string>${xmlEscape(s)}</string>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t${str(o.label)}`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...o.argv.map((a) => `\t\t${str(a)}`),
    '\t</array>',
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    ...Object.entries(o.env).flatMap(([k, v]) => [`\t\t<key>${xmlEscape(k)}</key>`, `\t\t${str(v)}`]),
    '\t</dict>',
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<true/>',
    '\t<key>ProcessType</key>',
    '\t<string>Background</string>',
    '\t<key>ExitTimeOut</key>',
    '\t<integer>300</integer>',
    '\t<key>StandardOutPath</key>',
    `\t${str(o.logPath)}`,
    '\t<key>StandardErrorPath</key>',
    `\t${str(o.logPath)}`,
    '</dict>',
    '</plist>',
  ];
  return lines.join('\n') + '\n';
}

// Control characters become C escapes, which systemd unquotes in both ExecStart= and Environment=.
function cEscapeControls(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// ExecStart= word: `$` would start variable expansion and `%` a specifier.
export function systemdQuoteArg(s: string): string {
  return `"${cEscapeControls(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')).replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

// Environment= assignment: specifiers apply, variable expansion does not, so `$` stays as is.
export function systemdQuoteEnv(key: string, value: string): string {
  return `"${cEscapeControls(`${key}=${value}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')).replace(/%/g, '%%')}"`;
}

export function renderSystemdUnit(o: { realDir: string; argv: string[]; env: Record<string, string> }): string {
  const description = o.realDir.replace(/[\x00-\x1f\x7f]/g, '?').replace(/%/g, '%%');
  const lines = [
    '[Unit]',
    `Description=mdsync for ${description}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${o.argv.map(systemdQuoteArg).join(' ')}`,
    'Restart=always',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    'KillMode=mixed',
    'TimeoutStopSec=300',
    ...Object.entries(o.env).map(([k, v]) => `Environment=${systemdQuoteEnv(k, v)}`),
    '',
    '[Install]',
    'WantedBy=default.target',
  ];
  return lines.join('\n') + '\n';
}

const decoder = new TextDecoder();

const defaultRunner: ServiceRunner = async (argv, env) => {
  const r = await spawnTracked(argv, { cwd: '/', env, timeoutMs: LOCAL_TIMEOUT_MS });
  const stderr = r.spawnError ?? (r.timedOut === 'timed-out' ? `timed out: ${decoder.decode(r.stderr)}` : decoder.decode(r.stderr));
  return { code: r.code, stdout: decoder.decode(r.stdout), stderr };
};

type Step = { kind: 'ran'; result: ServiceCommandResult } | { kind: 'not-found'; error: string };

async function step(runner: ServiceRunner, argv: string[], env: NodeJS.ProcessEnv): Promise<Step> {
  try {
    return { kind: 'ran', result: await runner(argv, env) };
  } catch (e) {
    if (e instanceof SpawnNotFoundError) return { kind: 'not-found', error: `${e.file} not found` };
    throw e;
  }
}

function failure(argv: string[], s: Step): ServiceOpResult {
  if (s.kind === 'not-found') return { kind: 'failed', error: s.error };
  const detail = (s.result.stderr.trim() || s.result.stdout.trim()).replace(/\s*\n\s*/g, ' ');
  return { kind: 'failed', error: `${argv.join(' ')} exited ${s.result.code}${detail ? `: ${detail}` : ''}` };
}

function succeeded(s: Step): boolean {
  return s.kind === 'ran' && s.result.code === 0;
}

function guiDomain(): string | 'none' {
  const uid = process.getuid?.();
  return uid === undefined ? 'none' : `gui/${uid}`;
}

// The unit file the user manager will find. `systemctl --user enable` resolves names in the manager, which searches
// its own $XDG_CONFIG_HOME (or ~/.config): an XDG_CONFIG_HOME exported only by a shell rc put the unit where the
// manager never looks, and enable failed with "Unit file ... does not exist".
async function managerUnitPath(hash: string, env: NodeJS.ProcessEnv, runner: ServiceRunner): Promise<string> {
  const s = await step(runner, ['systemctl', '--user', 'show-environment'], env);
  const m = s.kind === 'ran' && s.result.code === 0 ? /^XDG_CONFIG_HOME=(\/[^\n]*)$/m.exec(s.result.stdout) : null;
  return systemdUnitPath(hash, { ...env, XDG_CONFIG_HOME: m?.[1] });
}

// launchd can still be tearing down the booted-out job when bootstrap runs (error 5 / 37), so retry briefly.
const BOOTSTRAP_RETRY_DELAYS_MS = [500, 1_000] as const;

export async function installService(o: { kind: ServiceKind; hash: string; text: string; env: NodeJS.ProcessEnv;
  runner?: ServiceRunner }): Promise<ServiceOpResult> {
  const runner = o.runner ?? defaultRunner;
  try {
    if (o.kind === 'launchd') {
      const domain = guiDomain();
      if (domain === 'none') return { kind: 'failed', error: 'cannot determine the user id for launchctl' };
      const plist = launchdPlistPath(o.hash, homeOf(o.env));
      await step(runner, ['launchctl', 'bootout', `${domain}/${launchdLabel(o.hash)}`], o.env);   // not loaded: fine
      mkdirSync(dirname(plist), { recursive: true });
      await Bun.write(plist, o.text);
      const argv = ['launchctl', 'bootstrap', domain, plist];
      let s = await step(runner, argv, o.env);
      for (const ms of BOOTSTRAP_RETRY_DELAYS_MS) {
        if (succeeded(s) || s.kind === 'not-found') break;
        await Bun.sleep(ms);
        s = await step(runner, argv, o.env);
      }
      return succeeded(s) ? { kind: 'ok' } : failure(argv, s);
    }

    const unit = await managerUnitPath(o.hash, o.env, runner);
    const name = systemdUnitName(o.hash);
    // an older install where only this shell's XDG_CONFIG_HOME pointed: never leave two copies of the unit
    for (const other of systemdUnitCandidates(o.hash, o.env)) if (other !== unit) rmSync(other, { force: true });
    mkdirSync(dirname(unit), { recursive: true });
    await Bun.write(unit, o.text);
    // `restart` rather than `enable --now`: a reinstall over a running unit must pick up the new ExecStart.
    for (const argv of [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', name],
      ['systemctl', '--user', 'restart', name],
    ]) {
      const s = await step(runner, argv, o.env);
      if (!succeeded(s)) return failure(argv, s);
    }
    return { kind: 'ok' };
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

// A unit that was never installed is not an error.
export async function uninstallService(o: { kind: ServiceKind; hash: string; env: NodeJS.ProcessEnv;
  runner?: ServiceRunner }): Promise<ServiceOpResult> {
  const runner = o.runner ?? defaultRunner;
  try {
    if (o.kind === 'launchd') {
      const domain = guiDomain();
      if (domain === 'none') return { kind: 'failed', error: 'cannot determine the user id for launchctl' };
      const target = `${domain}/${launchdLabel(o.hash)}`;
      const bootout = ['launchctl', 'bootout', target];
      const out = await step(runner, bootout, o.env);
      if (out.kind === 'not-found') return failure(bootout, out);
      // bootout fails both for "not loaded" and for real errors; `print` tells them apart.
      if (!succeeded(out) && succeeded(await step(runner, ['launchctl', 'print', target], o.env))) return failure(bootout, out);
      rmSync(launchdPlistPath(o.hash, homeOf(o.env)), { force: true });
      return { kind: 'ok' };
    }

    const units = [...new Set([await managerUnitPath(o.hash, o.env, runner), ...systemdUnitCandidates(o.hash, o.env)])]
      .filter((u) => existsSync(u));
    const name = systemdUnitName(o.hash);
    if (units.length === 0) {
      await step(runner, ['systemctl', '--user', 'stop', name], o.env);   // a transient leftover; ignore failure
      return { kind: 'ok' };
    }
    const disable = ['systemctl', '--user', 'disable', '--now', name];
    const s = await step(runner, disable, o.env);
    if (!succeeded(s)) return failure(disable, s);
    for (const u of units) rmSync(u, { force: true });
    const reload = ['systemctl', '--user', 'daemon-reload'];
    const r = await step(runner, reload, o.env);
    return succeeded(r) ? { kind: 'ok' } : failure(reload, r);
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
