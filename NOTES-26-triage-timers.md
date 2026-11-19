# NOTES-26-triage-timers.md

Node 26.13.1 re-target triage — `timers`. DOCS ONLY, no `src/` change.
Worktree: `~/workspace/worktrees/node26-triage-misc-small`, base `3c091022`.
Node 26 binary verified before probing: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
Host Node (harness runtime): `v24.22.1`. Node 26 source: `~/workspace/local/node-26-src/`.

## Counts

- Baseline (28-module): timers 59 total, 58 pass, 1 fail, 0 timeout.
- Oracle: 1 shim-gap, 0 fails-natively, 0 native-timeout.
- **Gap stays 1 — and it is a harness artifact, not a shim gap.**
- v24 ceiling: 45/45 (100%). The one failing test is NEW in 26.
- Export diff: timers has NO export-surface change. Changelog
  cross-check: no `timers` behaviour rows in 25/26.0.0.

## Gap list (the 1 test, harnessExit / nativeExit from gaps-timers.json)

| test | harness | native | vendored in v24? |
| --- | --- | --- | --- |
| test-timers-immediate-unref-simple.js | 1 | 0 | **no — NEW in 26** |

Isolated re-run (staged Node 26 `test/parallel + common + fixtures`,
`timeout 30 node --import <abs preload> parity/node-test/parallel/<test>`,
`PARITY_TARGET=timers`, per `parity/drift/run-baseline.mjs`): exit 1
reproduced exactly. Probe logs: `~/workspace/node26-misc-probes/`.

## The test

`~/workspace/local/node-26-src/test/parallel/test-timers-immediate-unref-simple.js`
(verbatim):

```js
const common = require('../common');
const { isMainThread } = require('worker_threads');
if (!isMainThread) {
  // Note that test-timers-immediate-unref-nested-once works instead.
  common.skip('Worker bootstrapping works differently -> different timing');
}
// This immediate should not execute as it was unrefed
// and nothing else is keeping the event loop alive
setImmediate(common.mustNotCall()).unref();
```

Harness failure: the `mustNotCall` immediate FIRES —
`AssertionError [ERR_ASSERTION]: function should not have been called`,
at `test-timers-immediate-unref-simple.js:13` (harness stderr). The
test's premise is "nothing else is keeping the event loop alive". Under
the harness, that premise is false.

## Family

### F1 — Harness keeps the event loop alive (1 test) — NO-FIX, harness artifact

- Classification: not a shim gap. The shim's `unref` is correct — it
  delegates to the native handle (`src/timers.js:174-176`,
  `unref() { this._native.unref(); }`; `setImmediate` wraps the native
  immediate at `:303-305`). The immediate runs because something ELSE
  holds the loop open, and the shim cannot unref the harness's handles.
- Mechanism, PROVEN with a minimal one-liner
  (`setImmediate(() => console.log('FIRED')).unref()`, `timeout 10`):
  | condition | result |
  | --- | --- |
  | plain `node` (no `--import`) | silent, exit 0 (immediate never runs) |
  | `--import <empty .mjs>` | silent, exit 0 |
  | `--import <parity/hooks.mjs>` (no `register()`) | silent, exit 0 |
  | `--import <register-only.mjs>` calling `register('./hooks.mjs')` | **FIRED** |
  | `--import <parity/preload.mjs>` (`PARITY_TARGET=timers`) | **FIRED** |
  The live handle is the preload's registered ESM hooks worker
  (`register('./hooks.mjs', …)` in `parity/preload.mjs`, the
  `AsyncLoaderHookWorker` — one hooks thread per thread). Importing
  `hooks.mjs` without `register()` does not reproduce it; `register()`
  alone does. The hooks worker keeps the event loop alive, so the
  unrefed immediate gets to run before the process can exit.
- The vendored v24 sibling `test-timers-immediate-unref.js` passes
  because it does other work first (its setup keeps the loop alive
  legitimately and the assertions are ordered around it); only this
  minimal "nothing else alive" shape exposes the harness handle.
- No lane. Any "fix" would have to remove the harness's own hooks
  worker (which the preload needs for ESM redirects) or run the test
  without the preload (which would measure native Node against native
  Node — scoring inflation, same class as the declined async-hooks
  no-preload route in HITLIST row 70).

## Lane candidates

None. Estimated flips: **0**.

## NO-FIX list (1)

1. test-timers-immediate-unref-simple.js — harness artifact: the
   preload's registered ESM hooks worker thread holds the event loop
   open, so the unrefed immediate fires. Proven by the minimal-probe
   table above (fires under `register()`-only, silent without it).
   The shim's `setImmediate`/`unref` implementation is correct.

## New-in-26 vs pre-existing

- **NEW in 26 (1):** the failing test itself. All 45 vendored v24
  timers tests pass under the Node 26 baseline (58/59 = the 45 vendored
  + 13 of 14 new files; the only new-file failure is this one).
- **Pre-existing (0 gaps).** timers was 100% in v24 and no vendored
  timers test regressed in 26.

## Baseline corrections

- None for timers: the isolated re-run reproduces the baseline exit
  exactly (1).
- Classification correction for the record: the oracle calls this a
  "shim-gap" (native 0, harness 1), but the probe table proves the
  cause is the harness's own live handle, not the shim — the
  `shim-gap` label is a measurement artifact here, not a work item.
  If the program's shim-gap count is ever recomputed on mechanism
  rather than exit codes, this test (and the heap-profile-style
  host/harness artifacts in the worker_threads triage) are the
  candidates for reclassification — but per this task's banked numbers
  the count stands.
