# Client highWaterMark backpressure (test-http-client-highwatermark Test 3)

## Real-Node semantics probed (v24.22.1, plain node, before implementing)

- `http.request({ highWaterMark: 512 })`, 2KB `write()` in the same tick
  (before the socket connects): returns `false`; `drain` fires after the
  buffer flushes; `end()` in the drain handler completes the request.
- Cumulative accounting: with HWM 512, a 400B write returns `true`, a
  second 400B write returns `false` (800 buffered > 512).
- HWM 100000, 64KB pre-connect write: returns `true`.
- Decisive mechanism probe: a plain `Writable` with a *synchronous*
  `_write` callback returns `true` for a 2KB write at HWM 512 on real Node
  too (length drops to 0 before the return value is computed), while an
  async-callback `_write` returns `false`. So real Node's http
  pre-connect path must NOT complete the write callback synchronously —
  the chunk is buffered and its callback fires on flush, which is what
  keeps the length accounting above the threshold at return time.

## Root cause, in plain terms

`OutgoingMessage._write` (the shim's buffering step, used by both
`ClientRequest` and `ServerResponse`) invoked its callback synchronously.
`Writable.write()` computes its return value *after* `_write` returns, so
by then the synchronous `onwrite` had already decremented the buffered
length back to 0 and `write()` always returned `true`, regardless of
`highWaterMark`. Tests 1–2 passed anyway (Test 1 only checks the
`kHighWaterMark` symbol, which was already propagated by PR #268's
server-side work plus the `ClientRequest` constructor; Test 2 expects
`true`). Test 3 (2KB at HWM 512, expects `false` + `drain`) failed.

## Fix (src/http.js only, OutgoingMessage._write)

Defer the `_write` callback to a microtask (`queueMicrotask(callback)`)
instead of invoking it synchronously. Buffering itself stays synchronous
— `outputData`/`outputSize` are updated before returning — only the
callback timing changes. This matches real Node's observable contract
(write callbacks are never synchronous) and makes `write()` return
`length < highWaterMark` at call time, with `drain` firing on the
microtask flush (after the caller has attached its listener, so the
test's `drain` → `end()` flow completes instead of deadlocking).

Deliberately not changed: the `ClientRequest` streaming path
(`_streamEnsureStarted`/`_streamForward`, PR #257) — the fix sits below
it in `super.write()`; the streaming guards (especially
`test-http-server-consumed-timeout`) all still pass. Server responses
share `OutgoingMessage._write`, so their `write()` return values are now
also HWM-based instead of always-true; the server/chunked guard battery
below shows no behavior change for existing passing tests.

## Results (PARITY_TARGET=http)

- `test-http-client-highwatermark`: 1 → 0 (Tests 1–2 already passed;
  Test 3 was the `true !== false` assertion; a `zz-` probe confirmed
  `write(2KB) = false` + `drain` fired before the fix was verified on
  the test itself; probe deleted after use).
- Guard battery 42/42 on the branch (stdin from /dev/null): server,
  consumed-timeout, connection-list-when-close, options-incoming-message,
  blank-header, get-pipeline-problem, keep-alive-close-on-header,
  keep-alive-defaults, keep-alive-max-requests-null, de-chunked-trailer,
  keepalive-req-gc, unconsume-consume, connect-req-res, multiheaders,
  multiheaders2, client-headers-host-array, headers-distinct-proto,
  multiple-client-error, destroy-socket-on-client-error, client-error,
  drop-connections-in-cluster, delete-parser, options-highwatermark,
  client-highwatermark, chunked, chunked-304, chunked-smuggling,
  agent-keep-alive-timeout-buffer, client-keep-alive-hint, keep-alive,
  agent-timeout, agent-uninitialized, outgoing-finished,
  outgoing-message-write-callback, outgoing-write-types,
  request-timeout-delayed-headers, request-timeout-keepalive,
  headers-timeout-delayed-headers, headers-timeout-pipelining,
  server-keep-alive-timeout, keep-alive-timeout-custom.
- One guard scare, resolved as a filename error (twice): the
  `server-keep-alive-timeout-custom` name does not exist (module-not-found
  exit 1 on branch AND pristine main); the real file is
  `test-http-keep-alive-timeout-custom.js`, which passes 0 on the branch.
  Always list the directory before running a test.
- `tests/ondemand-require.test.js`: 29/29 on the branch (after rebase).
- No pristine-main differential needed for a regression claim: every
  guard passes; the only behavioral change is the fix itself (write
  return values + drain now HWM-based, verified against real-Node
  semantics above).

## Incidents

- Main moved mid-lane: docs sync PR #271 merged as `6ad68701`
  (159→170) while this lane worked. Rebased; the only conflict was the
  footprint allowlist, resolved to this branch's file set, then target +
  ondemand re-verified on the rebased tree before pushing.
- The repo's `NOTES-http-diagnosis.md` / `NOTES-http2-parity.md`
  untracked files in the parent checkout were left untouched, and the
  `node_modules` symlink in this worktree is not committed.
