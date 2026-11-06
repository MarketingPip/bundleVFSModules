# NOTES — http response-write lifecycle (triage rank 11)

Base: main `67448061` (PR #338 merged; actual http 328/397, recorded 315).
Scope: `src/http.js` only (+ this file). 8 of 9 targets flipped; 1 NO-FIX.

## Flips (all verified exit 0 on the fix worktree, 3 runs each on base first)

### 1. test-http-early-hints-invalid-argument — 124 → 0
Ported Node's link validation (`lib/internal/validators.js:522,557`):
`linkValueRegExp` + `validateLinkHeaderValue` (string → format check;
array → join with ", "; else `ERR_INVALID_ARG_VALUE`). `writeEarlyHints`
validates the Link value FIRST (Node order, `lib/_http_server.js:374-381`):
null/undefined/empty link returns silently (no 103, no callback); malformed
link → `ERR_INVALID_ARG_VALUE`; link with bad chars → `ERR_INVALID_CHAR`
(`_checkInvalidHeaderChar`); other headers validated after via the 103 write.
Kept the existing headersSent → `ERR_INVALID_ARG_VALUE` behavior (probed)
and the callback-on-success behavior.

### 2. test-http-response-status-message — 124 → 0
The parser already preserves empty statusMessage
(`src/_http_parser.js:529`, `statusMessage: m[4] || ""`), but six round-trip
sites masked it with `||`: `info.statusMessage || STATUS_CODES[...] || ""`
(2 sites: onHeaders, onInformation), `result.statusMessage || ...` (3 sites:
isConnect, isUpgrade, final response), and `response.statusText || ...` in
`fromFetchResponse`. All six changed to `??`. (The 124 was a swallowed
handler throw: the assert on `""` vs `"OK"` threw inside the response
handler, the round-trip try/catch swallowed it, countdown never
decremented.) NOT changed: `ServerResponse.writeHead`'s
`this.statusMessage || STATUS_CODES[statusCode] || "unknown"` — Node uses
`||=` there too (`lib/_http_server.js:426-427`), so the shim matches.

### 3. test-http-response-statuscode — 124 → 0
Two defects in `ERR_HTTP_INVALID_STATUS_CODE`: (a) `name` was `"Error"`,
must be `"RangeError"` (Node defines it as RangeError,
`lib/internal/errors.js:1343`, message `'Invalid status code: %s'`);
(b) message rendered `{}` as `[object Object]` and `[]` as `` — Node's `%s`
uses util.format/inspect (`{}` → `"{}"`, `[]` → `"[]"`). Added
`_formatPercentS` (primitives via `String()`; arrays `[a, b]`; plain objects
`{ k: v }`, `{}` when empty; recursive) and the factory now calls
`makeError("ERR_HTTP_INVALID_STATUS_CODE", \`Invalid status code:
${_formatPercentS(code)}\`, RangeError)`. Probed on real Node v24.22.1.

### 4. test-http-incoming-message-options — 124 → 0
The net Socket already honored `readableHighWaterMark` (probe:
`socket.readableHighWaterMark` = 1024), but `res.readableHighWaterMark` was
65536 (default). Node builds the message with the socket's readable HWM
(`lib/_http_incoming.js:63`). Fix: `IncomingMessage` constructor now syncs
`this._readableState.highWaterMark = socket.readableHighWaterMark` when the
passed socket has a numeric one (FakeSocket has none, default stands); the
five client round-trip sites (`new IncomingMessage()` — onHeaders,
onInformation, isConnect, isUpgrade, final response) now pass
`this.socket`. Server path already passed the socket; `fromRequest` and
`fromFetchResponse` left as-is (no socket); websocket upgrade site already
passed socket.

### 5. test-http-response-cork — 124 → 0
Three parts, all grounded in `lib/_http_outgoing.js:237,288-298` and
`lib/_http_outgoing.js:1124-1190`:
- `OutgoingMessage` overrides `cork()`/`uncork()` to call `super` (Writable
  state) AND `this.socket?.cork()/uncork()` — the message and socket
  `writableCorked` counters move together (the test asserts equality after
  every cork/uncork/end). `FakeSocket` (src/http.js:481) gained a cork
  counter + `writableCorked` getter (was empty stubs).
- `end()` fully uncorks message AND socket (`_fullyUncork()`, mirroring
  Node's end tail at 1179-1184: socket `_writableState.corked = 1` then
  `uncork()`, message `kCorked = 1` then `uncork()`), called from all three
  `end()` overrides (OutgoingMessage, ServerResponse, ClientRequest) before
  the chunk is routed — otherwise a corked `res.end(chunk)` deadlocks
  behind the still-corked Writable buffer (the test corks twice, uncorks
  once, then ends).
- The buffered chunked finish path in `_finishSocketResponse` now emits
  Node's five separate `socket.write` calls for an end(chunk) chunked
  response (header+size digits, CRLF, body, CRLF, terminator —
  `lib/_http_outgoing.js:382-411,1141-1177`; the test counts exactly 5).
  Call 1 is header + size digits WITHOUT the line CRLF — Node's first
  `_send` writes the size bare and the CRLF is the second call; appending
  `"\r\n"` to call 1 emitted a spurious empty line and desynced the
  client's chunk parser. The no-body chunked case splits into 2 writes
  (header, terminator), matching Node. The 'data'-event-per-response
  concern that motivated the old coalescing does not apply to this branch:
  the tests counting data events use non-chunked responses
  (test-http-1.0-keep-alive is HTTP/1.0, no chunked framing) or write() +
  chunkless end (test-http-server-keep-alive-defaults, streaming branch).

### 6. test-http-flush-headers — 124 → 0
`_streamEnsureStarted()` eligibility excluded plain GET/HEAD (no CL, no
chunked TE, no upgrade) → `_stream = null` → `flushHeaders()` did nothing,
head never dispatched. Fix: `_streamEnsureStarted(force)` bypasses the
method/body eligibility when forced (still requires a virtual server and
non-CONNECT); `ClientRequest.flushHeaders()` calls it forced. The streaming
round trip sends `headBytes` immediately, so a forced start dispatches the
head promptly; later `write()`/`end()` flow through the stream (GET framing
is "raw" per the existing framing rule).

### 7. test-http-write-callbacks — 1 → 0 (ordering only)
The full flow already worked; the test asserts the client end callback
inside the 'response' handler, but the shim fired it at round-trip
resolution (after the response). Node's ordering is emergent
flush-then-parse: the end callback fires at Writable finish (bytes flushed
to the socket), before the server can respond. Fix: in `ClientRequest.end()`,
for the streaming path, after `_streamFinish()`, fire `finish()` (end
callback + `'finish'` event + `_flushDeferredWriteCallbacks(null)`) via
`queueMicrotask` instead of at round-trip resolution; `run()` skips
`finish()` if already fired (guarded by `_outgoingFinishEmitted`); the error
path skips its second end callback when finish already fired (a later
round-trip failure surfaces via `'error'` only). A probe confirmed the
response delivery is async (several hops past `end()`), so the microtask
lands before `'response'`. The buffered path is untouched (finish still at
round-trip resolution — the body hasn't been flushed when `end()` returns).

### 8. test-http-sync-write-error-during-continue — 1 → 0
The head never reached the serverSide duplexPair: the factory is only
invoked in `_performRequest` at `end()`, and `end()` is only called inside
`'continue'`. Fix:
- Extracted `_invokeFactory()` from the `_performRequest` factory branch
  (identical semantics: sync return / async callback / both-at-once /
  sync throw / async callback error; sync-return sockets wired via
  `onSocket` immediately). The stored promise is reused, never re-invoked
  (the factory's mustCall expects exactly 1 call).
- Constructor early kick: when a factory AND an Expect header are present,
  `this._factorySocketPromise = this._invokeFactory()` at construction end
  (errors stay on the promise; a trailing `.catch(()=>{})` marks it handled
  so a factory that errors before any `end()` never becomes an unhandled
  rejection). `_performRequest` awaits the stored promise when present.
- `onSocket`'s Expect hook force-starts the stream for factory sockets
  (`_streamEnsureStarted(true)`); `_streamEnsureStarted(force)` allows a
  null virtual server when forced AND a real (non-FakeSocket) socket is
  assigned — the round trip is `_performVirtualRequest(null, ...)`, the
  factory shape `_performRequest` already used. Virtual targets keep the
  unforced call.
- Root-cause side fix (constructor Host rendering): Node's `defaultPort`
  has NO 80 fallback (`lib/_http_client.js:390`: `options.defaultPort ||
  agent.defaultPort`) — for an agent-less (factory) request it is
  `undefined`, so the Host header keeps `":80"` (`80 !== undefined`).
  The shim's `|| 80` rendered `"Host: localhost"` and broke the test's
  exact-head assertion (`Host: localhost:80`, probed on real Node
  v24.22.1). The port itself still falls back to 80 on the next line.
  Agent requests are unaffected (globalAgent defaultPort is 80).

## NO-FIX: test-http-no-read-no-dump — still 124
The server must emit `'pause'` on `req.connection` when the unconsumed req
body buffer fills (client writes 64KB after the 200 head, handler never
reads req); then `res.end()` + client `post.end("something")`; req must
`'close'` without `'end'`; the queued GET on the same keep-alive agent must
proceed. The mechanism does not exist in the shim:
- The pause here is NOT the `parserOnIncoming` writable-side gate
  (`lib/_http_server.js:1182-1189` — outgoing backpressure; the response
  head is tiny). The real mechanism is the req-stream backpressure chain:
  `IncomingMessage._read` → `readStart`/`readStop`
  (`lib/_http_incoming.js:47-54,258-268`), response-finish `req._dump()`
  (`lib/_http_server.js:1115-1118`) / `_dumpAndCloseReadable()`
  (`lib/_http_server.js:1224`, `lib/_http_incoming.js:490`), with the
  parser's onBody push living in the C++ binding layer.
- In the shim: `IncomingMessage._read` is a no-op (src/http.js:1675),
  `_dump()` doesn't exist (separate follow-up from #336), and there is no
  dump-without-socket-destroy path — shim `_destroy` destroys the socket
  for incomplete messages, which would kill the keep-alive socket the GET
  needs. Building the pause/resume/dump/close coordination across the
  parser, the socket, and the response-finish path is a multi-surface
  design change, not a lane fix — and the virtual transport's synchronous
  delivery makes the pause-during-drain ordering reentrant through
  `res.end()`. Closed NO-FIX; revisit only with a design for the
  `_dump()` + pause/resume surface as a whole.

## Guards / differential
TODO at ship time (see lane brief): outgoing-* family, flush-response-headers,
write-information, information-headers, early-hints, response-close,
response-drain-cork, write-head, expect-continue family; full 397 fast-sweep
differential `http-sweep-rw-{branch,base}.csv`; jest 3059/7/1; ondemand 29/29;
three build checks; `dist/` restored.
