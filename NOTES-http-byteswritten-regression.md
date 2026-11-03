# NOTES: test-http-byteswritten regression (fix/http-regression-byteswritten)

## The test

`parity/node-test/parallel/test-http-byteswritten.js`: server handler
writes ~2.6 MB in 3072 chunks (string, Buffer, hex), then asserts
`res.connection.bytesWritten > 0` mid-loop ("while buffer is not
empty"), and on `res` 'finish' asserts `typeof bytesWritten ===
"number"` and `> 0`. The client is a bare `http.get` with no response
handler (it never reads).

## Failure on current main (348fcae6)

Exit 1. The failing assertion is NOT a bytesWritten value check — it is
the `res` 'finish' mustCall (line 35) firing 0 times. Chain:

1. Mid-loop, `res.connection.bytesWritten` reads 0, so the line-52
   assert throws inside the handler.
2. The throw is swallowed by shim dispatch (the known triage
   mechanism: handler throw → no response written).
3. `res.end()` never runs, 'finish' never fires, the mustCall fails
   at exit.

## Root cause: #279 frame coalescing broke bytesWritten accounting

Bisect (parent-verified on scratch worktrees, test only): passes at
`a0be540a^` (5131d829, the #278 docs sync), fails at `a0be540a`
(#279, "coalesce streaming response frames"). #279 is the regressing
PR. Its guarded behavior (single-`data`-event delivery for
write();end()) is covered by test-http-1.0-keep-alive and
test-http-readable-data-event — both still pass with this fix, so
both sides hold.

Before #279, streaming writes went straight to `sock.write` →
`_deliverToPeer` → `_bytesWritten += length` synchronously, so the
mid-loop assert passed. #279's `_pendFrame` (`src/http.js:1100`)
coalesces streaming frames for single-`data`-event delivery: writes
accumulate in `res._pendingFrame` and only reach the socket on the
microtask flush or the finish path. Mid-loop the frame is still
pended, so the socket's `_bytesWritten` is still 0.

Probe (zz-bw, deleted after use; consuming client): pre-fix,
`LOOP-DONE bytesWritten = 0, framedPending = 2643101`. Post-fix,
`LOOP-DONE bytesWritten = 2643101`, `FINISH bytesWritten = 2643123`
(no double-count: pends drain to 0 at flush, delivered total stands).

## Real-Node probe — read this before "fixing" further

On host Node v24.22.1, this test ALSO fails: the exact test exits 1
on the same line-52 assert, and a probe shows `bytesWritten = 0`
throughout the synchronous loop (`writableLength` grows to 258726 by
i=100; finish reads 2621624). Real Node counts bytesWritten only when
writes complete to the kernel (async), so the mid-loop assert encodes
a synchronous-accounting assumption modern real Node does not satisfy.
A second real-Node quirk: `res.connection` reads null in the finish
handler on v24.22.1 (the test's finish assert would crash there too).

This does NOT make the lane a NO-FIX: the suite grades the SHIM, the
vendored suite is v24.20.0 (not the host's .22), and the test passed
on the shim six days ago (Oct 28 sweep, main 1d8bc7b4). The shim
delivers synchronously by design, so eager accounting at pend time
restores the shim's own consistent model — it is not faking a
real-Node behavior, it is repairing the accounting #279 broke. If a
future lane re-grades this test against real-Node timing, that is a
separate decision (test-shape change), not this fix.

## Fix (src/net.js only)

`Socket.prototype.bytesWritten` getter now returns `_bytesWritten`
plus the live server response's `_framedPending`, read through the
existing dispatch stash (`socket._httpState.lastResponse`, set at
`src/http.js:5922`, no new link):

```js
return (
  this._bytesWritten +
  (this._httpState?.lastResponse?._framedPending || 0)
);
```

Why the getter, not eager increment at pend time: incrementing in
`_pendFrame` would need a matching decrement at EVERY flush site
(`_flushPendingFrame`, both `_finishSocketResponse` branches, the
end-path join) or the flush's `sock.write` would double-count. The
getter has one site and no new invariant; the stash reads 0 after
flush (framedPending drains, or the stash is cleared).

Deliberately NOT included: the client side (`_httpMessage`) pends
through the same mechanism, so a streaming client request's socket
bytesWritten lags identically — but no test covers it, and widening
the getter's blast radius without a test would be scope creep. One
line (`+ (this._httpMessage?._framedPending || 0)`) if a client test
ever needs it.

Corner (documented in the code comment): a pipelined deferred
response overwrites `lastResponse` while its predecessor is
unfinished, so the predecessor's pends are briefly invisible here;
they land in `_bytesWritten` at its finish flush.

## Verification

- Target 1 → 0 (branch; base 1 confirmed on pristine 348fcae6).
- Guards all 0: readable-data-event, 1.0, 1.0-keep-alive,
  server-keep-alive-defaults, outgoing-properties, outgoing-finish,
  chunked, keep-alive, keep-alive-max-requests, outgoing-destroyed,
  server-keep-alive-timeout, server, upgrade-server.
- Pre-existing failures (1 on branch AND on pristine base, unrelated):
  net-socket-byteswritten, client-error. Raw net sockets carry no
  _httpState, so the getter change cannot affect the former; the
  latter fails identically without the change.
- https-byteswritten: 0 on base, 0 on branch (typeof-number assert
  only); the getter change preserves the number type.
- Full 397 differential vs pristine main 348fcae6: EXACTLY one line
  changed — byteswritten 1 → 0. Zero pass-to-fail, zero mode changes.
  Base totals 254 pass / 51 timeout / 90 fast / 134×1 / 139×1; branch
  255 / 51 / 89 / 134×1 / 139×1. Cross-check: base 254 = recorded 250
  + the 4 PR #303 flips, exactly as expected. CSVs:
  http-sweep-regbw-base.csv / http-sweep-regbw-branch.csv.
- Jest 3059 passed / 7 failed / 1 skipped (host baseline exactly).
  Ondemand 29/29 with the branch allowlist. build-vfs exit 0,
  sandbox --check 0, runtime --check 0. dist/ restored, never
  committed.
