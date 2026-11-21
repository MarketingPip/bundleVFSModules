# Wave 4 — EVENTS triage (30 files)

- Worktree: `~/workspace/worktrees/w4-events`, detached HEAD `6e4e6370`
- Oracle: native Node v26.13.1 (`~/workspace/local/node-26/bin/node`), no preload, 60 s timeout
- Baseline: host Node v24.22.1, `--import <worktree>/parity/preload.mjs` + `PARITY_TARGET=events`, 60 s timeout
- Staging: 30 Node 26 test files copied into `parity/node-test/parallel/`; `parity/node-test/common/` replaced with Node 26 `test/common/` (v24 copy backed up to `/tmp/w4-events-common-v24-backup`), both restored afterwards
- Flags honored: `--no-warnings` on the 3 max-listeners-warning tests; `--experimental-eventsource` on `test-eventsource.js`
- List verified: all 30 files exist under `~/workspace/local/node-26-src/test/parallel/`; none overlapped a tracked v24 file in the worktree
- Worktree left clean: `git status` shows only `?? node_modules` (pre-existing symlink); `git diff` empty

## Totals (of 30)

| Category | Count |
|---|---|
| PASS already | 20 |
| FLIPPABLE | 8 |
| NO-FIX | 0 |
| NOT-A-GAP | 2 |

## Per-file table

Oracle = native Node 26.13.1 rc. Baseline = shim rc. All 8 failures reproduced 3/3 runs (sweep + 2 isolated re-runs); no flakes, no OOM/load artifacts.

| File | Oracle | Baseline | Classification + reason |
|---|---|---|---|
| test-event-capture-rejections.js | 0 | 1 | FLIPPABLE (events) — `thenableThatThrows`: shim `addCatch` getter-throw branch passes the thenable object `{}` as the error instead of the caught error. `src/events.js:1121-1126` does `deferNextTick(emitUnhandledRejectionOrErr, that, promise, ...)` on getter throw; Node `lib/events.js:375-376` does `that.emit('error', err)` with the thrown `Error: kaboom`. Error handler got `{}` vs expected `Error: kaboom` (test:245). Also sync-vs-nextTick differs. |
| test-event-emitter-add-listeners.js | 0 | 0 | PASS already |
| test-event-emitter-check-listener-leaks.js | 0 | 0 | PASS already |
| test-event-emitter-emit-context.js | 0 | 0 | PASS already |
| test-event-emitter-error-monitor.js | 0 | 0 | PASS already |
| test-event-emitter-errors.js | 0 | 1 | FLIPPABLE (events) — shim mini-`inspect` (`src/events.js:124`) ignores `util.inspect.custom` and never throws, so `getUnhandledErrorException`'s try/catch fallback (`src/events.js:1104-1109`, mirroring Node `lib/events.js:469-473`) never fires. For the object whose `[util.inspect.custom]()` throws, expected message `Unhandled error. ([object Object])`, shim produced `Unhandled error. ({ message: 'Error!' })` (test:27). Fix: use real `util.inspect` (or honor custom-inspect-throw) in that path. |
| test-event-emitter-get-max-listeners.js | 0 | 0 | PASS already |
| test-event-emitter-invalid-listener.js | 0 | 0 | PASS already |
| test-event-emitter-listener-count.js | 0 | 0 | PASS already |
| test-event-emitter-listeners-side-effects.js | 0 | 0 | PASS already |
| test-event-emitter-listeners.js | 0 | 0 | PASS already |
| test-event-emitter-max-listeners-warning-for-null.js | 0 | 1 | FLIPPABLE (events) — warning message text. Shim renders the emitter as a full object dump (`{ _events: { null: [...] }, ... }`); Node uses `inspect(target, { depth: -1 })` (`lib/events.js:604`) giving `[EventEmitter]`. Test expects `2 null listeners added to [EventEmitter]. MaxListeners is 1.` (test:18). `warning.name`/`emitter`/`count`/`type` are all correct — message text only. Probe-verified. Same root cause as the two below. |
| test-event-emitter-max-listeners-warning-for-symbol.js | 0 | 1 | FLIPPABLE (events) — same as above; expects `2 Symbol(symbol) listeners added to [EventEmitter]. MaxListeners is 1.` (test:20). |
| test-event-emitter-max-listeners-warning.js | 0 | 1 | FLIPPABLE (events) — same as above; expects `2 event-type listeners added to [FakeInput]. MaxListeners is 1.` (test:25). Native probe confirms `[FakeInput]`; shim probe gives `{ _events: { event-type: [...] }, _eventsCount: 1, _maxListeners: 1 }`. Fix: `warnMaxListenersExceeded` (`src/events.js:790`) must format target as `[ClassName]` (depth −1 inspect). |
| test-event-emitter-max-listeners.js | 0 | 0 | PASS already |
| test-event-emitter-method-names.js | 0 | 0 | PASS already |
| test-event-emitter-modify-in-emit.js | 0 | 0 | PASS already |
| test-event-emitter-no-error-provided-to-error-event.js | 0 | 1 | FLIPPABLE (events) — domain routing missing from shim `emit`. `domain.add(e)` does set `e.domain` (probe-verified), but Node's domain support lives in a patch to native `EventEmitter.prototype.emit` (`lib/domain.js:477-478`, `EventEmitter.init` at :462) which never reaches the shim class, so `e.emit('error')` with no listener throws `ERR_UNHANDLED_ERROR` (unhandled, `src/events.js:1112`) instead of routing to the domain's `error` handler. Shim `src/events.js` has no `domain` handling at all. Fix: shim `emit` must implement the domain-aware `error` path (falsy/no arg → `new ERR_UNHANDLED_ERROR()`; non-Error args passed through as-is per test:42-53). |
| test-event-emitter-num-args.js | 0 | 0 | PASS already |
| test-event-emitter-once.js | 0 | 0 | PASS already |
| test-event-emitter-prepend.js | 0 | 0 | PASS already |
| test-event-emitter-remove-all-listeners.js | 0 | 1 | FLIPPABLE (events) — `removeAllListeners()` with no args iterates `Object.keys(events)` (`src/events.js:924`), which drops symbol keys, so a symbol-keyed listener is never removed and its `removeListener` never fires (`mustCall` expected 1, actual 0, test:118). Node uses `ReflectOwnKeys(events)` (`lib/events.js:768`). One-word fix. |
| test-event-emitter-remove-listeners.js | 0 | 0 | PASS already |
| test-event-emitter-set-max-listeners-side-effects.js | 0 | 0 | PASS already |
| test-event-emitter-special-event-names.js | 0 | 0 | PASS already |
| test-event-emitter-subclass.js | 0 | 1 | FLIPPABLE (events) — shim defines `class EventEmitter` (`src/events.js:614`); Node defines `function EventEmitter(opts)` (`lib/events.js:209`), callable without `new`. Test does `EventEmitter.call(this)` inside function constructors (test:34, `MyEE2`), which throws `TypeError: Class constructor EventEmitter cannot be invoked without 'new'` under the shim. Fix: convert the shim to a function-style constructor (or an equivalent callable form). |
| test-event-emitter-symbols.js | 0 | 0 | PASS already |
| test-event-target.js | 0 | 0 | PASS already |
| test-eventsource-disabled.js | 0 | 0 | NOT-A-GAP — never touches the shim; asserts only the host global `typeof EventSource === 'undefined'` (no `require('events')`). |
| test-eventsource.js | 0 | 0 | NOT-A-GAP — never touches the shim; asserts only the host global `typeof EventSource === 'function'` under `--experimental-eventsource` (no `require('events')`). No EventSource implementation exists in the shim, and neither test exercises one. |

## Evidence

- Oracle log: `/tmp/w4-events-oracle.txt` — all 30 rc=0
- Baseline log: `/tmp/w4-events-baseline.txt` — 22 rc=0, 8 rc=1
- Failure detail (first isolated re-run): `/tmp/w4-events-fail1.txt`
- Probes (created as `zz-*.js` under `parity/node-test/parallel/`, deleted after use): warning-message probe showed shim message `{ _events: ... }` vs native `[FakeInput]`; domain probe showed `e.domain` set but `emit('error')` throwing `ERR_UNHANDLED_ERROR` uncaught

## Blockers

None. No code changed, no commits, no pushes, no PRs. No fresh web research used (Node source pack + repo tree + local probes only).
