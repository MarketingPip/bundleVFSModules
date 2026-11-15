# NOTES — vm Lane 6: OwnKeys insertion order (`global-define-property`)

- **Lane:** V1-6. **Test:** `test-vm-global-define-property` (1 flip).
- **Base:** main `379e84bf`. **Branch:** `fix/vm-ownkeys-order`.
- **Mechanism:** the script does `Object.defineProperty(this, "f", {accessor})`
  then `g = f;`. The shim's `Object.keys(o)` was `['console','x','g','f']`
  vs expected `['console','x','f','g']` — `ensureDeclared` eagerly defined
  `g` when the scanner saw the assignment, so `g` was created before the
  `defineProperty` call ever ran.
- **Fix (`src/vm.js` only):** lazy assigned-name claiming.
  - `runWithContext` no longer `ensureDeclared`s `scanned.assigned` upfront.
    It builds `claimed = new Set(scanned.assigned)` and passes it to
    `makeScope`.
  - `makeScope(target, strict, claimed)`: the `has` trap claims a
    scanned-assigned name (guarded by `Reflect.isExtensible(t)` so the trap
    invariant holds on frozen targets), so bare assignments still land on
    the context instead of falling through to host globals. The `set` trap
    defines the name on first assignment with the same non-configurable
    descriptor `ensureDeclared` used to install eagerly, then sets — so
    insertion order follows execution order and the descriptor semantics
    are unchanged (only the timing moved).
  - `var`/`function` pre-declaration is untouched; `compileFunction`'s
    `makeScope(target)` call passes no claim set (no scanner there) and
    behaves exactly as before.
  - Strict-mode scripts claim nothing (composed with lane 5 on rebase):
    `claimed` is empty when `strict`, so the scope proxy's `has` trap
    returns false and `"use strict"; z = 42` throws ReferenceError, exactly
    lane 5's merged behaviour (test-vm-global-contextual-store, re-verified
    0, 0 after the rebase).
  - `ponytail:` lazy claiming is the ceiling — a read of a claimed but
    unassigned name still yields `undefined` via the `get` trap, and the
    scanner only records top-level bare `name = …` assignments, so nested
    assignments keep their (pre-existing) fall-through behaviour.
- **Verification:**
  - Target `test-vm-global-define-property`: 1 → 0, isolated 2x on the branch.
  - zz probe (deleted after use): 6 cases PASS — read-before-assign stays
    `undefined` and creates nothing; assign/defineProperty/assign orders
    `['a','b','c']`; defineProperty-then-assign orders `['f','g']`;
    lazily-claimed name stays non-configurable (`delete h` → false);
    `var`/`function` order `['fn','v','w']` matches real Node exactly
    (native probe confirmed); strict `z = 42` still succeeds.
  - Guards (all 0 on the branch): `deleting-property`, `getters`,
    `global-property-enumerator`, `inherited_properties`,
    `context-property-forwarding`, `create-context-accessors`,
    `create-context-arg`, `create-context-circular-reference`,
    `global-assignment`, `global-configurable-properties`, `global-get-own`,
    `global-identity`, `global-non-writable-properties`,
    `global-property-interceptors`.
  - Pre-existing failures, unchanged (1 on pristine base AND branch, same
    signature): `basic`, `context-async-script` (both exit 1 on base).
    Other lanes' targets unchanged: `not-strict` 1 (lane 7),
    `global-contextual-store` 1 (lane 5), `context-dont-contextify` 1
    (lane 8).
  - Repo tests: `tests/ondemand-require.test.js` + `tests/vm.test.js` +
    `tests/export_surface_vm.test.js` — 3 suites, 76 tests, all pass.
- **Rebase over lane 5 (#431, `94340521`):** first merge attempt 405'd —
  lane 5 landed first and touched the same assigned loop. Single-hunk
  conflict, composed (not either-side): `claimed = strict ? new Set() :
  new Set(scanned.assigned)` — sloppy keeps lazy claiming, strict claims
  nothing (lane 5's throw preserved). Re-verified after rebase: lane 6
  target 0, 0; lane 5 target `global-contextual-store` 0, 0; all 14 guards
  0; pre-existing failures unchanged.
- **Ship:** (filled at ship time)
  - PR #432 / merge SHA ___
