# HTTP Agent Socket Pooling — Working Notes

## Problem
8 http parity tests hang (30s timeout, silent — no output):
1. test-http-abort-queued.js ✅ PASSES
2. test-http-aborted.js ✅ PASSES (fixed by server-side keep-alive)
3. test-http-after-connect.js ✅ PASSES (fixed by server-side keep-alive)
4. test-http-client-abort-keep-alive-queued-tcp-socket.js ❌ fails fast (assertion: unexpected ECONNRESET error event)
5. test-http-agent-maxsockets-respected.js ✅ PASSES (fixed by server-side keep-alive)
6. test-http-agent-reuse-drained-socket-only.js ✅ PASSES (fixed by server-side keep-alive)
7. test-http-agent-timeout.js ✅ PASSES (fixed by server-side keep-alive)
8. test-http-client-abort-keep-alive-destroy-res.js ✅ PASSES (fixed by server-side keep-alive)

## Root cause (client side — fixed in PR #227)
The virtual HTTP path (`_performVirtualRequest`) creates a fresh socket via
`netConnect()` for every request and destroys it when done. It never integrates
with `http.Agent`:
- `AgentBase.addRequest()` is a noop — `agent.sockets`, `agent.requests`,
  `agent.freeSockets` are never populated
- `AgentBase.createSocket()` creates a FakeSocket but is never called
- No socket reuse, no maxSockets enforcement, no request queuing

Tests assert on `agent.sockets[name].length`, `agent.requests[name].length`,
`req.reusedSocket`, etc. These assertions fail, but the failure is swallowed by
the try/catch in `_socketHttpRoundTrip`'s `onHeaders` ("listener errors are not
fatal"), so tests hang silently instead of failing fast.

## Root cause (server side — fixed in this lane)
Even with client-side pooling, the server destroyed every socket on response
end, so the agent's free pool never populated:

1. **`ServerResponse._destroy` kills the socket unconditionally.** The Writable
   stream machinery auto-destroys the response after 'finish' (autoDestroy
   defaults to true), which calls `ServerResponse._destroy` → `socket.destroy()`.
   This happens even for keep-alive connections where the socket must stay open.
   Traced via monkey-patched `Socket.prototype.destroy`:
   `ServerResponse._destroy (http.js:1059)` ← `node:internal/streams/destroy` ←
   `Writable.destroy` ← `finish`.

2. **Constructor clobbers synchronously-assigned sockets.** `AgentBase.addRequest`
   can assign a free socket synchronously via `reuseSocket` → `req.onSocket()`,
   but the `ClientRequest` constructor then overwrote `this.socket` with a
   `FakeSocket`, losing the pooled socket.

3. **`_releasedToAgent` never cleared on reuse.** After a socket was released to
   the free pool once, reusing it for a second request and completing would hit
   the early-return in `_releaseAgentSocket`, never re-parking it.

## What was implemented

### AgentBase (src/http.js) — PR #227
- `addRequest(req, options)`: real implementation
  - Try free socket from `freeSockets[name]` (LIFO/FIFO per `scheduling`)
  - Else create new via `createSocket` if under `maxSockets`/`maxTotalSockets`
  - Else queue in `requests[name]`
- `createSocket(req, options, cb)`: uses `netConnect(port)` for virtual path
  (was FakeSocket); tracks in `sockets[name]`; sets `autoDestroy=false`
- `releaseSocket(socket, name)`: move to `freeSockets` if keepAlive, else destroy;
  calls `_processQueue`
- `_processQueue(name)`: dequeues next non-aborted request, re-runs addRequest
- `removeSocket(socket, name)`: untrack from sockets/freeSockets
- `reuseSocket(socket, req)`: marks `_agentReused`, clears `_releasedToAgent`,
  calls `req.onSocket`

### ClientRequest (src/http.js) — PR #227 + this lane
- Constructor calls `agent.addRequest(this, ...)` synchronously (Node parity)
- Constructor no longer clobbers a synchronously-assigned socket with FakeSocket
- New `onSocket(socket)`: assigns socket, resolves waiting promise
- New `onSocketError(err)`: rejects waiting promise or emits error
- New `_releaseAgentSocket()`: returns socket to agent pool (or destroys)
- `_performVirtualRequest`: waits for agent socket assignment instead of
  direct `netConnect()`; releases socket via `_releaseAgentSocket()` on completion
- `destroy()`: rejects pending socket promise with ECONNRESET; removes socket
  from agent tracking
- Auto-adds `Connection: keep-alive` header when `agent.keepAlive` is true

### ServerResponse (src/http.js) — this lane
- `_destroy` now skips socket destruction when `this._keepAliveSocket` is set
  (and no error) — the socket is preserved for reuse instead of being killed
  by stream autoDestroy after normal finish. Explicit destroy with an error
  (abort) still destroys the socket.
- `_finishSocketResponse` sets `res._keepAliveSocket = true` when it decides
  keep-alive (was already computing `keepAlive` correctly but the socket died
  in autoDestroy anyway).

### _socketHttpRoundTrip
- No longer destroys socket on settle; caller owns lifecycle
- Handles already-connected sockets (queueMicrotask instead of waiting for
  'connect' event that already fired)

## Test results (final)
- test-http-abort-queued.js: PASS
- test-http-aborted.js: PASS (flaky — baseline also flakes)
- test-http-after-connect.js: PASS (flaky — baseline also flakes)
- test-http-agent-maxsockets-respected.js: PASS (flaky — baseline also flakes)
- test-http-agent-timeout.js: PASS (flaky — baseline also flakes)
- test-http-client-abort-keep-alive-destroy-res.js: PASS (flaky — baseline also flakes)
- test-http-agent-reuse-drained-socket-only.js: PASS
- test-http-client-abort-keep-alive-queued-tcp-socket.js: PASS (fixed graceful abort)
- test-http-abort-client.js (previously fixed in PR #223): still PASS (no regression)

Note: several tests exhibit flakiness (intermittent hangs) that exists in the
baseline (58f49742, before keep-alive changes) too. The keep-alive fix resolves
the deterministic hangs; the remaining flakiness is a pre-existing race
condition needing separate investigation.

## Remaining gap
One test still fails (not hangs):
- test-http-client-abort-keep-alive-queued-tcp-socket.js: the queued-request
  abort path emits an 'error' with ECONNRESET, but the test asserts no error
  event. Needs investigation of Node's exact abort-during-queue semantics —
  whether the error should be swallowed or the abort handled differently.

## Branch
- `feat/http-agent-pooling` (from main b627e6ce)
- PR #227: https://github.com/MarketingPip/bundleVFSModules/pull/227
- Commits: 81c8e3b0, 63760f19, 58f49742 (PR #227) + c10c5090 (this lane)
