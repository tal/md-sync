// Clone into an empty dir, origin check, unborn branch name. Never rewrites .git/config.
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ResolvedConfig } from './config';
import { kindAt, realpathOrSame } from './fsutil';
import { classifyFailure, GitError, type GitClient, headSha } from './git';
import { errorText, type Logger } from './log';

// retry: 'retryable' for a clone that failed on the network or on auth (the daemon retries it on the network backoff
// instead of exiting); 'final' for everything that needs a person (a non-empty folder, another repo, no origin).
// What bootstrap reads: `remote` to clone and to compare with origin, `branch` for an empty remote's unborn HEAD.
type BootConfig = Pick<ResolvedConfig, 'remote' | 'branch'>;

export type BootstrapResult = { kind: 'ready'; cloned: 'cloned' | 'existing' }
  | { kind: 'failed'; error: string; retry: 'retryable' | 'final' };

// trim, then drop trailing '/' and '.git' (in either order: 'x.git/' and 'x/.git' both normalize to 'x')
function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  for (;;) {
    const next = u.replace(/\/+$/, '').replace(/\.git$/, '');
    if (next === u) return u;
    u = next;
  }
}

// A folder we can't write can't be cloned into, and no retry fixes that. The usual cause is a container bind mount
// whose host folder didn't exist: Docker creates it owned by root, and the image runs as uid 1000.
function notWritable(dir: string): 'writable' | string {
  try {
    accessSync(dir, constants.W_OK);
    return 'writable';
  } catch {
    let owner = 'another user';
    try { owner = `uid ${statSync(dir).uid}`; } catch { /* keep */ }
    const me = process.getuid?.();
    return `${dir} is not writable${me !== undefined ? ` by uid ${me}` : ''} (it is owned by ${owner}); `
      + `chown it${me !== undefined ? ` to ${me}` : ''}, or create it yourself before the first run`;
  }
}

async function checkExisting(o: { realDir: string; config: BootConfig; log: Logger; git: GitClient }): Promise<BootstrapResult> {
  const top = await o.git.run(['rev-parse', '--show-toplevel'], { cwd: o.realDir });
  if (top.code !== 0) {
    return { kind: 'failed', retry: 'final', error: errorText(`${o.realDir} is not a git repository: ${
      new GitError(['rev-parse', '--show-toplevel'], top, classifyFailure(top, 'local')).message}`) };
  }
  if (realpathOrSame(top.stdout.trim()) !== o.realDir) {
    return { kind: 'failed', retry: 'final', error: `${o.realDir} is inside another repository` };
  }
  const origin = await o.git.run(['remote', 'get-url', 'origin'], { cwd: o.realDir });
  if (origin.code !== 0) return { kind: 'failed', retry: 'final', error: `no "origin" remote in ${o.realDir}` };
  const actual = origin.stdout.trim();
  const configured = o.config.remote;
  if (configured !== undefined && normalizeRemoteUrl(configured) !== normalizeRemoteUrl(actual)) {
    o.log.warn('remote mismatch', { configured, actual,
      hint: `git -C ${o.realDir} remote set-url origin ${configured}` });   // the logger redacts URL credentials
  }
  return { kind: 'ready', cloned: 'existing' };
}

async function cloneInto(o: { realDir: string; config: BootConfig; log: Logger; git: GitClient }): Promise<BootstrapResult> {
  const remote = o.config.remote;
  if (remote === undefined || remote === '') {
    return { kind: 'failed', retry: 'final', error: `${o.realDir} is not a git repository and no remote is configured` };
  }
  // The commands refuse this earlier (missing key "branch"); a fresh clone never guesses the branch.
  const branch = o.config.branch;
  if (branch === undefined) {
    return { kind: 'failed', retry: 'final', error: `no branch given to clone into ${o.realDir}; pass --branch or set "branch" in the config file` };
  }
  o.log.info('cloning', { remote });
  // --no-checkout: git's checkout overwrote a file an agent wrote into the folder while it ran, and exited 0.
  // The clone leaves HEAD born with no index and no files; the first run's P1b populates the folder with a worktree
  // move. No -q: it would silence --progress.
  const args = ['clone', '--no-checkout', '--progress', '--', remote, o.realDir];
  const r = await o.git.run(args, { cwd: dirname(o.realDir), kind: 'network' });
  if (r.code !== 0) {
    const failure = classifyFailure(r, 'clone');
    const error = errorText(new GitError(args, r, failure).message);
    if (failure === 'network') o.log.warn('network error', { op: 'clone', error, timedOut: r.timedOut });
    else if (failure === 'auth') o.log.error('auth failed', { op: 'clone', error });
    o.log.error('clone failed', { error, failure });
    return { kind: 'failed', error, retry: failure === 'network' || failure === 'auth' ? 'retryable' : 'final' };
  }

  const head = await headSha(o.git);
  o.log.info('cloned', { head });
  if (head === 'unborn') {
    // An empty remote: point the unborn HEAD at B, so the first commit lands on the configured branch.
    const want = `refs/heads/${branch}`;
    const cur = await o.git.run(['symbolic-ref', '-q', 'HEAD'], { cwd: o.realDir });
    if (cur.code !== 0 || cur.stdout.trim() !== want) await o.git.ok(['symbolic-ref', 'HEAD', want], { cwd: o.realDir });
  }
  return { kind: 'ready', cloned: 'cloned' };
}

// `o.git` must have cwd = realDir; the clone itself runs from dirname(realDir).
export async function ensureRepo(o: { realDir: string; config: BootConfig; log: Logger; git: GitClient },
                                 mode: 'may-clone' | 'existing-only'): Promise<BootstrapResult> {
  if (kindAt(join(o.realDir, '.git')) !== 'missing') return checkExisting(o);
  if (mode === 'existing-only') return { kind: 'failed', retry: 'final', error: `${o.realDir} is not a git repository` };
  let empty: 'empty' | 'not-empty';
  try {
    empty = readdirSync(o.realDir).length === 0 ? 'empty' : 'not-empty';
  } catch (e) {
    if (!existsSync(o.realDir)) return { kind: 'failed', retry: 'final', error: `${o.realDir} does not exist` };
    return { kind: 'failed', retry: 'final', error: errorText(e) };
  }
  if (empty === 'not-empty') {
    return { kind: 'failed', retry: 'final', error: `${o.realDir} is not empty and is not a git repository` };
  }
  const unwritable = notWritable(o.realDir);
  if (unwritable !== 'writable') return { kind: 'failed', retry: 'final', error: unwritable };
  return cloneInto(o);
}
