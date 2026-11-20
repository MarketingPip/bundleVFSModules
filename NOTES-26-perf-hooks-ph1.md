# Node 26 Wave 2 — PERF_HOOKS L-PH1 (F1 + F2)

Lane: `feat/w2-perf-hooks-ph1` · base `b5f2e94f` (origin/main at lane start;
the task named `652333e7`, which is an ancestor of `b5f2e94f` — the delta
`652333e7..origin/main` touches only stream + preload + dist, no perf_hooks
files, so working from current origin/main is equivalent for this lane).
Banked count (coordinator-verified on live main, this run): **19/31**.

## Result: 24/31 (19 + 5 flips, 0 regressions)

| Test | Baseline | After | Evidence |
|---|---|---|---|
| test-perf-hooks-histogram-import.js | FAIL | PASS | isolated [0,0] x2 |
| test-perf-hooks-histogram-stats.js | FAIL | PASS | isolated [0,0] x2, with `// Flags: --expose-internals --no-warnings` |
| test-perf-hooks-sliding-window-histogram.js | FAIL | PASS | isolated [0,0] x2 |
| test-perf-hooks-histogram-diff.js | FAIL | PASS | isolated [0,0] x2 |
| test-perf-hooks-histogram-snapshot.js | FAIL | PASS | isolated [0,0] x2 |

Full differential (`parity/run.mjs`, Node 26 test files, qrde fixture staged):
`/tmp/ph26/run-fix2.log` — 24 PASS / 7 FAIL. Isolated runs:
`/tmp/ph26/iso-<test>-run{1,2}.log`, plus
`/tmp/ph26/iso-stats-flag-run{1,2}.log` (stats re-run with its declared flags).

Guards held — all 19 baseline passes still pass: eventlooputilization,
histogram-analysis, histogram-qrde-oracle, histogram-qrde-worker,
histogram-qrde, histogram, monitor-event-loop-delay-fast-calls,
resourcetiming-attributes, resourcetiming, timerify-basic,
timerify-constructor, timerify-error, timerify-histogram-async.mjs,
timerify-histogram-sync.mjs, timerify-invalid-args,
timerify-multiple-wrapping, timerify-return-value, usertiming,
worker-timeorigin.

Remaining 7 failures are out of lane scope (unchanged from baseline):
histogram-external-memory (see below), histogram-fast-calls,
histogram-record-zero (F3, L-PH2), monitor-event-loop-delay-options,
monitor-event-loop-delay-resolution (F4/F5, L-PH3),
resourcetiming-fetch.mjs (F7, L-PH5),
sliding-window-histogram-fast-calls (F3, L-PH2).

Note: `parity/run.mjs` DOES parse `// Flags:` headers (extractFlags) and
spawns `node [...flags, --import preload, <test>]`, so the full-run verdicts
for the flagged tests already carry their flags. The isolated re-runs used
direct harness invocation; stats was additionally re-run with its flags.

## Method

Two paths, one design (see `src/perf_hooks.js` §5b and §9b):

- **Native path (harness, host v24.22.1):** the 26 API is patched onto the
  native base `Histogram` prototype (parent of both the RecordableHistogram
  and ELD prototypes, so one patch covers both), gated on the host lacking
  `snapshot`. `snapshot()`/`diff()` round-trip through the native v1
  `export()` + native `importHistogram()`, with exceeds restored by
  recording `highest+1` (exceeds values are not stored in CBOR and do not
  touch EWMA). `export()` is re-encoded as CBOR v2. `reset()`/`subtract()`
  are wrapped to bump a per-instance `resetCount` WeakMap. Snapshots are
  re-prototyped to the base prototype with the own `constructor` property
  removed, so they read as plain read-only `Histogram`s.
- **Pure-JS path (browser lane):** `Histogram` gains `snapshot()`,
  `diff()`, `export()` (v2), `meanCI()` (ported Student's t), `resetCount`
  and EWMA getters; `BucketStore` gains EWMA state, `resetCount`,
  `normOffset`/`convRatio`, `clone()` and `setLogicalCounts()`.
  `importHistogram()` is always pure-JS (the host import rejects v2, and
  the host v1 import does not derive min/max). `createSlidingWindowHistogram`
  delegates to native when present, else a pure-JS chunked window
  (time/count generations per C++, snapshot aggregates live chunks).
- **CBOR codec** (pure JS, no deps): minimal-width uint encoder, float64,
  strict skipper mirroring `CborSkipItem` (16-level nesting limit,
  indefinite/reserved rejections), typed readers, and validation mirroring
  `Histogram::Import` (layout, countsLen equality, normOffset range,
  total-count match, int64 overflow via BigInt). Import translates physical
  sparse indices to logical via the normalizing offset and installs counts
  directly by hdr index (no midpoint re-bucketing — the only exact path for
  top-bucket counts). Export translates shim bucket indices to hdr logical
  indices via the (bucket, sub) mapping.

## Bugs found and fixed during the lane

1. **EWMA getter/setter clash** (`src/perf_hooks.js`, BucketStore): the
   `ewmaMean`/`ewmaStddev`/`ewmaErrorRate` getters read the same-named
   state fields, so the constructor assignment threw in strict mode
   (8 repo-test failures). Backing fields renamed to `_ewmaMean` /
   `_ewmaVariance` / `_ewmaErrorRate`; getters read the underscored fields.
2. **`hdrLayout` bucket overcount** (blocked both conditionals):
   `Number(INT64_MAX/2n)` rounds up to 2^62, so the
   `buckets_needed_to_cover_value` loop ran one iteration too far for
   highest INT64_MAX (ELD layout: countsLen 47104 instead of 46080, so
   every ELD export failed validation). Loop rewritten with exact BigInt
   arithmetic; the `lowest > highest/2` check likewise uses BigInt.
3. **Encoder wrote highest = 2^63** (blocked the ELD diff block):
   `Number(INT64_MAX)` rounds up to 2^63, which the int64 reader —
   correctly, per C++ — rejects. New `_cborWriteInt64` clamps a 2^63
   Number back to INT64_MAX for all int64 fields (lowest/highest/
   totalCount/min/max/counts/EWMA threshold); an int64 field can never
   legitimately be 2^63.
4. **`diff.call({})` / `snapshot.call({})` threw a codeless TypeError**
   (`this._store is not a function` on a bare `this`). The new methods
   (`snapshot`, `diff`, `export`, `meanCI`) and the `resetCount` getter
   now guard with `instanceof Histogram` first, yielding
   ERR_INVALID_THIS.

## ELD lowest depends on sampling mode (oracle fact)

`lib/internal/perf/event_loop_delay.js`: interval mode defaults to
lowest 1000 ns, `samplePerIteration` mode to lowest 1 ns. The diff test's
ELD block uses `samplePerIteration: true` (lowest 1, countsLen 55296);
the snapshot test's ELD block uses resolution 1 (lowest 1000, countsLen
46080). Both layouts are exercised by the passing tests.

## NOT claimed: histogram-external-memory

Re-probed after snapshot landed (direct harness run): still fails with
the same assertion — `Expected a major garbage collection caused by
histogram memory` (test line 36). The test creates 400 snapshots and
expects a major GC from the ~352 KiB of native histogram memory each
holds. Whether the snapshots' external memory is attributed so V8
schedules a major GC under the harness is unproven GC-scheduling
behavior, not an API gap — out of scope for this lane, no fix attempted.

## Ceilings (ponytail: documented, not fixed)

- Pure-JS `subtract` / `recordCorrected` are not implemented (not in the
  F1/F2 scope; the native path supplies them under the harness).
- Pure-JS sliding-window `structuredClone()`/`postMessage()` succeed
  (plain object) where native throws DataCloneError; the harness lane
  uses the native window, so this only affects the browser lane.
- Counts above 2^53 lose integer precision in the JS-number bucket array
  (hdr keeps int64); `highest`/`lowest` above 2^53 round-trip through
  doubles, so a non-power-of-two bound in that range can shift by one
  bucket on re-export. No 26 test exercises that range.
- A `structuredClone()` of a native histogram does not carry the JS-side
  `resetCount` (V8 clones the handle, not the WeakMap); the clone starts
  at 0. Untested by the 26 suite.
- `nativeRestoreExceeds` uses `BigInt(highest)+1`; for `highest` > 2^53
  the Number round-trip can lose the exact bound (same corner as above).
- `toJSON` EWMA/skewness fields unchanged (native under harness; out of
  scope).

## CI follow-up (2026-11-20 ~07:00 EST)

- First CI run on PR #525 (head `d696c9fc`) went red on the `build` job;
  the Parity check was green. The CI log (`/tmp/ph26/ci-build-525.log`)
  shows exactly one failing test: `tests/perf_hooks.test.js`,
  "exports match Node v24.20.0 (no Histogram) + Node 26 additions", at the
  NATIVE-surface assertion (line 64). Cause: CI pins Node 24.20.0, whose
  native namespace lacks both new exports (verified: 0 occurrences in the
  24.20.0 source pack, `hidden_files/node-src/lib/{perf_hooks,
  internal/histogram}.js`) — the shim assertion passed, the native
  equality failed. The host here is v24.22.1, which already carries both,
  so the failure was CI-only.
- Fix: the native check is now a subset check — the shim must cover
  everything the host native offers (the exact shim list stays pinned by
  the first assertion). Verified locally (41/41) and against the 24.20.0
  export list extracted from the source pack (subset holds). Pushed as a
  second commit on the branch; CI re-run awaited on the new head SHA.

## Recovery re-verification (L-PH1 recovery worker, 2026-11-20 ~02:45 EST)

- The first worker was killed by a runtime restart before CI ran; the
  branch survived at head `17113894`, PR #525 open, 0 check-runs
  (CI no-show). The stale local worktree was at `836e056a` (its own
  merge commit, tree-diff vs the pushed head: only `dist/vfs.js` 1 line);
  it was hard-reset to `origin/feat/w2-perf-hooks-ph1` — clean, nothing
  uncommitted lost. `/tmp/ph26` logs were wiped by the restart, so every
  claim below was re-proven from scratch.
- **Full differential re-run** (`parity/run.mjs perf_hooks`, 31 Node 26
  test files staged + `qrde-r-oracle.json` fixture, then restored):
  **24/31 PASS** on the branch — the 7 fails are exactly the out-of-scope
  set (external-memory, fast-calls, record-zero, monitor-options,
  monitor-resolution, resourcetiming-fetch.mjs,
  sliding-window-fast-calls). Log: `/tmp/ph26-rec/run-branch.log`
  (ephemeral; counts recorded here).
- **Baseline re-run on `origin/main` (`4a05cd91`)**, same staging:
  **19/31 PASS** — confirms the coordinator banked count. The 5 claimed
  flips all FAIL on main, all 19 baseline passes still pass on the
  branch: **0 regressions**. Log: `/tmp/ph26-rec/run-baseline.log`.
  Note: `resourcetiming-attributes` + `resourcetiming` PASS on main too
  (part of the 19 guard set) — the triage F6 first-failure does not
  reproduce under this harness invocation; L-PH4's work is therefore not
  double-counted here and no extra flip is claimed.
- **Isolated 2x re-runs** (direct harness, `PARITY_TARGET=perf_hooks`;
  stats with its declared `// Flags: --expose-internals --no-warnings`):
  all 5 flips exit 0 twice — import, stats, sliding-window-histogram,
  diff, snapshot. Logs: `/tmp/ph26-rec/iso-*-run{1,2}.log`.
- **Repo tests:** `jest tests/perf_hooks.test.js
  tests/export_surface_perf_hooks.test.js` — **41/41**. `node --check
  src/perf_hooks.js` clean.
- **Rebase:** `origin/main` has not moved since the branch's `1910c4b0`
  merge (`4a05cd91` still tip, base is an ancestor) — a rebase is a
  no-op, so no new head SHA comes from it. This recovery commit is the
  new push that retriggers CI on the branch. If CI still no-shows on
  the new head, the next unstick is close + reopen a fresh PR from the
  same branch (PR #384 precedent).
- **Merged:** CI went green on the new head `87b84192` (Parity success,
  build success — the push unstuck the no-show; no close/reopen needed).
  Squash-merged as `a1d2b4d8` (PR #525, merge verified `merged: true`
  by direct read). Branch ref deleted. Final count: **perf_hooks
  24/31** (19 banked + 5 flips, 0 regressions).

## Verification (all green)

- `node --check src/perf_hooks.js`
- Repo tests: `npx --no-install jest tests/perf_hooks.test.js
  tests/export_surface_perf_hooks.test.js` — 41/41 (run via the main
  repo's jest binary with `NODE_PATH`, since the worktree has no
  `node_modules`; `NODE_OPTIONS=--experimental-vm-modules` as the repo
  requires). Note: `tests/perf_hooks.test.js` expected list updated with
  the two new exports — the host v24.22 native namespace already carries
  both, so the native-surface assertion in the same test holds too.
- Pure-JS probes (`/tmp/ph26/probe-purejs.mjs`, `__PERF_HOOKS_NO_NATIVE__`):
  14/14 — meanCI vs the known 95% CI, constant/single-value cases,
  validation; v2 export header; pure-JS export/import round-trip
  (stats + EWMA, strict equality); pure-JS import vs native stats; the
  v1 payload from the import test (count 7, strict doubles incl.
  ewmaMean/ewmaStddev/ewmaErrorRate); pure-JS snapshot/diff incl.
  ERR_INVALID_STATE after reset; SW rotation + validation matrix;
  importHistogram validation.
