# md-sync

`md-sync` keeps a local folder of Markdown files in two-way sync with a git remote. It is a small Bun/TypeScript daemon, one per synced folder. Syncing is driven by events rather than a fetch loop (local changes come from an FSEvents stream on macOS, and from a stat poll of the folder on Linux and in containers):

- **Agents say when they're done.** `md-sync flush` (usually from an end-of-task hook) commits and pushes. Backup timers commit anything nobody flushed.
- **Remote pushes arrive by ntfy.** A GitHub Action posts each pushed SHA to an ntfy topic, and every daemon pulls when it sees one it doesn't have. An hourly catch-up covers the rest.
- **Conflicts never block.** Both versions are kept: the first-pushed one at the original path and the other as a conflict copy beside it.
- **Nothing is written into the synced repo** except commits of user content. Lock, socket and state files live in `~/.local/state/mdsync/`.

This README describes what md-sync does; the code and its tests are the reference for how. Contributor and agent rules are in [`AGENTS.md`](./AGENTS.md).

## Install

The executable is now `md-sync` (previously `mdsync`). Update shell commands and agent hooks, and reinstall services after replacing an old compiled executable. Config/state paths, service identifiers and `MDSYNC_*` environment variables keep their existing names.

Either way, `git` 2.40 or newer must be installed (md-sync replays local commits with `git merge-tree --merge-base` and reads attributes with `--attr-source`; it refuses to start on an older git and says so). Your existing git auth (SSH key or credential helper) is used as is.

- **With Bun** (≥ 1.3), straight from this repo. The command it installs is `md-sync`:

  ```sh
  # Replace <owner> with the GitHub owner of this repo.
  bun add -g github:<owner>/md-sync
  ```

  md-sync is not on npm yet. The npm name `md-sync` belongs to an unrelated third-party package, so don't install `md-sync` from the npm registry.

## Quick start

**From a clone, with nothing to configure.** In the top folder of a git checkout that has an `origin` remote:

```sh
cd ~/agent-notes
md-sync run                               # syncs this folder with its origin, on the branch checked out here
md-sync flush --message "finished task"   # from anywhere inside the folder
md-sync install-service                   # or run it as a service: the unit records this folder and its origin
```

- With no `--dir` and no config file, `dir` is the folder md-sync starts in. It must be the top of a git checkout: from a plain folder or a subfolder of a repo, md-sync exits 2 instead of syncing whatever folder it was started in.
- `remote` defaults to that folder's `origin`, and `branch` to the branch checked out there. There is no built-in branch: a detached HEAD exits 2 unless you pass `--branch` or a committed `.config/mdsync.json` names it (a rebase in progress counts as its branch).
- The branch is read once, at startup. While md-sync runs it keeps the folder on that branch: a `git checkout` of another branch is switched back at the next sync (or the sync fails, if the worktree has changes or that branch has commits no remote has). Stop md-sync before switching branches, then start it again.
- The `daemon starting` log line says where each came from: `"sources": {"dir": "default", "remote": "origin", "branch": "checkout"}`. `branch` is `cli`, `instance`, `repo` or `checkout`, never `default`. Credentials in an origin URL are redacted.

**With a config file**, for a folder that isn't cloned yet, or to set more than the defaults:

1. Write an instance config file, one per synced folder, for example `~/.config/mdsync/notes.json` (with a single folder you can use the default path, `~/.config/mdsync/config.json`, and leave out `--config` below):

   ```json
   {
     "remote": "git@github.com:tal/agent-notes.git",
     "dir": "~/agent-notes",
     "branch": "main",
     "ntfyUrl": "https://ntfy.sh/<long-random-topic>"
   }
   ```

   If `dir` is missing or empty, md-sync clones `remote` into it. If it is already a clone, its `origin` is used, and `remote` can be left out. `branch` defaults to the branch checked out in `dir`. There is no built-in default: when md-sync clones into `dir`, nothing is checked out yet, so `branch` must be set (or passed as `--branch`), or md-sync exits 2. It must be a branch the remote has, unless the remote is empty: naming `main` for a repo that only has `master` stops with an error that names the remote's default branch.

   Also commit a `.gitignore` for files your tools write next to your notes, so they aren't synced (and conflict-copied) between machines:

   ```gitignore
   .DS_Store
   *.swp
   *~
   .#*
   ```

2. Run it in the foreground to try it out, then [install it as a service](#run-it-as-a-service):

   ```sh
   md-sync run --config ~/.config/mdsync/notes.json
   ```

3. Tell it when work is done:

   ```sh
   md-sync flush --dir ~/agent-notes --message "finished task"
   ```

## Commands

| Command | What it does |
| --- | --- |
| `md-sync run` | Run the daemon in the foreground. Services and containers call this. Needs `dir` and `remote`; with neither given, it syncs the checkout it starts in (see [Quick start](#quick-start)). |
| `md-sync flush [-m <text>] [--wait] [<path>...]` | Commit now and push. See [Flushing](#flushing-from-agents). |
| `md-sync sync-once` | Run a single commit run (stage, commit, fetch, rebase, push) and exit. For cron, debugging and CI. Needs `dir` and `remote`, with the same defaults as `run`. |
| `md-sync status [--format text\|json]` | Show whether the daemon is running, the last sync and its result, unpushed commits, pending local changes and kept stashes. |
| `md-sync install-service [--print]` | Write and load a launchd agent (macOS) or a systemd user unit (Linux) that runs `md-sync run` with this config (started in a checkout with no `dir`, the unit records that folder and its origin). `--print` prints the unit instead. |
| `md-sync uninstall-service` | Unload and remove that unit. A unit that isn't installed is not an error. |
| `md-sync print-workflow` | Print the GitHub Action that posts pushes to ntfy. |
| `md-sync --help`, `md-sync --version` | Usage, and the installed version. |

Every command accepts `--cwd <path>` (run as if started in that folder, like `git -C`), `--config <path>`, `--log-level <debug|info|warn|error>` and any config key as a flag (next section). `flush`, `status` and `uninstall-service` find the folder from `--dir`, then the `dir` in `--config`, then the synced folder that contains the current directory, then the default config file.

| Exit code | Meaning |
| --- | --- |
| 0 | Success: clean shutdown, sync `ok` or `conflict-resolved`, flush queued |
| 1 | Runtime failure: folder already locked, clone failed, sync failed, flush not delivered (including a one-off `flush` with an invalid recorded config file), `--wait` push failure, service install failure |
| 2 | Usage or config error: bad flag, invalid config key, missing required key, a flush path outside the folder, folder can't be determined (no `dir` given and the current folder is not the top of a git checkout), no `branch` given and none checked out (a fresh clone, a detached HEAD) |

`flush`, `status` and `uninstall-service` never fail on a broken config file they didn't name: a flush still reaches the running daemon (which keeps its last good config), `status` warns and reports, and a crash-looping service can still be uninstalled.

## Configuration

Settings come from files, and any of them can be overridden with a CLI flag. Precedence, highest first: **CLI flag, instance file, repo file, default.** `ignore` lists replace lower layers; they are never merged.

| Key | CLI flag | Default | Allowed in | Applied on `SIGHUP` / repo change | Purpose |
| --- | --- | --- | --- | --- | --- |
| `remote` | `--remote` | `dir`'s `origin`, when `dir` is already a clone (otherwise required for `run`, `sync-once`, `install-service`) | Instance file | No, restart | Git remote URL (SSH or HTTPS) |
| `dir` | `--dir` | The current folder, if it is the top of a git checkout (`run`, `sync-once`, `install-service`; otherwise exit 2) | Instance file | No, restart | Local folder to sync. Cloned into if missing or empty |
| `branch` | `--branch` | The branch checked out in `dir`, read at startup. No built-in default: required when md-sync clones into `dir`, and a detached HEAD exits 2 | Either | No, restart | Branch to sync |
| `ntfyUrl` | `--ntfy-url` | (unset) | Either | Yes | ntfy topic URL for remote-push events. Unset means the catch-up timer only |
| `idleMs` | `--idle-ms` | `300000` (5 min) | Either | Yes | Backup commit after this long with no local writes and no flush |
| `fallbackMs` | `--fallback-ms` | `3600000` (1 h) | Either | Yes | Catch-up pull interval |
| `maxWaitMs` | `--max-wait-ms` | `1800000` (30 min) | Either | Yes | Backup commit this long after the first uncommitted change, even if writes continue |
| `ignore` | `--ignore` (repeatable) | `[]` | Either | Yes | Extra globs to ignore, on top of `.git/` and `.gitignore` |
| `authorName` | `--author-name` | `mdsync@<hostname>` | Instance file | Yes | Commit author name |
| `sshKey` | `--ssh-key` | (unset) | Instance file | Yes | SSH private-key path for this repo |
| `authorEmail` | `--author-email` | `mdsync@<hostname>.local` | Instance file | Yes | Commit author email |

- **Instance file:** `--config <path>`, default `$XDG_CONFIG_HOME/mdsync/config.json` (`~/.config/mdsync/config.json` on macOS and Linux). A relative `dir` resolves against the file's folder, and `~` is expanded. An invalid file or an unknown key refuses to start (exit 2) and names every bad key, for example `md-sync: invalid config key "idleMs" in /Users/tal/.config/mdsync/config.json: Invalid input: expected number, received string`.
- **Repo file:** `<repo>/.config/mdsync.json`, optional and committed by you, so every device shares it. It holds shared keys only. Instance-only keys (`remote`, `dir`, `authorName`, `authorEmail`, `sshKey`) and unknown keys are ignored with a warning. md-sync reads the **committed** version and reloads it after a sync changes it. An invalid new version keeps the last good one, including across restarts and one-off runs. Committing its removal clears the shared settings; a later invalid file keeps that empty layer.
- **Timers** (`idleMs`, `fallbackMs`, `maxWaitMs`) must be whole milliseconds from `1000` to `2147483647`.
- **`ignore` globs** follow `.gitignore`-style rules: `drafts` or `*.tmp` match at any depth, while a pattern containing a `/` is anchored at the repo root. `!` negation isn't supported. Matching files aren't committed (even if tracked), but pulls still update tracked ones.
- **Reloading:** send `SIGHUP` to re-read the instance file. `dir`, `remote` and `branch` need a restart, also when they come from the checkout (a new origin URL, another checked-out branch), and md-sync logs `config change requires restart` and keeps the old values. For a service, `launchctl kill SIGHUP gui/$(id -u)/dev.mdsync.<hash>` on macOS, or `kill -HUP $(systemctl --user show -p MainPID --value mdsync-<hash>.service)` on Linux.

**Env vars** are only for process-wide settings:

| Env var | Purpose |
| --- | --- |
| `GIT_TOKEN` | HTTPS token. Passed to git through a credential helper, never put in a URL, a log line or a service unit |
| `MDSYNC_LOG_LEVEL` | Same as `--log-level`. Default `info`. An invalid value only warns |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Where the default config file and the state, lock and socket files go. Default `~/.config` and `~/.local/state`, on macOS too |

Logs are JSON lines on stdout (`status`, `print-workflow` and `(un)install-service` log to stderr, so their stdout stays clean). Lines to watch for: `sync done`, `conflict`, `delete overridden`, `push deferred`, `data guard stop`, `stash kept`, `startup failed`, `event loop stalled`.

At debug level, `git` records actual Git commands. Filesystem diagnostics use `worktree operation failed` or `worktree operation skipped`, with an `action` and affected `path` or `paths`; failed operations include `error`.

## Flushing from agents

A local file change never commits on its own. Commits happen when a writer says it's done, and backup timers make sure nothing stays uncommitted for long if that signal never comes.

```sh
md-sync flush --dir ~/agent-notes                               # commit everything pending, return once queued
md-sync flush --dir ~/agent-notes -m "summarized meeting notes" # use this commit message
md-sync flush notes/a.md notes/b.md --wait                       # commit only these paths, wait for the push
```

- Paths are resolved against the current directory and must be inside the synced folder (otherwise exit 2). From a directory outside the folder (a hook running in your project), a relative path that doesn't exist there is taken as relative to the synced folder instead; one that does exist there is rejected (exit 2), never silently re-rooted. Named paths that are ignored or don't exist are skipped.
- Without `--wait`, `flush` returns as soon as the daemon has queued it. With `--wait`, it blocks until the push finishes and exits 1 if it fails (for example `md-sync: flush failed: network-error: …`).
- Flushes that arrive during a sync are merged into one commit run: their paths are combined and their messages joined.
- **No daemon running:** `flush` takes the folder lock and does the whole sync itself (commit, fetch, rebase, push), so a flush is never dropped. That can block for minutes on a bad network. It reuses the config the daemon last ran with (recorded in its state file), so `ignore` and the author still apply. If a daemon is starting or shutting down, `flush` waits for it instead.
- **Same state dir:** `flush` finds the daemon through its socket in `$XDG_STATE_HOME/mdsync/`. A hook started by a GUI app may not see the `XDG_STATE_HOME` your shell sets, so `flush` also looks in the default `~/.local/state/mdsync/` and in the dir recorded in the folder's installed service unit, and never starts its own sync while a daemon or one-off holds the folder there. Anywhere else, run `flush` with the daemon's `XDG_STATE_HOME`.

**Claude Code `Stop` hook**, in its settings file:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "md-sync flush --dir ~/agent-notes" }] }
    ]
  }
}
```

Any agent framework with an end-of-task hook can do the same: run `md-sync flush` when the agent finishes a unit of work. If the hook runner kills `md-sync flush` on a timeout, md-sync stops after the current git step; a local commit it already made is pushed by the next run.

**Backup timers.** When the daemon sees an uncommitted change, it arms two timers, and whichever fires first commits everything:

- `idleMs` (5 min): the folder has been quiet this long. On Linux and in containers it is never shorter than two poll intervals (see below).
- `maxWaitMs` (30 min): this long after the first uncommitted change, even if writes keep coming.

**Watching on Linux and in containers** is a poll: every 2 s, md-sync lists every folder that is not gitignored and stats every file in it. A scan waits ten times its own CPU cost before the next one, so the poll takes at most about 10% of one core. A big tree is scanned less often instead: measured on macOS, 50k files cost about 10% of a core and ~170 MB of memory, 200k files about 9% and ~400 MB. Gitignored folders (`node_modules`, build output, caches) are skipped, including ones created while md-sync runs. A write is seen up to one interval late, so the idle wait is never shorter than two intervals.

Backup commits get ` (auto)` at the end of the subject, so `git log --grep '(auto)'` shows where a writer forgot to flush. A path-limited flush doesn't reset the timers for other files.

**Commit messages** are the flush message, or `sync <hostname> <ISO time>` without one, followed by the list of changed files (the first 20).

## Remote push events (ntfy)

Each daemon subscribes to an ntfy topic over SSE, so no device needs an inbound port. A GitHub Action in the synced repo posts every pushed SHA to that topic.

1. **Pick a topic name that is a long random string.** The topic name is the shared secret: anyone who knows it can read your push notifications or send fake ones (which only cause extra pulls). For example:

   ```sh
   echo "https://ntfy.sh/mdsync-$(openssl rand -hex 16)"
   ```

2. Put that URL in each device's config as `ntfyUrl`. md-sync uses the public [ntfy.sh](https://ntfy.sh) instance by default and never logs the topic, only the host.
3. Add the workflow to the **synced** repo and commit it. This is optional, and it's the only file md-sync asks you to add there:

   ```sh
   mkdir -p ~/agent-notes/.github/workflows
   md-sync print-workflow > ~/agent-notes/.github/workflows/mdsync-notify.yml
   ```

4. Add the same URL as the repo secret `MDSYNC_NTFY_URL`, for example `gh secret set MDSYNC_NTFY_URL --repo tal/agent-notes`.

A daemon ignores the echo of its own pushes. Every (re)connect triggers a catch-up pull, so nothing is missed while the stream is down. Without `ntfyUrl`, only the `fallbackMs` catch-up timer pulls.

**Self-hosting ntfy** is a later option: run your own server and point `ntfyUrl` (and the `MDSYNC_NTFY_URL` secret) at it. Nothing else changes; only `ntfyUrl` differs. An access token in the URL (`?auth=…`) is kept and never logged.

## Run it as a service

```sh
md-sync install-service --config ~/.config/mdsync/notes.json
md-sync install-service --config ~/.config/mdsync/notes.json --print   # show the unit without installing it
md-sync uninstall-service --dir ~/agent-notes
```

`install-service` writes a unit that runs `md-sync run` with the same config file and CLI overrides, then loads it, and prints the unit's name and where its log goes (`md-sync status` shows them too). Run in a checkout with no `dir` given, it also writes that folder (`--dir`) and its origin (`--remote`) into the unit, since a service starts in `/` or `~`. An origin URL with credentials in it (`https://user:token@…`) is left out: the daemon reads origin from the folder at each start instead. The branch is never written: like `md-sync run`, the service syncs the branch checked out when it starts, and with none checked out (a detached HEAD) and none configured it exits 2 and says so in its log. The service restarts on crash and starts at login. Each synced folder gets its own unit, named after a hash of the folder's path. If the first clone fails because the network or the remote is down, the daemon stays up and retries it on its backoff (30 s, doubling to 10 min) rather than exiting into a restart loop.

- **macOS:** a launchd agent at `~/Library/LaunchAgents/dev.mdsync.<hash>.plist`. Logs go to `~/.local/state/mdsync/<hash>.log`.
- **Linux:** a systemd user unit at `~/.config/systemd/user/mdsync-<hash>.service`. Logs go to the journal: `journalctl --user -u mdsync-<hash>.service -f`. To keep md-sync running when you're not logged in, enable lingering once:

  ```sh
  loginctl enable-linger $USER
  ```

- **Credentials:** `GIT_TOKEN` is never written into a unit. Desktop services should use an SSH key or a git credential helper. If you set `XDG_CONFIG_HOME` or `XDG_STATE_HOME`, they're recorded in the unit, and `md-sync flush` looks there for the socket even when its own environment lacks them.
- **Liveness:** if the daemon's event loop ever stops running (a native deadlock looks alive to the service manager and ignores `SIGTERM`), a watchdog thread logs `event loop stalled` and kills the process after 60 s, so the service manager restarts it.
- **Shutdown:** on `SIGTERM`, md-sync finishes the current sync, commits and pushes anything pending, then exits, within 240 s. The units allow 300 s before a forced kill. A push that can't finish in time stays as a local commit, and the next start pushes it.

## Conflicts

When two writers edit the same lines, md-sync keeps both versions and keeps syncing. It never auto-resolves with `-X ours/theirs` and never waits for a human.

- **Conflict copy:** the version that reached the remote first stays at the original path. The other is saved beside it as `<name> (conflict <hostname> <YYYY-MM-DD HHmm>).md` (other file types keep their extension), and both are committed and pushed (a copy whose path is gitignored or matches `ignore` stays local). Someone, a person or an agent, reconciles the two later and deletes the copy, and that edit syncs like any other.
- Edits to different parts of the same file are merged automatically and produce no copy.
- **Edit vs delete:** the edit wins, and the delete is logged as `delete overridden`.
- **Rules files never become copies:** concurrent edits to `.gitignore` or `.gitattributes` keep the lines of both sides, and `.config/mdsync.json` keeps both sides' `ignore` patterns, so nothing either device kept out gets pushed.
- **Remote history rewrites** (a force-push that removes a leaked secret, a reset): only the commits made on this device since its last sync are replayed onto the new history; nothing the rewrite removed is pushed back (logged `remote history rewritten`).
- When a rebase conflicts, all local-only commits are replayed into one `sync <hostname> <ISO time> (conflict)` commit on top of the remote, whose message lists the copies and the replayed commits. md-sync verifies that every local change is accounted for before it moves anything. If that check fails, it logs `data guard stop` and leaves the folder untouched rather than lose data.
- `git log --grep '(auto)'` shows backup commits, which is where a writer forgot to flush.

Conflicts should be rare when agents write to their own files, but the path is tested.

How md-sync handles each local and remote git state (branch, detached `HEAD`, ahead, behind, diverged, remote rewrites): [docs/git-states.md](./docs/git-states.md).

## Status and kept stashes

```text
$ md-sync status --dir ~/agent-notes
dir:         /Users/tal/agent-notes
daemon:      running (pid 4242)
last sync:   2026-10-08T12:34:56Z  ok  (commit; in 1, out 2; 830 ms)
head:        0123abcd4567
unpushed:    0 commits
pending:     2 changes
   M notes/a.md
  ?? notes/b.md
```

`--format json` prints the same as one JSON object; when the folder can't be read, its `repo` is `{"state": "unavailable", "why": …}` and `pending` and `unpushed` are `"unknown"`, never an empty list. `daemon:` shows `not running (stale lock, pid N)` if the machine rebooted under a running daemon. A `not synced:` section lists files that are never committed: local-only conflict copies (of gitignored files), paths that differ only in letter case on a case-insensitive disk (fix those by removing one spelling), and git repositories cloned or created inside the folder (their files never sync; move them out, or copy the files you want synced next to them).

**Kept stashes.** To bring uncommitted edits across a pull, md-sync stashes them and replays them itself. If it can't verify that a replay landed on disk (for example, an agent wrote the same file at that moment), it keeps the stash instead of dropping it and logs `stash kept`. `md-sync status` lists these, for example `kept stashes: 1 (git -C /Users/tal/agent-notes stash list)`. md-sync never replays them again. To inspect one and recover anything missing from the working copy:

```sh
git -C ~/agent-notes stash list
git -C ~/agent-notes stash show -p <sha>          # what the stash holds
git -C ~/agent-notes checkout <sha> -- notes/a.md # take a file from it, if needed
git -C ~/agent-notes stash drop stash@{N}         # once you're done
```

## Changing the remote

md-sync never rewrites `.git/config`. If the configured `remote` differs from the clone's `origin`, it logs `remote mismatch` with the exact fix and keeps using `origin`:

```sh
git -C <dir> remote set-url origin <url>
```

Then restart the daemon.

## Security notes

- **Plaintext on GitHub:** git's SSH and HTTPS transport encrypts data in transit only. Your files are stored as plaintext on GitHub and in every clone. If that matters, layer git-crypt or similar on top.
- `GIT_TOKEN` is passed through a git credential helper in the process environment. It never appears in a URL, a log line, argv or a service unit.
- The ntfy topic name is a shared secret. Use a long random string.

## Limits

- One folder per daemon process. Run one process (or service) per folder.
- One branch. No per-agent branches or PR workflows.
- Files over 5 MB are synced with a `large file` warning. Large or binary files are not the target. A repo that uses Git LFS works (with `git-lfs` installed): md-sync uploads the LFS objects before each push, and downloads incoming ones before checking them out. An object the server doesn't have yet is retried like a network error.
- Git repositories inside the folder (a `git clone` or `git init` in a subfolder) are not synced, nor are submodules. `status` lists them under `not synced`.
- Changing only the letter case of the folder or a parent (`projects` → `Projects`) while the daemon runs makes it stop with `folder moved`; the service manager restarts it at the new spelling (in a terminal, start it again). Moving the folder elsewhere needs a new config `dir` and a reinstall.

## Development

```sh
bun install
bun test                 # fast unit checks (default root: test/unit)
bun run test:integration # real Git, processes, sockets and filesystem watching
bun run test:acceptance  # end-to-end daemon tests; local bare repos, no network
bun run test:all         # all three suites
bun run typecheck        # tsc --noEmit
bun run build            # bun build --compile src/cli.ts --outfile dist/md-sync
```

- **macOS:** the compiled binary must be ad-hoc re-signed or macOS kills it at launch: `codesign --force --sign - dist/md-sync`.

To use a separate SSH private key for one repo, add `"sshKey": "~/.ssh/notes_ed25519"` to its instance config, or pass `--ssh-key ~/.ssh/notes_ed25519`. Use an SSH remote URL. Relative key paths resolve from the instance config directory (CLI paths from the current directory). Changes apply on restart or SIGHUP. md-sync uses noninteractive SSH with `IdentitiesOnly=yes` and disables connection reuse for this identity; encrypted keys must already be unlocked in your SSH agent. Without `sshKey`, existing git authentication is used. Keep the private key outside the synced folder; config contains only its path.
