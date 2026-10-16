# CI integration test fixes

CI had failed on `bun run test:integration` since 2026-10-13. Both runs failed on the same five tests. Most were test problems. One was a real poll-watcher bug (below), and `src/` also gained a test-only pause knob.

## Linux (`ubuntu-latest`)

| Test | Cause | Fix |
|---|---|---|
| `lock.test.ts` › release › does not remove a lock file that was replaced (different inode) | The test unlinked the lock and wrote a new one. ext4/overlayfs reuse the just-freed inode number at once, so the "new" file had the same `ino`, and release correctly removed it. | Rename the old lock aside instead of unlinking it, so its inode stays allocated, and assert that the inodes differ before releasing. |
| `move.test.ts` › a path rewritten every 50 ms through the whole move | The test assumed the move reaches identity mode, which needs a change in rounds 1 *and* 2. The 200 ms pause covers round 1 only. On Linux, round 2 finishes in under 50 ms, often between two timer writes, so the move ended with a plain conflict copy and never logged `worktree write raced` / `changing`. | Rewrite the file from `moveTestHooks.inWritePass` during round 2 (round number tracked through `afterSurvey`), so round 3 always runs in identity mode. |
| `move-recovery.test.ts` › d28-data-4 › copy-only / rename-only: a path rewritten every 50 ms … | Same cause | Same fix |

Learned: writing from `afterSurvey` is too early to count as a change in that round, because M3 classifies from a fresh read. A write has to land between the plan and the switch (the write pass) to be seen as a race.

## Linux acceptance (found once integration passed)

Integration used to fail first, so `test:acceptance` never ran on Linux. Once it did, one test failed:

- `33-concurrent-writes` › a path that keeps changing through the whole move ends in an identity copy: same cause as the integration move tests. The agent saves every 20 ms, and a Linux round 2 often finishes inside one of those gaps. The daemon runs as a separate process, so `moveTestHooks` can't reach it.
- Fix: a new test hook, `MDSYNC_TEST_MOVE_PAUSE_ROUNDS` (default 1, so other tests are unchanged). It holds rounds 1 to N, not just round 1. The test sets it to 2. `pauseForTests` in `src/move.ts` now takes the round number.
- In Docker, `33-concurrent-writes` › P2 times out with `live git detection unavailable`. It does the same on the unchanged code, and it passes on CI. Like `probes`, Docker has no boot id.

## Poll watcher: a note created right after an ignore reload could go unreported (real bug)

The next CI run failed `watcher.test.ts` › startWatcher (poll) › setIgnore: a note created in an un-ignored folder before the next scan is reported. It had passed the run before. This was a real bug, not a flaky test:

- When a reload un-ignores a folder, the poll scan treated an entry it hadn't seen before as pre-existing when the entry's `max(mtime, ctime)` was earlier than the reload's `Date.now()`. Linux stamps files from a coarse kernel clock that runs behind `Date.now()`. Measured in Docker: 1999 of 2000 files got a time *earlier* than a `Date.now()` read just before creating them (worst 1.1 ms; on macOS, 0 of 2000). So a note created within one clock tick after a reload looked older than the reload and never armed the backup timers.
- Fix: `RULES_CLOCK_SLACK_MS = 2_000` (new export of `src/watcher.ts`). An entry counts as pre-existing only if it looks older than the reload by more than 2 s. The 2 s also covers coarse-timestamp filesystems: FAT stores mtime in 2 s steps, HFS+ in 1 s. Cost: an entry changed in the 2 s before the reload is reported. That only arms the backup timers, and the daemon runs a status check after every reload anyway.
- Tests: the reload test creates its new note immediately after `setIgnore`, which is the case that used to fail. Its "old" file, and `scratch.tmp` in the matcher-swap test, are now made more than the slack before the reload.

## macOS (`macos-latest`)

`liveness.test.ts` › a suspended process (SIGSTOP) is not mistaken for a stalled loop: on CI the child never exited after `SIGCONT`, and the test's 20 s timer killed it (exit 137). A side agent flagged that this could mean a laptop waking from sleep leaves md-sync frozen with the watchdog never firing. A throwaway branch (`debug/macos-sigstop`, deleted after use) reproduced it on the runner and captured `ps` and `sample` output:

| Child process | Stopped by SIGSTOP? | Exits after SIGCONT? |
|---|---|---|
| `sh` loop with `sleep` | no (`ps` shows `S`, not `T`) | no, hangs |
| `python3` | no, kept printing ticks | no, hangs |
| `node` | no, kept printing ticks | no, hangs |
| `bun` with no md-sync code | no | no, hangs |
| `bun` with the liveness guard | no | no, hangs |

- Cause: GitHub's macOS 26.6.2 VM (`RELEASE_ARM64_VMAPPLE` kernel) doesn't handle stop and continue signals, for any process. Every thread then sits in `kevent64` or `__ulock_wait` and never wakes. That is not md-sync and not Bun. The guard can't fire because its own worker thread is parked as well. Bare-metal macOS 27 passes.
- Not evidence about laptop sleep: real sleep suspends the whole machine and doesn't go through SIGSTOP, and on the same VM the guard's real stall test (`a main thread that stops running is killed`) passes.
- Fix: the test first checks the OS with a plain `sh -c 'sleep 1.5'` (stop, continue, expect it to exit within 5 s). If the OS fails that check, the test is skipped and a warning is logged. It still runs wherever suspend and resume work.
- The helper also drains the child's stderr, which was piped but never read, and a failure now shows the exit code, the signal, stdout and stderr.

## Verified

- Linux (Docker `oven/bun:1.4.2`, git 2.47): the move tests passed 3/3 times, and the lock test passes. `probes › currentBootId` fails only inside Docker (no boot id); it passes on CI.
- macOS CI VM: the suspend probe reports `broken`, so the suspend test is skipped, and the other liveness tests pass. Locally the probe reports `works` and the test runs and passes.
- `bunx tsc --noEmit` clean.
