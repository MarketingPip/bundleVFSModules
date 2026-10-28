# NOTES — HTTP CONNECT dispatch (server 'connect' + client 'connect')

## Real-Node behavior probed (Node v24.22.1, before implementing)

Server side (raw `net` client):
- A CONNECT request emits `'connect'` with `(req, socket, head)`; `req.method`
  is `CONNECT`, `req.url` is the authority (`example.com:80`); `head` is the
  bytes after the header block in the same packet (pipelined bytes).
- `'request'` NEVER fires for CONNECT, with or without a `'connect'`
  listener. With no `'connect'` listener the socket is destroyed silently
  (no response bytes, no `clientError`).
- Re-emitting `'connection'` on the server with the same socket is harmless
  (no second dispatch, no assertion) — the test's `StreamBase::Consume`
  regression shape.
- `server.close()` is what drains the loop in the test: without it the
  listening handle keeps the process alive; with it, plus both sockets
  closing, the process exits.

Client side (`http.request({ method: 'CONNECT' })`, raw `net` server):
- EVERY first response status is delivered via the request's `'connect'`
  event, never `'response'`: probed 100, 200, 201, 404, 407, 500 — all
  `'connect'`, and a 100 does not produce a second `'connect'` for a
  following 200 (the parser detaches at the first response).
- `head` is the bytes after the response headers (`"TUNNEL-BYTES"` /
  `"Head"` in the probes).
- With NO `'connect'` listener the client socket is destroyed after the
  response (observed: client socket `close` fires in all no-listener
  variants; with a listener it stays open as the app's tunnel).
- Probe trap (twice): a `setTimeout` watchdog in the probe itself keeps
  the loop alive until it fires, so "TIMEOUT" from the watchdog is not
  evidence of a hang — read socket `close` events, not the watchdog exit.
  A second trap: attaching a socket `'data'` listener AFTER a synchronous
  `socket.write(200)` misses tunnel bytes the write already delivered —
  the shim's virtual sockets deliver synchronously, so listeners must be
  attached before the write. Neither trap is a shim defect.

## Root cause (two stacked gaps)

1. Server dispatch (`_dispatchSocketRequest`) emitted `'request'` for every
   method except upgrade, so CONNECT hit the test's `mustNotCall` and the
   exchange stalled with no response.
2. Client round trip (`_socketHttpRoundTrip` + `_performVirtualRequest`)
   treated a CONNECT response as a normal response: it emitted `'response'`
   at headers and then awaited body completion — but a 200 has no length
   framing, so it waited for EOF forever and the sockets never closed.

## Fix (`src/http.js` only)

- Server: CONNECT routes to `'connect'` (sibling of the upgrade block),
  with `takeRemainder()` head bytes; no `'connect'` listener destroys the
  socket; nothing counted `inFlight`. A distinct `state.connect` flag
  (NOT `state.upgraded`): the timeout checker is already inert for it
  (not receiving, never idle-after-response), and the socket `'end'`
  handler closes a CONNECT tunnel on peer FIN — deferred one microtask so
  the app's own `'end'` listeners (attached after the HTTP handler) can
  still write farewell bytes first (`test-http-connect-req-res` echoes on
  `'end'`; a synchronous end dropped the echo).
- Client: `_socketHttpRoundTrip` settles at headers for CONNECT (any
  status) with `isConnect` + `connectHead`, never waiting for EOF, and
  detaches its data listener so later tunnel bytes flow only to the app.
  `_performVirtualRequest` then emits `'connect'` (never `'response'`,
  never released to the agent pool), destroys the socket when no
  `'connect'` listener exists, and wires socket `'close'` → request
  destroy so `req` emits `'close'` with `destroyed === true`.

## Results (PARITY_TARGET=http, timeout 30; base main 20eed2ac)

- `test-http-server-unconsume-consume`: 124 → 0 (target flip).
- `test-http-connect-req-res`: 124 → 0 (bonus flip — same CONNECT
  machinery; it hung on pristine main and now passes fully, including
  the `firstBodyChunk === "Head"` and echo assertions).
- No regressions: 16/16 named guards green (server, server-options,
  consumed-timeout, connection-list-when-close, keep-alive-max-requests-
  null, de-chunked-trailer, request-timeout-upgrade, keep-alive-hint,
  agent-keep-alive-timeout-buffer, plus the second guard sweep below).
- Pre-existing failures reproduced identically on pristine main
  (scratch worktree at 20eed2ac): `test-http-connect` 124,
  `test-http-upgrade-client` 1, `test-http-upgrade-agent` 1,
  `test-http-keep-alive-timeout` 124.

## Deliberately out of scope

- `test-http-connect` (124 both sides) is a different gap (not the
  dispatch/connect-event shape) — left for its own lane.
- CONNECT over the `fetch()` path (non-virtual): browsers forbid the
  CONNECT method in fetch; the virtual loopback path is what the tests
  exercise.
- A CONNECT response carrying a `Content-Length` body: same-packet body
  bytes land in `head` (upgrade convention); later bytes arrive as
  socket `'data'`. No test covers this; the behavior matches the tunnel
  contract.
