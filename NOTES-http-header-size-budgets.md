# NOTES — header size budgets (triage round-2 Lane 13)

Targets: `test-http-header-overflow`, `test-http-max-header-size-per-stream`
(both 1→0).

## Node behavior (grounded)

- Limits are llhttp-enforced, JS-configured: server
  `lib/_http_server.js:772` `connectionListenerInternal` passes
  `server.maxHeaderSize || 0` to `parser.initialize` (`:804`
  `parser.maxHeaderPairs = server.maxHeadersCount << 1`); client mirror
  `lib/_http_client.js:1088` (`req.maxHeaderSize || 0`) and `:1098`.
  The binding (`src/node_http_parser.cc` `Initialize`) treats 0 as "use
  the process default" (16384); `storeHTTPOptions`
  (`lib/_http_server.js:508`) validates `maxHeaderSize` as an integer
  >= 0.
- Overflow is raised by the binding's `TrackHeader` on header-field /
  header-value / URL / status spans (`header_nread_ += len; if
  (header_nread_ >= max_http_header_size_)` → `HPE_USER` with reason
  `"HPE_HEADER_OVERFLOW:Header overflow"`); `prepareError`
  (`lib/_http_common.js:301`) builds the message as
  `"Parse Error: " + reason` and `rawPacket` is the chunk passed to
  that `execute()` call. `bytesParsed` is `llhttp_get_error_pos -
  chunk base` — the offset where llhttp stopped, i.e. the end of the
  offending span, not the bytes consumed so far. Probed on real Node
  v24.22.1 (`/tmp/probe-overflow.js`): a single 16405-byte unterminated
  block gives `bytesParsed: 16405` (the whole chunk — the span callback
  runs only after the span is fully scanned); a terminated 17027-byte
  block gives `bytesParsed: 17024` (end of the value span, before the
  CRLF).
- `socketOnError` (`lib/_http_server.js:999-1007`) maps
  `HPE_HEADER_OVERFLOW` to the prebuilt 431 response
  (`HTTP/1.1 431 Request Header Fields Too Large\r\nConnection:
  close\r\n\r\n`) — but only after `clientError` is emitted with no
  listener; `socket.destroy(err)` then surfaces the socket `'error'`.

## What was wrong in the shim

1. The parser's size-overflow message was
   `"header block exceeds maxHeaderSize of N bytes"` (4 throw sites in
   `src/_http_parser.js`); the server/client `onError` normalizers
   prefix the parser's reason to `"Parse Error: <reason>"`, so the
   surfaced message was wrong. Fixed: all four sites now throw reason
   `"Header overflow"` (the pair-budget site already used that text),
   so both owners produce `"Parse Error: Header overflow"`.
2. `bytesParsed` was `this._off - this._headStart` — 20 for the
   header-overflow test (only the start line consumed when the mid-line
   check fired). Fixed: the mid-line throw marks the error
   (`_midLineOverflow`); `execute()`'s catch sets `bytesParsed` to the
   current chunk's length (llhttp consumed the whole in-progress span)
   or, with no new chunk, the bytes buffered for this message. The
   marker is deleted before `onError` fires so the surfaced error
   carries exactly Node's shape. Complete-line overflow sites keep the
   existing fallback — no official test pins their `bytesParsed`.
   The 431 response path itself already existed (`src/http.js`
   `HPE_HEADER_OVERFLOW` → 431, `socket.destroy(err)`); only the
   parser-side message/bytesParsed were wrong.
3. `maxHeaderSize` was validated + stored on `ClientRequest`
   (`src/http.js:3783-3826`) but never threaded to the response
   parser, which kept its `16 * 1024` default; the server never stored
   the option at all. Fixed, mirroring the existing `maxHeadersCount`
   plumbing exactly:
   - client: `onSocket` pooled-parser refresh + `_socketHttpRoundTrip`
     param (call site passes `this.maxHeaderSize`) + assignment at
     round-trip time; `|| 16 * 1024` reproduces the binding's
     0-means-default rule.
   - server: `ServerBase` stores `options.maxHeaderSize` (same
     integer >= 0 validation as the client); threaded to the request
     parser at connection time and refreshed per message (same reason
     as the `maxHeaderPairs` refresh: the shim reuses `Connection:
     close` sockets). `HttpsServerBase` inherits it via
     `extends http.Server`.

## Sub-test status (probed on base before the fix)

`test-http-max-header-size-per-stream`: Test 1 (client `*4`, accept)
and Test 3 (server `*4`, accept) failed; Tests 2 and 4 (default,
must error) already passed. All four pass after the fix.

## Scope limits

- Tests 3–4 of `test-http-max-header-size-per-stream` use
  `stream.duplexPair()` + `server.emit('connection', fakeSocket)`; the
  dispatch itself already worked on base (the failure was purely the
  budget), so no dispatch-surface change was needed — Lane 14's
  foreign-Duplex work is untouched by this lane.
- `test-http-chunk-problem` (NO-FIX, child-process form) and
  `test-http-pipeline-flood` (NO-FIX) are unrelated to this lane.
