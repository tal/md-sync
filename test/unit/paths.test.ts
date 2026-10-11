import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  canonicalDir, defaultConfigPath, dirHash, ensureStateDir, expandHome, findSyncedAncestor, resolveDirInput,
  statePathsFor, xdgConfigHome, xdgStateHome,
} from '../../src/paths';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-paths-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function sha256Prefix(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 16);
}

describe('expandHome / resolveDirInput', () => {
  test('expands ~ and ~/x only', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/notes/a', '/h')).toBe('/h/notes/a');
    expect(expandHome('~other/x', '/h')).toBe('~other/x');
    expect(expandHome('notes/~', '/h')).toBe('notes/~');
    expect(expandHome('/abs', '/h')).toBe('/abs');
    expect(expandHome('~')).toBe(homedir());
  });

  test('resolves relative input against base, ~ against home', () => {
    expect(resolveDirInput('notes', '/base/dir')).toBe('/base/dir/notes');
    expect(resolveDirInput('../x', '/base/dir')).toBe('/base/x');
    expect(resolveDirInput('/abs/n', '/base')).toBe('/abs/n');
    expect(resolveDirInput('~/n', '/base')).toBe(join(homedir(), 'n'));
  });
});

describe('XDG defaults', () => {
  test('falls back to ~/.config and ~/.local/state on every platform', () => {
    const env = { HOME: '/home/u' };
    expect(xdgConfigHome(env)).toBe('/home/u/.config');
    expect(xdgStateHome(env)).toBe('/home/u/.local/state');
    expect(defaultConfigPath(env)).toBe('/home/u/.config/mdsync/config.json');
  });

  test('honors absolute XDG vars and ignores relative or empty ones', () => {
    expect(xdgConfigHome({ HOME: '/h', XDG_CONFIG_HOME: '/x/cfg' })).toBe('/x/cfg');
    expect(xdgStateHome({ HOME: '/h', XDG_STATE_HOME: '/x/state' })).toBe('/x/state');
    expect(xdgConfigHome({ HOME: '/h', XDG_CONFIG_HOME: 'rel/cfg' })).toBe('/h/.config');
    expect(xdgStateHome({ HOME: '/h', XDG_STATE_HOME: '' })).toBe('/h/.local/state');
    expect(defaultConfigPath({ HOME: '/h', XDG_CONFIG_HOME: '/x/cfg' })).toBe('/x/cfg/mdsync/config.json');
  });

  test('uses the OS home when HOME is unset', () => {
    expect(xdgStateHome({})).toBe(join(homedir(), '.local', 'state'));
  });
});

describe('dirHash / statePathsFor', () => {
  test('dirHash is sha256(realDir) hex, first 16 chars, stable', () => {
    expect(dirHash('/Users/tal/agent-notes')).toBe(sha256Prefix('/Users/tal/agent-notes'));
    expect(dirHash('/Users/tal/agent-notes')).toBe(dirHash('/Users/tal/agent-notes'));
    expect(dirHash('/Users/tal/agent-notes')).toMatch(/^[0-9a-f]{16}$/);
    expect(dirHash('/a')).not.toBe(dirHash('/a/'));   // callers pass realpaths, which have no trailing slash
    expect(dirHash('/a')).not.toBe(dirHash('/b'));
  });

  test('state file names live under <stateHome>/mdsync', () => {
    const p = statePathsFor('/data/notes', { HOME: '/h', XDG_STATE_HOME: '/s' });
    const h = sha256Prefix('/data/notes');
    expect(p).toEqual({
      stateDir: '/s/mdsync',
      hash: h,
      lock: `/s/mdsync/${h}.lock`,
      lockGuard: `/s/mdsync/${h}.lock.takeover`,
      sock: `/s/mdsync/${h}.sock`,
      state: `/s/mdsync/${h}.json`,
      stateTmp: `/s/mdsync/${h}.json.tmp`,
      journal: `/s/mdsync/${h}.journal.json`,
      log: `/s/mdsync/${h}.log`,
      tmp: `/s/mdsync/${h}.tmp`,
      rescue: `/s/mdsync/${h}.rescue`,
      localOnly: `/s/mdsync/${h}.local-only.json`,
    });
  });
});

describe('canonicalDir', () => {
  test('resolves symlinks to the real path', () => {
    const real = join(root, 'real');
    mkdirSync(real);
    symlinkSync(real, join(root, 'link'));
    expect(canonicalDir(join(root, 'link'))).toBe(real);
  });

  test('throws ENOENT for a missing dir', () => {
    expect(() => canonicalDir(join(root, 'missing'))).toThrow(/ENOENT/);
  });
});

describe('ensureStateDir', () => {
  test('creates the state dir 0700, parents included', () => {
    const env = { HOME: '/h', XDG_STATE_HOME: join(root, 'st1', 'deep') };
    const p = statePathsFor('/x', env);
    ensureStateDir(p);
    expect(statSync(p.stateDir).isDirectory()).toBe(true);
    expect(statSync(p.stateDir).mode & 0o777).toBe(0o700);
    ensureStateDir(p);   // idempotent
  });

  test('refuses a state dir that is a symlink (someone else may control its target)', () => {
    const env = { HOME: '/h', XDG_STATE_HOME: join(root, 'st-link') };
    const p = statePathsFor('/x', env);
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    mkdirSync(dirname(p.stateDir), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), p.stateDir);
    expect(() => ensureStateDir(p)).toThrow(/not a directory/);
  });

  test.skipIf(process.getuid?.() !== 0)('refuses a state dir owned by another user (root only: needs chown)', () => {
    const env = { HOME: '/h', XDG_STATE_HOME: join(root, 'st-foreign') };
    const p = statePathsFor('/x', env);
    mkdirSync(p.stateDir, { recursive: true, mode: 0o777 });
    chownSync(p.stateDir, 65534, 65534);
    expect(() => ensureStateDir(p)).toThrow(/owned by uid 65534/);
  });

  test('tightens an existing, too-open state dir', () => {
    const env = { HOME: '/h', XDG_STATE_HOME: join(root, 'st2') };
    const p = statePathsFor('/x', env);
    mkdirSync(p.stateDir, { recursive: true });
    chmodSync(p.stateDir, 0o755);
    ensureStateDir(p);
    expect(statSync(p.stateDir).mode & 0o777).toBe(0o700);
  });
});

describe('findSyncedAncestor', () => {
  const env = { HOME: '/h', XDG_STATE_HOME: join(root, 'state-find') };
  const synced = join(root, 'tree', 'synced');
  const deep = join(synced, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  const p = statePathsFor(synced, env);
  ensureStateDir(p);

  test('none when no ancestor has state files', () => {
    expect(findSyncedAncestor(deep, env)).toBe('none');
  });

  test('finds the ancestor by its <hash>.json, from deep inside and from the dir itself', () => {
    writeFileSync(p.state, '{}');
    expect(findSyncedAncestor(deep, env)).toBe(synced);
    expect(findSyncedAncestor(synced, env)).toBe(synced);
    expect(findSyncedAncestor(join(root, 'tree'), env)).toBe('none');
    rmSync(p.state);
  });

  test('a lock or a socket file also marks the folder', () => {
    writeFileSync(p.lock, '{}');
    expect(findSyncedAncestor(deep, env)).toBe(synced);
    rmSync(p.lock);
    writeFileSync(p.sock, '');
    expect(findSyncedAncestor(join(synced, 'a'), env)).toBe(synced);
    rmSync(p.sock);
  });

  test('the nearest synced ancestor wins', () => {
    const inner = join(synced, 'a');
    const pi = statePathsFor(inner, env);
    writeFileSync(p.state, '{}');
    writeFileSync(pi.state, '{}');
    expect(findSyncedAncestor(deep, env)).toBe(inner);
    rmSync(pi.state);
    rmSync(p.state);
  });
});
