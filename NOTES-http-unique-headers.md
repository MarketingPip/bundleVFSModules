# NOTES — `uniqueHeaders` option (test-http-multiple-headers)

## Target

`parity/node-test/parallel/test-http-multiple-headers.js` — the only
vendored test mentioning `uniqueHeaders` (grep over
`parity/node-test/parallel/`; the brief's second name,
`test-http-server-multiple-headers.js`, does not exist). It covers the
option on BOTH sides at once: server `createServer({ uniqueHeaders:
["x-res-b", "x-res-d", "x-res-y"] })` and client `request({ ...,
uniqueHeaders: ["x-req-b", "x-req-y"] })`, with array-valued
`setHeader`/`appendHeader` calls, `writeHead` object headers,
`removeHeader("date")`, and `addTrailers` on both ends.

Baseline on `dae76863`: exit 1 — unhandled `'error'` on ClientRequest,
`Error: Socket is not connected` from `src/net.js` `Socket._write`.
That error is SECONDARY: the server handler's `req.rawHeaders`
assertion threw first (the real gap), and the swallowed handler throw
left no response written (known triage pattern). Once the handler
passes, the socket error disappears — verified: the target test now
exits 0 with no error handler added.

## Real-Node semantics probed (plain node v24.22.1, 2026-10-28)

- **Send-side ONLY, never parse-side.** Raw duplicate lines arriving at
  a server/client with a unique list still fold normally on receipt
  (`headersDistinct` keeps both values, `headers` joins `", "`,
  `rawHeaders` keeps both lines). No change to `_applyRawHeaders` or
  the parser was needed.
- **Case-insensitive list matching** (`uniqueHeaders: ['X-FOO']`
  matches `setHeader('x-foo', ...)`).
- **Join separator is `"; "`** (not `", "`).
- **`set-cookie` in the list IS joined** (one `set-cookie: a=1; b=2`
  line) — so the unique check must come BEFORE any set-cookie special
  case in the renderer.
- **Single (non-array) values unchanged.**
- **`getHeader`/`getHeaders` still return ARRAYS** for unique headers
  — joining happens ONLY at wire render time, never in storage
  (`kOutHeaders` untouched).
- **Wire casing/order:** `setHeader` overwrites `entry[0]` with the
  latest call; `appendHeader` appends without changing `entry[0]`;
  `writeHead(obj)` merges into `kOutHeaders` via `setHeader`;
  `Host` default is `setHeader("Host", ...)`; options headers apply
  in constructor order; streaming TE renders as `Transfer-Encoding`
  (capitalized).
- **`removeHeader('date')` suppresses the auto Date header** — wire
  shows no Date line after removal.
- **`trailersDistinct` EXISTS on real Node** (null-prototype, every
  trailer line's value unjoined — including singleton and cookie
  lines). The old `_applyRawTrailers` comment claiming otherwise was
  wrong; corrected here.

## Root causes (all `src/http.js` unless noted)

1. **Virtual-path flattening destroyed structure.** `_streamEnsureStarted`
   flattened headers with `v.join(", ")` (and the `_performRequest`
   virtual branch flattened via `_mergeArrayHeaders` over the
   `", "`-joined fetchOptions headers) — per-value structure AND
   first-seen casing were gone before serialization. The real-fetch
   path's `", "`-join is correct for browsers and untouched.
2. **`_renderHeaderEntry` diverged from Node.** Non-set-cookie arrays
   of length >= 2 were joined with `", "` into ONE line. Probed real
   Node renders one line per element. `pushLine` inside `_storeHeader`
   already emits one line per array element and folds `flat` with
   `", "` — so the fix is to stop pre-joining and let `pushLine`
   handle arrays, with the unique case pre-joined `"; "` first.
3. **Client streaming terminator dropped trailers.**
   `_streamFinish` hardcoded `Buffer.from("0\r\n\r\n")` instead of
   `this._chunkTerminator()`, so request trailers never reached the
   server on the streaming path. (Buffered client requests get
   Content-Length framing, so their trailers are correctly dropped
   per real Node — #273 rule; buffered + explicit chunked TE is an
   uncovered edge, left alone.)
4. **Server never applied parsed trailers to `req`.** The parser
   recorded `rawTrailers` (#273) but the server's `onMessageComplete`
   only called `_finishBody()`. The client round-trip paths already
   applied their own copy; the server path did not.
5. **`trailersDistinct` missing.** Constructor never created it and
   `_applyRawTrailers` never populated it.
6. **`removeHeader('date')` didn't suppress auto Date.**
   `removeHeader` flagged only connection/content-length/
   transfer-encoding; `_storeHeader` added Date whenever
   `sendDate && !flat.date`.
7. **Nothing set `kUniqueHeaders`.** The getter/setter and the
   `_renderHeaderEntry` unique reference existed but no constructor
   or dispatch code assigned it.

## Changes (`src/http.js` only)

- `OutgoingMessage._renderHeaderEntry`: unique-listed arrays render
  one `"; "`-joined line (checked BEFORE set-cookie handling);
  other arrays reach `pushLine` intact (one line per element);
  empty arrays render nothing (old code emitted a `"name: "` line
  for unique-empty — a degenerate case dropped deliberately).
- `OutgoingMessage._chunkTerminator`: unique-listed trailer arrays
  render one `"; "`-joined line; others one line per element.
- `removeHeader`: `date` case sets `_removedDate`; `_storeHeader`
  Date condition gains `&& !this._removedDate`.
- `ClientRequest` constructor: stashes `this[kUniqueHeaders]` as a
  lowercase Set from `options.uniqueHeaders` (non-array → null).
- `ServerBase` constructor: stashes `this._serverUniqueHeaders`
  (same normalization); `_dispatchSocketRequest` assigns
  `res[kUniqueHeaders]` next to the other `res._server*` fields.
- New `ClientRequest._virtualHeaders()` (next to
  `_mergeArrayHeaders`): builds headers from `kOutHeaders` entry[0]
  casings with array copies, merges array-form pairs, then
  `"; "`-joins unique-listed arrays (join AFTER merging so pair
  values are included).
- `_streamEnsureStarted`: uses `_virtualHeaders()` instead of the
  flatten loop; object-form streaming TE is now
  `setHeader("Transfer-Encoding", "chunked")` (capitalized, matching
  real Node wire; the array-form lowercase fold is untouched —
  array-form + streaming TE wire casing on real Node is unprobed).
- `_performRequest` virtual branch: uses `_virtualHeaders()` instead
  of `_mergeArrayHeaders(fetchOptions.headers)`; the fetchOptions
  `", "`-join loop itself is untouched (real fetch path).
- Side effect (improvement, not a regression): the old virtual branch
  built headers from fetchOptions, whose `host` entry was deleted for
  the real-fetch path, so the serializer fell back to `Host:
  localhost` — the pre-existing divergence the #261 lane recorded
  ("virtual-path object-form Host is `localhost` not
  `localhost:port`"). `_virtualHeaders()` reads `kOutHeaders`
  directly, so the constructor's `setHeader("Host", hostHeader)`
  now reaches the wire as the real `host:port`. Any test asserting
  the old `localhost` fallback would show up in the differential
  sweep; none did in the guard battery.
- `_streamFinish`: terminator via `Buffer.from(this._chunkTerminator(),
  "latin1")` — byte-identical with no trailers.
- Server `onMessageComplete`: applies `parser.rawTrailers` via
  `_applyRawTrailers` before `_finishBody()` (parser resets
  `rawTrailers` per message, so no cross-request leak).
- `IncomingMessage` constructor: `this.trailersDistinct =
  Object.create(null)`; `_applyRawTrailers` populates it (every
  line's value, unjoined) and its stale comment is corrected.

## Guard-risk note

The `_renderHeaderEntry` change alters wire bytes for EVERY response
with multi-value headers: 1 `", "`-joined line becomes N lines.
Client folded `headers` are unchanged for non-singletons (`", "`
join either way); `headersDistinct` changes from `[joined]` to
`[v1, v2, ...]` (more correct, matches real Node); `rawHeaders`
gains lines (more correct). Sharp edge: singleton headers with 2
values now arrive as separate lines, so the parser keeps FIRST —
a test written against the old joined wire would see a different
value. Mitigation: full 397-test differential sweep, branch vs
pristine base `dae76863` (see Testing).

## Testing

- Target: `test-http-multiple-headers` 1 → 0.
- Bonus flip (verified 2× on branch = 0, 2× on base = 124):
  `test-http-dont-set-default-headers-with-set-header`. Mechanism:
  the test sets `HOST` (uppercase) + `foo: ["bar", "baz"]` and
  asserts exact `rawHeaders`. The old virtual path lowercased keys
  and `", "`-joined arrays, so the handler assertion threw → hang;
  `_virtualHeaders()` preserves first-seen casing and per-value
  arrays, so the wire matches exactly.
- Bonus flip (verified 2× on branch = 0, 2× on base = 1):
  `test-http-host-headers`. Mechanism: the test asserts
  `req.headers.host === localhost:${port}`; the old virtual path
  sent the serializer's `Host: localhost` fallback (no port) —
  the pre-existing #261 divergence — while `_virtualHeaders()`
  carries the constructor's real `Host: localhost:port` header.
  This closes that recorded divergence for object-form requests.
- Bonus flips (verified 2× on branch = 0, 2× on base = 124):
  `test-http-url.parse-basic` and `test-http-url.parse-post`.
  Same Host mechanism: both assert
  `request.headers.host === hostname:port` from a `url.parse`d
  request; the old `Host: localhost` fallback threw in the
  handler → hang, the real Host header passes.
- Full 397-test differential sweep, branch vs pristine base
  `dae76863`: EXACTLY these 5 lines differ, all toward pass, zero
  regressions — branch 190 pass / 81 timeout / 126 fail (plus
  134 ×1, 139 ×1, 7 ×1) vs base 185 / 84 / 128 (same crash codes:
  parser-lazy-loaded 134, parser-timeout-reset 139, identical on
  both trees — pre-existing).
- Guard battery 47/47 (see PR body): #261 family (multiheaders,
  multiheaders2, client-headers-host-array, headers-distinct-proto,
  client-headers-array), #277 family (server-reject-chunked-with-
  content-length, server-reject-cr-no-lf, invalid-te,
  missing-header-separator-lf), set-trailers, de-chunked-trailer,
  server, chunked, chunked-304, keep-alive family, consumed-timeout,
  connection-list-when-close, options-incoming-message,
  options-highwatermark, client-highwatermark, outgoing-buffer,
  nodelay, connect, agent-remove, proxy, get-pipeline-problem,
  keep-alive-close-on-header, blank-header, agent-keep-alive-timeout-
  buffer, client-keep-alive-hint, keepalive-req-gc,
  unconsume-consume, connect-req-res, multiple-client-error,
  destroy-socket-on-client-error, client-error,
  drop-connections-in-cluster, delete-parser, outgoing-finished,
  outgoing-message-write-callback, outgoing-write-types, #254
  timeout flips (server-keep-alive-timeout,
  server-request-timeout-delayed-headers,
  server-headers-timeout-delayed-headers).
- Full 397-test differential sweep: branch vs pristine base
  `dae76863` — results in PR body (branch sweep CSV
  `http-sweep-uh-branch.csv`, base sweep CSV `http-sweep-uh-base.csv`
  in the goal hidden_files dir).
- `node --check src/http.js` clean; build-vfs clean (see PR body).

## Known gaps (out of scope, documented not fixed)

- Buffered client requests with explicitly chunked TE do not send
  trailers (only the streaming path renders them via
  `_chunkTerminator`).
- Array-form + streaming TE wire casing on real Node is unprobed;
  the array-form fold stays lowercase.
- Non-array `uniqueHeaders` option values are ignored (no official
  test covers them); no validation error is raised.
- `OutgoingMessage._send` still writes chunked frames as three
  separate socket writes (pre-existing, no in-scope test uses it).
