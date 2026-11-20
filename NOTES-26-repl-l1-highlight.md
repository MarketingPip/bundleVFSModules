# NOTES — Node 26 Wave 2 REPL lane: L1 ALS routing + L2-repair highlight (3 flips)

- Base: `652333e7` (origin/main). Node 26.13.1 verified
  (`~/workspace/local/node-26/bin/node --version` → `v26.13.1`).
  Harness host is v24.22.1. Branch: `feat/w2-repl-l1-highlight`.
- Rebase (2026-11-20, before merge): origin/main advanced three times
  while the PR was open (first to `4a05cd91`: #522 stream, #523
  worker_threads, #524 zlib; then to `a1d2b4d8` #525 perf_hooks +
  `e895aceb` docs; then to `dc70e38d` #527 crypto), so the branch was
  rebased three times onto current main. The ONLY conflict each time
  was `dist/vfs.js` (the shared manifest every lane regenerates);
  resolved by regenerating it from the new base's dist files + the
  rebuilt repl bundle. The src/ diff is byte-identical before/after
  the rebases (md5-verified); all flip + differential evidence below
  was gathered at `652333e7`.
- Banked (coordinator-verified on live main, not recomputed): repl **97/108**.
  New count = 97 + flips verified 2x on live main − regressions in the
  differential. Never computed from triage expectations.
- Method: Node 26 test tree staged into `parity/node-test/` (parallel +
  common + fixtures, as `parity/drift/run-baseline.mjs` stages it), each
  flip / adjudication re-run isolated as
  `PARITY_TARGET=repl timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/<test>` (helper
  `parity/drift/w2-repl-l1/run-isolated.sh`, which stages + restores the
  tree). Tree restored afterwards (`git checkout -- parity/node-test` +
  explicit deletion of staged-only files; `git status --porcelain --
  parity/node-test` = 0). Full differential via
  `parity/drift/run-baseline.mjs --modules repl --jobs 2`.
- CAUTION (recorded): `run-baseline.mjs` does NOT honor `// Flags:`
  headers — flagged tests were run directly WITH their flag and recorded
  here. 16 repl tests declare Flags (mostly `--expose-internals`).

## Flips (2, all isolated [0,0] x2)

### L1 — `test-repl-multiple-instances-async-error.js` [0,0] x2
### L1 — `test-repl-uncaught-exception-after-input-ended.js` [0,0] x2

- Port: Node 26 `_handleError` + `replContext` ALS routing + `handleError`
  option (`src/repl.js`). Eval wrapped as `REPLEval` in
  `replContext.run({ replServer: self }, ...)` (Node lib/repl.js:692);
  user handler dispatched first in `_handleError` ('ignore' → return,
  'print' → fall through, 'unhandled' → return 'unhandled', else coded
  `ERR_INVALID_STATE` with the exact native message).
- Host adaptation (proven, not assumed): `process.addUncaughtExceptionCaptureCallback`
  is **undefined on v24.22.1** (probed directly: node-26 binary → function,
  v24 host → undefined). The port installs it when present and falls back
  to the v24 singleton `setUncaughtExceptionCaptureCallback` — only when
  no callback is already set, with "not mine" reproduced in-callback
  (emit `uncaughtException`; if no listener, unset capture +
  `setImmediate(() => { throw err; })` to crash exit 1), because the
  singleton's return is ignored by the dispatcher. The async-'unhandled'
  subtest of test-repl-user-error-handler passing validates the singleton
  not-mine emulation (the error reached the test's
  `once(process, 'uncaughtException')` listener).
- Log: `parity/drift/w2-repl-l1/flip-l1.txt` (pre-bridge runs);
  re-verified post-bridge in `reverify-after-bridge.txt` (see § Regression).

## Removed from this PR — highlight repair is a FOLLOW-UP lane (not landed)

- Per parent direction (2026-11-20), the L2-repair of
  `test-repl-highlight.js` is NOT part of this Wave 2 PR. The fix was
  written, verified, and then REVERTED out of this branch; the work is
  preserved here and in the lane scratch logs for the follow-up lane.
  This PR is L1-only: 2 flips, 97 → 99.
- Root cause (coordinator-proven, confirmed by the parent: the test
  passes exit 0 on 067a8700 and fails exit 1 4x on live main 652333e7):
  Wave 1 util #513 U3 set `inspect.styles.regexp = highlightRegExp` (a
  FUNCTION, src/util.js:1100) and the repl-highlight port's local
  `stylizeWithColor` (src/internals/repl-highlight.js:30-37) assumed
  style values are color-name strings — `inspect.colors[function]` is
  undefined, so `highlight('/regexp/u')` returned unstylized and test:35
  (`assert.notStrictEqual(highlight(source), source)` for '/regexp/u')
  failed.
- Oracle fix (verified before removal): mirror Node 26
  lib/internal/util/inspect.js:850-862 — if `inspect.colors[style]` is
  undefined AND `typeof style === 'function'`, return `style(str)`.
  Oracle check (Node 26 binary, `--expose-internals`,
  `require('internal/repl/highlight')`): `highlight('/regexp/u')` =
  `"\u001b[32m/\u001b[39m\u001b[33mr\u001b[39m\u001b[33me\u001b[39m\u001b[33mg\u001b[39m\u001b[33me\u001b[39m\u001b[33mx\u001b[39m\u001b[32m/\u001b[39m\u001b[31mu\u001b[39m"`;
  `highlight('const value = "text"')` also byte-identical to the oracle.
  With the fix applied the test passed isolated [0,0] x2 (with
  `--expose-internals`); after the revert it fails again, as expected.
- Logs preserved for the follow-up lane:
  `parity/drift/w2-repl-l1/flip-l2.txt` (verified flip, pre-revert),
  `reverify-flagged.txt` (post-bridge re-verification). The fix itself
  is recoverable from the pre-revert commit on this branch
  (`git show <pre-revert>:src/internals/repl-highlight.js` — the
  function-style branch in `stylizeWithColor`).
- `src/internals/repl-highlight.js` has NO dist representation: no file
  in src/ imports it (the browser repl never loads
  `internal/repl/highlight`; the fix is exercised via the parity
  harness preload redirect only). Nothing to regenerate for it.

## Regression found in differential — and repaired (not a flake)

### `test-repl-underscore.js` — REGRESSED by the first L1 attempt, REPAIRED

- Symptom: base sweep pass + base isolated [0,0] x2 vs post-fix sweep
  fail + post-fix isolated fail x3. Failure mode: `testError()`'s
  setImmediate assertion at test:187 `assert.match(line, expected)`
  threw `TypeError [ERR_INVALID_ARG_TYPE]: The "regexp" argument must be
  an instance of RegExp. Received undefined` — one extra output line.
  A dump probe (`zz-underscore-dump.js`) showed 16 lines vs 15 expected;
  the extra line was `    at Immediate.<anonymous> (REPL7:1:37)` — a stack
  frame of the async 'baz' error that the native server normally slices
  away.
- Mechanism (proven end to end, not guessed):
  1. The first L1 attempt added a static
     `import { AsyncLocalStorage } from "./async_hooks"` to src/repl.js.
     `src/async_hooks.js` statically imports the `als-browser` npm
     package, which patches the global timers (setTimeout / setInterval /
     setImmediate / queueMicrotask) at import time.
  2. Probe (`zz-patch-probe.js`, checks
     `Symbol.for('als-browser:original') in globalThis.setImmediate`):
     at base (pristine `652333e7` worktree) `require('repl')` leaves the
     timers UNPATCHED (all false); post-fix they were PATCHED (all true).
     `src/readline.js:17-20` avoids `../events.js` for exactly this reason.
  3. The patched `setImmediate` wraps the eval'd callback in a
     null-named bind-wrapper frame. The native v24 domain error handler
     (lib/repl.js:638-660) slices the stack at the LAST null-named frame
     and keeps what is above it — with the wrapper present, the user's
     arrow frame survives the cut (one extra line); without it, the arrow
     frame is the last null-named frame and is cut (single-line output).
  4. The test uses NATIVE servers via `common/repl.js` (no shim
     REPLServer is ever constructed), so the failure was purely the
     import-time timer patch leaking into the test process — the shim's
     repl module must not pull `als-browser` into the graph.
- Repair: removed the static `./async_hooks` import. `replContext` is
  now resolved lazily through `process.getBuiltinModule("async_hooks")`
  (same four-export validation `src/async_hooks.js` uses for its
  `loadNativeAsyncHooks` probe), which loads nothing extra and returns
  the NATIVE AsyncLocalStorage under the harness; in the browser there
  is no native module, so it is a no-op stub (`run` calls through,
  `getStore` returns undefined — eval runs un-wrapped, async errors
  surface as the host's ordinary uncaught errors, never swallowed).
  Call sites use `getReplContext()` (capture callback, `processNewListener`
  guard, eval wrap).
- Re-verification (log `reverify-after-bridge.txt`): patch probe after
  the repair — timers UNPATCHED after `require('repl')` (all false),
  matching base. `test-repl-underscore.js` [0,0] x2 isolated, and it
  PASSES in the final full sweep.

### `test-repl-programmatic-history-setup-history.js` — same root cause, repaired

- Post-fix sweep fail (exit 1) + isolated [0,0] x2 both at base and
  post-fix, with `Failed test # 10` printed in ALL isolated runs — the
  #10 subtest output mismatch is pre-existing and load-dependent. The
  test `require('repl')`s the SHIM from parallel/, so the timer patch
  shifted its timing under sweep load. After the bridge repair: [0,0] x2
  isolated AND passes in the final full sweep.

## Guards held (full 97 pass set)

- Full flag-less differential after the highlight revert
  (`parity/drift/w2-repl-l1/baseline-l1-only.jsonc`):
  **97/108 pass, 10 fail, 1 timeout**. The 2 L1 flips PASS in the sweep;
  `test-repl-underscore.js` and `test-repl-programmatic-history-setup-history.js`
  PASS in the sweep (regressions gone). `test-repl-highlight.js` fails
  again (expected — follow-up lane, see § Removed from this PR).
- Flag-aware count: 97 + `test-repl-reverse-search.js` (passes [0,0] x2
  WITH `--expose-internals`; flag-less failure is a `// Flags:` artifact
  of the runner) + `test-repl-history-navigation.js` (known load flake,
  isolated [0,0] x2 post-fix — see below) = **99/108** (97 banked + 2).
- The pre-revert differential (`baseline-final.jsonc`) read 98/108
  flag-less / 100/108 flag-aware with the highlight repair in the tree;
  it is superseded by `baseline-l1-only.jsonc` — the only delta is the
  highlight test, reverted per parent direction.
- Repo tests: `npx --no-install jest tests/repl.test.js
  tests/export_surface_repl.test.js` — 2/2 pass.
- `test-repl.js` still passes (util lane flip held, banked, not counted).

### `test-repl-history-navigation.js` — known load flake, adjudicated

- Failed in the final sweep (exit 1); isolated post-fix [0,0] x2
  (`reverify-after-bridge.txt`). Same handling as the coordinator's
  banked adjudication (fails in sweeps, passes isolated). Not a regression.

## Remaining failures (9 files, all expected / out of lane)

- `test-repl-envvars.js` (timeout 124) — NO-FIX per triage.
- `test-repl-highlight.js` — Wave 1 util #513 cross-lane regression;
  repair is a FOLLOW-UP lane, not this PR (see § Removed from this PR).
- `test-repl-history-init-fail-leak.js` — L3, not a Wave 2 lane.
- `test-repl-mode.js`, `test-repl-tab-complete-import.js`,
  `test-repl-tab-complete-require.js` — R5-gate-blocked family A, PARKED.
- `test-repl-preview.js` — NO-FIX per triage.
- `test-repl-tab-complete-nested-repls.js` — host artifact per triage.
- `test-repl-user-error-handler.js` — still failing as a file (0 flips),
  but improved 124 timeout → 6/8 subtests pass (see below).

### `test-repl-user-error-handler.js` — 6/8 subtests (not a flip)

- Passing: sync ignore/print/unhandled + async ignore/print/unhandled.
- Failing: sync badvalue — `Missing expected exception`. The
  `ERR_INVALID_STATE` IS created with the exact native message
  (`Error [ERR_INVALID_STATE]: Invalid state: External REPL error handler
  must return either "ignore", "print", or "unhandled", but received: ...`),
  but it surfaces as an unhandledRejection, not a sync throw out of
  `input.end()`, because the shim's `_defaultEval` is `async` — async
  functions convert sync-prefix throws into rejected promises, while
  Node 26's defaultEval is a plain function. Deliberately NOT fixed by
  refactoring `_defaultEval` into a sync+async split for this one
  subtest: out of lane scope, regression risk to the passing
  top-level-await tests, and the file stays red either way (child
  badvalue also fails — the child spawns the host v24 native repl, which
  has no `handleError`, as triage predicted). Upgrade path: split
  `_defaultEval` so the sync prefix (including `_handleError` dispatch)
  throws synchronously.
- Triage estimated 7/8; actual 6/8 — the sync-badvalue root cause above
  is the difference. Log: `parity/drift/w2-repl-l1/user-error-handler.txt`.

## Ceilings (ponytail, also in code comments)

- Node's `_handleError` standalone branch is NOT ported: the shim has no
  `_isStandalone`, so a standalone REPL prints like a non-standalone one.
- Singleton (v24) path cannot distinguish unhandled rejections from
  uncaught exceptions — v24 passes only the error to the capture
  callback. Node 26's `add*` path gets the same limitation in practice
  (the callback receives only the error); the routing is by store, not
  by event kind.
- Browser: no native ALS, no host process — `replContext` is a no-op
  stub and no capture is installed; async errors surface as the host's
  ordinary uncaught errors. The `handleError` option is still honored
  for sync eval errors through `_handleError`.
- `processNewListener` guard: a `uncaughtException` listener added from
  inside a REPL eval throws `ERR_INVALID_REPL_INPUT` (Node lib/repl.js:207-219).

## Files changed

- `src/repl.js` — L1 port + lazy native-ALS bridge (no `./async_hooks`
  import; see § Regression).
- `NOTES-26-repl-l1-highlight.md` (this file).
- dist: see § Dist below.
- NOT in this PR: `src/internals/repl-highlight.js` — the L2-repair was
  written, verified, and reverted out per parent direction; it ships
  unchanged from base and its repair is a follow-up lane (see § Removed
  from this PR).

## Dist

- `dist/repl.js` + `dist/vfs.js` regenerated (same pattern as #513, which
  touched dist/console.js + dist/repl.js + dist/util.js + dist/vfs.js).
  Verified: 77 vfs exports, same keys/order; ONLY the `repl` export
  differs between old and new vfs.js; new vfs `repl` === dist/repl.js
  bytes exactly; the bundle parses (`node --check`) and contains the L1
  strings (`External REPL error handler must return`, `getBuiltinModule`).
- The full build (`node src/build-vfs.mjs`) does NOT complete in this
  environment: it dies with exit 1 on `src/specials/bundler.js` —
  esm-sh-plugin failed to fetch `https://esm.sh/acorn?bundle` and
  `https://esm.sh/acorn-walk?bundle` after multiple attempts (network,
  not this lane; the failing file is untouched by this change). 64
  modules built before the exit; the only dist file the full build
  changed was `dist/zlib.js` (1-line drift, reverted — out of lane).
  Regeneration was therefore done with the script the build file itself
  anticipates: `parity/drift/w2-repl-l1/rebuild-repl-dist.mjs`, which
  imports `nodeGitHubPlugin`/`esmShPlugin` from `src/build-vfs.mjs`
  and replicates `bundleToString` (same esbuild options/plugins) for
  the repl entry only, then replicates `generateVFS`+`minifyCode` over
  the dist files on disk. The repl entry itself needs no esm.sh fetch
  (bare `acorn`/`acorn-walk` resolve from node_modules).
- `src/internals/repl-highlight.js` has NO dist representation: no file
  in src/ imports it (the browser repl never loads `internal/repl/highlight`;
  the L2 fix is exercised via the parity harness preload redirect only).
  Nothing to regenerate for it; the file ships as source.
