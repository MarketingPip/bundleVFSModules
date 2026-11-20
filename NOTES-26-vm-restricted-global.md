# NOTES — Node 26 Wave 1 lane: vm-restricted-global

Base: `origin/main` @ `d587825d` (PR #506 triage merged).
Lane: `NOTES-26-triage-vm.md` §Family D — `global-restricted-property`, 1 flip.
Branch: `fix/26w1-vm-restricted-global`. Worktree: `~/workspace/worktrees/26w1-vm`.

## Result

- `test-vm-global-restricted-property.js`: **fail → pass**.
- Full vm guard (Node 26 suite via `parity/drift/run-baseline.mjs --modules vm
  --jobs 2`): **66/101 pass** (baseline 65/101), 34 fail, 1 timeout.
  Per-test diff vs `parity/drift/node26-baseline.jsonc`: exactly one status
  change (`test-vm-global-restricted-property.js` fail → pass); the same
  timeout (`test-vm-timeout.js`, Family C NO-FIX); zero baseline passes lost.
- Repo jest: `tests/vm.test.js` + `tests/export_surface_vm.test.js` **47/47 pass**.
- No `// Flags:` header on the flipped test; run directly under the harness.
- All `zz-*.js` probes deleted; `parity/node-test/` verified clean after the
  guard run (runner restored it).

## Spike verdict: PROVED (with two design corrections)

The triage's proposed approach (have `skipLexical` return bound names, check
against non-configurable own properties) proved out — but the naive form of
it was disproved by probe and had to be corrected:

1. **Oracle** (`~/workspace/local/node-26/bin/node`, v26.13.1;
   `/tmp/oracle-restricted{,2,3}.js`, ~60 cases): `let`/`const`/`class`/
   `function` (incl. `async`/`function*`) over a non-configurable own
   property throw `SyntaxError: Identifier 'foo' has already been declared`;
   `var` does NOT throw; configurable properties do NOT throw; writable
   non-configurable still throws; destructuring binds (`{foo}`, `{x: foo}`,
   `[foo]`, nested, rest, defaults on the bound name); default values
   (`{a = foo}`), computed keys (`{[foo]: a}`), and property keys
   (`{foo: bar}`) do NOT bind; sloppy `let = 2`, block/function/if-body/
   `for-of` `let foo`, and strings/comments/templates/regex containing
   `let foo` do NOT throw; ASI `let foo = 1\nlet bar = 2` throws for `bar`.
2. **Structural extractor** (`/tmp/spike-extract.js`): the REAL `scanScript`
   extracted verbatim from `src/vm.js`, with ONLY `skipLexical` patched in
   the copy to collect names via a structural pattern parser. Battery of 71
   oracle-labelled cases: **70/71** (with the line-809 fix below), 69/71
   without it. The single remaining miss is ASI two-decls (see Ceiling).
3. **Naive `collectPatternIds` reuse DISPROVED**: on `a = foo`,
   `a = foo, bar`, `[foo]: a`, `a: b = foo`, `a = {x: foo}` it returns `foo`
   as a binding — 5 shapes where the oracle does NOT throw. The lane
   therefore parses patterns structurally (`parsePattern` /
   `parseBindingElement` / `skipDefault`) instead of reusing
   `collectPatternIds` for lexical names. (`parseVarDeclarators` keeps using
   it for `var` — pre-existing over-collection there is harmless because
   `var` names are only pre-declared, never checked.)
4. **Risk 1 cleared**: only top-level bindings count — the `let`/`const`
   branch in `onWord` already gates on top-level + `declPos` + a following
   `{`/`[`/identifier, so sloppy `let` and block-scoped `let`s never reach
   the collector (extractor battery: all such cases predict NO, matching
   the oracle).
5. **Risk 2 decided — let/const ONLY**: `class` has no scanner support and
   top-level `function` capture is incomplete (`async function` at the top
   level is not captured by `onWord`), so covering them would be partial.
   No test covers them; they are a documented ceiling, not a silent gap.
6. **Risk 3 cleared**: destructuring yields every bound name structurally
   (see battery: nested/rest/rename/default-on-binding all correct) and
   never yields default-value or computed-key identifiers.

## Implementation (`src/vm.js`, +161/−41, one file)

- `scanScript` (`src/vm.js:739`): new `lexical` array, returned alongside
  `functions`/`vars`/`assigned`.
- `skipLexical` rewritten as a declarator-list parser mirroring
  `parseVarDeclarators` (plain ids + `{`/`[` patterns, `=` initializer skip,
  `,` continuation), collecting into `lexical` via the new structural
  `parsePattern` / `parseBindingElement` / `skipDefault`. This also removes
  the old extent walker's call to undefined `skipCommentLex` (`src/vm.js:896`
  on main) — a live crash: pre-fix,
  `vm.runInContext('let foo = 1 /* c */, bar = 2;', ctx)` threw
  `ReferenceError: skipCommentLex is not defined` (proven by the zz probe).
- `skipInitializer` (`src/vm.js:809`): `skipWs(code, j)` → `skipWs(j)` —
  the inner `skipWs` takes one argument, so a comment inside an initializer
  corrupted `j` to the code string and truncated the whole scan (spike:
  `comment-in-init` failed without this one-token fix, passed with it).
- `runWithContext` (`src/vm.js:1699`): after the scan, each lexical name is
  checked with `Object.getOwnPropertyDescriptor(target, name)`; a
  non-configurable own property throws a host `SyntaxError` with V8's
  message (`Identifier '<name>' has already been declared`) before any
  pre-declaration or execution. A throwing descriptor trap is treated as
  "not restricted" (fail-open). The test only checks the constructor, and
  under the shim the context's `SyntaxError` resolves to the host one, so
  `instanceof` passes.
- `zz-vm-restricted-global-spike.js` (31 assertions, deleted after use):
  pre-fix 13 FAIL / 18 PASS exactly as predicted (incl. the
  `skipCommentLex` ReferenceError and a `destr-nested` TypeError that the
  pre-check now pre-empts); post-fix **31/31 PASS**, exit 0. One
  implementation bug caught by the probe and fixed in the same turn:
  `getOwnPropertyDescriptor` returns `undefined` (not `null`) for absent
  properties — the first version threw `TypeError: Cannot read properties
  of undefined (reading 'configurable')` on any unbound lexical name.

## Ceiling / known misses

- `class` / `function` declarations over restricted globals: NOT covered
  (see Risk 2 decision). Oracle throws for both; the shim does not.
- ASI: `let foo = 1\nlet bar = 2;` with restricted `bar` is missed — the
  initializer skipper cannot see the ASI boundary, so the second
  declaration is consumed as initializer text. Pre-existing scanner
  limitation shared with `var`/`assigned` scanning; false-negative only
  (same as today's behaviour, no regression). Fixing it needs ASI-aware
  expression scanning — out of scope for this lane.
- `parseVarDeclarators` still over-collects pattern identifiers via
  `collectPatternIds` (unchanged, harmless for `var`).

## Ship

- PR: #509
- Merge SHA: `03d7f9cce13143e1869475b165d406be3389e736` (squash-merge of PR #509)
- Final count: **vm 66/101** (65 banked + 1 flips, 0 regressions)
