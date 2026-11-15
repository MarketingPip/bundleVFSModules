# NOTES-vm-measure-memory.md — Lane 2, vm wave V1 (measureMemory completion)

## Claim

`measureMemory()` now returns the full documented shape (`current` + `other`
sections listing every live contextified context, `total` as the sum) plus
the `ExperimentalWarning` emitted once per process, and validation throws
synchronously like real Node. Flips exactly 3: `test-vm-measure-memory`,
`test-vm-measure-memory-lazy`, `test-vm-measure-memory-multi-context`
(all 1 → 0, isolated 2× each, exactly one `ExperimentalWarning` on stderr
per run, no other output). Guards: all 48 previously-passing vm tests 0
on the branch; repo suites `tests/vm.test.js` + `tests/ondemand-require.test.js`
75/75.

## Root causes (three, all in `src/vm.js`)

1. **Wrong function shape — the sync-throw bug.** `measureMemory` was
   declared `async`, so validation failures became rejected promises instead
   of synchronous throws. The vendored test asserts
   `assert.throws(() => vm.measureMemory(null), …)` (line 29) — "Missing
   expected exception" on base. Real Node `lib/vm.js:382` is a plain
   function returning a promise (verified by probe: `measureMemory(null)`
   throws synchronously `ERR_INVALID_ARG_TYPE`, `{mode:'bogus'}` throws
   `ERR_INVALID_ARG_VALUE`, no-arg returns a promise). Fix: plain function
   returning `Promise.resolve(result)`.
2. **Missing `current`/`other`.** The old shape was a synthetic
   `{total, WebAssembly}` with no `current`/`other` keys. Fix: detailed
   mode adds `current` (synthetic shape for the calling context) and
   `other` (one synthetic entry per live contextified context); `total`
   is the sum of the two (all synthetic zeros). `liveContexts` is a new
   `Set` fed by `markContext` — a `WeakSet` cannot enumerate, so the
   registry is required. Entries hold no reference to their context, so
   contexts can still be GC'd; a `FinalizationRegistry` (guarded by
   `typeof` for older hosts) drops the entry when its context dies.
   `runInNewContext` contexts register too (via `createContext`), matching
   real Node where they are live contexts until GC'd.
3. **Missing warning.** Real Node emits `emitExperimentalWarning(
   'vm.measureMemory')` once per process, before validation. Fix: a
   module-level once-flag + guarded `process.emitWarning(msg,
   'ExperimentalWarning')` (the `src/assert.js` guard pattern:
   `typeof process !== 'undefined' && typeof process.emitWarning ===
   'function'`, try/catch). Warning fires before validation, mirroring
   Node's order — so even an invalid call warns once.

## Shape fidelity (real-Node probe, v24.22.1)

- Summary: `{"total":{…},"WebAssembly":{"code":0,"metadata":33866}}` — the
  `WebAssembly` key is real, kept. Detailed keys in order:
  `["total","WebAssembly","current","other"]`; `other.length` equals the
  number of live created contexts (2 in the probe). Key order in the shim
  matches. Sizes stay synthetic zeros — the tests assert shape, key
  presence and types, not values.
- `ponytail:` comment on the registry names the ceiling: real measurement
  needs a V8 heap profiler, unreachable from the browser; shape fidelity
  is the honest ceiling.

## Repo-test correction (in this PR)

`tests/vm.test.js` "measureMemory resolves a summary shape" asserted
`await expect(vm.measureMemory(null)).rejects…` — that encoded the shim's
old wrong async shape. Real Node throws synchronously (probe above), so
the test now asserts sync throws via `toThrow(expect.objectContaining(
{code}))`. No other repo-test changes.

## Guards

- 48 previously-passing vm tests (triage sweep `vm-sweep-2026-11-15.csv`,
  exit 0): all 0 on the branch (47 in the loop + `util-lazy-properties`
  separately — the loop's `while read` skipped the unterminated last line;
  re-ran it, exit 0).
- `tests/vm.test.js` + `tests/ondemand-require.test.js`: 75/75.
- Known pre-existing flake NOT a regression: none hit in this lane
  (`test-vm-timeout` is 1 isolated on the shim / 0 native — not in the
  guard set, unchanged by this lane).

## Overturns

HITLIST's "3 measureMemory inherent" is wrong — the tests assert shape,
not real measurement. Stated in the PR body; the docs sync (parent) will
restate the vm count.

## Ship

- Branch: `fix/vm-measure-memory` (PR #___; merge SHA ___ — filled at ship time)
- Files: `src/vm.js`, `tests/vm.test.js`, `NOTES-vm-measure-memory.md`
  (footprint pattern allows all three; no preload/hook changes).
