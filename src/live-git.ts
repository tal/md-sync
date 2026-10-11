// "Is a git process (other than ours) running with its cwd inside the repo?" via lsof (darwin) or /proc (linux).
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { firstLine } from './fsutil';
import { errorText } from './log';
import { SpawnNotFoundError, liveChildPids, spawnTracked } from './spawn';

// visibility 'own-namespace': only this PID namespace was scanned (a container), so a git run by the host user on a
// bind-mounted folder is invisible and an empty result proves less.
export type PidVisibility = 'all' | 'own-namespace';
export type LiveGitScan = { kind: 'scanned'; pids: number[]; visibility: PidVisibility } | { kind: 'unknown'; error: string };

const INIT_PID_NS = 'pid:[4026531836]';   // PROC_PID_INIT_INO (0xEFFFFFFC): the host's, initial PID namespace
let visibilityOverride: PidVisibility | 'detect' = 'detect';

// Test hook: pretend to run in (or outside) a container.
export function overridePidVisibility(v: PidVisibility | 'detect'): void {
  visibilityOverride = v;
}

export function pidVisibility(): PidVisibility {
  if (visibilityOverride !== 'detect') return visibilityOverride;
  if (process.platform !== 'linux') return 'all';   // darwin: lsof lists every process
  try {
    return readlinkSync('/proc/self/ns/pid') === INIT_PID_NS ? 'all' : 'own-namespace';
  } catch {
    return 'own-namespace';
  }
}

const LSOF_TIMEOUT_MS = 10_000;
const LSOF_FALLBACK = '/usr/sbin/lsof';   // launchd's default PATH may not include /usr/sbin

type RawScan = { kind: 'scanned'; pids: Set<number> } | { kind: 'unknown'; error: string };

function inside(cwd: string, realRoot: string): boolean {
  const root = realRoot.endsWith('/') ? realRoot.slice(0, -1) : realRoot;
  return root === '' || cwd === root || cwd.startsWith(root + '/');
}

async function scanLsof(realRoot: string): Promise<RawScan> {
  const lsof = Bun.which('lsof') ?? LSOF_FALLBACK;
  const r = await spawnTracked([lsof, '-b', '-w', '-a', '-c', 'git', '-d', 'cwd', '-Fpn'],
    { cwd: '/', env: { ...process.env, LC_ALL: 'C' }, timeoutMs: LSOF_TIMEOUT_MS });
  if (r.spawnError !== undefined) return { kind: 'unknown', error: `lsof: ${r.spawnError}` };
  if (r.timedOut === 'timed-out') return { kind: 'unknown', error: `lsof timed out after ${LSOF_TIMEOUT_MS} ms` };
  // A grandchild holding the pipe: the listing may be incomplete, so it proves nothing.
  if (r.drain === 'truncated') return { kind: 'unknown', error: 'lsof output truncated' };
  const out = new TextDecoder().decode(r.stdout);
  if (out.trim() === '') {
    if (r.code === 0 || r.code === 1) return { kind: 'scanned', pids: new Set() };
    const why = firstLine(new TextDecoder().decode(r.stderr));
    return { kind: 'unknown', error: why === '' ? `lsof exited ${r.code}` : `lsof exited ${r.code}: ${why}` };
  }
  const pids = new Set<number>();
  let pid: number | 'none' = 'none';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : 'none';
    } else if (line.startsWith('n') && pid !== 'none' && inside(line.slice(1), realRoot)) {
      pids.add(pid);
    }
  }
  return { kind: 'scanned', pids };
}

function scanProc(realRoot: string): RawScan {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch (e) {
    return { kind: 'unknown', error: `/proc: ${errorText(e)}` };
  }
  const pids = new Set<number>();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (!readFileSync(`/proc/${name}/comm`, 'utf8').startsWith('git')) continue;
      if (inside(readlinkSync(`/proc/${name}/cwd`), realRoot)) pids.add(Number(name));
    } catch {
      // EACCES (another user's process) or ENOENT (it exited): skip
    }
  }
  return { kind: 'scanned', pids };
}

export async function liveGitIn(realRoot: string, o: { exclude?: ReadonlySet<number> } = {}): Promise<LiveGitScan> {
  // Default exclude: our own children. Snapshot before the scan as well, so a child that exits mid-scan
  // (and leaves the live set) is still not counted.
  const given = o.exclude;
  const before = given === undefined ? new Set(liveChildPids()) : new Set<number>();
  let raw: RawScan;
  try {
    if (process.platform === 'darwin') raw = await scanLsof(realRoot);
    else if (process.platform === 'linux') raw = scanProc(realRoot);
    else raw = { kind: 'unknown', error: `live git detection is not supported on ${process.platform}` };
  } catch (e) {
    const error = e instanceof SpawnNotFoundError ? 'lsof not found' : errorText(e);
    return { kind: 'unknown', error };
  }
  if (raw.kind === 'unknown') return raw;
  const excluded = (pid: number): boolean =>
    given !== undefined ? given.has(pid) : before.has(pid) || liveChildPids().has(pid);
  return { kind: 'scanned', pids: [...raw.pids].filter((p) => !excluded(p)).sort((a, b) => a - b), visibility: pidVisibility() };
}
