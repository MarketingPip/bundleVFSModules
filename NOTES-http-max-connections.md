# NOTES — maxConnections / dropMaxConnection enforcement

## Real-Node semantics probed (v24.22.1, before implementing)

- **Single-process server, `maxConnections = 0` (dropMaxConnection unset):**
  connection is dropped: server emits `'drop'` with
  `{localAddress, localPort, localFamily, remoteAddress, remotePort,
  remoteFamily}`, handler/`'connection'` never fire, client gets
  `ECONNRESET "socket hang up"` (synthesized by the http client on
  premature close).
- **`dropMaxConnection` default is `undefined`.** In single-process mode
  it changes nothing: `dropMaxConnection = false` still drops (probe D).
- **Cluster mode:** `dropMaxConnection = true` → the worker drops the
  connection and emits `'drop'` (exact test shape, probe B).
  `dropMaxConnection = false` or unset → the primary HOLDS the connection
  (queued, never distributed, never dropped); with `maxConnections = 0`
  it never frees, and the client only errors when the primary exits
  (probes C, E). So `dropMaxConnection` is a cluster-distribution knob
  only; the shim has no distributing primary, so single-process drop
  semantics apply to its virtual servers.
- **Raw net dropped connection (probe F):** server `'drop'` fires FIRST,
  then client `'connect'`, `'ready'`, `'end'`, `'close' (hadError false)`.
  NO client `'error'` — the server side is destroyed gracefully (FIN),
  not reset. This is why `test-net-server-max-connections` requires
  `'connect'` on rejected connections (chain continues) and
  `test-net-server-max-connections-close-makes-more-available` resolves
  rejected promises via `'end'` (its `ECONNRESET` error assertion has
  minimum 0 and never fires).
- **Cluster + harness mechanics (probed, not assumed):** the test files'
  `require('cluster')` resolves to REAL Node cluster even under the
  parity preload (a real child process runs the worker branch). Primary
  and worker deadlock on the open IPC channel unless the worker exits —
  which is exactly the target test's exit path (`'drop'` →
  `process.exit()`). The shim's `cluster.fork` stub never runs worker
  code; it is irrelevant to this test.

## Root cause

Two stacked gaps, one enforcement point:

1. `http.ServerBase` never defined `maxConnections` (plain assignment
   just set an inert property) and never forwarded it to its backing
   `net.Server`, so net's `_acceptConnection` check (`maxConnections !=
   null`) never saw it: over-limit connections were served normally
   (handler fired, 200 returned, no `'drop'`).
2. Even the net-level check was unreachable in effect: the old drop path
   refused the client BEFORE pairing (no `'connect'`, `ECONNREFUSED`
   instead of graceful EOF) and built drop data before the ephemeral
   port was allocated (`remotePort` undefined, failing
   `test-net-server-drop-connections`' truthy assertions).

## Fix

- `src/net.js` `_acceptConnection` drop path: allocate the ephemeral
  port first (fixes `remotePort`), emit `'drop'`, then pair the sockets
  like the accept path (sockname/peername, `connect` + `ready`,
  loop-keeper refresh) and destroy the server side gracefully — so the
  client sees `'end'` + `'close' (false)`. No `'connection'` event, no
  `_connections++`, no `_server` link (dropped sockets are never
  counted). The refused/blocked paths are untouched (still
  `ECONNREFUSED`, no pairing).
- `src/http.js` `ServerBase`: `maxConnections` accessor (stored value +
  forward to the backing net server when one exists, so assignment
  after `listen()` works like real Node's accept-time read), `listen()`
  applies the stored value to the fresh net server and forwards its
  `'drop'` event to the http server. `dropMaxConnection` needs no
  forwarding (single-process semantics drop regardless; no test
  exercises the cluster-queue shape in the shim).

## Results (PARITY_TARGET=http/net, timeout 30)

| Test | Before (base 301e6024) | After (branch) |
|---|---|---|
| test-http-server-drop-connections-in-cluster (target) | 124 | 0 (3/3) |
| test-net-server-drop-connections | 1 | 0 |
| test-net-server-max-connections | 124 | 0 |
| test-net-server-max-connections-close-makes-more-available | 1 | 0 |

Guards (37 tests: server, keep-alive, chunked, agent, blank-header,
pipelined, 1.0, #254 timeout flips, recent flips): all pass except 7
non-zero, ALL reproduced identically on pristine base 301e6024 AND on
pristine current main 94195b72 — zero regressions. The 7: agent (1),
agent-keepalive (1), server-close-idle-connections (1) (known
pre-existing), plus incoming-pipelined-socket-destroy (1),
keep-alive-close-on-header (1), server-request-timeout (1),
server-headers-timeout (1) — these four fail on base too (the first two
were in the inherited passing list, so the list was stale relative to
#267's merged main; not a regression of this change).
`tests/ondemand-require.test.js`: 29/29.

## Out of scope, deliberately

- Cluster-queue behavior for falsy `dropMaxConnection` (primary holds
  the connection): the shim has no distributing primary, and no test
  exercises it. If a future test does, it needs a queue in the accept
  path, not a drop.
- `test-http-server-stale-close` (cross-process reachability):
  architectural, ranked last, untouched.
