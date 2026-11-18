# R4b — top-level-await port (Node `lib/internal/repl/await.js`)

## Mechanism

Node's `lib/internal/repl/await.js` (acorn-based) ported to the `acorn` +
`acorn-walk` npm packages (both direct deps, already imported by
`src/runtime/*`; no new dep). The old shim `processTopLevelAwait`
(`src/repl.js`, pre-R4b) wrapped code as `(async()=>{...})()` with NO
return — it always resolved to `undefined` (the value-drop the triage
correction names) — and its `new Function` validity check swallowed the
caret-formatted SyntaxError by returning `null`.

The port is verbatim where it matters:

- Visitors (`ClassDeclaration`, `ForOfStatement`, `FunctionDeclaration`,
  `AwaitExpression`, `ReturnStatement`, `VariableDeclaration`) + the
  ancestor-tracking wrapper over `walk.base`, `state.replace/prepend/
  append`, the last-expression-statement rewrite to
  `return { value: (...) }`, and the caret-formatted SyntaxError path
  (Unterminated → `Recoverable`; pre-`await` errors → `null`).
- Caller (`_defaultEval`, Node `lib/repl.js:439-444`): `code.includes(
  "await")` gate; on a transform throw, the strip-`await` fallback
  re-parse + `isRecoverableError` check (Recoverable vs the SyntaxError).
- Unwrap (`_defaultEval` await branch, Node `lib/repl.js:612`):
  `result = (await raw)?.value` — exactly once. No second await: a
  value that IS a Promise (the last expression of `await p1, p2`) must
  print as a Promise, not as its resolution. The old code awaited
  twice.

## The statement-list problem (`_evalAwait`)

The ported code is a statement list (hoisted declarations + the async
IIFE), but the sandboxed expression wrapper only accepts a single
expression. `_evalAwait` (new method, await branch only) evaluates it:

- useGlobal: indirect eval handles statement lists natively (a hoisted
  `let` persists in the global lexical environment; redeclaration
  throws by itself).
- Sandboxed: split the hoisted declarations from the IIFE, DROP the
  hoists, and `return (iife)`. Dropping is what makes the assignments
  land on the context: a hoisted `let k;` kept in the Function body
  would be function-local, so the IIFE's `k = ...` would update the
  local and be discarded. With the hoist dropped, the assignment
  resolves through the `with` proxy's set trap onto the context. The
  one thing dropping loses is redeclaration: a hoisted `let` name
  already on the context throws `Identifier 'x' has already been
  declared` first (Node's error for the `const k` redeclare case).
  Hoisted `var` names are freely redeclared, as in Node — no check.
  The Function is invoked with `.call(proxy, proxy)` so the
  transform's `this.foo = foo` (FunctionDeclaration visitor) lands on
  the context, not globalThis.
- `ponytail:` the redeclare check answers `n in this.context`, which
  also matches builtin libs/getters installed on the context (a
  `let Buffer` would falsely throw — Node allows a lexical to shadow a
  global property). No test covers it; a precise check needs a lexical
  store the shim does not have.
- The scope proxy is factored into `_scopeProxy()`, shared by the sync
  expression wrapper and `_evalAwait` (behavior-identical move).

## Top-level return (`return 42; await 5;`)

The transform returns `null` (containsReturn), and Node then parses
the code as a script: "Illegal return statement". The shim's
expression wrapper would report "Unexpected token 'return'" instead.
`hasTopLevelReturn` (acorn, `allowReturnOutsideFunction`, function
boundaries not descended into) detects it in the await block, and the
code is indirect-evaled — the parse fails before anything executes,
and the error's `at eval` first frame is what `_handleError` needs
for the source/caret arrow (the test's `line: 3` assertion passes
through that arrow).

## Evidence

- Transform outputs verified against real Node's
  `processTopLevelAwait` (`node --expose-internals`,
  `require('internal/repl/await')`) for 15 sampled inputs, including
  `for await (let i ...)`, destructuring, `const k`, `class Foo`,
  `if (await true) { function bar() {}; }`, `for (var i ...)` — all
  identical, including the caret message for
  `await Promise..resolve()`.
- Probe (`zz-tla-probe.js`, deleted after use): all 54 await-bearing
  cases from `test-repl-top-level-await.js` in order, with the
  sync-declaration lines skipped and `foo`/`koo` seeded on the
  context: **48 passed, 6 failed**. The 6 are all out of region:
  - `Bar`, `j` → `undefined` instead of `ReferenceError` (sloppy
    `has: () => true` claims every name — R1's has-trap region).
  - `for await ... console.log(i)` ×3 → `1/2/3` go to process.stdout,
    not the repl output (Node binds `context.console` to the repl
    output, `lib/repl.js:1109` — createContext, R1's region).
  - `await Promise.resolve(123), Promise.resolve(456)` → shim prints
    `Promise { 456 }` on one line; native prints it multi-line with
    `Symbol(async_id_symbol)` / `Symbol(trigger_async_id_symbol)`
    (util.inspect promise rendering — `src/util.js` region).
- The vendored test still fails, first at `let dd;` (a plain
  declaration, no await — the sync path's expression-only wrapper
  cannot evaluate declarations). The flip needs follow-up lanes (see
  below); this lane is convergent (Z4 precedent): the value-drop fix
  is real and verified, with zero regressions.

## Verification (branch head, vs base `9b1ba043`)

- Guards exit 0: colors, options, recoverable, context,
  programmatic-history.
- Full repl differential (fast-sweep `--target repl --force --jobs 2`):
  base 93/101, branch 93/101, diff EMPTY — **0 flips, 0 regressions**.
  CSVs: `hidden_files/fast-sweep/repl-r4b-base-2026-11-18.csv`,
  `repl-r4b-branch-2026-11-18.csv`.
- `test-repl.js` (manual, no dash) + `test-repl-require.js` fail
  identically on base and branch ([1,1] isolated on both) — both are
  module-resolution failures (`src/module.js` `moduleNotFound`,
  "Require stack:" format) in R7's region (`replModule.paths` /
  `Proxy.require`). Note for the wave record: on `9b1ba043` only
  `recoverable` of R2's three claimed flips holds; the reproducible
  count from that commit is 94/102 (93 sweep + reverse-search isolated
  + test-repl.js failing), which matches the banked 94.
- Footprint test green. `node --check src/repl.js` clean.
  `node src/build-vfs.mjs` exit 0 (dist/ reverted — CI bot owns it).

## What still blocks the flip (follow-up lanes, not this one)

1. **Sync-path declaration persistence** (first failure: `let dd;`,
   then `let [ii, ...]`, and the setup `function foo`/`koo`): the
   sandboxed expression wrapper cannot evaluate declarations. Needs a
   script-style eval for declarations in the sandboxed path
   (declarations rewritten to context assignments, as the await
   transform does).
2. **Has-trap ReferenceError** (`Bar`, `j`): sloppy `has: () => true`
   returns `undefined` for undeclared reads instead of throwing.
   R1's region; changing it risks sloppy-assignment persistence.
3. **`context.console` → repl output** (the three `for await`
   `console.log` cases): Node `lib/repl.js:1109`. createContext, R1's
   region.
4. **util.inspect promise symbols** (the `Promise {` case):
   `src/util.js` region.
5. **SIGINT interruption** (`ctrlCTest`): `breakEvalOnSigint` is inert
   (no watchdog) — a new feature, not a fix.

## Ship

- PR #___ / merge SHA: ___
- Branch: `fix/repl-top-level-await` (base `9b1ba043`).
- Files: `src/repl.js` only + this NOTES file.
- Count: repl stays **94/102** (no flip; convergent).
