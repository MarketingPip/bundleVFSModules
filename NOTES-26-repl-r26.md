# NOTES — Node 26 Wave 1, repl lane R-26 (L2 + L4)

- Base: origin/main `d587825d` (PR #506 triage merged). Banked repl:
  **95/108** on the Node 26 suite (`parity/drift/node26-baseline.jsonc`).
- Branch: `fix/26w1-repl-r26`. Worktree: `~/workspace/worktrees/26w1-repl`.
- Scope: NOTES-26-triage-repl.md §C (L2) + §E (L4) only. NOT in scope:
  L1, L3 (Wave 2), `test-repl.js` (util lane, U5), R5 gate (PARKED).
- Harness host: v24.22.1. Node 26 binary for oracle probes:
  `~/workspace/local/node-26/bin/node` (v26.13.1).
- Both flip tests carry `// Flags: --expose-internals`. The baseline
  runner does NOT pass flags headers, so isolated verification below was
  run WITH the flag (as the test declares); both tests ALSO pass without
  it under the harness (common re-spawns the test as a child_process
  with `--expose-internals` itself), so the `run-baseline.mjs` guard run
  exercises both flips too.

## L2 — `test-repl-highlight.js` (FLIP)

- Failure at base (isolated, with flag): exit 1,
  `Error: Cannot find module 'internal/repl/highlight'` (test:8).
  `lib/internal/repl/highlight.js` is NEW in Node 26 (89 lines); host
  v24.22.1 has no such module.
- Fix (3 files + 1 new):
  - `src/internals/repl-highlight.js` (NEW) — faithful port of Node 26
    `lib/internal/repl/highlight.js`. Diffs from Node, all deliberate:
    primordials → plain `.slice` / `.bind`; `internal/deps/acorn` →
    the `acorn` npm dep (already direct; `Parser.tokenizer` uses
    `new this(...)`, so it stays bound to Parser exactly as Node binds
    it); `stylizeWithColor` from `internal/util/inspect` → the shim's
    own (see below); ESM export instead of `module.exports`.
  - The port's `stylizeWithColor` is a LOCAL wrapper over the shim's
    PUBLIC `inspect.styles` / `inspect.colors` (src/util.js:4196-4197)
    — same table and wrap shape, so the test's exact-ANSI assertion
    (`const` cyan, `"text"` green, via the shim's own `inspect.colors`)
    holds. It is deliberately NOT imported from src/util.js: exporting
    it there polluted the node:util surface and failed
    `tests/export_surface_util.test.js` (CI build job, PR #518 first
    run) — fixed in the follow-up commit below.
  - `parity/internal-repl-highlight-adapter.mjs` (NEW) — re-exports the
    port's `highlight` (named + default), following the
    `internal-http-adapter.mjs` precedent.
  - `parity/preload.mjs` — target-scoped redirect only (14 lines):
    `target === "repl" && bare === "internal/repl/highlight"` →
    the adapter. Coordinator-authorized minimal shared-file addition.
- Ceiling (ponytail comment in the port): the shim's REPLServer does
  NOT wire `highlight` in as its readline `colorize` yet (Node 26
  `lib/repl.js:330`); useColors:true input is still rendered plain.
  Wiring it in is a separate behaviour change — the interactive redraw
  path must be proven not to leak ANSI into the ArrayStream transcripts
  the repl tests assert on. The flip test's REPLServer block uses
  `useColors: false` and already rendered plain at base.
- Verification (isolated, `--expose-internals`, PARITY_TARGET=repl):
  exit 0, 2x (`/tmp/r26-highlight-fix1.log`, `-fix2.log`, 0 bytes each).
  Also exit 0 without the flag.

## L4 — `test-repl-top-level-await.js` (FLIP)

- Failure at base (isolated, with flag): exit 1, deepStrictEqual at
  ordinaryTests:206. The shim printed the multi-line stamped form
  (`Promise {\n  456,\n  Symbol(async_id_symbol): 3512,\n
  Symbol(trigger_async_id_symbol): 3503\n}`) while the 26 test asserts
  the WHOLE output is single-line `Promise { 456 }` (test:187).
- Root cause (traced, not symptom): `enablePromiseTrackingOnce`
  (`src/repl.js:54-92`, called once per REPLServer construction) enabled
  a no-op-`init` async_hooks hook process-wide, which is what stamped
  every promise with async ids. Node 26 removed domains
  (`lib/repl.js` has no `domain.create()`; the `domain` option throws
  `ERR_INVALID_ARG_VALUE`), so native 26 no longer stamps promises.
- Fix (`src/repl.js` only): removed the function + its call site,
  replaced with a short note (why it existed, why Node 26 makes it
  wrong, ponytail version-gate note for any future reintroduction).
  The minimal `_domain` stub on REPLServer is KEPT — it is only the
  EventEmitter-shaped surface object, it stamps nothing.
- Blast radius: triage-checked, no other Node 26 repl test mentions
  `async_id`; the full-suite guard below is the empirical check. No
  repo jest test references the stamped form (`grep Symbol(async` in
  tests/ is empty).
- Verification (isolated, `--expose-internals`, PARITY_TARGET=repl):
  exit 0, 2x (`/tmp/r26-tla-fix1.log`, `-fix2.log`, 1820 bytes each =
  the test's own `Testing ...` lines). Also exit 0 without the flag.

## Guard — full repl suite (run-baseline.mjs, --modules repl)

- Command: `node parity/drift/run-baseline.mjs --node26-src
  ~/workspace/local/node-26-src --worktree <worktree> --out
  /tmp/r26-baseline-repl.jsonc --csv-dir /tmp/r26-csv-2026-11-19
  --modules repl --jobs 2 --short 10 --full 30`
- Result: **97/108** (9 fail, 2 timeout) — exactly 95 + 2 flips, 0
  regressions. Diff vs `parity/drift/node26-baseline.jsonc` is exactly
  2 lines: `test-repl-highlight.js` fail→pass,
  `test-repl-top-level-await.js` fail→pass. Output:
  `/tmp/r26-baseline-repl-rerun.jsonc`,
  `/tmp/r26-csv-2026-11-19-rerun/node26-baseline-repl.csv`.
- First guard run scored 96/108 with `test-repl-history-navigation.js`
  fail (exit 1) — a load flake, NOT a regression: the test is
  timing-sensitive (setImmediate keypress choreography + a 1000 ms
  timer, test:500; tmpdir history file), it passed isolated 3x on the
  branch, and it passed in the guard re-run. No mechanism links it to
  this lane (util.js change is a pure additive export; the preload
  redirect fires only for `internal/repl/highlight`, which the test
  never requires; the L4 removal only drops a no-op async_hooks hook).
  First-run output: `/tmp/r26-baseline-repl.jsonc`.
- Non-flip fails/timeouts expected to remain (triage): mode,
  tab-complete-import, tab-complete-require (R5 gate, PARKED); preview
  (NO-FIX, V8 inspector); envvars (NO-FIX, harness stall, 124);
  multiple-instances-async-error, uncaught-exception-after-input-ended,
  user-error-handler (L1, Wave 2); history-init-fail-leak (L3, Wave 2);
  test-repl.js (util lane); tab-complete-nested-repls (host artifact).

## Recovery (2026-11-19/20) — rebase + re-verification on current main

- Original worker was killed by a runtime restart drain after committing
  locally as `925a09a5` (never pushed). Recovery worker verified the
  commit diff matches lane scope exactly (no stray files, worktree clean
  apart from the `node_modules` symlink), then rebased onto current
  origin/main `bb6905b5` (dns #507, vm #509, module #508, buffer #512
  merged since `d587825d`). Rebase was clean, no conflicts; new HEAD
  `1adf978d`. (First `git fetch` hit a transient HTTP/2 stream CANCEL;
  retry succeeded and confirmed `bb6905b5` is current main.)
- Guard on the rebased head (fresh out/CSV):
  `node parity/drift/run-baseline.mjs --node26-src
  ~/workspace/local/node-26-src --worktree <worktree> --out
  /tmp/r26r-baseline-repl.jsonc --csv-dir /tmp/r26r-csv-2026-11-19
  --modules repl --jobs 2 --short 10 --full 30`
  → **96/108** first run: both flips pass, but
  `test-repl-history-navigation.js` failed (exit 1) — the same load
  flake as the original run. Isolated on the rebased head it passed 3x
  (`/tmp/r26r-histnav-{1,2,3}.log`, exit 0 each; note it also carries
  `// Flags: --expose-internals` and passed even without the flag).
- Both flips re-verified isolated 2x on the rebased head, WITH
  `--expose-internals` as declared: highlight exit 0, 2x
  (`/tmp/r26r-highlight-fix{1,2}.log`); top-level-await exit 0, 2x
  (`/tmp/r26r-tla-fix{1,2}.log`).
- Guard re-run (fresh out/CSV `/tmp/r26r-baseline-repl-rerun.jsonc`,
  `/tmp/r26r-csv-2026-11-19-rerun`): **97/108** (9 fail, 2 timeout).
  Diff vs `parity/drift/node26-baseline.jsonc` is exactly 2 lines:
  `test-repl-highlight.js` fail→pass,
  `test-repl-top-level-await.js` fail→pass. 0 regressions.
- Recovery gotcha: `rm -rf parity/node-test` to clear manual isolated
  staging deleted the 3718 TRACKED files under that path (the repo
  commits the Node 24 test tree there); restored with
  `git checkout -- parity/node-test` — never `rm -rf` that path, let
  the runner's restore step handle it.

- CI incident (PR #518, first run on code SHA `e74f2c07`): Parity job
  SUCCESS, Build VFS job FAILURE at the `Run Tests` (jest) step.
  Local repro (`NODE_OPTIONS=--experimental-vm-modules npx jest
  --runInBand --forceExit`, `/tmp/r26r-jest.log`): 6 suites / 9 tests
  failed. Root cause of ONE was this lane: the original
  `export { stylizeWithColor }` in src/util.js polluted the node:util
  surface (`tests/export_surface_util.test.js`: extra export).
  The other five are NOT this lane, proven by running the same six
  suites on a clean main worktree (`/tmp/r26r-main`, `bb6905b5`,
  `/tmp/r26r-main-6suites.log`): perf_hooks, oracle-export-surface,
  constants, export_surface_sys fail identically on main (host
  v24.22.1 vs the v24.20.0-captured expectations — e.g. sys
  re-exports the REAL node:util, which gained debounce/throttle in
  24.22.1; oracle lists new 24.22.1 crypto/util APIs the shim lacks);
  timers passed on main, so its branch failure (setInterval fired 2x
  not 3x in 50 ms) is a load flake; export_surface_util PASSED on
  main, confirming it as this lane's regression. (Main's CI is green
  on bb6905b5 because CI pins Node 24.20.0, where the host-version
  artifacts do not occur.)
- Fix (follow-up commit): `stylizeWithColor` is now a LOCAL wrapper in
  src/internals/repl-highlight.js over the shim's PUBLIC
  `inspect.styles` / `inspect.colors` — same tables, same output, no
  util.js export. Re-verified: highlight isolated 2x exit 0
  (`/tmp/r26r2-highlight-fix{1,2}.log`), tla exit 0
  (`/tmp/r26r2-tla.log`); targeted jest
  (export_surface_util, export_surface_repl, repl, util_named_exports,
  export_surface_util_types) 5 suites / 21 tests PASS.
- CI log fetch blocked: `gh-logs.py` 401s on `custom.github-tibia`
  ("Bad credentials") and the `gh.py` job-logs fetch hit an approval
  card that timed out unanswered — NOT retried (needs user action).
  Diagnosis above came from the local jest repro instead.

## Files changed

- `src/internals/repl-highlight.js` (new, 100 lines)
- `parity/internal-repl-highlight-adapter.mjs` (new)
- `parity/preload.mjs` (+14, redirect lines only)
- `src/repl.js` (-29 net: enablePromiseTrackingOnce removal)
- `src/util.js` (+5: `export { stylizeWithColor }`)
- `NOTES-26-repl-r26.md` (this file)
- No docs-number changes. No `dist/` changes. No baseline changes.
