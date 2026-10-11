// Acceptance 15: continuous writes with no flush are still committed once maxWaitMs passes.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  is, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, startDaemon, waitFor, type CommitInfo,
  type LogLine,
} from '../harness';

afterEach(cleanupAll);

const at = (l: LogLine): number => Date.parse(l.ts);
const reasonsOf = (l: LogLine): unknown[] => (Array.isArray(l.reasons) ? l.reasons : []);

test('continuous new-file writes are committed by max-wait while the writes continue', async () => {
  const t = await setupTestEnv('max-wait');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 5000, maxWaitMs: 2000 } });
  const m = A.mark();

  // A new file every 300 ms for 6 s: one file rewritten nonstop never settles under awaitWriteFinish.
  let writer: 'writing' | 'stopped' = 'writing';
  const written: string[] = [];
  const writes = (async () => {
    const end = Date.now() + 6_000;
    for (let i = 0; Date.now() < end; i++) {
      await a.write(`w${i}.md`, `write ${i}\n`);
      written.push(`w${i}.md`);
      await Bun.sleep(300);
    }
    writer = 'stopped';
  })();

  try {
    const fired = await A.waitForLog(is('backup timer fired', { timer: 'max-wait' }), { since: m, timeoutMs: 20_000 });
    const writerAtFire = writer;
    expect(writerAtFire).toBe('writing');
    expect(A.logs.slice(m, A.logs.indexOf(fired)).some(is('backup timer fired', { timer: 'idle' }))).toBe(false);

    const committed = await A.waitForLog(is('committed', { source: 'backup' }), { since: A.logs.indexOf(fired) });
    expect(String(committed.subject)).toMatch(/ \(auto\)$/);
    await waitFor(async () => (await r.log()).some((c) => c.sha === committed.sha),
      { timeoutMs: 20_000, label: 'max-wait commit on the remote' });
    const writerAtLanding = writer;
    expect(writerAtLanding).toBe('writing');
  } finally {
    await writes;
  }

  // Everything written ends up on the remote, and every daemon commit is a backup commit.
  await waitFor(async () => {
    const tree = await r.tree();
    return written.every((w) => tree.includes(w));
  }, { timeoutMs: 30_000, label: 'all written files on the remote' });
  const mine = (await r.log()).filter((c) => c.authorName === 'mdsync-A');
  expect(mine.length).toBeGreaterThanOrEqual(2);
  for (const c of mine) expect(c.subject).toMatch(/^sync \S+ \S+Z \(auto\)$/);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => p === 'README.md' || /^w\d+\.md$/.test(p));
}, 90_000);

// One file appended to every 200 ms never settles under awaitWriteFinish (500 ms); raw fs activity still arms the
// timers at the first write, so max-wait commits it while the appends go on.
test('a single file written nonstop is committed by max-wait while the writes continue', async () => {
  const t = await setupTestEnv('max-wait-append');
  const r = await createRemote(t, { files: { 'log.md': 'start\n' } });
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 5000, maxWaitMs: 2000 } });
  await A.waitForSync({ reason: 'startup' });
  const m = A.mark();

  let writer: 'writing' | 'stopped' = 'writing';
  const writes = (async () => {
    const end = Date.now() + 12_000;
    for (let i = 0; Date.now() < end && writer === 'writing'; i++) {
      appendFileSync(join(a.dir, 'log.md'), `line ${i}\n`);   // in place, like a log writer
      await Bun.sleep(200);
    }
    writer = 'stopped';
  })();
  try {
    // the watcher reports the file while it is still being written (not only once it settles)
    await A.waitForLog(is('local change'), { since: m, timeoutMs: 20_000 });
    const writerAtChange = writer;
    expect(writerAtChange).toBe('writing');
    const fired = await A.waitForLog(is('backup timer fired', { timer: 'max-wait' }), { since: m, timeoutMs: 20_000 });
    const writerAtFire = writer;
    expect(writerAtFire).toBe('writing');
    const committed = await A.waitForLog(is('committed', { source: 'backup' }), { since: A.logs.indexOf(fired) });
    await waitFor(async () => (await r.log()).some((c) => c.sha === committed.sha),
      { timeoutMs: 20_000, label: 'max-wait commit on the remote' });
    const writerAtLanding = writer;
    expect(writerAtLanding).toBe('writing');
    expect(((await r.show('log.md')) ?? '').split('\n').length).toBeGreaterThan(2);
  } finally {
    writer = 'stopped';
    await writes;
  }
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'log.md'].includes(p));
}, 90_000);

// Variant: an agent flushing only its own path keeps committing, and max-wait still commits a file nobody flushes.
// Flushes use --wait so a flush trigger never merges with the max-wait trigger (a merged run gets no "(auto)").
test('path-limited flushes do not hold back max-wait for other dirty files', async () => {
  const t = await setupTestEnv('max-wait-paths');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 5000, maxWaitMs: 2000 } });
  const m = A.mark();

  const bWrittenAt = Date.now();
  await a.write('b.md', 'nobody flushes me\n');
  let landed: CommitInfo | undefined;
  let landedAt = 0;
  const deadline = Date.now() + 20_000;
  for (let i = 0; landed === undefined && Date.now() < deadline; i++) {
    await a.write('a.md', `agent write ${i}\n`);
    const f = await A.flush(['a.md', '-m', `a ${i}`, '--wait']);
    expect({ code: f.code, stderr: f.stderr }).toEqual({ code: 0, stderr: f.stderr });
    landed = (await r.log()).find((c) => c.files.includes('b.md'));
    landedAt = Date.now();
    if (landed === undefined) await Bun.sleep(500);
  }
  if (landed === undefined) throw new Error('b.md never reached the remote while the path-limited flushes ran');

  expect(landed.subject).toMatch(/^sync \S+ \S+Z \(auto\)$/);
  expect(landed.files).toContain('b.md');
  // a.md too, if max-wait fired between an a.md write and its flush.
  expect(landed.files.filter((f) => f !== 'b.md' && f !== 'a.md')).toEqual([]);
  // The anchor (firstDirtyAt) is the first arm after the write: a `local change`, or the post-run check of a flush
  // run that saw b.md dirty first. Both log `backup timers armed`. Doc says "within ~2.5 s of its write"; the watcher
  // adds awaitWriteFinish (500 ms) + batching (250 ms) before a `local change`, so the write bound is looser.
  const armed = A.logs.slice(m).find(is('backup timers armed'));
  const fired = A.logs.slice(m).find(is('backup timer fired', { timer: 'max-wait' }));
  if (armed === undefined || fired === undefined) throw new Error('missing `backup timers armed` / max-wait fire');
  expect(at(fired) - at(armed)).toBeGreaterThanOrEqual(2000 - 50);
  expect(at(fired) - at(armed)).toBeLessThan(2000 + 1500);
  expect(landedAt - bWrittenAt).toBeLessThan(8_000);
  expect(A.logs.slice(m, A.logs.indexOf(fired)).some(is('backup timer fired', { timer: 'idle' }))).toBe(false);

  // At least one path-limited commit run happened while b.md was dirty, before max-wait fired.
  const between = A.logs.slice(A.logs.indexOf(armed), A.logs.indexOf(fired));
  expect(between.some((l) => l.msg === 'sync done' && reasonsOf(l).includes('flush') && l.commitStep === 'committed')).toBe(true);

  // The flush commits hold only a.md.
  const flushCommits = (await r.log()).filter((c) => /^a \d+$/.test(c.subject));
  expect(flushCommits.length).toBeGreaterThanOrEqual(1);
  for (const c of flushCommits) expect(c.files).toEqual(['a.md']);
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['README.md', 'a.md', 'b.md'].includes(p));
}, 90_000);
