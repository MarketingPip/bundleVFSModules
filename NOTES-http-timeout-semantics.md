# NOTES — http timeout semantics (test-http-set-timeout-server, test-http-timeout-client-warning)

Base: origin/main `d9d0c273` (http 362/397). Branch: `fix/http-timeout-semantics`.
Both targets exit 1 on base, 0 on real Node v24.22.1, 0×2 on branch.

## Root causes (Node source first, then probes)

### 1. Server timeout emission — `onHttpTimeout` (src/http.js)

Node `socketOnTimeout` (`lib/_http_server.js:900-909`):
```js
const req = this.parser?.incoming;
const reqTimeout = req && !req.complete && req.emit('timeout', this);
const res = this._httpMessage;
const resTimeout = res && res.emit('timeout', this);
const serverTimeout = this.server.emit('timeout', this);
if (!reqTimeout && !resTimeout && !serverTimeout) this.destroy();
```
The shim emitted the server event first, then `cur.req.emit("timeout")` with
NO socket arg, and never emitted on the response. Two consequences:
- `serverRequestTimeout`: the req callback does `socket.destroy()` on
  `undefined` → TypeError (base failure at test line 72).
- `serverResponseTimeout`: the res callback never fires (base never reached
  it — masked by the line-72 crash).

Fix: port `socketOnTimeout` verbatim — req emits only while incomplete, res
emits, server emits, all with the socket arg, destroy only when nothing
listened. `EventEmitter.emit` returns a boolean in the shim (src/events.js),
so the destroy-if-none rule is expressible directly.

### 2. Which response the timeout fires on — `socket._httpMessage`

First cut used `cur?.res ?? state.lastResponse` (last-dispatched res). That
fires the WRONG res for pipelined requests: in
`serverResponseTimeoutWithPipeline` (one raw `net.connect`, three pipelined
GETs; /1 ends, /2 and /3 set a 50 ms res timeout) the timer fired on /3's
res (which carries a `timeout` listener but never armed the timer — its
socket is null) instead of /2's. Caught `"/3"`, expected `"/2"`.

Node's answer is `socket._httpMessage`: `assignSocket` sets it (and throws
`ERR_HTTP_SOCKET_ASSIGNED` if one is already attached), `detachSocket`
clears it at `resOnFinish` (`lib/_http_server.js:296-311`). A pipelined res
waits in `state.outgoing` with NO socket until the previous finishes
(`lib/_http_server.js:1229-1233`), so only the attached res can arm the
socket timer — and only it can receive the timeout.

Port: the shim's server side never maintained `socket._httpMessage` (only
the client side did, src/http.js:5102). Now set at dispatch whenever the
res takes the socket (normal + 400 + 417 + drop branches), cleared in
`_finishSocketResponse` (the single finish funnel, Node's `detachSocket`).
`onHttpTimeout` reads `socket._httpMessage` with no fallback, exactly like
Node. The dispatch deferral itself already existed (pipelined res gets
`socket = null` while the previous is unfinished); this only tracks which
res owns the socket.

Scope limit, documented: no "advance to the next queued res" step was added
(Node assigns the next queued res at `resOnFinish`); the shim never
advanced queued res before either (their writes go through the finish
closure's socket), so queued res still get no socket until/unless a future
lane adds the handoff. Consequence: after the attached res finishes,
`_httpMessage` is null until the next dispatch — a socket timeout firing in
that window emits on no res (server only), where Node would emit on the
newly-attached queued res. No official test covers that window.

### 3. Client duration-overflow warning — `ClientRequest.setTimeout`

Node `getTimerDuration` (`lib/internal/timers.js:490-502`, called from
`ClientRequest.setTimeout`, `lib/_http_client.js:1229`): a duration above
`2**31-1` warns synchronously with
`` `${timeout} does not fit into a 32-bit signed integer.\nTimer duration
was truncated to 2147483647.` `` (`TimeoutOverflowWarning`) and clamps to
`2**31-1`. Real-Node probe of the test confirms exactly that message (not
the Timeout-constructor "set to 1" variant from `lib/internal/timers.js:
225-230`, which is what the shim produced before — its native timer fired
with the wrong message and an async stack lacking the test file).

Fix: after the existing validation in `ClientRequest.setTimeout`, if
`timeout > 2**31-1`, emit the warning synchronously via
`globalThis.process.emitWarning` (the native process under the harness —
src/http.js deliberately does not import `./process.js`) and clamp before
storing. Must happen at call time: the value is deferred to `'connect'`,
and clamping first keeps the later `sock.setTimeout(TIMEOUT_MAX)`
warning-free, so exactly one warning fires. Scope is
`ClientRequest.setTimeout` ONLY — Node does not apply `getTimerDuration`
in `IncomingMessage`/`OutgoingMessage`/`Server` setTimeout (they forward
to `socket.setTimeout`). The constructor `timeout` option path
(`lib/_http_client.js:415`, also `getTimerDuration`) is NOT covered by any
test — left alone, noted here.

### 4. Detached streaming round-trip rejection (found while fixing #1)

`serverRequestTimeout`'s client POST writes `"Hello"` and never calls
`end()`. The server destroys the socket at timeout; the client must get
`ECONNRESET 'socket hang up'` on the request (real-Node probe: req error
ECONNRESET → req close, socket close hadError=false). On base the request
hung silently: the streaming round trip (started at first write) DID fail
with ECONNRESET on socket close (`onSockClose` → `fail`), but
`_streamEnsureStarted` attached only `.catch(() => {})` to the detached
promise, and no `end()` ever awaited it — the rejection died there.
Real Node surfaces it via `socketCloseListener` (`lib/_http_client.js:712`:
no response yet → ECONNRESET on the request, then `'close'`), independent
of `end()`.

Fix: the detached catch now mirrors the `end()` path's emission exactly
(same `_errorEmitted` single-fire gate, same `'abort'` fallback when no
`'error'` listener, same `destroy()` for `'close'`) — so a later `end()`
never double-emits. Teardown-initiated rejections never reach this catch:
the round-trip catch returns early for them (`_aborted && _abortSwallow`),
and `destroy()` sets `_errorEmitted` for its own error, so the gate skips.
Probe note: the shim's virtual delivery is slow on this VM (handler ~180 ms
after write-flush; real Node ~940 ms under the same load) — probes with a
200 ms window falsely showed "handler never ran"; the mechanism was fine,
only the window was short.

## Changes (src/http.js only + this file)

- `onHttpTimeout`: port of `socketOnTimeout` (req/res/server + socket arg +
  destroy-if-none).
- Dispatch (4 branches) + `_finishSocketResponse`: server-side
  `socket._httpMessage` tracking (assign/detach).
- `ClientRequest.setTimeout`: overflow warn + clamp to `2**31-1`.
- `_streamEnsureStarted`: detached round-trip rejection surfaces on the
  request (mirrors the `end()` path).

## Verification

- Targets: `test-http-set-timeout-server` 0×2, `test-http-timeout-client-warning` 0×2.
- Guards: 42/42 pass (all #345 ×8, #347 ×4, #350/#351 ×5, dump-req #353,
  keepalive-free #355, remove-header pair #357, server-timeout families).
- Differential: full fast-sweep vs base (fresh `http-sweep-ts-{branch,base}.csv`).
  Branch 362 pass / 5 timeout / 28 fail / 1×134 / 1×139; base run 358 / 6 / 31
  — the base run undercounted by 4 under heavy VM load (349 phase-1 cap-hits
  vs 31 in validation; base-vs-post357 diff is 5 load-flake lines only).
  True comparison is branch vs the post-#357 sweep (362/3/30): exactly the 2
  targets moved 1→0, 0 regressions, 0 mode changes. The runner's 4
  toward-pass lines include 2 base-run flake recoveries
  (client-close-with-default-agent, server-headers-timeout-keepalive: 0 in
  post357, 1 on the loaded base, 0 on branch) — NOT branch improvements.
  The 1 mode change (client-leaky-with-double-response 124→1) is a base-run
  timeout flake (1 in post357 and on branch). Branch timeouts byteswritten
  and pipeline-requests-connection-leak are load flakes: both 0 isolated on
  branch, 0 in post357 (byteswritten is a known pre-existing flake).
  NOTE: the differential took ~58 min wall (base 2198 s + branch 1307 s)
  plus a SIGTERM reap mid-base-phase-2, resumed from the runner's
  resumable state — the loaded VM, not the runner, is the cost.
- Jest suite: 3058 passed / 8 failed / 1 skipped full-run; the 8th failure
  is `timers: interval fires repeatedly until cleared` (30 s timeout, load
  flake — 16/16 isolated on branch). The other 7 are the known baseline
  version-skew set (constants ×3, perf_hooks ×1, oracle util/crypto ×2,
  sys ×1). Baseline 3059/7/1 matched.
- Ondemand: 29/29, non-vacuous (footprint = src/http.js + NOTES file,
  allowlist set to exactly that).
- Builds: `build-sandbox --check` 0, `build-runtime --check` 0,
  `build-vfs` 1 on branch AND on base (identical esm.sh acorn/acorn-walk
  fetch failure for `src/specials/bundler.js`) — environmental, not the
  branch. dist/ restored after builds; never committed.
