# NOTES-26-events-e1e3 — Node 26 Wave 1 lane (E1–E3)

- Base: origin/main `d587825d` (PR #506 triage merged).
- Lane: `fix/26w1-events-e1e3`, worktree `~/workspace/worktrees/26w1-events`.
- Triage source: `NOTES-26-triage-events.md` §E1–E3.
- Banked count before lane: events **1/9** on the Node 26 suite.
- Result: events **9/9** — 8 flips, 0 regressions.

## Flips (all verified 2x isolated + baseline guard)

| Test | Lane | Root cause |
|---|---|---|
| `test-events-getmaxlisteners.js` | E1 | global-leak detector, timer globals replaced on import |
| `test-events-list.js` | E1 | same |
| `test-events-listener-count-with-listener.js` | E1 | same |
| `test-events-on-async-iterator.js` | E1 | same |
| `test-events-once.js` | E1 | same |
| `test-events-uncaught-exception-stack.js` | E1 | same (leak masked the real assertion: expected `'Error'`, got the leak `AssertionError`) |
| `test-events-add-abort-listener.mjs` | E2 | already-aborted: no event arg, dispose no-op |
| `test-events-static-geteventlisteners.js` | E1+E3 | kEvents walk returned als-browser bound copies |

## Changes

- `parity/events-harness.mjs` (new): restores the four timer globals from
  `globalThis.__PARITY_ORIG_TIMERS__` after importing `src/events.js`,
  re-exports the shim. Mirrors `parity/stream-harness.mjs`. Harness-only.
- `parity/preload.mjs`: `target === "events" && name === "events"` case in
  `polyfillPath()` → `parity/events-harness.mjs` (8 lines, CJS require path).
- `parity/hooks.mjs`: mirror case in `polyfillURL()` (8 lines, ESM import
  path). Required by the ESM-only `test-events-add-abort-listener.mjs`,
  which would otherwise load `src/events.js` directly with no timer
  restore. Same case, same file pair as every other harness.
- `src/events.js` (E2): `pureAddAbortListener` synthesizes a real abort
  `Event` for already-aborted signals (type `abort`, target/currentTarget
  = signal, `isTrusted` true) and makes the scheduled microtask call
  cancellable by dispose (disposed flag checked at call time).
  `addAbortListenerInternal` routes already-aborted signals to the pure
  path before delegating — the host v24 builtin calls the listener with no
  arguments and ignores dispose (probe-verified), so delegation cannot
  pass the two new Node 26 subtests. The non-aborted path still delegates
  (stopImmediatePropagation resistance preserved).
- `src/events.js` (E3): shim-side originals registry. `EventTarget.prototype`
  add/removeEventListener are wrapped on top of als-browser's patch (ALS
  propagation preserved); originals are recorded per (target, type) in
  insertion order with Node's dedup (same listener + capture registers
  once). `getEventListeners` consults the registry first, falls back to
  the kEvents walk for pre-load or bypassing listeners.

## Probes (Node 26.13.1 binary `~/workspace/local/node-26/bin/node`)

- Already-aborted `addAbortListener`: listener receives a real `Event`
  (`instanceof Event`, `type` `abort`, `target === signal`,
  `currentTarget === signal`, `isTrusted` true, no own properties);
  dispose-then-await does NOT fire the listener; live-abort event is a
  real trusted event. (Probe files deleted after use.)
- `signal.dispatchEvent(new Event('abort'))` leaves `isTrusted` false on
  both the Node 26 binary and host v24.22.1 — so the E2 synthesis shadows
  the three read-only accessors with own properties instead of
  dispatching. All asserted properties and `instanceof Event` match.
- als-browser `AsyncLocalStorage.bind` returns a plain closure with no
  reference to the original, and its `listenerMap` WeakMap is
  module-private with no public unwrap API — hence the shim-side registry
  for E3 (no route through the bound function exists).

## Verification

- Before (baseline runner, `PARITY_TARGET=events`, 10 s/30 s phases):
  1/9 pass — `test-events-customevent.js` only; the other 8 fail
  (exit 1, except `test-events-uncaught-exception-stack.js` exit 7).
  2 tests hit the 10 s phase-1 cap in the before-run.
- After, direct isolated runs (staged Node 26 tree, `timeout 30 node
  --import ./parity/preload.mjs`, `PARITY_TARGET=events`): 9/9 pass,
  run twice (two separate passes, all exit 0).
- After, baseline guard (`parity/drift/run-baseline.mjs --modules events
  --jobs 2 --short 10 --full 30`, fresh `/tmp` out/CSV): **9/9 pass**,
  0 fail, 0 timeout; `parity/node-test/` restored clean. 4 tests hit the
  10 s phase-1 cap and passed on the 30 s phase-2 re-run — same shape as
  the before-run (2 cap hits); a single vendored test measures 3.2 s
  wall / 0.3 s CPU, so the cap hits are load variance on the shared
  1.5-CPU VM, not hangs (no 124s anywhere).
- Flags headers: `test-events-on-async-iterator.js`
  (`--expose-internals --no-warnings`), `test-events-once.js`
  (`--no-warnings`), `test-events-static-geteventlisteners.js`
  (`--expose-internals --no-warnings`). All three re-run directly WITH
  their flags: exit 0. The baseline runner does not pass flags; outcomes
  are identical with and without them (the preload's
  `internal/event_target` adapter already covers the internals require).
- Repo jest (`NODE_OPTIONS=--experimental-vm-modules npx jest`,
  the repo's own `npm test` invocation — a bare `npx jest` fails on ESM
  transform for these files, pre-existing, unrelated):
  `tests/events_named_exports.test.js`,
  `tests/export_surface_events.test.js` — 10 passed;
  `tests/vite7-events-require-interop.test.js` — 7 passed. Total 17/17.
- Cross-module guard: `async_hooks` Node 26 baseline re-run
  (`--modules async_hooks --jobs 2`): 29/36, per-test statuses and exit
  codes identical to `node26-baseline.jsonc`. No regressions.
- Prettier: `npx prettier --check` clean on all four touched files.
- `node --check` clean on all four touched files.

## Ceilings / follow-ups (not regressions)

- E2 synthesis: the event carries own `target`/`currentTarget`/`isTrusted`
  properties; Node 26's has none (internal dispatch). If a future test
  asserts the absence of own properties, the synthesis needs real
  internal dispatch, which public APIs cannot do.
- E3 registry: `{ once: true }` listeners (and `signal`-option removals)
  stay in the registry after they fire / abort — Node removes them from
  kEvents on dispatch; pruning would need dispatch-time hooks. Weak
  (`kWeakHandler`) listeners are held strongly by the registry while
  their target lives.
- `listenerCount` for EventTargets still reads kEvents size (als-browser
  double-counts a twice-added listener: 2 vs Node's 1). No in-scope test
  asserts it (`test-events-listener-count-with-listener.js` is
  EventEmitter-only); the same registry could fix it in a follow-up.
- The E1 caveat from triage (restoring originals removes ALS propagation
  through timers for the test duration) held: no test in the suite
  regressed, including `test-events-on-async-iterator.js`.

## Recovery verification (2026-11-19, independent re-check of `efc3c2bd`)

- Baseline guard re-run by the recovery worker (fresh
  `/tmp/events-e1e3-verify/` out/CSV, `--modules events --jobs 2 --short 10
  --full 30`): **9/9 pass, 0 fail, 0 timeout**, all 9 in phase 1 (no cap
  hits this run). New count: 1 + 8 = **9/9**. The original worker's 9/9
  claim is confirmed, not trusted on faith.
- Flips 2x isolated, recovery worker's own runs: the 7 CJS flips exit 0
  twice each run from the Node 26 tree (`PARITY_TARGET=events timeout 30
  node --import $PWD/parity/preload.mjs <test>`). E2 needed the staged
  location: `parity/hooks.mjs` only redirects ESM imports whose importer
  lives under `parity/node-test/parallel/`, so an isolated run from the
  Node 26 tree loads the host v24 builtin and fails the event-arg subtest
  (`listener called with undefined`, 8/9) — a harness-scoping artifact,
  not a code defect. Re-run from `parity/node-test/parallel/` with the
  Node 26 test + common staged over the vendored copies: exit 0 twice.
  (The vendored `test-events-add-abort-listener.mjs` is the OLD v24 file
  — it lacks both new Node 26 subtests — so a run against it proves
  nothing for E2; the Node 26 copy is what was verified.)
- Flagged tests re-run WITH flags: `on-async-iterator`
  (`--expose-internals --no-warnings`), `once` (`--no-warnings`),
  `static-geteventlisteners` (`--expose-internals --no-warnings`) — all
  exit 0. Note: `run-baseline.mjs` does NOT honor `// Flags:` headers.
- Repo jest events suites: 17/17 (`NODE_OPTIONS=--experimental-vm-modules
  npx jest tests/events_named_exports.test.js
  tests/export_surface_events.test.js
  tests/vite7-events-require-interop.test.js`).
- Cross-module guard: `async_hooks` re-run 29/36, per-test statuses and
  exit codes IDENTICAL to `node26-baseline.jsonc` (zero diffs). No
  regressions.
- Recovery-worker incident: a `rm -rf parity/node-test` (mistaken for
  ignored staging) deleted tracked vendored files mid-verification;
  restored immediately with `git checkout -- parity/node-test` plus
  removal of 4 untracked staged-only common files
  (`bench.js`, `trace_events.js`, `quic/`, `wpt/`); `git status` verified
  clean (`?? node_modules` only) before proceeding. Lesson recorded here:
  `parity/node-test/` is TRACKED — never `rm -rf` it; the runner's own
  restore (`git checkout --` + exact staged-only deletion) is the only
  safe cleanup.
