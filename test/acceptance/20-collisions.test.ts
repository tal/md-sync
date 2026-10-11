// Incoming-path collisions and replay clashes.
import { afterEach, expect, test } from 'bun:test';
import {
  is, CONFLICT_COPY_RE, cleanupAll, cloneRemote, createRemote, expectNoMdsyncArtifacts, fakeNtfy, remoteNotifier,
  setupTestEnv, startDaemon, type Clone, type LogLine, type Remote, type TestEnv,
} from '../harness';

afterEach(cleanupAll);

const CONFLICT_SUBJECT = /^sync \S+ \S+Z \(conflict\)$/;
const inCopy = (p: string): boolean => p.split('/').some((seg) => CONFLICT_COPY_RE.test(seg));
const userPathsOf = (known: string[]) => (p: string): boolean => known.includes(p) || inCopy(p);

// A daemon with ntfy, so a remote push arrives as a pull-only run (a flush would commit the local files first).
async function pullScene(name: string, o: { files?: Record<string, string>; ignore?: string[] } = {}) {
  const t = await setupTestEnv(name);
  const r = await createRemote(t, o.files === undefined ? undefined : { files: o.files });
  const n = await fakeNtfy();
  remoteNotifier(r, n);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, {
    name: 'A', dir: a.dir, remote: r, ntfy: n, config: o.ignore === undefined ? {} : { ignore: o.ignore },
  });
  return { t, r, a, A };
}

// A cloud agent's push, force-adding paths the repo's .gitignore covers.
async function forcePush(t: TestEnv, r: Remote, files: Record<string, string>, message: string): Promise<string> {
  const h = await cloneRemote(t, r, `pusher-${Date.now()}`);
  for (const [rel, content] of Object.entries(files)) await h.write(rel, content);
  for (const args of [['add', '-f', '-A'], ['commit', '-q', '-m', message], ['push', '-q', 'origin', 'HEAD:refs/heads/main']]) {
    const res = await h.git(args);
    if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  }
  return (await h.git(['rev-parse', 'HEAD'])).stdout.trim();
}

async function copyOf(c: Clone, prefix: string): Promise<string> {
  const found = (await c.files()).filter((p) => p.startsWith(prefix) && inCopy(p));
  if (found.length !== 1) throw new Error(`expected one conflict copy starting with "${prefix}", found ${JSON.stringify(found)}`);
  return found[0] as string;
}

test('untracked, gitignored and ignore-matched local files at incoming paths', async () => {
  const { t, r, a, A } = await pullScene('collisions-untracked', {
    files: { 'README.md': '# notes\n', '.gitignore': 'secret*\n' }, ignore: ['drafts/**'],
  });
  await a.write('same.md', 'same\n');
  await a.write('diff.md', 'local diff\n');
  await a.write('secret-key.md', 'local secret\n');
  await a.write('drafts/d.md', 'local draft\n');

  const m = A.mark();
  const incoming = await forcePush(t, r, {
    'same.md': 'same\n', 'diff.md': 'remote diff\n', 'secret-key.md': 'remote secret\n', 'drafts/d.md': 'remote draft\n',
  }, 'incoming');
  const done = await A.waitForSync({ since: m, reason: 'ntfy' });
  expect(done).toMatchObject({ kind: 'pull-only', outcome: 'conflict-resolved', commitsOut: 1 });

  const collisions = A.logs.slice(m).filter(is('collision'));
  const about = (p: string): LogLine | undefined => collisions.find((l) => l.incoming === p);
  expect(about('same.md')).toMatchObject({ action: 'kept-identical' });   // kept as it is, not removed
  expect(about('diff.md')).toMatchObject({ action: 'renamed', committable: 'commit' });
  expect(about('secret-key.md')).toMatchObject({ action: 'renamed', committable: 'local-only' });
  expect(about('drafts/d.md')).toMatchObject({ action: 'renamed', committable: 'local-only' });
  for (const p of ['diff.md', 'secret-key.md', 'drafts/d.md']) expect(String(about(p)?.copy)).toMatch(CONFLICT_COPY_RE);

  // Incoming versions at the paths; every local version kept; no copy for the identical file.
  expect(await a.read('same.md')).toBe('same\n');
  expect(await a.read('diff.md')).toBe('remote diff\n');
  expect(await a.read('secret-key.md')).toBe('remote secret\n');
  expect(await a.read('drafts/d.md')).toBe('remote draft\n');
  const diffCopy = await copyOf(a, 'diff (conflict ');
  const secretCopy = await copyOf(a, 'secret-key (conflict ');
  const draftCopy = await copyOf(a, 'drafts/d (conflict ');
  expect(await a.read(diffCopy)).toBe('local diff\n');
  expect(await a.read(secretCopy)).toBe('local secret\n');
  expect(await a.read(draftCopy)).toBe('local draft\n');
  expect((await a.files()).filter((p) => p.startsWith('same (conflict '))).toEqual([]);

  // Only the committable copy reaches the remote, in a commit holding nothing else.
  const tree = await r.tree();
  expect(tree).toContain(diffCopy);
  expect(tree).not.toContain(secretCopy);
  expect(tree).not.toContain(draftCopy);
  expect(await r.show(diffCopy)).toBe('local diff\n');
  const log = await r.log();
  expect(log[0]).toMatchObject({ authorName: 'mdsync-A', files: [diffCopy] });
  expect(log[0]?.subject).toMatch(CONFLICT_SUBJECT);
  expect(log[1]?.sha).toBe(incoming);
  expect(A.logs.slice(m).some(is('committed', { source: 'conflict' }))).toBe(true);
  expect(A.logs.slice(m).find(is('conflict', { kind: 'collision' }))?.copies).toContain(diffCopy);

  // The push made secret-key.md tracked; its copy was made while it was gitignored, so it stays local for good.
  expect((await A.flush(['--wait'])).code).toBe(0);
  expect(await r.tree()).not.toContain(secretCopy);
  expect(await a.read(secretCopy)).toBe('local secret\n');
  await expectNoMdsyncArtifacts(t, [a], r,
    userPathsOf(['README.md', '.gitignore', 'same.md', 'diff.md', 'secret-key.md', 'drafts/d.md']));
}, 120_000);

test.skipIf(process.platform !== 'darwin')('a case-only name clash on a case-insensitive filesystem', async () => {
  const { t, r, a, A } = await pullScene('collisions-case');
  await a.write('Case.md', 'local case\n');

  const m = A.mark();
  await r.push({ 'case.md': 'remote case\n' }, 'incoming case.md');
  const done = await A.waitForSync({ since: m, reason: 'ntfy' });
  expect(done.outcome).toBe('conflict-resolved');
  expect(A.logs.slice(m).find(is('collision', { incoming: 'case.md' }))).toMatchObject({ path: 'Case.md', action: 'renamed' });

  const files = await a.files();
  expect(files).toContain('case.md');
  expect(files).not.toContain('Case.md');
  expect(await a.read('case.md')).toBe('remote case\n');
  const copy = await copyOf(a, 'Case (conflict ');
  expect(await a.read(copy)).toBe('local case\n');
  const tree = await r.tree();
  expect(tree).toContain('case.md');
  expect(tree).not.toContain('Case.md');
  expect(await r.show(copy)).toBe('local case\n');
  await expectNoMdsyncArtifacts(t, [a], r, userPathsOf(['README.md', 'case.md']));
}, 120_000);

test('file vs directory at incoming paths, both ways', async () => {
  const { t, r, a, A } = await pullScene('collisions-file-dir');
  await a.write('topic', 'local topic file\n');        // a local file where a folder arrives
  await a.write('area/n.md', 'local area note\n');    // a local folder where a file arrives

  const m = A.mark();
  await r.push({ 'topic/x.md': 'remote topic note\n', area: 'remote area file\n' }, 'incoming file and folder');
  const done = await A.waitForSync({ since: m, reason: 'ntfy' });
  expect(done.outcome).toBe('conflict-resolved');
  const collisions = A.logs.slice(m).filter(is('collision'));
  expect(collisions.find((l) => l.incoming === 'topic/x.md')).toMatchObject({ path: 'topic', action: 'renamed' });
  expect(collisions.find((l) => l.incoming === 'area')).toMatchObject({ path: 'area', action: 'moved-folder' });   // moves whole

  expect(await a.read('topic/x.md')).toBe('remote topic note\n');
  expect(await a.read('area')).toBe('remote area file\n');
  const topicCopy = await copyOf(a, 'topic (conflict ');
  expect(topicCopy.includes('/')).toBe(false);
  expect(await a.read(topicCopy)).toBe('local topic file\n');
  const areaCopy = await copyOf(a, 'area (conflict ');
  expect(areaCopy).toMatch(/^area \(conflict [^/]+\)\/n\.md$/);
  expect(await a.read(areaCopy)).toBe('local area note\n');
  expect(await r.show(topicCopy)).toBe('local topic file\n');
  await expectNoMdsyncArtifacts(t, [a], r, userPathsOf(['README.md', 'topic/x.md', 'area']));
}, 120_000);

test('a folder that replaced a tracked file survives a pull-only run (probe e11)', async () => {
  const { t, r, a, A } = await pullScene('collisions-folder-replaces-file', {
    files: { 'README.md': '# notes\n', projects: 'old project list\n' },
  });
  await a.remove('projects');
  await a.write('projects/alpha.md', 'alpha note\n');
  await a.write('projects/beta.md', 'beta note\n');

  const m = A.mark();
  await r.push({ 'other.md': 'unrelated\n' }, 'unrelated incoming');
  const done = await A.waitForSync({ since: m, reason: 'ntfy' });
  expect(['ok', 'conflict-resolved']).toContain(String(done.outcome));
  expect(await a.read('other.md')).toBe('unrelated\n');

  // In place, or (if a file came back at `projects`) under a conflict-copy folder: never lost.
  const files = await a.files();
  for (const [name, content] of [['alpha.md', 'alpha note\n'], ['beta.md', 'beta note\n']] as const) {
    const where = files.filter((p) => p === `projects/${name}` || (p.endsWith(`/${name}`) && inCopy(p)));
    expect({ name, found: where.length > 0 }).toEqual({ name, found: true });
    for (const p of where) expect(await a.read(p)).toBe(content);
  }
  expect(await a.stashList()).toEqual([]);
  expect((await a.git(['ls-files', '-u'])).stdout).toBe('');
  expect((await r.log()).filter((c) => c.authorName === 'mdsync-A')).toEqual([]);
  await expectNoMdsyncArtifacts(t, [a], r, userPathsOf(['README.md', 'projects', 'projects/alpha.md', 'projects/beta.md', 'other.md']));
}, 120_000);

test('replay file/dir clash: a local file `d` vs a pushed `d/x.md` (probe e1b)', async () => {
  const t = await setupTestEnv('collisions-replay-file-dir');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const b = await cloneRemote(t, r, 'B');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });
  const B = await startDaemon(t, { name: 'B', dir: b.dir, remote: r });

  await b.write('d/x.md', 'B note\n');
  expect((await B.flush(['--wait'])).code).toBe(0);
  await a.write('d', 'A file\n');
  const m = A.mark();
  const fa = await A.flush(['--wait']);
  expect({ code: fa.code, stderr: fa.stderr }).toEqual({ code: 0, stderr: fa.stderr });
  expect((await A.waitForSync({ since: m, reason: 'flush' })).outcome).toBe('conflict-resolved');
  expect(A.logs.slice(m).find(is('conflict', { kind: 'rebase' }))?.copies).toHaveLength(1);

  expect(await r.show('d/x.md')).toBe('B note\n');
  const tree = await r.tree();
  const copies = tree.filter((p) => CONFLICT_COPY_RE.test(p));
  expect(copies).toHaveLength(1);
  const copy = copies[0] as string;
  expect(copy.startsWith('d (conflict ')).toBe(true);
  expect(await r.show(copy)).toBe('A file\n');

  // Nothing deleted on either device.
  expect(await a.read('d/x.md')).toBe('B note\n');
  expect(await a.read(copy)).toBe('A file\n');
  expect((await B.flush(['--wait'])).code).toBe(0);
  expect(await b.read('d/x.md')).toBe('B note\n');
  expect(await b.read(copy)).toBe('A file\n');
  await expectNoMdsyncArtifacts(t, [a, b], r, userPathsOf(['README.md', 'd/x.md']));
}, 120_000);

test.skipIf(process.platform !== 'darwin')('committed case-only add/add goes through the replay (probe e4)', async () => {
  const t = await setupTestEnv('collisions-case-add-add');
  const r = await createRemote(t);
  const a = await cloneRemote(t, r, 'A');
  const A = await startDaemon(t, { name: 'A', dir: a.dir, remote: r });

  await r.push({ 'notes.md': 'B notes\n' }, 'B adds notes.md');
  await a.write('Notes.md', 'A notes\n');
  const m = A.mark();
  const f = await A.flush(['--wait']);
  expect({ code: f.code, stderr: f.stderr }).toEqual({ code: 0, stderr: f.stderr });
  const clash = A.logs.slice(m).find(is('case collision', { action: 'replay' }));
  expect(clash?.paths).toContain('Notes.md');
  expect((await A.waitForSync({ since: m, reason: 'flush' })).outcome).toBe('conflict-resolved');

  const tree = await r.tree();
  expect(tree).toContain('notes.md');
  expect(tree).not.toContain('Notes.md');
  expect(await r.show('notes.md')).toBe('B notes\n');
  const copies = tree.filter((p) => CONFLICT_COPY_RE.test(p));
  expect(copies).toHaveLength(1);
  expect(await r.show(copies[0] as string)).toBe('A notes\n');
  expect(await a.read('notes.md')).toBe('B notes\n');
  expect(await a.read(copies[0] as string)).toBe('A notes\n');
  await expectNoMdsyncArtifacts(t, [a], r, userPathsOf(['README.md', 'notes.md']));
}, 120_000);
