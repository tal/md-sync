// Seeded multi-device chaos (review round 4): three daemons on clones of one bare remote, small
// timers, a fake ntfy. A fixed seed drives random creates, appends, overwrites, atomic saves, deletes, renames,
// file/folder clashes, flushes, unreachable windows, SIGKILL/SIGTERM restarts and SIGHUPs; then everything quiesces
// and the invariants are checked. The op sequence is fixed by the seed; the timing is real, so the invariants are the
// ones that hold whatever the interleaving.
//   MDSYNC_CHAOS_SEEDS=1,2,3  MDSYNC_CHAOS_MS=300000  bun test test/acceptance/32-chaos.test.ts   (a longer hunt)
// The round-4 hunt (6 seeds x 300 s) found writes reverted by undoPartialCheckout and pushes that lost the remote
// ref race reported as `busy`; both are invariants here.
// D28 is closed: no git command writes the worktree any more, so there is no D28 window to excuse
// and every lost token fails the run (D28_MAX = 0; the d28Shape exemption is gone). The agent never touches mdsync's
// temp folders (`.mdsync-<pid>-<ms>.d`, excluded everywhere like `.git`): a write into one is not a user's write, and
// the old harness's writes there hid tokens (an overwritten aside counted as `removed`) and made 2 devices stuck.
// Chaos round 2 added a history invariant: a commit may delete a conflict copy only after its device's agent removed
// it. Lost tokens can't see a committed copy the move never wrote, since its snapshot stays in the copies commit.
import { afterEach, expect, test } from 'bun:test';
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { copyOrigins } from '../../src/conflict-name';
import {
  cleanupAll, type Clone, cloneRemote, createRemote, type Daemon, fakeNtfy, type FakeNtfy, type Remote,
  remoteNotifier, runCli, setupTestEnv, startDaemon, type TestEnv, waitFor,
} from '../harness';

afterEach(cleanupAll);

const SEEDS = (process.env.MDSYNC_CHAOS_SEEDS ?? '7').split(',').map(Number).filter((n) => Number.isInteger(n));
const CHAOS_MS = Number(process.env.MDSYNC_CHAOS_MS ?? 30_000);
const D28_MAX = 0;   // lost writes allowed per run: none
const TEMP_DIR_NAME_RE = /^\.mdsync-\d+-\d+\.d$/;   // a move's temp folder (src/cas.ts TEMP_DIR_RE, one segment)

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Dev = { name: 'A' | 'B' | 'C'; clone: Clone; daemon: Daemon; instances: Daemon[]; state: 'up' | 'down'; busy: 'idle' | 'lifecycle';
  intentional: Set<Daemon>; config: Record<string, unknown> };
type Written = { tok: string; dev: string; path: string; at: number };

async function chaos(seed: number): Promise<void> {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const between = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const t: TestEnv = await setupTestEnv(`chaos-${seed}`);
  const remote: Remote = await createRemote(t);
  const ntfy: FakeNtfy = await fakeNtfy();
  remoteNotifier(remote, ntfy);
  const problems: string[] = [];

  let tokSeq = 0;
  const TOKEN_RE = new RegExp(`tok-${seed}-\\d+`, 'g');
  const written = new Map<string, Written>();
  const removed = new Set<string>();
  const ops: string[] = [];   // every op, for the dump
  const renames: { path: string; to: string }[] = [];
  const removals: { dev: string; path: string; scope: 'file' | 'tree'; at: number }[] = [];   // an agent's delete, rename, rm -r
  const MARKERS_RE = /^(<<<<<<< |>>>>>>> |=======$)/m;
  const agentMarked = new Set<string>();   // paths an agent wrote from text that already held git's markers
  const rec = (dev: string, op: string, f: Record<string, unknown>): void => {
    ops.push(JSON.stringify({ ts: new Date().toISOString(), dev, op, ...f }));
  };
  const tokensIn = (s: string): string[] => [...new Set(s.match(TOKEN_RE) ?? [])];
  const newToken = (): string => `tok-${seed}-${++tokSeq}`;
  const readOr = (abs: string): string => { try { return readFileSync(abs, 'utf8'); } catch { return ''; } };
  const kindAt = (abs: string): 'file' | 'dir' | 'none' => {
    try { return lstatSync(abs).isDirectory() ? 'dir' : 'file'; } catch { return 'none'; }
  };
  const walk = (root: string, want: 'file' | 'dir'): string[] => {
    const out: string[] = [];
    const go = (abs: string, rel: string): void => {
      let es;
      try { es = readdirSync(abs, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        if (rel === '' && e.name === '.git') continue;
        if (TEMP_DIR_NAME_RE.test(e.name)) continue;   // mdsync's, not the user's: never listed, never touched
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (want === 'dir') out.push(r);
          go(join(abs, e.name), r);
        } else if (want === 'file') {
          out.push(r);
        }
      }
    };
    go(root, '');
    return out.sort();
  };
  const canCreate = (root: string, rel: string): boolean => {
    if (kindAt(join(root, rel)) !== 'none') return false;
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) if (kindAt(join(root, ...segs.slice(0, i))) === 'file') return false;
    return true;
  };
  const POOL: string[] = [];
  for (let i = 0; i < 6; i++) POOL.push(`notes/n${i}.md`);
  for (let d = 0; d < 3; d++) for (let f = 0; f < 3; f++) POOL.push(`d${d}/f${f}.md`, `d${d}/e${f % 2}/g${f}.md`);
  const CLASH = ['d0/e0', 'd1/e1', 'd2/e0'];

  const devs: Dev[] = [];
  const start = async (d: Pick<Dev, 'name' | 'clone' | 'config'>): Promise<Daemon> =>
    startDaemon(t, { name: d.name, dir: d.clone.dir, remote, ntfy, config: d.config as never });
  for (const name of ['A', 'B', 'C'] as const) {
    const clone = await cloneRemote(t, remote, name.toLowerCase());
    const config = { idleMs: 1_000, maxWaitMs: 2_500, fallbackMs: 5_000 };
    const daemon = await start({ name, clone, config });
    devs.push({ name, clone, daemon, instances: [daemon], state: 'up', busy: 'idle', intentional: new Set(), config });
  }

  // ---- file ops ----
  const write = (d: Dev, rel: string, text: string, op: 'create' | 'append' | 'overwrite' | 'atomic' | 'clash'): void => {
    const abs = join(d.clone.dir, rel);
    const tok = newToken();
    if (op === 'append') appendFileSync(abs, `- ${tok} (${d.name})\n`);
    else if (op === 'atomic') {
      const tmp = join(dirname(abs), `.${rel.split('/').pop()}.sb-${tok}`);
      writeFileSync(tmp, `${text}- ${tok} (${d.name} atomic)\n`);
      renameSync(tmp, abs);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${op === 'clash' ? 'clash' : `# ${rel}`}\n\n- ${tok} (${d.name} ${op})\n`);
    }
    written.set(tok, { tok, dev: d.name, path: rel, at: Date.now() });
    rec(d.name, op, { path: rel, tok });
  };
  const existing = (d: Dev): string | 'none' => {
    const files = walk(d.clone.dir, 'file');
    return files.length === 0 ? 'none' : pick(files);
  };
  const fileOp = (d: Dev): void => {
    const root = d.clone.dir;
    const w = rnd() * 80;
    if (w < 18) {
      const cands = POOL.filter((p) => canCreate(root, p));
      const rel = cands.length === 0 || rnd() < 0.15 ? `x${between(0, 4)}/z-${d.name}-${tokSeq}.md` : pick(cands);
      if (canCreate(root, rel)) write(d, rel, '', 'create');
    } else if (w < 69) {
      const rel = existing(d);
      if (rel === 'none' || kindAt(join(root, rel)) !== 'file') return;
      const text = readOr(join(root, rel));
      if (MARKERS_RE.test(text)) agentMarked.add(rel);   // an agent editing a conflicted file keeps its markers
      if (w < 43) write(d, rel, text, 'append');
      else if (w < 53) {
        for (const b of tokensIn(text)) removed.add(b);
        write(d, rel, text, 'overwrite');
      } else if (w < 59) write(d, rel, text, 'atomic');
      else if (w < 64) {
        if (rel === 'README.md') return;
        for (const b of tokensIn(text)) removed.add(b);
        unlinkSync(join(root, rel));
        removals.push({ dev: d.name, path: rel, scope: 'file', at: Date.now() });
        rec(d.name, 'delete', { path: rel, removed: tokensIn(text) });
      } else {
        if (rel === 'README.md') return;
        const cands = POOL.filter((p) => canCreate(root, p));
        const to = cands.length > 0 && rnd() < 0.7 ? pick(cands) : `mv/${d.name}-${tokSeq}.md`;
        if (!canCreate(root, to)) return;
        mkdirSync(dirname(join(root, to)), { recursive: true });
        renameSync(join(root, rel), join(root, to));
        removals.push({ dev: d.name, path: rel, scope: 'file', at: Date.now() });
        if (MARKERS_RE.test(text)) agentMarked.add(to);
        rec(d.name, 'rename', { path: rel, to, carried: tokensIn(text) });
        renames.push({ path: rel, to });
        // the tokens move with the file: they are still live, at the new path
        for (const tok of tokensIn(text)) { const x = written.get(tok); if (x !== undefined) written.set(tok, { ...x, path: to }); }
      }
    } else if (w < 70) {
      const dirs = walk(root, 'dir');
      if (dirs.length === 0) return;
      const rel = pick(dirs);
      for (const f of walk(join(root, rel), 'file')) for (const b of tokensIn(readOr(join(root, rel, f)))) removed.add(b);
      rmSync(join(root, rel), { recursive: true, force: true });
      removals.push({ dev: d.name, path: rel, scope: 'tree', at: Date.now() });
      rec(d.name, 'delete-dir', { path: rel });
    } else if (w < 71) {
      const cands = CLASH.filter((p) => canCreate(root, p));
      if (cands.length > 0) write(d, pick(cands), '', 'clash');
    } else {
      flush(d);
    }
  };

  // ---- flushes, outages and restarts ----
  const background = new Set<Promise<unknown>>();
  const bg = (p: Promise<unknown>): void => {
    const q = p.catch((e) => problems.push(`background: ${String(e).slice(0, 500)}`)).finally(() => background.delete(q));
    background.add(q);
  };
  let inFlight = 0;
  const flush = (d: Dev): void => {
    if (inFlight >= 3) return;
    const args = [rnd() < 0.35 ? '--wait' : '--no-wait'];
    if (rnd() < 0.4) {
      const files = walk(d.clone.dir, 'file');
      if (files.length > 0) args.push(join(d.clone.dir, pick(files)));
    }
    if (rnd() < 0.3) args.push('-m', `chaos ${d.name} ${tokSeq}`);
    inFlight++;
    bg(runCli(t, ['flush', '--dir', d.clone.dir, ...args], { timeoutMs: 300_000 }).then((r) => {
      if (r.code !== 0 && r.code !== 1) problems.push(`flush exit ${r.code}: ${r.stderr.slice(0, 300)}`);
      if (r.code === 1 && /busy: push failed/.test(r.stderr) && reach === 'reachable') {
        problems.push(`flush busy on a push with the remote reachable: ${r.stderr.slice(0, 300)}`);   // r4-chaos-3
      }
    }).finally(() => { inFlight--; }));
  };
  const lifecycle = (d: Dev, kind: 'kill' | 'term' | 'hup'): void => {
    if (d.busy !== 'idle' || d.state !== 'up') return;
    d.busy = 'lifecycle';
    bg((async () => {
      try {
        if (kind === 'hup') {
          d.config = { ...d.config, idleMs: between(1_000, 1_500), maxWaitMs: between(2_500, 3_000) };
          const cfg = (await Bun.file(d.daemon.configPath).json()) as Record<string, unknown>;
          writeFileSync(d.daemon.configPath, `${JSON.stringify({ ...cfg, ...d.config }, null, 2)}\n`);
          d.daemon.signal('SIGHUP');
          return;
        }
        d.intentional.add(d.daemon);
        d.state = 'down';
        d.daemon.signal(kind === 'kill' ? 'SIGKILL' : 'SIGTERM');
        const code = await d.daemon.exited;
        if (kind === 'term' && code !== 0) problems.push(`${d.name}: SIGTERM exit ${code}`);
        await Bun.sleep(between(200, 2_000));
        d.daemon = await start(d);
        d.instances.push(d.daemon);
        d.state = 'up';
      } finally {
        d.busy = 'idle';
      }
    })());
  };
  let reach: 'reachable' | 'unreachable' = 'reachable';
  let outage: 'none' | 'open' = 'none';
  const restoreRemote = async (): Promise<void> => {
    if (reach === 'reachable') return;
    await remote.restore();
    reach = 'reachable';
    // a push cut by the rename can leave a ref lock in the bare repo (a harness artifact, not mdsync's)
    await Bun.sleep(1_000);
    for (const l of walk(remote.path, 'file').filter((p) => p.endsWith('.lock') && !p.startsWith('objects/'))) {
      rmSync(join(remote.path, l), { force: true });
    }
  };
  const unreachable = (): void => {
    if (outage === 'open') return;
    outage = 'open';
    bg((async () => {
      try {
        await remote.setUnreachable();
        reach = 'unreachable';
        await Bun.sleep(between(2_000, 6_000));
      } finally {
        await restoreRemote();
        outage = 'none';
      }
    })());
  };

  // ---- chaos ----
  const end = Date.now() + CHAOS_MS;
  while (Date.now() < end) {
    const d = pick(devs);
    const x = rnd();
    if (x < 0.008) lifecycle(d, 'kill');
    else if (x < 0.014) lifecycle(d, 'term');
    else if (x < 0.019) lifecycle(d, 'hup');
    else if (x < 0.027) unreachable();
    else {
      try {
        fileOp(d);
      } catch {
        // a file vanished under us (a pull moved it): fine
      }
    }
    await Bun.sleep(between(20, 400));
  }

  // ---- quiesce ----
  for (let i = 0; i < 60 && background.size > 0; i++) await Promise.race([...background, Bun.sleep(5_000)]);
  await restoreRemote();
  for (const d of devs) if (d.state !== 'up') { d.daemon = await start(d); d.instances.push(d.daemon); d.state = 'up'; }
  for (let round = 0; round < 2; round++) {
    for (const d of devs) {
      const r = await runCli(t, ['flush', '--dir', d.clone.dir, '--wait'], { timeoutMs: 300_000 });
      if (r.code !== 0) problems.push(`quiesce flush ${d.name} round ${round}: exit ${r.code} ${r.stderr.slice(0, 300)}`);
    }
    await Bun.sleep(3_000);
  }
  // converged, and settled: every replaced inode's grace has passed and the daemons' settle timers emptied their temp
  // folders (a late write kept by settle is a new copy, which the device then commits and the others pull)
  const tempFolders = (d: Dev): string[] => readdirSync(d.clone.dir).filter((n) => TEMP_DIR_NAME_RE.test(n));
  try {
    await waitFor(async () => {
      const rh = await remote.head();
      for (const d of devs) {
        if ((await d.clone.head()) !== rh || (await d.clone.porcelain()).length > 0 || tempFolders(d).length > 0) return undefined;
      }
      return true;
    }, { timeoutMs: 60_000, intervalMs: 500, label: 'convergence' });
  } catch {
    problems.push('the devices did not converge (and settle) within 60 s of the last flush');
  }

  // ---- invariants ----
  const rtree = await remote.tree();
  for (const d of devs) {
    if ((await d.clone.head()) !== (await remote.head())) problems.push(`${d.name}: HEAD differs from the remote`);
    const temps = tempFolders(d);
    if (temps.length > 0) problems.push(`${d.name}: temp folders left after settle: ${temps.join(', ')}`);
    // two worktree names on one inode: an in-place edit of one note silently changes the other (the agent never
    // makes hard links, so any is mdsync's)
    const byIno = new Map<string, string[]>();
    for (const f of walk(d.clone.dir, 'file')) {
      const st = lstatSync(join(d.clone.dir, f), { bigint: true });
      if (st.nlink > 1n) byIno.set(String(st.ino), [...(byIno.get(String(st.ino)) ?? []), f]);
    }
    for (const names of byIno.values()) if (names.length > 1) problems.push(`${d.name}: worktree files share an inode: ${names.join(', ')}`);
    const racedKinds = new Map<string, number>();   // reported like kept stashes: kept by design, but worth seeing
    for (const inst of d.instances) for (const l of inst.logs) {
      if (l.msg === 'worktree write raced') racedKinds.set(String(l.kind), (racedKinds.get(String(l.kind)) ?? 0) + 1);
    }
    if (racedKinds.size > 0) process.stderr.write(`chaos seed ${seed}: ${d.name} worktree write raced ${JSON.stringify(Object.fromEntries(racedKinds))}\n`);
    const por = await d.clone.porcelain();
    if (por.length > 0) problems.push(`${d.name}: worktree not clean: ${por.slice(0, 10).join(', ')}`);
    if (JSON.stringify(walk(d.clone.dir, 'file')) !== JSON.stringify(rtree)) problems.push(`${d.name}: files on disk differ from the remote tree`);
    for (const g of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
      if (existsSync(join(d.clone.dir, '.git', g))) problems.push(`${d.name}: leftover .git/${g}`);
    }
    const st = await runCli(t, ['status', '--format', 'json', '--dir', d.clone.dir]);
    const sj = JSON.parse(st.stdout) as { stuck?: unknown; keptStashes?: { sha: string; reason: string }[]; unpushed?: number;
      lastRun?: { outcome?: string } };
    if (sj.stuck !== undefined) problems.push(`${d.name}: stuck ${JSON.stringify(sj.stuck)}`);
    // A stash replay whose write raced an agent keeps the stash rather than drop it: by design, reported.
    // Kept for any other reason, or a stash nothing accounts for, is a problem.
    const kept = sj.keptStashes ?? [];
    const raced = new Set(kept.filter((k) => k.reason === 'write-raced').map((k) => k.sha));
    if (kept.some((k) => k.reason !== 'write-raced')) problems.push(`${d.name}: kept stashes ${JSON.stringify(kept)}`);
    if (raced.size > 0) process.stderr.write(`chaos seed ${seed}: ${d.name} kept ${raced.size} stash(es) after a raced write\n`);
    const shas = (await d.clone.git(['log', '-g', '--format=%H', 'refs/stash', '--'])).stdout.split('\n').filter((x) => x !== '');
    if (shas.some((x) => !raced.has(x))) problems.push(`${d.name}: leftover stash entries`);
    if (sj.unpushed !== 0) problems.push(`${d.name}: ${sj.unpushed} unpushed`);
    if (sj.lastRun?.outcome !== 'ok' && sj.lastRun?.outcome !== 'conflict-resolved') problems.push(`${d.name}: last run ${sj.lastRun?.outcome}`);
    for (const inst of d.instances) {
      if (!d.intentional.has(inst) && inst.proc.exitCode !== null) problems.push(`${d.name}: daemon exited on its own (${inst.proc.exitCode})`);
    }
  }
  const stateDir = join(t.stateHome, 'mdsync');
  for (const e of existsSync(stateDir) ? readdirSync(stateDir, { withFileTypes: true }) : []) {
    if (e.name.endsWith('.journal.json')) problems.push(`leftover journal ${e.name}`);
    if (e.name.endsWith('.rescue') && e.isDirectory() && readdirSync(join(stateDir, e.name)).length > 0) problems.push(`leftover rescue ${e.name}`);
  }
  // Conflict markers are git's own output and never belong in a commit, except in what an agent made from a file that
  // held them (mdsync never edits user bytes): its edit of a conflicted file, kept as a rescue copy (S5 (b),
  // R3, P5), or a conflicted file it renamed or edited in place. Descends: those, what the chaos renamed them to, and
  // conflict copies of either.
  const rescued = new Set<string>(agentMarked);
  for (const d of devs) for (const inst of d.instances) for (const l of inst.logs) {
    if ((l.msg === 'rescued files' || (l.msg === 'conflict' && l.kind === 'rescue')) && Array.isArray(l.copies)) {
      for (const c of l.copies as string[]) rescued.add(c);
    }
  }
  for (let grew = 'yes'; grew === 'yes';) {
    grew = 'no';
    for (const r of renames) if (rescued.has(r.path) && !rescued.has(r.to)) { rescued.add(r.to); grew = 'yes'; }
  }
  const fromRescue = (p: string): boolean => rescued.has(p) || copyOrigins(p).some((o) => rescued.has(o));
  const present = new Set<string>();
  let rescuedMarkers = 0;
  for (const p of rtree) {
    const text = (await remote.show(p)) ?? '';
    if (MARKERS_RE.test(text)) {
      if (fromRescue(p)) rescuedMarkers++;
      else problems.push(`conflict markers in ${p}`);
    }
    for (const tok of tokensIn(text)) present.add(tok);
  }
  if (rescuedMarkers > 0) process.stderr.write(`chaos seed ${seed}: ${rescuedMarkers} rescued edit(s) of a conflicted file kept with git's markers\n`);
  const onDevices = new Set<string>();   // not pushed is not lost: the convergence checks above report that
  for (const d of devs) for (const f of walk(d.clone.dir, 'file')) for (const tok of tokensIn(readOr(join(d.clone.dir, f)))) onDevices.add(tok);
  const lost: string[] = [];
  for (const w of written.values()) {
    if (removed.has(w.tok) || present.has(w.tok) || onDevices.has(w.tok)) continue;
    lost.push(`${w.tok} (${w.dev}, last at ${w.path})`);
  }
  if (lost.length > D28_MAX) for (const l of lost) problems.push(`lost ${l}`);
  process.stderr.write(`chaos seed ${seed}: ${written.size} writes, ${[...written.values()].filter((w) => removed.has(w.tok)).length}`
    + ` removed by an agent, ${lost.length} lost\n`);
  const allowed = new Set(['Test Helper', 'mdsync-A', 'mdsync-B', 'mdsync-C']);
  for (const c of await remote.log()) {
    if (!allowed.has(c.authorName)) problems.push(`commit ${c.sha} by ${c.authorName}`);
    if (c.files.length === 0) problems.push(`empty commit ${c.sha} ${c.subject}`);
  }
  const merges = Bun.spawnSync(['git', 'rev-list', '--merges', 'refs/heads/main'], { cwd: remote.path, env: t.env }).stdout.toString().trim();
  if (merges !== '') problems.push('merge commits on the remote');
  // mdsync never deletes a conflict copy on its own: a device's commit that deletes one follows that device's agent
  // deleting it, renaming it away or removing a folder above it. A committed copy missing from the disk is pushed as a
  // delete nobody made (chaos round 2: a copy whose link the move refused was never written, seeds 121 … 164). The
  // commit time is in whole seconds, so an op up to 1.5 s after it still counts.
  const history = Bun.spawnSync(['git', '-c', 'core.quotePath=false', 'log', '--reverse', '--no-renames', '--name-status', '-z',
    '--format=%x1e%H %ct %an', 'refs/heads/main'], { cwd: remote.path, env: t.env }).stdout.toString();
  for (const chunk of history.split('\x1e').slice(1)) {
    const [head = '', ...fields] = chunk.split('\0').map((f) => f.replace(/^\n/, ''));
    const [sha = '', ct = '0', ...an] = head.split(' ');
    const author = an.join(' ');
    const dev = author.replace(/^mdsync-/, '');
    for (let k = 0; k + 1 < fields.length; k += 2) {
      const p = fields[k + 1] as string;
      if (fields[k] !== 'D' || !p.includes('(conflict ')) continue;
      const by = removals.some((x) => x.dev === dev && x.at <= Number(ct) * 1000 + 1_500
        && (x.path === p || (x.scope === 'tree' && p.startsWith(`${x.path}/`))));
      if (!by) problems.push(`commit ${sha.slice(0, 8)} by ${author} deletes ${p}, which no agent on ${dev} deleted`);
    }
  }
  if (written.size < 40) problems.push(`only ${written.size} writes: the run exercised too little`);

  if (problems.length > 0 || process.env.MDSYNC_CHAOS_DUMP === 'dump') {
    // everything needed to replay the story: kept with the temp dir (the harness prints where)
    process.env.MDSYNC_KEEP_TMP = 'keep';
    for (const d of devs) d.instances.forEach((inst, i) => writeFileSync(join(t.root, `logs-${d.name}-${i}.jsonl`),
      inst.logs.map((l) => JSON.stringify(l)).join('\n')));
    writeFileSync(join(t.root, 'writes.jsonl'), [...written.values()].map((w) => JSON.stringify({ ...w, ts: new Date(w.at).toISOString() })).join('\n'));
    writeFileSync(join(t.root, 'ops.jsonl'), ops.join('\n'));
  }
  expect(problems).toEqual([]);
}

for (const seed of SEEDS) {
  test(`chaos seed ${seed}: three devices converge, nothing written is lost, nothing is left behind`, async () => {
    await chaos(seed);
  }, CHAOS_MS + 240_000);
}
