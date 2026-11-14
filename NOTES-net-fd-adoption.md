# NOTES — net fd adoption / validation (lane N1-11)

Branch: `fix/net-fd-adoption`. Base: main `3199bb5d`. Targets (PARITY_TARGET=net):
`test-net-connect-options-fd`, `test-net-socket-constructor`. Both were exit 1
on base; both exit 0 on the branch (isolated 2x each).

## Mechanism (triage lane 11, confirmed against the Node source oracle)

- Node `lib/net.js:596`: legacy interface — a bare number options arg is
  `{ fd: options }`.
- Node `lib/net.js:636-644`: `options.fd !== undefined` → `createHandle(fd,
  false)`, which does `validateInt32(fd, 'fd', 0)` (`:195-196`) then
  `handle.open(fd)`. So `new net.Socket({ fd: -1 })` throws
  `ERR_OUT_OF_RANGE` and `new net.Socket({ fd: 'foo' })` throws
  `ERR_INVALID_ARG_TYPE`.
- The shim `Socket` ctor (`src/net.js`) ignored `options.fd` entirely (only
  `BoundSocket` handles were adopted) and threw `ERR_INVALID_ARG_TYPE` for
  any non-object options — so `new net.Socket(4)` (worker branch of
  socket-constructor) also could not work. `VirtualHandle` had no `fd`, so
  `connect-options-fd` failed `22 !== undefined` on `this._handle.fd`
  (connect + pipe data flow already worked).

## Fix (src/net.js only)

1. `Socket` ctor: `typeof options === "number"` → `{ fd: options }`
   (Node `lib/net.js:596`), before the non-object throw.
2. After the `BoundSocket` adoption block: if `options.fd !== undefined`
   and no handle was adopted, `validateInt32(options.fd, "fd", 0)` (the
   shim's own validator, same error codes) and adopt
   `this._handle = new VirtualHandle()` with `this._handle.fd = options.fd`.
   `connect()` only creates a handle when none exists, and `_doConnect`
   reuses `this._handle` (VirtualHandle has no `connect`, so the virtual
   pipe/TCP lookup still runs) — the adopted handle survives connect, which
   is what `connect-options-fd` asserts.

## Ceiling

No OS fd-type verification is possible in-browser: Node's `guessHandleType`
needs fstat, so `ERR_INVALID_FD_TYPE` for a non-pipe/non-TCP fd cannot be
emulated. No vendored test asserts it.

## Differential

- Base: triage sweep `hidden_files/fast-sweep/net-sweep-2026-11-14.csv`
  (main `3199bb5d`, 87 pass / 65 fail / 4 timeout / 1×134 / 1×137).
  (A fresh base sweep started pre-fix was contaminated: the fix landed
  mid-sweep, so its socket-constructor row reads 0; it is not used as the
  base. File: `hidden_files/fast-sweep/net-n1-fd-base-2026-11-14.csv`.)
- Branch: `hidden_files/fast-sweep/net-n1-fd-branch-2026-11-14.csv`
  (see below).
- Claimed flips (2): `test-net-connect-options-fd.js` 1 → 0,
  `test-net-socket-constructor.js` 1 → 0. Both re-run isolated 2x on the
  branch, exit 0 each time.
- Branch sweep rows for socket-constructor (124) and
  listen-handle-in-cluster-2 (0 → 124) are LOAD NOISE, adjudicated, not
  regressions: (a) a zz probe (since deleted) creating `new net.Socket(4)`,
  `{fd:5}`, `{fd:6}` + unref exits 0 — fd-adopted never-connected sockets
  cannot arm the loop keeper (`_needsLoopKeeper` returns false when
  `!_connected && !connecting`); (b) a trivial shim load takes 5s wall /
  the zz probe 14s wall under the current 7-lane parallel-sweep contention
  (0.25s user time — pure scheduling wait), so 10s/30s caps are blown by
  starvation alone; (c) listen-handle-in-cluster-2 times out 124 2x on a
  PRISTINE base worktree too; (d) socket-constructor isolated on the branch
  is 5×0 / 3×124 across 8 runs, all 124s at peak contention. Throttle
  134→124 and write-fully-async-buffer 137→124 are the known spinner
  mode changes, pre-existing.

## Guards re-run (all exit 0 on the branch)

- `test-net-server-close`, `test-net-socket-timeout`
- zz-fd-loop probe (deleted after use): fd 4/5/6 adopted, process exits 0
