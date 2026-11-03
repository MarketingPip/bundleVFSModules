# NOTES — test-http-agent-reuse-drained-socket-only (agent reuses only drained sockets)

## Target

`test-http-agent-reuse-drained-socket-only` failed with exit 124 (timeout, no
output) on base `e9c268dd`.

## What the test does

- A raw `net` server (`pauseOnConnect: true`) never reads: on connection it
  pauses and writes a `200` with `Content-Length: 0`.
- Request 1 (keep-alive agent): on socket `connect`, writes three 64MB
  buffers and ends with a third; asserts `req.socket.writableLength > 0`
  (the socket is NOT drained — the server never reads).
- On response `end`, request 2 must arrive on a NEW socket (the first is
  not drained, hence not reusable); on its `end`, request 3 must REUSE
  request 2's socket (drained: headers only).

## Diagnosis — three stacked gaps, all in the request/socket path

1. **Deadlock before anything: `socket` fired at round-trip time, not at
   assignment.** The shim emitted `socket` only inside
   `_performVirtualRequest` (i.e. at `end()`/flush). The test defers
   `end()` until `connect`, and `connect` is attached inside `socket` —
   so no `socket` → no `connect` handler → no `end()` → no round trip.
   Probed on real Node v24.22.1: `socket` fires asynchronously after
   construction, while the socket is still `connecting=true,
   pending=true` — before any `end()` is required.
2. **GET + body threw before the loopback gates.** `_performRequest`
   threw `ERR_INVALID_ARG_VALUE` ("Request with GET method cannot have a
   body") for ANY GET/HEAD with a body, before the virtual/raw gates.
   Real Node http sends GET bodies fine (the test itself proves it);
   only `fetch` forbids them, and no official test covers the early
   throw (grep for "cannot have a body" is empty).
3. **No drained accounting anywhere.** The shim's `keepSocketAlive`
   checked only the server keep-alive timeout hint, so an undrained
   socket would have been pooled. And the shim's socket `writableLength`
   always read the stream queue alone — but virtual delivery is
   synchronous into the peer's readable buffer, so the queue drains to 0
   even when the peer never reads. Probed on real Node: after the first
   response ends with 192MB queued, `writableLength` reads 201326657
   (192MB + head), the socket sits in `agent.sockets` (active, count 1),
   NOT in `freeSockets`, and is NOT destroyed — indefinitely.

## Real-Node probes (v24.22.1, plain scripts under /tmp)

- `probe-ard-real.js`: `socket` event sees `connecting=true,
  pending=true`; after `end(64MB)` the third time, `writableLength`
  reads 201326657; after first response `end`, free pool length is 0 and
  the socket is not in the pool.
- `probe-ard-real2.js`: after first `end` and after +500ms, the socket
  is still in `agent.sockets` (count 1), never in `freeSockets`, never
  destroyed. The server peer sees no close/error.
- The test itself passes on real Node (exit 0).

## Fix

- `src/http.js`, `ClientRequest.onSocket`: emit `socket` at assignment
  time via `queueMicrotask`, guarded by a new `_socketEmitted` flag so
  it fires exactly once per request. `_performVirtualRequest`, the
  pending-socket branch, and the fetch path skip their emission once
  the flag is set (the connect replay for already-connected sockets is
  unchanged).
- `src/http.js`, `_performRequest`: the body bytes are drained out of
  `outputData`/`outputSize` once built (they are now owned by the round
  trip/fetch, mirroring real Node's flush-into-socket), and the
  GET/HEAD+body throw moves to just before the fetch branch, so only
  the fetch path rejects GET bodies.
- `src/http.js`, `AgentBase.keepSocketAlive`: veto pooling when
  `socket.writableLength > 0` (drained-only reuse).
- `src/net.js`, `Socket.prototype.writableLength` (shadows the ported
  stream getter): stream queue + current request's unflushed buffer
  (`outputSize` + Writable queue, only until `_performRequest` drains
  it) + the peer's unread bytes beyond one kernel-scale receive window
  (131072, the `recvBufferSize` observed on real Node: headers-only
  sockets still read 0, 192MB sockets read undrained).

## Deliberately left alone

- Real Node KEEPS an undrained socket tracked as active (never pooled,
  never destroyed); the shim's `releaseSocket` DESTROYS on veto (the
  existing hint-veto path). The test observes only reuse, not the
  socket's fate, so the shared veto path serves here — but a future
  test asserting the kept socket would need a distinct undrained path
  in `releaseSocket` (re-add to the active list instead of destroying).
## Differential note: test-http-parser-memory-retention 124 → 1 (fail-to-fail, NOT a regression)

- Base `e9c268dd`: exit 124 (hang). Branch: exit 1, stable across
  isolated re-runs. The test still FAILS on both trees; only the failure
  surfacing changed.
- Root cause (proven, pre-existing, out of this lane's scope): nothing
  in `src/http.js` ever sets `ClientRequest.parser` — the only `parser`
  assignments are the server-side `socket.parser` facade and the
  CONNECT/upgrade nulling. So the test's `socket`-handler assertion
  (`typeof parser.onIncoming === "function"`) throws on BOTH trees.
  On base the throw lands inside `_performVirtualRequest`'s synchronous
  emit, rejects the round-trip promise, and `end()`'s error handler
  emits `abort` (no `error` listener) — the server never sees the
  request and the test hangs. On branch the identical throw lands in
  the assignment-time `queueMicrotask` emit and surfaces as an
  uncaught exception. A base probe (`request.parser = undefined` logged
  at `socket` time, server handler never running, exit 124) confirms
  the chain.
- Client-side `request.parser` exposure + parser freeing belongs to the
  queued parser-residuals family, not this lane; fixing it here would
  expand scope past the drained-socket target. Precedent: the #291 lane
  shipped with mode-changed still-failing tests documented the same way.
- The 128KiB window in the socket getter approximates kernel buffer
  accounting; it is not a protocol constant. A future test pinning an
  exact kernel-buffer boundary would need the real capacity model.
- The 256MB vs 192MB shape at the sync assert (request Writable queue
  still counts the first chunk whose callback is microtask-deferred,
  while `outputData` already holds it) is unobservable: the test
  asserts only `> 0`, and the agent veto reads only `> 0`.

