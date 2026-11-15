# vm wave V1, Lane 4 — codeGeneration enforcement

**Test:** `test-vm-codegen.js` (1 test). **PR:** #___ (fill at ship time).
**Merge SHA:** ___ (fill at ship time).

## Mechanism

`codeGeneration:{strings:false}` / `{wasm:false}` were validated in
`createContext`/`getContextOptions` (src/vm.js:248-278, 1404-1431) but stored
nowhere `runWithContext` consults. `eval("x")` threw `ReferenceError: x is
not defined` instead of the context's `EvalError`; `new WebAssembly.Module(
WASM_BYTES)` succeeded instead of throwing the context's `CompileError`.
Real-Node probe (v24.22.1): strings → `EvalError: "Code generation from
strings disallowed for this context"`; wasm → `CompileError:
"WebAssembly.Module(): Wasm code generation disallowed by embedder"`.
Validation asserts in the test (`strings: 0`, `codeGeneration: 1/null`,
`contextCodeGeneration: {wasm: 1}` → `ERR_INVALID_ARG_TYPE`) already passed
— the shim's `validateObject`/`validateBoolean` were correct; only
enforcement was missing.

## Fix (src/vm.js only)

- `createContext` stores the defaulted `{strings, wasm}` flags on the
  context in a new `contextCodeGeneration` WeakMap (next to `contextified`).
  `DONT_CONTEXTIFY` contexts and never-contextified targets read as the
  default `{strings: true, wasm: true}`.
- `runWithContext` reads the flags and, when false, installs throwing
  bindings via a prefix **inside** the evaluated code
  (`globalThis.eval = __vm_e__;` / `globalThis.WebAssembly = __vm_w__;`),
  passed as extra factory params. The prefix — not a host-side install —
  is load-bearing: the runner's own direct `eval()` resolves through the
  same scope proxy, so installing host-side before the run would break the
  runner itself. The prefix runs first (after the strict prologue), so user
  code sees the throwing bindings.
- Throwing values come from `standardGlobals()` — the context's own
  intrinsics (what `runInContext("EvalError", ctx)` returns). The wasm
  override is `Object.create(host WebAssembly)` with an own throwing
  `Module`, so `CompileError`/`instantiate`/etc. still resolve to the real
  ones. `headLines` counts the prefix lines so stack mapping stays right.
- The previous own-property state is restored after the run, but only if
  untouched — user code may have overwritten the binding, and that
  assignment must persist, as in Node (restore uses `Reflect.*`, never
  throws; save/restore composes across nested runs).
- **Regression caught at rebase #5 (lane 11 landed first):** the save step
  called `Object.getOwnPropertyDescriptor(target, ...)` unconditionally,
  which trips a throwing Proxy sandbox's trap and broke
  `test-vm-proxy-failure-CP` (lane 11's flip) — 1 on the branch, 0 on
  pristine main. Fix: the save reads are guarded by `noEval`/`noWasm`, so
  a default context never touches the target's descriptors; the restore
  was already guarded. Re-verified after the fix: lane 11 guard 0, target
  0x2, all 48 guards 0, repo suites 76/76, zz restore probe PASS.
- `enrichScriptError` returns the same error object (stack rewritten in
  place), so `instanceof EvalError`/`CompileError` survives the catch path.

## Verification

- Target: `test-vm-codegen.js` 1 → 0, isolated 2x on the branch.
- Guards: **all 48 passing vm tests** (base sweep CSV) re-run 1x on the
  branch — all exit 0. Results:
  `hidden_files/vm-v1-codegen-guards.csv`. (Textual grep found no passing
  test mentioning eval/WebAssembly, so the full passing set is the guard —
  the change touches the `runWithContext` core path every test uses.)
- Repo tests: `tests/vm.test.js` + `tests/export_surface_vm.test.js` +
  `tests/ondemand-require.test.js` — 76/76.
- zz probe (deleted after use): restore semantics — throwing `eval`/
  `WebAssembly` do not persist on the context after the run; a user
  overwrite of `eval` inside a strings:false context persists; strict code
  still runs; `WebAssembly.CompileError` read inside a wasm:false run is
  the real constructor. All passed.

## Ceiling / leftovers

- Only `eval()` and `WebAssembly.Module` are blocked. `new Function()`,
  `WebAssembly.compile`, and `WebAssembly.instantiate` are NOT blocked
  under `strings:false`/`wasm:false` (real Node blocks them too) — no test
  covers them; blocking them needs the `compileFunction` path (its own
  `makeScope` use) plus a `Function`-constructor override, a separate lane.
- `compileFunction` does not consult the flags at all (same reason).
- `globalThis.eval` inside a restricted context is `undefined` in the shim
  (pre-existing gap: the context object has no `eval` own property until
  the prefix runs, and the prefix value is restored after the run) — real
  Node returns the throwing function. Untested.

## Ship

- Branch: `fix/vm-codegen` (worktree `~/workspace/worktrees/vm-v1-codegen`).
- Base: main `379e84bf`.
- Files: `src/vm.js`, `NOTES-vm-codegen.md`.
- CI note: the 7th-rebase head (`2ae34334`, code SHA) went Parity green +
  build red in a single suite; all three local build steps
  (`build-vfs`, `build-sandbox --check`, `build-runtime --check`) pass
  clean on the same tree and the jobs API returned no log summary — the
  known transient build failure. Retriggered with this notes-only commit.
