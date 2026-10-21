# test-http-agent-uninitialized — diagnosis and fix

Status: FIXED on `fix/http-agent-uninitialized` (target test exits 0).

The test constructs a `ClientRequest` (which registers with the default
global agent), then manually calls `addRequest` on a *second*, keep-alive
agent whose free pool has been stuffed with a bare `net.Socket` that has
no `_handle`. Four defects were stacked behind the hang — and the same
root defect was also behind the long-standing `tests/http-socket.test.js`
client-loopback timeouts.

## 1. `onSocket` swallowed every asynchronous socket assignment

`ClientRequest.onSocket()` began with `if (this.socket) return;` — a guard
added in b6678070 (PR #235) to ignore duplicate assignments from a second
agent. But the constructor installs a `FakeSocket` placeholder whenever
the agent doesn't assign synchronously, so by the time an async
`createSocket` callback delivered a real socket, `this.socket` was always
truthy and the delivery was dropped. `_performVirtualRequest()` then
waited on `_onSocketAssigned` forever: the request never reached the
server.

Fix: only a *real* socket counts as an assignment —
`if (this.socket && !(this.socket instanceof FakeSocket)) return;`

This one-line narrowing is also what unblocked the Jest loopback suite:
the 8 `http.request()` round-trip tests that timed out at 30s each on
main were waiting on the same swallowed delivery.

## 2. A redundant creation attempt could fail a completed request

With the guard fixed, both agents race: the global agent's socket wins
and serves the request; the manual agent's socket is still connecting
when the server closes, its pending accept is refused, and the
`addRequest` create callback forwarded that ECONNREFUSED to the already
-completed request as an unhandled `error` event.

Fix: in `AgentBase.addRequest`'s create callback, if the request already
holds a real socket, a redundant attempt's error is swallowed (and a
redundant *successful* socket is removed from tracking and destroyed
instead of leaking an open connection).

## 3. Pooled free sockets were never reaped

With 1 and 2 fixed, the request completed — but the process still
couldn't exit: the winning socket sat in the global agent's free pool,
its server-side pair open, holding the loop forever. `releaseSocket()`
parked sockets with no idle lifetime. Node's default agent
(`keepAlive: true, timeout: 5000`) destroys idle pooled sockets after
the timeout; that reaping is what lets this test's process exit.

Fix: when parking a socket, if the agent's `options.timeout` is set, arm
an (unref'd) timer that removes and destroys the socket if it is still
pooled when the timeout elapses. `reuseSocket()` cancels the timer on
checkout; the idle-error path clears it too.

## Verification

- `test-http-agent-uninitialized`: hang → exit 0 (~5.5s, the reaper).
- `tests/http-socket.test.js`: **36/36 pass in 0.8s** (clean-main
  baseline: 27/36 with ~240s of timeouts; after PR #239: 28/36).
- `tests/http.test.js` + `tests/net.test.js`: 135/135.
- Parity unchanged: test-http-chunk-extensions-limit,
  test-http-1.0-keep-alive, test-http-chunked-304, test-http-agent-getname,
  test-http-agent-maxsockets, test-http-agent-no-protocol all exit 0.
- `test-http-agent-timeout` hangs identically on pristine main —
  pre-existing, not a regression (queued separately).
