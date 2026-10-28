# NOTES — server parse-error surfacing (`clientError` + socket `'error'`)

Lane 7 from `triage-124-2026-10-28.md`. Flips
`test-http-server-multiple-client-error` (124 → 0),
`test-http-server-destroy-socket-on-client-error` (1 → 0), and as a
same-cause bonus `test-http-server-client-error` (1 → 0).

## Real-Node rules probed first (v24.22.1, plain node)

- No `clientError` listener: the server socket emits `'error'` with the
  parse error (`message "Parse Error: Invalid method encountered"`,
  `code HPE_INVALID_METHOD`, `bytesParsed`, `rawPacket` = the chunk that
  triggered the parse), the client receives exactly
  `HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n` then `'end'`,
  and the socket closes with `hadError=true`.
- With a `clientError` listener: the handler owns the socket — no
  automatic 400, no destroy, no socket `'error'` (a listener that does
  not destroy leaves the socket open and silent).
- After a parse error the parser stays in its error state: every further
  chunk re-reports the same failure code with the new chunk as
  `rawPacket`. In the multiple-client-error shape (net server reads one
  byte, unshifts it, manually emits `'connection'`), chunk `"1"` errors
  at once and the buffered `"23 http://example.com HTTP/1.1\r\n\r\n"`
  errors again after the handler destroys the socket (buffered data
  still drains after destroy).
- `bytesParsed` for an invalid method is how many leading bytes matched
  a known method's prefix before failing: `"GETX"` → 3, `"GE"` → 2,
  `"FOO"` → 1, `"XFOO"`/`"1ABC"` → 0. Quirk of the real parser's
  minimized method DFA, also probed: `'F'` counts (`"FA"` → 1) and
  `"FL"` counts twice (`"FL"` → 2), though no known method starts
  with F. Lowercase first letters count 0.
- llhttp validates the method token before anything else on the line:
  `"FOO /\r\n"` (no version) and `"Oopsie-doopsie\r\n"` (no space at
  all) are `HPE_INVALID_METHOD`, not `HPE_INVALID_START_LINE`.

## Root causes (three, all in the parse path)

1. `ServerBase` never handled a manually-emitted `'connection'`:
   `_onSocketConnection` was wired only to the internal net server's
   `'connection'` event, so `httpServer.emit("connection", socket)`
   attached no parser and no `clientError` could ever fire.
2. The line-based parser waited for a complete line before judging the
   method, and `_parseStartLine` returned early on any partial line —
   so a lone `"1"` byte produced silence instead of an eager
   `HPE_INVALID_METHOD`.
3. The server `onError` path always wrote 400 and destroyed without the
   error, even with no `clientError` listener — so socket `'error'`
   never fired — and the error object lacked Node's shape (`"Parse
   Error: …"` message, `bytesParsed`, `rawPacket` as the triggering
   chunk; the old code re-wrapped chunks through the shim Buffer, which
   fails `deepStrictEqual` against a real Buffer in `expectsError`).

## Fix

- `src/http.js`: `ServerBase` constructor registers its own
  `'connection'` → `_onSocketConnection` listener (Node's http.Server
  IS a net.Server); `_onSocketConnection` is idempotent per socket
  (`socket._httpState` guard) and skips its own nested `'connection'`
  emit for manually-emitted connections (Node's
  `connectionListenerInternal` never re-emits, so app listeners fire
  once, not twice). `parser.onError` now normalizes the message to
  `"Parse Error: Invalid method encountered"` for
  `HPE_INVALID_METHOD` (other codes get the `"Parse Error: "` prefix),
  emits `clientError` and stops when a listener exists, and otherwise
  writes the 400 (413 for chunk-extension overflow, unchanged) and
  destroys the socket *with* the error so `'error'` fires.
- `src/_http_parser.js`: complete-line path checks the method token
  (up to the first space, or the whole line) before the version/space
  checks; new `_judgePartialStartLine()` judges partial remainders
  eagerly from both no-complete-line sites (viability is monotone, so
  an early throw matches llhttp exactly); `methodBytesParsed()` encodes
  the probed prefix rule including the F/FL DFA quirk; `execute()`
  records the triggering chunk as `rawPacket` (kept unwrapped when it
  is already a `Uint8Array`, so a real-Buffer chunk under parity stays
  a real Buffer) and, once in the error state, re-reports the same
  code for each further chunk (`bytesParsed -1`, `rawPacket` = the new
  chunk) while a chunk-less re-parse stays silent.

## Results (PARITY_TARGET=http)

- `test-http-server-multiple-client-error`: 124 → 0.
- `test-http-server-destroy-socket-on-client-error`: 1 → 0.
- `test-http-server-client-error`: 1 → 0 (same cause: no-space method
  line + error shape).
- `test-http-blank-header`: still 0 (its 400 path is the no-listener
  path; the only change there is `destroy(err)` instead of
  `destroy()`, absorbed by the http layer's own no-op `'error'`
  listener).
- Guard battery 43/46 + 7 #254 timeout flips, all 0; the two agent
  failures (`test-http-agent`, `test-http-agent-keepalive`, exit 1)
  reproduce identically on pristine main `bf0f3db9` — pre-existing,
  not regressions.
- `tests/ondemand-require.test.js`: 29/29 on the branch.

## Repo-test corrections (probed real-Node behavior, not weakened checks)

The full local suite initially showed 2 new failures beyond the known
7-failure baseline, both in `tests/http-socket.test.js` — both encoded
the shim's previous always-400 / wait-for-end behavior, which real Node
contradicts (probed v24.22.1):

- `"malformed request -> 400 and clientError"`: with a do-nothing
  `clientError` listener, real Node sends NO 400 bytes (client sees
  `'end'` with empty data); the old test only passed because the shim
  always wrote 400. Rewritten as `"malformed request -> clientError, no
  automatic 400 with a listener"`: the client ends its write, receives
  nothing, and the code still surfaces as `HPE_INVALID_METHOD`. The
  no-listener 400 path stays covered by the official
  `test-http-server-destroy-socket-on-client-error`.
- `"response: 204 and HEAD have no body"` trailing-garbage case:
  real Node errors trailing `"xx"` after a 204 at once as
  `HPE_INVALID_CONSTANT` (`"Parse Error: Expected HTTP/, RTSP/ or
  ICE/"`), not `HPE_TRUNCATED` at end. Expectation corrected, and a
  partial-viable-prefix case (`"HT"` + end) added to prove the
  truncation path still works (`HPE_TRUNCATED`).

After these corrections the full suite matches the known baseline
exactly (see Testing).

## Not in scope (follow-up lanes, detection not surfacing)

- `test-http-server-reject-chunked-with-content-length` (exit 1 on
  branch and pristine main): the parser never detects
  Content-Length + chunked Transfer-Encoding
  (`HPE_INVALID_TRANSFER_ENCODING` missing).
- `test-http-server-reject-cr-no-lf` (exit 1 on branch and pristine
  main): the parser never detects a lone CR in a header block
  (`HPE_LF_EXPECTED` missing).
