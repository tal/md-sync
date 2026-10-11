// `git merge-file` wrapper with its three inputs in temp files under the state dir.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunContext } from './context';
import { errCode, isRecord } from './fsutil';
import { GitNotFoundError } from './git';
import { errorText } from './log';

export type MergeFileResult = { kind: 'clean'; content: Uint8Array } | { kind: 'conflict'; count: number }
                            | { kind: 'binary' } | { kind: 'error'; error: string };

let seq = 0;

function hasNul(b: Uint8Array): boolean {
  return b.indexOf(0) >= 0;
}

// <paths.tmp>/merge-<n>/, skipping any n left over from an earlier run
async function makeMergeDir(tmp: string): Promise<string> {
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  for (;;) {
    const dir = join(tmp, `merge-${++seq}`);
    try {
      await mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e;
    }
  }
}

// 'union': conflicting hunks keep the lines of both sides (`--union`), for files whose every line is a rule that
// must survive (.gitignore, .gitattributes): a conflict copy there is a file git never reads.
export type MergeStyle = 'normal' | 'union';

export async function mergeFile(ctx: RunContext, local: Uint8Array, base: Uint8Array, remote: Uint8Array,
                                style: MergeStyle = 'normal'): Promise<MergeFileResult> {
  if (hasNul(local) || hasNul(base) || hasNul(remote)) return { kind: 'binary' };

  let dir: string | 'none' = 'none';
  try {
    dir = await makeMergeDir(ctx.paths.tmp);
    const [l, b, r] = [join(dir, 'local'), join(dir, 'base'), join(dir, 'remote')];
    await Promise.all([Bun.write(l, local), Bun.write(b, base), Bun.write(r, remote)]);
    const res = await ctx.git.bytes(['merge-file', '-p', ...(style === 'union' ? ['--union'] : []),
      '-L', 'local', '-L', 'base', '-L', 'remote', l, b, r]);
    if (res.code === 0) return { kind: 'clean', content: res.stdout };
    if (res.code >= 1 && res.code <= 127) return { kind: 'conflict', count: res.code };
    if (res.code >= 128 && res.stderr.includes('Cannot merge binary files')) return { kind: 'binary' };
    const why = res.spawnError ?? (res.timedOut === 'timed-out' ? 'timed out' : res.stderr.trim());
    return { kind: 'error', error: errorText(`git merge-file exited ${res.code}${why === '' ? '' : `: ${why}`}`) };
  } catch (e) {
    if (e instanceof GitNotFoundError) throw e;
    return { kind: 'error', error: errorText(e) };   // temp-file I/O
  } finally {
    if (dir !== 'none') await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// The repo config (.config/mdsync.json), merged per top-level key: a key one side changed takes that side's value,
// `ignore` takes the patterns of both sides (remote's order, then local's additions), and a key both sides changed
// differently takes the remote value (as the remote keeps the path in any conflict). 'unmergeable' when a side is
// not a JSON object: the line merge decides then.
export function mergeRepoConfig(local: Uint8Array, base: Uint8Array, remote: Uint8Array): Uint8Array | 'unmergeable' {
  const parse = (b: Uint8Array, empty: 'absent-ok' | 'required'): Record<string, unknown> | 'invalid' => {
    const text = new TextDecoder().decode(b);
    if (text.trim() === '' && empty === 'absent-ok') return {};
    try {
      const v: unknown = JSON.parse(text);
      return isRecord(v) ? v : 'invalid';
    } catch {
      return 'invalid';
    }
  };
  const [l, b, r] = [parse(local, 'required'), parse(base, 'absent-ok'), parse(remote, 'required')];
  if (l === 'invalid' || b === 'invalid' || r === 'invalid') return 'unmergeable';
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(b)])) {
    const [lv, bv, rv] = [l[k], b[k], r[k]];
    let v: unknown;
    if (k === 'ignore' && (Array.isArray(lv) || Array.isArray(rv))) {
      const both = [...(Array.isArray(rv) ? rv : []), ...(Array.isArray(lv) ? lv : [])];
      v = both.filter((x, i) => both.findIndex((y) => same(x, y)) === i);
    } else if (same(lv, bv)) {
      v = rv;
    } else if (same(rv, bv)) {
      v = lv;
    } else {
      v = rv;
    }
    if (v !== undefined) out[k] = v;
  }
  return new TextEncoder().encode(`${JSON.stringify(out, null, 2)}\n`);
}
