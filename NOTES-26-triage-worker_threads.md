# NOTES-26-triage-worker_threads.md

Node 26.13.1 re-target triage — `worker_threads`. DOCS ONLY, no `src/` change.
Worktree: `~/workspace/worktrees/node26-triage-misc-small`, base `3c091022`.
Node 26 binary verified before probing: `~/workspace/local/node-26/bin/node --version` = `v26.13.1`.
Host Node (harness runtime): `v24.22.1`. Node 26 source: `~/workspace/local/node-26-src/`.

## Counts

- Baseline (28-module): worker_threads 146 total, 137 pass, 8 fail, 1 timeout.
- Oracle: 9 shim-gap, 0 fails-natively, 0 native-timeout.
- **After this triage: gap stays 9.** The NOTES-drift-detector correction
  (heap-profile = load artifact, true gap 8 / program 566) is **REFUTED**
  below — the 26 file aborts in isolation, under the harness AND natively
  on the host. True program shim-gap stays **567**.
- v24 ceiling: 141/144, remaining 3 all NO-FIX (debug,
  message-port-inspect-during-init-hook, process-env).

## Gap list (all 9, harnessExit / nativeExit from gaps-worker_threads.json)

| test | harness | native | vendored in v24? |
| --- | --- | --- | --- |
| test-worker-cpu-profile.js | 1 | 0 | yes |
| test-worker-debug.js | 124 | 0 | yes |
| test-worker-heap-profile.js | 129 | 0 | yes |
| test-worker-heap-statistics.js | 1 | 0 | yes |
| test-worker-message-port-inspect-during-init-hook.js | 1 | 0 | yes |
| test-worker-message-port-transfer-filehandle-fd0.js | 1 | 0 | **no — NEW in 26** |
| test-worker-messageerror-listener-cleanup.js | 1 | 0 | **no — NEW in 26** |
| test-worker-process-env.js | 1 | 0 | yes |
| test-worker-spec-differences.js | 9 | 0 | **no — NEW in 26** |

Isolated re-runs (staged Node 26 `test/parallel + common + fixtures`,
`timeout 30 node --import <abs preload> parity/node-test/parallel/<test>`,
`PARITY_TARGET=worker_threads`, per `parity/drift/run-baseline.mjs`):
all 9 exits reproduced exactly (cpu 1, debug 124, heap-profile **134 ×4**
across two stagings, heap-stats 1, inspect 1, fd0 1, messageerror 1,
process-env 1, spec-differences 9). Flag variants: spec-differences WITH
`--experimental-web-worker` still 9 (host rejects the flag).
Probe logs: `~/workspace/node26-misc-probes/`.

## New-in-26 vs pre-existing

- **NEW in 26 (3):** transfer-filehandle-fd0, messageerror-listener-cleanup,
  spec-differences. None is in the vendored v24 tree.
- **Pre-existing files (6):** cpu-profile, debug, heap-profile,
  heap-statistics, message-port-inspect, process-env. All six differ from
  their vendored v24 copies (mostly prettier reformatting), but four carry
  NEW 26 assertions layered on the old file:
  - cpu-profile: new `{ sampleInterval: 0.5, maxBufferSize: 8 }` block and
    `maxBufferSize: 0` → `ERR_OUT_OF_RANGE` exit-handler assertion.
  - heap-profile: new `startHeapProfile()` options-validation throws
    (`'bad'` → `ERR_INVALID_ARG_TYPE`, `sampleInterval`/`stackDepth`/
    `forceGC` type+range checks).
  - heap-statistics: new expected key `` `total_allocated_bytes` ``.
  - message-port-inspect: expected inspect string changed from
    `'MessagePort [EventTarget] { active: true, refed: false }'` to
    `'MessagePort { active: true, refed: false }'`.
  - debug, process-env: formatting-only diffs (normalized diff shows no
    behavioural change).

## Families

### F1 — V8 profiler / heap internals (3 tests) — NO-FIX

- test-worker-cpu-profile.js, test-worker-heap-profile.js,
  test-worker-heap-statistics.js.
- Classification: real shim work in the abstract, NO-FIX in a browser.
- Evidence per test:
  - cpu-profile: the new options block passes on host; the only failure
    is the exit handler — `startCpuProfile({ maxBufferSize: 0 })` on an
    exited worker. Probe: Node 26 → `ERR_OUT_OF_RANGE` (options validated
    before running-state); host v24.22.1 → `ERR_WORKER_NOT_RUNNING`
    (running-state checked first). The API itself needs a V8 CPU
    profiler; the validation-order nuance rides on it.
  - heap-profile: see Baseline correction below. New 26 validation
    throws do not exist on host v24.22.1 (`startHeapProfile('bad')` →
    NO THROW on host, `ERR_INVALID_ARG_TYPE` on Node 26 — probe), then
    the process aborts with heap corruption.
  - heap-statistics: Node 26 `getHeapStatistics()` has
    `total_allocated_bytes` (probe: present); host has 14 keys, without
    it. Browser `Worker.getHeapStatistics()` returns `{}` today
    (`src/worker_threads.js:884-886`); no honest value exists in a
    browser (no V8 heap introspection — rule 7, no silent fakes).
- No lane. The harness `Worker` is native host (`src/worker_threads.js:899`
  `const Worker = nativeWt ? nativeWt.Worker : BrowserWorker`), so even the
  validation-order parts are host behaviour, not shim behaviour.

### F2 — Inspector under preload (1 test) — NO-FIX, pre-existing

- test-worker-debug.js (harness 124).
- v24 NO-FIX stands: inspector `Session` never drives worker debugging
  under the preload. Refined mechanism in 26: the session attaches, but
  `waitForBreakAfterCommand('Runtime.runIfWaitingForDebugger', __filename, 1)`
  sees `callFrame.location.lineNumber` **553, expected 1**
  (`test-worker-debug.js:109`, harness stderr) — the worker is not held
  on start — then the session never disconnects cleanly and the run times
  out (124). No shim change can fix the preload/inspector interaction.

### F3 — Host-version skew (4 tests) — NO-FIX

These fail because the harness host is v24.22.1, not because of the shim.
No `src/` change can flip them under this host.

- test-worker-message-port-inspect-during-init-hook.js — the v24 NO-FIX
  reason is **superseded**. The init hook DOES fire with a MessagePort
  (failure is `strictEqual` at `:13`, actual is the port's inspect
  string). The only mismatch is the string: host prints
  `MessagePort [EventTarget] { active: true, refed: false }`, Node 26
  prints `MessagePort { active: true, refed: false }` (probes on both
  binaries). `util` is native host under `PARITY_TARGET=worker_threads`,
  so no worker_threads shim change can affect it.
- test-worker-message-port-transfer-filehandle-fd0.js — the failing
  process is a grandchild running **plain host node** (`spawnSync(
  process.execPath, [__filename, 'child'])`, no preload, no shim):
  `fs.fstatSync(0)` does not throw `EBADF` after the discarded transfer
  ("Missing expected exception", `:37`). Native Node 26 exit 0, native
  host exit 1. Host fd-close-on-discard behaviour differs from 26.
- test-worker-process-env.js — v24 NO-FIX stands, mechanism refined.
  Same symptom as v24: `Unexpected global(s) found: setImmediate,
  setInterval, setTimeout, queueMicrotask` (common exit check). Native
  host exit 0, native Node 26 exit 0 — the leak is harness-introduced:
  probe proves `process.execArgv` includes `--import <preload>`, so
  workers spawned by the test inherit the preload. Exact replacer still
  unidentified (v24 wording).
- test-worker-spec-differences.js — `common` re-execs the test with its
  `// Flags: --experimental-web-worker`; host rejects the flag
  (`/usr/bin/node: bad option: --experimental-web-worker`, exit 9).
  Probe: Node 26 with the flag → `typeof Worker === 'function'`; host
  → bad option. The flag does not exist on the host at all. (Separately,
  the shim exposes no global web `Worker`; that is a runtime feature,
  not a lane — no test can run on this host either way.)

### F4 — Worker exit listener cleanup (1 test) — LANE, flip 1

- test-worker-messageerror-listener-cleanup.js.
- Node 26 removes `message` AND `messageerror` listeners on Worker
  exit; host v24.22.1 removes `message` only. Probes: host → `message 0,
  messageerror 1`; Node 26 → `0, 0`. Fails at `:15`, the `messageerror`
  assertion (`1 !== 0`). (Note: the first assertion at `:14` passes on
  host — the earlier "message 1" reading was a line miscount; `:15` is
  the `messageerror` line.)
- The browser path lacks it too: `BrowserWorker.#finish` emits `'exit'`
  without removing listeners (`src/worker_threads.js:824-831`).
- **Lane W-26-1 — Worker exit listener cleanup. Estimated flip: 1**
  (messageerror-listener-cleanup). Work: remove `message` +
  `messageerror` listeners before user `'exit'` handlers run, in
  `BrowserWorker.#finish` AND for the native path — under the harness
  `Worker` is native host (`src/worker_threads.js:899`), so the lane
  must wrap/subclass the native `Worker` (constructor-registered
  `'exit'` cleanup runs before user handlers added after construction).
  **Needs a parent call on wrapping the native Worker**; if wrapping is
  declined, this test becomes NO-FIX (host-skew) and the lane count is 0.

## Lane candidates (conservative)

| lane | tests flipped | estimate |
| --- | --- | --- |
| W-26-1 Worker exit listener cleanup | test-worker-messageerror-listener-cleanup.js | **1** (conditional on native-Wrap approval) |

No other worker_threads test is flippable by a shim lane under this host.

## NO-FIX list (8, 9 if W-26-1 is declined)

1. test-worker-cpu-profile.js — needs a V8 CPU profiler; validation-order
   difference is host-native behaviour.
2. test-worker-debug.js — inspector Session under preload cannot drive
   worker debugging (break at line 553, expected 1; hangs to 124).
3. test-worker-heap-profile.js — needs Node 26 native Worker validation
   + V8 heap profiler; host aborts (134) on the 26 test (see correction).
4. test-worker-heap-statistics.js — needs V8 heap internals
   (`total_allocated_bytes`); browser has no honest value.
5. test-worker-message-port-inspect-during-init-hook.js — host-skew
   `util.inspect` string (`[EventTarget]` dropped in 26); `util` is
   native host under this target.
6. test-worker-message-port-transfer-filehandle-fd0.js — fails in a
   grandchild running plain host node; no shim code runs there.
7. test-worker-process-env.js — harness-introduced global leak via
   `--import` inheritance through `execArgv` (v24 NO-FIX).
8. test-worker-spec-differences.js — host has no
   `--experimental-web-worker` flag at all (exit 9, bad option).
9. (conditional) test-worker-messageerror-listener-cleanup.js — if the
   native-Worker wrap is declined.

## Baseline corrections

- **Heap-profile correction REFUTED (the one correction in the task
  brief).** `NOTES-drift-detector.md` claims the test "PASSES the harness
  in isolation (exit 0)" and the true program shim-gap is 566. My probes
  do not reproduce that for the Node 26 file:
  - Harness, staged Node 26 files, 30 s cap, run-baseline invocation:
    exit **134 (SIGABRT) ×4** across two independent stagings
    ("double free or corruption (out)").
  - Native host v24.22.1, no preload: exit **134**
    ("munmap_chunk(): invalid pointer").
  - Native Node 26.13.1: exit **0**.
  - Vendored v24 file under harness: exit **0**.
  - Conclusion: the NOTES 0 was the **vendored v24 file** (which lacks
    the new validation block), not the Node 26 file. The Node 26 file is
    a genuine non-pass on this host: its new validation assertions fail
    on host native (`startHeapProfile('bad')` → NO THROW on host,
    `ERR_INVALID_ARG_TYPE` on Node 26), and the host then aborts with
    heap corruption. **worker_threads gap stays 9; program shim-gap
    stays 567, not 566.** (Note: `/tmp` was wiped by a runtime restart
    between the two stagings, losing the first run's logs; the second
    staging re-ran from scratch and reproduced 134 ×2. Logs kept in
    `~/workspace/node26-misc-probes/` this time.)
- **All other 8 exits reproduced exactly** in isolated re-runs
  (cpu 1, debug 124, heap-stats 1, inspect 1, fd0 1, messageerror 1,
  process-env 1, spec-differences 9), and the spec-differences flag
  variant also gives 9 — the baseline's 9 is not a missing-flag artifact
  of the runner (the baseline correctly runs without `// Flags:`; the
  flag itself is absent on the host).
- **Messageerror line correction:** the failing assertion is at `:15`,
  the `messageerror` line — not the `message` line. Host removes
  `message` listeners on exit (0) but not `messageerror` (1); Node 26
  removes both (0/0).
- **Message-port-inspect v24 reason superseded:** the ESM-loader-entry
  mechanism did not reproduce in 26 — the hook fires with a MessagePort
  and only the inspect string differs.
