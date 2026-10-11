# Review round 4: writes made while git runs, rewrite detection, LFS transfers, push races, the Linux watcher

The fourth review (a chaos fuzzer, a fix-regression lens and a poll-watcher lens) confirmed 12 findings: 1 critical, 2 high, 5 medium, 4 low. All 12 are fixed. A new seeded chaos acceptance test (`32-chaos`), built from the reviewer's fuzzer, then found 3 more data bugs of its own, also fixed here. Every fix has a regression test. Each new test was run against a copy of the round-3 source (or against the code just before the fix) to check that it fails there. `docs/ARCHITECTURE.md` covers every behavior change (§5, §7.2, §9.2–9.3, §4.26, new §20 rows D45–D50). `SPEC.md`, `README.md` and `AGENTS.md` are updated where a product decision changed.

## Critical and high: writes made while git runs

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| After a failed rebase, any difference between the pre-rebase snapshot and the worktree is git's half checkout. (r4-chaos-1, r4-fix-regressions-1) | Usually it was an agent's write, often the very write that made git refuse to start ("cannot rebase: You have unstaged changes"). `undoPartialCheckout` ran `reset --hard H` and replayed only the old snapshot: the write was gone from disk and from every ref. That was 26 of the 46 lost writes in the reviewer's chaos runs; one stress repro lost 62 writes in one undo. The same happened to a note written during a slow checkout that then failed. | Only what the checkout can have written is undone: a path where H and R differ that now holds R's version (R's blob, a strict prefix of it, or R's absence) goes back to the pre-rebase version (H when git's autostash holds the edits). Everything else stays. A refusal because the folder changed during git's autostash is retried once in the run, then ends `busy`, never "stuck". R13's abandoned replay now uses the same undo for the files its failed reset left behind. |
| `refs/remotes/origin/B` before the fetch is what this device last integrated. (r4-fix-regressions-2) | It moves without being integrated: an editor's autofetch, or a run that fetched the rewrite and then failed in S5 or was killed. The next run saw no rewrite, rebased with R as the upstream, and pushed the purged secret back. | `RunResult.integrated` (origin/B when HEAD contains it) is kept in the state file. S3 measures a rewrite from the newest of that and the tracking ref that HEAD contains. With neither, it falls back to the tracking ref's reflog (`merge-base --fork-point`, as `git pull --rebase` does). All three repros are fixed, including a first-ever run killed right after its fetch. |

## Found by the new chaos test (not in the review)

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| A conflict copy's name only has to avoid the remote, local and index trees. | `changedTriples` also lists paths that only the merge base has (an older copy that both sides renamed away). Within the same minute the namer picked exactly that name for a new conflict on `README.md`. The data guard stopped the replay, and the device was stuck at {H, R} with 11 unpushed commits until something changed. | The namer also avoids every triple path, as `replayStash` already did. |
| In S5 case (b), unmerged paths are git's own conflict output. | The replay spends ~400 ms planning before its `reset --hard`. An agent that rewrote the conflicted file in that time lost the write, with no rescue and not even a dangling blob. 4 of the first batch's losses. | S5's autostash replays use the P5 rule: a conflicted file written after `.git/AUTO_MERGE` is saved and comes back as a copy. |
| R3 (stopped rebase) can skip unmerged paths: they are git's output "from milliseconds ago". | The same race before `rebase --abort`. | R3 uses P2's rule: written after `rebase-merge/stopped-sha` (probe e9), it is saved. |

## Medium

- **LFS uploads were silent (r4-fix-regressions-3).**
  - Before: git-lfs prints no progress on a pipe, so any upload longer than the 120 s no-output limit was killed, every retry from zero. The git push is gated behind it, so the device never pushed again.
  - Now: network ops run with `GIT_LFS_FORCE_PROGRESS=1`.
  - Incoming LFS objects are fetched (`git lfs fetch origin R`, a network op) before S4u's checkout and S5's rebase. A big download is therefore no longer under the 300 s local-op cap.
- **A lost ref-update race on the remote counted as a local lock (r4-chaos-3).**
  - Before: two devices pushed at the same moment and one got `remote: error: cannot lock ref … is at X but expected Y`. It was classified `busy`: `flush --wait` exited 1, and the push waited 30 s or more for a retry.
  - Now: for a push, that message and `[remote rejected] (incorrect old value provided)` are non-fast-forward. S6 re-fetches, rebases and retries.
- **Gitignored folders created after the start were scanned forever (r4-poll-watcher-1).**
  - Before: a 50k-file `node_modules` took idle CPU from 0.3% to 15%, until a restart.
  - Now: the poll backend reports new folders (`onNewDirs`), and the daemon refreshes `ignoredDirs` at most every 30 s (`ignored dirs refreshed`).
- **Acceptance tests 14 and 22 failed on Linux's backend (r4-poll-watcher-2).**
  - Before: they waited for a `local change` that the poll never logs once a status check has already armed the timers.
  - Now: they anchor on whichever comes first, `local change` or `backup timers armed`.
  - New test hook `MDSYNC_TEST_WATCHER=poll|fsevents` (D50), which the harness passes through.
  - CI runs the acceptance suite a second time on macOS with the poll backend.
- **The poll used 17–28% of a core, not ~10% (r4-poll-watcher-3).**
  - Before: the scan interval was 10 × the scan's wall time, but `lstat` runs on the thread pool at 2–3× wall time.
  - Now: 10 × max(CPU time across threads, wall time).
  - Folders are told apart by their directory-entry type (no `lstat`), and `ignore`-glob results are cached between scans.
  - Measured on macOS: 50k files 18.5% → 10%; 50k files with 8 patterns 26.8% → 10%; 200k files 17–18% → 9%. 10k files stays at ~6–7%, under the 2 s floor.

## Low

- **LFS smudge failures got stuck (r4-fix-regressions-4).**
  - Before: a missing object failed inside the rebase (case c), and the run was remembered as stuck at {H, R}. The object arriving later changed nothing, and R's new files were left for the next commit run to commit.
  - Now: the prefetch above fails first as a network error. Any later smudge failure at S5z or S4u is `network-error`, never stuck. The failed replay reset's leftovers are removed.
- **Stuck errors grew without bound (r4-chaos-4):** each replay of a stuck failure stored its own `unchanged since …: ` text as the new error. The record now keeps the original error.
- **Idle commits fired mid-burst on Linux (r4-poll-watcher-4):** the idle timer ran from when a scan reported a write, so `idleMs` 1500 split a 10 s writing session into 5 commits. The idle wait is now at least 2 × the watcher's latency (D49). That is a no-op on macOS, where the latency is the 250 ms batch window.
- **Notes in an un-ignored folder were missed (r4-poll-watcher-5):**
  - Before: after a reload un-ignored a folder, the next scan judged new entries by the old rules. A note created there before that scan was never reported.
  - Now: only entries that predate the reload are skipped.
- **Sleep-sensitive tests (r4-known-1):** `Date.now() - process.uptime()` is wrong after a sleep on macOS, because uptime stops. The tests compare against `ps -o lstart` now (`psStartMs`). This can't be reproduced deterministically without sleeping the host.

## Learned along the way

- **D28 is not "milliseconds", and not everything that looks like D28 is.** The snapshot-to-destructive-op window is real and measurable. On the final code, 16 writes in 30 chaos runs of 30 s landed in it. The reviewer's sparser 150 s runs had 1 in 300 s.
  - The chaos test counts losses with exactly that shape (a destructive op starting within 300 ms of the write, no snapshot in between) and fails on any other loss.
  - That precise accounting exposed the two unmerged-path bugs above, which my first, looser rule ("any destructive op within 1.5 s") had excused as D28.
  - Chaos batches on the same 15 seeds: 4 "snapshotted, then destroyed" losses before the case (b) fix (seeds 20, 26, 31), 2 after it (seeds 27 and 31, both R3), none after the R3 fix.
- **Bugs in my own work:**
  - The first `git` wrapper for the race tests never fired. `case " $* "` with `*" rebase "*" --autostash "*` needs two spaces between adjacent words, because the patterns share one. All three tests "failed" on the baseline for the wrong reason until I checked that the wrapper ran.
  - My first chaos classification excused real bugs as D28 windows.
  - Its rename op moves a token's recorded path, so analyzing a loss at its write time needed a full op log, now dumped with the logs.
  - `psStartMs` first read `ps`'s local time with whatever `TZ` the test process had at that moment. A unit test that sets `TZ=America/New_York` made it 4 h off. `ps` now runs with `TZ=UTC` and the fields are read as UTC.
- **git-lfs:**
  - `git lfs push` skips objects reachable from `refs/remotes/origin/*`.
  - `Bun.serve` and `node:net` both buffer whole request bodies (`pause()` applies no TCP backpressure), so a slow uplink can't be simulated with a Bun server. A git-lfs custom transfer agent can: git-lfs drives it, and prints or suppresses progress from its events.
  - `git lfs fetch` creates `.git/lfs` even in a repo without LFS files, which would turn on S6's `git lfs push`. That is why the prefetch only runs when R's `.gitattributes` mention `filter=lfs` (or `.git/lfs` already exists).
- **Synchronous `lstat`** halved the poll's CPU, but a hung network mount would then freeze the whole event loop (IPC, timers, liveness). Async stays.

## Decisions worth a look

- **The idle floor applies on Linux only.** On macOS a single file written continuously is still reported once per 2 s throttle window, so `idleMs` below ~2.5 s can split that one file's session (documented; the default is 5 min).
- **A rebase refused because the folder changed** is retried once in the run, then `busy` (30 s backoff).
- **New state field `integrated`.** Losing the state dir falls back to the reflog, then to the old behavior.
- **The LFS prefetch** adds one `git grep` per S5/S4u run, and one `git lfs fetch` when the repo uses LFS.
- **CI** now runs the macOS acceptance suite twice (FSEvents and poll).
- **The chaos test** tolerates up to 6 D28-shaped losses per 30 s run. The density is deliberately high: 3 devices, a write every ~200 ms across ~30 files, runs every 1–2 s.
  - Closing D28 itself (an in-memory replay plus `read-tree -m -u`, which refuses rather than discards) is still future work.
  - `MDSYNC_CHAOS_SEEDS=…` and `MDSYNC_CHAOS_MS=…` run longer hunts.

## Results

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test test/unit` | 888 pass, 1 skip (was 869 + 1 skip) |
| `bun test test/acceptance` | 116 pass (was 103) |
| `MDSYNC_TEST_WATCHER=poll bun test test/acceptance` | 116 pass (what macOS CI now runs too) |
| `32-chaos`, 30 runs (seeds 1–15, 20–34) on the final code | 26 pass. The 4 failures (seeds 5, 21, 27 and 31) were all conflict markers in agent-made content: rescue copies, and an agent's rename of a conflicted file. They led to the final marker rule, and those seeds pass now. No write was lost outside a D28 window. Also passes on the poll backend (seeds 7–9). |
| Reviewer's repros (`v1-realgit.ts`, `f1-writer-large-file.sh`, `f2-crash-after-fetch.sh`, `rewrite-external-fetch.sh`, `rewrite-after-failed-run.sh`) | all fixed |
| Reviewer's fuzzer `chaos.ts`, seeds 1 and 6 × 150 s, 3 daemons, ~730 ops each | converged; 0 and 1 lost writes (the 1 is a D28 window: a new file at an incoming path, overwritten by git's own checkout 10 ms later); no `busy` push outcomes |
| New tests against the round-3 source | all fail there: `33` (the first three), the new cases in `31` and `08`, `34` (poll forced), and the new unit tests in `git-lfs`, `conflict` (R13 leftovers), `sync` (rewrites), `watcher` (un-ignore, `onNewDirs`), `timers` (idle floor) and `cli` (stuck error). The two chaos-found unmerged-path tests in `33` and the base-only copy name test in `conflict` fail on the code just before their fixes. |

The reworked tests 14 and 22 pass on the round-3 source with the poll backend forced: their fix is in the tests.

All on macOS. The Linux-only paths (the poll backend as the default, the container) run in the `ubuntu-latest` CI job, not run here.
