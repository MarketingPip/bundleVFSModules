# NOTES — test-http-content-length-mismatch (strictContentLength)

## Target

`parity/node-test/parallel/test-http-content-length-mismatch.js` — exit 124
(timeout) on pristine main `df4c1d7e`, exit 0 with this fix. All four
sub-cases (throw on more bytes, no-throw without a declared length,
throw on fewer bytes with a retrying `end()`, string-valued length)
pass.

## Diagnosis

`strictContentLength` appeared nowhere in `src/` — the feature was
entirely missing. The test's handler throws (`assert.throws` fails
because the expected throw never happens), the throw is swallowed by
shim dispatch, `res.end()` never runs, no response is delivered, and
the client waits until the timeout. This is the swallowed-throw hang
pattern seen in earlier lanes, but the root cause here is a missing
feature, not a dispatch bug: fixing the feature (not the dispatch
throw path) makes the test pass for the right reason.

## Real-Node behavior (probed v24.22.1, single-trial processes)

- Both `ServerResponse` and `ClientRequest` carry `strictContentLength`,
  default `false`.
- With the flag truthy (truthy `1` enables it too — unlike
  `rejectNonStandardBodyWrites`, which needs literal `true`) and an
  explicit `Content-Length`:
  - `write()` whose prospective total exceeds the length throws
    `ERR_HTTP_CONTENT_LENGTH_MISMATCH` with message
    `Response body's content-length of <total> byte(s) does not match
    the content-length of <length> byte(s) set in header`. The chunk is
    not counted, so a later `end()` still delivers exactly the
    declared bytes.
  - `end(chunk)` whose prospective total differs from the length
    throws the same error; the chunk is not counted, so a retry
    `end()` with the exact remainder still delivers.
  - A chunkless `end()` with a short total throws the same error.
  - An empty write after an exact total does not throw.
  - With no declared length, nothing throws (bytes flow, no length
    header is added).
  - A string-valued length (`"5"`) behaves like the number.
  - With `Transfer-Encoding: chunked` also set, writes never throw
    mismatch.
  - With the flag off (default), over-length writes do not throw.
- Message wording uses `byte(s)` regardless of count (`1 byte(s)`).

## Fix (`src/http.js` only, product)

- `ERR_HTTP_CONTENT_LENGTH_MISMATCH(actual, expected)` factory beside
  `ERR_HTTP_BODY_NOT_ALLOWED`, message verbatim from the probe
  (including `Response body's` even for client requests — that is
  Node's literal message).
- `OutgoingMessage._strictCheck(len, isEnd, count)` shared helper:
  unconditional byte count (like Node's `_contentLength`: bytes
  written while the flag is off still count if it is turned on
  later); the check runs only when the flag is truthy, an explicit
  length is set (either header store — `writeHead(obj)` headers live
  in `_renderedHeaders` only, while `getHeader()` sees `kOutHeaders`
  only), and the framing is not chunked (explicit chunked token in
  either store, or the `_chunkedStreaming` flag). `write()` throws
  when the prospective total exceeds the length; `end()` throws when
  it differs. A throw leaves the count unchanged and runs before
  `finished`/`_ended` is set, so a retry still delivers.
- Placements, each with a `ponytail:`-free short comment (the helper
  carries the full reasoning):
  - `OutgoingMessage.write`: after the no-body drop, before dispatch.
    Covers `ServerResponse.write` (which delegates to it) and buffered
    `ClientRequest` writes.
  - `OutgoingMessage.end`: after the body-not-allowed check, before
    `finished = true`. Its chunk goes through Writable's `write`, not
    `OutgoingMessage.write`, so no double count.
  - `ServerResponse.end`: same position; its chunk routes through
    `OutgoingMessage.write`, which counts it, so the check there does
    not count (`count = false`).
  - `ClientRequest.end`: after validation, before `_ended = true`.
    The buffered branch routes through `OutgoingMessage.write`
    (`count = false`); the streaming branch forwards via
    `_streamForward`, which does not count (`count = true`).
- Dropped bodies (`_hasBody === false`: 204/304/1xx) are never counted
  or checked, mirroring `write()`'s silent drop.

## Deliberately left alone

- Retry after an `end()` that throws for OVERFLOW: real Node's retry
  `end()` throws again, while this helper (overflow chunk not
  counted) would let a retry deliver. No official test covers
  retry-after-overflow; the helper documents it.
- `ServerResponse._send` (internal headers+first-chunk coalescing
  helper) bypasses `write()` and is not strict-checked; no test
  covers it with the flag set.
- The sibling test `test-http-content-length` (empty-body implicit
  `Content-Length: 0` on client requests) is a separate root cause
  and ships as its own PR.

## Verification

- Target 124 → 0 (branch + live main, parent-verified).
- Full 397 differential vs pristine main `df4c1d7e`: exactly one line
  toward pass, zero pass-to-fail, zero mode changes.
- Guards all 0: double-content-length, response-multi-content-length,
  chunked-304, set-trailers, outgoing-end-types, outgoing-buffer,
  outgoing-destroyed, res-write-after-end.
- Repo jest 3059/7/1 (host baseline exactly); ondemand 29/29;
  build-vfs exit 0; dist/ restored, never committed.
