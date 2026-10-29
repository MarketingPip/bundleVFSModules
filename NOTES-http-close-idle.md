# NOTES: test-http-server-close-idle (fix/http-close-idle)

## Target

`test-http-server-close-idle` failed with exit 1 on merged main `54fa5b5b`
(and on pristine base alike); `test-http-server-close-idle-wait-response`
passes and is a guard.

## Diagnosis — two stacked defects, both in `src/http.js`

### 1. Response header order: auto Date was rendered before app headers

The test asserts the response starts with
`HTTP/1.1 200 OK\r\nConnection: keep-alive`. The shim rendered
`HTTP/1.1 200 OK\r\nDate: ...\r\nConnection: keep-alive\r\n...` because
`OutgoingMessage._storeHeader` prepended the auto Date header ahead of the
app-header lines.

Probed on real Node v24.22.1, the rule is: **app headers first, in
insertion order, then auto headers** (Date, then Connection, Keep-Alive,
Content-Length, Transfer-Encoding). Evidence: writeHead Connection-only →
`Connection, Date, TE`; X-Custom + Connection → `X-Custom, Connection,
Date, TE`; setHeader Connection-then-X-A → `Connection, X-A, Date, CL`;
no app headers → `Date, Connection: keep-alive, Keep-Alive, CL`;
app Date + Connection → `Date(app), Connection, TE`.

Fix: in `_storeHeader`, emit the app-header lines first, then the auto
Date, then the existing auto Connection/Keep-Alive block. TE stays last
(`_streamingHeader` appends it at the end; `_finishSocketResponse` uses
`_header` verbatim and appends implicit Content-Length at the end, which
matches real Node's auto order).

### 2. server.close() destroyed a connection with a partial request

After fixing the order, the test failed later: the 500 ms check's mustCall
never ran because... (see below) — the probe showed `server.close()`
closed BOTH clients, while real Node keeps the never-finished one open.

Root cause: `ServerBase.close()` / `closeIdleConnections()` treated a
socket as idle whenever `!state.busy`. A connection that sent a partial
start line (`GET / HTTP/1.1`, no CRLF) never dispatches, so `busy` is
false — but the parser already fired `onMessageStart` on the first bytes
(`src/_http_parser.js`: a message starts the moment its first bytes are
consumed, partial start line included), so `state.receiving` is true.

Probed on real Node v24.22.1:

- zero-byte connection: NOT closed by `close()` (surprising, but
  consistent across probes; the shim still destroys fresh sockets —
  pre-existing divergence, untested by any official test, left alone
  deliberately to avoid changing loop-drain behavior other tests may
  rely on).
- partial start line / partial headers: NOT closed by `close()` nor by
  `closeIdleConnections()`.
- idle after a completed response: closed by both.
- complete request, response pending at `close()` time: response is
  delivered, socket stays open afterwards (even 1000 ms later).
- partial request completed AFTER `close()`: response is delivered,
  socket stays open afterwards.

Fix: the idle predicate in both `close()` and `closeIdleConnections()`
is now `!state || (!state.busy && !state.receiving)`. A receiving-but-
not-busy socket survives with NO `serverClosing` flag — matching the
probed late-response behavior (it keeps keep-alive like normal), unlike
a busy socket, which keeps the existing `serverClosing = true` path
(guarded by test-http-outgoing-drain-writable-length).

## Verification

- `test-http-server-close-idle` 1 → 0; `test-http-server-close-idle-
  wait-response` stays 0.
- Full 397-test differential, branch vs pristine base `54fa5b5b`
  (CSVs: `http-sweep-closeidle-branch.csv` / `http-sweep-closeidle-base.csv`
  in the parity-sweep goal hidden_files): base 218 pass / 68 timeout /
  111 fail → branch 220 / 68 / 109. Four lines differ: target 1→0,
  `test-http-server-close-all` 1→0, `test-http-write-head-after-set-header`
  124→0 (both bonuses from the header-order fix: close-all asserts the
  same `Connection: keep-alive`-first response start; write-head-after-
  set-header asserts `rawHeaders[0..4]` are the writeHead array headers,
  which the prepended Date pushed out of position — on base the throw
  stuck its countdown and hung), and one REGRESSION found by the sweep:
  `test-http-double-content-length` 0→124, diagnosed and fixed in-lane
  (see below). Crash codes 134/139 identical.
- Guard battery 40/40 (close-idle family, #286 flip, #284 outgoing
  family, #283 upgrade family, CONNECT, keep-alive, multiheaders,
  multiple-headers, host-headers, set-trailers, proxy, server,
  blank-header, chunked, keepalive-req-gc, delete-parser,
  drop-connections-in-cluster, client-error family).
- Repo jest: 3059 passed / 7 failed / 1 skipped — exactly the known host
  version-skew baseline. Ondemand 29/29; `build-vfs` exit 0; `dist/`
  restored, never committed.

## In-lane regression: double-content-length (found by the sweep, fixed)

The sweep showed `test-http-double-content-length` 0→124. Mechanism
(traced with socket-event logging on both trees):

- The shim's parser reports duplicate conflicting Content-Length as
  `HPE_INVALID_CONTENT_LENGTH`, but the test asserts
  `HPE_UNEXPECTED_CONTENT_LENGTH` (a pre-existing shim code gap, noted
  by the #277 lane — NOT fixed here).
- The assertion throws inside the `clientError` handler, so the
  handler's `socket.destroy()` line never runs. The throw is swallowed
  by the delivery layer, but the client still sees an error either way
  (`REQ error` fires on both trees).
- The test's req-error handler calls `server.close()`. On base, close()
  destroyed the errored socket (`busy` false) and the loop drained.
  With the new predicate, the errored socket still had
  `receiving === true` (the message started but never completed, and
  nothing cleared it on error), so close() spared it and the loop never
  drained → 124.

Fix (one line, `parser.onError` head): `state.receiving = false` — the
message is dead, so a later close must not mistake the socket for one
still receiving a request. Busy sockets are unaffected (still spared
via `state.busy`). This restores base behavior exactly for errored
sockets: double-content-length returns to 0, and the clientError family
(multiple-client-error, destroy-socket-on-client-error, client-error),
blank-header, invalid-te, missing-header-separator-lf, both reject
tests, and all 15 timeout-variant tests match base exactly (the three
bare `test-http-server-*-timeout` names do not exist; the real files
are the `-delayed-*` / `-pipelining` / `-keepalive` variants).

Note on scope: the swept tree predates this one-line follow-up; the
follow-up was verified by the targeted re-runs above (error-adjacent
families + target + bonuses + guards), not a second full sweep.

## Deliberately left alone

- Fresh (zero-byte) connections are still destroyed by shim `close()`,
  while real Node keeps them. No official test covers it; changing it
  risks loop-drain regressions in tests that connect without sending.
- `closed` is `true` immediately after `destroy()` on the shim; real
  Node reports `false` until `'close'` (pre-existing ported-stream
  timing, noted by the #286 lane).
- Server `req.destroy()` with unread pipelined data: real Node sends
  RST; the shim's graceful destroy sends FIN (noted by the #286 lane).
- `'aborted'` is set but not emitted on server req destroy (noted by
  the #286 lane).
