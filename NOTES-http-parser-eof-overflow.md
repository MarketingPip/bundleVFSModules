# test-http-parser-finish-error + test-http-max-http-headers — server EOF + header budget

## Test shapes

`test-http-parser-finish-error`: server `http.createServer(mustNotCall)`
+ `clientError` mustCall asserting message matches `/^Parse Error/`
and code `HPE_INVALID_EOF_STATE`, then `socket.destroy()`; client
writes `GET / HTTP/1.1\r\nContent-Length:` (partial header, no value,
no CRLF) then FIN.

`test-http-max-http-headers` (flags `--expose-internals`): test1
(client side) — response headers over the limit must error
`HPE_HEADER_OVERFLOW`; test2 (server side) — request headers over
the limit must `clientError` `HPE_HEADER_OVERFLOW`; test3 (server
side) — headers exactly 1 byte UNDER the llhttp count must dispatch
normally (request handler mustCall, `clientError` mustNotCall).
Headers are delivered in 100-byte chunks. The test's own comment:
"llhttp counts actual header name/value sizes, excluding the
whitespace and stripped chars."

## Failure on pristine main `1b237141`

Both exit 1, 3/3 runs. Finish-error: the `clientError` mustCall fires
0 times (truncated message silently dropped on FIN). Max-headers:
the trace is test3's `clientError` mustNotCall firing via
`parser.onError` — the shim trips overflow on headers real Node
accepts.

## Diagnosis — traced end to end, probed on real Node v24.22.1

1. **Server never reports EOF-mid-message**: the server socket `end`
   handler `onHttpEnd` never called `parser.end()`. Its idle branch
   did `state.parser.unpause()` then `socket.end()` — the truncated
   message vanished with the socket. Real-Node EOF probes (server
   side): partial start line, partial headers, AND partial body +
   FIN all yield `clientError` code `HPE_INVALID_EOF_STATE` with
   message exactly `Parse Error` (bare — llhttp's EOF reason is
   empty). Client-side partial-status EOF probes as `ECONNRESET` /
   `socket hang up` instead (not a parse error) — the client mapping
   is a separate divergence, out of scope here.
2. **Raw header accounting**: the shim counted `line.length + 2` per
   line (plus a raw-buffer check in `_findLine`), i.e. start line +
   CRLFs + separators. llhttp counts only name + trimmed-value bytes
   plus the request target (requests) or reason phrase (responses).
   Boundary probes: request count model `target + Σ(name + trimmed
   value)` — 16383 passes, 16384 overflows, 16385 overflows;
   overflow fires MID-LINE (before CRLF) at 16384; a longer target
   shifts the boundary exactly by target length (method/version do
   not count). Response count model `reason + Σ(name + trimmed
   value)` — 16383 passes, 16384 overflows. Rule: throw
   `HPE_HEADER_OVERFLOW` as soon as the llhttp count reaches
   `maxHeaderSize` (>=, not >). Test3 arithmetic: target `/` (1) +
   Host 4+9 + Agent 5+4 + X-CRASH 7+16353 = 16383 counted (must pass)
   vs 16410 raw (shim tripped).
3. **Code placement**: the shared parser's `end()` must keep emitting
   `HPE_TRUNCATED` — the repo suite (`tests/http-socket.test.js`)
   asserts it at the parser level, and the client round trip keeps
   the truncation shape. `HPE_TRUNCATED` is emitted ONLY by `end()`,
   so the server `onError` mapping to `HPE_INVALID_EOF_STATE` is
   unambiguous.

## Fix (`src/_http_parser.js` + `src/http.js` only)

- `_headerBytes` repurposed to the llhttp count: `_parseStartLine`
  adds target (request) or reason (response) and checks `>=
  maxHeaderSize` (counted before validation, like the old raw check,
  so an over-limit start line still overflows before any
  malformation error); `_parseHeaders` adds `name.length +
  trimmedValue.length` per completed line (blank terminating line
  adds 0 — its CRLF is a separator, not content) and checks `>=`;
  trailer lines add `name + trimmed value` to the same budget.
- `_findLine`'s no-CRLF check uses a provisional llhttp count
  (`_provisionalHeaderBytes()`: start-line target/reason so far,
  header/trailer name + value-so-far with leading OWS stripped, a
  no-colon line contributes its whole length as name-so-far, a
  continuation line its whole length, a trailing lone CR is a split
  CRLF and counts nothing) instead of raw buffered bytes — otherwise
  test3's 100-byte delivery still trips mid-stream. The
  `skipSizeCheck` parameter (chunk-size lines) keeps its meaning.
- `src/http.js` `onHttpEnd` idle branch calls `parser.end()` after
  `unpause()` and before the close decision (a clean EOF between
  messages is a no-op in `end()`; a mid-message EOF fires `onError`
  → `clientError`; if the handler destroys the socket, the guarded
  close is a no-op; a throwing handler cannot skip the close
  decision). Server `onError` maps `HPE_TRUNCATED` →
  `HPE_INVALID_EOF_STATE` / bare `Parse Error` / reason `""` before
  the generic normalization (which then correctly leaves the bare
  message unprefixed and the empty reason alone).

## Documented residuals (not regressions)

- A FIN arriving while a request is in flight with a partial
  pipelined message buffered is still dropped silently (the response
  completes, then the socket closes via `peerEnded`); real Node may
  report the partial after the response. No test covers it; the idle
  branch only is fixed here.
- A header value with trailing OWS near the boundary may trip the
  provisional (mid-line) check slightly early: mid-line only leading
  OWS can be stripped (trailing OWS may still be interior), while
  the completed-line count trims both ends. No test combines
  trailing OWS with the exact boundary.
- A line that is BOTH malformed and over-limit keeps the old
  precedence (overflow first for complete lines, via
  count-before-validation); llhttp's byte order could differ when
  the malformation precedes the limit point. No test combines the two.

## Guards (all exit 0 on the branch)

parser-finish-error, max-http-headers, server-reject-chunked-with-
content-length, server-reject-cr-no-lf, invalid-te,
missing-header-separator-lf, server-multiple-client-error,
server-destroy-socket-on-client-error, server-client-error,
double-content-length, blank-header,
incoming-pipelined-socket-destroy, server-incomingmessage-destroy,
parser, parser-bad-ref, parser-freed-during-execute, parser-free,
server-close-idle, server-close-idle-wait-response,
server-close-all, chunked, chunked-304, set-trailers,
server-de-chunked-trailer, upgrade-client2, upgrade-server,
client-parse-error, client-error-rawbytes, head-request, 1.0,
keep-alive, server, server-close-idle (again, same file), plus
`tests/http-socket.test.js` + `tests/ondemand-require.test.js`
65/65.
