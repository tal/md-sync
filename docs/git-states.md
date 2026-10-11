# Git states

What mdsync does for each local and remote git state of the synced branch. Nothing here uses `checkout`, `reset --hard` or `-X ours/theirs`; files are only replaced after a check that they still hold git's bytes.

## Local: what is checked out

| Local state | What mdsync does | Result |
|-------------|------------------|--------|
| On the configured branch | Nothing | syncs |
| On another branch, no commits the configured branch lacks | Moves the branch ref and the folder to the configured branch, keeping edits | `branch-fixed`, syncs |
| On another branch, with commits the configured branch lacks | Refuses and prints the `git merge` to run | `failed` |
| On another branch, tracked files modified | Refuses to switch | `failed` |
| Detached `HEAD`, no commits the remote lacks | Same as another branch: reattaches to the configured branch | `branch-fixed`, syncs |
| Detached `HEAD` on top of the configured branch | Moves the branch forward to include those commits, so they sync | `branch-fixed`, syncs |
| Detached `HEAD`, commits not on top of the configured branch | Refuses | `failed` |
| Unborn `HEAD` (no commits yet) | Populates from the remote, or the first commit creates the branch if the remote is empty | syncs |
| Interrupted rebase / merge / cherry-pick / revert | Quits it (never aborts), restores the branch, keeps every edit | `recovered`, syncs |
| Stale lock file, no live `git` | Removes it after 60 s (10 min in a container) | `recovered`, syncs |
| Lock file with a live `git` | Waits | `busy`, retried |

## Remote vs local (configured branch)

| Remote vs local | What mdsync does | Result |
|-----------------|------------------|--------|
| Same commit | Nothing | `up to date` |
| Local ahead | Pushes | `pushed` |
| Remote ahead | Moves the folder to the remote tip; uncommitted edits are carried | syncs |
| Diverged | Replays local commits onto the remote; a line conflict keeps both versions as a conflict copy | `conflict` |
| Remote history rewritten (force-push) | Replays only this device's commits since its last sync; nothing the rewrite removed is pushed back | `remote history rewritten` |
| Remote branch missing, remote empty | First push creates it | syncs |
| Remote branch missing, other branches exist | Refuses rather than fork a second branch | `failed` |
| Push rejected as non-fast-forward | Fetches and replays again, up to 3 retries | `push rejected` |
| Push rejected by the remote | Stops, keeps local commits | `failed` |
| Remote unreachable or auth fails | Keeps local commits | `network-error`, backoff 30 s to 10 min |

Pull-only runs (ntfy, retry) never commit your uncommitted work. The code is the source of truth: `src/preflight.ts` (local) and `src/sync.ts` (remote).
