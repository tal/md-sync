// Compiles `ignore` config globs into Bun.Glob matchers and git pathspec excludes.

export type IgnoreMatcher = {
  patterns: readonly string[];        // as configured
  globs: readonly string[];           // compiled (each pattern -> 2 globs)
  matches(rel: string): boolean;      // Bun.Glob match on repo-relative POSIX path
  pathspecExcludes: readonly string[];// [':(exclude,glob)<g>' for each compiled glob, then MOVE_TEMP_EXCLUDE]
};

// The worktree move's temp folders: never staged, never pending, also with an empty `ignore` list. Replaced
// inodes wait there for SETTLE_GRACE_MS after a move, and S2 may run meanwhile.
export const MOVE_TEMP_EXCLUDE = ':(exclude,glob)**/.mdsync-*.d/**';

// gitignore-like: a leading '/' or an inner '/' anchors a pattern to the repo root, anything else
// matches at any depth ('drafts/' too: the trailing '/' is dropped); '<base>/**' covers a matched dir's contents.
export function compilePattern(pat: string): [string, string] {
  let p = pat.trim().replace(/^\.\//, '');
  const anchored = p.startsWith('/') || p.replace(/\/$/, '').includes('/');
  p = p.replace(/^\//, '').replace(/\/$/, '');
  const base = anchored ? p : `**/${p}`;
  return [base, `${base}/**`];
}

// A pattern that normalizes to nothing ('/', './', '//') would compile to '' and '/**', and git
// rejects '/**' as outside the repository, failing every status call. Such patterns are skipped.
function compilable(pat: string): boolean {
  const [base] = compilePattern(pat);
  return base !== '' && !base.startsWith('/');
}

export function compileIgnore(patterns: readonly string[]): IgnoreMatcher {
  const globs = patterns.filter(compilable).flatMap((pat) => compilePattern(pat));
  const matchers = globs.map((g) => new Bun.Glob(g));
  return {
    patterns: [...patterns],
    globs,
    matches: (rel: string): boolean => {
      for (const m of matchers) if (m.match(rel)) return true;
      return false;
    },
    pathspecExcludes: [...globs.map((g) => `:(exclude,glob)${g}`), MOVE_TEMP_EXCLUDE],
  };
}
