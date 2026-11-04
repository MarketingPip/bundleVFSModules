# test-http-header-value-relaxed — working note

## Test shape

`parity/node-test/parallel/test-http-header-value-relaxed.js` (599 lines,
19 blocks). The `httpValidation` option (`strict` | `relaxed` | `insecure`)
on client requests and servers, mutually exclusive with
`insecureHTTPParser` (both set → `ERR_INVALID_ARG_VALUE` at construction:
Tests 12 client, 13 server).

- Outbound: `relaxed`/`insecure` allow control chars 0x01–0x1f except HTAB
  plus DEL 0x7f in header values (Tests 2, 4, 7, 11, 17 — `setHeader`,
  `appendHeader`, server `writeHead`/`_storeHeader` path); NUL (0x00), CR
  (0x0d), LF (0x0a) are ALWAYS rejected with `ERR_INVALID_CHAR` even in
  relaxed mode (Tests 3, 5); strict (default, explicit `strict`, and
  `insecureHTTPParser: false`) rejects all control chars (Tests 1, 6, 8,
  9, 18, 19).
- Inbound: relaxed mode accepts control chars in header values on both
  sides (Test 10 client via `duplexPair`, Test 14 server via raw TCP —
  both gated on `kLenientHeaderValueRelaxed > 0`, which is 1024 here, so
  they RUN); strict inbound rejects (Test 10b expects client `error`;
  Test 15 expects `400` or empty).
- Test 16: `relaxed` does NOT enable duplicate-Transfer-Encoding leniency
  (double `chunked` TE → 400) but `insecure` DOES accept it (200) — so
  `relaxed` maps to only the header-value lenient flag, `insecure` maps
  to the full lenient set (same as `insecureHTTPParser`).

## Diagnosis (pre-fix)

- `httpValidation` appeared NOWHERE in `src/`: the shim had no relaxed
  path at all. The observed failure was `ClientRequest.setHeader`
  throwing `ERR_INVALID_CHAR` (`Invalid character in header content
  ["X-Test"]`) on Test 2's relaxed `setHeader("X-Test",
  "value\x01here")`.
- The shim parser did NOT validate header-value characters at all (no
  char check in `src/_http_parser.js` — only name token, bare-CR
  `HPE_LF_EXPECTED`, obs-fold, duplicate-CL, CL+TE checks). So strict
  inbound rejection (Tests 10b/15) is NEW validation, not a flag flip.
- Test 10/10b failed differently: THREE mustCall misses (the
  `createConnection: mustCall` factory, the response callback, Test 10b's
  `error` handler) — the duplexPair path never reached the round trip.
  Root cause: request-level `createConnection` was NEVER honored by the
  shim. The constructor leaves `agent` undefined when
  `options.createConnection` is a function, and no path in
  `_performRequest` ever called the request's own factory — such requests
  fell through to fetch(), where the duplexPair bytes go nowhere. The
  toctou test's `createConnection: () => {}` never connects, so it gave
  no evidence about the connected path.

## Probed real-Node behavior (v24.22.1)

- Mutual exclusion: ANY `httpValidation` value + ANY defined
  `insecureHTTPParser` (even `false`) → `ERR_INVALID_ARG_VALUE` "The
  property 'options.httpValidation' cannot be used together with
  options.insecureHTTPParser. Received 'relaxed'". Also `strict` +
  `true` throws the same way.
- Invalid value → `ERR_INVALID_ARG_VALUE` "The property
  'options.httpValidation' must be one of: 'strict', 'relaxed',
  'insecure'. Received 'bogus'". (The shim's factory wording differs —
  "The argument ..." — the suite asserts CODE only for Tests 12/13.)
- Server default, request with `\x01` value → `clientError`
  `HPE_INVALID_HEADER_TOKEN` / "Parse Error: Invalid header value char"
  → 400.
- Double chunked TE (two headers) → `clientError`
  `HPE_INVALID_TRANSFER_ENCODING` / "Parse Error: Invalid
  `Transfer-Encoding` header value" (backticks around Transfer-Encoding).
  Single header "chunked, chunked" → SAME TE error. Two headers gzip +
  chunked (chunked once) → 200 OK. Rule: chunked-token-count > 1 in the
  joined TE list, NOT header-count > 1.
- Client default, response with `\x01` value → request `error`
  `HPE_INVALID_HEADER_TOKEN` / "Parse Error: Invalid header value char"
  / reason "Invalid header value char".
- Server `insecureHTTPParser: true` alone → `\x01` request accepted,
  handler sees `"value\u0001here"`, 200. Server insecureHTTPParser IS a
  real full-leniency alias on Node — threading it as full leniency is
  Node-true, not scope creep.
- Inbound NUL under lenient mode (probed both sides): ACCEPTED —
  server-insecure handler sees `"va\u0000lue"`, client-insecure response
  sees `"va\u0000lue"`. The shim's lenient-skips-the-value-check matches.
- `createConnection` call shape: `factory({ port, host }, callback)` for
  TCP; for socketPath targets the options object is `{ socketPath,
  port: 80, host: "localhost", path: socketPath }`.

## Design

### Mode matrix (strict / relaxed / insecure)

|                     | strict (default) | relaxed | insecure (= insecureHTTPParser) |
|---------------------|------------------|---------|---------------------------------|
| Outbound value check | strict regex     | lenient (Fetch: only NUL/CR/LF + non-byte rejected) | lenient |
| Inbound value check  | strict → `HPE_INVALID_HEADER_TOKEN` | skipped | skipped |
| Obs-fold unfolding   | no               | no      | yes (PR #292) |
| Duplicate chunked TE | rejected         | rejected | accepted |

- `ClientRequest` constructor: validates `httpValidation` (unknown →
  `ERR_INVALID_ARG_VALUE` with "must be one of" reason; defined +
  `insecureHTTPParser` defined → `ERR_INVALID_ARG_VALUE` with "cannot
  be used together" reason), then `this._lenientHeaderValidation =
  (relaxed || insecure || insecureHTTPParser)`. Headers application
  passes it to `normalizeArrayHeaders(headers, lenient)`; a
  `ClientRequest._isLenientHeaderValidation()` override feeds the
  existing `setHeader`/`appendHeader` check (which already calls the
  polymorphic method). `validateHeaderValue`/`normalizeArrayHeaders`
  take an optional lenient param (default strict — backward compatible).
- `ServerBase` constructor: same validation pair; stores
  `_lenientHeaderValidation` (relaxed || insecure || insecureHTTPParser)
  and `_insecureParser` (insecure || insecureHTTPParser). Server parser
  creation passes both flags to `new HTTPParser("request", ...)`.
  `ServerResponse` gets `lenientHeaderValidation` from its construction
  options (all 3 sites) and overrides `_isLenientHeaderValidation()`.
  `_storeHeader`'s `pushLine` validates each value under the response's
  mode — covering writeHead-object headers (Tests 17/18), which render
  without value validation otherwise (kOutHeaders entries were already
  validated at set time, so re-checking is a no-op).
- Parser (`src/_http_parser.js`): imports `_checkInvalidHeaderChar` from
  `./_http_common.js` (no cycle — that module has no imports). New
  instance flag `lenientHeaderValue` (set by `relaxed` as well as
  `insecure`). In `_finishHeaders`, after the header-building loop and
  BEFORE the CL+TE check: (1) when `!lenientHeaderValue`, every
  `_rawHeaders` value failing the strict check throws
  `parseError("HPE_INVALID_HEADER_TOKEN", "Invalid header value
  char")` — values here are post-trim (the re-trim loop runs first),
  and obs-fold unfolded values are included (folding only runs in
  insecure mode, which is value-lenient, so no conflict); (2) when
  `!insecureHTTPParser`, the joined `transfer-encoding` distinct list
  is scanned for chunked tokens (`/(^|[, \t])chunked([, \t]|$)/gi`);
  count > 1 throws `parseError("HPE_INVALID_TRANSFER_ENCODING",
  "Invalid \`Transfer-Encoding\` header value")`. `_findLine` decodes
  latin1, so the string-level strict check is byte-exact.

### Request-level createConnection (Test 10/10b fix)

- Constructor stores the factory raw (`this._createConnection`) and the
  socketPath (`this.socketPath`, previously dropped entirely — a
  socketPath request's factory used to get bare `{ port, host }` and
  dial TCP instead of the path).
- `_performRequest` gains a gate AFTER the virtual/raw/websocket gates
  (so loopback targets keep their virtual routing —
  `test-http-client-with-create-connection` still routes virtually) and
  BEFORE fetch: if a request-level factory exists, call it with Node's
  args, then `onSocket(socket)` + `_performVirtualRequest(null, ...)`
  over that socket. All factory shapes (test-http-createConnection):
  sync return, async callback, both at once (first wins), sync throw,
  async callback error — via a settled-guarded promise. The factory
  vouches for readiness, so the socket is marked `_connected = true`
  before the round trip — otherwise `_performVirtualRequest`'s connect
  wait would hang on sockets with no `connect` event (native Duplex
  never emits one); the round trip's own `sock.connecting` wait still
  gates genuinely-connecting sockets. A factory that neither returns a
  socket nor calls back never settles, like Node's pending socket.

### Bonus flip (same root cause, same gate)

`test-http-createConnection` (base 1 → branch 0): it exercises exactly
the factory shapes above against a virtual server on a different port
than the request's default — it could only pass once request-level
factories are honored. It rides in this PR, not a separate one: one
root cause, one gate.

## Differential note (documented fail-to-fail mode change)

`test-http-client-with-create-connection`: base 124 → branch 1. Still
failing on both trees; the mode changes because the branch now CALLS
the factory (Node-true) instead of hanging in fetch. The factory's shim
`net.connect` to the PIPE path then fails `ENOENT`, exposing a
PRE-EXISTING, separate gap: `ServerBase.listen` treats a string
argument as a port (`Number(path)` → NaN → ephemeral port), so an http
server `listen(common.PIPE)` never registers a pipe server in the net
`_pipeServers` registry. Fixing listen(PIPE) is separate work, not in
this PR's scope; this test is not counted as a pass or a regression.

## Known gaps (not regressions, no test covers them)

- Trailer-line values are NOT validated (the trailer path records
  rawTrailers without a value check); `_chunkTerminator` trailer values
  stay strict (explicit `false`). Pre-existing gap.
- Inbound NUL under lenient mode is allowed by the shim — probed above
  as Node-true on both sides, so this is NOT a gap.

## Full differential (397-file sweep, deduped, no duplicate rows)

- Branch: 276 pass / 76 fail / 43 timeout / 1×134 / 1×139.
- Base (`8ec017b2`): 271 pass / 78 fail / 46 timeout / 1×134 / 1×139.
- Toward pass (5 lines, zero pass-to-fail):
  - `test-http-header-value-relaxed` 1→0 (the lane target).
  - `test-http-createConnection` 1→0 (same createConnection gate).
  - `test-http-insecure-parser-per-stream` 1→0 (server parser flag
    threading — previously the server parser got NO options at all).
  - `test-http-missing-header-separator-cr` 1→0 (strict inbound value
    check rejects the bare-LF header line → exact 400 the test expects).
  - `test-http-response-splitting` 124→0 (`_storeHeader` validation now
    throws `ERR_INVALID_CHAR` for writeHead-object headers, as Node does).
- Second fail-to-fail mode change: `test-http-insecure-parser` 124→1.
  The test carries a `--insecure-http-parser` flag the sweep does not
  pass, so the shim run is strict-correct: the branch rejects the
  `\x08` header value with a fast 400 (isolated run: expected 200, got
  `HTTP/1.1 400 Bad Request`) where the base hung. Failing on both
  trees; not a regression, not counted as a pass.
- All five flips isolated-verified 3/3 on the branch and failing on
  base; the two mode changes isolated-verified on both trees.
