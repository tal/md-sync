# Review round 3: repo identity, partial checkouts, Linux watcher, rule-file conflicts, and test gaps

The third review (data interactions, fix regressions, Linux static analysis, the macOS watcher, and a mutation lens) confirmed 35 findings: 2 critical, 10 high, 14 medium, 9 low. All 35 are addressed. Every fix has a regression test, and every new acceptance test was run against a copy of the round-2 source to check that it fails there. Each of the 12 surviving mutations was re-applied to a copy of the fixed tree to check that the new test kills it. `docs/ARCHITECTURE.md` covers every behavior change: new P0 and P1b, §10.7, and §20 rows D37–D44. `SPEC.md`, `AGENTS.md` and `README.md` are updated where a product decision changed.

## Critical

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| The synced folder is always a repository, because bootstrap checked that once. | Nothing stopped git from searching parent folders. After `rm -rf notes/.git`, or a wipe and `mkdir`, inside another repo, every git call acted on that parent repo. P6 switched its branch to `main`, S2 committed the notes into it, and S6 pushed them to the parent's remote, together with the user's unpushed WIP commit. | Every git client sets `GIT_CEILING_DIRECTORIES=dirname(folder)` and drops inherited `GIT_DIR`/`GIT_WORK_TREE`/… . A new preflight step **P0** checks that the folder is still its own repository. If not, the run fails with "is no longer a git repository". |
| A failed `git rebase` with no rebase dir changed nothing. | git checks out R first. It can fail partway on a file it can't write: a read-only folder, a name APFS refuses, a failed LFS smudge, a full disk. HEAD and the index stayed at L, but local-only notes were already gone from disk and local edits were back to R's text. The next commit run committed that damage and pushed it. With a name that can never be created, every run repeated it. | S5 snapshots the tracked worktree (`stash create`) before the rebase. In case (f), `undoPartialCheckout` resets to H, replays the snapshot, and removes files the checkout created from R. In case (c), R3 no longer saves what the checkout left (R's content or absence) as an edit, so the restore no longer deletes local notes a second time. |

## High

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| Round 2's interrupted-clone fix (`HEAD -> .invalid`) covered killed clones. | A kill **during** the checkout left a born HEAD, no `.git/index` and part of the files. The first commit run pushed the deletion of every missing file: 18 075 of 20 000 in the repro. | New **P1b**: with no index under a born HEAD, rebuild the index from HEAD, write the missing files, and finish any file git was killed while writing (its bytes are a strict prefix of HEAD's). Real edits are kept. |
| Pathspec excludes keep never-staged paths out of the index. | git on macOS rewrites argv paths to NFC. The NFD exclude of an NFC+NFD pair became a second NFC exclude, and `add -A` staged the NFD entry with the NFC file's bytes. With no edit at all, the Mac overwrote one spelling with the other's content on every device. | After every `add`, the index entries of never-staged paths go back to HEAD's through `update-index --index-info` on stdin, which git does not rewrite. |
| Pushes upload whatever git-lfs needs. | `core.hooksPath=/dev/null` also disables git-lfs's pre-push hook. The remote got pointers whose content existed on one device only, and every other device failed its pull with a smudge error. | When `.git/lfs` exists, S6 runs `git lfs push origin B` first. A smudge failure counts as a network error, so it is retried and never stays stuck. |
| A conflict copy is a safe home for the losing side of any file. | Not for `.gitignore`, `.gitattributes` or `.config/mdsync.json`: git and mdsync never read a copy. The losing device's rules vanished, and its next commit run pushed what they had protected (`secret.md` with `API_KEY=…`, `private/**`). | `.gitignore` and `.gitattributes` merge with `git merge-file --union`. The repo config merges per key, and the `ignore` patterns of both sides are kept (D37). |
| A gitlink in the replay is always unsupported. | Row 0 ran before rows 1–2. A nested repo that `add -A` had committed once made every later conflict replay a `data-guard-stop`, even when the remote never touched it. The device never synced again. | Rows 1–2 come first. Only a gitlink that both sides changed is unsupported. |
| inotify (chokidar on Linux) is a safe watcher. | Bun's per-path `fs.watch`, which chokidar uses, takes its two mutexes in opposite orders on the inotify thread and the main thread. Deleting a populated folder, or closing the watcher while events arrived, deadlocked the process. On macOS, the same Bun code with the chokidar backend hung in 2 of 13 runs. It also `open()`s every entry of a watched folder while holding a lock, so one FIFO froze startup in a crash loop. And it drops events for names that start with `.`. | Linux and containers now **poll**: `readdir` + `lstat` every 2 s, or 10× the last scan's duration if that is longer. No `fs.watch`, nothing opened, dotfiles seen, no inotify limits. The FIFO and folder-churn tests now run for every backend. |
| `container-smoke.sh` step 4 works. | Under `set -o pipefail`, `git log … \| grep -qx x.md` reported git's SIGPIPE (141) as "x.md is not on the remote". It failed 499 runs in 500, so the container job, `ci` and every release were red. | Output is captured first and matched with a here-string (`has_line`). A unit test forbids `\| grep -q` and `\| head` in the script. CI jobs got `timeout-minutes`. |
| (test gaps) | No test caught: a pull-only STASH CONFLICT that committed the other unflushed edits; or binary conflicts where local wins and the remote bytes are dropped. | New sub-tests in `03`, plus unit tests that run binary files through `handleRebaseConflict` and `replayStash`. |

## Medium

- **Shutdown push forked the remote:**
  - Before: with a remote whose history is on `master`, a stop pushed local `main` anyway (S6-only mode skips S3's branch check). The fork synced from then on.
  - Now: a shutdown push to a missing branch runs `ls-remote` first, and creates B only on a truly empty remote.
  - P6 no longer creates B in a clone that knows other `origin/*` branches but no `origin/B`, so notes are never committed onto a fork in the first place.
- **Notes stranded by a branch switch:**
  - Before: after `"branch": "master"`, P6 checked out master over local `main`, and the notes vanished from the folder.
  - Now: P6 counts the commits that neither B nor any remote branch has.
    - On a detached HEAD on top of B, it adopts them (B moves forward).
    - Otherwise it fails with a message that names them.
  - This also fixes the low finding about commits made on a detached HEAD being abandoned.
- **Name length on macOS:**
  - Before: the data guard rejected names over 255 UTF-8 bytes. APFS counts UTF-16 units, so a 90-character Japanese title was legal on the Mac. Every conflict replay on that Mac then stopped for good.
  - Now: the limit follows the local filesystem (UTF-16 units on macOS, bytes elsewhere).
- **Phantom case duplicates:**
  - Before: one disk file stands for two index spellings, so the pre-conflict stash captured a phantom edit. The Mac pushed a conflict copy of the other spelling's text on every remote edit.
  - Now: the stash replay drops a triple whose bytes equal another spelling's base blob.
- **NFD-tracked notes unreachable by path:**
  - Before: path-limited `status`/`add` precomposed the name to NFC and never matched the NFD entry. Edits never armed the timers, and `flush --path` exited 0 with nothing staged.
  - Now: those calls use the exact index spelling with `core.precomposeunicode=false`.
- **Case-only rename of the folder or a parent:**
  - Before: FSEvents went silent (Bun compares paths case-sensitively). `flush` and `status` hashed the new spelling, missed the daemon, and started a second sync.
  - Now: the daemon checks its canonical path every 15 s, logs `folder moved`, and exits 1 so the service manager restarts it there.
  - Until then, flush and status find it through the lock files.
- **Nested repositories:**
  - Before: a nested repository was committed as an empty gitlink, and nothing inside it synced.
  - Now: it is never staged. `nested repository not synced` is logged once per path, and `status` lists it (and existing gitlinks) under `not synced`.
- **Invalid committed repo config:**
  - Before: only a running daemon kept the last good layer, so every restart or one-off run pushed what `ignore` had protected.
  - Now: the last good layer is persisted in the state file. With none known on a device, commit runs stage nothing until the file is fixed, and they still pull.
- **Remote history rewrites:**
  - Before: S5 rebased onto R with R as the upstream, so a force-push that purged a secret was undone by the next sync.
  - Now: when the new `origin/B` no longer contains the previous one, only the commits made here since then are replayed (`rebase --onto R <old>`). The conflict replay uses the same base. This is logged as `remote history rewritten`.
- **Dotfiles on Linux:** fixed by the poll backend.
- **Test gaps** (each now has a test that kills the mutation):
  - a SIGTERM with a clean tree but unpushed commits;
  - a push refused by a pre-receive hook;
  - backoff that never grows past 30 s;
  - the stash-replay data guard.

## Low

- **Watcher error flood:** `watcher error` is logged at warn once per root and error code for the whole process, with a hint for ENOSPC and EMFILE. Later errors are logged at debug, and `onError` fires once per watcher.
- **systemd unit location:** the unit is written where the user manager looks: its own `XDG_CONFIG_HOME` from `show-environment`, else `~/.config`. An `XDG_CONFIG_HOME` exported only in a shell rc made `enable` fail.
- **Test gaps:**
  - the non-ff bound (3 retries) and its backoff sleep;
  - the stale-lock threshold at 55 s and 65 s;
  - the wake trigger through the daemon (`MDSYNC_TEST_WAKE_TICK_MS`, test-only, D44);
  - the liveness guard being armed (the worker now reports `liveness guard started`);
  - the conflict stamp in local time (a literal value under `TZ=America/New_York`).

## Learned along the way

- **The round-2 fixes had gaps of their own:**
  - The interrupted-clone fix covered only the fetch phase.
  - The NFD-alias fix made path-limited calls miss the NFD entry entirely.
  - The remote-duplicates route kept the phantom diff.
  - The NAME_MAX guard used the wrong unit for macOS.
  - The `master` check ran in S3, which shutdown mode skips.
- **The round-2 docs blamed kqueue for the watcher deadlock.** The inverted lock order is in Bun's platform-shared Zig code (`path_watcher.zig`, `Watcher.zig`), so Linux was never safe. §4.26 and D30 are corrected.
- **Bugs I hit in my own changes:**
  - The first poll backend reported every existing file on its first scan. Fixed with a baseline.
  - It would also have reported files that a reload had just un-ignored. Fixed by judging new entries with the previous scan's rules.
  - My first `refused commit` (unknown repo rules) returned before S3. A device that never saw a valid config then could never pull the fix. It now runs as a pull and fails at S7.
  - P6's stranded-commit count first counted commits that are on other remote branches. That would have refused a fresh clone of `main` configured for `"branch": "notes"`. It now uses `--not --remotes`.
  - The new pre-rebase snapshot (`git stash create`) failed a pull-only run in acceptance 11. `stash create` exits 1, with no output, when its first check (without an index refresh) sees a racily clean entry right after a `reset --hard` and its refreshed second check sees nothing. That now counts as "no changes". The harness's timeout message now includes the `error` of error lines, which is how this was found.
- **macOS limits I measured:** APFS allows 255 UTF-16 units per name (255 CJK characters work, 128 emoji do not). `git status -- :(literal)<NFD>` matches nothing with `precomposeunicode=true`, and matches with it set to `false`.

## Decisions worth a look

- **chokidar is now unused.** It is still in `package.json` and AGENTS.md, and its backend code is kept (not selected anywhere) until Bun fixes the lock order. Remove it, or keep it? Reporting the inversion to Bun upstream is also still open; the exact lock order is in §4.26.
- **Polling on Linux.** A 2 s minimum interval, adaptive to tree size. An FFI inotify reader (`bun:ffi`, directories only) would be cheaper, but it couldn't be tested here (no Linux, no Docker).
- **A repo-config key that both sides changed takes the remote value.** The local value is not kept as a copy, because a copy of a rules file is never read.
- **P6 refuses** (instead of switching) when a named branch has commits that no remote has. The sync stops with a message until you check out the branch or merge.
- **Test-only env hook** `MDSYNC_TEST_WAKE_TICK_MS`. The alternative was an 80 s SIGSTOP acceptance test.

## Results

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test test/unit` | 869 pass, 1 skip (was 837) |
| `bun test test/acceptance` | 103 pass (was 80) |
| New acceptance tests against the round-2 source | all fail there (`30`, `31` cases, and the new cases in `21` and `29` checked) |
| The 12 surviving mutations re-applied to the fixed tree | all killed |

All on macOS. The Linux-only paths (the poll backend as the default, systemd unit placement, the container smoke script) are covered by tests that also run in the `ubuntu-latest` CI job, but they weren't run on Linux here (no Linux, no Docker). The poll backend itself passed every watcher test on macOS, including the FIFO and folder-churn children.
