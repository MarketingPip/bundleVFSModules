# NOTES — Agent listener leak (triage round-2 Lane 11)

Target: `test-http-client-request-listeners-leak` (exit 1 → 0).

## Node behavior (grounded)

`lib/_http_client.js:1155` `onSocketNT`: when the socket is assigned to a
request that is already destroyed, and the socket is not destroyed and the
request has an agent, Node does NOT destroy the socket — it emits `'free'`
on it (`socket.emit('free')`) and removes the error listener. The agent's
`'free'` handler (`lib/_http_agent.js:201`) then pools the socket (or hands
it to a queued request). `ClientRequest.destroy()` itself (`lib/_http_client.js:683`)
only destroys `this.socket` — but at destroy time the socket is not yet
assigned (assignment happens on nextTick via `onSocketNT`), so the destroy
never touches it. Net effect: destroying a request immediately after
`http.get()` leaves one live socket in the free pool, and the next cycle
reuses it — `createSocket` is called exactly once across 11 cycles, and no
`MaxListenersExceededWarning` fires (the error listener comes off at free).

## Shim gap

The shim assigns the socket synchronously at creation
(`AgentBase.createSocket` → `req.onSocket(socket)`), so by the time the
user's synchronous `req.destroy()` runs, `this.socket` is already a real
socket. Both destroy paths then killed it:

- `ClientRequest.destroy()` deferred the socket destroy one macrotask
  (`setTimeout(0)`, pre-round-trip) — it fired after the cycle's promise
  settled, destroying the socket instead of pooling it.
- `_performVirtualRequest`'s abort continuation (the microtask after the
  socket wait resolves) called `agent.removeSocket` + the same deferred
  destroy — removing the socket from tracking before the next cycle's
  `addRequest` ran.

Each cycle therefore created a new socket: `createSocketCount === 11`.

## Fix (`src/http.js` only)

New shared helper `ClientRequest._releaseDestroyedSocket(sock)`, used at
both sites. It releases the socket via `agent.releaseSocket` (which parks
it in the free pool, removes the request listeners, emits `'free'` on the
socket and the agent, drains the queue, and keeps `totalSocketCount`
exact — a pooled socket still counts) and returns true; it returns false
when the caller must destroy instead:

- no agent (request-level factory socket — Node destroys those),
- a socket the agent does not own (`sock._agent !== agent`),
- an already-destroyed socket (a factory-queued error destroy, e.g.
  `test-http-client-abort3` — the close listener owns cleanup),
- a round trip that started meanwhile (`_roundTripStarted`).

Two call sites:

1. `_performVirtualRequest` abort continuation: the release is
   synchronous. This is the shim's assignment point (the equivalent of
   Node's `onSocketNT`), and it must run before the request's
   `'error'`/`'close'` settle the caller's promise — the next cycle's
   `addRequest` must already find the socket pooled. The old
   `removeSocket` + deferred destroy runs only when the helper
   returns false.
2. `ClientRequest.destroy()`'s deferred `setTimeout(0)` callback:
   backstop for shapes where the round trip never runs (no `end()`
   call), so no continuation releases the socket. It also skips the
   destroy when the socket was already released/pooled meanwhile
   (`_inFreePool` or `_socketReleased`), so a pooled — possibly
   already reused — socket is never destroyed by a stale timer.

## Verified

- Target 0×2 on branch.
- Probe (zz-al-probe, deleted after use): `createSocketCount = 1` across
  3 cycles, `'free'` emitted per cycle, socket ends in the free pool
  with `totalSocketCount = 1`.
- Real-Node probe: the test passes on real Node v24.22.1 (it is a
  shim-behavior gap, not a test-shape issue).

## Ceiling / scope limits

- A socket released here is re-validated on checkout by `addRequest`
  (`_handle` / destroyed / ended checks); an unconnected pooled socket
  is fine because the round trip waits for `'connect'` before writing.
- `destroy()` before `end()` on a request whose socket was assigned
  synchronously is the only shape the deferred backstop covers; a
  factory socket keeps the old destroy path unchanged.
