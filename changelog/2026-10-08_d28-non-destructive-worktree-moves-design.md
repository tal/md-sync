# D28 design: non-destructive worktree moves (design only, not implemented)

D28 was the last known way to lose a write. An agent's write that landed between a snapshot (a rescue's hashes, `stash create`) and the destructive git op after it was gone: `reset --hard`, `checkout -f`, `checkout-index -f`, `<op> --abort`, and git's own `rebase --autostash` internals. `32-chaos` measured 16 such losses in 30 runs of 30 s, and tolerated up to 6 per run.

This change is a design. It adds `docs/ARCHITECTURE.md` §7.8 and rewrites the affected parts of the contract:

- §5 S4u, S5 and S5z;
- §6 P1b–P6;
- §7.1 (marked superseded) and §7.2–7.6;
- §8;
- §1.1, §1.5, §2, §4.6, §4.14–4.16, §4.18, §4.22, §4.26, §15, §18 and §19;
- §20: D28 closed, D2/D5/D6/D7/D8/D38/D45 adjusted, new D51 and D52;
- §21: the SPEC.md and AGENTS.md edits this needs, which are not applied yet.

No source code changed. The code, SPEC.md and AGENTS.md still describe the rebase-based flow until someone implements §7.8.

## The design in one paragraph

No git command writes the worktree any more. Local commits are replayed in memory: per commit, `merge-tree --write-tree --merge-base=<c^>` and then `commit-tree`, keeping the message, author and author date. A conflict or a merge commit goes to the existing planner, which builds the single verified `(conflict)` commit. The worktree then moves from H to the new tip, path by path, through mdsync's own compare-and-swap writer:

- **Before the switch:** it re-reads the bytes through a held descriptor and requires exactly the version the plan classified as being in git.
- **The switch:** an atomic exchange, `renamex_np(RENAME_SWAP)` on macOS or `renameat2(RENAME_EXCHANGE)` on Linux, through `bun:ffi`. It never exchanges back.
- **After the switch:** it checks that what came out is the same, unchanged inode, and keeps that inode linked under a temp name until a settle step at the end of the move. Anything else becomes a merge or a conflict copy.
- **Uncommitted edits:** merged three-way, or copied, instead of being autostashed.
- **HEAD and the index:** they move last (`update-index` on the changed paths, then a compare-and-swap `update-ref`), under a new `move` journal part.
- **Failure:** a failure rolls back with the same checked operations.

## What the probes established (git 2.55.0, Bun 1.3.13, APFS)

| Assumption going in | What the probe showed |
|---|---|
| `git read-tree -m -u H T` refuses instead of discarding, so it could be the primitive. | Its verification is all-or-nothing for dirty and untracked paths. But it **silently overwrites ignored files** in the way, even without `--exclude-per-directory`. A stale stat (`touch`) makes it refuse, because it never compares content. Its **writes are not all-or-nothing**: a permission error left the other new files written and the index unchanged, which is the D38 partial checkout again. It checks every path and then writes them one by one, so in the race probe it lost 73 of 400 writes (window 0–3.5 ms per file for 30 files). Rejected. |
| `git replay` could replace the rebase. | It is still `EXPERIMENTAL`. Its default `--ref-action=update` moved the **checked-out** branch without touching the index or the worktree. On a conflict it prints nothing and exits 1, and it refuses merge commits. Rejected in favor of per-commit `merge-tree`. |
| A `merge-tree` exit code of 1 means a conflict. | Exit 1 also comes with **empty stdout** for a bad branch argument. A conflict is exit 1 *and* a tree oid as the first field. |
| `cat-file --batch --filters` can stream smudged content. | Its header gives the **unfiltered** size (`blob 4` followed by 6 bytes under `eol=crlf`), so the stream can't be framed. Use one `cat-file --filters --path` per filtered path. |
| `<op> --abort` is the only way out of a person's stopped op. | `rebase`, `merge`, `cherry-pick`, `revert` and `am` all have `--quit`. It drops the op state and leaves HEAD, the index and every file byte-identical. `rebase --quit` moves an autostash into `refs/stash`. |
| A compare-and-swap write closes the window. | A one-step `rename(temp, path)` still lost 9 of 1 500 single writes, all atomic saves landing between the check and the rename (≈ 10–30 µs per file). Moving the old file aside first lost nothing, but left the path missing for ~270 µs: 24 writer `ENOENT` errors and 8 stub files. `RENAME_SWAP` with swap-back lost 5 of 50 000. A read-modify-write writer read our transient version, and its save then replaced the raced one. That is a bug I found in my own first design: never exchange back. `RENAME_SWAP` without swap-back, with the replaced inode kept until the end of the move, lost **0 of 1 500 and 0 of 50 000**. |
| Today's ops have a window of "tens of milliseconds". | A snapshot followed by `reset --hard` or `checkout-index -f` lost 225 and 221 of 400 single writes. Every write from the snapshot until git rewrote that file is lost. |

## What remains

- **With the exchange:** only a write made through a file descriptor opened before the switch and written after the end-of-move settle. That is inherent to replacing any file someone holds open; git's own checkout has the same limit.
- **Without the exchange** (no `bun:ffi`, musl, NFS, SMB, FUSE, Docker Desktop shares): additionally, the ≈ 10–30 µs gap for atomic saves.
- **The chaos test:** it is specified with `D28_MAX = 0`, and the D28-shape exemption is removed.

## Open items for whoever implements it

- **`bun:ffi`** is experimental, and AGENTS.md lists no FFI. This needs the owner's approval. The design works without it, with the measured gap.
- **Linux is unmeasured** (Docker was not running). Run the race probe on ext4 and on overlay or bind mounts in CI. Confirm that `renameat2` is reachable from the compiled binary.
- **Transient `.mdsync-*.tmp` files in the worktree** are a new exception to "never write into the synced folder" (§20 D51). They are journaled, ignored by staging and the watcher, and resolved by P4 after a crash.
- **Untested here:** how APFS exchanges two entries whose names differ only in case or normalization.
