import { describe, expect, test } from 'bun:test';
import { renderWorkflow } from '../../src/workflow-template';

// What `md-sync print-workflow` prints for branch main, byte for byte. Users commit this file, so any change to it is
// a change every synced repo has to pick up by hand.
const MAIN_YAML = `# .github/workflows/mdsync-notify.yml
name: mdsync-notify
on:
  push:
    branches: [main]
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -o /dev/null -d "$GITHUB_SHA" "$NTFY_URL"
        env:
          NTFY_URL: \${{ secrets.MDSYNC_NTFY_URL }}
`;

const branchLine = (yaml: string): string | undefined => yaml.split('\n').find((l) => l.trimStart().startsWith('branches:'));

describe('renderWorkflow', () => {
  test('default output is the expected workflow byte-for-byte', () => {
    expect(renderWorkflow('main')).toBe(MAIN_YAML);
    expect(Buffer.from(renderWorkflow('main'))).toEqual(Buffer.from(MAIN_YAML));
  });

  test('only the branches line changes with the branch', () => {
    const base = MAIN_YAML.split('\n');
    const out = renderWorkflow('notes').split('\n');
    expect(out).toHaveLength(base.length);
    const diff = out.flatMap((l, i) => (l === base[i] ? [] : [[base[i], l]]));
    expect(diff).toEqual([['    branches: [main]', '    branches: [notes]']]);
  });

  test('plain names in the safe character class stay unquoted', () => {
    for (const b of ['master', 'release/v1.2', 'feature/x_y-z', 'Main.2']) {
      expect(branchLine(renderWorkflow(b))).toBe(`    branches: [${b}]`);
    }
  });

  test('anything outside the class is JSON-quoted', () => {
    expect(branchLine(renderWorkflow('my branch'))).toBe('    branches: ["my branch"]');
    expect(branchLine(renderWorkflow('a,b'))).toBe('    branches: ["a,b"]');
    expect(branchLine(renderWorkflow('x#y'))).toBe('    branches: ["x#y"]');
    expect(branchLine(renderWorkflow('quo"te'))).toBe('    branches: ["quo\\"te"]');
    expect(branchLine(renderWorkflow('café'))).toBe('    branches: ["café"]');
  });

  test('names YAML would not read back as a string are quoted', () => {
    for (const b of ['1.0', '2026-10-08', 'true', 'No', 'null', 'on', '0x1F', '.inf', '_x']) {
      expect(branchLine(renderWorkflow(b))).toBe(`    branches: [${JSON.stringify(b)}]`);
    }
  });

  test('GitHub filter glob characters are escaped so the branch matches literally', () => {
    expect(branchLine(renderWorkflow('c++'))).toBe('    branches: ["c\\\\+\\\\+"]');
    expect(branchLine(renderWorkflow('!hot'))).toBe('    branches: ["\\\\!hot"]');
    expect(branchLine(renderWorkflow('x]'))).toBe('    branches: ["x\\\\]"]');
  });

  test('quoted output is a valid YAML/JSON scalar that decodes to the filter pattern', () => {
    for (const b of ['my branch', 'c++', '1.0']) {
      const line = branchLine(renderWorkflow(b)) ?? '';
      const inner = line.slice(line.indexOf('[') + 1, line.lastIndexOf(']'));
      expect(JSON.parse(inner)).toBe(b.replace(/[*?+[\]!]/g, '\\$&'));
    }
  });
});
