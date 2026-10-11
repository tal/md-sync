# A fast default test suite with explicit integration coverage

`bun test` now runs the fast checks in `test/unit` in under three seconds locally. It previously also discovered long-running process, Git and watcher regressions, including deliberate process suspension and race stress loops. These cannot serve as a short feedback loop while keeping their real-process coverage.

Moved 25 complete test modules from `test/unit` to `test/integration` (bootstrap, cas-race, commit, conflict, exchange, git-args, git-classify, git-lfs, harness, ipc, live-git, liveness, lock, merge-attrs, merge-file, move, move-recovery, pending, preflight, replay, repo-defaults, rescue, spawn, sync and watcher). Split the CLI subprocess checks into `test/integration/cli.test.ts`; parsing, path handling and bookkeeping stay in the default suite. A content-hash audit verified that all 48 original test files' contents were preserved across relocation, reconstructing the CLI file from its two parts. No tests were deleted or newly skipped by this split.

Added `bun run test:integration`, `bun run test:acceptance` and `bun run test:all`. CI explicitly runs all three suites on both platforms, retaining the additional watcher/fallback-mode and binary/container jobs. Explicit paths outside Bun's configured unit-test root must start with `./`; fixed those existing CI and smoke examples too. README and contributor instructions describe the new test commands and layout. Production code is unchanged.

Validation: the literal `bun test` command passed 561 tests (one existing root-only skip) in 1.412 and 1.384 seconds wall time, both under a three-second process timeout. Type checking passed. The integration/acceptance suites retain their longer runtime and are not part of the default command's timing claim.
