# NOTES-process-identity-adoption.md — wave P1 lane L1

Branch: `fix/process-identity-adoption`. Base main: `8ed96c8d`.
Tests: `test-process-default.js` (flips), `test-process-get-builtin.mjs`
(does NOT flip — structurally unflippable from `src/process.js`; see below).

## Mechanism

`src/process.js` captured the pre-load global as `_priorGlobalProcess`
(:44) but never adopted its own properties, and built `processFinal` as a
fresh object installed as the global (:1164). Two identity gaps followed:

1. Any expando set on the global before the shim loads is lost.
   `test-process-default.js` sets `process.default = 1` on the native
   global, then dynamically imports `node:process` and asserts
   `processModule.default.default === 1` (test:8). On base the shim's
   fresh `process2` has no `.default` → `undefined !== 1`, exit 1.
2. `require('process')` returns a different object from the global the
   test already holds. `test-process-get-builtin.mjs` loop 1 asserts
   `process.getBuiltinModule(id) === require(id)` for every builtin.

## Fix shape (src/process.js only, +~45 lines)

1. **Adoption copy.** After the `processBase` → `processFinal`
   descriptor-preserving copy and before the deprecation toggles, copy the
   prior global's own properties NOT already on `processFinal` onto
   `processFinal`, descriptor-preserving (same pattern as the existing
   copy). Shim-defined properties win — notably `versions`, whose `node`
   must stay `"0.0.0-shim"`. Probe-proven narrow: a pristine native global
   has ZERO own names missing from `processFinal`, so the copy carries
   only user expandos set before load (`default` here). `ponytail:`
   comment in code names the ceiling (one-way, load-time only).
2. **`getBuiltinModule("process")` returns `processFinal`.** Checked
   BEFORE the template delegation, whose cache holds the prior, pre-shim
   process — `require('process')` returns `processFinal`, so identity
   requires the same object here. Other ids unchanged (template, else
   honest `undefined`; never the native bridge).
3. **Global install is now `enumerable: false`.** The native
   `globalThis.process` property is a non-enumerable accessor
   (`enumerable: false, configurable: true` — probed). The shim installed
   it as `enumerable: true`, which trips the official tests' global-leak
   check (`common/index.js` `leakedGlobals`: any for-in-visible global
   whose value is not a known builtin). With the adoption fix, test:8
   passed but the test still exited 1 on the leak check alone; matching
   Node's descriptor flips it. No repo test pins the old enumerability
   (grepped).

## Differential (isolated 2x each; base = scratch worktree at origin/main 8ed96c8d)

| Test | Base | Branch |
|---|---|---|
| test-process-default.js | 1, 1 (test:8 `undefined !== 1`) | **0, 0** |
| test-process-get-builtin.mjs | 1, 1 (test:74 reference inequality) | 1, 1 (same test:74 — see below) |

Guards (branch, 1x each, all exit 0): test-process-env.js,
test-process-exit.js, test-process-hrtime.js, test-process-hrtime-bigint.js,
test-process-next-tick.js, test-process-chdir.js,
test-process-getactivehandles.js, test-process-getactiveresources.js,
test-process-warning.js, test-process-config.js, test-process-argv-0.js,
test-process-emit.js, test-process-emitwarning.js,
test-process-kill-pid.js, test-process-title-cli.js.
L4 .mjs tests unchanged: finalization.mjs 1 (status null), warnings.mjs 1.
Repo suites on branch: tests/process.test.js +
tests/export_surface_process.test.js + tests/process_exit_code.test.js
52/52 pass; tests/ondemand-require.test.js (footprint) 29/29 pass.
Guard note: six first-pick guard names (argv, cwd, memory-usage, title,
kill, emit-warning) do not exist — filename trap, exit 1 was
ERR_MODULE_NOT_FOUND; replaced with real names above, all 0.

## get-builtin.mjs does NOT flip — structural proof (not a fix failure)

Loop 1 (`assert.strictEqual(process.getBuiltinModule(id), require(id))`,
test:74) evaluates its first argument on the STILL-NATIVE global, before
`require('process')` loads the shim mid-argument-list. So at id
`'process'` the comparison is native-global-process vs `process2` — a
reference inequality no fresh-object shim can close. A zz probe
replicating loop 1 with logging (deleted after use) shows: shim loads
exactly during `require('process')` (versions 24.22.1 → 0.0.0-shim); 29
mismatches / 72 ids, starting at `'process'` (gbm object, req object),
then 28 more where the shim's `getBuiltinModule` returns `undefined`
vs native modules. The triage probe's "gbm is undefined" at `'process'`
is an artifact of ITS evaluation order (require first); the test
evaluates gbm first. Branch failure is identical to base: exactly one
AssertionError, test:74, `actual: process {...}` vs
`expected: Object [process] {...}`.

The only shape that closes loop 1 is in-place adoption (`process2` IS
the prior global) — probed and REFUTED: the native global's `argv0`,
`features`, and `exitCode` are non-configurable, so a fresh object is
the only shape that keeps the shim's `argv0 ""`, `exitCode undefined`,
and features key set pinned by tests/process.test.js:165,179,169 (plus
the RTP-override test and real-exit-code side effects on the jest
worker). Fresh object (this lane) and loop-1 identity are jointly
unsatisfiable from `src/process.js` alone. The triage's L1 prescription
("getBuiltinModule('process') returns process2") cannot flip this test
either — it only changes which later assertion would fail. Do NOT reopen
without a harness change (eager shim load before the test's loop, or a
preload change) — both are parent calls, not lane work.

Net lane result: **1 flip (default.js). Process 83 → 84/97.**
The wave ceiling is therefore 94/97, not 95/97, unless the parent
re-triages get-builtin.mjs under a harness change.

## Ship

- PR #460 / Merge SHA: 71cb3eb5
- CI waiter: `hidden_files/pr___-ci-wait.py` pinned to code SHA ___.
- Push: git-push-api.py first try / fallback (record here).
