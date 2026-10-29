# NOTES — obs-fold (multi-line header) option plumbing

## Target

`test-http-multi-line-headers`: a raw `net` server sends a response whose
`Content-Type` value spans three lines via obsolete line folding
(obs-fold, RFC 7230 §3.2.4), and the client requests with
`insecureHTTPParser: true`, expecting the unfolded value
`'text/plain; x-unix-mode=0600; name="hello.txt"'`.

Base `2d6fb5b6`: exit 1 (response callback never called — the shim
parser threw `HPE_INVALID_HEADER` "obsolete line folding is not
supported" on the continuation line, and the round trip never resolved).
On the pre-#290 base the same test hung (124) in the fetch path, which
never reached the parser; #290's loopback routing exposed the fast
failure. Branch: exit 0.

## Diagnosis

`insecureHTTPParser` was entirely unimplemented in the shim: the option
appeared nowhere in `src/http.js` or `src/_http_parser.js`, so
`ClientRequest` silently dropped it and the client round-trip parser
(`_socketHttpRoundTrip`, `new HTTPParser("response")`) never ran in
lenient mode. The parser's `_parseHeaders` rejected every SP/TAB-leading
line unconditionally.

## Real-Node behavior probed (v24.22.1, not assumed)

Unfolding rule — the CRLF is dropped and the continuation line is
appended verbatim; leading/trailing OWS of the completed value is
trimmed:

| Case (insecure mode) | Result |
|---|---|
| `text/plain;` + ` x-unix-mode=0600;` + ` name="hello.txt"` | `text/plain; x-unix-mode=0600; name="hello.txt"` (the test's expectation) |
| `one` + `  two` (two spaces) | `one  two` (whitespace preserved, not collapsed) |
| `one` + `\ttwo` (tab) | `one\ttwo` |
| `one` + ` two ` (trailing space) | `one two` (trailing OWS trimmed) |
| empty value + ` cont` | `cont` (leading OWS trimmed) |
| continuation with no preceding header | `HPE_INVALID_HEADER_TOKEN`, `Parse Error: Invalid header token` |
| strict mode (no flag) obs-fold | `HPE_INVALID_HEADER_TOKEN`, `Parse Error: Unexpected whitespace after header value` |

Strict mode is deliberately left byte-identical to the shim's historical
`HPE_INVALID_HEADER` rejection: aligning the strict error code is a
separate, untested change, and this lane changes only the insecure path.

A second, stacked gap surfaced once unfolding worked: the test's
`res.destroy()` (message incomplete — body unread) drove the client
socket's `resetAndDestroy`, whose peer notification destroyed the
server-side net socket with `ECONNRESET`, surfacing an unhandled
`'error'` on a server `conn` that attaches no error listener. Probed on
real Node: a no-error client destroy delivers NO observable event to
the server socket — not `'error'`, not `'end'`, not `'close'` — whether
or not the server already ended. (Contrast: mid-response destroy with
the server still holding the response open delivers `'end'` + response
`'close'` + socket `'close'` with `hadError=false` — a FIN, never an
error.) The shim's RST was wrong for the no-error case.

## Fix

1. `src/http.js` — `ClientRequest` validates `insecureHTTPParser`
   (non-boolean throws `ERR_INVALID_ARG_TYPE` with the options-property
   shape: `The "options.insecureHTTPParser" property must be of type
   boolean. Received type number (0)`), stores it, and threads it
   through `_performVirtualRequest` into `_socketHttpRoundTrip`, which
   constructs `new HTTPParser("response", { insecureHTTPParser })`.
   This also flips `test-http-client-insecure-http-parser-error`
   (1→0). `test-http-insecure-parser-per-stream` still fails (its
   Tests 1–4 need invalid-header-char leniency and the server-side
   option — separate lanes, see below).
2. `src/_http_parser.js` — the parser takes an options bag;
   `insecureHTTPParser` enables obs-fold unfolding in `_parseHeaders`
   (append verbatim to the previous raw value; continuation with no
   preceding header throws `HPE_INVALID_HEADER_TOKEN` "Invalid header
   token"); `_finishHeaders` trims leading/trailing OWS of every
   completed value (a no-op for ordinary headers, already trimmed at
   push). Strict mode untouched.
3. `src/net.js` — `resetAndDestroy` with NO error no longer destroys
   an already-ended peer with `ECONNRESET`; it destroys the peer
   cleanly (`'close'` with `hadError=false`, no `'error'`). Still-open
   peers and error-carrying resets keep the `ECONNRESET` destroy, so
   `test-http-outgoing-destroyed` block 3 (server response `'close'`
   on client destroy of an incomplete message) still passes, and the
   repo `resetAndDestroy gives the peer ECONNRESET` test still passes
   (its peer never ended).

## Deliberately left alone

- Strict-mode obs-fold error code (`HPE_INVALID_HEADER` vs real Node's
  `HPE_INVALID_HEADER_TOKEN`): probed, untested, separate change.
- Server-side `insecureHTTPParser` (`createServer` option, per-stream
  Tests 3–4): the server parser is constructed without the option;
  threading it is a separate lane.
- Invalid-header-character leniency (`foo\x08foo` values, per-stream
  Tests 1–2, `test-http-header-value-relaxed`, `httpValidation:
  'insecure'` alias): a different lenient behavior from obs-fold,
  separate lane.
- `HPE_INVALID_CONTENT_LENGTH` vs `HPE_UNEXPECTED_CONTENT_LENGTH`
  code-name gap (left open by #287): unrelated, still open.
- Fresh zero-byte connections still destroyed by `close()` (#287
  note): pre-existing, untested divergence, untouched.

## Verification

- Target: `test-http-multi-line-headers` 1→0 (branch; re-verified on
  live main after merge).
- Bonus: `test-http-client-insecure-http-parser-error` 1→0.
- Shim-side fold-variant probe (all match real Node): two-space,
  tab, trailing-space, empty-then-fold, first-line-fold error,
  strict-fold unchanged.
- Guard battery: ~110 tests, all exit 0 (agent family, client
  reject-* family, close-idle family, outgoing family, upgrade family,
  CONNECT family, server reject-* family, #254 timeout flips, parser
  family, keep-alive, chunked, proxy, server).
- Full 397-test differential branch vs pristine base `2d6fb5b6`:
  see the sweep CSVs in the parity-sweep goal hidden files.
- Repo jest on branch: 3059 passed / 7 failed (known host
  version-skew) / 1 skipped — exactly baseline. Ondemand 29/29.
  `build-vfs` exit 0 (`dist/` regenerated for the check, then
  restored, never committed).
