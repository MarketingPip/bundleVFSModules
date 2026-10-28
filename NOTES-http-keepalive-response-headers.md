# NOTES — HTTP/1.1 keep-alive response framing (fix/http-keepalive-response-headers)

## Target test

`test-http-server-keep-alive-defaults`: 124 (hang) on base main `7c4101c0`
(PR #258) → 0 after this change. Its sibling
`test-http-server-keep-alive-max-requests-null` already passed on base and
still passes.

## Root cause: three stacked defects, not one

The test sends 4 pipelined POSTs over a raw socket and split-counts the
response bytes, requiring `Connection: keep-alive` + `Keep-Alive: timeout=5`
in every response. It hung for three independent reasons, fixed in this PR
in order of discovery:

### 1. ServerResponse sent neither header (src/http.js `_storeHeader`)

`_storeHeader` only ever appended `Connection: close` (when the connection
would not be kept alive). Keep-alive responses went out with just
`Date`/`Content-Type`/`Transfer-Encoding: chunked`, so the test's
`assertResponse` threw inside the socket data handler, `socket.end()`
never ran, and the process never exited.

Real-Node rules probed on v24.22.1 (not trusted from the lane-1 summary —
re-probed, including the cases the summary did not cover):

- Keep-alive response → `Connection: keep-alive` + `Keep-Alive: timeout=N`,
  N = floor(server.keepAliveTimeout / 1000): 5000 → 5, 10000 → 10,
  1500 → 1, 5999 → 5, 500 → 0.
- keepAliveTimeout = 0 → `Connection: keep-alive` with NO `Keep-Alive`
  header at all (the header is omitted, not `timeout=0`).
- Non-keep-alive response (1.1 + `Connection: close` request, or 1.0
  without length framing) → `Connection: close`, no `Keep-Alive`.
- HTTP/1.0 + `Connection: keep-alive` + Content-Length response →
  keep-alive + timeout=5 (1.0 keep-alive works when framing allows it);
  1.0 + `TE: chunked` advertised → chunked + keep-alive.
- App-set `Connection` ALWAYS wins: app `close` → close with no
  `Keep-Alive` added; app `keep-alive` → keep-alive with no `Keep-Alive`
  added; app `Upgrade` → kept as-is. App-set `Keep-Alive: timeout=99`
  is kept verbatim while Node still adds `Connection: keep-alive`.
- 304 + app `Transfer-Encoding: chunked` on a keep-alive request →
  `Connection: close` (framing error forces close).
- 204 (no TE) on a keep-alive request → keep-alive + timeout=5.
- maxRequestsPerSocket = 1 → the limit response carries
  `Connection: close` (and a further request gets 503).

Fix: `_storeHeader` (ServerResponse branch only) now appends
`Connection: keep-alive` + `Keep-Alive: timeout=N` when the connection
will be kept alive, and `Connection: close` otherwise, gated on the app
not having set `Connection` itself (and not having removed it —
`_removedConnection` respected on both branches). The keep-alive
decision mirrors `_finishSocketResponse`'s: `shouldKeepAlive` (already
folded with the no-body-with-TE rule by `writeHead`), the max-requests
budget (`max === 0 || max == null || reqNo < max` — null means
unlimited, matching Node and keeping keep-alive-max-requests-null
green), and HTTP/1.0 length framing (Content-Length / Transfer-Encoding
present, or a `TE: chunked` request). Server inputs are stashed on the
response at dispatch (`_serverKeepAliveTimeout`,
`_serverMaxRequestsPerSocket`, `_serverReqNo`); fallbacks cover
responses not built by that path (unlimited budget, 5000 ms default).
ClientRequest framing is untouched (the branch checks
`instanceof ServerResponse`).

### 2. Chunked terminators bunched after all responses (ServerResponse `end()`)

Even with correct headers the test still hung: the chunked `0\r\n\r\n`
terminator was written only by the async `finish` listener, which fires
after the parser has dispatched (and flushed) the next pipelined
response — so all four terminators arrived after all four responses.
Real Node terminates each response before the next response's bytes.

Fix: `ServerResponse.end()` now writes the terminator synchronously
when headers were already flushed and chunked streaming is active
(`_headerFlushed && _chunkedStreaming`), in call order; the finish
listener skips it via `_chunkTerminatorSent`. Safe because the flushed
`_write` path is synchronous (verified by probe: an `end("World!")`
final chunk reaches the socket before `end()` returns). Buffered
(non-flushed) responses are untouched — their headers go out at finish
time together with the terminator, so they were already correctly
ordered.

### 3. One chunked frame per delivery event, and listener throws wedging the write queue

Even with (1) and (2) the test still hung, for two sub-reasons found by
instrumenting the byte stream:

(a) The flushed path wrote each chunked frame as THREE socket writes
(size line, body, CRLF). The test's `buffer.trim().split("\r\n\r\n")`
counting then false-triggers on the bare size-line event: `trim()`
strips the trailing CRLF, creating a phantom 8th part (`"c"`) whose
body lacks `Hello World!`, so `assertResponse` throws on an incomplete
response. Fix: one `Buffer.concat` write per frame in both
`ServerResponse._write` and the `_flushHeaders` drain loop.

(b) That throw used to wedge the writer: `Socket._write` →
`_deliverToPeer` → `peer.push` → `emit("data")` runs synchronously, so
a listener throw skipped `cb()` (the Writable onwrite) and stalled the
server socket's write queue forever, with the process staying alive
(proven with a throw-in-handler probe: delivery stopped after the
throwing event). Fix: `_deliverToPeer` in src/net.js now runs `cb()`
in a `finally`, so the queue advances; the throw itself still
propagates to the writer's own catch (`ServerResponse._write`
swallows it) exactly as before. Residual note: `_flushPendingWrites`
still aborts its loop on a throwing delivery (pre-connect buffered
writes only); left as-is, out of this test's path.

### 4. First-write headers + chunk coalescing (and its guard)

`test-http-keep-alive-max-requests` (124 on base) exposed the next
layer: its handler asserts on every `buffer.endsWith("\r\n\r\n")`
event, and the shim delivered response headers as their own event
before the body — so the handler asserted on a headers-only buffer
with `body === undefined`, the throw was swallowed by the delivery
path, and the request sequence derailed (the second request was never
sent; the "final" request was really only the second dispatch, so it
carried keep-alive instead of close). On real Node the first write
sends headers + chunk together, so the first event never satisfies
`endsWith` on headers alone.

Fix: `ServerResponse._write` now sends headers + first chunk as ONE
write when headers are rendered and the write is explicit (shared
`_streamingHeader()` helper with `_flushHeaders`, which still sends
headers alone on explicit `flushHeaders()`). Excluded when finishing:
`end(chunk)` sets `finished` before its internal write, so end-chunks
stay buffered and the finish path sends headers + body + terminator
as one write — tests counting data events per response
(`test-http-1.0-keep-alive`, which regressed to 1 without this guard
and is 0 with it) rely on that.

Remaining gap for that test (NOT fixed here): its final handler is
`mustCall` (exactly 1 data event), but a write + end response still
arrives as two shim events (coalesced frame, then terminator),
whereas real Node loopback coalescing usually delivers it as one.
Closing that gap needs per-turn delivery batching in the loopback
layer — a separate architectural change, out of this PR's scope. The
test moved 124 → 1 (it now reaches its assertions); it is not a
regression of a passing test.

## Verification

- Target: `test-http-server-keep-alive-defaults` 124 → 0 (three runs
  after the final change shape; also verified the byte stream shows
  `Connection: keep-alive` + `Keep-Alive: timeout=5` on all four
  responses with correctly interleaved terminators).
- Bonus movement: `test-http-keep-alive-max-requests` 124 → 1 (now
  reaches its assertions; remaining failure is delivery-event
  granularity, see §4 — not a regression, it never passed).
- Guard sweep: full server/agent/keep-alive/chunked/outgoing/
  blank-header/pipelined/1.0 families + the twelve PR #254 timeout
  flips, run twice (before and after the first-write coalescing
  change); every failure reproduced identically on pristine main
  `7c4101c0` before being called pre-existing, except the two
  changed-failure-mode cases documented here:
  `test-http-keep-alive-max-requests` (124 → 1, see §4) and
  `test-http-outgoing-buffer` (pristine aborts with heap OOM, this
  branch times out at 30 s — same underlying pre-existing defect,
  bare `OutgoingMessage.write()` never returning false, which this
  change does not touch; only the symptom timing differs).
- Repo tests: `tests/ondemand-require.test.js` 29/29 (footprint
  allowlist set to this branch's exact file set).

## Files changed

- `src/http.js` — keep-alive/close framing in `_storeHeader`
  (including `, max=N`), dispatch stashing, synchronous chunked
  terminator in `end()` + finish-listener skip flag, one-write chunked
  frames, first-write headers + chunk coalescing (with the
  end-chunk guard for per-response event counting).
- `src/net.js` — `_deliverToPeer` `cb()` in `finally`.
- `NOTES-http-keepalive-response-headers.md` — this note.
- `tests/ondemand-require.test.js` — footprint allowlist only.
