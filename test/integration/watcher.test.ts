import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compileIgnore } from '../../src/ignore';
import { createLogger, type Logger } from '../../src/log';
import { pollIntervalMs, startWatcher, watcherBackendFor, type WatcherBackend, type WatcherHandle } from '../../src/watcher';

type Line = { level: string; msg: string; [k: string]: unknown };

function testLog(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  return { log: createLogger({ level: 'debug', sink: 'stdout', write: (l) => lines.push(JSON.parse(l) as Line) }), lines };
}

const roots: string[] = [];
const handles: WatcherHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const r = realpathSync(mkdtempSync(join(tmpdir(), 'mdsync-watch-')));
  roots.push(r);
  return r;
}

function put(root: string, rel: string, content = 'x'): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

async function until(pred: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const end = performance.now() + timeoutMs;
  while (!pred()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

// awaitWriteFinish (500 ms) + batching (250 ms) + polling: anything not reported by then never will be.
const QUIET_MS = 1_500;

// 'ready' does not mean macOS fs.watch is live yet: a file created right after it, under load, is never reported. So
// each test first writes a sentinel into every dir it relies on and waits until it is seen (the daemon has no such
// handshake, and needs none: the startup run's post-run status check covers that window). Sentinel paths
// never reach a test's batches.
const SENTINEL = 'zz-watcher-live.md';
const isSentinel = (rel: string): boolean => rel === SENTINEL || rel.endsWith(`/${SENTINEL}`);

async function goLive(root: string, dirs: readonly string[], seen: Set<string>): Promise<void> {
  for (const d of dirs) {
    const rel = d === '' ? SENTINEL : `${d}/${SENTINEL}`;
    const end = performance.now() + 20_000;
    for (let k = 0; !seen.has(rel); k++) {
      if (performance.now() > end) throw new Error(`watcher never went live in '${d}'`);
      writeFileSync(join(root, rel), String(k));
      const until = performance.now() + 1_500;
      while (!seen.has(rel) && performance.now() < until) await Bun.sleep(20);
    }
  }
  await Bun.sleep(QUIET_MS);   // the sentinels' own late events (awaitWriteFinish) land before the test starts
}

// macOS runs both backends (fsevents is the default there; poll is what Linux uses), other platforms poll only. The
// poll backend scans every 200 ms here (2 s in the daemon), so the timing assertions hold for both.
const BACKENDS: readonly WatcherBackend[] = process.platform === 'darwin' ? ['fsevents', 'poll'] : ['poll'];

async function watch(root: string, o: { ignore?: string[]; ignoredDirs?: string[]; onBatch?: (rels: string[]) => void;
  live?: string[]; backend?: WatcherBackend; throttleMs?: number; onNewDirs?: (dirs: string[]) => void } = {}) {
  const { log, lines } = testLog();
  const batches: string[][] = [];
  const target = o.onBatch ?? ((rels) => batches.push(rels));
  const sentinels = new Set<string>();
  let phase: 'handshake' | 'live' = 'handshake';
  const handle = await startWatcher({
    root,
    ignore: compileIgnore(o.ignore ?? []),
    ignoredDirs: o.ignoredDirs ?? [],
    log,
    onBatch: (rels) => {
      const user = rels.filter((p) => !isSentinel(p));
      for (const p of rels) if (isSentinel(p)) sentinels.add(p);
      // nothing before the handshake ends: macOS may still deliver writes made just before the watch started
      if (user.length > 0 && phase === 'live') target(user);
    },
    onError: () => {},
    ...(o.backend !== undefined ? { backend: o.backend } : {}),
    ...(o.throttleMs !== undefined ? { throttleMs: o.throttleMs } : {}),
    ...(o.onNewDirs !== undefined ? { onNewDirs: o.onNewDirs } : {}),
    pollMs: 200,
  });
  handles.push(handle);
  // Poll startup awaits its baseline scan; unlike FSEvents, it is already live when startWatcher resolves.
  if ((o.backend ?? watcherBackendFor(process.platform)) !== 'poll') {
    await goLive(root, o.live ?? [''], sentinels);
  }
  phase = 'live';
  const seen = (): Set<string> => new Set(batches.flat());
  return { handle, batches, lines, seen };
}

for (const backend of BACKENDS) describe(`startWatcher (${backend})`, () => {
  const watchWith: typeof watch = (root, o = {}) => watch(root, { backend, ...o });
  test('resolves on ready, logs watcher started, ignores existing files', async () => {
    const root = tempRoot();
    put(root, 'old.md');
    await Bun.sleep(1_000);   // macOS fs.watch can report a write made just before the watch started
    const w = await watchWith(root);
    expect(w.lines.find((l) => l.msg === 'watcher started')).toMatchObject({ level: 'debug', root });
    await Bun.sleep(QUIET_MS);
    expect(w.batches).toEqual([]);
  }, 10_000);

  test('add, change and unlink are reported as repo-relative paths, batched', async () => {
    const root = tempRoot();
    put(root, 'keep.md', 'v1');
    put(root, 'gone.md');
    const w = await watchWith(root);
    put(root, 'notes/new.md');
    put(root, 'keep.md', 'v2');
    unlinkSync(join(root, 'gone.md'));
    await until(() => ['notes', 'notes/new.md', 'keep.md', 'gone.md'].every((p) => w.seen().has(p)), 'all events');
    // raw fs events report at once, awaitWriteFinish events 500 ms later (and may split once more)
    expect(w.batches.length).toBeLessThanOrEqual(3);
    for (const b of w.batches) expect(new Set(b).size).toBe(b.length);
  }, 10_000);

  test('a burst of writes arrives as one batch', async () => {
    const root = tempRoot();
    const w = await watchWith(root);
    for (let i = 0; i < 10; i++) put(root, `f${i}.md`);
    await until(() => w.seen().size === 10, 'ten files');
    expect(w.batches.length).toBeLessThanOrEqual(2);
  }, 10_000);

  test('.git is never reported', async () => {
    const root = tempRoot();
    put(root, '.git/HEAD', 'ref: refs/heads/main\n');
    const w = await watchWith(root);
    put(root, '.git/index', 'i');
    put(root, '.git/refs/heads/main', 'sha');
    put(root, 'sub/.git/config', 'c');
    put(root, 'visible.md');
    await until(() => w.seen().has('visible.md'), 'visible.md');
    await Bun.sleep(QUIET_MS);
    expect([...w.seen()].filter((p) => p.split('/').includes('.git'))).toEqual([]);
  }, 10_000);

  test('the ignore matcher applies (files and directories)', async () => {
    const root = tempRoot();
    const w = await watchWith(root, { ignore: ['*.tmp', 'drafts', '/build/'] });
    put(root, 'a.tmp');
    put(root, 'deep/b.tmp');
    put(root, 'drafts/x.md');
    put(root, 'deep/drafts/y.md');
    put(root, 'build/out.md');
    put(root, 'deep/build/kept.md');
    put(root, 'real.md');
    await until(() => w.seen().has('real.md') && w.seen().has('deep/build/kept.md'), 'unignored files');
    await Bun.sleep(QUIET_MS);
    expect([...w.seen()].sort()).toEqual(['deep', 'deep/build', 'deep/build/kept.md', 'real.md']);
  }, 10_000);

  test('ignoredDirs: the dir and everything under it, trailing slash tolerated', async () => {
    const root = tempRoot();
    put(root, 'node_modules/pkg/index.js');
    put(root, 'cache/a/b.bin');
    put(root, 'cachefile.md');
    const w = await watchWith(root, { ignoredDirs: ['node_modules', 'cache/a/'], live: ['', 'cache'] });
    put(root, 'node_modules/pkg/new.js');
    put(root, 'node_modules/other/x.js');
    put(root, 'cache/a/c.bin');
    put(root, 'cache/a/deeper/d.bin');
    put(root, 'cache/visible.md');
    put(root, 'cachefile.md', 'changed');
    await until(() => w.seen().has('cache/visible.md') && w.seen().has('cachefile.md'), 'visible files');
    await Bun.sleep(QUIET_MS);
    expect([...w.seen()].sort()).toEqual(['cache/visible.md', 'cachefile.md']);
  }, 10_000);

  test('setIgnoredDirs: newly ignored trees go quiet; un-ignored trees are watched again', async () => {
    const root = tempRoot();
    put(root, 'gen/a.md');
    put(root, 'vendor/a.md');
    const w = await watchWith(root, { ignoredDirs: ['vendor'] });

    w.handle.setIgnoredDirs(['gen']);
    // Re-watching vendor is an async scan; with ignoreInitial, files created before it finishes count as
    // initial and are not reported. (Harmless for the daemon: the .gitignore change itself arms the timers.)
    await Bun.sleep(300);
    put(root, 'gen/a.md', 'changed');
    put(root, 'gen/new.md');
    put(root, 'vendor/a.md', 'changed');
    put(root, 'vendor/new.md');
    put(root, 'marker1.md');
    await until(() => w.seen().has('marker1.md') && w.seen().has('vendor/new.md') && w.seen().has('vendor/a.md'), 'vendor events');
    await Bun.sleep(QUIET_MS);
    expect([...w.seen()].filter((p) => p.startsWith('gen'))).toEqual([]);

    w.batches.length = 0;
    w.handle.setIgnoredDirs([]);
    await Bun.sleep(300);
    put(root, 'gen/a.md', 'again');
    put(root, 'gen/newer.md');
    await until(() => w.seen().has('gen/a.md') && w.seen().has('gen/newer.md'), 'gen events again');
  }, 15_000);

  test('a throwing onBatch is logged and the watcher keeps going', async () => {
    const root = tempRoot();
    const got: string[][] = [];
    const w = await watchWith(root, {
      onBatch: (rels) => {
        got.push(rels);
        if (got.length === 1) throw new Error('batch handler');
      },
    });
    put(root, 'one.md');
    await until(() => got.length === 1, 'first batch');
    await Bun.sleep(300);
    put(root, 'two.md');
    await until(() => got.length === 2, 'second batch');
    expect(w.lines.find((l) => l.msg === 'callback failed')).toMatchObject({ source: 'watcher.onBatch', error: 'batch handler' });
  }, 10_000);

  test('close() stops all callbacks, drops a pending batch and is idempotent', async () => {
    const root = tempRoot();
    const w = await watchWith(root);
    put(root, 'before-close.md');
    await Bun.sleep(600);   // the add event may be waiting in the batch window
    await w.handle.close();
    await w.handle.close();
    w.handle.setIgnoredDirs(['x']);   // no-op after close
    put(root, 'after-close.md');
    await Bun.sleep(QUIET_MS);
    expect(w.seen().has('after-close.md')).toBe(false);
  }, 10_000);

  test('batches use a fixed window, so a steady stream of writes is still delivered while it lasts', async () => {
    const root = tempRoot();
    const w = await watchWith(root);
    const seenWhileWriting = { batches: 0 };
    for (let i = 0; i < 30; i++) {
      put(root, `w${i}.md`);
      await Bun.sleep(80);
      seenWhileWriting.batches = w.batches.length;
    }
    expect(seenWhileWriting.batches).toBeGreaterThan(0);
    await until(() => w.seen().size === 30, 'all files');
    expect(w.batches.length).toBeGreaterThan(2);
  }, 15_000);

  test('continuous writes to one file are reported while they go on (awaitWriteFinish never settles)', async () => {
    const root = tempRoot();
    put(root, 'log.md', 'start\n');
    const w = await watchWith(root);
    const t0 = performance.now();
    let during = 'not-seen';
    while (performance.now() - t0 < 3_000) {
      appendFileSync(join(root, 'log.md'), 'line\n');
      await Bun.sleep(150);
      if (w.seen().has('log.md')) during = 'seen';
    }
    expect(during).toBe('seen');
  }, 15_000);

  test('symlinks are not followed: writes in a linked outside tree are never reported', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    for (let i = 0; i < 100; i++) put(outside, `d${i}/f.md`);
    symlinkSync(outside, join(root, 'linked'));
    const fds = readdirSync('/dev/fd').length;
    const w = await watchWith(root);
    expect(readdirSync('/dev/fd').length - fds).toBeLessThan(50);   // following it opens one per entry
    put(outside, 'd1/new.md');
    put(outside, 'deep/secret.md');
    put(root, 'real.md');
    await until(() => w.seen().has('real.md'), 'real.md');
    await Bun.sleep(QUIET_MS);
    expect([...w.seen()].filter((p) => p.startsWith('linked/'))).toEqual([]);
  }, 15_000);

  test('setIgnore swaps the matcher in place: newly ignored paths go quiet, un-ignored ones are watched, no fds leak', async () => {
    const root = tempRoot();
    for (let i = 0; i < 30; i++) put(root, `d${i}/f.md`);
    put(root, 'drafts/x.md');
    const w = await watchWith(root, { ignore: ['drafts'] });
    const fds = readdirSync('/dev/fd').length;
    for (let i = 0; i < 6; i++) {
      w.handle.setIgnore(compileIgnore(i % 2 === 0 ? ['*.tmp'] : ['drafts', '*.tmp']));
      await Bun.sleep(300);
    }
    // recreating the watcher per reload kept every old descriptor on macOS (one per watched path)
    expect(readdirSync('/dev/fd').length - fds).toBeLessThan(15);

    w.handle.setIgnore(compileIgnore(['*.tmp']));
    await Bun.sleep(500);
    w.batches.length = 0;
    put(root, 'drafts/x.md', 'changed');
    put(root, 'drafts/new.md');
    put(root, 'scratch.tmp');
    await until(() => w.seen().has('drafts/x.md') && w.seen().has('drafts/new.md'), 'un-ignored drafts');

    w.handle.setIgnore(compileIgnore(['drafts']));
    await Bun.sleep(300);
    w.batches.length = 0;
    put(root, 'drafts/x.md', 'again');
    put(root, 'marker.md');
    await until(() => w.seen().has('marker.md'), 'marker');
    await Bun.sleep(QUIET_MS);
    expect([...w.seen()].sort()).toEqual(['marker.md']);
  }, 20_000);

  test('a file written continuously is reported about once per throttle window, and its last write still is', async () => {
    const root = tempRoot();
    put(root, 'app.log', 'start\n');
    const reports: number[] = [];
    await watchWith(root, { throttleMs: 1_000, onBatch: (rels) => { if (rels.includes('app.log')) reports.push(performance.now()); } });
    const t0 = performance.now();
    while (performance.now() - t0 < 4_000) {
      appendFileSync(join(root, 'app.log'), 'line\n');
      await Bun.sleep(50);
    }
    // one report per 250 ms batch would be ~16 (each one a `git status` in the daemon)
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(reports.length).toBeLessThanOrEqual(7);
    appendFileSync(join(root, 'app.log'), 'last\n');
    const lastWrite = performance.now();
    await until(() => reports.some((t) => t > lastWrite), 'the trailing report', 4_000);
  }, 20_000);

  test('dotfiles and dot-folders: created, atomically replaced and deleted are all reported', async () => {
    // Bun's inotify directory watch (all chokidar used on Linux) dropped every child whose name starts with '.', and
    // its per-file watch missed deletes and atomic saves: a new .gitignore waited for the hourly fallback (r3).
    const root = tempRoot();
    put(root, '.existing', 'v1');
    put(root, '.gone', 'x');
    const w = await watchWith(root);
    put(root, '.gitignore', 'drafts/\n');
    put(root, '.github/workflows/mdsync-notify.yml', 'on: push\n');
    put(root, '.tmp-save', 'v2');
    renameSync(join(root, '.tmp-save'), join(root, '.existing'));
    unlinkSync(join(root, '.gone'));
    await until(() => ['.gitignore', '.github/workflows/mdsync-notify.yml', '.existing', '.gone'].every((p) => w.seen().has(p)),
      'dotfile events');
  }, 10_000);

  test('latencyMs: how late a write can reach onBatch (poll: a scan interval plus the batch window)', async () => {
    const w = await watchWith(tempRoot());
    expect(w.handle.latencyMs()).toBeGreaterThanOrEqual(backend === 'poll' ? 200 + 250 : 250);
  });

  if (backend === 'poll') {
    test('setIgnore: a note created in an un-ignored folder before the next scan is reported; older files are not', async () => {
      // r4: new entries were judged by the previous scan's rules alone, so a note created in drafts/ right after a
      // reload un-ignored it was taken for a pre-existing file and never reported (nothing armed the timers).
      const root = tempRoot();
      put(root, 'drafts/old.md');
      const w = await watchWith(root, { ignore: ['drafts'] });
      // Ensure the old file predates the reload even when startup finishes within the same clock millisecond.
      await Bun.sleep(20);
      w.handle.setIgnore(compileIgnore([]));
      put(root, 'drafts/new.md');
      await until(() => w.seen().has('drafts/new.md'), 'drafts/new.md', 3_000);
      await Bun.sleep(QUIET_MS);
      expect(w.seen().has('drafts/old.md')).toBe(false);   // existed before: the daemon's post-reload status check
    }, 15_000);

    test('onNewDirs: folders that appear after the baseline are passed on, ignored ones and existing ones are not', async () => {
      // r4: a gitignored folder created after the start (npm install) was scanned on every poll until a restart; the
      // daemon refreshes its ignored-dir list from this hook.
      const root = tempRoot();
      put(root, 'old/a.md');
      const got: string[][] = [];
      const w = await watchWith(root, { ignoredDirs: ['skip'], onNewDirs: (d) => got.push(d) });
      put(root, 'node_modules/pkg/index.js');
      put(root, 'skip/inner/x.md');
      await until(() => got.flat().includes('node_modules'), 'node_modules', 3_000);
      expect(got.flat().sort()).toEqual(['node_modules', 'node_modules/pkg']);
      w.handle.setIgnoredDirs(['node_modules', 'skip']);
      await Bun.sleep(500);
      w.batches.length = 0;
      put(root, 'node_modules/pkg/more.js');
      put(root, 'marker.md');
      await until(() => w.seen().has('marker.md'), 'marker.md');
      expect([...w.seen()].filter((p) => p.startsWith('node_modules'))).toEqual([]);
    }, 15_000);

    test('setIgnore: a nested folder un-ignored by a reload is watched again', async () => {
      const root = tempRoot();
      put(root, 'projects/private/a.md');
      put(root, 'projects/other.md');
      const w = await watchWith(root, { ignore: ['private'], live: ['', 'projects'] });
      w.handle.setIgnore(compileIgnore([]));
      await Bun.sleep(1_000);
      put(root, 'projects/private/new.md');
      await until(() => w.seen().has('projects/private/new.md'), 'projects/private/new.md', 6_000);
    }, 20_000);
  }

  if (backend === 'fsevents') {
    test('a folder moved into the tree is reported (one event for the folder)', async () => {
      const root = tempRoot();
      const outside = tempRoot();
      put(outside, 'proj/sub/x.md');
      const w = await watchWith(root);
      renameSync(join(outside, 'proj'), join(root, 'proj'));
      await until(() => w.seen().has('proj'), 'proj');
    }, 10_000);
  }
});

test.if(process.getuid?.() !== 0)('watch errors: one warn line per root and error code, one onError per watcher, a hint for limits', async () => {
  // r3: one `watcher error` warn line per unwatchable path (1773 for an EMFILE tree), again on every degraded restart.
  const root = tempRoot();
  for (const d of ['a', 'b', 'c']) {
    put(root, `${d}/x.md`);
    chmodSync(join(root, d), 0o000);
  }
  try {
    for (let round = 0; round < 2; round++) {
      const { log, lines } = testLog();
      let errors = 0;
      const h = await startWatcher({ root, ignore: compileIgnore([]), ignoredDirs: [], log, backend: 'poll', pollMs: 100,
        onBatch: () => {}, onError: () => { errors++; } });
      handles.push(h);
      await Bun.sleep(500);
      expect(errors).toBe(1);
      const warns = lines.filter((l) => l.msg === 'watcher error' && l.level === 'warn');
      expect(warns.length).toBe(round === 0 ? 1 : 0);   // the second watcher (a degraded-mode restart) adds none
      await h.close();
    }
  } finally {
    for (const d of ['a', 'b', 'c']) chmodSync(join(root, d), 0o755);
  }
}, 10_000);

// Runs `body` (TypeScript, with startWatcher, compileIgnore, log, root and seen in scope) in a child it can SIGKILL:
// the failures these tests guard against freeze the whole event loop, which would hang the test runner too.
async function inChild(root: string, body: string, killAfterMs: number, backend: WatcherBackend): Promise<string[]> {
  const script = join(tempRoot(), 'watch-child.ts');
  writeFileSync(script, `
    import { startWatcher } from ${JSON.stringify(resolve(import.meta.dir, '../../src/watcher.ts'))};
    import { compileIgnore } from ${JSON.stringify(resolve(import.meta.dir, '../../src/ignore.ts'))};
    import { createLogger } from ${JSON.stringify(resolve(import.meta.dir, '../../src/log.ts'))};
    import { readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
    const root = ${JSON.stringify(root)};
    const log = createLogger({ level: 'error', sink: 'stderr', write: () => {} });
    const seen = new Set();
    const h = await startWatcher({ root, ignore: compileIgnore([]), ignoredDirs: [], log, backend: ${JSON.stringify(backend)},
      onBatch: (r) => r.forEach((p) => seen.add(p)), onError: () => {} });
    const alive = async (name) => {
      for (let i = 0; i < 40 && !seen.has(name); i++) {
        writeFileSync(root + '/' + name, String(i));
        await Bun.sleep(250);
      }
      console.log(seen.has(name) ? 'alive' : 'deaf');
    };
    ${body}
    await h.close();
    process.exit(0);
  `);
  const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
  const outText = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(killer);
  return outText.trim().split('\n');
}

// A FIFO blocks fs.watch's open() (macOS kqueue, and Bun's inotify path watcher, which opens every entry of a watched
// folder), freezing the whole event loop. Each backend a platform uses runs these in a child it can SIGKILL.
for (const backend of BACKENDS) describe(`liveness (${backend})`, () => {
test('a FIFO in the folder blocks neither startup nor a running watcher, also when it replaces a watched file', async () => {
  const root = tempRoot();
  Bun.spawnSync(['mkfifo', join(root, 'at-start.fifo')]);
  put(root, 'a.md');
  put(root, 'b.md');
  const lines = await inChild(root, `
    console.log('ready');
    await alive('first.md');
    Bun.spawnSync(['mkfifo', root + '/while-running.fifo']);
    await Bun.sleep(300);
    // renamed over a watched file, and removed + recreated as a FIFO at the same path
    Bun.spawnSync(['mkfifo', root + '/.renamed.fifo']);
    renameSync(root + '/.renamed.fifo', root + '/a.md');
    unlinkSync(root + '/b.md');
    Bun.spawnSync(['mkfifo', root + '/b.md']);
    await Bun.sleep(300);
    await alive('after.md');
  `, 20_000, backend);
  expect(lines).toEqual(['ready', 'alive', 'alive']);
}, 30_000);

// chokidar's per-path fs.watch deadlocked Bun's event loop on macOS after 2 to 40 such deletions (the frozen loop then
// ignored SIGTERM too), and kept one descriptor open per deleted folder.
test('deleting and recreating a populated folder over and over neither freezes the watcher nor keeps descriptors', async () => {
  const root = tempRoot();
  put(root, 'keep.md');
  const lines = await inChild(root, `
    await alive('first.md');
    const fds = () => readdirSync('/dev/fd').length;
    const before = fds();
    for (let cycle = 0; cycle < 60; cycle++) {
      await Bun.spawn(['sh', '-c', 'mkdir -p "$0/proj/sub" && for i in $(seq 0 29); do echo c > "$0/proj/x$i.md"; done', root]).exited;
      await Bun.sleep(100);
      await Bun.spawn(['rm', '-rf', root + '/proj']).exited;
      await Bun.sleep(100);
    }
    await Bun.sleep(1000);
    console.log('fd growth ' + (fds() - before));
    await alive('after.md');
  `, 120_000, backend);
  expect(lines[0]).toBe('alive');
  expect(lines[2]).toBe('alive');
  const growth = Number(/^fd growth (-?\d+)$/.exec(lines[1] ?? '')?.[1] ?? 'NaN');
  expect(growth).toBeLessThan(10);
}, 150_000);
});

test('poll interval: ten times the scan cost in CPU time (all threads) or wall time, whichever is larger, never under pollMs', () => {
  // r4: wall time alone let a scan whose lstat calls ran on the thread pool (CPU 2-3x wall) cost 20-28% of a core.
  expect(pollIntervalMs(2_000, { wallMs: 50, cpuMs: 120 })).toBe(2_000);
  expect(pollIntervalMs(2_000, { wallMs: 200, cpuMs: 600 })).toBe(6_000);
  expect(pollIntervalMs(2_000, { wallMs: 900, cpuMs: 300 })).toBe(9_000);
});
