# NOTES — repl completion overhaul (R3)

## What

`src/repl.js` `complete()` was identifier-only: it matched the last
identifier fragment against the context/globalThis names. No module-name,
no `require()`/`import()` completion, no file completion, no REPL-command
completion, no `node:` variants, no group separators. This lane ports
Node's `lib/internal/repl/completion.js` (Node v24.20.0, SHA256-verified
source pack) + the `complete()`/`completeOnEditorMode` dispatch from
`lib/repl.js:1196-1215`.

## Mechanism (Node source cites)

- `completeRepl` (module-level in `src/repl.js`, `this` = the server):
  a faithful port of `lib/internal/repl/completion.js:complete` —
  commands branch (`/^\s*\.(\w*)$/` → `Object.keys(this.commands)`),
  `requireRE`/`importRE` branches (builtin groups always; file group
  only when `this.allowBlockingCompletions`), `fsAutoCompleteRE` branch
  (`completeFSFunctions`), identifier/member branch via
  `findExpressionCompleteTarget` + `includesProxiesOrGetters` +
  eval-based member completion, and the `completionGroupsLoaded` merge
  (filter case-insensitively per group; sort each group descending,
  unshift each entry so each group lands ascending at the front; `''`
  separator per group that added anything; strip a leading `''`).
- `getReplBuiltinLibs()` returns the live `builtinModules` array
  (`lib/internal/repl/utils.js:821-834`): `nodeBuiltinModules` filtered
  (`e[0] !== '_' && !e.startsWith('node:')`, 54 names). The old shim
  array was a hardcoded 36-name snapshot — it could never reflect a
  push and missed newer modules (`async_hooks`, `diagnostics_channel`,
  `inspector`, `sea`, `sqlite`, `node:test`, …). `nodeSchemeBuiltinLibs`
  is snapshotted once at load (`map(lib => 'node:'+lib)` + the
  scheme-only names `node:sea`/`node:sqlite`/`node:test/reporters`,
  per `lib/internal/bootstrap/realm.js:getSchemeOnlyModuleNames`), so a
  pushed `"foobar"` appears bare only, never as `node:foobar`.
- `this.allowBlockingCompletions = !!options.allowBlockingCompletions`
  (Node `lib/repl.js:332`) — added to the constructor; the tab-complete
  tests pass `allowBlockingCompletions: true`.
- `this.completer` wiring (Node `lib/repl.js:757-771`): the user
  completer goes through `super()` so the Interface wraps a sync
  completer into callback form; the internal completer is set after
  super when no user completer was given. `complete()` dispatches via
  `Reflect.apply(this.completer, this, arguments)` (Node
  `lib/repl.js:1196`); `completeOnEditorMode` is the exact Node shape
  (`lib/repl.js:1206-1215`, `[commonPrefix(result)]`).
- `this._lexicalNames` (a `Set`, accumulated by `_defaultEval` on the
  useGlobal path) stands in for the inspector's
  `Runtime.globalLexicalScopeNames` (see A3 below).

## Shim adaptations (behavior matches Node's; each is commented in code)

- A1: Node evals `` try { <expr> } catch {} `` — a statement the shim's
  expression wrapper rejects (SyntaxError). The port evals the bare
  expression and treats ANY error as "no object", which is exactly what
  Node's try/catch yields (undefined). Probe-proven: `arguments` and
  undeclared names eval to `undefined` in the shim (the scope proxy
  intercepts them), so the crash test (`arguments.`/`undef.` → `[]`)
  holds with no special-casing.
- A2: `getOwnNonIndexProperties` (a V8 internal binding) does not exist
  here — `Object.getOwnPropertyNames` + the `isIdentifier` filter
  excludes integer indices the same way (the non-index semantics).
  `isIdentifier` uses `acorn.isIdentifierStart/isIdentifierChar`
  (exported by the npm acorn package, already a direct dep).
- A3: `getGlobalLexicalScopeNames` is the V8 inspector — not portable.
  The shim tracks top-level lexical names in `this._lexicalNames`,
  accumulated by `_defaultEval` on the useGlobal path. Empty in the
  sandboxed path until declaration persistence lands (R4c owns that).
- A4: Node's completion module uses its own `module.paths`
  (`fixReplRequire`). The shim reads the server's `replModule.paths`
  (R7, `this.context.module.paths`), falling back to
  `CJSModule._nodeModulePaths("repl")`.
- A5: Node reads the real fs. The shim uses the completion fs object:
  the native bridge (the R6 probe-proven gate, reused via
  `_historyNativeModules` from `src/readline.js`) under the harness,
  the VFS fs shim (`_tryRequireFs`) in the browser, null otherwise
  (builtin-only completion — honest degradation, no crash).
- A6: `extensionFormatMap` (ESM formats) has no shim equivalent — the
  default key set from Node `lib/internal/modules/esm/get_format.js:16-23`
  (`.cjs`, `.js`, `.json`, `.mjs`, `.wasm`; `.node`/`.ts` are behind
  flags and excluded).
- A7: `isProxy` (`internal/util/types`) — native `util.types.isProxy`
  via the bridge, else `() => false` (proxies then complete like their
  targets — honest degradation in the browser).
- A8: `globalBuiltins` (fresh-context globals) —
  `Object.getOwnPropertyNames(globalThis)` per call.
- A9: The shim's sandboxed context is `Object.create(null)`: its
  prototype chain is empty, where Node's vm context has
  `Object.prototype`. Bare names still resolve through to the host
  globalThis, so `Object.prototype`'s members are completed as Node
  does (this is what makes the `"I"` exact list match —
  `isPrototypeOf` comes from there).
- A10: Dirent entries that arrive as plain strings (an fs shim that
  ignores `withFileTypes`) are treated as files.
- A11: path ops use the shim's posix `path` import (string ops only —
  identical results on Linux).
- A12: The internal completer is dual-mode: the shim's readline
  Interface awaits the completer with one argument (`[kTabComplete]`),
  while `server.complete()` and direct callers pass a callback — it
  returns a Promise when no callback is given.

## Also in this diff

- `src/readline.js`: `commonPrefix` + `_historyNativeModules` added to
  the named export list (reused by the port; the gate itself is R6's
  probe-proven "genuine Node?" check).
- `parity/node-test/fixtures/node_modules/no_index/` vendored verbatim
  from the SHA256-verified tarball (`lib/index.js` = `module.exports =
  {}` + `package.json` `{"main": "./lib/index.js"}`, byte-identical via
  `diff -r` against a fresh tarball extract). The triage listed it as
  missing; R0 did not vendor it. Without it the native completion
  fails the `no_ind` case too (proven: both target tests pass natively
  after vendoring, exit 0).
- Probes `zz-r3-complete-baseline.js`, `zz-r3-eval-probe.js`,
  `zz-r3-input-probe.js`, `zz-r3-port-verify.js`, `zz-r3-diag.js` are
  deleted before push (verification-only).

## Mechanism correction — the two targets CANNOT flip on live main

The brief expected 96 → 98/102 on live main. That rests on a wrong
mechanism assumption, proven three ways:

1. On live main (no gate), both target tests exercise the **native**
   server's completion: `common/repl.js` requires `node:repl`, and the
   failure stacks show native frames
   (`node:internal/repl/completion:510`, `REPLServer.complete
   (node:internal/repl/completion:459)`). The only shim-visible surface
   they touch is the test file's `repl.builtinModules` + the fixtures.
2. The count assertion (`data[0].length + 1 === modules.length`) can
   only pass if the push of `"foobar"` lands in the completion's
   internal builtin list — the native completion reads the native
   `_builtinLibs`, and the shim's push lands in the shim's array. On
   the branch the failure is still the count assertion, at the same
   lines: import `605 !== 604` (test:43), require `604 !== 603`
   (test:44), both 2× isolated. (The numbers moved from the base
   603/602 because the vendored `no_index` fixture adds its 2 entries
   to the native completion's file group — the fixture is being picked
   up, as intended.)
3. The triage itself says R3 "needs the mode harness gate to share one
   repl module between test and server" (Recommended lane split, R3).

So on live main this lane flips **0** tests — the port is proven
correct by direct verification (below) and by the gate measurement
(below), not by a main differential flip. The count stays 96/102 on
merge; the 2 targets flip only when the R5 gate lands (the gate's
blockers after this lane are the eval-path declaration persistence,
R4c, and the save/load command flow — see the gate measurement).

## Direct port verification (shim server, exact test inputs)

`parity/node-test/parallel/zz-r3-port-verify.js` (deleted after use),
run under the harness (`PARITY_TARGET=repl`): **35 pass, 0 fail**,
including: `import('` includes every public builtin + `node:` variant;
foobar push grows completions by exactly 1, bare only; `import\t( 'n`
exact ordering (separators load-bearing); `@nodejs` for all three
quote marks + closed-quote → `[[], undefined]`; `no_ind` →
`[["no_index", "no_index/"], "no_ind"]`; relative paths (`import('.`
length 2 + both entries, `import('..`, `./test-`,
`../parallel/test-`); the same for `require('`; `fs.readFileSync(`
dir order (`.hiddenfiles`, `hellorandom.txt`, `helloworld.js`);
`console.lo`/`console?.lo`/`toSt`/`.b`/`arguments.`/`undef.`/literals/
empty-line/`" "`; the `"I"` **exact** list (matches the test's
deep-equal list verbatim); proxy cases via `isProxy` (`proxyObj.` →
`[]`, `proxyObj.foo.` → `[]`, `objWithProxy.foo.bar.` → `[]`,
`objWithProxy.foo.` includes `objWithProxy.foo.bar`); `new X.` /
`delete globalThis._` completeOn; editor mode
`server.completer("Uin")` → `[["Uint"], "Uin"]`.

Fidelity note found by the probe: the completion **sorts the live
`builtinModules` array in place** (Node's `completionGroupsLoaded`
sorts each group, and the builtin groups ARE the live arrays — Node
does exactly the same). A `push` followed by a completion moves the
pushed entry off the end, so a `pop()` after a completion removes the
alphabetically-first entry (`"assert"`), not the pushed one. The real
tests never pop; the probe removes by value (`splice(indexOf(...))`).

## Eval-path gap (probe-proven, NOT this lane — R4c's region)

In the sandboxed path, `var`/`let`/`const` statements did not evaluate
at all before R4c (`var custom = "test";` → `Uncaught SyntaxError:
Unexpected token 'var'`). R4c (merged as #475, `95671045`) fixed that
with `processTopLevelSync` + `_evalSyncStatements` — re-probed after
the rebase: `let lexicalLet` / `var custom` / `var inner = {...}` /
`class Klass` all evaluate AND complete (`lexicalL` →
`[["lexicalLet"]]`, `cus` → `[["CustomEvent", "custom"]]`, `inner.o`
→ `[["inner.one"]]`). The lexical names surface via `contextOwnNames`
now, so the port's `_lexicalNames` set stays useGlobal-only (see A3)
with no loss in completion results.

One eval gap REMAINS and is now the dominant gate blocker (see the
gate measurement): **a lone expression statement with a trailing
semicolon never evaluates** — `processTopLevelSync` returns null for a
single ExpressionStatement, and the expression wrapper rejects the
trailing `;` (`return(x.a = 1;)` is a SyntaxError). So `x.a = 1;`,
`ele.biu = 1;`, `globalThis.counter = 0;` never run. This is an
_eval_-path fix (in `_defaultEval`/`processTopLevelSync`, R4c's
region), NOT a completion fix — named here for the follow-up lane,
not fixed in this PR per the lane's region rule.

## Verification on the branch head (rebased onto `95671045`, R4c #475)

- `node --check src/repl.js` clean, `node --check src/readline.js`
  clean. Footprint test (`tests/ondemand-require.test.js`): 29/29 green.
- Target tests 2× isolated on the branch: `test-repl-tab-complete-import`
  exit 1, 1; `test-repl-tab-complete-require` exit 1, 1 — both still
  the count assertion (see the mechanism correction above), NOT a
  regression from this change.
- Guards (branch head, rebased tip `2ba29468`): all exit 0 —
  test-repl-tab-complete, test-repl-tab-complete-files,
  test-repl-colors, test-repl-options, test-repl-recoverable,
  test-repl-context, test-repl-programmatic-history, test-repl-require,
  test-repl.js. `test-repl-top-level-await` exit 0, 0 with
  `--expose-internals` (the test requires `internal/util/inspect`;
  without the flag it fails at load with MODULE_NOT_FOUND — a harness
  invocation detail, not a regression; R4c's flip holds on this branch).
- Full repl differential vs `95671045` (fast-sweep `--target repl
  --force --jobs 2`): base CSV `repl-r3-base-95671045.csv` (95/101
  glob) vs branch CSV `repl-r3-branch-2ba29468.csv` (95/101 glob) —
  **the sorted CSVs are IDENTICAL: 0 flips, 0 regressions**. Base
  adjudicated 97/102 (95 glob + reverse-search isolated 0,0 + 
  test-repl.js exit 0). Branch count stays 97/102.

## Gate measurement (scratch worktree `repl-r3-gate-measure`, detached
at `2ba29468` + the R5 gate patch on `parity/preload.mjs`, uncommitted
— NOT in the PR; gate CSV `repl-r3-gate-2ba29468.csv`)

Gate + port vs branch (gate OFF): **72 pass / 28 fail / 1 timeout**
(vs 95/5/1). Flips (real): `test-repl-tab-complete-import` 1→0,
`test-repl-tab-complete-require` 1→0 — the two targets flip under the
gate. (`test-repl-reverse-search` 1→0 is the known TEST_THREAD_ID
sweep flake — it passes isolated on the base too; not a gate flip.)
Regressions: 26 (was 36 in the R5 re-measure). The completion family
went from 11 regressing to 3: `tab-complete-files`,
`tab-complete-crash`, `tab-complete-computed-props`,
`tab-complete-custom-completer`, `tab-complete-new-expression`,
`tab-complete-on-editor-mode`, `tab-complete-unary-expressions`, and
`completion-on-getters-disabled` all STOP regressing under the gate
(they pass on the branch base and under the gate now). The 3 remaining
completion regressions share ONE root cause — the trailing-semicolon
lone-expression eval gap (see above): `tab-complete.js` (the `y.`
shadowing case — `x.a = 1;` etc. never run, so `y` has no members),
`tab-complete-buffer` (`ele.biu = 1;` never runs, so `ele.biu` is
absent), `tab-complete-nosideeffects` (`globalThis.counter = 0;`
never runs, `context.counter` stays `undefined`). That gap is the
next gate blocker (eval-path follow-up lane, not this PR).
`test-repl-mode` still fails under the gate (1→1) on
`testStrictModeTerminal` — the strict-mode preview
(`// ReferenceError: xyz is not defined` as the user types) — the
preview family, which needs the V8 inspector (NO-FIX). The other 22
regressions are the pre-existing gate families (context, domain,
editor, save/load ×5, pretty-stack ×3, custom-eval ×2,
uncaught-exception ×2, function-definition-edge-case, load-multiline
×2, no-terminal-restore, null-thrown, preview-newlines, reset-event,
underscore) — unchanged by this port, not this lane's region.
**Gate verdict: still NO-MERGE** (26 regressions >> 2 flips), but the
port is proven: the targets flip, 8 completion regressions are fixed,
and the port introduces ZERO new regressions under the gate.

## Ship

- PR #476 / merge SHA: d1584ac8 (squash-merged 2026-11-18)
- Branch: `fix/repl-completion`, base `95671045` (rebased from
  `99fdc0cc` after R4c #475 merged; one conflict in the constructor,
  resolved keeping R4c's `breakEvalOnSigint` line + this lane's
  additions — all port pieces verified present after the rebase)
- Files: `src/repl.js`, `src/readline.js`,
  `parity/node-test/fixtures/node_modules/no_index/lib/index.js`,
  `parity/node-test/fixtures/node_modules/no_index/package.json`,
  `NOTES-repl-completion.md`
