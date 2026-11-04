# test-http-client-parse-error + test-http-client-error-rawbytes — client parse-error shape

## Test shapes

`test-http-client-parse-error`: a raw net server writes one of two
payloads per connection: (a) `HTTP/1.1 302 Object Moved\r\n
Content-Length: 0\r\n\r\nhi world` (trailing garbage after a complete
0-length response), (b) `bad http = should trigger parse error`. Both
requests must emit `error` with code `HPE_INVALID_CONSTANT`, message
`Parse Error: Expected HTTP/, RTSP/ or ICE/`; at error time
`req.socket.listenerCount("data") === 0` and `listenerCount("end") === 1`.

`test-http-client-error-rawbytes`: server writes `HTTP/1.1 200 OK\r\n
Content-Length: 6\r\nTransfer-Encoding: Chunked\r\n\r\n6\r\nfoobar0\r\n`;
the client must see `error` with message `Parse Error:
Transfer-Encoding can't be present with Content-Length`, code
`HPE_INVALID_TRANSFER_ENCODING`, `reason` =
`Transfer-Encoding can't be present with Content-Length`, `bytesParsed`
within bounds, `rawPacket` deep-equal to the response.

## Failure on pristine main `9f1da4ae`

Both exit 1, 3/3 runs, shim confirmed loaded (zz probe printing `SHIM` +
parseRequestArgs multi-line). Payload (a) got `RESPONSE 302` only, no
error; payload (b) got `ERROR` with the wrong message (`Parse Error:
invalid response prefix: bad http =`), `reason` undefined, and `end`
listeners = 2. Rawbytes failed only on line 35 (`err.reason`
strict-equal) — message, code, `bytesParsed`, `rawPacket` already right.

## Diagnosis — traced end to end, all probed on real Node v24.22.1

1. **Wrong constant message** (`src/_http_parser.js`): the partial
   start-line judge threw `invalid response prefix:...`, and the
   complete-line response branch fell through to `HPE_INVALID_VERSION`
   "malformed status line" for a non-`HTTP/` prefix. Real Node: a
   CRLF-terminated non-HTTP/ status line (`HTTX/1.1 200 OK`) is
   `HPE_INVALID_CONSTANT` / `Expected HTTP/, RTSP/ or ICE/`; a bad
   version (`HTTP/9.9`) is `HPE_INVALID_VERSION` / `Invalid HTTP
   version` on both request and response sides.
2. **`reason` missing on all parser errors**: `parseError()` set only
   `code` + `message`. Real Node parser errors carry `reason` = the
   raw llhttp reason (message without the `Parse Error: ` prefix),
   plus `bytesParsed` and `rawPacket` (which `execute()`'s catch
   already set).
3. **Extra `end` listener at error time**: the shim's no-op
   `socketOnEnd` (attached in `ClientRequest.onSocket()`, stored as
   `socket._requestEndListener`) made `end` == 2. Real Node has `end`
   == 1 at request-error time (stream-internal `onReadableStreamEnd`
   only); a plain connected net socket already has `end` == 1. The
   listener must NOT be removed at attach time:
   `test-http-agent-keepalive` `checkListeners` asserts `end` == 2 at
   assignment and `end` == 1 after free.
4. **Trailing garbage after a complete response never errors**: the
   round trip's `parser.onMessageComplete` settled the promise
   immediately, detaching listeners mid-`execute()`; the parser loop
   then parsed `hi world` → `onError` → `fail` no-op (settled).
5. **Streaming-catch code corruption** (found by fixing 4): the round
   trip's `onHeaders` always creates a streamed message and emits
   `response` at headers, so a 302's `response` fires before the
   trailing-garbage error. The `_performVirtualRequest` catch treated
   every streamed failure as a socket destroy: it MUTATED the parse
   error's code to `ECONNRESET` and emitted it on the response stream
   — with no response `error` listener in the test, that throw
   propagated to the request's `error` as `ECONNRESET` + parse message.
   Real Node reports a post-response parse error on the REQUEST, not
   the response stream.

## Fix (`src/_http_parser.js` + `src/http.js` only)

- `parseError(code, message, reason?)` sets `err.reason` (explicit
  reason, else the raw message text). Both `onError` normalization
  sites (server `parser.onError`, round-trip `parser.onError`) set
  `reason` for the `HPE_INVALID_METHOD` special case, derive it from
  the pre-prefix message otherwise, and leave the bare `Parse Error`
  EOF shape unprefixed (see the companion EOF lane).
- Response start-line judging: partial and complete non-`HTTP/`
  prefixes → `HPE_INVALID_CONSTANT` / `Expected HTTP/, RTSP/ or ICE/`;
  version failures → `HPE_INVALID_VERSION` / `Invalid HTTP version`
  (request side too, was `unsupported version: ...`).
- Round-trip `fail()` detaches ONLY `socket._requestEndListener`
  before rejecting — not the full `_removeRequestSocketListeners`
  (which would drop the error/close/timeout listeners real Node keeps,
  and break the deferred agent untrack on the close listener).
- Round-trip `onMessageComplete` records a pending result (first
  wins) instead of settling; `onData` settles it after `execute()`
  returns, and `onSockClose` settles it after `parser.end()`. A parse
  error later in the same `execute()` therefore wins over the
  response (via `fail()`), while a second complete message never
  overwrites the first. CONNECT/101 settle-at-headers paths untouched.
- `_performVirtualRequest` streaming catch: an `HPE_*` error aborts
  + destroys the streamed message and is RETHROWN unmutated, so the
  request's `error` carries the parse error; non-`HPE_*` errors keep
  the existing aborted + `ECONNRESET` response-error mapping.

## Documented divergences (not regressions)

- Real Node emits BOTH `response` 302 AND request `error` for payload
  (a); the shim emits `response` 302 (via `onHeaders`) and request
  `error` too — the error is what the test counts, and it now fires.
  (Verified: the test passes; the probe sequence is RESPONSE 302 →
  request `error` HPE_INVALID_CONSTANT.)
- Split-chunk trailing garbage (garbage arriving in a LATER chunk,
  after the round trip settled) still never errors: the round trip is
  over and the parser detached. No official test covers it; it is a
  deeper parser-ownership gap, same class as the lane-11 hold.
- `end()` still emits `HPE_TRUNCATED` for a buffered partial at EOF:
  the repo suite (`tests/http-socket.test.js`) asserts that code at
  the parser level, and real Node's `HPE_INVALID_EOF_STATE` wire code
  applies on the SERVER side only — the server `onError` mapping for
  it belongs to the companion EOF lane (PR2), not to the shared
  parser. The round trip's `HPE_TRUNCATED` carve-out is unchanged.

## Companion server fix (required by the client change)

The deferred-error rule above regressed `test-http-head-request`
(0 → 1 in the branch sweep; isolated 1/1/1 vs base 0/0/0): a HEAD
response with `Transfer-Encoding: chunked` now failed with request
`error HPE_INVALID_CONSTANT` and its `end` mustCall firing 0 times.

Root cause is server-side, exposed by the client fix: the shim
server appended the chunked terminator `0\r\n\r\n` after a HEAD
response (buffered path in `_finishSocketResponse`, plus the two
streaming terminator sites). The old client swallowed it — the
response settled at `onMessageComplete` before the terminator parsed.
With deferred settling, the terminator parsed as a new message start
(`HPE_INVALID_CONSTANT`) and the error won, aborting the response
before `end`. Real Node sends headers-only for HEAD+chunked in every
probed variant (writeHead+end with close and keep-alive,
flushHeaders), so the terminator is shim-only bytes, not legitimate
framing. (Method note: probes run from `/tmp` do NOT load the shim —
the preload redirect applies to files under the repo — so byte
comparisons must use `zz-*.js` probes under
`parity/node-test/parallel/`, not `/tmp` scripts.)

Fix (`src/http.js`, three terminator sites, same rule): never send
the chunked terminator for a HEAD response — `ServerResponse.end()`
streaming write, `_finishSocketResponse` streaming branch, and
`_finishSocketResponse` buffered path (`else if (!noBodyStatus &&
req.method !== "HEAD")`, falling through to headers-only). 204/304
handling is unchanged (already headers-only via `noBodyStatus`).
Without this companion fix PR1 is unshippable (zero pass-to-fail
rule); as a standalone change it would show no differential (the
test passes on main today), so it rides in this PR by necessity.

Guards for the terminator change: head-request, chunked-304,
server-keep-alive-defaults, proxy, keep-alive, chunked, 1.0,
1.0-keep-alive, head-throw-on-response-body-write — all exit 0.

client-parse-error, client-error-rawbytes, client-reject-chunked-with-
content-length, client-reject-cr-no-lf, client-reject-unexpected-agent,
extra-response, agent-timeout, upgrade-client2,
outgoing-message-capture-rejection, client-timeout-event,
socket-encoding-error, content-length, content-length-mismatch,
chunked, response-close, outgoing-destroyed, 1.0, byteswritten,
head-throw-on-response-body-write, readable-data-event,
server-reject-chunked-with-content-length, server-reject-cr-no-lf,
invalid-te, missing-header-separator-lf,
server-multiple-client-error, server-destroy-socket-on-client-error,
server-client-error, keep-alive, agent-keepalive,
client-abort-keep-alive-destroy-res.
