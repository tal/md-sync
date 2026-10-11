// Zero-config defaults read from the synced folder's own checkout: `dir` is the current directory when it is the top of
// a git worktree, `remote` its `origin` URL and `branch` the branch checked out there. Read once, before the daemon
// starts, so a later `git checkout` needs a restart like any other branch change. An explicit folder is only ever read
// through its own `.git`: git never searches above it (a folder inside another repo must not pick up that repo's branch).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type DetectedInput, type DirectLayers, isValidBranchName, parseRepoConfig, readRepoConfigBlob, readRepoConfigText,
} from './config';
import { absoluteGitDir, createGitClient, type GitClient } from './git';
import { firstLine, kindAt } from './fsutil';
import { createLogger, type Logger } from './log';
import { canonicalDir, realpathLoose, statePathsFor } from './paths';
import { readJournal } from './state';

type Refusal = { kind: 'refused'; key: 'dir' | 'branch'; message: string };
export type RepoDefaults = { kind: 'ok'; layers: DirectLayers } | Refusal;

// For read-only git clients; the identity is never used.
export const PROBE_IDENTITY = { name: 'mdsync', email: 'mdsync@localhost' };
const HEADS = 'refs/heads/';

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

// No `dir` from any layer: the current directory must be the top of a git worktree. Syncing whatever folder a command
// happened to start in (a home directory, a subfolder of a project) would commit and push all of it.
async function requireWorktreeTop(cwd: string, log: Logger): Promise<'ok' | Refusal> {
  const g = createGitClient({ cwd, identity: PROBE_IDENTITY, log, discovery: 'search-up' });
  const r = await g.run(['rev-parse', '--show-toplevel']);
  if (r.code !== 0) {
    const why = r.spawnError ?? firstLine(r.stderr);
    const detail = why === '' || /not a git repository/i.test(why) ? '' : ` (${why})`;
    return { kind: 'refused', key: 'dir', message: `no dir given and ${cwd} is not a git repository${detail}; pass --dir` };
  }
  const top = r.stdout.trim();
  if (realpathLoose(top) !== realpathLoose(cwd)) {
    return { kind: 'refused', key: 'dir',
      message: `no dir given and ${cwd} is inside the git repository ${top}, not at its top; run md-sync from ${top} or pass --dir` };
  }
  return 'ok';
}

// A detached HEAD that still says which branch it belongs to: a rebase in progress (git's own head-name, also left by a
// rebase stopped on a conflict), or an mdsync worktree move interrupted before it re-attached HEAD (its journal's ref
// step). Without these, a daemon killed in that window could never restart without --branch.
async function intendedBranch(g: GitClient, dir: string, env: NodeJS.ProcessEnv): Promise<string | 'none'> {
  let gitDir: string | 'none' = 'none';
  try { gitDir = await absoluteGitDir(g); } catch { /* keep */ }
  if (gitDir !== 'none') {
    for (const op of ['rebase-merge', 'rebase-apply']) {
      const name = readText(join(gitDir, op, 'head-name')).trim();
      if (name.startsWith(HEADS)) return name;
    }
  }
  let realDir: string;
  try {
    realDir = canonicalDir(dir);
  } catch {
    return 'none';
  }
  const j = readJournal(statePathsFor(realDir, env).journal);
  const ref = j !== 'none' ? j.move?.ref : undefined;
  return ref?.kind === 'update' && ref.head === 'attach' && ref.ref.startsWith(HEADS) ? ref.ref : 'none';
}

type Checkout = { kind: 'branch'; name: string } | Refusal;

const PASS_BRANCH = 'pass --branch (or set "branch" in the config file)';
// parseRepoConfig warns about ignored keys; the daemon says that once, when it loads the same file
const QUIET = createLogger({ level: 'error', sink: 'stderr', write: () => {} });

function refuseBranch(message: string): Refusal {
  return { kind: 'refused', key: 'branch', message };
}

function branchOf(ref: string, dir: string): Checkout {
  const name = ref.startsWith(HEADS) ? ref.slice(HEADS.length) : '';
  if (name !== '' && isValidBranchName(name)) return { kind: 'branch', name };
  return refuseBranch(`HEAD in ${dir} is ${ref}, not a branch mdsync can sync; ${PASS_BRANCH}`);
}

// The committed repo file's `branch`; anything unreadable counts as unset. Here it is read only to spare a detached HEAD
// the refusal, and returned as the detected value so the provisional config (no repo layer) has it; the repo layer then
// supplies the same value.
export async function committedBranch(g: GitClient, log: Logger): Promise<string | 'none'> {
  try {
    const blob = await readRepoConfigBlob(g);
    if (blob === 'none') return 'none';
    const parsed = parseRepoConfig(await readRepoConfigText(g, blob), log);
    return parsed.kind === 'ok' && parsed.value.branch !== undefined ? parsed.value.branch : 'none';
  } catch {
    return 'none';
  }
}

async function checkedOutBranch(g: GitClient, dir: string, env: NodeJS.ProcessEnv): Promise<Checkout> {
  const r = await g.run(['symbolic-ref', '-q', 'HEAD']);
  if (r.code === 0) return branchOf(r.stdout.trim(), dir);   // an unborn branch counts: its first commit lands there
  // Anything but "detached" (exit 1) is a HEAD git itself rejects: an interrupted clone leaves `ref: refs/heads/.invalid`
  // (symbolic-ref exits 128). With the branch given, P6 points HEAD at it and the next fetch completes the clone.
  if (r.code !== 1) {
    const why = r.spawnError ?? (firstLine(r.stderr) || `git symbolic-ref exited ${r.code}`);
    return refuseBranch(`HEAD in ${dir} does not name a valid branch, as an interrupted clone leaves it (${why}); ${PASS_BRANCH}`);
  }
  const intended = await intendedBranch(g, dir, env);
  if (intended !== 'none') return branchOf(intended, dir);
  const committed = await committedBranch(g, QUIET);
  if (committed !== 'none') return { kind: 'branch', name: committed };
  return refuseBranch(`${dir} has a detached HEAD, so there is no checked-out branch to sync; check out a branch `
    + `(git -C ${dir} switch <branch>) or ${PASS_BRANCH}`);
}

// `dir`: 'from-layers' for run, sync-once and install-service (the layers' dir, else the current directory); the
// target folder for flush and status, which find it on their own. `remote` and `branch` are read only for keys no flag
// or instance file sets, and only from a folder that is already a repository. An empty or missing one (a fresh clone)
// has no branch to read, and there is no built-in default: the missing key "branch" is reported by the caller.
export async function withRepoDefaults(o: { layers: DirectLayers; cwd: string; env: NodeJS.ProcessEnv; log: Logger;
  dir: 'from-layers' | string }): Promise<RepoDefaults> {
  const set = (k: keyof DetectedInput): string | undefined => o.layers.cli[k] ?? o.layers.instance[k];
  const detected: DetectedInput = {};
  let dir: string;
  if (o.dir !== 'from-layers') {
    dir = o.dir;
  } else {
    const given = set('dir');
    if (given !== undefined) {
      dir = given;
    } else {
      dir = resolve(o.cwd);
      const top = await requireWorktreeTop(dir, o.log);
      if (top !== 'ok') return top;
      detected.dir = dir;
    }
  }
  const wantRemote = set('remote') === undefined ? 'detect' : 'given';
  const wantBranch = set('branch') === undefined ? 'detect' : 'given';
  if ((wantRemote === 'detect' || wantBranch === 'detect') && kindAt(join(dir, '.git')) !== 'missing') {
    const g = createGitClient({ cwd: dir, identity: PROBE_IDENTITY, log: o.log });
    const [r, b] = await Promise.all([
      wantRemote === 'detect' ? g.run(['remote', 'get-url', 'origin']) : undefined,
      wantBranch === 'detect' ? checkedOutBranch(g, dir, o.env) : undefined,
    ]);
    const url = r?.stdout.trim() ?? '';
    if (r?.code === 0 && url !== '') detected.remote = url;
    if (b?.kind === 'refused') return b;
    if (b !== undefined) detected.branch = b.name;
  }
  return { kind: 'ok', layers: { ...o.layers, detected } };
}

// URLs that carry a user (and maybe a password or token) before the host: `https://user:token@host/x.git`. They are
// never written into a service unit; the daemon reads `origin` itself at each start instead.
export function hasUserinfo(url: string): boolean {
  return /^\w[\w+.-]*:\/\/[^/@\s]+@/.test(url);
}
