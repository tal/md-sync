# Architecture revision after three adversarial critiques

`docs/ARCHITECTURE.md` was revised against critiques on three fronts:

- git correctness
- lifecycle and concurrency
- testability and spec compliance

50 findings in total: 47 accepted, and 3 partly accepted (git #11, git #12, testability #11). Every factual git claim was re-checked on git 2.55 / macOS (APFS, case-insensitive) before it went in.

## Data-loss bugs in the previous design (verified)

| What was wrong | Evidence | Fix |
|---|---|---|
| `rebase --autostash` deletes untracked files under a folder that replaced a tracked file. Exit 0, nothing logged. | `projects` file → `projects/alpha.md`, `projects/beta.md`; after the rebase both notes were gone and the old file was back | New rescue rows (type-change, shadowed). Every destructive op, including S5's rebase and the unborn checkout, is wrapped in a rescue. |
| A refused autostash apply exits 0 with **no** unmerged entries; the edits survive only in `stash@{0}` | Reproduced with a write during the rebase | S5(b) keys on "new autostash on top", not on unmerged entries. P5 also replays leftover mdsync stashes. |
| `update-index --index-info` silently drops `d/x.md` when a file `d` is set; `checkout-index -f` then deletes the whole `d/` folder | Exit 0 from both | Plans get a clash pass. The replay commit is built in a temporary index and verified with `ls-tree` before `reset --hard C`. |
| A clean rebase on a case-insensitive FS leaves both `Notes.md` and `notes.md` in the index but one file on disk | `status` showed ` M notes.md` holding the other writer's text | Case-fold precheck routes the clash to the replay. Staging never stages case-duplicate index entries. |
| `git clone --no-tags` writes `remote.origin.tagopt` into `.git/config` | `git config --local --list` diff | Clone without `--no-tags` |
| An unborn HEAD with a staged index makes every pull-only run fail | `checkout -B` refused | `git reset -q` before the unborn checkout |

## Lifecycle bugs (reasoned or probed)

| What was wrong | Fix |
|---|---|
| A stale lock whose pid was reused after a reboot blocked the daemon forever | Lock records the boot id and process start time |
| Check-then-act takeover race let two processes hold the lock | Takeover guard file plus an ino check |
| systemd's default `KillMode` and a terminal Ctrl-C killed in-flight git children | Every child is detached; `KillMode=mixed`; `tini` in the container |
| Shutdown could take longer than every stop timeout | 240 s deadline. Runs started after the signal only commit and push once. |
| Path-limited flushes restarted max-wait for everyone, so a file nobody flushed could wait forever | Backup timers keep a `firstDirtyAt` anchor |
| A no-wait flush that hit a busy lock lost its message and path scope | Carry slot in the queue |
| Timer values > 2³¹−1 fire after 1 ms in Bun | Schema max plus chaining in `realClock` |
| The ntfy first connect did nothing, leaving a gap of up to 1 h | Catch-up on every connect |
| `server.stop(true)` cut off `flush --wait` clients merged into the final run | `stopAccepting()` / `closeAll()` |
| Unbounded local git ops, pipe drains and `lsof` could stall the queue | Timeouts on every spawn, drain limits, a queue watchdog |

## Rejected or partly accepted

- **Exit 2 on `remote mismatch`, and in-process restart on a SIGHUP change to `dir`/`branch`/`remote`:** rejected. The brief decided warn-and-restart. The warning now carries the exact `git remote set-url` command.
- **Probing the socket to detect a stale daemon lock:** rejected. A starting daemon legitimately holds the lock before its socket exists.
- **In-memory replay with `merge-tree` + `read-tree -m -u`:** deferred. It is recorded as D28 (residual-risk window), because it is a SPEC step-4 change.
- **`?since=` on the ntfy subscription:** not adopted. The catch-up on every connect already covers that gap.

## Own mistakes fixed in this pass

- §7.2's header said `L = H0`, but S5 passes `H`. With `H0`, R6 would have failed after every committing run.
- P5 matched a pre-conflict stash by `endsWith(': mdsync pre-conflict')`. A verified `stash store -m` subject is exactly `mdsync pre-conflict`.
- The merge base was called `B`, the same letter as the branch. It is now `M`.

## Follow-up required

ARCHITECTURE §21 lists the SPEC.md and AGENTS.md edits to make before implementation starts, so the §20 amendments and SPEC no longer contradict each other.
