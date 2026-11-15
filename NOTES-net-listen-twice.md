# NOTES — net lane N2-14: cluster-worker listen-twice (test-net-listen-twice)

## Target

`test-net-listen-twice.js` — was 124 (hang) under the shim, 0 under real Node.
Flipped: **2** (listen-twice + server-close-before-ipc-response, see below).
Net 127/156 → **129/156**.

## Mechanism (triage-era, confirmed on current main)

The test forks a cluster worker. The worker calls `server.listen()` twice
(no args, port 0). Under real Node a worker's handle acquisition is async
(`listenInCluster`, lib/net.js:2423): the 1st `listen()` issues a `queryServer`
round-trip to the primary and returns with no handle yet, so the sync guard
(`if (this._handle) throw ERR_SERVER_ALREADY_LISTEN`) does not fire on the
2nd `listen()`; the 2nd query bumps `_listeningId` and the 1st reply's
callback sees the stale id, closes its handle, and returns. The worker then
counts `NODE_CLUSTER` acks from the primary; at 2 it closes the server and
disconnects, and `server.on('listening', common.mustCall())` must fire
exactly once.

Under the shim the 2nd `listen()` threw `ERR_SERVER_ALREADY_LISTEN`
synchronously (the `_listening || _bindPending` guard, set by the 1st
listen), the test's `try/catch` swallowed it and returned before registering
the `internalMessage` handler, so `close()`/`disconnect()` never ran and
the worker hung on the leaked 1h `_keepLoopAlive` interval + IPC channel.

## Fix (src/net.js only)

Cluster-worker-aware `listen()`: when the process is a real cluster worker
(`cluster.isWorker && typeof cluster._getServer === 'function'`), the TCP
branch defers the local bind to the primary-query callback instead of
setting `_bindPending` synchronously:

- `Server.prototype._listenClusterWorker(port, host, backlog)` (port of
  Node's `listenInCluster` + the worker path of `listen()`):
  - bumps `this._listeningId` (new ctor field, init 1 per lib/net.js:2192)
    per listen();
  - resolves the query address like Node's `lookupAndListen` (no host →
    address null / addressType 4; IP literal / loopback name → that address
    + family; a hostname needing DNS falls back to the existing local path,
    whose `_bindTCP` reports ENOTFOUND async);
  - issues one `cluster._getServer(this, serverQuery, cb)` per listen();
  - in the callback: stale `listeningId` → `handle.close()` and return
    (Node exact); `this._handle === null` (closed while the query was in
    flight) → close the handle and return, never resurrect; primary errno
    → async `'error'` via new `errBindErrno` (ExceptionWithHostPort shape,
    `errnoNameForUv` mapping, syscall `'bind'`); winning reply → sets
    `_bindPending`, runs the synchronous `_bindTCP` (N1-3 split), then
    nextTick `'listening'` guarded by `_listening` (or nextTick `'error'`
    on bind failure).
  - the 2nd listen's query is deduped by `_listeningId` exactly as in Node,
    so `'listening'` fires exactly once; a 3rd listen after acquisition
    throws `ERR_SERVER_ALREADY_LISTEN` via the unchanged sync guard.
- `Server.prototype.close` (the part that makes the close-before-ipc flip
  REAL — see Differential): Node's close starts with
  `this._listeningId++` (lib/net.js:2811), invalidating any in-flight
  query; without it a worker that closes right after `listen()` would
  still bind and emit `'listening'` when the reply arrived. Also nulls
  `_handle` for a worker-path listen in flight (never bound, so no
  registry/loop cleanup — keeps the N1-9 "nulled on close()" invariant).
- `import cluster from "node:cluster"` (static): dual resolution, same
  precedent as the existing static `node:fs` import — in the parity harness
  this is native cluster (preload does NOT redirect it); in the browser
  build esbuild externalizes `node:` builtins and the sandbox resolves
  `node:cluster` to `src/cluster.js`, whose honest stub always reports
  `isWorker === false` and has no `_getServer`, so the worker path never
  runs in a browser. `NODE_UNIQUE_ID` detection is dead (deleted at startup
  by `initializeClusterIPC`, pre_execution.js:611-615); the cluster module
  itself is the only worker signal.
- `isClusterWorker()` helper guards the path; `_createListenHandle()` is
  still called synchronously per listen() (N1-9 invariant: `server._handle`
  exists at `listen()` return).

## Verification

- Target isolated 2× on the branch worktree: exit 0, 0 (under heavy
  sibling-sweep load; first run 39 s, second run similar). Re-verified
  after the `close()` fix and the rebase onto `4ed5be71`: exit 0, empty
  stderr, 2×.
- Guard probe (zz-listen-twice-probe3.js, deleted after use):
  - non-worker double `listen()` still throws `ERR_SERVER_ALREADY_LISTEN`;
  - worker `address()` is null before listen and right after `listen()`,
    set after the primary reply binds;
  - worker 2nd `listen()` does not throw; 3rd `listen()` after acquisition
    throws `ERR_SERVER_ALREADY_LISTEN`; worker exits 0.
- Named guards (all exit 0, empty stderr, post-rebase + post-`close()`
  fix): server-listen-options, listen-error,
  better-error-messages-listen, socket-constructor (cluster fork),
  connect-immediate-destroy, listen-invalid-port, server-reset,
  server-listen-path, listen-fd0 (N2-27), server-close.
- Footprint test: `tests/ondemand-require.test.js` 29/29 passed on the
  rebased branch (incl. the allowlist test).
- Note on the sweep: the full differential ran on the pre-`close()`-fix
  commit (`e418c9ac`); the `close()` fix (3 lines + comment in
  `Server.prototype.close`, ctor init 0 → 1) only touches `_listeningId`,
  which nothing else reads, so the sweep differential stands and the fix
  itself was verified by the targeted re-runs above (both flipped tests
  2× clean + 10 guards + footprint 29/29).
- Differential: fast-sweep `--target net --force`, base CSV
  `net-n2-14-base-2026-11-15.csv` (scratch worktree at main `453d2976`,
  post-#413; 156 rows, pass 125, timeout 7, fail 24) vs branch CSV
  `net-n2-14-branch-2026-11-15.csv` (156 rows, pass 129, timeout 4,
  fail 23). Diff: **toward-pass 4, regressions 0, mode-changes 0.**
  Adjudicated isolated 2× on base AND branch:
  - `test-net-listen-twice.js` (124 → 0): the target, real flip.
  - `test-net-server-close-before-ipc-response.js` (124 → 0): **real
    second flip** — the test does `listen(0, mustNotCall()).close()` in a
    worker and exits only when its patched `process.send` sees an
    `act: 'close'` message. The comment in the test names the mechanism:
    "listenOnPrimaryHandle in net.js should call handle.close()". Under
    the old shim no query was ever issued, so no `close` message was ever
    sent and the worker hung. With this lane, `close()` bumps
    `_listeningId` (Node lib/net.js:2811) and the callback's stale-id arm
    calls `handle.close()` on the native faux handle — which sends
    `{ act: 'close', key }` (child.js:151/201) — the patched send
    intercepts it and disconnects → exit 0, clean stderr.
    **False-pass catch (2026-11-15, post-rebase verification):** the first
    version of this lane (without the `close()` `_listeningId++`) ALSO
    recorded exit 0 for this test — but the worker was actually CRASHING
    on the `mustNotCall` listen callback ('listening' fired after close)
    while the primary still exited 0, so the harness saw a pass. Caught
    by reading stderr, not the exit code: the worker's AssertionError
    stack was in stderr. Lesson for cluster tests: exit 0 is the
    PRIMARY's code — always check the worker's stderr too. After the
    `close()` fix both tests pass with empty stderr, 2× each.
    This moves one test off the triage NO-FIX list (lane-11 family); the
    remaining lane-11 tests still need real cross-process reachability.
  - `test-net-listen-handle-in-cluster-2.js` (124 → 0 in sweep): load
    flake, NOT a flip — passes isolated 2× on base (0, 0) and branch
    (0, 0); the base sweep ran under much heavier load (147 files hit
    the 10s cap vs 18 on branch).
  - `test-net-server-listen-path.js` (1 → 0 in sweep): load flake, NOT a
    flip — passes isolated 2× on base (0, 0) and branch (0, 0).

## Known limits / interactions

- The primary-error shape (`errBindErrno`) is unprobed — no vendored test
  exercises a primary bind failure; it mirrors Node's
  `ExceptionWithHostPort(errno, 'bind', address, port)` by construction.
- `flags` in the query is 0 (Node's `getFlags` value for plain options);
  `ipv6Only`/`reusePort` are not plumbed by the shim's `_bindTCP`.
- The faux handle returned by native `_getServer` (RoundRobinHandle) is
  discarded after the stale/closed checks; the shim's virtual handle is
  the one that serves connections. The faux handle's `ref()` interval is
  closed by the native side when the worker disconnects (verified: the
  worker exits 0 in the target test).
- Interaction watch: `test-net-listen-exclusive-random-ports` (N2-19) also
  forks workers that listen — it must re-verify after this lane lands (or
  vice versa on rebase). Other cluster-using net tests remain NO-FIX
  (child-process-connect-reset, listen-handle-in-cluster-1/2,
  server-listen-handle) or unaffected (socket-constructor guard passes).
  `server-close-before-ipc-response` flipped as a side effect of this
  lane (see Differential) — one lane-11-family test down.
- No docs-number changes in this PR (batched syncs are separate).
