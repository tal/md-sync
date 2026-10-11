# ntfy only counts a real event stream as connected; a network change retries at once

Two changes to how mdsync recovers from a bad network. Docs first, then code and tests (`docs/ARCHITECTURE.md` §2, §3, §4.27 step 3, new §4.32, §9.1, §9.2, §10.1, §10.4, §10.5, §15, §17, §18, §19, §20 D17/D55/D56; `SPEC.md`; `AGENTS.md`).

## 1. ntfy: a 200 that is not `text/event-stream` is a failure, not a connect

| Wrong assumption | What actually happened | Fix |
|---|---|---|
| Any 2xx with a body is the subscription. | ntfy.sh answers `GET https://ntfy.sh/sse` (an `ntfyUrl` with no topic) and `GET /bad.topic!/sse` (an invalid topic) with its **web app**: identical 4485-byte `200 text/html` bodies (captured read-only on 2026-10-09, `test/fixtures/ntfy/ntfy-sh-no-topic-web-app`). Captive portals answer 200 HTML, and proxies or catch-all routes an empty 200. Each retry logged `ntfy connected`, fired `onConnect` and queued a catch-up sync that could not reach anything either, and nothing said the URL was wrong. | `connectOnce` reads the media type (`content-type` up to the first `;`, trimmed, lowercased). Anything but `text/event-stream` cancels the body and returns a failure on the normal backoff, with no `ntfy connected` and no `onConnect`. |
| The `empty response body` branch catches an empty 200. | Bun's `fetch` gives an empty 200 a non-null body, so that branch never ran (the fixture `proxy-200-empty-body` had pinned this as a gap). | The content-type check catches it: no `content-type` → `no content type`. |

- New error text (logged as `ntfy disconnected` `{error, retryInMs}`): `not an event stream (<media type>): check that ntfyUrl names a topic`. The media type is cut to 100 chars; with no header it reads `no content type`. It comes from the header only, never from the URL.
- `text/event-stream; charset=utf-8` (what ntfy.sh sends) is accepted, in any case and with spaces.
- Fixtures: `captive-portal-login-page`, `ntfy-sh-no-topic-web-app` and `proxy-200-empty-body` now expect 0 connects and the new error, and their `gap` fields are gone. `huge-single-line` was a 78 KB `text/html` line, which the content-type check would now refuse before reading; its stub now sends `text/event-stream` and a `data:` line, so it still covers `SSE line too long` through real `fetch` (1 connect, normal retry, no gap). The fixture README says an SSE case must send `content-type: text/event-stream`.
- `ntfy-client.test.ts`'s stub responses now send `content-type: text/event-stream` (the harness's `fakeNtfy` already did). New tests: a 200 `text/html`, a 200 with no content type and an over-long media type are failures with the backoff growing; `Text/Event-Stream ; charset=utf-8` connects.

## 2. A network change cuts the backoff short (D55)

Before: after a network failure a sync waited out the network backoff (30 s doubling to 10 min) and ntfy its own (1 s doubling to 5 min), even when the laptop rejoined Wi-Fi seconds later.

- New module `src/netwatch.ts`: `NetworkWatcher` polls `os.networkInterfaces()` every 5 s. A snapshot is one `<iface>|<address>` per address that is neither internal nor link-local (169.254.0.0/16, fe80::/10).
  - A changed snapshot must be seen on two ticks in a row before it counts. Then it becomes the base, and `onChange({added, removed})` fires only if it added an address. A removal alone (the network went down) updates the base silently, so the same address coming back later still fires.
  - A `read` that throws is no change for that tick: no log, no state change.
  - No native event source (`notifyutil`, `scutil`, `ip monitor`, netlink, ffi): containers lack the tools, and the call is cheap.
- Daemon: started and stopped next to the `WakeDetector`. On a change while running: log `network changed` `{added, removed}` (info; counts only, never an address or interface name), `ntfy.reconnectNow()`, and a pull-only run with the new reason `network`.
- The pending retry is left alone. Checked in `#scheduleRetry`/`#onRunEnd`: a `network` run that ends ok clears the retry and resets the step like any sync; one that fails keeps the pending retry as it is, because only a run whose reasons include `retry` advances the step.
- Test hook `MDSYNC_TEST_NETWORK_FILE=<path>` (D56): the watcher reads a JSON array of strings from that file every 200 ms. Harness helper `fakeNetwork(t, entries)` writes it atomically and returns the env.
- Tests: `test/unit/netwatch.test.ts` (12 cases) and `test/acceptance/35-network-reconnect.test.ts`. In the acceptance test a flush fails with the remote away (retry due in 30 s); dropping the address logs nothing; restoring the remote and the same address gives `network changed {added: 1, removed: 0}`, a `network` run that pushes, and an ntfy reconnect, all about 2 s later.

### D55 limits

- A drop shorter than about one tick (5 s) is not seen; nothing fires and the old backoff applies.
- A new IPv6 temporary address (macOS rotates them about daily), a VPN connecting or a Docker bridge coming up counts as a change. Each costs one ntfy reconnect and one pull.
- Containers rarely see a change: their interfaces stay up while the host's network comes and goes, so they still wait out the backoff.
- The first-clone retry loop at startup (§10.1 step 6) is not covered: the watcher starts with the other services, after the clone.

## What was learned

- On this Mac, `os.networkInterfaces()` lists 9 interfaces with 15 addresses: 3 internal, 8 link-local (one each on `utun0`–`utun4`, `awdl0`, `llw0` and `en0`; for six of those interfaces it is their only address), and 4 that matter (IPv4 and IPv6 on `en0` and on the tunnel `utun4`). Without the link-local filter, AirDrop and VPN churn would trigger syncs. The call takes about 26 µs (Bun 1.4.2), so polling every 5 s is free.
- Two other fixture cases were failing for an unrelated reason: `connection-refused` and `message-cut-mid-json-then-reset` expected the error without the `TypeError: ` prefix that `errorText` (`NAMED_ERRORS` in `src/log.ts`) now adds. They were recorded before that change. Their expected `error` strings now carry the prefix (after flagging it to the lead), so the whole fixture suite passes again.
