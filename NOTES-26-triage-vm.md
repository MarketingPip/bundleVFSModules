# NOTES — Node 26 re-target triage: vm (36 gaps)

Base: `origin/main` @ `3c091022` (drift detector). Host Node v24.22.1.
Node 26 binary verified first: `~/workspace/local/node-26/bin/node --version`
= `v26.13.1`. Node 26 source: `~/workspace/local/node-26-src/`.
DOCS ONLY — no `src/` change, no shim code, no `package.json` edit.

## Banked numbers (parent-verified, used as given)

vm: 101 tests, 65 pass, 35 fail, 1 timeout. Oracle: gap 36,
fails-natively 0, native-timeout 0. Gap list:
`~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node26-triage/gaps-vm.json`
(36 tests; every entry `harnessExit` 1 except `test-vm-timeout.js` 124,
every entry `nativeExit` 0).

## Reconciliation with the v24 closure (arithmetic closes exactly)

- v24.20.0 test tree (tarball `hidden_files/node-src/node-v24.20.0.tar.gz`):
  97 `test-vm-*` files. The v24 triage (`triage-vm-2026-11-15.md`) counted
  96 — its sweep glob missed the one `.mjs` file
  (`test-vm-module-referrer-realm.mjs`, 0 hits in
  `fast-sweep/vm-sweep-2026-11-15.csv` and the wave-end CSV).
- Node 26 tree: 101 files = 97 + 4 genuinely new (absent from the v24.20.0
  tarball): `test-vm-global-restricted-property.js`,
  `test-vm-property-definer-interception.js`,
  `test-vm-property-definer-partial-update.js`,
  `test-vm-proxy-sandbox-property-query.js`.
- 26 baseline: 65 pass = 62 (v24 ceiling: 48 + 14 lane flips, all landed
  on main) + 3 (the three new tests that pass). 36 gaps = 34 v24 NO-FIX +
  1 unadjudicated-in-v24 (`referrer-realm`, ESM family) + 1 new-in-26
  (`global-restricted-property`).
- The 4 new tests: 3 pass under the v24 shims, 1 gaps. No new-test
  regression anywhere else in vm.

## Test-file drift v24 → v26 (34 pre-existing gap tests)

Every one of the 34 pre-existing gap tests differs textually from its
vendored v24 copy — but a normalized comparison (strip all quote chars,
backslashes and whitespace, then `difflib` opcode diff) shows the ONLY
deltas are Node's lint reformat: single→double quotes and trailing-comma
removal/addition. Representative opcode output: all non-equal blocks are
`,` insertions/deletions at call/object/array tails
(e.g. `test-vm-module-link.js`, `test-vm-module-modulerequests.js`).
No assertion, no mechanism, no flag changed in any of the 34. The v24
adjudications therefore carry over verbatim; nothing was re-diagnosed
from scratch.

## Changelog / export-surface / lib drift (no vm change)

- Export diff (`parity/drift/node26-export-diff.md:49,57`): vm `0 | 0 | 0 | 0
  | 0` — no export-surface change.
- Changelog cross-check
  (`research_notes/node-24-to-26-drift-20261119-1722/cross-check-changelog-2026-11-19.md:54`):
  "vm: no change found in 25/26.0.0". The 25.0.0 JSPI-for-WebAssembly note
  is vm/wasm-adjacent; no gap test touches it.
- `diff` of `lib/vm.js` v24.20.0 → v26.13.1: exactly 2 hunks, both
  cosmetic — an `ObjectPrototype` import plus the default sandbox
  `{}` → `{ __proto__: ObjectPrototype }` (`createContext` default
  parameter). No behavioural change. The shim's gap is therefore a v24
  gap carried forward, not 26 drift.

## Families (36 = 25 + 7 + 3 + 1)

### Family A — ESM `vm.Module` (25, NO-FIX)

`module-after-evaluate`, `module-basic`, `module-cached-data`,
`module-dynamic-import-promise`, `module-dynamic-import`,
`module-dynamic-namespace`, `module-errors`,
`module-evaluate-source-text-module`,
`module-evaluate-synthethic-module-rejection`,
`module-evaluate-synthethic-module`,
`module-evaluate-while-evaluating`, `module-hasasyncgraph`,
`module-hastoplevelawait`, `module-import-meta`, `module-instantiate`,
`module-link-shared-deps`, `module-link`,
`module-linkmodulerequests-circular`, `module-linkmodulerequests-deep`,
`module-linkmodulerequests`, `module-modulerequests`,
`module-reevaluate`, `module-referrer-realm.mjs`, `module-synthetic`,
`timeout-escape-promise-module`.

- 24 of these are the v24 NO-FIX ESM family
  (`triage-vm-2026-11-15.md`, "needs a real V8 module graph (linking,
  namespace exotic objects, TLA, module map, source-text-module default
  loader)").
- `module-referrer-realm.mjs` is the 25th: it existed in v24.20.0 but was
  never swept or adjudicated (glob missed `.mjs`). Its mechanism is the
  same family — it imports `SourceTextModule` from `node:vm` and drives
  `link`/`evaluate` plus a per-context `importModuleDynamically`
  referrer-resolution case. New adjudication here, same reason.
- Shim evidence: `src/vm.js` exports no `Module` / `SourceTextModule` /
  `SyntheticModule` at all — the default export (`src/vm.js:2448-2458`)
  lists only `Script, compileFunction, constants, createContext,
  createScript, isContext, measureMemory, runInContext, runInNewContext,
  runInThisContext`; the header (`src/vm.js:30-31`) says the classes
  "are not available without a module loader; they throw on construction"
  (in fact they are absent entirely, so construction fails earlier).
- Native probe (Node 26.13.1, `~/workspace/local/node-26/bin/node`):
  without the flag the classes are still gated —
  `typeof vm.SourceTextModule === 'undefined'` (same for `Module`,
  `SyntheticModule`); with `--experimental-vm-modules`,
  `new vm.SourceTextModule('export const a=1;')` constructs, status
  `unlinked`. So the harness's missing-`Flags:` handling is a second,
  independent failure layer (v24 triage harness finding), but the shim
  lacks the classes outright — a future ESM-loader lane must fix the
  shim AND the flag path.
- Isolated harness signatures (exact baseline invocation,
  `PARITY_TARGET=vm`, host v24.22.1 — see §Isolated re-runs):
  `module-basic.js:76` → `TypeError: SourceTextModule is not a
  constructor`; `module-referrer-realm.mjs:4` → `SyntaxError: The
  requested module 'node:vm' does not provide an export named
  'SourceTextModule'`.
- Classification: real shim work in principle (a new ESM-loader
  subsystem), NO-FIX as a lane — same call as the v24 triage and the
  http2 triage. No lane candidate.

### Family B — V8-isolate semantics (7, NO-FIX)

`context-async-script`, `function-declaration`,
`global-property-prototype`, `global-setter`, `harmony-symbols`,
`proxies`, `script-after-evaluate`.

All 7 are the v24 NO-FIX V8-isolate family (`triage-vm-2026-11-15.md`:
"each needs a real V8 context: per-context intrinsics (Symbol/Proxy/
Object.prototype), per-context microtask queues, nested-sloppy-`this`
binding, and a distinct global proxy. The shim is `with`/Proxy-based on
the host globalThis (`src/vm.js` header)"). Mechanisms re-confirmed
against the Node 26 test files (semantically identical to v24, §above):

- `context-async-script` (`test-vm-context-async-script.js:29-35`):
  sandbox is given the host `setTimeout`; the in-context timer callback
  `x = 3` must land on the context global (`sandbox.x === 3` and
  `ctx.x === 3`). Isolated harness: `AssertionError: undefined !== 3`
  at `:34` — the callback runs on the host queue and the assignment
  never lands on the context.
- `function-declaration` (`:42-49`): the run must return function `b`,
  `o.b` must be a function, `res === o.b` — needs declarations to land
  on the context global and `(function(){return this})()` to be the
  context global. Isolated harness: `typeof res` `'undefined'` vs
  `'function'` at `:42`.
- `global-property-prototype`: prototype-chain descriptor semantics of
  the context global (outer-proto vs self properties).
- `global-setter`: global-proxy setter receiver semantics
  (`getSetPropReceiving*` descriptors on the global proxy).
- `harmony-symbols` (`:27-37`): "The sandbox should have its own Symbol
  constructor" — `sandbox.Symbol !== Symbol` unless copied in.
- `proxies` (`:11-18`): `sandbox.Proxy !== Proxy` unless copied in —
  per-context `Proxy`.
- `script-after-evaluate`: per-context microtask queue draining
  (`microtaskMode: 'afterEvaluate'`; a promise created in the inner
  context must not resolve in the outer context until the queue is
  drained by a later `runInContext('')`).

Native probes (Node 26.13.1) proving the gap needs a real isolate:

- P3a: `vm.runInContext('Array', ctx) === Array` → `false`;
  `vm.runInContext('Symbol', ctx) === Symbol` → `false`.
- P3b: host sloppy `(function(){ return this; })() === globalThis` →
  `true`; in-context sloppy `(function(){ return this; })() === this`
  → `true` — the context has its own sloppy-`this` global. The shim's
  header admits the opposite: "a nested sloppy function's `this` is the
  host globalThis rather than the sandbox global" (`src/vm.js:22-24`).
- P3c: `setTimeout` inside a context assigns `x = 3` on the context
  global natively (`sb.x` → `3` after the timer).

Classification: NO-FIX, all 7. No lane candidate — every one needs
per-context intrinsics / a distinct global proxy / a per-context
microtask queue, none of which a `with`/Proxy shim on the host
globalThis can mint.

### Family C — Timeout interrupt (3, NO-FIX)

`timeout`, `timeout-escape-promise`, `timeout-escape-promise-2`.

- v24 reason (unchanged): "A synchronous `while(true){}` cannot be
  preempted in a browser (no worker thread, no isolate interruption).
  The shim's `timeout` option is validated but cannot interrupt"
  (`src/vm.js:24-25`; `validateTimeout` only, `src/vm.js:1815,1853`).
- `timeout-escape-promise(-2)` add `microtaskMode: 'afterEvaluate'` +
  a promise-loop escape hatch, but the core requirement is still
  preemption of a synchronously spinning loop
  (`test-vm-timeout-escape-promise.js:29-38`: expects
  `ERR_SCRIPT_EXECUTION_TIMEOUT` / `Script execution timed out after
  5ms`).
- Native probe (Node 26.13.1): `vm.runInThisContext('while(true) {}',
  { timeout: 100 })` throws `ERR_SCRIPT_EXECUTION_TIMEOUT` /
  `Script execution timed out after 100ms`.
- Isolated harness: `test-vm-timeout.js` at the 30 s cap → exit 124,
  empty stdout/stderr — the loop spins forever and the outer `timeout`
  kills it (see §Baseline corrections — this CONFIRMS the baseline
  124, it is not a flake).
- Classification: NO-FIX, all 3. No lane candidate.

### Family D — Restricted global (1, NEW in 26, LANE CANDIDATE)

`global-restricted-property` — the only genuinely new gap test in 26
(absent from the v24.20.0 tarball).

- Test (`test-vm-global-restricted-property.js:9-21`): define a
  non-configurable (`configurable: false`) property `foo` on the context
  global, then `vm.runInContext('let foo = 2;', ctx)` must throw the
  context's `SyntaxError` — spec GlobalDeclarationInstantiation 3.d
  ("If hasRestrictedGlobal is true, throw a SyntaxError exception",
  cited in the test).
- Native probe (Node 26.13.1): throws `SyntaxError: Identifier 'foo'
  has already been declared`. Control probe: same shape with
  `configurable: true` does NOT throw — the check is exactly the
  restricted (non-configurable) property.
- Shim failure, isolated harness: `AssertionError: Missing expected
  exception (SyntaxError)` at `:17` — the `let` never throws, because
  the shim runs code as a `new Function` body, not at global scope, so
  GlobalDeclarationInstantiation's restricted-global check never runs.
- Why this one is different from Family B: it needs no per-context
  intrinsics and no new global proxy — only a pre-execution check the
  shim can emulate. The shim's scanner already locates top-level
  lexical declarations (`src/vm.js:971-986`: `skipLexical` is called for
  top-level `let`/`const` bindings) but discards the names; and
  `src/vm.js:1626` notes lexical names "are NOT pre-declared on the
  target". A lane could have `skipLexical` return the bound names,
  then `runWithContext` check each against non-configurable own
  properties of the target and throw a host `SyntaxError` with V8's
  message. The test only checks the constructor
  (`assert.throws(fn, vm.runInContext('SyntaxError', ctx))` — under the
  shim that resolves to the host `SyntaxError`, so `instanceof` passes
  if the shim throws a host `SyntaxError`).
- **Lane candidate: vm-restricted-global — estimated flip 1, confidence
  LOW, spike-gated.** Risks the spike must clear before this becomes a
  real lane: (1) `let` as a sloppy-mode identifier and block-scoped
  `let`s must not false-positive — only top-level bindings count;
  (2) `class` declarations and `function` declarations over restricted
  globals throw under the same spec step — the lane must decide whether
  to cover them (the test only covers `let`; covering `function` risks
  colliding with the scanner's `ensureDeclared` pre-declaration path);
  (3) destructuring patterns (`let {a} = …`, `let [b] = …`) must yield
  every bound name. If the spike shows false positives or a message/
  identity mismatch, this test falls back to NO-FIX (Family B).

## New-in-26 vs pre-existing split

| | count |
|---|---|
| Pre-existing, adjudicated in v24, reason unchanged | 34 |
| Pre-existing in v24.20.0, never adjudicated (glob missed `.mjs`) — now adjudicated, ESM family | 1 (`module-referrer-realm.mjs`) |
| New in 26 | 1 (`global-restricted-property`, lane candidate) |
| **Total gaps** | **36** |

No gap is caused by a Node 26 behaviour change: `lib/vm.js` is
behaviour-identical v24→v26 (§above), the export surface is unchanged,
and all 34 pre-existing gap tests are semantically identical to v24.

## Lane candidates (conservative)

| Lane | Tests | Est. flips |
|---|---|---|
| vm-restricted-global (spike-gated; §Family D) | `global-restricted-property` | 1 (low confidence) |
| **Total** | | **1** |

No other lane is proposed. In particular there is NO ESM-loader lane:
Family A (25) is a subsystem (real V8 module graph), not a lane fix —
same call as v24.

## NO-FIX list (35)

- Family A, ESM `vm.Module` (25): `module-after-evaluate`,
  `module-basic`, `module-cached-data`, `module-dynamic-import-promise`,
  `module-dynamic-import`, `module-dynamic-namespace`, `module-errors`,
  `module-evaluate-source-text-module`,
  `module-evaluate-synthethic-module-rejection`,
  `module-evaluate-synthethic-module`,
  `module-evaluate-while-evaluating`, `module-hasasyncgraph`,
  `module-hastoplevelawait`, `module-import-meta`,
  `module-instantiate`, `module-link-shared-deps`, `module-link`,
  `module-linkmodulerequests-circular`,
  `module-linkmodulerequests-deep`, `module-linkmodulerequests`,
  `module-modulerequests`, `module-reevaluate`,
  `module-referrer-realm.mjs`, `module-synthetic`,
  `timeout-escape-promise-module` — needs a real V8 module graph;
  shim has no `Module`/`SourceTextModule`/`SyntheticModule` at all.
- Family B, V8-isolate semantics (7): `context-async-script`,
  `function-declaration`, `global-property-prototype`, `global-setter`,
  `harmony-symbols`, `proxies`, `script-after-evaluate` — needs a real
  V8 context (per-context intrinsics, distinct global proxy,
  per-context microtask queue); shim is `with`/Proxy on host globalThis.
- Family C, timeout interrupt (3): `timeout`,
  `timeout-escape-promise`, `timeout-escape-promise-2` — sync
  `while(true){}` cannot be preempted in a browser.

## Isolated re-runs (baseline adjudication)

Exact baseline invocation (`run-baseline.mjs` `runOne`):
`timeout N node --import <worktree>/parity/preload.mjs
parity/node-test/parallel/<test>`, `PARITY_TARGET=vm`, cwd = worktree,
host Node v24.22.1. (Vendored copies used where semantically identical
to the 26 files; the one staged 26 file was removed afterwards and
`parity/node-test/` verified clean, 0 dirty lines.)

| Test | Cap | Isolated exit | Baseline | Verdict |
|---|---|---|---|---|
| `test-vm-timeout.js` | 30 s | 124 (empty out/err) | 124 | reproduces — baseline correct |
| `test-vm-global-restricted-property.js` | 10 s | 1 (`Missing expected exception (SyntaxError)` :17) | 1 | reproduces |
| `test-vm-module-referrer-realm.mjs` | 10 s | 1 (`node:vm does not provide an export named 'SourceTextModule'`) | 1 | reproduces |
| `test-vm-module-basic.js` | 10 s | 1 (`SourceTextModule is not a constructor` :76) | 1 | reproduces |
| `test-vm-function-declaration.js` | 10 s | 1 (`typeof res` `'undefined'` vs `'function'` :42) | 1 | reproduces |
| `test-vm-context-async-script.js` | 10 s | 1 (`undefined !== 3` :34) | 1 | reproduces |

Note: the two new-file runs (`global-restricted-property`,
`referrer-realm`) used the vendored v24 `common/` (the baseline used
staged 26 `common/`); both fail with shim-gap signatures before any
26-only common helper could matter, so the adjudication stands.

## Baseline corrections

1. **`test-vm-timeout.js` 124 is CORRECT, not a load artifact.**
   Isolated at the 30 s phase-2 cap it still exits 124 with empty
   output — the shim cannot preempt the loop, so any cap kills it.
   This SUPERSEDES the v24 triage note ("124 in the sweep but 1
   isolated on the shim"): the isolated-1 observation does not
   reproduce on base `3c091022` (invocation then is unknown); on this
   base the 124 reproduces in isolation. No baseline change needed.
2. **No other baseline error found.** The five other isolated re-runs
   reproduce their baseline exits exactly. No 129/signal death, no
   137/OOM, no flake in this module's set.
3. **Process incident (not a baseline error):** my full-module
   re-run attempt (`run-baseline.mjs --modules vm`, jobs 4) was killed
   mid-flight by an exec-service restart before writing any output.
   Its partial staging was fully undone with the script's own restore
   logic (`git checkout -- parity/node-test` + explicit deletion of
   exactly the untracked staged paths: 7,560 files removed;
   `git status --porcelain -- parity/node-test` = 0 lines after).
   Targeted isolated re-runs (table above, same invocation) were
   substituted for the full re-run.

## Method note

- Gap list, export diff, changelog cross-check, run-baseline.mjs,
  run-oracle method, and the v24 triage (`triage-vm-2026-11-15.md` +
  `NOTES-vm-*.md` lane notes) were read before triaging.
- No fresh web research (Node source pack + repo tree + local probes
  only). No background jobs left running.
