# md-sync

`md-sync` keeps a local folder of Markdown files in two-way sync with a git remote. It is a small Bun/TypeScript daemon, one per synced folder. Syncing is driven by events rather than a fetch loop (local changes come from an FSEvents stream on macOS, and from a stat poll of the folder on Linux and in containers):

- **Agents say when they're done.** `md-sync flush` (usually from an end-of-task hook) commits and pushes. Backup timers commit anything nobody flushed, unless you turn them off (`autoCommit: "off"`).
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

- **As a single binary** from the [GitHub releases](../../releases). The macOS and glibc builds need nothing but `git`; the musl builds also need the C++ runtime (`apk add git libstdc++ libgcc` on Alpine):

  | Asset | For |
  |---|---|
  | `md-sync-darwin-arm64` | Apple silicon Macs |
  | `md-sync-linux-x64` | x64 Linux with glibc and an AVX2 CPU (most desktops and servers since about 2015) |
  | `md-sync-linux-x64-baseline` | x64 Linux with glibc on any CPU (older or low-power CPUs such as Atom/Celeron NAS boxes, and VMs with a generic CPU model like `kvm64`) |
  | `md-sync-linux-arm64` | arm64 Linux with glibc (Raspberry Pi OS 64-bit, Ubuntu) |
  | `md-sync-linux-x64-musl` | Alpine and other musl-based systems on an AVX2 CPU |
  | `md-sync-linux-x64-musl-baseline` | Alpine and other musl-based systems on any x64 CPU |
  | `md-sync-linux-arm64-musl` | Alpine and other musl-based systems on arm64 |

  A glibc build on Alpine fails with `not found`, a musl build without `libstdc++` fails with `Error loading shared library libstdc++.so.6`, and an AVX2 build on a CPU without it dies with `Illegal instruction`: pick the `-baseline` asset (glibc or musl) then.

  ```sh
  # Replace <owner> with the GitHub owner of this repo, and pick your platform's file.
  curl -fL -o ~/.local/bin/md-sync https://github.com/<owner>/md-sync/releases/latest/download/md-sync-linux-x64
  chmod +x ~/.local/bin/md-sync
  md-sync --version
  ```

  The macOS binary is ad-hoc signed. If you downloaded it with a browser, clear the quarantine flag with `xattr -d com.apple.quarantine md-sync`.

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
| `md-sync status [--format text\|json] [--json]` | Show a health verdict, whether the daemon is running, the last sync and its result, the ntfy subscription, unpushed commits, the auto-commit mode, pending local changes and kept stashes. `--json` is `--format json`. |
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
| `autoCommit` | `--auto-commit` | `timers` | Either | Yes | `timers`: the backup timers commit what nobody flushed, and a stop commits what is pending. `off`: only `flush` and `sync-once` commit; pulls still run. See [Backup timers](#flushing-from-agents) |
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

A local file change never commits on its own. Commits happen when a writer says it's done, and backup timers make sure nothing stays uncommitted for long if that signal never comes (unless `autoCommit` is `off`, below).

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

**Pull automatically, commit only by hand.** Set `"autoCommit": "off"` (or `--auto-commit off`) to keep the pulls but drop the backup commits:

- Local changes arm no timer. Only `md-sync flush` and `md-sync sync-once` commit; edits nobody flushes stay uncommitted in the folder.
- ntfy events and the `fallbackMs` catch-up still pull, carrying uncommitted edits through as usual. A conflict copy made by a pull is still committed and pushed.
- On `SIGTERM`, pending edits stay uncommitted (logged `changes left uncommitted`); commits that already exist but aren't pushed yet are still pushed.
- It applies on `SIGHUP` or a repo-file change: switching to `off` cancels armed timers, and switching back to `timers` arms them for changes already pending. `md-sync status` shows the mode (`auto commit:`, and `autoCommit` in `--format json`).

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
- **Shutdown:** on `SIGTERM`, md-sync finishes the current sync, commits and pushes anything pending, then exits, within 240 s. With `autoCommit: "off"` it commits nothing: it pushes commits that already exist and leaves pending edits in the folder. The units allow 300 s before a forced kill. A push that can't finish in time stays as a local commit, and the next start pushes it.

## Container

The [`Dockerfile`](./Dockerfile) is an example image based on `oven/bun:slim`, with `git`, `openssh-client` and `tini`. `tini` runs as PID 1: it reaps orphaned `ssh` and `git` children and forwards `SIGTERM` to md-sync. The synced folder is the `/data` volume, state goes in `/state`, and the default config file is `/config/mdsync/config.json`. md-sync runs as the image's unprivileged `bun` user (uid 1000), so what it writes into your folder is owned by you, not root, as long as you create the folder yourself first: for a bind source that doesn't exist yet, Docker creates it owned by root, and the container can't clone into it.

```sh
docker build -t md-sync .
mkdir -p ~/agent-notes   # before the first run: a folder Docker creates belongs to root

# HTTPS with a token (GIT_TOKEN is read from your shell's environment):
docker run -d --name agent-notes --restart unless-stopped --stop-timeout 300 \
  -e GIT_TOKEN \
  -v ~/agent-notes:/data -v agent-notes-state:/state \
  md-sync run --dir /data --remote https://github.com/tal/agent-notes.git --branch main

# SSH with a mounted key plus known_hosts (there is no tty to answer a host-key prompt):
docker run -d --name agent-notes --restart unless-stopped --stop-timeout 300 \
  -v ~/.ssh/id_ed25519:/home/bun/.ssh/id_ed25519:ro \
  -v ~/.ssh/known_hosts:/home/bun/.ssh/known_hosts:ro \
  -v ~/agent-notes:/data -v agent-notes-state:/state \
  md-sync run --dir /data --remote git@github.com:tal/agent-notes.git --branch main
```

- **Stop timeout:** Docker's default stop grace period is 10 s, which isn't enough to commit and push on `SIGTERM`. Use `--stop-timeout 300`, or `stop_grace_period: 5m` in compose.
- **Flush from inside the container:** `docker exec agent-notes bun /app/src/cli.ts flush --dir /data`. A host-side `md-sync flush` can't reach the container's socket, and it can't see the container's lock either: it would start a second, competing sync of the same folder. Use `docker exec`.
- The image trusts every repo path (`safe.directory=*`), because a bind-mounted folder is usually owned by a different uid than the container user.
- **Your uid:** the image runs as uid 1000, the first user on most Linux desktops. If your uid differs (`id -u`), add `--user "$(id -u):$(id -g)"` (compose: `user: "1001:1001"`), or files the container writes won't be yours. That works with `GIT_TOKEN`; ssh refuses to run for a uid with no passwd entry in the image, so use HTTPS then.
- **Upgrading from an image that ran as root:** hand the folder and the state volume to the container user once, for example `docker run --rm --user 0 -v ~/agent-notes:/data -v agent-notes-state:/state --entrypoint chown md-sync -R 1000:1000 /data /state` (use your uid if you run with `--user`). md-sync refuses a state dir owned by another uid.
- **Host-side git on the mounted folder:** the container can't see your host's processes, so md-sync waits 10 minutes (instead of 1) before it treats a git lock or a stopped rebase or merge in the folder as abandoned and cleans it up.
- **One state volume per synced folder.** Every container sees its folder as `/data`, so state is keyed by that same path in each one. Give each instance its own state volume (`agent-notes-state`, `work-notes-state`, …), and never share or reuse one across folders: two containers on one volume would both think they hold the folder lock.

With compose (create `~/agent-notes` first, as above):

```yaml
services:
  md-sync:
    build: .
    command: ["run", "--dir", "/data", "--remote", "https://github.com/tal/agent-notes.git", "--branch", "main"]
    environment:
      GIT_TOKEN: ${GIT_TOKEN}
    volumes:
      - ~/agent-notes:/data
      - agent-notes-state:/state
    stop_grace_period: 5m
    restart: unless-stopped
volumes:
  agent-notes-state:
```

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
health:      degraded (2 paths not synced)
daemon:      running (pid 4242)
last sync:   2026-10-08T12:34:56Z  ok  (commit; in 1, out 2; 830 ms)
head:        0123abcd4567
ntfy:        connected since 2026-10-08T09:00:00Z, last event 2026-10-08T12:34:40Z (89ab01cd23ef), last message 2026-10-08T12:35:10Z
unpushed:    0 commits
auto commit: timers
pending:     2 changes
   M notes/a.md
  ?? notes/b.md
```

`--format json` (or `--json`) prints the same as one JSON object; when the folder can't be read, its `repo` is `{"state": "unavailable", "why": …}` and `pending`, `unpushed`, `notSynced` and `autoCommit` are `"unknown"`, never an empty list. Records that may be absent (`lastRun`, `lastOkAt`, `nextRetryAt`, `stuck`, `service`) are `null`, so the shape never changes:

```json
{"dir": "/Users/tal/agent-notes",
 "health": {"status": "degraded", "issues": ["2 paths not synced"]},
 "daemon": {"state": "running", "pid": 4242}, "service": null, "repo": {"state": "ok", "head": "0123abcd…"},
 "lastRun": {"outcome": "ok", "kind": "commit", "finishedAt": "2026-10-08T12:34:56.830Z", …},
 "lastOkAt": "2026-10-08T12:34:56.830Z", "consecutiveFailures": 0, "nextRetryAt": null, "stuck": null,
 "keptStashes": [], "fallbackMs": 3600000,
 "ntfy": {"state": "connected", "since": "2026-10-08T09:00:00.000Z", "lastConnectedAt": "2026-10-08T09:00:00.000Z",
          "lastMessageAt": "2026-10-08T12:35:10.000Z", "lastEventAt": "2026-10-08T12:34:40.000Z",
          "lastEventSha": "89ab01cd23ef…", "reconnects": 0},
 "unpushed": 0, "pending": [], "notSynced": ["a (conflict mac 2026-10-08 1200).env", "Notes.md"], "autoCommit": "timers"}
```

- **`health.status`** is computed by md-sync so a dashboard doesn't re-derive it. `failing`: the daemon isn't running (stopped or a stale lock), a stuck record, 3 or more failed syncs in a row, no ok sync for 3 × `fallbackMs`, or runs but never an ok one. `degraded`: any failed sync in a row, a last run that wasn't `ok` (`conflict-resolved` included), ntfy disconnected, ntfy connected but silent for 5 minutes (ntfy sends a keepalive every 45 s), kept stashes, or `notSynced` paths. `unknown`: no state file yet. Otherwise `healthy`. `issues` lists every reason in plain words, never the ntfy topic or credentials.
- **`ntfy`** is `"off"` without `ntfyUrl`, `{"state": "unknown"}` when it is set but the daemon hasn't recorded the subscription yet, and otherwise the daemon's record: `state` (`connected` or `disconnected`) and `since`, `lastConnectedAt`, `lastDisconnectedAt` (a live stream dropped), `lastError` (the last failure, redacted like the logs), `lastMessageAt` (the last bytes on the stream, keepalives included), `lastEventAt` and `lastEventSha` (the last push notification, echoes of this device's own pushes included) and `reconnects` since the daemon started.

The daemon keeps that `ntfy` record in its state file, `$XDG_STATE_HOME/mdsync/<hash>.json` (the hash is of the folder path), for other apps to read. It is written at once on a connect, a drop or an event; a keepalive alone updates `lastMessageAt` on disk at most once a minute. Each daemon start begins a new record, a clean stop marks it `disconnected` (`lastError: "stopped"`), and it is absent without `ntfyUrl`. A daemon that died leaves its last record behind, so read it together with the daemon's `pid` or `status`'s `daemon`. `daemon:` shows `not running (stale lock, pid N)` if the machine rebooted under a running daemon. A `not synced:` section lists files that are never committed: local-only conflict copies (of gitignored files), paths that differ only in letter case on a case-insensitive disk (fix those by removing one spelling), and git repositories cloned or created inside the folder (their files never sync; move them out, or copy the files you want synced next to them).

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
bun run test:live        # opt-in: creates a private GitHub repo and three local checkouts
bun run typecheck        # tsc --noEmit
bun run build            # bun build --compile src/cli.ts --outfile dist/md-sync
```

- **macOS:** the compiled binary must be ad-hoc re-signed or macOS kills it at launch: `codesign --force --sign - dist/md-sync`.
- **Binary smoke test:** `MDSYNC_BIN=$PWD/dist/md-sync bun test ./test/smoke.test.ts`.
- **Container smoke test:** `docker build -t md-sync:dev . && bash test/container-smoke.sh md-sync:dev`.
- CI (`.github/workflows/ci.yml`) explicitly runs all three test suites on Linux and macOS, the binary smoke test on both, and the container smoke test. Tagging `v*` builds the release binaries (`.github/workflows/release.yml`).

**Live GitHub check:** `bun run test:live` needs an authenticated `gh` CLI and working GitHub git authentication. Each invocation creates a new private `mdsync-live-<timestamp>-<random>` repo under your authenticated account and three checkouts (`alpha`, `beta`, `gamma`) under `~/mdsync-live/<timestamp>-<random>/`. It checks writes from each checkout, an unflushed backup-timer write, deletion and divergent edits that preserve both versions. It verifies all three heads match GitHub and that commit history contains only synthetic user content. Remote delivery uses a 10-second catch-up timer; this does not test GitHub Actions or ntfy. Config, state and logs stay outside the synced folders.

Use `bun run test:live --ntfy` to also test GitHub Actions → ntfy → daemon pulls. This mode creates a random topic on ntfy.sh, sets the repo's `MDSYNC_NTFY_URL` secret, commits the generated notification workflow and configures all three subscribers. It requires GitHub Actions to be enabled and permission to set repo secrets and push workflow files. The topic stays in the external instance configs and GitHub secret. The workflow discards ntfy's response body to keep the topic out of Actions logs.

In ntfy mode the catch-up interval is one hour, and each wait allows up to five minutes for Actions and notification delivery. For each writer, both peers must log the matching pushed SHA and a successful ntfy-triggered pull that imports it; startup, reconnect and fallback pulls cannot satisfy that check. The corresponding notification workflow must also finish successfully. The history check allows the notification workflow alongside the synthetic user content.

The command stops its daemons on exit and keeps the repo, checkouts, logs and a `README.txt` with restart/flush instructions for manual testing. A successful check also writes `result.json`, including the delivery mode. Delete the GitHub repo and local workspace yourself when finished. Live checks are excluded from `bun test`, `test:all` and CI; they run only with the explicit commands above.

To use a separate SSH private key for one repo, add `"sshKey": "~/.ssh/notes_ed25519"` to its instance config, or pass `--ssh-key ~/.ssh/notes_ed25519`. Use an SSH remote URL. Relative key paths resolve from the instance config directory (CLI paths from the current directory). Changes apply on restart or SIGHUP. md-sync uses noninteractive SSH with `IdentitiesOnly=yes` and disables connection reuse for this identity; encrypted keys must already be unlocked in your SSH agent. Without `sshKey`, existing git authentication is used. Keep the private key outside the synced folder; config contains only its path.
