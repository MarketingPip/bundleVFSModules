# NOTES — net lane N2-18: server capture-rejection (1 flip)

Target: `test-net-server-capture-rejection` (1 → 0).
Fix: `src/net.js` + `parity/preload.mjs` + `parity/hooks.mjs`.

## Mechanism (traced end to end, not assumed)

Real Node, `lib/net.js:2879`:

```js
Server.prototype[EventEmitter.captureRejectionSymbol] = function (err, event, sock) {
  switch (event) {
    case 'connection':
      sock.destroy(err);
      break;
    default:
      this.emit('error', err);
  }
};
```

The test sets `events.captureRejections = true`, then a server whose async
`'connection'` listener throws `'kaboom'` after registering
`sock.on('error', mustCall(...))`. Real Node routes the rejected promise
through `addCatch` → `emitUnhandledRejectionOrErr` → the handler above, so
the server-side socket gets `'error'` with the same error object and the
client sees `'close'`.

The shim already had both halves of the machinery: `src/events.js`
`addCatch` (`:1096`, gated on the instance `kCapture` flag) and
`emitUnhandledRejectionOrErr` (`:1122`, calls `ee[kRejection](err, type,
...args)` when defined), plus `EventEmitter.captureRejectionSymbol`. What was
missing was the `Server` handler itself — and, found by probe, the flag
never reached it:

- Base run: exit 1, uncaught `kaboom` at the throw site (addCatch never
  routed — see below).
- `zz-probe-capture.js` (deleted after use): with the `Server` handler
  added but no redirect, `server[Symbol.for('kCapture')]` stayed `false`
  while the test's `events.captureRejections` read `true`, and the target
  still exited 1. Root cause: under `PARITY_TARGET=net` the test's
  `require('events')` resolves to **native** events; the flag lands on a
  different module instance than the shim's `EventEmitter.prototype`.
  `src/net.js` imports the shim's `EventEmitter`, so the shim's
  `prototype[kCapture]` never flips and `addCatch` returns early.

## Fix (two parts)

1. `src/net.js`: `Server.prototype[EventEmitter.captureRejectionSymbol]`,
   a verbatim port of Node `lib/net.js:2879` (`'connection'` →
   `sock.destroy(err)`; default → `this.emit('error', err)`). `sock.destroy`
   goes through the streams destroy path, which emits `'error'` with the
   passed error object on the server-side socket; the peer then sees EOF
   (`_receiveEOF`) and `'close'`.
2. `parity/preload.mjs` + `parity/hooks.mjs`: `events` added as an extra
   redirect under `target === "net"` (#232 precedent — same shape as the
   http→net, https→http/tls/net, http→perf_hooks redirects, stated in the
   PR body). Now the test's `require('events')` returns the shim's
   `EventEmitter`, so `captureRejections = true` sets the shim prototype
   flag and `addCatch` routes the rejection to the handler. Only two net
   tests `require('events')` (`server-capture-rejection`,
   `connect-abort-controller`); the differential guards the other.

## Verification

- Target isolated 2× on branch: exit 0, 0 (base: exit 1).
- Guard `test-net-connect-abort-controller` (the other `require('events')`
  net test): exit 0 on branch.
- Full net fast-sweep differential: base
  `hidden_files/fast-sweep/net-n2-capture-base-2026-11-14.csv` vs branch
  `hidden_files/fast-sweep/net-n2-capture-branch-2026-11-14.csv`
  (see RESULT below).
- `node --check src/net.js` clean; footprint test 29/29.

## RESULT

- Flips: exactly 1 toward-pass, 0 regressions — `test-net-server-capture-rejection` 1 → 0 (isolated 0×2 on branch; base sweep 1, base isolated 1).
- Differential: base
  `hidden_files/fast-sweep/net-n2-capture-base-2026-11-14.csv` (pass 123)
  vs branch
  `hidden_files/fast-sweep/net-n2-capture-branch-2026-11-14.csv` (pass 122).
  Changed-value lines (sorted, deduped):
  - `test-net-server-capture-rejection.js: 1 -> 0` — the flip.
  - `test-net-autoselectfamily-commandline-option.js: 0 -> 124`,
    `test-net-connect-options-fd.js: 0 -> 124`,
    `test-net-normalize-args.js: 0 -> 124` — sweep load flakes (0, 0
    isolated on branch).
  - `test-net-socket-constructor.js: 124 -> 0` — true value (0, 0 isolated
    on branch; N1-11 flip, base sweep 124 was a load flake).
  - `test-net-end-close.js: 124 -> 1` — NOT a regression: 1, 1 isolated on
    base with the identical assertion failure (`[]` vs `['end','close']`,
    lane 24's target); the base sweep 124 was a hang-under-load artifact
    of the same failing test. It does not `require('events')`, so the
    redirect cannot have caused it.
- Guards: `test-net-connect-abort-controller` (the other `require('events')`
  net test) 0 on branch.
- PR: (filled at ship time)
- Merge SHA: (filled at ship time)
