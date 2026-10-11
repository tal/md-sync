// `run`: validate the CLI and instance layers, then hand over to the daemon. With
// neither, it syncs the checkout it starts in: its origin, its checked-out branch.
import { runDaemon } from '../daemon';
import { type CommandEnv, loadStartupLayers, requireRunKeys } from './shared';

export async function runCommand(c: CommandEnv): Promise<number> {
  const loaded = await loadStartupLayers(c);
  if (loaded.kind === 'exit') return loaded.code;
  const ready = requireRunKeys(c.log, loaded.layers, c.env);
  if (ready.kind === 'exit') return ready.code;
  return runDaemon({ layers: loaded.layers, env: c.env, log: c.log });
}
