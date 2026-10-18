# HTTP Parity Fix — Working Notes

## Branch: fix/http-parity-hangs (from b6678070)

## test-http-chunk-extensions-limit — Root Cause Identified

### The Problem
Block 3 of the test (three chunks with 10KB extensions each, expecting 200 OK)
fails with the client receiving empty data (`actual: ''`).

### Root Cause: queueMicrotask timing in _dispatchSocketRequest

In `src/http.js`, `_dispatchSocketRequest()` emits the 'request' event via
`queueMicrotask()`:

```js
queueMicrotask(() => {
  try {
    this.emit("request", req, res);
  } catch (err) { ... }
});
```

But the HTTP parser (`src/_http_parser.js`) runs **synchronously** in the same
`execute()` call. When a request's headers + body arrive in a single TCP chunk
(which happens with virtual net's `sock.end(data)`):

1. `parser.execute(30110 bytes)` starts
2. `onHeadersComplete` fires → schedules microtask for `emit("request")`
3. Parser continues synchronously → `onBody` → `req.push("AA")` (3x)
4. Parser → `onMessageComplete` → `req._finishBody()` → `req.push(null)` (stream ends)
5. `execute()` returns
6. Microtask runs → handler: `req.on("end", ...)` + `req.resume()` — **TOO LATE**

The 'end' listener is attached after `push(null)` already ran. Our Readable
shim does not emit 'end' for late-attached listeners (unlike Node, where
`resume()` after `push(null)` does fire 'end').

### Why it "passed at merge time"
The test was likely verified with blocks run in a different order/timing, or
the verification didn't catch the single-chunk case. On the merged commit
b6678070, the test fails consistently.

### Attempted Fix (reverted)
Changed `queueMicrotask(() => this.emit("request", ...))` to synchronous
`this.emit("request", ...)`. This fixes the 'end' event — the handler runs,
`req.on("end")` fires, `res.end()` is called.

**But**: the client still receives 0 bytes. The response path has a separate
issue — `res.end("bye")` is called but the data never reaches the client
socket. The socket is not destroyed (`destroyed=false`), but the
`socket.write()` in `_finishSocketResponse` doesn't deliver.

This suggests a deeper issue with synchronous reentrancy: when `res.end()`
is called synchronously inside `parser.execute()`, the socket write may be
lost or the response state machine may be in an inconsistent state.

### Recommendation
The fix needs to address both:
1. Ensure 'request' handler is attached before body completes (timing)
2. Ensure response written synchronously during parser.execute() actually
   reaches the client (reentrancy)

Options:
- **A**: Make the parser pause after headers until the handler runs (complex,
  changes parser contract)
- **B**: Fix Readable to emit 'end' for late listeners (matches Node, but
  broad change to stream implementation)
- **C**: Defer body pushing to next tick (breaks streaming semantics)

None of these are "smallest correct fix" — they all have broad implications.
**Recommend**: deeper investigation by someone with more context on the
stream/socket interaction, or accept this as a known limitation for now.

## The 4 Hangs — Not Yet Investigated

- test-http-1.0-keep-alive
- test-http-agent-uninitialized  
- test-http-blank-header
- test-http-chunked-304

These are likely the known virtual-net orphaned-socket issue (sockets with
`destroyed=false`, no `_peer`, `_eofReceived=false` that never trigger
cleanup). Previous deep-surgery attempts were reverted. Not investigated
in this session due to time spent on chunk-extensions-limit.

## Files Changed
- src/http.js: (reverted, no net change)

## Test Evidence
- test-http-chunk-extensions-limit: FAILS on b6678070 (block 3, `actual: ''`)
- Isolated block 3 via shim: FAILS (len 0)
- Isolated block 3 via real Node http: PASSES (confirming it's a shim bug)
