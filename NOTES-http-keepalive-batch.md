# NOTES: per-turn loopback delivery batching (test-http-keep-alive-max-requests)

## Failing assertion (reproduced: exit 1 on base 78dfcb4b)

The test's final phase registers `socket.on("data", common.mustCall(...))`
(expected exactly 1 invocation) for the 3rd request on the first socket,
which must come back `Connection: close`. On the shim the handler fired
twice: "Mismatched <anonymous> function calls. Expected exactly 1,
actual 2."

## Delivery-timing diagnosis (zz probe, shim vs real Node v24.22.1)

The test handler does `res.writeHead(200); res.write("Hello World!");
res.end()` — the streaming path. Delivery observed:

| | shim (base) | real Node |
|---|---|---|
| keep-alive response | 2 events: 181B headers+chunk, then 5B `0\r\n\r\n` | 1 event: 186B headers+chunk+terminator |
| final (close) response | 2 events: 146B + 5B | 1 event: 151B headers+chunk+terminator |

Real Node flushes a synchronous `write();end()` sequence as one TCP
segment, so the client sees headers + chunk + terminator in a single
`'data'` event. The loopback delivers one `'data'` event per
`socket.write`, and the streaming path did two: the first-chunk write
(headers+chunk, coalesced by #267) and the terminator write in `end()`.

The buffered path (`_finishSocketResponse`, end-only responses) already
coalesced headers + body + terminator into one write (for
test-http-1.0-keep-alive, which also counts data events per response).
Only the streaming path split.

## Fix (src/http.js only, ServerResponse)

Streaming frames now pend instead of going straight to the socket
(`_pendFrame` / `_flushPendingFrame`, new fields `_pendingFrame`,
`_pendingFlushScheduled`):

- `_write` (first-chunk and header-flushed paths): frames pend rather
  than `sock.write`. Write callbacks stay synchronous, so Writable
  queue/backpressure behavior is unchanged (#272 unaffected).
- `end()` terminator block: flushes the pending frame together with
  the terminator in a single write, so a synchronous `write();end()`
  reaches the client as one `'data'` event.
- `_finishSocketResponse` streaming branch: same coalescing as a
  fallback (normally `end()` already sent the terminator).
- Microtask flush: covers handlers that stream without ending
  (delivery stays prompt).
- Pipelining guard: `_dispatchSocketRequest` flushes the previous
  response's pending frame at entry and stashes the new response as
  `state.lastResponse`, so pipelined responses can never overtake an
  unfinished one. Proven by a zz probe: handler1 writes a chunk
  without ending, pipelined request2 dispatches, client sees CHUNK1
  before RESP2 (ORDER-OK).
- `_flushHeaders()` keeps its synchronous send: an explicit flush
  means "send now" (test-http-server-consumed-timeout relies on it).

## GC regression caught by differential (and fixed in this lane)

First version of the fix regressed `test-http-server-keepalive-req-gc`
(0 on base, 124 on branch): `state.lastResponse` pinned `res -> req`
(`res.req`), and the client-side socket still links to the server
socket via `_peer` after a graceful FIN, so the finished request stayed
reachable forever — the exact #264 failure mode through a new
reference. Fixed by releasing the stash: `_finishSocketResponse`
clears it when the finishing response is still the stashed one (a
pipelined next request may already have replaced it, and its pending
frame must survive), and the socket close handler clears it next to
the #264 parser-callback release. After the fix, req-gc passes 3/3
runs, and the target + server guards still pass.

## Results

- `test-http-keep-alive-max-requests`: 1 -> 0.
- Guard battery 56 tests: 54 pass; the 2 non-zero are differential-
  proven pre-existing on base 78dfcb4b:
  `test-http-server-incoming-pipelined-socket-destroy` (1 on both),
  and req-gc was 124 on the first version of this branch but is 0
  after the release fix (3/3 runs).
- Keep-alive family, chunked family, proxy, set-trailers, pipeline
  tests, #254 timeout flips, #266 trio, connect/agent-remove,
  multiheaders, highwatermark, nodelay all pass on the branch.

## Out of scope / known gaps left

- `OutgoingMessage._send` still writes chunked frames as three
  separate socket writes; no in-scope test uses it, left untouched.
- The client-side (fetch-backed) response path is untouched; this
  lane covers server responses only.
- `test-http-server-incoming-pipelined-socket-destroy` (exit 1 on
  branch and base) is a separate pre-existing gap.
