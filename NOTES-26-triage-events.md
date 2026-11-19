# NOTES-26-triage-events — Node 26.13.1 drift triage (events)

- Base: `3c091022` (worktree `~/workspace/worktrees/node26-triage-core-small`).
- Scope: 8 gap tests, all class `shim-gap` in
  `hidden_files/node26-triage/gaps-events.json`, nativeExit 0 for all 8.
- Node 26 binary verified: `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
- Method: same as NOTES-26-triage-buffer.md — staged the Node 26 test tree
  over `parity/node-test/`, re-ran each gap with the exact
  `parity/drift/run-baseline.mjs` invocation (`PARITY_TARGET=events`,
  timeout 10 s). All 8 reproduced. Tree restored after;
  `git status -- parity/node-test` clean.
- Export diff (`parity/drift/node26-export-diff.md`): events has NO
  export-surface change. Changelog cross-check: no listed-module change
  for events in 25/26.
- Headline: 6 of the 8 failures are ONE harness gap (E1), and the other
  2 are real shim work (E2, E3). The E1/E3 root cause is a repo change
  made AFTER the v24 sweep, not a Node 26 change.

## Families

### E1 — Timer globals replaced on import trip the global-leak detector (6 leak-only + 1 more, harness gap)
- Tests whose ONLY failure is the leak (exit 1):
  `test-events-getmaxlisteners.js`, `test-events-list.js`,
  `test-events-listener-count-with-listener.js`,
  `test-events-on-async-iterator.js`, `test-events-once.js`,
  `test-events-uncaught-exception-stack.js`.
  (`test-events-add-abort-listener.mjs` also trips the leak, on top of
  its real defects — see E2.)
- Failure (identical in all 6, from the staged Node 26 `test/common/index.js:439`,
  on process exit):
  `AssertionError [ERR_ASSERTION]: Unexpected global(s) found: setImmediate, setInterval, setTimeout, queueMicrotask`.
  For `test-events-uncaught-exception-stack.js` this masks the real
  assertion: expected `'Error'`, got the leak `AssertionError` instead
  (test line 10).
- Mechanism, probe-proven:
  - `src/events.js:41` statically imports `./async_hooks.js`, which
    imports `als-browser` (`src/async_hooks.js:29`).
  - Importing `src/events.js` replaces all four timer globals
    (probe: `node probe-timers.mjs` → `after events.js import replaced:
    ["setTimeout","setInterval","setImmediate","queueMicrotask"]`).
    als-browser's `dist/index.mjs` patches the timers (and
    `EventTarget.prototype.addEventListener` — see E3).
  - `test/common/index.js` snapshots `knownGlobals` (by VALUE) when it
    loads — every events test requires `../common` FIRST, then `events`
    — so the exit-time check sees the replaced timer functions as leaks.
  - The preload already anticipates this: it snapshots the originals in
    the non-enumerable `globalThis.__PARITY_ORIG_TIMERS__`
    (`parity/preload.mjs:53-65`) with the comment that "als-browser
    (pulled in via async_hooks → events → stream → fs) replaces them on
    import". Harnesses restoring the originals exist for stream,
    async_hooks, http, http2, https, net, tls, tty, child_process
    (`parity/*-harness.mjs`) — but there is NO `parity/events-harness.mjs`,
    and `polyfillPath()` in the preload has no `target === "events"` case.
- Why this is a REGRESSION, not a Node 26 change: at the port commit
  `af30d6fb` ("Port node:events from Node v24.20.0; 9/9 official tests
  pass") `src/events.js` did NOT statically import async_hooks — the
  header said "`async_hooks` is loaded lazily only when
  `EventEmitterAsyncResource` is requested" (getter at old lines
  1479-1488). The static import was added in `647123b1` ("Export-surface
  parity: named exports for 6 modules (#68)"): `+import { AsyncResource
  as LocalAsyncResource } from './async_hooks.js';` with the comment
  "so this stays constructible in browsers (backed by the stub
  AsyncResource ...)". From that commit on, every `require('events')`
  pulls als-browser and replaces the timers. The 8 test files are all
  vendored (pre-existing); their require order (common first, then
  events) is identical in v24 and 26.
- Fix (harness-only, no src/ change — mirrors `parity/stream-harness.mjs`
  / `parity/async-hooks-harness.mjs`): add `parity/events-harness.mjs`
  that imports `../src/events.js`, restores the four originals from
  `__PARITY_ORIG_TIMERS__`, re-exports the shim; add the preload
  redirect `if (target === "events" && name === "events")`. The shim
  keeps working (it captured its own references) — same claim the
  existing harnesses make.
- Caveat to carry into the lane: restoring the originals also removes
  als-browser's ALS propagation through timers for the duration of the
  test. Precedent says this is fine (the stream and async_hooks suites
  pass under the same restore, and stream uses async_hooks heavily),
  but the lane should watch the `on`-async-iterator test for it.
- Alternative fix (product change, NOT recommended for this lane):
  restore lazy loading of async_hooks in `src/events.js`. That would
  also fix E1 but reopens the export-surface problem 647123b1 solved
  (`EventEmitterAsyncResource` constructible at load in browsers).
- Lane: **events-harness (timer restore) — flip 6**.

### E2 — addAbortListener: already-aborted signals (1, real shim work)
- Test: `test-events-add-abort-listener.mjs` (exit 1). Also trips the
  E1 leak (the exit-1 cause); underneath it, 2 subtests fail. Both
  subtests are NEW in 26 — the v24 file contains neither
  "should pass an abort event" nor "should not execute ... when disposed"
  (grep of `HEAD:parity/node-test/parallel/test-events-add-abort-listener.mjs`
  → no hits). The other 7 subtests pass under the harness.
- Defect (a) — listener gets no event. Subtest "should pass an abort
  event to the listener for aborted runners" (test lines 36-45) fails
  with `TypeError: Cannot read properties of undefined (reading 'type')`
  at line 42 (`event.type`). The listener resolves `[e, e?.currentTarget]`
  and asserts `event.type === 'abort'`, `event.target === signal`,
  `event.isTrusted === true`, `currentTarget === signal`.
  - Shim source: `pureAddAbortListener` (`src/events.js:1470-1496`) does
    `queueMicrotask(() => listener())` for already-aborted signals —
    called with NO arguments.
  - Node 26 behavior change, probe-verified: on the 26 binary the real
    builtin calls the listener with a real abort event (`type= abort,
    target===signal: true, isTrusted: true, currentTarget===signal: true`).
    On the host Node 24.22.1 the real builtin ALSO passes `undefined`
    (`type= undefined, target===signal: false`) — so under this harness
    even the real-builtin delegation path cannot pass this subtest; the
    shim must synthesize the event itself.
- Defect (b) — dispose does not prevent the late call. The suite-level
  error is: `A resource generated asynchronous activity after the test
  ended. This activity created the error "AssertionError [ERR_ASSERTION]:
  function should not have been called at ...mjs:49"` — the
  `mustNotCall` listener from the "should not execute ... when disposed"
  subtest (line 48-49) fired after the subtest ended.
  - Shim source: in the already-aborted branch `removeEventListener`
    is never set, so `[Symbol.dispose]` is a no-op — the queued
    microtask fires regardless.
  - Probe-verified this is a Node 26 behavior change, not a
    shim-only quirk: dispose-immediately-then-await on the HOST real
    builtin (v24.22.1) ALSO fires the listener (`REAL listener fired
    after dispose!`); the shim behaves identically
    (`SHIM listener fired after dispose!`). The 26 test passes natively,
    so Node 26 made the already-aborted invocation cancellable.
- Fix: in `pureAddAbortListener`, synthesize a real abort `Event`
  (type `abort`, target/currentTarget = signal, `isTrusted` true) for
  already-aborted signals, and make the scheduled invocation
  cancellable by dispose (e.g. a disposed flag checked at call time).
- Lane: **events-addAbortListener-aborted (synthesize Event + cancellable
  call) — flip 1** (applies after the E1 harness fix, which clears the
  exit-1 leak masking it).

### E3 — getEventListeners returns als-browser wrappers (1, real shim work)
- Test: `test-events-static-geteventlisteners.js` (exit 1), failing at
  line 32: `getEventListeners(target, 'foo')` — actual
  `[Function (anonymous)], [Function (anonymous)]`, expected
  `[Function: mustNotCall], [Function: mustNotCall]`.
  The EventEmitter block (lines 20-21) passes; the failure is the
  EventTarget block.
- The test is substantively UNCHANGED in 26 (only quote-style diffs) —
  this is a regression from the same `647123b1` static import as E1:
  at port time `require('events')` never loaded als-browser, so
  `addEventListener` was unpatched and the originals came back.
- Mechanism, probe-proven step by step:
  - als-browser `dist/index.mjs:429-462` (`patchEventTarget`) replaces
    `EventTarget.prototype.addEventListener` with a wrapper that stores
    `AsyncLocalStorage.bind(listener)` in Node's internal listener list
    and keeps the original→bound mapping in a module-private
    `listenerMap` WeakMap (no public unwrap API).
  - Probe: after `import src/events.js`,
    `EventTarget.prototype.addEventListener` is a different function
    (`before === after` → false, name `''`); the stored
    `handler.listener === fn1` → false.
  - The shim's `getEventListeners` (`src/events.js:1521-1545`) walks
    Node's internal `kEvents` list exactly like native
    (`lib/events.js:933-948`) — a manual walk of the same list returns
    the originals (`listener === fn1` → true) when als-browser has NOT
    been imported. Once imported, the list holds the bound wrappers.
    (`target[kEvents]` is a `SafeMap`, not a `Map` — irrelevant to the
    walk, which only needs `.get(type)`.)
- Fix (lane investigation required): `getEventListeners` must unwrap
  to the original listener. Options: expose/reach als-browser's
  private `listenerMap` (no public API today), track originals in the
  shim's own layer, or have the shim's EventTarget interop keep the
  mapping. The `removeEventListener` translation already depends on
  the same private map (als-browser translates back on remove).
- Lane: **events-getEventListeners-unwrap — flip 1**.

## Lane candidates (conservative flips)
| Lane | Tests | Est. flips |
|---|---|---|
| events-harness, timer restore (E1) | getmaxlisteners, list, listener-count-with-listener, on-async-iterator, once, uncaught-exception-stack | 6 |
| events-addAbortListener-aborted (E2) | add-abort-listener | 1 |
| events-getEventListeners-unwrap (E3) | static-geteventlisteners | 1 |
| **Total** | | **8 / 8** |

## NO-FIX list
- None. E1 is harness-only; E2/E3 are portable JS fixes (E2's
  synthesized Event is a normal `Event`; E3's unwrap is bookkeeping).

## New-in-26 vs pre-existing
- All 8 test files are VENDORED (pre-existing in
  `parity/node-test/parallel/`).
- 6 leak-only failures (E1) are a repo regression introduced by
  `647123b1` (static async_hooks import), present at base `3c091022`
  — NOT a Node 26 change. They were passing at the events port
  (`af30d6fb`, 9/9).
- 1 file has NEW-in-26 assertions (E2: two new subtests in
  add-abort-listener).
- 1 file is substantively unchanged but newly failing via the same
  `647123b1` import (E3: getEventListeners).

## Baseline corrections
- None for the exit codes — all 8 reproduce as classified. But the
  `shim-gap` class on the 6 E1 tests understates the finding: they are
  a harness gap (missing events-harness), not shim-behavior gaps.
  The coordinator should record E1 as harness work, not shim work.
