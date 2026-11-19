# Net module — Node 26 re-target triage (2026-11-19)

DOCS ONLY. No src/ changes, no shim code, no package.json edits.

- Base: worktree `~/workspace/worktrees/node26-triage-net` at `3c091022`
  (drift detector PR #505).
- Node 26 binary verified first: `~/workspace/local/node-26/bin/node --version`
  → `v26.13.1`. Node 26 source: `~/workspace/local/node-26-src/`
  (lib/ + test/parallel/). Node 24.20.0 source pack:
  `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node-src/`.
- Gap list (parent-verified, not recomputed):
  `hidden_files/node26-triage/gaps-net.json` — **16 tests, all shim-gap,
  0 fails-natively, 0 native-timeout**.
- v24 adjudication baseline:
  `hidden_files/triage-net-2026-11-14.md` (+ `...-probes.txt`) — v24 close
  **143/156** with 13 NO-FIX (+ 2 fails-natively env = 15 in the triage doc).
- Method: read run-baseline.mjs first; isolated re-runs use its exact
  invocation (`timeout N node --import <abs preload> parity/node-test/parallel/<test>`,
  `PARITY_TARGET=net`) PLUS the test's `// Flags:` (see § Baseline corrections).
  All 16 reproduced isolated; failure lines quoted below from
  `/tmp/net26-iso/<test>.log` (ephemeral — quoted here, not linked).

## Headline

- Node 26 net total: **161 files, 145 pass / 16 fail / 0 timeout**
  (`parity/drift/node26-baseline.jsonc`, `"net"` section).
  v24 close was 143/156. Same pass count, bigger denominator.
- **16 gaps = 13 pre-existing + 3 new-in-26.**
- **13 NO-FIX (unchanged reasons) + 3 fixable (1-flip lanes each).**
- Lane ceiling if all 3 land: **148/161 (91.9%)**.
- Changelog cross-check
  (`research_notes/node-24-to-26-drift-20261119-1722/cross-check-changelog-2026-11-19.md:45`):
  net has **no listed-module change in 25/26.0.0**. The 3 new tests are
  regression tests for behavior that already existed (or was already
  missing) — no new lib surface except the internal `_TransferredBoundSocket`
  (see § Export diff).
- File inventory change 24 → 26 (filename diff of the two test trees):
  +6 new files, −1 removed. New: the 3 failing tests below + 3 passing
  (`test-net-connect-custom-lookup-non-string-address.mjs`,
  `test-net-server-async-dispose.mjs`,
  `test-net-unref-timer-parent-undefined.js` — all `pass` in the baseline).
  Removed upstream: `test-net-listen-ipv6only.js` (v24 env NO-FIX,
  fails-natively identically — it disappears with the file, not with a fix).

## Per-test table

| Test | New? | Base | Iso | Failure signal (isolated) | Verdict |
|---|---|---|---|---|---|
| test-net-allow-half-open-async-iter-destroy.js | NEW | 1 | 1 | `destroyed` false, expected true (:52) | Fixable → L3 |
| test-net-autoselectfamily-attempt-timeout-default-value.js | pre | 1 | 1 | actual 1250, expected 2500 | Fixable → L1 |
| test-net-boundsocket-transfer-worker.js | NEW | 1 | 1 | `DataCloneError` at `postMessage` (:46) | NO-FIX |
| test-net-child-process-connect-reset.js | pre | 1 | 1 | `ECONNREFUSED` vs `ECONNRESET` (:40) | NO-FIX |
| test-net-listen-handle-in-cluster-1.js | pre | 1 | 1 | mustCall 0/1, worker never listening | NO-FIX |
| test-net-persistent-nodelay.js | pre | 1 | 1 | `0 !== 1` (:33, patched setNoDelay never called) | NO-FIX |
| test-net-persistent-ref-unref.js | pre | 1 | 1 | mustCallAtLeast 0 | NO-FIX |
| test-net-server-listen-handle.js | pre | 1 | 1 | shim `TypeError: 'options' must have "port" or "path"` (src/net.js:3838) | NO-FIX |
| test-net-server-transfer-worker.js | pre | 1 | 1 | `DataCloneError` at `postMessage` | NO-FIX |
| test-net-socket-transfer-worker-http.js | pre | 1 | 1 | native `http.get` → `AggregateError [ECONNREFUSED]` on `::1:40000` | NO-FIX |
| test-net-socket-transfer-worker.js | pre | 1 | 1 | `DataCloneError` at `postMessage` | NO-FIX |
| test-net-socket-unref-timer-parent-chain.js | NEW | 1 | 1 | `TypeError: socket._unrefTimer is not a function` (:16) | Fixable → L2 |
| test-net-throttle.js | pre | 129 | 124 | spin, empty output, TERM-killed | NO-FIX (arch) |
| test-net-transfer-guards.js | pre* | 1 | 1 | `code: 25` (DataCloneError) vs `ERR_WORKER_HANDLE_NOT_TRANSFERABLE` | NO-FIX |
| test-net-write-fully-async-buffer.js | pre | 129 | 124 | spin, empty output, TERM-killed | NO-FIX (arch) |
| test-net-write-fully-async-hex-string.js | pre | 129 | 124 | spin, empty output, TERM-killed | NO-FIX (arch) |

\* transfer-guards.js is the one pre-existing test file that CHANGED upstream
(see F1): Node 26 adds BoundSocket guard cases. Same barriers, same verdict.

Native check (real Node 26.13.1, plain `node <test>`, flags from headers):
all 3 new tests exit 0 — genuine shim gaps, not native failures.

## Families

### F1 — Worker transfer guards / handle passing (5 tests) — NO-FIX

- `test-net-boundsocket-transfer-worker.js` (NEW), `test-net-server-transfer-worker.js`,
  `test-net-socket-transfer-worker.js`, `test-net-socket-transfer-worker-http.js`,
  `test-net-transfer-guards.js` (extended in 26).
- Mechanism: transferring a Socket/Server/BoundSocket needs V8 structured
  clone to invoke `[kTransfer]`/`[kTransferList]` and move a real libuv
  handle to another thread. The shim defines no such methods (0 hits for
  `kTransfer` in `src/net.js`) and cannot obtain the symbols: they are
  C++ `internalBinding('symbols')` values, re-exported by
  `lib/internal/worker/js_transferable.js:13-17,137-138`.
- Fresh Node 26.13.1 probe (quoted):
  `node-26 --expose-internals -e "…internalBinding('symbols')…"` →
  `messaging_transfer_symbol: symbol | messaging_transfer_list_symbol: symbol | messaging_deserialize_symbol: symbol`.
  And the transfer itself moves a real handle — Node 26 `lib/net.js:570-586`:
  `BoundSocket.[kTransfer]` asserts `#handle instanceof TCP` and returns
  `{ data: { handle }, deserializeInfo: 'net:_TransferredBoundSocket' }`
  (comment: "the messaging layer takes ownership of it via
  `TCPWrap::TransferForMessaging()`").
- Isolated evidence: `DataCloneError: Found invalid value in transferList`
  at `postMessage` (boundsocket, server-transfer, socket-transfer);
  transfer-guards gets `code: 25` (DataCloneError) instead of
  `ERR_WORKER_HANDLE_NOT_TRANSFERABLE`; socket-transfer-worker-http fails
  even earlier — native `http.get` dials real TCP `::1:40000` →
  `ECONNREFUSED` — and fixing that only reaches the same transfer barriers.
- transfer-guards 26 delta: three new BoundSocket cases (pipe BoundSocket,
  closed BoundSocket, adopted BoundSocket — all expecting
  `ERR_WORKER_HANDLE_NOT_TRANSFERABLE`). The BoundSocket cases need the same
  `[kTransfer]` machinery plus a real TCP handle; verdict unchanged.
- Pre-existing reason unchanged (v24 triage NO-FIX list). The only new member
  (boundsocket-transfer-worker) is the consumer of the new internal export
  (see § Export diff).

### F2 — Real-handle adoption via `--expose-internals` (3 tests) — NO-FIX

- `test-net-server-listen-handle.js`, `test-net-persistent-nodelay.js`,
  `test-net-persistent-ref-unref.js`.
- Test files byte-identical to v24. All three patch or adopt the REAL
  libuv handle: server-listen-handle builds real `TCP`/`Pipe` from
  `internalBinding('tcp_wrap')`/`('pipe_wrap')` (test :11-13) and passes the
  handle to `server.listen()`; persistent-nodelay patches
  `TCPWrap.prototype.setNoDelay` (test :7-8); persistent-ref-unref patches
  `TCPWrap.prototype.ref/unref`.
- Fresh Node 26.13.1 probe (quoted):
  `TCP: function | TCP.prototype.setNoDelay: function | TCP.prototype.ref: function`.
  The shim's stand-in is a plain JS constructor, `src/net.js:1184`
  (`function VirtualHandle()`), a different prototype that the tests' patches
  never touch — isolated persistent-nodelay fails `0 !== 1` (:33).
- server-listen-handle isolated: the shim rejects the handle object outright —
  `TypeError: The argument 'options' must have the property "port" or "path"`
  at `src/net.js:3838` (`Server.listen`). A virtual transport cannot adopt a
  real libuv handle.
- Pre-existing reason unchanged (v24 triage NO-FIX list).

### F3 — Cluster / IPC handle passing (1 test) — NO-FIX

- `test-net-listen-handle-in-cluster-1.js` (byte-identical to v24).
- Needs a real serializable handle + IPC handle-passing
  (`child_process._send` throws `ERR_INVALID_HANDLE_TYPE`; the shim server
  has no `_handle`). Isolated: worker never reports listening (mustCall 0/1).
- Pre-existing reason unchanged (v24 triage: Fixable→NO-FIX).

### F4 — Cross-process connect-reset, lane-11 family (1 test) — NO-FIX

- `test-net-child-process-connect-reset.js` (byte-identical to v24).
- The real child listens on a real port; the shim parent's virtual registry
  has no server for that real port, so connect fails `ECONNREFUSED` before
  the parent can SIGKILL the child (which would produce `ECONNRESET`).
  Isolated: `actual: 'ECONNREFUSED', expected: 'ECONNRESET'` (:40) — same
  as v24 probe §3. The orphaned real child lingers holding the stdout pipe;
  the isolated run killed orphan pid 5339 afterwards (no orphan left).
- Pre-existing reason unchanged (v24 triage NO-FIX, lane-11).

### F5 — Sync-transport backpressure spin (3 tests) — NO-FIX (arch)

- `test-net-throttle.js`, `test-net-write-fully-async-buffer.js`,
  `test-net-write-fully-async-hex-string.js` (all byte-identical to v24).
- The virtual transport delivers synchronously (`src/net.js:2965`
  `_write` → `_deliverToPeer`) and `write()` never returns `false`, so
  `while (conn.write(...))` spins forever and the peer buffer grows
  unbounded. Isolated: all three exit 124, empty output,
  `timeout: sending signal TERM to command 'node'`.
- Fresh probe (zz-probe-backpressure.js, run under the harness, deleted
  after): 50,000 writes, `{"trueCount":50000,"falseCount":0,
  "writableLength":51068928}` — `write()` returned `true` 50,000/50,000
  with ~51 MB buffered and never a `false`. No backpressure exists to
  observe; a fix needs async write/backpressure rework of the sync
  transport (wide blast radius, not a ranked lane — v24 triage caveat,
  unchanged).
- Baseline exit 129 vs isolated 124 is a runner artifact, not a new crash
  mode (see § Baseline corrections).

### F6 — Happy-eyeballs default value (1 test) — FIXABLE → L1

- `test-net-autoselectfamily-attempt-timeout-default-value.js`
  (file byte-identical to v24; the FAILURE MODE is new in 26).
- The test asserts `getDefaultAutoSelectFamilyAttemptTimeout() ===
  platformTimeout(2500)`. Upstream changed two inputs: the Node default
  went 250 → 500, and `test/common/index.js:206` now multiplies by ×5
  (v24: ×10 at vendored `common/index.js:190-191`). 500×5 = 2500 ✓ on real
  Node; the shim still hardcodes 250 (`src/net.js:937`), so common sets
  250×5 = 1250. Isolated: `actual: 1250, expected: 2500`.
- Fresh probes (quoted): real Node 26.13.1
  `require('net').getDefaultAutoSelectFamilyAttemptTimeout()` → `500`;
  host Node v24.22.1 → `250`. Both binaries read the same lib line
  (`lib/net.js:160`: default from
  `getOptionValue('--network-family-autoselection-attempt-timeout')`) — the
  option DEFAULT changed upstream, not the code shape.
- The v24 preload/common-split bug is already fixed: `parity/preload.mjs:379-393`
  (`isNetHelper` gate) redirects `common/index.js` to the shim under
  target=net, so the ×5 now lands on the shim. The other happy-eyeballs
  tests pass in the 26 baseline (not in gaps) — only the default changed.
- Pre-existing test, new-in-26 failure mode, one-line fix (L1).

### F7 — Async-iterator destroy of a half-open socket (1 test) — FIXABLE → L3

- `test-net-allow-half-open-async-iter-destroy.js` (NEW in 26; absent from
  the v24.20.0 source pack). Native exit 0 on Node 26.13.1.
- Server with `allowHalfOpen: true`; client `end('data')`; server socket is
  consumed with plain `for await`; test asserts `serverSocket.destroyed ===
  true` after the loop (:52). Isolated: `actual: false, expected: true`.
- Upstream change: Node 26 removed the half-open preservation from the
  stream async iterator. Node 24 `lib/internal/streams/readable.js:1412-1421`
  had a `preserveHalfOpenDuplex` carve-out (skip destroy when
  `allowHalfOpen && writable && !writableEnded`); Node 26
  `lib/internal/streams/readable.js:1611-1623` (`finalize()`) destroys
  unconditionally unless `options?.destroyOnReturn === false`. The shim
  ported the v24 shape verbatim, including the carve-out
  (`src/stream/readable.js:1432-1441`).
- Upstream confirms the new behavior twice over: the sibling test
  `test-net-allow-half-open-async-iter.js` changed in 26 to
  `serverSocket.iterator({ destroyOnReturn: false })` (only line changed
  vs v24) and still asserts `destroyed === false` + write-back; the stream
  test `test-stream-readable-async-iter-half-open-duplex.js` made the same
  change in 26. Both pass in the 26 baseline.
- New-in-26 fixable; lane L3 (cross-module: the code lives in
  `src/stream/readable.js`, shared with the stream suite — see coordination
  note in L3).

### F8 — Missing `Socket.prototype._unrefTimer` (1 test) — FIXABLE → L2

- `test-net-socket-unref-timer-parent-chain.js` (NEW in 26; absent from the
  v24.20.0 source pack; regression test for nodejs/node#64490). Native
  exit 0 on Node 26.13.1.
- The test sets `socket._parent = undefined` and calls `socket._unrefTimer()`
  then `socket.destroy()`. The shim defines NO `_unrefTimer` anywhere
  (0 hits in `src/`). Isolated: `TypeError: socket._unrefTimer is not a
  function` (:16).
- Node 26 `lib/net.js:800-807` is a 7-line port:
  walk `s._parent` with a loose `!= null` check, `refresh()`ing `s[kTimeout]`.
  The shim already has the slot: `kTimeout` symbol at `src/net.js:1248`
  (`Symbol.for("bundleVFSModules.net.kTimeout")`), set at `:1301`/`:1811`.
- Block 2 (`destroy()` with `_parent === undefined`) already works —
  probed under the harness (zz-probe, deleted after):
  `{"destroyed":true}`, exit 0, no error event. The shim's `_destroy`
  never reads `_parent` (only `src/net.js:1284` sets it to null).
- Sibling test `test-net-unref-timer-parent-undefined.js` (TLS variant of
  the same #64490 fix) PASSES in the 26 baseline — the TLS path never
  calls the missing method. Only the net-socket test needs the port.
- New-in-26 fixable; lane L2.

## Lane candidates (conservative estimates)

### L1 — Happy-eyeballs default 250 → 500 — est. 1 flip

- Target: `test-net-autoselectfamily-attempt-timeout-default-value.js`.
- Change: `src/net.js:937` `defaultAutoSelectFamilyAttemptTimeout = 250` → `500`
  (matches Node 26's option default, `lib/net.js:160`).
- Must also update the repo's own assertion: `tests/net.test.js:290`
  (`expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(250)` → `500`).
  The sibling `tests/net.test.js:304` clamp case (5 → 10) is unaffected.
- Blast radius checked: no other Node 26 net test asserts `250`
  (only the default-value test file contains `250` among the
  autoselectfamily tests); the CLI-flag seed (`src/net.js:939-961`) and the
  `setDefault*` validation are untouched. Estimate stays 1 — the other
  happy-eyeballs tests already pass.

### L2 — Port `Socket.prototype._unrefTimer` — est. 1 flip

- Target: `test-net-socket-unref-timer-parent-chain.js`.
- Change: add the method to `src/net.js`, porting Node 26 `lib/net.js:800-807`
  verbatim against the shim's existing `kTimeout` slot (`src/net.js:1248`):
  `for (let s = this; s != null; s = s._parent) { if (s[kTimeout]) s[kTimeout].refresh(); }`.
- No other test calls `_unrefTimer` directly; the destroy path is already
  clean (probed above). Estimate 1.

### L3 — Drop the `preserveHalfOpenDuplex` carve-out — est. 1 flip (net)

- Target: `test-net-allow-half-open-async-iter-destroy.js`.
- Change: remove the carve-out from the async-iterator `finally` block in
  `src/stream/readable.js:1432-1441`, matching Node 26
  `lib/internal/streams/readable.js:1611-1623` (`finalize()` destroys unless
  `destroyOnReturn === false`).
- Why the sibling keeps passing: Node 26's sibling test uses
  `iterator({ destroyOnReturn: false })`, so its `destroyed === false` +
  write-back assertions hold without the carve-out.
- Coordination (required, not optional): the code is shared stream
  infrastructure. The vendored v24 stream test
  `test-stream-readable-async-iter-half-open-duplex.js` asserts
  `destroyed === false` after PLAIN `for await` — it passes today only
  because of the carve-out, and Node 26's version of that file uses
  `iterator({ destroyOnReturn: false })` (same upstream change). Landing
  L3 without the stream-test update regresses the v24 vendored stream
  suite; landing it WITH the Node 26 stream test shape is clean. The
  stream module's triage owns that file — flag the dependency, don't
  silently break it. Net estimate stays 1.

Total lane flips: **3** (L1 + L2 + L3). Ceiling: 145 + 3 = **148/161 (91.9%)**.

## NO-FIX list (13)

| Test | One-line reason (probe in F1–F5) |
|---|---|
| test-net-boundsocket-transfer-worker.js | Needs real libuv `TCP` handle moved across threads via C++ transfer symbols; V8 throws `DataCloneError` |
| test-net-server-transfer-worker.js | Same; `DataCloneError` at `postMessage` |
| test-net-socket-transfer-worker.js | Same; `DataCloneError` at `postMessage` |
| test-net-socket-transfer-worker-http.js | Same barriers (fails earlier on native `http.get` → `ECONNREFUSED`) |
| test-net-transfer-guards.js | Guards can only fire via `[kTransferList]` invoked by native `postMessage`; V8 throws `DataCloneError` first (code 25) |
| test-net-server-listen-handle.js | Needs real libuv handle adoption (`TCPWrap`/`PipeWrap`); shim rejects handle args |
| test-net-persistent-nodelay.js | Patches real `TCPWrap.prototype.setNoDelay`; shim `VirtualHandle` is a different prototype, never called (0 !== 1) |
| test-net-persistent-ref-unref.js | Same; patches real `TCPWrap.prototype.ref/unref` (mustCallAtLeast 0) |
| test-net-listen-handle-in-cluster-1.js | Needs real serializable handle + IPC handle-passing; worker never listens |
| test-net-child-process-connect-reset.js | Cross-process: shim parent gets `ECONNREFUSED` for a real child's real port, never reaches the SIGKILL/`ECONNRESET` step |
| test-net-throttle.js | Architectural: sync transport has no backpressure (`write()` true 50,000/50,000 with ~51 MB buffered) → spin |
| test-net-write-fully-async-buffer.js | Same spin (124 isolated) |
| test-net-write-fully-async-hex-string.js | Same spin (124 isolated) |

All 13 are pre-existing with reasons unchanged from the v24 triage
(`triage-net-2026-11-14.md` NO-FIX list); the only new member is
boundsocket-transfer-worker, whose barrier is the same C++ transfer
machinery as the other four in F1. No new NO-FIX family appeared in 26.

## New-in-26 vs pre-existing split

- NEW in 26 (3, all absent from the v24.20.0 source pack `test/parallel/`):
  `allow-half-open-async-iter-destroy` (fixable, L3),
  `boundsocket-transfer-worker` (NO-FIX, F1),
  `socket-unref-timer-parent-chain` (fixable, L2).
- PRE-EXISTING (13, all in the vendored v24 set): 12 NO-FIX with unchanged
  reasons (11 files byte-identical to v24; transfer-guards.js gained
  BoundSocket cases, same barriers) + 1 fixable with a NEW failure mode
  (`autoselectfamily-attempt-timeout-default-value`, F6/L1 — upstream
  default 250 → 500, common multiplier ×10 → ×5).
- Net file inventory 24 → 26: 159 → 161 test files (+6 new, −1 removed
  `listen-ipv6only.js`). The 3 other new files all pass; no new test
  family beyond the transfer/half-open/`_unrefTimer` items above.

## Export diff

- `parity/drift/node26-export-diff.md` § net: ADDED `_TransferredBoundSocket`
  only. It is the internal deserialization target for a transferred
  BoundSocket (Node 26 `lib/net.js:606`, exported at `:3002`;
  `_TransferredBoundSocket.prototype = BoundSocket.prototype`). Not public
  API; its only test consumer is `boundsocket-transfer-worker` (NO-FIX, F1).
  No shim action: a browser cannot obtain the `TCP` handle it wraps.
  Changelog cross-check confirms no listed-module change for net in
  25/26.0.0.

## Baseline corrections

1. **Spinner exit codes 129 → 124.** The baseline records 129 for
   `throttle`, `write-fully-async-buffer`, `write-fully-async-hex-string`;
   isolated re-runs (timeout 30, with flags) give 124 with empty output and
   `timeout: sending signal TERM to command 'node'`. 129 is
   `run-baseline.mjs` `runOne`'s signal mapping (`code === null` →
   `128 + 1` for ANY signal), i.e. the `timeout` wrapper died of a signal
   under the parallel run — not a distinct crash mode. Same spin as v24
   (124 isolated, 134/137 sweep artifacts). The baseline jsonc counts all
   three as `fail`, not `timeout` (net `timeout: 0`), which is why the
   gap file lists them as shim-gap with harnessExit 129.
2. **`run-baseline.mjs` omits `// Flags:` — harmless, verified.** `runOne`
   runs `node --import preload <test>` with no flags, while `run-oracle.mjs`
   and `parity/run.mjs` parse and pass them. The omission does not change
   outcomes: Node's `test/common/index.js` detects the missing flags and
   re-spawns the test as a child with them
   (`NOTE: The test started as a child_process using these flags: […]
   Use NODE_SKIP_FLAG_CHECK…`). Verified no-flag vs with-flag: 
...[truncated 2310 chars]