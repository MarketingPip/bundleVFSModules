# NOTES-http-incoming-surface.md

## What

`IncomingMessage` gained the two public header-folding methods real Node
exposes, and a socket-less message no longer gets a substitute socket.

- `IncomingMessage.prototype._addHeaderLine(field, value, dest)` — verbatim
  port of Node `lib/_http_incoming.js:447`, with the `matchKnownFields`
  flag-byte table from `:340` ported as a module-level function.
- `IncomingMessage.prototype._addHeaderLineDistinct(field, value, dest)` —
  verbatim port of Node `lib/_http_incoming.js:481`.
- `IncomingMessage` constructor: `this.socket = socket` (was
  `socket || new FakeSocket()`). Node's constructor assigns the socket
  as-is, so `new IncomingMessage()` has `socket`/`connection`/`client`
  all `undefined`. The `connection` accessor already lived on
  `IncomingMessage.prototype` (get → `this.socket`, set → `this.socket`);
  only the constructor default was wrong.

## Why

- `test-http-incoming-matchKnownFields`: calls `_addHeaderLine` directly
  on a fresh message with a plain `{}` dest, covering the whole
  `matchKnownFields` table (traditional-cased vs lowercase fields,
  `, `-join fields, `; `-join Cookie, Set-Cookie arrays, first-wins
  singletons, the empty-field edge). Was `TypeError: _addHeaderLine is
  not a function`.
- `test-http-incoming-message-connection-setter`: `new
  http.IncomingMessage()` must have `connection` and `socket` both
  `undefined`, and setting `connection` must set `socket` too
  (`lib/_http_incoming.js:109`). Was a `FakeSocket` on both.

## Design note: two fold paths, deliberately

The shim's internal wire fold (`IncomingMessage._applyRawHeaders` /
`_applyRawTrailers`) already implements the same semantics as
`_addHeaderLine` — the `DUPLICATES_REMOVED` set is exactly Node's
no-flag fields, the always-join branch is exactly the flag-0 fields,
Cookie joins with `"; "`, Set-Cookie is always an array, and the
`joinDuplicateHeaders` gating matches `:464`. That is why every header
test already passed. The ported methods are the public API surface,
not a second fold path: `_applyRawHeaders` was NOT rewired onto them,
because it also pushes `rawHeaders`, maintains `headersDistinct`
inline, and accepts array values from `fromRequest` (Node's port takes
a single string value) — rewiring would change fold output for those
inputs with zero test benefit. If a future change needs one fold
implementation, the blocker is the array-value case in `fromRequest`.

## Verification

- Targets `test-http-incoming-matchKnownFields`,
  `test-http-incoming-message-connection-setter`: exit 1 on base,
  exit 0 ×2 on branch.
- Probe cross-check vs real Node v24.22.1 (`/tmp/probe-is-port.js`):
  byte-identical JSON on 8 cases the test does not cover (Set-Cookie
  array, Cookie `; ` join, Date `, ` join, Host first-wins,
  Host join with `joinDuplicateHeaders = true`, empty field,
  `_addHeaderLineDistinct`, Content-Encoding with undefined value).
- Guards: the 8 × #345, 4 × #347, 5 × #350/#351 flips, dump-req #353,
  keepalive-free #355, remove-header pair #357, plus the header-folding
  families (multiheaders, multiheaders2, multiple-headers,
  request-join-authorization-headers, server-multiheaders,
  headers-distinct-proto, client-headers-host-array,
  client-headers-array, blank-header, raw-headers) — all exit 0.
- Full differential (fast-sweep, `http-sweep-is-{base,branch}.csv`, 397
  rows each): raw diff 4 toward pass, 0 regressions, 1 mode change.
  Corrected to exactly 2 toward pass (`test-http-incoming-
  matchKnownFields`, `test-http-incoming-message-connection-setter`),
  0 regressions, 0 mode changes: the other 3 lines are load artifacts
  from 8 lanes sweeping in parallel (base itself scored 358, not the
  known 362 ground truth; phase 1 took 6x normal). Targeted re-checks
  under the same load give identical codes on base and branch for all
  three: `test-http-server-headers-timeout-keepalive` 1/1 (ground truth
  0), `test-http-server-headers-timeout-pipelining` 0/0,
  `test-http-client-leaky-with-double-response` 1/1; also
  `test-http-byteswritten` 124/124 and
  `test-http-pipeline-requests-connection-leak` 0/0 on both sides.
  `ponytail:` a quiet-machine re-sweep would reproduce 362→364 with
  exactly these 2 lines; not re-run here — the re-checks already settle
  the 3 disputed lines, and re-sweeping into 7 other lanes' load would
  just re-contaminate the numbers.
- Full repo jest suite: the 7 known baseline failures only
  (constants ×3, perf_hooks, sys, oracle util + crypto — all host-Node
  v24.22.1 vs CI-pin v24.20.0 skew, identical on base). Two full runs
  under parallel-lane load (load avg 34) each showed extra timeout
  failures in `headless-parity` / `timers` (65–105 s per test) and, in
  run 1, the ondemand footprint test (allowlist not yet set); the same
  `headless-parity` + `timers` tests fail identically on pristine base
  under the same load, and `timers` + `headless-parity` passed in run 1
  — load flakes, not regressions. `tests/ondemand-require.test.js`
  29/29 after the allowlist fix.
- Builds: `build-sandbox --check` exit 0, `build-runtime --check`
  exit 0, `build-vfs` exit 1 on branch (twice) AND on pristine base
  with the identical error — `src/specials/bundler.js`, esm.sh
  acorn/acorn-walk fetch failed after 3 attempts (known environmental
  transient, same as lanes #337/#340/#346/#347/#353/#354/#357).
