// Atomic exchange and the per-filesystem probe.
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { casPut, digestAt, type Digest, writeTemp } from '../../src/cas';
import { exchange, renameNoReplace, reprobe, volumeCaps, volumeProbe } from '../../src/exchange';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-exchange-')));
let n = 0;

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function dir(): string {
  const d = join(base, `d${++n}`);
  mkdirSync(d);
  return d;
}

describe('exchange and renameNoReplace', () => {
  test.if(process.platform === 'darwin' || process.platform === 'linux')('the probe picks exchange here (APFS, ext4, tmpfs)', () => {
    const d = dir();
    const caps = volumeCaps(d);
    expect(caps.mode).toBe('exchange');
    expect(caps.noReplace).toBe('native');
    expect(readdirSync(d)).toEqual([]);   // the probe cleans up after itself
  });

  test('exchange swaps two entries; a missing side is an errno, nothing moves', () => {
    const d = dir();
    writeFileSync(join(d, 'a'), 'A');
    writeFileSync(join(d, 'b'), 'B');
    expect(exchange(join(d, 'a'), join(d, 'b'))).toBe('exchanged');
    expect(readFileSync(join(d, 'a'), 'utf8')).toBe('B');
    expect(readFileSync(join(d, 'b'), 'utf8')).toBe('A');
    expect(exchange(join(d, 'a'), join(d, 'missing'))).toEqual({ errno: 'ENOENT' });
    expect(readFileSync(join(d, 'a'), 'utf8')).toBe('B');
  });

  test('renameNoReplace never replaces, in every no-replace method', () => {
    for (const noReplace of ['native', 'link', 'excl-open'] as const) {
      const d = dir();
      writeFileSync(join(d, 'src'), 'mine');
      writeFileSync(join(d, 'taken'), 'theirs');
      expect(renameNoReplace(join(d, 'src'), join(d, 'taken'), { mode: 'exchange', noReplace })).toBe('exists');
      expect(readFileSync(join(d, 'taken'), 'utf8')).toBe('theirs');
      expect(renameNoReplace(join(d, 'src'), join(d, 'free'), { mode: 'exchange', noReplace })).toBe('renamed');
      expect(readFileSync(join(d, 'free'), 'utf8')).toBe('mine');
      expect(existsSync(join(d, 'src'))).toBe(false);
    }
  });

  test('MDSYNC_TEST_EXCHANGE_MODE caps the probe; reprobe never demotes on its own', () => {
    const d = dir();
    const before = volumeCaps(d).mode;
    reprobe(d);   // what a real call's EINVAL / ENOTSUP / ENOSYS / EXDEV does: the probe runs again
    expect(volumeCaps(d).mode).toBe(before);
    for (const cap of ['rename-only', 'copy-only'] as const) {
      process.env.MDSYNC_TEST_EXCHANGE_MODE = cap;
      try {
        reprobe(d);
        const p = volumeProbe(d);
        expect(p.caps.mode).toBe(cap);
        if (cap === 'copy-only') expect(p.caps.noReplace).toBe('excl-open');   // as on exFAT
        expect(p.error).not.toBe('none');
      } finally {
        delete process.env.MDSYNC_TEST_EXCHANGE_MODE;
        reprobe(d);
      }
    }
    expect(volumeCaps(d).mode).toBe(before);
  });
});

// exFAT: no hard links, no exchange, and RENAME_EXCL refuses only an absent target. macOS with hdiutil only.
const HDIUTIL = process.platform === 'darwin' && Bun.which('hdiutil') !== null;

describe('an exFAT volume', () => {
  test.if(HDIUTIL)('is copy-only, and a create still never replaces anything', async () => {
    const img = join(base, 'exfat.dmg');
    const mnt = join(base, 'exfat-mnt');
    mkdirSync(mnt);
    const mk = Bun.spawnSync(['hdiutil', 'create', '-quiet', '-size', '8m', '-fs', 'ExFAT', '-volname', 'MDSYNCX', img]);
    if (mk.exitCode !== 0) return;   // no exFAT support in this environment
    const at = Bun.spawnSync(['hdiutil', 'attach', '-quiet', '-nobrowse', '-mountpoint', mnt, img]);
    if (at.exitCode !== 0) return;
    try {
      const d = join(mnt, '.mdsync-1-1.d');
      mkdirSync(d);
      const caps = volumeCaps(d);
      expect(caps.mode).toBe('copy-only');
      writeFileSync(join(mnt, 'a.md'), 'theirs\n');
      writeFileSync(join(mnt, 'src'), 'mine\n');
      expect(writeTemp(mnt, '.mdsync-1-1.d/1', { kind: 'file', src: join(mnt, 'src'), exec: 'plain' })).toBe('written');
      const r = casPut(mnt, 'a.md', { kind: 'absent' }, { kind: 'file', src: join(mnt, 'src'), exec: 'plain' },
        { temp: '.mdsync-1-1.d/1', aside: '.mdsync-1-1.d/2' }, caps);
      expect(r.kind).toBe('changed');
      expect(readFileSync(join(mnt, 'a.md'), 'utf8')).toBe('theirs\n');
      writeTemp(mnt, '.mdsync-1-1.d/3', { kind: 'file', src: join(mnt, 'src'), exec: 'plain' });
      const ok = casPut(mnt, 'a.md', digestAt(mnt, 'a.md') as Digest, { kind: 'file', src: join(mnt, 'src'), exec: 'plain' },
        { temp: '.mdsync-1-1.d/3', aside: '.mdsync-1-1.d/4' }, caps);
      expect(ok.kind).toBe('done');
      expect(readFileSync(join(mnt, 'a.md'), 'utf8')).toBe('mine\n');
    } finally {
      Bun.spawnSync(['hdiutil', 'detach', '-quiet', '-force', mnt]);
    }
  }, 60_000);
});
