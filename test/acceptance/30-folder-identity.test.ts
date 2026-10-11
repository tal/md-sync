// The synced folder stays the repository and the path the daemon started with (the
// git ceiling, P0): a folder that loses its .git inside another repo never touches that repo, and a case-only rename of a
// parent makes the daemon restart under the new path instead of going deaf.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupAll, createRemote, setupTestEnv, startDaemon, type LogLine } from '../harness';

afterEach(cleanupAll);

function sh(env: Record<string, string>, cwd: string, args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, env });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

// A parent repo on branch `feature`, with an unpushed commit on its main: what a developer's checkout looks like.
function parentRepo(env: Record<string, string>, root: string): { dir: string; remote: string } {
  const remote = join(root, 'parent-remote.git');
  const dir = join(root, 'parent');
  sh(env, root, ['init', '-q', '--bare', '-b', 'main', remote]);
  mkdirSync(dir);
  sh(env, dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'app.txt'), 'app\n');
  sh(env, dir, ['add', '.']);
  sh(env, dir, ['commit', '-qm', 'parent init']);
  sh(env, dir, ['remote', 'add', 'origin', remote]);
  sh(env, dir, ['push', '-q', '-u', 'origin', 'main']);
  writeFileSync(join(dir, 'wip.txt'), 'wip\n');
  sh(env, dir, ['add', '.']);
  sh(env, dir, ['commit', '-qm', 'LOCAL-ONLY WIP']);
  sh(env, dir, ['checkout', '-q', '-b', 'feature']);
  return { dir, remote };
}

for (const how of ['dotgit-removed', 'folder-recreated'] as const) {
  test(`the synced folder inside another repo (${how}): that repo's branch, commits and remote stay untouched`, async () => {
    // git searched upward from the de-gitted folder and found the parent: P6 checked out its main, S2 committed the
    // notes into it and S6 pushed them, together with the parent's unpushed work.
    const t = await setupTestEnv(`parent-${how}`);
    const r = await createRemote(t, { files: { 'README.md': 'notes\n', 'secret.md': 'private\n' } });
    const P = parentRepo(t.env, t.root);
    sh(t.env, P.dir, ['clone', '-q', r.url, 'notes']);
    const dir = join(P.dir, 'notes');
    const parentHead = sh(t.env, P.dir, ['rev-parse', 'HEAD']);
    const parentMain = sh(t.env, P.dir, ['rev-parse', 'main']);
    const parentRemote = sh(t.env, P.remote, ['rev-parse', 'main']);
    const A = await startDaemon(t, { name: 'A', dir, remote: r, config: { idleMs: 1_500, maxWaitMs: 4_000 } });

    const m = A.mark();
    if (how === 'dotgit-removed') {
      rmSync(join(dir, '.git'), { recursive: true, force: true });
      writeFileSync(join(dir, 'secret.md'), 'private, edited\n');
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeFileSync(join(dir, 'new.md'), 'new\n');
    }
    const f = await A.flush(['--wait']);
    expect(f.code).toBe(1);
    expect(f.stderr).toContain('is no longer a git repository');
    await Bun.sleep(6_000);   // the backup timers fire too (idle 1.5 s, max-wait 4 s)

    expect(sh(t.env, P.dir, ['symbolic-ref', '--short', 'HEAD'])).toBe('feature');
    expect(sh(t.env, P.dir, ['rev-parse', 'HEAD'])).toBe(parentHead);
    expect(sh(t.env, P.dir, ['rev-parse', 'main'])).toBe(parentMain);
    expect(sh(t.env, P.remote, ['rev-parse', 'main'])).toBe(parentRemote);
    expect(sh(t.env, P.dir, ['status', '--porcelain', '--untracked-files=no'])).toBe('');
    const done = A.logs.slice(m).filter((l: LogLine) => l.msg === 'sync done');
    expect(done.length).toBeGreaterThan(0);
    for (const l of done) {
      expect(l.outcome).toBe('failed');
      expect(String(l.error)).toContain('no longer a git repository');
    }
    expect(A.logs.slice(m).filter((l) => l.msg === 'committed' || l.msg === 'pushed' || l.msg === 'recovered')).toEqual([]);
    expect(await r.tree()).toEqual(['README.md', 'secret.md']);
  }, 120_000);
}

// Needs a case-insensitive filesystem (the default on macOS): there the old spelling keeps working for git.
const caseInsensitive = ((): boolean => {
  const probe = join(tmpdir(), `mdsync-case-probe-${process.pid}`);
  writeFileSync(probe, '');
  try {
    return existsSync(join(tmpdir(), `MDSYNC-CASE-PROBE-${process.pid}`));
  } finally {
    rmSync(probe, { force: true });
  }
})();

test.if(caseInsensitive)('a case-only rename of a parent folder: flushes still reach the daemon, which then restarts under the new path', async () => {
  // FSEvents reports the new spelling and Bun drops every event that does not start with the watched spelling, so
  // the watcher went silent; flush and status hashed the new spelling, missed the daemon and ran a second sync.
  const t = await setupTestEnv('case-rename');
  const r = await createRemote(t, { files: { 'README.md': 'notes\n' } });
  mkdirSync(join(t.root, 'projects'));
  sh(t.env, join(t.root, 'projects'), ['clone', '-q', r.url, 'notes']);
  const dir = join(t.root, 'projects', 'notes');
  const A = await startDaemon(t, { name: 'A', dir, remote: r });

  renameSync(join(t.root, 'projects'), join(t.root, 'Projects'));
  const moved = join(t.root, 'Projects', 'notes');
  writeFileSync(join(moved, 'x.md'), 'x\n');
  const m = A.mark();
  const f = await A.flush(['--wait']);
  expect({ code: f.code, oneOff: f.logs.some((l) => l.msg === 'one-off run') }).toEqual({ code: 0, oneOff: false });
  expect(A.logs.slice(m).some((l) => l.msg === 'flush received')).toBe(true);
  expect(await r.show('x.md')).toBe('x\n');

  const gone = await A.waitForLog('folder moved', { since: m, timeoutMs: 40_000 });
  expect({ dir: gone.dir, now: gone.now }).toEqual({ dir, now: moved });
  expect(await A.exited).toBe(1);
}, 120_000);
