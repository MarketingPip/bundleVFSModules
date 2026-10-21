# test-http-blank-header — diagnosis and fix

Status: FIXED on `fix/http-blank-header` (target test exits 0).

The test sends one request with a blank `Cookie:` header followed, in the
same write, by pipelined garbage (`\r\nhello world`). Node behavior: the
handler runs with `cookie: ""`, then the garbage fails to parse and the
client receives exactly
`HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n`.

The blank header itself already parsed correctly (`cookie: ""` reached
the handler). Two defects caused the hang:

## 1. Pipelined bytes buffered in the parser were never validated

After the request's headers completed, the parser paused between
messages with the garbage still in its internal buffer. The socket
`data` handler only fed the parser again on a *subsequent* chunk (the
"peek" path) or after the response finished — and this handler never
responds. With everything delivered in one write, nothing ever looked
at the remainder: no `clientError`, no 400, process hung.

Node surfaces pipelined parse errors immediately, even while a response
is pending (llhttp parses the buffer eagerly). Fix: after every
`parser.execute()` in the socket data handler, a
`validatePipelinedRemainder()` step checks the new
`parser.hasBufferedRemainder()` and, while a response is pending and no
body is awaited, unpauses and executes the buffered bytes. Parse errors
flow through the existing `onError` → `clientError` → 400 path. Valid
pipelined messages dispatch through the same path the next-chunk peek
already used.

## 2. The default 400 response had an extra header

`parser.onError` wrote
`HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`.
Node's default clientError response has no Content-Length, and this
test matches the response bytes exactly. Dropped the header. (The 413
response was already byte-exact; no other test depends on the padded
400 — verified by grep over the Jest and parity suites.)

## Verification

- `test-http-blank-header`: hang → exit 0.
- Jest `tests/http.test.js` + `tests/http-socket.test.js` +
  `tests/net.test.js`: 171/171.
- Parity regression spot checks all exit 0: chunk-extensions-limit,
  agent-uninitialized, 1.0, 1.0-keep-alive, chunked-304,
  chunked-smuggling.
- Wider parity probes (pipelined-socket-destroy, get-pipeline-problem,
  keep-alive-close-on-header, agent-keep-alive-timeout-buffer,
  client-keep-alive-hint) fail **identically on pristine main** —
  pre-existing, not regressions; they remain queued.
