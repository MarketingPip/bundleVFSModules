# Error propagation — http timeouts (triage rank 12)

Branch `fix/http-error-prop`, base main `67448061` (PR #338 merged).
Targets: `test-http-aborted`, `test-http-catch-uncaughtexception`,
`test-http-exceptions`, `test-http-uncaught-from-request-callback`
— all four were timeouts (exit 124) on base except
catch-uncaughtexception (exit 1); all four exit 0 ×3 on the branch.

## Root causes (Node source first, then probes)

All four share one root cause: the shim swallowed user throws on the
parse/emit path, where real Node has no try/catch at all.

1. **Round-trip swallow** (`src/http.js` `_socketHttpRoundTrip`,
   `onHeaders`/`onInformation`/`onBody` handlers): `try { onHeaders(i) }
   catch { /* listener errors are not fatal */ }` around the user
   callback. A throw in a response callback (test-http-exceptions,
   test-http-uncaught-from-request-callback, test-http-catch-
   uncaughtexception) vanished — the request hung instead of
   surfacing an uncaughtException. Real Node
   (`lib/_http_client.js`, `lib/_http_common.js` parser callbacks)
   has no try/catch on this path: a listener throw propagates out of
   the parser and becomes an uncaughtException.
2. **Server dispatch swallow** (`_dispatchSocketRequest` try/catch):
   a sync throw in a request/checkContinue/checkExpectation handler
   was turned into `clientError` + socket destroy. Real Node lets
   the throw propagate (2 handler throws → 2 uncaughtExceptions,
   `clientError` count 0, client gets no error, request stays in
   flight — probed v24.22.1).
3. **Missing abort error events**: on client abort, the shim closed
   the request and response but never emitted `aborted`/`error`
   (ECONNRESET `"aborted"`) on the client response, nor `error` +
   `close` on the server request. Real Node (`lib/_http_incoming.js`
   `_destroy` + `onError`, `lib/_http_client.js` `socketCloseListener`,
   `lib/_http_server.js` `socketOnClose` → `abortIncoming`/
   `abortOutgoing`) destroys every in-flight message with
   `ConnResetException('aborted')` when its socket closes.

## Fixes (all in `src/http.js`)

- `_rethrowUncaught(err)` helper (before `ClientRequest`):
  `queueMicrotask(() => { throw err; })` — the established codebase
  pattern (shouldUpgradeCallback throw site) for surfacing a user
  throw as a genuine uncaught exception past a swallowing call stack.
  The swallow sites are kept (they also guard parser-internal
  errors); only the user emits are rethrown.
- Fix 1 — client response-callback throws: try/catch →
  `_rethrowUncaught` around `emit("response")` in
  `_performVirtualRequest`'s `onHeaders`, and around
  `emit("continue")` / `emit("information")` in `onInformation`.
  (The non-streaming `emit("response")` is unreachable for client
  requests — `_performVirtualRequest` always passes onHeaders.)
- Fix 2 — server handler throws: `_dispatchSocketRequest`'s dispatch
  catch now calls `_rethrowUncaught(err)` instead of emitting
  `clientError` and destroying the socket.
- Fix 3a — client res abort: in `_performVirtualRequest`'s round-trip
  catch, the `streamedMsg` branch has an `isAbort` early-return first:
  `streamedMsg.aborted = true; emit("aborted")`; `sock.destroy()`;
  `this.destroy()`; guarded `emit("error", ECONNRESET "aborted")`
  only if `listenerCount("error") > 0`; `streamedMsg.destroy()`.
  The dead `!isAbort` guards later in that branch were simplified.
- Fix 3b — server req error + close: in `onHttpClose`, both the
  `state.current` branch and the stashed-`lastResponse` branch now,
  after destroying the response, emit a listener-guarded `'error'`
  (`new Error("aborted")`, code `ECONNRESET`) on the req and then
  `req.destroy()` for `'close'` — skipped when the app already
  destroyed the request (`!req.destroyed` guard).
- Fix 4 — `OutgoingMessage.errored` is now Node's `kErrored` slot
  (see "False greens" below): `const kErrored = Symbol("errored")`,
  set to `null` in the constructor, a prototype `get errored()`
  shadowing the ported Writable's state-based getter, and a
  `destroy(err)` override recording the argument verbatim.
- Fix 5 — `IncomingMessage._destroy` now matches Node's
  `lib/_http_incoming.js` `_destroy` + `onError` exactly: the
  callback runs on `process.nextTick` (queueMicrotask fallback),
  never synchronously, and the destroy error reaches cb ONLY when
  the message has `'error'` listeners (otherwise `cb()` with no
  error — the ported destroy would emit it unguarded, throwing on
  an unlistened `'error'` and skipping `'close'`). The client socket
  is destroyed WITH the error (`resetAndDestroy(err)`, matching
  Node's `socket.destroy(err)`): the socket error forwarder carries
  it to the request as the unhandled `'error'` — that is where
  test-http-client-incomingmessage-destroy's uncaughtException
  comes from on real Node, not from the response. The server-socket
  branch is unchanged (graceful destroy, probed close-only
  behavior); the peer still gets ECONNRESET either way.
- Fix 6 — `requireHostHeader` (lib/_http_server.js:581-586, 1249):
  the option is now stored on ServerBase (default `true`, non-
  boolean throws `ERR_INVALID_ARG_TYPE` at createServer), and a
  Host-less HTTP/1.1 request is answered 400 with `Connection:
  close` before the handler runs. This was missing entirely from
  the shim — without it, test-http-highwatermark's `mustNotCall`
  handler fired on the shim (natively it never runs: Node 24
  defaults the option to true). Overlap note: rank 9
  (header-assembly) lists requireHostHeader as a lead; this is the
  minimal implementation its lane can build on. Known corner
  divergences: a Host-less checkContinue/checkExpectation request
  goes to its handler here (native 400s it first), and a Host-less
  request past maxRequestsPerSocket gets 503 here (native 400s it
  first) — no official test covers either.
- Fix 7 — `IncomingMessage.client`: plain own property
  `this.client = socket` in the constructor, mirroring
  lib/_http_incoming.js:95 (the shim only had `connection`).
- Fix 8 — `ServerResponse` now observes its socket's `'close'`
  (lib/_http_server.js `onServerResponseClose`, attached by
  `assignSocket`): at dispatch the socket carries TWO close
  listeners (the server's onClose + this one), so
  test-http-req-close-robust-from-tampering's manual invocation
  of both works — the listener removes itself and destroys the
  response only if still unfinished (onHttpClose, registered
  first, already destroyed it on a real close). Removed at finish
  (`_finishSocketResponse`) and at destroy
  (`ServerResponse._destroy`) so keep-alive sockets don't
  accumulate one per response. The manual invocation is safe on
  the shim because the parser guards all callbacks with null
  checks (body bytes are dropped, no throw). Only the normal
  dispatch path attaches it; the 417/drop branches don't yet.

## False greens exposed (both fixed above)

- `test-http-outgoing-destroyed` block 4 (`res.end(); res.destroy();
  res.end("asd"); assert.strictEqual(res.errored, undefined)`)
  passed on base only because the old dispatch catch swallowed the
  handler's AssertionError. Real Node's `OutgoingMessage.errored`
  is a `kErrored` symbol slot — `null` at construction, set to the
  destroy argument verbatim by `OutgoingMessage.prototype.destroy`
  (`lib/_http_outgoing.js:87,158,195–198,356–362`). The shim
  inherited the ported Writable's state-based `errored` getter
  (`src/stream/writable.js:1146`), which reports `null` after a
  bare `destroy()`. Fixed by Fix 4.
- `test-http-client-incomingmessage-destroy` (asserts `res.closed ===
  false` right after `res.destroy(err)`) passed on base only because
  the round-trip catch swallowed the callback's assert throw.
  Real Node's `IncomingMessage._destroy` defers its callback to
  `process.nextTick(onError, ...)` in BOTH branches
  (`lib/_http_incoming.js`, `lib/internal/streams/destroy.js`), so
  `kClosed` is set on nextTick and `closed` stays false
  synchronously after `destroy()` returns. Fixed by Fix 5.

## Cosmetic order deltas vs real Node (not asserted by any test)

zz abort probe on the branch fires all 8 native events with correct
values; two orderings differ: client req `'close'` lands before res
`'aborted'` (the abort-time destroy's close was already queued), and
server req `'error'` lands before server res `'close'` (res close is
async via the ported destroy while the error emit is synchronous).

## Regressions found by the differential — and fixed

The first full differential (branch 330 vs base 328) showed 2
regressions, both cases where the rethrow exposed a missing shim
feature rather than a genuine user error:

- `test-http-highwatermark` (0→1): the `mustNotCall` request
  handler fired on the shim because `requireHostHeader` was
  missing. Fixed by Fix 6 above.
- `test-http-req-close-robust-from-tampering` (0→1): the handler
  threw `TypeError` because `req.client` was undefined and the
  socket carried a single close listener (native carries two).
  Fixed by Fixes 7–8 above.

The same differential showed 19 mode changes, ALL 124→1, all on
rank 9/10/11 targets (header-assembly, localaddress,
response-write timeouts). That is the rethrow working as designed:
those tests hang on base because a handler throw (missing
feature) is swallowed and no response is ever written; on the
branch the throw surfaces as an uncaughtException and the process
exits 1 fast instead of hanging. They still fail — they need the
other lanes' feature fixes — but they fail fast now. Not
regressions.

## Second differential: two pipeline regressions — ROOT CAUSED AND FIXED

- Branch differential 2 (`http-sweep-ep-branch2.csv` vs base, 328):
  branch 331 pass / 7 timeout / 57 fail — the 4 targets + bonus
  `test-http-request-host-header` flipped, but **2 regressions
  (pass→timeout): `test-http-many-ended-pipelines` and
  `test-http-pipeline-requests-connection-leak`**, both 0→124.
- Bisect + instrumented probes (module-local counters, never
  `globalThis` — the harness rejects unexpected globals) traced the
  stall to `res.socket.on("close", onResClose)` inside Fix 8's
  attach block at dispatch #9 of many-ended-pipelines:
  - Each pipelined predecessor reads `finished` by the next
    dispatch, so every response gets the real socket and attaches
    another close listener. At dispatch #9 the socket holds 10
    close listeners; the 11th trips `warnMaxListenersExceeded`.
  - The warning message calls the `inspect` stand-in in
    `src/events.js`, which had **no cycle detection and no depth
    limit** — it recurses astronomically on the socket's cyclic
    graph (`socket → _httpState → lastResponse → socket …`) and
    hangs synchronously. Proved: the warning probe fired, the
    post-`inspect` probe never did.
  - On base (no Fix 8) the socket carries only 2 close listeners,
    so the warning never fires — the hang is entirely this lane's
    Fix 8 + the latent `inspect` bug.
- Fix 9 — `src/events.js` `inspect()`: path-based `seen` set
  (`[Circular]` on re-entry) + depth cap 2 (Node's default,
  `[Object]` beyond). Proved alone: many-ended-pipelines went
  124 → 1 (the warning now surfaces and the test's `mustNotCall`
  warning handler throws), connection-leak 124 → 0 with the
  warning printed.
- Fix 10 — `src/http.js` attach block: one live per-response close
  listener per socket, tracked as `state.resCloseListener`
  (per-socket state). Before attaching, the previous response's
  listener is removed from the socket; it is stale by construction
  (the previous response is finished whenever a new response gets
  the real socket). This matches real Node's observable shape
  (exactly two close listeners: its own onClose + the current
  response's `onServerResponseClose`, probed v24.22.1). A stale
  state pointer (listener already removed at finish/destroy) is a
  removeListener no-op. Finish/destroy removals unchanged.
- After Fixes 9–10: many-ended-pipelines 0, connection-leak 0,
  req-close-robust-from-tampering 0 (2-listener shape preserved),
  all 4 targets + request-host-header + the false-green pair 0,
  guards 81/81.

## Leftovers (not this PR)

- `onBody` data-listener throws are still swallowed by
  `_socketHttpRoundTrip`'s `/* listener errors are not fatal */`
  catch — same root cause as Fix 1, no target needs it.
- `IncomingMessage._dump()` is still missing
  (`lib/_http_incoming.js:502`); native `ClientRequest.destroy()`
  calls `res._dump()`. Separate small lane (from PR #336).
- `test-http-abort-stream-end` (exit 1) still fails — needs the same
  `'error'` ECONNRESET `'aborted'` on the client response in the
  streaming-abort path; next abort-family round (from PR #338).

## Verification

- Targets + the two regressed guards + both former regressions:
  0 ×3 each on the branch (aborted, catch-uncaughtexception,
  exceptions, uncaught-from-request-callback, outgoing-destroyed,
  client-incomingmessage-destroy, server-incomingmessage-destroy,
  highwatermark, req-close-robust-from-tampering).
- Guards: 81/81 pass on the branch (client-error family with correct
  names, outgoing family, abort family, agent family, timeout-option
  family, unix-socket family, server-incomingmessage-destroy,
  client-incomingmessage-destroy, server-capture-rejections,
  expect-handling, req-res-close, 1.0, byteswritten) — re-run after
  the regression fixes, still 81/81.
- Differential: fast-sweep, `http-sweep-ep-{branch3,base}.csv`
  [PENDING — re-run after Fixes 9–10].
- Jest baseline 3059 passed / 7 failed / 1 skipped [PENDING].
- Ondemand 29/29 [PENDING]; builds exit 0 [PENDING].
