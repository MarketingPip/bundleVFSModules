# test-http-client-timeout-event — request `timeout` fired twice

## Test shape

Server with NO handler. Client `req.setTimeout(1)`, `req.on("timeout",
mustCall(...))` (expects exactly one fire); the handler calls `req.end(cb)`,
then `req.destroy()` 100ms later; `req.on("close", mustCall(...))` asserts
`req.destroyed === true`.

## Failure on pristine main `e48733e4`

Exit 1, 3/3 runs: `Mismatched function calls. Expected exactly 1, actual 2`
at the `timeout` mustCall. (Before PR #291's agent rework this test timed
out (124): `end()` to a never-responding server never completed — see the
round-trip note below. #291 made `end()` complete via the agent timer, but
left the double fire.)

## Diagnosis — three facets of one timeout mechanism

Traced with timestamped probes under `PARITY_TARGET=http`:

1. **`ClientRequest.setTimeout` never armed the socket timer**
   (`src/http.js`, `ClientRequest.setTimeout`). It stored `this.timeout`
   and registered the callback, but — unlike `IncomingMessage.setTimeout`
   and unlike real Node — it never forwarded to `this.socket.setTimeout`.
   The socket therefore kept the agent's 5000ms timer (globalAgent
   `timeout: 5000`, applied at assignment in `onSocket`), so the first
   `timeout` fired at ~5000ms instead of ~1ms.

2. **Post-fire writes re-armed the socket timer** (`src/net.js`,
   `Socket.prototype._deliverToPeer`). It called `_refreshTimeout()`
   unconditionally. Real Node, probed on v24.22.1: after the timer fires
   (its callback nulls `_idleTimer`), a subsequent WRITE does not re-arm
   it, a subsequent READ does, and an explicit `setTimeout` does. So
   `end()` inside the `timeout` handler re-armed the 1ms timer and fired
   `timeout` a second time.

3. **The round-trip timer double-fired** (`src/http.js`,
   `_performVirtualRequest`). It arms `this._timeoutId` with `this.timeout`
   at `end()` and emits `timeout` on fire — a second, independent source
   alongside the socket timer. In the old flow it fired at end()+1ms,
   producing the second `timeout`.

## Fix (all three facets required; no single facet passes the test)

- `src/net.js`, `_deliverToPeer`: refresh the idle timer only when it is
  currently armed (`this._idleTimer !== null`). Reads
  (`_receiveFromPeer`) still refresh unconditionally, per the probed rule.
- `src/http.js`, `ClientRequest.setTimeout`: forward to the socket when
  one is already assigned (`if (this.socket?.setTimeout)`), so a request
  timeout wins over the agent timeout applied at assignment. Queued
  requests (no socket yet) keep the stored timeout; the round-trip timer
  covers them, as before.
- `src/http.js`, `onSocket` agent-timeout forwarder: sets
  `request._timeoutFired = true` when it delivers `timeout` via the socket
  timer.
- `src/http.js`, `_performVirtualRequest` timer: still destroys the
  socket on fire, but skips the `timeout` emit when `_timeoutFired` is
  set. The destroy is NOT skipped: it is what unblocks a round trip to a
  server that never responds (probed on pristine main: immediate `end()`
  to a no-handler server never runs its callback without a socket
  destroy, because the round trip awaits response completion). The
  destroy does not close the request itself — `finish` runs, the `end()`
  callback runs, the app's own `destroy()` at +100ms still owns `close`
  with `req.destroyed === true`.

With all three: socket timer fires at ~1ms (fire #1) → handler `end()` →
write does not re-arm (guard) → round-trip timer fires at end()+1ms,
destroys the socket, skips the emit (flag) → `end()` callback →
`destroy()` at +100ms → `close` with `destroyed === true`. Exactly one
`timeout`, and fast (was ~5s, now ~0.1s).

## Real-Node probes (v24.22.1, `/tmp/probe-mc291-timeout*.js`)

- Test shape mirrored (server no handler, `setTimeout(1)`, `end()` inside
  the `timeout` handler): exactly ONE fire.
- Timeout fires, then DATA arrives: fires AGAIN (reads re-arm post-fire).
- Explicit `setTimeout` after fire: fires again.
- Writes every 50ms pre-fire with a 100ms timeout: ZERO fires (writes
  refresh pre-fire).

## Guards (all exit 0)

client-timeout, client-timeout-with-data, agent-timeout,
agent-timeout-option, agent-keep-alive-timeout-buffer, keep-alive-timeout,
keep-alive-timeout-custom, keep-alive-timeout-buffer,
keep-alive-timeout-race-condition, server-keep-alive-timeout,
agent-keepalive-delay, client-keep-alive-hint,
client-keep-alive-release-before-finish, agent-keepalive, keep-alive,
keep-alive-max-requests, keep-alive-drop-requests.

## Rejected variants

- Guard alone: still fails — the agent 5000ms timer + round-trip 1ms
  timer still double-fire.
- Socket forward alone: still fails — the `end()` write re-arms the
  fired timer, and the round-trip timer adds a third fire.
- Round-trip skip alone: passes the count but leaves the 1ms timeout
  firing at 5000ms — wrong timing, wrong reason.
- Removing the round-trip timer's socket destroy: hangs — see the
  round-trip note above. The `finish`-waits-for-response shape is a
  deeper gap, out of scope for this lane; the destroy preserves the
  existing unblocking behavior.
