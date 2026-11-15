# Net lane N2-16+24 — generic handle adoption (socket-setnodelay, end-close)

## Targets (2 flips, 1 → 0, isolated 2x on branch)

- `test-net-socket-setnodelay` — `new net.Socket({handle:
  {setNoDelay: fn, readStart(){}}})` never called the mock (mustCall 1,
  actual 0).
- `test-net-end-close` — events `[]` vs `['end', 'close']`.

## Mechanism

Node's Socket ctor adopts any truthy `options.handle`
(lib/net.js:612-633: `this._handle = options.handle` for a non-BoundSocket
handle) and `initSocketHandle` wires `handle.onread = onStreamRead`
(:334-341). The shim's ctor adopted only `BoundSocket` instances, so
plain-object fakes were ignored: `_handle` stayed null, `setNoDelay()`
cached the value without ever calling the handle, and the fake's
`readStart` never ran.

## Fix (src/net.js + src/internals/stream-wrap-state.js + parity adapter)

- Ctor: adopt a plain-object `options.handle` as `_handle` and wire
  `handle.onread = () => onStreamReadFor(this)`. A live VirtualHandle is
  NOT adopted: test-net-socket-constructor passes the server socket's
  live VirtualHandle for readable/writable asserts only, and adopting it
  would alias a live handle.
- `_read`: call `handle.readStart()` when the handle has one and is not
  already reading (Node's tryReadStart, lib/net.js:997-1004); VirtualHandle
  has no `readStart`, so this is inert for virtual sockets. A read error
  destroys with the mapped errno (reuses `errnoNameForUv`).
- `onStreamReadFor(socket)`: port of lib/internal/stream_base_commons.js
  `onStreamRead` — nread comes from the shared stream_wrap state; UV_EOF
  → `socket._receiveEOF()` (push(null) + read(0), the existing EOF path);
  other negative errnos destroy with the mapped error.
- Shared state: `src/internals/stream-wrap-state.js` exports
  `streamBaseState`, `kReadBytesOrError`, `UV_EOF` (-4095, probed).
- Parity adapter `parity/internal-test-binding-adapter.mjs` + one preload
  redirect under PARITY_TARGET=net (internal-net-adapter / #232 shape):
  `require('internal/test/binding')` returns real Node's module, except
  `internalBinding('stream_wrap')` whose `streamBaseState` /
  `kReadBytesOrError` cells are the shim's shared state — the same object
  the test's fake readStart writes UV_EOF into and the shim's onStreamRead
  reads. The other five net tests requiring internal/test/binding
  (connect-options-fd, listen-handle-in-cluster-2, persistent-nodelay,
  persistent-ref-unref, server-listen-handle) use only tcp_wrap /
  pipe_wrap, which pass through untouched; all six run with
  --expose-internals.
- The setNoDelay change-only dedupe from lane N1-9 (PR #406) was already
  on main (`enable !== this._noDelay`, init false) — not duplicated here;
  adoption alone supplies the missing handle calls (truthy→falsey→truthy
  = exactly 3 calls, as the test expects).

## Ceiling

- A fake handle delivering real bytes would need the arrayBuffer argument
  Node's onStreamRead receives; `onStreamReadFor` returns early on
  nread > 0. No vendored test does that.
- `connect()` on an adopted generic handle is untested by these two
  targets and untouched (the virtual `_doConnect` path assumes a
  VirtualHandle).

## Guards (isolated, branch)

socket-constructor, boundsocket, connect-options-fd, server-listen-handle,
persistent-nodelay, persistent-ref-unref, server-nodelay, socket-tos,
keepalive-interval-count, connect-abort-controller, connect-reset,
server-keepalive, server-reset, listen-invalid-port, server-listen-options,
listen-handle-in-cluster-2 — all 0, except the three known pre-existing
NO-FIX failures, verified 1 on base too (server-listen-handle,
persistent-nodelay, persistent-ref-unref). Targets re-run 0x2 isolated.

## Differential

fast-sweep --target net --force, base
`hidden_files/fast-sweep/net-n2-base-ha-2026-11-14.csv` (main 453d2976:
124 pass / 10 timeout / 22 fail) vs branch
`hidden_files/fast-sweep/net-n2-handle-adoption-branch-2026-11-14.csv`
(129 pass / 6 timeout / 21 fail). Changed-value lines, sorted:
- test-net-end-close.js: 1 → 0 (target flip)
- test-net-socket-setnodelay.js: 1 → 0 (target flip)
- test-net-connect-memleak.js: 124 → 0 (load flake — known live value 1,
  sweep 124 under contention; NOT claimed)
- test-net-connect-options-fd.js: 124 → 0 (load flake — 0 isolated on
  branch and on base; NOT claimed)
- test-net-listen-handle-in-cluster-2.js: 124 → 0 (known load flake,
  isolated 0/0; NOT claimed)
- test-net-listen-exclusive-random-ports.js: 124 → 1 (mode change only —
  the lane-19 target fails 1 isolated on base too; NOT a regression)
Exactly the 2 targets toward-pass, 0 regressions.

## Ship

PR #___ (squash-merged as ___). Branch ref deleted; worktrees removed.

## RESULT

(Parent fills in: flips, differential paths, PR + merge SHA, guards.)
