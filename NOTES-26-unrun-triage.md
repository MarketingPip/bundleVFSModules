# Node 26 Wave 4, phase 1 — triage of the 65 unrun in-scope tests

**Base:** main `6e4e6370` (program closed at 2,323/2,748, 84.5%).
**Method:** oracle first (native Node 26.13.1, no preload), baseline second (host Node
v24.22.1, `--import <worktree>/parity/preload.mjs`, `PARITY_TARGET=<mod>`), isolated
staging with Node 26 `test/common/`, `// Flags:` headers honored, non-passes
re-run isolated 2–3× before classification. No run-baseline (does not honor flags).
No fresh web research; Node source pack + repo tree + local probes only.
**Coordinator verification:** re-ran a sample of each worker's passes and flips in the
worker's own worktree — all reproduced (worker 1/1, ALS 3/3, module 1/1, http2 2/2
fail, events 2 flips fail + 1 pass + 1 not-a-gap pass). Totals below are computed
from verified runs only, never from triage expectations.

## Totals (of 65)

| Outcome | Count | Groups |
|---|---|---|
| Pass under harness | 39 | events 22, async_hooks 12, module 4, worker_threads 1 |
| — of which never touch the shim | 6 | eventsource 2, module 4 |
| — true shim passes | 33 | events 20, async_hooks 12, worker_threads 1 |
| FLIPPABLE (conservative) | 8 | all events |
| NO-FIX | 18 | all http2 diagnostics-channel |
| NOT-A-GAP | 6 | eventsource 2, module 4 |
| **Total** | **65** | 39 + 8 + 18 = 65 ✓ |

## Revised program arithmetic

- Denominator: 2,748 + 65 = **2,813**.
- Passes folded in: 2,323 + 39 = **2,362/2,813 (84.0%)**.
- Ceiling if all 8 flippable flips land: 2,362 + 8 = **2,370/2,813 (84.3%)**.
- The 6 not-a-gap tests pass under the harness, so they count as passes in the
  program total (per triage precedent they stay in the denominator); they measure
  nothing about the shim.

## Per-module revised counts (folded in)

| Module | Before | Folded in | Now | Ceiling |
|---|---|---|---|---|
| events | 9/9 | +22 pass, +8 flippable (of 30) | 31/39 | 39/39 (100%) |
| http2 | 94/289 | +0 (of 18) | 94/307 | 94/307 (30.6%) |
| async_hooks | 29/36 | +12 (of 12) | 41/48 | 41/48 (85.4%) |
| module | 33/37 | +4 (of 4) | 37/41 | 37/41 (90.2%) |
| worker_threads | 138/146 | +1 (of 1) | 139/147 | 139/147 (94.6%) |

## Events (30) — 22 pass, 8 flippable, 2 not-a-gap

Oracle: all 30 pass natively. Baseline: 22 pass, 8 fail (all 8 reproduced 3/3).
Flags honored: `--no-warnings` (3 warning tests), `--experimental-eventsource`
(`test-eventsource.js`). No tracked-v24 name collisions.

### PASS already (20)

test-event-emitter-add-listeners, -check-listener-leaks, -emit-context,
-error-monitor, -get-max-listeners, -invalid-listener, -listener-count,
-listeners-side-effects, -listeners, -max-listeners, -method-names,
-modify-in-emit, -num-args, -once, -prepend, -remove-listeners,
-set-max-listeners-side-effects, -special-event-names, -subclass (no — see
flippable), -symbols, test-event-target. (Full list in w4-events-triage.md.)

### FLIPPABLE (8) — all in `src/events.js`, one lane family

| File | Root cause (shim vs Node 26 source) |
|---|---|
| test-event-capture-rejections | `addCatch` getter-throw branch passes the thenable `{}` as the error instead of the caught `Error: kaboom`. `src/events.js:1121-1126` vs `lib/events.js:375-376` (`that.emit('error', err)`) |
| test-event-emitter-errors | Shim mini-`inspect` (`src/events.js:124`) ignores `util.inspect.custom` and never throws, so the `getUnhandledErrorException` fallback (`src/events.js:1104-1109`, Node `lib/events.js:469-473`) never fires. Expected `Unhandled error. ([object Object])`, got `Unhandled error. ({ message: 'Error!' })` (test:27) |
| test-event-emitter-max-listeners-warning-for-null | Warning message renders full object dump; Node `inspect(target, {depth:-1})` gives `[EventEmitter]` (`lib/events.js:604`). Expects `2 null listeners added to [EventEmitter]...` (test:18). Name/emitter/count/type all correct — message text only |
| test-event-emitter-max-listeners-warning-for-symbol | Same root cause. Expects `2 Symbol(symbol) listeners added to [EventEmitter]...` (test:20) |
| test-event-emitter-max-listeners-warning | Same root cause. Expects `2 event-type listeners added to [FakeInput]...` (test:25). Probe-verified: native `[FakeInput]` vs shim `{ _events: {...}, ... }` |
| test-event-emitter-no-error-provided-to-error-event | No domain routing in shim `emit`. `domain.add(e)` sets `e.domain` (probe-verified), but Node's domain patch targets native `EventEmitter.prototype.emit` (`lib/domain.js:477-478`) and never reaches the shim class, so `emit('error')` throws `ERR_UNHANDLED_ERROR` uncaught (`src/events.js:1112`). `src/events.js` has no `domain` handling at all. **Riskiest of the 8** — needs domain integration with the shim class |
| test-event-emitter-remove-all-listeners | `removeAllListeners()` with no args iterates `Object.keys(events)` (`src/events.js:924`), dropping symbol keys; symbol listener never removed, `removeListener` never fires (mustCall expected 1, actual 0, test:118). Node uses `ReflectOwnKeys(events)` (`lib/events.js:768`) |
| test-event-emitter-subclass | Shim is `class EventEmitter` (`src/events.js:614`); Node is `function EventEmitter(opts)` (`lib/events.js:209`), callable without `new`. `EventEmitter.call(this)` (test:34) throws `TypeError: Class constructor EventEmitter cannot be invoked without 'new'` |

### NOT-A-GAP (2)

- test-eventsource-disabled — never touches the shim; asserts only host global
  `typeof EventSource === 'undefined'`.
- test-eventsource.js — never touches the shim; asserts only host global
  `typeof EventSource === 'function'` under `--experimental-eventsource`. No
  EventSource implementation exists in the shim and neither test exercises one.

Evidence: `~/workspace/worktrees/w4-events/w4-events-triage.md`; logs
`/tmp/w4-events-oracle.txt`, `/tmp/w4-events-baseline.txt`, `/tmp/w4-events-fail1.txt`.

## http2 diagnostics-channel (18) — 0 pass, 0 flippable, 18 NO-FIX

Oracle: 18/18 pass natively. Baseline: 18/18 fail (rc=1, twice, deterministic).
No `// Flags:` on any file.

Shared root-cause mechanism (source-grounded, all 18):
- `src/http2.js` has **zero** `diagnostics_channel` references (grep-verified by
  coordinator) and publishes none of the 12 channels these tests subscribe to.
- Node 26 publishes them from `lib/internal/http2/core.js:197-208` at 15 publish
  sites, all inside the nghttp2 frame-processing lifecycle.
- `src/http2.js:1611`: single `class Http2Stream extends EventEmitter` — not a
  Duplex; no `ClientHttp2Stream`/`ServerHttp2Stream` classes. Every subscriber
  asserts `stream instanceof Duplex` + constructor name — both fail even if
  publish calls were added.
- `src/http2.js:1836-1856` `_destroy` emits the raw error with no code mapping —
  peer never gets `ERR_HTTP2_STREAM_ERROR` (proven by the two server error tests).
  Close-error tests also assert `rstCode === NGHTTP2_CANCEL` /
  `NGHTTP2_INTERNAL_ERROR`, which needs a real RST_STREAM frame.

Why not flippable: every file has ≥2 independent engine-level blockers. Adding
publish calls alone still fails the constructor-name, `instanceof Duplex`, header
deep-equal, per-chunk `writev`/`data`/`encoding`, `flags`, and error-code
assertions. Satisfying them = re-implementing the nghttp2 stream lifecycle's
observable behavior = the standing NO-FIX bucket (no real HTTP/2 engine).

Per-file table (all NO-FIX, mechanism = channel never published unless noted):
client-stream-body-multiple-buffers-and-strings, client-stream-body-multiple-buffers,
client-stream-body-no-chunks, client-stream-body-single-buffer,
client-stream-body-single-string (bodyChunkSent/bodySent never fired);
client-stream-close-error, client-stream-close, client-stream-created,
client-stream-error, client-stream-finish, client-stream-start (close/created/
error/finish/start never fired); server-stream-close-error, server-stream-error
(crash first: `err.code` undefined, expected `ERR_HTTP2_STREAM_ERROR`);
server-stream-close, server-stream-created, server-stream-finish,
server-stream-start (subscribers never fired); server-stream-created-start-timing
(countdown reached 0 but channel map empty: `0 !== 2`).

Evidence: `~/workspace/worktrees/w4-http2/w4-http2-triage.md`; logs
`/tmp/w4-http2-base/` (per-file), `/tmp/w4-http2-oracle.txt`,
`/tmp/w4-http2-baseline.txt`.

## async_hooks — AsyncLocalStorage (12) — 12 pass, 0 gaps

Oracle: 12/12 pass natively. Baseline: 12/12 pass (each run twice, sequential,
60 s timeout). Flags honored: `--expose-gc` on `http-parser-leak` and
`weak-asyncwrap-leak` only.

Mechanism: `src/async_hooks.js:540-541` — `AsyncLocalStorage = native !==
undefined ? native.AsyncLocalStorage : BrowserALS`; lines 542-555 delegate
`AsyncResource`, `createHook`, `executionAsyncId`, `triggerAsyncId` to native
under a Node host by design. Probe-verified: `AsyncLocalStorage.toString()`
identical with/without preload (native class); `executionAsyncId()` differed
(0 with preload vs 1 native) — the known preload async-resource id shift. None
of these 12 tests assert absolute async ids, so the shift is harmless here.

Scope limit (not a gap): these runs exercise the shim's native-delegation path
on a Node host; the browser fallback (`BrowserALS`/`StubAsyncLocalStorage`,
`src/async_hooks.js:322`) is not covered by this harness invocation.

Evidence: `~/workspace/worktrees/w4-als/w4-als-triage.md`.

## module diagnostics-channel (4) — 4 pass under harness, 0 shim evidence, NOT-A-GAP

Oracle: 4/4 pass natively. Baseline: 4/4 pass under the harness — but the passes
are pure-native executions, not shim passes. None of the 4 files (nor Node 26
`test/common/index.js`) requires/imports `module`; they subscribe to native
`diagnostics_channel` while the native loader publishes (`lib/internal/modules/
cjs/loader.js:230` `tracingChannel('module.require')`,
`lib/internal/modules/esm/loader.js:70` `tracingChannel('module.import')`).
`src/module.js` has zero `tracingChannel` references. Probe-verified: under the
same preload + target, the `module.require` event for `require('http')` fired
with `src/module.js` never loaded; the shim entered the cache only when the
probe itself called `require('module')`.

No harness target can make these tests exercise the shim as publisher: even
under `PARITY_TARGET=diagnostics_channel` the native loader would publish to
the native `dc` registry while the test subscribes to the shim registry. These
are loader-integration tests, outside the parity gap count — but they stay in
the program denominator as passes (they pass under the harness).

Evidence: `~/workspace/worktrees/w4-module/w4-module-triage.md`.

## worker_threads diagnostics-channel (1) — 1 pass already

test-diagnostics-channel-worker-threads.js: oracle PASS, baseline PASS (isolated
+ re-run, both exit 0). No `// Flags:` header. Structural pass: Node source
pack `lib/internal/worker.js:104-105,378-379` — native `Worker` publishes
`{ worker }` to `dc.channel('worker_threads')` when it has subscribers; the
shim's `Worker` subclasses the native `Worker`, so `super()` runs the native
constructor and the publish fires. `diagnostics_channel` is NOT redirected
(`PARITY_TARGET=worker_threads` only), so the test subscribes on the native host
dc module — the same channel instance the native Worker publishes to.

Evidence: `~/workspace/worktrees/w4-worker/w4-worker-triage.md`.

## Recommendation

- **One events lane (E-26-W4) for the 8 flippable tests** — all in `src/events.js`,
  ~6 root causes; the 3 max-listeners-warning tests share one fix. Landing all 8
  takes events to **39/39 (100%)**, the program to **2,370/2,813 (84.3%)**. Flag
  the domain test as the riskiest flip (needs domain integration with the shim
  class); the subclass test needs a class→function conversion.
- **No lane for http2** (18 NO-FIX, engine), **async_hooks, module, worker_threads**
  (nothing to fix).
- Fold the 65 into the program record (denominator 2,813; passes 2,362) via a
  docs sync once the events lane lands — or now, if the parent prefers the
  measurement banked before the lane.

## Ship — events lane (Wave 4)

- PR: #537
- Merge SHA: `e3774e64b14ad8a746b5094cba652418f09e8a9f` (squash-merge of PR #537)
- Events: 9/9 banked + 22 measured passes + 8 flips → **39/39 (100%)**.
- Program after folding in the 65: **2,370/2,813 (84.3%)**.
