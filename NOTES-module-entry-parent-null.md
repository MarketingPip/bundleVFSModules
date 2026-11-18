# module entry-parent normalization — M1

Fixes `test-module-parent-deprecation.js` (+1, 29 → 30/32) by normalizing
the CJS entry module's `parent` from `undefined` to `null` in the parity
harness (`parity/preload.mjs` only). No `src/` change: the test's `module`
is a native instance (`instanceof` the shim's Module is `false`), created
before any shim code runs.

## Root cause (probe-proven, 3 ways)

A plain CJS entry has `module.parent === null`; under ANY `--import`
(preload no-target, `PARITY_TARGET=module`, empty ESM import) it becomes
`undefined` (triage probe `zz-module-parent-probe2.js`; parent re-verified
in-lane: plain `node` → `null`, `--import` preload → `undefined`).

Oracle (Node v24.20.0 source pack):

- The ESM translator pre-creates the entry module via
  `cjsEmplaceModuleCacheEntry(filename)` with NO parent argument
  (`lib/internal/modules/esm/translators.js:289` → `:397-404`:
  `new CJSModule(filename, undefined)`), then calls
  `loadCJSModuleWithModuleLoad`, which asserts the module is already in
  `CJSModule._cache[filename]` and calls
  `wrapModuleLoad(filename, undefined, isMain, …)` (`:354-372`).
- Native `_load` finds the cached entry and returns its exports
  (`lib/internal/modules/cjs/loader.js:1366-1392`): the `parent` argument
  is only used when constructing a fresh module (`new Module(filename,
  parent)` at `:1400`), and the cache-hit path only ever writes
  `kLastModuleParent` — the getter reads `kFirstModuleParent`
  (`:452-453`), set in the constructor (`:370`) with no
  `undefined → null` coercion. `run_main` passes `null` explicitly, so a
  plain entry is `null`.
- So normalizing the `_load` argument alone does NOTHING (proven in-lane:
  arg-only fix left the test at exit 1 and the probe at `undefined`).

## Fix (`parity/preload.mjs` only, +18 lines)

In the patched `Module._load`, when `isMain && parent === undefined`:
`parent = null` and `delete Module._cache[request]`, so native `_load`
constructs a fresh Module with parent `null` — mirroring `run_main`.
The constructor sets both parent slots directly, so no deprecation
warning fires. Side benefit (probe-proven): the fresh module also gets
`id === '.'` and `process.mainModule === module` / `require.main ===
module`, exactly like a plain `node` entry (the translator's module had
the full-path id). The translator still mirrors exports onto its
orphaned instance after `_load` returns, so the ESM namespace is
unaffected. Regular `require()` calls always pass a real parent with
`isMain` false, so they are untouched.

## Dead end, kept for the record (probe-proven)

Setting the cached entry via the public setter
(`cached.parent = null`) DOES flip the test (exit 0, assert passes) —
but it fires the setter's DEP0144 warning during entry load, and that
warning is then the only DEP0144 the process ever emits (the getter's
is suppressed by the global `codesWarned` set). Any test using
`common.expectWarning` with an exact expected set then fails on the
extra warning — proven: `test-repl-options.js` (expects the
`repl._builtinLibs` warning, got DEP0144) and
`test-process-env-deprecation.js` both flipped 0 → 1 in the guard
sweeps. The `process.emitWarning` nextTick deferral
(`lib/internal/process/warning.js:180`) is what lets the target test
itself pass under the setter (its listener attaches before the tick
fires) — but it does not save the other suites. The delete approach
emits no warning at all: the target test's own read fires its one
expected DEP0144.

Why the slot cannot be written directly: `kFirstModuleParent` is a V8
private symbol (`module_first_parent_private_symbol`, loader.js:100) —
it does not appear in `Object.getOwnPropertySymbols(module)` (probe:
only kIsMainSymbol, kIsCachedByESMLoader, kURL, kFormat, kIsExecuting
are visible), so there is no userland handle on it.

## Verification (branch head, worktree `util-m1-entry-parent`)

- Flip 2× isolated, exit 0: `test-module-parent-deprecation.js`
  (incl. the DEP0144 `expectWarning` exit check).
- Probe: entry under preload now `parent: null | id: . |
  mainModule===module: true | require.main===module: true` — byte-for-byte
  the plain-`node` values.
- Guards exit as designed: `test-module-create-require.js` 1 (NO-FIX,
  pinned divergence), `test-module-strip-types.js` 1 (NO-FIX, needs
  amaro), `test-module-parent-setter-deprecation.js` 0,
  `test-module-print-timing.mjs` 0.
- Full module differential (`module-m1-branch-2026-11-18.csv`,
  `--jobs 2`) vs triage sweep on `880cc319`: exactly 1 flip
  (parent-deprecation 1→0), 0 regressions → 30/32 on branch.
- Cross-module guards (fix touches the entry load for all targets):
  repl sweep identical to wave-end except the known
  `test-repl-reverse-search.js` flake passing (1→0; [0,0] isolated on
  branch — TEST_THREAD_ID gap, triage-documented); process sweep
  identical to wave-end except the `redirect-warnings` / 
  `redirect-warnings-env` pair swapping under contention (both [0,0]
  isolated on branch AND on base `880cc319`). The two
  setter-version regressions (`test-repl-options.js`,
  `test-process-env-deprecation.js`) pass [0,0] isolated on the final
  branch.
- Footprint test: 29/29. Repo jest module suite: 89/89.
  `node --check parity/preload.mjs` clean.

## Ship

- PR #___ / merge SHA ___
