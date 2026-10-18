import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statePathsFor } from '../../src/paths';
import type { StatePaths } from '../../src/paths';
import { readJournal, readState, updateJournal, writeJournal, writeState } from '../../src/state';
import type { LastRun, RebaseJournal, StashJournal, StateFile } from '../../src/state';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-state-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
let paths: StatePaths;
beforeEach(() => {
  paths = statePathsFor(join(root, `dir-${++n}`), { HOME: root, XDG_STATE_HOME: join(root, `state-${n}`) });
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
});

const lastRun: LastRun = {
  runId: 3, kind: 'commit', mode: 'normal', reasons: ['flush'], outcome: 'ok', commitStep: 'committed', commitsIn: 1,
  commitsOut: 2, head: 'a'.repeat(40), committed: 'b'.repeat(40), conflicts: [], overriddenDeletes: [], keptStashes: [],
  startedAt: '2026-10-08T12:00:00.000Z', durationMs: 830, finishedAt: '2026-10-08T12:00:00.830Z',
};

const state: StateFile = {
  version: 1, dir: '/Users/x/notes', pid: 4242, updatedAt: '2026-10-08T12:00:01.000Z',
  instance: { configPath: '/Users/x/.config/mdsync/notes.json', cli: { idleMs: 120_000, ignore: ['drafts/'] } },
  lastRun, lastOkAt: '2026-10-08T12:00:00.830Z', consecutiveFailures: 0,
  keptStashes: [{ sha: 'c'.repeat(40), reason: 'write-raced', at: '2026-10-08T11:00:00.000Z' }],
  stuck: { head: 'd'.repeat(40), remote: 'e'.repeat(40), outcome: 'failed', error: 'boom', since: '2026-10-08T10:00:00.000Z' },
  integrated: 'f'.repeat(40),
  ntfy: { state: 'connected', since: '2026-10-08T11:59:00.000Z', lastConnectedAt: '2026-10-08T11:59:00.000Z',
    lastDisconnectedAt: '2026-10-08T11:58:00.000Z', lastError: 'stream ended', lastMessageAt: '2026-10-08T12:00:00.000Z',
    lastEventAt: '2026-10-08T11:59:30.000Z', lastEventSha: 'a'.repeat(40), reconnects: 2 },
};

const rebase: RebaseJournal = {
  op: 'rebase-conflict', phase: 'planned', local: 'l'.repeat(40), remote: 'r'.repeat(40), target: 'c'.repeat(40),
  stash: 'none', copies: ['a (conflict h 2026-10-08 1200).md'], overridden: [{ path: 'gone.md', deletedBy: 'remote' }],
  startedAt: '2026-10-08T12:00:00.000Z',
};
const stash: StashJournal = {
  op: 'stash-replay', phase: 'reset', stash: 's'.repeat(40), head: 'h'.repeat(40), target: 'h'.repeat(40),
  workTree: 't'.repeat(40), writes: ['a.md'], deletes: ['b.md'], copies: [], overridden: [],
  startedAt: '2026-10-08T12:00:00.000Z',
};

const stateDirEntries = () => readdirSync(paths.stateDir).sort();

describe('state file', () => {
  test('round trip, atomic via <hash>.json.tmp (nothing left behind), mode 0600', () => {
    writeState(paths, state);
    expect(readState(paths.state)).toEqual(state);
    expect(existsSync(paths.stateTmp)).toBe(false);
    expect(stateDirEntries()).toEqual([`${paths.hash}.json`]);
    expect(statSync(paths.state).mode & 0o777).toBe(0o600);
  });

  test('overwrites the previous state and any leftover tmp file', () => {
    writeState(paths, state);
    writeFileSync(paths.stateTmp, 'half-written garbage');
    const next: StateFile = { ...state, consecutiveFailures: 2, nextRetryAt: '2026-10-08T12:05:00.000Z' };
    delete next.stuck;
    writeState(paths, next);
    expect(readState(paths.state)).toEqual(next);
    expect(existsSync(paths.stateTmp)).toBe(false);
  });

  test('creates a missing state dir', () => {
    rmSync(paths.stateDir, { recursive: true, force: true });
    writeState(paths, state);
    expect(readState(paths.state)).toEqual(state);
  });

  test('missing or unparsable => none', () => {
    expect(readState(paths.state)).toBe('none');
    for (const bad of ['', '{', '[]', 'null', '42', '{"version":2,"dir":"/x"}', '{"version":1}']) {
      writeFileSync(paths.state, bad);
      expect(readState(paths.state)).toBe('none');
    }
  });

  test('a minimal or partly damaged file is normalized, not rejected', () => {
    writeFileSync(paths.state, JSON.stringify({
      version: 1, dir: '/d', keptStashes: [{ sha: 'x', reason: 'failed', at: 't' }, { sha: 1 }, 'junk', { sha: 'y', reason: 'nope', at: 't' }],
      consecutiveFailures: -3, lastRun: { nonsense: true }, stuck: { head: 'h' }, instance: { configPath: 'none', cli: {} },
      integrated: 'not a sha',
    }));
    expect(readState(paths.state)).toEqual({
      version: 1, dir: '/d', pid: 0, updatedAt: '', consecutiveFailures: 0,
      keptStashes: [{ sha: 'x', reason: 'failed', at: 't' }],
      instance: { configPath: 'none', cli: {} },
    });
  });
});

describe('state file: ntfy health', () => {
  const base = { version: 1, dir: '/d' };
  const read = (ntfy: unknown) => {
    writeFileSync(paths.state, JSON.stringify({ ...base, ntfy }));
    const s = readState(paths.state);
    return s === 'none' ? 'none' : s.ntfy;
  };

  test('a minimal record is kept; unknown keys are dropped', () => {
    expect(read({ state: 'disconnected', since: 't', reconnects: 0, url: 'https://ntfy.sh/topic' }))
      .toEqual({ state: 'disconnected', since: 't', reconnects: 0 });
  });

  test('a malformed record is dropped, and the rest of the file is kept', () => {
    for (const bad of [
      'connected', null, [], {},
      { state: 'up', since: 't', reconnects: 0 },
      { state: 'connected', reconnects: 0 },
      { state: 'connected', since: 't' },
      { state: 'connected', since: 't', reconnects: -1 },
      { state: 'connected', since: 't', reconnects: 1.5 },
      { state: 'connected', since: 't', reconnects: 0, lastMessageAt: 5 },
      { state: 'connected', since: 't', reconnects: 0, lastEventSha: null },
    ]) {
      expect(read(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('journal', () => {
  test('round trip with both parts; atomic (no tmp left)', () => {
    writeJournal(paths.journal, { rebase, stash });
    expect(readJournal(paths.journal)).toEqual({ rebase, stash });
    expect(existsSync(`${paths.journal}.tmp`)).toBe(false);
    expect(statSync(paths.journal).mode & 0o777).toBe(0o600);
  });

  test('writing {} deletes the file (and is fine when there is none)', () => {
    writeJournal(paths.journal, { rebase });
    writeJournal(paths.journal, {});
    expect(existsSync(paths.journal)).toBe(false);
    expect(() => writeJournal(paths.journal, {})).not.toThrow();
    expect(readJournal(paths.journal)).toBe('none');
  });

  test('missing, unparsable or both parts absent => none', () => {
    expect(readJournal(paths.journal)).toBe('none');
    for (const bad of ['', '{', '[]', '{}', '{"other":1}']) {
      writeFileSync(paths.journal, bad);
      expect(readJournal(paths.journal)).toBe('none');
    }
  });

  test('a malformed part counts as absent', () => {
    writeFileSync(paths.journal, JSON.stringify({ rebase: { ...rebase, phase: 'bogus' }, stash }));
    expect(readJournal(paths.journal)).toEqual({ stash });
    writeFileSync(paths.journal, JSON.stringify({ rebase, stash: { ...stash, op: 'rebase-conflict' } }));
    expect(readJournal(paths.journal)).toEqual({ rebase });
    writeFileSync(paths.journal, JSON.stringify({ rebase: { ...rebase, copies: 'x' } }));
    expect(readJournal(paths.journal)).toBe('none');
  });

  test('updateJournal sets one part and keeps the other; clearing the last part deletes the file', () => {
    updateJournal(paths.journal, 'rebase', rebase);
    expect(readJournal(paths.journal)).toEqual({ rebase });
    updateJournal(paths.journal, 'stash', stash);
    expect(readJournal(paths.journal)).toEqual({ rebase, stash });
    const reset: RebaseJournal = { ...rebase, phase: 'reset', stash: 'f'.repeat(40) };
    updateJournal(paths.journal, 'rebase', reset);
    expect(readJournal(paths.journal)).toEqual({ rebase: reset, stash });
    updateJournal(paths.journal, 'rebase', 'clear');
    expect(readJournal(paths.journal)).toEqual({ stash });
    updateJournal(paths.journal, 'stash', 'clear');
    expect(existsSync(paths.journal)).toBe(false);
    expect(() => updateJournal(paths.journal, 'stash', 'clear')).not.toThrow();
    expect(stateDirEntries()).toEqual([]);
  });

  test('updateJournal overwrites an unparsable journal', () => {
    writeFileSync(paths.journal, '{ torn');
    updateJournal(paths.journal, 'stash', stash);
    expect(readJournal(paths.journal)).toEqual({ stash });
  });

  test('a part with the wrong op is a programmer error', () => {
    expect(() => updateJournal(paths.journal, 'rebase', stash)).toThrow();
    expect(() => updateJournal(paths.journal, 'stash', rebase)).toThrow();
    expect(() => writeJournal(paths.journal, { rebase: stash as unknown as RebaseJournal })).toThrow();
    expect(existsSync(paths.journal)).toBe(false);
  });

  test('the file on disk is plain JSON with only the present parts', () => {
    updateJournal(paths.journal, 'stash', stash);
    expect(Object.keys(JSON.parse(readFileSync(paths.journal, 'utf8')) as object)).toEqual(['stash']);
  });
});
