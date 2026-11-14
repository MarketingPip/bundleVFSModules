# NOTES — net pre-connect destroy/abort (lane N1-5)

Base: main `3199bb5d`. Recorded net 87/156; triage ceiling 141/156.
Targets (all `PARITY_TARGET=net`): `test-net-connect-abort-controller`,
`test-net-connect-reset`, `test-net-write-cb-on-destroy-before-connect`.

## Fixes (all in `src/net.js`)

1. **Double abort-listener registration — connect-abort-controller 1 → 0.**
   `net.connect(options)` builds the socket via `new Socket(options)`, and the
   `Duplex` ctor already attaches the abort listener (`src/stream/duplex.js:122`
   → `abort-listener-attach.js`, mirroring Node `lib/internal/streams/duplex.js:124`
   + `lib/net.js:717`). `Socket.prototype.connect` added a second one, so
   `listenerCount(signal, 'abort')` read 2 instead of 1. Fix: delete
   `connect()`'s own `signal.addEventListener("abort", …)` registration.
   The validation and the already-aborted branch stay: the ctor's listener
   destroys with an `AbortError` when the signal is already aborted, and
   `connect()` must still schedule `destroy(signal.reason)` instead of
   resurrecting the socket into a real connection (the pre-aborted sub-case).

2. **resetAndDestroy with no handle — connect-reset 1 → 0.**
   `resetAndDestroy` fell through to `destroy(err)` with `err === undefined`,
   so no `error` event fired. Node `lib/net.js:1029`: no `_handle` →
   `destroy(new ERR_SOCKET_CLOSED())`. Fix: guard at the top of
   `resetAndDestroy` + new `errSocketClosed()` helper (Node
   `lib/internal/errors.js:1795`: `'Socket is closed'`). New
   `errSocketClosedBeforeConnection()` helper alongside it (1796:
   `'Socket closed before the connection was established'`).

3. **Connecting-write close listener — write-cb-on-destroy-before-connect 1 → 0.**
   The connecting branches of `_write`/`_writev` buffered into `_pendingWrites`
   with no close listener; `_destroy` cleared them silently, so the write
   callback never fired. Node `lib/net.js:1228-1239` (`_writeGeneric`):
   a connecting write registers `once('close', onClose)` → cb with
   `ERR_SOCKET_CLOSED_BEFORE_CONNECTION`. Fix: same registration in both
   connecting branches (stashing `onClose` on the pending item);
   `_flushPendingWrites` removes the listener per item before delivering,
   mirroring Node's `off('close', onClose)` in its connect handler — without
   that, a later close would invoke the callback a second time. The `_writev`
   branch gets the same treatment (Node routes it through the same
   `_writeGeneric`).

4. **Server-socket handle ordering (regression found by guard, fixed in-lane).**
   `test-net-server-reset` (passes on base) regressed: its connection handler
   calls `resetAndDestroy()` synchronously, and `_acceptConnection` assigned
   the server socket's `VirtualHandle` only *after* `emit("connection")`, so
   the new no-handle guard fired `ERR_SOCKET_CLOSED` as an unhandled `error`.
   Node creates the TCPWrap on accept, before the connection handler runs.
   Fix: move the handle assignment to just before `emit("connection")` in
   `_acceptConnection`.

## Differential

- Base CSV: `hidden_files/fast-sweep/net-n1-base-2026-11-14.csv`
  (fresh full sweep on scratch worktree at `3199bb5d`: 156 rows,
  86 pass / 8 timeout / 62 fail — vs triage 87/4/65; the 4-row delta is
  load noise only: `listen-handle-in-cluster-2` 0 → 124,
  `listen-exclusive-random-ports` 1 → 124, `throttle` 134 → 124,
  `write-fully-async-buffer` 137 → 124).
- Branch CSV: `hidden_files/fast-sweep/net-n1-branch-2026-11-14.csv`
  (full sweep on this branch).
- Matched changed-value lines (sorted, deduped): TBD after branch sweep.
- Claimed flips (each re-run isolated 2× on the branch, all 0):
  - `test-net-connect-abort-controller.js`: 1 → 0
  - `test-net-connect-reset.js`: 1 → 0
  - `test-net-write-cb-on-destroy-before-connect.js`: 1 → 0

## Guards re-run (all 0 on the branch unless noted)

Net (passing on base, touching destroy/reset/connect/write):
`connect-after-destroy`, `connect-destroy`, `connect-reset-after-destroy`,
`connect-reset-until-connected`, `end-destroyed`, `socket-destroy-send`,
`socket-reset-send`, `server-reset` (regressed by the first form of fix 2,
fixed by fix 4), `connect-call-socket-connect`, `connect-immediate-finish`,
`reconnect`, `socket-end-before-connect`, `write-connect-write`,
`pause-resume-connecting`, `socket-write-error`, `write-after-end-nt`,
`can-reset-timeout`, `settimeout`, `socket-timeout`.
HTTP (consumers of `resetAndDestroy` / `_pendingWrites`):
`outgoing-destroyed`, `conn-reset`, `destroyed-socket-write2`,
`multi-line-headers`, `upgrade-server-callback`,
`server-keep-alive-defaults`.
NOT guards (fail on base for other lanes' reasons, not regressions):
`connect-buffer`, `connect-buffer2`, `socket-byteswritten` (lane 1),
`connect-immediate-destroy`, `connect-reset-before-connected`,
`socket-destroy-twice`, `socket-reset-twice`, `socket-timeout-unref`
(lane 3), `socket-connecting` (lane 10), `socket-tos` (lane 12).

## Ship

- Branch: `fix/net-preconnect-destroy`. PR: TBD. Merge SHA: TBD.
