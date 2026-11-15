# NOTES — net lane N2-22: net perf_hooks entries

Target: `test-net-perf_hooks` (mustCallAtLeast 1, actual 0 — no `net` entries
observed). Flips exactly 1, 0 regressions (differential below).

## Mechanism (Node source first)

Real Node, `lib/net.js` (v24.20.0 source pack):

- `internalConnect` (:1404-1405): when `handle.connect` returns 0 (dial
  issued), `else if ((addressType === 6 || addressType === 4) &&
  hasObserver('net'))` → `startPerf(self, kPerfHooksNetConnectContext,
  { type: 'net', name: 'connect', detail: { host: address, port } })`.
  Pipes never start an entry (the addressType 4/6 gate).
- `afterConnect` (:2009-2010): after `emit('connect')` + `emit('ready')`
  (and the first read), `if (self[kPerfHooksNetConnectContext] &&
  hasObserver('net')) stopPerf(self, kPerfHooksNetConnectContext)`.
  A refused dial starts the slot but never stops it, so no entry is ever
  enqueued for it.

The shim had zero perf instrumentation in `src/net.js`, and the bridge in
`src/internals/perf-observe.js` is only filled when `src/perf_hooks.js` is
imported — which never happened under `PARITY_TARGET=net`, since the test's
`require('perf_hooks')` resolved to native (preload redirected it only for
target=http). Both halves were missing.

## Fix

- `src/net.js`: import the bridge (`./internals/perf-observe.js`, same as
  `src/http.js:42`); module-level `kPerfHooksNetConnectContext` symbol +
  `_netPerfStart` / `_netPerfStop` wrappers copied from the
  `src/http.js:80-98` `_httpPerfStart` / `_httpPerfStop` pattern (lane #369:
  start only when a `net` observer exists right now, stop only when a start
  context exists and an observer still exists; no-ops when perf_hooks.js
  was never loaded).
  - Start: `_doConnect`, right before `queueAccept` — the virtual server
    lookup found a listener, i.e. the shim's "dial issued" moment —
    gated on `!pipe` (Node's addressType 4/6 gate).
  - Stop: after `emit('connect')` + `emit('ready')` (+ the first read) in
    BOTH connect-emit sites — `emitClientConnect` (normal accept path)
    and `_dropPairedConnection` (maxConnections/blockList drop path: the
    client still gets a real connect in Node, so its entry still stops).
- `parity/preload.mjs` (`isExtraRedirect`): one extra redirect,
  `target === "net" && name === "perf_hooks"` — the #232 precedent,
  mirroring the http-target perf_hooks redirect directly above it. Only
  `test-net-perf_hooks` requires perf_hooks among net tests (grep-verified),
  so the redirect cannot regress another net test.

## Verification

- Target: `test-net-perf_hooks` 1 → 0, isolated 2x on the branch.
- zz probe (deleted after use): refused TCP connect emits no entry
  (`zz-net-perf-refused.js`, PASS).
- Guards (all 0 on branch): connect-buffer, connect-buffer2,
  connect-immediate-destroy, connect-reset, connect-abort-controller,
  connect-options-port, connect-options-invalid, connect-keepalive,
  connect-nodelay, connect-immediate-finish, socket-byteswritten,
  bytes-written-large, server-listen-options, listen-invalid-port,
  server-keepalive, server-nodelay, server-reset, pingpong, boundsocket.
  `test-net-remote-address-port` is 1 on branch AND on pristine base
  (same assertion) — lane 20's target, not a regression.
- `test-http-perf_hooks` (http target) still 0 — the preload edit did not
  disturb the http redirect.
- Differential: fast-sweep `--target net` base
  `hidden_files/fast-sweep/net-n2-perfhooks-base-2026-11-15.csv` (156 rows,
  123 pass / 13 timeout / 20 fail on pristine main `b2657677`) vs branch
  `hidden_files/fast-sweep/net-n2-perfhooks-branch-2026-11-15.csv` (156
  rows, 122 pass / 14 timeout / 20 fail). Matched changed-value lines
  (sorted, deduped): perf_hooks 1→0 (this lane); connect-options-fd
  124→0 (base load flake — passes isolated, N1-11 flip); end-close
  1→124, persistent-ref-unref 124→1, server-listen-handle 124→1 (mode
  changes on known NO-FIX / lane-24 targets). The 3 apparent regressions
  (autoselectfamily-commandline-option, normalize-args,
  socket-constructor, all 0→124) were adjudicated with isolated 2x
  re-runs on the branch: all 0×2 — sweep load flakes under the 14-lane
  contention, not regressions. end-close is 1×2 isolated (its base
  value). Net result: exactly 1 flip, 0 regressions.

## Ceiling notes

- Happy-eyeballs multi-attempt dials re-enter `_doConnect` per attempt;
  each attempt that finds a server restarts the slot (startPerf overwrites
  `target[key]`), and the winning attempt's connect emit stops it — at most
  one entry per socket, as in Node (whose multiple path starts perf in the
  winning attempt's completion). No vendored test pins multi-attempt perf
  timing.
- `ponytail:` the wrappers are the minimum reuse of the #369 bridge; no new
  abstraction. If a future test needs `dns`/`tls` perf entries, the same
  start/stop pair ports directly (Node gates each on its own observer type).
