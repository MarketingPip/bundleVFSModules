# NOTES — test-http-keep-alive-close-on-header

Target: `test-http-keep-alive-close-on-header` failed on main (exit 1) at the
third response's `end` handler: `agent.sockets[name]` was already gone.
Once that was fixed, the exit-time `connectCount === 3` assertion failed
(0 connects observed). Two distinct defects, both in `src/http.js`.

## Defect 1 — agent release removed the socket before response 'end'

The test queues three requests through an `Agent({ maxSockets: 1 })`
(keepAlive off) against a server that answers `Connection: close`. Each
response callback asserts `agent.sockets[name].length === 1`, the third
asserts the same inside the response's `end` handler, and exit asserts
three separate connections were made.

At parser-complete, `_performVirtualRequest` called
`_releaseAgentSocket()` synchronously. For a non-keep-alive agent,
`releaseSocket` destroys the socket and splices it out of
`agent.sockets[name]` immediately — before the response stream's `end`
(nextTick-scheduled) reached listeners. In Node the socket leaves
`agent.sockets` when it actually closes, which is after `end` delivery.

Fix: the release still always happens at message-complete time
(consumed or not), but when the agent is not a keep-alive agent — the
destroy case — it is deferred one turn (`setTimeout 0`). Keep-alive
parking keeps the immediate path.

Two alternatives were tried and rejected on evidence:

- Gating the release on the message's `end`/`close` events fixed the
  target but hung `test-http-agent-uninitialized`, which never consumes
  its response; an unconsumed stream never emits `end`, so the socket
  (and its loop keeper) leaked forever. Node releases at parser
  complete regardless of consumption.
- Deferring by one microtask was not enough: the stream schedules `end`
  only after buffered chunks flush, which can be several ticks later,
  while a microtask fires at the first checkpoint.

## Defect 2 — 'connect' fired before the request's 'socket' event

The test counts connections via the documented pattern
`req.on('socket', s => s.on('connect', …))`. Our agent's `createSocket`
invokes its callback from the socket's `connect` event, so assignment —
and therefore the request's `socket` event — necessarily came after
`connect` had already been emitted. Handlers attached in the `socket`
handler could never observe it (count stayed 0).

An attempt to invoke the create callback early (microtask, before the
handshake) was reverted: a connection that then got refused had no
owner left to clean up the duplicate agent's bookkeeping, and
`test-http-agent-uninitialized` hung.

Fix: `createSocket` now records `_connectedBeforeAssign` on the socket
when its callback runs. After `_performVirtualRequest` emits `socket`,
it replays `connect` once on a microtask for exactly that case, so
handlers attached during the `socket` event observe it. The flag is
cleared on replay and in `reuseSocket`, so pooled sockets never replay
a stale `connect` (Node does not re-emit `connect` on reuse either).

Also removed: `_performVirtualRequest` previously deferred the `socket`
event itself until `connect` when the socket was still connecting —
the same inversion from the other side. It now emits at assignment
time, like Node.

## Verification

- Target passes (exit 0), together with the guard tests
  `test-http-agent-uninitialized`, `test-http-agent-timeout`,
  `test-http-blank-header`, `test-http-chunk-extensions-limit`.
- Jest `http` + `http-socket` + `net` suites and the agent/keep-alive
  parity family re-run for regressions.
