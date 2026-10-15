# HTTP Agent Socket Pooling — Working Notes

## Problem
8 http parity tests hang (30s timeout, silent — no output):
1. test-http-abort-queued.js ✅ PASSES now
2. test-http-aborted.js ⏳ still hangs
3. test-http-after-connect.js ⏳ still hangs
4. test-http-client-abort-keep-alive-queued-tcp-socket.js ❌ fails fast (not hang)
5. test-http-agent-maxsockets-respected.js ⏳ still hangs
6. test-http-agent-reuse-drained-socket-only.js ❌ fails fast (not hang)
7. test-http-agent-timeout.js ⏳ still hangs
8. test-http-client-abort-keep-alive-destroy-res.js ⏳ still hangs

## Root cause
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

## What was implemented

### AgentBase (src/http.js)
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
- `reuseSocket(socket, req)`: marks `_agentReused`, calls `req.onSocket`

### ClientRequest (src/http.js)
- Constructor calls `agent.addRequest(this, ...)` synchronously (Node parity)
- New `onSocket(socket)`: assigns socket, resolves waiting promise
- New `onSocketError(err)`: rejects waiting promise or emits error
- New `_releaseAgentSocket()`: returns socket to agent pool (or destroys)
- `_performVirtualRequest`: waits for agent socket assignment instead of
  direct `netConnect()`; releases socket via `_releaseAgentSocket()` on completion
- `destroy()`: rejects pending socket promise with ECONNRESET; removes socket
  from agent tracking
- Auto-adds `Connection: keep-alive` header when `agent.keepAlive` is true

### _socketHttpRoundTrip
- No longer destroys socket on settle; caller owns lifecycle
- Handles already-connected sockets (queueMicrotask instead of waiting for
  'connect' event that already fired)

## Remaining gaps (5 tests still hang)
The remaining hangs involve server-side keep-alive socket lifecycle:
- When the server ends a response, the virtual socket gets destroyed even
  though `Connection: keep-alive` was sent
- `info.shouldKeepAlive` is computed correctly by the parser, but the socket
  is destroyed by stream autoDestroy before the agent can reuse it
- Setting `socket.autoDestroy = false` didn't prevent it — the destroy comes
  from `stream/writable.js` finish handler

These require deeper changes to the server-side socket lifecycle (ServerResponse
+ net.js virtual socket interaction), beyond minimal agent pooling.

## Test results
- test-http-abort-queued.js: PASS (was hanging)
- test-http-client-abort-keep-alive-queued-tcp-socket.js: FAIL fast (was hanging)
  - Unexpected 'error' event with ECONNRESET (test has mustNotCall on error)
- test-http-agent-reuse-drained-socket-only.js: FAIL fast (was hanging)
  - ECONNREFUSED — socket reuse not working due to server-side destroy
- 5 others: still hang (server-side keep-alive socket lifecycle)

## Branch
- `feat/http-agent-pooling` (from main b627e6ce)
- Commits: 81c8e3b0, 63760f19, 58f49742
- Pushed to GitHub via git-push-api.py
