# ntfy failure fixtures

Real-world responses an ntfy subscription can get, replayed against `startNtfy` (`src/ntfy.ts`) by `test/unit/ntfy-fixtures.test.ts`. Each case folder holds a response script and the behavior expected from it. The cases pin **current** behavior. When that behavior looks wrong, the case says so in `gap` and the test still expects what the code does today.

## How a case runs

- The test finds every folder here and creates one `test()` per folder, named after it. A malformed `case.json`, a missing body file or an unused file in the folder fails that test with the file and key named.
- A real `Bun.serve` on `127.0.0.1:0` plays `response`. `startNtfy` subscribes with real `fetch`, and its watchdog and backoff timers run on a manual clock, so nothing waits 120 s in real time.
- The client-side `fetch` passes the body through an observer that records where each read ended. The server sends chunk *k+1* only after the client has read and processed chunks *0..k*. Chunk boundaries therefore reach the client exactly as scripted, including splits inside a UTF-8 sequence, and the test asserts that they did.
- A case drives one attempt per entry in `expect.disconnects`. Between attempts, the clock advances by the logged `retryInMs`, and the server plays the same response again.
- Every case also checks:
  - every request went to `<url path>/sse` with the query kept;
  - the topic and the query (self-hosted ntfy's `?auth=`) never appear in any log line;
  - `onConnect` reported `first`, then `reconnect`;
  - no callback failed;
  - `stop()` left no timer on the clock.

## case.json

```jsonc
{
  "note": "one sentence: the real-world situation",
  "source": "captured: <host> <YYYY-MM-DD> …" | "synthesized: <what it is based on>",
  "gap": "optional: one sentence on behavior that looks wrong",
  "url": "/{topic}",            // optional, default "/{topic}"; path (+ query) after the stub's origin, {topic} = a random topic
  "response": {
    "status": 401,
    "headers": { "content-type": "application/json" },   // not content-length, transfer-encoding, connection or date
    "chunks": ["text", { "repeat": "x", "times": 70000 }], // inline UTF-8 chunks, one write each, or …
    "bodyFile": "body.json",    // … raw bytes from this folder (byte-exact; .gitattributes keeps them -text)
    "splitAt": [12, 57],        // optional with bodyFile: byte offsets where chunks split (may fall inside a UTF-8 character)
    "end": "close"              // close | hang (send nothing more, keep the socket) | reset (drop the socket mid-body)
  },
  // or { "end": "no-headers" }   accept the request, never send a status line
  // or { "network": "refused" }  point the client at a closed port
  "expect": {
    "connects": 1,              // onConnect calls over all attempts
    "shas": [],                 // onSha calls, in order
    "ignored": ["not-message"], // reasons of the `ntfy message ignored` debug lines, in order
    "advanceMs": 120000,        // only when an attempt stays open after its script (hang, no-headers): advance the clock
                                // this much; the test checks nothing fired 1 ms earlier
    "disconnects": [            // one `ntfy disconnected` line per attempt (1 to 5)
      { "level": "warn", "error": "HTTP 401", "retryInMs": 1000 }
    ]
  }
}
```

A body of one chunk that ends with `close` goes out with `Content-Length`, as most error pages do. Every other body streams with chunked encoding, like ntfy's SSE. `hang` and `reset` need at least one chunk, because Bun.serve sends no headers before the first one. `reset` stops the server, so it allows one attempt only.

A 200 counts as connected only when its `content-type` is `text/event-stream` (parameters such as `; charset=utf-8` allowed). A case that streams SSE must send that header, as ntfy does.

## Cases

| case | source | what it pins |
|---|---|---|
| `ntfy-sh-open-then-restart` | captured | the real `open` event, then a close (ntfy restart), twice; each connect fires `onConnect` and the failure count grows |
| `ntfy-sh-keepalive-then-silence` | captured | the real `open` and `keepalive`, then a dead link; the 120 s watchdog ends it |
| `ntfy-sh-subscription-url-pasted` | captured | the `/sse` URL pasted as ntfyUrl → `/sse/sse` → ntfy's 404 JSON; **gap** |
| `ntfy-sh-invalid-since` | captured | a stray `?since=` → ntfy's 400 JSON; **gap** |
| `ntfy-sh-no-topic-web-app` | captured | no topic → ntfy.sh's web app as 200 text/html; not an event stream, so never connected, and the error says to check that ntfyUrl names a topic |
| `self-hosted-401-no-token` | synthesized | auth required, no token; **gap** |
| `self-hosted-403-token-without-read` | synthesized | token without read access; the `?auth=` query is never logged; **gap** |
| `ntfy-sh-429-rate-limited` | synthesized | 429 with `Retry-After: 120`; **gap** |
| `nginx-502-bad-gateway` | synthesized | nginx's built-in 502 page (CRLF) |
| `cloudflare-503-html` | synthesized | a Cloudflare-style 503 page |
| `captive-portal-login-page` | synthesized | hotel Wi-Fi answers 200 text/html; not an event stream, never connected, normal backoff |
| `proxy-200-empty-body` | synthesized | 200 with `Content-Length: 0` and no content type; never connected (`no content type`) |
| `message-cut-mid-json-then-reset` | synthesized | a message cut before its closing brace, then ECONNRESET; no sha is delivered |
| `shared-topic-foreign-messages` | synthesized | title, tags, priority, click, attachment, actions and markdown messages are ignored; the sha after them is delivered |
| `emoji-split-mid-utf8` | synthesized | splits 1, 2 and 3 bytes into multi-byte characters; the sha is still delivered |
| `connection-refused` | synthesized | a closed port |
| `huge-single-line` | synthesized | an event stream whose one 78 KB `data:` line never ends → `SSE line too long`, reconnect on the normal backoff |
| `no-headers-accept-then-silence` | synthesized | accepted, never answered; the watchdog covers the wait for headers |

### Where the captured bytes came from

On 2026-10-09, read-only `curl -sN --max-time …` GETs went to `https://ntfy.sh` for a fresh random topic (`mdsync-fixture-<16 hex>`). Nothing was published. The bytes were recorded as received.

| request | used in |
|---|---|
| `GET /<topic>/sse` (HTTP/2 and HTTP/1.1, 58 s) | `open` event; `open`, then `keepalive` 45 s later |
| `GET /<topic>/sse?since=garbage` | 400 `{"code":40008,…}` |
| `GET /<topic>/sse/sse`, `/<topic>/json/sse`, `/<70 × a>/sse` | 404 `{"code":40401,…}`, identical for all three |
| `GET /sse`, `GET /bad.topic!/sse` | 200 text/html, the ntfy web app, identical 4485-byte bodies |

Headers that Bun sets itself (`content-length`, `transfer-encoding`, `connection`, `date`) were dropped. The rest are kept as captured.

The synthesized cases were built from ntfy's documented formats, not recorded. Their sources:

- **Error bodies:** ntfy's JSON error shape (`{"code":40101,"http":401,"error":"unauthorized","link":"…"}` plus Go's trailing `\n`), matching the captured 400 and 404.
- **Message events:** ntfy's message JSON (`id`, `time`, `expires`, `event`, `topic`, then `title`, `message`, `priority`, `tags`, `click`, `actions`, `attachment` and `content_type`), framed as `data: <json>\n\n` with no `event:` line, as ntfy sends message events.
- **Proxy and portal pages:** modeled on nginx's and Cloudflare's stock error pages and a typical captive portal.

## Adding a case

1. Make `test/fixtures/ntfy/<lowercase-kebab-case>/case.json`. Add `body.<ext>` if the body is not short text.
2. To capture, use read-only GETs only (`curl -sN --max-time 10 -D headers.txt -o body.ext <url>`). Never publish to a public server. Keep the body bytes untouched. Copy the headers that matter, minus the four Bun sets.
3. For a split inside a character, compute `splitAt` from the body's bytes, not from its characters.
4. Run `bun test test/unit/ntfy-fixtures.test.ts`. Write down what the code does today. If that looks wrong, add `gap` rather than changing `src/`.
