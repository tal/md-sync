# Architecture contract (docs/ARCHITECTURE.md)

Added `docs/ARCHITECTURE.md`, the contract that parallel implementers code against. It covers:

- module list and signatures
- sync, preflight and conflict algorithms, with exact git commands
- IPC, lock, state and journal formats
- CLI and config
- log `msg` table
- test harness API
- SPEC acceptance → test mapping
- deviations from SPEC

## What the probes corrected (git 2.55/2.54, Bun 1.3.13, chokidar 5)

| Assumption | What actually happens | Design consequence |
|---|---|---|
| A stash conflict prints "Applying autostash resulted in conflicts" | That text is gone in git 2.55, and the rebase **exits 0** in both versions | Detect stash conflicts from repo state (unmerged entries + a new `refs/stash` with subject `autostash`), never from text |
| Preflight only needs to check the rebase dir or `MERGE_HEAD` | An autostash conflict leaves only unmerged entries. A later `git add -A` silently stages the marker files | Preflight P5 recovers leftover unmerged entries, and staging refuses to run while they exist |
| `git rebase --abort` is lossless | It discards tracked edits made while the rebase was stopped. `reset --hard` also overwrites untracked or ignored files at paths the target tracks | New `rescue.ts` saves those edits before every destructive op and restores them after |
| The untracked-collision check is `diff ∩ ls-files --others --exclude-standard` | It misses case-only names and file/dir clashes, which make the rebase loop forever, and ignored files, which get silently overwritten | New `collisions.ts` covers ignored files, case folding and both directions of file/dir clashes, with a stderr-parse fallback |
| `--diff-filter=U` lists every conflicted path | With several local commits, it lists only the first stopped commit's paths | The conflict replay covers all of `B..L` |
| `git stash pop` failures are content conflicts | They have 3 distinct failure modes | mdsync never pops; it replays stashes with its own 3-way logic |
| The rebase is harmless when nothing is incoming | It always rewrites dirty files (new inode and mtime) | The rebase is skipped when `origin/B` is already an ancestor of HEAD |
| `Bun.spawn({timeout})` kills the git op | It kills only the leader; grandchildren keep the pipes open | Network ops use `detached: true` plus a process-group kill |
| A compiled binary just runs | macOS 27 SIGKILLs unsigned `bun build --compile` output | CI and release run `codesign --force --sign -` |
| ignore glob = prepend `**/` | Neither Bun.Glob nor git pathspecs match the directory's contents | Each pattern compiles to both `p` and `p/**` |
| `kill(pid,0)` throwing means dead | EPERM means alive. In containers, the lock pid can be our own pid (PID reuse) | Treat EPERM as alive, and a lock naming our own pid as stale |
| Daemon env for credentials via `GIT_CONFIG_COUNT` | This would clobber the test harness's upload-pack race hook | Credential entries are **appended** after any existing ones |

## Decisions recorded as deviations

`docs/ARCHITECTURE.md` §20 lists D1–D25. The most visible ones:

- Conflict copies are committed even in pull-only runs.
- A conflict produces a single `(conflict)` replay commit.
- `sync-once` is a commit run.
- Repo config is read from the committed HEAD blob.
- Ignore globs also exclude tracked files from staging.

SPEC.md should be updated to match once the implementation lands.
