// test/container-smoke.sh: it runs with `set -euo pipefail`, where `producer | grep -q` reports
// the producer's SIGPIPE (141) as a failure whenever grep exits early. r3: step 4 failed 499 runs in 500 that way,
// turning the container job, `ci` and every release red.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = readFileSync(join(import.meta.dir, '..', 'container-smoke.sh'), 'utf8');
const ROOT = join(import.meta.dir, '..', '..');

// Pinned toolchain: the image builds on the same Bun release as CI and the release binaries.
describe('Dockerfile', () => {
  test('its BUN_VERSION default is the release in .bun-version, and FROM uses it', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const pinned = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
    expect(/^ARG BUN_VERSION=(\S+)$/m.exec(dockerfile)?.[1]).toBe(pinned);
    expect(dockerfile).toMatch(/^FROM oven\/bun:\$\{BUN_VERSION\}-slim$/m);
  });
});

describe('container-smoke.sh', () => {
  test('runs with pipefail and never pipes into an early-exiting reader (grep -q, head)', () => {
    expect(SCRIPT).toContain('set -euo pipefail');
    const lines = SCRIPT.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(lines.filter((l) => /\|\s*(grep\s+-[a-zA-Z]*q|head\b)/.test(l))).toEqual([]);
  });

  test('has_line matches a captured output, whatever follows the match', () => {
    const fn = /^has_line\(\) \{[\s\S]*?^\}$/m.exec(SCRIPT)?.[0];
    expect(fn).toBeDefined();
    const run = (body: string): number =>
      Bun.spawnSync(['bash', '-c', `set -euo pipefail\n${fn}\n${body}`]).exitCode;
    expect(run('out=$(seq 1 200000); has_line exact 1 "$out"')).toBe(0);
    expect(run('out=$(printf "x.md\\nREADME.md\\n"); has_line exact x.md "$out"')).toBe(0);
    expect(run('out=$(printf "x.mdx\\n"); has_line exact x.md "$out"')).toBe(1);
    expect(run('out=$(printf \'{"msg":"daemon ready"}\\n\'); has_line fixed \'"msg":"daemon ready"\' "$out"')).toBe(0);
  });
});
