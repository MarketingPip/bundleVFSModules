# HTTP Agent Socket Pooling — Working Notes

## Problem
8 http parity tests hang (30s timeout, silent — no output):
1. test-http-abort-queued.js
2. test-http-aborted.js
3. test-http-after-connect.js
4. test-http-client-abort-keep-alive-queued-tcp-socket.js
5. test-http-agent-maxsockets-respected.js
6. test-http-agent-reuse-drained-socket-only.js
7. test-http-agent-timeout.js
8. test-http-client-abort-keep-alive-destroy-res.js

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

## Node's Agent behavior (from training data)
- `addRequest(req, options)`:
  - Compute `name = getName(options)` → `"host:port:localAddress"`
  - If free socket exists for name → reuse (LIFO or FIFO per `scheduling`)
  - Else if `sockets[name].length < maxSockets` → `createSocket()`
  - Else → queue in `requests[name]`
- When response completes: socket moves from `sockets[name]` to
  `freeSockets[name]` (if keepAlive), emits 'free', queued requests are processed
- `req.reusedSocket` = true when socket came from free pool
- `totalSocketCount` tracks all sockets (active + free)

## Implementation plan (minimal)
1. `AgentBase.addRequest(req, options)` — real: try free socket, else create if
   under maxSockets, else queue in `requests[name]`
2. `AgentBase.createSocket(req, options, cb)` — for virtual path, use
   `netConnect(port)`; track in `sockets[name]`, increment `totalSocketCount`
3. `AgentBase.reuseSocket(socket, req)` — assign via `req.onSocket(socket)`
4. `AgentBase.removeSocket(socket, name)` — untrack, decrement count
5. `ClientRequest.onSocket(socket)` — new method: assign socket, resolve
   pending promise in `_performVirtualRequest`
6. `_performVirtualRequest` — wait for agent socket assignment instead of
   direct `netConnect()`; on completion, release socket to agent free pool
   (if keepAlive) or destroy
7. `ClientRequest.reusedSocket` property — set by agent

## Key design decisions
- The agent drives socket creation via `createSocket`, but for the virtual path
  the ClientRequest knows the server port. Pass `{ host, port }` through
  `addRequest` options.
- Socket reuse: virtual sockets are stateful net.js sockets; reuse means not
  destroying after response and reusing for next request to same origin.
- Keep the fetch() path (non-virtual) as-is — agent is metadata-only there.
