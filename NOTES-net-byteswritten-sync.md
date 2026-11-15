# NOTES: net bytesWritten sync accounting (lane N1-1)

Branch: `fix/net-byteswritten-sync`. Base: main `3199bb5d` (recorded net 87/156).
Targets (all `PARITY_TARGET=net`): `test-net-access-byteswritten`,
`test-net-bytes-stats`, `test-net-socket-byteswritten`,
`test-net-bytes-written-large`, `test-net-connect-buffer`,
`test-net-connect-buffer2`. Claimed flips: 6 (1 → 0 each, isolated 2×).

## Mechanism (triage lane 1, parent-verified)

The `bytesWritten` getter (`src/net.js`, `Socket.prototype`) counted only
delivered `_bytesWritten`. Three gaps, all in the getter's orbit:

1. Writes still queued read 0. While connecting, `_write`/`_writev` push
   into `_pendingWrites`; while corked, writes sit in the Writable buffer
   (`writableBuffer`). Real Node's getter (`node-src/lib/net.js:1279-1312`)
   sums dispatched bytes + `writableBuffer` entries + the in-flight
   connecting write (`_pendingData`). The shim summed none of the queued
   bytes: `socket-byteswritten` 0 !== 7, `bytes-written-large` (corked
   writev leg) 0 !== 10^7, `connect-buffer(2)` 0 !== 15.
2. Unconstructed prototype reads NaN. `Socket.prototype.bytesWritten`
   evaluated `undefined + 0`; Node returns `undefined` when there is no
   writable state (`lib/net.js:1280`, `if (!writableBuffer) return
   undefined`). `access-byteswritten` NaN !== undefined.
3. Reconnect never resets the counters. Node gets a fresh handle per
   connect; the shim's `connect()` reset only `_pendingWrites`/`_finSent`,
   so a reconnected socket's `bytesWritten` accumulated across connections
   (`bytes-stats` 18 !== 12).

## Fix (`src/net.js` only)

- Getter: `if (!writableBuffer) return undefined` guard (the shim's
  `writableBuffer` getter returns falsy exactly when `_writableState` is
  absent, so the guard fires only on unconstructed prototypes), then sums
  `_bytesWritten` + the existing `_httpState` framed-pending term +
  `writableBuffer` entries + `_pendingWrites` entries, each with the
  Node byte-length rule (Buffer → `.length`, else `Buffer.byteLength`
  with the entry encoding). A chunk lives in exactly one of the three
  buckets at a time, so the sum never double-counts.
- `connect()`: reset `this._bytesWritten = 0; this._bytesRead = 0;`
  alongside the existing `_pendingWrites`/`_finSent` reset.
- `_flushPendingWrites`: drain one item at a time (`shift()` from the
  live queue) instead of detaching the whole array first. A write
  callback fired mid-flush must still see the not-yet-flushed bytes in
  `bytesWritten` (Node counts them via `writableBuffer` while the first
  write's callback runs — `connect-buffer` asserts a+b in that callback).
  Same loop body otherwise; items can only join `_pendingWrites` while
  connecting, and `connecting` is false by flush time, so the loop cannot
  grow.
- `emitClientConnect`: flush pre-connect writes AFTER `emit("connect")`
  + `emit("ready")`, not before. Node's `afterConnect`
  (`lib/net.js:2002-2003`) emits both, and the connecting write is
  re-issued by a `once('connect')` listener with its callback firing
  only once the write completes — the old flush-before-emit order fired
  write callbacks with `connected` still false
  (`connect-buffer:64`, `assert.ok(connected)`). The flush stays before
  the `read(0)` that follows, preserving the previous flush/read order.

## Differential

- Base: `hidden_files/fast-sweep/net-sweep-2026-11-14.csv` (triage sweep,
  same base commit; 87 pass / 65 fail / 4 timeout / 1 crash-134 / 1 exit-137).
- Branch: `hidden_files/fast-sweep/net-n1-byteswritten-branch-2026-11-14.csv`
  (fast-sweep `--target net --force`, `--base` the triage CSV).
- Matched changed-value lines (sorted, deduped — branch vs triage base CSV,
  156 rows each):
  - `test-net-access-byteswritten.js: 1 → 0`
  - `test-net-bytes-stats.js: 1 → 0`
  - `test-net-bytes-written-large.js: 1 → 0`
  - `test-net-connect-buffer.js: 1 → 0`
  - `test-net-connect-buffer2.js: 1 → 0`
  - `test-net-socket-byteswritten.js: 1 → 0`
  - `test-net-listen-exclusive-random-ports.js: 1 → 124` (adjudicated flake,
    see below)
  - `test-net-listen-handle-in-cluster-2.js: 0 → 124` (adjudicated flake,
    see below)
  - `test-net-throttle.js: 134 → 124` (same known pre-existing spin)
  - `test-net-write-fully-async-buffer.js: 137 → 124` (same known
    pre-existing spin)
  Branch totals: 92 pass / 56 fail / 8 timeout (base 87 / 65 / 4 + 134 + 137).
  Sweep ran under extreme contention (8 sibling net sweeps at once; 116/156
  files hit the 10s phase-1 cap), which explains the timeout noise.
- Adjudication (isolated re-runs): `listen-handle-in-cluster-2` 124 3× on
  branch AND 124 2× on base (triage worktree, same commit) — load flake,
  not a regression (base sweep recorded 0 under lighter load).
  `listen-exclusive-random-ports` 124 3× branch, 124 2× base — same verdict
  (lane-19 probabilistic target). `throttle` / `write-fully-async-buffer`
  are the known pre-existing spinners (124/134/137 are the same spin under
  different load).
- Isolated re-runs (branch, 2× each, all 0): access-byteswritten,
  bytes-stats, socket-byteswritten, bytes-written-large, connect-buffer,
  connect-buffer2. Base isolated exits were all 1 (verified before the fix).

## Guards re-run

All 0 on the branch (isolated, `PARITY_TARGET` as noted):
- net: after-close, allow-half-open, bytes-read, connect-keepalive,
  server-close, connect-call-socket-connect, connect-destroy,
  connect-immediate-finish, connect-no-arg, connect-nodelay,
  connect-paused-connection.
- http: outgoing-destroyed (peer-dies-mid-flush path), client-abort,
  upgrade-client, upgrade-client2, agent-keepalive, client-timeout,
  keep-alive, byteswritten (0 at 60s; 124 at 30s on BOTH base and branch —
  load slowness, verified on the triage base worktree).
- Non-results: `test-net-connect.js`, `test-net-connect-timeout.js`,
  `test-net-create-connection.js` do not exist (filename trap — the 1s in
  the first guard run were ERR_MODULE_NOT_FOUND, replaced by the real
  connect-* names above).

## Out of scope / notes

- `bytesRead` getter has no unconstructed-prototype guard (reads
  `undefined` on the prototype); no test asserts it — left alone.
- `TLSSocket`/`tty` assertions in `access-byteswritten` already passed:
  `TLSSocket` is a separate EventEmitter class with an instance
  `bytesWritten = 0` field (no inherited net getter), tty streams extend
  `Readable`/`Writable` directly.
