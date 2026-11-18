# NOTES-repl-semicolon-expression.md — R8: lone expression statements with a trailing semicolon

## What

Lone expression statements with a trailing `;` (`x.a = 1;`, `ele.biu = 1;`,
`globalThis.counter = 0;`) never evaluated under the shim: `SyntaxError:
Unexpected token ';'`. Native Node evaluates them as a script and prints the
value. Fixed in `src/repl.js` only (+~75 lines), plus a second fix the gate
measurement forced out: `globalThis` inside a sandboxed eval resolved to the
host globalThis instead of the repl context (see "Correction to the R3 note"
below).

## Mechanism (probe-proven)

- `_defaultEval` routes a single expression to the sandboxed expression
  wrapper (`runFn`), which builds `with(__ctx__){return(<code>)}` — a `;`
  inside the parens is a SyntaxError.
- `processTopLevelSync` returns `null` for a single `ExpressionStatement`
  ("the expression wrapper owns it"), so the statement evaluator — which
  handles `;` fine — never sees it.
- **Why not reroute to the statement evaluator:** `_evalSyncStatements`
  runs a sloppy `with` Function (a `'use strict'` directive cannot live
  inside `with`, so it cannot be made strict). Routing `x = 3;` there would
  silently create a global in strict mode instead of throwing
  `ReferenceError` — a silent fake (repo rule 7). Probe-proven: native
  strict `x = 3;` → `Uncaught ReferenceError: x is not defined` (stream
  probe; `server.eval` never calls back on a throwing eval — the error goes
  to the server domain, Node `lib/repl.js:636,576`).
- **Fix:** `stripLoneExpressionSemicolon(src)` — parse-grounded, next to
  `processTopLevelSync`. Only when the input is exactly one
  `ExpressionStatement` (plus empty statements) whose span extends past its
  expression (acorn ends the statement after the `;`): every `;` between the
  expression end and the last body node's end is blanked with a space
  (positions preserved). The wrapper then sees the bare expression, which it
  already evaluates with the right semantics in both modes.
- **Second fix, same function:** the wrapper now emits `return(<code>\n)`.
  `c.trim()` removed the trailing newline, so a trailing `//` comment
  commented out the `)` and `}` (`x.a = 1 // c` failed as `Unexpected
  token '}'` — pre-existing, same root cause: the wrapper cannot take a
  trailing line comment). The `\n` is inert whitespace otherwise.

## Node source cites

- `lib/repl.js:489-494` — strict mode prefixes `'use strict'; void 0;` and
  evaluates as a script (so `x.a = 1;` is a script statement, not an
  expression).
- `lib/repl.js:636` — `self.eval = self._domain.bind(eval_)` (why
  `server.eval` never calls back on a throwing eval).
- `lib/internal/repl/await.js` visitors — the hoist-and-assign rewrite
  `processTopLevelSync` reuses (unchanged by this lane).

## Verification (branch head, before push)

- Probe `zz-r8-probe.js` (21 sloppy + 2 strict cases, all matching native):
  `x.a = 1;` → 1, `ele.biu = 1;` → 1, `globalThis.counter = 0;` → 0,
  `1;` → 1, `x.a = 1;;` → 1, `x.a = 1; // c` → 1, `x.a = 1 // c` → 1,
  `x.a = 1 /* c */ ;` → 1, `x.a = 1; ; ;` → 1, `"use strict";` →
  `"use strict"`, `let dd;` → undefined, `y = 3` / `y = 3;` → 3. Strict:
  `x = 3;` → ReferenceError, `zz.q = 1;` → 1 (probe deleted after use).
- `globalThis` probe: after `globalThis.counter = 0;`,
  `context.counter` is 0 and host `globalThis.counter` is undefined
  (before the fix it was the reverse). `counter` reads 0.
- Guards exit 0: top-level-await, colors, options, recoverable, context,
  programmatic-history, require. `test-repl.js` 1 then 0,0 (known flake).
- Has-trap probe: strict `x = 3` → ReferenceError, context.x undefined;
  sloppy `y = 3` → 3, context.y 3; sloppy `Bar` → ReferenceError. The known
  `typeof <undeclared>` divergence (throws; Node returns `'undefined'`) is
  untouched.
- Main differential vs `d1584ac8` (R3 branch CSV): sorted CSVs differ in
  exactly one line — reverse-search 1→0, the known TEST_THREAD_ID sweep
  flake ([0,0] isolated, verified by R3). **0 flips / 0 regressions —
  convergent, as designed.** Branch non-zero rows: envvars 124 (NO-FIX),
  mode 1 (gate), preview 1 (NO-FIX), tab-complete-import 1 (gate),
  tab-complete-require 1 (gate).
- Gate measurement (see below).

## Gate measurement

- Scratch worktree `repl-r8-gate-measure` at this branch head with the gate
  patch (`parity/preload.mjs` isReplHelper, from `fix/repl-harness-gate`
  `807eec89`) applied uncommitted; the lane branch itself carries no gate
  change. Full repl differential under the gate, fresh CSV
  `repl-r8-gate-94970fea.csv`.
- **Result: 75 pass / 26 non-zero (was 72 / 29). Diff vs the R3 gate CSV
  (`repl-r3-gate-2ba29468.csv`) is exactly 3 lines, all 1→0:
  tab-complete.js, tab-complete-buffer, tab-complete-nosideeffects. Zero
  new regressions.** Gate still NO-MERGE: 23 regressions remain — save/load
  ×5, pretty-stack ×3, multiline ×2, custom-eval ×2, uncaught-exception
  ×2, context, domain, editor, preview-newlines, reset-event, null-thrown,
  function-definition-edge-case, no-terminal-restore, underscore. (Not
  regressions: envvars 124 and preview + mode fail on main too;
  tab-complete-import/require pass under the gate.)

## Correction to the R3 note

R3's note says the three remaining completion regressions "share ONE root
cause" (the `;` eval). Half-wrong, proven in-lane: after the `;` fix,
tab-complete.js and tab-complete-buffer flip, but nosideeffects still fails
at test:35 (`context.counter` undefined). Second, independent root cause:
`globalThis` inside the sandboxed `with` eval resolved to the HOST
globalThis (scope-proxy `get` fell through to `k in globalThis`), so
`globalThis.counter = 0;` landed on the host instead of the context.
Fixed in `_scopeProxy().get`: `globalThis` returns the context itself
(Node: a vm context's global is its own globalThis). Same shape, NOT
fixed here: bare `global` still resolves to the host global.

## Ship

- PR #477 / merge SHA 1262290a (squash-merged 2026-11-18)
