// Per-path checked writes: every step of casPut, linkCopy and settleAside in all three
// exchange modes, with a writer injected at exactly the moment between the check and the switch (or around settle's
// unlink). Nothing a writer wrote may be lost: it is at the path, in a kept (raced) file, or in a replaced inode
// that settle keeps.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  casPut, copyOut, type Digest, digestAt, linkCopy, moveAside, settleAside, symlinkDigest, TEMP_DIR_RE, writeTemp,
} from '../../src/cas';
import { type VolumeCaps, volumeCaps } from '../../src/exchange';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-cas-')));
const TEMP = '.mdsync-7-7.d';
let n = 0;

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const MODES: Record<'exchange' | 'rename-only' | 'copy-only', () => VolumeCaps> = {
  exchange: () => volumeCaps(join(fresh(), TEMP)),
  'rename-only': () => ({ mode: 'rename-only', noReplace: 'link' }),
  'copy-only': () => ({ mode: 'copy-only', noReplace: 'excl-open' }),
};

function fresh(): string {
  const root = join(base, `r${++n}`);
  mkdirSync(join(root, TEMP), { recursive: true });
  return root;
}

// a root with `a.md` = OLD, and NEW ready as the version to put
function scene(): { root: string; src: string; names: { temp: string; aside: string } } {
  const root = fresh();
  writeFileSync(join(root, 'a.md'), 'OLD\n');
  const src = join(root, 'src-new');
  writeFileSync(src, 'NEW\n');
  const names = { temp: `${TEMP}/${++n}`, aside: `${TEMP}/${++n}` };
  return { root, src, names };
}

// every byte under the root, temp folder included
function everything(root: string): string {
  let out = '';
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isSymbolicLink()) out += readlinkSync(join(d, e.name));
      else out += readFileSync(join(d, e.name), 'utf8');
    }
  };
  walk(root);
  return out;
}

const WRITERS = {
  append: (p: string) => appendFileSync(p, 'AGENT\n'),
  rewrite: (p: string) => writeFileSync(p, 'AGENT REWROTE\n'),
  'atomic save': (p: string) => {
    writeFileSync(`${p}.sb`, 'AGENT SAVED\n');
    renameSync(`${p}.sb`, p);
  },
} as const;

describe.each(Object.keys(MODES) as (keyof typeof MODES)[])('%s mode', (mode) => {
  const caps = MODES[mode]();

  test('C3–C5: an unchanged file is replaced; its old inode waits as an aside and settles clean', () => {
    const { root, src, names } = scene();
    const expect0 = digestAt(root, 'a.md') as Digest;
    expect(writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' })).toBe('written');
    const r = casPut(root, 'a.md', expect0, { kind: 'file', src, exec: 'plain' }, names, caps);
    expect(r.kind).toBe('done');
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('NEW\n');
    if (r.kind !== 'done' || r.aside === 'none') throw new Error('an aside was expected');
    expect(readFileSync(join(root, r.aside.name), 'utf8')).toBe('OLD\n');
    expect(settleAside(root, r.aside)).toEqual({ kind: 'clean' });
    expect(existsSync(join(root, r.aside.name))).toBe(false);
  });

  for (const [what, write] of Object.entries(WRITERS)) {
    test(`a writer's ${what} between the check and the switch is never lost`, () => {
      const { root, src, names } = scene();
      const expect0 = digestAt(root, 'a.md') as Digest;
      writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
      const r = casPut(root, 'a.md', expect0, { kind: 'file', src, exec: 'plain' }, names, caps,
        { afterCheck: () => write(join(root, 'a.md')) });
      expect(r.kind === 'error').toBe(false);
      if (r.kind === 'done' && r.aside !== 'none') {
        // an in-place write reached the replaced inode: settle keeps it, never unlinks it
        const s = settleAside(root, r.aside);
        expect(s.kind).toBe('late');
      }
      expect(everything(root)).toContain('AGENT');
      // the path holds either our version or the agent's: never a mixture we made up
      expect(['NEW\n', 'AGENT SAVED\n', 'OLD\nAGENT\n', 'AGENT REWROTE\n']).toContain(readFileSync(join(root, 'a.md'), 'utf8'));
    });
  }

  test('a rename-and-create save (vim style) between the check and the switch is changed or raced, never an error', () => {
    const { root, src, names } = scene();
    const expect0 = digestAt(root, 'a.md') as Digest;
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    const r = casPut(root, 'a.md', expect0, { kind: 'file', src, exec: 'plain' }, names, caps, { afterCheck: () => {
      renameSync(join(root, 'a.md'), join(root, 'a.md~'));
      writeFileSync(join(root, 'a.md'), 'VIM SAVED\n');
    } });
    expect(['changed', 'raced']).toContain(r.kind);
    expect(everything(root)).toContain('VIM SAVED');
    expect(readFileSync(join(root, 'a.md~'), 'utf8')).toBe('OLD\n');
  });

  test('the path vanishes between the check and the switch: changed, never an error', () => {
    const { root, src, names } = scene();
    const expect0 = digestAt(root, 'a.md') as Digest;
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    const r = casPut(root, 'a.md', expect0, { kind: 'file', src, exec: 'plain' }, names, caps, { afterCheck: () => {
      renameSync(join(root, 'a.md'), join(root, 'moved.md'));
    } });
    expect(['changed', 'raced']).toContain(r.kind);
    expect(everything(root)).toContain('OLD');
  });

  test('a file that changed before the check is never replaced (changed), and our temp is removed', () => {
    const { root, src, names } = scene();
    const expect0 = digestAt(root, 'a.md') as Digest;
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    writeFileSync(join(root, 'a.md'), 'EDITED\n');
    const r = casPut(root, 'a.md', expect0, { kind: 'file', src, exec: 'plain' }, names, caps);
    expect(r.kind).toBe('changed');
    expect(readFileSync(join(root, 'a.md'), 'utf8')).toBe('EDITED\n');
    expect(existsSync(join(root, names.temp))).toBe(false);
  });

  test('C2: a create never replaces what someone created in the window', () => {
    const { root, src, names } = scene();
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    const r = casPut(root, 'new/b.md', { kind: 'absent' }, { kind: 'file', src, exec: 'plain' }, names, caps,
      { afterCheck: () => writeFileSync(join(root, 'new', 'b.md'), 'AGENT CREATED\n') });
    expect(r.kind).toBe('changed');
    expect(readFileSync(join(root, 'new', 'b.md'), 'utf8')).toBe('AGENT CREATED\n');
    const ok = casPut(root, 'new/c.md', { kind: 'absent' }, { kind: 'file', src, exec: 'plain' },
      { temp: `${TEMP}/${++n}`, aside: `${TEMP}/${++n}` }, caps);
    expect(ok.kind).toBe('changed');   // its temp was never written: nothing to create from
  });

  test('C4: a delete moves the inode aside and verifies it; an atomic save in the window is put back', () => {
    const { root, names } = scene();
    const expect0 = digestAt(root, 'a.md') as Digest;
    const d = casPut(root, 'a.md', expect0, { kind: 'absent' }, names, caps);
    expect(d.kind).toBe('done');
    expect(existsSync(join(root, 'a.md'))).toBe(false);
    const s2 = scene();
    const e2 = digestAt(s2.root, 'a.md') as Digest;
    const r = casPut(s2.root, 'a.md', e2, { kind: 'absent' }, s2.names, caps, { afterCheck: () => WRITERS['atomic save'](join(s2.root, 'a.md')) });
    expect(r.kind).toBe('changed');
    expect(readFileSync(join(s2.root, 'a.md'), 'utf8')).toBe('AGENT SAVED\n');
    const s3 = scene();
    const e3 = digestAt(s3.root, 'a.md') as Digest;
    const a = casPut(s3.root, 'a.md', e3, { kind: 'absent' }, s3.names, caps, { afterCheck: () => WRITERS.append(join(s3.root, 'a.md')) });
    expect(a.kind).toBe('done');
    if (a.kind === 'done' && a.aside !== 'none') expect(settleAside(s3.root, a.aside).kind).toBe('late');
    expect(everything(s3.root)).toContain('AGENT');
  });

  test('a symlinked parent folder is in the way: changed, and nothing is written through it', () => {
    const { root, src, names } = scene();
    const outside = join(base, `outside-${++n}`);
    mkdirSync(outside);
    symlinkSync(outside, join(root, 'linked'));
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    const r = casPut(root, 'linked/x.md', { kind: 'absent' }, { kind: 'file', src, exec: 'plain' }, names, caps);
    expect(r.kind).toBe('changed');
    expect(readdirSync(outside)).toEqual([]);
  });

  test('linkCopy: a hard link (or a byte copy without links); a symlink is copied as a symlink, never its target', () => {
    const { root } = scene();
    const r = linkCopy(root, 'a.md', 'a copy.md', digestAt(root, 'a.md') as Digest, caps);
    expect(r === 'changed' || r === 'taken').toBe(false);
    if (mode === 'copy-only') expect(r).toEqual({ kind: 'copied' });
    else expect(r).toMatchObject({ kind: 'linked' });
    expect(readFileSync(join(root, 'a copy.md'), 'utf8')).toBe('OLD\n');
    expect(linkCopy(root, 'a.md', 'a copy.md', 'any', caps)).toBe('taken');
    writeFileSync(join(root, 'target.md'), 'T\n');
    symlinkSync('target.md', join(root, 'link.md'));
    expect(linkCopy(root, 'link.md', 'link copy.md', 'any', caps)).toEqual({ kind: 'copied' });
    expect(lstatSync(join(root, 'link copy.md')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'link copy.md'))).toBe('target.md');
    expect(lstatSync(join(root, 'target.md')).nlink).toBe(1);
    // a changed file is never copied as if it held the expected bytes
    writeFileSync(join(root, 'a.md'), 'CHANGED\n');
    expect(linkCopy(root, 'a.md', 'another.md', { kind: 'file', size: 4, sha256: 'x' }, caps)).toBe('changed');
  });

  test('identity mode: an inode captured by a copy is replaced without a content check; settle unlinks it by inode', () => {
    if (mode === 'copy-only') return;   // identity in copy-only mode is C5c without a check
    const { root, src, names } = scene();
    expect(linkCopy(root, 'a.md', 'cap.md', 'any', caps)).toMatchObject({ kind: 'linked' });
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    const r = casPut(root, 'a.md', { kind: 'inode', copy: 'cap.md' }, { kind: 'file', src, exec: 'plain' }, names, caps,
      { afterCheck: () => appendFileSync(join(root, 'a.md'), 'LATE IN PLACE\n') });
    expect(r.kind).toBe('done');
    expect(readFileSync(join(root, 'cap.md'), 'utf8')).toBe('OLD\nLATE IN PLACE\n');   // the copy shares the inode
    if (r.kind === 'done' && r.aside !== 'none') {
      expect(r.aside.copy).toBe('cap.md');
      expect(settleAside(root, r.aside)).toEqual({ kind: 'clean' });
    }
  });

  // chaos seed 103: the conflict copy hard-links the replaced inode. An agent's edit of the copy (in place, or after
  // renaming it) is not a late write: the copy keeps it, so settle must not link that inode under a second copy name.
  test('a put records the conflict copy that links the replaced inode: edits of the copy (renamed or not) settle clean', () => {
    if (mode === 'copy-only') return;   // no hard links: the copy is a byte copy with an inode of its own
    for (const agent of ['edit in place', 'rename, then edit'] as const) {
      const { root, src, names } = scene();
      expect(linkCopy(root, 'a.md', 'a (conflict t 2026-10-08 1234).md', digestAt(root, 'a.md') as Digest, caps)).toMatchObject({ kind: 'linked' });
      writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
      const r = casPut(root, 'a.md', digestAt(root, 'a.md') as Digest, { kind: 'file', src, exec: 'plain' },
        { ...names, copy: 'a (conflict t 2026-10-08 1234).md' }, caps);
      expect(r.kind).toBe('done');
      if (r.kind !== 'done' || r.aside === 'none') throw new Error('aside');
      expect(r.aside.copy).toBe('a (conflict t 2026-10-08 1234).md');
      let copy = 'a (conflict t 2026-10-08 1234).md';
      if (agent === 'rename, then edit') {
        renameSync(join(root, copy), join(root, 'moved.md'));
        copy = 'moved.md';
      }
      appendFileSync(join(root, copy), 'AGENT EDITED THE COPY\n');
      expect(settleAside(root, r.aside)).toEqual({ kind: 'clean' });
      expect(readFileSync(join(root, copy), 'utf8')).toBe('OLD\nAGENT EDITED THE COPY\n');
      expect(lstatSync(join(root, copy)).nlink).toBe(1);
      expect(readdirSync(join(root, TEMP))).toEqual([]);
    }
  });

  test('an aside with a recorded copy whose inode nothing else links any more still settles by content', () => {
    if (mode === 'copy-only') return;
    const { root, src, names } = scene();
    linkCopy(root, 'a.md', 'c.md', 'any', caps);
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    const r = casPut(root, 'a.md', digestAt(root, 'a.md') as Digest, { kind: 'file', src, exec: 'plain' }, { ...names, copy: 'c.md' }, caps);
    if (r.kind !== 'done' || r.aside === 'none') throw new Error('aside');
    appendFileSync(join(root, 'c.md'), 'WRITTEN, THEN THE COPY WAS DELETED\n');
    unlinkSync(join(root, 'c.md'));
    expect(settleAside(root, r.aside)).toEqual({ kind: 'late', kept: r.aside.name });   // the only name left: kept
  });
});

describe('settleAside (S1–S5)', () => {
  const caps = MODES.exchange();

  function replaced(): { root: string; aside: Exclude<ReturnType<typeof casPut>, { kind: 'changed' | 'raced' | 'error' }>['aside'] } {
    const { root, src, names } = scene();
    writeTemp(root, names.temp, { kind: 'file', src, exec: 'plain' });
    const r = casPut(root, 'a.md', digestAt(root, 'a.md') as Digest, { kind: 'file', src, exec: 'plain' }, names, caps);
    if (r.kind !== 'done') throw new Error(r.kind);
    return { root, aside: r.aside };
  }

  test('S1: gone -> clean; another inode at the name -> late, never unlinked', () => {
    const { root, aside } = replaced();
    if (aside === 'none') throw new Error('aside');
    unlinkSync(join(root, aside.name));
    expect(settleAside(root, aside)).toEqual({ kind: 'clean' });
    writeFileSync(join(root, aside.name), 'someone else\n');
    expect(settleAside(root, aside)).toEqual({ kind: 'late', kept: aside.name });
    expect(existsSync(join(root, aside.name))).toBe(true);
  });

  test('S4/S5: a write that reaches the inode during the unlink is caught through settle\'s own descriptor', () => {
    const { root, aside } = replaced();
    if (aside === 'none') throw new Error('aside');
    // a writer that opened the old version before the switch and writes during the unlink
    const fd = openSync(join(root, aside.name), constants.O_WRONLY | constants.O_APPEND);
    const s = settleAside(root, aside, { afterUnlink: () => writeSync(fd, 'STALLED WRITE\n') });
    closeSync(fd);
    expect(s.kind).toBe('writing');
    if (s.kind !== 'writing') return;
    const copy = copyOut(root, s.fd, 'a (conflict test 2026-10-08 1234).md');
    // copyOut leaves the descriptor open: when a name can't be made, it is the only reference to these bytes
    expect(() => copyOut(root, s.fd, 'blocked/x.md'.replace('blocked', 'a.md'))).toThrow();
    expect(copyOut(root, s.fd, 'a (conflict test 2026-10-08 1234 2).md')).toBe('a (conflict test 2026-10-08 1234 2).md');
    closeSync(s.fd);
    expect(readFileSync(join(root, copy), 'utf8')).toBe('OLD\nSTALLED WRITE\n');
  });

  test('a symlink aside settles at once: clean when it is the replaced target, late otherwise', () => {
    const root = fresh();
    symlinkSync('old-target', join(root, 'l'));
    const src = join(root, 'src');
    const names = { temp: `${TEMP}/${++n}`, aside: `${TEMP}/${++n}` };
    writeTemp(root, names.temp, { kind: 'symlink', target: 'new-target' });
    const r = casPut(root, 'l', symlinkDigest('old-target'), { kind: 'symlink', target: 'new-target' }, names, caps);
    void src;
    expect(r.kind).toBe('done');
    expect(readlinkSync(join(root, 'l'))).toBe('new-target');
    if (r.kind === 'done' && r.aside !== 'none') expect(settleAside(root, r.aside)).toEqual({ kind: 'clean' });
  });
});

describe('moveAside and TEMP_DIR_RE', () => {
  test('a folder moves whole, never replacing anything', () => {
    const root = fresh();
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'd', 'x.md'), 'x\n');
    mkdirSync(join(root, 'taken'));
    expect(moveAside(root, 'd', 'taken')).toBe('taken');
    expect(moveAside(root, 'd', 'd (conflict)')).toBe('moved');
    expect(readFileSync(join(root, 'd (conflict)', 'x.md'), 'utf8')).toBe('x\n');
    expect(moveAside(root, 'd', 'elsewhere')).toBe('missing');
  });

  test('matches the temp folder and everything in it, nothing else', () => {
    expect(TEMP_DIR_RE.test('.mdsync-12-34.d')).toBe(true);
    expect(TEMP_DIR_RE.test('.mdsync-12-34.d/5')).toBe(true);
    expect(TEMP_DIR_RE.test('mnt/.mdsync-12-34.d/5')).toBe(true);
    expect(TEMP_DIR_RE.test('notes/.mdsync-x.d')).toBe(false);
    expect(TEMP_DIR_RE.test('my.mdsync-1-2.d')).toBe(false);
  });
});
