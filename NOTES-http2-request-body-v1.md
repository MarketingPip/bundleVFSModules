# H2-V1 — http2 request-body delivery

Ship: PR #___ / merge SHA ___

## Problem

Request bodies arrived empty on the server side. Two stacked causes,
both probe-proven in this lane:

1. **Dispatch-timing snapshot.** `_dispatchVirtualStream` ran on the next
   microtask and `Http2ServerRequest` snapshotted
   `this._body = stream.requestBody` at construction — before the client
   had written anything. A 139,837-byte piped file arrived as 0 bytes
   (`src/http2.js:879,1236,1258-1301` pre-fix).
2. **Write routing.** `Http2Stream.write()` routed by `_responseStarted`,
   so once the server called `respond()`, the client's continued request
   writes landed in `_responseChunks` instead of `_requestChunks`. Even
   after `finish`, `requestBody` was empty (probe: `deliver runs, body
   len= 0` while the bytes later surfaced as response data).

## Oracle

Real Node compat `Http2ServerRequest` is a real Readable; the underlying
`Http2Stream` emits `data` as DATA frames arrive
(`hidden_files/node-src/lib/internal/http2/compat.js` `onStreamData` →
`request.push(chunk)`, `onStreamEnd` → `request.push(null)`); `complete` =
aborted || readableEnded || state.closed || stream.destroyed
(`compat.js:345-349`). The shim delivers the whole body as one chunk,
like `_deliverResponse` does for the response.

## Fix (`src/http2.js` only)

- **`write()` routes by `_requestEnded`, not `_responseStarted`.**
  The client writes the request body strictly before it ends the
  request, so until `_requestEnded` any write is a request chunk — even
  after the server has responded. Once the request has ended, writes
  are response data. (The compat `res.write()` path bypasses this
  router via `_writeResponse` directly.)
- **`_deliverRequestBody()`** (idempotent): waits for the client `finish`
  (or a microtask if already ended), then reads `stream.requestBody`
  LIVE, emits `data` (if non-empty) + `end` on the shared stream, then
  runs a pending `_deliverResponse()`.
- **`_deliverResponse()` deferral + single-`end`:** if body delivery
  started but not emitted → set `_responsePending`, return; if not
  started and server-side `data` consumers exist
  (`listenerCount("data") - _dataListenersAtDispatch > 0`) → start
  delivery + set pending, return; else deliver as before, except skip
  the `end` emission if `_requestEndEmitted`.
- **`_responseEnded` gate (added after the zero-length-write
  regression):** `_deliverResponse()` waits for the server to have
  ended the response once the body was awaited — a response body piped
  in the body-end handler must not be lost to an empty early delivery.
  `_responseEnded` is set by a server-classified `stream.end()` and by
  `_endResponse()` (compat `res.end()`). If the body was never awaited,
  the response still delivers from the client's end (base behavior).
- **`Http2Stream.end()` client/server classification:** the stream is
  shared, so `end()` must tell the client's end (completes the request)
  from the server's (completes the response). The client ends exactly
  once, so once `_requestEnded` is set any later end() is the server's.
  For the first end(): already-ended/delivered, or request bytes
  buffered, means the client's end — the server's first end() lands
  synchronously in the dispatch handler, before the client has written
  anything. The server's first end() must NOT mark the request ended.
  The end() payload routes by `_responseStarted` (server response data
  once respond() ran, else request data) — `write()` routes by
  `_requestEnded` instead, so `stream.end("data")` while the client
  request is still un-ended still lands in the response body
  (test-http2-async-local-storage).
- **`_dispatchVirtualStream`** snapshots
  `stream._dataListenersAtDispatch = stream.listenerCount("data")`
  before emitting `stream`/`request`; post-handler trigger starts
  `_deliverRequestBody()` if a server-side `data` consumer attached but
  no response was delivered yet.
- **`Http2ServerRequest.resume()` / `pipe()`** share a
  `_deliverWhenEnded(deliver)` helper — wait for `stream` `finish`, then
  read `stream.requestBody` live; the `body` getter now reads live
  (`this.stream ? this.stream.requestBody : this._body`).
- **`Http2Stream.end()` repeatEnd rule:** once the server calls
  `respond()`, the client's `req.end()` takes the RESPONSE path
  (`_responseStarted` true) instead of marking the request ended, so
  `finish` never fired and delivery waited forever. Fixed by the
  client/server end() classification above (a first end() with request
  bytes buffered, or after the response ended/was delivered, is the
  client's end and marks `_requestEnded` + emits `finish`).
- Comments corrected: `writeContinue()` ("delivers the request body
  regardless" → lazy-once-client-ends) and the `Http2Stream` class
  comment (no longer "no 'data' flow on the server side").

## Regression caught in-lane: test-http2-zero-length-write

The first version of the end() classification (repeatEnd computed
BEFORE `_deliverResponse()`, from delivered/pending only) regressed
this test (base 0 → branch 1): the client ends FIRST (after piping a
file) while the server ends LATER (via pipe in the body-end handler),
so no mark fired and the body was never delivered. The fix is the
classification above (buffered-bytes tiebreaker + the `!_requestEnded`
gate so a second end() is always the server's) plus the
`_responseEnded` gate in `_deliverResponse()` (the response must wait
for the server's end once the body was awaited — the first `_deliverResponse`
call after the body would otherwise deliver an empty response before
the server pipes its own body in). Final state: zero-length-write
[0,0] ×2 on the branch, and the full 41-pass set is 41/41.

## Probes (all `zz-h2v1-*.js` under `parity/node-test/parallel/`, deleted)

- Probe 1 (small sync 2×1000-byte writes): native SERVER end bytes 2000
  then CLIENT response/end; shim (pre-fix) CLIENT response/end first,
  then SERVER end bytes 0 — divergence confirmed cleanly.
- Probe 2/4 (pipe the 139,837-byte fixture into the client stream):
  pre-fix the fs ReadStream never emitted `data`/`end` at all
  (TIMEOUT-HANG). Root cause: shim `Readable.prototype.pipe`
  (`src/stream/readable.js:938+`) registers `dest.once("close",
  onclose)` → `unpipe()` → pauses the source; the shared Http2Stream
  emits `close` from `_deliverResponse` synchronously during dispatch,
  before the fs stream delivers. The lazy-delivery design above is what
  overcomes it (the response `end`/`close` now waits for body delivery).
- Probe 3/5/6/7: fs ReadStream alone works; with http2 loaded + server
  listening works; with a request made (sync write+end, no pipe) works;
  piping into a plain EventEmitter dest works. The stall needs
  `str.pipe(req)` into the Http2Stream specifically.
- Replica `zz-h2v1-cu.js` (client-upload replica): post-fix order is
  SERVER data 139837 → CLIENT end → SERVER end total 139837 match: true
  → CLIENT response → SERVER close.
- Probe 8 (same replica, logging only) hangs cleanly pre-fix; probe 9
  (replica + throwing deepStrictEqual in the `end` handler) OOMs 137 —
  see the assert side finding below.

## Triage correction

`test-http2-client-upload` is **137 (OOM-killed) on base `40db00f5`**,
not the triage's "hangs (124)". The 137 is NOT the http2 body gap: it
is the shim's `assert.deepStrictEqual` formatting a failure on a
139,837-byte Buffer mismatch — probe 12 (`zz-h2v1-assert.js`) OOMs in
~9s under the shim; small-buffer assert failures throw cleanly (probe
`zz-h2v1-assert2.js`: msg len 193 / 126, exit 0). Pre-existing
`src/assert.js` bug, OUT OF SCOPE for this lane (lane is `src/http2.js`
only). After this fix the client-upload assertion PASSES
(`data === fileData`), so the formatting path is never hit and the test
exits 0. A future assert lane should cap/truncate large-buffer diff
formatting.

## Known shared-stream limits (recorded, not regressions)

- A client `end()` with an empty body that lands before any server
  `end()` is indistinguishable from the server's own first `end()`, so
  a server that waits on the body before responding at all still sees
  no body.
- A server `end()` that lands after the client wrote (but before it
  ended) is indistinguishable from the client's `end()` and marks the
  request ended early (partial body, later client writes misrouted to
  the response). No test in the 41-pass set hits either limit.
- A server early-response write while the request is still in flight
  would land in the request body (write-routing by `_requestEnded`).
- The request-body `data` is emitted on the shared stream, so the
  client's `data` listener also sees the request body bytes (they are
  indistinguishable from response data on one object); tests that assert
  on the client `data` while the server reads the body can pass on the
  request bytes. Pre-existing shared-stream behavior, not new.

## Verification

- Targets 2× on branch, 2× on pristine main (`40db00f5`):
  test-http2-pipe [1,1] → [0,0]; test-http2-compat-serverrequest-pipe
  [1,1] → [0,0]; test-http2-client-upload [124,137] (base fails: 124
  timeout on one run, 137 OOM-kill on the other — load-dependent) →
  [0,0]. All 3 flip.
- Guards: H2-F1 ×3 + H2-V2 + H2-V3 ×2 + async-local-storage + binding
  + zero-length-write, isolated on branch + base — all 0 on both.
- Full 41-pass set (sweep-mjs.py + the 41-file list) on the branch:
  41/41, 0 fail.
- Footprint test: 29/29. Jest http2 suite: 66/66 (base is also 66/66;
  the 67 figure in earlier lane notes is stale).
