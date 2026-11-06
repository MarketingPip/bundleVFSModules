# NOTES — http `IncomingMessage._dump()` (test-http-dump-req-when-res-ends)

## What was missing

`IncomingMessage._dump()` did not exist on the shim. Node calls it from
`resOnFinish` (`lib/_http_server.js:1115-1118`): when the response finishes,
a request the user never consumed is dumped — its `'data'` listeners are
removed and it is resumed so the body drains — and when the user *did*
consume it, it is left alone.

## Fix (`src/http.js` only)

- Added `IncomingMessage._dump()`, a faithful port of
  `lib/_http_incoming.js:502`: `_dumped` guard, `removeAllListeners('data')`,
  then `resume()`.
- Added the `_consuming` flag (init `false` in the constructor, set in
  `_read()`), mirroring `lib/_http_incoming.js:97,259`.
- Wired the `resOnFinish` gate into `_finishSocketResponse`:
  `if (!req._consuming && !req._readableState?.resumeScheduled) req._dump()`,
  guarded to skip destroyed / already-ended requests.

## The subtle part: `_read()` must not mark a paused request consumed

Node's `_read` sets `_consuming` unconditionally — and the shim does the
same *except* it only sets it when the readable buffer is empty. That
qualification is the whole fix, and it is forced by a delivery-timing
divergence, proved by probes (real Node v24.22.1 vs the shim):

- On real Node, the client writes the body chunk frame and the chunked
  terminator in adjacent ticks, but TCP coalesces them: the server's first
  socket `'data'` event already contains chunk + terminator, so the parser
  completes the message in one `execute` — at the socket-handler / finish
  time the request is already `ended: true` (probed: `length 1798`,
  `ended: true`), `maybeReadMore_`'s loop skips `read(0)`, `_read` never
  runs, `_consuming` stays `false`, and the dump gate fires.
- In the shim the virtual socket delivers each client write synchronously
  and separately: the first chunk is pushed (buffered, `length 1918`)
  before the terminator is even written, `maybeReadMore_` then prefetches
  `read(0)` between `res.end()` and `finish`, and that speculative `_read`
  set `_consuming = true` — so the gate never dumped and the test failed
  on its `'resume'`-handler assertion (`listenerCount("data")` 1, not 0).
  A first version of this lane shipped exactly that regression (line-26
  assertion failure became a line-23 `mustCall` failure: no dump means no
  `'resume'`, so the re-attached `'data'` handler never ran).

So `_read()` sets `_consuming` only when `this._readableState.length === 0`
— when the machinery genuinely needs more data. A prefetch `read(0)` with
buffered data is not consumption. Genuine consumption still sets it: a
`resume()`-driven `_read` runs with an empty buffer (verified by
`test-http-pause-no-dump`, which asserts `!req._dumped` after the user
consumed via a `'data'` listener), as does a user `read(n)` on an empty
buffer.

Ceiling: a user `read(n)` that needs more than the *buffered* bytes still
arrives with `length > 0`, so that one partial-buffer case is missed (the
flag stays false and a later finish would dump a request the user partly
read). No official test covers it; if one appears, the gate needs a
separate "user read issued" signal rather than the buffer-length proxy.

## Not this lane

- The client request closes early (`writableEnded: false`): the response
  finishing destroys the still-writing client request, so the chunked
  terminator is never sent and the server request never completes. That
  is a separate client-lifecycle divergence (it does not affect this test:
  the test never requires the request to finish, and its comments
  anticipate the other side destroying mid-send). Fixing it alone would
  not fix this test either — `maybeReadMore_` runs before the terminator
  could arrive — so it stays a follow-up.
- Client-side `_dump()` call sites (`ClientRequest.destroy`, the
  no-`'response'`-listener path) are untouched; the abort family just
  closed there (#338/#347) and this lane is server-side only.
- `test-http-no-read-no-dump` stays 124 (closed NO-FIX, #345): a
  socket-pause / agent-reuse shape, not a `_dump()` shape.

## Verification

- Target `test-http-dump-req-when-res-ends`: exit 0 ×2 on the branch.
- Guards 37/37 exit 0: the 8 PR #345 flips, 4 PR #347 flips, 5 PR #350/#351
  flips, `pause-no-dump`, `server-consumed-timeout`, `server-unconsume`,
  `server-unconsume-consume`, `upgrade-reconsume-stream`, incoming-message /
  server-lifecycle / close-idle families. `no-read-no-dump` still 124.
- Differential: fast-sweep `http-sweep-dr-{branch,base}.csv` vs base
  `1d147098` (358 pass) — exactly 1 line toward pass
  (`dump-req-when-res-ends` 1→0), 0 regressions.
- Jest 3059 passed / 7 failed / 1 skipped (known baseline);
  `tests/ondemand-require.test.js` 29/29; builds 0.
