# NOTES — http client request lifecycle on response finish (test-http-keepalive-free)

## What was wrong

Two faces of one root cause: the shim's response-completion path tore the
client request down with `destroy()` where real Node ends it gracefully
or defers it.

1. **Still-writing request destroyed at response completion.** When the
   response ended before the client finished writing its body,
   `_releaseAgentSocket()` destroyed the request unconditionally. The
   chunked terminator was never sent and the server request never
   completed (probed: keep-alive client writing after res `'end'` —
   real Node finishes the request and the server sees all 12 bytes with
   req `'end'`; the shim closed the request with `writableEnded: false`
   and the server saw 6 bytes, no `'end'`).
2. **Finished request not destroyed before user `'end'` handlers.**
   The release ran after user `'end'` handlers (via `_releaseAfterEnd`),
   so `req.destroyed` was still `false` inside them — real Node sets it
   synchronously in `responseOnEnd` → `responseKeepAlive`
   (`lib/_http_client.js:986`), and `test-http-keepalive-free` asserts
   it in `'end'`.

## Node source (v24.20.0, `lib/_http_client.js`)

- `responseOnEnd()` (1017): sets `req._ended = true`; if not
  keep-alive → `socket.destroySoon()` / `socket.end()`; else if
  `req.writableFinished && !this.aborted` → `responseKeepAlive(req)`.
  A still-writing request releases nothing here.
- `requestOnFinish()` (1066): "This function is necessary in the case
  where we receive the entire response from the server before we finish
  sending out the request." When `'finish'` fires later, if
  `req.shouldKeepAlive && req._ended && !req.destroyed` →
  `responseKeepAlive(req)`.
- `responseKeepAlive()` (986): removes socket listeners, schedules
  `emitFreeNT` on nextTick ("Mark this socket as available, AFTER
  user-added end handlers have a chance to run"), then synchronously
  sets `req.destroyed = true` and detaches the socket from the response.
- `emitFreeNT` (1077): `req._closed = true`, `req.emit('close')`,
  `req.socket.emit('free')` — `'close'`/`'free'` come after user
  `'end'` handlers, on nextTick.
- `res.on('end', responseOnEnd)` is attached FIRST (964, "Add our
  listener first, so that we guarantee socket cleanup"), before
  `'response'` is emitted — so it runs before user `'end'` listeners.

## Fix (`src/http.js` only)

- `_releaseAgentSocket()`: if the request has not finished writing
  (`!this.writableFinished && !this.destroyed`), do NOT destroy it and
  do NOT release the socket — attach a one-shot `'finish'` listener
  that re-enters the release then (Node's `requestOnFinish`). The
  `_releasedToAgent` guard keeps it once-only; if the request never
  finishes, the socket stays assigned, matching real Node.
- Streamed completion branch: before `streamedMsg._finishBody()`, if
  `this.writableEnded && !this.destroyed`, destroy the request via
  `Writable.prototype.destroy` so user `'end'` handlers see
  `req.destroyed === true`. The predicate is `writableEnded`, not
  `writableFinished`: ClientRequest emits `'finish'` only after
  `_performRequest()` resolves, which is after this completion branch,
  so the finished bit is still false here for buffered requests. The
  socket release stays after `'end'` (see `_releaseAfterEnd`):
  pooling/destroying the socket here would break tests that read
  `agent.sockets` inside `'end'`
  (`test-http-keep-alive-close-on-header`) or destroy the socket
  themselves there (`test-http-agent-destroyed-socket`).
- `ClientRequest.destroy(err)`: early return when `this.destroyed` is
  already true. Real Node's `destroy()` on a destroyed stream is a
  no-op — including not touching the socket. The ported stream destroy
  already no-ops, but this override destroyed the socket
  unconditionally, so a second `destroy()` (e.g. `req.destroy()` after
  the response already completed and destroyed the request) killed the
  pooled socket the first destroy had preserved
  (`test-http-keepalive-free` line 40: `req.socket.destroyed` must stay
  `false` after `req.abort()`/`req.destroy()`).

## Ordering notes (all probed)

- `'close'` after `destroy()` is nextTick-scheduled, and res `'end'`
  delivery is nextTick-scheduled too — but the destroy runs before
  `_finishBody()`, so its close-nextTick is queued first. In practice
  the guard suite shows no ordering regression (the tests that wait on
  req `'close'` check pool state at a further nextTick, by which time
  the release has run).
- The `finish`-after-`close` emit for `end()` called on an
  already-closed request in the Connection: close shape: the shim
  emits `'finish'` after the late `end()`, real Node does not — an
  ordering-only divergence, no failing test hinges on it.

## Not this lane

- **Server socket `end()` vs `destroy()` at response finish
  (`test-http-remove-header-stays-removed`,
  `test-http-remove-connection-header-persists-connection`). At res
  `'finish'` on a non-keep-alive connection the shim's server socket
  has `writableEnded === false`; real Node has `true`. Root cause:
  `_finishSocketResponse`'s non-keep-alive branch calls
  `socket.destroy()` where Node's `resOnFinish`
  (`lib/_http_server.js:1123-1129`, `res._last` branch) calls
  `socket.destroySoon()` / `socket.end()`. Separate lane: the fix site
  is the server finish path (with loop-drain risk — `end()` alone
  leaves the virtual socket half-open, per the comment there; the
  server socket has `allowHalfOpen: true`), not the client release
  path. Both tests fail identically on base and on this branch.
- The `finish`-after-`close` emit for `end()` called on an
  already-closed request in the Connection: close shape — probed
  real-vs-shim difference is ordering-only (shim emits `'finish'`,
  real Node does not); no failing test hinges on it.

## Verification

- Target `test-http-keepalive-free`: exit 0 ×2 on the branch (was 1).
- Guards 74/76 exit 0: the 8 PR #345 flips, 4 PR #347 flips, 5 PR
  #350/#351 flips, dump-req #353, client-timeout-*/client-abort*/
  client-finished/client-response-domain families, agent families
  (keepalive, destroyed-socket, free-socket-data-guard,
  keep-alive-timeout-buffer, maxsockets-respected,
  keep-alive-close-on-header, uninitialized, close, error-on-idle,
  maxsockets, timeout, remove, false, null, no-protocol), upgrade
  family, server keep-alive families. The 2 failures are the
  remove-header pair above (identical on base — pre-existing, not a
  regression).
- Keep-alive probe (`zz-cl-keepalive`, removed after use): shim now
  matches real Node — res `'end'` → `req.end()` → server req `'end'`
  (12 bytes, `readableEnded: true`) → client `'finish'`
  (`writableEnded`/`writableFinished` true) → client `'close'`.
- Differential: fast-sweep `http-sweep-cl-{base,branch}.csv` vs base
  `e81523d7` — exactly 1 line toward pass (`keepalive-free` 1→0),
  0 regressions.
- Jest 3059 passed / 7 failed / 1 skipped (known baseline);
  `tests/ondemand-require.test.js` 29/29; builds 0.
