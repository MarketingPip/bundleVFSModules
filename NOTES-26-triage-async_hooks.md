# NOTES-26-triage-async_hooks — Node 26.13.1 drift triage (async_hooks)

- Base: `3c091022` (worktree `~/workspace/worktrees/node26-triage-core-small`).
- Scope: 7 gap tests, all class `shim-gap` in
  `hidden_files/node26-triage/gaps-async_hooks.json`, nativeExit 0 for all 7.
- Node 26 binary verified: `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
- Method: same as NOTES-26-triage-buffer.md — staged the Node 26 test tree
  over `parity/node-test/`, re-ran each gap with the exact
  `parity/drift/run-baseline.mjs` invocation (`PARITY_TARGET=async_hooks`,
  timeout 10 s). All 7 reproduced. Tree restored after;
  `git status -- parity/node-test` clean.
- Export diff (`parity/drift/node26-export-diff.md`): async_hooks has NO
  export-surface change. Changelog cross-check: 25.0.0 removed the
  `asyncResource` property on bound functions — no gap test covers it.
- Headline: the 7 gaps are EXACTLY the v24 7. Same tests, same failure
  signatures, same mechanism, re-verified in the current tree. No lanes.
  Ceiling 29/36 stands.

## The 7 — same as v24 (see `hidden_files/triage-async-hooks-2026-11-18.md`)

The v24 triage (2026-11-18, parent-verified) closed async_hooks at
29/36 with 7 failures, all attributed to the PRELOAD's own
async-resource creation, and the no-preload route DECLINED. The 26
baseline's 7 are the identical set (same filenames, same categories
in the v24 triage doc lines 39-74):

| # | Test (exit 1, isolated re-run) | v24 category | 26 signature |
|---|---|---|---|
| 1 | `test-async-hooks-promise-triggerid.js` | ID SHIFT | `0 !== 1` at test line 18, init hook: triggerAsyncId mismatch (`emitInitNative`, `promiseInitHook`, `Promise.resolve`) |
| 2 | `test-async-hooks-promise.js` | ID SHIFT | `14 !== 15` at test line 20, promiseResolve hook |
| 3 | `test-async-hooks-enable-before-promise-resolve.js` | EXTRA INVOCATIONS (flaky in v24: fails 3/4) | `Mismatched noop function calls. Expected exactly 2, actual 5` |
| 4 | `test-async-hooks-disable-during-promise.js` | EXTRA INVOCATIONS | `Mismatched noop function calls. Expected exactly 2, actual 4` |
| 5 | `test-async-hooks-enable-recursive.js` | EXTRA INVOCATIONS | `Expected exactly 1, actual 3` and `Expected exactly 2, actual 4` (two mustCalls) |
| 6 | `test-async-hooks-correctly-switch-promise-hook.js` | EXTRA SEQUENCE ENTRIES | deep-equal diff: extra `PROMISE` entries (`after: false, before: false, init: true, promiseResolve: true` and a duplicate full entry) |
| 7 | `test-async-hooks-top-level-clearimmediate.js` | ID SHIFT | `0 !== 1` at test line 21, init hook (`initAsyncResource`, `new Immediate`, `setImmediate`) |

## Mechanism — re-verified in the current tree (not re-asserted from memory)

Probe (`probe-ids.mjs`: `createHook({init(id, type, trigger){...}})` +
`await Promise.resolve()`, run under the current preload):
- Plain node, no preload: first PROMISE `init 3 <- 0`.
- With parity preload (`PARITY_TARGET=async_hooks`,
  `node --import ./parity/preload.mjs`): first PROMISE `init 13 <- 0`
  (+10, deterministic), followed by `15 <- 13`, `17 <- 16`.

This is the v24 finding exactly (first promise id 3 → 13; CJS path:
native `3<-1` vs preload `13<-0` plus extra promises). The preload's
own module tree + `register("./hooks.mjs")` creates async resources
before any test code runs; the tests assert exact async IDs and exact
hook-invocation counts, so the pre-existing resources shift every
number. No src/ change can un-create resources that exist before the
test runs; importing the shim itself costs 0 IDs (v24 probe P7, and
the als-browser-attribution refutation in the v24 triage — the old
"als-browser module-eval side effects" mechanism was probe-refuted and
must NOT be re-recorded).

## Families
- One family only: **preload ID-shift / extra invocations (7)**.
  Classification: fixture/harness gap (the harness itself, not the
  shim). The shim's own behavior is not implicated by any of the 7
  signatures — the same tests run against the native module under the
  preload fail identically (v24 triage: all 7 reproduce [1,0]
  shim/native).

## Lane candidates
- None. The only route that would flip these 7 is running them
  WITHOUT the preload — a harness-architecture / scoring decision for
  the parent, already DECLINED in the v24 triage. Do not re-propose it
  as a lane. `tests/async_hooks.test.js` (Jest) is 39/39 green and
  unaffected.

## NO-FIX list (7 — all preload-architecture, not browser limits)
- `test-async-hooks-promise-triggerid.js` — ID shift (preload +10).
- `test-async-hooks-promise.js` — ID shift (preload +10).
- `test-async-hooks-enable-before-promise-resolve.js` — extra
  invocations from preload resources (flaky in v24).
- `test-async-hooks-disable-during-promise.js` — extra invocations.
- `test-async-hooks-enable-recursive.js` — extra invocations.
- `test-async-hooks-correctly-switch-promise-hook.js` — extra PROMISE
  sequence entries from preload resources.
- `test-async-hooks-top-level-clearimmediate.js` — ID shift.

## New-in-26 vs pre-existing
- All 7 test files are VENDORED (pre-existing). The files were
  reorganized in 26 (e.g. chained `.createHook({...})` → named
  `const hook = async_hooks.createHook({...})`, extra
  `Promise.resolve(1).then(...)` wrapping) but the expected hook
  counts and ID assertions are unchanged, and the re-run failure
  signatures match the v24 triage categories exactly.
- NEW in 26: 0. PRE-EXISTING: 7.

## Baseline corrections
- None. All 7 reproduce as classified; the `shim-gap` class is
  accurate in the narrow sense (they fail under the shim) but the
  adjudication is harness-caused, per the v24 triage — carry the
  29/36 ceiling forward unchanged.
