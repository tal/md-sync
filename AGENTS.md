# AGENTS.md — md-sync

Git-backed, two-way Markdown folder sync daemon (command: `md-sync`). **Status: implemented.** There is no separate spec or design doc: the [`README.md`](./README.md) (what mdsync does, for users), the code and the tests are the source of truth. Read the README and the modules you're changing (each file's header comment says what it owns) before changing anything.

## Naming

- Folder and package: `md-sync` (kebab-case).
- `md-sync` is the command. `mdsync` remains the env var prefix (`MDSYNC_LOG_LEVEL`), the state dir (`$XDG_STATE_HOME/mdsync/`) and the workflow file (`mdsync-notify.yml`).
- The package bin, compiled executable and release assets use `md-sync`. Keep the existing `mdsync` config/state paths, service identifiers, workflow name and `MDSYNC_*` environment variables.
- **Open item (npm name):** the npm name `md-sync` belongs to an unrelated third-party package, so this project can't be published under it (`mdsync` was free on npm as of 2026-10-08, or use a scope). Until a name is chosen, docs install from GitHub (`bun add -g github:<owner>/md-sync`) and must never tell users to `bun add -g md-sync`. Don't rename the package without asking.

## Stack and hard constraints

- **Bun only** (a recent stable release, pinned in `.bun-version` for CI and releases; bump it on purpose). Never add Node or Deno compat. Use `Bun.spawn`, `Bun.file`/`Bun.write`, `bun:test`.
- **Dependencies:** `chokidar` and `zod` (config validation). Nothing else without asking. (`@types/bun` and `typescript` are devDependencies for type-checking only.) No platform uses chokidar any more: macOS watches with one recursive `fs.watch` and Linux polls, because Bun's per-path `fs.watch` (which chokidar uses) deadlocks. Removing it is an open decision.
- **Git:** shell out to system `git` ≥ 2.40 via `Bun.spawn` (the replay needs `merge-tree --merge-base`, the worktree move `--attr-source`). No git wrapper libs, no isomorphic-git.
- **`bun:ffi`** only for the atomic exchange in `src/exchange.ts` (`renamex_np` / `renameat2`). It is optional: without it mdsync falls back to rename-only or copy-only moves.
- **ntfy:** read SSE with `fetch` and parse by hand. No `EventSource` dependency.
- **Never write into the synced repo** except commits of user content and the worktree move's journaled temp folder `.mdsync-<pid>-<startMs>.d/`, which is removed once its replaced files have settled. No config, hooks or lockfiles there. Lock, socket and state files live under `$XDG_STATE_HOME/mdsync/`.
- **Never log credentials.** `GIT_TOKEN` goes through a credential helper, never in a URL or log line.
- Logging is JSON lines to stdout (stderr for `status`, `print-workflow` and `(un)install-service`), levels `debug` / `info` / `warn` / `error`. Every `msg` is in the closed set `LOG_MSGS` in `src/log.ts`.

## Correctness rules (don't regress these)

- One sync at a time. Triggers during a run only set a `dirty` flag, causing exactly one more run.
- Local file changes only arm backup timers. Commits come from `flush`, a backup timer or `sync-once`.
- Pull-only runs (ntfy, catch-up) never commit local work, except conflict copies. They carry uncommitted edits through the worktree move.
- Conflicts: keep both versions as `<name> (conflict <hostname> <YYYY-MM-DD HHmm>).md`. Never use `-X ours/theirs`. Verify every local-only change is saved before the worktree moves. If the check fails, log an error and stop rather than lose data.
- No git command writes the worktree. A file is replaced or deleted only after a check, right before the switch, that it still holds the bytes classified as being in git, and nothing is unlinked unverified.
- No mtime ever proves that a file is git's output: only its content does.
- Edit vs delete: the edit wins, and the delete is logged as overridden.
- Network failure is not a conflict: exponential backoff (30s to 10 min), keep local commits; a network change retries at once.
- Config precedence: CLI flag > instance file > repo file > default. Invalid instance config refuses to start and names the key. Invalid repo config keeps the last good version.

## Code style

- TypeScript, strict mode.
- **No booleans for state or options. Use enums / string literal unions** (e.g. `type SyncKind = 'commit' | 'pull-only'`), even for two-value choices. Plain boolean return values from predicates, and third-party APIs that require a boolean (`Bun.spawn({detached: true})`, chokidar options, `parseArgs` flags converted to an enum at the CLI boundary), are the only exceptions. `test/unit/style.test.ts` enforces this.
- Match surrounding code for naming and comment density. Prefer small modules, one concern each. Comments explain the reason in plain language; don't cite section numbers of docs that don't exist.

## Testing

- `bun test` runs fast unit checks; `bun run test:integration` runs the real Git/process/watcher tests; `bun run test:acceptance` runs the daemon acceptance tests. `bun run test:all` runs all three. Also run `bunx tsc --noEmit` for types. Module integration tests use real Git, processes, sockets and watchers. Acceptance tests use a local bare repo as the remote plus 2-3 daemon instances on temp clones. No network.
- The tests are the definition of done: the numbered acceptance tests in `test/acceptance/` cover user-visible behavior end to end, the unit tests in `test/unit/` cover each module, and CI adds the compiled-binary and container smoke tests. A behavior change comes with a test that pins it.
- Tests must prove the synced repo contains only user content commits.
- Tests check code against code, never against Markdown: no test reads the README or any other `.md` file unless the user asks for one. `test/unit/log.test.ts` checks `LOG_MSGS` against the log calls in `src/`. Keeping the README accurate is a review job, not a test.

## Layout

```
src/              one module per concern; each file's header comment says what it owns
src/commands/     one file per CLI command, plus shared.ts
test/unit/        fast unit checks, no daemon (mostly one file per src module)
test/integration/ real Git, process, socket and watcher regression tests
test/acceptance/  end-to-end tests, numbered per behavior, using test/harness.ts
test/fixtures/    config and ntfy fixture cases (each folder has a README)
test/smoke.test.ts, test/container-smoke.sh   compiled-binary and container smoke tests (CI)
Dockerfile        oven/bun:slim + git + tini example
.github/          CI (all three test suites, compiled-binary smoke on Linux + macOS, container), release builds
changelog/        YYYY-MM-DD_descriptive-name.md after each significant change
```

## Working in this repo

- Add a `changelog/YYYY-MM-DD_descriptive-name.md` entry after any significant change. Record what was learned or corrected, not just what moved. Entries before 2026-10-09 cite `SPEC.md` and `docs/ARCHITECTURE.md` sections; both were deleted, so read those citations as history.
- Questions get answers, not actions. Wait for an explicit go-ahead before building.
- Update the README in the same change when user-visible behavior changes, so it stays accurate. Log `msg` strings, exported signatures, file names, constants and the IPC wire format are API: change them on purpose, update their tests, and note the change in the changelog.
