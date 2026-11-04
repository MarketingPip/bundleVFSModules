# Interim-response family (100 Continue / 103 Early Hints / informational delivery)

## Root cause

`src/http.js` treated every 1xx as a noop: `writeContinue()` /
`writeProcessing()` were empty, `writeEarlyHints()` only fired its
callback, `writeInformation()` only fired its callback and returned
`false`, and the server auto-sent `100 Continue` for ANY `Expect:
100-continue` request without checking for `checkContinue` listeners.
There was no `checkContinue` / `checkExpectation` dispatch at all, and
the client round trip settled a 1xx as the final `response`.

## What changed (`src/http.js` only)

- `OutgoingMessage` interim methods now write real wire bytes to the
  response socket (`HTTP/1.1 100 Continue`, `102 Processing`, `103
  Early Hints` + headers, `<code> <STATUS_CODES[code]>` + headers),
  with probed real-Node (v24.22.1) validation: non-number status →
  `ERR_INVALID_ARG_TYPE`, 101 → `ERR_HTTP_INVALID_STATUS_CODE`,
  outside 100–199 → `ERR_OUT_OF_RANGE`, bad header name →
  `ERR_INVALID_HTTP_TOKEN`, headers sent → `ERR_HTTP_HEADERS_SENT`
  (writeContinue / writeProcessing / writeInformation) or
  `ERR_INVALID_ARG_VALUE` (writeEarlyHints, probed). `writeInformation`
  returns `true`. Array link/header values join with `", "`. Empty
  hints (`{}` / all-empty arrays) send nothing, so the client sees no
  `information` event. Callbacks fire via `queueMicrotask`.
- Client round trip (`_socketHttpRoundTrip`): new `onInformation`
  option. A 1xx (except 101 upgrade) routes there instead of
  `onHeaders`, and never settles `pendingResult`. `_performVirtualRequest`
  builds a full `IncomingMessage` for it (status, 1.1, raw headers
  preserved) and emits `continue` for 100, `information` otherwise.
- Server auto-ack gated on `listenerCount("checkContinue") === 0`
  (previously unconditional).
- Server dispatch (`_dispatchSocketRequest`): `Expect: 100-continue`
  + checkContinue listeners → `checkContinue` event (never `request`);
  other `Expect` + checkExpectation listeners → `checkExpectation`;
  other `Expect` + neither listener → 417 `Expectation Failed` with
  `Connection: close` through the normal finish machinery (mirrors the
  drop branch). `captureRejections` still covers `request` only.
- Body callbacks (`parser.onBody` / `onMessageComplete`) moved inside
  dispatch, before emit: a handler's synchronous `writeContinue()` pulls
  the request body reentrantly through synchronous virtual delivery,
  and the old post-dispatch wiring dropped that body and never fired
  req `end`.
- Client: at socket assignment, a request carrying an `Expect` header
  starts the streaming round trip (`_streamEnsureStarted`) so its head
  reaches the server before `end()` — an expect-continue client only
  ends after `continue` fires, so a buffered head would deadlock.
  Stream-ineligible shapes (GET + Expect) and non-virtual targets keep
  the buffered path.

## Verified

- Targets, 4 runs each: test-http-expect-continue,
  test-http-expect-handling, test-http-information-headers,
  test-http-information-processing, test-http-early-hints — all pass.
- Guards passing: expect-continue-reuse-race, write-information,
  server lifecycle family (timeouts-validation, optimize-empty-requests,
  response-standalone, keepalive-end, capture-rejections, async-dispose,
  clear-timer, close-destroy-timeout, req-res-close), keep-alive,
  outgoing-message, client-response-timeout families (see differential).

## Known gaps (separate root causes, NOT this PR)

- test-http-write-callbacks: was a timeout on base; now runs to an
  ordering assertion. Real cause: the shim delivers `response` before
  the streaming request's end callback (verified pre-existing on
  pristine base for plain streaming requests), while the test asserts
  end-callback-first ("should not come until after the end is
  flushed out"). The assert throws inside the `response` handler and
  is swallowed by the round trip's `onHeaders` try/catch, so the `data`
  listener never attaches. Fix belongs to a streaming-callback-ordering
  lane (delivery timing; 11 tests depend on synchronous delivery).
- test-http-sync-write-error-during-continue: fails identically on
  base (duplexPair + sync write error inside `parser.execute()` —
  parser reentrancy with custom sockets, separate cause).
- test-http-early-hints-invalid-argument: timeouts identically on base
  (link-value shape validation — `</...>; rel=...` parsing with
  `ERR_INVALID_ARG_VALUE` — not implemented; name/value char validation
  is implemented).
- test-https-server-async-dispose / test-https-server-close-destroy-timeout:
  still fail — the PR #330 slot bridge is http-target-only by design
  (see PR #330 notes).
