# NOTES — vm wave V1, Lane 3: Validation error codes

**Test:** `test-vm-options-validation` (1 test).
**Triage:** `triage-vm-2026-11-15.md` Lane 3. Base main `379e84bf`, vm 48/96.

## Mechanism

`validateInt32` (src/vm.js:138) conflated non-number input with out-of-range
numbers — both threw `ERR_OUT_OF_RANGE`. Real Node
(lib/internal/validators.js:118-133) splits the failure: `typeof value !==
'number'` → `ERR_INVALID_ARG_TYPE`; non-integer or out-of-range number →
`ERR_OUT_OF_RANGE`. Same conflation in `validateTimeout` (Node validates vm
timeouts with `validateUint32(timeout, 'options.timeout', true)`,
lib/vm.js:172) and in `validateUint32` (no callers in vm.js today).

## Fix (src/vm.js only, +30/−12)

- `validateInt32`: type check first (non-number → `ERR_INVALID_ARG_TYPE`,
  message follows the file's own `validateString`/`validateBoolean` pattern),
  then integer/range check → `ERR_OUT_OF_RANGE` (message unchanged).
- `validateTimeout`: same split (non-number → TYPE; non-integer or outside
  1..4294967295 → RANGE). NaN is a number → RANGE, matching the test.
- `validateUint32`: same split for family consistency (dead code in vm.js
  today; no callers).

No other validator needed work: `validateObject` (options `42` / `null` /
`"bad"`), `validateString` (filename `123`), `validateBoolean`
(produceCachedData `1`, displayErrors/breakOnSigint), `validateCachedData`
(cachedData `[0]`/`{}`/`true`/`"bad"`/`42`) already threw
`ERR_INVALID_ARG_TYPE`. `normalizeTopOptions` (top-level run* spread) is out
of scope — the test exercises only the `Script` methods, which go through
`normalizeMethodOptions` → `validateObject`.

## Differential (targeted — no full sweep per template)

- Flip: `test-vm-options-validation` 1 → 0, isolated 2× on the branch.
- Guards (15, all 0 on the branch): createcacheddata, source-map-url,
  syntax-error-message, syntax-error-stderr, run-in-new-context,
  create-and-run-in-context, sigint, sigint-existing-handler,
  create-context-arg, context, new-script-new-context,
  new-script-this-context, parse-abort-on-uncaught-exception, strict-mode,
  strict-assign.
- Results file: `hidden_files/vm-v1-options-validation-results.txt`.
- 0 regressions.

## Ship

- PR #___ (filled at ship time)
- Merge SHA: ___ (filled at ship time)
