# NOTES — repl top-level-await completion (R4c)

Flips `test-repl-top-level-await` (R4b landed the `lib/internal/repl/await.js`
port; this lane clears the remaining blockers). `src/repl.js` only.

Base: `af051744` (R4b), rebased onto `99fdc0cc` (R7, #474) mid-lane — one
rebase conflict in `_handleError`, resolved by keeping this lane's sandboxed
frame cut AND R7's `else if (cut === -1)` branch (see §6).

## 1. Sync-statement evaluation — `let dd;` (blocker #1)

Root cause (probe-proven): the sandboxed `runFn` wraps code as
`with(__ctx__){return(<code>)}` — expression-only, so `let dd;` threw
`SyntaxError: Unexpected identifier 'dd'`. The echo was fine (present in
both); the failure was the declaration-persistence gap, not a CR artifact.

Fix: new `processTopLevelSync(src)` + `_evalSyncStatements({code, hoists})`,
reusing the await transform's shared Acorn `visitors` (the same
hoist-and-assign rewrite). Parse as a script
(`allowAwaitOutsideFunction: true`); parse fail or a single expression
statement → return null (expression wrapper owns it, preserving
Recoverable/SyntaxError behavior). Otherwise rewrite the last
ExpressionStatement to `return (...)` (Node's completion value) and return
`{code, hoists}`; the evaluator drops the hoists so rewritten assignments
land on the context via the `with` proxy's set trap (same trick as
`_evalAwait`). Routed in `_defaultEval` only when `!awaitPromise &&
!this.useGlobal` (useGlobal handles statements natively; the rewritten code
carries a top-level `return` so it must never be indirect-evaled). The
`wrappedCmd` retry is skipped when the statement evaluator ran (its errors
are the real errors).

Shared `_checkHoistedRedeclare(hoists)` (factored out of `_evalAwait`):
a hoisted `let` name already on the context throws
`Identifier 'x' has already been declared` (the test's `const k` redeclare
case). Hoisted `var` names are freely redeclared, as in Node.

Known quirks (documented, not pre-solved): the shared visitor appends
`=undefined` to bare declarators, so a sync bare `var` redeclare
(`var foo = 5;` then `var foo;`) resets foo to undefined where Node (script
eval, no transform) keeps 5 — untested, refine only if the differential
shows a failure. Strict mode: the statement evaluator runs sloppy (no
directive), same documented gap as `_evalAwait` — in strict mode a `let`
assignment falls through the honest `has` to host globalThis instead of
the context (observable output still matches: reads return undefined;
latent pollution only, untested).

## 2. Has-trap ReferenceError for sloppy undeclared reads — `Bar`, `j` (blocker #2)

Root cause (probe-proven): sloppy read `Bar` → `undefined` (must be
`ReferenceError: Bar is not defined`); strict read already threw correctly.

Fix (in `_scopeProxy().get`): keep `has: () => true` for sloppy (writes must
land on context) and make `get` throw `ReferenceError: \`${k} is not
defined\`` for STRING keys in neither context nor globalThis. SYMBOL keys
exempt (return current behavior) — `with` reads `Symbol.unscopables` on
every evaluation and a throw there would break all evals.

Divergence (documented in a `ponytail:` comment): `typeof <undeclared>`
now throws instead of returning `"undefined"` (a `get` trap cannot tell a
typeof read from a value read) — no vendored test covers it (grep of all
`test-repl-*.js`: only `typeof globalThis` in tab-complete-unary-expressions
— a completion query, not an eval — and `typeof action`/`typeof e` in
test-harness code, never evaled in the repl).

R1 has-trap probe (zz, deleted after use): strict `x = 3` →
`ReferenceError: x is not defined`, context.x undefined; sloppy `y = 3` →
3, context.y 3; sloppy `Bar` → `ReferenceError: Bar is not defined`.
All pass on the branch head (re-run after the rebase + props fix).

## 3. `context.console` → repl output (blocker #3)

Node `lib/repl.js:1109-1114`: `const _console = new Console(this.output);
ObjectDefineProperty(context, 'console', {configurable: true, writable: true,
value: _console})`, inside the non-useGlobal branch only (verified by
reading `lib/repl.js:1083-1115` — with useGlobal the context IS globalThis
and its console is NOT replaced).

Fix: in `createContext`, non-useGlobal branch only, after the GLOBALS copy
(which copies the host console), overwrite `context.console` with
`new Console(this._output)` via defineProperty (configurable, writable).
`this._output` is set in the constructor before `resetContext()` →
`createContext()`, so it is available (also on later `resetContext()` calls).
`src/console.js` exports `Console` (:1534); constructor accepts positional
`new Console(stdout)` (:833 backwards-compat).

## 4. util.inspect promise async symbols — `Promise {` (blocker #4)

Mechanism (probe chain, all 2026-11-18): native repl prints multi-line
`Promise {\n 456,\n Symbol(async_id_symbol): 19,\n
Symbol(trigger_async_id_symbol): 5\n}`; plain `node -e` inspect prints
single-line `Promise { 456}`; a promise WITH those two symbol properties
inspects multi-line exactly like the repl (proven by manual stamping); the
symbols come from Node's `promiseInitHook`
(`lib/internal/async_hooks.js:329`, `trackPromise`) which runs only when
async-hooks tracking is active; the trigger in native is `domain.create()`
in the repl constructor (`lib/repl.js:334`), proven by `node -e` probes
(require(repl)/require(async_hooks)/require(events) alone: no symbols;
after `repl.start`: symbols present). The shim's inspect ALREADY renders a
stamped promise multi-line exactly like native.

Fix (honest, in-region): enable a no-op async hook with an `init` callback
once per process on first REPLServer construction —
`createHook({init(){}}).enable()` (an empty callbacks object does NOT
activate the promise hook — probed; `init` is required). The hook is
reached through the bare global process's `getBuiltinModule` — the same
probe `src/async_hooks.js` uses — NOT by importing `./async_hooks`.

Why not the import (found the hard way): the first version imported
`createHook` from `./async_hooks`, and the test then failed at exit with
the harness's global-leak check (`Unexpected global(s) found:
setImmediate, setInterval, setTimeout, queueMicrotask`). Bisect-proven:
importing `src/async_hooks.js` alone replaces all four global timers —
its static `als-browser` import patches them at import time (the known
hazard documented at `src/readline.js:18` — the same reason the readline
shim avoids the shared events.js). The native probe avoids it entirely:
timer identity verified unchanged after require/start/eval. In the
browser/sandbox there is no native module and the tracking stays off (the
stub hook cannot stamp real promises); the repl still works, promises
just inspect single-line.

Only `test-repl-top-level-await.js:199` in the whole repl suite asserts on
`Promise {` output, so blast radius is minimal; the differential adjudicates.

## 5. SIGINT interruption — `ctrlCTest` (blocker #5)

Node's mechanism (read from source pack, `lib/repl.js:549-623` +
`:818-843`): sync eval uses the C++ SigintWatchdog + `breakOnSigint` (no
browser equivalent — sync interruption is impossible); async-await eval
races the promise against an `interrupt` promise whose reject is registered
in a `prioritizedSigintQueue` (created with `stackTraceLimit = 0` so the
error has NO stack); the `onSigInt` handler runs queued tasks first, else
the idle behavior (clear line; first idle Ctrl+C prints
`(To exit, press Ctrl+C again or Ctrl+D or type .exit)\n` and sets
sawSIGINT; second closes; resets sawSIGINT on every line).

Fix (async case only — the part that CAN work): constructor state
`this[kSigintQueue] = new Set()` + `this._sawSIGINT = false` +
`this.on("SIGINT", () => this._onSigint())`; `_onSigint()` mirrors Node
(queue tasks first, else idle behavior using `this.line`,
`this.clearLine()`, `this[kBufferedCommand]`, `clearBufferedCommand()`,
`this.lines.level = []`, `displayPrompt()`; `_sawSIGINT = false` reset at
the top of `_onLine`); in `_defaultEval`'s await branch, when
`this.breakEvalOnSigint`, race `raw` against an interrupt promise and
remove the task in `finally` (the original pending promise stays pending
and is garbage — no handlers, no side effects). Error factory
`makeScriptInterruptedError()`: `new Error("Script execution was
interrupted by \`SIGINT\`")` + `e.code =
"ERR_SCRIPT_EXECUTION_INTERRUPTED"` + `e.stack = "Error
[ERR_SCRIPT_EXECUTION_INTERRUPTED]: Script execution was interrupted by
\`SIGINT\`"` (one line, no frames — reproduces Node's stackTraceLimit=0
observable stack; the `[CODE]` infix comes from Node's internal-error
`toString`, `lib/internal/errors.js:384`).

Probe-verified printed shape (shim writer): `["[Error
[ERR_SCRIPT_EXECUTION_INTERRUPTED]: Script execution was interrupted by
\`SIGINT\`] {", " code: 'ERR_SCRIPT_EXECUTION_INTERRUPTED'", "}"]`,
first line 90 chars > breakLength 80 (both host and shim
`inspect.defaultOptions.breakLength` are 80 — probed) → `_handleError`
emits the `Uncaught:\n` form, matching the test's slice(0,3) and slice(-2).

The shim's readline already emits "SIGINT" on the Interface when
`listenerCount("SIGINT") > 0` (src/readline.js:2577,:3313), else closes;
`Interface.write(d, key)` (:1906) routes to `[kTtyWrite]` in terminal mode;
the repl server IS the Interface so `this.on("SIGINT",...)` catches it.
Only test-repl-top-level-await drives Ctrl+C into the SHIM (direct
`require("repl")` + breakEvalOnSigint); the other Ctrl+C tests use
`internal/repl` or `common/repl.js` (NATIVE server) — verified by grep —
so the listener has no blast radius on them.

Sync interruption stays impossible (no V8 watchdog in a browser) — the
header comment now says so explicitly instead of "breakEvalOnSigint
accepted but inert".

## 6. Frame-cut gap (found during R4c probing; REQUIRED for blocker #2)

Current shim printed a sandboxed ReferenceError with a FULL stack (strict
`Bar`: `Uncaught ReferenceError: Bar is not defined\n at eval (eval at
runFn (...), <anonymous>:3:48)\n at eval (...:3:63)\n at runFn...` — the
`_handleError` cut regex `^ at eval \(<anonymous>\)` only matches the
indirect-eval (useGlobal) dispatch format, so the sandboxed frames
survived). Native prints `Bar` as a single line and a nested `f()` throw
as `Uncaught Error: x\n at f (REPL2:1:22)\n` (one user frame kept,
machinery dropped — probed natively 2026-11-18).

Fix (in `_handleError`): branch on dispatch marker — if a
`^ at eval \(eval at ` (sandboxed dispatch) frame exists, keep the message
lines plus any user-function frames above it matching
`^ at (?:async )?(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*
\(<anonymous>:\d+:\d+\)` (named functions at `<anonymous>` locations,
async/dotted allowed) and drop the rest (the proxy `get`-trap frame has a
real file location so it is dropped; the dispatch + machinery below it are
dropped). If no sandboxed marker, keep the EXISTING indirect-eval cut
unchanged (`slice(0, cut - 1)`). For the SIGINT error (one-line stack, no
frames) neither cut triggers, so its props block is preserved.

Props-block preservation (found by a guard regression, fixed in the second
commit): the first version of the sandboxed cut dropped the trailing
inspect props block, regressing `test-repl-require` (exit 1 on the branch
while 0 on base `99fdc0cc`): the test asserts
`/code: 'MODULE_NOT_FOUND'/` and `/requireStack: \[ '<repl>' \]/`. The cut
now re-attaches the props block to the last kept line (the same suffix
move R7's `cut === -1` branch does). Native ground truth (probed):
native prints the require-machinery frames too — the shim drops them
(they are src/module.js paths, not Node's); no test asserts them, and the
props are what the tests check.

Rebase conflict (onto `99fdc0cc`): R7 added an `else if (cut === -1)`
branch to the same `if (cut > 0)` (last-frame drop for the
stackTraceLimit test-repl.js case, `lib/repl.js:643`). Resolution keeps
BOTH: this lane's sandboxed-aware `if (cut > 0)` body + R7's
`else if (cut === -1)` branch. Both guards (test-repl-require,
test-repl.js) exit 0 on the merged head.

## Verification (branch head `4cfd26e8`, base `99fdc0cc`)

- Flip 2× isolated, exit 0: test-repl-top-level-await (runs 1+2 pre-rebase
  on `af051744`, runs 1+2 post-rebase on `6edfd507`, run 3 post-props-fix
  on `4cfd26e8`; logs identical within each pair).
- Guards exit 0 (all on `4cfd26e8`): test-repl-colors, test-repl-options,
  test-repl-recoverable, test-repl-context, test-repl-programmatic-history,
  test-repl-programmatic-history-setup-history, test-repl-require,
  test-repl.js.
- R1 has-trap probe: strict `x = 3` → ReferenceError, context.x
  undefined; sloppy `y = 3` → 3, context.y 3; sloppy `Bar` →
  ReferenceError. Passes on `4cfd26e8`.
- Full repl differential (fast-sweep --target repl --force --jobs 2):
  base `99fdc0cc` sweep `repl-r4c-base-99fdc0cc.csv`: 94 pass / 6 fail /
  1 timeout (envvars 124) across 101 glob tests; branch `4cfd26e8` sweep
  `repl-r4c-branch-4cfd26e8.csv`: 95 pass / 5 fail / 1 timeout. Diff of
  the sorted CSVs is exactly ONE line: test-repl-top-level-await 1→0.
  ZERO regressions. Remaining branch non-pass in-glob: envvars 124
  (NO-FIX), mode 1 (R5 gate), preview 1 (NO-FIX), reverse-search 1 (sweep
  flake — exit 0 isolated on branch), tab-complete-import 1 (R3),
  tab-complete-require 1 (R3). True counts: base 96/102 (94 sweep +
  reverse-search isolated + test-repl.js manual exit 0), branch 97/102
  (95 sweep + reverse-search isolated exit 0 + test-repl.js exit 0).
- Footprint test: 29/29 green (tests/ondemand-require.test.js, local jest).
- `node --check src/repl.js` clean.

## Ship

- PR #___ / merge SHA: ___
- Branch: `fix/repl-top-level-await-completion`
- Commits: `6edfd507` (main R4c change) + `4cfd26e8` (props-block fix)
- Repl count: 94 → 95/102 on live main (base `99fdc0cc` is 96/102 with
  R7's two flips — test-repl-require + test-repl.js both exit 0 on base —
  so this lane lands 96 → 97/102; the 94 banked count predates R7, which
  the parent had not yet verified).
