# NOTES-repl-context-options.md — R1: context builtins + options defaults (+ strict has-trap)

Wave R, lane R1. Base main: `d8bba974` (docs sync #468).
Triage: `hidden_files/triage-repl-2026-11-18.md` (true 80/102, ceiling 100/102).

## What

Three fixes, all in `src/repl.js` (+290/−8):

1. **Context builtins (test-repl-colors).** `createContext()` copied a
   hardcoded GLOBALS list and never added builtin libs — `context.util`,
   `require`, `process`, `Buffer` were all `undefined` (parent-probe-proven),
   so evaluating anything needing `util.inspect` threw. Ported from Node:
   - `addBuiltinLibsToObject` (`lib/internal/modules/helpers.js:230`) —
     lazy, non-enumerable getters for every builtin module, skipping
     underscored names, slashed names, and already-defined names. The
     getter loads via the shim's CJS loader (`Module._load`) so `util`
     etc. resolve to the SHIM modules, never native. A builtin the shim
     cannot load throws honestly on first access.
   - `require`/`module` (`lib/repl.js:1114-1135`) — a `<repl>` CJS module
     plus `makeReplRequire` (port of `lib/internal/modules/cjs/loader.js`
     `makeRequireFunction`: `resolve`/`paths`/`main`/`extensions`/`cache`).
     `replModule.paths = []` — no lookup paths in a browser; builtin
     requires never consult paths, relative requires fail honestly.
   - Runs for both branches: with `useGlobal` the context IS globalThis
     (Node does the same); the already-defined skip rule protects
     existing globals (`process`, `Buffer`, `console`, ...).
2. **Options defaults (test-repl-options).**
   - `useColors`: Node `lib/repl.js:289-291` — when `terminal` and
     `useColors === undefined`, default via `shouldColorize(output)`.
     Ported Node `lib/internal/util/colors.js` `shouldColorize()` (a
     stream colorizes only when it IS a TTY, color depth > 2 when it
     reports one, unless FORCE_COLOR). NOT the `src/util.js` stand-in,
     which defaults ON for non-TTY streams (opposite default, console
     use). The shim did `useColors ?? terminal`, so a non-TTY output
     with `terminal: true` wrongly got colors.
   - `historySize`: the readline Interface already had the getter
     (returns `historyManager.size`, default 30) — the bug was only
     that the REPLServer constructor never passed
     `options.historySize` through to `super()`. One-line passthrough.
   - `ERR_INVALID_REPL_EVAL_CONFIG`: Node `lib/repl.js:348-352` —
     `breakEvalOnSigint` + a truthy `eval` option throws a TypeError
     with that code and message `Cannot specify both
     "breakEvalOnSigint" and "eval" for REPL`. The shim accepted it
     silently. Added the check before `this.eval` is assigned.
   - Deprecation warnings the test demands via `common.expectWarning`:
     `DEP0141` on `inputStream`/`outputStream` access (get + set),
     `DEP0191` on `repl.builtinModules` access, `DEP0142` on
     `repl._builtinLibs` access — all emitted once per process via
     `process.emitWarning` (same deferred-to-nextTick timing as Node,
     so accesses before `expectWarning` is called are still caught, in
     order). The last two live as getters on the default-export object
     (what CJS `require('repl')` returns); the ESM named export stays
     the plain array. `builtinModules` changed `const` → `let` so the
     setters can replace the list, as Node's `setReplBuiltinLibs` does.
3. **Strict-mode has-trap (probe-verified, same commit).** Two stacked
   defects, both fixed:
   - The `'use strict'` prefix inside `return(...)` was a SyntaxError
     that matches the Recoverable pattern, so every strict eval buffered
     forever (output `|`). The prefix now applies only to the useGlobal
     path (indirect eval of a script, where it is valid — probe-proven
     working before this change). The sandboxed path runs the code
     inside a strict inner function (outer `with` is sloppy, legal).
   - The scope proxy's `has: () => true` claimed every name, defeating
     undeclared-assignment errors. In strict mode it now answers
     honestly (`k in t || k in globalThis`); sloppy keeps the old
     behaviour so assignments still land on the context.
   - Probe: strict `x = 3` → `Uncaught ReferenceError: x is not
     defined`, `context.x` undefined; strict read of an undeclared name
     throws too; sloppy `y = 3` → `3`, `context.y === 3` (no
     regression). `test-repl-mode` itself still cannot flip until the
     R5 harness gate lands (it runs against the native server); the
     gate re-measure will test it then.

## Known ceilings (not this lane)

- The expression wrapper only accepts a single expression — `const`/`let`/
  `var` declarations are statements and buffer as Recoverable instead of
  evaluating (`const a = 1` → output `|`, `context.a` undefined; same
  before and after this lane). Pre-existing architecture ceiling; a real
  script eval would be needed to fix it. Noted with a `ponytail:` comment
  at the wrapper.
- Strict + top-level-await runs the await body sloppy (the async IIFE has
  no directive). Untested by any repl test; noted, not fixed.

## Verification (branch head, before push)

- Flips 2× isolated, exit 0: test-repl-colors [0,0], test-repl-options [0,0].
- Has-trap zz probe (deleted after): strict ReferenceError YES, strict
  read throws, sloppy `y = 3` works. Probe file removed.
- Guards exit 0: test-repl-definecommand, test-repl-empty,
  test-repl-autolibs, test-repl-underscore, test-repl-end-emits-exit.
- Known-failing unchanged: test-repl-recoverable 124, test-repl-require 124.
- Footprint test green (1 passed, 28 skipped).
- `node --check src/repl.js` clean. `node src/build-vfs.mjs` exit 0
  (dist/ output reverted — CI bot owns dist/).
- Full repl differential: fast-sweep `--target repl --force --jobs 2`,
  CSV `hidden_files/fast-sweep/repl-sweep-2026-11-18-r1.csv` vs triage
  base (79 sweep passes + reverse-search = 80/102). Delta: colors 1→0,
  options 1→0, reverse-search 1→0 (known sweep flake — passes isolated,
  already counted in the true 80). ZERO regressions. Branch non-pass 19
  (17×1 + envvars 124 + pretty-custom-stack 7). True count **82/102**
  (80 + 2). Recoverable shows exit 1 in the sweep vs 124 isolated — same
  failure, timing variation, still failing.
- Manual test-repl.js (outside glob): still [1,1] (R2's lane).

## Ship

- Branch: `fix/repl-context-options`
- PR #470 / Merge SHA: 92b5e369 (squash-merged 2026-11-18)
