# NOTES — Node 26 triage: repl (13 gaps)

- Base: `3c091022` (drift detector #505). Node 26.13.1 verified
  (`~/workspace/local/node-26/bin/node --version` → `v26.13.1`) before any probe.
- Banked (parent-verified, not recomputed): repl 13 non-pass, all 13 shim-gap,
  0 fails-natively, 0 native-timeout (gaps-repl.json).
- Method: Node 26 test tree staged into `parity/node-test/` (parallel +
  common + fixtures, as `parity/drift/run-baseline.mjs` stages it), each gap
  re-run isolated as
  `timeout 30 node --import <worktree>/parity/preload.mjs parity/node-test/parallel/<test>`
  with `PARITY_TARGET=repl`, cwd = worktree. All 13 reproduced exactly as
  banked (envvars 124, user-error-handler 124, rest 1). Tree restored
  afterwards (`git checkout -- parity/node-test` + explicit deletion of
  staged-only files; `git status --porcelain -- parity/node-test` = 0).
- Harness host is **v24.22.1** (every failure log ends `Node.js v24.22.1`).
  Any test that spawns `process.execPath` children runs Node 26 fixtures
  against a v24 binary — see Family I and the user-error-handler note.
- v24 close (for the split): repl 97/102, 5 remaining — mode,
  tab-complete-import, tab-complete-require (R5 gate-blocked), envvars
  NO-FIX, preview NO-FIX. `src/repl.js` unchanged since 2026-11-18
  (`git log --since=2026-11-18 -- src/repl.js` empty), so every 26
  regression below is test/common-driven, not a shim regression.
- **Split: pre-existing 5, new in 26: 8.**
- **Flips (conservative, file-level): 5 by repl lanes + 1 by a util lane =
  6 of 13.** Remaining: 3 parked gate, 2 NO-FIX, 1 host artifact,
  1 host-blocked (user-error-handler).

## Families

### A. R5-gate-blocked, pre-existing (3) — NO LANE, gate PARKED

- `test-repl-mode.js` (1), `test-repl-tab-complete-import.js` (1),
  `test-repl-tab-complete-require.js` (1).
- Classification: harness/fixture gap (module identity), not shim work.
- Evidence:
  - Mode: probe-proven the test runs against the **native** server.
    `common/repl.js` does `require("node:repl")`, which resolves natively
    under the harness while the test file's `require("repl")` resolves to
    the shim. Probe (`zz-mode-ident2.js`, deleted after use):
    `instanceof probe REPLServer: false`, no `_scopeProxy` (shim-only),
    `_domain` is a real `Domain` instance. The shim's `REPL_MODE_STRICT`
    symbol means nothing to the native server → sloppy → `x = 3` prints
    `3` instead of `ReferenceError: x is not defined`
    (testStrictMode, test:38; actual `'> 3\n> '`). The 26 test drops the
    v24 `{disableDomainErrorAssert: true}` second arg (domain gone in 26);
    the mechanism is unchanged.
  - Import/require: the failure is the count assertion, at the same lines
    as v24, with native frames in the stack
    (`node:internal/repl/completion:510`, `REPLServer.complete
    (node:internal/repl/completion:459)`). Import: `663 !== 662`
    (test:37); require: `662 !== 661` (test:44). The pushed `'foobar'`
    adds 0 (662 === 662): the push lands in the shim's `builtinModules`
    while the native completion reads native `_builtinLibs`. Absolute
    counts drifted since R3 (605/604 → 662) with the fixtures-dir file
    group (`process.chdir(fixtures.fixturesDir)`); the gate mechanism is
    unchanged.
- v24 record: NOTES-repl-completion.md:138, :203-208, :245-248;
  NOTES-repl-context-options.md:71-72.
- Lane: NONE. The R5 harness gate is PARKED — branch
  `fix/repl-harness-gate` (@807eec89), 75/101 with 23 regressions per the
  brief. Do NOT re-propose it as a lane.

### B. Node 26 ALS error routing, NEW (3) — real shim work

- `test-repl-multiple-instances-async-error.js` (1),
  `test-repl-uncaught-exception-after-input-ended.js` (1),
  `test-repl-user-error-handler.js` (124).
- Classification: real shim work (one lane, L1 below).
- What changed in Node 26: `lib/repl.js` no longer creates a domain
  (v24 `lib/repl.js:334` `this._domain = options.domain || domain.create()`;
  26 has no `require('domain')`, no `domain.create()`; `options.domain`
  now throws `ERR_INVALID_ARG_VALUE`, 26:372-373). Replacement:
  `AsyncLocalStorage` `replContext` + one process-wide
  `addUncaughtExceptionCaptureCallback` routing to the owning instance's
  `_handleError` (26 `lib/repl.js:179-219`, `:692`), plus the new
  `handleError` user option (`this._userErrorHandler = options.handleError`,
  :386; `_handleError`, :985; 0 occurrences of `handleError` in v24
  `lib/repl.js`).
- Failures (isolated re-runs):
  - multiple-instances: the `setTimeout(() => { throw ... })` from repl1
    escapes as a process uncaught exception (stack at
    `src/repl.js:2458` runFn eval, `Error: error from repl1`) instead of
    landing in repl1's output.
  - uncaught-after-input-ended: same shape, `Error: test` escapes instead
    of `Uncaught Error: test` in the REPL output.
  - user-error-handler: 124, 0 bytes of test output — the `handleError`
    callback is never invoked, so `'handled-error'` never fires and the
    `node:test` subtests never complete.
- Lane L1 — port Node 26 `_handleError` + `replContext` ALS routing +
  `handleError` option into `src/repl.js`.
  - Conservative flips: **2** (`multiple-instances-async-error`,
    `uncaught-exception-after-input-ended`).
  - `user-error-handler`: **0 file-level flips.** Its in-process subtests
    (7/8) are unblocked by L1, but the `badvalue` child-process subtest
    spawns `process.execPath` (host v24.22.1) with native `node:repl`,
    which has no `handleError` support. Probe: badvalue child under host
    v24 → exit 0, no `ERR_INVALID_STATE`; under `node-26` binary →
    exit 1 with the error. The file stays red under a v24 host by
    construction; record the 7/8 as progress, not a flip.
  - Risk (flag, do not solve here): in the browser there is no process
    uncaught-capture; the lane must define honest browser behaviour for
    an async error with no owning REPL (AGENTS.md rule 7 — never a fake
    success, never silently swallowed). Under the harness the lane can
    reach the host process the way `enablePromiseTrackingOnce` does
    (`process.getBuiltinModule`).

### C. Node 26 syntax highlighting, NEW (1) — real shim work + fixture gap

- `test-repl-highlight.js` (1).
- Classification: real shim work (port) + fixture gap (new internal module).
- Failure: `Error: Cannot find module 'internal/repl/highlight'`
  (test:8). `lib/internal/repl/highlight.js` is NEW in Node 26 (89 lines;
  deps: acorn `Parser.tokenizer` + `stylizeWithColor` from
  `internal/util/inspect`). The host v24.22.1 has no such module, so the
  `require` fails before any assertion runs.
- The test asserts `highlight()` directly (keyword/string colouring,
  incomplete source does not throw) plus one `REPLServer` write with
  `useColors: false` rendering `const` plain. `lib/repl.js:119` requires
  the module in 26.
- Lane L2 — port `highlight()` (acorn is already a direct dep;
  NOTES-repl-completion A2) into the shim and add a preload redirect for
  `internal/repl/highlight` (shared `parity/preload.mjs` — coordinator
  call, per AGENTS.md one-PR-per-module).
  - Conservative flips: **1**, contingent on the redirect.

### D. History close-on-error, NEW (1) — real shim work + fixture gap

- `test-repl-history-init-fail-leak.js` (1).
- Classification: real shim work (port) + fixture gap (internal module
  resolves natively).
- What changed in Node 26: `lib/internal/repl/history.js` gained
  `[kCloseHandle]` — the handle is now closed on init error (:328, :395)
  plus a public `closeHandle()` (:423-430); the shim's port
  (`src/readline.js:1141-1180` `_initializeHistory`) never closes
  `this[kHHistoryHandle]` on the `handle.truncate(0)` throw — it goes
  straight to `_handleHistoryInitError`, leaking the handle.
- Failure: `AssertionError: false !== true` at test:55 (`closeCalled`),
  reached via native frames `[_kHandleHistoryInitError]
  (node:internal/repl/history:359)` — i.e. `require('internal/repl/history')`
  resolves to the NATIVE host v24 module (no preload redirect for target
  repl), which predates the fix. The test's `fs.promises.open` mock DID
  reach it (the error path ran), so the failure is exactly the missing
  close, not a mock miss.
- Lane L3 — port the 26 `[kCloseHandle]` into the shim's `ReplHistory`
  error path (`src/readline.js`) and add a preload redirect for
  `internal/repl/history` (shared file — coordinator call).
  - Conservative flips: **1**, contingent on (a) the redirect and
    (b) the lane verifying the test's `fs.promises.open` mock reaches the
    fs the shim's `ReplHistory` uses (`native.fs.promises`,
    `src/readline.js:1142`) — probe it first; if the mock cannot reach
    it, the test is unflippable without a harness change.

### E. Promise-tracking removal (top-level-await), NEW regression (1) — real shim work

- `test-repl-top-level-await.js` (1).
- Classification: real shim work — REMOVE a v24-era workaround that Node
  26 made wrong.
- What changed: native Node 26 no longer stamps promises with async ids
  (domain removal, see Family B). The 26 test now asserts the WHOLE output
  is single-line `Promise { 456 }` (26 test:187); the v24 test asserted
  only line 0 `Promise {` with `{ line: 0 }` (v24 test:199), tolerating
  the multi-line stamped form. The shim still enables the no-op async
  hook once per process (`src/repl.js:54-92`, `enablePromiseTrackingOnce`,
  documented in NOTES-repl-top-level-await-completion.md §4 as the fix
  for the v24 test) → the promise is stamped → the shim prints
  `Promise {\n  456,\n  Symbol(async_id_symbol): 3512,\n
  Symbol(trigger_async_id_symbol): 3503\n}` → deep-equal fails at
  ordinaryTests:206. Oracle nativeExit 0 confirms native 26 prints the
  single-line form.
- Controls (all exit 0, same shim): v24 test file as-is; v24 test + the
  26 `useColors: false`-then-`true` shape (`zz-tla26shape.js`, deleted
  after use); v24 test + staged Node 26 `common/`. Only the full 26 test
  (new assertion) fails. The `useColors` change is NOT the trigger
  (a direct probe showed the symbols in both useColors modes).
- Lane L4 — remove/gate `enablePromiseTrackingOnce` so the shim stops
  stamping promises (in the browser tracking is already off — no native
  module — so browser behaviour is already single-line; this aligns the
  harness with the browser and with Node 26).
  - Conservative flips: **1**.
  - Blast radius checked: no other Node 26 repl test mentions `async_id`.

### F. util.inspect showProxy re-wrap, surfaced via repl (1) — UTIL lane, not repl

- `test-repl.js` (1).
- Classification: real shim work, owned by the util triage lane
  (cross-module dependency). No repl-lane work.
- What changed: Node 26 `lib/internal/util/inspect.js` `formatValue`
  (:1114-1136, :1190-1195). With `showProxy: false`, v24 unwrapped the
  proxy once and printed the target; 26 unwraps for formatting but then
  re-wraps the result in `Proxy(...)` once per proxy level. The test
  changed with it: v24 expect `'{ x: 42 }'` → 26 expect
  `'Proxy({ x: 42 })'` (test:733-734, same send
  `repl.writer.options.showProxy = false, new Proxy({x:42}, {});`).
  The shim printed `'{ x: 42 }'` (v24 behaviour). Control: v24 test +
  current shim = exit 0.
- Lane: util-inspect lane ports the 26 `formatValue` proxy loop into
  `src/util.js` (which currently implements the v24 unwrap-once shape,
  `src/util.js:3481-3483` region).
  - Conservative flips: **1** (`test-repl.js`), when the util lane lands.

### G. Preview (inspector), pre-existing NO-FIX (1)

- `test-repl-preview.js` (1).
- Classification: NO-FIX — needs the V8 inspector, which has no browser
  equivalent.
- Evidence: Node 26 `lib/internal/repl/utils.js:310-316` — `getInputPreview`
  calls `sendInspectorCommand(session => session.post('Runtime.evaluate',
  { expression, throwOnSideEffect: true, timeout: 333, ... }))`. The shim
  has zero preview references (`grep -i preview src/repl.js` empty).
  Failure: the preview line is missing from the output (actual
  `['foo\r', '\x1B[36m[Function: foo]\x1B[39m']`, expected includes the
  grey `\x1B[90m[Function: foo]...` preview line). The 26 test change is
  only the `useColors: false`-at-construction-then-`true` shape (same
  comment as Family E: "Keep syntax highlighting out of these preview
  transcript assertions"); the failure mode is identical to v24.
- v24 reason carried forward: NO-FIX, V8 inspector
  (NOTES-repl-completion.md:245-248; NOTES-repl-setup-history.md:129;
  NOTES-repl-require-resolution.md:260).

### H. envvars harness stall, pre-existing NO-FIX (1)

- `test-repl-envvars.js` (124).
- Classification: NO-FIX — harness stall, same at base.
- Evidence: fresh isolated re-run exit 124 with 0 bytes of test output
  (only the runner NOTE line, 188 bytes). The 26 test is formatting-only
  vs v24 (quote style + trailing commas; tokdiff shows no semantic
  change). The test requires `internal/repl` (`REPL.createInternalRepl`);
  the shim exports no `createInternalRepl` (`grep` in `src/repl.js`
  empty), so the servers are native under the harness and the `node:test`
  `mustSucceed` callbacks never fire. Re-probed WITH `--expose-internals`:
  still 124.
- v24 reason carried forward: NO-FIX harness stall
  (NOTES-repl-require-resolution.md:259; NOTES-repl-setup-history.md:127).

### I. Harness-host artifact, NEW (1) — NOT a shim gap

- `test-repl-tab-complete-nested-repls.js` (1).
- Classification: baseline artifact, no lane.
- The test file is SEMANTICALLY IDENTICAL 24 → 26 (tokdiff: no change
  beyond quote style), and the v24 control run passes (exit 0). The outer
  test `spawnSync(process.execPath, [fixture])` — no preload, so the
  fixture runs against the NATIVE host binary. The Node 26 fixture
  dropped the `_domain.on('error', throw)` rethrow (domain gone) and
  relies on the 26 ALS error routing to surface the completion-callback
  error; host v24.22.1 has neither the domain handler (dropped from the
  fixture) nor the ALS routing, so the child swallows the error, exits 0,
  and `assert.ok(result.status, 'testFile swallowed its error')` fails.
- Probes (fixture run directly, no harness):
  - 26 fixture under `node-26` binary: exit 1, `fhqwhgads` ×2 (passes
    natively — matches oracle nativeExit 0 for the outer test).
  - 26 fixture under host v24.22.1: exit 0, `fhqwhgads` ×0.
  - 24 fixture under host v24.22.1: exit 7, `fhqwhgads` ×1.
- The shim is never loaded in the child process. The test cannot pass
  under a v24 host by construction.

## Lane candidates (conservative, file-level)

| Lane | Work | Tests flipped | Est. |
|---|---|---|---|
| L1 | Port Node 26 `_handleError` + `replContext` ALS routing + `handleError` option (`src/repl.js`) | `multiple-instances-async-error`, `uncaught-exception-after-input-ended` | 2 |
| L2 | Port `internal/repl/highlight` (89 lines) + preload redirect for `internal/repl/highlight` | `highlight` | 1 |
| L3 | Port 26 `[kCloseHandle]` into shim `ReplHistory` + preload redirect for `internal/repl/history` | `history-init-fail-leak` | 1 |
| L4 | Remove/gate `enablePromiseTrackingOnce` (`src/repl.js:54-92`) | `top-level-await` | 1 |
| — (util) | Port 26 `formatValue` proxy re-wrap into `src/util.js` | `test-repl.js` | 1 |
| — | `user-error-handler`: 0 file-level (badvalue child subtest needs the Node 26 binary; 7/8 subtests unblocked by L1) | — | 0 |
| — | R5 gate (mode, import, require): PARKED, do not re-propose | — | 0 |

Total flippable: 6 of 13 (5 repl lanes + 1 util lane).

## NO-FIX list (2)

1. `test-repl-preview.js` — V8 inspector `Runtime.evaluate` previews
   (`lib/internal/repl/utils.js:310-316`); no browser equivalent; shim has
   no preview code. Same failure mode as v24.
2. `test-repl-envvars.js` — harness stall, exit 124, 0 test bytes; native
   `internal/repl` servers, callbacks never fire. Same as v24.

## New-in-26 vs pre-existing

- Pre-existing (5): mode, tab-complete-import, tab-complete-require
  (Family A, gate); preview (G, NO-FIX); envvars (H, NO-FIX).
- New in 26 (8): multiple-instances-async-error, uncaught-exception-after-
  input-ended, user-error-handler (B, ALS); highlight (C); history-init-
  fail-leak (D); top-level-await (E, behaviour change); test-repl.js
  (F, inspect change); tab-complete-nested-repls (I, host artifact).
- New test files in 26 (absent from the v24 vendored tree): highlight,
  history-init-fail-leak, multiple-instances-async-error,
  uncaught-exception-after-input-ended, user-error-handler.
- Changed test files with semantic deltas: top-level-await (single-line
  `Promise { 456 }` assertion + useColors shape), test-repl.js
  (`Proxy({ x: 42 })` expectation), preview + top-level-await (useColors
  shape only), mode (dropped `disableDomainErrorAssert`), nested-repls
  fixture (dropped `_domain` rethrow). All other gap test files differ
  from v24 by formatting only (Node's prettier reformat: double → single
  quotes, trailing commas).
- Export surface: no change (parity/drift/node26-export-diff.md: repl 0).
  Changelog cross-check: 25.0.0 "Instantiating REPL without `new` removed"
  — no gap test exercises the no-`new` path (the shim's `REPLServer`
  wrapper at `src/repl.js:3334` is already the no-`new` path; `start()`
  calls it with `new`).

## Baseline corrections

1. `test-repl-tab-complete-nested-repls.js` is misclassified as shim-gap:
   it is a harness-host artifact (Family I probes). True repl shim-gap is
   12, not 13, under a Node 26 host.
2. The baseline runner passes no `// Flags:` headers. Verified against all
   four flagged repl gaps — re-probed WITH `--expose-internals`, all still
   fail identically (envvars 124, highlight 1, history-init-fail-leak 1,
   top-level-await 1) — so no further repl correction. (The one flags
   casualty is readline's `promises-csi`; see NOTES-26-triage-readline.md.)
3. v24 wave-end CSV has 101 rows for 102 repl tests — `test-repl.js` is
   not in the fast-sweep glob; it was counted via manual adjudication
   (exit 0, NOTES-repl-completion.md:219). `parity/drift/run-baseline.mjs`
   DOES include `test-<prefix>.js`, so the 26 baseline counts it
   correctly. Not a 26 error; noted so the coordinator does not re-litigate
   the v24 97/102.
4. `test-repl-user-error-handler.js` can never reach exit 0 under the
   v24.22.1 harness host even after L1 (badvalue child-proc subtest
   probes in Family B). File-level flip estimate is 0 for that reason,
   not for lack of shim work.

## Work notes

- All probes run with the repo's own harness invocation; probe files
  (`zz-*.js`) were created under `parity/node-test/parallel/`, run, and
  deleted; `git status --porcelain -- parity/node-test` is 0 at the end.
- A VM restart mid-triage wiped `/tmp` (logs + scratch scripts); the 3
  unread logs were re-captured afterwards (test-repl.js exit 1,
  envvars/user-error-handler exit 124) — no finding was lost.
