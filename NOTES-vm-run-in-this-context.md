# NOTES — vm lane 7: runInThisContext var/delete semantics (test-vm-not-strict)

## Target
- `test-vm-not-strict.js`: 1 → 0 (isolated 2× on the branch, 0/0).
- Net: 48 → 49/96.

## Mechanism (triage lane 7, probe P2)
`Script.prototype.runInThisContext` used indirect `(0, eval)(code)`
(src/vm.js, old line 1633). After indirect eval, a top-level `var b` is a
deletable eval-introduced binding, so `delete b; data.push(b)` throws
`ReferenceError: b is not defined`. Real Node compiles a real Script whose
top-level vars are non-configurable global bindings: `delete b` is a silent
no-op in sloppy code and `b` still reads `"this"`.

## Fix (src/vm.js only, +13/−15)
1. `Script.prototype.runInThisContext` now routes through the existing
   `runWithContext(this.#code, globalThis, runOpts)` instead of indirect
   eval. The scanner pre-declares top-level `var`/`function` on globalThis
   as non-configurable (via the existing `ensureDeclared`), so `delete`
   behaves like Node and `typeof unusedB === "number"` after the call.
   Error enrichment is unchanged in shape (runWithContext already enriches
   with filename/lineOffset/headLines; `basic`'s `checkErr` stack-prefix
   assertion still passes).
2. `runWithContext`'s `assigned` pre-declaration loop now skips the
   pre-declaration when `target === globalThis`. Implicit globals must fall
   through the `with` to the real global scope, where sloppy assignment
   creates them configurable — exactly like Node, so `delete
   globalThis.vmResult` (basic :64) still works. Pre-declaring them would
   make them non-configurable and `delete` would wrongly fail. Sandbox
   targets still pre-declare (without it the assignment would fall through
   to the REAL global scope — a leak). Design was proven with a zz probe
   (deleted after use) plus native probes:
   - native `runInThisContext("x = 1")` → `delete globalThis.x` is true;
     native `runInThisContext("var y = 1")` → `delete` is false.
   - shim `runInContext("typeof runWithContext")` is `undefined`: `new
     Function` bodies see only the global scope, so the fall-through
     cannot reach shim internals (the closure-leak worry does not apply).

## Differential (targeted; base = origin/main 379e84bf)
- Flip: `test-vm-not-strict` 1 → 0 (2× isolated).
- Guards 0 on branch (all runInThisContext users + adjacent): static-this,
  new-script-this-context, api-handles-getter-errors, deleting-property,
  global-configurable-properties, global-property-enumerator,
  global-get-own, context, context-property-forwarding, low-stack-space,
  sigint, sigint-existing-handler.
- Unchanged failures (identical exit + failure line on base, verified in a
  scratch worktree at 379e84bf): basic 1 (still :162, lane 9 SyntaxError —
  its runInThisContext block :57–65 passes, incl. `delete
  globalThis.vmResult`), global-define-property 1 (:47 both), cached-data 1
  (lane 10), dynamic-import-callback-missing-flag 1,
  module-dynamic-import 1, no-dynamic-import-callback 1,
  timeout-escape-promise 1, timeout-escape-promise-2 1,
  timeout-escape-promise-module 1, options-validation 1, timeout 124
  (documented no-interrupt gap).
- 0 regressions.
- Repo tests on branch: tests/vm.test.js + tests/export_surface_vm.test.js
  + tests/ondemand-require.test.js = 76/76 (incl. footprint rule).

## Known gaps (not this lane)
- Sandbox `var` bindings are non-configurable in the shim but native
  `runInContext("var varG = 7")` yields `configurable: true` on the
  sandbox object (native probe). The shim's `ensureDeclared` makes sandbox
  vars non-configurable too. No vendored test asserts it; a future lane
  could split `ensureDeclared` by target kind. (Native implicit sandbox
  globals ARE configurable: true — the shim's `assigned` pre-declaration
  still makes them non-configurable on sandboxes. Same future lane.)
- `test-vm-timeout` still spins (124) — the documented no-interrupt gap.

## Ship
- PR #434, merge SHA ___ (filled at ship time).
- Rebase onto main 94340521 (lane 5, PR #431): src/vm.js conflicted in
  the `assigned` loop — lane 5 wraps it in `if (!strict)`, this lane
  guarded the pre-declaration with `target !== globalThis`. Composed as
  `if (!strict && target !== globalThis)` (both skips kept, comments
  kept). Re-verified after rebase: not-strict 0/0, lane 5's
  global-contextual-store 0, guards 0, basic still 1 at :162.
- 2nd rebase onto main 626ee62b (lane 6, PR #432): lane 6 replaced the
  eager `assigned` pre-declaration with lazy claiming (`claimed` set
  passed to makeScope; `set` trap defines names non-configurable on
  first assignment). The old `if (!strict && target !== globalThis)`
  form is gone — the host-global skip now lives in the `claimed`
  computation: `claimed = !strict && target !== globalThis ?
  new Set(scanned.assigned) : new Set()`. This matters: under lane 6's
  mechanism a claimed host-global name would be defined
  non-configurable by the `set` trap and `delete globalThis.vmResult`
  would wrongly fail. Re-verified after rebase: not-strict 0/0, lane 5's
  global-contextual-store 0, lane 6's global-define-property 0, guards 0,
  basic still 1 at :162, repo tests 76/76.
- 4th rebase onto main 6f2d03f3 (lane 11, PR #439): clean (lane 11
  touches lines ~1184, this lane ~1394/~1722). Ship incident: the
  previous head 735d3435 went CI GREEN (Parity + build success, single
  suite 118411822409, poll 4) but the dist-regen bot's commit ee70fcd8
  made the PR dirty — `git merge-tree` proved the conflict is ONLY in
  the generated bundles dist/vfs.js + dist/vm.js (Lane 11's dist-regen
  vs this branch's); src/vm.js auto-merges. Rebasing the local branch
  (which never carried the bot commit) drops the stale dist state; the
  bot regenerates after the next green run. Verification trap caught
  in-lane: `test-vm-with-scope` does not exist (exit 1 was
  ERR_MODULE_NOT_FOUND, and a `| tail` pipeline had swallowed the real
  code on the base check). Lane 11's real flip is
  test-vm-proxy-failure-CP, 0 on pristine 6f2d03f3 and 0 on this branch
  — no regression. Re-verified after rebase: not-strict 0/0, lanes
  2/3/5/6/11 flips all 0 (measure-memory, options-validation,
  global-contextual-store, global-define-property, proxy-failure-CP),
  guards 0, basic still 1 at :162, repo tests 76/76.
