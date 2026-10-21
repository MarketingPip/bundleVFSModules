# NOTES — test-http-get-pipeline-problem

Target: `test-http-get-pipeline-problem` failed on main (exit 1). The
test sets `http.globalAgent.maxSockets = 1`, fires 10 concurrent
`http.get` requests (`connection: close`), and pipes each response —
a 45,658-byte JPEG served via
`writeHead(200, { "content-type", connection: "close", "content-length" })`
+ `res.end(image)` — to a file, then asserts all 10 files are complete.

On main the first response crashed the client:
`Error: expected CRLF after chunk data` from the client-side parser.
Two defects in the server dispatch path (`_finishSocketResponse`,
`src/http.js`):

## Defect 1 — writeHead Content-Length invisible to the framing decision

The framing decision read `res.hasHeader("content-length")`, which only
sees `kOutHeaders` (the `setHeader` API). When only `writeHead(obj)` is
used, headers deliberately stay out of `kOutHeaders` (Node behavior)
and live in `_renderedHeaders`. So `hasCL` was false, the "explicit
writeHead commits headers first, body is chunked" branch fired, and the
response went out with **both** the rendered `content-length` header
and an appended `Transfer-Encoding: chunked`.

Fix: the framing check now consults both stores, exactly like the
`hasLen` keep-alive check a few lines below already did.

## Defect 2 — binary body stringified into the wire write

Both coalesced writes interpolated the body as a string:
`` `${body.length.toString(16)}\r\n${body.toString()}\r\n0\r\n\r\n` ``
and `headOut + body.toString()`. `body` is a Buffer (`_getBody()`), and
`Buffer#toString()` is UTF-8: non-ASCII bytes expand to multi-byte
sequences or replacement characters while the chunk-size line still
declares the original byte count. The client's parser therefore lands
mid-body when checking the trailing CRLF — the observed crash. On the
length-framed path the same conversion would have silently corrupted
the file bytes instead.

Fix: both writes are now `Buffer.concat` of the header block (latin1),
the framing lines, and the raw body Buffer — one write, byte-exact.

## Evidence

- Raw wire dump before the fix, 300-byte binary body with
  `content-length: 300`: 718 bytes on the wire, both `content-length`
  and `Transfer-Encoding: chunked` present, body mismatched from the
  first byte (chunk-size line inside the body region).
- After: 422 bytes, `content-length` only, body byte-exact.
- Chunked control (explicit writeHead, no Content-Length, 5,000-byte
  binary body): arrives chunked and byte-exact at a real client.
- Guards: `test-http-chunk-extensions-limit` (its block 3 needs
  writeHead-*without*-Content-Length to stay chunked),
  `test-http-chunked-304`, `test-http-1.0-keep-alive`, and the
  agent/keep-alive set from the previous fixes all pass.
