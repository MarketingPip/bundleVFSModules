# test-http-chunk-extensions-limit — diagnosis and fix

Status: FIXED on `fix/http-chunk-extensions-limit` (target test exits 0).

The test has three blocks: an oversized chunk extension sent whole (expects a
413), the same sent in pieces (expects a 413), and three under-limit chunks
whose extensions must reset per chunk (expects a 200 "bye", chunked). Three
separate defects were stacked behind one test name:

## 1. Request dispatch raced socket EOF — and lost

`_dispatchSocketRequest()` emitted `request` via `queueMicrotask()`, but the
virtual transport's EOF handling runs on `process.nextTick`, which drains
*before* the microtask queue. For a client that sends a request and
half-closes in one write (`sock.end(bytes)`, as this test does):

1. parser executes, dispatch is queued as a microtask;
2. the peer FIN is delivered; the server socket (allowHalfOpen=false)
   auto-ends its writable side and is destroyed;
3. only then does the microtask fire `request` — the handler runs, the
   buffered body drains, `req` emits `end`, the response finishes, and
   `_finishSocketResponse()` finds `socket.destroyed` and writes nothing.

The client sees `end` with an empty response (block 3's original failure:
assertion at line 141, actual `''`).

Fix, mirroring Node's architecture:

- Dispatch `request` **synchronously** from `_dispatchSocketRequest()`
  (Node's `parserOnIncoming` emits synchronously during parse). The handler
  attaches its `req` listeners before the body is fed and before any FIN
  queued behind the chunk is processed.
- The HTTP layer owns EOF close decisions on accepted sockets:
  `_onSocketConnection()` sets `socket.allowHalfOpen = true`, the socket
  `end` handler latches `state.peerEnded` instead of letting the stream
  layer auto-end mid-response, and `_finishSocketResponse()` treats
  `peerEnded` as not-keep-alive, closing after the response is written.

## 2. Split request bodies deadlocked in `state.pending`

While a request was in flight and awaiting its body, the socket `data`
handler parked incoming chunks in `state.pending`, drained only after the
response finished — but the response waits for the body, so a body sent in
a second write never arrived. Block 2 hung; the hang was masked until now
because block 3's assertion threw first and killed the process.

The parser is the authority on message boundaries: it consumes body bytes
for the in-flight message and pauses between messages
(`pauseBetweenMessages`), buffering any pipelined remainder internally.
Fix: while `state.awaitingBody`, feed the parser (`parser.execute(chunk)`)
instead of parking the chunk.

## 3. Content-Length shortcut rewrote committed headers

For block 3's expected bytes, `writeHead(200, {...})` + `end("bye")` must be
`Transfer-Encoding: chunked`, but the buffered path in
`_finishSocketResponse()` replaced the already-rendered header's ending
with `Content-Length: 3`. Node frames with Content-Length only when the
header is rendered implicitly by `end()` itself (length known at first
flush); an explicit `writeHead()` commits the headers, so the body chunks.

Fix: `ServerResponse._implicitHeader()` now marks `_headersImplicit`; the
Content-Length shortcut requires it, and an explicit `writeHead()` with no
length framing goes through the chunked serializer instead.

## Verification

- `test-http-chunk-extensions-limit`: fail (empty response) → exit 0.
- `tests/http.test.js` + `tests/net.test.js`: 135/135.
- Parity spot checks unchanged: test-http-1.0, test-http-1.0-keep-alive,
  test-http-chunked-304, test-http-chunked-smuggling all exit 0.
- `tests/http-socket.test.js`: 28 pass / 8 fail vs the clean-main baseline
  of 27 pass / 9 fail — no regressions, and "100-continue is acknowledged
  before the body" now passes (it timed out on main; the synchronous
  dispatch fixed its reentrant body pull as well). The remaining 8 failures
  are the identical pre-existing client-loopback timeouts (separate bug,
  own lane in the parity queue).
