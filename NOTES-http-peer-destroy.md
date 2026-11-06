# NOTES — peer-destroy error semantics (test-http-conn-reset, test-http-destroyed-socket-write2)

Base main `d9d0c273` (docs sync #358, http 362/397). Triage lane 3
(triage-2026-11-06.md). Both targets 1 → 0, no regressions.

## Root causes (all probed on real Node v24.22.1, not assumed)

### 1. `destroy()` is abortive (RST), `end()` is graceful (FIN)

Real Node `socket.destroy()` closes the handle abortively: a peer that
writes after the destroy gets `ECONNRESET` (test-http-conn-reset: the
net server destroys the accepted socket immediately; the client's
`req.end()` write must fail `ECONNRESET`). The shim's virtual transport
modeled every peer close as a graceful FIN: `Socket._destroy` delivered
`peer._receiveEOF()` ('end'), `onReadableStreamEnd` replaced `write`
with `writeAfterFIN`, and the next write failed `EPIPE`.

Fix (`src/net.js`): `_destroy` marks the peer with `_peerReset = true`
when it delivers the EOF from a destroy (not from `_final`'s graceful
FIN). `writeAfterFIN` then errors `ECONNRESET` (via the existing
`errConnReset()` helper, same shape as `resetAndDestroy`'s peer
error) when the flag is set, and keeps `EPIPE` otherwise — the repo
test `tests/net.test.js` "write after local end and remote FIN fails
with EPIPE" pins the FIN case, and it still passes.

### 2. Writes to an already-destroyed peer had no error code

In `test-http-destroyed-socket-write2` the second `req.write("hello")`
runs synchronously inside the server's `data` handler (which just
destroyed the response), i.e. before the EOF tick: `Socket._write`
hit the `peer.destroyed` branch and produced `new Error("Socket is
not connected")` with no `code` (the test accepts
ECONNRESET/ECONNABORTED/EPIPE). Same shape in `_writev` and
`_flushPendingWrites`.

Fix (`src/net.js`): at all three sites, a write whose peer exists but
is destroyed now fails with `errConnReset()`; any other
not-connected state keeps the existing codeless error (no test pins
it). `test-http-outgoing-destroyed` block 3 (the `_flushPendingWrites`
case) asserts only that an error fires, not its code.

### 3. `ClientRequest.res` was `undefined`, Node inits it to `null`

Node `lib/_http_client.js:486`: `this.res = null;` in the constructor
(set on response arrival at :820/:896/:960, cleared at :911).
The shim never assigned it. `test-http-destroyed-socket-write2`
asserts `req.res === null` in its error handler.

Fix (`src/http.js`): `this.res = null;` in the `ClientRequest`
constructor, right after `super()`.
ponytail: ceiling — only the null init is ported; the shim does not
track the live response on `req.res` (set/clear on the response
lifecycle), because no test reads a live `res`.

### 4. Unwritten request body must be dropped on socket error

After fixes 1–3 the test failed at `req.outputData.length === 0`
(actual 2): the two `write("hello")` entries were never drained.
Node `lib/_http_client.js:748-749` (`socketOnEnd`): "Too bad. That
output wasn't getting written." — `if (req.outputData)
req.outputData.length = 0;`.

Fix (`src/http.js`, `socketErrorListener`): clear
`request.outputData` (and `request.outputSize`, which the shim tracks
alongside it) immediately before emitting `'error'` on the request.
The clearing is scoped to the actual emission (after the
`_errorEmitted` / `_inFreePool` guards), so a socket error that is
swallowed elsewhere never touches a live request's queue.

## Verification

- Targets 0×2 on branch: `test-http-conn-reset`,
  `test-http-destroyed-socket-write2`.
- Guards: recent flips (#345×8, #347×4, #350/#351×5, #353, #355,
  #357×2) + socket-error families + EPIPE pinning tests
  (`test-net-socket-write-after-close`,
  `test-net-write-after-end-nt`) — see handoff for counts.
- Full differential (fast-sweep): `http-sweep-pd-{base,branch}.csv`.
- Jest full suite: baseline 3059/7/1; ondemand 29/29.
- Builds: `build-vfs`, `build-sandbox --check`, `build-runtime
  --check` exit 0; dist restored.

## Follow-ups (not this PR)

- None. The `writeAfterFIN` EPIPE branch and the codeless
  "Socket is not connected" error remain for their pinned/untested
  cases; if a future test asserts a code for a never-connected
  socket write, the `_write` fallback is the place to look.
