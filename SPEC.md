# Handoff: mdsync — git-backed markdown sync daemon

Oct 7, 2026 · @Tal Atlas

> Naming note: the project folder and package are `md-sync` (kebab-case). The spec below uses `mdsync` as the command and tool name throughout; see AGENTS.md "Naming" for the open item.

## Goal

Build `mdsync`: a standalone TypeScript daemon that keeps a local folder of Markdown files in two-way sync with a git remote, triggered by events rather than a polling timer. Install it once per device or container, point it at a repo with a few env vars, and run it as a service.

The synced repo is shared by several writers:

- **Cloud agents** that clone the repo from GitHub and push to `main` with normal git.
- **Local agents on a Mac and a Linux box** that only read and write plain files in the synced folder. They never run git.
- **The daemon on each device**, which is the only process that runs git in its folder.

Latency of tens of seconds is fine. Correctness matters more: no lost writes, no stalled syncs, no manual cleanup.

## Constraints

- **Standalone tool, not part of the synced repo.** It lives in its own repo and is installed globally (`bun add -g mdsync`, or the compiled single binary). It writes nothing into the synced repo except commits of user content. The tool never writes config, hooks or lockfiles into it. The optional repo config file is something the user commits.
- **Bun only.** Target the latest stable Bun. Node and Deno are never supported, so use Bun APIs freely: `Bun.spawn` or Bun Shell (`$`), `Bun.file`/`Bun.write`, `bun:test`. It needs to run on macOS and Linux, and in a slim container (`oven/bun:slim` plus `git`).
- **Few, small dependencies.** Run the system `git` binary through `Bun.spawn`, with no git wrapper library. Use `chokidar` for file watching, because it handles editor save patterns and `awaitWriteFinish` better than raw `fs.watch`. Read the ntfy SSE stream with `fetch` and parse it by hand; it's a few lines, so no `EventSource` dependency is needed. Use `zod` for config validation. Avoid isomorphic-git: we want real git's behavior and on-disk format.
- **Configuration lives in files, and any setting can be overridden by a CLI flag**. Env vars are only for process-wide settings such as the git token and log level. Details are under Configuration. No interactive setup.
- **Uses the existing git auth** on the machine: SSH key, credential helper, or a `GIT_TOKEN` env var for containers. Never logs credentials.
- **One daemon per synced folder.** Enforce this with a lockfile *outside* the repo, e.g. `$XDG_STATE_HOME/mdsync/<hash-of-path>.lock`.

## Configuration

Each instance gets its settings from a JSON config file, and any individual setting can be overridden with a CLI flag. Env vars are reserved for settings that apply to the whole process environment and are shared by every instance running in it.

**Precedence**, from highest to lowest: CLI flag, then the instance config file, then the repo config file, then the default.

**Instance config file:** pass it with `mdsync run --config <path>`. The default path is `$XDG_CONFIG_HOME/mdsync/config.json`. Use one file per synced folder, so running several instances on one machine means several files. Changes take effect on restart or `SIGHUP`. If the file is invalid, refuse to start and say which key is wrong.

**Repo config file:** `<repo>/.config/mdsync.json`. It is optional and committed by the user, so all devices share it. It holds shared keys only. Per-instance keys (`remote`, `dir`, `authorName`, `authorEmail`) are ignored with a warning. Reload it when a sync changes it, and keep the last good version if the new one is invalid. Validate both files with zod.

| Key | CLI flag | Default | Allowed in | Purpose |
| --- | --- | --- | --- | --- |
| `remote` | `--remote` | (required) | Instance file | Git remote URL (SSH or HTTPS) |
| `dir` | `--dir` | (required) | Instance file | Local folder to sync. If it's missing or empty, clone into it |
| `branch` | `--branch` | `main` | Either | Branch to sync |
| `ntfyUrl` | `--ntfy-url` | (unset) | Either | ntfy topic for remote-push events. If unset, rely on the fallback timer only |
| `idleMs` | `--idle-ms` | `300000` (5 min) | Either | Backup commit after this long with no local writes and no flush. See Commits and flush |
| `fallbackMs` | `--fallback-ms` | `3600000` | Either | Catch-up sync interval (1h) |
| `ignore` | `--ignore` (repeatable) | `[]` | Either | Extra globs to ignore, on top of `.git/` and `.gitignore` |
| `authorName` | `--author-name` | `mdsync@<hostname>` | Instance file | Commit author name |
| `authorEmail` | `--author-email` | `mdsync@<hostname>.local` | Instance file | Commit author email |
| `maxWaitMs` | `--max-wait-ms` | `1800000` (30 min) | Either | Backup commit this long after the first uncommitted change, even if writes continue |

**Env vars** are limited to these:

| Env var | CLI flag | Default | Purpose |
| --- | --- | --- | --- |
| `GIT_TOKEN` | (none) | (unset) | HTTPS token, passed through a credential helper and never put in the URL or logs |
| `MDSYNC_LOG_LEVEL` | `--log-level` | `info` | `debug` / `info` / `warn` / `error`, logged as JSON lines to stdout |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | (none) | Platform default | Where the default config file and the state and lock files go |

An example instance file:

```json
{
  "remote": "git@github.com:tal/agent-notes.git",
  "dir": "~/agent-notes",
  "ntfyUrl": "https://ntfy.sh/<long-random-topic>"
}
```

An example run with an override: `mdsync run --config ~/.config/mdsync/notes.json --idle-ms 120000`.

## Sync algorithm

All triggers feed one serialized queue. If a sync is already running, a new trigger only sets a `dirty` flag, which causes exactly one more run afterwards. Two syncs must never run at once.

**Triggers:**

- **A flush** from `mdsync flush`, or a **backup timer** (`idleMs` or `maxWaitMs`) firing: a commit run. See Commits and flush. Local file changes on their own only arm the backup timers. The watcher ignores `.git/` and gitignored paths, and waits for writes to finish (`awaitWriteFinish`).
- A remote push event from ntfy: a pull-only run, but only if the SHA in the message isn't already in the local history.
- Startup, an SSE reconnect, and wake from sleep (detected by a timer that fires much later than scheduled).
- The catch-up timer (pull-only), `fallbackMs`.

**One sync run:**

1. Run a pre-flight check. If a rebase or merge is in progress, or a stale `index.lock` is older than 60s with no git process running, recover: abort the rebase or merge, remove the lock, and log a warning.
2. Commit runs only (pull-only runs skip this step): `git add -A`, or just the flushed paths when the flush named some, then commit if anything is staged. The message is the flush message if one was given, otherwise `sync <hostname> <ISO time>`, with `(auto)` appended for backup-timer commits. Either way, add a list of changed files, truncated after 20.
3. `git fetch origin <branch>`.
4. `git rebase --autostash origin/<branch>`. Uncommitted local changes are stashed and reapplied on top, so a pull-only run never commits half-done work. On conflict, in the rebase itself or when the stash is reapplied, go to Conflict handling. For a stash conflict, the local working-copy version is the one saved as the conflict copy.
5. `git push origin <branch>`. If it's rejected as non-fast-forward, which means someone pushed in between, retry from step 3 up to 3 times with backoff.
6. Log the result: the commit counts in and out, and the final `HEAD`.

Network failures don't count as conflicts. On a network failure, back off exponentially (from 30s, capped at 10 min) and keep local commits. The next run pushes them.

## Commits and flush

A local file change never triggers a commit on its own. Commits happen when a writer says it's done, and backup timers guarantee nothing stays uncommitted for long if that signal never comes. Cloud agents commit with git themselves and aren't affected.

**Primary: `mdsync flush`.** Agents call it when they finish a unit of work, usually from an end-of-turn hook.

- It finds the running daemon for the folder from `--config`, `--dir`, or the current directory being inside a synced folder, and signals it over a Unix socket at `$XDG_STATE_HOME/mdsync/<hash-of-path>.sock`.
- `--message <text>` sets the commit message. Repeatable `--path <file>` commits only those paths. Without `--path`, it commits everything pending.
- By default it returns as soon as the daemon has queued the flush. With `--wait`, it blocks until the push finishes and exits non-zero on failure.
- Flushes that arrive while a run is in progress coalesce into one commit run: their paths are combined, and their messages are joined.
- If no daemon is running, `flush` takes the folder lock and does a single commit run itself, so a flush is never silently dropped.

**Backup: two timers.** When the watcher sees an uncommitted change, it arms both timers:

- `idleMs` (default 5 min): commit once the folder has been quiet this long.
- `maxWaitMs` (default 30 min): commit this long after the first uncommitted change, even if writes keep coming.

Whichever fires first starts a commit run, and any commit run resets both. Backup commits get `(auto)` in the message, so `git log --grep '(auto)'` shows where a writer forgot to flush. On `SIGTERM`, pending changes are committed as a backup commit before exit.

**Example hook (Claude Code `Stop` hook, in its settings file):**

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "mdsync flush --dir ~/agent-notes" }] }
    ]
  }
}
```

The README should include this example and say that any agent framework with an end-of-task hook can do the same.

## Conflict handling

When a conflict happens, keep both versions and keep syncing. Never auto-resolve with `-X ours/theirs`, and never stop waiting for a human.

1. Note the conflicted paths and `git rebase --abort`.
2. For each conflicted file, copy the local version aside, then take the remote version: `git checkout origin/<branch> -- <path>`.
3. Write the local version to `<name> (conflict <hostname> <YYYY-MM-DD HHmm>).md` next to the original.
4. Hard-reset to `origin/<branch>`. This is safe because every local change is either already on the remote or saved in a conflict copy. Before resetting, verify that every file changed in the local-only commits has been saved. If that check fails, stop and log an error rather than lose data.
5. Commit the conflict copies, then push.
6. Log a `warn` line listing the conflict files.

**End state.** On every device, the original path holds whichever version reached the remote first. The losing device's version sits beside it as the conflict copy, and both are committed. No content is lost, but nothing is merged either: someone, a person or an agent, reconciles the two files later and deletes the copy, and that edit syncs like any other. This path only runs when the two sides edited overlapping lines. Edits to different parts of the same file are merged automatically by the rebase and never produce a conflict copy.

Handle deletes too: if one side deleted a file and the other edited it, keep the edited version, and log the delete as overridden.

In practice conflicts should be rare, because agents write to their own files. The conflict path still has to be solid and tested.

## Remote push events

Remote events come from a GitHub Action that posts each pushed SHA to an ntfy topic. Each daemon subscribes to that topic over SSE, so no device needs an inbound port.

The tool ships a ready-made workflow file and a command that prints it: `mdsync print-workflow`. The user commits that file to the synced repo themselves. It's the only thing that touches the repo, and it's optional.

```yaml
# .github/workflows/mdsync-notify.yml
name: mdsync-notify
on:
  push:
    branches: [main]
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -d "$GITHUB_SHA" "$NTFY_URL"
        env:
          NTFY_URL: ${{ secrets.MDSYNC_NTFY_URL }}
```

**Daemon side:**

- Subscribe to `<ntfyUrl>/sse` and parse the `message` events.
- If the SHA is already in local history, ignore it: it's an echo of this device's own push. Otherwise, enqueue a sync.
- Reconnect with backoff, and trigger a catch-up sync on every reconnect.
- Use the public ntfy.sh instance. Make the topic name a long random string, which acts as the shared secret. The README should say this plainly, and mention self-hosting ntfy as a later option, which works by changing only ntfyUrl.

## Packaging and install

Ship it two ways. The first is a package with a `bin` entry that runs the TypeScript source directly, installed with `bun add -g`. The second is a standalone executable from `bun build --compile` for `darwin-arm64`, `linux-x64` and `linux-arm64`, attached to GitHub releases. The binary needs nothing installed except `git`.

**Commands:**

- `mdsync run`: run in the foreground. This is what services and containers call.
- `mdsync sync-once`: run a single sync and exit, for cron, debugging and CI.
- `mdsync status`: show the last sync time and result, plus pending local changes, read from the state file in `$XDG_STATE_HOME/mdsync/`.
- `mdsync install-service`: write and load a launchd plist on macOS, or a systemd user unit on Linux, pointing at the instance config file plus any CLI overrides. Also add `uninstall-service`.
- `mdsync print-workflow`: print the GitHub Action YAML.
- `mdsync flush [--message] [--path ...] [--wait]`: mark work as done and commit now. See Commits and flush.

**Service behavior:**

- Restart on crash.
- Shut down cleanly on SIGTERM: finish the current sync, commit and push anything pending, then exit.
- On Linux, document `loginctl enable-linger` so the service runs without an active login.

**Container:**

- Include a `Dockerfile` example based on `oven/bun:slim` with `git` installed.
- Mount the synced folder as a volume and run `mdsync run` as the entrypoint.
- Support `GIT_TOKEN` for HTTPS auth, or a mounted SSH key.

## Testing and acceptance

The integration tests use a local bare repo as the remote and two or three daemon instances on separate temp clones. No network is needed. Use `bun test`.

- [ ] A file written in clone A shows up in clone B. Simulate the ntfy event in tests.
- [ ] Ten files written and then one flush produce exactly one commit, using the flush message.
- [ ] Concurrent edits to the same file on A and B on overlapping lines leave the first-pushed version at the original path plus one conflict copy, and no content is lost from either side.
- [ ] An edit on one side and a delete on the other keeps the edited file.
- [ ] Killing the daemon mid-rebase, then restarting it, recovers automatically, with a clean tree and nothing lost.
- [ ] A stale `index.lock` is cleaned up. A lock held by a live git process is left alone.
- [ ] With the remote unreachable, local commits pile up; once the remote is back, they all push.
- [ ] A push rejected as non-fast-forward retries and succeeds.
- [ ] A daemon's own ntfy echo doesn't trigger a redundant sync.
- [ ] Starting a second daemon on the same folder fails fast with a clear error.
- [ ] The synced repo contains nothing written by `mdsync` other than user content commits.
- [ ] Runs on macOS, on Linux, and in the example container.
- [ ] The compiled binary from `bun build --compile` passes an end-to-end smoke test, run in CI on Linux and macOS.
- [ ] With no flush, a change is committed after `idleMs` of quiet, with `(auto)` in the message.
- [ ] Continuous writes with no flush are still committed once `maxWaitMs` passes.
- [ ] A remote event arriving with unflushed local changes pulls them in without committing the local changes.
- [ ] `flush --path` commits only the named paths. `flush --wait` exits non-zero when the push fails.
- [ ] `flush` with no daemon running does a one-off commit run itself.
- [ ] `SIGTERM` with pending changes commits and pushes them before exiting.

## Out of scope

- Large or binary files. The tool should log a warning for files over 5 MB but still sync them.
- Multiple branches, per-agent branches, or PR workflows.
- A GUI, tray icon, or mobile client.
- Syncing more than one folder per daemon process. Run one process per folder instead.
- End-to-end encryption of repo contents. Git's SSH and HTTPS transport only encrypts data in transit; files are stored as plaintext on GitHub and in every clone. If that matters later, layer git-crypt or similar on top.
