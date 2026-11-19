# NOTES-26-net-l1l3 — Node 26 Wave 1 lane NET L1–L3

Base: origin/main `d587825d` (PR #506 triage merged). Banked net count on the
Node 26 suite: **145/161**. Lane ceiling: 145 + 3 = **148/161 (91.9%)**.

## L1 — Happy-eyeballs default 250 → 500 (1 flip)

- Target: `test-net-autoselectfamily-attempt-timeout-default-value.js`
  (baseline: fail, exit 1 — `actual: 1250, expected: 2500`).
- Root cause: Node 26 raised the `--network-family-autoselection-attempt-timeout`
  option default 250 → 500 (`node-26-src/lib/net.js:160`,
  `src/node_options.cc:730`); Node 26 `test/common` multiplies by ×5, so
  500×5 = 2500. Oracle probe: Node 26.13.1
  `require('net').getDefaultAutoSelectFamilyAttemptTimeout()` → `500`
  (host Node v24.22.1 → `250`).
- Change: `src/net.js:937` `defaultAutoSelectFamilyAttemptTimeout = 250` → `500`.
- Repo assertion updated: `tests/net.test.js:290` `toBe(250)` → `toBe(500)`,
  plus the restore at `:306` (250 → 500, same default — the `:304` clamp
  case 5 → 10 is untouched).
- No other Node 26 net test asserts `250` among the autoselectfamily tests;
  the CLI-flag seed (`src/net.js:939-961`) and `setDefault*` validation are
  untouched.

## L2 — Port `Socket.prototype._unrefTimer` (1 flip)

- Target: `test-net-socket-unref-timer-parent-chain.js` (NEW in 26; baseline:
  fail, exit 1 — `TypeError: socket._unrefTimer is not a function`).
- Root cause: the shim defined no `_unrefTimer` anywhere (0 hits in `src/`).
  Regression test for nodejs/node#64490.
- Change: `src/net.js:1447-1455`, porting Node 26 `lib/net.js:800-807`
  verbatim against the shim's existing `kTimeout` slot (`src/net.js:1248`):
  walk `s._parent` with a loose `!= null` check, `refresh()`ing `s[kTimeout]`.
  Placed directly after the `Socket.prototype` chain setup, as in Node 26.
- The `destroy()` half of the test (Block 2, `_parent === undefined`) already
  worked pre-fix; the shim's `_destroy` never reads `_parent`.

## L3 — Drop the `preserveHalfOpenDuplex` carve-out (1 flip, net)

- Target: `test-net-allow-half-open-async-iter-destroy.js` (NEW in 26;
  baseline: fail, exit 1 — `destroyed` false, expected true at `:52`).
- Root cause: Node 26 removed the half-open preservation from the stream
  async iterator (`lib/internal/streams/readable.js:1611-1623`, `finalize()`
  destroys unless `options?.destroyOnReturn === false`). The shim had ported
  the v24 shape verbatim, including the carve-out
  (`src/stream/readable.js:1432-1441`).
- Change: `src/stream/readable.js:1432-1441` — carve-out removed; the
  `finally` block now matches Node 26 `finalize()` exactly.
- Coordination (shared stream infrastructure — required, not optional):
  the vendored v24 stream test
  `test-stream-readable-async-iter-half-open-duplex.js` asserted
  `destroyed === false` after PLAIN `for await` and passed only because of
  the carve-out. Updated in this PR to the Node 26 shape —
  `duplex.iterator({ destroyOnReturn: false })` — the only semantic line
  changed, matching Node 26's version of the file. The same one-line update
  was applied to the vendored net sibling
  `test-net-allow-half-open-async-iter.js` (`:52`), which asserts
  `destroyed === false` after plain `for await` for the same reason; its
  client-socket loop (`:71`) is unchanged in Node 26 and stays plain.
  Landing L3 without these two updates would regress the v24 vendored
  stream/net suites.

## Verification

- Syntax: `node --check src/net.js src/stream/readable.js` — OK.
- Repo tests: `NODE_OPTIONS=--experimental-vm-modules npx --no-install jest
  tests/net.test.js` — 78/78 pass.
- Differential (Node 26 test files under the parity harness, via
  `parity/drift/run-baseline.mjs --modules net,stream --jobs 2`, two full
  runs, fresh CSV dirs each run — `/tmp/node26-net-l1l3-run1.jsonc` and
  `/tmp/node26-net-l1l3-run2.jsonc`, module JSON identical across runs):
  - Net: **148/161** in both runs (baseline 145/161). All three targets
    exit 0 in both runs; zero regressions — the 13 remaining non-passes
    are exactly the 13 baseline fails minus the 3 flips. (The three
    throttle/write-fully tests read exit 124 in the runs vs 129 in the
    baseline; per triage § Baseline corrections that 129-vs-124 delta is
    a runner artifact, same fail status either way.)
  - Stream: **180/232** in both runs, identical to baseline 180/232 —
    zero regressions, zero changes. Guard held.
  - Vendored guard: `test-stream-readable-async-iter-half-open-duplex.js`
    (Node 26 shape) exits 0 in the stream run in both runs, and the
    vendored net sibling `test-net-allow-half-open-async-iter.js` exits 0
    in the net run in both runs.
- No `// Flags:` headers on any of the three target tests (checked heads) —
  no flag handling needed; run-baseline's Flags gap does not apply here.
- No `zz-*.js` probes left behind (isolated pre-fix runs used staged copies
  under `/tmp`, deleted).

## Files changed (5)

- `src/net.js` — L1 default 250 → 500; L2 `_unrefTimer` port.
- `src/stream/readable.js` — L3 carve-out removal.
- `tests/net.test.js` — default assertion + restore 250 → 500.
- `parity/node-test/parallel/test-stream-readable-async-iter-half-open-duplex.js`
  — Node 26 shape (`iterator({ destroyOnReturn: false })`).
- `parity/node-test/parallel/test-net-allow-half-open-async-iter.js`
  — Node 26 shape (server-socket loop only).

## Result

**3/3 flips landed, 2x verified. New net count: 148/161 (91.9%).**
No regressions in the net or stream 26-suite pass sets.

## Recovery — rebase + re-verification (2026-11-20, worker killed by restart drain)

- Original local commit `25969ffc` (on `d587825d`) verified intact: same
  6 files, same diff, worktree clean apart from the `node_modules` symlink.
- Rebased cleanly onto current origin/main `bb6905b5` (dns #507, vm #509,
  module #508, buffer #512 merges) — zero conflicts. New head `913ba9bc`.
- Re-verification on the rebased head (fresh out/CSV each run):
  - `parity/drift/run-baseline.mjs --modules net,stream --jobs 2`, run 1
    (`/tmp/node26-net-l1l3-rebase-run1.jsonc`,
    `/tmp/node26-net-l1l3-rebase-csv1`) and run 2
    (`/tmp/node26-net-l1l3-rebase-run2.jsonc`,
    `/tmp/node26-net-l1l3-rebase-csv2`): **net 148/161, stream 180/232 in
    both runs; module JSON identical across runs.** Net: exactly the 3
    targets fixed vs the `d587825d` baseline, zero new non-pass. Stream:
    identical to baseline (180/232), zero changes. The 3 net timeouts
    (throttle, write-fully-async-buffer/-hex-string) read exit 124 in
    phase 2 vs 129 in the baseline — same runner artifact as before,
    same fail status.
  - Isolated runs (Node 26 `common/`+`fixtures/` staged, absolute preload
    path, `PARITY_TARGET=net|stream`, 30 s cap; staged files removed and
    `parity/node-test/` restored to committed state after): all 3 targets
    exit 0, vendored stream guard
    `test-stream-readable-async-iter-half-open-duplex.js` exit 0,
    vendored net guard `test-net-allow-half-open-async-iter.js` exit 0.
    (First isolated attempt exited 1 for all five — my own error:
    `--import parity/preload.mjs` resolves as a package; the runner uses
    the absolute preload path. Not a code failure.)
  - Repo suite: `NODE_OPTIONS=--experimental-vm-modules npx --no-install
    jest tests/net.test.js` — **78/78 pass** on the rebased head.
- No `// Flags:` headers on any target test; no `zz-*.js` probes left.
