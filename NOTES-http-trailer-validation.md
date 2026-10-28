# NOTES: HTTP Trailer-header validation (ERR_HTTP_TRAILER_INVALID)

## The gap (plain terms)

A server response may declare a `Trailer` header only when the body is sent
with chunked transfer encoding — trailers ride in the chunked terminator, so
any other framing has nowhere to put them. Real Node rejects the combination
at header time with `ERR_HTTP_TRAILER_INVALID`. Our `ServerResponse.writeHead`
never checked, so the official test's `assert.throws(...)` itself threw and
the handler died before `res.end("ok")` — the test hung (exit 124).

## Real-Node behavior probed (Node v24.22.1, before implementing)

Error shape (all throw cases): `Error`, `code: "ERR_HTTP_TRAILER_INVALID"`,
`message: "Trailers are invalid with this transfer encoding"`.

| Case | Result |
|---|---|
| Trailer + Content-Length (setHeader or writeHead obj, any case) | THROW |
| Trailer + empty value + Content-Length | THROW (presence, not value, matters) |
| Trailer + Transfer-Encoding: identity / gzip | THROW |
| Trailer + Transfer-Encoding: chunked (any case, `gzip, chunked` / `chunked, gzip` lists, array value) | NO THROW |
| Trailer + Content-Length + TE chunked together | NO THROW (chunked wins) |
| Trailer, no CL, no TE, HTTP/1.1 GET 200 | NO THROW (default chunked) |
| Trailer + implicit headers (end() with CL via setHeader) | THROW (validation is at header-render time, not writeHead-only) |
| Trailer + 204 / 304 (no CL/TE) | THROW |
| Trailer + 204 + TE chunked | THROW (no-body status beats explicit chunked) |
| Trailer + HEAD request, no CL/TE | THROW |
| Trailer + HEAD request + TE chunked | NO THROW |
| Trailer + HTTP/1.0 request, no CL/TE | THROW |
| Trailer + HTTP/1.0 request advertising `TE: chunked`, no CL/TE | NO THROW |

Rule implemented from the table: chunked ⟺ body-carrying response AND
(explicit TE containing a chunked token, OR (no TE AND no Content-Length AND
not HEAD AND (HTTP/1.1 OR request advertised TE: chunked))).

## Fix

`src/http.js` only, in `ServerResponse.writeHead`, before `_storeHeader`
renders anything (so a throw leaves headers unsent and the handler can
`removeHeader("Trailer")` + `end()` normally, as the test does):

- `ERR_HTTP_TRAILER_INVALID` factory next to the other `ERR_HTTP_*` factories.
- `_lookupHeader(headers, name, isOutHeadersMap)` helper: reads one header
  from a writeHead header view in all three shapes — the kOutHeaders map
  (`[name, value]` entries keyed lowercase, post-merge), a plain object, or
  an array (flat pairs or `[name, value]` pairs). The merged view matters:
  `hasHeader()` alone would miss writeHead-only headers (same dual-store
  lesson as PR #245).
- The check itself, placed after the no-body (`_hasBody = false`) block so
  204/304/1xx are decided correctly, and after the obj→kOutHeaders merge so
  a failed writeHead leaves merged headers in place exactly like Node.
- Every server header path funnels through writeHead (`_implicitHeader`
  calls it), so implicit headers and `flushHeaders()` are covered too.
  `ClientRequest` is untouched (client-side trailer validation, if Node
  does it, is a separate lane).

## Results (PARITY_TARGET=http)

- `test-http-server-de-chunked-trailer`: 124 (hang, main `9c8a0c41`) → 0.
- Throwaway shim-side matrix (`zz-trailer-matrix.js`, 11 cases mirroring the
  probe table incl. HEAD and 204+chunked): ALL PASS, exit 0, file deleted.
- Guards, 26/27 pass: test-http-server, chunked, chunked-304, blank-header,
  get-pipeline-problem, keep-alive-close-on-header, client-keep-alive-hint,
  agent-keep-alive-timeout-buffer, server-keep-alive-timeout,
  server-request-timeout-pipelining, server-headers-timeout-pipelining,
  server-consumed-timeout, server-connection-list-when-close,
  server-options-incoming-message, keep-alive, agent-timeout,
  server-non-utf8-header, incoming-pipelined-socket-destroy,
  outgoing-finished, outgoing-message-write-callback, agent-maxsockets,
  agent-getname, agent-null, agent-no-protocol, agent-uninitialized,
  agent-error-on-idle — all exit 0.

## Pre-existing gap, NOT a regression (differential-proven)

`test-http-set-trailers` exits 1 on this branch AND identically on pristine
main `9c8a0c41` (same response bytes, same assertion): the chunked
terminator is sent as bare `0\r\n\r\n` with no `x-foo: bar` trailer line.
Validation passes for that test's chunked+Trailer response; the missing
piece is `addTrailers` emission in the chunked terminator — a separate lane
(chunked-terminator rendering), deliberately out of scope here.

## CI retrigger note
First CI run on PR #263: Parity success, build failed with no log summary
available via API and no branch-head movement (failure before the dist-commit
step). Local reproduction is clean: build-vfs, sandbox --check, runtime
--check all pass, and the full serial jest suite matches the known baseline
exactly (3059 passed / 7 pre-existing version-skew failures, zero new
failures). The build re-run via API is 403 for this token, so this
notes-only change retriggers CI to distinguish a transient infra failure
from a real one.
