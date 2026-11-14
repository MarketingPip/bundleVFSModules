# NOTES — net listen bind validation (fix/net-listen-bind-validation)

Net fix lane N1-7 (triage-net-2026-11-14.md lane 7). Base main `3199bb5d`,
recorded net 87/156. Targets: `test-net-better-error-messages-listen`,
`test-net-listen-error`. Claimed flips: 2.

## Mechanism

`Server.prototype._doListenTCP` (src/net.js:2651) had no bind validation:
any IP literal host bound virtually and emitted `listening`. Only non-IP
hostnames errored (`ENOTFOUND`). Real Node binds in `setupListenHandle`
(node-src/lib/net.js:2297) and a bind against an address the host does not
own fails as `UVExceptionWithHostPort(rval, 'listen', address, port)` —
async `error` with `EADDRNOTAVAIL`, `syscall: 'listen'`, `address`, `port`.

Probed real Node v24.22.1 (2026-11-14): `listen(1, '1.1.1.1')` →
`{ code: 'EADDRNOTAVAIL', syscall: 'listen', address: '1.1.1.1', port: 1,
message: 'listen EADDRNOTAVAIL: address not available 1.1.1.1:1' }`
(errno -99). `127.0.0.1`, `0.0.0.0`, `::1`, `::`, `localhost` all listen.

## Fix (src/net.js only)

- New `errAddrNotAvail(address, port)` factory beside `errAddrInUse`:
  `EADDRNOTAVAIL` / `listen` / `listen EADDRNOTAVAIL: address not
  available <address>:<port>` / errno -99, with `address` + `port` fields.
- In `_doListenTCP`, the `isIP(host)` branch now rejects non-bindable
  addresses before the registry insert: only loopback
  (`isLoopbackAddress` — 127.0.0.0/8, `::1`) and the wildcards
  `0.0.0.0` / `::` may bind — the same predicate `BoundSocket._bind`
  already uses (src/net.js:3127). Anything else resets `_bindPending`
  and emits the `EADDRNOTAVAIL` error on nextTick, so the listen
  callback / `listening` never fire and a later `listen()` retry works.

No preload / hooks / shared-file changes. No docs-number changes.

## Verification

- Both targets pass isolated on the branch (PARITY_TARGET=net):
  `test-net-better-error-messages-listen` 1 → 0,
  `test-net-listen-error` 1 → 0.
- zz probe (deleted after use): exact error shape incl. errno -99 and
  message; `192.168.1.99` also EADDRNOTAVAIL; `127.0.0.1`, `127.0.0.2`,
  `0.0.0.0`, `::1`, `::`, `localhost` all still listen; retry after a
  failed bind listens OK (`_bindPending` reset proven).
- Guards re-run (isolated, branch, all 0): listen-after-destroying-stdin,
  listen-close-server-callback-is-not-function, listen-close-server,
  listen-handle-in-cluster-2, listening, server-call-listen-multiple-times,
  server-close-before-calling-lookup-callback, server-close,
  server-listen-remove-callback, connect-immediate-finish.
- Footprint test: tests/ondemand-require.test.js 29/29 on the branch.
- Differential (fast-sweep --target net, base
  net-sweep-2026-11-14.csv vs branch
  net-n1-listen-bind-branch-2026-11-14.csv, 156 rows each, pass 87 → 89):
  matched changed-value lines (sorted, deduped), exactly 4 —
  `test-net-better-error-messages-listen.js,1,0`,
  `test-net-listen-error.js,1,0`,
  `test-net-throttle.js,134,124`,
  `test-net-write-fully-async-buffer.js,137,124`.
  The two 134/137 → 124 mode changes are the known pre-existing spinner
  artifacts (triage: throttle 134 sweep / 124 isolated,
  write-fully-async-buffer 137 sweep / 124 isolated) — same spin, different
  kill code, not regressions. All other known flakes identical on both
  sides (listen-twice 124, server-close-before-ipc-response 124,
  socket-write-after-close 124, write-fully-async-hex-string 124,
  connect-memleak 1). Regressions: 0.

## Ceiling / leftovers

- Expanded IPv6 loopback (`0:0:0:0:0:0:0:1`) and IPv4-mapped loopback
  (`::ffff:127.0.0.1`) are rejected by the shared predicate where real
  Node would bind them — same limitation as `BoundSocket._bind`;
  no vendored test covers either form. Widening `isLoopbackAddress`
  would also change the connect-side `localAddress` validation, so it
  is left as a shared-helper follow-up, not done in this lane.
- Binding the machine's real LAN IP cannot pass in-browser (no such
  interface exists in the virtual transport); no test covers it.
