# NOTES — http remove-header pair (server socket end() at response finish)

Targets (both exit 1 on base `3dc3d588`, exit 0 on this branch):
- `test-http-remove-header-stays-removed.js` — response removes
  `connection` / `transfer-encoding` / `content-length` / `date`, sets
  `date: coffee o clock`, ends `"beep boop\n"`. At res `'finish'` the
  test asserts `socket.writableEnded === true`; the client asserts
  `res.headers` deep-equals `{ date: "coffee o clock" }` (no
  Content-Length) and the body arrives.
- `test-http-remove-connection-header-persists-connection.js` — response
  removes `connection` only. HTTP/1.1 with a keep-alive agent must reuse
  the same socket for two requests; the HTTP/1.0 leg asserts
  `socket.writableEnded` at res `'finish'`.

## Root cause (Node source first, then probes)

Node `lib/_http_outgoing.js` `_storeHeader` computes `res._last`:
- `_removedConnection` → `_last = !shouldKeepAlive` (1.1 keeps alive,
  1.0 closes);
- no Content-Length and no Transfer-Encoding with a body →
  `_last = true` when chunked-by-default cannot frame it — in
  particular when BOTH were removed by the app (the code comment there
  cites `test-http-remove-header-stays-removed` by name);
- the Content-Length auto-add branch requires `!_removedContLen`.
Node `lib/_http_server.js` `resOnFinish` (1096, attached before any user
listener at 1237) then calls `socket.destroySoon()` when `res._last`
(`lib/net.js:1084`: `end()` if writable, destroy once `'finish'` fires),
so `writableEnded` is already true when user `'finish'` handlers run
and the socket is destroyed shortly after.

The shim diverged three ways (probed, base `3dc3d588`):
1. `_finishSocketResponse`'s buffered branch added an implicit
   `Content-Length: 10` even when the app removed it — the client saw
   `{ date, content-length: "10" }` instead of `{ date }`.
2. The keep-alive decision only required length framing for HTTP/1.0
   (`framingOk`); a 1.1 response with no CL/TE and a body was kept
   alive, so the socket was never ended at finish.
3. The close branch called `socket.destroy()` (synchronous, leaves
   `writableEnded === false`) instead of ending.

Real-Node probes (plain scripts, exit 0): at res `'finish'`,
`writableEnded=true, destroyed=false, writableFinished=false`; +10 ms
`destroyed=true`; client headers `{ date }` only; client socket
destroyed at `'end'`. Shim base probes (zz-rh-s1/s2, removed after use):
S1 client headers `{ date, content-length: "10" }`, finish
`writableEnded=false destroyed=false`, +10 ms `destroyed=true`
(via `server.close()`); S2 finish `writableEnded=false
destroyed=true`. Branch probes are byte-identical to real Node
(modulo the Date seconds).

## Fix (`src/http.js` `_finishSocketResponse` + `src/net.js`)

- `Socket.prototype.destroySoon` (`src/net.js`, port of `lib/net.js:1084`):
  `end()` if writable, destroy immediately if `writableFinished`,
  else `once('finish', () => destroy())`. Arrow closure instead of
  Node's bare `this.destroy` listener so the socket stays bound if a
  ported `once` calls listeners unbound.
  `ponytail:` ceiling — a socket whose `'finish'` never fires (already
  destroyed, or `end()` skipped because `!writable`) is never destroyed
  by this; callers needing a guaranteed close must `destroy()` directly.
  The server finish path relies on the peer FIN-ing back to release the
  loop keeper if `'finish'` stalls (see `_isTransportInactive`).
  Destroyed sockets return immediately, and the finish listener arms
  once: several last-responses can finish on the same socket (the
  pipelined buffer keeps dispatching after the first end), and a
  once-listener per response trips the MaxListeners warning
  (test-http-many-ended-pipelines — the handler destroys the socket per
  request and all 20 pipelined responses still finish). Real Node never
  calls destroySoon twice on one socket — its parser stops at the first
  end — so single arming matches Node's observable exactly.
- Implicit Content-Length: only added when `!res._removedContLen`, and
  recorded in `rendered["content-length"]` so the framing decision below
  sees the length framing that is actually on the wire.
- Framing rule: a response that carries a body (`_hasBody !== false`,
  method !== `HEAD`) needs length framing (CL, TE, or chunked) to keep
  the connection alive — for 1.1 as well as 1.0. Streaming responses
  default to chunked, explicit-`writeHead` bodies get chunked framing,
  and the buffered implicit-CL add covers the normal case, so only the
  genuinely unframed (both-removed) case now closes.
- Close branch: `socket.destroySoon()` (with `destroy()` fallback for
  sockets without the method, e.g. FakeSocket stand-ins). The
  peer-ended deferred-destroy branch is untouched (its parser-visibility
  ordering is deliberate) and the server-closing branch keeps
  `destroy()` (the server is going away).

## Loop-drain risk (investigated, not just noted)

`end()` alone would leave the virtual socket half-open (server sockets
have `allowHalfOpen: true`), but `destroySoon` destroys on socket
`'finish'`, which fires after `_final` delivers the FIN: branch probes
show `destroyed=true` at +10 ms, and the client socket is destroyed at
its `'end'`. If `'finish'` stalled, `_isTransportInactive` releases
the loop keeper once the peer FINs back (client sockets auto-end on EOF
— `allowHalfOpen: false`).

## Verification

- Targets 0×2 on branch; branch probes byte-identical to real Node.
- Guards 114/114 exit 0 (8× #345, 4× #347, 5× #350/#351 flips,
  dump-req #353, keepalive-free #355, server-lifecycle / close-idle /
  socket / keep-alive / interim-response / upgrade / connect families,
  plus the framing neighbors: 1.0, 1.0-keep-alive, chunked-304,
  response-remove-header-after-sent, head-request, content-length,
  content-length-mismatch, get-pipeline-problem, raw-headers, proxy,
  chunk-extensions-limit, insecure-parser, server-keepalive-req-gc).
  (Three names in the first guard pass — `server-reject-chunked`,
  `server-keep-alive-timeout-custom`, `server-keep-alive-timeout-buffer`
  — do not exist; the real files
  `server-reject-chunked-with-content-length`,
  `keep-alive-timeout-custom`, `keep-alive-timeout-buffer` all pass.)
- Differential: fast-sweep `http-sweep-rh-{base,branch}.csv` vs base
  `3dc3d588` — exactly 2 lines toward pass, 0 regressions, 0 mode
  changes. First branch run showed 1 regression
  (`test-http-many-ended-pipelines`, MaxListenersExceededWarning from
  one `once('finish')` listener per finished response on a
  handler-destroyed socket) — fixed by the destroyed early-return +
  single arming in `destroySoon` (see above); branch re-swept clean.
- Jest 3059 passed / 7 failed / 1 skipped (known baseline);
  `tests/ondemand-require.test.js` 29/29; builds 0 (build-vfs exit 1
  once on the known esm.sh acorn-fetch transient, 0 on retry).
