# NOTES-vm-strict-assign — Lane 5: strict-mode undeclared assignment

**Target:** `test-vm-global-contextual-store` (1 test). **Result: FLIP 1 → 0.**

## Mechanism

`runWithContext` (`src/vm.js`) pre-declares every top-level bare-assignment
target the scanner finds, via `ensureDeclared`, so the name lands on the
context object as a writable binding. For a strict script this is wrong:
`"use strict"; z = 42` must throw `ReferenceError: z is not defined` (real
Node verified: throws, and `Object.hasOwn(ctx, "z")` is false), but the
pre-declared `z` made the assignment succeed — "Missing expected exception"
at test :17 on base.

## Fix (`src/vm.js` only, +16/−4)

In `runWithContext`, skip the `scanned.assigned` pre-declaration loop when
`strict` is true (`isStrictPrologue` already detects the directive). With
the name undeclared, the scope proxy's `has` trap returns false, the `with`
falls through, and the strict eval throws ReferenceError before any property
is created. Sloppy scripts still pre-declare (bare assignment creates the
global — the common case, unchanged).

Names already on the target are unaffected in both modes: context properties
(`x = 42` where `x` is in the context) and standard globals claimed by the
scope proxy (`parseInt = 5` in strict mode stays legal, as in Node).
`var`/`function` pre-declaration is untouched.

## Verification

- Target `test-vm-global-contextual-store`: 1 → 0, isolated 2x on the branch.
- zz-probe (6 cases, deleted after use — all PASS): strict undeclared
  assignment throws + creates nothing; sloppy bare assignment creates the
  global; strict assignment to a context property works; strict assignment
  to a standard global works; strict var assignment does not throw and the
  function lands; strict nested-function undeclared assignment throws.
- Guards (16 run, 14 pass): context, create-and-run-in-context,
  create-context-arg, global-assignment, global-configurable-properties,
  global-get-own, global-identity, global-non-writable-properties,
  global-property-enumerator, global-property-interceptors, run-in-new-context,
  deleting-property, strict-mode, strict-assign — all 0. `basic` and `script`
  exit 1 on the branch AND on pristine base (pre-existing failures, basic
  fails at :162 on base) — not regressions.
- Repo suite: `tests/vm.test.js` 46/46 on the branch;
  `tests/ondemand-require.test.js` 29/29 (footprint pattern holds).
- Native check: test passes on real Node v24.22.1 (exit 0); strict `z = 42`
  throws `ReferenceError: z is not defined`, `hasOwn` false.

## Known leftover (NOT fixed — different mechanism, out of scope)

Strict-mode top-level `var` does not land on the context: `"use strict";
var q = 1; q = 2` leaves `ctx.q === undefined` on the branch AND on base
(native: 2). Cause: strict direct eval gets its own declarative environment,
so the hoisted `var q` shadows the pre-declared target property. Fixing it
means extracting top-level `var` into the eval prefix like functions are —
a different change; recorded here, not attempted in this lane.

## Ship

- PR #___ (filled at ship time), merge SHA ___.
- Branch `fix/vm-strict-assign`, worktree `~/workspace/worktrees/vm-v1-strict-assign`.
