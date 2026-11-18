# NOTES-process-fixture-vendoring.md — L4 (wave P1)

## Lane
L4 — fixture/doc/deps vendoring (vendored tree ONLY). No `src/` or
`parity/preload.mjs` changes. All files taken from the local SHA256-verified
Node v24.20.0 tarball
(`hidden_files/node-src/node-v24.20.0.tar.gz`); nothing fetched from the web.

## Mechanism
Each target failed because a file the test (or its spawned child) reads did
not exist in the vendored tree — the test never touches the shim.

## Files vendored (tarball path -> vendored path)
- `test/addons/not-a-binding/` (`binding.gyp`, `not_a_binding.c`, `test.js`)
  -> `parity/node-test/addons/not-a-binding/` — dlopen-error-message-crash:
  `fs.accessSync` on the dir must succeed; the `.node` file is absent from
  the tarball too, so `copyFileSync` then throws ENOENT and the test takes
  its `common.skip('addon not found')` path.
- `test/fixtures/dotenv/basic-valid.env`
  -> `parity/node-test/fixtures/dotenv/basic-valid.env` — load-env-file.
- `test/fixtures/dotenv/.env` -> `parity/node-test/fixtures/dotenv/.env` —
  load-env-file "supports not-passing a path". The triage doc said this file
  already existed; it did not (`ls -a` shows only `basic-valid.env` and
  `valid.env` before this lane). Found in the tarball, vendored here.
- `test/fixtures/warnings.js` -> `parity/node-test/fixtures/warnings.js` —
  redirect-warnings x2.
- `test/fixtures/uncaught-exceptions/uncaught-monitor1.js`,
  `uncaught-monitor2.js` -> same under
  `parity/node-test/fixtures/uncaught-exceptions/` — uncaught-exception-monitor.
- `test/fixtures/process/` (all 6 `.mjs`: `close`, `before-exit`,
  `finalization-cleanup`, `gc-not-close`, `unregister`,
  `different-registry-per-thread`) -> `parity/node-test/fixtures/process/`
  (new directory) — finalization.mjs.
- `test/fixtures/disable-warning.js`, `disable-warning-worker.js` ->
  `parity/node-test/fixtures/` — warnings.mjs.

Precedent: the util wave fetched 2 missing fixtures; the vm wave vendored
`parity/node-test/fixtures/es-modules/message.mjs`.

## Flips — 5 of 7
Isolated 2x each on branch (all exit 0), plus full-sweep confirmation below.
Base exits are the triage's 2x isolated reproductions (all exit 1).

1. `test-process-dlopen-error-message-crash.js` 1 -> 0.
2. `test-process-redirect-warnings.js` 1 -> 0.
3. `test-process-redirect-warnings-env.js` 1 -> 0 (ADJUDICATED — see below).
4. `test-process-finalization.mjs` 1 -> 0 (via `sweep-mjs.py`).
5. `test-process-warnings.mjs` 1 -> 0 (via `sweep-mjs.py`).

Branch full sweeps (`--jobs 2`, fresh filenames):
- `.js`: `hidden_files/fast-sweep/process-p3-branch.csv` — 85 pass / 9 fail
  (base 83 pass / 11 fail). Changed rows vs triage
  `process-sweep-2026-11-18.csv`: dlopen 1->0, redirect-warnings 1->0.
  Zero regressions.
- `.mjs`: `hidden_files/fast-sweep/process-p3-branch-mjs.csv` — 2 pass / 1 fail
  (base 0 pass / 3 fail). Changed rows: finalization 1->0, warnings 1->0.
  `test-process-get-builtin.mjs` stays 1 on base AND branch (another lane's
  target, not a regression).
- Recorded sweep total on branch: 87/97. True total with the adjudicated
  redirect-warnings-env flip: **88/97** (83 + 5).

## Adjudication: redirect-warnings-env (sweep 1, isolated 0)
Two full branch sweeps record it 1; it passes isolated 5x, in the targeted
`sweep-mjs`-style re-check (`process-p3-rwe-check.csv`), and 10/10 concurrent
runs with distinct `TEST_THREAD_ID`s. Root cause, proven from the code and a
failure log: `common/tmpdir.js` names the tmpdir `.tmp.<TEST_THREAD_ID||0>`,
so with no `TEST_THREAD_ID` set (fast-sweep sets none) every parallel test
shares `parity/node-test/.tmp.0`. Both redirect-warnings tests
`tmpdir.refresh()` (`rm -rf .tmp.0`) and use the same filename
`warnings.txt`. The sibling's refresh deletes the file between this test's
child writing it and the parent reading it; the log shows exactly
`ENOENT ... .tmp.0/warnings.txt` at the `readFile` in the exit handler.
Reproduction: concurrent runs with distinct `TEST_THREAD_ID` values 0/10
failures; concurrent runs sharing `.tmp.0` 10/10 failures of the env test
(plain test 0/10). Real Node CI sets `TEST_THREAD_ID` per worker, so this
is a sweep-harness artifact, not a test failure.
`ponytail:` follow-up for the parent, NOT this lane: fast-sweep should set a
distinct `TEST_THREAD_ID` per parallel job (or run tmpdir-sharing tests
serially); any test pair sharing `.tmp.0` and a filename races the same way.

## NOT flipped — 2, reported honestly (triage caveat: children + preload)
1. `test-process-load-env-file.js` — STILL exit 1. Vendoring fixed the
   fixture half: 5/6 subtests now pass (incl. "supports not-passing a path"
   once `.env` was vendored). The remaining subtest, "should throw when
   `.env` does not exist", does `process.chdir(join(process.cwd(), "lib"))`;
   the repo root has no `lib/` (in the real Node repo that is Node's own
   source dir), so the chdir itself throws ENOENT. Proven: the test passes
   6/6 natively when run from a directory containing `lib/`. This is a
   repo-layout gap, not vendoring — Node's `lib/` cannot be vendored, and a
   stub `lib/.gitkeep` at repo root would fail the footprint pattern rule.
   Needs a harness/layout decision (parent's call).
2. `test-process-uncaught-exception-monitor.js` — STILL exit 7. The vendored
   monitor fixtures now load, but the main-process monitor handler receives
   origin `'unhandledRejection'` instead of `'uncaughtException'`. Proven
   with a minimal probe (`zz-monitor-origin.js`, deleted after use): native
   run gives origin `uncaughtException`; ANY `node --import <ESM>` run —
   even an empty module with no hooks registered — gives
   `unhandledRejection`, because `--import` routes the entry point through
   the ESM loader and a top-level throw becomes a rejected module-evaluation
   promise. This is a property of the parity harness invocation itself
   (`node --import ./parity/preload.mjs ...`), not of the fixtures and not
   of the preload's redirects. Needs a harness decision (parent's call);
   out of scope for a vendoring-only lane.

## Guards
- The 7 targets isolated 2x on branch: 5 at 0, load-env-file at 1 (5/6
  subtests), uncaught-exception-monitor at 7 (origin mismatch, proven above).
- Full branch sweeps show zero regressions vs the triage CSVs (only the 4
  sweep-visible flips changed; get-builtin unchanged 1).
- Repo suite: `tests/ondemand-require.test.js` 29/29 locally (footprint
  pattern: all new files are under `parity/node-test/`).

## Ship
- Branch: `fix/process-fixture-vendoring`
- PR #___ / Merge SHA: ___
