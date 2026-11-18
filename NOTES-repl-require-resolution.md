# NOTES — repl require resolution + require-stack (R7)

Lane: R7 of the repl wave. Base: main `9b1ba043` (PR #472, R2), parent-verified
94/102; rebased onto main `af051744` (PR #473, R4b) — see §4. Expected: +2 →
96/102 (test-repl-require, test-repl.js). Note: the recorded count after R4b
was 95/102, but R4b's flip does not hold on live main (§4), so the true
pre-R7 count is 94/102 and this lane lands at 96/102, not 97/102.

## 1. The two briefed fixes

### 1a. `replModule.paths` was empty — `src/repl.js:693`

Was: `replModule.paths = []; // No lookup paths in a browser`.

Node: `replModule.paths = CJSModule._resolveLookupPaths('<repl>', parentModule)`
(`lib/repl.js:1119`), where `parentModule` is the repl builtin module itself
(`lib/repl.js:183`). `_resolveLookupPaths` for a REPL parent (null filename)
returns `["."]` for relative requests (`lib/internal/modules/cjs/loader.js:995+`,
comment "In REPL, parent.filename is null"), and the node_modules walk comes
from `_nodeModulePaths` on the parent's path.

Native probe (CWD = `parity/node-test/fixtures`, host Node v24.22.1): the repl
module's `paths` walk from `<cwd>/repl/node_modules` up to `/node_modules`
plus the globals (`$HOME/.node_modules`, `$HOME/.node_libraries`,
`/usr/lib/node`); `module.filename` is null, id is `<repl>`.

Fix: `replModule.paths = CJSModule._nodeModulePaths("repl")` (the shim's
`_nodeModulePaths`, `src/module.js:1116`, already mirrors Node's walk).
`CJSModule` is `Module` and `_nodeModulePaths` is its static — no import
change. The relative-request `["."]` rule is already mirrored by the shim's
`_resolveLookupPaths` (`src/module.js:1193`), so relative requires keep
failing honestly. Browser-sandbox CWD "/" degrades the walk to
`["/repl/node_modules", "/node_modules"]`.

Effect: `require("baz")` in the repl now resolves
`fixtures/node_modules/baz/index.js` (vendored by R0); `require("./baz")`
already worked.

### 1b. `getRequireStack` excluded `'<repl>'` — `src/module.js:1389`

Was: `else if (p.id && p.id !== "<repl>") stack.push(p.id)`.

Node: `lib/internal/modules/helpers.js:482` pushes `cursor.filename ||
cursor.id` unconditionally — `'<repl>'` IS in the stack. Native probe:
`require("./bar")` from the repl throws with requireStack `["<repl>"]`
and the message head `Cannot find module './bar' / Require stack: / - <repl>`.

Fix: drop the exclusion — `if (p.filename) stack.push(p.filename); else if
(p.id) stack.push(p.id);`.

Effect: test-repl.js's `internal/repl` case now prints `Require stack:\n-
<repl>` exactly as Node does (and the props block `code` /
`requireStack` is populated).

## 2. Corrections to the R2 report (both verified, both acted on)

### 2a. `fixtures/node_modules/bar.js` is NOT supposed to be missing

The brief (parent-verified on live main) said bar.js is SUPPOSED to be missing
because test-repl-require:64-68 asserts `require("./bar")` throws
`Cannot find module './bar'`. That claim is WRONG, proven three ways:

1. **The tarball HAS `test/fixtures/node_modules/bar.js`** (1,208 bytes,
   extracted from the SHA256-verified Node v24.20.0 tarball).
2. **`fixtures/node_modules/baz/index.js` (vendored verbatim by R0)
   UNCONDITIONALLY requires `bar`** (line 26: `require('bar')`, asserted
   equal to `require('../bar.js')`). Without bar.js, `require("baz")`
   cannot succeed — the test's own line 38 (`require("baz")`) fails first.
3. **Native run proves it**: real Node fails test-repl-require at test:38
   with the fixture tree as vendored (bar.js absent) — the `doesNotMatch
   /Cannot find module/` assertion fails because `require("baz")` loads
   `baz/index.js`, whose `require('bar')` throws `Cannot find module
   'bar'` with requireStack `['.../fixtures/node_modules/baz/index.js',
   '<repl>']`.

Block 2's `./bar` assertion is about RELATIVE resolution (CWD-based,
#30808 — relative requires do NOT consult node_modules) and holds whether
or not `fixtures/node_modules/bar.js` exists; the test was written knowing
node_modules/bar.js exists (that IS the point of #30808).

**Action: `parity/node-test/fixtures/node_modules/bar.js` vendored verbatim
from the tarball, cmp-verified byte-identical (1,208 B).** No other fixture
was vendored in this lane. `fixtures/node_modules/baz/node_modules/asdf.js`
already exists (R0) — confirmed, not re-vendored.

### 2b. R2 NOTES §10 "Blocked" — the `_handleError` props-block gap

R2 scoped "preserving the `code`/`requireStack` props block only makes sense
once `requireStack` is correct" to a future lane. R7 IS that lane (§1b
above), so the props-block work below (§3) is in scope here, not a scope
expansion. The R2 comment claiming the props block "is dropped with the
machinery frames" is stale for the cut=-1 shape (the debug probe proved the
props block prints when no eval-dispatch line exists).

## 3. What test-repl.js actually needed (all masked by the stackTraceLimit failure)

R2's branch failed test-repl.js ONLY at the stackTraceLimit case, so the
later cases were never exercised. Fixing §1 unmasked six further divergences,
each probe-proven and each fixed in `src/repl.js` (no new files, no new
deps — acorn was already imported). All are required for test-repl.js to
pass; none is a scope expansion beyond "make test-repl.js pass", which is
the briefed flip.

### 3a. `_handleError` frame cut, cut = -1 — `src/repl.js` `_handleError`

Node's `overrideStackTrace` (`lib/repl.js:643`) slices frames to before the
last null-named frame; with none found idx=-1 → `slice(0, -1)` drops the
LAST captured frame (5 captured at stackTraceLimit=5 → 4 printed). The shim
only handled cut ≥ 0 (an `at eval (<anonymous>)` dispatch line exists).
For the `internal/repl` case there is no dispatch line (the stack was
truncated before it), so cut stayed -1 and all 5 frames printed.

Fix: an `else if (cut === -1)` branch — drop the LAST `^    at ` frame line
(Node's `slice(0,-1)`), KEEP the trailing props block, and transfer the
` {` suffix to the new last frame line when a props block follows. Verified
against the native shape: exactly 4 frames + ` {` + props block.

Also verified by instrumentation (temporary debug print, reverted): the
throw case has TWO eval frames, cut=2 → only the message line is kept
(`Uncaught Error: test error`).

### 3b. Greedy `.value` unwrap removed from the sync branch — `_defaultEval`

Was: `result = raw && typeof raw === "object" && "value" in raw ? raw.value
: raw` at both sync sites (main path + SyntaxError-retry path). It fired on
ANY object with a `value` property: a generator's `{value: undefined, done:
true}` printed as `undefined` (test-repl.js generator case).

No `{value, syncError}` "SyncPromise" wrapper producer exists anywhere in
`src/` (grep: only unrelated hits in `src/fs.js` + test files); the comment
referenced a nonexistent concept. The `.value` unwrap belongs ONLY to the
await branch (R4b: Node's `lib/internal/repl/await.js` rewrites the last
expression to `return {value: (...)}`). `processTopLevelAwait` returns null
when no `await` is present, so the generator case is sync-path.

Fix: removed both sync-branch unwraps. The await branch is untouched (R4b
owns it).

### 3c. `require('repl')` identity — `makeReplRequire` + `addBuiltinLibsToObject`

Probe-proven: the repl context's `repl` is the NATIVE Node repl module, not
the shim. `process.getBuiltinModule('repl')` under the harness returns
native (its `start` source is byte-identical to native's; `__bvm_process_final__`
is undefined under the harness; `getBuiltinModule(repl) === require(repl)`
is false; writer identity false). Chain: `addBuiltinLibsToObject` getter →
`replModule.require('repl')` → `Module._load` → `loadBuiltinModule`
(`src/module.js:1490`) → `process.getBuiltinModule('repl')` → NATIVE.

So the test's `repl.writer.options.showProxy = false` mutated the NATIVE
writer's options while the server prints with the SHIM writer
(`r.writer !== context repl.writer`, probe-proven). In real Node,
`require('repl')` inside the repl returns the same module that owns the
server.

Fix (two sites, same contract — the bare identifier and the typed require
take different paths):
- `makeReplRequire` (`src/repl.js:368`): `id === "repl" || id ===
  "node:repl"` → return `replExports` (the module-level exports const).
- `addBuiltinLibsToObject` getter: `name === "repl"` → `replExports`
  instead of `replModule.require(name)` (the bare `repl` identifier goes
  through this getter, NOT through `context.require` — the first fix alone
  did not cover it; the showProxy case still failed until the getter was
  fixed).

Deliberately NOT fixed globally in `loadBuiltinModule`: that would change
what every CJS require of a builtin returns under the harness (e.g.
`context.require('fs')` currently returns native fs and passing tests may
depend on it) — suite-wide blast radius, adjacent to the parked process
eager-load question. Only `'repl'` itself is identity-asserted by a repl
test.

### 3d. Bare newline vs whitespace-only line — `_defaultEval`

Was: `if (code.trim() === "") return cb(null);` (1 arg → finish prints
nothing). The test's "Whitespace is not evaluated" case (`" \t  \n"`,
expects `undefined`) timed out — the repl sent only a prompt.

Node `lib/repl.js` defaultEval: `if (code === '\n') return cb(null);` —
EXACTLY a bare newline gets the 1-arg callback; a whitespace-only line
goes through normal eval and prints `undefined`. Probe-proven natively:
bare `"\n"` → prompt only; `" \t  \n"` → `undefined\n` + prompt.

Fix: `if (code === "\n") return cb(null);`. The R2 comment about the bare
newline was right about the mechanism and wrong about the condition.

### 3e. Arrow source line — `syntaxArrow`

Was: the arrow source was the FIRST line of the buffered input (R2 NOTES §9
rationale: the `{}),({}` case expects the first line). The multiline-object
case `x = {\nfield\n{` expects `"| | {"` — the error is on line 3, not
line 1.

Node's arrow comes from V8 (via vm.Script) and points at the source LINE
containing the error position. The shim has no V8 frame objects, so the
position is re-derived with acorn (already imported): `acorn.parse(src,
{ecmaVersion: "latest", allowAwaitOutsideFunction: true})` and its
SyntaxError `loc.line` selects the line (clamped). Acorn's loc matches V8's
arrow line on every probed case (`x = {` → 3, `{}),({}` → 1, `...[]` →
1, `(2 + 3))` → 1, missing-comma → 1). If acorn cannot locate the error
(parses fine, or no loc), fall back to the first line. The caret heuristic
is unchanged (the test only asserts the kArrow shape).

### 3f. `toDynamicImport` ported from Node — `src/repl.js:258`

Was: a regex version that printed `const comeOn = await import('fhqwhgads');`
for a default import. Node (`lib/repl.js:228`) is acorn-based and prints
`const { default: comeOn } = await import("fhqwhgads");` — default
specifiers destructure the default export, and the source is JSON-quoted
(double quotes).

Fix: faithful port of Node's function (parse the line as a module with
acorn, take `body[0]` — no acorn-walk needed for a single-line import):
0 specifiers → `await import(...);`; single namespace specifier → `const
<name> = await import(...);`; otherwise → `const { <names> } = await
import(...);` with `local.name === imported?.name ? local.name :
`${imported?.name ?? 'default'}: ${local.name}``. Covers all seven import
cases in test-repl.js (default, named, namespace, bare, aliased, mixed).
A try/catch falls back to the old shape if the line is not parseable (Node
would throw here; the shim's call site is inside `_defaultEval`, so a
fallback avoids masking the original error).

### 3g. Top-level let/const leak onto globalThis — `persistTopLevelLexical`

`let npm = () => {};` (test-repl.js) passed its case (`undefined`) but the
test's exit-time `leakedGlobals` check (`for...in` over globalThis,
`parity/node-test/common/index.js:420`) failed with `Unexpected global(s)
found: npm`.

Root cause: `persistTopLevelLexical` (R2) rewrites top-level `let`/`const`
to `var` so the bindings survive indirect eval — and `var` creates an
ENUMERABLE global property. In Node's repl, top-level let/const are lexical
(they never appear on globalThis).

Fix: `persistTopLevelLexical` now also returns the declared names (including
destructured bindings, via a small recursive pattern walk), and `_defaultEval`
redefines each as non-enumerable after a successful eval
(`Object.defineProperty(globalThis, name, {...desc, enumerable: false})`).
Bare-identifier resolution is unaffected (enumerability does not gate
property lookup); only `for...in` / `Object.keys` visibility changes, which
is exactly Node's shape. Fidelity wart, noted in the code: `globalThis.<name>`
still resolves where Node's is undefined — the alternative is a persistent
lexical scope, a redesign of the eval path. Non-configurable names (a real
global of the same name) are left alone.

## 4. Verification (branch head, worktree `repl-r7-require-resolution`)

- Flips 2× isolated, exit 0 each:
  - test-repl-require: 0, 0
  - test-repl.js: 0, 0
- Guards, exit 0 each: test-repl-colors, test-repl-options,
  test-repl-recoverable, test-repl-programmatic-history,
  test-repl-programmatic-history-setup-history, test-repl-context,
  test-repl-persistent-history — all 0.
- Full repl differential (FIRST run, vs base `9b1ba043`): fast-sweep
  `--target repl --force --jobs 2`, branch `repl-r7-branch-2026-11-18.csv`
  (94 pass / 1 timeout / 6 fail, 101 rows) vs base
  `repl-r7-base-2026-11-18.csv` (93 pass / 1 timeout / 7 fail, 101 rows).
  Delta: EXACTLY ONE change — test-repl-require.js 1 → 0. ZERO regressions.
  Branch non-zero: envvars 124 (NO-FIX harness stall, same at base), mode 1
  (R5 gate), preview 1 (NO-FIX, V8 inspector), reverse-search 1 (known
  TEST_THREAD_ID sweep flake — isolated re-runs on the branch are [0,0]
  2×, same as triage), tab-complete-import 1 + tab-complete-require 1 (R3
  targets), top-level-await 1 (R4b target). test-repl.js (non-glob, outside
  fast-sweep's pattern) is [0,0] 2× on the branch, [1,1] at base.
- REBASE (R4b merged first): while PR #474's first CI run was green,
  main moved to `af051744` (PR #473, R4b top-level-await) and the PR went
  mergeable:false / dirty. Rebased `fix/repl-require-resolution` onto
  `af051744` — clean, no conflicts; new head `e25cb2f0`. The rebase result
  was verified region by region: R4b's await-branch `.value` unwrap
  (`result = (await raw)?.value`, Node lib/repl.js:612) is present AND the
  sync branch still has no unwrap — both survive together.
- **R4b flip does NOT hold on live main (found during the rebase
  re-verification, NOT a regression):** test-repl-top-level-await fails
  exit 1 on main `af051744` AND identically on this branch — same test,
  same line, same error (`let dd;` → `Uncaught SyntaxError: Unexpected
  identifier 'dd'`, caret under `dd`). Root cause: the TLA test's repl
  server is SANDBOXED (not useGlobal), and the sandboxed `runFn` wraps
  code as `return(${c.trim()})` — an expression-only wrapper. A `let`
  declaration is a statement; in expression position `let` parses as an
  identifier, so `dd` is unexpected. This is the pre-existing architecture
  ceiling the code itself documents ("declarations ... buffer as
  Recoverable instead of evaluating ... not this lane"). Fixing it means
  making the sandboxed runner handle statements (a real script eval) —
  out of this lane's region; a follow-up lane owns it. Consequence for the
  count: the true pre-R7 count on live main is 94/102, not the recorded
  95/102 — R4b's +1 does not bank. This lane's +2 therefore lands at
  **96/102**, not 97/102. (Parent verify-merge adjudication to confirm.)
- Full repl differential (SECOND run, vs new base `af051744`):
  branch `repl-r7-branch2-2026-11-18.csv` (94 pass / 1 timeout / 6 fail,
  101 rows, missing=0) vs base `repl-r7-base2-2026-11-18.csv` (93 pass /
  1 timeout / 7 fail, 101 rows, missing=0). Delta: EXACTLY ONE change —
  test-repl-require.js 1 → 0. ZERO regressions. Branch non-zero is the
  same set as the first run (envvars 124, mode, preview, reverse-search
  sweep flake, tab-complete ×2, top-level-await). (One mid-run read of the
  base CSV showed 100 rows with envvars missing — a read-timing artifact:
  the sweep's DONE line reports rows=101 missing=0, and envvars isolated
  on base `af051744` is 124, same as everywhere else.) test-repl.js
  (non-glob) is [0,0] 2× on the rebased branch. Total: 94 + 2 flips −
  0 regressions = 96/102.
- Footprint test: 29/29 green (`tests/ondemand-require.test.js`).
- `node --check` clean on `src/repl.js` and `src/module.js`.
- Native cross-checks (host Node v24.22.1): test-repl-require fails natively
  without bar.js (test:38) and test-repl.js passes natively (exit 0).

## 5. Files changed

- `src/repl.js` (+214/−28 across the file — see §1a, §3a–§3g)
- `src/module.js` (getRequireStack, §1b)
- `parity/node-test/fixtures/node_modules/bar.js` (vendored verbatim from
  the Node v24.20.0 tarball, 1,208 B, cmp-verified — §2a)
- `NOTES-repl-require-resolution.md` (this file)

No `package.json` change. No new dependency (acorn was already imported by
`src/repl.js`). No test file changed. No other module touched.

## 6. Ship

- PR: #474
- Merge commit: 99fdc0cc (squash-merged 2026-11-18)
- Branch: `fix/repl-require-resolution`
- Count after merge: 94 → 96/102 (true pre-R7 count on live main is 94, not
  the recorded 95 — R4b's top-level-await flip does not hold on live main,
  §4; + 2 flips verified 2× on the rebased branch − 0 regressions in the
  differential vs `af051744`).
