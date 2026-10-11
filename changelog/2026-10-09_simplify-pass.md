# Simplify pass: shared helpers, de-duplicated sync logic, fewer git spawns

Behavior-neutral cleanup from a reuse / simplification / efficiency / altitude review of `src/`.

## Reuse
- `firstLine`, `realpathOrSame` and `isOid` now live once (`fsutil.ts`, `git.ts`) instead of 3-4 copies each.
- `rescue.ts` uses `sha256Hex` from `cas.ts`; `flush.ts` / `exchange.ts` use `kindAt`; `merge-file.ts` uses `isRecord`; `preflight.ts` / `watcher.ts` use `errCode`.
- `sync.ts` imports `NON_FF_RE` and `isOkOutcome` instead of keeping private copies.
- `checkIgnored` (commit.ts) is reused by `pending.ts`.
- `acquireOneOffLock` replaces the same lock-or-busy expression in `flush` and `sync-once`.

## Simplification
- `sync.ts`: one helper logs network/auth failures (six pasted blocks removed).
- `failedRunResult` replaces two identical 18-field `RunResult` literals (queue.ts, daemon.ts).
- `daemon.ts`: `#shutdown` was derivable from `#phase === 'stopping'`; the duplicated reload block is one method.
- `ipc.ts`: one connect-failure classifier, merged `queued` condition, no redundant `clearTimeout` guards.
- `state.ts`: `rmSync(path, { force: true })` for unlink-ignore-ENOENT.

## Efficiency
- `commit.ts`: one batched `ls-files` replaces a spawn per deleted candidate (falls back to the single probe when git's case/Unicode folding makes the batched answer ambiguous).
- `sync.ts` `lastIntegrated`: independent probes run concurrently; the tracking probe is reused when `known` equals it.
- `daemon.ts`: shutdown and startup probes run concurrently.

## Learned / deliberately not done
- The three index-lock regexes (`git.ts` `LOCKED_RE`, `move.ts` `LOCK_RE`, `conflict.ts`) are **not** equivalent (`cannot lock ref`, `: File exists` suffix, stdout vs stderr), so unifying them would change which failures count as locked. Left as is.
- Passing HEAD / the origin ref through to `finish` and S4 is not neutral: those can run after the push moved `refs/remotes/origin/B` or after `update-ref -d`.
- Not taken: move planner `Promise.all`, `lsTree` memoization and `registerCopies` batching (safety-critical `move.ts`, needs its own change); `--cwd` `chdir` removal; carrying failure kinds on move/replay results instead of matching error text; narrowing unused exports.
- `errCode` in `watcher.ts` `onError` stringifies non-string codes where the old code mapped them to `'other'`; this only changes a warning dedupe key.
