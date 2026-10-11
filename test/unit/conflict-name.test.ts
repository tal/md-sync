import { describe, expect, test } from 'bun:test';
import {
  CONFLICT_COPY_RE, conflictCopyPath, copyOrigins, foldCase, isConflictCopy, NAME_MAX_BYTES, nameLimitFor, overlongSegments,
} from '../../src/conflict-name';
import { conflictStamp } from '../../src/host';

const STAMP = '2026-10-08 1234';
const free = (): boolean => false;
const copy = (rel: string, taken: (c: string) => boolean = free): string => conflictCopyPath(rel, 'host', STAMP, taken);

// The `taken` predicate callers build: exists, in a tree/index, prefix/descendant of one, or already chosen.
function takenBy(paths: string[], ignoreCase: 'case-insensitive' | 'case-sensitive'): (c: string) => boolean {
  const key = ignoreCase === 'case-insensitive' ? foldCase : (p: string) => p;
  const keys = paths.map(key);
  return (c) => {
    const k = key(c);
    return keys.some((p) => p === k || p.startsWith(`${k}/`) || k.startsWith(`${p}/`));
  };
}

describe('conflictCopyPath naming', () => {
  test('keeps the extension after the parens', () => {
    expect(copy('note.md')).toBe('note (conflict host 2026-10-08 1234).md');
    expect(copy('data.json')).toBe('data (conflict host 2026-10-08 1234).json');
  });

  test('no extension', () => {
    expect(copy('README')).toBe('README (conflict host 2026-10-08 1234)');
  });

  test('a dotfile has no extension', () => {
    expect(copy('.env')).toBe('.env (conflict host 2026-10-08 1234)');
    expect(copy('dir/.gitignore')).toBe('dir/.gitignore (conflict host 2026-10-08 1234)');
  });

  test('only the last extension moves; a dotfile with an extension keeps its leading dot', () => {
    expect(copy('archive.tar.gz')).toBe('archive.tar (conflict host 2026-10-08 1234).gz');
    expect(copy('.config.json')).toBe('.config (conflict host 2026-10-08 1234).json');
  });

  test('a trailing dot is not an extension', () => {
    expect(copy('odd.')).toBe('odd. (conflict host 2026-10-08 1234)');
  });

  test('nested dirs stay put; dots in dir names are ignored', () => {
    expect(copy('a/b.c/note.md')).toBe('a/b.c/note (conflict host 2026-10-08 1234).md');
    expect(copy('a/b.c/README')).toBe('a/b.c/README (conflict host 2026-10-08 1234)');
  });

  test('a directory collision renames the top dir name', () => {
    expect(copy('notes')).toBe('notes (conflict host 2026-10-08 1234)');
  });

  test('passes the full candidate path to taken', () => {
    const seen: string[] = [];
    copy('d/x.md', (c) => { seen.push(c); return seen.length < 3; });
    expect(seen).toEqual([
      'd/x (conflict host 2026-10-08 1234).md',
      'd/x (conflict host 2026-10-08 1234 2).md',
      'd/x (conflict host 2026-10-08 1234 3).md',
    ]);
  });
});

describe('conflictCopyPath suffixes', () => {
  test(' 2, then 3, inside the parens', () => {
    const taken = new Set(['a (conflict h 2026-10-08 1234).md', 'a (conflict h 2026-10-08 1234 2).md']);
    expect(conflictCopyPath('a.md', 'h', STAMP, (c) => taken.has(c))).toBe('a (conflict h 2026-10-08 1234 3).md');
  });

  test('a chosen-in-this-plan set gives distinct names to repeated calls', () => {
    const chosen = new Set<string>();
    const pick = (p: string): string => {
      const c = conflictCopyPath(p, 'h', STAMP, (x) => chosen.has(x));
      chosen.add(c);
      return c;
    };
    expect([pick('n.md'), pick('n.md'), pick('n.md')]).toEqual([
      'n (conflict h 2026-10-08 1234).md',
      'n (conflict h 2026-10-08 1234 2).md',
      'n (conflict h 2026-10-08 1234 3).md',
    ]);
  });

  test('case-insensitive taken skips a name that differs only in case', () => {
    const existing = ['Note (conflict host 2026-10-08 1234).md'];
    expect(copy('note.md', takenBy(existing, 'case-sensitive'))).toBe('note (conflict host 2026-10-08 1234).md');
    expect(copy('note.md', takenBy(existing, 'case-insensitive'))).toBe('note (conflict host 2026-10-08 1234 2).md');
  });

  test('case-insensitive taken folds NFC/NFD spellings', () => {
    const nfd = 'Cafe\u0301 (conflict host 2026-10-08 1234).md';
    expect(copy('caf\u00e9.md', takenBy([nfd], 'case-insensitive'))).toBe('caf\u00e9 (conflict host 2026-10-08 1234 2).md');
  });

  test('a candidate that is a prefix of a taken path is taken', () => {
    const existing = ['notes (conflict host 2026-10-08 1234)/x.md'];
    expect(copy('notes', takenBy(existing, 'case-sensitive'))).toBe('notes (conflict host 2026-10-08 1234 2)');
  });

  test('a candidate under a taken file path is taken', () => {
    const existing = ['d/x (conflict host 2026-10-08 1234).md'];
    // the candidate equals the taken path; and a dir candidate whose descendant exists is also refused
    expect(copy('d/x.md', takenBy(existing, 'case-sensitive'))).toBe('d/x (conflict host 2026-10-08 1234 2).md');
    expect(copy('d', takenBy(['d (conflict host 2026-10-08 1234)'], 'case-sensitive'))).toBe('d (conflict host 2026-10-08 1234 2)');
    const fileThere = takenBy(['top (conflict host 2026-10-08 1234)'], 'case-sensitive');
    expect(fileThere('top (conflict host 2026-10-08 1234)/inner.md')).toBe(true);
  });

  test('a taken predicate that never frees a name is a programmer error', () => {
    expect(() => copy('x.md', () => true)).toThrow(/no free name/);
  });
});

describe('conflictCopyPath name length (NAME_MAX)', () => {
  const bytes = (s: string): number => new TextEncoder().encode(s).length;
  const last = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

  test('a copy of a long name is cut to 255 bytes in its stem and still matches, in every suffix', () => {
    // a 233-byte name made the copy 270 bytes: `reset --hard` then failed on it, on every run
    const rel = `deep/dir/${'a'.repeat(233)}.md`;
    const chosen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const c = conflictCopyPath(rel, 'Noctiluca', STAMP, (x) => chosen.has(x));
      chosen.add(c);
      expect(c.startsWith('deep/dir/aaaa')).toBe(true);
      expect(bytes(last(c))).toBeLessThanOrEqual(NAME_MAX_BYTES);
      expect(CONFLICT_COPY_RE.test(c)).toBe(true);
      expect(c.endsWith(`(conflict Noctiluca 2026-10-08 1234${i === 0 ? '' : ` ${i + 1}`}).md`)).toBe(true);
      expect(overlongSegments(c)).toEqual([]);
    }
    expect(chosen.size).toBe(12);
  });

  test('cuts at a character boundary, never inside a multi-byte character', () => {
    const rel = `${'é'.repeat(126)}.md`;   // 252 + 3 bytes
    const c = copy(rel);
    expect(bytes(c)).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(c).not.toContain('\uFFFD');
    expect(/^é+ \(conflict host 2026-10-08 1234\)\.md$/.test(c)).toBe(true);
  });

  test('an absurdly long extension is cut too, keeping its dot', () => {
    const c = copy(`x.${'e'.repeat(250)}`);
    expect(bytes(c)).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(CONFLICT_COPY_RE.test(c)).toBe(true);
    expect(c.startsWith('x (conflict host 2026-10-08 1234).ee')).toBe(true);
  });

  test('a folder copy (directory collision) is cut the same way; short names are untouched', () => {
    const c = copy(`notes/${'d'.repeat(250)}`);
    expect(bytes(last(c))).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(CONFLICT_COPY_RE.test(c)).toBe(true);
    expect(copy('note.md')).toBe('note (conflict host 2026-10-08 1234).md');
  });

  test('overlongSegments names the segments no filesystem can create', () => {
    expect(overlongSegments(`a/${'x'.repeat(256)}/b.md`)).toEqual(['x'.repeat(256)]);
    expect(overlongSegments(`a/${'x'.repeat(255)}`)).toEqual([]);
    expect(overlongSegments('日'.repeat(90), 'bytes')).toEqual(['日'.repeat(90)]);
    expect(overlongSegments('日'.repeat(90), 'utf16-units')).toEqual([]);
    expect(overlongSegments('😀'.repeat(128), 'utf16-units')).toEqual(['😀'.repeat(128)]);   // 256 UTF-16 units
    expect(nameLimitFor('darwin')).toBe('utf16-units');
    expect(nameLimitFor('linux')).toBe('bytes');
  });
});

describe('CONFLICT_COPY_RE / isConflictCopy', () => {
  test('is the documented regex', () => {
    expect(CONFLICT_COPY_RE.source).toBe(String.raw` \(conflict [^()]+ \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?:\.[^./]+)?$`);
  });

  test('round-trip: every generated name matches', () => {
    const inputs = ['note.md', 'README', '.env', 'odd.', 'archive.tar.gz', 'a/b.c/x.json', 'notes', '..md', 'sp ace/f i.le.txt'];
    for (const rel of inputs) {
      for (const n of [1, 2, 11]) {
        let calls = 0;
        const name = conflictCopyPath(rel, 'my-host', conflictStamp(new Date(2026, 9, 8, 7, 5)), () => ++calls < n);
        expect(CONFLICT_COPY_RE.test(name)).toBe(true);
        expect(isConflictCopy(name)).toBe(true);
      }
    }
  });

  test('ordinary names do not match', () => {
    for (const rel of ['note.md', 'a (conflict).md', 'a (conflict h 2026-10-08).md', 'a (conflict h 26-10-08 1234).md',
      'a(conflict h 2026-10-08 1234).md', 'a (conflict h 2026-10-08 1234).tar.gz']) {
      expect(isConflictCopy(rel)).toBe(false);
    }
  });

  test('isConflictCopy also covers files inside a conflict-copy directory', () => {
    const inside = 'd (conflict h 2026-10-08 1234)/x.md';
    expect(CONFLICT_COPY_RE.test(inside)).toBe(false);
    expect(isConflictCopy(inside)).toBe(true);
    expect(isConflictCopy('d (conflict h 2026-10-08 1234 2)/sub/y.md')).toBe(true);
  });
});

describe('copyOrigins', () => {
  test('strips one conflict suffix per step, keeping the extension', () => {
    expect(copyOrigins(copy('notes/journal.md'))).toEqual(['notes/journal.md']);
    expect(copyOrigins(copy('.env'))).toEqual(['.env']);
    expect(copyOrigins(copy('a.tar.gz'))).toEqual(['a.tar.gz']);
    expect(copyOrigins(copy('x.md', (c) => !c.includes(' 3)')))).toEqual(['x.md']);
  });

  test('a file inside a conflict-copy folder stands for the same path in the original folder', () => {
    expect(copyOrigins(`${copy('secrets')}/key.md`)).toEqual(['secrets/key.md']);
  });

  test('a copy of a copy yields every original, nearest first', () => {
    const twice = copy(copy('n.md'));
    expect(copyOrigins(twice)).toEqual([copy('n.md'), 'n.md']);
  });

  test('not a copy: nothing', () => {
    expect(copyOrigins('notes/plain.md')).toEqual([]);
    expect(copyOrigins('my (conflict) notes.md')).toEqual([]);
  });
});

describe('foldCase', () => {
  test('lowercases and NFC-normalizes', () => {
    expect(foldCase('Notes/README.MD')).toBe('notes/readme.md');
    expect(foldCase('Cafe\u0301')).toBe('caf\u00e9');
    expect(foldCase('CAF\u00c9')).toBe(foldCase('cafe\u0301'));
  });
});

describe('conflictStamp', () => {
  test('is local time, not UTC (a literal value under a non-UTC zone)', () => {
    // r3 mutation lens: every daemon in the suite runs with TZ=UTC and the unit tests built the expected name with
    // conflictStamp itself, so a UTC stamp passed. 07:05 in New York is 11:05 UTC in October.
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const d = new Date(Date.UTC(2026, 9, 8, 11, 5));
      expect(conflictStamp(d)).toBe('2026-10-08 0705');
      expect(conflictStamp(new Date(Date.UTC(2026, 9, 9, 3, 30)))).toBe('2026-10-08 2330');   // the local date, too
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});
