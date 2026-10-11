# D28 design, round 5: revision after two critiques (design only, not implemented)

Two adversarial critiques of `docs/ARCHITECTURE.md` §7.8 (non-destructive worktree moves) were checked by experiment. The probe scripts are in the design session's scratchpad: `d28/revise`, `d28/critic-0` and `d28/critic-1`. All 34 findings were accepted in substance. Two sub-claims were rejected, and two proposed fixes were replaced by simpler ones (see "Rejected or narrowed"). No source code changed.

## What was wrong in the first design, and what replaced it

| First design | What the probes showed | Now |
|---|---|---|
| Settle every aside right after the last switch of the move | With the settle done immediately, writers that stall 0–2 ms between `open` and `write` (normal for an async `writeFile`) lost 492 of 2 000 writes. A 200 ms grace lost 0, with stalls of up to 10 ms. | Asides wait `SETTLE_GRACE_MS` (5 s) in a journaled `settle` part. A settle timer, P4, or the last run of an exiting process settles them. Nothing holds a descriptor in the meantime. |
| Asides live next to the file they replace | `rmdir` of the folder fails with `ENOTEMPTY`, so a folder that becomes a file never completes. | One temp folder per process, `.mdsync-<pid>-<startMs>.d/`, at the worktree top. `RENAME_SWAP`, `RENAME_EXCL` and `link` all work across folders. |
| A path that keeps changing → `changed` → after 3 rounds, roll back and return `busy` | A note written every 100–300 ms kept every pull busy. | Changed paths are re-surveyed alone. Once a path has changed in two rounds in a row, it is captured by inode: a hard link to a copy, then an exchange. `busy` is left only for a locked index and for file ↔ folder churn, and it resumes forward. |
| The rollback exchanges the old version back | That is the hazard §7.8.0 itself measured (5 / 50 000), plus an unchecked `rename` back in rename-only mode. | The undo uses forward checked puts, and only for content that came from git. Puts over edits stay. |
| `RENAME_EXCL` probed on an existing target | exFAT returns `EEXIST` there, but `ENOTSUP` onto an absent target. exFAT also has no `link`. | A probe against an absent target, and a third mode, `copy-only`. That mode loses nothing more, but readers can see a path briefly absent. |
| `link()` copies symlinks | On macOS `link()` hard-links the symlink's target. | Symlinks are copied with `symlink(readlink())`, never hard-linked. |
| Per-spelling survey on case-insensitive filesystems | A remote case-only rename deleted the note, and the next commit pushed the deletion. Remote twins met `EEXIST` forever. | Fold groups: one disk entry per group, extra spellings index-only, and a case-only rename after the put. |
| The worktree's `.gitattributes` when smudging | `eol=crlf` or LFS added by T came out as LF, or as pointer files. | `--attr-source=<to>` for writing and `<from>` for hashing. Versions are materialized with one `checkout-index --prefix` into the state dir (no per-path spawn, no memory spike). |
| mtime ≤ `ref` proves a file is git's output (P2, T3) | An mtime-preserving writer or a coarse-timestamp filesystem defeats it. | Content only: stage blobs, reproducible trees, and `AUTO_MERGE:<p>`, which equals the conflicted worktree blob for rebase, merge, cherry-pick and `am -3`. `merge --quit` deletes `AUTO_MERGE`, so it is recorded first. |
| `git clone` with its checkout (W1 exception) | The clone overwrote a file an agent wrote during the checkout, and exited 0. | `clone --no-checkout`. P1b populates the folder with a move. |
| `log -1 --format` for the author | A user's `log.showSignature=true` puts `No signature` into the author name. | One `cat-file --batch` of the raw commits, and `log.showSignature=false` in `GLOBAL_ARGS`. |
| Path lists as command-line arguments in M8 | About 20 000 paths hit `E2BIG` (`ARG_MAX` is 1 MiB on macOS), which wedged the device. | `diff-tree` and `update-index` read everything on stdin. |
| `--no-renames` only | An uncommitted edit of a note the remote renamed came back under the old name. | Edits follow `diff-tree -M` renames, as the autostash did. |
| No durability | git's default `core.fsync` leaves loose objects out. | Temps are fdatasynced, changed folders are fsynced before M8, and objects use `core.fsync=committed`. |
| The replay replays already-upstream commits | Rebase skips commits whose patch-id is already upstream. | `rev-list --cherry-pick --right-only` filter. |

Smaller fixes:

- `core.fileMode=false` and `core.symlinks=false` are honored.
- A gitlink's folder is created when it is absent.
- The done map: a path the move already wrote is measured against its new version.
- The temps list is append-only.
- Stash-replay resume: HEAD == `j.to` is checked first, and the part is kept until the stash drop.
- Orphan temps are local-only.
- A symlinked parent folder counts as in the way.
- HEAD's symbolic ref is compared, not just its sha.
- Benign errnos give `changed`.
- One misread errno never demotes a filesystem.
- Non-UTF-8 paths: data-guard stop.
- Modes are `0666`/`0777` minus the umask.
- git ≥ 2.40 is checked at startup and in the Dockerfile.

## Rejected or narrowed

- **"A truncating `open` loses the whole save":** rejected. `O_TRUNC` truncates the old inode at `open`, before the switch, so C3 or settle sees it. The real gap is any write that arrives after the final unlink, which the grace closes.
- **"M0 must finish pending settles first":** rejected. An aside belongs to no path's current state, and the survey never sees the temp folder.
- **`linkat` through FFI for symlinks:** not adopted. Copying a symlink as a new symlink is simpler, and works without FFI.
- **"The journal write is not durable":** already true in `state.ts` (tmp, fsync, rename, fsync dir). Only the doc said less.

## Open

- I could not check which git `oven/bun:slim` installs. If its base is Debian bookworm, it ships 2.39. The Dockerfile now fails the build on git older than 2.40.
- The 5 s grace is a choice, not a measurement of the worst writer: 200 ms already gave 0 losses with stalls up to 10 ms.
