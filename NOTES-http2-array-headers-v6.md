# NOTES-http2-array-headers-v6.md — H2-V6: array-form headers + rawHeaders

Ship section: PR #498 / merge SHA 2ea75e5c.

## What changed

`src/http2.js` only (+ a one-line repo-jest correction in
`tests/http2.test.js`, see "Jest conflict" below):

- `ClientHttp2Session.request()` accepts flat `[k, v, ...]` arrays as well
  as objects (previously threw `ERR_INVALID_ARG_TYPE` on arrays).
- `Http2Stream.respond()` accepts flat arrays as well as objects, and
  normalizes both per the oracle (below): `:status` defaults to 200,
  a `date` is auto-added unless one is present or `sendDate` is false.
- The compat response exposes `rawHeaders` as the 3rd `"response"`
  event argument; the server `"stream"` event and
  `Http2ServerRequest.rawHeaders` now carry the pseudo-headers too, in
  wire order (pseudo first, names lowercased, duplicates in order).
- `stream.sentHeaders` is a null-prototype object (was a plain-object
  spread); the client's `req.sentHeaders` now reports the request
  headers.
- `Http2ServerRequest.authority` falls back to the `host` header when
  `:authority` is absent (Node `getAuthority` semantics).
- `Http2ServerResponse.writeHead()` passes `this.sendDate` into
  `respond()` (Node `compat.js:900`).

## Oracle (Node v24.20.0 source, `hidden_files/node-src/`)

- `lib/internal/http2/util.js:621` `prepareRequestHeadersArray` — missing
  pseudo-headers are PREPENDED in canonical order
  (`:method, :authority, :scheme, :path`); defaults from the session
  (`GET`, session authority, session scheme, `/`).
- `lib/internal/http2/util.js:711` `prepareRequestHeadersObject` — verbatim
  copy, then missing pseudo-headers are APPENDED by assignment.
- `lib/internal/http2/util.js:968` `getAuthority` — `:authority` first,
  then `host`; `:authority` is NOT defaulted when `host` is present.
- `lib/internal/http2/core.js:2211-2239` `sentHeaders` getter — folds the
  raw array into a null-prototype object (duplicates fold to arrays, case
  preserved); `core.js:1889` stores it only for object headers — the shim
  now stores it for both forms.
- `lib/internal/http2/core.js:2688` `prepareResponseHeadersArray` — scan
  pairs (case-insensitive) for `:status` (coerced `| 0`) and `date`; a
  missing `:status` 200 is UNSHIFTED to the front, a missing date is
  PUSHED to the end.
- `lib/internal/http2/core.js:2654` `prepareResponseHeadersObject` — copy
  own keys; `:status` coerced `| 0 || 200` and assigned back (appends if
  missing); `hasDate` checks the EXACT key `'date'` with value != null;
  date appended if absent and `sendDate` (default true).
- `lib/internal/http2/core.js:766` `buildNgHeaderString` — wire order is
  ALWAYS pseudo-headers first (input relative order), then regulars
  (input relative order); names lowercased, values stringified.
- `lib/internal/http2/compat.js:900` `[kBeginSend]` passes
  `sendDate: state.sendDate` into `stream.respond()`.
- `lib/internal/http2/compat.js:419-421` — `Http2ServerRequest.authority`
  is a getter over `getAuthority(this[kHeaders])`.

## Probes (real Node, plain `node`, since deleted)

Array input, all pseudo given: sentHeaders keeps given order, null
prototype, duplicates fold (`a: ["b","c"]`), case preserved (`x-FOO`).
Array input, none given: missing pseudo-headers PREPENDED in canonical
order `:method,:authority,:scheme,:path` (defaults GET, session
authority, session scheme, `/`). Array input, `:path` only: `:method,
:authority, :scheme` prepended before `:path`. Object input, `:path`
only: missing defaults APPENDED (`:path, x-foo, :method, :authority,
:scheme`). Server stream rawHeaders: pseudo in SENT relative order,
then regulars in sent order, regular names lowercased, duplicates
preserved. Server `stream.sentHeaders` (array respond): null prototype,
case preserved, duplicates folded, `:status` as STRING `"404"` (given
as string), NO auto date when `DATE` explicitly given. Client response
rawHeaders: `:status` first, then regulars in input order, names
lowercased, values stringified, date in its input position if given.
`respond({x: "1"})` (object, no `:status`/date): sentHeaders
`{x: "1", ":status": 200, date: "<toUTCString>"}` — `:status` appended
AFTER given keys as NUMBER 200, date appended last. Client rawHeaders
`[":status","200","x","1","date","..."]` — `:status` hoisted FIRST on
the wire. Odd-length array: NO throw; orphan pairs with `undefined`
(invisible in JSON output). Symbol keys: `rawHeaders[sensitiveHeaders]`
is preserved onto sentHeaders. `respond()` with duplicate `expires`
keys throws natively `ERR_HTTP2_HEADER_SINGLE_VALUE` unless
`strictSingleValueFields: false` is passed — the shim ignores that
option and won't throw (out of scope, V4 territory).

## Normalization (as implemented)

- `normalizeRequestHeaders(headers, session)` in `src/http2.js`:
  array path folds the pairs (missing pseudo defaults prepended);
  object path copies verbatim then appends missing pseudo defaults
  (`:authority` skipped when `host` is present). Both return
  `{ headersObject, rawPairs }`; symbol keys copied both ways.
- `normalizeResponseHeaders(headers, options)`: array path scans for
  `:status`/date, unshifts 200, pushes date; object path copies then
  coerces `:status` (`| 0 || 200`) and appends date. Both return
  `{ headersObject, rawPairs }`; `options.sendDate === false` suppresses
  the date.
- `toWireRawHeaders(rawPairs)`: pseudo first (input relative order),
  then regulars (input relative order); names lowercased, values
  `String()`.
- `connect()` stores `session._authority = url.host` and
  `session._scheme = url.protocol.slice(0, -1)` for the request
  defaults.
- `Http2ServerRequest.rawHeaders` and the `"stream"` event rawHeaders
  derive from `stream._requestRawPairs` (fallback: derive from the
  headers object, for host-bridge streams). `_deliverResponse()` emits
  `"response"` with rawHeaders as the 3rd argument from
  `stream._responseRawPairs` (fallback: derive from the sent object).

## The `_sentHeaders` trap (found in-lane, probe-proven)

`request()` first stored the request headers in `stream._sentHeaders`.
That broke the virtual loop: `_responseStarted` is a getter keyed on
`_sentHeaders !== null`, so the client's `end()` took the server branch
and delivered a "response" made of the request headers before the
server handler ever ran (and the dispatch microtask then bailed on the
closed stream, so the `"stream"` handler never fired). Fix: the request
headers live in a separate `stream._requestSentHeaders`; `_sentHeaders`
keeps meaning "response headers sent". The `sentHeaders` getter returns
the response headers once `respond()` has run, else the request headers.

## The `sendDate` regression (found in-lane, guard-caught)

The first 50-test branch run went 49/50:
`test-http2-compat-serverresponse-headers-send-date` regressed — the
handler sets `response.sendDate = false`, but `writeHead()` called
`respond(out)` with no options, so the date was auto-added. Fixed by
passing `{ sendDate: this.sendDate }` (oracle `compat.js:900`). Rerun:
50/50. Known leftover in the same cluster: the oracle's
`removeHeader('date')` also sets `sendDate = false` (`compat.js:625`);
the shim's `removeHeader` does not — no vendored test covers it.

## Jest conflict (resolved in-lane)

`tests/http2.test.js:525` "respond() records sentHeaders without I/O"
expected `sentHeaders` to equal `{":status": 201, "x-a": "b"}` — NO date
key. But real Node's `respond()` DOES auto-add `date`, and the parity
test `test-http2-raw-headers-defaults` requires it
(`stream.sentHeaders.date` is a string). The repo test pinned the
shim's incomplete behavior; updated to expect
`{":status": 201, "x-a": "b", date: expect.any(String)}` (same class as
the Z5 repo-test replacement). Jest http2 stays 66/66.

## Differential (branch `fix/http2-array-headers-v6`, base `40e3df7a`)

Flips — each [0,0] on branch, [1,1] on pristine main (isolated, 2×):

- `test-http2-raw-headers` (expected, probable)
- `test-http2-raw-headers-defaults` (expected, probable)
- `test-http2-multiheaders-raw` (bonus — server rawHeaders: pseudo
  first + lowercased names, supplied by the fix)
- `test-http2-single-headers-validation-disabled` (bonus — server
  rawHeaders.slice(8) + response rawHeaders.slice(2,10), supplied by
  the fix; the response has no date asserted in the slices)
- `test-http2-compat-serverrequest-host` (bonus — the `host`-present
  `:authority` skip + the `authority` fallback; rawHeaders supplied by
  the fix)

Guards — 0 regressions: the full 45-test old pass set (35 triage passes
+ F1 ×3 + V2 + V3 ×2 + V1 ×3 + V5) passes 45/45 on base AND 50/50 on
branch (45 old + 5 new). Footprint 29/29. Jest http2 66/66.

New count: **50/277** (45 banked + 5 flips).

## Not flipped (expected, per triage + probes)

- `test-http2-sent-headers` — server `sentHeaders` assertions now pass,
  but the client's informational `"headers"` event (`:status` 102) is
  never emitted by the shim; mustCall never fires.
- `test-http2-sensitive-headers` — sensitiveHeaders computation on the
  response + duplexPair/`createConnection` transport; out of scope.
- `test-http2-compat-serverrequest-headers` — method setter throws
  `ERR_INVALID_ARG_VALUE`/`ERR_INVALID_ARG_TYPE`; V4 validation
  territory.
- `test-http2-util-headers-list` — internal `\x00`-separated
  header-list serialization.
- `test-http2-zero-length-header` — server headers object expects null
  prototype + `[sensitiveHeaders]: []` symbol + dropped `""` header +
  an unexplained pseudo order `:scheme,:authority,:method,:path`;
  out of scope, do not chase.
