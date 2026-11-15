# NOTES — vm lane 1: dynamic import interception (3 tests)

## Result
- **Flips (3):** `test-vm-no-dynamic-import-callback` 1→0,
  `test-vm-dynamic-import-callback-missing-flag` 1→0 (each re-run 2x isolated
  on the branch), **plus bonus `test-vm-context-dont-contextify` 1→0**.
- **Bonus flip, why:** lane 8 (partial, #438) fixed the DONT_CONTEXTIFY
  builtins gap and vendored `fixtures/es-modules/message.mjs`, so the
  import block's only remaining blocker was this lane: on base it fails at
  `:227` with `ERR_INVALID_ARG_TYPE` from `new Script` (the symbol
  validator rejected `USE_MAIN_CONTEXT_DEFAULT_LOADER`); with this lane's
  validator exemption + host-loader routing, `await promise` is the same
  namespace object as the test file's own host `import()` (`strictEqual`,
  same URL → same cached module). Branch run: exit 0, stdout 0 bytes,
  stderr 0 bytes.
- **Guards:** all 48 previously-passing `vm` tests still 0 on the branch
  (identical to base); sibling flips `codegen` (lane 4) and `not-strict`
  (lane 7) still 0.
- Repo tests: `tests/vm.test.js` + `tests/export_surface_vm.test.js` 47/47;
  `tests/ondemand-require.test.js` 29/29 (footprint pattern: `src/vm.js` +
  this NOTES file only).

## Mechanism (Node source first)
`lib/internal/modules/esm/utils.js:251-281` (`importModuleDynamicallyCallback`)
+ `lib/internal/vm.js:60` (`getHostDefinedOptionId`):
- no callback registered → reject `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`;
- callback present but `--experimental-vm-modules` off → the callback is
  registered but never consulted → reject
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`;
- callback + flag on → call it as
  `callback(specifier, referrer, attributes, phase)`;
- `USE_MAIN_CONTEXT_DEFAULT_LOADER` → host default loader (+ experimental
  warning in real Node; the shim does not emit it — noted gap, no test
  asserts it).
- Error texts (lib/internal/errors.js:1937-1939): MISSING =
  "A dynamic import callback was not specified."; MISSING_FLAG =
  "A dynamic import callback was invoked without --experimental-vm-modules";
  both TypeError.

The shim stored `importModuleDynamically` (validated it, never kept it) and
`runWithContext`'s eval / `runInThisContext`'s indirect eval let the host
ESM loader run `import()`, so the import resolved instead of rejecting.

## Fix (`src/vm.js` only, +270/-14)
- `Script` now stores `#importModuleDynamically`; `compileFunction` keeps its
  (already-destructured) binding.
- New `rewriteDynamicImports(code)`: lexer-based rewrite of genuine dynamic
  `import(` to a 6-char helper `__vdim(` — same length as `import`, so line
  and column positions are preserved and `enrichScriptError` keeps mapping
  to the original code. Reuses the shim's own lexer (`skipStringLex`,
  `skipTemplateLex`, `skipRegexLex`, `matchBalanced`, `readId`, `KEYWORDS`).
  Skips strings, comments, regexes; recurses into template `${}`
  interpolations (where `import()` is real code); leaves `import.meta`,
  member calls (`x.import(`), and object methods named `import` (a `{` on
  the same line after the balanced parens) alone. Returns the input
  unchanged when there is nothing to rewrite.
- New `makeDynamicImportHandler(callback, getReferrer)`: async helper
  implementing Node's rule above. `getReferrer` is a thunk — compileFunction
  builds its handler before the compiled function exists; the referrer is
  only read when a callback is actually invoked (Script instance for
  Script, the compiled function for compileFunction). Attributes come from
  the import call's options (`with`/`assert`); phase is `"evaluation"`.
- Injection: `runWithContext` takes the handler and passes it as a third
  factory parameter (the direct eval inside `with` sees factory params —
  probe-proven); `compileFunction` does the same (the compiled function
  closes over the factory param — probe-proven). **Rebase update:** lane 7
  rerouted `Script.runInThisContext` through `runWithContext(globalThis)`
  for var/delete semantics, so the original temporary-global install for
  the indirect-eval path is gone — `runInThisContext` now passes the
  handler as `runWithContext`'s 4th argument and the rewrite happens on
  the eval code there. **When no `import(` was rewritten the helper stays
  out of scope entirely** (factory without the parameter), so import-free
  code is byte-identical in behavior.
- Validation fix (found by the flag-on probe): `Script` and `compileFunction`
  rejected `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`
  with `ERR_INVALID_ARG_TYPE` (it is a symbol, not a function). Node's
  `getHostDefinedOptionId` accepts that symbol as-is, so both validators now
  exempt it. This unblocks lane 8's `dont-contextify` import block, which
  uses exactly that value.

## Probes (zz-vm-dynimport2.js, deleted after use; flag-off AND flag-on runs)
- Flag off: all lexical negatives pass (string/template/comment/regex/member
  call/`import.meta` SyntaxError untouched); spaced / newline / comment
  forms of `import(` rewrite to MISSING; context path + top-level-function
  (prefix) path reject MISSING; callback present + flag off → MISSING_FLAG
  with the callback never called.
- Flag on: callback invoked for `Script.runInThisContext` (referrer is the
  Script, attributes `{}`, phase `"evaluation"`), `Script.runInContext`,
  `compileFunction` (referrer is the compiled function), and template
  interpolation; `USE_MAIN_CONTEXT_DEFAULT_LOADER` host-imports `node:fs`
  (has `readFileSync`).
- Base behavior before the fix: both target tests exit 1, "Missing expected
  rejection" (host import resolved `fs`).

## Known limits (ponytail: a full parser is out of scope)
- `import("x")` immediately followed by a `{` block on the same line is
  misread as an object method (ASI case).
- A regex containing the literal text `import(` after an object-literal `}`
  is misread as a call.
- The `USE_MAIN_CONTEXT_DEFAULT_LOADER` experimental warning is not emitted.
- `vm.Module` / SourceTextModule dynamic import is untouched (module family
  is NO-FIX in triage).

## Ship
- Branch: `fix/vm-dynamic-import` (worktree `~/workspace/worktrees/vm-v1-dynamic-import`).
- Base: main `83df7c14` (rebased from `379e84bf`; 6 sibling vm lanes landed
  first: #434 lane 7, #436 lane 9, #437 lane 2, #439 lane 11, #440 lane 10,
  #433 lane 4, #438 lane 8 partial). Third rebase (onto `83df7c14`) was
  clean — no conflicts.
- Rebase history: first rebase (onto `20560b65`) had one hunk in
  `Script.runInThisContext` (lane 7's reroute vs this lane's indirect-eval
  install); composed: `runInThisContext` routes through `runWithContext`
  AND passes the handler. Second rebase (onto `77fed54c`, lane 4) had two
  hunks in `runWithContext` (lane 4's `__vm_e__`/`__vm_w__` factory params
  vs this lane's conditional `__vdim` param); composed by keeping all five
  params in order with matching call args.
- Ship incidents: git-push-api.py failed twice on the git-data API flap
  (blob-create RemoteDisconnected, then parent-GET 404s); pushed via the
  manual git-database-API driver instead. First CI waiter (head-following)
  TIMED OUT after 120 min: it missed the green run on code SHA `0cf5cec4`
  (Parity + build success) because the dist-regen bot commit (`1deda0e9`,
  "chore: regenerate vfs.js") moved the head to a zero-run state. The
  waiter was rewritten to pin its verdict to the code SHA.
- Differential files (goal hidden_files): `vm-v1-base-results.txt`,
  `vm-v1-branch-results.txt`, `vm-v1-guard-list.txt`.
