import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveGitIn, pidVisibility } from '../../src/live-git';
import { liveChildPids, spawnTracked } from '../../src/spawn';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-live-git-')));
const ENV_KEYS = ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'] as const;
const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
const holders = new Set<Bun.Subprocess>();
const groups = new Set<number>();
let n = 0;

beforeAll(() => {
  writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
});

afterAll(async () => {
  for (const p of holders) p.kill('SIGKILL');
  for (const g of groups) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      // gone
    }
  }
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function newRepo(): string {
  const dir = join(root, `repo-${++n}`);
  mkdirSync(dir);
  const r = Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: dir, env: process.env });
  expect(r.exitCode).toBe(0);
  return dir;
}

// Same shape as the harness's holdLiveGit: `git hash-object --stdin` with stdin left open.
async function holdLiveGit(dir: string): Promise<{ pid: number; release(): Promise<void> }> {
  const proc = Bun.spawn(['git', 'hash-object', '--stdin'], { cwd: dir, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env: process.env });
  holders.add(proc);
  // wait until it has started (cwd set, image exec'd) before scanning
  await Bun.sleep(150);
  return {
    pid: proc.pid,
    async release() {
      proc.stdin.end();
      await proc.exited;
      holders.delete(proc);
    },
  };
}

async function waitForPid(dir: string, pid: number, want: 'present' | 'absent', o: { exclude?: ReadonlySet<number> } = {}) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const scan = await liveGitIn(dir, o);
    expect(scan.kind).toBe('scanned');
    const has = scan.kind === 'scanned' && scan.pids.includes(pid);
    if ((want === 'present') === has || Date.now() > deadline) return scan;
    await Bun.sleep(100);
  }
}

describe('liveGitIn', () => {
  test('finds a git whose cwd is the repo', async () => {
    const dir = newRepo();
    const h = await holdLiveGit(dir);
    try {
      const scan = await waitForPid(dir, h.pid, 'present');
      expect(scan).toEqual({ kind: 'scanned', pids: expect.arrayContaining([h.pid]), visibility: pidVisibility() });
    } finally {
      await h.release();
    }
    const after = await waitForPid(dir, h.pid, 'absent');
    expect(after.kind === 'scanned' && after.pids.includes(h.pid)).toBe(false);
  });

  test('finds a git whose cwd is below the repo root', async () => {
    const dir = newRepo();
    const sub = join(dir, 'notes', 'deep');
    mkdirSync(sub, { recursive: true });
    const h = await holdLiveGit(sub);
    try {
      const scan = await waitForPid(dir, h.pid, 'present');
      expect(scan.kind === 'scanned' && scan.pids.includes(h.pid)).toBe(true);
    } finally {
      await h.release();
    }
  });

  test('does not report a git in another dir, or in a sibling whose name shares the prefix', async () => {
    const dir = newRepo();
    const other = newRepo();
    const sibling = `${dir}-sibling`;
    mkdirSync(sibling);
    const h1 = await holdLiveGit(other);
    const h2 = await holdLiveGit(sibling);
    try {
      // make sure both holders are visible at all, then that neither counts for `dir`
      expect(((await waitForPid(other, h1.pid, 'present')) as { pids: number[] }).pids).toContain(h1.pid);
      expect(((await waitForPid(sibling, h2.pid, 'present')) as { pids: number[] }).pids).toContain(h2.pid);
      const scan = await liveGitIn(dir);
      expect(scan.kind).toBe('scanned');
      if (scan.kind === 'scanned') {
        expect(scan.pids).not.toContain(h1.pid);
        expect(scan.pids).not.toContain(h2.pid);
      }
    } finally {
      await h1.release();
      await h2.release();
    }
  });

  test('our own children are excluded by default; an explicit exclude replaces the default', async () => {
    const dir = newRepo();
    const before = new Set(liveChildPids());
    // a git that stays alive (it waits for its alias' shell) and is registered as our child
    const running = spawnTracked(['git', '-c', 'alias.mdsync-wait=!sleep 30', 'mdsync-wait'],
      { cwd: dir, env: { ...process.env }, timeoutMs: 30_000 });
    const pid = [...liveChildPids()].find((p) => !before.has(p));
    expect(pid).toBeDefined();
    groups.add(pid!);
    try {
      const visible = await waitForPid(dir, pid!, 'present', { exclude: new Set() });
      expect(visible.kind === 'scanned' && visible.pids.includes(pid!)).toBe(true);
      const dflt = await liveGitIn(dir);
      expect(dflt.kind).toBe('scanned');
      expect(dflt.kind === 'scanned' && dflt.pids.includes(pid!)).toBe(false);
      const explicit = await liveGitIn(dir, { exclude: new Set([pid!]) });
      expect(explicit.kind === 'scanned' && explicit.pids.includes(pid!)).toBe(false);
    } finally {
      process.kill(-pid!, 'SIGTERM');
      await running;
    }
  });

  test('an empty repo with no git running scans to no pids', async () => {
    const dir = newRepo();
    expect(await liveGitIn(dir)).toEqual({ kind: 'scanned', pids: [], visibility: pidVisibility() });
  });
});
