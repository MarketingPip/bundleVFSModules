# Agent-* residuals: test-http-agent, test-http-agent-keepalive (+delay), test-http-agent-timeout-option

All four failed on merged main `72357e4b` and on pristine base alike
(pre-existing, not regressions). All four pass after this change. All
behavior below was probed on real Node v24.22.1 first, not assumed.

## 1. test-http-agent — createSocket bypassed createConnection (exit 1)

The test overrides `http.Agent.prototype.createConnection` to call back
with `Error("nothing")` for 16 requests and expects 16 request errors
(plus 16 server hits from the first batch). The shim's
`AgentBase.createSocket` called `netConnect` directly and never called
`this.createConnection`, so the override was bypassed and all 32 requests
reached the server (17 mustCall mismatches: server handler 16 vs 32,
plus 16 never-fired error-path mustCalls).

Fix: `createSocket` now builds the connect options (port, host, agent
`noDelay` default true, agent `keepAlive`/`keepAliveMsecs` as
`keepAlive`/`keepAliveInitialDelay`, request `lookup`) and calls
`this.createConnection(options, oncreate)`. The default
`createConnection` is the virtual-network path (previously a FakeSocket
stub that nothing used for real requests). The addRequest callback is
invoked synchronously at creation now, not on connect: assignment
already happened, so its success branch is a guarded no-op except for
the redundant-socket case (a request that already holds a real socket
via another path — the second addRequest in
test-http-agent-uninitialized — whose cleanup the callback performs).
Socket errors surface solely through `socketErrorListener` (see §4);
no connect/error listener is attached for creation, keeping the
assignment-time error count at exactly one.

## 2. test-http-agent-keepalive-delay — same bypass, plus option shape (exit 1)

The test wraps `agent.createConnection` and asserts it receives
`options.keepAlive === true` and
`options.keepAliveInitialDelay === agent.keepAliveMsecs`, then delegates.
It failed with the override never called (mustCall 0 vs 1). Fixed by
the same §1 refactor: `createSocket` passes `keepAlive` /
`keepAliveInitialDelay` through, and the wrapper's delegation to the
default implementation returns a real virtual socket.

## 3. test-http-agent-keepalive — redirect + release timing + listener lifecycle (was 124, then 1, now 0)

Three stacked gaps:

### 3a. `_http_agent` was not redirected (ECONNREFUSED)

The test (and keepalive-delay) `require("_http_agent").Agent`. The
preload redirected only `net`, `_http_outgoing`, and zlib's `buffer`,
so the test got real Node's agent, whose `createSocket` does a real
`net.connect` against the virtual server port and dies with
ECONNREFUSED (stack showed real `node:net` internals). Fix:
`parity/preload.mjs` now redirects `_http_agent` for the http target
(PR #232 precedent — shared-file change, justified here because only
the shim's Agent can speak the virtual network), re-exporting the
shim's `Agent`/`globalAgent` from the pre-existing `src/_http_agent.js`.
Swapping the import in a probe copy immediately changed the failure
from ECONNREFUSED to a hang, exposing the shim gaps below.

### 3b. Keep-alive release happened before 'end' (counts wrong at 'end')

Real Node order, probed precisely: at 'end' handler enter AND exit,
`sockets=1, free=undefined`; freed only after all user 'end' listeners
run, before nextTick callbacks scheduled in them. The shim released
immediately at message completion (`_finishBody` then
`_releaseAgentSocket`), so at 'end' the socket was already freed.
Fix (streaming completion path, keep-alive branch only): attach
`once('end', release)` + `once('close', backstop)` instead of releasing
immediately. The 'close' backstop covers abort-before-'end' (where
`_finishBody` is skipped and 'end' never fires). The two listeners
remove each other: a stale 'close' firing after the socket was reused
for a later request must NOT re-park the live socket (reuseSocket
resets `_releasedToAgent`, so the guard alone cannot stop it — this was
a real failure found by tracing: the reused socket lost its fresh 'end'
listener). Non-keep-alive `setTimeout(0)` deferral and the buffered
completion path are untouched.

### 3c. Listener lifecycle: assignment, parking, remote close, remote error

Real Node agent-socket listener shapes, probed at each stage (keepAlive
agent, no timeout option):
- At assignment: error 1 (`socketErrorListener`), end 2
  (`onReadableStreamEnd` + `socketOnEnd`), timeout 1 (`onTimeout`).
- After free: error 1 (`freeSocketErrorListener`), end 1, data 0,
  drain 0.
- The test's `checkListeners` asserts exactly those (plus readable 0).

Fix: `ClientRequest.onSocket` now attaches five per-request listeners
and stashes their refs on the socket:
- `socketErrorListener` on 'error' — the request error forwarder
  (consolidates the old `_performVirtualRequest` closure, which
  attached AFTER 'socket' emission and therefore could not satisfy
  the assignment-time count). Semantics preserved: clears the request
  timeout, skips aborted and free-pool sockets, else marks aborted and
  emits 'error'.
- `socketOnEnd` on 'end' — no-op observer ('end' listeners never affect
  flow; a 'data' listener here would wrongly switch the socket to
  flowing mode, so none is added).
- `onTimeout` on 'timeout' — no-op observer.
- `timeoutCb` (`emitRequestTimeout`) on 'timeout' as the SECOND timeout
  listener, only when the agent has a timeout option (§5).
- `socketCloseListener` on 'close' — untracks an active socket on
  close, deferred one turn (see §3e).

`_removeRequestSocketListeners` removes exactly these five; it runs in
the agent's parking path (before the free-pool handlers are added, so
free state is error 1 / end 1) and in the CONNECT/upgrade detach paths
(so handoff is still error 0 / end 1 / timeout 0, per
test-http-connect).

### 3d. Pooled socket never left the pool on remote close

`remoteClose`: the server ends the pooled socket (FIN); after 200ms
the test expects `freeSockets` undefined and `totalSocketCount` 0.
Nothing removed a pooled socket on 'close'. Fix: parking now adds
`once('close', freeSocketCloseListener)` (stored as `_idleCloseHandler`,
removed on reuse alongside `_idleErrorHandler`), mirroring the idle
error handler minus the destroy (already closed).

### 3e. Active socket never left the pool on remote error

`remoteError`: the server destroys its side; the request errors with
"socket hang up" (sockets still 1 at error time — asserted), then after
1ms for 'close' the test expects sockets undefined and total 0. The
request never releases (no completed response), so nothing untracked
it. Fix: the per-request `socketCloseListener` above. Its removal is
deferred one turn (`setTimeout(0)`): the request's 'error' is delivered
async via the round-trip rejection, and its handler still observes the
socket tracked; the 1ms-later close check sees it gone. `removeSocket`
only decrements when the socket is still in the active list, so a close
after release is a safe no-op.

## 4. Creation-time assignment (enables §5, preserves guards)

Real Node fires 'socket' while the socket is still connecting
(probed: `connecting=true, pending=true` at 'socket' time, 'connect'
after). The shim assigned on connect and replayed 'connect' after
'socket'. Now `createSocket` assigns synchronously at creation
(tracking + `req.onSocket`), and 'connect' follows naturally — no
replay needed for fresh sockets (the replay path is kept for sockets
that arrive already connected). Pre-connect writes buffer in the
socket's pending-write queue and flush on connect, so the round trip
can start immediately. The `_performVirtualRequest` waiter already
handled synchronous assignment (the free-socket reuse branch), so no
waiter change was needed. The old connect-time callback wiring
(`once('connect')` + `once('error')` in createSocket) is gone: the
'error' listener counted at 'socket' time (keepalive asserts exactly
one) and would double-emit with `socketErrorListener`.

## 5. test-http-agent-timeout-option — lookup + pending socket + agent timeout (was 1, now 0)

The test does `get({ agent: new Agent({ timeout: 50 }), lookup: () => {} })`
and asserts on 'socket': `socket.timeout === 50`,
`listeners('timeout').length === 2`, `listeners[1] === request.timeoutCb`.
Three stacked gaps:

- **Lookup was dropped.** `_agentOptions` carried only host/hostname/
  port, so the agent's connect ignored the never-returning lookup and
  ECONNREFUSED against the unlistened port, while the request fell
  through to fetch and failed again with 'fetch failed'. Fix: the
  request-level `lookup` is threaded through `_agentOptions` →
  `createSocket` → `createConnection` → `netConnect`, and
  `Socket.prototype.connect` now honors it (mirrors Node's
  `lookupAndConnect`): the lookup is called with (host, options, cb)
  and connect waits for the callback; the resolved address is accepted
  but unused (the virtual network is port-based). A lookup that never
  calls back keeps the socket pending with no error, exactly like Node.
  The loop keeper is armed only AFTER the lookup resolves: a pending
  lookup performs no handle activity on real Node, so it must not hold
  the loop open (otherwise the never-resolving lookup hangs the
  process instead of draining).
- **No-server agent requests fell through to fetch.** With no virtual
  or raw server to round-trip against, `_performRequest` fetched and
  failed. Fix: a new branch before the fetch path — when the request
  holds an agent-assigned real socket (no server target by then, since
  the gates above excluded servers), it emits 'socket' async via
  microtask (like the fetch path: the branch runs synchronously inside
  `get()`/`end()`, before the caller can attach listeners — a
  synchronous emission would be lost) and waits on the socket's fate
  (error surfaces once via the forwarder; a pending socket never
  settles, so the loop drains and the process exits — matching Node's
  pending-socket hang).
- **Agent timeout was never wired to the socket.** Fix in `onSocket`:
  when `agent.options.timeout` is set, the request gets `timeoutCb`
  (named `emitRequestTimeout`, emits 'timeout' on the request) attached
  as the second 'timeout' listener after `onTimeout`, and
  `socket.setTimeout(agentTimeout)` sets the property and arms the
  (unref'd) timer. Real Node leaves `request.timeout` undefined for the
  agent option (probed) — it is NOT copied — and an agent timeout emits
  'timeout' on the request without destroying the socket (probed:
  still `destroyed=false` at 500ms), unlike the request-level `timeout`
  option, which destroys. Both distinctions are preserved.

## 6. Three regressions the guard battery caught, all fixed in-lane

The first guard run (102 pass / 16 fail) showed 13 failures identical
on pristine base (pre-existing, not regressions) plus 3 the lane
introduced. Each had a distinct, probed root cause:

### 6a. test-http-server-delete-parser (branch 124, base 0)

The once('end') keep-alive release (§3b) never fired for this test:
its client attaches NO response handler, so 'end' never fires and the
socket stayed active, holding the loop. Probed on real Node v24.22.1:
with no response handler the socket IS released at completion
(free=1 at +500ms), but with a response handler and no read it is
NOT (sockets=1 at +500ms). Rule implemented: the streaming emission
site stashes `streamedMsg._responseObserved` (a 'response' listener
exists at emit time — stashed, not checked later, because the
constructor attaches the response callback via once(), which emit
removes). The keep-alive completion branch releases immediately when
unobserved, and uses the once('end')/once('close') pair only when
observed. agent-uninitialized passes either way (server.close()
destroys the connection; it asserts nothing about counts).

### 6b. test-http-outgoing-destroyed (branch 1, base 0)

The first block's PUT client must see 'error' when the server destroys
the response mid-request. On base the frame's `_write` runs after the
server destroyed during the head's delivery, so it errors "Socket is
not connected" and the forwarder emits the client error. On branch
both client `_write`s executed BEFORE the server handler ran: the
round trip started at creation, so its writes sat in pre-connect
`_pendingWrites` and were flushed during pairing — before the server
socket's HTTP machinery was attached, so the server processed them
asynchronously (after all client writes) instead of synchronously
during delivery, leaving nothing to error. Fix (two parts, both
needed): (1) `_performVirtualRequest` waits for 'connect' before the
round-trip body runs ('socket' is still emitted at assignment time;
reused/already-connected sockets skip the wait; a socket that dies
before connecting just returns, its error already forwarded — no
double emission). This restores post-connect write timing. (2)
`Socket.prototype._flushPendingWrites` applies `_write`'s liveness
check per item (peer re-read each iteration, since it can die
mid-loop): a peer that died during an earlier item's delivery errors
later items ("Socket is not connected", or ERR_STREAM_DESTROYED once
this socket is destroyed) instead of `_deliverToPeer` silently
dropping them. Both call sites are client pairing, so the check
restores exactly the post-connect `_write` behavior.

### 6c. test-http-double-content-length (branch 1, base 0)

The server `clientError` handler asserts code
`HPE_UNEXPECTED_CONTENT_LENGTH`, but the parser only ever emits
`HPE_INVALID_CONTENT_LENGTH` for conflicting values (grep-confirmed:
zero occurrences of UNEXPECTED in `src/`; the parser file is
untouched by this lane). On base the test passes anyway because the
throw is swallowed by the round-trip writer's catch (the #287 note
documents this: the handler throws before destroying, and the test
passes via swallow + the receiving=false drain fix). On branch the
same throw propagated as uncaught because the round trip started
before connect: the request bytes were flushed during pairing,
outside the round-trip writer's catch. The §6b connect-wait restores
the base timing (writes inside the writer's catch), so the throw is
swallowed exactly as on base. The parser's code-name gap
(INVALID vs UNEXPECTED) is NOT fixed here — it is a separate,
test-backed question (the conflicting-value test passes via the
swallow; whether any test asserts UNEXPECTED for same-value CL is
still unchecked, per the HPE_STRICT lesson) and changing the hot
parser path for a swallowed assertion would be a maybe-fix.

### 6d. Repo jest: fetch-bridge hijack (http.test.js/https.test.js, 8 tests)

Creation-time assignment (§4) made EVERY request hold a real socket
at `_performRequest` time, so two fetch-path assumptions broke:

1. The deferral branch ("agent-assigned real socket, no server →
   never fetch") hijacked non-loopback requests: example.com requests
   errored ENOTFOUND from netConnect's DNS branch instead of reaching
   mocked fetch. Fix: the branch is gated on `_isLoopbackTarget()` —
   the pending-socket shape it serves (a lookup that never calls
   back) only exists for loopback targets; non-loopback keeps fetch
   (the shim has no DNS/TCP for real hosts).
2. The consolidated socketErrorListener (moved into onSocket so
   keepalive sees error==1 at assignment) also served fetch-path
   requests, which never had a forwarder on base: the ENOTFOUND from
   the meaningless agent socket cleared the request's 20ms timeout
   timer and set `_aborted`, so "timeout emits timeout" hung to the
   jest 30s cap. Fix: `_performRequest` sets `_usingFetch = true`
   when it commits to the fetch section, and the forwarder returns
   early for such requests — the listener still consumes the socket
   error (nothing throws unhandled), but the fetch outcome owns the
   request. The deferral branch never sets the flag, so its
   error-via-forwarder behavior is unchanged.

Known remaining divergence (no test asserts it): the fetch path's
'socket' event now carries the agent's real socket instead of the
old FakeSocket, since creation-time assignment replaced the
synthetic socket. Harmless for the suites (http/https 68/68).

### 6e. test-http-client-read-in-error (sweep regression 0→124, fixed)

Honoring the custom `createConnection` override (the lane's core fix)
exposed a loop-keeper bug: the test's override returns a raw socket
that errors without ever connecting or being destroyed. The request
errored ("ignore" printed) but the process never exited: pushing bytes
into the errored socket scheduled a ported-Readable read, which armed
the socket's 1h loop keeper, and nothing ever released it.
`_needsLoopKeeper` returned true for it (not destroyed, no EOF,
`_readStarted`). Fix (`src/net.js`, one guard): a socket that never
connected and isn't connecting has no handle on real Node, so it must
not hold the loop — `_needsLoopKeeper` returns false in that case.
Connected/connecting sockets are untouched (the guard requires both
flags false); half-closed and peer-dead sockets still go through the
`_isTransportInactive` path below it.

### 6f. Sweep mode changes, still failing on both trees (not regressions)

- `test-http-outgoing-message-capture-rejection` (base 1, branch 124):
  block 2's drain throw correctly produces a single req 'error' on
  branch, while base emits it twice ("kaboom", then "socket hang up")
  and the second error's assertion throw kills the process (exit 1).
  Branch is closer to real Node on block 2, but block 1's server never
  closes on EITHER tree (its socket 'error' handler never fires — the
  drain throw's captureRejections routing never reaches the socket),
  so without base's killing throw the loop stays held. A block-1-only
  replica hangs identically on base and branch. The socket-error
  routing for captureRejections drain throws is a separate, pre-existing
  gap (both trees fail this test).
- `test-http-req-res-close` (base 1, branch 124 in the sweep only):
  1×3 on branch and 1×3 on base on re-run — the sweep's 124 was load
  flake, not a branch effect.
- `test-http-client-timeout-event` (124→1) and
  `test-http-socket-encoding-error` (124→1): failure mode changed,
  still failing — noted, not chased (same precedent as #290's
  multi-line-headers mode change).

## Verification

- Targets: agent 1→0, keepalive 124→0, keepalive-delay 1→0,
  timeout-option 1→0 (each re-run on the branch; see PR).
- Guards + full 397 differential + repo jest + build-vfs: see PR body.

## Deliberately left alone

- `test-http-agent-keepalive`'s `remoteError` 1ms close check relies on
  the deferred active-close removal; a same-turn removal would break
  the error-handler assertion (sockets=1 there).
- The fetch path still uses the FakeSocket with no agent-timeout
  wiring: only the agent path (virtual + deferral branch) carries real
  sockets, and `timeoutCb` is observed only by the timeout-option test,
  which takes the deferral branch.
- `test-http-upgrade-*` and `test-http-connect` handoff shapes are
  unchanged: detach removes all five request listeners before emitting
  'connect'/'upgrade'.
- Bare-message drain emission and `writableNeedDrain` shadowing (from
  the #280 lane) remain open — no test in this lane hinges on them.
