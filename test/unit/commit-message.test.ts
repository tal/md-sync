import { describe, expect, test } from 'bun:test';
import { MAX_LISTED_FILES, buildCommitMessage, buildConflictMessage, subjectOf } from '../../src/commit-message';
import type { ChangeEntry, CommitPlan } from '../../src/types';

const NOW = new Date('2026-10-08T12:34:56.789Z');
const ISO = '2026-10-08T12:34:56Z';

function plan(p: Partial<CommitPlan>): CommitPlan {
  return { scope: { kind: 'all' }, messages: [], tag: 'none', sources: ['flush'], ...p };
}
function changes(n: number): ChangeEntry[] {
  return Array.from({ length: n }, (_, i) => ({ status: i % 2 ? 'M' : 'A', path: `f${i}.md` }));
}
const msg = (p: Partial<CommitPlan>, c: ChangeEntry[] = []): string => buildCommitMessage({ plan: plan(p), host: 'box', now: NOW, changes: c });

describe('buildCommitMessage subject', () => {
  test('no messages: sync <host> <ISO UTC without ms>', () => {
    expect(msg({})).toBe(`sync box ${ISO}`);
  });

  test('auto tag goes on the subject line', () => {
    const m = msg({ tag: 'auto', sources: ['backup'] }, [{ status: 'A', path: 'a.md' }]);
    expect(subjectOf(m)).toBe(`sync box ${ISO} (auto)`);
    expect(subjectOf(m)).toMatch(/^sync \S+ \S+Z \(auto\)$/);   // acceptance 14
    expect(m).toBe(`sync box ${ISO} (auto)\n\nChanged files:\nA\ta.md`);
  });

  test('the flush message becomes the text; its first line is the subject', () => {
    expect(msg({ messages: ['ten files'] })).toBe('ten files');
    expect(subjectOf(msg({ messages: ['title\n\nbody line'] }))).toBe('title');
  });

  test('(auto) is appended to the first line only, even with a multi-line message', () => {
    expect(msg({ messages: ['title\nmore'], tag: 'auto' })).toBe('title (auto)\nmore');
  });

  test('multiple messages: trimmed, empties and exact duplicates dropped, arrival order kept', () => {
    const m = msg({ messages: ['  second wins? no  ', '', 'first', '   ', 'second wins? no', 'third'] });
    expect(m).toBe('second wins? no\n\nfirst\n\nthird');
  });

  test('only blank messages fall back to the sync subject', () => {
    expect(msg({ messages: ['  ', '\n'] })).toBe(`sync box ${ISO}`);
  });
});

describe('buildCommitMessage changes footer', () => {
  test('status TAB path, one per line', () => {
    expect(msg({ messages: ['m'] }, [{ status: 'A', path: 'a.md' }, { status: 'D', path: 'sub/b c.md' }]))
      .toBe('m\n\nChanged files:\nA\ta.md\nD\tsub/b c.md');
  });

  test('exactly 20 files: no "more" line', () => {
    const m = msg({}, changes(MAX_LISTED_FILES));
    expect(MAX_LISTED_FILES).toBe(20);
    expect(m.split('\n').slice(3)).toHaveLength(20);
    expect(m).not.toContain('more');
  });

  test('more than 20: first 20 then "\u2026 and N more" (U+2026)', () => {
    const m = msg({}, changes(23));
    const lines = m.split('\n');
    expect(lines.slice(0, 3)).toEqual([`sync box ${ISO}`, '', 'Changed files:']);
    expect(lines.slice(3, 23)).toEqual(changes(20).map((c) => `${c.status}\t${c.path}`));
    expect(lines[23]).toBe('\u2026 and 3 more');
    expect(lines).toHaveLength(24);
  });

  test('no changes: no footer', () => {
    expect(msg({ messages: ['m'] }, [])).toBe('m');
  });
});

describe('buildConflictMessage', () => {
  const base = { host: 'box', now: NOW, kind: 'rebase' as const, copies: [], overridden: [], replayedSubjects: [] };

  test('subject only when every section is empty', () => {
    expect(buildConflictMessage(base)).toBe(`sync box ${ISO} (conflict)`);
    expect(subjectOf(buildConflictMessage({ ...base, kind: 'collision', copies: ['x'] }))).toBe(`sync box ${ISO} (conflict)`);
  });

  test('all three sections in order', () => {
    const m = buildConflictMessage({
      ...base,
      copies: ['note (conflict box 2026-10-08 1234).md'],
      overridden: [{ path: 'a.md', deletedBy: 'local' }, { path: 'b.md', deletedBy: 'remote' }],
      replayedSubjects: ['ten files', 'sync box 2026-10-08T10:00:00Z (auto)'],
    });
    expect(m).toBe([
      `sync box ${ISO} (conflict)`,
      '',
      'Conflict copies:',
      'note (conflict box 2026-10-08 1234).md',
      '',
      'Overridden deletes:',
      'a.md (deleted locally)',
      'b.md (deleted remotely)',
      '',
      'Replayed local commits:',
      'ten files',
      'sync box 2026-10-08T10:00:00Z (auto)',
    ].join('\n'));
  });

  test('empty sections are omitted', () => {
    const m = buildConflictMessage({ ...base, kind: 'stash', overridden: [{ path: 'x.md', deletedBy: 'remote' }] });
    expect(m).toBe(`sync box ${ISO} (conflict)\n\nOverridden deletes:\nx.md (deleted remotely)`);
  });

  test('each section is capped at 20 lines + "\u2026 and N more"', () => {
    const copies = Array.from({ length: 25 }, (_, i) => `c${i}`);
    const subjects = Array.from({ length: 21 }, (_, i) => `s${i}`);
    const m = buildConflictMessage({ ...base, copies, replayedSubjects: subjects });
    const [head, copySection, subjectSection] = m.split('\n\n');
    expect(head).toBe(`sync box ${ISO} (conflict)`);
    expect(copySection).toBe(['Conflict copies:', ...copies.slice(0, 20), '\u2026 and 5 more'].join('\n'));
    expect(subjectSection).toBe(['Replayed local commits:', ...subjects.slice(0, 20), '\u2026 and 1 more'].join('\n'));
  });
});

describe('subjectOf', () => {
  test('first line', () => {
    expect(subjectOf('a\nb\nc')).toBe('a');
    expect(subjectOf('only')).toBe('only');
    expect(subjectOf('')).toBe('');
    expect(subjectOf('crlf\r\nnext')).toBe('crlf');
  });
});
