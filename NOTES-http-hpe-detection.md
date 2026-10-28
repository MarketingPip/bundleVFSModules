# NOTES — HPE detection: CL+TE and bare-CR header lines

## Targets (both server-side, both exit 1 on base 76acfe6b)

- `test-http-server-reject-chunked-with-content-length`: expected
  `clientError` code `HPE_INVALID_TRANSFER_ENCODING`, no data to the
  client. On base the clientError fired but with code `ERR_ASSERTION`
  (the mustNotCall handler throw routed through onError — the parser
  accepted the headers and dispatched).
- `test-http-server-reject-cr-no-lf`: expected `HPE_LF_EXPECTED`, no
  data, client `end`. Same base failure mode.

## Real-Node probes (v24.22.1, plain node)

### Transfer-Encoding + Content-Length

Rule is total, not chunked-only: ANY Transfer-Encoding header present
with ANY Content-Length header present errors, request and response
sides, with `Parse Error: Transfer-Encoding can't be present with
Content-Length`:

- CL + TE chunked → HPE_INVALID_TRANSFER_ENCODING
- CL + TE gzip (no chunked) → HPE_INVALID_TRANSFER_ENCODING
- CL + TE chunked, gzip → HPE_INVALID_TRANSFER_ENCODING
- CL + TE empty value → HPE_INVALID_TRANSFER_ENCODING
- CL + two TE headers (gzip, chunked) → HPE_INVALID_TRANSFER_ENCODING
- CL + TE chunked on HTTP/1.0 → HPE_INVALID_TRANSFER_ENCODING
- CL 0 + TE chunked → HPE_INVALID_TRANSFER_ENCODING
- Response side CL + TE chunked → same code on req `error`
- 204 / 304 responses with CL + TE chunked → same code
- Client receives no data, then `end` (server test) / req `error`
  (client test).

Ordering note: duplicate Content-Length (even same value) + TE
chunked gives `HPE_UNEXPECTED_CONTENT_LENGTH` ("Duplicate
Content-Length") on real Node — the dup-CL check fires before the
TE check. The shim only rejects *conflicting* CL values
(`HPE_INVALID_CONTENT_LENGTH`); same-value duplicates are still
accepted. That is a separate gap, deliberately NOT fixed here.

### Bare CR in a header line

- `Dummy: Header\rContent-Length: 1\r\n\r\n` → HPE_LF_EXPECTED,
  `Parse Error: Missing expected LF after header value`, no data,
  client `end`.
- CR inside a header value mid-line (`Host: a\rb`) → same code.
- Response side CR-no-LF → same code on req `error`.
- Bare CR in the *start line* (`GET / HTTP/1.1\rX`) is a DIFFERENT
  code on real Node: HPE_STRICT ("Expected CRLF after version").
  The shim currently reports HPE_INVALID_VERSION there. Left
  unchanged — no named test covers it, and changing it is a
  separate decision.

## Root cause (plain terms)

1. `_finishHeaders` preferred chunked framing whenever a TE header
   mentioned chunked and silently ignored Content-Length. No
   CL+TE check existed anywhere.
2. `_findLine` only splits on CRLF, so a bare CR inside a header
   line survived into the line text (`Dummy: Header\rContent-Length:
   1`) and was stored as a value with an embedded CR. No check
   existed for it, so the message dispatched normally.

## Fix (src/_http_parser.js only)

- `_parseHeaders`: after the empty-line check, before the obs-fold
  check, `line.includes("\r")` throws `HPE_LF_EXPECTED` /
  "Missing expected LF after header value". Byte order matches
  llhttp (the CR is hit while scanning the value, before any
  fold judgment). A trailing lone CR at the end of the buffer is
  NOT an error yet: `_findLine` returns null until the next byte
  arrives, so a CRLF split across chunks is never misjudged.
  Start-line behavior untouched (see above).
- `_finishHeaders`: new `hasTransferEncoding` flag (any TE header,
  whatever its value); after the loop, before framing and before
  `onHeadersComplete`, `contentLength !== null &&
  hasTransferEncoding` throws `HPE_INVALID_TRANSFER_ENCODING` /
  "Transfer-Encoding can't be present with Content-Length". The
  existing onError machinery prefixes `Parse Error: `, so the
  clientError message matches real Node exactly. The check sits
  after the loop so the inline conflicting-CL error keeps its
  existing precedence. Shared by request and response paths, and
  uniform across statuses — matching the probes (204/304/1.0
  included).
- Trailer lines deliberately NOT checked: #273 made malformed
  trailer lines lenient by design, and no test covers trailer
  CR-no-LF. Changing that leniency is out of scope.

## Results

- `test-http-server-reject-chunked-with-content-length`: 1 → 0
- `test-http-server-reject-cr-no-lf`: 1 → 0
- Guard battery 46/46 (see below for the regression scare that
  turned into a second real fix).
- Client variants NOT fixed, deliberately: `test-http-client-
  reject-chunked-with-content-length` and `test-http-client-
  reject-cr-no-lf` still exit 1 with `fetch failed`. The shim's
  ClientRequest is fetch-backed; when the target port has a virtual
  *net* server but no virtual *http* server, the request goes to
  real fetch(), which fails against a port nothing real listens
  on. The response bytes never reach the parser, so the parser
  fix cannot help. Client requests to raw net servers need
  loopback response parsing — a separate feature lane, not a
  parser fix. Failure mode unchanged (same `fetch failed`, not a
  regression).

## The parser check exposed a real framing bug (fixed in this lane)

First guard battery: 43/46 — `test-http-keep-alive`,
`test-http-keep-alive-close-on-header`, and
`test-http-keep-alive-timeout-custom` all hung (124) on the branch
while passing on pristine base. Bisected by toggling each check:
the TE+CL check was the culprit, not the CR check. A debug probe
showed the shim's OWN server response carrying BOTH headers:

```
Date, Content-Length: 12, Connection: keep-alive,
Keep-Alive: timeout=5, Transfer-Encoding: chunked
```

for a handler doing `writeHead(200, {Content-Length})` +
`write()` + `end()`. Root cause: `_streamingHeader()` consulted
only `kOutHeaders` via `hasHeader()`, but `writeHead(obj)` headers
live in `_renderedHeaders` only (the known dual-store trap from
#245/#263) — so the app-set Content-Length was invisible and
streaming start added `Transfer-Encoding: chunked` on top. The
single-`end(body)` path was unaffected because
`_finishSocketResponse` already consults both stores.

Fix (src/http.js, `_streamingHeader()`): `hasCL`/`hasTE` now
consult both stores (`hasHeader()` OR `_renderedHeaders[...]`).
After the fix the 3-request keep-alive probe flows fully and all
three hanging tests pass. The client streaming path
(`_streamEnsureStarted`) already consults both stores
(`getHeader` OR `arrayHeader`) — no equivalent trap there.

Lesson: a strict parser check on the client side is only safe
once the shim's own emitters stop producing the malformed shape.
Any future parser strictness needs a loopback-emitter audit first.

## Incidents

- Probe chaining trap (twice): a multi-case probe that chained via
  `server.close(done)` stopped after the first case — the close
  callback never fired after a client error while the loop still
  emptied. Fixed by running one case per process with an explicit
  timeout + `process.exit(0)`.
- CI retrigger (transient build): first CI run on head 933009b3 was
  Parity success + build failure with no log summary via API — the
  known transient signature (same as #262 rebased head, #263 first
  head, #272 first head). Local reproduction: full jest suite on
  the branch matches the known baseline exactly (3059 passed / 7
  failed, same version-skew suites: constants, perf_hooks, sys,
  oracle surfaces); sandbox/runtime --check pass; build-vfs failed
  once on an esm.sh fetch flake for the unrelated bundler special,
  passed on pristine base (exit 0), branch retry pending at time of
  writing. Retriggered with this notes-only commit.
