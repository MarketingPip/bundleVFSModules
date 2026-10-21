# test-http-agent-timeout — diagnosis and fix

Status: FIXED on `fix/http-agent-timeout` (target test exits 0).

The test has four blocks: reuse of successful keep-alive sockets, timed
-out pooled sockets not being reused, destroyed pooled sockets not being
reused, and a custom `keepSocketAlive()` that overrides the pooled
socket's timeout (60ms must beat the agent option's 50ms, observable via
`socket.timeout`). Three defects:

## 1. Pooled sockets never timed out

`releaseSocket()` parked sockets indefinitely: the agent's `timeout`
option was never applied to them, so a pooled socket never emitted
`timeout` and block 2 waited forever. (PR #240's hand-rolled idle
reaper destroyed pooled sockets silently after the timeout; this
replaces it with Node's actual mechanism.)

Fix: when parking, the agent applies its timeout through the socket's
own timer — `socket.setTimeout(agent.options.timeout)` — and installs a
one-shot `timeout` listener that removes and destroys the socket, so
timed-out sockets are never reused. The socket's inactivity timer emits
`timeout` exactly like Node (and is what lets processes on the default
keep-alive `globalAgent`, timeout 5000, exit — the behavior PR #240
depended on; test-http-agent-uninitialized still passes).

## 2. `keepSocketAlive()` was never consulted

The hook existed on AgentBase but `releaseSocket()` never called it, so
a subclass override (block 4) had no effect. Fix: after applying the
agent timeout, `releaseSocket()` calls `this.keepSocketAlive(socket)`;
a `false` return destroys the socket instead of pooling it. The order
matters: the hook runs last so its `socket.setTimeout(60)` replaces the
agent's 50ms — block 4 asserts `socket.timeout === 60` when `timeout`
fires.

`reuseSocket()` now also removes the pooled `timeout` listener and
disarms the socket timer (`setTimeout(0)`): a checked-out socket is
governed by its request's timeout semantics, not the pool's.

## 3. Round-trip listeners leaked onto reused sockets (pre-existing)

`_socketHttpRoundTrip()` attached `data`/`error`/`close` listeners to
the socket per request and never removed them. On a reused socket, the
previous trip's parser was still attached, so response #2 was parsed by
*both* trips and emitted as `response` on the completed request #1 as
well — block 1's `mustCall` response handler fired twice (verified
identically on pristine main; on main the failure was masked by later
blocks hanging). Fix: the trip's listeners are named and detached in
`settle()`, the single choke point for resolve/reject.

## Verification

- `test-http-agent-timeout`: hang → exit 0.
- `test-http-agent-uninitialized`: still exit 0 after the reaper swap.
- Jest http + http-socket + net: 171/171.
- Parity spot checks exit 0: blank-header, chunk-extensions-limit,
  1.0-keep-alive, chunked-304, chunked-smuggling, agent-getname,
  agent-maxsockets, agent-no-protocol.
- Still failing identically to pristine main (separate queue):
  test-http-client-keep-alive-hint,
  test-http-agent-keep-alive-timeout-buffer,
  test-http-keep-alive-close-on-header, test-http-get-pipeline-problem,
  test-http-incoming-pipelined-socket-destroy.
