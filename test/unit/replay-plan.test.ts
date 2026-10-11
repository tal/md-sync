import { describe, expect, test } from 'bun:test';
import { conflictCopyPath, foldCase } from '../../src/conflict-name';
import type { TreeEntry } from '../../src/git';
import {
  buildPlan, changedTriples, dataGuard, finalMap, foldClashes, planOps,
} from '../../src/replay-plan';
import type { Disposition, Merger, NameCopy, PathTriple, Plan, PlanEnv, PlanEntry, Side } from '../../src/replay-plan';

// ---------- helpers ----------

const REG = '100644';
const EXE = '100755';
const LNK = '120000';
const GIT = '160000';
const A = 'absent' as const;

const s = (sha: string, mode = REG): Side => ({ mode, sha });
const te = (sha: string, mode = REG): TreeEntry => ({ mode, type: mode === GIT ? 'commit' : 'blob', sha });
function tree(o: Record<string, string | [mode: string, sha: string]>): Map<string, TreeEntry> {
  return new Map(Object.entries(o).map(([p, v]) => [p, typeof v === 'string' ? te(v) : te(v[1], v[0])]));
}
const tri = (path: string, base: Side, local: Side, remote: Side): PathTriple => ({ path, base, local, remote });

type MergeOut = Awaited<ReturnType<Merger>>;
function merger(out: MergeOut | ((t: PathTriple) => MergeOut)): { fn: Merger; calls: string[] } {
  const calls: string[] = [];
  const fn: Merger = async (t) => {
    calls.push(t.path);
    return typeof out === 'function' ? out(t) : out;
  };
  return { fn, calls };
}
const noMerge: Merger = async (t) => { throw new Error(`merger called for ${t.path}`); };

// Deliberately NOT memoized: buildPlan must memoize so one ancestor gets one copy dir.
function namer(fmt: (p: string, n: number) => string = (p) => `${p} (conflict)`): { fn: NameCopy; calls: string[] } {
  const calls: string[] = [];
  return { fn: (p) => { calls.push(p); return fmt(p, calls.length); }, calls };
}
const COPY = (p: string): string => `${p} (conflict)`;

function env(remote: Map<string, TreeEntry>, o: Partial<Omit<PlanEnv, 'remote'>> = {}): PlanEnv {
  return { remote, ignoreCase: o.ignoreCase ?? 'case-sensitive', blocked: o.blocked ?? (() => false),
    ...(o.nameLimit !== undefined ? { nameLimit: o.nameLimit } : {}) };
}

async function plan(triples: PathTriple[], e: PlanEnv, o: { merge?: Merger; nameCopy?: NameCopy } = {}): Promise<Plan> {
  return buildPlan(triples, o.merge ?? noMerge, o.nameCopy ?? COPY, e);
}
const dispositions = (p: Plan): Record<string, Disposition> =>
  Object.fromEntries(p.entries.map((e) => [e.triple.path, e.disposition]));

// Build the env.remote map that matches a triple list (paths not in triples come from `others`).
function remoteOf(triples: PathTriple[], others: Record<string, string> = {}): Map<string, TreeEntry> {
  const m = tree(others);
  for (const t of triples) if (t.remote !== A) m.set(t.path, te(t.remote.sha, t.remote.mode));
  return m;
}

async function planAndGuard(triples: PathTriple[], e: PlanEnv, o: { merge?: Merger; nameCopy?: NameCopy } = {}) {
  const p = await plan(triples, e, o);
  return { plan: p, guard: dataGuard(triples, p, e), final: finalMap(p, e.remote) };
}

// ---------- changedTriples ----------

describe('changedTriples', () => {
  test('every path where local != base (mode or sha), with the remote side, sorted', () => {
    const base = tree({ 'same.md': 'b1', 'mod.md': 'b2', 'del.md': 'b3', 'mode.sh': 'b4', 'z/remote-only.md': 'b5' });
    const local = tree({ 'same.md': 'b1', 'mod.md': 'l2', 'mode.sh': [EXE, 'b4'], 'add.md': 'l6', 'z/remote-only.md': 'b5' });
    const remote = tree({ 'same.md': 'r1', 'mod.md': 'r2', 'del.md': 'b3', 'z/remote-only.md': 'r5', 'add.md': 'r6' });
    expect(changedTriples(base, local, remote)).toEqual([
      tri('add.md', A, s('l6'), s('r6')),
      tri('del.md', s('b3'), A, s('b3')),
      tri('mod.md', s('b2'), s('l2'), s('r2')),
      tri('mode.sh', s('b4'), s('b4', EXE), A),
    ]);
  });

  test('sides carry only mode and sha', () => {
    const [t] = changedTriples(tree({}), tree({ x: 'l' }), tree({ x: 'r' }));
    expect(t?.local).toEqual({ mode: REG, sha: 'l' });
    expect(Object.keys(t?.remote as object).sort()).toEqual(['mode', 'sha']);
  });

  test('nothing changed locally -> no triples', () => {
    expect(changedTriples(tree({ a: '1' }), tree({ a: '1' }), tree({ a: '2', b: '3' }))).toEqual([]);
  });
});

// ---------- per-path rows ----------

describe('row 0: a gitlink both sides changed -> unsupported', () => {
  for (const [name, t] of [
    ['local', tri('sub', s('b'), s('l', GIT), s('r'))],
    ['remote', tri('sub', s('b'), s('l'), s('r', GIT))],
    ['base', tri('sub', s('b', GIT), s('l'), s('r', GIT))],
    ['local deleted a gitlink', tri('sub', s('b', GIT), A, s('r', GIT))],
  ] as const) {
    test(`gitlink on the ${name} side`, async () => {
      const e = env(remoteOf([t]));
      const p = await plan([t], e);
      expect(p.unsupported).toEqual(['sub']);
      expect(p.entries).toEqual([]);
      expect(dataGuard([t], p, e)).toEqual({ kind: 'fail', paths: ['sub'], reason: 'unsupported entry (gitlink)' });
    });
  }

  test('other paths are still planned', async () => {
    const ts = [tri('a.md', s('b'), s('l'), s('b')), tri('sub', A, s('c', GIT), s('d', GIT))];
    const p = await plan(ts, env(remoteOf(ts)));
    expect(p.unsupported).toEqual(['sub']);
    expect(dispositions(p)).toEqual({ 'a.md': { kind: 'take-local' } });
  });

  // An embedded repo `add -A` committed as a gitlink stopped every later conflict replay (data-guard-stop) when this
  // row came first, though the remote never touched it (r3).
  for (const [name, t, want] of [
    ['local-only gitlink add', tri('sub', A, s('c', GIT), A), 'take-local'],
    ['local gitlink update', tri('sub', s('b', GIT), s('l', GIT), s('b', GIT)), 'take-local'],
    ['local delete of a gitlink', tri('sub', s('b', GIT), A, s('b', GIT)), 'take-local'],
    ['remote-only gitlink change, local same', tri('sub', s('b', GIT), s('r', GIT), s('r', GIT)), 'same'],
  ] as const) {
    test(`a gitlink only one side changed follows rows 1-2: ${name}`, async () => {
      const { plan: p, guard } = await planAndGuard([t], env(remoteOf([t])));
      expect(p.unsupported).toEqual([]);
      expect(dispositions(p)).toEqual({ sub: { kind: want } });
      expect(guard).toEqual({ kind: 'pass' });
    });
  }
});

describe('row 1: remote unchanged -> take-local', () => {
  const cases: [string, PathTriple][] = [
    ['local edit', tri('a.md', s('b'), s('l'), s('b'))],
    ['local delete', tri('a.md', s('b'), A, s('b'))],
    ['local add', tri('a.md', A, s('l'), A)],
    ['local mode change', tri('a.sh', s('b'), s('b', EXE), s('b'))],
    ['local symlink edit (no merge needed)', tri('ln', s('b', LNK), s('l', LNK), s('b', LNK))],
  ];
  for (const [name, t] of cases) {
    test(name, async () => {
      const { plan: p, guard } = await planAndGuard([t], env(remoteOf([t])));
      expect(dispositions(p)).toEqual({ [t.path]: { kind: 'take-local' } });
      expect(guard).toEqual({ kind: 'pass' });
    });
  }
});

describe('row 2: remote changed, local == remote -> same', () => {
  const cases: [string, PathTriple][] = [
    ['both edited identically', tri('a.md', s('b'), s('x'), s('x'))],
    ['both deleted', tri('a.md', s('b'), A, A)],
    ['both added identically', tri('a.md', A, s('x'), s('x'))],
    ['both changed the mode', tri('a.sh', s('b'), s('b', EXE), s('b', EXE))],
  ];
  for (const [name, t] of cases) {
    test(name, async () => {
      const { plan: p, guard } = await planAndGuard([t], env(remoteOf([t])));
      expect(dispositions(p)).toEqual({ [t.path]: { kind: 'same' } });
      expect(planOps(p).ops).toEqual([]);
      expect(guard).toEqual({ kind: 'pass' });
    });
  }
});

describe('row 3: both present and different', () => {
  test('clean merge -> merged with the remote mode when local kept the mode', async () => {
    const t = tri('a.md', s('b'), s('l'), s('r'));
    const m = merger({ kind: 'clean', sha: 'm' });
    const { plan: p, guard } = await planAndGuard([t], env(remoteOf([t])), { merge: m.fn });
    expect(m.calls).toEqual(['a.md']);
    expect(dispositions(p)).toEqual({ 'a.md': { kind: 'merged', sha: 'm', mode: REG } });
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('clean merge keeps a local mode change', async () => {
    const t = tri('a.sh', s('b'), s('l', EXE), s('r'));
    const p = await plan([t], env(remoteOf([t])), { merge: merger({ kind: 'clean', sha: 'm' }).fn });
    expect(dispositions(p)).toEqual({ 'a.sh': { kind: 'merged', sha: 'm', mode: EXE } });
  });

  test('clean merge takes a remote mode change', async () => {
    const t = tri('a.sh', s('b'), s('l'), s('r', EXE));
    const p = await plan([t], env(remoteOf([t])), { merge: merger({ kind: 'clean', sha: 'm' }).fn });
    expect(dispositions(p)).toEqual({ 'a.sh': { kind: 'merged', sha: 'm', mode: EXE } });
  });

  test('clean add/add (no base) uses the remote mode', async () => {
    const t = tri('a.sh', A, s('x', EXE), s('x'));
    const p = await plan([t], env(remoteOf([t])), { merge: merger({ kind: 'clean', sha: 'x' }).fn });
    expect(dispositions(p)).toEqual({ 'a.sh': { kind: 'merged', sha: 'x', mode: REG } });
  });

  test('the merger gets the whole triple', async () => {
    const t = tri('a.md', s('b'), s('l'), s('r'));
    let seen: PathTriple | undefined;
    await plan([t], env(remoteOf([t])), { merge: async (x) => { seen = x; return { kind: 'clean', sha: 'm' }; } });
    expect(seen).toEqual(t);
  });

  for (const reason of ['content', 'binary', 'error'] as const) {
    test(`merge ${reason} -> conflict-copy reason ${reason}`, async () => {
      const t = tri('a.md', s('b'), s('l'), s('r'));
      const n = namer();
      const { plan: p, guard, final } = await planAndGuard([t], env(remoteOf([t])), { merge: merger({ kind: 'conflict', reason }).fn, nameCopy: n.fn });
      expect(dispositions(p)).toEqual({ 'a.md': { kind: 'conflict-copy', copyPath: 'a.md (conflict)', reason } });
      expect(p.copies).toEqual(['a.md (conflict)']);
      expect(n.calls).toEqual(['a.md']);
      expect(final.get('a.md')).toEqual(te('r'));
      expect(final.get('a.md (conflict)')).toEqual(te('l'));
      expect(guard).toEqual({ kind: 'pass' });
    });
  }

  test('add/add content conflict -> reason add-add', async () => {
    const t = tri('a.md', A, s('l'), s('r'));
    const p = await plan([t], env(remoteOf([t])), { merge: merger({ kind: 'conflict', reason: 'content' }).fn });
    expect(dispositions(p)['a.md']).toEqual({ kind: 'conflict-copy', copyPath: 'a.md (conflict)', reason: 'add-add' });
  });

  test('add/add binary or error keeps the merger reason', async () => {
    for (const reason of ['binary', 'error'] as const) {
      const t = tri('a.bin', A, s('l'), s('r'));
      const p = await plan([t], env(remoteOf([t])), { merge: merger({ kind: 'conflict', reason }).fn });
      expect(dispositions(p)['a.bin']).toEqual({ kind: 'conflict-copy', copyPath: 'a.bin (conflict)', reason });
    }
  });

  for (const [name, t] of [
    ['local symlink', tri('ln', s('b'), s('l', LNK), s('r'))],
    ['remote symlink', tri('ln', s('b'), s('l'), s('r', LNK))],
    ['both symlinks', tri('ln', s('b', LNK), s('l', LNK), s('r', LNK))],
    ['add/add symlink vs file', tri('ln', A, s('l', LNK), s('r'))],
  ] as const) {
    test(`${name} -> conflict-copy reason type, merger not called`, async () => {
      const { plan: p, guard, final } = await planAndGuard([t], env(remoteOf([t])));
      expect(dispositions(p)).toEqual({ ln: { kind: 'conflict-copy', copyPath: 'ln (conflict)', reason: 'type' } });
      expect(final.get('ln (conflict)')).toEqual(t.local === A ? undefined : te(t.local.sha, t.local.mode));
      expect(guard).toEqual({ kind: 'pass' });
    });
  }
});

describe('rows 4 and 5: edit vs delete', () => {
  test('row 4: local deleted, remote modified -> delete-overridden (remote kept)', async () => {
    const t = tri('x.md', s('b'), A, s('r'));
    const { plan: p, guard, final } = await planAndGuard([t], env(remoteOf([t])));
    expect(dispositions(p)).toEqual({ 'x.md': { kind: 'delete-overridden', deletedBy: 'local' } });
    expect(planOps(p).ops).toEqual([]);
    expect(final.get('x.md')).toEqual(te('r'));
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('row 5: local modified, remote deleted -> edit-restored (local written)', async () => {
    const t = tri('x.md', s('b'), s('l'), A);
    const { plan: p, guard, final } = await planAndGuard([t], env(remoteOf([t])));
    expect(dispositions(p)).toEqual({ 'x.md': { kind: 'edit-restored', deletedBy: 'remote' } });
    expect(planOps(p)).toEqual({ ops: [{ op: 'set', path: 'x.md', mode: REG, sha: 'l' }], writes: ['x.md'], deletes: [], copies: [] });
    expect(final.get('x.md')).toEqual(te('l'));
    expect(guard).toEqual({ kind: 'pass' });
  });
});

// ---------- clash pass ----------

describe('clash (a): a proper prefix of the set is a file in F', () => {
  test('remote added file d; local added d/x.md and d/y.md -> one copy dir for d', async () => {
    const ts = [tri('d/x.md', A, s('lx'), A), tri('d/y.md', A, s('ly'), A)];
    const n = namer((p, i) => `${p} (conflict ${i})`);
    const e = env(remoteOf(ts, { d: 'rd' }));
    const { plan: p, guard, final } = await planAndGuard(ts, e, { nameCopy: n.fn });
    expect(n.calls).toEqual(['d']);
    expect(dispositions(p)).toEqual({
      'd/x.md': { kind: 'conflict-copy', copyPath: 'd (conflict 1)/x.md', reason: 'path-clash' },
      'd/y.md': { kind: 'conflict-copy', copyPath: 'd (conflict 1)/y.md', reason: 'path-clash' },
    });
    expect(final.get('d')).toEqual(te('rd'));
    expect([...final.keys()].sort()).toEqual(['d', 'd (conflict 1)/x.md', 'd (conflict 1)/y.md']);
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('the outermost file prefix names the copy dir', async () => {
    const ts = [tri('a/b/c.md', A, s('l'), A)];
    const p = await plan(ts, env(remoteOf(ts, { a: 'ra' })));
    expect(dispositions(p)['a/b/c.md']).toEqual({ kind: 'conflict-copy', copyPath: 'a (conflict)/b/c.md', reason: 'path-clash' });
  });

  test('edit-restored under a file the remote created -> copy (remote deleted d/x, added file d)', async () => {
    const ts = [tri('d/x.md', s('b'), s('l'), A)];
    const e = env(remoteOf(ts, { d: 'rd' }));
    const { plan: p, guard, final } = await planAndGuard(ts, e);
    expect(dispositions(p)).toEqual({ 'd/x.md': { kind: 'conflict-copy', copyPath: 'd (conflict)/x.md', reason: 'path-clash' } });
    expect(final).toEqual(tree({ d: 'rd', 'd (conflict)/x.md': 'l' }));
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('local replaced file a with a dir, remote edited a -> a kept, a/x copied', async () => {
    const ts = [tri('a', s('b'), A, s('r')), tri('a/x.md', A, s('l'), A)];
    const { plan: p, guard } = await planAndGuard(ts, env(remoteOf(ts)));
    expect(dispositions(p)).toEqual({
      a: { kind: 'delete-overridden', deletedBy: 'local' },
      'a/x.md': { kind: 'conflict-copy', copyPath: 'a (conflict)/x.md', reason: 'path-clash' },
    });
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('no clash when the file at the prefix is removed by the plan', async () => {
    const ts = [tri('a', s('b'), A, s('b')), tri('a/x.md', A, s('l'), A)];
    const { plan: p, guard, final } = await planAndGuard(ts, env(remoteOf(ts)));
    expect(dispositions(p)).toEqual({ a: { kind: 'take-local' }, 'a/x.md': { kind: 'take-local' } });
    expect([...final.keys()]).toEqual(['a/x.md']);
    expect(guard).toEqual({ kind: 'pass' });
  });
});

describe('clash (b): F has a path under the set', () => {
  test('remote added d/x.md; local committed a file d -> d copied, remote d/x.md kept (probe e1b)', async () => {
    const ts = [tri('d', A, s('ld'), A)];
    const e = env(remoteOf(ts, { 'd/x.md': 'rx' }));
    const { plan: p, guard, final } = await planAndGuard(ts, e);
    expect(dispositions(p)).toEqual({ d: { kind: 'conflict-copy', copyPath: 'd (conflict)', reason: 'path-clash' } });
    expect(final).toEqual(tree({ 'd/x.md': 'rx', 'd (conflict)': 'ld' }));
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('edit-restored is converted when the remote turned the file into a dir', async () => {
    const ts = [tri('n', s('b'), s('l'), A)];
    const p = await plan(ts, env(remoteOf(ts, { 'n/inner.md': 'r' })));
    expect(dispositions(p)['n']).toEqual({ kind: 'conflict-copy', copyPath: 'n (conflict)', reason: 'path-clash' });
  });
});

describe('clash (c): case-only spellings (case-insensitive only)', () => {
  test('committed case-only add/add: local Notes.md vs remote notes.md -> local copied (probe e4)', async () => {
    const ts = [tri('Notes.md', A, s('l'), A)];
    const remote = remoteOf(ts, { 'notes.md': 'r' });
    const ci = await planAndGuard(ts, env(remote, { ignoreCase: 'case-insensitive' }));
    expect(dispositions(ci.plan)).toEqual({ 'Notes.md': { kind: 'conflict-copy', copyPath: 'Notes.md (conflict)', reason: 'case-clash' } });
    expect(ci.final.get('notes.md')).toEqual(te('r'));
    expect(ci.guard).toEqual({ kind: 'pass' });

    const cs = await planAndGuard(ts, env(remote, { ignoreCase: 'case-sensitive' }));
    expect(dispositions(cs.plan)).toEqual({ 'Notes.md': { kind: 'take-local' } });
    expect(cs.guard).toEqual({ kind: 'pass' });
  });

  test('local case-only rename with the remote unchanged is not a clash', async () => {
    const ts = [tri('Notes.md', A, s('b'), A), tri('notes.md', s('b'), A, s('b'))];
    const { plan: p, guard, final } = await planAndGuard(ts, env(remoteOf(ts), { ignoreCase: 'case-insensitive' }));
    expect(dispositions(p)).toEqual({ 'Notes.md': { kind: 'take-local' }, 'notes.md': { kind: 'take-local' } });
    expect([...final.keys()]).toEqual(['Notes.md']);
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('local case-only rename while the remote edited the old spelling -> delete overridden + copy', async () => {
    const ts = [tri('Notes.md', A, s('b'), A), tri('notes.md', s('b'), A, s('r'))];
    const { plan: p, guard } = await planAndGuard(ts, env(remoteOf(ts), { ignoreCase: 'case-insensitive' }));
    expect(dispositions(p)).toEqual({
      'Notes.md': { kind: 'conflict-copy', copyPath: 'Notes.md (conflict)', reason: 'case-clash' },
      'notes.md': { kind: 'delete-overridden', deletedBy: 'local' },
    });
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('the remote spelling keeps its local edit; only the new spelling moves', async () => {
    const ts = [tri('notes.md', s('b'), s('l'), s('b')), tri('NOTES.md', A, s('n'), A)];
    const { plan: p, guard } = await planAndGuard(ts, env(remoteOf(ts), { ignoreCase: 'case-insensitive' }));
    expect(dispositions(p)).toEqual({
      'notes.md': { kind: 'take-local' },
      'NOTES.md': { kind: 'conflict-copy', copyPath: 'NOTES.md (conflict)', reason: 'case-clash' },
    });
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('a remote-internal duplicate is tolerated (edit to one spelling stays in place)', async () => {
    const ts = [tri('A.md', s('b'), s('l'), s('b'))];
    const e = env(remoteOf(ts, { 'a.md': 'other' }), { ignoreCase: 'case-insensitive' });
    const { plan: p, guard } = await planAndGuard(ts, e);
    expect(dispositions(p)).toEqual({ 'A.md': { kind: 'take-local' } });
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('two new local spellings are both moved; copies are distinct', async () => {
    const ts = [tri('X.md', A, s('l1'), A), tri('x.md', A, s('l2'), A)];
    const chosen = new Set<string>();
    const nameCopy: NameCopy = (p) => {
      const c = conflictCopyPath(p, 'h', '2026-10-08 1234', (x) => chosen.has(foldCase(x)));
      chosen.add(foldCase(c));
      return c;
    };
    const { plan: p, guard } = await planAndGuard(ts, env(remoteOf(ts), { ignoreCase: 'case-insensitive' }), { nameCopy });
    expect(dispositions(p)).toEqual({
      'X.md': { kind: 'conflict-copy', copyPath: 'X (conflict h 2026-10-08 1234).md', reason: 'case-clash' },
      'x.md': { kind: 'conflict-copy', copyPath: 'x (conflict h 2026-10-08 1234 2).md', reason: 'case-clash' },
    });
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('NFD vs NFC spellings fold together', async () => {
    const ts = [tri('cafe\u0301.md', A, s('l'), A)];
    const p = await plan(ts, env(remoteOf(ts, { 'caf\u00e9.md': 'r' }), { ignoreCase: 'case-insensitive' }));
    expect(dispositions(p)['cafe\u0301.md']).toMatchObject({ kind: 'conflict-copy', reason: 'case-clash' });
  });

  test('folded file/dir clash: remote file Docs vs local docs/readme.md -> (a)', async () => {
    const ts = [tri('docs/readme.md', A, s('l'), A)];
    const remote = remoteOf(ts, { Docs: 'r' });
    const ci = await planAndGuard(ts, env(remote, { ignoreCase: 'case-insensitive' }));
    expect(dispositions(ci.plan)).toEqual({ 'docs/readme.md': { kind: 'conflict-copy', copyPath: 'docs (conflict)/readme.md', reason: 'path-clash' } });
    expect(ci.guard).toEqual({ kind: 'pass' });
    const cs = await plan(ts, env(remote));
    expect(dispositions(cs)).toEqual({ 'docs/readme.md': { kind: 'take-local' } });
  });

  test('folded file/dir clash: local file Docs vs remote docs/x.md -> (b)', async () => {
    const ts = [tri('Docs', A, s('l'), A)];
    const p = await plan(ts, env(remoteOf(ts, { 'docs/x.md': 'r' }), { ignoreCase: 'case-insensitive' }));
    expect(dispositions(p)).toEqual({ Docs: { kind: 'conflict-copy', copyPath: 'Docs (conflict)', reason: 'path-clash' } });
  });

  test('a remote-internal folded file/dir pair is tolerated', async () => {
    const ts = [tri('docs/x.md', s('b'), s('l'), s('b'))];
    const e = env(remoteOf(ts, { Docs: 'r' }), { ignoreCase: 'case-insensitive' });
    const { plan: p, guard } = await planAndGuard(ts, e);
    expect(dispositions(p)).toEqual({ 'docs/x.md': { kind: 'take-local' } });
    expect(guard).toEqual({ kind: 'pass' });
  });
});

describe('clash (d): on-disk obstruction', () => {
  test('a blocked set becomes a copy with reason blocked; only sets are asked, each path once', async () => {
    const ts = [
      tri('blocked.md', s('b'), s('l'), s('b')),
      tri('free.md', s('b'), s('l'), s('b')),
      tri('gone.md', s('b'), A, s('b')),
      tri('same.md', s('b'), s('x'), s('x')),
      tri('kept.md', s('b'), A, s('r')),
    ];
    const asked: string[] = [];
    const e = env(remoteOf(ts), { blocked: (p) => { asked.push(p); return p === 'blocked.md'; } });
    const { plan: p, guard } = await planAndGuard(ts, e);
    expect(dispositions(p)['blocked.md']).toEqual({ kind: 'conflict-copy', copyPath: 'blocked.md (conflict)', reason: 'blocked' });
    expect(dispositions(p)['free.md']).toEqual({ kind: 'take-local' });
    expect(asked.sort()).toEqual(['blocked.md', 'free.md']);
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('blocked applies to a merged path the remote has too', async () => {
    const ts = [tri('m.md', s('b'), s('l'), s('r'))];
    const p = await plan(ts, env(remoteOf(ts), { blocked: () => true }), { merge: merger({ kind: 'clean', sha: 'm' }).fn });
    expect(dispositions(p)['m.md']).toEqual({ kind: 'conflict-copy', copyPath: 'm.md (conflict)', reason: 'blocked' });
  });

  test('D/F rules win over blocked (checked first)', async () => {
    const ts = [tri('d', A, s('l'), A)];
    const p = await plan(ts, env(remoteOf(ts, { 'd/x': 'r' }), { blocked: () => true }));
    expect(dispositions(p)['d']).toMatchObject({ reason: 'path-clash' });
  });
});

describe('clash pass repeats', () => {
  test('second pass: a copy made in pass 1 is a file prefix of another set', async () => {
    // A naive namer picks "x (c)", which local already uses as a directory.
    const ts = [tri('x', A, s('lx'), A), tri('x (c)/y.md', A, s('ly'), A)];
    const n = namer((p) => `${p} (c)`);
    const e = env(remoteOf(ts, { 'x/z.md': 'rz' }));
    const { plan: p, guard, final } = await planAndGuard(ts, e, { nameCopy: n.fn });
    expect(dispositions(p)).toEqual({
      x: { kind: 'conflict-copy', copyPath: 'x (c)', reason: 'path-clash' },
      'x (c)/y.md': { kind: 'conflict-copy', copyPath: 'x (c) (c)/y.md', reason: 'path-clash' },
    });
    expect(n.calls).toEqual(['x', 'x (c)']);
    expect(final).toEqual(tree({ 'x/z.md': 'rz', 'x (c)': 'lx', 'x (c) (c)/y.md': 'ly' }));
    expect(guard).toEqual({ kind: 'pass' });
  });

  test('merges run once per path, not once per pass', async () => {
    const ts = [tri('m.md', s('b'), s('l'), s('r')), tri('x', A, s('lx'), A), tri('x (c)/y.md', A, s('ly'), A)];
    const m = merger({ kind: 'clean', sha: 'merged' });
    await plan(ts, env(remoteOf(ts, { 'x/z.md': 'rz' })), { merge: m.fn, nameCopy: (p) => `${p} (c)` });
    expect(m.calls).toEqual(['m.md']);
  });

  test('no clashes: nameCopy is never called', async () => {
    const ts = [tri('a.md', s('b'), s('l'), s('b')), tri('b.md', A, s('l'), A)];
    const n = namer();
    await plan(ts, env(remoteOf(ts)), { nameCopy: n.fn });
    expect(n.calls).toEqual([]);
  });
});

// ---------- planOps / finalMap / foldClashes ----------

describe('planOps', () => {
  test('maps every disposition to ops, writes, deletes and copies in entry order', () => {
    const entries: PlanEntry[] = [
      { triple: tri('add.md', A, s('l1'), A), disposition: { kind: 'take-local' } },
      { triple: tri('del.md', s('b'), A, s('b')), disposition: { kind: 'take-local' } },
      { triple: tri('m.md', s('b'), s('l'), s('r')), disposition: { kind: 'merged', sha: 'mm', mode: EXE } },
      { triple: tri('er.md', s('b'), s('l2'), A), disposition: { kind: 'edit-restored', deletedBy: 'remote' } },
      { triple: tri('c.md', s('b'), s('l3', LNK), s('r')), disposition: { kind: 'conflict-copy', copyPath: 'c (x).md', reason: 'type' } },
      { triple: tri('same.md', s('b'), s('x'), s('x')), disposition: { kind: 'same' } },
      { triple: tri('do.md', s('b'), A, s('r')), disposition: { kind: 'delete-overridden', deletedBy: 'local' } },
    ];
    expect(planOps({ entries, copies: ['c (x).md'], unsupported: [] })).toEqual({
      ops: [
        { op: 'set', path: 'add.md', mode: REG, sha: 'l1' },
        { op: 'remove', path: 'del.md' },
        { op: 'set', path: 'm.md', mode: EXE, sha: 'mm' },
        { op: 'set', path: 'er.md', mode: REG, sha: 'l2' },
        { op: 'set', path: 'c (x).md', mode: LNK, sha: 'l3' },
      ],
      writes: ['add.md', 'm.md', 'er.md', 'c (x).md'],
      deletes: ['del.md'],
      copies: ['c (x).md'],
    });
  });

  test('an impossible entry (copy with no local side) is a programmer error', () => {
    const entries: PlanEntry[] = [{ triple: tri('a', s('b'), A, s('r')), disposition: { kind: 'conflict-copy', copyPath: 'a (c)', reason: 'content' } }];
    expect(() => planOps({ entries, copies: ['a (c)'], unsupported: [] })).toThrow(/no local side/);
  });
});

describe('finalMap', () => {
  test('base − removes + sets, without mutating base; set types follow the mode', () => {
    const base = tree({ keep: 'k', gone: 'g', over: 'o' });
    const entries: PlanEntry[] = [
      { triple: tri('gone', s('g'), A, s('g')), disposition: { kind: 'take-local' } },
      { triple: tri('over', s('o'), s('n', EXE), s('o')), disposition: { kind: 'take-local' } },
      { triple: tri('new', A, s('l', LNK), A), disposition: { kind: 'take-local' } },
    ];
    const f = finalMap({ entries, copies: [], unsupported: [] }, base);
    expect(f).toEqual(new Map([['keep', te('k')], ['over', te('n', EXE)], ['new', te('l', LNK)]]));
    expect(base).toEqual(tree({ keep: 'k', gone: 'g', over: 'o' }));
  });
});

describe('foldClashes', () => {
  test('groups of two or more spellings per foldCase, sorted', () => {
    expect(foldClashes(['b.md', 'A.md', 'a.md', 'x/Y', 'x/y', 'X/y', 'solo'])).toEqual([
      ['A.md', 'a.md'],
      ['X/y', 'x/Y', 'x/y'],
    ]);
  });

  test('the same spelling twice is not a clash; NFC/NFD forms are', () => {
    expect(foldClashes(['a', 'a'])).toEqual([]);
    expect(foldClashes(['caf\u00e9', 'cafe\u0301'])).toEqual([['cafe\u0301', 'caf\u00e9']]);
  });
});

// ---------- data guard ----------

function entryOf(triple: PathTriple, disposition: Disposition): PlanEntry {
  return { triple, disposition };
}
function handPlan(entries: PlanEntry[], o: Partial<Plan> = {}): Plan {
  const copies = entries.flatMap((e) => (e.disposition.kind === 'conflict-copy' ? [e.disposition.copyPath] : []));
  return { entries, copies, unsupported: [], ...o };
}

describe('dataGuard', () => {
  test('passes an empty plan', () => {
    expect(dataGuard([], handPlan([]), env(tree({ a: '1' })))).toEqual({ kind: 'pass' });
  });

  test('passes a plan that exercises every disposition (conflict replay end to end, pure part)', async () => {
    const M = tree({ 'keep.md': 'k', 'note.md': 'n0', 'mergeable.md': 'm0', 'gone.md': 'g0', 'edited.md': 'e0', 'ld.md': 'd0', 'same.md': 's0' });
    const L = tree({ 'keep.md': 'k', 'note.md': 'nL', 'mergeable.md': 'mL', 'gone.md': 'g0', 'edited.md': 'eL', 'same.md': 'sX', d: 'dL', 'new.md': 'new' });
    const R = tree({ 'keep.md': 'k', 'note.md': 'nR', 'mergeable.md': 'mR', 'edited.md': 'e0', 'ld.md': 'dR', 'same.md': 'sX', 'd/x.md': 'rx', 'remote-new.md': 'rn' });
    // ld.md: local deleted, remote edited; gone.md: remote deleted, local untouched (not a triple)
    const triples = changedTriples(M, L, R);
    expect(triples.map((t) => t.path)).toEqual(['d', 'edited.md', 'ld.md', 'mergeable.md', 'new.md', 'note.md', 'same.md']);
    const e = env(R);
    const m = merger((t) => (t.path === 'mergeable.md' ? { kind: 'clean', sha: 'mM' } : { kind: 'conflict', reason: 'content' }));
    const p = await buildPlan(triples, m.fn, COPY, e);
    expect(dispositions(p)).toEqual({
      d: { kind: 'conflict-copy', copyPath: 'd (conflict)', reason: 'path-clash' },
      'edited.md': { kind: 'take-local' },
      'ld.md': { kind: 'delete-overridden', deletedBy: 'local' },
      'mergeable.md': { kind: 'merged', sha: 'mM', mode: REG },
      'new.md': { kind: 'take-local' },
      'note.md': { kind: 'conflict-copy', copyPath: 'note.md (conflict)', reason: 'content' },
      'same.md': { kind: 'same' },
    });
    expect(dataGuard(triples, p, e)).toEqual({ kind: 'pass' });
    expect(finalMap(p, R)).toEqual(tree({
      'keep.md': 'k', 'note.md': 'nR', 'mergeable.md': 'mM', 'edited.md': 'eL', 'ld.md': 'dR', 'same.md': 'sX',
      'd/x.md': 'rx', 'remote-new.md': 'rn', 'd (conflict)': 'dL', 'new.md': 'new', 'note.md (conflict)': 'nL',
    }));
  });

  test('fails: duplicate changed path', () => {
    const t = tri('a', s('b'), s('l'), s('b'));
    const r = dataGuard([t, t], handPlan([entryOf(t, { kind: 'take-local' })]), env(remoteOf([t])));
    expect(r).toEqual({ kind: 'fail', paths: ['a'], reason: 'duplicate changed path' });
  });

  test('fails: a triple with no entry, an extra entry, a duplicate entry, or an entry for a different triple', () => {
    const a = tri('a', s('b'), s('l'), s('b'));
    const b = tri('b', s('b'), s('l'), s('b'));
    const e = env(remoteOf([a, b]));
    const reason = 'plan does not cover every changed path exactly once';
    expect(dataGuard([a, b], handPlan([entryOf(a, { kind: 'take-local' })]), e)).toEqual({ kind: 'fail', paths: ['b'], reason });
    expect(dataGuard([a], handPlan([entryOf(a, { kind: 'take-local' }), entryOf(b, { kind: 'take-local' })]), e))
      .toEqual({ kind: 'fail', paths: ['b'], reason });
    expect(dataGuard([a], handPlan([entryOf(a, { kind: 'take-local' }), entryOf(a, { kind: 'take-local' })]), e))
      .toEqual({ kind: 'fail', paths: ['a'], reason });
    const stale = tri('a', s('b'), s('OTHER'), s('b'));
    expect(dataGuard([a], handPlan([entryOf(stale, { kind: 'take-local' })]), e)).toEqual({ kind: 'fail', paths: ['a'], reason });
  });

  test('fails: a triple whose remote side disagrees with env.remote', () => {
    const t = tri('x.md', s('b'), s('l'), A);   // claims the remote deleted it\u2026
    const e = env(tree({ 'x.md': 'r' }));       // \u2026but the remote has it
    const r = dataGuard([t], handPlan([entryOf(t, { kind: 'edit-restored', deletedBy: 'remote' })]), e);
    expect(r).toEqual({ kind: 'fail', paths: ['x.md'], reason: 'changed path does not match the remote tree' });
  });

  describe('remote-side loss', () => {
    test('take-local over a changed remote', () => {
      const t = tri('a.md', s('b'), s('l'), s('r'));
      const r = dataGuard([t], handPlan([entryOf(t, { kind: 'take-local' })]), env(remoteOf([t])));
      expect(r).toEqual({ kind: 'fail', paths: ['a.md'], reason: 'disposition does not account for both sides' });
    });

    test('a conflict copy written over a remote path', () => {
      const t = tri('a.md', s('b'), s('l'), s('r'));
      const plan = handPlan([entryOf(t, { kind: 'conflict-copy', copyPath: 'other.md', reason: 'content' })]);
      const r = dataGuard([t], plan, env(remoteOf([t], { 'other.md': 'o' })));
      expect(r).toEqual({ kind: 'fail', paths: ['other.md'], reason: 'conflict copy path is not unique or overwrites a changed or remote path' });
    });

    test('delete-overridden when the remote also deleted (nothing to keep)', () => {
      const t = tri('a.md', s('b'), A, A);
      const r = dataGuard([t], handPlan([entryOf(t, { kind: 'delete-overridden', deletedBy: 'local' })]), env(remoteOf([t])));
      expect(r).toMatchObject({ kind: 'fail', reason: 'disposition does not account for both sides' });
    });
  });

  describe('local-side accounting', () => {
    const cases: [string, PathTriple, Disposition][] = [
      ['same when local != remote', tri('a', s('b'), s('l'), s('r')), { kind: 'same' }],
      ['conflict-copy with no local side', tri('a', s('b'), A, s('r')), { kind: 'conflict-copy', copyPath: 'a (c)', reason: 'content' }],
      ['conflict-copy onto its own path', tri('a', s('b'), s('l'), s('r')), { kind: 'conflict-copy', copyPath: 'a', reason: 'content' }],
      ['merged with a symlink side', tri('a', s('b'), s('l', LNK), s('r')), { kind: 'merged', sha: 'm', mode: REG }],
      ['merged dropping a local mode change', tri('a', s('b'), s('l', EXE), s('r')), { kind: 'merged', sha: 'm', mode: REG }],
      ['merged with local deleted', tri('a', s('b'), A, s('r')), { kind: 'merged', sha: 'm', mode: REG }],
      ['delete-overridden with local present', tri('a', s('b'), s('l'), s('r')), { kind: 'delete-overridden', deletedBy: 'local' }],
      ['edit-restored with remote present', tri('a', s('b'), s('l'), s('r')), { kind: 'edit-restored', deletedBy: 'remote' }],
      ['edit-restored with local absent', tri('a', s('b'), A, A), { kind: 'edit-restored', deletedBy: 'remote' }],
    ];
    for (const [name, t, d] of cases) {
      test(name, () => {
        const r = dataGuard([t], handPlan([entryOf(t, d)]), env(remoteOf([t])));
        expect(r).toEqual({ kind: 'fail', paths: ['a'], reason: 'disposition does not account for both sides' });
      });
    }
  });

  describe('conflict copies', () => {
    test('two copies on one path', () => {
      const a = tri('a', s('b'), s('l1'), s('r1'));
      const b = tri('b', s('b'), s('l2'), s('r2'));
      const plan = handPlan([
        entryOf(a, { kind: 'conflict-copy', copyPath: 'c', reason: 'content' }),
        entryOf(b, { kind: 'conflict-copy', copyPath: 'c', reason: 'content' }),
      ]);
      expect(dataGuard([a, b], plan, env(remoteOf([a, b])))).toMatchObject({ kind: 'fail', paths: ['c'] });
    });

    test('a copy on another changed path', () => {
      const a = tri('a', s('b'), s('l1'), s('r1'));
      const b = tri('b', s('b'), A, s('b'));
      const plan = handPlan([entryOf(a, { kind: 'conflict-copy', copyPath: 'b', reason: 'content' }), entryOf(b, { kind: 'take-local' })]);
      expect(dataGuard([a, b], plan, env(remoteOf([a, b])))).toMatchObject({ kind: 'fail', paths: ['b'] });
    });

    test('plan.copies out of step with the entries', () => {
      const a = tri('a', s('b'), s('l1'), s('r1'));
      const plan = handPlan([entryOf(a, { kind: 'conflict-copy', copyPath: 'a (c)', reason: 'content' })], { copies: [] });
      expect(dataGuard([a], plan, env(remoteOf([a])))).toMatchObject({ kind: 'fail', reason: 'plan copies do not match its conflict-copy entries' });
    });
  });

  describe('representable', () => {
    test('a D/F clash in finalMap fails (a plan that skipped the clash pass)', () => {
      const t = tri('d', A, s('l'), A);
      const r = dataGuard([t], handPlan([entryOf(t, { kind: 'take-local' })]), env(remoteOf([t], { 'd/x.md': 'r' })));
      expect(r).toEqual({ kind: 'fail', paths: ['d', 'd/x.md'], reason: 'file/directory clash in the final tree' });
    });

    test('a copy that lands under a remote file fails', () => {
      const t = tri('a.md', s('b'), s('l'), s('r'));
      const plan = handPlan([entryOf(t, { kind: 'conflict-copy', copyPath: 'f/a.md', reason: 'content' })]);
      const r = dataGuard([t], plan, env(remoteOf([t], { f: 'file' })));
      expect(r).toEqual({ kind: 'fail', paths: ['f', 'f/a.md'], reason: 'file/directory clash in the final tree' });
    });

    test('case duplicates fail under case-insensitivity only', () => {
      const t = tri('Notes.md', A, s('l'), A);
      const plan = handPlan([entryOf(t, { kind: 'take-local' })]);
      const remote = remoteOf([t], { 'notes.md': 'r' });
      expect(dataGuard([t], plan, env(remote, { ignoreCase: 'case-insensitive' })))
        .toEqual({ kind: 'fail', paths: ['Notes.md', 'notes.md'], reason: 'case clash in the final tree' });
      expect(dataGuard([t], plan, env(remote))).toEqual({ kind: 'pass' });
    });

    test('the name limit is the local filesystem\'s: 90 Japanese characters are a legal Mac name (APFS counts UTF-16 units)', () => {
      // r3: the byte limit stopped every conflict replay on a Mac that held such a note, for good.
      const long = `${'日'.repeat(90)}.md`;   // 273 UTF-8 bytes, 93 UTF-16 units
      const t = tri(long, A, s('l'), A);
      const plan = handPlan([entryOf(t, { kind: 'take-local' })]);
      expect(dataGuard([t], plan, env(remoteOf([t]), { nameLimit: 'utf16-units' }))).toEqual({ kind: 'pass' });
      expect(dataGuard([t], plan, env(remoteOf([t]), { nameLimit: 'bytes' })))
        .toEqual({ kind: 'fail', paths: [long], reason: 'path segment longer than 255 bytes' });
      const huge = `${'日'.repeat(256)}.md`;
      const t2 = tri(huge, A, s('l'), A);
      expect(dataGuard([t2], handPlan([entryOf(t2, { kind: 'take-local' })]), env(remoteOf([t2]), { nameLimit: 'utf16-units' })))
        .toEqual({ kind: 'fail', paths: [huge], reason: 'path segment longer than 255 UTF-16 units' });
    });

    test('a copy name no filesystem can create (a segment over 255 bytes) fails before anything destructive', () => {
      const long = `${'a'.repeat(233)}.md`;
      const t = tri(long, s('b'), s('l'), s('r'));
      const copy = `${'a'.repeat(233)} (conflict Noctiluca 2026-10-08 0952).md`;
      const r = dataGuard([t], handPlan([entryOf(t, { kind: 'conflict-copy', copyPath: copy, reason: 'content' })]),
        env(remoteOf([t]), { nameLimit: 'bytes' }));
      expect(r).toEqual({ kind: 'fail', paths: [copy], reason: 'path segment longer than 255 bytes' });
      const fits = conflictCopyPath(long, 'Noctiluca', '2026-10-08 0952', () => false);
      expect(dataGuard([t], handPlan([entryOf(t, { kind: 'conflict-copy', copyPath: fits, reason: 'content' })]), env(remoteOf([t]))))
        .toEqual({ kind: 'pass' });
    });

    test('case duplicates that exist in the remote itself are tolerated', () => {
      const t = tri('b.md', A, s('l'), A);
      const remote = remoteOf([t], { 'A.md': '1', 'a.md': '2' });
      expect(dataGuard([t], handPlan([entryOf(t, { kind: 'take-local' })]), env(remote, { ignoreCase: 'case-insensitive' })))
        .toEqual({ kind: 'pass' });
    });

    test('a third local spelling joining a remote duplicate group fails', () => {
      const t = tri('a.MD', A, s('l'), A);
      const remote = remoteOf([t], { 'A.md': '1', 'a.md': '2' });
      expect(dataGuard([t], handPlan([entryOf(t, { kind: 'take-local' })]), env(remote, { ignoreCase: 'case-insensitive' })))
        .toEqual({ kind: 'fail', paths: ['A.md', 'a.MD', 'a.md'], reason: 'case clash in the final tree' });
    });

    test('a folded D/F clash introduced locally fails', () => {
      const t = tri('docs/readme.md', A, s('l'), A);
      const r = dataGuard([t], handPlan([entryOf(t, { kind: 'take-local' })]), env(remoteOf([t], { Docs: 'r' }), { ignoreCase: 'case-insensitive' }));
      expect(r).toEqual({ kind: 'fail', paths: ['Docs', 'docs/readme.md'], reason: 'file/directory case clash in the final tree' });
    });

    test('a folded copy colliding with a remote path fails', () => {
      const t = tri('a.md', s('b'), s('l'), s('r'));
      const plan = handPlan([entryOf(t, { kind: 'conflict-copy', copyPath: 'A.md', reason: 'content' })]);
      const r = dataGuard([t], plan, env(remoteOf([t]), { ignoreCase: 'case-insensitive' }));
      expect(r).toEqual({ kind: 'fail', paths: ['A.md', 'a.md'], reason: 'case clash in the final tree' });
    });
  });

  test('unsupported is reported before anything else', () => {
    const t = tri('sub', A, s('c', GIT), A);
    expect(dataGuard([t], handPlan([], { unsupported: ['sub'] }), env(tree({}))))
      .toEqual({ kind: 'fail', paths: ['sub'], reason: 'unsupported entry (gitlink)' });
  });
});

// ---------- end-to-end with the real naming function ----------

describe('buildPlan with conflict.ts-style naming', () => {
  test('copies avoid F, the triples and each other; the guard passes', async () => {
    const R = tree({ 'note.md': 'nR', 'note (conflict h 2026-10-08 1234).md': 'old copy', 'd/x.md': 'rx' });
    const L = tree({ 'note.md': 'nL', d: 'dL' });
    const M = tree({ 'note.md': 'n0' });
    const triples = changedTriples(M, L, R);
    const all = new Set([...R.keys(), ...L.keys()]);
    const chosen = new Set<string>();
    const nameCopy: NameCopy = (p) => {
      const c = conflictCopyPath(p, 'h', '2026-10-08 1234', (x) => chosen.has(x)
        || [...all].some((q) => q === x || q.startsWith(`${x}/`) || x.startsWith(`${q}/`)));
      chosen.add(c);
      return c;
    };
    const e = env(R);
    const p = await buildPlan(triples, merger({ kind: 'conflict', reason: 'content' }).fn, nameCopy, e);
    expect(p.copies).toEqual(['d (conflict h 2026-10-08 1234)', 'note (conflict h 2026-10-08 1234 2).md']);
    expect(dataGuard(triples, p, e)).toEqual({ kind: 'pass' });
    expect(planOps(p).writes).toEqual(p.copies);
  });
});
