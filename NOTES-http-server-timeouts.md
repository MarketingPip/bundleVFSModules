# NOTES — HTTP server timeout machinery (headersTimeout / requestTimeout / keepAliveTimeout)

## What was missing (plain terms)

The HTTP server already *stored* the timeout options (`headersTimeout`,
`requestTimeout`, `keepAliveTimeout`, `connectionsCheckingInterval` — with
Node's defaults 60000 / 300000 / 5000 / 30000) but never *enforced* them: no
checking loop, no 408 response, no socket-timeout wiring, and no server-side
upgrade dispatch. So every test in the `*-headers-timeout-*` /
`*-request-timeout-*` families hung or failed, and `server.setTimeout`
never fired.

## Real-Node behavior probed (Node v24.22.1, before implementing)

1. **408 bytes, exact:** `HTTP/1.1 408 Request Timeout\r\nConnection:
   close\r\n\r\n`, then close. The server `timeout` event does NOT fire for
   headers/request timeouts (official tests assert `mustNotCall`).
2. **headersTimeout** is per-request, headers phase only, deadline = the
   request's first byte + headersTimeout.
3. **requestTimeout** is per-request, headers + body (until fully received),
   deadline = the request's first byte + requestTimeout. Probed: headers
   complete at +1500ms with requestTimeout 2000 still 408s at ~2000ms, not
   ~3500ms — the clock does NOT restart at headers-complete.
4. **Fresh silence:** a connection that sends nothing still gets a 408
   after headersTimeout/requestTimeout from *connection* time (probed: 408
   at ~2019ms for headersTimeout 2000, check interval 100).
5. **Enforcement granularity is polling**, not exact timers: the 408 lands
   on the first `connectionsCheckingInterval` tick AFTER the deadline
   (probed: +98ms with a 100ms interval; +265ms with a 250ms interval).
   That is why the official tests set `connectionsCheckingInterval` to
   timeout/4.
6. **Keep-alive gaps are exempt:** an idle gap of 1.5x the timeout between
   two requests on one connection must NOT 408 (official keepalive tests).
   The next request's clock starts at its own first byte.
7. **keepAliveTimeout closes idle sockets only after a response has
   finished** (fresh connections that never served a request are NOT
   closed — probed: a fresh idle socket survived 3s at keepAliveTimeout
   500 / check 100). The close carries no 408. Open question: one probe
   showed the post-response close landing ~3x keepAliveTimeout after
   response finish (1505ms at ka=500/check=100) for reasons not yet
   explained; no in-scope test asserts that latency, so the implementation
   uses straightforward polling (close at first tick after idle exceeds
   keepAliveTimeout).
8. **Upgrade disables the clocks:** after a successful upgrade,
   requestTimeout no longer applies (official upgrade test: bytes sent at
   2x requestTimeout still echo through `socket.pipe(socket)`).
9. **Invalid timeouts don't crash:** assigning a non-numeric
   `headersTimeout` must neither 408 nor throw (official
   invalid-headers-timeout-no-abort test; NaN comparisons are false).
10. **req.setTimeout is socket-inactivity based:** the callback AND the
    request's `timeout` event fire after the timeout of inactivity; flowing
    body data resets the timer (probed: 100ms writes, 500ms timeout, no
    fire while flowing, fire ~450ms after the stall).
11. **server.setTimeout is NOT retroactive** (probed: calling it after a
    connection + 200 produces no `timeout` event for that socket). It
    applies at connection time only, and the socket is NOT destroyed on
    `timeout` — the app decides.

## Changes

- **`src/_http_parser.js` (+33 lines):** `onMessageStart` callback — fires
  once when the parser starts consuming a new message's first bytes,
  including a partial start line with no CRLF yet (its clock must run
  while the client stalls mid-line), and including pipelined messages
  resumed after a pause. Between messages (paused/complete/error) nothing
  fires. `takeRemainder()` — returns bytes buffered past the current
  message (an upgrade request's `head`) and clears them so the abandoned
  parser can never re-parse them as a new message.
- **`src/http.js` (+182 lines):**
  - Per-socket timeout state in `_onSocketConnection`: `connectedAt`,
    `fresh`, `receiving`, `requestStart`, `headersDone`, `idleSince`,
    `upgraded`, `timedOut`.
  - `_startConnectionChecker` / `_stopConnectionChecker` /
    `_checkConnections` / `_timeoutSocket`: an unref'd interval at
    `connectionsCheckingInterval` (default 30000; non-finite/non-positive
    values fall back to 30000 so a bad value can't hot-loop), started
    lazily on first connection and stopped when the last connection
    closes or the server closes. Exactly one clock runs per socket:
    fresh → headers/request from connection time; receiving → headers
    (until headers complete) + request from first byte; idle after a
    response → keepAliveTimeout from response finish (silent destroy);
    responding (request in, response in flight) → no clock; upgraded →
    exempt. A 0 timeout disables its clock; a non-numeric value compares
    false and can neither fire nor crash. Each socket's check is wrapped
    so one bad socket can't kill the checker.
  - `server.setTimeout` wiring at connection time:
    `socket.setTimeout(this.timeout)` when positive, plus one `timeout`
    listener forwarding to the server (`timeout`, socket) and to the
    in-flight request (`timeout`). The listener is installed
    unconditionally so `req.setTimeout` (which arms the socket timer
    directly) also gets its callback/event through net.js's inactivity
    refresh.
  - Server-side upgrade dispatch in `_dispatchSocketRequest`: a request
    with an `Upgrade` header and `Connection:...upgrade...` emits
    `upgrade` (req, socket, head) instead of `request`, is not counted
    inFlight, and marks the socket upgraded. The socket `data`/`end`
    handlers early-return for upgraded sockets so post-upgrade bytes
    flow through the app's pipe instead of tripping the parser's
    clientError path.
  - `_finishSocketResponse` keep-alive branch records `idleSince`.
- **`src/net.js` (+15/−2 lines):** `_isTransportInactive` now also returns
  true when EOF was received AND there are no pending writes AND the peer
  link is null (peer destroyed). A graceful peer FIN does NOT null the
  link (only `_destroy` nulls it before notifying EOF) — so half-close
  drain (server still owes responses after a client FIN) keeps its loop
  keeper. This fixed the keep-alive-timeout exit hang: the test's logic
  completed but the process never exited because the two orphaned client
  sockets kept their ref'd 1-hour loop timers; the release rule now
  matches real Node (a half-open peer with a dead transport does not
  keep the loop alive).

## Results (PARITY_TARGET=http, timeout 60; before = main b1ea9920 baseline)

| Test | Before | After |
| --- | --- | --- |
| test-http-server-consumed-timeout | 124 (hang) | 124 (hang; see below) |
| test-http-server-headers-timeout-delayed-headers | 1 | 0 |
| test-http-server-headers-timeout-interrupted-headers | 1 | 0 |
| test-http-server-headers-timeout-keepalive | 1 | 0 |
| test-http-server-headers-timeout-pipelining | 1 | 0 |
| test-http-server-invalid-headers-timeout-no-abort | 0 | 0 |
| test-http-server-keep-alive-timeout | 124 (hang) | 0 |
| test-http-server-request-timeout-delayed-body | 1 | 0 |
| test-http-server-request-timeout-delayed-headers | 1 | 0 |
| test-http-server-request-timeout-interrupted-body | 1 | 0 |
| test-http-server-request-timeout-interrupted-headers | 1 | 0 |
| test-http-server-request-timeout-keepalive | 1 | 0 |
| test-http-server-request-timeout-pipelining | 1 | 0 |
| test-http-server-request-timeout-upgrade | 1 | 0 |

13 of 14 in-scope tests now pass (was 1 of 14).

## Remaining: consumed-timeout (NOT fixed here — client-side root cause)

The official test deadlocks on the *client* side, not the server side:

- **Proven:** a minimal POST + `req.write(".")` + `req.end()` after 500ms
  shows the server handler firing ONLY after `req.end()` — the shim's
  `ClientRequest` buffers ALL writes in `outputData` (`OutgoingMessage`
  `_write` pushes; `ClientRequest._performRequest` concats everything
  into one body and sends at end). Real Node streams headers + chunked
  frames as writes happen.
- The test writes `"."` (buffered, never sent) and waits for the response
  to start its interval writes; the server never sees the request;
  nothing ever happens → hang. Baseline also 124 — pre-existing.
- **The server side of this test DOES work now:** a raw-net-client probe
  (bypassing `http.request`) shows `req.setTimeout`'s callback AND the
  request's `timeout` event firing ~469ms after a stall with a 500ms
  timeout, and NOT firing while body data flows every 100ms.
- **Fix needed (separate PR, wider blast radius):** stream client writes
  (headers on first write, chunked framing per write, terminator at end)
  instead of buffering to end. That touches all client writes and could
  regress chunked framing, Content-Length, expect-100-continue, and
  agent pooling — it is NOT a small safe fix, so it is deliberately out
  of this PR.

## Guard tests

<!-- filled after the guard loop + differential vs pristine main -->

## Caveats / open questions

- `ServerResponse.setTimeout` still only registers a `timeout` listener
  on the response without arming the socket — no in-scope test exercises
  it; left as-is (smallest correct fix).
- The keepAliveTimeout ~3x latency observation (probed real Node, see
  finding 7) is recorded as an open question; no in-scope test asserts
  that latency.
- Worktree note: the first worktree for this task (`/tmp/http-server-
  timeouts`) was wiped by a runtime restart with its uncommitted work;
  the branch ref had no commits so nothing committed was lost, and the
  work was re-applied verbatim (diff identical: parser +33, http +182,
  net +15/−2) into the persistent worktree
  `~/workspace/worktrees/http-server-timeouts` on the new main tip
  b1ea9920 (PR #253, docs-only).
