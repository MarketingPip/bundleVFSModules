# NOTES — Transfer-Encoding / smuggling group (repeated chunked + smuggling)

## Targets (both exit 1 on base 00de1571, 2/2 runs each)

- `test-http-transfer-encoding-repeated-chunked`: `Transfer-Encoding:
  chunkedchunked` — expects the request handler called exactly once,
  no req `data`/`end`, and exactly `HTTP/1.1 400 Bad Request\r\n
  Connection: close\r\n\r\n` then client `end`. On base the handler
  ran and req `end` fired (shim dispatched it as a no-body request).
- `test-http-transfer-encoding-smuggling`: two cases, both expect the
  handler never called + the same 400 bytes (case 1) / client `end`
  with the socket closed (case 2). Case 1: two TE headers `chunked`
  then `chunked-false` + `Connection: upgrade` + a smuggled
  `GET /flag`. Case 2: `chunked` then ` , chunked-false`. On base the
  shim dispatched both as chunked requests (its TE regex never
  rejected a `chunked`-prefixed coding).

## Real-Node probes (v24.22.1, plain node; /tmp/probe-te-native*.js)

Server side, raw TCP client, one case per fresh server. The rule is
llhttp's two-phase TE validation (confirmed in the generated C,
`deps/llhttp/src/llhttp.c`, Node v24.20.0 tarball):

- Phase 1 — during header parsing, BEFORE onHeadersComplete (no
  dispatch): `HPE_INVALID_TRANSFER_ENCODING`, "Invalid
  `Transfer-Encoding` header value" — duplicate `chunked`, any token
  after `chunked` (`chunked, gzip`; `chunked` + `chunked-false`
  headers), empty element mid/trailing list (`chunked,, chunked`,
  `chunked,`); "Empty Transfer-Encoding" for a bare empty TE value.
  A leading empty element is tolerated (`, chunked` → 200).
- Phase 2 — `llhttp__after_headers_complete` (deps/llhttp/src/http.c),
  AFTER onHeadersComplete (handler HAS run): `HPE_INVALID_TRANSFER_ENCODING`,
  "Request has invalid `Transfer-Encoding`" — TE present but the final
  coding is not exactly `chunked` (`chunkedchunked`, `chunked-false`
  alone, `gzip`/`identity`/`deflate`/`compress` alone, `chunked;
  foo=bar`, `chunked chunked`). Valid: `gzip, chunked`, `chunked`,
  `CHUNKED`, leading-space `chunked`.
- Responses NEVER validate TE: `chunkedchunked` / `chunked, gzip` /
  `gzip` alone on a response is no error — the body just runs to EOF
  when the final coding is not chunked (`gzip, chunked` → chunked
  framing, body `A`). The CL+TE check DOES apply to responses
  (prior #277 probes).
- `--insecure-http-parser` accepts every TE shape above (no error) —
  all new validation is gated on `!insecureHTTPParser`, like the old
  duplicate-chunked check.
- Precedence probed: CL-first + TE `chunked, gzip` reports the CL+TE
  reason ("Transfer-Encoding can't be present with Content-Length"),
  so the CL+TE check runs before structural validation. (Known
  divergence, reason text only: TE-first + invalid TE + a later CL
  reports the CL+TE reason here, where llhttp reports the structural
  one — same code, no official test covers the combination.)
- Trailing-tab divergence (untested, left): `Transfer-Encoding:
  chunked\t` is invalid on real Node, but the shim trims SP/TAB off
  header values before this code sees them, so it stays accepted.

## Root causes (two, one fix each)

1. `_http_parser.js` `_finishHeaders` had no TE grammar at all: a
   substring regex (`/(^|[, \t])chunked([, \t]|$)/i`) decided chunked
   framing, and only duplicate-`chunked` was rejected. Any other
   `chunked`-ish value sailed through as chunked (smuggling) or as
   no-body (repeated-chunked).
2. `_dispatchSocketRequest` (src/http.js) finished the request body
   synchronously at dispatch (`if (!info.hasBody) req._finishBody()`),
   before the parser's post-dispatch validation could raise the
   phase-2 error — so even once the parser rejected the TE, req `end`
   had already been scheduled. Real Node decides message completion
   in the parser after dispatch; the dispatch-time finish predates
   the onMessageComplete wiring (#99) and is redundant with it
   (`_finishMessage` → onMessageComplete → `_finishBody()`, same
   tick, same `end` delivery, plus the awaitingBody/receiving/current
   bookkeeping the direct finish skipped).

## Fix (src/_http_parser.js + src/http.js only)

- Parser: each TE value is split into comma-separated elements
  (OWS-trimmed, leading empties dropped). Framing follows the FINAL
  element only (`chunked` ⟺ last element is exactly `chunked`,
  case-insensitive) — so `chunked, gzip` is EOF framing on both
  sides, matching the response probe. After the CL+TE check,
  request-only + strict: empty value → "Empty Transfer-Encoding";
  no codings / empty middle-trailing element / duplicate chunked /
  chunked-not-last → "Invalid `Transfer-Encoding` header value".
  After `onHeadersComplete`, request-only + strict: TE present and
  not chunked → "Request has invalid `Transfer-Encoding`".
  The old duplicate-chunked block is subsumed by the general check
  and removed; the CL+TE check itself is untouched.
- Server dispatch: the `if (!info.hasBody) req._finishBody()` line
  is deleted (comment records why). No-body completion now comes
  solely from `_finishMessage` → onMessageComplete. Verified
  redundant: for requests `!hasBody` ⟺ `completeNow`, and
  `_dispatchSocketRequest` has exactly one caller
  (parser.onHeadersComplete).

## Results

- `test-http-transfer-encoding-repeated-chunked`: 1 → 0 (3/3)
- `test-http-transfer-encoding-smuggling`: 1 → 0 (3/3)
- Guards 44/44 (each ×2 where noted): chunked, chunked-304,
  chunked-smuggling, client/server-reject-chunked-with-content-length,
  content-length, content-length-mismatch, invalid-te,
  server-de-chunked-trailer, multiple-headers, keep-alive,
  keep-alive-timeout, expect-continue, expect-handling,
  information-headers, upgrade-server/client/client2, server-close-idle,
  server-close-all, server-close-idle-wait-response, 1.0,
  1.0-keep-alive, chunk-extensions-limit, missing-header-separator-lf,
  server-reject-cr-no-lf, client-error-rawbytes, client-parse-error,
  proxy, server-optimize-empty-requests, server-response-standalone,
  server-keepalive-end, req-res-close, server-timeouts-validation,
  client-reject-cr-no-lf, double-content-length,
  response-multi-content-length, head-throw-on-response-body-write,
  get-pipeline-problem, blank-header. (Three first-pass "failures"
  were my own wrong filenames — `test-http-de-chunked-trailer`,
  `test-http-close-idle`, `test-http-close-all` do not exist; the
  real `server-*` names all pass. Same trap as the #324/#326 lanes.)
- Full 397 differential via fast-sweep (see below): exactly 2 lines
  toward pass, zero pass-to-fail.

## Related targets — NOT flipped (different root causes, follow-ups)

- `test-http-chunk-problem`: exit 1 on base and branch. The test
  spawns child `node` processes via `cp.exec` shell piping; the child
  dials the virtual port over real TCP → ECONNREFUSED. Same
  architectural gap as pipeline-flood (held lane 11: cross-process
  virtual-server reachability). NO-FIX in this lane; the only Node
  behavior it exercises (chunked response framing) is already in the
  shim (map-part-te-headers.md agrees).
- `test-http-dump-req-when-res-ends`: exit 1 on base and branch
  (`req.listenerCount("data")` 1 vs expected 0 when `res.end()`
  dumps the paused request). Root cause is the missing
  `IncomingMessage._dump()` (`lib/_http_incoming.js:502`, called from
  `lib/_http_server.js:1115` on response finish) — the shim only has
  the `_dumped = false` flag. Separate lane, not TE grammar.

## Debug notes

- A `clientError` listener SUPPRESSES the automatic 400 + socket
  destroy (onError returns early) — a debug probe with one attached
  hangs the client and misleads; the real tests attach none.
- The repeated-chunked `end` was traced with a zz probe wrapping
  `req._finishBody`/`push`: the call came from
  `_dispatchSocketRequest` during dispatch, not from socket close.
