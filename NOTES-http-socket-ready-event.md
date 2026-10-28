# NOTES — Socket `'ready'` event (net.js)

## Real-Node behavior probed (Node v24.22.1, plain node, no shim)

- Client socket: `'connect'` fires first, then `'ready'`, exactly once.
  At both events: `readyState === 'open'`, `pending === false`,
  `connecting === false`.
- A `'ready'` listener registered *inside* the `'connect'` handler still
  fires (so emitting `'ready'` synchronously right after `'connect'`
  matches the observable order).
- Refused connections and never-connected sockets never fire `'ready'`.
- Server-side accepted sockets do not observably emit `'ready'` after the
  `'connection'` handler runs (a listener registered in that handler never
  fires before data or close), so only the client side gets the emission.

## Root cause in plain terms

The shim's loopback pairing (`Server.prototype._acceptConnection` in
`src/net.js`) emitted `'connect'` on the client socket but never `'ready'`.
Any test that waits on `socket.on('ready')` before writing — e.g. the two
pipelined-POST keep-alive tests — waited forever (exit 124).

## Fix

One line in `src/net.js` (`_acceptConnection`): `client.emit("ready")`
immediately after `client.emit("connect")`. No other file changed. The
emission point is the single pairing path, so it fires exactly once per
successful loopback connection and never for refused/unconnected sockets.

## Results (PARITY_TARGET=http)

| Test | Before (base 4f8e6431) | After |
|---|---|---|
| test-http-server-keep-alive-max-requests-null | 124 | 0 |
| test-http-server-keep-alive-defaults | 124 | 124 (see follow-up) |

## Known follow-up (NOT in this PR — separate root cause, separate PR)

`test-http-server-keep-alive-defaults` still hangs after this fix, for a
different reason: its `assertResponse` requires `Connection: keep-alive`
and `Keep-Alive: timeout=5` in every response, but the shim's
`ServerResponse` framing sends neither (verified: headers are only
`Date`/`Content-Type`/`Transfer-Encoding: chunked`). The assertion throws
inside the socket `'data'` handler, `socket.end()` never runs, and the
process never exits. Real-Node rule probed (v24.22.1, default server):
HTTP/1.1 responses carry `Connection: keep-alive` +
`Keep-Alive: timeout=5` (keepAliveTimeout 5000 ms → 5 s), whether or not
the request asked keep-alive; HTTP/1.0 responses carry
`Connection: close` in this shape. The follow-up is response-framing work
in `src/http.js` (emit those headers when the connection will be kept
alive, `Connection: close` when it will not) — it touches every response,
so it needs its own guard sweep and must not ride along with this
one-line net.js fix.
