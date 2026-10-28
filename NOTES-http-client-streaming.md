# NOTES — HTTP client streaming writes (test-http-server-consumed-timeout)

## The hang, in plain terms

`test-http-server-consumed-timeout` is a circular wait with TWO halves, and
both had to be fixed for the test to pass:

1. **Client half (the named root cause).** `ClientRequest` buffered ALL writes
   in `outputData` and sent nothing until `end()`. The test writes `"."`
   and then waits for the response before its interval writes — but the
   server handler never runs until the server sees the request, and the
   request never leaves until `end()`, which only happens inside the
   response callback. Hang.
2. **Server half (found by probing, not assumed).** `ServerResponse.flushHeaders()`
   only RENDERED headers; it never wrote them to the socket. The test's
   server calls `res.writeHead(200); res.flushHeaders();` and then waits
   for request body data — but without the header bytes on the wire, the
   client never gets its `response` event, so the interval that would
   produce that body data never starts. Second circular wait, on the
   response side. The inherited `write()`-triggered flush already sent
   headers for `res.write()` flows; only the explicit `flushHeaders()`
   path was a no-op send.

## Real-Node behavior probed first (system Node v24.22.1, raw TCP capture)

- POST, no Content-Length, `write(".")` → head + `Transfer-Encoding: chunked`
  + `1\r\n.\r\n` frame IMMEDIATELY (before `end()`); `end()` → `0\r\n\r\n`.
- POST with `Content-Length: 3`, `write("ab")` → head + raw `ab` immediately;
  `end("c")` → raw `c` (no terminal chunk).
- Three synchronous writes + `end()` → head + one frame PER write call
  (`1 a`, `2 bb`, `3 ccc`, `0`), coalesced into one TCP segment.
- `flushHeaders()` → head bytes (with `Transfer-Encoding: chunked`) sent
  immediately, before any write.
- Empty `write("")` → headers only, NO frame and NO terminator (so the
  forwarder must skip empty buffers, or a `0\r\n\r\n` would end the body
  early).
- SURPRISE: `Expect: 100-continue` does NOT hold the body — `write("X")`
  sent head + frame immediately, before the `continue` event. No
  special-casing for Expect in this implementation.
- SURPRISE: GET `write("x")` returns true and sends head + raw `x` in real
  Node. The shim deliberately does NOT stream no-body methods (GET/HEAD/
  DELETE/OPTIONS/TRACE/CONNECT without Content-Length): their `end()`
  behavior is unchanged, so no currently-passing guard changes meaning.

## What changed (src/http.js only, +~200 lines)

- `_socketHttpRoundTrip`: new streaming mode. In `doConnect`, a streaming
  trip writes pre-serialized head bytes, then hands the caller a writer
  whose `write()` drops bytes only if the socket was destroyed or released
  to the agent pool (possibly reused by another request). Parser,
  onHeaders/onBody, settle, and error/close handling are untouched.
- `_performVirtualRequest`: optional streaming 4th argument. Socket wait,
  `socket` emit, connect replay, timeout, agent `request` emit, streamed
  response completion, and socket release are all reused verbatim; only
  the round-trip call gains the streaming options. Head bytes are built
  with the existing `_serializeRequestHead` (after the keep-alive
  `Connection` adjustment, so keep-alive framing is preserved).
- `ClientRequest.write()`: starts streaming BEFORE `super.write()` (which
  marks headers sent, after which `setHeader()` throws — the chunked
  framing header must be set while headers are open), then forwards the
  chunk. After `end()`/abort, the Writable error path applies unchanged.
- `ClientRequest.flushHeaders()`: starts streaming before rendering, so
  headers go out immediately (probed P6).
- `_streamEnsureStarted()`: decides ONCE per request. Eligible only for
  virtual-server requests with a body-capable method (POST/PUT/PATCH, or
  any non-GET/HEAD method with explicit Content-Length or
  `Transfer-Encoding: chunked`); websocket upgrades and CONNECT are
  excluded. Framing: Content-Length → raw bytes; otherwise chunked
  (header materialized like Node). Ineligible requests keep the exact
  buffered whole-body-at-`end()` behavior.
- `_streamForward()` / `_streamFinish()`: chunked framing per write call,
  empty buffers skipped, pending queue flushed in order when the writer
  becomes ready (socket assignment is async), terminal `0\r\n\r\n` only
  for chunked framing.
- `ClientRequest.end()`: when a stream already started, forwards the
  final chunk (if any) + terminal chunk, then awaits the in-flight round
  trip instead of starting a second one. When no stream started,
  byte-identical old path.
- `_performRequest()`: early return of the in-flight streaming round trip
  (placed before fetch/upgrade handling; a request already on the wire
  must not be re-issued or spuriously failed).
- `ServerResponse.flushHeaders()`: override that calls `_flushHeaders()`
  after rendering. `_flushHeaders()` itself is unchanged and already
  no-ops when flushed or socketless, and `_finishSocketResponse` already
  handles pre-flushed headers (the `write()`-triggered flush path
  exercises the same code).

## Deliberate non-goals / known limitations

- Fetch-path requests (non-virtual hosts) still send the whole buffered
  body at `end()` — fetch has no streaming request-body path here.
- Writes after full response completion (round trip settled, socket
  released) are dropped from the wire by the writer guard; the pathological
  write-after-response-end-before-end() case is not given new semantics.
- Over-Content-Length writes behave as before (the whole-body path had
  the same unguarded behavior); no new accounting was added.
- `setHeader()` after first write still throws `ERR_HTTP_HEADERS_SENT`,
  matching Node (and the shim's pre-existing behavior).
- No docs-number changes in this PR (batched separately per lane rules).

## Verification

- `test-http-server-consumed-timeout`: 124 → 0.
- Guard battery (agent, keep-alive, chunked, outgoing, blank-header,
  pipeline, close-on-header, client-keep-alive-hint, test-http-server,
  all twelve PR #254 timeout flips, plus the three known pre-existing
  failures agent-reuse-drained-socket-only / agent-keepalive /
  agent-timeout-option): see PR body; any failure must reproduce
  identically on pristine main before it may be called pre-existing.
- Repo suites: `tests/ondemand-require.test.js` 29/29 required; full jest
  suite reported in the PR body.
