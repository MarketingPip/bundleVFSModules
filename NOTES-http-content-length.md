# NOTES — test-http-content-length (implicit Content-Length: 0)

## Target

`parity/node-test/parallel/test-http-content-length.js` — exit 124
(timeout) on pristine main `308b2ec0`, exit 0 with this fix. The
`/multiple-writes` (chunked) and `/end-with-data` (`Content-Length:
11`) cases already passed; only the `/empty` case hung.

## Diagnosis

The test's server asserts the request headers for an empty POST:
`{ connection: "keep-alive", "content-length": "0" }` (after deleting
`host`). The shim's client sent no `content-length` header at all for
an empty body, so the assertion threw inside the handler, the throw
was swallowed by shim dispatch, no response was delivered, and the
client waited until the timeout — the swallowed-throw hang pattern.
A logging probe (since deleted) confirmed the other two cases match
exactly and only `/empty` diverges, on the request side: the
corresponding empty *response* already carried `content-length: 0`.

## Real-Node behavior (probed v24.22.1)

An empty-body request (no writes, `end()` with no data) sends:

- `POST`, `PUT`, `PATCH`: `Content-Length: 0`.
- `GET`, `HEAD`, `DELETE`, `OPTIONS`: no length header at all.

## Fix (`src/http.js` only, product)

`_serializeRequestHead` previously added a length header only when
the body was non-empty. It now also handles the transfer-encoding
case and the empty-body case:

- A `Transfer-Encoding` header already present suppresses the
  body-length `Content-Length` (previously a chunked request with a
  body got BOTH headers on the wire, which real Node never sends).
  This fixes the request half of `test-http-raw-headers` (its server
  asserts the exact raw header list with no length line); see the
  mode-change note below.
- An empty body sends `Content-Length: 0` when the method is
  POST/PUT/PATCH, no length or transfer-encoding header is already
  present, the head is final (not a streaming head), and default
  headers are enabled. GET/HEAD/DELETE/OPTIONS stay length-less,
  exactly as probed.
- The new `bodyFollows` parameter (default `false`) marks streaming
  heads, which are pre-serialized at first write with the body still
  to come via the writer. The streaming call site passes `true`, so a
  streaming POST keeps its chunked framing instead of wrongly gaining
  `Content-Length: 0`.
- The new `setDefaultHeaders` parameter (default `true`) gates the
  `Content-Length: 0` addition: implicit length is a default header,
  so it must not be added when the caller passed
  `setDefaultHeaders: false`
  (`test-http-dont-set-default-headers-with-set-header` asserts the
  exact raw header list for an empty POST with defaults off, and
  regressed to a hang before this gate was added).
- Threading note: `ClientRequest` stashes the option as
  `this._setDefaultHeaders` in its constructor (next to the existing
  Host-default check). The streaming call site reads it directly
  (it lives in a `ClientRequest` method), but the buffered call site
  lives in the module-level `_socketHttpRoundTrip`, where `this` is
  not the request — so the flag travels as an explicit
  `setDefaultHeaders` option through the round-trip call, with other
  callers (emulated inbound requests) keeping the default `true`.
  An earlier version read `this._setDefaultHeaders` at the buffered
  site and broke every buffered virtual request (TypeError swallowed
  into a hang); the threading above is the fix for that.
- Non-empty-body behavior is otherwise byte-identical, including
  when a transfer-encoding header is absent (length-from-body
  branch untouched).

## Deliberately left alone

- The fetch path (non-virtual targets): browsers own that header
  computation; the test exercises virtual loopback only.
- Chunked request-body framing: the buffered serializer still sends
  the body raw under `Transfer-Encoding: chunked` instead of
  chunk-encoding it. That is the likely cause of the remaining
  `test-http-raw-headers` response-half failure below, but it is a
  separate root cause and out of this lane's scope.
- The sibling test `test-http-content-length-mismatch`
  (`strictContentLength` enforcement) is a separate root cause and
  shipped as its own PR.

## Verification

- Target 124 → 0 (branch + live main, parent-verified).
- Full 397 differential vs pristine main: TWO lines toward pass,
  both from this one root cause (empty-body implicit length):
  `test-http-content-length` 124 → 0 and
  `test-http-client-default-headers-exist` 1 → 0 (that test expects
  `content-length` among the default headers for POST/PUT).
- Zero pass-to-fail. One mode change, documented, not a regression:
  `test-http-raw-headers` 124 → 1 — the TE guard fixed its
  request-half assertion (server handler now runs; only the response
  mustCall fails), while the response half still fails on the
  pre-existing chunked-body-framing/trailer gap above. It passed on
  neither tree.
- Guards all 0: content-length-mismatch, multiple-writes family
  (multiple-headers, chunked), keep-alive, agent-keepalive, upgrade
  client/server families (streaming-head path untouched in behavior),
  dont-set-default-headers-with-set-header.
- Repo jest 3059/7/1 (host baseline exactly); ondemand 29/29;
  build-vfs exit 0; dist/ restored, never committed.
