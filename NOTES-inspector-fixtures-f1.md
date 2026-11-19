# NOTES — inspector fixture gap (I-F1)

Triage: `hidden_files/triage-inspector-2026-11-18.md` (base main `327b0226`).
Banked count on base: 30/75. This lane: +3 flips → **33/75**.

## Root cause

Four fixture files were absent from the vendored tree (all present in the
Node v24.20.0 tarball). Three of them blocked tests that pass once the
fixture exists; the fourth unmasks the test's real (protocol) failure.

## Files vendored (verbatim from the tarball, cmp-verified byte-identical)

| File | Size | Test it unblocks |
|---|---|---|
| `parity/node-test/fixtures/printB.js` | 17 B | `test-inspector.js` — was `Cannot find module '../fixtures/printB.js'` (test:179) |
| `parity/node-test/fixtures/test-inspector-dom-storage.mjs` | 4411 B | `test-inspector-dom-storage.js` — was `Cannot find module '.../fixtures/test-inspector-dom-storage.mjs'` |
| `parity/node-test/fixtures/inspector-open.js` | 385 B | `test-inspector-open-coverage.js` — spawned native child hit `MODULE_NOT_FOUND` |
| `parity/node-test/fixtures/overwrite-config-preload-module.js` | 129 B | `test-inspector-overwrite-config.js` — was missing `--require` module; flips 0 (see below) |

Note: `test/` is a symlink to `parity/node-test/` in this repo, so
`test/fixtures/overwrite-config-preload-module.js` and
`parity/node-test/fixtures/overwrite-config-preload-module.js` are the
same file. All four paths live under `parity/node-test/fixtures/` and
are gitignored there — `git add -f` was required.

Deliberately NOT vendored: the `parity/node-test/fixtures/typescript/`
tree (86 files) — the triage proved it flips nothing for
`test-inspector-strip-types.js` (native still 1 with all 86 files).

## Flips (2× isolated on branch, native 0 as control; base exit 1)

- `test-inspector.js`: branch `0 0`, base `1`, native `0`
- `test-inspector-dom-storage.js`: branch `0 0`, base `1`, native `0`
- `test-inspector-open-coverage.js`: branch `0 0`, base `1`, native `0`

## Non-flip (unmask only)

- `test-inspector-overwrite-config.js`: branch `1`, native `0`. With the
  fixture the first failure becomes `log statement did not reach the
  inspector` — it needs a real `Runtime.consoleAPICalled` protocol event
  (family A, NO-FIX). Vendored so the test is measurable.

## Differential (branch vs pristine main `327b0226`)

- The 3 flips: branch `0 0` ×2 each; base `1` each.
- Full 30-test pass set (29 glob passes from the triage sweep CSV +
  `test-inspector-wait.mjs`): branch 30/30, base 30/30 — **0 regressions**.
- Footprint test `tests/ondemand-require.test.js`: 29/29.

## Triage correction (found in-lane)

**Correction (parent-verified 2026-11-18, docs sync):** the "correction"
above is itself WRONG and is retracted. The vendored
`test-inspector-connect-to-main-thread.js` is ~200 lines, and the test
FAILS [1,1] isolated on the triage base, the post-F1 base, and the
post-V1 main — it was never in the 30-test pass set. Under V1 its
failure moved from the validation assertion to the live-delivery
assertions (:190 mustCall 0/1; :196 counter 0 !== 2) — progress, not
regression. The triage's NO-FIX classification stands: the test needs
real worker sessions + `Runtime.evaluate` results and cannot flip.
The I-V1 `connectToMainThread()` `ERR_INSPECTOR_NOT_WORKER` throw is
still worth implementing for oracle fidelity, but no vendored test
asserts it — it flips 0 on its own.

## Ship

- PR #502
- Merge SHA: 6b331aac
