# Upgrade-socket detach (server + client)

Follow-up to PR #275, which detached CONNECT tunnels but explicitly left
upgrade sockets untouched ("their tests assert different listener shapes").
All 10 upgrade tests failed on the base (`65786936`): 5 exit 1, 4 hang
(124), 1 fast failure — but the failures turned out to be broader than
listener state alone. This lane fixes the diagnosed mismatches, narrowly:
7 of the 10 tests now pass. The remaining 3 are each blocked by a distinct
out-of-lane root cause, diagnosed with evidence below; none was papered
over.

## Baseline (base `65786936`, all 10 failing)

| Test | Before | After |
|---|---|---|
| upgrade-client | 1 | 0 |
| upgrade-agent | 1 | 0 |
| upgrade-client2 | 124 | 124 (blocked, §5) |
| upgrade-server | 1 | 1 (blocked, §6) |
| upgrade-server2 | 124 | 0 |
| upgrade-server-callback | 1 | 124→ see §7 (cases proven, test blocked) |
| upgrade-binary | 1 | 0 |
| upgrade-advertise | 124 | 0 |
| upgrade-reconsume-stream | 1 | 0 |
| parser-freed-before-upgrade | 1 | 0 |

## Real-Node shapes probed (v24.22.1, plain node)

- Server socket at `'upgrade'`: close [], data [], end
  `[onReadableStreamEnd]`, error [], timeout [] — identical to the CONNECT
  detach shape. `socket.parser === null`, `allowHalfOpen: true`,
  `_httpMessage: undefined`. Head = post-header bytes. Post-upgrade app
  `data` listeners receive bytes (echo works).
- Client socket at `'upgrade'` (raw net server): close [], data [], end
  `[onReadableStreamEnd]`, error [], timeout [], `parser: null`,
  `_httpMessage: null`. Head = parser remainder.
- No `'upgrade'` listener and no `shouldUpgradeCallback` → falls back to
  `'request'` dispatch (`HTTP/1.1 200 OK`).
- `shouldUpgradeCallback`: false → `'request'` dispatch even with a
  listener; true + no listener → socket destroyed (client ECONNRESET);
  callback throw → `uncaughtException`.
- Upgrade handler throw → `uncaughtException` (never swallowed).
- Request completes at upgrade: after `'upgrade'`, the request is
  destroyed (`req.destroyed === true`) and emits `'close'` with no socket
  activity at all.

## Root causes fixed

### 1. Client WebSocket-bridge hijack (client, agent, server-callback, binary, reconsume, parser-freed)

`_performRequest` checked `upgrade === "websocket"` BEFORE the
virtual-server check and bridged to the native WebSocket, which dialed
real TCP to `ws://localhost:port` where no real server listens →
ECONNREFUSED → `nativeWs.onerror` emitted `'error'` on `this.socket`,
still the FakeSocket placeholder at `end()` time → uncaught (FakeSocket
extends EventEmitter; `emit('error')` with no listener throws).

Fix: loopback targets never take the bridge. A new `_isLoopbackTarget()`
(factored out of `_getVirtualServer`, preserving its host-carried-port
parse) gates the bridge, and a null-server branch routes loopback
websocket upgrades through the existing agent-socket round trip
(`_performVirtualRequest(null, …)` — the server side is the app's net
`'connection'`/`'data'` handlers, not HTTP dispatch). Array-form headers
are invisible to `getHeader()` (they bypass `kOutHeaders`), so the
loopback branch consults the stashed `_headersArray` too — without this,
upgrade-client's second (array-form) request fell through to `fetch()`.

### 2. Client virtual round-trip had no 101 handling (client2, advertise)

`_socketHttpRoundTrip` waited for `onMessageComplete`, which never fires
for a 101 (no body framing) → hang. Added 101-at-headers resolution
next to the CONNECT branch, gated on the request carrying an Upgrade
header: resolves with `isUpgrade: true` + `upgradeHead` from
`parser.takeRemainder()`.

Two subtleties found by probing:

- **Split-write remainder loss.** The server writes headers and
  post-header bytes as separate chunks. Settling detaches the round
  trip's `data` listener mid-flow, but the shim's flow loop only checks
  the flowing flag (never cleared by `removeListener`), so it kept
  running and emitted the next buffered chunk to zero listeners — the
  "nurtzo" byte loss (proven: chunk buffered, then `READ-EMIT` to zero
  listeners, `readableLength` 0 at upgrade). Fix, scoped to the 101
  path only: `sock.pause()` before settling (stops the loop, bytes stay
  buffered), and the caller `resume()`s after `'upgrade'` is emitted
  when the app attached a `data` listener (without one, bytes stay
  buffered for a later read/resume, as on a paused Node stream).
- **Request completion at upgrade.** The request must be destroyed
  (emitting `'close'`) once upgraded, without touching the handed-off
  socket — upgrade-agent's `'close'` handler is what ends the socket,
  not the other way round. `ClientRequest.destroy()` would destroy the
  socket, so the branch goes through `Writable.prototype.destroy` with
  the `_keepAliveSocket` preservation flag that
  `OutgoingMessage._destroy` honors.

### 3. Server upgrade sockets not detached (server, server2, advertise, reconsume)

The upgrade branch emitted `'upgrade'` with all five HTTP listeners
still attached and `socket.parser` still the facade. Now mirrors the
CONNECT branch: the five named handlers are removed by stored reference
(app listeners survive), the close handler is stashed as
`socket._onHttpSocketClose` (so `Socket._destroy` still runs connection
tracking / checker-stop / facade-free / parser-callback release), and
`socket.parser` is set to `null` before emit (probed shape).

### 4. No-listener fallback + `shouldUpgradeCallback` missing (server, server-callback)

The branch emitted `'upgrade'` unconditionally. Now:

- Callback present: false → normal `'request'` dispatch; true + no
  `'upgrade'` listener → `socket.destroy()`; throw → async rethrow
  (below).
- No callback: listener present → `'upgrade'`; no listener → `'request'`
  dispatch (this is what advertise's final "regular" case needs, after
  the destroy case removes all `'upgrade'` listeners).

The callback throw is rethrown via `queueMicrotask` because on the
virtual path the throw travels back through the client's write stack,
whose `try/catch` would swallow it into a silent hang (the raw path has
no such catch, which is why server2 already surfaced). The socket is
destroyed so a surviving process doesn't stall.

### 5. Handler throws swallowed by the parser (server2)

`parser.execute()` caught every owner-callback throw and routed it to
`onError` → 400 + destroy, so a throwing upgrade handler silently hung
instead of surfacing. Now only `HPE_`-coded failures take the `onError`
path; anything else is rethrown. The two pipelined-path catches
(`validatePipelinedRemainder`, busy-path `onHttpData`) got the same
non-`HPE_` rethrow treatment so the rule is uniform.

### 6. `Server.call(this)` never initialized `this` (server)

`Server` returned `Reflect.construct(ServerBase, …)` — a NEW object
that `.call()` discards. The classic subclassing pattern
(`testServer` + `setPrototypeOf` chains) therefore crashed at
`this._connections.add(socket)`. The wrapper now detects the
`.call(this)` shape (`new.target === undefined && this instanceof
Server`), constructs a throwaway instance, and transplants its own
properties (string + symbol keys, descriptors intact — EventEmitter
state is plain own properties) onto `this`, which keeps its own
prototype chain. (Node returns `undefined` here; returning `this` is
harmless and more useful, and no official test distinguishes.)

### 7. Close-before-headers error code (server-callback true-without-handler)

A socket destroyed before any response arrived surfaced as
`ERR_SOCKET_CLOSED`; real Node reports `ECONNRESET` ("socket hang
up"). `_socketHttpRoundTrip`'s close handler now maps the
no-headers-yet case to `ECONNRESET`; headers-received-but-truncated
stays `ERR_SOCKET_CLOSED`.

## Remaining gaps (diagnosed, deliberately NOT fixed in this lane)

### A. upgrade-client2 — GET `write()` buffering (write path, out of area)

The test does `http.request` (GET) + `request.write("head")` with no
`end()`. On the shim, GET writes are deliberately left buffered (PR
#257: "GET write() deliberately left buffered"), so the request bytes
never leave and the server never sees the upgrade. Proven with a
replica: `write` returns, server receives nothing. Flushing GET writes
is ClientRequest write-path surgery — explicitly out of this lane's
area, and the #257 lane left it buffered deliberately. Follow-up lane:
GET-write flushing semantics.

### B. upgrade-server — synchronous loopback delivery race (global timing, out of scope)

With the crash fixed, the with-listener phase fails on a re-entrancy
race, not on listener state: the test's upgrade handler writes the 101
and THEN assigns `request_upgradeHead`, but the client's data handler
runs synchronously inside the server's `socket.write` (loopback
delivery is synchronous; real TCP is async), so it asserts the global
before the assignment executes. Proven: a race-free replica (capture
before write) passes the FULL official flow — with-listener echo +
kill, no-listener 200 fallback, standard http, exit counts 3/3. Fixing
the official shape requires deferring loopback data delivery — a global
timing change with unknowable blast radius, out of this lane's scope.

### C. upgrade-server-callback — `instanceof Buffer` vs the pure-JS Buffer (design gap)

All four callback cases are proven working in replica (true, false,
true-without-handler ECONNRESET, callback-throw uncaught). The official
test additionally asserts `upgradeHead instanceof Buffer` twice, where
`Buffer` is the test's native global. The shim's Buffer is deliberately
a pure-JS class (`src/buffer.js`: "always the pure-JS implementation …
so the parity tests exercise this code, not the native builtin"), so a
shim-produced head can never pass a native `instanceof` check — and it
is the ONLY http test asserting it (grep over `test-http*.js`). Flipping
it needs a project-level call on Buffer identity (e.g. native heads
under Node), not a smuggled exception in this lane. Reported, not
implemented.

Also noted, same class as §4 but untested by any official test:
a `'request'`/`'upgrade'` handler that throws on the VIRTUAL path is
still swallowed by the round trip writer's catch (the raw path
surfaces it). The callback got the async-rethrow treatment because its
test covers it; generalizing that to all handler emits is follow-up
work, not done here.

## Files changed

- `src/http.js` — server detach + fallback + `shouldUpgradeCallback` +
  `Server.call` transplant + round-trip 101 + pause/resume + client
  upgrade branch + loopback routing + `ECONNRESET` mapping +
  `_isLoopbackTarget`/`_parseTarget` + pipelined rethrow catches.
- `src/_http_parser.js` — `execute()` rethrows non-`HPE_` owner throws.
- `NOTES-http-upgrade-detach.md` (this file).

## Guards

Re-run after rebase onto `8ed6e8de` (#282): all 7 flipped upgrade tests
exit 0; the #275 CONNECT family (connect, agent-remove,
unconsume-consume, connect-req-res) and the #254 timeout flips were
re-run as guards; full 397-test differential sweep branch-vs-base and
the repo jest suite + ondemand suite were run before shipping (see PR).
