// Paths that are one file on a case-insensitive filesystem but two in git (`unstageable` paths, S5):
// an NFD-named tracked file, two remote spellings that differ only in case, and a
// remote case-only rename. macOS (APFS) only; elsewhere the filesystem keeps them apart.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFLICT_COPY_RE, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, runCli, setupTestEnv, startDaemon,
  type Remote, type TestEnv,
} from '../harness';

afterEach(cleanupAll);

function caseInsensitiveFs(): boolean {
  const d = mkdtempSync(join(tmpdir(), 'mdsync-case-'));
  try {
    writeFileSync(join(d, 'X'), '');
    return existsSync(join(d, 'x'));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = caseInsensitiveFs();

const NFD = 'café.md';
const NFC = 'café.md';

// A commit made with plumbing, as a Linux device (or git with core.precomposeunicode=false) would: exact path
// spellings, no filesystem in between. `null` removes the path.
function rawPush(t: TestEnv, r: Remote, files: Record<string, string | null>, message: string): void {
  const index = join(t.root, `raw-${Math.random().toString(36).slice(2)}.index`);
  const env = { ...t.env, GIT_INDEX_FILE: index, GIT_DIR: r.path };
  const git = (args: string[], input?: string): string => {
    // precomposeunicode would turn an NFD argument into NFC on macOS: keep the spelling exactly as given
    const p = Bun.spawnSync(['git', '-c', 'core.precomposeunicode=false', ...args], { env, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input) });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  const parent = git(['rev-parse', 'refs/heads/main']);
  git(['read-tree', parent]);
  for (const [path, content] of Object.entries(files)) {
    if (content === null) git(['update-index', '-z', '--index-info'], `0 ${'0'.repeat(40)}\t${path}\0`);
    else git(['update-index', '--add', '--cacheinfo', `100644,${git(['hash-object', '-w', '--stdin'], content)},${path}`]);
  }
  const commit = git(['commit-tree', '-p', parent, '-m', message, git(['write-tree'])]);
  git(['update-ref', 'refs/heads/main', commit, parent]);
  rmSync(index, { force: true });
}

// `git show main:<path>` with the spelling exactly as given (the harness's remote.show would precompose it).
function showRaw(t: TestEnv, r: Remote, path: string): string | undefined {
  const p = Bun.spawnSync(['git', '-c', 'core.precomposeunicode=false', 'cat-file', 'blob', `refs/heads/main:${path}`],
    { env: { ...t.env, GIT_DIR: r.path } });
  return p.exitCode === 0 ? p.stdout.toString() : undefined;
}

const folded = (paths: string[], name: string): string[] =>
  paths.filter((p) => p.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase());

test.skipIf(!CASE_INSENSITIVE)('an NFD-named tracked file is never pushed again under its NFC spelling, and sync keeps working', async () => {
  const t = await setupTestEnv('nfd-alias');
  const r = await createRemote(t, { files: { 'other.md': 'hi\n' } });
  rawPush(t, r, { [NFD]: 'v0\n' }, 'an NFD name, as a Linux device commits it');
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });

  // git on macOS lists the NFD file as an untracked NFC name: nothing to commit, nothing pending
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(folded(await r.tree(), NFC)).toEqual([NFD]);
  const st = await runCli(t, ['status', '--dir', a.dir, '--format', 'json']);
  expect((JSON.parse(st.stdout) as { pending: unknown[] }).pending).toEqual([]);

  // an edit through either spelling lands in the one tracked entry
  await a.write(NFC, 'v1 from the mac\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(folded(await r.tree(), NFC)).toEqual([NFD]);
  expect(showRaw(t, r, NFD)).toBe('v1 from the mac\n');

  // and pulls still work (a stale second index entry made every later rebase fail)
  await r.push({ 'other.md': 'hi from B\n' }, 'b edits other');
  await a.write('mine.md', 'mine\n');
  const since = A.mark();
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await A.waitForSync({ since, reason: 'flush' })).toMatchObject({ outcome: 'ok' });
  expect(await a.read('other.md')).toBe('hi from B\n');
  expect(await r.show('mine.md')).toBe('mine\n');
  await expectNoMdsyncArtifacts(t, [a], r, (p) => ['other.md', 'mine.md', NFD, NFC].includes(p));
}, 180_000);

test.skipIf(!CASE_INSENSITIVE)('two remote spellings that differ only in case: the Mac still pulls and pushes', async () => {
  const t = await setupTestEnv('remote-case-dupes');
  const r = await createRemote(t, { files: { 'a.md': 'a0\n' } });
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  rawPush(t, r, { 'Case.md': 'upper\n', 'case.md': 'lower\n' }, 'two spellings from a case-sensitive device');
  expect((await A.flush(['--wait'])).code).toBe(0);   // fast-forward onto them

  await r.push({ 'a.md': 'a1\n' }, 'remote edits a.md');
  await a.write('new.md', 'new\n');
  const since = A.mark();
  const f = await A.flush(['--wait']);
  expect({ code: f.code, stderr: f.stderr.trim() }).toEqual({ code: 0, stderr: '' });
  const done = await A.waitForSync({ since, reason: 'flush' });
  expect(['ok', 'conflict-resolved']).toContain(done.outcome as string);
  expect(await a.read('a.md')).toBe('a1\n');
  expect(await r.show('new.md')).toBe('new\n');
  expect(await a.head()).toBe(await r.head());
  // both remote spellings are still there, untouched
  expect(await r.show('Case.md')).toBe('upper\n');
  expect(await r.show('case.md')).toBe('lower\n');
  // and nothing is pending forever (no backup timer re-arms for the phantom diff)
  const st = await runCli(t, ['status', '--dir', a.dir, '--format', 'json']);
  expect((JSON.parse(st.stdout) as { pending: unknown[] }).pending).toEqual([]);
}, 180_000);

test.skipIf(!CASE_INSENSITIVE)('case-only renames and adds: no spurious conflict copies with stale text', async () => {
  const t = await setupTestEnv('case-rescue');
  const r = await createRemote(t, { files: { 'Notes.md': 'old\n' } });
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });

  // a remote case-only rename plus an edit, with no local change to the file
  rawPush(t, r, { 'Notes.md': null, 'notes.md': 'new\n' }, 'rename to lower case');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await a.read('notes.md')).toBe('new\n');
  expect(await a.conflictCopies()).toEqual([]);
  expect((await r.tree()).filter((p) => CONFLICT_COPY_RE.test(p))).toEqual([]);

  // a local add that case-clashes with a remote add: exactly one copy, holding the local text
  await r.push({ 'todo.md': 'remote todo\n' }, 'another device adds todo.md');
  await a.write('Todo.md', 'mac Todo\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect((await A.flush(['--wait'])).code).toBe(0);   // a second run must not push extra copies left on disk
  const copies = (await r.tree()).filter((p) => CONFLICT_COPY_RE.test(p));
  expect(copies).toHaveLength(1);
  expect(await r.show(copies[0] ?? '')).toBe('mac Todo\n');
  expect(await r.show('todo.md')).toBe('remote todo\n');
  expect(await a.conflictCopies()).toEqual(copies);
  expect(await a.porcelain()).toEqual([]);
}, 180_000);

test.skipIf(!CASE_INSENSITIVE)('NFC and NFD spellings with different contents on the remote: a Mac with no edits never overwrites one with the other', async () => {
  // git rewrote the NFD exclude into NFC on argv, so `add -A` staged the NFD entry with the NFC file's bytes and the
  // first commit run pushed that to every device (r3).
  const t = await setupTestEnv('nfc-nfd-pair');
  const r = await createRemote(t, { files: { 'other.md': 'hi\n' } });
  rawPush(t, r, { [NFD]: 'nfd version\n', [NFC]: 'nfc version\n' }, 'both spellings');
  const before = await r.head();
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  expect((await A.flush(['--wait'])).code).toBe(0);
  await a.write('mine.md', 'mine\n');
  expect((await A.flush(['--wait'])).code).toBe(0);   // a commit run that does stage something
  expect(showRaw(t, r, NFD)).toBe('nfd version\n');
  expect(showRaw(t, r, NFC)).toBe('nfc version\n');
  expect(await r.head()).not.toBe(before);
  expect((await r.log()).filter((c) => c.authorName === 'mdsync-A').map((c) => c.files)).toEqual([['mine.md']]);
}, 180_000);

test.skipIf(!CASE_INSENSITIVE)('an NFD-tracked note: `flush --path` through either spelling commits it, and a watcher edit arms the backup timers', async () => {
  // Path-limited git calls named it in NFC (git precomposes argv), which matched no index entry: the flush exited 0
  // with nothing staged, and edits never armed the timers (r3).
  const t = await setupTestEnv('nfd-path');
  const r = await createRemote(t, { files: { 'other.md': 'hi\n' } });
  rawPush(t, r, { [NFD]: 'v0\n' }, 'nfd');
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r, config: { idleMs: 1_500, maxWaitMs: 60_000 } });

  await a.write(NFC, 'v1 via --path NFC\n');
  expect((await A.flush([join(a.dir, NFC), '--wait'])).code).toBe(0);
  expect(showRaw(t, r, NFD)).toBe('v1 via --path NFC\n');
  await a.write(NFD, 'v2 via --path NFD\n');
  expect((await A.flush([join(a.dir, NFD), '--wait'])).code).toBe(0);
  expect(showRaw(t, r, NFD)).toBe('v2 via --path NFD\n');

  const m = A.mark();
  await a.write(NFC, 'v3 by an agent\n');
  await A.waitForLog('backup timer fired', { since: m, timeoutMs: 20_000 });
  await A.waitForSync({ since: m, reason: 'idle', timeoutMs: 20_000 });
  expect(showRaw(t, r, NFD)).toBe('v3 by an agent\n');
  expect(folded(await r.tree(), NFC)).toEqual([NFD]);
}, 180_000);

test.skipIf(!CASE_INSENSITIVE)('remote case duplicates: a remote edit of one spelling never makes the Mac push a copy of the other', async () => {
  // One file on disk stands for both entries, so one always looks modified; the pre-conflict stash took that phantom
  // along and replayed it as a conflict copy of the other spelling's text, on every Mac, on every remote edit (r3).
  const t = await setupTestEnv('remote-case-dupes-edit');
  const r = await createRemote(t, { files: { 'a.md': 'a0\n' } });
  rawPush(t, r, { 'Case.md': 'upper\n', 'case.md': 'lower\n' }, 'two spellings');
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  rawPush(t, r, { 'Case.md': 'upper v2\n' }, 'edit Case.md');
  expect((await A.flush(['--wait'])).code).toBe(0);
  rawPush(t, r, { 'case.md': 'lower v2\n' }, 'edit case.md');
  await a.write('mine.md', 'mine\n');
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect((await r.tree()).filter((p) => CONFLICT_COPY_RE.test(p))).toEqual([]);
  expect(await a.conflictCopies()).toEqual([]);
  expect(await r.show('Case.md')).toBe('upper v2\n');
  expect(await r.show('case.md')).toBe('lower v2\n');
  expect(await r.show('mine.md')).toBe('mine\n');
}, 180_000);
