# NOTES — server IncomingMessage destroy (test-http-server-incomingmessage-destroy)

## Assigned name does not exist — read this first

The brief named `test-http-server-incoming-pipelined-socket-destroy`.
That file does NOT exist in the vendored Node v24.20.0 suite: a full
directory listing shows only `test-http-incoming-pipelined-socket-destroy`
(which passes, exit 0) and `test-http-server-incomingmessage-destroy`
(which failed, exit 7, on branch and base alike). The sweep CSVs confirm
it: grepping the #284 branch sweep for "pipelined" returns exactly one
line, the passing test. This lane fixed the one real failing test in the
family, `test-http-server-incomingmessage-destroy`, and reports the
substitution explicitly rather than inventing the assigned file.

## The test (verbatim shape)

Server handler calls `req.destroy(new Error("Destroy test"))`. It asserts:
(1) NO `uncaughtException` (`mustNotCall`), (2) the client `get()` gets
`'error'` with message `"socket hang up"`, code `ECONNRESET`, (3) then
`server.close()`. On real Node v24.22.1 it passes; on the shim it exited 7.

## Diagnosis — two stacked mismatches, both in `IncomingMessage._destroy`

### 1. The destroy error surfaced as uncaughtException

`IncomingMessage._destroy` ended with `cb(err)`. The ported stream emits
`'error'` from that callback unconditionally — and because the handler
runs synchronously inside dispatch, the throw propagated through
`_dispatchSocketRequest` → parser → `onHttpData` and became an
`uncaughtException`, tripping the test's `mustNotCall`.

Real-Node contract, probed (not assumed):
- Server `req.destroy(err)` with NO `'error'` listener → NO
  `uncaughtException`. `errored === err`, `'close'` fires.
- The `'error'` event DOES fire if a listener exists at emission time
  (async emission: a listener attached synchronously after `destroy()`
  still catches it; a listener removed before the tick means no event
  and no throw — manual `emit('error')` with no listener DOES throw, so
  the destroy path itself is conditional, not the emitter).
- Client `res.destroy(err)` is the opposite: with no `'error'` listener
  it DOES surface as `uncaughtException` (required by
  `test-http-client-incomingmessage-destroy`).
- The client test's uncaught does NOT come from the response at all: on
  real Node the client socket error is forwarded to the `ClientRequest`,
  which emits `'error'` ("Destroy test", no code) — proven by attaching a
  request `'error'` listener and watching it fire while the uncaught
  disappears. The shim does not forward socket errors to the request
  (proven: shim case with a res listener but no request listener shows
  no uncaught), so the shim's client test passes via the res `'error'`
  path today and that path must be preserved.

Fix: `cb(this.socket && this.socket.server ? null : err)`. Accepted
sockets carry `.server` (net.js accept path, the ONLY place `.server`
is assigned); client sockets and FakeSocket never do — so the marker
needs no new flag and no creation-site changes. This mirrors the
existing `OutgoingMessage._destroy` close-only pattern (`cb(null)`,
`errored` set by the ported destroy before `_destroy` runs).

### 2. The client saw 'read ECONNRESET' instead of 'socket hang up'

After fix 1, the client assertion failed: actual `'read ECONNRESET'`,
expected `'socket hang up'`. Cause: `_destroy` used `resetAndDestroy()`
for every incomplete message, so the peer got a reset.

Real-Node contract, probed with raw sockets:
- Server `req.destroy(err)` → server socket closes with `hadError: true`,
  but the CLIENT socket sees FIN (`'end'`) + clean close (`hadError:
  false`). The HTTP layer then generates `ECONNRESET "socket hang up"`
  for the incomplete response.
- A genuine reset (`req.socket.resetAndDestroy()`, or reset after a
  partial response) gives the client `'read ECONNRESET'` instead — a
  different, also-real outcome that this test does NOT want.

Fix: server-side messages destroy their socket gracefully
(`this.socket.destroy()`, no error) instead of `resetAndDestroy()`.
The loopback graceful destroy delivers EOF to the peer, the client
socket ends itself (allowHalfOpen false), and the existing client
round-trip close path generates `"socket hang up"` ECONNRESET.

The `resetAndDestroy` branch is kept for client messages: its comment
still stands for the client→server direction, where a FIN never closes
an allowHalfOpen server socket (test-http-outgoing-destroyed block 3).

## What the shim now does (zz-probe verified)

```
after destroy: errored: Destroy test closed: true
REQ close, errored: Destroy test destroyed: true
CLIENT: socket hang up ECONNRESET
DONE
```

No `'error'` event on the server req, no uncaught, client gets exactly
`"socket hang up"` / `ECONNRESET`, loop drains.

## Known divergences deliberately left alone

- `res.closed`/`req.closed` is `true` immediately after `destroy()` on
  the shim; real Node reports `false` until `'close'` fires. Pre-existing
  ported-stream timing, not introduced here. The client test's
  `closed === false` assertion is invisible on the shim because
  virtual-path handler throws are swallowed by the round-trip writer's
  catch (the #283 follow-up note) — that swallowing is separate
  follow-up work, not this lane.
- Server `req.destroy()` with unread pipelined data: real Node sends
  RST (unread data → reset); the shim's graceful destroy always sends
  FIN. No official test covers it; noted, not chased.
- `'aborted'` event: real Node emits it on server req destroy; the shim
  sets `aborted = true` but does not emit. No test asserts it; not added
  (minimal fix).

## Verification

- Target: `test-http-server-incomingmessage-destroy` 7 → 0 (branch and
  live-main re-verified; base worktree at 4705e749 still 7).
- Neighbors: `test-http-client-incomingmessage-destroy` 0,
  `test-http-incoming-pipelined-socket-destroy` 0.
- Guard battery 49/49 on the branch (full #284 outgoing family, CONNECT
  family, upgrade family, keep-alive-max-requests, server, proxy,
  chunked, blank-header, destroy-socket-on-client-error, client-error,
  multiple-client-error, keepalive-req-gc, delete-parser,
  drop-connections-in-cluster, client-highwatermark, set-trailers,
  nodelay, multiple-headers, host-headers).
- Full 397-test differential sweep branch vs pristine base 4705e749
  (CSVs in the parity-sweep goal hidden_files): base 217 pass / 68
  timeout / 112 fail → branch 218 pass / 68 timeout / 111 fail.
  EXACTLY ONE line differs, toward pass:
  test-http-server-incomingmessage-destroy 7 → 0. Zero regressions;
  crash codes 134/139 identical on both trees.
- Repo jest + ondemand + build-vfs: run before shipping (see PR body).

## Files changed

- `src/http.js` only (IncomingMessage._destroy: server-side graceful
  socket destroy + close-only callback) + this note + the ondemand
  allowlist.
