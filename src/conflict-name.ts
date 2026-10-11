// Conflict-copy path naming and case folding. Pure.

export const CONFLICT_COPY_RE: RegExp = / \(conflict [^()]+ \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?:\.[^./]+)?$/;

// A broken `taken` that never says no would loop forever; past this many suffixes it is a programmer error.
const MAX_SUFFIX = 100_000;
// The longest file or folder name (one path segment) APFS, ext4 and most other filesystems accept, in UTF-8 bytes.
export const NAME_MAX_BYTES = 255;

const utf8 = new TextEncoder();

function byteLength(s: string): number {
  return utf8.encode(s).length;
}

// The longest prefix of s (whole code points) that fits in `bytes` UTF-8 bytes.
function clipBytes(s: string, bytes: number): string {
  if (bytes <= 0) return '';
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > bytes) break;
    out += ch;
    used += n;
  }
  return out;
}

// stem + middle + ext as one segment of at most NAME_MAX_BYTES. The stem is shortened (keeping its start), and the
// extension only when even a one-character stem would not fit (it keeps its dot and first character), so the result
// still matches CONFLICT_COPY_RE. A copy named past the limit can't be created: `reset --hard` failed on it, after
// rewriting the rest of the worktree, on every run.
function fitSegment(stem: string, middle: string, ext: string): string {
  if (byteLength(stem + middle + ext) <= NAME_MAX_BYTES) return stem + middle + ext;
  let e = ext;
  if (e !== '' && byteLength(middle) + byteLength(e) + 1 > NAME_MAX_BYTES) {
    const body = e.slice(1);
    const kept = clipBytes(body, NAME_MAX_BYTES - byteLength(middle) - 2);
    e = `.${kept !== '' ? kept : [...body][0] ?? ''}`;
  }
  return clipBytes(stem, NAME_MAX_BYTES - byteLength(middle) - byteLength(e)) + middle + e;
}

// 'dir/' + stem + ext. ext is the last '.xxx' of the basename (xxx non-empty), unless that dot is at index 0
// (a dotfile has no ext). A trailing dot stays in the stem, so every result matches CONFLICT_COPY_RE.
function splitName(rel: string): { dir: string; stem: string; ext: string } {
  const slash = rel.lastIndexOf('/');
  const dir = rel.slice(0, slash + 1);
  const base = rel.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return { dir, stem: base, ext: '' };
  return { dir, stem: base.slice(0, dot), ext: base.slice(dot) };
}

// `<dir>/<stem> (conflict <host> <stamp>)<ext>`, then ` 2`, ` 3`, … inside the parens until `taken` says no.
// For a directory collision pass the top dir name (`notes` -> `notes (conflict h 2026-10-08 1234)`). The last
// segment is kept within NAME_MAX_BYTES by shortening the stem (fitSegment).
export function conflictCopyPath(rel: string, host: string, stamp: string, taken: (candidate: string) => boolean): string {
  const { dir, stem, ext } = splitName(rel);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const suffix = n === 1 ? '' : ` ${n}`;
    const candidate = `${dir}${fitSegment(stem, ` (conflict ${host} ${stamp}${suffix})`, ext)}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`conflictCopyPath: no free name for ${rel} after ${MAX_SUFFIX} candidates`);
}

// True for a conflict copy and for anything inside a conflict-copy directory (`d (conflict …)/x.md`).
export function isConflictCopy(rel: string): boolean {
  return rel.split('/').some((segment) => CONFLICT_COPY_RE.test(segment));
}

// One conflict-copy path segment: stem, ` (conflict <host> <stamp>[ n])`, ext.
const COPY_SEGMENT_RE = /^(.*) \(conflict [^()]+ \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)((?:\.[^./]+)?)$/;
const MAX_ORIGINS = 64;

// The paths a conflict copy stands for, nearest first: each step strips one ` (conflict …)` (the last one in the
// first copy segment). 'd (conflict h 2026-10-08 1234)/x.md' -> ['d/x.md']; not a copy -> [].
export function copyOrigins(rel: string): string[] {
  const out: string[] = [];
  let cur = rel;
  for (let i = 0; i < MAX_ORIGINS; i++) {
    const segs = cur.split('/');
    const at = segs.findIndex((s) => COPY_SEGMENT_RE.test(s));
    if (at === -1) break;
    const m = COPY_SEGMENT_RE.exec(segs[at]!)!;
    segs[at] = `${m[1]}${m[2]}`;
    cur = segs.join('/');
    out.push(cur);
  }
  return out;
}

// How the local filesystem measures a name's 255 limit: APFS (macOS) counts UTF-16 code units, so a 90-character
// Japanese title (270 UTF-8 bytes) is a legal Mac name; ext4, btrfs and xfs count UTF-8 bytes.
export type NameLimit = 'bytes' | 'utf16-units';

export function nameLimitFor(platform: NodeJS.Platform): NameLimit {
  return platform === 'darwin' ? 'utf16-units' : 'bytes';
}

export function nameLimitText(limit: NameLimit): string {
  return limit === 'bytes' ? `${NAME_MAX_BYTES} bytes` : `${NAME_MAX_BYTES} UTF-16 units`;
}

// Path segments longer than the local filesystem allows (255 in its measure): they can't be created here.
export function overlongSegments(p: string, limit: NameLimit = nameLimitFor(process.platform)): string[] {
  return p.split('/').filter((seg) => (limit === 'bytes' ? byteLength(seg) : seg.length) > NAME_MAX_BYTES);
}

export function foldCase(p: string): string {
  return p.normalize('NFC').toLowerCase();
}
