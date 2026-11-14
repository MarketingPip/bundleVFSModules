# Net state getters — NOTES-net-state-getters.md

Branch: `fix/net-state-getters` (base main `3199bb5d`).
Lane: net triage 2026-11-14, lane 10 (state getters) — 2 flips.

## Targets

- `test-net-buffersize.js` — 1 → 0
- `test-net-socket-connecting.js` — 1 → 0

## Mechanism

Both are one-line ports of Node `lib/net.js` (v24.20.0 source pack):

1. `bufferSize` getter (`src/net.js`, was `:1215`): returned
   `writableLength` only when `_connected`. Writes happen pre-connect
   (the test writes 9 bytes synchronously after `net.connect()` returns,
   while the socket is still connecting), so the getter read `undefined`.
   Node `lib/net.js:980`: `if (this._handle) return this.writableLength`.
   The shim's `_handle` exists from `connect()` (`src/net.js:1697`,
   `new VirtualHandle()`), i.e. through the whole connecting window —
   changed the predicate to `this._handle`.
2. `_connecting` alias: the shim had no `_connecting` at all, so
   `client._connecting` read `undefined` (the test's legacy getter).
   Node `lib/net.js:947-951` defines `Socket.prototype._connecting` as a
   getter returning `this.connecting`. Added the same getter to the
   `Object.defineProperties(Socket.prototype, …)` block, in the block's
   existing style (`enumerable: true, configurable: true`).

No other files touched. No preload/harness change.

## Verification

- Both targets reproduced 1 on base before the fix
  (`buffersize: undefined !== 1`; `socket-connecting: undefined !== true`),
  then 0 after.
- Isolated re-runs on the branch, 2× each: both 0, 0.
- Guards (all 0 on the branch): `test-net-after-close`,
  `test-net-pingpong`, `test-net-connect-call-socket-connect`,
  `test-net-connect-no-arg`, `test-net-socket-close-after-end`,
  `test-net-socket-connect-without-cb`, `test-net-connect-immediate-finish`,
  `test-net-connect-destroy`.
- Differential: fast-sweep `--target net` branch CSV
  `hidden_files/fast-sweep/net-n1-state-getters-branch-2026-11-14.csv`
  vs triage base CSV `net-sweep-2026-11-14.csv` (same base `3199bb5d`):
  exactly 2 toward pass, 0 regressions (see PR body for the diff lines).

## Differential (matched changed-value lines)

- `test-net-buffersize.js,1` → `test-net-buffersize.js,0`
- `test-net-socket-connecting.js,1` → `test-net-socket-connecting.js,0`

Sweep totals: base 87 pass → branch 88 pass (156 rows). The sweep flagged
one apparent regression, `test-net-listen-handle-in-cluster-2.js`
(0 → 124): adjudicated as sweep-timeout noise — it passes 0×3 isolated
on the branch (cluster test under the 58-file phase-2 load). The two
mode changes (`test-net-throttle.js` 134 → 124,
`test-net-write-fully-async-buffer.js` 137 → 124) are the known
pre-existing spinner artifacts (same spin, different kill code).
