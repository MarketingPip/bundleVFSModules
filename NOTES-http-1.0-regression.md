# NOTES — test-http-1.0 regression (HTTP/1.0 response lost)

## Target

`test-http-1.0` failed with exit 1 on current main `ba26449a`
(and on the Nov 3 full sweep), after passing exit 0 on the Oct 28 full
sweep (base `1d8bc7b4`). This is a genuine regression, not a flake:
isolated 2/2 on current main before the fix.

## What the test does

Three sub-tests over raw `net` sockets. The failing one is the second:
an HTTP/1.0 request with headers, handler does `writeHead(200)`,
`write("Hello, ")`, `_send("")`, `write("world!")`, `_send("")`,
`end()`. The client must receive exactly
`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nHello, world!`
and then EOF. Actual before the fix: the client got EOF with zero bytes.

## Diagnosis

The handler's writes go through the streaming path (`_headerFlushed`
after `writeHead`), so each `write()` pends its frame in
`_pendingFrame` via `_pendFrame` (PR #279, coalesced streaming
delivery). The pended frame is flushed by a queued microtask — but for
a close-delimited (HTTP/1.0, `Connection: close`) response, the
finish path closes the socket before that microtask runs, so the frame
was dropped and the client saw an empty EOF. A debug probe confirmed
the bytes sitting in `_pendingFrame` (71 -> 77 bytes across the two
writes) after `end()`, with the client total `""`.

Both synchronous flush sites had the same gap: `ServerResponse.end()`
joined a pended frame to the chunk terminator ONLY when
`_chunkedStreaming` was true, and `_finishSocketResponse`'s streaming
case likewise only flushed pending when chunked. A non-chunked
streaming response (HTTP/1.0 close-delimited, or HTTP/1.1 with an
explicit Content-Length) had no synchronous flush at all. The first
sub-test (writeHead + end(body)) passes because end-chunks stay
buffered and go out via the finish path; the third (HTTP/1.1 chunked)
passes because the chunked branch flushes. Only the
write-then-end non-chunked shape broke.

## Attribution (bisect)

`git log -S "_pendFrame"` points at PR #279 (`a0be540a`, "coalesce
streaming response frames so write();end() delivers as one data
event"). Verified by running the test at both revisions in a scratch
worktree: pre-#279 (`a0be540a^`) exit 0, post-#279 (`a0be540a`)
exit 1. PR #284 later touched the same accounting but did not
introduce the gap.

## Real-Node behavior probed (v24.22.1, plain script /tmp/probe-10-real.js)

The sub-test 2 shape under real Node delivers exactly the test's
expected bytes, `Connection: close` + raw body, no chunk framing.
(Incidental: the vendored suite's sub-test 3 expects two separate
chunks `7\r\nHello, \r\n6\r\nworld!\r\n`, but host Node v24.22.1
coalesces them into one `d\r\nHello, world!\r\n` chunk — a
v24.20.0-vs-v24.22.1 difference in Node itself, not a shim gap. The
shim matches the vendored test expectation, which is the grading
oracle; no action.)

## Fix (src/http.js only, _finishSocketResponse)

The streaming case of `_finishSocketResponse` (which runs at `_deliver`
time, after `end()` returns and before the keep-alive/close decision)
now flushes a pended frame for non-chunked streaming responses too,
mirroring the existing chunked terminator join: same socket guard,
same `_framedPending` accounting, same `_maybeEmitStreamDrain`. The
chunked path is byte-identical. Carries a `ponytail:` comment naming
the ceiling.

Why here and not in `end()`: the first attempt widened the
synchronous `end()` flush to non-chunked responses. It fixed
test-http-1.0 but REGRESSED test-http-readable-data-event (0 -> 1,
isolated 2/2): flushing inside `end()` lets a second chunk arrive
within the client's first readable callback, so its `read()` returned
`'Hello again later!'` where the test expects `null`. The
`_deliver`-time flush preserves the interleaving — it runs after the
client's callback unwinds — while still preceding the socket close
for close-delimited responses. With this placement the target passes
AND the readable test passes, and all three bonus flips below survive
(they are finish-time delivery effects, not synchronous-end effects).

## Differential (branch sweep vs Nov 3 base CSV, both 397 rows)

- test-http-1.0: 1 -> 0 (target).
- test-http-outgoing-first-chunk-singlebyte-encoding: 1 -> 0 (bonus,
  isolated 2/2 on branch vs 1,1 on base).
- test-http-request-methods: 1 -> 0 (bonus, isolated 2/2 vs 1,1).
- test-http-wget: 1 -> 0 (bonus, isolated 2/2 vs 1,1).
- test-http-byteswritten: sweep read 1 -> 124, but isolated 2/2 on
  branch is 1,1 (same as base) — sweep-load flake, not a regression.
- Zero pass-to-fail in isolated re-runs. Net sweep counts:
  base 250/94/51 -> branch 253/90/52 (pass/fail/timeout; 134/139
  unchanged).

## Guards (all exit 0 after the fix)

The #279 guard itself (`test-http-server-keep-alive-defaults`,
terminator ordering) plus `test-http-1.0-keep-alive`,
`test-http-outgoing-properties` (framedPending accounting),
`test-http-outgoing-destroyed`, `test-http-keep-alive-max-requests`,
`test-http-server-keep-alive-timeout`, `test-http-chunked`,
`test-http-keepalive-request`.

## Deliberately left alone

- `_finishSocketResponse`'s streaming case still only handles the
  chunked shape; end() now guarantees it never sees a pending frame
  for a finished response, so no second flush site is needed.
- The microtask flush in `_pendFrame` still covers handlers that
  stream without ending (delivery stays prompt there).
- No change to the buffered (non-streaming) finish path.
