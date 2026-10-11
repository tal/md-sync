# D28 closed: no git command writes the worktree (implementation of ARCHITECTURE §7.8)

D28 was the last known way to lose a write: an agent's write that landed between a snapshot (a rescue's hashes,
`stash create`) and the destructive git op after it (`reset --hard`, `checkout -f`, `checkout-index -f`,
`<op> --abort`, git's own `rebase --autostash` internals). `32-chaos` lost 16 writes in 30 runs of 30 s and tolerated 6
per run. This change implements the design in `docs/ARCHITECTURE.md` §7.8. `32-chaos` now allows no lost write at all
(`D28_MAX = 0`, the D28-shape exemption is gone).

## What changed

| Before | Now |
|---|---|
| `git rebase --autostash origin/B` (S5) | `replay.ts`: local commits replayed in memory (`rev-list --cherry-pick` patch-id skip, then per commit `merge-tree --write-tree --merge-base=<c^>` + `commit-tree`, author/date/message/encoding read from the raw objects, objects written with `core.fsync=committed`). A conflict or a merge commit goes to the planner, as before. **Correction (review round 5):** "as before" was wrong: `git rebase` linearized merges and replayed root commits, and the planner squashed them into one `(conflict)` commit. Merges are now linearized too; only a merge with content of its own goes to the planner. Commit objects are now written from the raw author header (`hash-object -t commit`), and commits that start empty are kept. |
| `reset --hard`, `checkout -f`, `checkout-index -f`, the autostash | `move.ts`: one worktree move from `from` to `to`. It surveys what differs (and whatever is in its way), classifies by content (git's bytes, or an edit), plans with the existing planner, journals every temp name, then switches path by path with checked writes. The index and the ref move only after the worktree and its folders are on disk. Uncommitted edits are kept, three-way merged or copied: no stash. |
| `reset --hard` after a snapshot | `cas.ts` + `exchange.ts`: a put re-reads the bytes through a held descriptor right before the switch, swaps the new version in atomically (`renamex_np(RENAME_SWAP)` / `renameat2(RENAME_EXCHANGE)` through `bun:ffi`), and checks that what came out is the same inode. The replaced inode stays linked for `SETTLE_GRACE_MS` (5 s) and is unlinked only if it still holds exactly the replaced bytes; anything a late writer added is kept as a conflict copy. Filesystems without an exchange (`rename-only`) or without hard links either (`copy-only`, exFAT) are found by a probe. |
| `rebase --abort`, `merge --abort` … of a person's stopped op (P2) | `<op> --quit` (touches nothing), then a move to the abort target, with git's own output recognized by content only (`AUTO_MERGE` for unmerged paths, stage blobs, reproducible trees). |
| collisions pass, set-aside, `commitCollisionCopies` | Inside the move's own plan. `collisions.ts` is deleted. An identical file in the way is now kept, not removed; a folder in the way moves whole. |
| `git clone` with its checkout | `git clone --no-checkout`; the first run's P1b populates the folder with a move (an agent's file at an incoming path is kept, or kept beside a copy). |
| P5, P6, the stash replay, P3 restores, legacy journal parts | All through the move or `applyOps` (checked writes with a journal). |
| Writes in the D28 window lost | Kept: merged, left in place, or in a conflict copy. |

Also: `requireGitVersion` (git ≥ 2.40, daemon and one-offs, and the Dockerfile build), a settle timer in the daemon
(`PullReason` `settle`, `RunResult.settleDueAt`), `settlePending('all')` at shutdown and after one-off runs,
orphaned temp folders recovered as local-only `recovered (conflict …)`, `MDSYNC_TEST_MOVE_PAUSE_MS` and
`MDSYNC_TEST_EXCHANGE_MODE` test hooks, `LOG_MSGS` synced to §15.

## What the tests found in the design (and in my code)

| Assumption | What actually happened | Fix |
|---|---|---|
| `AUTO_MERGE:p` is git's conflict output (§6 P2). | `AUTO_MERGE` is a whole tree: for a path that is *not* conflicted it holds HEAD's content. In a rebase stopped on its second pick, HEAD holds the person's hand resolution of the first: read as git's output, it was replaced by the abort target's version with no copy. An existing preflight test caught it. | `AUTO_MERGE:p` counts only for paths with unmerged stages (stash replay too). |
| An op-quit edit's base is the index stage-0 entry (§6 P2). | A person's *staged* edit at a path the abort leaves alone became a conflict copy instead of staying in place, as it did before (tests). | The base is `from` (HEAD): staged edits stay in place where G keeps the path, and are copied where G changes it. |
| The stash replay writes `p.writes ∪ p.deletes` (§7.3 T3). | Paths where the plan keeps H's version still held git's conflict markers from the autostash apply; the old `reset --hard target` had replaced them. | Every stash-changed and unmerged path is also put back to the work tree's version while it holds git's output. Only a skipped write/delete/copy keeps the stash; a folder an agent made at a kept-remote path no longer does. |
| P4 reruns a stash replay "from scratch". | With `unmerged: skip`, git's markers are not recognized after a crash, and the stash was kept forever. | The rerun uses the AUTO_MERGE policy P5 uses. |
| P3 can decide every rescue row first. | A shadowed note decided "copy" because the file at its folder's path had not been re-deleted yet. | The deleted rows are applied first. |
| `undo()` (M9) moves folders back after undoing puts. | Only when there were puts to undo. | Folder move-asides are always undone (when the name is free). |
| A committed copy whose link failed is written from its blob later (M5). | Round 2 classified against `i.to`'s tree, which lacks the copy: the index would get it, the disk not, and the next commit would have pushed its deletion. | After the copies commit, later rounds measure against `final`; an existing committed copy is never touched. **Correction (chaos round 2):** this fix was claimed but only half made. The code re-surveyed the copy in round 2 but still classified it against `to`, so it was never written, and 8 of 44 dumped chaos runs pushed a delete of it. See "Chaos round 2" below. |
| Rename-only mode loses "at most 1 per 1 000" (§7.8.8). | The §7.8.0 probe itself measured 66 of 8 333 atomic saves; a write made into such a raced save's own inode before the rename goes with it. | The race test asserts the shape (only atomic saves between C5′'s link and rename, plus writes into their inode), bounded at 3% of atomic saves under a hammer that concentrates 25 writes in each 3 ms window. Exchange and copy-only modes: 0 lost. |
| A patch-id test can cherry-pick the local commit. | Within the same second, `cherry-pick` reproduced the identical commit object, so nothing was local any more (flaky). | `cherry-pick -x`. |

## Chaos round 1: what 46 runs found after the close

24 official runs of `32-chaos` (seeds 100–119 at 30 s, poll watcher for 103 and 111, 120 s for 105 and 117) and 22 runs of
a stricter variant. 22 official runs passed; seed 110 lost a write and the 120 s seed 105 left a device stuck for good.
Every root cause below has a deterministic regression test that fails on the old code and passes now.

| Seed | What happened | Root cause | Fix | Test |
|---|---|---|---|---|
| 110 | A remote edit was deleted on every device: B's `tok-110-42` at `d1/e0/g2.md`, pushed, then removed by A's next commit. No `delete overridden`. | M2 hashed A's edited file; A's agent renamed it during M2–M3 (~100 ms of materialize and `check-attr`); M3's re-read got `gone`, and `classify` returned `nothing`. No op, no `again`, but M8 still wrote `to`'s index entry, so the next `add -A` staged a delete. | `gone` re-lstats and classifies what is there now (absent: a local delete, so the remote edit is `delete-overridden` and restored); gone twice, the path joins `again`. Never `nothing`. | `move.test.ts` seed 110 (new `moveTestHooks.afterSurvey`) |
| 105 (120 s) | Device C failed 241 runs in a row (about 2 a second, across a restart): `conflictCopyPath: no free name for d2/e0/g2.md after 100000 candidates`. No convergence, leftover journal. No byte lost: they sat in an aside. | A `late` aside whose path's folder `d2/e0` had become a file in HEAD. `copyNamer` rejected every name under a file prefix, and `keepAsCopy` called the namer outside its `try`, so the throw escaped settle and P4. The entry stayed, so every run failed, and the overdue settle timer re-fired at once. | `copyNamer` names the copy under a copy of the blocking folder (`d2/e0 (conflict …)/g2.md`, as the planner names clash copies), and treats `ENOTDIR` as taken. `keepAsCopy` never throws (path, then top level, else `stuck`). `settlePending` handles each entry on its own: a stuck one stays, due after another grace. The daemon never re-arms an overdue settle timer at once after a failed run (`settleTimerDue`). | `move.test.ts` seeds 105/117 (three tests), copyNamer test, `daemon.test.ts` |
| 105, S5 branch | (found reading the code) | `settlePending`'s S5 branch also named outside its `try`, and on a failed `copyOut` it dropped the bytes: `copyOut` had already closed the only descriptor to an unlinked inode. | `copyOut` leaves fd open; `copyOutStable` tries the path's copy, the top level, then a fresh temp-folder name kept by a new settle entry (journaled first). | `move.test.ts` S5 test (new `moveTestHooks.settle`), `cas.test.ts` |
| 117 (120 s) | Passed, but device A failed 50 runs in 41 s with the same error. It recovered only because the test's agent renamed the aside out of the temp folder. | Same as 105. | Same. | Same. |
| 103 (and 21 of 24 runs) | Worktree files sharing one inode at the end of most runs (up to 8 names), 220 `late` events, duplicate conflict copies (seed 100 ended with 14 README copies). | A conflict copy is a hard link to the local version; the put then replaces that inode, so the aside *is* the copy. `casPut` built every aside with `copy: 'none'`, so settle's S2 never applied: an agent's edit of the copy within the grace read as a late write, and settle linked the inode under a second copy name. Agent renames then spread the link to tracked notes. | Every put whose path's inode a copy links carries `copy` (the move, P5, and a resume via `MoveTemp.copy`); S2 also accepts `nlink ≥ 2` (a copy an agent renamed); a copy left sharing an inode with another worktree name (failed move, skipped put, original renamed away) gets an inode of its own (UNSHARE). | `cas.test.ts` (2), `move.test.ts` seed 103, M9 and applyOps unshare tests |
| 111 (poll) | One run failed: `git add exited 128: fatal: unable to stat 'd1/.f0.md.sb-tok-111-11'`. | `git add -A` lists, then lstats: an atomic-save temp renamed away in between. Not retried. | `addRetrying`: at most 3 runs on "unable to stat" / `open(...)` ENOENT; anything else still throws. | `commit.test.ts` |
| 100 (all seeds) | The harness itself: `32-chaos` still had `D28_MAX = 6` and the `d28Shape` exemption, and its agent wrote into mdsync's temp folders (324 of 3 549 ops). | Not updated for the close. An overwritten aside hid its tokens, temp files counted as on-device, `checkout-index --prefix` counted as destructive, and the agent's appends into asides caused both stuck devices. | Per §7.8.8: `walk` skips `.mdsync-*.d`; `D28_MAX = 0`, no exemption, every lost token fails; raced kinds reported; quiesce waits for settle and no temp folder may be left; new invariant: no two worktree files share an inode. | the test itself |

### The acceptance suite was not green after the close

This round's brief said all 116 acceptance tests passed, but the last green log (14:57) predates the close's `src/`
changes. On the close's code (before any change of this round), 13 tests in 5 files failed. They found two real
defects (the 4 `05` failures and part of one `20` failure); the rest asserted behavior the close removed on purpose:

| File | Failed because | Now |
|---|---|---|
| `05-mid-rebase-recovery` (4) | **Real:** git 2.55's `rebase --quit` leaves `REBASE_HEAD`, `AUTO_MERGE` and `MERGE_MSG` in `.git` (`--abort` removed them). A stale `MERGE_MSG` prefills the person's next `git commit`. | P2 removes them after a `rebase`/`am` quit (also when P4 finds the quit done); `preflight.test.ts` asserts it. |
| `20-collisions` (2) | Stale: an identical file in the way is now `kept-identical` (was `removed-identical`), and a folder in the way `moved-folder`. **Real, minor:** the `collision` line for a file in the way of an incoming folder named the file itself as `incoming` (`topic`, not `topic/x.md`). | Expectations follow §7.8.4; the survey records which incoming path a blocking file is in the way of. |
| `21-empty-remote` (1) | Stale: the clone is `--no-checkout`, so files arrive in the startup run's P1b, after `daemon ready`. | Waits for the startup sync. |
| `31-data-edge-cases` (1) | Stale: asserted `recovered {action: 'partial-checkout-undone'}`; there is no partial checkout any more. | Asserts the move failed, HEAD stayed at the device's own commit, and nothing harmful was committed (§7.8.8). |
| `33-concurrent-writes` (5) | Stale: every test drove `git rebase --autostash` through a `git` wrapper, and that command no longer runs. | Rewritten per §7.8.8 around `MDSYNC_TEST_MOVE_PAUSE_MS`: writes into the paused gap of a pull (append, rewrite, atomic save), a conflict replay, a stash replay (P5) and P2's op-quit move are merged or copied; a write through a descriptor opened before the switch and issued 1 s later is a late copy; a path rewritten every 20 ms ends in an identity copy with the run ok. |

What I got wrong along the way:

- The first unshare test asserted `nlink == 1` on the original right after the failed move, but our own aside (in the
  temp folder) still links it until settle. The invariant is about worktree names: the assertion moved after settle,
  and the unshare counts our asides as not sharing.
- The first `git add` retry test faked only `git.run`; the old code called `git.ok`, so on the old code it failed for
  the wrong reason (no add at all). The fake's `ok` now goes through the same injection, and the old code fails with
  seed 111's exact error.
- My first rewrite of the `31` read-only case asserted `HEAD == log[0]`, which is always true. It now checks what HEAD
  holds (B's note and edit) and that it is not R.
- Each regression test was run against the original sources (with only the two test-hook call sites added): all 8
  move tests, the 3 cas tests, the commit test and the P2 assertion fail there, each for its seed's reason.

## Chaos round 2: what 50 runs found after round 1

50 runs: 24 official (seeds 120–139 at 30 s; poll watcher on 120 and 121; 120 s on 122 and 123) and 26 extra (140–159 at 30 s in 5 parallel lanes; 160–163 with `MDSYNC_TEST_EXCHANGE_MODE=copy-only`; 164 and 165 at 300 s). All 50 passed. In the 44 runs that were dumped, 6 994 writes were made and none was lost. There were no non-convergence, stuck devices, leftovers or shared inodes, and one SIGKILL mid-move was resumed. A stricter check of the remote history, which the test did not have, found one defect: 8 commits that deleted a committed conflict copy that no agent had deleted.

| Seeds | What happened | Root cause | Fix | Test |
|---|---|---|---|---|
| 121 (poll), 138, 141, 149, 157, 158, 160 (copy-only) | A pull-only move committed a copy of an uncommitted edit in its copies commit, and the copy was pushed. The device's next backup commit then deleted the copy (`D README (conflict … 2).md`), and the other devices pulled the delete. Every one followed a move whose `conflict` log listed the same origin twice. No token was lost: the snapshot stayed in the copies commit, and the round-2 survey kept the agent's newer bytes. But the tip deleted a file that nobody deleted, and an editor that saves an old buffer would leave the snapshot's extra bytes only in history. | Round 1 committed the copy, and then its `linkCopy` was refused: the agent rewrote or appended to the origin between M3's hash and M5's link. The round-1 fix above added the copy to round 2's candidates, but `toTree` was still `lsTree(i.to)`, which has no copy. So the copy's slot was `toSide: absent`, `look: absent`, and classify returned `nothing`. M8 then gave HEAD and the index the copy, the disk never got it, and the next `add -A` staged the delete. `resumeMove` was never affected: its `to` is the journaled final. | `measureAgainstFinal`: after the copies commit, later rounds use `final`'s tree (and versions materialized from `final`), as a resume does. The copy is then an incoming file and gets a create-only put from its blob. Copies the move itself made (linked, copied, or moved with their folder) are never surveyed or written again (`madeCopy`), so an agent that deletes or edits one during the move keeps that change. Without this rule, measuring against `final` would have brought back a copy the agent deleted (the guard test fails that way). | `move.test.ts` "chaos round 2 regressions" (rewrite, append, rename; linked-then-deleted stays deleted), `33-concurrent-writes` (all three in the paused gap of a daemon's pull, then a flush: no commit on the remote deletes a file) |
| 164 (300 s) | The rename variant: C's agent renamed the origin away during the move, and C's next commit deleted the committed copy. The bytes survived at the new name. | Same. Here the link was refused because the origin was gone, not changed. Round 2 classified the origin as a local delete and the committed copy as `nothing`. | Same. The copy is written, the remote edit is restored at the origin (`delete overridden`), and the renamed file stays. | the same tests (rename case) |
| (none; found reading the code) | The same defect for a folder. A folder in the way of an incoming file moves whole to its copy folder, and its files' copies are committed under that name. If an agent removed the folder (or replaced it with a file) between M3 and its move-aside, `moveAside` returned `missing` and the op was silently skipped, so the move finished with the copies in HEAD and not on disk. A folder replaced by a file was moved as a file onto the copy folder's name, so no copy under it could ever be written. | `runOps` ignored `missing`, and never checked that the folder was still a folder. | A whole-folder move-aside (`gone: 'again'`) whose path is gone or is no longer a folder blocks its key. The next round plans the path again and writes the committed copies from their blobs. Identity move-asides are unchanged (`gone: 'fine'`). | `move.test.ts` (folder removed; folder replaced by a file) |
| 32-chaos itself | The test could not see this defect: every run passed. | No check covered the history. Lost tokens look at the tip and the disks, and the snapshot was in an earlier commit. | New invariant: no commit deletes a conflict copy unless the committing device's agent deleted it, renamed it away, or removed a folder above it, at or before the commit's time (+1.5 s, because commit times are whole seconds). It is checked on the remote's `log --no-renames --name-status`. Run over the 44 dumped runs, it flags exactly the 8 known commits and nothing else. | the test itself |
| 128 and 11 others | 12 `worktree write raced {kind: late}` events in 50 runs. All were matched to agent ops: an in-place edit through a conflict copy's name, followed within the grace by an atomic save, delete or folder delete of that name. | By design. This is the open item below. Settle can't tell this from a write through an old descriptor, so it keeps the bytes. | None. Not a loss. | — |

What I learned or corrected:

- **The round-1 row above was wrong about the code.** The copy was added to round 2's candidates, but nothing wrote it. The doc (§7.8.4 M5) already said the right thing; the code didn't do it.
- **Measuring against `final` was not enough on its own.** Done by itself, it would resurrect a committed copy that the agent linked and then deleted during the move: the old candidate rule, "not on disk", also matched that copy. The candidate rule is now "not made by this move and not yet written". `classify` treats a made copy as the person's.
- **Each regression test fails on the old behavior.** I checked this by disabling the fix: the three link-refused tests fail with "bytes: undefined", the folder test fails, and the guard test fails when `madeCopy` is removed. The scratchpad repro `copy-link.test.ts` (seed 121's shape through a daemon) failed before the fix and passes after it.

### Results after round 2

Measured 2026-10-08 on macOS (APFS, exchange mode), git 2.55, Bun 1.3.13.

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test test/unit` | 974 pass, 1 skip, 0 fail (975 tests, 43 files; 5 new) |
| `bun test test/acceptance` | 118 pass, 0 fail (118 tests, 33 files; 1 new). `24-ntfy-reconnect` passed this time. |
| `32-chaos` with the new invariant, failing seeds in their original modes | 13 runs in 5 parallel lanes: 121 (poll watcher), 138, 141, 149, 157 and 158 (30 s), 160 (`copy-only`) and 164 (300 s), plus 120 (30 s and poll), 121 (30 s), 128 and 131. **All 13 pass.** |
| Writes / lost | 2 235 writes, **0 lost**. The token-history check over the remote's history (every commit that drops a token from the tree is matched to an agent op) found 0 unexplained drops. |
| Phantom copy deletes | 0, from both the test's invariant and the same check run on the dumps. The defect's exact shape came back once, in seed 149: A's agent overwrote `README.md` at 42.616, between M3's hash at 42.577 and the link, and the move copied `README.md` twice. No commit deleted the committed copy. |
| `worktree write raced` | 4 `late` in 13 runs. 3 are the known open item below: a copy edited in place, then saved atomically or deleted within the grace. The 4th (poll 121, device B) is the irreducible check-then-write race. The agent's in-place overwrite of `d0/f1.md` at 57.195 landed in the inode that a pull's exchange was replacing at that moment (the pull ran from 56.913 to 57.302 and brought A's version). Settle kept the bytes (`tok-121-61`) as `d0/f1 (conflict … 0202).md`, and they were committed and pushed. It is a copy, not a loss. |
| Stuck devices, leftover journals or temp folders, shared inodes, conflict markers, stashes | none |

## Review round 5: twelve confirmed findings, fixed in severity order

Two reviewers (a "data" lens on crash and error paths, a "semantics" lens comparing the new flow with the old
`git rebase --autostash` on twin clones) confirmed 12 findings, each with a repro. Every fix has a regression test that
fails on the code before it (run against a pristine copy of the pre-round sources; the tests that need the new
`moveTestHooks.inWritePass` seam ran there with only that hook added).

| # | Sev. | What went wrong | Fix | Test |
|---|---|---|---|---|
| data-1 | high | A crash during M9's undo: the undo's temps (whose `want` is `from`'s version, or absent) were appended to the same move part, so `recoverTemps` marked those paths done. The resumed move returned `moved` with HEAD at R over `from`'s bytes: the next commit pushed a revert of the remote edit (`x v1`), the deletion of a remote-added file, or on an unborn first sync the deletion of every file the undo had removed. | `undo()` first sets phase `undoing` (new). `resumeMove` never builds a done map from such a part: it clears it (op-quit: back to `planned`; an applyOps caller: rerun) and returns `failed`. HEAD and the index are still at `from`, so the next run moves again from scratch. Also: an exception once M8 began (phase `index`/`ref`) no longer undoes; the part stays for P4. | `move-recovery.test.ts` (modify, create, unborn) |
| sem-1 | high | The settle timer's run (preflight only) ended `ok` and counted as a sync: 5 s after any failed run that had replaced a file it cancelled the 30 s retry, reset the backoff, replaced `last error` and cleared the stuck record. An unpushed commit waited for an unrelated trigger. | `runBookkeeping(req)`: a pull whose reasons are all `settle` is `settle-only`. `recordRun({bookkeeping})` keeps `lastRun`, the failure count, `lastOkAt` and the stuck record when it ends ok; the daemon keeps the retry and its backoff. A failed one is recorded but never touches the stuck record. | `daemon.test.ts`; `08-non-ff-retry` (push rejected after a pull that replaced a file: the +30 s retry pushes, `status` keeps `last error` and `retry at` until then) |
| data-2 | medium | Copy-only: a crash between C5c's `rename(path, aside)` and its create left the path absent, the merged version in the temp and the person's edit in the aside. The resume unlinked the temp as "never switched in", surveyed the absent path as a local delete (`delete overridden`, remote version written), and settle unlinked the aside. The edit survived only as a dangling loose object. | `recoverTemps` finishes a switch cut in two: the temp holds `want`, its paired aside exists (another inode than the path's), the path is absent → `renameNoReplace(temp, path)`. On `excl-open` filesystems an O_EXCL copy cut part-way (C2 or C5c: the path holds a strict prefix of the temp) is finished by appending the rest. A switch that began and can't be finished keeps its aside whole (`expect: 'inode'`: a copy). `MDSYNC_TEST_EXCHANGE_MODE=copy-only` now also caps the no-replace create at `excl-open`, as on real exFAT. | `move-recovery.test.ts` (path absent, path holding a prefix, a create cut part-way) |
| data-3 | medium | `buildTree`'s `write-tree`, `commitTree` and `writeBlob` ran without `core.fsync=committed`, then a ref was moved to their commit: the move's copies commit, the conflict replay's C, the stash replay's copies commit, merged blobs. A power loss could leave HEAD naming a missing object. | All three are durable. S2's `git add` and `git commit` too (same chain: a ref moves to their objects). | `move-recovery.test.ts` (parses the git debug log of a pull with a committed copy and a merged blob, and of a conflict replay) |
| data-4 | medium | Identity mode in copy-only mode (or where `link()` is refused for an inode): the identity copy is a byte snapshot, and the put's inode check (`lstat(copy).ino == lstat(path).ino`) never passes. The move returned busy, every later P4 resumed it busy (no commit, pull or push while the agent kept writing) and each resume added two more copies. | `Expect` gains `{snapshot, copy, digest}`. When the identity copy op returns `copied`, its put becomes a snapshot put: no content check, the inode moves aside whole (C5c; C5 in exchange mode), and the aside settles against the snapshot's digest (anything written after the snapshot is a second copy). | `move-recovery.test.ts` (copy-only and rename-only, a path rewritten every 50 ms) |
| sem-2 | medium | `replayCommits` sent any merge or root commit to the planner, which squashed the whole local history into one `sync <host> … (conflict)` commit by the configured identity, even with no conflict at all. `git rebase` linearizes. | Linearized like `git rebase`: the non-merge commits replay in topological order, a root commit with the empty tree as its base. A merge is dropped only when `merge-tree <m^1> <m^2>` reproduces its tree (nothing of its own); a hand-resolved or edited merge, or an octopus, still goes to the planner, which keeps that content (safer than rebase, which drops it). | `replay.test.ts` (merge vs the rebase on a twin clone, same subjects/authors/tree; a hand-resolved merge → `has-merges`; unrelated histories) |
| sem-3 | medium | An uncommitted edit was merged with plain `git merge-file`: a path's `merge` attribute was ignored. An append to a `merge=union` log became a conflict copy (committed and pushed); the autostash apply had merged both lines in place. | `mergeAttrsOf` (`check-attr --attr-source=<to> merge`, plus `merge.default` and `merge.<name>.driver`) and `makeMerger({attrs})`: `union`, `binary`, `-merge` and configured drivers are merged by git itself, `git --attr-source=<rev> merge-tree --merge-base=<B> <R> <L>` over single-path trees, with the remote as "ours" as in the rebase. Unspecified, set, `text` or an unknown driver name keep the line merge (git falls back to text too). The stash replay uses H's attributes, the conflict replay R's. | `merge-attrs.test.ts` (union, `-merge`, `merge=binary`, a driver, an unknown name; a pull-only `syncRun` against `git rebase --autostash`) |
| data-5 | low | A temp cut short by a crash in the write pass (O_EXCL create, part of the bytes) was read on resume as a switched temp holding the replaced inode: settle kept it as a `late` conflict copy of junk, committed and pushed. | Each completed write pass is journaled (`MoveJournal.written`). A temp at or after that mark was never switched in: it is unlinked on resume, whole or not. `resumeMove` then sets `written` to the number of temps. | `move-recovery.test.ts` (`moveTestHooks.inWritePass` crashes after truncating a temp) |
| data-6 | low | A failed write pass, a put that stopped `runOps` with an error, and applyOps' write-pass failure left the round's unswitched temps behind, unjournaled once the part was cleared. Each ENOSPC retry leaked more. | `writeTemp` unlinks its own temp on a failure after the create; a failed pass unlinks every temp it made; a switch pass that stops early unlinks the temps of the puts it never reached (rule (a)). | `move-recovery.test.ts` (three ENOSPC attempts; an EACCES put; `writeTemp` with an unreadable source) |
| data-7 | low | A crash between a rename-follow's create of the new name and the delete of the old one: the resumed survey required the new name to be absent, so the old name became `edit-restored`, and the next commit pushed it back beside the renamed note. | `recoverTemps` returns the journaled deletes (path → the sha256 they were planned against). On resume the follow is allowed when q is done and still holds its done want, p still holds exactly the journaled bytes, and p's edit is provably saved (q's version is not `to`'s plain one, or p's journaled copy holds p's bytes): p gets a checked delete. Otherwise p stays (never a lost edit). | `move-recovery.test.ts` (deleted; edited again after the crash: kept) |
| sem-4 | low | The replay rebuilt authors through `GIT_AUTHOR_*` + `commit-tree`, whose ident check rejected an empty name (the device failed every run for good) and rewrote `"Alice"` and `Alice Jr.,`; a header without a timezone failed to parse. `git rebase` copies the header. | Each replayed commit object is written with `hash-object -t commit -w` (durable): the original author header byte for byte, the configured committer (`git var GIT_COMMITTER_IDENT`), the encoding header and message bytes. git's object check refuses a header git never writes (no timezone): then `--literally`, as the original object holds the same line. `GitRunOpts.author`/`encoding` and `GitAuthor` are removed (no caller left). | `replay.test.ts` (four author shapes) |
| sem-5 | low | A commit that started empty (`git commit --allow-empty -m checkpoint`) was dropped as "became empty"; `git rebase` keeps it. | A commit whose tree equals its parent's is kept (the tip's tree with its metadata); only one that becomes empty is dropped. | `replay.test.ts` (a checkpoint kept, a commit that becomes empty dropped, against the rebase) |

What I learned or corrected along the way:

- **My first copy-only tests ran in exchange mode.** The volume probe is cached per filesystem for the whole process, so setting `MDSYNC_TEST_EXCHANGE_MODE` inside a test file changed nothing once another test had probed the volume: the identity test "passed" in exchange mode, and the C5c tests failed for a state that can't happen there. The tests now `reprobe` and assert the capped mode (and `excl-open`) before moving.
- **The reviewer's data-5 repro simulated an impossible state under the fix.** It truncated a temp after the write pass had completed. With the `written` mark, a real crash inside the pass leaves its temps after the mark; the regression test crashes inside the pass instead (`moveTestHooks.inWritePass`). A temp truncated after a completed pass is still treated as a replaced inode (kept), which is the safe reading.
- **Finishing a cut copy by appending is only safe on `excl-open` filesystems.** Elsewhere every create is atomic, so a strict prefix at the path is someone else's file (an agent's empty file is a prefix of anything). The append is restricted to `excl-open`; completing an absent path from its temp applies everywhere.
- **`merge-tree` honours `--attr-source` with tree arguments**, both for `merge=union` and for a configured driver (probe in `r5/probe-mt`). The union order follows the rebase: remote lines first, then local.
- **`git rev-list --cherry-pick` treats two empty commits as the same patch:** a local empty commit is skipped when upstream has one too, exactly as `git rebase` does, so keep-empty only applies to the others.
- **The `-merge` attribute reads as `unset` from `check-attr`**, the same word my own "no config value" sentinel used: my first version skipped `-merge` paths entirely. Caught by the `-merge` test.
- **A test helper read `args[0]` as the subcommand**: durable calls now start with `-c` pairs (`conflict.test.ts` `gitCalls` strips them).

### Results after review round 5

Measured 2026-10-08/09 on macOS (APFS), git 2.55, Bun 1.3.13.

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test test/unit` | 1003 pass, 1 skip, 0 fail (1004 tests, 45 files; 29 new, 3 rewritten) |
| `bun test test/acceptance` | 119 pass, 0 fail (119 tests, 33 files; includes `32-chaos` seed 7 and the new `08` settle/retry test) |
| `33-concurrent-writes` with `MDSYNC_TEST_EXCHANGE_MODE=rename-only` and `=copy-only` (now `excl-open`) | 7 + 7 pass. The review had seen the copy-only "a path that keeps changing" case fail (busy). |
| New tests against the pre-round sources | 13 of 16 `move-recovery`, 4 of 5 `merge-attrs`, 4 of 5 new `replay` tests plus both rewritten ones, and the `08` test fail there; the rest are guard tests that pass both ways (the new `daemon.test.ts` cases need `runBookkeeping`, which the old code lacks). |
| `32-chaos`, 12 runs in 3 parallel lanes | seeds 200–204 (30 s), 205–208 (30 s, `copy-only` with `excl-open`, confirmed by the daemons' `worktree exchange unavailable {mode: copy-only}`), 209 (30 s, poll watcher), 210 (120 s), 211 (120 s, `copy-only`). **All 12 pass.** |
| Writes / lost | 1 832 writes, **0 lost**. No phantom copy deletes, stuck devices, leftover journals or temp folders, shared inodes. |
| `worktree write raced` | 1 `late` in 12 runs (seed 202, device B): the known open item below. The agent overwrote `README (conflict … 4).md` in place, then saved it atomically 1.4 s later, within the grace, so the aside of the inode that copy used to name settled as a second copy (`… 5).md`). A copy, not a loss. |

## Final gate after review round 5 (2026-10-09)

No source change. The last `move.ts` edit of round 5 (23:51) came after that round's unit and acceptance runs, so the whole gate ran again on the final code. Measured on macOS (APFS, exchange mode, on AC), git 2.55, Bun 1.3.13, every run under `caffeinate -i -s`.

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test test/unit`, twice | 1003 pass, 1 skip (root-only `paths` test), 0 fail, both runs (1004 tests, 45 files) |
| `bun test test/acceptance`, twice | 119 pass, 0 fail, both runs (33 files). `32-chaos` seed 7 inside them: 95 writes, 0 lost, both runs |
| `32-chaos`, seeds 500–514 at 30 s, plus 503 and 511 with `MDSYNC_TEST_WATCHER=poll` (3 parallel lanes) | **17 of 17 pass.** 1 737 writes, **0 lost** (`D28_MAX = 0`) |
| `bun build --compile` + `codesign --force --sign -`, then `test/smoke.test.ts` with `MDSYNC_BIN` | 1 pass |
| Compiled binary's primitive (a scratch check, not in the repo) | A pull that hits a local file runs in `exchange` mode: no `worktree exchange unavailable`, so `bun:ffi`'s `renamex_np` works inside `--compile`. The local bytes were kept as a conflict copy |

`32-chaos` now prints one line per run, `chaos seed N: W writes, R removed by an agent, L lost`, so the counts come from the test's own check instead of from a dump.

What the runs showed:

- **`worktree write raced`: 1 `late` in 17 runs** (seed 505, device C). It is the known open item: the agent appended to a conflict copy that shared the replaced inode, then deleted the copy within the grace, so settle kept the aside as `README (conflict … 2).md`. A spurious copy, not a loss.
- **The scratchpad token-history analyzer (`analyze.ts`) flagged one drop, and it was a false positive.** In seed 508, C's agent overwrote `x2/z-B-30.md` (which held B's `tok-508-31`) while B's agent renamed it to `d0/e0/g2.md`. C's replayed commit carried the overwrite to the renamed path, as `git rebase` would. The test counts the token as removed by an agent. The analyzer only follows renames forward on the device that removed a token, not another device's rename of the same file.
- The brief's baseline (889 unit, 116 acceptance) was out of date. Round 5 left 1003 unit and 119 acceptance tests.

## Results (chaos round 1)

The results after chaos round 2 are in its own section above.

Measured 2026-10-08 on macOS (APFS, exchange mode), git 2.55, Bun 1.3.13, after chaos round 1.

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bun test test/unit` | 969 pass, 1 skip, 0 fail (970 tests, 43 files) |
| `bun test test/acceptance` | 116 of 117 pass. The one failure, `24-ntfy-reconnect`, is a pre-existing flake: the harness's own `git clone`/`git push` of the local bare remote, or the ntfy reconnect wait, times out. It fails 1 run in 4 on the code from before this round too; reruns pass. Every file this round touched or rewrote (05, 20, 21, 31, 33) passes. |
| `32-chaos`, updated harness (`D28_MAX = 0`, no exemption, temp folders off-limits to the agent, settle awaited, no shared inodes) | 34 runs. First the failing seeds (9 runs: 110; 105 and 117 at 120 s; 103 and 111 with the poll watcher; 100, 103, 105, 117 at 30 s), then the original round's full matrix (24 runs: seeds 100–119 at 30 s, 103 and 111 with the poll watcher, 105 and 117 at 120 s), then one rerun. 33 pass. The other one (117 at 120 s) found nothing wrong except "only 39 writes": the laptop, on battery, suspended for 100 s (`caffeinate -s` only holds on AC), and both daemons logged `wake detected`. Its rerun passed. |
| Writes / lost | 4 231 writes, **0 lost**. |
| `worktree write raced` | 4 `late` in 34 runs (220 in the 24 runs before this round). All 4 checked against the agent's ops: it edited a conflict copy that shared the replaced inode, then deleted the copy (3) or replaced it with an atomic save (1) within the grace. The inode's only remaining name was our aside, holding bytes that differ from what was replaced, so settle kept them as a copy. Conservative (it can't tell that from a write through an old descriptor): a spurious copy, never a loss. |
| Stuck devices, leftover journals or temp folders, shared inodes, conflict markers, stashes | none |
| Run failures | Only the test's own outages (`network-error`), SIGTERM shutdown runs (`push deferred to the next start`), and 7 runs whose push lost the ref race on all 4 attempts (`push rejected as non-fast-forward after 3 retries`). Those retry on the backoff and were all pushed later (the convergence check). The push path is unchanged this round. |

## Open

- **AGENTS.md (§21, D51/D54 rows) is not edited.** It is the project's agent-instructions file (CLAUDE.md imports it), so its owner should apply the listed edits: "They use `rebase --autostash`", "before the hard reset", "Never `reset --hard` …", the `bun:ffi` and git ≥ 2.40 stack lines, and the temp-folder exception to "never write into the synced repo". Until then AGENTS.md contradicts the code in those lines.
- **`bun:ffi` needs the owner's approval** (the design flagged it). It is built into Bun and optional: without it a process is `rename-only` or `copy-only`.
- **`24-ntfy-reconnect` is flaky** (pre-existing, about 1 run in 4 before and after this round): the harness's own `git clone`/`git push` of the local bare remote hangs past its 60 s timeout, or the reconnect wait times out. Not investigated: it involves no move.
- **§7.8.8's two new `05-mid-rebase-recovery` kills** (inside the move with `MDSYNC_TEST_MOVE_PAUSE_MS`, and between the ref step and the settle) were never added; `move.test.ts` covers those phases at unit level.
- **A conflict copy edited and then deleted within the grace comes back** as a `late` copy (4 events in round 1's runs). Settle can't tell that from a write through an old descriptor, so it keeps the bytes. Chaos round 2 saw 12 in 50 runs, the rate rose under 5 parallel lanes, and its reruns saw 3 in 13. The atomic save or delete can also hit a folder that holds the copy.
- **A resumed move still writes every journaled copy that is missing**, including one it had linked before the crash and that the agent then deleted. `resumeMove` can't tell those apart, because what it linked isn't journaled. The result is a stray copy, never a loss. Unchanged this round.
- **The round-2 reruns hit the defect's race only once in 13 runs** (seed 149). The deterministic tests are what prove the fix. The chaos invariant is what would catch a regression.
- **Review round 5 leftovers (by design, never a loss):**
  - A resumed rename-follow keeps the old name when it can't prove the edit is saved elsewhere: the new name holds `to`'s plain version and the old name's copy was local-only (not journaled), or the edit merged into exactly `to`'s version. The old name then comes back as before.
  - A C5c switch cut in two whose create can't be finished on resume (someone made the path in between) keeps the person's old inode whole as a `late` copy.
  - A snapshot identity put that a crash interrupts is journaled as `inode`, so its aside settles as a second copy.
  - A local merge with content of its own still goes to the planner (one commit, `(conflict)` subject, the configured identity): safer than `git rebase`, which drops that content, but not the same history.
  - A configured `merge.<name>.driver` now runs during a pull (as it did inside the old rebase and autostash apply). It is a command from the user's git config.
- **`MDSYNC_TEST_EXCHANGE_MODE=copy-only` now means `excl-open` too.** CI's copy-only jobs (`33-concurrent-writes`, `32-chaos`) therefore exercise the O_EXCL-copy create, as on exFAT. They pass locally on APFS; ubuntu is unmeasured.
- **Linux is unmeasured here** (no Docker in this session): CI runs the suite on ubuntu, `33-concurrent-writes` with `MDSYNC_TEST_EXCHANGE_MODE=rename-only` and `copy-only`, and `32-chaos` with `copy-only` (§16.4). The CI workflow changes for those runs are not made here.

## Docs sync (2026-10-09)

- Applied the ARCHITECTURE §21 D51 rows that the review-fixer had left open:
  - **AGENTS.md:** pull-only runs carry edits through the worktree move (no `rebase --autostash`), "no git command writes the worktree", "no mtime proves git output", git ≥ 2.40, `bun:ffi` allowed only for `exchange.ts`, and the `.mdsync-<pid>-<startMs>.d/` temp-folder exception to the never-write rule.
  - **SPEC.md:** Sync step 4 and Conflict handling steps 1, 4 and 5 now describe the in-memory replay and checked writes instead of rebase/abort/hard reset.
- **Decision:** `bun:ffi` is accepted. It is a Bun built-in, not a dependency, and mdsync falls back to rename-only or copy-only moves without it.
