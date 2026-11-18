# NOTES — http2 V4b regressions (async-local-storage + zero-length-write)

Result: **85/277** (+2 restored, 0 regressions).

## What happened

The http2 wave-end sweep (on final main `b5770fa5`, H2-V4) showed 83 glob
passes against 78 banked flips + 7 extra side-effect flips = 85 expected.
The 2-test gap was 2 REAL regressions V4 shipped, both parent-verified
[1,1] ×2 isolated on live main and [0] on the V6 base `2ea75e5c`:

- `test-http2-async-local-storage` — `Error: connect ECONNREFUSED
  127.0.0.1:40000` from `dispatchVirtualRequest` (`src/http2.js:3075`).
- `test-http2-zero-length-write` — assertion at test:54, response body
  empty (`actual: ''`, `expected: 'asdffoobar'`); `end` fired with no data.

## Root cause 1 — async-local-storage: immediate dispatch + server.close() race

V4 made dispatch immediate (`dispatchVirtualRequest` calls
`_dispatchVirtualStream(session, stream, true)`, `src/http2.js:3088`) so a
client `close()` queued as one microtask cannot overtake the dispatch
(test-http2-client-rststream-before-connect). The immediate emit runs the
server handler synchronously, so the FIRST request's whole round trip —
including the test's `server.close()` in its `'end'` handler — runs inside
the first dispatch microtask, before the SECOND request's dispatch
microtask runs. The second dispatch then finds an empty `serverRegistry`
and emits an `ECONNREFUSED` `error` on the session/stream, which has no
`'error'` listener → uncaught throw. Pre-V4 the emit was queued as a
second microtask, so both dispatches ran (registry full) before either
round trip completed.

Fix (`src/http2.js`, `connect()` + `dispatchVirtualRequest`): record the
established peer at connect time — `session._virtualServer`, set in the
connect microtask next to the TLS/plain-mismatch lookup — and fall back
to it when `lookupServer()` finds nothing at all:
`lookupServer(session._virtualPort) || session._virtualServer`. This
matches real Node: `server.close()` stops NEW connections but an
already-connected session's requests still complete. A connect to a
never-registered port still refuses (`_virtualServer` is undefined), and
the registry's first-server fallback is untouched (the fallback only
applies when the registry is empty).

## Root cause 2 — zero-length-write: unscoped 'end' on the shared stream

V4 side-scoped `'data'` and `'trailers'` (`_emitData` / `_emitTrailers`)
but left `'end'` unscoped: `_deliverRequestBody`'s `deliver` called the
single-guard `_emitEndOnce()`, a plain `emit("end")` that fires the
CLIENT's `'end'` handler first (registration order — the client registers
in the listen callback, the server in the dispatch handler), before the
server's `'end'` handler has piped the response body. Pre-V4 this was
masked: the unscoped `'data'` fed the REQUEST body into the client's
accumulator, so the client's `actual` was already `'asdffoobar'` when its
`'end'` fired — the assertion passed vacuously, with no response ever
delivered. V4's correct side-scoping of `'data'` exposed the ordering bug.

Fix (`src/http2.js`, `Http2Stream`): `'end'` is side-scoped like
`'data'`/`'trailers'` now.

- `_emitVirtualStream` snapshots the pre-dispatch `'end'` listeners and
  computes `stream._serverEndListeners` (same pattern as
  `_serverDataListeners` / `_serverTrailersListeners`).
- New `_emitEndForSide(side)` — `"request"` targets the server-side
  listeners, `"response"` targets the rest.
- `_emitEndOnce()` is per-side now (`_requestEndEmitted` = server side,
  new `_responseEndEmitted` = client side); a teardown
  (`close()`/`destroy()`/`end()`) only wakes the sides that have not had
  it. The dead single `_endEmitted` flag is gone.
- `_deliverRequestBody`'s `deliver` emits the server-side `'end'` only;
  `_deliverResponse` calls `_emitEndOnce()`, which fires the client's
  `'end'` after the response lands (and the server's too, if the body was
  never delivered). Push streams are unaffected: they have no
  `_serverEndListeners`, so the server-side branch is a no-op and the
  client's `'end'` still fires.

## Why V4's differential missed them

V4's differential guarded only 17 tests (15 flips + 2 passing). The two
regressed tests were triage passes, not flips, so neither the worker's
differential nor the parent verification ran them. The wave-end full
sweep caught both. Lesson (for the docs sync): a lane differential must
guard the FULL pass set, not just the flips + a couple of passing tests.

## Differential (full 85-test pass set, branch vs pristine main `b5770fa5`)

- Branch: **85/85** pass, 0 fail (sweep-mjs.py, --jobs 2).
- Base: **83/85** pass; the only 2 failures are exactly the 2 regressed
  tests (both exit 1).
- The 2 regressed tests: [0,0] ×2 isolated on branch, [1,1] ×2 isolated
  on base.
- Footprint: `tests/ondemand-require.test.js` 29/29. Jest http2 66/66.

The 85: 35 triage passes + 50 flips (43 lane flips + the 7 extra
side-effect flips the wave-end sweep found: client-write-before-connect,
compat-serverresponse-statusmessage,
compat-write-early-hints-invalid-argument-type,
compat-write-head-after-close, pipe-named-pipe, server-setLocalWindowSize,
window-size).

## Ship

- PR #___
- Merge SHA: ___
