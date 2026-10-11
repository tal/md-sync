// In-memory commit replay: rebase's patch-id skip, then one
// `merge-tree --write-tree --merge-base=<c^>` per local commit, each result written as a commit object built from the
// original one (`hash-object -t commit`: the author header byte for byte, the encoding header and the message bytes),
// as `git rebase` copies them. It writes objects only: nothing to undo when it fails or the process dies, and the
// worktree is never touched. Like `git rebase` (without --rebase-merges) it linearizes: merge commits are dropped and
// the commits on every side of them are replayed in topological order. Only a merge that holds content of its own (a
// conflict resolution, an evil merge), a conflict or an octopus goes to the planner, which keeps every byte.
import type { RunContext } from './context';
import { firstLine } from './fsutil';
import { isOid, parseNul } from './git';

export type ReplayResult =
  | { kind: 'clean'; tip: string; replayed: number; dropped: number; skipped: number }   // tip == onto when nothing is left
  | { kind: 'conflict'; at: string; paths: string[] }                    // the first commit that conflicts
  | { kind: 'has-merges' }                                                // a merge in upstream..local with content of its own
  | { kind: 'failed'; error: string };

// One raw commit object. `author` is the header's value exactly as stored (bytes: a Latin-1 commit's name is not UTF-8).
export type RawCommit = { tree: string; parents: string[]; author: Uint8Array; encoding: string | 'none'; message: Uint8Array };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function indexOfBytes(hay: Uint8Array, needle: readonly number[], from: number): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

function startsWith(line: Uint8Array, prefix: string): boolean {
  const p = encoder.encode(prefix);
  if (line.length < p.length) return false;
  for (let k = 0; k < p.length; k++) if (line[k] !== p[k]) return false;
  return true;
}

// One raw commit object: its headers (continuation lines of a gpgsig or mergetag header skipped) and the message bytes
// after the first blank line. Never formatted output: a user's log.showSignature prefixes `log --format`.
// The author header is kept as it is: rebuilt through GIT_AUTHOR_* (commit-tree's ident check), a name another tool
// wrote (empty, quoted, a trailing comma, no timezone) was rejected for good or rewritten, where `git rebase` copies it.
export function parseRawCommit(raw: Uint8Array): RawCommit | 'invalid' {
  const sep = indexOfBytes(raw, [10, 10], 0);
  const headEnd = sep < 0 ? raw.length : sep;
  let tree = '';
  const parents: string[] = [];
  let author: Uint8Array | 'none' = 'none';
  let encoding: string | 'none' = 'none';
  for (let at = 0; at < headEnd;) {
    let nl = raw.indexOf(10, at);
    if (nl < 0 || nl > headEnd) nl = headEnd;
    const line = raw.subarray(at, nl);
    at = nl + 1;
    if (line[0] === 0x20) continue;   // a continuation line (gpgsig, mergetag)
    if (startsWith(line, 'tree ')) tree = decoder.decode(line.subarray(5)).trim();
    else if (startsWith(line, 'parent ')) parents.push(decoder.decode(line.subarray(7)).trim());
    else if (startsWith(line, 'author ') && author === 'none') author = line.subarray(7);
    else if (startsWith(line, 'encoding ')) encoding = decoder.decode(line.subarray(9)).trim();
  }
  if (author === 'none' || !isOid(tree)) return 'invalid';
  return { tree, parents, author, encoding, message: sep < 0 ? new Uint8Array(0) : raw.subarray(sep + 2) };
}

// `cat-file --batch` output for the given commits: `<oid> commit <size>\n<raw>\n` each.
async function readRawCommits(ctx: RunContext, shas: readonly string[]): Promise<Map<string, RawCommit> | { error: string }> {
  const out = new Map<string, RawCommit>();
  if (shas.length === 0) return out;
  const r = await ctx.git.bytes(['cat-file', '--batch'], { input: shas.map((s) => `${s}\n`).join('') });
  if (r.code !== 0) return { error: `git cat-file --batch exited ${r.code}: ${firstLine(r.stderr)}` };
  const b = r.stdout;
  let at = 0;
  for (const sha of shas) {
    const nl = b.indexOf(10, at);
    if (nl < 0) return { error: `git cat-file --batch: output ended before ${sha}` };
    const header = decoder.decode(b.subarray(at, nl)).split(' ');
    const size = Number(header[2]);
    if (header[0] !== sha || header[1] !== 'commit' || !Number.isInteger(size)) {
      return { error: `git cat-file --batch: unexpected header for ${sha}: ${header.join(' ')}` };
    }
    const raw = b.subarray(nl + 1, nl + 1 + size);
    const parsed = parseRawCommit(raw);
    if (parsed === 'invalid') return { error: `commit ${sha} has no author header` };
    out.set(sha, parsed);
    at = nl + 1 + size + 1;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The replayed commit object, as `git rebase` writes it: tree, parent, the original author header byte for byte, the
// configured committer with the current time, the original encoding header, the original message bytes (a gpgsig is
// dropped: mdsync never signs). Written durably. git's object check refuses some headers git itself would
// never write (an author line without a timezone, which another tool made); the original object holds the same line,
// so it is written as is (`--literally`), as the rebase did, rather than failing every run on {H, R} for good.
async function writeCommit(ctx: RunContext, o: { tree: string; parent: string; meta: RawCommit; committer: string }):
  Promise<string | { error: string }> {
  const body = concat([
    encoder.encode(`tree ${o.tree}\nparent ${o.parent}\nauthor `), o.meta.author,
    encoder.encode(`\ncommitter ${o.committer}\n${o.meta.encoding !== 'none' ? `encoding ${o.meta.encoding}\n` : ''}\n`),
    o.meta.message,
  ]);
  let r = await ctx.git.run(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: body, durable: 'durable' });
  if (r.code !== 0) r = await ctx.git.run(['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], { input: body, durable: 'durable' });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !isOid(sha)) return { error: `git hash-object -t commit exited ${r.code}: ${firstLine(r.stderr)}` };
  return sha;
}

// A merge that `git merge` itself would produce from its two parents holds nothing of its own: dropped, as `git rebase`
// drops it, its sides' commits carry every change. Anything else (a hand-resolved conflict, an edit made in the merge,
// an octopus) would lose that content in a linearized replay: the planner replays the whole diff instead.
async function plainMerge(ctx: RunContext, m: RawCommit): Promise<'plain' | 'own-content'> {
  if (m.parents.length !== 2) return 'own-content';
  const r = await ctx.git.run(['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', '--allow-unrelated-histories',
    m.parents[0] as string, m.parents[1] as string]);
  const tree = parseNul(r.stdout)[0] ?? '';
  return r.code === 0 && tree === m.tree ? 'plain' : 'own-content';
}

export async function replayCommits(ctx: RunContext, i: { local: string; onto: string; upstream: string }): Promise<ReplayResult> {
  const g = ctx.git;
  try {
    // P1: the local commits, oldest first (topological order, as rebase's todo list)
    const list = await g.run(['rev-list', '--reverse', '--topo-order', '--parents', `${i.upstream}..${i.local}`, '--']);
    if (list.code !== 0) return { kind: 'failed', error: `git rev-list exited ${list.code}: ${firstLine(list.stderr)}` };
    const revs: { sha: string; parents: string[] }[] = [];
    for (const line of list.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const [sha, ...parents] = line.trim().split(' ');
      if (sha !== undefined) revs.push({ sha, parents });
    }
    const merges = revs.filter((c) => c.parents.length >= 2);
    const picks = revs.filter((c) => c.parents.length <= 1);   // a root commit (unrelated histories) replays onto the tip
    // rebase's patch-id skip: a commit whose change is already upstream (cherry-picked, or pushed by a device that
    // crashed before recording the push) is skipped. Replayed, it conflicts with any later upstream edit of its lines.
    const fresh = await g.run(['rev-list', '--cherry-pick', '--right-only', '--no-merges', `${i.onto}...${i.local}`, '--']);
    if (fresh.code !== 0) return { kind: 'failed', error: `git rev-list --cherry-pick exited ${fresh.code}: ${firstLine(fresh.stderr)}` };
    const keep = new Set(fresh.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
    const todo = picks.filter((c) => keep.has(c.sha));
    const skipped = picks.length - todo.length;

    // P2: one read of every object needed (the picks, their parents' trees, the merges)
    const need = [...new Set([...todo.map((c) => c.sha), ...todo.flatMap((c) => c.parents), ...merges.map((c) => c.sha)])];
    const raw = await readRawCommits(ctx, need);
    if ('error' in raw) return { kind: 'failed', error: raw.error };
    for (const m of merges) {
      const meta = raw.get(m.sha);
      if (meta === undefined || (await plainMerge(ctx, meta)) === 'own-content') return { kind: 'has-merges' };
    }
    const committer = (await g.ok(['var', 'GIT_COMMITTER_IDENT'])).trim();
    let tip = i.onto;
    let tipTree = (await g.ok(['rev-parse', '--verify', `${i.onto}^{tree}`])).trim();
    let replayed = 0;
    let dropped = 0;
    for (const c of todo) {
      const meta = raw.get(c.sha);
      const parent = c.parents[0];
      const parentTree = parent === undefined ? ctx.emptyTree : raw.get(parent)?.tree;
      if (meta === undefined || parentTree === undefined) return { kind: 'failed', error: `commit ${c.sha} was not read` };
      let tree: string;
      if (meta.tree === parentTree) {
        tree = tipTree;   // empty from the start (a checkpoint): kept, as `git rebase` keeps it (--keep-empty, git >= 2.26)
      } else {
        const m = await g.run(['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages',
          `--merge-base=${parent ?? ctx.emptyTree}`, tip, c.sha], { durable: 'durable' });
        const fields = parseNul(m.stdout);
        const first = fields[0] ?? '';
        if (m.code === 0 && isOid(first)) {
          tree = first;
        } else if (m.code === 1 && isOid(first)) {
          return { kind: 'conflict', at: c.sha, paths: [...new Set(fields.slice(1).filter((p) => p !== ''))] };
        } else {
          // exit 1 with empty stdout is a usage error, not a conflict (`not something we can merge`); 128 is fatal
          return { kind: 'failed', error: `git merge-tree exited ${m.code}: ${firstLine(m.stderr) || 'no output'}` };
        }
        if (tree === tipTree) {
          dropped++;   // became empty: `git rebase` drops it too
          continue;
        }
      }
      const w = await writeCommit(ctx, { tree, parent: tip, meta, committer });
      if (typeof w !== 'string') return { kind: 'failed', error: w.error };
      tip = w;
      tipTree = tree;
      replayed++;
    }
    return { kind: 'clean', tip, replayed, dropped, skipped };
  } catch (e) {
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
