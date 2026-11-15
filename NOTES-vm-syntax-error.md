# NOTES — vm Lane 9: Syntax-error fidelity (`basic`)

## Result

- `test-vm-basic.js`: **1 → 0** (isolated 2× on the branch; also 0 on the
  branch after rebase — see ship section).
- `test-vm-options-validation.js`: **0 on branch and on base** — was a
  side-effect flip of this lane's validator split, but Lane 3 merged first
  (PR #430, `17849a59`) and flipped it on main; this branch keeps it 0
  (see "Overlap with Lane 3").
- Guards 0: `syntax-error-message`, `syntax-error-stderr`, `context`,
  `create-and-run-in-context`, `run-in-new-context`, `new-script-new-context`,
  `new-script-this-context`, `createcacheddata`.
- Unchanged failures (verified identical on pristine base `17849a59`):
  `script-after-evaluate` 1 (NO-FIX, V8-isolate family),
  `codegen` 1 (Lane 4), `cached-data` 1 (Lane 10).
- Repo tests: `tests/vm.test.js` + `tests/export_surface_vm.test.js`
  47/47 on the branch.

## What was wrong

`compileFunction("});\n\n(function() {\nconsole.log(1);\n})();\n\n(function() {")`
threw `SyntaxError: Unexpected token ')'` instead of Node's
`Unexpected token '}'`. The shim wraps code as
`function(params){ code }` via `new Function`, shifting the parser's token
context: the `}` closes the wrapper and V8 reports the `)` instead.

## Fix (src/vm.js only)

1. **`preParseFunctionBody(code)`** — pre-parse the raw code before the
   wrapped factory, surfacing the raw SyntaxError; the wrapped form is used
   only after the raw parse succeeds.
   - The triage's suggested shape (`new Function` on the unwrapped source)
     does NOT work as-is: `new Function` on the test input reports
     "Single function literal required", not "Unexpected token '}'".
     Probed matrix (real Node v24.22.1, 14 inputs): `new Function` matches
     vm on 11, raw program parse (`(0, eval)(code)`) on 9 — and they fail
     in complementary places. Rule implemented: `new Function(code)` first;
     on failure, prefer the eval SyntaxError unless it is "Illegal return
     statement" (eval is program-scoped, blind to the body's top-level
     `return`). Result: 13/14 matrix inputs match vm exactly.
   - Pre-parse runs WITHOUT params: with params, a bad param name would
     fail the parse while the code is valid, and the eval fallback would
     then EXECUTE the valid code. Params are still validated by the factory
     parse below, exactly as today. Proven by zz probe: bad param + side-
     effect code does not execute (probe deleted after use).
   - `ponytail:` ceiling — a body with BOTH a top-level `return` AND an
     early-`}` + unclosed tail (e.g. `return 1;\n});\n\n(function() {`)
     still reports "Single function literal required": eval is blind past
     the `return` and `new Function` hits its quirk. Needs a real parser
     (acorn is dev-only here; its messages don't match V8's either).
2. **Validator split (verbatim port of Node `lib/internal/validators.js`)**
   — the test's later assertions exposed it: `validateInt32` conflated
   type errors with range errors (both → `ERR_OUT_OF_RANGE`). Now three
   arms: non-number → `ERR_INVALID_ARG_TYPE` TypeError; non-integer →
   `ERR_OUT_OF_RANGE` "It must be an integer."; out of range →
   `ERR_OUT_OF_RANGE` "It must be >= min && <= max." (note Node's `&&`,
   the shim had `and`). Same split applied to `validateUint32` and to
   `validateTimeout` (port of `validateUint32(positive=true)`, which
   lib/vm.js uses for `options.timeout`).
3. **`validateCachedData`: "argument" → `argOrProp(name)`** — the test
   expects `"options.cachedData" property must be…`, the shim hardcoded
   "argument". Both call sites pass `options.cachedData`.
4. **Host-realm `global`/`globalThis` for no-context compileFunction** —
   `compileFunction("return global", [])()` returned `undefined`: the
   fresh target stands in for the host realm, but `makeScope` claims
   `global` as a host-blocked name and returns undefined. Seed
   `target.global = target.globalThis = globalThis` when there is no
   parsing context (extensions still win if they define `global`).

## Later assertions (triage caveat) — all proven, no follow-up needed

The stack-position assertions (`<anonymous>:1:7`, lineOffset `:4:7`,
columnOffset `:1:10`), the `varInContext` ReferenceError, and the
cachedData section all pass on the branch — they were already correct in
the shim (`enrichScriptError` with headLines/lineBias), just unreachable
behind the line-162 failure.

## Overlap with Lane 3

Lane 3 (`options-validation`) owned the `validateInt32` split; this lane
needed the same validator for `basic`'s option-type assertions, so the
split landed here first. Lane 3 then merged as PR #430 (`17849a59`) with
a two-arm split (type check, then a combined non-integer-or-out-of-range
branch keeping the old `and` range message). This branch rebased onto
`17849a59` and resolved the conflict by keeping this lane's three-arm
split — the verbatim Node `lib/internal/validators.js` port (separate
"It must be an integer." arm, `&&` range message) — plus Lane 3's
comments. Both branches agree on the error codes; this lane's messages
are the more faithful ones.

## Differential files

- `vm-lane9-results-2026-11-15.txt` (goal hidden_files): targeted runs
  (flips 2×, guards, base comparison for the three unchanged failures).

## Ship

- Branch: `fix/vm-syntax-error` (worktree `vm-v1-syntax-error`).
- Base at branch time: main `379e84bf`; rebased onto `94340521` (Lane 5,
  PR #431), then onto `626ee62b` (Lane 6, PR #432), then onto `17849a59`
  (Lane 3, PR #430) — validator conflict resolved keeping this lane's
  three-arm split (see "Overlap with Lane 3").
- PR #436 — [merge SHA filled at ship time].
