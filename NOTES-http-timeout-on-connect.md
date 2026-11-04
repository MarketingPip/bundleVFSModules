# NOTES: test-http-client-timeout-on-connect (PR #324)

## The test

`parity/node-test/parallel/test-http-client-timeout-on-connect.js`
(`// Flags: --expose-internals`) asserts two things about a client socket
with a pre-connect `req.setTimeout(1)`:

1. At `socket` assignment time, `socket[kTimeout]` (from
   `require("internal/timers")`) is `null` — the deferred pre-connect
   timeout must NOT be armed at assignment (PR #322 defers it to connect).
2. At socket `connect`, `socket[kTimeout]._idleTimeout === 1` — the
   deferred timeout is applied at connect as a 1 ms timer.
3. Then `timeout` -> `req.abort()` -> `error` "socket hang up" (the PR #322
   destroy/abort path; already passing once 1+2 hold).

## Failure on pristine main ff954d40 (3/3 runs, shim confirmed via stack)

At `socket` time the assertion failed `undefined !== null`: the shim's
`Socket` never defined any `kTimeout` property at all. (The second
assertion never ran.)

## Real-Node probes (v24.22.1, `--expose-internals`)

Socket `kTimeout` lifecycle — the slot is a real property, never a fake:

- Fresh socket: own symbol `timeout` present, value `null`.
- `setTimeout(1)` pre-connect: timer object, `_idleTimeout === 1`.
- At connect: same timer, `_idleTimeout` unchanged.
- After the `timeout` event fires: still the timer object (not nulled).
- After `setTimeout(0)`: still the timer object, now `_idleTimeout -1`,
  `_destroyed true` (clearTimeout's doing, not a nulling).
- After `destroy`: still the timer object, `_idleTimeout -1`,
  `_destroyed true`.
- After re-arm: new timer with the new `_idleTimeout`.

So the faithful emulation is: slot starts `null`; arming stores the new
timer; clearing / firing / destroying keeps the (cleared or fired) timer
object in the slot. The slot is never nulled after first arming.

## Fix (3 files)

- `src/net.js` only in product:
  - `kTimeout = Symbol.for("bundleVFSModules.net.kTimeout")` (ponytail
    comment at the definition). Product code cannot import Node's real
    `internal/timers` symbol — the browser build cannot resolve internal
    modules — so the slot is keyed by this bridge. The adapter below
    exports the same key, so test reads see the slot.
  - Constructor: `this[kTimeout] = null` beside `this._idleTimer = null`.
  - `_clearIdleTimer`: keeps the cleared timer in the slot (probed shape).
  - `_refreshTimeout`: stores the new timer in the slot on arm; the fire
    callback keeps the fired timer in the slot before emitting `timeout`.
  - All other timer paths (`setTimeout(0)`, re-arm, `_destroy`) flow
    through these two helpers, so they inherit the probed shape for free.
- `parity/internal-timers-adapter.mjs` (new, harness-only): exports only
  `kTimeout` = the bridge key. It is the only member the http test uses.
  Scope check: the only http-target importer of `internal/timers` is this
  test (grep over `test-http-*.js`); the http2/tls/child_process readers
  run under other targets and keep the real module, because the redirect
  below is scoped to `target === "http"`.
- `parity/preload.mjs` (harness-only, one special case following the
  `internal/event_target` and `_http_common` precedents): for the http
  target, `require("internal/timers")` resolves to the adapter above.

## What was deliberately NOT done

- No import of `internal/timers` (or any Node internal) in product code:
  it would break the browser build. No symbol-identity claim against
  real Node's `kTimeout`: no vendored test asserts it, and the bridge
  cannot satisfy it (named as the ceiling in the ponytail comment).
- No ESM-hook (`hooks.mjs`) redirect: the only importer uses CJS
  `require`, which the `Module._load` patch covers.
- `test-net-socket-timeout-unref` fails exit 1 on branch AND base:
  pre-existing, unrelated to this change (verified on pristine main).
- `test-net-timeout.js` does not exist (the name yields module-not-found
  exit 1, not a test failure); the real net timeout guards
  (`test-net-settimeout`, `test-net-timeout-no-handle`,
  `test-net-can-reset-timeout`, `test-net-socket-timeout`) all pass.

## Verification

- Target: 1 -> 0, 3/3 runs on the branch; 1 on pristine main (3/3).
- Guards all 0: the #322 family (client-timeout-option,
  client-timeout-option-listeners, client-timeout-option-with-agent,
  client-set-timeout, client-response-timeout), client-timeout,
  client-timeout-event, client-timeout-with-data, agent-timeout-option,
  agent-timeout, keep-alive-timeout, keep-alive-timeout-custom,
  server-keep-alive-timeout, agent-keep-alive-timeout-buffer,
  client-set-timeout-after-end; net-target settimeout,
  timeout-no-handle, can-reset-timeout, socket-timeout.
- Full 397 differential vs pristine main: exactly 1 line toward pass,
  zero pass-to-fail (see http-sweep-toc-{branch,base}.csv).
