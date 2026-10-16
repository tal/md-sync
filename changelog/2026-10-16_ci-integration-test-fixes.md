# CI integration test fixes

CI had failed on `bun run test:integration` since 2026-10-13. Both runs failed on the same five tests. All were test-side problems; no `src/` change.

## Linux (`ubuntu-latest`)

| Test | Cause | Fix |
|---|---|---|
| `lock.test.ts` › release › does not remove a lock file that was replaced (different inode) | The test unlinked the lock and wrote a new one. ext4/overlayfs reuse the just-freed inode number at once, so the "new" file had the same `ino`, and release correctly removed it. | Rename the old lock aside instead of unlinking it, so its inode stays allocated, and assert that the inodes differ before releasing. |
| `move.test.ts` › a path rewritten every 50 ms through the whole move | The test assumed the move reaches identity mode, which needs a change in rounds 1 *and* 2. The 200 ms pause covers round 1 only. On Linux, round 2 finishes in under 50 ms, often between two timer writes, so the move ended with a plain conflict copy and never logged `worktree write raced` / `changing`. | Rewrite the file from `moveTestHooks.inWritePass` during round 2 (round number tracked through `afterSurvey`), so round 3 always runs in identity mode. |
| `move-recovery.test.ts` › d28-data-4 › copy-only / rename-only: a path rewritten every 50 ms … | Same cause | Same fix |

Learned: writing from `afterSurvey` is too early to count as a change in that round, because M3 classifies from a fresh read. A write has to land between the plan and the switch (the write pass) to be seen as a race.

## macOS (`macos-latest`)

- `liveness.test.ts` › a suspended process (SIGSTOP) is not mistaken for a stalled loop: on CI the child did not exit within 20 s of `SIGCONT` and the test's own SIGKILL ended it (exit 137). It does not reproduce locally on macOS: 12 runs with stop delays of 0–800 ms all passed.
- The helper now drains the child's stderr, which was piped but never read, so a child that writes to stderr can't block on a full pipe. A failure now shows the exit code, the signal, stdout lines and stderr. If it fails again, that output is the next step.

## Verified

- Linux (Docker `oven/bun:1.4.2`, git 2.47): the move tests passed 3/3 times, and the lock test passes. `probes › currentBootId` fails only inside Docker (no boot id); it passes on CI.
- `bunx tsc --noEmit` clean.
