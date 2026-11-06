# NOTES-http-request-signal.md

Triage Lane 7 (2026-11-06): `IncomingMessage.signal` — lazy getter + abort wiring.
Target: `test-http-request-signal.js` (exit 1 on main `d9d0c273`) → 0.
Fix: `src/http.js` only (+30/-8 lines of logic, + comments).

## Root cause

The shim had NO `IncomingMessage.signal` getter at all — only
`options.signal` on `ClientRequest` (`src/http.js:3684+`). Accessing
`req.signal` returned `undefined`, so the test threw
`TypeError: Cannot read properties of undefined (reading 'aborted')`
at line 99 (Test 3: `req.signal.aborted` after `req.destroy()`).

## Node model (lib/_http_incoming.js, v24.20.0)

- `signal` getter, line 199: lazy `AbortController`; if the message is
  destroyed while incomplete → abort immediately; else
  `kAttachAbortSignal()`.
- `kAttachAbortSignal`, lines 215–238: if already aborted / detached /
  listener exists → return; no socket → return; socket destroyed →
  `abortSignal()`; else store socket + `socket.once('close', listener)`
  → `abortSignal()`.
- `kDetachAbortSignal`, lines 240–249: mark detached, remove the socket
  'close' listener.
- `abortSignal`, lines 300–305: detach, then `ac.abort()` if a
  controller exists.
- `_destroy`, lines 271–279: only if `!readableEnded || !complete` →
  `aborted = true`, `emit('aborted')`, `abortSignal(this)`.
- Server `resOnFinish` detaches: `req[kDetachAbortSignal]()`
  (`lib/_http_server.js:1111`). Client `responseOnEnd` detaches:
  `this[kDetachAbortSignal]()` (`lib/_http_client.js:1021`).

## The port (src/http.js, IncomingMessage)

- Symbols next to `kOutHeaders`: `kAbortController`,
  `kAbortSignalSocket`, `kAbortSignalListener`, `kAbortSignalDetached`
  (module-local — `src/_http_incoming.js` already exports a
  `kDetachAbortSignal` symbol, but it is a fresh instance in that
  module and importing it into http.js would cycle: that module imports
  `IncomingMessage` from `./http.js`).
- Constructor slots init after `joinDuplicateHeaders = false`.
- `get signal()` + `_attachAbortSignal()` / `_detachAbortSignal()` /
  `_abortSignal()` mirror Node 199–238 / 240–249 / 300–305.
  `AbortController` is a platform global (browser + Node), no import.
- `_destroy` gate ported: only when `!readableEnded || !complete` →
  set `aborted`, emit `'aborted'`, `_abortSignal()`. Previously the
  shim set `aborted = true` unconditionally, which diverges from Node
  (test 2 asserts `req.aborted === false` after normal completion).
- Detach points (mirroring resOnFinish / responseOnEnd):
  - Server: top of `_finishSocketResponse`. Destroy-without-end never
    reaches here (`'finish'` is only emitted manually for
    end-then-destroy), so test 1's `res.destroy()` abort is unaffected.
  - Client streamed completion branch: after
    `streamedMsg._finishBody()`.
  - Client buffered path: after `msg._setBody(result.body)`.
  - Client fetch path: after `fromFetchResponse` (message already
    complete; detaching before `'response'` matches the end-state).

## Regression caught and fixed during the lane

First version emitted `'aborted'` in `_destroy` unconditionally
inside the gate. That double-fired `mustCall(1)` `'aborted'`
listeners in `test-http-aborted` and `test-http-client-abort`:
the shim's `onHttpClose` ALREADY emits `'aborted'` and sets
`aborted = true` before destroying the message (server stashed-req
branch ~8160, client round-trip abort paths ~5931/5964/5978).
Fix (first attempt): gate the `_destroy` emit on `!this.aborted`.
That fixed test-http-aborted / test-http-client-abort — but the
full differential then showed 4 more double-`'aborted'` regressions
(test-http-abort-client, test-http-client-aborted-event,
test-http-client-spurious-aborted,
test-http-outgoing-message-capture-rejection): the HPE/generic
round-trip branches record the abort as `_aborted`, not `aborted`,
so the `!aborted` gate missed them.
Fix (final): gate the emit on `!this.aborted && !this._aborted`
(the codebase's own combined predicate, ~10554), while still
always setting public `aborted = true` here, as Node does and as
the old code did. All 6 abort tests + the target pass 0×2 after
the fix. The two sweep-timeout "regressions"
(pipeline-requests-connection-leak, server-headers-timeout-keepalive)
were contention flakes — both pass isolated on the branch; the
latter FAILS 2/2 isolated on base (expects 408, gets 200 — a
pre-existing timing flake, not a regression).

Debugging note: plain probes in `/tmp` did NOT reproduce the double
fire — files outside the repo run under REAL Node http (the preload
only shims requires from inside the tree), so `/tmp` probes showed
single-fire while in-tree tests double-fired. Reproduce parity bugs
with test files inside `parity/node-test/parallel/` (zz-*.js, deleted
after use), never with `/tmp` probes alone.

## Differential (fast-sweep, base d9d0c273 → branch)

- Branch (fresh run `http-sweep-rs-branch2.csv`): 363 pass / 3
  timeout / 31 fail (29 fast + 1×134 + 1×139).
- Base (`http-sweep-rs-base.csv`): 361 pass / 4 timeout / 32 fail.
  (One below the recorded 362: `test-http-byteswritten.js` timed out
  at 124 in this base run under contention — it passes 0×2 isolated
  on base and branch alike, a known flake, not a code difference.)
- Changed lines: exactly 2 toward pass —
  `test-http-request-signal.js` 1→0 (the target) and
  `test-http-byteswritten.js` 124→0 (flake, NOT claimed as a flip).
- 0 regressions, 0 mode changes.
- True code-caused flips: 1. Recorded count: 362 → 363.
- NOTE: an earlier branch sweep (`http-sweep-rs-branch.csv`, run
  before the `_aborted`-gate fix) showed 354 pass with 8 apparent
  regressions; 4 were real double-`'aborted'` regressions (fixed by
  the final gate, all 0×2 after), 2 were contention flakes, 2 were
  sweep-timeout flakes. That CSV is stale — do not use it.

## Guards (all 0 on branch)

8× #345 (early-hints-invalid-argument, flush-headers,
incoming-message-options, response-cork, response-status-message,
response-statuscode, sync-write-error-during-continue,
write-callbacks), 4× #347 (aborted, catch-uncaughtexception,
exceptions, uncaught-from-request-callback), 5× #350/#351
(header-badrequest, mutable-headers, set-cookies,
client-check-http-token, hostname-typechecking), dump-req-when-res-ends
(#353), keepalive-free (#355), remove-header pair (#357),
client-abort, client-abort3, client-abort-destroy,
agent-abort-controller. `test-http-abort-stream-end` still 1
(Lane 9 target, also 1 on base — not a regression).

## Follow-ups (NOT this PR)

- `IncomingMessage.signal` on a message whose socket is REPLACED
  after access (fetch path reassigns `msg.socket` after construction):
  the attached socket is the construction-time FakeSocket; the
  observable (completed response never aborts) is correct because the
  detach runs before `'response'`, but the attach-then-replace ordering
  is untested. No test covers it.
- `kDetachAbortSignal` symbol in `src/_http_incoming.js` is still a
  surface stub (fresh symbol instance, unused). A future lane that
  needs cross-module identity should reconcile it with the http.js
  symbols, not add a third.
