// `install-service` and `uninstall-service`.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { InstanceInput } from '../config';
import { canonicalDir, ensureStateDir, realpathLoose, statePathsFor } from '../paths';
import { hasUserinfo } from '../repo-defaults';
import {
  execArgv, installService, launchdLabel, renderLaunchdPlist, renderSystemdUnit, serviceArgv, serviceEnv, serviceKindFor,
  systemdUnitName, uninstallService,
} from '../service';
import { writeState } from '../state';
import {
  type CommandEnv, type DirectLayers, loadStartupLayers, loadStateOrFresh, requireRunKeys, resolveTarget, stderrLine,
  stdoutText, warnInvalidInstance,
} from './shared';

// The unit starts in / (launchd) or ~ (systemd), so a dir taken from the current directory goes into it, with the
// remote taken from origin, unless that carries credentials (`https://user:token@…`): the daemon then reads origin
// from the pinned folder at each start, and the token stays in .git/config only. A configured dir pins nothing: the
// daemon reads origin from it itself, and a pinned --remote would outrank a `remote` added to the config file later.
// The branch is never pinned: like a foreground `run`, the service syncs what is checked out when it starts.
function pinnedOverrides(layers: DirectLayers): InstanceInput {
  const d = layers.detected ?? {};
  if (d.dir === undefined) return layers.cli;
  return { ...layers.cli, dir: d.dir, ...(d.remote !== undefined && !hasUserinfo(d.remote) ? { remote: d.remote } : {}) };
}

export async function installServiceCommand(c: CommandEnv): Promise<number> {
  const loaded = await loadStartupLayers(c);
  if (loaded.kind === 'exit') return loaded.code;
  const ready = requireRunKeys(c.log, loaded.layers, c.env);
  if (ready.kind === 'exit') return ready.code;
  const kind = serviceKindFor(process.platform);
  if (kind === 'unsupported') {
    stderrLine(`install-service is not supported on ${process.platform} (launchd on macOS, systemd on Linux)`);
    return 1;
  }

  const action: 'print' | 'install' = c.values.print === true ? 'print' : 'install';   // enum at the CLI boundary
  // A fresh device can install before its first clone. --print only previews: it creates nothing (the realpath of
  // the longest existing ancestor gives the same state hash the install would).
  if (action === 'install') mkdirSync(ready.config.dir, { recursive: true });
  const realDir = action === 'install' ? canonicalDir(ready.config.dir) : realpathLoose(resolve(ready.config.dir));
  const paths = statePathsFor(realDir, c.env);
  const { layers } = loaded;
  const cli = pinnedOverrides(layers);
  const argv = serviceArgv(execArgv(), layers.instancePath, cli, c.logLevelFlag);
  const env = serviceEnv(c.env);
  const text = kind === 'launchd'
    ? renderLaunchdPlist({ label: launchdLabel(paths.hash), argv, env, logPath: paths.log })
    : renderSystemdUnit({ realDir, argv, env });

  if (action === 'print') {
    stdoutText(text);
    return 0;
  }

  ensureStateDir(paths);
  writeState(paths, { ...loadStateOrFresh(paths, realDir), updatedAt: new Date().toISOString(),
    instance: { configPath: layers.instancePath, cli } });
  const r = await installService({ kind, hash: paths.hash, text, env: c.env });
  if (r.kind === 'failed') {
    stderrLine(`install-service failed: ${r.error}`);
    return 1;
  }
  // what to look for later: the unit's name (for launchctl / systemctl) and where its log goes
  if (kind === 'launchd') stderrLine(`installed ${launchdLabel(paths.hash)}; log: ${paths.log}`);
  else stderrLine(`installed ${systemdUnitName(paths.hash)}; logs: journalctl --user -u ${systemdUnitName(paths.hash)}`);
  if (kind === 'systemd') stderrLine('To keep mdsync running after logout: loginctl enable-linger $USER');
  return 0;
}

export async function uninstallServiceCommand(c: CommandEnv): Promise<number> {
  const t = resolveTarget(c);
  if (t.kind === 'exit') return t.code;
  warnInvalidInstance(t.target);   // a unit crash-looping on a bad config must still be removable
  const kind = serviceKindFor(process.platform);
  if (kind === 'unsupported') {
    stderrLine(`uninstall-service is not supported on ${process.platform}`);
    return 1;
  }
  const r = await uninstallService({ kind, hash: t.target.paths.hash, env: c.env });
  if (r.kind === 'failed') {
    stderrLine(`uninstall-service failed: ${r.error}`);
    return 1;
  }
  return 0;
}
