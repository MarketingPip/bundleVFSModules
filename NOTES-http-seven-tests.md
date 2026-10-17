# Working Notes: 7 net-using HTTP tests (feat/http-seven-tests)

## Branch: feat/http-seven-tests (from 55db71dd)

### test-http-1.0 — FIXED
**Root cause:** Shim's ServerResponse had no `_send` method. Test calls `res._send("")`.
In file mode, `res._send` was undefined → TypeError → server dispatch caught → 
`clientError` → `socket.destroy()` → response truncated.

**Fixes in src/http.js:**
1. Added `OutgoingMessage._send(data, encoding, callback)` — ports Node's `_send`
   onto shim's `_flushHeaders`/`_chunkedStreaming` machinery. Calls `_implicitHeader()`
   if no header, `_flushHeaders()` if not flushed, writes directly to socket
   (chunked-framed if streaming, else raw).
2. Added `Connection: close` in `_storeHeader` after app headers (not before) when
   `!shouldKeepAlive && !flat.connection && ServerResponse`. Node appends it after
   app headers.
3. Sync `res.shouldKeepAlive = info.shouldKeepAlive` in `_dispatchSocketRequest`.
   (OutgoingMessage constructor sets it true; nothing was syncing from request.)

**Lesson:** Debug via test files under `parity/node-test/parallel/`, never `-e`.
The `-e` mode leaks native http (preload redirect doesn't apply same way), hiding
the bug.

### test-http-1.0-keep-alive — HTTP BEHAVIOR FIXED (pre-existing net hang remains)
**Native behavior (captured):**
- 1.0 + keep-alive, no length → Server sends `Connection: keep-alive` (echoed) but
  CLOSES (no auto Content-Length for 1.0).
- 1.0 + `TE: chunked` request → Server uses chunked encoding, keeps open.
- 1.0 + app `Transfer-Encoding: chunked` → chunked, keeps open.
- 1.0 + app `Content-Length` → keeps open.

**Fixes:**
1. `res._reqHadTE` flag from `req.headers.te` in `_dispatchSocketRequest`.
2. `_flushHeaders`: allow chunked for 1.0 if `_reqHadTE`.
3. `_finishSocketResponse` buffered path: don't auto-add Content-Length for 1.0.
4. Keep-alive decision: for 1.0, require explicit framing (`Content-Length` or
   `Transfer-Encoding` in `_renderedHeaders`, or `_chunkedStreaming`).
5. Buffered path: inject `Transfer-Encoding: chunked` header + frame body as chunks
   when 1.0 + `_reqHadTE`.
6. Coalesce headers+body into single `socket.write()` (test counts data events;
   Node coalesces).

**Pre-existing issue:** Process hangs after test (2 client sockets not destroyed).
Baseline also hangs. Virtual-net lifecycle issue, not HTTP semantics.

### test-http-agent-uninitialized — FIXED
**Root cause:** Test manually stuffs bare `net.Socket()` (no `_handle`) into
`agent.freeSockets`, then `agent.addRequest(req, {})`.
1. `getName(req)` vs `getName({})` mismatch → free socket not found.
2. `createSocket` used `options.port` (empty) → port 80 → ECONNREFUSED.
3. Constructor's `globalAgent.addRequest` + manual `addRequest` → duplicate;
   late `onSocket` overwrote working socket.

**Fixes:**
1. `addRequest`: derive host/port from `req` when options empty, for name computation.
2. `createSocket`: fall back to `req.port`/`req.host`.
3. `addRequest`: skip free socket if `!socket._handle || socket.destroyed` (Node checks
   `_handle` before `asyncReset`).
4. `ClientRequest.onSocket`: ignore if `this.socket` already set (duplicate guard).

### test-http-blank-header — FIXED
**Root cause:** Parser buffered pipelined data while `state.busy`, never processing
it. Test sends valid request (handler called, doesn't respond) + invalid
`\r\nhello world`. Expected 400, got timeout.

**Fixes:**
1. `socket.on("data")`: when `state.busy && !state.awaitingBody`, unpause parser and
   feed data so `onError` can fire → 400. (Dispatch still gated.)
2. `onHeadersComplete`: queue if `state.busy` instead of immediate dispatch.
3. `_finishSocketResponse`: dispatch queued request when keep-alive.

### test-http-chunk-extensions-limit — 413 ENFORCEMENT FIXED
**Root cause:** Parser accepted/ignored chunk extensions (documented out-of-scope).

**Fixes:**
1. `src/_http_parser.js`: if chunk extension > 16384 bytes, throw with
   `err.statusCode = 413`.
2. `src/http.js` `parser.onError`: send `413 Payload Too Large` (without
   Content-Length, matching test) when `err.statusCode === 413`.
3. `_findLine(skipSizeCheck)`: skip header-size check for chunk lines (prevents
   false HPE_HEADER_OVERFLOW on large chunk data).
4. Reset `_headStart` when entering `body-chunked` state.

**Limitation:** Third block (three 10k extensions, expects 200) still fails with
HPE_INVALID_CHUNK_SIZE. Pre-existing parser bug (verified on baseline). The 413
enforcement (test's primary purpose) works.

### test-http-chunked-304 — FIXED
**Root cause:** Buffered path sent `0\r\n\r\n` terminator even for 204/304
(`_hasBody === false`).

**Fix:** Only send terminator `if (!noBodyStatus)`. 204/304/1xx get headers only.

### test-http-chunked-smuggling — FIXED
**Root cause:** Parser accepted `2;\n` (LF instead of CRLF) in chunk size line,
allowing smuggled `GET /admin` to be parsed as second request (handler called twice).

**Fix:** In `_parseChunkedBody`, reject chunk size line containing `\n` or `\r`
(bare line breaks). Throws `HPE_INVALID_CHUNK_SIZE` → 400 → smuggled request rejected.

## Files changed
- `src/http.js` (234 lines)
- `src/_http_parser.js` (28 lines)
- `tests/ondemand-require.test.js` (allowlist update for branch footprint)

## Test results
- test-http-1.0: PASS
- test-http-1.0-keep-alive: HTTP assertions PASS (process hang pre-existing)
- test-http-agent-uninitialized: PASS
- test-http-blank-header: PASS
- test-http-chunk-extensions-limit: 413 blocks PASS (3rd block pre-existing fail)
- test-http-chunked-304: PASS (assertions; exit hang pre-existing)
- test-http-chunked-smuggling: PASS
