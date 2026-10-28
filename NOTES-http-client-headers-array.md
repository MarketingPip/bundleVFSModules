# NOTES: ClientRequest array-form headers (multiheaders lane)

Base: main @ 877726d4 (PR #257, streaming client writes).
Branch: fix/http-headers-array. Files: src/http.js, src/_http_parser.js.

## The gap (triage §3/§14)

`http.get` with headers given as an ARRAY of `[name, value]` pairs arrived
server-side with every custom header undefined. The server parser was
innocent (a raw-socket control probe joins duplicates correctly) — the
drop was client-side: the ClientRequest constructor iterated
`Object.keys(options.headers)`, which for an array yields indices
("0", "1", ...) and stored pair arrays as garbage header values.

## Real-Node behavior probed first (Node v24.22.1, /tmp/probe-headers*.js)

- Accepted forms: array of `[name, value]` pairs AND flat alternating
  `[name, value, ...]` strings. Each pair is one wire line, verbatim
  casing, duplicates preserved, in order.
- No auto `Host` when array headers are supplied (even when no host pair
  is present); no auto `Authorization` from `options.auth` either.
- Array headers bypass `kOutHeaders`: `getHeaders()` is `{}`, `getHeader()`
  is `undefined`, `hasHeader()` is false, `getHeaderNames()` is `[]`,
  `headersSent` is true from construction, and `setHeader()` /
  `removeHeader()` throw `ERR_HTTP_HEADERS_SENT`.
- An array value inside a pair expands to one line per element
  (`["cookie", ["a=1", "b=2", "c=3"]]` → three cookie lines, joined
  server-side with `"; "`).
- Number values coerce to strings (`"5"`). An `undefined` value throws
  `ERR_HTTP_INVALID_HEADER_VALUE` (this is also what a non-array entry in
  pairs mode, or a short pair, reduces to). An odd-length flat array
  throws `ERR_INVALID_ARG_VALUE` at construction.
- Server fold: singleton headers drop later duplicates (first wins —
  host, content-type, user-agent, referer, authorization, …); other
  duplicates join with `", "` (cookie with `"; "`); set-cookie stays an
  array. `headersDistinct` keeps EVERY value, including dropped ones.
  `req.headers` has `Object.prototype`; `req.headersDistinct` is
  null-prototype.
- Object-form `host` given as an array throws `ERR_INVALID_ARG_TYPE` at
  construction — but `setHeader("host", [])` does NOT throw, so the check
  lives in the constructor, not in `setHeader`. A host pair with an
  array value does NOT throw (it expands to lines).
- A request with NO host pair at all gets a 400 from a real Node server
  (missing Host) — so suppressing the shim's `Host: localhost` fallback
  for array requests is wire-faithful and safe for the target tests
  (both supply host pairs).

## Root causes fixed (three, not one)

1. **Client (src/http.js):** constructor normalizes array headers via
   `normalizeArrayHeaders()` into stashed `this._headersArray` pairs
   (validated at construction, before agent/socket activity — a throw
   after `agent.addRequest()` leaves a connection attempt racing the
   failed construction and crashes with an unhandled `ECONNREFUSED`,
   which is how the host-array test first failed). Object-form behavior
   is untouched. `_mergeArrayHeaders()` folds the pairs into the virtual
   round-trip headers as array values, so `_serializeRequestHead` (which
   already emitted one line per array element) writes one line per pair.
   The streaming start path (`_streamEnsureStarted`) consults the stashed
   pairs for content-length / transfer-encoding / upgrade and folds the
   chunked framing header into the merged headers instead of `setHeader`
   (which throws for array requests). `_performVirtualRequest` /
   `_socketHttpRoundTrip` / `_serializeRequestHead` take a `noDefaultHost`
   flag so array requests without a host pair send no `Host` line.
   Object-form requests pass the same reference through and see zero
   behavior change.
2. **Server fold (src/http.js `IncomingMessage._applyRawHeaders`):** was
   joining ALL duplicates with `", "`. Now implements Node's rule:
   `DUPLICATES_REMOVED` set is first-wins, cookie joins with `"; "`,
   others with `", "`, distinct keeps every line's value. Also uses
   `hasOwnProperty` instead of `in` (a `"constructor"` header must not
   read `Object.prototype`), and `headersDistinct` is now null-prototype
   (probed Node behavior; also what
   `test-http-headers-distinct-proto` asserts).
3. **Parser (src/_http_parser.js `_finishHeaders`):** the same prototype
   trap lived here — `info.headersDistinct` was a plain object, so a
   `"constructor"` header read `Object` and `.concat` threw, surfacing
   as a server 400 (this was the actual v1 blocker, found by bisecting
   v1's header set: every subset passed except the constructor trio).
   Fixed the same way (null-prototype distinct + `hasOwnProperty` for
   the join check). The parser's `info.headers` fold is internal only
   (dispatch and response paths rebuild from `rawHeaders`), so it keeps
   joining.

## Results (PARITY_TARGET=http)

| Test | Before (base 877726d4) | After |
|---|---|---|
| test-http-server-multiheaders | 124 | 0 |
| test-http-server-multiheaders2 | 124 | 0 |
| test-http-client-headers-array | 0 | 0 (unchanged) |
| test-http-client-headers-host-array | 1 | 0 |
| test-http-headers-distinct-proto | 1 | 0 |
| test-http-multiple-headers | 1 | 1 (uniqueHeaders option unimplemented; out of scope) |

Guards: agent family, keep-alive family, chunked, outgoing core,
blank-header, get-pipeline-problem, keep-alive-close-on-header,
test-http-server, all twelve PR #254 timeout flips,
test-http-server-options-incoming-message,
test-http-server-consumed-timeout — all still pass. Every non-zero
result in the wider header/outgoing sweep (automatic-headers,
default-headers-exist, dont-set-default-headers ×3, flush-headers,
flush-response-headers, host-headers, mutable-headers, content-length
×2, information-headers, invalidheaderfield, header-badrequest,
outgoing-buffer/destroy/destroyed/drain-writable-length/end-cork/
end-multiple, max-headers-count, client-reject-chunked-with-content-
length, double-content-length, no-content-length, multi-line-headers,
missing-header-separator ×2) reproduces IDENTICALLY on pristine base
— zero regressions.

## Known gaps left (not in this PR)

- `__proto__` as a header name: assignment onto the plain-object
  `req.headers` is a prototype-set no-op, so it vanishes from
  `req.headers` (distinct carries it correctly). No target test covers
  it; fixing it means `defineProperty`-style assignment in
  `_applyRawHeaders`.
- `uniqueHeaders` option (test-http-multiple-headers): server/client
  `"; "`-join semantics for listed headers — separate feature.
- Virtual-path object-form `Host` is `localhost` (serializer default)
  rather than `localhost:port` — pre-existing, unrelated to array
  headers; several default-header tests hang on it.
