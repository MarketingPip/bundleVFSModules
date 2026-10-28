# NOTES — set-trailers emission (fix/http-set-trailers-emission)

## Failing test (before)

`parity/node-test/parallel/test-http-set-trailers.js` exited **1** on base
main `469b8a04` (PR #272). The HTTP/1.1 sub-test asserted the response
ends with `/0\r\nx-foo: bar\r\n\r\n$/`; the shim sent a bare terminator
(`6\r\nstuff\n\r\n0\r\n\r\n`) even though the handler called
`res.addTrailers({ "x-foo": "bar" })`. `addTrailers()` stored
`this._trailer` but nothing ever read it.

## Real Node probed (v24.22.1, plain node, /tmp/probe-tr*.js)

| Case | Terminator bytes |
|---|---|
| Chunked + `addTrailers({ "x-foo": "bar" })` | `0\r\nx-foo: bar\r\n\r\n` (no `Trailer:` declaration header required) |
| Multiple / array values | One line per value, insertion order: `0\r\nx-foo: bar\r\nx-baz: one\r\nx-baz: two\r\n\r\n` |
| Content-Length (non-chunked) + trailers | Silently dropped: body raw, no trailer bytes, no error |
| `addTrailers` after `end()` | No throw, no bytes — bare `0\r\n\r\n` (silently ignored) |
| No trailers added | Bare `0\r\n\r\n` (unchanged) |

Client side (same probes): `res.trailers` is a folded plain object
(keys lowercased, duplicates joined `", "`, cookie `"; "`, set-cookie an
array); `res.rawTrailers` is a flat `[name, value, ...]` array preserving
wire casing, one pair per line. Same folding as headers; there is no
`trailersDistinct` in Node.

Server `close()` semantics (probed v24.22.1, needed for this test to exit):
`server.close()` destroys connections that are **idle at close time** —
the client sees `end` + `close` at once and the loop drains. A connection
with a request in flight survives close and completes; once it goes idle
it is NOT destroyed retroactively. Client sockets with `allowHalfOpen`
false end themselves once EOF is delivered: a write inside an `end`
handler still lands on the peer (auto-end happens after `end` listeners
run), then the socket closes.

## Root cause (plain terms)

Three separate gaps, one chain:

1. **Emission:** the server wrote a hardcoded bare `0\r\n\r\n` at every
   chunked terminator site and never rendered `_trailer`.
2. **Client delivery:** the chunked parser consumed trailer lines and
   dropped them, so `http.get` responses never populated `res.trailers`
   (the test's third sub-test).
3. **Loop drain (unmasked by fixing 1+2):** the test never ends its raw
   HTTP/1.1 client socket, and on real Node the process still exits
   because `server.close()` destroys the idle connection and the client
   socket then ends itself on EOF. The shim did neither, so the fixed
   test hung (exit 124) instead of exiting 0.

## Changes (all in this branch)

- `src/http.js`
  - `OutgoingMessage._chunkTerminator()` (new, next to `addTrailers`):
    renders `0\r\n` + one `name: value\r\n` per trailer value (arrays
    expand) + `\r\n`; bare `0\r\n\r\n` when `_trailer` is null,
    non-object, an array, or empty — byte-identical to today's output
    when no trailers are set.
  - `addTrailers` gate: `if (this.finished) return;` (post-end trailers
    silently ignored, matching the probe).
  - All four server terminator sites use the helper:
    `ServerResponse.end()` streaming site, `ServerBase._finishSocketResponse`
    streaming site, buffered sendBody, buffered no-body case.
    Non-chunked branches and the noBodyStatus (204/304/1xx) branch are
    untouched — they send no terminator, so trailers drop automatically,
    matching the Content-Length probe.
  - `IncomingMessage._applyRawTrailers()` (new static): folds flat
    `[name, value]` pairs into `trailers`/`rawTrailers` with header
    folding rules (`hasOwnProperty` guard, so a `constructor` trailer
    cannot read `Object.prototype`).
  - `_socketHttpRoundTrip` `onMessageComplete` resolves
    `rawTrailers: parser.rawTrailers.slice()` (CONNECT resolves at
    headers and has none).
  - `_performVirtualRequest`: buffered path applies `rawTrailers` after
    `_applyRawHeaders`, before emitting `response`; streaming path
    applies them to `streamedMsg` before `_finishBody()`, so `end`
    handlers see trailers. `fromFetchResponse` untouched (fetch does
    not expose trailers).
  - `ServerBase.close()` now destroys connections idle at close time
    (same `!state || !state.busy` predicate as `closeIdleConnections()`).
    Busy connections are untouched.
- `src/_http_parser.js`
  - `_resetMessage()` initializes `this.rawTrailers = []` (per-message).
  - Chunked-trailers state records well-formed lines
    (`colon > 0`, name matches `TOKEN_RE`, value OWS-stripped like
    `_parseHeaders`) into flat `rawTrailers`, wire casing preserved.
    Malformed trailer lines are consumed and dropped WITHOUT throwing
    (deliberate leniency — see known gaps).
- `src/net.js`
  - `onReadableStreamEnd`: with `allowHalfOpen` false, the socket ends
    itself on a tick after `end` listeners run (guarded by `destroyed`
    / `writableEnded`). HTTP accepted sockets set `allowHalfOpen`
    true, so half-closed request/response still works.

## Out of scope (not implemented)

- Client request trailers (`ClientRequest._streamFinish` path).
- Server `req.trailers` population for incoming requests (parser
  accumulation is harmless and available for a future lane).
- Malformed trailer-line errors; trailer value validation (invalid
  characters, non-string `addTrailers` values) — unprobed, no test in
  scope. Values are `String()`-coerced on render.
- Post-`end`-handler writes: after auto-end, a later write hits the
  shim's `writeAfterFIN` EPIPE path; real Node reports
  `ERR_STREAM_WRITE_AFTER_END` there. Same terminal state, different
  error code — noted, not chased.

## Validation and emission are different layers

PR #263's `ERR_HTTP_TRAILER_INVALID` validation (a `Trailer` header
without chunked encoding throws in `writeHead`) is untouched and must
keep passing — it is covered by the guard run below
(`test-http-server-de-chunked-trailer` and the trailer-validation tests
in the full suite). No validation rule was weakened.

## Results

- `test-http-set-trailers`: exit **1 → 0**.
- Guard run: see PR description for the full list and counts
  (agent-* family, keep-alive-*, chunked*, blank-header,
  get-pipeline-problem, client-keep-alive-hint,
  agent-keep-alive-timeout-buffer, test-http-server, the PR #254
  timeout flips, server close/idle family, client abort/close family,
  multiheaders, headers-distinct-proto, client-highwatermark, plus
  `tests/ondemand-require.test.js`).
- No score claimed here: docs-number syncs are batched separately.
