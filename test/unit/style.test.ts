// AGENTS.md: no booleans for state or options (string-literal unions instead). Predicate return
// values and third-party options are the allowed exceptions, so this scans for the state shapes only.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const file of sources(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) out.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe('no boolean state', () => {
  test('no mutable boolean variables', () => {
    expect(hits(/\b(let|var)\s+\w+\s*(:\s*boolean\b|=\s*(true|false)\b)/)).toEqual([]);
  });

  test('no boolean fields in types (parseArgs values, a third-party shape, excepted)', () => {
    const parseArgsShape = (h: string): boolean => h.startsWith('commands/shared.ts:') && /\b(help|version)\?: boolean/.test(h);
    expect(hits(/^\s*(readonly\s+)?\w+\??\s*:\s*boolean\s*[;,]/).filter((h) => !parseArgsShape(h))).toEqual([]);
  });

  test('parseArgs booleans are read only at the CLI boundary, into an enum', () => {
    // allowed: cli.ts (help/version) and the one-line conversions in flush and install-service
    const raw = hits(/values\.\w+\s*===\s*true/).filter((h) => !h.startsWith('cli.ts:'));
    expect(raw.every((h) => /:\s*'[a-z-]+'\s*\|\s*'[a-z-]+'\s*=|: WaitMode =/.test(h))).toBe(true);
  });
});

describe('shared helpers have one copy (src/fsutil.ts)', () => {
  test('errCode, kindAt, properPrefixes, isRecord, homeOf and writeAllSync are defined only there', () => {
    const defs = hits(/^\s*(export\s+)?function\s+(errCode|kindAt|properPrefixes|isRecord|isPlainObject|homeOf|writeAllSync)\b/);
    expect(defs.map((h) => h.split(':')[0]).every((f) => f === 'fsutil.ts')).toBe(true);
    expect(defs.length).toBe(6);
  });
});
