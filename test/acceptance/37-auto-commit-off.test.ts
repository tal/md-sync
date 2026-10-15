// Acceptance 37: with `autoCommit: "off"` the daemon still pulls but never commits on its own. Local changes arm no
// backup timer, a remote push is pulled with the edit left uncommitted, `flush` commits it, and SIGTERM leaves pending
// edits uncommitted (pushing only commits that already exist). A reload switches the mode live.
import { afterEach, expect, test } from 'bun:test';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier, runCli, setupTestEnv,
  startDaemon, type Daemon,
} from '../harness';

afterEach(cleanupAll);

// Longer than both backup timers below (and two poll intervals), so a timer that was armed would have fired.
const PAST_TIMERS_MS = 4_000;
const SHORT_TIMERS = { idleMs: 1_000, maxWaitMs: 2_000 };

function autoActivity(d: Daemon, since: number): string[] {
  return d.logs.slice(since).filter((l) => is('backup timer fired')(l) || is('backup timers armed')(l) || is('committed')(l))
    .map((l) => l.msg);
}

async function rewriteConfig(d: Daemon, patch: Record<string, unknown>): Promise<void> {
  const cfg = (await Bun.file(d.configPath).json()) as Record<string, unknown>;
  await Bun.write(d.configPath, `${JSON.stringify({ ...cfg, ...patch }, null, 2)}\n`);
}

test('no backup commit; a remote push is pulled with the edit uncommitted; flush commits; SIGTERM commits nothing', async () => {
  const t = await setupTestEnv('auto-commit-off');
  const r = await createRemote(t, { files: { 'README.md': '# notes\n', 'notes.md': 'n\n' } });
  const n = await fakeNtfy();
  remoteNotifier(r, n);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, ntfy: n, config: { ...SHORT_TIMERS, autoCommit: 'off' } });
  const seed = await r.head();

  // 1. A local edit past both timers: nothing is armed, fired or committed.
  const m = A.mark();
  await a.write('notes.md', 'n\nlocal edit\n');
  await a.write('new.md', 'brand new\n');
  await A.waitForLog(is('local change'), { since: m });
  await Bun.sleep(PAST_TIMERS_MS);   // a negative: there is no log line to wait for
  expect(autoActivity(A, m)).toEqual([]);
  expect((await a.porcelain()).sort()).toEqual([' M notes.md', '?? new.md']);
  expect(await r.head()).toBe(seed);

  // status reports the mode and the pending changes
  const st = await runCli(t, ['status', '--dir', a.dir, '--format', 'json']);
  expect(st.code).toBe(0);
  const json = JSON.parse(st.stdout) as { autoCommit: unknown; pending: { path: string }[] };
  expect(json.autoCommit).toBe('off');
  expect(json.pending.map((e) => e.path).sort()).toEqual(['new.md', 'notes.md']);
  const text = await runCli(t, ['status', '--dir', a.dir]);
  expect(text.stdout).toContain('auto commit: off');

  // 2. A remote push is pulled; the local edits stay uncommitted.
  const m2 = A.mark();
  const pushed = await r.push({ 'remote.md': 'r\n' }, 'remote edit');
  await A.waitForLog(is('ntfy event', { sha: pushed }), { since: m2 });
  expect(await A.waitForSync({ since: m2, reason: 'ntfy' }))
    .toMatchObject({ kind: 'pull-only', outcome: 'ok', commitsIn: 1, commitsOut: 0 });
  expect(await a.read('remote.md')).toBe('r\n');
  expect(await a.head()).toBe(pushed);
  expect((await a.porcelain()).sort()).toEqual([' M notes.md', '?? new.md']);
  expect(await a.read('notes.md')).toBe('n\nlocal edit\n');
  expect(autoActivity(A, m)).toEqual([]);

  // 3. flush commits them (not tagged auto) and pushes.
  const f = await A.flush(['--wait', '-m', 'by hand']);
  expect(f.code).toBe(0);
  const log = await r.log();
  expect(log[0]).toMatchObject({ subject: 'by hand', authorName: 'mdsync-A' });
  expect([...(log[0]?.files ?? [])].sort()).toEqual(['new.md', 'notes.md']);
  expect(log[1]?.sha).toBe(pushed);
  expect(await a.porcelain()).toEqual([]);

  // 4. SIGTERM with a pending edit: nothing is committed or pushed, the edit stays in the worktree.
  const m4 = A.mark();
  await a.write('later.md', 'pending at shutdown\n');
  await A.waitForLog(is('local change'), { since: m4 });
  const headBefore = await r.head();
  expect(await A.stop()).toBe(0);
  const after = A.logs.slice(m4);
  expect(after.some(is('changes left uncommitted', { changes: 1, reason: 'auto-commit-off' }))).toBe(true);
  expect(after.some(is('committed'))).toBe(false);
  expect(after.some((l) => l.msg === 'sync start' && l.mode === 'shutdown')).toBe(false);   // nothing to push either
  expect(after.some(is('shutdown complete', { exitCode: 0 }))).toBe(true);
  expect(await r.head()).toBe(headBefore);
  expect(await a.porcelain()).toEqual(['?? later.md']);
  expect(await a.read('later.md')).toBe('pending at shutdown\n');
  expect((await r.log()).filter((c) => c.subject.endsWith('(auto)'))).toEqual([]);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'notes.md', 'new.md', 'remote.md', 'later.md'].includes(p));
}, 120_000);

test('--auto-commit off: SIGTERM pushes a commit that is already made, and leaves the pending edit uncommitted', async () => {
  const t = await setupTestEnv('auto-commit-off-sigterm-ahead');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: SHORT_TIMERS, args: ['--auto-commit', 'off'] });

  await r.setUnreachable();
  await a.write('p.md', 'committed while offline\n');
  expect((await A.flush(['--wait'])).code).toBe(1);   // committed, push failed
  expect(await a.porcelain()).toEqual([]);
  await r.restore();
  const m = A.mark();
  await a.write('q.md', 'still pending\n');
  await A.waitForLog(is('local change'), { since: m });
  expect(await A.stop()).toBe(0);

  const after = A.logs.slice(m);
  const run = after.find((l) => l.msg === 'sync done' && l.mode === 'shutdown');
  expect(run).toMatchObject({ kind: 'pull-only', outcome: 'ok', commitStep: 'not-applicable', commitsOut: 1 });
  expect(after.some(is('committed'))).toBe(false);
  expect(after.some(is('changes left uncommitted', { changes: 1 }))).toBe(true);
  expect(await r.show('p.md')).toBe('committed while offline\n');
  expect(await r.head()).toBe(await a.head());
  expect(await r.show('q.md')).toBeUndefined();
  expect(await a.porcelain()).toEqual(['?? q.md']);
}, 120_000);

test('a reload to off cancels armed backup timers; back to timers arms them for what is pending', async () => {
  const t = await setupTestEnv('auto-commit-reload');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 3_000, maxWaitMs: 6_000 } });
  const seed = await r.head();

  const m = A.mark();
  await a.write('a.md', 'a\n');
  await A.waitForLog((l) => is('local change')(l) || is('backup timers armed')(l), { since: m });
  await rewriteConfig(A, { autoCommit: 'off' });
  A.signal('SIGHUP');
  const off = await A.waitForLog(is('config reloaded', { trigger: 'sighup' }), { since: m });
  expect(off.changed).toEqual(['autoCommit']);
  const m2 = A.mark();
  await Bun.sleep(6_000 + 1_000);   // past maxWaitMs from the first change: an armed timer would have fired
  expect(A.logs.slice(m).some(is('backup timer fired'))).toBe(false);
  expect(autoActivity(A, m2)).toEqual([]);
  expect(await r.head()).toBe(seed);
  expect(await a.porcelain()).toEqual(['?? a.md']);

  const m3 = A.mark();
  await rewriteConfig(A, { autoCommit: 'timers' });
  A.signal('SIGHUP');
  const on = await A.waitForLog(is('config reloaded', { trigger: 'sighup' }), { since: m3 });
  expect(on.changed).toEqual(['autoCommit']);
  await A.waitForLog(is('backup timer fired'), { since: m3, timeoutMs: 30_000 });
  const done = await A.waitForSync({ since: m3, outcome: 'ok' });
  expect(done).toMatchObject({ kind: 'commit', commitStep: 'committed', commitsOut: 1 });
  expect((await r.log())[0]).toMatchObject({ files: ['a.md'] });
  expect((await r.log())[0]?.subject).toMatch(/ \(auto\)$/);
  expect(await a.porcelain()).toEqual([]);
}, 120_000);
