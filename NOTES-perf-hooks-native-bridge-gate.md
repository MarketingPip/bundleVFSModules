# NOTES — perf_hooks native-bridge gate alignment (P1)

Wave P, lane P1. Base main `ef157e95`. Recorded perf_hooks 13/15 (verified
TRUE by the wave-P triage).

## What changed

`src/perf_hooks.js` only (+18/−5): the native-bridge gate at :55-70 no
longer requires `typeof globalThis._RUNTIME_ === "undefined"`. It now
delegates whenever the genuine builtin is available and
`__PERF_HOOKS_NO_NATIVE__` is unset — the util (`src/util.js:523-527`) /
worker_threads (`src/worker_threads.js:154-169`, `getNativeWorkerThreads()`)
pattern. The preload's `_RUNTIME_ = { parityForceShim: true }` marker
(`parity/preload.mjs:30-42`) is untouched.

Plus one new condition in the same gate: a self-delegation guard,
`candidate.createHistogram !== createHistogram` (see below).

## Mechanism (why the gate was the sole blocker)

Under the harness, `process` IS native and
`process.getBuiltinModule('perf_hooks')` IS the genuine builtin — the
`_RUNTIME_` check was the only thing keeping the bridge off (triage-proven,
parent-verified). Both failing tests need primitives pure JS cannot provide:

- `test-perf-hooks-histogram.js` (first failure test:87): `postMessage(h)`
  throws DataCloneError for the pure-JS `RecordableHistogram`. The native
  histogram is a V8 host object with shared-state structured serialization
  (`lib/internal/histogram.js` kHandle + kDeserialize).
- `test-perf-hooks-eventlooputilization.js` (124, isolated — not a flake):
  the pure-JS fallback returns `{ idle: 0, active: 0, utilization: 0 }`
  forever, so the test's `idle <= 0` loop never exits. Needs libuv
  idle/active counters (`lib/internal/perf/event_loop_utilization`).

Gate-is-sole-blocker proof (triage + parent): `PARITY_NATIVE=1` flips both
to 0 and the full 15-file native sweep is 15/15.

## Rule-7 honesty note

With the gate narrowed, the two tests measure native Node's behavior — V8
host-object histogram serialization via structured clone, and libuv
event-loop counters — NOT the shim's pure-JS fallback. The browser path
gained nothing: in a browser there is no `process.getBuiltinModule`, and in
Jared's sandbox the template's getBuiltinModule throws
ERR_REQUIRE_ASYNC_MODULE for a builtin still being evaluated (its
cache/registry only resolve completed loads), so the bridge stays off there
too and the pure-JS fallback still serves the sandbox. This is the same
delegation-banking trade the program already made for worker_threads
(141/144 — the browser Web Worker path is unmeasured) and util's Promise
bridge. The pure-JS gaps stay honestly documented in the shim header
(`src/perf_hooks.js:40-54`).

## Self-delegation guard (why it is there)

`src/child_process.js` `loadNativeChildProcess` documents the trap: "a
VFS-resolving getBuiltinModule would hand this module its own exports back
as 'native'". If `process.getBuiltinModule("perf_hooks")` ever returned
this module itself, `createHistogram` / `eventLoopUtilization` /
`monitorEventLoopDelay` would call themselves through `nativePerfHooks`
and recurse until stack overflow.

Traced load paths show the guard cannot trigger today, and it is kept as
defense-in-depth, not as a tested branch:

- Sandbox: the gate runs once, at first evaluation. At that moment the
  template's `_builtinCache` does not hold perf_hooks (populated on
  completion — `runtime.js:262` host side; `loadModule` hook sandbox side)
  and the `moduleRegistry` scan in `src/sandbox/50-process.js:24-85`
  requires `rec.status === 'done'`, which is set only after evaluation
  (`src/sandbox/20-module-loader.js:289`; the record is created
  `'loading'`). So the self-lookup throws ERR_REQUIRE_ASYNC_MODULE, the
  gate's try/catch sets `nativePerfHooks = null`, and the pure-JS fallback
  serves the sandbox.
- Harness (Node): `process.getBuiltinModule` is the genuine native one,
  whose `createHistogram` is a different function object from the shim's
  hoisted declaration (`src/perf_hooks.js:762`), so the guard never
  false-positives there.

Probe-proven (`zz-p1-selfguard`, deleted after use): when
`getBuiltinModule` is monkey-patched to hand a pure-JS shim namespace back
as "native", the re-imported module does NOT recurse — `createHistogram()`
returns a `RecordableHistogram` and `eventLoopUtilization()` returns zeros.
That probe exercises the accept-a-shim case (candidate is a *different*
module copy, so the identity guard does not fire); the exact identity case
(candidate === the importing module's own namespace) is unreachable through
any traced load path, because a module cannot be 'done' during its own
first evaluation.

## Verification (branch head `fix/perf-hooks-native-bridge-gate`)

- Flips 2× isolated, exit 0: `test-perf-hooks-histogram.js` 0,0;
  `test-perf-hooks-eventlooputilization.js` 0,0.
- Full 15-file differential (`sweep-mjs.py` +
  `hidden_files/perf-hooks-tests-2026-11-18.txt`,
  `hidden_files/fast-sweep/perf-hooks-p1-branch-2026-11-18.csv`): 15/15
  pass. Diff vs triage sweep: exactly 2 flips (histogram 1→0, elu 124→0),
  0 regressions. Count: 13 + 2 = **15/15**.
- Fallback guards (`zz-p1-fallback-probe.js`, deleted after use): with
  `globalThis.__PERF_HOOKS_NO_NATIVE__ = true`, the shim behaves exactly
  as before the change — `RecordableHistogram`, `postMessage` throws
  `DataCloneError`, ELU `{ idle: 0, active: 0, utilization: 0 }`,
  `nodeTiming.loopStart -1`. No crash, no behavior change.
- Cross-module guards, branch vs base `ef157e95` (identical — 0
  regressions): `test-dns-perf_hooks.js` 1/1 (known dns NO-FIX, no public
  API for entryType `'dns'`), `test-http-perf_hooks.js` 0/0,
  `test-http2-perf_hooks.js` 1/1 (pre-existing http2 gap),
  `test-net-perf_hooks.js` 0/0.
- Repo jest: `tests/perf_hooks.test.js` +
  `tests/export_surface_perf_hooks.test.js` — 1 failed / 40 passed, the
  same single failure as the triage baseline (host-version skew:
  `createSlidingWindowHistogram` + `importHistogram` added in host
  v24.22.1, absent from v24.20.0; passes on CI's pinned v24.20.0).
  No change from the baseline.
- Footprint test: 29/29. `node --check src/perf_hooks.js`: clean.
- Diff: `src/perf_hooks.js` +18/−5 only. No docs-number changes in this PR.

## Ship

- PR #___
- Merge SHA: ___
