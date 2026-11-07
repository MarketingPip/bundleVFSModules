# NOTES-http-trailing-bytes.md — trailing bytes after a completed response

Target: `test-http-client-leaky-with-double-response.js` (1 → 0).

## The test

Server handler:

```js
res.setHeader("Content-Type", "application/json");
res.end(JSON.stringify({ hello: "world" }));
req.socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
```

Client collects `data` chunks, on `'end'` does `JSON.parse(body)` and
asserts `data.hello === "world"`. It also waits for `onGC(req)` — the
request must become collectable once the body is correct.

## Root cause: the shim INVERTS the wire order (probed, not assumed)

Real Node delivers the 200 response synchronously inside `res.end()`,
so the trailing 400 bytes arrive AFTER the first message completes.
The shim delivered dispatch-created buffered response bytes only at
`'finish'` (nextTick), while the handler's synchronous
`req.socket.write()` went out immediately — so the client parser saw
the 400 FIRST.

Evidence (2026-11-06, probes `/tmp/probe-real-order.js`,
`/tmp/probe-real-leaky.js`, `zz-leaky.js`, `zz-order2.js`):

- Real Node, raw `net.connect` client: wire order is
  `HTTP/1.1 200 OK... {"hello":"world"}MARKER-RAW` — 200 first, raw
  write second. Client gets exactly one data chunk
  `{"hello":"world"}`, `'end'` fires with the clean body; the trailing
  400 bytes never surface as data.
- Shim before the fix: `[srv] after end: bytesWritten= 0 finished=
  true headerFlushed= false` — after `res.end()` returns, ZERO
  response bytes had reached the socket; `[srv] after raw write:
  bytesWritten= 12` (only the 12-byte raw write). Client got
  `response event, status: 400`, data chunk = the ENTIRE raw first
  response (`"HTTP/1.1 200 OK\r\n...Content-Length: 17\r\n\r\n
  {\"hello\":\"world\"}"`), then hang → exit 124. The parser took the
  400 as the first message and the 200 bytes as its body (no CL/TE →
  body until EOF, never completes).
- Shim after the fix: `[srv] after end: bytesWritten= 172` (the full
  200 response delivered synchronously in `end()`), raw write adds 12
  → 184. Client gets status 200, data `{"hello":"world"}`, `'end'`.

Mechanism: `ServerResponse._write` buffers the end-chunk (the
`this._header && !this.finished` branch is skipped for end-chunks by
design — end-chunks stay buffered so the finish path sends headers +
body + terminator as one write, which tests counting data events per
response rely on); bytes left only in `_finishSocketResponse`
(~9937, called from the `res.on("finish")` listener installed at
dispatch), and Writable `finish` is emitted via `nextTick`
(`src/stream/writable.js:1001`). `_deliverToPeer` (`src/net.js:1857`)
is synchronous (except during upgrade dispatch), so the raw write
overtook.

## Why the client guard alone CANNOT fix this test

Node's `parserOnIncomingClient` double-response guard
(`lib/_http_client.js:881-897`, read from the node-src pack) fires
only when a second response's headers complete while `req.res` is
already set: `if (req.res) { socket.destroy(); if (socket.parser) {
socket.parser.incoming = req.res; socket.parser.incoming[kSkipPendingData]
= true; } return 0; }` (NODE-SRC-MAP.md:240-243). In the shim the 400
arrived FIRST, so there was no first response to protect — the guard
would never fire. The map's note assumed 200-first delivery. The fix
must restore wire order server-side; the client guard is still the
faithful second half (prevents pool poisoning + enables GC when both
messages land in one execute, and matches Node for any genuinely-late
second response).

## Fix, part 1 — buffered-delivery extraction (shared by finish + the write hook)

`src/http.js`:

- `_writeBufferedResponse(socket, req, res)` (line 7768, module-level):
  the buffered-delivery else-branch of `_finishSocketResponse`,
  extracted VERBATIM (verified byte-identical modulo the flag lines +
  dedent) — head/body computation, implicit-CL, Trailer/TE/chunked
  framing incl. the corked 5-write sequence for chunked, one-write
  coalescing for CL. Pure in `(socket, req, res)`: no server state
  (the only `this.`/`state.`/`info.` hits in the original branch were
  inside comments). Sets `res._bytesDelivered = true` just before the
  first write, so a throw mid-branch cannot let finish re-deliver
  (and duplicate) the response; a computation throw leaves the flag
  unset and finish delivers normally.
- `ServerResponse.end` does NOT flush: the response stays buffered
  until finish (nextTick), exactly as on base. The flush instead
  happens from the socket's own write path (see part 3).
- `_finishSocketResponse` (line 9923): the buffered branch is now
  `else if (!socket.destroyed && !res._bytesDelivered)` — finish
  skips byte delivery when the write hook already delivered, while
  still running all lifecycle (dump, keep-alive/close, `inFlight`).

Scope guards (why the flush is NOT unconditional):

- Streaming responses (`_headerFlushed`, i.e. pended frames exist)
  keep finish-time delivery: a synchronous end flush of pended
  frames was TRIED and REVERTED for the streaming case — it broke
  incremental readers (`test-http-readable-data-event`: flushing
  inside `end()` lets a second chunk arrive within the client's
  first readable callback, so `read()` never returns the null the
  test expects). See the `#279` note in `_finishSocketResponse` and
  the `ServerResponse.end` foreign-socket comment. The buffered case
  has no pended frames and delivers as ONE write, the same
  data-event shape as finish-time delivery — only the timing moves
  a tick earlier.
- Foreign sockets keep their own early delivery above (which already
  set `_headerFlushed`); standalone responses keep their finish
  listener; socketless pipelined responses (`res.socket === null`)
  keep finish-time delivery.

## Fix, part 2 — client-side double-response guard (Node-faithful)

`src/http.js` `_socketHttpRoundTrip` (~7402–7511):

- `let finalDelivered = false` in the round-trip closure; set in the
  CONNECT branch, the 101 branch, and the final-response fall-through
  (1xx never sets it — Node clears `req.res` for 1xx).
- At the top of `parser.onHeadersComplete`, before the CONNECT/101/1xx
  checks: if `finalDelivered`, destroy the socket synchronously,
  set `parser._skipPendingData = true`, and return WITHOUT calling
  `onHeaders`/`onInformation` (do not replace `streamedMsg`, do not
  re-emit `'response'`). The socket destroy is safe mid-execute:
  `Socket._destroy` emits `'close'` via `nextTick`
  (`src/net.js:2083`), so the current `execute()` + `onData` settle
  complete first; `onSockClose`'s pendingResult branch resolves with
  the first response before any fail. The default globalAgent is
  non-keep-alive, so release destroys the socket anyway — that is what
  lets `onGC(req)` fire once the body is correct.

`src/_http_parser.js`:

- `this._skipPendingData = false` in the constructor (line 159) and
  cleared in `_resetMessage()` (line 177) so a later message on the
  same parser can be delivered again (Node rewinds
  `parser.incoming` per message the same way).
- The three `onBody` emission sites (body-eof ~247, fixed ~949,
  chunked ~1004) are gated on `!this._skipPendingData`. The flag is
  only ever set by the client round trip's guard; the server-side
  parser never sets it, so server parsing is untouched. A skipped
  message's `onMessageComplete` still fires but the round trip's
  `pendingResult` is first-wins, so the first response is never
  overwritten.

With the ordering fix, the 400 bytes in THIS test arrive in a separate
delivery AFTER settle (listeners detached), so they sit in the socket's
readable buffer and die when the socket is destroyed at release; the
guard covers the same-execute coalesced case and any genuinely-late
second response.

## Fix, part 3 — socket-write hook (rework; the end-flush + parser guard were reverted)

First attempt (REVERTED): flush the buffered response synchronously
inside `ServerResponse.end()`, plus a parser re-entrancy guard
(`_executing` / `_pending` / `_drainPending()` in
`src/_http_parser.js`) to absorb the synchronous client reply that
the flush creates. That attempt fixed the target (0×2) but regressed
3 tests in the fast-sweep differential (all 0 on base and on the
clean post357 CSV, all reproduced isolated 2× on the branch):

- `test-http-pipeline-socket-parser-typeerror` 0 → 124 (hang).
  The guard queued request 3's bytes during request 2's dispatch,
  and the outer `execute()` returned via `"paused"` without draining
  them; response 2 is a streaming `res.write` that never finishes
  until the upgrade handler runs, which needs request 3 parsed —
  deadlock. On base the re-entrant parse THROWS (`malformed header
  line: GET / HTTP/1.1`, proven by line-level debug on the base
  worktree) → 400 + socket destroy → clean exit, so the test passes
  vacuously via teardown, not via the upgrade flow. The guard
  converted that throw into a silent queue + hang.
- `test-http-socket-error-listeners` 0 → 124 (hang). Each `"*"` →
  HPE_INVALID_METHOD → `onError` → `clientError` handler writes the
  next `"*"` synchronously during the catch; the re-entrant
  `execute()` queued it, and the catch path never drained
  `_pending`, so the loop stalled — no further `execute()` ever came.
- `test-http-writable-true-after-close` 0 → 1. The end-flush made
  `finish` fire on the proxy response whose socket the peer had
  already aborted, so the test's `mustCall(1)` listener (registered
  on BOTH `finish` and `close`) fired twice; on base only `close`
  fires (the response is destroyed with the socket before finish).

The end-flush was the wrong layer: it changed delivery timing for
EVERY buffered response, which created re-entrancy (keep-alive
sequential) and changed finish/close timing on aborted sockets.
Reverted in full: the `end()` flush call and the parser guard
(`_executing` / `_pending` / `_drainPending`, drain-aware returns,
`finally` clear) are gone; the parser is byte-identical to base
except part 2's `_skipPendingData`.

The fix that shipped instead flushes ONLY at the moment the wire
order matters — when user code writes raw bytes to a server socket
that has a finished-but-undelivered buffered response. `src/http.js`
`_onSocketConnection` installs an own `socket.write` wrapper (same
pattern as the own `setEncoding` thrower just below it):

- Before delegating, if `state.lastResponse` is finished,
  `!_headerFlushed`, `!_bytesDelivered`, dispatch-created
  (`_serverReqNo !== undefined`), on a live non-FakeSocket, call
  `_writeBufferedResponse(socket, res.req, res)` — then the raw
  bytes go out after the response. A throw mid-branch leaves
  `_bytesDelivered` set, so finish skips re-delivery.
- The wrapper is safe from net.js's own `write` resets
  (`src/net.js:1476` resets only on client `connect()`; `writeAfterFIN`
  only when `allowHalfOpen` is false — server sockets set it true),
  and it is installed only on server sockets (client sockets never
  get it).
- No extra re-entrancy flag is needed: `_bytesDelivered` is set
  before the helper's first write, so the helper's own
  `socket.write` calls see the flag and delegate straight through;
  and the server's dispatch gating (the next request is not
  dispatched until the in-flight response finishes) means no later
  finished response can be pending during a delivery, so the wrapper
  can never flush a later response ahead of an earlier one in flight.
- With the flush out of `end()`, the keep-alive sequential test
  behaves exactly as on base (response at finish, reply after
  `execute()` returns — no re-entrancy, no parser guard needed),
  the pipeline test keeps base's throw → teardown → exit 0, the
  socket-error loop keeps base's re-entrant error-state reporting,
  and the writable test keeps base's finish suppression on an
  aborted socket.

## Verification

- Target: 1 on base worktree (exact `JSON.parse` failure on
  `"HTTP/1.1 2..."`), 0×2 on branch worktree (both with the
  end-flush attempt and with the shipped write hook).
- Wire-order probe `zz-order2.js` (end-flush attempt): after end
  bytesWritten 0 → 172. With the shipped hook the response goes out
  inside the handler's `req.socket.write()`, before the raw bytes.
- The 3 differential regressions from the end-flush attempt are all
  0×2 on the branch with the shipped hook:
  pipeline-socket-parser-typeerror, socket-error-listeners,
  writable-true-after-close (each 0 on base too).
- Guards (first batch, end-flush era): 116 pass / 9 fail; all 9
  adjudicated against the base worktree at 30s (7 were load flakes
  at the 20s cap — 0 on base and branch; server-headers-timeout-
  keepalive 1 on BOTH sides; pipeline-flood 1 on both sides, known
  NO-FIX) — zero regressions. `tests/http-socket.test.js` 36/36 +
  16 parity spot-checks all 0 (readable-data-event, 1.0-keep-alive,
  get-pipeline-problem, many-ended-pipelines, client-parse-error,
  pipeline-assertionerror-finish, pipeline-outgoing-destroy, server,
  keep-alive, chunked, transfer-encoding-smuggling, upgrade-client,
  information-headers, expect-continue, dump-req-when-res-ends,
  keepalive-free).
- Guards (rework batch, 73 tests: the 4 key tests + 16 spot-checks +
  response/pipeline/keep-alive/parser families + the 9
  previously-adjudicated): 58 pass / 15 fail. All 15 adjudicated:
  14 are other wave-2 lanes' still-open targets (L8 ×2, L9, L11,
  L12, L13 ×2, L14 ×3, L16, L17, L18) + pipeline-flood (known
  NO-FIX, 1 both sides); the 15th, server-request-timeout, is 1 on
  base 2× and branch 2× — pre-existing, not a regression. Zero
  regressions. `tests/http-socket.test.js` 36/36 on the reworked
  branch.
- Jest: branch 3059 passed / 7 failed / 1 skipped — EXACTLY the
  pristine-base baseline (3059/7/1); zero branch-only failures.
  The 7 are the known host-skew set (constants 3, sys 1, oracle
  crypto/util 2, perf_hooks 1). `tests/http-socket.test.js` 36/36 on
  the reworked branch.
- Ondemand: 29/29 (on the rebased commit).
- Builds: sandbox 0, runtime 0, build-vfs 0 (VFS written;
  `dist/*` churn reverted afterwards).
- Differential: fast-sweep `http-sweep-tb-base2.csv` (base = new main
  `631837ac`: 382 pass / 2 timeout / 13 fail) /
  `http-sweep-tb-branch2.csv` (branch `64051e95`: 383 pass / 2 timeout
  / 12 fail) — exactly 1 changed line: the target 1 → 0, zero
  regressions. (The earlier `http-sweep-tb-{base,branch}.csv` pair,
  against the old `4f663d64` base, showed the 3 regressions of the
  reverted end-flush attempt; superseded by the base2/branch2 pair.)

## Follow-ups

- None known. The queued-res socket handoff (#364 NOTES) is
  untouched by this change: a socketless pipelined response still
  delivers at finish, as before.
