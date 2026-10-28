# NOTES — test-http-server-keepalive-req-gc regression (bisect + fix)

## Regression statement

`test-http-server-keepalive-req-gc` passed in the full sweep of 2026-10-20
(base main `da9859b6`) but hangs (exit 124) in the full re-sweep of
2026-10-28 (base main `1d8bc7b4`, PR #254) and still hung on main
`9c8a0c41` (verified 3/3 hangs before the fix).

## Bisect (repeat runs, PARITY_TARGET=http, timeout 30)

| Base | Result |
|---|---|
| `da9859b6` (Oct 20 sweep base) | 3/3 pass (exit 0) |
| `9c8a0c41` (pre-fix main) | 3/3 hang (exit 124) |
| `3e509abb` (PR #250) | hang |
| `236ad990` (PR #245) | pass |
| `210390fd` (PR #246) | hang |

**Regressor: PR #246** — "ignore empty lines before the start line (llhttp
behavior)". Its only `src/` change is `HTTPParser._parseStartLine`: skip
leading empty lines in a loop, plus the eager partial-remainder judgment.
Docs PRs in the window (#243, #247–#249, #251, #253) touch no `src/` code.

## What the test actually requires

The test sends one keep-alive POST whose body is followed by a trailing
CRLF (`"hello world\r\n"` — the joined request array ends with an empty
string). It then ends the client, forces two major GCs, and passes only if
the finished `req` object is collected: `onGC(req)` fires `server.close()`,
which lets the process exit. A hang therefore means **req is never
collected**, not that the server fails to close.

## Mechanism (probed, not theorized)

Old code (#245) vs new code (#246+) stage traces differ in one place:

- Old: `handler → server-socket-close → req-end → … → gc-fired →
  server-closed → exit 0`. The trailing CRLF hit the old start-line parser
  as an empty "start line", tripped a parse error, and the error path
  destroyed the server socket. `Socket._destroy` nulls the peer link both
  ways (when it did not already send FIN), breaking the retention chain.
- New: `handler → req-end → client-end → server-socket-end →
  server-socket-close → gc-calls-done → (no gc-fired) → hang`. The parser
  now correctly consumes the trailing CRLF and waits for the next request.
  The socket then closes cleanly via FIN — and a graceful FIN deliberately
  does NOT null the `_peer` link (`src/net.js`: the peer stays alive to
  receive writes), so this chain survives socket close:

  test-scope `client` → client socket → `_peer` → server socket →
  `socket._httpState` → `state.parser` → `parser.onBody` /
  `parser.onMessageComplete` closures → dispatched `{ req, res }` → `req`.

  The client socket itself never emits `close` here (its FIN arrives while
  paused and unread — matching real Node's paused-stream behavior, not a
  defect for this test), so nothing ever tears the chain down.

Two probe artifacts that misled before the chain was isolated:

- A first probe that kept the server socket in a module-scope variable
  "proved" retention after nulling `client` — the probe itself was the
  holder. A second probe's async-frame local (`state`) did the same. The
  WeakRef survey (probe v4, no strong refs retained past the handler)
  showed every object collected and `gcFired=true` once the test-side
  references were dropped — confirming the chain above rather than any
  server-side set or timer (the http `_connections` set is empty after
  close; the #254 connection-checker timer is unref'd and iterates only
  `_connections`).

## Fix (src/http.js, server socket `close` handler)

Release the real parser's request-capturing callbacks at socket close and
drop `state.parser`:

```js
parser.onBody = null;
parser.onMessageComplete = null;
parser.onHeadersComplete = null;
parser.onMessageStart = null;
parser.onError = null;
state.parser = null;
```

Placed after the existing parser-facade `free()` block in
`_onSocketConnection`'s `close` handler. Safe because a closed socket is
never parsed again (the `close` handler already nulls `state.current` and
the `socket.parser` facade the same way). This does not touch `net.js`
peer-link lifecycle, client write paths, or stream behavior — the client
socket's non-`close` after a paused FIN is real-Node behavior, not part of
this regression.

## Verification

- Target test on this branch: 3/3 pass (exit 0), was 3/3 hang on base.
- Guard suite: 66 tests (server family, keep-alive family, agent family,
  chunked, blank-header, pipelined, content-length, pipeline) run on this
  branch; every non-zero result differentially re-run on pristine main
  `9c8a0c41` — see the PR body for the table. No new failures.
- Repo tests: `tests/ondemand-require.test.js` 29/29 (footprint allowlist
  set to this branch's file set).
