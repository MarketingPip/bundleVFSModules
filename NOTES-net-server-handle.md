# Net lane N1-9 — fake server._handle (2 flips)

Base: main `3199bb5d`. Branch: `fix/net-server-handle`.
Targets: `test-net-server-keepalive`, `test-net-server-nodelay` (both 1 -> 0).

## Mechanism (triage lane 9)

Both tests wrap `server._handle.onconnection` right after `listen(0)` and die
on `undefined` — Server never created `_handle` (Node: `setupListenHandle`
sets `this._handle.onconnection`, node-src `lib/net.js:2315`).

## Fix (src/net.js only)

- `Server._handle`: `null` in the ctor (Node shape); `listen()` creates the
  fake handle synchronously via `_createListenHandle()` — `{ onconnection }`
  closing over the server — in all three success branches (TCP, pipe,
  BoundSocket-adopted), so it exists at `listen()` return, before the
  deferred bind runs. Nulled again on `close()` and on bind failure
  (`_doListenTCP`/`_doListenPipe` error paths), matching Node's
  `setupListenHandle`/`close()` lifecycle; a re-`listen()` then builds a
  fresh handle instead of reusing a stale wrapped one.
- `Server._onconnection(err, clientHandle)`: port of Node's `onconnection`
  (`lib/net.js:2691`). Applies the server's socket options to the accepted
  handle — `setNoDelay(true)` / `setKeepAlive(true, keepAliveInitialDelay)`
  with the delay in SECONDS (server property is already seconds) — counts
  the connection and emits `'connection'`. The server-side Socket is the
  accepted handle's `_socket` link (`VirtualHandle._socket`, set in
  `_acceptConnection`).
- `_acceptConnection`: no longer applies options via the Socket setters
  before the handle exists (that never reached a handle). It builds the
  server-side Socket, creates its `VirtualHandle` BEFORE `emit('connection')`
  (previously `:2942`, after), links `handle._socket`, and routes the accept
  through `this._handle.onconnection(null, serverSocket._handle)` — so a
  test wrapping `onconnection` sees the accepted handle first, as on real
  Node. The client-connect tail (`emitClientConnect`) is unchanged and still
  runs after.
- `Socket.setNoDelay`: port of Node's dedupe (`lib/net.js:826`, init false
  at `:687` / shim `:1030`) — the handle is only told when the value changes
  vs the cached `_noDelay`. This is what makes server-nodelay pass: the
  server applied `noDelay` at accept, so the later `setNoDelay(true)` with
  a `mustNotCall` handle is suppressed.
- `Socket.setKeepAlive`: port of Node's conversion + change detection
  (`lib/net.js:844-882`, positional form only). The handle takes SECONDS
  (`~~(ms/1000)`); the JS API takes milliseconds. The handle is only told
  when `(enable, delay-seconds)` changes vs the cache. This is what makes
  server-keepalive pass: the server applied 1s at accept, so the later
  `setKeepAlive(true, 1000)` is suppressed and only the 2000/3000 calls
  reach the handle as 2/3. `_keepAliveInitialDelay` stays milliseconds
  (shim convention; `connect()` and the client connect tail divide by 1000
  at the handle), so the dedupe compares converted seconds against the
  cached milliseconds divided back down.
  - ponytail: the object form and `interval`/`count` forwarding are NOT
    ported here — that is lane 12 (socket-option methods). This lane keeps
    the two-argument call shape. Consequence: `test-net-keepalive-interval-count`
    still fails, but its first failing assertion moved from `delay`
    (5000 !== 5) to `interval` (undefined !== 10) — lane 12 closes it.

## Verification

- Targets isolated, branch worktree, 2x each: both exit 0 (base: exit 1,
  `TypeError: Cannot read properties of undefined (reading 'onconnection')`).
- Differential: fast-sweep `--target net --force`, fresh file
  `hidden_files/fast-sweep/net-n1-server-handle-branch-2026-11-14.csv`
  (branch worktree, `--jobs 4`, `--base net-sweep-2026-11-14.csv` — the
  triage base sweep on the same base commit `3199bb5d`; a fresh base sweep
  was started but killed at ~15 min, still in phase 2, under contention
  from ~14 concurrent lane sweeps — the same-commit triage CSV is the
  base of record). Runner diff + independent positional re-parse agree:
  toward-pass exactly the 2 targets, regressions 0, mode-changes 2
  (`test-net-throttle.js` 134 -> 124, `test-net-write-fully-async-buffer.js`
  137 -> 124 — both are the known pre-existing spins, same spin under
  different load per triage §1; both fail on base and branch).
  Branch totals: 89 pass / 6 timeout / 61 fail (base 87 / 4 / 65).
- Guards re-run (all exit 0 unless noted): `test-net-keepalive`,
  `test-net-persistent-keepalive`, `test-net-after-close`,
  `test-net-pingpong`, `test-net-write-slow`, `test-net-server-close`,
  `test-net-server-max-connections`, `test-net-server-drop-connections`,
  `test-http-server`, `test-http-keep-alive`, `test-http-upgrade-server`,
  `test-https-simple`; repo suite `tests/net.test.js` 78/78 pass.
  `test-net-stream` still exits 1 — pre-existing lane-25 failure, same
  assertion as base (server `'error'` mustCall 0/1); the stack only routes
  through the new `_onconnection` because that is where `'connection'` is
  now emitted.
- Lane 16 (`test-net-socket-setnodelay`) still fails the same way as base
  (plain-object handle not adopted); it reuses this lane's `setNoDelay`
  dedupe when it lands.

## Differential (base -> branch)

- `test-net-server-keepalive.js,1 -> 0`
- `test-net-server-nodelay.js,1 -> 0`

No other changed-value lines.

## Ship

- PR: #406 (`fix/net-server-handle`, created on head `d38c65dd`, 1 commit).
  Merge SHA: BLOCKED — see below.
- Rebase: main moved under the lane (#399 `4b956bc6` state-getters,
  #402 `35bf2d43` fd-adoption). Rebases cleanly onto `35bf2d43` as
  `b37bed8e` (allowlist-only conflict, resolved to this branch's own
  footprint). Re-verified on the rebased tree: targets 0/0, guards 0
  (`test-net-keepalive`, `test-net-persistent-keepalive`,
  `test-net-connect-keepalive`, `test-net-connect-nodelay`),
  `tests/net.test.js` + `tests/ondemand-require.test.js` 107/107,
  `test-net-socket-setnodelay` still 1 (lane 16, unchanged).
- BLOCKER (2026-11-14 ~19:00 EST): the force-push of the rebased commit
  failed 6 consecutive times on transient GitHub transport/API errors —
  `git/blobs` POST disconnects + 404s, `git/commits` GET disconnects x3
  ("Parent 35bf2d43 not on GitHub" / "Cannot read parent commit" —
  the parent IS on GitHub, the GETs just die). Credential is alive
  (`GET /user` = MarketingPip; a probe blob POST succeeded once).
  `git ls-remote` itself then failed with `HTTP/2 stream 1 was not
  closed cleanly: CANCEL (err 8)` — the VM's GitHub egress is in a bad
  spell, not the lane. Remote ref verified still at `d38c65dd`.
- RESUME (parent): when egress recovers, from this worktree:
  `git-push-api.py ~/workspace/worktrees/net-n1-server-handle fix/net-server-handle --force`
  (verify via `git ls-remote` — expect the local HEAD, see `git log -1`), then relaunch
  the CI waiter `hidden_files/pr406-ci-wait.py` with SHA updated to the
  new head, then squash-merge #406 on green Parity + build and confirm
  `merged: true` by direct read before deleting the branch ref.
  CI never started on the old head (0 check runs in 7 polls before a
  runtime restart killed the first waiter; the rebase also serves as the
  no-show unstick).

- Parent rebase onto main `32c4d5c6` (#404) 2026-11-14: setKeepAlive conflict
  resolved to #404's verbatim port (supersedes this lane's positional-only
  version); `_onconnection` slot assignment corrected to the seconds
  convention (`serverSocket._keepAliveInitialDelay =
  this.keepAliveInitialDelay`, no `* 1000` — Server stores seconds, #404
  stores seconds in the socket slot; the `* 1000` form belonged to the old
  milliseconds slot convention and would have broken the accept-time
  dedupe). Targets + guards re-verified on the rebased tree before push.

- Parent rebase onto main `eddf42e6` (#401) 2026-11-14: _acceptConnection
  conflict resolved to the lane's side — routing through
  `this._handle.onconnection` subsumes #401's `_connections++` + handle
  creation + `emit("connection")` (all performed inside `_onconnection`,
  exactly once). Targets + server-reset guard re-verified on the rebased
  tree before push.
