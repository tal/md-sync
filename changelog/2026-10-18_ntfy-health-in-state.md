# ntfy health in the state file, and a health verdict in `md-sync status`

career-dash's dashboard shows each folder's sync health, including when the ntfy stream last delivered anything. It reads the md-sync state file (`$XDG_STATE_HOME/mdsync/<hash>.json`) and `md-sync status --json`, so the daemon now records its ntfy subscription there, and `status` computes the verdict itself so other apps don't re-derive the rules.

## What changed

| Area | Change |
| --- | --- |
| `src/state.ts` | New `NtfyHealth` type and optional `StateFile.ntfy`: `state` (`connected`/`disconnected`), `since`, `lastConnectedAt`, `lastDisconnectedAt`, `lastError`, `lastMessageAt`, `lastEventAt`, `lastEventSha`, `reconnects`. `normalizeState` keeps a valid record (dropping unknown keys) and drops a malformed one, keeping the rest of the file. |
| `src/ntfy.ts` | `startNtfy` takes optional `onData` (every chunk read off a live stream, keepalives and `open` events included) and `onDisconnect({ error, retryInMs })` (each failed attempt or drop, with the redacted `errorText` of the error; never after `stop()`). New export `addNtfySecrets(log, url)` (the topic path and query redaction `startNtfy` already did, now shared with `status`). |
| `src/ntfy-health.ts` (new) | Pure reducer `nextNtfyHealth`, `freshNtfyHealth`, and `ntfyWriteDue` with `NTFY_MESSAGE_WRITE_MS = 60_000`: connects, drops and events write at once; a message alone writes only if the state file wasn't written in the last minute. |
| `src/daemon.ts` | Keeps the record in `#ntfyHealth`, outside `#state`, and adds it in `#writeState`. `#onRunEnd` replaces `#state` with `recordRun`'s result after awaiting git, so a record stored in `#state` would have been rolled back by any ntfy callback during that await. A loaded state file's `ntfy` is dropped at start (each daemon records its own). New `#stopNtfy` closes a live record as `disconnected`/`stopped` on reload and shutdown, because `stop()` ends the stream without `onDisconnect`. A reload that removes `ntfyUrl` removes the record. |
| `src/health.ts` (new) | `computeHealth` with named constants `FAILING_CONSECUTIVE_FAILURES = 3`, `STALE_OK_FALLBACK_MULTIPLE = 3`, `NTFY_SILENT_MS = 5 min`. Failing outranks unknown (no state file), which outranks degraded. Issues go through `redact`. |
| `md-sync status` | `--json` is `--format json` (`--json --format text` is a usage error). JSON adds `health`, `ntfy` (record, `{"state":"unknown"}`, or `"off"`) and `fallbackMs` (effective config). `lastOkAt`, `nextRetryAt` and `stuck` are now always present, `null` when absent (they used to be left out), so the shape is fixed. Text adds `health:` and `ntfy:` lines. For an unreadable folder, the config comes from the instance and CLI layers plus the repo layer the state file last recorded. |
| README | Command table, status example, the JSON shape, the health rules and the state-file `ntfy` record. |

## Decisions and things learned

- `lastDisconnectedAt` and `since` move only when a **live** stream drops. A failed attempt while already disconnected updates only `lastError`, so `since` keeps meaning "down since".
- `reconnects` counts connects after this daemon's first one, including after a reload that changed `ntfyUrl`.
- `lastEventAt`/`lastEventSha` include echoes of this device's own pushes: they are push notifications too, and they prove the topic delivers.
- The trailing `lastMessageAt` is not flushed by a timer: with ntfy's 45 s keepalive, the on-disk value lags by at most about 105 s, and any other state write carries the current value.
- Not changed: `instance.cli` in the state file still holds an `--ntfy-url` given on the command line (it predates this change, and `status` never prints `instance`). Worth revisiting if other apps read the raw file.
- A one-off run holding the lock reports `daemon: stopped`, so `health` says `failing (daemon not running)` during it; that matches the daemon status it already printed.

## Tests

- `test/unit/ntfy-client.test.ts`: `onData` per chunk, `onDisconnect` with a redacted error, nothing after `stop()`.
- `test/unit/ntfy-health.test.ts` (new): reducer transitions, reconnect counting, error redaction, the write throttle.
- `test/unit/state.test.ts`: round trip with `ntfy`; malformed records dropped.
- `test/unit/health.test.ts` (new): every failing and degraded rule, precedence, redaction, and the `ntfy:` text line.
- `test/unit/cli.test.ts`: `--json` parsing.
- `test/integration/cli.test.ts`: the fixed JSON shape, `ntfy: "off"`/`{"state":"unknown"}`/recorded, the text lines, no topic in output.
- `test/acceptance/32-chaos.test.ts`: its `status --json` check read an absent `stuck` as "not stuck"; it now checks for `null`. The full run caught this (seed 7 reported `stuck null` on all three devices), which is the same break any consumer that tested `stuck !== undefined` would see.
- `test/acceptance/24-ntfy-reconnect.test.ts`: after a drop, reconnect and event, the state file's record and `status --json` match, and neither holds the topic.
