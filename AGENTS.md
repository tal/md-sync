# AGENTS.md — md-sync

Git-backed, two-way Markdown folder sync daemon (command: `mdsync`). **Status: spec only, no code yet.** The full spec is in [`SPEC.md`](./SPEC.md) and is the source of truth. Read it before changing anything.

## Naming

- Folder and package: `md-sync` (kebab-case).
- The spec uses `mdsync` for the command, env var prefix (`MDSYNC_LOG_LEVEL`), state dir (`$XDG_STATE_HOME/mdsync/`), and workflow file (`mdsync-notify.yml`).
- **Open item:** decide whether the `bin` name is `mdsync` (as in the spec) or `md-sync`. Until decided, keep `mdsync` everywhere in code and docs, and don't rename without asking.

## Stack and hard constraints

- **Bun only** (latest stable). Never add Node or Deno compat. Use `Bun.spawn`, `Bun.file`/`Bun.write`, `bun:test`.
- **Dependencies:** `chokidar` (watching) and `zod` (config validation). Nothing else without asking.
- **Git:** shell out to system `git` via `Bun.spawn`. No git wrapper libs, no isomorphic-git.
- **ntfy:** read SSE with `fetch` and parse by hand. No `EventSource` dependency.
- **Never write into the synced repo** except commits of user content. No config, hooks or lockfiles there. Lock, socket and state files live under `$XDG_STATE_HOME/mdsync/`.
- **Never log credentials.** `GIT_TOKEN` goes through a credential helper, never in a URL or log line.
- Logging is JSON lines to stdout, levels `debug` / `info` / `warn` / `error`.

## Correctness rules (don't regress these)

- One sync at a time. Triggers during a run only set a `dirty` flag, causing exactly one more run.
- Local file changes only arm backup timers. Commits come from `flush` or a backup timer.
- Pull-only runs (ntfy, catch-up) never commit local work. They use `rebase --autostash`.
- Conflicts: keep both versions as `<name> (conflict <hostname> <YYYY-MM-DD HHmm>).md`. Never use `-X ours/theirs`. Verify every local-only change is saved before the hard reset. If the check fails, log an error and stop rather than lose data.
- Edit vs delete: the edit wins, and the delete is logged as overridden.
- Network failure is not a conflict: exponential backoff (30s to 10 min), keep local commits.
- Config precedence: CLI flag > instance file > repo file > default. Invalid instance config refuses to start and names the key. Invalid repo config keeps the last good version.

## Code style

- TypeScript, strict mode.
- **No booleans for state or options. Use enums / string literal unions** (e.g. `type SyncKind = 'commit' | 'pull-only'`), even for two-value choices. Plain boolean return values from predicates are the only exception, and only when unavoidable.
- Match surrounding code for naming and comment density. Prefer small modules, one concern each.

## Testing

- `bun test`. Integration tests use a local bare repo as the remote plus 2-3 daemon instances on temp clones. No network.
- The acceptance checklist at the bottom of `SPEC.md` is the definition of done. Each item should map to a test (or a CI job, for the compiled-binary smoke test).
- Tests must prove the synced repo contains only user content commits.

## Planned layout (not yet created)

```
src/        cli, config, queue, sync, git, watcher, ntfy, flush (socket), service, conflict
test/       integration tests per acceptance item
Dockerfile  oven/bun:slim + git example
.github/    CI (bun test, compiled-binary smoke on Linux + macOS), release builds
changelog/  YYYY-MM-DD_descriptive-name.md after each significant change
```

## Working in this repo

- Add a `changelog/YYYY-MM-DD_descriptive-name.md` entry after any significant change. Record what was learned or corrected, not just what moved.
- Questions get answers, not actions. Wait for an explicit go-ahead before building.
- Update `SPEC.md` when a decision changes, so it stays the source of truth.
