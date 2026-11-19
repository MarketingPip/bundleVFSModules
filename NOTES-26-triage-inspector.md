# NOTES — Node 26 triage — inspector

Base: `3c091022` (drift detector + baseline + oracle, #505). Worktree:
`~/workspace/worktrees/node26-triage-inspector` (detached HEAD `3c091022`).
Host Node for harness runs: v24.22.1 (`node --version`). Native oracle
binary: `~/workspace/local/node-26/bin/node`, verified `--version` =
v26.13.1 before any probe. Node 26 source: `~/workspace/local/node-26-src/`.
v24 oracle source pack:
`~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node-src/`
(v24.20.0).

## Counts (banked, parent-verified — not recomputed)

| | |
|---|---|
| Node 26 baseline, inspector | 41 pass / 29 fail / 6 timeout, 76 total (`parity/drift/node26-baseline-inspector.csv`: 41× `,0`, 29× `,1`, 6× `,124`) |
| Oracle classes on the 35 non-passes | **30 shim-gap**, 2 fails-natively, 3 native-timeout (`parity/drift/node26-oracle.json`, `gaps-inspector.json`) |
| v24 post-wave (I-F1 + I-V1, `NOTES-inspector-validation-v1.md`, `NOTES-inspector-fixtures-f1.md`) | 38/75 pass, 37 non-pass, all 37 adjudicated NO-FIX |

Reconciliation v24 → v26: 38/75 → 41/76 = **+3 net**. Composition, all
probe-proven below:

- **+4** — v24 family F (`break-when-eval`, `esm`, `exception`,
  `worker-target`): failed [1,1] on v24 (pause/break notification never
  delivered even natively — environmental). On Node 26.13.1 they pass
  natively AND under the shim. Isolated, exact baseline invocation
  (`timeout 30 node --import <preload> parity/node-test/parallel/<t>`,
  `PARITY_TARGET=inspector`, Node 26 test tree staged in a throwaway
  worktree): shim exit 0 ×5 (incl. `test-inspector.js`); pure native
  Node 26.13.1 (no preload): exit 0 ×5.
- **−1** — `test-inspector-dom-storage.js`: passed on v24, now
  fails-natively in 26 (see § "Not shim gaps").
- **+1 denominator** — `test-inspector-dom-storage-malformed.js`: new
  test in Node 26, fails-natively.
- 38 + 4 − 1 = 41; 75 + 1 = 76. ✓

The v24 37 NO-FIX set is fully accounted for: 30 (this module's gaps)
+ 4 (family F, now passing) + 3 (still native-timeout: `ip-detection`,
`network-fetch`, `network-http`). **All 30 gaps are pre-existing; 0 are
new in Node 26.**

## What changed in Node 26 (test files, lib, exports)

- `lib/inspector.js` v24.20.0 vs v26.13.1: `diff -q` → **identical**
  (exit 0). No oracle change behind the shim.
- Export diff (`parity/drift/node26-export-diff.md:35`): inspector
  `0 | 0 | 0 | 0 | 0` — **no export-surface change**.
- Changelog cross-check
  (`~/workspace/research_notes/node-24-to-26-drift-20261119-1722/cross-check-changelog-2026-11-19.md:41`):
  only row is 25.0.0 `--allow-inspector` added to the permission model —
  **permission-model surface only**, nothing for the JS shim.
- Test files: all 37 compared v24-vendored vs Node 26 source with
  esbuild-minify normalization (strips the vendored prettier pass):
  **34 SAME** (formatting only), **3 real diffs**:
  - `test-inspector-tracing-domain.js` — Node 26 adds
    `common.skipIfPerfettoEnabled()` + comment. Does not trigger here:
    `process.config.variables.node_use_perfetto` is `undefined` on the
    26.13.1 binary. Test still fails under the shim for the same
    protocol-data reason.
  - `test-inspector-dom-storage.js` — drops `--experimental-webstorage`,
    adds a second spawn with fixture
    `test-inspector-dom-storage-unavailable.mjs`. See § "Not shim gaps".
  - `test-inspector-network-fetch.js` — undici dispatcher gains
    `noProxy: '*'`, servers bind `127.0.0.1` explicitly. Still
    native-timeout. Robustness fix only.
- New test files in Node 26 (`comm` of the `test-inspector*` listings):
  exactly **one** inspector test, `test-inspector-dom-storage-malformed.js`
  (the other 5 new files are `test-coverage-*`, `test-permission-*`,
  `test-process-timeout-inspector.js` — other modules). None removed.
  All 76 `test-inspector*` files in Node 26 source were run by the
  baseline (76 rows; no unrun file).

## Families — the 30 gaps

Classification per family: all four are **real shim work in the sense
that only a live DevTools protocol / V8 inspector backend would flip
them** — i.e. NO-FIX under the current design, not fixture or validation
gaps. (The v24 validation lane I-V1 and fixture lane I-F1 are both
already shipped in this tree: `src/inspector.js` at this base carries
the I-V1 throws; the I-F1 fixtures are vendored.)

### A. Protocol events/results never arrive — 20 — NO-FIX inherent

The shim's `Session.post()` resolves `{}` and never emits
`inspectorNotification`; there is no DevTools protocol to deliver
`Debugger.paused`, `Runtime.consoleAPICalled`,
`Debugger.scriptParsed`, `HeapProfiler` results, `NodeTracing`
categories, or `Runtime.evaluate` values. Same 20 as v24 family A
(`triage-inspector-2026-11-18.md` §A), test files esbuild-SAME.

| Test | Isolated first failure, Node 26 test + shim (this triage) |
|---|---|
| `test-inspector-async-call-stack.js` | `AssertionError: Missing expected rejection` — shim resolves `{}` where the protocol must reject `ERR_INSPECTOR_COMMAND` |
| `test-inspector-async-context-brk.js` | v24 signature (notification never arrives); file SAME |
| `test-inspector-async-hook-after-done.js` | `AssertionError` (throw at test) — pause notification never arrives |
| `test-inspector-bindings.js` | Deliberate `Error: We expect this` in `post("Console.enable")` callback propagates uncaught (v24 note: oracle turns it into a warning; second half needs a real session) |
| `test-inspector-console-top-frame.js` | `TypeError: Cannot read properties of undefined (reading 'url')` — `Runtime.evaluate` result is `{}` |
| `test-inspector-contexts.js` | v24 signature (`executionContextCreated` never arrives); file SAME |
| `test-inspector-exit-worker-in-wait-for-connection.js` | exit 1 (30 s cap; 124 at the 10 s cap — slow, not a hang; see § Baseline corrections) |
| `test-inspector-has-idle.js` | v24 signature (HeapProfiler `nodes` undefined); file SAME |
| `test-inspector-heap-allocation-tracker.js` | `AssertionError` — HeapProfiler result is `{}` |
| `test-inspector-heapdump.js` | `SyntaxError: Unexpected end of JSON input` — heap snapshot result empty |
| `test-inspector-multisession-js.js` | `AssertionError: The expression evaluated to a falsy value` — `session1Paused`/`session2Paused` falsy |
| `test-inspector-network-arbitrary-data.js` | exit 1 (30 s cap; 124 at the 10 s cap — slow, not a hang); waits for `Network.*` events the shim session cannot observe |
| `test-inspector-network-data-received.js` | exit 1; `Wait for inspector event Network.* timed out` shape (v24) |
| `test-inspector-network-data-sent.js` | exit 1; same shape |
| `test-inspector-promises.js` | `AssertionError: Expected values to be strictly deep-equal` — protocol result `{}` vs expected |
| `test-inspector-resource-name-to-url.js` | `Mismatched noop function calls. Expected exactly 1, actual 0` — `Debugger.scriptParsed` never comes |
| `test-inspector-runtime-evaluate-with-timeout.js` | v24 signature; file SAME |
| `test-inspector-tracing-domain.js` | v24 signature (`Tracing` categories undefined); file SAME modulo the perfetto skip (does not trigger here) |
| `test-inspector-vm-global-accessors-getter-sideeffect.js` | v24 signature; file SAME |
| `test-inspector-vm-global-accessors-sideeffects.js` | v24 signature; file SAME |

### B. `url()` is undefined by design — 3 — NO-FIX inherent (repo rule 7)

| Test | Isolated first failure, Node 26 |
|---|---|
| `test-inspector-already-activated-cli.js` | v24 signature (`inspector.url()` undefined, `startsWith` on undefined); file SAME |
| `test-inspector-close-worker.js` | v24 signature; parent + worker both `require('inspector')` under the shim; file SAME |
| `test-inspector-open.js` | `TypeError [ERR_INVALID_ARG_TYPE]: The "url" argument must be of type string. Received undefined` — parent's `inspector.url()` is undefined, forked child is native |

Returning a fabricated `ws://` URL would be a silent fake (nothing
listens on it) — forbidden by AGENTS.md rule 7. `open()` still does not
throw `ERR_INSPECTOR_ALREADY_ACTIVATED` (deliberate, documented in
`src/inspector.js`).

### E-inherent. Network-inspection hangs — 3 — NO-FIX inherent

Child spawns with `--inspect=0 --experimental-network-inspection`;
parent shim Session waits for network protocol events that never arrive.
Native Node 26.13.1 passes (oracle `nativeExit: 0`; re-proven here for
`network-content-type`: native exit 0 from both the Node 26 source tree
and the staged worktree, flags `--inspect=0
--experimental-network-inspection`).

| Test | Harness exit |
|---|---|
| `test-inspector-network-content-type.js` | 124 (30 s cap, isolated re-run) |
| `test-inspector-network-http2.js` | 124 (baseline; v24 triage proved the same hang at a 150 s cap for the websocket sibling) |
| `test-inspector-network-websocket.js` | 124 (baseline) |

### S. Singles — protocol-adjacent, NO-FIX overall — 4

| Test | Why it cannot flip (Node 26 evidence) |
|---|---|
| `test-inspector-emit-protocol-event.js` | Isolated: `Mismatched <anonymous> function calls. Expected exactly 1, actual 0` — I-V1 already fixed its first assertion (`broadcastToFrontend` `validateObject` throw); the rest asserts a connected DevTools frontend receives emitted events. No delivery exists. |
| `test-inspector-connect-main-thread.js` | Isolated: `AssertionError: 0 !== 2` at `skipChildMain` (test:183) — I-V1 fixed its first assertion (`ERR_INSPECTOR_NOT_WORKER` throw); the rest needs real worker sessions + `Runtime.evaluate` results. Failure point moved forward by I-V1, verdict unchanged. |
| `test-inspector-overwrite-config.js` | Isolated: `AssertionError: log statement did not reach the inspector` — unchanged from v24 (fixture unmasked by I-F1; needs a real `Runtime.consoleAPICalled` event). |
| `test-inspector-strip-types.js` | **Baseline artifact, not a shim gap** (see § Baseline corrections). 4/5 subtests pass under the shim; the failing one is the spawned child running host Node v24.22.1 (`Node.js v24.22.1` in the log) throwing `SyntaxError: The requested module './test-module-export.ts' does not provide an export named 'foo'`. The test never touches the shim (parent drives the child over raw WebSocket via `NodeInstance`). Native Node 26.13.1: exit 0. |

## Lane candidates

**None.** Conservative estimated flips for every candidate: **0**.

- No fixture lane: the I-F1 fixtures are vendored; no gap test fails on
  a missing fixture (verified: all 30 first failures are protocol /
  `url()` / hang, not `MODULE_NOT_FOUND`). Do NOT vendor the
  `typescript/` tree for `strip-types` — v24 already proved it flips
  nothing, and the 26 failure is a host-version artifact anyway.
- No validation lane: I-V1 shipped; the two tests whose first assertions
  it fixed (`emit-protocol-event`, `connect-main-thread`) now fail
  further down on missing delivery. No further oracle throw is asserted
  by any gap test.
- No shim-code lane flips anything in families A, B, or E: each needs a
  live DevTools protocol / V8 inspector backend / heap-profiler data /
  a listening inspector socket — none exists in a browser sandbox.
- **Ceiling: 41/76 as-is.** The only upward move available is the
  `strip-types` reclassification below (a counting correction, not a
  code flip): true shim-gap would be 29, not 30.

## NO-FIX list (30) — one line each

1. `already-activated-cli` — `url()` undefined by design (rule 7).
2. `async-call-stack` — protocol must reject `ERR_INSPECTOR_COMMAND`; shim resolves `{}`.
3. `async-context-brk` — `Debugger.paused` never arrives.
4. `async-hook-after-done` — pause notification never arrives.
5. `bindings` — second half needs a real debug session.
6. `close-worker` — `url()` undefined by design (rule 7).
7. `connect-main-thread` — needs real worker sessions + `Runtime.evaluate`.
8. `console-top-frame` — `Runtime.evaluate` result is `{}`.
9. `contexts` — `executionContextCreated` never arrives.
10. `emit-protocol-event` — needs a connected DevTools frontend to receive events.
11. `exit-worker-in-wait-for-connection` — needs a real wait-for-connection session.
12. `has-idle` — HeapProfiler result is `{}`.
13. `heap-allocation-tracker` — HeapProfiler result is `{}`.
14. `heapdump` — heap snapshot result is empty.
15. `multisession-js` — two live sessions never receive `Debugger.paused`.
16. `network-arbitrary-data` — child emits real network events the shim session cannot observe.
17. `network-content-type` — hangs waiting for `Network.*` events (124).
18. `network-data-received` — `Network.dataReceived` never arrives.
19. `network-data-sent` — `Network.dataSent` never arrives.
20. `network-http2` — hangs waiting for `Network.*` events (124).
21. `network-websocket` — hangs waiting for `Network.*` events (124).
22. `open` — `url()` undefined by design; child ping needs a real listening socket.
23. `overwrite-config` — `Runtime.consoleAPICalled` never arrives.
24. `promises` — protocol result `{}` vs expected values.
25. `resource-name-to-url` — `Debugger.scriptParsed` never arrives.
26. `runtime-evaluate-with-timeout` — `Runtime.evaluate` result never arrives.
27. `strip-types` — baseline artifact (host-v24 child); shim uninvolved.
28. `tracing-domain` — `NodeTracing` categories undefined (perfetto skip does not trigger here).
29. `vm-global-accessors-getter-sideeffect` — `Runtime.evaluate` / pause data never arrives.
30. `vm-global-accessors-sideeffects` — same.

## Not shim gaps (listed separately, per the gap file)

### Fails-natively (2) — both fail on real Node 26.13.1, neither involves the shim

- `test-inspector-dom-storage.js` (`nativeExit: 1` in the oracle).
  Node 26 test change: drops `--experimental-webstorage`, adds a second
  spawn (`test-inspector-dom-storage-unavailable.mjs`). Two independent
  non-shim failure modes, both reproduced isolated:
  - **Harness failure is host skew, not the shim.** The spawned child
    is host Node v24.22.1 (`Node.js v24.22.1` in the log) and dies with
    `ReferenceError: localStorage is not defined` at
    `fixtures/test-inspector-dom-storage.mjs:56` — v24 still needs
    `--experimental-webstorage` to define `globalThis.localStorage`;
    Node 26 defines it without the flag. The shim is never involved:
    the fixture child runs plain `process.execPath` with a native
    inspector Session.
  - **Native failure is a tmpdir race (flake).** Oracle-exact native
    runs (cwd `node-26-src`, Node 26.13.1 binary, no preload):
    run 1 exit 0, run 2 exit 1. Run 2: the child fails with
    `code: 'ENOENT', syscall: 'uv_cwd'` — its cwd
    (`test/.tmp.0`) vanished under it — reported as
    `[process 8204]: status = 1` by `spawnSyncAndExitWithoutError`.
    The oracle's single run caught one instance of the flake.
- `test-inspector-dom-storage-malformed.js` (`nativeExit: 1`; **new test
  in Node 26**). Consistently fails natively: oracle-exact runs 1 and 2
  both exit 1. Second sub-case mismatches:
  actual `Could not read DOM storage items: Uncaught Error: unable to
  open database file`, expected `... Uncaught Error: localStorage
  database is malformed: expected schema_version to be an integer`
  (test:89). The first sub-case (wrong-typed value → `the backing file
  is malformed`) passes. Under the shim it fails differently again
  (`AssertionError: Missing expected rejection` at test:80) — the child
  is host v24.22.1, whose storage agent does not reject malformed
  values the Node 26 way. Either way: a Node/environment behavior
  difference, not a shim gap.

### Native-timeout (3) — hang on real Node 26 too, NOT shim gaps

- `test-inspector-ip-detection.js` — 124 natively and under the shim
  (unchanged from v24: environmental).
- `test-inspector-network-fetch.js` — 124 natively and under the shim
  (unchanged from v24; Node 26 test change — `noProxy: '*'` + explicit
  `127.0.0.1` binds — is a robustness fix that does not change the
  verdict).
- `test-inspector-network-http.js` — 124 natively and under the shim
  (unchanged from v24: environmental).

## Baseline corrections

1. **`strip-types` is misclassified as a shim-gap; it is a harness
   artifact, not a shim gap.** Evidence: isolated shim log shows the
   failing child reporting `Node.js v24.22.1` with the v24-era
   `SyntaxError` on `./test-module-export.ts`; `grep` of the Node 26
   test file shows it uses only `NodeInstance` +
   `connectInspectorSession()` (raw WebSocket) and never
   `require('inspector')` — the shim is never in the path. The
   baseline spawns children on `process.execPath` (host v24.22.1), not
   on the Node 26 binary. Coordinator correction to the mechanism
   (2026-11-19): the worker's "host v24.22.1 natively exits 1" does
   NOT reproduce — native host v24.22.1 exits 0 on 4 consecutive runs
   from the clean node-26-src tree, and native Node 26.13.1 exits 0 on
   3 runs. The failure reproduces ONLY under the harness (staged 26
   tree + preload, exit 1, identical v24-child SyntaxError), so it is
   harness-induced (preload/host child), not shim-caused and not a
   native host-version failure. The verdict stands — not a shim gap —
   so the module's true shim-gap is **29**, not 30. No code change
   flips it from the shim side.
2. **`dom-storage` harness failure is host skew, not the shim**
   (see above: `localStorage is not defined` on the v24 child). Its
   oracle class (`fails-natively`) stands, but for the wrong reason in
   the single oracle run (tmpdir flake); the harness reason is the
   missing `--experimental-webstorage` on the v24 child. Same
   host-skew shape as `strip-types`; unlike `strip-types`, its native
   run is genuinely flaky, so it stays out of the shim-gap count
   either way.
3. **No correction needed for the two "124 at 10 s, 1 at 30 s" tests.**
   `exit-worker-in-wait-for-connection` and `network-arbitrary-data`
   read 124 at the baseline's 10 s phase-1 cap and 1 at the 30 s
   phase-2 cap — the two-phase design handled them correctly (both
   re-proven isolated here: 124 @ 10 s, 1 @ 30 s). They are slow
   under the shim, not hangs; the baseline's `harnessExit: 1` is
   right.
4. **F-family flip is a native fix, not a shim change.** `break-when-eval`,
   `esm`, `exception`, `worker-target` pass under the shim in Node 26
   because real Node 26.13.1 now delivers the pause/break
   notifications that v24.22.1 never delivered even natively. The shim
   (`src/inspector.js`) is unchanged between the two measurements
   apart from the already-shipped I-V1 validation.
5. **Non-baseline artifact, ignore:** running a test with `--import
   preload` but WITHOUT `PARITY_TARGET` (not the baseline invocation)
   fails with `TypeError: assert is not a function` (`esm` test:62,
   `test-inspector.js` test:34) — the preload is loaded but no module
   is redirected. It disappears under both correct conditions
   (`PARITY_TARGET=inspector` → exit 0; pure native Node 26.13.1 →
   exit 0). Not a baseline error, not a shim error.

## Pre-existing vs new-in-26 split

- Pre-existing (in the v24 37 NO-FIX set, same reason): **30/30 gaps**.
- New in Node 26: **0 gaps**. One new test (`dom-storage-malformed`)
  fails natively; three test files changed substantively (tracing-domain
  perfetto skip, dom-storage second spawn, network-fetch proxy hardening)
  with no change to any shim verdict.

## Parked path (not a lane)

A real inspector bridge — forwarding `Session.post()` through a host
inspector backend via the guarded `globalThis._RUNTIME_` hook in
`src/inspector.js` — would flip family A (20) and family E (3) and the
delivery halves of `emit-protocol-event` / `connect-main-thread` /
`overwrite-config`. No such backend exists in the sandbox; building one
is a host-architecture decision, already declined once; AGENTS.md rule 1
(browser-first, no native-Node delegation) forbids it as product work.
Recorded here only so it is not re-proposed as a lane.

## Method + evidence

- Exact baseline invocation, per `parity/drift/run-baseline.mjs`
  `runOne`: `timeout N node --import <abs preload>
  parity/node-test/parallel/<test>`, cwd = worktree,
  `PARITY_TARGET=inspector`. Isolated re-runs used a throwaway worktree
  at the same base (`3c091022`) with the full Node 26 test tree staged
  (`parallel` + `common` + `fixtures`, as `run-baseline.mjs` `stage()`
  does), then removed after the runs.
- Isolated re-run coverage: all 30 gaps re-run under the shim (27×
  exit 1, 3× exit 124 — identical to the baseline modulo the two
  slow-finishers, which were confirmed 1 at the 30 s cap); 5 F-family
  + `test-inspector.js` re-run shim (0) and native Node 26.13.1 (0);
  `dom-storage` + `dom-storage-malformed` re-run oracle-exact native
  (see above); `network-content-type` re-run native (0, both cwds).
- Probe logs (25 files): `~/workspace/node26-insp26-logs/` —
  `shim-<test>.log`, `shim2-<test>.log` (F-family), `native-<test>.log`,
  `oracle-exact-<test>-<n>.log`, `native24-strip-types.log`.
  Note: an earlier `/tmp` log set was lost to a runtime restart
  (`/tmp` wipe); all quoted results above were re-run with logs under
  `~/workspace/` except the F-family shim/native 0×5 pair, which was
  observed in completed tool output before the restart and matches the
  baseline CSV exactly.
- Test-file equivalence: esbuild-minify normalization of v24-vendored
  vs Node 26 source, 37 files (script `/tmp/norm-compare.mjs`, since
  lost with `/tmp`; method: `transform(..., {minify: true})` equality).
  Result 34 SAME / 3 REAL-DIFF (listed above).
- v24 adjudication source: `hidden_files/triage-inspector-2026-11-18.md`
  (base `327b0226`, 30/75, families A–F) + lane notes
  `NOTES-inspector-validation-v1.md` (I-V1, +5 flips, PR #503) and
  `NOTES-inspector-fixtures-f1.md` (I-F1, +3 flips).

## Deliverable

This file only. No `src/` changes, no shim code, no `package.json`
edits (docs-only triage). No lane is proposed; no follow-up lane work
is owed for inspector on Node 26 beyond the `strip-types`
reclassification decision, which belongs to the coordinator.
