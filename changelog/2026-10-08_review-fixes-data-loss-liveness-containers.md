# Fixes from the post-implementation review: data loss, liveness, containers, tests

An independent review of the finished implementation produced 25 confirmed findings. All 25 are addressed here, with two partial:

- **npm package name:** the documented install no longer pulls a stranger's package, but the rename itself needs your decision.
- **Shared container state volume:** the shared lock is documented, not solved.

Each fix has a regression test that fails before the fix. `docs/ARCHITECTURE.md` is updated for every behavior change, and `SPEC.md` where a product decision changed. Results: unit 793 pass (1 skipped), acceptance 67 pass, `tsc --noEmit` clean.

## Data loss (high)

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| "Edits made while git was stopped" all show up in `git diff-files`. | Staged work never appears there: a hand-resolved and `git add`ed conflict, a staged new note, or an amended commit at a `rebase -i` `edit` stop. P2's `--abort` deleted all of it, with no log line. | A new rescue row, `op-work`. It covers what is staged or committed relative to the abort target (orig-head for a rebase, HEAD otherwise). Content that git itself rewrote (onto, MERGE_HEAD) or wrote before the stop (by mtime) is skipped. The rest goes back in place, or into a copy if its base moved. |
| A conflict copy of a gitignored or `ignore`-matched file stays local. | Only the run that created the copy honoured that. The copy's new name no longer matched the pattern, so the next `git add -A` pushed the secret (`.env (conflict …)`). | `stageForCommit` excludes any untracked conflict copy whose original is ignored, using a new `copyOrigins`, `ignore`, and `check-ignore --no-index`. This is stateless, and it covers collision, stash, rescue and P5 copies. |
| An incoming add whose local file is byte-identical is safe to delete. | Not when the path is in the merge base, i.e. the local side deleted it in a commit. Examples: `git rm --cached` plus `.gitignore` to keep a file local, or a note restored from the Trash. The rebase replays that deletion, so the file was gone for good. | Such files are set aside under a copy name during the rebase. `settleSetAside` then puts each one back if the result has nothing at that path, drops it if identical, or keeps the copy. |

## Liveness

- **FIFO:** a FIFO in the folder froze the whole daemon on macOS, because `fs.watch` opens it and blocks.
  - The watcher's `ignored(path, stats)` now skips FIFOs, sockets and devices.
- **Symlinks:** chokidar followed symlinks out of the folder. One link to `/usr/share` meant a 20 s startup and about 40k file descriptors.
  - The watcher now uses `followSymlinks: false`. git syncs the link, not its target.
- **Continuous writes:** with `awaitWriteFinish` (500 ms), a file written more often than that was never reported, so max-wait never armed.
  - chokidar `raw` events now report the file immediately (mtime ≥ watcher ready).
  - Added §20 D29 and a SPEC clarification.
- **Config reloads:** each reload that changed `ignore` recreated the watcher and leaked one descriptor per watched path on macOS (a closed Bun `fs.watch` keeps its fd).
  - Added `setIgnore`, which swaps the matcher in place. Only a degraded watcher is still recreated.
- **Wall-clock steps (Linux):** a clock step made a live lock look `stale-pid-reused`. `btime` is recomputed from the realtime clock on every read.
  - The lock now also records `procStartTicks` (boot-relative `/proc` field 22), and liveness compares those first.

## Containers

- **Root-owned files:** the image ran as root, so every file it wrote into the host folder was `root:root`.
  - It now runs as `bun` (uid 1000).
  - `/state` and `/config` are `1777`, so `--user "$(id -u):$(id -g)"` also works.
  - The smoke test runs as the host uid and asserts file ownership.
- **Shared or reused state volumes:** every container's folder is `/data`, so state hashes collide.
  - Rescue manifests now carry the repo identity (root commits) and are never restored into another repo.
  - The README names the state volume per instance and says never to share one.
  - A shared *lock* still can't tell two containers apart. That is documented, not solved: a namespace check would break crash restarts.
- **Host processes:** live-git detection in a container can't see host processes.
  - Scans now report `visibility: 'own-namespace'`.
  - Locks and stopped ops must then be 10 minutes old (`NAMESPACED_STALE_MS`) before preflight treats them as abandoned.
- **Release assets:** they needed AVX2 and glibc.
  - Added `linux-x64-baseline`, `linux-x64-musl` and `linux-arm64-musl`, and a README table explaining which asset to pick.

## Smaller fixes

- **`print-workflow`:** now honours the committed repo-config `branch` (SPEC precedence).
- **`flush --path` from outside the folder:** a path that exists relative to cwd is rejected (exit 2) instead of being silently re-rooted. The folder-relative fallback stays for paths that don't exist there, and is now documented in D18 and the README.
- **State dir:** must be a real directory owned by us, otherwise the command exits 1. Rescue manifest paths are validated, because a planted `../../x` used to be written outside the folder.
- **`uninstall-service` after the folder was deleted:** now resolves the realpath of the longest existing ancestor, so `/tmp/notes` still hashes like `/private/tmp/notes`.
- **Boolean state:** replaced with string unions in `status`, `rescue` and `install-service`, and a source-scan test (`test/unit/style.test.ts`) guards against it.
- **Duplicated helpers:** eight copies of `errCode`, plus `kindAt`, `properPrefixes`, `isRecord`, `homeOf` and two EAGAIN write loops, are merged into `src/fsutil.ts`. The two write loops had already drifted apart (50×2 ms vs 20×1 ms retries).

## Tests that proved less than they claimed

- **Artifact check:**
  - It now checks every entry under each clone's `.git` against git's own set, and every ref (clones and remote).
  - A mutant that writes `.git/SYNC_STATE.json` now fails, and so does one that pushes `refs/tags/sync-*`. Both used to pass the whole suite.
- **Watcher unit tests:** they lost events written right after `ready` under load.
  - They now do a sentinel handshake before relying on events.
  - Two parallel runs, 0 of 8 failed; before the fix it was about 1 in 5.
  - The daemon needs no handshake, because the startup status check covers that window.
- **19(b):** it now asserts that the in-flight push itself lands. Before, the shutdown run silently re-pushed when git children were not detached.

## Bugs I found in my own changes along the way

- **Raw events and startup:** the first raw-event version reported files written *before* the watcher started, because macOS delivers late events. Fixed by requiring mtime ≥ ready.
- **Backdated test files:** backdating files in a test made `git merge --abort` fail with "not uptodate", because the index stat info was stale. The tests now refresh the index, as `git status` would.
- **Upgrade hazard (not solved):** a container upgrade from the root image fails with the new state-dir ownership check until `/data` and `/state` are chowned. The README gives the one-line fix.

## Needs your decision

- **npm name:** `md-sync` on npm belongs to an unrelated package (senntyou's gulp/sftp tool), so `bun add -g md-sync` installed someone else's code.
  - The docs now install from GitHub (`bun add -g github:<owner>/md-sync`) and warn about the npm package.
  - The package was **not** renamed (AGENTS.md: ask first). `mdsync` was free on npm on 2026-10-08.
