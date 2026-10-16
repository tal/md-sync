// File watching: ignore rules, gitignored-dir pruning, per-path throttling and 250 ms batching.
// macOS: one recursive fs.watch on the root (a single FSEvents stream). Elsewhere: stat polling, no fs.watch.
import { watch as chokidarWatch } from 'chokidar';
import { type Dirent, type FSWatcher, lstatSync, type Stats, watch as fsWatch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { TEMP_DIR_RE } from './cas';   // the worktree move's temp folders: our own writes, never a local change
import { errCode } from './fsutil';
import type { IgnoreMatcher } from './ignore';
import type { Logger } from './log';

export type WatcherHandle = {
  close(): Promise<void>;
  setIgnoredDirs(dirs: readonly string[]): void;
  setIgnore(ignore: IgnoreMatcher): void;   // swap the `ignore` matcher in place (no new watcher)
  latencyMs(): number;                      // the longest a write can take to reach onBatch (poll: one scan interval)
};

// fsevents: a single FSEvents stream for the whole tree (macOS).
// poll: lstat()/readdir() polling (Linux, containers). Bun's per-path fs.watch, which chokidar uses for every file
//   and folder, takes its watcher mutex and its path-watcher mutex in opposite orders on the inotify thread and the
//   main thread (bun 1.3.13 path_watcher.zig, INotifyWatcher.zig): closing a watch while events arrive (deleting a
//   populated folder, a shutdown, a watcher restart) deadlocked the process. It also open()s every entry of a
//   watched folder, blocking on a FIFO with a lock held, and drops child events whose name starts with '.' (a new
//   .gitignore, an atomic save). Polling opens no file and needs no inotify watches.
// chokidar: no longer used by any platform (kept for comparison until Bun fixes the lock order).
export type WatcherBackend = 'fsevents' | 'poll' | 'chokidar';

export function watcherBackendFor(platform: NodeJS.Platform): WatcherBackend {
  return platform === 'darwin' ? 'fsevents' : 'poll';
}

// The poll backend scans at most this often, and waits at least POLL_LOAD times as long as its last scan cost, in CPU
// time across all threads (lstat runs on Bun's thread pool: 2-3x the scan's wall time) or wall time, whichever is
// larger. So a scan costs at most ~1/POLL_LOAD of one core. A write reaches the daemon up to one interval late, so the
// daemon's idle timer never runs shorter than two intervals.
export const POLL_MIN_MS = 2_000;
const POLL_LOAD = 10;
const POLL_CONCURRENCY = 64;

// After a path is reported it is held back this long: a file written continuously (an app log, a database) is
// reported once per window, not once per batch, and the last write in a window is still reported when it ends.
export const REPORT_THROTTLE_MS = 2_000;
// FSEvents can hand over a write made just before the stream started; ignoreInitial semantics: not ours to report.
const STARTUP_WINDOW_MS = 1_000;
// How much older than a reload a newly un-ignored entry must look before the poll scan takes it for one that existed
// before it. File times come from another clock: Linux stamps them from a coarse kernel clock that runs behind
// Date.now() (by up to a tick), FAT keeps mtime in 2 s steps and HFS+ in 1 s. An entry inside the slack is reported:
// an extra report only arms the backup timers, a missed one leaves a new note unsynced until something else changes.
export const RULES_CLOCK_SLACK_MS = 2_000;
const PRUNE_AT = 2_000;

const BATCHED_EVENTS: ReadonlySet<string> = new Set(['add', 'change', 'unlink', 'addDir', 'unlinkDir']);

function dirSet(dirs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const d of dirs) {
    const rel = d.replace(/^\.\//, '').replace(/\/+$/, '');
    if (rel !== '') out.add(rel);
  }
  return out;
}

function outsideRoot(rel: string): boolean {
  return rel === '' || rel === '.' || rel === '..' || rel.startsWith('../');
}

function inGitDir(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/') || rel.endsWith('/.git') || rel.includes('/.git/');
}


// FIFOs, sockets and devices: git never tracks them, and opening a FIFO to watch it blocks the whole process until
// a writer appears (macOS fs.watch opens every watched path).
function specialFile(st: Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink'>): boolean {
  return !st.isFile() && !st.isDirectory() && !st.isSymbolicLink();
}

// mtime of a file or symlink; 'none' for anything else (gone, a folder).
function fileMtime(abs: string): number | 'none' {
  try {
    const st = lstatSync(abs);
    return st.isFile() || st.isSymbolicLink() ? st.mtimeMs : 'none';
  } catch {
    return 'none';
  }
}

// Last content or inode change (a rename into the folder sets ctime); 'none' when the path is gone.
function changedAt(abs: string): number | 'none' {
  try {
    const st = lstatSync(abs);
    return Math.max(st.mtimeMs, st.ctimeMs);
  } catch {
    return 'none';
  }
}

// The current ignore rules: `.git`, gitignored dirs (and everything under them) and the `ignore` matcher. Both are
// swapped in place on reload.
class Rules {
  constructor(public dirs: Set<string>, public matcher: IgnoreMatcher) {}

  // Called for every path considered (repo-relative), so it has to stay cheap. `matches` replaces the matcher call
  // (the poll scan passes a cached one: every entry against every glob, on every scan, was a third of its CPU).
  ignored(rel: string, matches: (rel: string) => boolean = this.matcher.matches): boolean {
    if (outsideRoot(rel)) return false;
    if (inGitDir(rel) || TEMP_DIR_RE.test(rel)) return true;
    if (this.dirs.has(rel)) return true;
    for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
      if (this.dirs.has(rel.slice(0, i))) return true;
    }
    return matches(rel);
  }
}

// Matcher results of the previous scan, reused while the matcher is the same object; only the paths seen in this
// scan are carried over, so it never outgrows the tree.
class MatchCache {
  #matcher: IgnoreMatcher | undefined;
  #prev = new Map<string, boolean>();
  #next = new Map<string, boolean>();

  begin(matcher: IgnoreMatcher): (rel: string) => boolean {
    if (matcher.globs.length === 0) return () => false;   // no `ignore` patterns: nothing to cache
    if (matcher !== this.#matcher) {
      this.#matcher = matcher;
      this.#prev = new Map();
    }
    this.#next = new Map();
    return (rel) => {
      let v = this.#prev.get(rel);
      if (v === undefined) v = matcher.matches(rel);
      this.#next.set(rel, v);
      return v;
    };
  }

  end(): void {
    this.#prev = this.#next;
    this.#next = new Map();
  }
}

// Batching (a fixed window from the first event, not a debounce: a steady stream of writes must still reach onBatch)
// plus the per-path throttle.
class Reporter {
  #batch = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #held = new Set<string>();
  #heldTimer: { handle: ReturnType<typeof setTimeout>; due: number } | undefined;
  readonly #last = new Map<string, number>();
  #state: 'open' | 'closed' = 'open';

  constructor(private readonly o: { batchMs: number; throttleMs: number; filter: Rules; log: Logger;
    onBatch: (rels: string[]) => void }) {}

  report(rel: string): void {
    if (this.#state === 'closed' || outsideRoot(rel) || this.o.filter.ignored(rel)) return;
    if (this.#batch.has(rel) || this.#held.has(rel)) return;
    const now = Date.now();
    const last = this.#last.get(rel);
    if (last !== undefined && now - last < this.o.throttleMs) {
      this.#held.add(rel);
      this.#scheduleHeld(last + this.o.throttleMs);
      return;
    }
    this.#add(rel);
  }

  close(): void {
    this.#state = 'closed';
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#heldTimer !== undefined) clearTimeout(this.#heldTimer.handle);
    this.#timer = undefined;
    this.#heldTimer = undefined;
    this.#batch = new Set();
    this.#held = new Set();
  }

  #add(rel: string): void {
    this.#batch.add(rel);
    this.#timer ??= setTimeout(() => this.#flush(), this.o.batchMs);
  }

  #scheduleHeld(due: number): void {
    if (this.#heldTimer !== undefined && this.#heldTimer.due <= due) return;
    if (this.#heldTimer !== undefined) clearTimeout(this.#heldTimer.handle);
    this.#heldTimer = { due, handle: setTimeout(() => this.#releaseHeld(), Math.max(0, due - Date.now())) };
  }

  #releaseHeld(): void {
    this.#heldTimer = undefined;
    if (this.#state === 'closed') return;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const rel of [...this.#held]) {
      const due = (this.#last.get(rel) ?? 0) + this.o.throttleMs;
      if (due <= now) {
        this.#held.delete(rel);
        if (!this.o.filter.ignored(rel)) this.#add(rel);
      } else {
        next = Math.min(next, due);
      }
    }
    if (next !== Number.POSITIVE_INFINITY) this.#scheduleHeld(next);
  }

  #flush(): void {
    this.#timer = undefined;
    if (this.#state === 'closed' || this.#batch.size === 0) return;
    const rels = [...this.#batch].filter((r) => !this.o.filter.ignored(r));   // a dir ignored after it was reported
    this.#batch = new Set();
    const now = Date.now();
    if (this.#last.size > PRUNE_AT) {
      for (const [rel, at] of this.#last) if (now - at >= this.o.throttleMs) this.#last.delete(rel);
    }
    for (const r of rels) this.#last.set(r, now);
    if (rels.length === 0) return;
    try {
      this.o.onBatch(rels);
    } catch (e) {
      this.o.log.error('callback failed', { source: 'watcher.onBatch', error: e });
    }
  }
}

// What to do about a watch-resource error, for the one line that is logged.
function errorHint(code: string): string | undefined {
  if (code === 'ENOSPC') return 'raise fs.inotify.max_user_watches (sysctl), or ignore large folders';
  if (code === 'EMFILE' || code === 'ENFILE') return 'raise the open-files limit (ulimit -n, or docker run --ulimit nofile=...)';
  return undefined;
}

// 'watcher error' is logged at warn once per root and error code for the whole process: an over-limit tree used to
// log one line per unwatchable path, again on every degraded-mode restart (megabytes every 10 minutes). Later ones
// are debug lines.
const warnedErrors = new Set<string>();

export function startWatcher(o: { root: string /* realpath */; ignore: IgnoreMatcher; ignoredDirs: readonly string[]; log: Logger;
  onBatch: (rels: string[]) => void; onError: (e: unknown) => void; batchMs?: number /* 250 */;
  throttleMs?: number /* REPORT_THROTTLE_MS */; backend?: WatcherBackend /* watcherBackendFor(process.platform) */;
  pollMs?: number /* POLL_MIN_MS */;
  onNewDirs?: (dirs: string[]) => void /* poll: folders that appeared since the last scan (gitignored ones get pruned) */;
}): Promise<WatcherHandle> {
  const { root, log } = o;
  const rules = new Rules(dirSet(o.ignoredDirs), o.ignore);
  const reporter = new Reporter({ batchMs: o.batchMs ?? 250, throttleMs: o.throttleMs ?? REPORT_THROTTLE_MS, filter: rules,
    log, onBatch: o.onBatch });
  let state: 'open' | 'closed' = 'open';
  let forwarded: 'none' | 'forwarded' = 'none';
  const w: Wiring = {
    root, log, reporter, rules, pollMs: o.pollMs ?? POLL_MIN_MS, batchMs: o.batchMs ?? 250,
    onNewDirs: (dirs) => {
      if (state === 'closed' || dirs.length === 0 || o.onNewDirs === undefined) return;
      try {
        o.onNewDirs(dirs);
      } catch (e) {
        log.error('callback failed', { source: 'watcher.onNewDirs', error: e });
      }
    },
    onError: (e: unknown): void => {
      if (state === 'closed') return;
      const code = errCode(e);
      const key = `${root}\0${code ?? 'other'}`;
      if (warnedErrors.has(key)) {
        log.debug('watcher error', { error: e });
      } else {
        warnedErrors.add(key);
        const hint = code !== undefined ? errorHint(code) : undefined;
        log.warn('watcher error', { error: e, ...(hint !== undefined ? { hint } : {}) });
      }
      // one call per watcher: the daemon only needs to know it is degraded
      if (forwarded === 'forwarded') return;
      forwarded = 'forwarded';
      try {
        o.onError(e);
      } catch (err) {
        log.error('callback failed', { source: 'watcher.onError', error: err });
      }
    },
    closed: (): void => {
      state = 'closed';
      reporter.close();
    },
  };
  const backend = o.backend ?? watcherBackendFor(process.platform);
  return backend === 'fsevents' ? startFsEvents(w) : backend === 'poll' ? startPoll(w) : startChokidar(w);
}

type Wiring = { root: string; log: Logger; reporter: Reporter; rules: Rules; pollMs: number; batchMs: number;
  onError: (e: unknown) => void; onNewDirs: (dirs: string[]) => void; closed(): void };

// ---------------------------------------------------------------------------------------------------------------
// poll

type Snapshot = Map<string, string>;   // rel -> 'd', or `f|l:ino:size:mtime:ctime`

// One pass over the tree: readdir() of every folder that is not ignored, lstat() of every file and symlink (folders
// and special files are told apart by the directory entry's type, without an lstat). Nothing is opened but folders
// (never a FIFO, a socket or a device), symlinks are not followed, and an entry that vanishes mid-scan is simply absent.
async function scanTree(root: string, rules: Rules, matches: (rel: string) => boolean,
  errors: (rel: string, e: unknown) => void): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  const dirs = [''];
  const stat = async (rel: string): Promise<void> => {
    let st: Stats;
    try {
      st = await lstat(join(root, rel));
    } catch {
      return;
    }
    if (st.isDirectory()) {
      snap.set(rel, 'd');
      dirs.push(rel);
    } else if (st.isFile() || st.isSymbolicLink()) {
      snap.set(rel, `${st.isFile() ? 'f' : 'l'}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`);
    }
  };
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch (e) {
      const code = errCode(e);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') errors(dir, e);
      continue;
    }
    const todo: string[] = [];
    for (const d of entries) {
      const rel = dir === '' ? d.name : `${dir}/${d.name}`;
      if (rules.ignored(rel, matches)) continue;
      if (d.isDirectory()) {
        snap.set(rel, 'd');
        dirs.push(rel);
      } else if (d.isFile() || d.isSymbolicLink()) {
        todo.push(rel);
      } else if (!d.isFIFO() && !d.isSocket() && !d.isBlockDevice() && !d.isCharacterDevice()) {
        todo.push(rel);   // type unknown (some filesystems): lstat decides
      }
    }
    for (let i = 0; i < todo.length; i += POLL_CONCURRENCY) await Promise.all(todo.slice(i, i + POLL_CONCURRENCY).map(stat));
  }
  return snap;
}

function cpuMsNow(): number {
  const c = process.cpuUsage();
  return (c.user + c.system) / 1000;
}

// The wait after a scan: POLL_LOAD times its cost (CPU time across threads, or wall time if larger), at least pollMs.
// Wall time alone let a scan whose lstat calls ran on 4 pool threads cost 20-28% of a core instead of 10%.
export function pollIntervalMs(pollMs: number, cost: { wallMs: number; cpuMs: number }): number {
  return Math.max(pollMs, POLL_LOAD * Math.max(cost.wallMs, cost.cpuMs));
}

function startPoll(w: Wiring): Promise<WatcherHandle> {
  const { root, log, reporter, rules } = w;
  let state: 'open' | 'closed' = 'open';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prev: Snapshot | 'none' = 'none';   // 'none' until the first scan: that one is the baseline, not changes
  // The rules the previous scan used, and when they last changed. An entry that only appears because a reload
  // un-ignored it is not new when it predates the change (ignoreInitial semantics; the daemon runs a status check
  // right after every reload). One created or changed since is: judging by the old rules alone, a note created in
  // an un-ignored folder before the next scan was never reported.
  let prevRules = new Rules(new Set(rules.dirs), rules.matcher);
  let rulesChangedAt = 0;
  let intervalMs = w.pollMs;
  let lastWallMs = 0;
  const cache = new MatchCache();
  const failing = new Set<string>();

  const scan = async (): Promise<number> => {
    const started = performance.now();
    const cpu0 = cpuMsNow();
    const now = new Rules(new Set(rules.dirs), rules.matcher);
    const seenErrors = new Set<string>();
    const next = await scanTree(root, now, cache.begin(now.matcher), (rel, e) => {
      seenErrors.add(rel);
      if (!failing.has(rel)) {
        failing.add(rel);
        w.onError(e);
      }
    });
    cache.end();
    for (const rel of [...failing]) if (!seenErrors.has(rel)) failing.delete(rel);
    const before = prev;
    const newDirs: string[] = [];
    if (state === 'open' && before !== 'none') {
      for (const [rel, sig] of next) {
        const was = before.get(rel);
        if (was === sig) continue;
        if (was === undefined && prevRules.ignored(rel)) {
          const at = changedAt(join(root, rel));
          if (at === 'none' || at < rulesChangedAt - RULES_CLOCK_SLACK_MS) continue;
        }
        if (was === undefined && sig === 'd') newDirs.push(rel);
        reporter.report(rel);
      }
      for (const rel of before.keys()) if (!next.has(rel)) reporter.report(rel);
    }
    prev = next;
    prevRules = now;
    lastWallMs = performance.now() - started;
    if (newDirs.length > 0) w.onNewDirs(newDirs);
    return pollIntervalMs(w.pollMs, { wallMs: lastWallMs, cpuMs: cpuMsNow() - cpu0 });
  };

  const loop = (nextMs: number): void => {
    if (state === 'closed') return;
    intervalMs = nextMs;
    timer = setTimeout(() => {
      timer = undefined;
      scan().then(loop, (e: unknown) => {
        w.onError(e);
        loop(w.pollMs);
      });
    }, intervalMs);
  };

  const handle: WatcherHandle = {
    async close(): Promise<void> {
      if (state === 'closed') return;
      state = 'closed';
      if (timer !== undefined) clearTimeout(timer);
      w.closed();
    },
    setIgnoredDirs(next: readonly string[]): void {
      if (state === 'closed') return;
      rules.dirs = dirSet(next);
      rulesChangedAt = Date.now();
    },
    setIgnore(next: IgnoreMatcher): void {
      if (state === 'closed') return;
      rules.matcher = next;
      rulesChangedAt = Date.now();
    },
    latencyMs: () => intervalMs + lastWallMs + w.batchMs,
  };
  return scan().then((ms) => {
    log.debug('watcher started', { root });
    loop(ms);
    return handle;
  });
}

// One FSEvents stream for the whole tree: no per-path descriptors, nothing opened, symlinks never followed. Events
// name the changed path relative to the root (a folder moved in is one event for the folder; git status covers it).
function startFsEvents(w: Wiring): Promise<WatcherHandle> {
  const { root, log, reporter } = w;
  let state: 'open' | 'closed' = 'open';
  const readyAt = Date.now();
  let fsw: FSWatcher;
  try {
    fsw = fsWatch(root, { recursive: true, persistent: true }, (_event, filename) => {
      if (state === 'closed' || typeof filename !== 'string' || filename === '') return;
      const rel = filename.replace(/^\/+/, '').replace(/\/+$/, '');
      if (Date.now() - readyAt < STARTUP_WINDOW_MS) {
        const at = changedAt(join(root, rel));
        if (at !== 'none' && at < readyAt) return;
      }
      reporter.report(rel);
    });
  } catch (e) {
    return Promise.reject(e);
  }
  fsw.on('error', (e) => w.onError(e));
  log.debug('watcher started', { root });
  return Promise.resolve({
    async close(): Promise<void> {
      if (state === 'closed') return;
      state = 'closed';
      w.closed();
      fsw.close();
    },
    setIgnoredDirs(next: readonly string[]): void {
      if (state === 'closed') return;
      w.rules.dirs = dirSet(next);
    },
    setIgnore(next: IgnoreMatcher): void {
      if (state === 'closed') return;
      w.rules.matcher = next;
    },
    latencyMs: () => w.batchMs,
  });
}

function startChokidar(w: Wiring): Promise<WatcherHandle> {
  const { root, log, reporter, rules } = w;
  const dropped = new Set<string>();   // dirs unwatched by setIgnore, re-added once un-ignored
  let state: 'open' | 'closed' = 'open';
  let readyAt: number | 'not-ready' = 'not-ready';
  const ignoredAbs = (abs: string): boolean => {
    const rel = relative(root, abs);
    return !outsideRoot(rel) && rules.ignored(rel);
  };

  const fsw = chokidarWatch(root, {
    ignoreInitial: true,
    // git syncs a symlink as a link, never its target: following one would watch arbitrary trees outside the folder
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    ignored: (p: string, st?: Stats) => (st !== undefined && specialFile(st)) || ignoredAbs(p),
  });

  fsw.on('all', (event, abs) => {
    if (state === 'closed' || !BATCHED_EVENTS.has(event)) return;
    reporter.report(relative(root, abs));
  });

  // awaitWriteFinish holds 'add'/'change' until a file has been still for 500 ms, so a file written more often than
  // that would not be reported while the writes go on, and max-wait would never arm. Raw fs events are not held back:
  // a file they name is reported at once (the daemon's git status decides whether it is dirty).
  fsw.on('raw', (_event: string, evPath: unknown, details: unknown) => {
    if (state === 'closed' || typeof details !== 'object' || details === null) return;
    const watched = (details as { watchedPath?: unknown }).watchedPath;
    if (typeof watched !== 'string') return;
    const base = resolve(root, watched);
    const named = typeof evPath === 'string' && evPath !== '' && evPath !== basename(base) ? join(base, evPath) : base;
    const mtime = fileMtime(named);
    // a write made before the watch started can still arrive; ignoreInitial semantics: not ours to report
    if (mtime !== 'none' && readyAt !== 'not-ready' && mtime >= readyAt) reporter.report(relative(root, named));
  });

  fsw.on('error', (e) => {
    if (state === 'closed') return;
    w.onError(e);
  });

  // Re-reads every watched folder: chokidar's add() of a folder it already watches only picks up children it does
  // not know yet, so this finds what an `ignore` or gitignore change made visible at any depth (ignoreInitial: no
  // events for existing files) and reuses the watches it already holds.
  const rescan = (): void => {
    for (const dir of Object.keys(fsw.getWatched())) {
      const rel = relative(root, dir);
      if (rel === '..' || rel.startsWith('../')) continue;
      if (rel === '' || !rules.ignored(rel)) fsw.add(dir);
    }
  };

  const handle: WatcherHandle = {
    async close(): Promise<void> {
      if (state === 'closed') return;
      state = 'closed';
      w.closed();
      await fsw.close();
    },
    setIgnoredDirs(next: readonly string[]): void {
      if (state === 'closed') return;
      const before = rules.dirs;
      rules.dirs = dirSet(next);
      // Release the watches of newly ignored trees (inotify limits); re-watch trees that are no longer ignored,
      // since chokidar never descended into them. ignoreInitial keeps the re-add from reporting existing files.
      for (const d of rules.dirs) if (!before.has(d)) fsw.unwatch(join(root, d));
      for (const d of before) if (!rules.dirs.has(d) && !ignoredAbs(join(root, d))) fsw.add(join(root, d));
    },
    setIgnore(next: IgnoreMatcher): void {
      if (state === 'closed') return;
      rules.matcher = next;
      // Watched dirs that are ignored now: release their watches (inotify limits); report() keeps them quiet too.
      for (const dir of Object.keys(fsw.getWatched())) {
        const rel = relative(root, dir);
        if (!outsideRoot(rel) && rules.ignored(rel)) {
          fsw.unwatch(dir);
          dropped.add(dir);
        }
      }
      for (const dir of [...dropped]) {
        if (!ignoredAbs(dir)) {
          dropped.delete(dir);
          fsw.add(dir);
        }
      }
      rescan();
    },
    latencyMs: () => w.batchMs + 500,   // awaitWriteFinish
  };

  return new Promise<WatcherHandle>((done) => {
    fsw.once('ready', () => {
      readyAt = Date.now();
      log.debug('watcher started', { root });
      done(handle);
    });
  });
}
