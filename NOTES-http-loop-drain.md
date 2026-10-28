# NOTES: server unref() loop drain (test-http-server-delete-parser)

## Test (verbatim shape)

`http.createServer` handler: `writeHead(200)`, `res.write("okay",
cb)` where `cb` deletes `res.socket.parser`, then `res.end()`.
Client: bare `http.request({ port, host, method: "GET" })`, `req.end()`
— no response handler, no consumer. Top level: `server.unref()`.
Real Node exits 0; the shim hung (124).

## What the exchange does (probed, not assumed)

- The exchange itself drains fine under the shim: by ~7s the client
  socket is destroyed by the agent pooled timeout (5s), the server-side
  socket closes with it, both `_loopTimer`s are cleared, the agent
  free pool is empty, `server._connections` is 0, and the
  connections-checking interval is stopped. `process._getActiveHandles()`
  shows only the 2 stdio PipeWrap sockets (present from t=0, red
  herrings — they exist in every run, including ones that exit).
- `process.getActiveResourcesInfo()` at 7s/12s shows exactly one
  remaining ref'd resource: `Timeout: 1`. That is the **net Server's
  `_loopTimer`** (1h repeat interval, ref'd) — acquired when the net
  server starts listening and released only on close.
- Proof it is the keeper: calling `server.close()` at 12s makes the
  probe exit immediately (close releases the net server's loop timer).

## Root cause

`ServerBase` (src/http.js, the http server object) had `ref()` /
`unref()` as no-ops returning `this`. They never reached
`this._netServer`, whose `Server.prototype.unref()` (src/net.js)
correctly unrefs its `_loopTimer` and whose `_keepLoopAlive()` honors
a pre-set `_unref` flag. So `server.unref()` left the listening
socket's loop-keeper ref'd forever, and the process never exited even
after every connection drained.

## Real-Node semantics probed (v24.22.1, plain node)

- `unref()` after `listen()` → process exits once the server-side
  socket drains (~4s: the server keepAliveTimeout closes the idle
  connection; the unref'd listening socket does not hold the loop).
- `unref()` BEFORE `listen()` → also exits (~4.5s): the unref sticks.
- `unref()` then `ref()` → stays alive past 8s: ref re-refs.
- Note for future probes: real Node also stays alive ~1.5s after res
  end (server-side socket until keepAliveTimeout) — a 1.5s window
  proves nothing; wait past 5s. And: a `probe exit=$?` after a
  `| grep` pipeline reports grep's exit, not node's — always capture
  node directly.

## Fix (src/http.js, ServerBase only)

- Constructor: `this._unrefed = false` next to `this._netServer`.
- `unref()`: set the flag, call `this._netServer?.unref()`.
- `ref()`: clear the flag, call `this._netServer?.ref()`.
- `listen()`: after `netServer.listen(...)`, `if (this._unrefed)
  netServer.unref()` — the net server is recreated on every
  `listen()`, so a pre-listen unref must be re-applied.
- Deliberately NOT touched: FakeSocket's no-op ref/unref (a fake
  socket has no handle — an early edit landed there by mistake and
  was reverted before testing), the #254 connections-checking loop
  (already unref'd and stopped when idle; it is not the keeper here),
  the loop-keeper itself (correct for genuinely open sockets).

## Results (PARITY_TARGET=http)

- `test-http-server-delete-parser`: 124 → 0.
- Shim-side ref/unref probe (zz-loop-drain6, deleted after use):
  mode A (unref after listen) exits ~5.4s, mode B (unref before
  listen) exits ~5.4s, mode C (unref then ref) STILL-ALIVE at 8s —
  matching real Node.
- Guards: see the guard-loop output (47 tests incl. the twelve #254
  timeout flips, the #267 keep-alive-defaults flip, and the #266
  clientError trio). No passing guard may change.

## Not claimed

No http score change (docs syncs are batched separately). The
server-side keepAliveTimeout close path (real Node closes the idle
server socket at 5s) is a separate mechanism from this fix: under the
shim the pooled-client timeout cascade already closes both sockets,
so this lane did not need to implement server keepAliveTimeout
enforcement.
