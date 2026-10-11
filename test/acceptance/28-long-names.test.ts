// Conflict copies of long file names (NAME_MAX, R13): the copy name stays within 255 bytes,
// so the replay's `reset --hard` can create it, and nothing else in the worktree is lost along the way.
import { afterEach, expect, test } from 'bun:test';
import { CONFLICT_COPY_RE, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, setupTestEnv, startDaemon } from '../harness';

afterEach(cleanupAll);

const LONG = `${'a'.repeat(250)}.md`;   // 253 bytes: any conflict suffix makes the copy name too long uncut
const bytes = (s: string): number => new TextEncoder().encode(s).length;

test('a conflict on a 250-byte file name: the copy fits in 255 bytes, every edit survives, sync keeps working', async () => {
  const t = await setupTestEnv('long-names');
  const r = await createRemote(t, { files: { [LONG]: 'base\n', 'other.md': 'hi\n' } });
  const a = await cloneRemote(t, r, 'A');
  const b = await cloneRemote(t, r, 'B');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const B = await startDaemon(t, { name: 'B', dir: b.dir, remote: r });

  await a.write(LONG, 'A edit\n');
  expect((await A.flush(['--wait'])).code).toBe(0);

  await b.write(LONG, 'B edit\n');
  await b.write('other.md', 'hi\nB other edit\n');
  const since = B.mark();
  const b1 = await B.flush(['--wait']);
  expect({ code: b1.code, stderr: b1.stderr.trim() }).toEqual({ code: 0, stderr: '' });
  expect(await B.waitForSync({ since, reason: 'flush' })).toMatchObject({ outcome: 'conflict-resolved' });

  const copies = (await r.tree()).filter((p) => CONFLICT_COPY_RE.test(p));
  expect(copies).toHaveLength(1);
  const copy = copies[0] ?? '';
  expect(bytes(copy)).toBeLessThanOrEqual(255);
  expect(copy.startsWith('aaaa')).toBe(true);
  expect(await r.show(copy)).toBe('B edit\n');
  expect(await r.show(LONG)).toBe('A edit\n');
  expect(await r.show('other.md')).toBe('hi\nB other edit\n');
  expect(await b.read(copy)).toBe('B edit\n');
  expect(await b.read('other.md')).toBe('hi\nB other edit\n');
  expect(await b.porcelain()).toEqual([]);
  expect(await b.head()).toBe(await r.head());

  // and the next run is an ordinary one
  await b.write('later.md', 'later\n');
  const b2 = await B.flush(['--wait']);
  expect(b2.code).toBe(0);
  expect(await r.show('later.md')).toBe('later\n');
  await expectNoMdsyncArtifacts(t, [a, b], r, (p) => p === LONG || p === 'other.md' || p === 'later.md');
}, 120_000);

test.if(process.platform === 'darwin')('a long non-Latin note title that APFS allows (90 Japanese characters, 273 bytes) does not stop a conflict replay', async () => {
  // r3: the guard measured names in UTF-8 bytes; APFS counts UTF-16 units. Every replay on that Mac then stopped with
  // data-guard-stop until the note was pushed, which it never could be.
  const t = await setupTestEnv('long-cjk');
  const r = await createRemote(t, { files: { 'other.md': 'l1\nl2\nl3\n' } });
  const a = await cloneRemote(t, r, 'a');
  const B = await startDaemon(t, { name: 'B', dir: a.dir, remote: r });
  await r.push({ 'other.md': 'l1\nl2 remote\nl3\n' }, 'remote edit');
  const title = `${'日'.repeat(90)}.md`;
  await a.write(title, 'a long title\n');
  await a.write('other.md', 'l1\nl2 local\nl3\n');
  const f = await B.flush(['--wait']);
  expect({ code: f.code, stderr: f.stderr.trim() }).toEqual({ code: 0, stderr: '' });
  expect(await r.show(title)).toBe('a long title\n');
  expect(await r.show('other.md')).toBe('l1\nl2 remote\nl3\n');
  expect((await r.tree()).filter((p) => CONFLICT_COPY_RE.test(p))).toHaveLength(1);
}, 120_000);
