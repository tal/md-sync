# Review round 2: daemon liveness, interrupted ops, odd file names, toolchain, and first-run rough edges

The second review of the implementation (after round 1's 25 fixes) confirmed 31 findings: 1 critical, 5 high, 13 medium, 12 low. All 31 are addressed here. Each fix has a regression test that fails on the round-1 code and passes now (checked against a copy of the round-1 source; the Bun 1.4.2 one against the Bun 1.4.2 binary). `docs/ARCHITECTURE.md` is updated for every behavior change (new §10.6, new §20 rows D30–D36), and `SPEC.md` and `AGENTS.md` where a product decision changed.

## Critical: the daemon could freeze for good on macOS

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| chokidar is a safe watcher on every platform. | On macOS, chokidar opens a kqueue watch per file and folder. Deleting watched folders (2 to 44 times, by `rm -rf`, Finder or a pulled commit) deadlocked Bun: the main thread and Bun's "File Watcher" thread both waited on the same `os_unfair_lock`. No runs, timers, IPC or JS signal handling followed, yet `status` said "running … ok" and launchd/systemd saw a live process. Only SIGKILL worked. | macOS now uses **one recursive `fs.watch`** (a single FSEvents stream), filtered in JS. Linux keeps chokidar (inotify). No new dependency. |
| A frozen daemon is a crash, and the service manager handles crashes. | It isn't one: the process stays alive. The queue watchdog is a timer on the same frozen loop, so it can never fire. | New **liveness guard** (`src/liveness.ts`): a worker thread watches a shared heartbeat counter. After 60 s without a beat it logs `event loop stalled` and SIGKILLs the process, so the service manager restarts it. A long gap between its own ticks counts as sleep or SIGSTOP, not a stall. |
| A `flush --wait` that got `queued` will get its result. | Not from a frozen daemon: the client waited forever. | The client gives up after `FLUSH_RESULT_WAIT_MS` (60 min). Normally the guard kills the daemon long before, which closes the connection. |

The same root cause produced three more findings, and the backend switch fixes them all:

- a FIFO renamed over a watched file froze the loop in `open()`;
- every deleted folder leaked a descriptor;
- each reload of a degraded watcher leaked one descriptor per watched path.

**Also fixed with the watcher:**

- **Degraded watcher reloads:** a degraded watcher is no longer recreated on every config reload. The rules swap in place; recovery is tried from the degraded poll at most every 10 min.
- **Nested un-ignore on Linux:** chokidar's `setIgnore` rescan re-adds every watched folder, not just the root. Re-adding only the root never re-watched a nested folder that a reload un-ignored.
- **Continuous writes:** a file written continuously is reported at most once per 2 s window, and the last write of a window is still reported. The daemon runs one batch's `git status` at a time. A gitignored log written 4 times a second used to cost 4 `git status` runs a second, indefinitely.

**Still open (yours):** report the lock inversion to Bun upstream. The repro is in `scratchpad/r2/probe/chok-deadlock.ts`: chokidar alone, no mdsync code, hangs within ~40 folder deletions.

## Data loss and stuck syncing (high)

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| Round 1's op-work rule: "content not newer than the latest stop is git's own output". | A hand resolution committed by `rebase --continue` at an *earlier* stop, or an amend at an `edit` stop, was written before the latest stop too. P2 skipped it as git's output, and the abort left it only in the reflog. A cherry-pick of several commits had the same hole, and its abort rewinds to `sequencer/head`, not HEAD. | Content the op **committed** is judged by content only. P2 simulates the op's own output: a clean replay of every `done` pick from `onto` with `git merge-tree`, plus the in-flight pick restricted to the paths it changes. Anything outside that output is saved as a copy. For cherry-pick/revert sequences the target is `sequencer/head`. The mtime rule now applies only to uncommitted content. |
| (same rule, the other way) | A rebase **killed mid-pick** (no `stopped-sha`) left git's clean merge in the index, newer than the rebase dir. It was turned into a conflict copy and pushed. | The simulation reproduces that merge, so no copy. |
| A conflict-copy name always fits. | A 233-byte note name made a 270-byte copy name. `reset --hard` rewrote the rest of the worktree, then failed on the long name. The journal retried the same target every run: syncing stopped, and other edits vanished from disk on every run (kept only in rescue files). | Copy names are cut to 255 UTF-8 bytes in the stem (`NAME_MAX_BYTES`). The data guard rejects any added path with an overlong segment. If R13's `reset --hard` fails anyway, mdsync puts L, the rescue and the stash back and drops the replay instead of retrying it forever. |
| Index-only case-collision handling covers macOS. | git on macOS lists an NFD-named tracked file (made on Linux) as an untracked NFC name. The first `git add -A` pushed a visually identical duplicate to every device. The index then held two entries for one file, and every rebase failed ("You have unstaged changes"). | One shared `unstageable()` (pending.ts) for staging and pending: case-collided index paths, untracked **aliases** of tracked paths, and local-only copies. Aliases are never staged. |
| Remote-internal case duplicates are harmless ("tolerated", D27). | Two spellings pushed from a case-sensitive device (or NFC plus NFD from plain git on a Mac) share one file on the Mac. `rebase --autostash` refused every rebase, and the checkout refused to overwrite the other spelling as an untracked file. Every Mac stopped syncing for good. | While the index or the incoming tree holds such duplicates, S5 uses the tree-only replay (no worktree diff involved). `status` lists them under `not synced` with the fix (remove one spelling). |
| Bun's errno for a missing socket is stable. | Bun 1.4.2 (what `bun-version: latest` installed) returns EINVAL, not ENOENT, for a missing socket path of 104+ bytes under a missing folder. A first `flush` with no daemon exited 1. Three acceptance tests failed on `macos-latest`, so no release could be published. | `sendFlush` lstat-checks the socket path first. CI and releases now pin Bun with `.bun-version` (1.3.13). |

## Medium

- **Copies of tracked-but-gitignored files:** round 1 used `check-ignore --no-index`, which kept a rescue copy of a **tracked** file matching a `.gitignore` pattern off the remote forever. Dropping `--no-index` would leak round 1's case: a copy made while `.env` was untracked, after another device force-adds `.env`.
  - The local-only decision is now made **when the copy is created** and recorded in `<hash>.local-only.json` (collisions, stash replay, rescue restore).
  - Later checks are index-aware, the same rule as `copyCommittable`.
- **Rescue on case-insensitive disks:** the at-risk row checked index membership with exact case, so a tracked file reached through another spelling was saved as untracked. That made spurious copies, some with stale text (three copies of one text in one case). The lookup now folds case and normalization.
- **Invalid config file while a daemon runs:** a typo in the instance file made `flush`, `status` and `uninstall-service` exit 2.
  - A Claude Code Stop hook treats exit 2 as "block the agent".
  - A crash-looping unit could not be uninstalled.
  - Now they skip the file with a warning. A flush still reaches the daemon (which keeps its last good config); only a one-off that needs the file refuses, with exit 1.
  - An invalid `MDSYNC_LOG_LEVEL` only warns.
- **Flush from another environment:** a hook without the shell's `XDG_STATE_HOME` missed the daemon's socket and ran a second sync, without the daemon's `ignore` list or author.
  - `flush`, `sync-once` and `run` also check the default state dir and the `XDG_STATE_HOME` recorded in the installed unit.
  - A container's state can't be seen from the host: the README says to use `docker exec`.
- **Remote without the configured branch:** with history only on `master`, mdsync quietly created and pushed `main`. It now fails with "origin has no branch main (its default branch is master); set "branch": "master"". Only a truly empty remote gets the branch created.
- **Slow links:** a fetch over a slow but working link was killed at a fixed 120 s and restarted from zero, forever, so local commits were never pushed either.
  - Network ops now run with `--progress` and are killed after 120 s **without output** (30 min absolute cap).
  - The clone dropped `-q`, which silences `--progress`.
- **Interrupted first clone:** a SIGKILL or `docker stop` mid-clone left `HEAD -> refs/heads/.invalid`. Every later run failed with "No such ref: HEAD" while the daemon said ready. P6 now repairs HEAD, and the next fetch completes the clone.
- **README fixes:**
  - musl assets need `apk add libstdc++ libgcc`;
  - `mkdir -p ~/agent-notes` before `docker run` (a missing bind source is created root-owned, and the uid-1000 container can't clone into it; mdsync now says so, with a chown hint);
  - one config file name throughout Quick start;
  - `mkdir -p .github/workflows` before the `print-workflow` redirect;
  - a `.gitignore` suggestion for `.DS_Store` and editor droppings.

## Low

- **Backoff:** every failed run advanced the backoff, so six flushes during a brief outage pushed the automatic retry to 10 minutes. The step now advances only when the retry's own run fails; other failures keep the pending retry.
- **Local-only copies:** they kept every pull re-arming the backup timers for an empty commit run. Never-staged paths are no longer pending.
- **First clone on a network failure:** the daemon exited 1 at once (a 5 to 10 s restart storm). It now retries on the backoff while holding the lock and socket. Startup failures log `startup failed`.
- **`status --format json`:**
  - it reported a missing or non-repo folder as clean; now `repo: {state:'unavailable', why}` and `'unknown'`;
  - it gained `head`, the one-off pid, `service` and `notSynced`.
- **ntfy:** a URL with `?auth=…` put `/sse` into the token. `/sse` now goes on the path, and the query is a log secret.
- **`install-service --print`** created the folder. It now creates nothing, and `install-service` prints the unit name and log path (status shows them too).
- **Plainer CLI messages:**
  - no `TypeError:` prefix;
  - "expected a whole number of milliseconds" instead of "received NaN";
  - "is the synced folder itself";
  - the default config path that was checked;
  - no repeated repo-config warnings from `status`.
- **Release assets:** on Bun 1.3.x, `linux-x64-musl` needs AVX2 and had no baseline sibling. Added `linux-x64-musl-baseline` and noted that the asset list must be re-checked whenever `.bun-version` changes (on 1.4.2, `linux-x64` and `-baseline` are byte-identical).

## Bugs I found in my own changes along the way

- **`splitName` deleted:** a Python slice meant to replace one block in `conflict-name.ts` removed `splitName` along with it; tsc caught it.
- **`git stash push` on untracked files:** I tried it to get a before/after comparison. It failed (the whole `src/` is untracked), so nothing changed, but it is the wrong tool here. I used a copy of the round-1 source in the scratchpad instead.
- **First op-work fix too broad:** the in-flight pick's merge-tree result counted for **all** paths. That reproduced a resolution committed at an earlier stop, because the pick leaves untouched paths as HEAD had them. Restricted to the paths the pick changes (`OpTree.paths`).
- **The test harness polluted its own remote:** its `remote.push` is plain git on macOS, and it committed the NFC alias of an NFD file. I kept that as a real scenario: plain git on a Mac does exactly this, and the remote-duplicates route now covers it.
- **Precomposed paths in the tests:** `precomposeunicode=true` in the test's bare repo turned NFD arguments into NFC, so the raw-push and show helpers run with `-c core.precomposeunicode=false`.
- **`clone -q --progress`:** prints no progress at all. Dropped `-q`.

## Decisions worth a look

- **Bun pin:** 1.3.13 via `.bun-version`. The container image (`oven/bun:slim`) stays unpinned, because the tag couldn't be checked here without Docker.
- **Local-only copy list:** a new state file, `<hash>.local-only.json`. It is the only way to honour both rounds' rules: copies of tracked files sync, while a copy made while its original was ignored stays local for good.
- **Exit code 1 for a one-off flush that needs an invalid config:** §13.3 still says config errors are exit 2. The exception is limited to a file the flush didn't name.

## Results

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test test/unit` | 837 pass, 1 skip (was 793) |
| `bun test test/acceptance` | 80 pass (was 67) |
| `17-flush-path-wait` and `18-flush-no-daemon` on Bun 1.4.2 | 8 pass (3 failed before) |
| Compiled binary smoke test | passes; the liveness worker kills a stalled compiled binary too |
| Reviewer's repros | local folder churn: no hang in 60 cycles (round-1 code hung at 12); pull-driven folder churn: no hang in 25 cycles (hung at 11) |

All on macOS. The Linux-only paths (chokidar's nested rescan, the degraded watcher on an unreadable folder) are covered by tests that also run in the `ubuntu-latest` CI job, but weren't run locally (no Docker here).
