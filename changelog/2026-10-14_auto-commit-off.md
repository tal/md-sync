# `autoCommit`: pull automatically, commit only by hand

New shared config key `autoCommit: 'timers' | 'off'` (default `timers`, the old behavior), settable in the instance file, the repo file `.config/mdsync.json` and as `--auto-commit <timers|off>`. With `off`, md-sync keeps pulling (ntfy, `fallbackMs` catch-up, wake, network) but never commits on its own: only `flush` and `sync-once` commit.

## What changed

| Area | Change |
| --- | --- |
| `src/config.ts` | `autoCommit` in `SHARED_KEYS`, both schemas (`z.enum`), `InstanceInput`/`RepoInput`/`ResolvedConfig`, `CONFIG_KEYS` (after `maxWaitMs`), `CONFIG_FLAGS`, defaults. New exports `AUTO_COMMIT_MODES` and `AutoCommit`. Invalid values follow the existing rules: an instance file refuses to start naming the key, a repo file keeps its last good layer. |
| `src/cli.ts`, `src/commands/shared.ts`, `src/service.ts` | `--auto-commit` flag, usage line, `CliValues`, and re-emitted into service units after `--max-wait-ms`. |
| `src/daemon.ts` | With `off`, a local change only logs `local change`; the post-run status check never arms the timers; a timer that somehow fires is ignored. A reload to `off` clears armed timers; back to `timers` runs a status check that arms them for pending changes. |
| `src/daemon.ts` shutdown | With `off`, pending edits are left in the worktree (new log msg `changes left uncommitted`, `{changes, reason: 'auto-commit-off'}`). If commits are unpushed, a shutdown-mode **pull-only** run (reason `shutdown`) pushes them: in shutdown mode a pull-only run is preflight plus one push attempt, no fetch, no commit. `settlePending` after the queue drains is unchanged, so replaced inodes still settle. |
| `src/types.ts` | `PullReason` gains `'shutdown'` (it was already a `TriggerLabel`). |
| `md-sync status` | Text line `auto commit: timers` / `off (only flush and sync-once commit)`; JSON gains `autoCommit` (`'timers' | 'off' | 'unknown'`), additive. |
| README | Config table row, the Flushing section (new "Pull automatically, commit only by hand" block), the shutdown bullet, status example and JSON note. |

## Tests

- `test/unit/config.test.ts`: schema values, precedence row (cli > instance > repo > default), instance/CLI/repo invalid-value issues, `changedKeys` order, defaults.
- `test/unit/service.test.ts`: `--auto-commit` re-emitted in table order.
- `test/acceptance/37-auto-commit-off.test.ts`: (1) a local edit past both timers is not armed, fired or committed; `status` shows `off` and the pending paths; an ntfy-triggered pull lands with the edit still uncommitted; `flush --wait` commits and pushes; SIGTERM commits nothing, runs no shutdown sync and leaves the file untracked. (2) `--auto-commit off` from the CLI: SIGTERM pushes an existing unpushed commit through a pull-only shutdown run and leaves the pending edit. (3) SIGHUP to `off` cancels armed timers; SIGHUP back to `timers` arms them and the backup commit lands.
- Integration test fixtures that build a `ReadyConfig` literal now include `autoCommit: 'timers'` (the field is required on the resolved config).

## Notes

- The shutdown commit run could not simply be skipped when `off`: a clean tree with an unpushed commit (a flush during an outage) must still be pushed on stop. Reusing the shutdown-mode pull-only run gets exactly "push, don't commit" without a new run kind in `sync.ts`.
- Conflict copies made by pulls are still committed in pull-only runs; nothing about that path changed.
