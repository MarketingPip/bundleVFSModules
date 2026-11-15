# NOTES — vm Lane 8: Vanilla-context builtins, DONT_CONTEXTIFY (PARTIAL)

**Test:** `test-vm-context-dont-contextify.js` (triage lane 8, 1 test, partial).
**Branch:** `fix/vm-dont-contextify`. **Base:** main `379e84bf`, rebased onto
`626ee62b` (PRs #431 lane 5 + #432 lane 6 landed first — see Rebase note).
**Status: PARTIAL — the test now fails ONLY at the final dynamic-import block
(Lane 1 territory). Do NOT count the flip until Lane 1 has merged; the parent
verifies the full flip on main after Lane 1 lands.**

## What changed (2 files + this note)

- `src/vm.js` only:
  1. `createContext(DONT_CONTEXTIFY)` now returns `markContext(makeVanillaContext())`
     instead of `markContext({})`. `makeVanillaContext()` defines the standard
     globals (from the existing `standardGlobals()` table) as non-enumerable
     own properties (`writable: true, enumerable: false, configurable: true`),
     EXCLUDING `console` — `process`/`Buffer` were never in the table. So
     `typeof context.Array === "function"` and `Object.keys(context)` is `[]`,
     while `context.process`/`context.Buffer`/`context.console` stay absent.
     Values are the host intrinsics (a browser has no per-context intrinsics
     to mint); ceiling: cross-context identity (`context.Array` is the host
     Array, where real Node mints a fresh one) — no vendored test asserts it.
  2. Sloppy-assignment fix in the scope proxy (`makeScope` `set` trap): when
     `Reflect.set` fails in sloppy mode, the trap now returns `false` (the
     engine fails the assignment silently AND KEEPS EVALUATING) instead of
     throwing the `SloppyAssignSilent` sentinel, which aborted the whole eval
     — `qux = 2; qux` on a getter-only property returned `undefined` instead
     of `1` (test :113). Strict mode still throws Node's
     "Cannot assign to read only property" message. Dead `SloppyAssignSilent`
     class + its runner catch removed.
  3. Frozen-context leak fix, composed with lane 6 (#432): lane 6 replaced
     eager pre-declaration of bare-assignment targets with lazy claiming
     (`claimed = strict ? new Set() : new Set(scanned.assigned)` in
     `runWithContext`, claimed in the scope proxy's `has` trap, defined by
     its `set` trap on first assignment) — which subsumed this lane's
     `unclaimed` set (dropped in the rebase, and the `ensureDeclared`
     return-value change with it: nothing uses it now). The one gap lane 6
     left: its `has` trap only claimed when `Reflect.isExtensible(t)`, so
     on a FROZEN target a bare assignment fell through and created a host
     global (`bar = 1` leaked `globalThis.bar`, breaking the later
     ReferenceError read — test :160). The composed fix drops that guard:
     returning true from `has` is always spec-legal, and a frozen target
     MUST still be claimed; the `set` trap then fails the assignment
     silently via the return-false change above. A later read (different
     run, no claim) falls through to the real scope and throws
     ReferenceError, as in Node.
- `parity/node-test/fixtures/es-modules/message.mjs` (vendored, 36 bytes):
  `export const message = 'A message';` — extracted from the SHA256-verified
  Node v24.20.0 tarball in `hidden_files/node-src/` (the pack has no `test/`
  tree; the tarball does). The fixture was the only reason the test failed
  natively (ERR_MODULE_NOT_FOUND); the test's final block `await
  import(moduleUrl.href)` needs the file on disk.

## Differential (targeted, no full sweep — parent runs the wave-end sweep)

- Target, base (main `379e84bf`): exit 1 at `:17`
  (`typeof context.Array` 'undefined' vs 'function').
- Target, branch: exit 1 at `:227`, stable 2x isolated —
  `new vm.Script(..., { importModuleDynamically:
  vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })` throws
  `ERR_INVALID_ARG_TYPE` from `validateFunction` (src/vm.js:111): the
  symbol is not accepted yet. That is Lane 1's fix (triage: "Script
  currently validateFunctions it and throws"). Every block before :227
  passes, including both freeze blocks.
- Guards (branch vs base, identical): `context-async-script` exit 1 both,
  same signature `undefined !== 3` (NO-FIX, setTimeout-outside-context);
  `context`, `create-and-run-in-context`, `create-context-arg`,
  `is-context`, `global-identity`, `cross-context`,
  `create-context-accessors`, `global-assignment`, `function-redefinition`
  all exit 0 on both. 0 regressions.
- zz-probe (deleted after use): frozen vanilla context — `bar = 1` does not
  leak to host, later `bar` read throws ReferenceError, `typeof bar` is
  'undefined', `context.Array` is a function, `Object.keys` is `[]`,
  `context.console` undefined. PASS.
- Repo tests on branch: `tests/vm.test.js` + `tests/export_surface_vm.test.js`
  + `tests/ondemand-require.test.js` — 76/76 pass (incl. the footprint
  pattern check over this diff: src/vm.js + NOTES file + vendored fixture).

## Known ceilings (not fixed here)

- In-script `typeof console` still yields `'function'` via the scope proxy's
  `standardGlobals()` fallback — pre-existing for ALL contexts, not just
  vanilla ones; the test only asserts `process` absence in-script. Out of
  lane scope.
- Same-script assign-then-read of a name whose pre-declaration failed on a
  frozen context (`bar = 1; bar` in one eval) returns `undefined` instead of
  throwing ReferenceError — the claim lives only for the assigning run.
  Untested by any vendored test.
- `undefined`/`NaN`/`Infinity` are defined writable/configurable like the
  other globals; real Node makes them non-writable, non-configurable.
  Untested.

## Ship

- PR #438. Merge SHA: ___ (filled at ship time).
- No docs-number changes (partial flip — not counted).

## Rebase note (2026-11-15)

- First head `1434abf7` CI-starved (0 runs, `mergeable_state: unknown`)
  because main had moved: #431 (lane 5) + #432 (lane 6) landed first.
- Rebasing onto `626ee62b` conflicted in `src/vm.js` only (4 hunks, all in
  makeScope/runWithContext — lanes 5/6 reworked the same mechanism).
  Resolved by composition, not by picking a side: lane 5's strict
  handling + lane 6's lazy claiming kept; this lane's `unclaimed` set and
  `ensureDeclared` return-value change dropped (subsumed); lane 6's
  `Reflect.isExtensible(t)` guard in `has` dropped (see item 3 above);
  the sloppy return-false `set` trap + `SloppyAssignSilent` removal kept.
- Re-verified after the rebase: target :227 2x; lane 5
  (`global-contextual-store`) 0 and lane 6 (`global-define-property`) 0 —
  their flips preserved; `context-async-script` 1 unchanged
  (`undefined !== 3`); the 9 other guards 0; repo tests 76/76.
- Second rebase (onto `6f2d03f3`, PR #439 lane 11 landed while the first
  rebased head was in CI): conflicted in `makeScope` only — lane 11
  rewrote the scope proxy onto a fresh plain-object target with the
  `Symbol.unscopables` short-circuit. Resolved by composition: lane 11's
  structure kept, this lane's `has`-guard drop + sloppy return-false
  applied on top of it. (Cautionary note: the first resolver attempt used
  a `re.S` regex whose trailing `.*\n` swallowed the file tail — recovered
  via `git checkout --conflict=merge` and a line-based resolver. Never
  regex-replace a conflict span with re.S.)
- Re-verified after the second rebase: target :227 2x; lanes 5/6/11 flips
  preserved (`global-contextual-store` 0, `global-define-property` 0,
  `proxy-failure-CP` 0); `context-async-script` 1 unchanged; the other
  guards 0; repo tests 76/76.
- Third rebase (onto `510f2fd4`, PR #434 lane 7 landed while the second
  rebased head was in CI): applied CLEANLY, no conflicts — lane 7's
  `runWithContext` var/delete work sits in a different region than this
  lane's. (False alarm in verification: `test-vm-run-in-this-context`
  does not exist — ERR_MODULE_NOT_FOUND exit 1; lane 7's test is
  `test-vm-new-script-this-context`, 0 on branch AND on main.)
- Re-verified after the third rebase: target :227 2x; lanes 5/6/7/11
  flips preserved (`global-contextual-store` 0, `global-define-property`
  0, `new-script-this-context` 0, `proxy-failure-CP` 0);
  `context-async-script` 1 unchanged; the other guards 0; repo tests
  76/76.
