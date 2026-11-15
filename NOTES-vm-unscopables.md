# NOTES-vm-unscopables — Lane 11, with-scope unscopables (PR #___)

## Target

- `test-vm-proxy-failure-CP.js`: `vm.runInContext("", proxySandbox)` where the
  sandbox Proxy's `getOwnPropertyDescriptor` trap throws `Error: whoops` for
  any prop. Real Node: exit 0 (contextify never queries sandbox attributes
  on an empty run). Shim before fix: exit 1 (`whoops` from `runWithContext`,
  src/vm.js:1333).

## Mechanism (traced, not assumed)

The shim runs user code as `with(__vm_p__){ return eval(__vm_c__); }`, so
every run resolves the name `eval` through the scope proxy. `with`
name-resolution calls `Get(scope, Symbol.unscopables)` first. The scope
proxy's `get` trap forwarded symbols via `Reflect.get(t, prop)` — which
returns `undefined` harmlessly — but Proxy `[[Get]]` validation then
unconditionally calls `target.[[GetOwnProperty]](Symbol.unscopables)` on the
scope proxy's target (the sandbox Proxy), and the sandbox's throwing trap
fires there. That validation call is the throw: probe P3's last TRAP line
before the throw is exactly `getOwnPropertyDescriptor Symbol(unscopables)`.

## Triage correction (important)

The triage's prescribed fix — "short-circuit Symbol.unscopables in the
`get` trap, answer it without touching the target" — DOES NOT WORK. Proven
with a pure-Node probe (`/tmp/vm-unscop-probe.cjs`, Node v24.22.1): a scope
proxy whose `get` trap returns `{}` for `Symbol.unscopables` without
touching the target STILL throws `whoops`, on both a direct Get and a
`with`+`eval` run, because the `[[Get]]` validation query hits the target's
trap anyway. Any fix that keeps the sandbox Proxy as the scope proxy's
target cannot work: the validation query is unconditional whenever the
`get` trap is defined.

## Fix (src/vm.js, `makeScope` only)

Retarget the scope proxy at a fresh plain object (`new Proxy({}, {...})`)
and forward every trap to the closed-over sandbox instead of `t`. Proxy
validation queries then hit the inert `{}` target, never the sandbox's
traps. Plus a `get`-trap short-circuit for `Symbol.unscopables` (return
`undefined`): real Node never consults a context global's `@@unscopables`
(it is not a `with` object), so ignoring the sandbox's value also matches
Node for sandboxes whose `get` trap returns a blocking unscopables object
or throws.

`ponytail:` comment in the code names the ceiling: validation is now
checked against `{}` — reporting a non-configurable descriptor
(`getOwnPropertyDescriptor`) or defining a non-configurable property
(`defineProperty`) through the scope would fail invariant checks that
passed against the sandbox target. No vm test reaches those paths through
the `with` object (user code cannot reference the scope), and the full
passing vm suite guards the shared paths.

## Verification

- Flip: `test-vm-proxy-failure-CP` 1 → 0, isolated 2x on the branch.
- Guards: ALL 48 passing vm tests (triage sweep CSV, exit 0) re-run isolated
  on the branch: 48/48 pass, 0 regressions. Includes the Proxy-sandbox
  tests (`test-vm-context`, `test-vm-set-property-proxy`) and the scope
  trap-sensitive tests (`global-non-writable-properties`,
  `global-configurable-properties`, `ownkeys`, `ownpropertynames`,
  `ownpropertysymbols`, `global-property-interceptors`, `deleting-property`,
  `data-property-writable`, `global-property-enumerator`,
  `indexed-properties`, `inherited_properties`, `symbols`).
- Repo tests: `tests/vm.test.js` + `tests/export_surface_vm.test.js` 47/47;
  `tests/ondemand-require.test.js` 29/29 (footprint pattern: `src/vm.js` +
  this NOTES file).
- `node --check src/vm.js` clean.

## Ship

- Branch `fix/vm-unscopables`, base main `379e84bf`.
- PR #___ (filled at ship time), merge SHA ___ (filled at ship time).
