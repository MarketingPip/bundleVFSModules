# NOTES — http2 validation hardening (H2-V4)

Ship: PR #___ / merge SHA ___ (docs sync fills this in).
Base: `2ea75e5c` (PR #498, H2-V6). Banked count at base: **50/277**.
Result: **78/277** (+28 flips, 0 regressions).

## What this lane did

Implemented the missing validations the Node oracle performs, in the
oracle's order, in `src/http2.js` only (plus two repo-jest expectation
updates — see the loud flag below). Every validation below is
probe-proven against real Node v24.22.1 and/or read from the Node
v24.20.0 source pack (`hidden_files/node-src/`).

### Validators added (module scope, after `invalidArgTypeHelper`)

- `checkIsHttpToken`, `inspectValue`, `invalidArgValue` (exact Node
  messages — `ERR_INVALID_ARG_VALUE` with the property-vs-argument
  split, values inspected and truncated at 128 chars),
  `validateString/Number/Boolean/Function/Buffer/Integer` (exact Node
  messages via `validateInteger`/`validateBoolean`/`validateFunction`
  /`validateBuffer`/`validateNumber`).
- `assertValidHeader` (compat.js:82-96: empty/spaced names →
  `ERR_INVALID_HTTP_TOKEN`, pseudo-headers →
  `ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED`, undefined/null values →
  `ERR_HTTP2_INVALID_HEADER_VALUE` with the
  `Invalid value "x" for header "y"` message).
- `kValidPseudoHeaders`, `kSingleValueFields`,
  `kNoPayloadMethods` (DELETE/GET/HEAD), `assertValidPseudoHeader` /
  `assertValidPseudoHeaderResponse` / `assertValidPseudoHeaderTrailer`,
  `isIllegalConnectionSpecificHeader`,
  `validateHeaderList` (buildNgHeaderString validation core:
  lowercase, strict single-value, pseudo validator, token,
  connection headers; skips undefined values and `''` keys),
  `foldToHeaderObject` (duplicates join `", "`, set-cookie stays an
  array), `normalizeTrailerPairs`.

### Where the validations landed

- `normalizeRequestHeaders`: CONNECT rules (authority required,
  scheme/path forbidden when method CONNECT and no `:protocol`,
  defaults otherwise) + `validateHeaderList` on both array and object
  paths. `strictSingleValueFields` (default true) threads from
  `connect()` options / server options through the session — with
  `false`, duplicate single-value headers are allowed (regression fix
  for `single-headers-validation-disabled`, see below).
- `normalizeResponseHeaders`: `:status` validated to [200,599] →
  `ERR_HTTP2_STATUS_INVALID` (both paths) + `validateHeaderList`.
- `Http2Session`: constructor tracks `_localWindowSize` /
  `_effectiveLocalWindowSize` (65535; local is the high-water mark,
  effective is the last set value — probe-proven) +
  `_pendingRemoteSettings` queue; `state` uses them;
  `settings()` validates the callback + queues a remote-settings
  snapshot; `_queueRemoteSettingsSnapshot` / `_flushRemoteSettings`
  deliver snapshots to the paired server session's `_remoteSettings`
  and emit `remoteSettings` per snapshot on a microtask;
  `goaway()` validates (destroyed → INVALID_SESSION, opaqueData
  buffer, code/lastStreamID numbers); `setLocalWindowSize()` exact
  validation + high-water/effective tracking;
  `setNextStreamID()` exact validation (`> 0 and <= 4294967295`);
  `destroy()` tears down its tracked streams (see below).
- `ClientHttp2Session.request()`: options validation after headers
  (assertIsObject + endStream/parent/exclusive/silent types);
  `waitForTrailers` → `stream._requestWaitForTrailers`; GET/HEAD/DELETE
  + content-length > 0 (or NaN) → no dispatch, microtask emits
  `error` `ERR_HTTP2_STREAM_ERROR` NGHTTP2_PROTOCOL_ERROR + `close`
  (probe-proven: the server stream is never created).
- `Http2Stream`: trailers state; `pushAllowed` reads the paired
  server session's remote `enablePush`; `additionalHeaders()` full
  oracle validation (destroyed/closed, headersSent, `:status` 101 /
  1xx rules, response pseudo validator); `_destroy(err, callback)`
  added; `close()` rewritten (validateInteger code +
  validateFunction callback, closed → return, sync `_closed` /
  `_rstCode`, deferred microtask completion: code 0 → `end` then
  `_destroy()`; code 1 → `error` then `_destroy()`; other codes →
  `_destroy()`); `_emitEndOnce()` + `_emitCloseOnce()` guards
  (`close` fires exactly once — fixes the double-`close` that broke
  `misused-pseudoheaders`); `destroy()` emits `end` once when called
  with no error (like a real stream) and not when called with an
  error.
- `respond()`: destroyed/closed → INVALID_STREAM first, then
  headersSent, then assertIsObject(options); `:status` range +
  header validation via `normalizeResponseHeaders`; records
  `_responseWaitForTrailers`.
- `respondWithFD()` / `respondWithFile()`: oracle order (destroyed →
  headersSent → options offset/length/statCheck types via
  `invalidArgValue` → fd type for FD → headers incl. the 204/205/304
  payload-forbidden rule); remain noops after validation (no fds /
  no file delivery in a browser).
- `sendTrailers()`: destroyed/closed → INVALID_STREAM; no
  wantTrailers fired for the current side → NOT_READY; already sent
  for that side → ALREADY_SENT; trailer pseudo validator →
  INVALID_PSEUDOHEADER; stores per side.
- `pushStream()`: pushAllowed false → throw
  `ERR_HTTP2_PUSH_DISABLED` sync; then callback validation, then
  header validation (connection headers). When push is allowed it
  actually creates the push stream (even id from the server
  session's `_nextPushStreamID`, starting at 2), emits `stream` on
  the client session, and calls back `(null, pushStream, headers,
  {})` on a microtask.
- `end()`: client end with waitForTrailers → emit wantTrailers
  (request side) before completing; server end after the client
  already ended (no respond() yet) → deliver the default 200 +
  response data; server end with waitForTrailers → emit
  wantTrailers (response side); end() on a closed stream emits
  `end` once (rststream test).
- `_emitWantTrailers(side)` / `_emitTrailers(headers, side)` /
  `_emitData(chunk, side)`: side-scoped emission on the shared
  stream object. `wantTrailers` splits on the pre-dispatch client
  snapshot; `trailers` / `data` split on the server-side listeners
  snapshotted at dispatch (`_serverTrailersListeners` /
  `_serverDataListeners` — registered by the `stream` / `request`
  handlers). Without this, the client's `data`/`trailers`
  listeners fired for the request body/trailers and vice versa.
- `_deliverRequestBody()`: after `end`, emits `trailers` with the
  folded request trailers if the client sent any.
- `Http2ServerRequest`: `method` / `url` / `scheme` / `authority`
  are prototype getter/setter pairs (compat.js:407-435 — method
  setter validates: non-string → ERR_INVALID_ARG_TYPE,
  blank-after-trim → ERR_INVALID_ARG_VALUE; authority falls back to
  the Host header; no `path` property); `trailers` /
  `rawTrailers` getters read live from the stream.
- `Http2ServerResponse`: `setHeader()` trim + lowercase +
  assertValidHeader + token check + headersSent throw + connection
  headers dropped silently; `setTrailer()` exact messages
  (validateString → trim/lowercase → assertValidHeader; no separate
  token check, like Node); `addTrailers()` validates via
  assertValidHeader; both write normalized trailers to
  `stream._sentTrailers` directly (the compat path bypasses the
  low-level sendTrailers guard); `writeEarlyHints()` validates
  (object, link exempt, other keys trim/lowercase +
  assertValidHeader + token check); `writeHead()` returns silently
  when the stream is closed/destroyed (compat.js:717-718, checked
  BEFORE the headers-sent throw — fixes the V2 guard regression);
  `createPushResponse()` (compat.js:878-891 — validateFunction
  first, closed stream → callback with ERR_HTTP2_INVALID_STREAM
  on a microtask, else delegate to pushStream and wrap the result
  in a new Http2ServerResponse).
- `Http2Server` constructor: options/settings object validation,
  maxSessionInvalidFrames / maxSessionRejectedStreams /
  unknownProtocolTimeout uint32s, strictSingleValueFields boolean;
  `setTimeout()` callback validation (non-function and !==
  undefined → ERR_INVALID_ARG_TYPE; returns `this`).
- `Http2SecureServer`: own constructor — validates options as an
  object FIRST (a function first arg throws ERR_INVALID_ARG_TYPE,
  probe-proven: the plain server treats a function as the request
  handler, the secure server does not — `initializeTLSOptions`
  runs before the handler check) + ALPNCallback + ALPNProtocols →
  ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS (probe-proven message:
  "The ALPNCallback and ALPNProtocols TLS options are mutually
  exclusive").
- `_dispatchVirtualStream()` / `_emitVirtualStream()`: the dispatch
  emit runs synchronously inside `dispatchVirtualRequest` (it is
  already one microtask after `request()`; a second queued
  microtask let a client `close()` overtake the dispatch, so the
  server never saw an RST'd stream); the host-bridge path keeps
  the queued emit. Snapshots `_clientWantTrailers`,
  `_serverTrailersListeners`, `_serverDataListeners`; flushes
  pending remote settings; extends the lazy-body trigger to a
  `trailers` listener. `dispatchVirtualRequest()`: guard is
  `_destroyed` only (an RST-closed stream still dispatches so the
  server sees the RST). `connect()`: queues an initial
  remote-settings snapshot of the defaults when no
  `options.settings` were given.
- Session stream tracking: `Http2Session._streams` (a Set);
  `request()` adds the stream, `_dispatchVirtualStream()` adds it
  to the server session's set, `_destroy()` removes it from both.
  `Http2Session.destroy()` closes tracked streams (a destroyed
  session tears down its streams in Node); `close()` does not.
- `invalidArgTypeHelper`: anonymous functions now render as
  `Received function ` (Node's helper uses `input.name` verbatim —
  probe-proven), not `Received function anonymous`.

### Probes (real Node v24.22.1, all in-session)

- rawHeaders order is pseudo-first on both real Node and the shim.
- GET + content-length:1 → client ERR_HTTP2_STREAM_ERROR
  NGHTTP2_PROTOCOL_ERROR, server stream NEVER created (0); GET
  cl:0 and POST cl:1+body OK; HEAD cl:1 → same error.
- writeHead(103) THROWS ERR_HTTP2_STATUS_INVALID in real Node.
- stream.close(0) → client `end`+`close` (rst=0, destroyed=true),
  no error, server `end`+`close`; close(1) → client
  `error`+`close` (rst=1), NO `end` unless req.end() called,
  server `error`+`close`; close(8) → `close` only; exact test
  sequence (close(1) → resume() → end()) gives end → error →
  close → callback → server error → server close.
- setLocalWindowSize state: initial eff/local/remote 65535; after
  2**20 eff=local=1048576; after 20 (2nd call) eff=20, local stays
  1048576; after 70000 eff=70000, local stays 1048576 — local is
  the high-water mark, effective is the last set value.
- setLocalWindowSize errors: 2**32 → ERR_OUT_OF_RANGE "It must be
  >= 0 && <= 2147483647"; "x" → ERR_INVALID_ARG_TYPE; 1.5 →
  ERR_OUT_OF_RANGE "It must be an integer".
- setNextStreamID errors: 0/−1/2**32 → ERR_OUT_OF_RANGE "It must
  be > 0 and <= 4294967295"; "x" → ERR_INVALID_ARG_TYPE.
- `createSecureServer(() => {})` THROWS ERR_INVALID_ARG_TYPE in
  real Node while `createServer(() => {})` does NOT throw.
- ALPNCallback + ALPNProtocols → ERR_TLS_ALPN_CALLBACK_WITH_
  PROTOCOLS, "The ALPNCallback and ALPNProtocols TLS options are
  mutually exclusive"; ALPNCallback alone does not throw.
- `invalidArgTypeHelper`: anonymous arrow → ` Received function `,
  named → ` Received function foo`.
- util.inspect formats (function → `[Function: function]`, string
  `' '` → `"' '"`, `{}` → `{}`, `[]` → `[]`).

## Flips (28 — each [0,0] ×2 on branch / [1,1] ×2 on pristine main `2ea75e5c`)

| test | what flipped it |
|---|---|
| invalidargtypes-errors | validators (setNextStreamID/setLocalWindowSize/goaway/headers arg types) |
| single-headers-validation | validateHeaderList (single-value, pseudo, token, connection) |
| multi-content-length | single-value + GET+cl PROTOCOL_ERROR |
| client-settings-before-connect | settings() callback validation + remoteSettings snapshots |
| client-request-options-errors | request() options validation after headers |
| respond-errors | respond() INVALID_STREAM/HEADERS_SENT + destroy() emits `end` |
| respond-file-errors | respondWithFile() oracle-order validation |
| respond-file-fd-errors | respondWithFD() oracle-order validation (+ fd type) |
| createserver-options | server constructor options/settings/uint32 validation |
| createsecureserver-options | secure constructor (function-first-arg throw) + base validation + invalidArgTypeHelper anonymous fix |
| server-settimeout-no-callback | setTimeout() callback validation |
| invalidheaderfield | assertValidHeader + setHeader trim/lowercase/token |
| invalidheaderfields-client | request-header validation (token/pseudo/connection) |
| status-code-invalid | :status [200,599] in normalizeResponseHeaders |
| server-rst-before-respond | close() rewrite (validateInteger + validateFunction + code-1 error/close) |
| compat-write-early-hints-invalid-header | writeEarlyHints() validation |
| server-push-disabled | pushStream() sync PUSH_DISABLED throw when push disabled |
| respond-file-204 | respondWithFile() 204/205/304 payload-forbidden |
| client-setNextStreamID-errors | setNextStreamID() exact validation |
| compat-serverrequest-headers | ServerRequest method/url/scheme/authority accessors |
| compat-serverresponse-trailers | addTrailers/setTrailer compat storage + _sentTrailers delivery |
| client-setLocalWindowSize | setLocalWindowSize() exact messages + window tracking |
| client-rststream-before-connect | close() rewrite + immediate dispatch (server sees the RST) + end() on closed stream emits `end` |
| trailers | wantTrailers/sendTrailers state machine + side-scoped trailers/data + request-trailers delivery |
| server-push-stream-errors-args | pushStream() arg validation order (pushAllowed now true when the peer allows push — `_serverSession` wiring) + server end without respond() delivers |
| compat-serverresponse-createpushresponse | createPushResponse() + real push-stream creation + `push` event in _deliverResponse |
| misused-pseudoheaders | sendTrailers trailer pseudo validation + _emitCloseOnce (double-`close` fix) |
| server-shutdown-options-errors | goaway() validation + session destroy() closes its streams |

Guards (17/17 on branch AND base, 1× each — the 15 prior flips +
2 passing tests): large-write-multiple-requests,
client-upload-reject, compat-client-upload-reject,
compat-serverresponse-writehead, compat-serverresponse-
statusmessage-property, -property-set, pipe,
compat-serverrequest-pipe, client-upload, create-client-connect,
raw-headers, raw-headers-defaults, multiheaders-raw,
single-headers-validation-disabled, compat-serverrequest-host,
serve-file, no-wanttrailers-listener. Zero regressions.

Repo jest: `tests/http2.test.js` 66/66 on branch and on base.
Footprint: `tests/ondemand-require.test.js` 29/29.

## LOUD FLAG — repo jest expectations updated (H2-V6 precedent)

`tests/http2.test.js` — two expectations pinned the OLD (incorrect)
shim behavior and provably contradict real Node (probe-proven +
oracle lines). Updated with H2-V4 comments citing the oracle:

1. `setNextStreamID validates` (:464, :467): 0 / −3 now expect
   `ERR_OUT_OF_RANGE` (was `ERR_HTTP2_INVALID_STREAM`). Real Node
   validates with `validateInteger(id, 'id', 1, 2**32-1)` —
   probe-proven messages. The parity test
   `client-setNextStreamID-errors` requires it.
2. `pushStream() reports ERR_HTTP2_PUSH_DISABLED asynchronously`
   → renamed `pushStream() throws ERR_HTTP2_PUSH_DISABLED when push
   is disabled`, now expects the SYNC throw via `catchCode`. Real
   Node (core.js:2948-2950) checks pushAllowed FIRST and throws
   synchronously; the parity tests `server-push-disabled` and
   `server-push-stream-errors-args` require it. A bare stream has no
   server session, so push is disabled.

No other repo test was touched.

## In-lane regressions caught and fixed (differential)

1. `compat-serverresponse-writehead` (V2 flip) 0→1: my new
   `respond()` threw INVALID_STREAM when `_closed`, but `writeHead`
   delegates to `respond()` — and the oracle (compat.js:717-718)
   makes `writeHead` a silent noop when the stream is
   closed/destroyed, checked BEFORE the headers-sent throw. Added
   the early return to `writeHead`.
2. `single-headers-validation-disabled` (V6 flip) 0→1: my
   `validateHeaderList` always enforced single-value strictly,
   ignoring the session's `strictSingleValueFields: false`
   (connect/server options, oracle core.js:3429-3435 / 3657-3663,
   util.js:768,781). Threaded the flag through connect → session
   → `normalizeRequestHeaders` / `normalizeResponseHeaders` /
   `respond()` / `_prepareFileResponseHeaders`, with boolean
   validation in the server constructor and `connect()`.

## NO-FIX (4 — inherent, primitive named)

| test | primitive |
|---|---|
| altsvc | Real ALTSVC frame delivery to the peer + `altsvc` events on the client session (needs a cross-session frame exchange; the validation half — ERR_INVALID_CHAR etc. — is implemented in the oracle order but the test also asserts 4 client `altsvc` events that cannot fire without delivery). |
| alpn | Real TLS ALPN negotiation (the ALPNCallback + ALPNProtocols throw IS now implemented — probe-proven — but the rest of the test needs a real TLS handshake, `secureConnection`, and `alpnProtocol`). |
| origin | Real ORIGIN frame exchange + `originSet` tracking on the client session. |
| test-http2-origin-set-max-size.mjs | Real TLS + ORIGIN exchange (`.mjs` validation half). |

Also not in the 32: `test-http2-util-headers-list.js` fails on the
NgHeaders string format (sensitive-header flags), NOT validation —
needs a real buildNgHeaderString; `test-http2-compat-method-connect`
sends valid CONNECT and fails only on the missing compat `connect`
event (not this lane).

## Side findings (not lanes)

- `test-http2-client-upload` (and the upload family) OOMs on base
  with a 139,837-byte Buffer mismatch in `src/assert.js`
  formatting — pre-existing `src/assert.js` bug, not this lane.
- The `Readable.prototype.pipe` stall mechanism (dest `close` →
  unpipe → source paused forever) is what lazy delivery overcomes
  (H2-V1).
- The `run_main` group in the triage's family E resolves to the 4
  tests named in the flip table above
  (`client-setNextStreamID-errors`, `compat-serverrequest-headers`,
  `client-rststream-before-connect`,
  `compat-serverresponse-trailers`).
