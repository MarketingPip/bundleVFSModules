# NOTES — Node 26 re-target triage: perf_hooks (14 gaps)

Base SHA `3c091022`. Docs only — no src/ changes.
Banked numbers (parent-verified, not recomputed): overall 2,748 tests,
2,144 pass / 575 fail / 29 timeout; perf_hooks non-pass 14, shim-gap 14,
0 fail-natively, 0 native-timeout (oracle: native Node 26.13.1 passes all 14).

## Method + host versions (verified by probe, not assumed)

- Node 26 binary `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
  Host `node --version` → `v24.22.1` (the harness host; CI pins v24.20.0).
- Isolated re-run invocation, baseline-exact (from
  `parity/drift/run-baseline.mjs:167-178`):
  `PARITY_TARGET=perf_hooks timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/<test>` — NO per-test flags (run-baseline passes
  none; the oracle, `parity/drift/run-oracle.mjs:50-69`, parses each test's
  `// Flags:` header). All 14 tests were staged from
  `~/workspace/local/node-26-src/test/parallel/` into the worktree's
  `parity/node-test/parallel/`, re-run, then restored (`git checkout` +
  untracked-file removal; `git status --porcelain` clean afterwards).
- **All 14 reproduced exit 1 under the baseline-exact invocation — 0 flakes,
  0 passes.** First-failure lines below are from those re-runs.
- v24.20.0 test inventory (from `node-v24.20.0.tar.gz` test list): the vendored
  15 perf_hooks tests are exactly the v24.20.0 set. Of the 14 gaps, 2 test
  files existed in v24.20.0 (changed in 26) and 12 are new in 26.
- Export diff (`parity/drift/node26-export-diff.md:111-113`): perf_hooks ADDED
  `createSlidingWindowHistogram`, `importHistogram`. Changelog cross-check
  (`cross-check-changelog-2026-11-19.md:47-48`): 25.0.0 removed deprecated
  perf_hooks accessors; 24.22.0 added SlidingWindowHistogram + meanCI + CBOR
  export/import for histograms.
- v24 context: perf_hooks closed 15/15 (100%) on v24.20.0 via the
  native-bridge gate (`NOTES-perf-hooks-native-bridge-gate.md`, PR #489,
  merge `b132dbb4`): `src/perf_hooks.js:55-70` delegates to the genuine
  builtin whenever available. **That gate is load-bearing for this triage:
  under the harness, `createHistogram()` / `monitorEventLoopDelay()` return
  HOST v24.22.1 native histograms** — proven by re-run stacks citing
  `node:internal/histogram:734` (fast-calls, record-zero). So several "26"
  failures are the host native object lacking 26 behaviour, not the pure-JS
  shim — see the host-artefact notes per family. The pure-JS fallback is a
  separate lane surface (browser), and its flips do NOT move the harness
  score while the bridge delegates.

## New-in-26 vs pre-existing split

NEW in 26 (12 — test file absent from v24.20.0 tarball):
histogram-diff, histogram-external-memory, histogram-import,
histogram-record-zero, histogram-snapshot, histogram-stats,
monitor-event-loop-delay-options, monitor-event-loop-delay-resolution,
resourcetiming-attributes, resourcetiming-fetch.mjs,
sliding-window-histogram-fast-calls, sliding-window-histogram.

PRE-EXISTING file, CHANGED in 26 (2 — passed on v24, fail on the 26 version):
- `test-perf-hooks-histogram-fast-calls.js` — 26 adds a record(0) block
  (diff v24→26, lines 36-47: `histogram.record(0)`, `count` 1, `min` 0).
- `test-perf-hooks-resourcetiming.js` — 26 adds expected fields
  `finalResponseHeadersStart`, `firstInterimResponseStart`,
  `renderBlockingStatus`, `contentType`, `contentEncoding` to the
  deep-equalled entries (diff v24→26).
Neither is a v24 adjudication carried over: both passed 15/15 on v24 and
fail only because the 26 test asserts new behaviour. No gap here is a
re-opened v24 NO-FIX.

## Families (first-failure cause; counts sum to 14)

### F1 — Missing exports: `createSlidingWindowHistogram` / `importHistogram` not exported by the shim (4)

- Tests: `test-perf-hooks-histogram-import.js` (`:43`
  `TypeError: importHistogram is not a function`),
  `test-perf-hooks-histogram-stats.js` (`:534` same),
  `test-perf-hooks-sliding-window-histogram.js` (`:12`
  `TypeError: createSlidingWindowHistogram is not a function`),
  `test-perf-hooks-sliding-window-histogram-fast-calls.js` (`:11` same).
- Shim evidence: `src/perf_hooks.js:2221-2252` export list has neither name;
  grep for `createSlidingWindowHistogram|importHistogram|meanCI|exportHistogram`
  in `src/perf_hooks.js` returns nothing.
- Host evidence: host v24.22.1 HAS both
  (`node -e` probe: `createSlidingWindowHistogram function`,
  `importHistogram function`) — the gap is purely the missing shim export +
  delegation, not host capability. (Also explains the known repo-test skew in
  the gate note: `tests/export_surface_perf_hooks.test.js` fails on host
  v24.22.1 because the shim lacks these two; passes on CI's pinned v24.20.0
  where the surface itself lacks them.)
- Classification: **real shim work** (export + native delegation, pure-JS
  fallback for browsers).
- Second blockers (affect lane flip accounting, not family membership):
  stats uses `meanCI()` (lines 13-83, already passing under harness — host
  native has it) and `export()` (line 530, host has it), so stats' ONLY
  blocker is the missing export. import tests CBOR validation of
  `importHistogram()` incl. hand-built payloads and a v1-format payload
  (lines 160-182) — host native import handles it, pure-JS needs a CBOR codec.
  sliding-window-fast-calls additionally records 0 (see F3).

### F2 — `Histogram.snapshot()` / `diff()` / `export()` missing (3)

- Tests: `test-perf-hooks-histogram-diff.js` (`:17`
  `TypeError: histogram.snapshot is not a function`),
  `test-perf-hooks-histogram-snapshot.js` (`:57` same),
  `test-perf-hooks-histogram-external-memory.js` (`:29` same, 400×
  `histogram.snapshot()` in a loop).
- Shim evidence: grep for `snapshot(|diff(|export(|meanCI` in
  `src/perf_hooks.js` returns nothing — the pure-JS `RecordableHistogram`
  (`:663`) has `record/recordDelta/add` but no `snapshot/diff/export`.
  Node 26 lib has all three (`lib/internal/histogram.js`: `snapshot`,
  `diff`, `export`, `meanCI` at :214, plus `SlidingWindowHistogram` at :848).
- Host evidence: host v24.22.1 native histogram has `export` + `meanCI`
  but `snapshot`/`diff` are `undefined`
  (`node -e` probe: `snapshot undefined diff undefined export function
  meanCI function`); node 26.13.1 has all four. Under the harness the bridge
  hands back the host object, so the pure-JS implementation alone cannot flip
  these — the lane must also decide how a native histogram gains
  `snapshot()` (candidate design: implement it in JS on top of `export()`'s
  CBOR, which the host DOES provide; must not regress `histogram.js`
  postMessage, which needs the native object — a blunt "use pure-JS when the
  native lacks snapshot" gate would regress it).
- Classification: **real shim work**, conditional on that design.
- snapshot test specifics: snapshot must be a read-only `Histogram`
  (constructor name `Histogram`, `inspect` → `[Histogram]`, mutating methods
  `undefined`, `resetCount` tracked — lines 28-40, 110-111); `export()`
  round-trip equality (line 25). diff test specifics: `diff()` between
  snapshots, `resetCount` semantics, cross-type throws, sliding-window
  interaction (lines 129-166).
- external-memory: after `snapshot()` exists, the test needs 400 snapshots to
  trigger a major GC observed via `PerformanceObserver` gc entries
  (`NODE_PERFORMANCE_GC_MAJOR`). Whether pure-JS snapshots (JS-heap counts
  arrays, ~352 KiB each natively) trigger observable major GC through the
  shim's observer is UNPROVEN — flip counted 0 (see L-PH1).

### F3 — `record(0)` rejected (2 first-failures; +2 second-blockers)

- Tests (first failure): `test-perf-hooks-histogram-fast-calls.js` (`:39`,
  `RangeError [ERR_OUT_OF_RANGE] ... Received 0` at
  `node:internal/histogram:734` — the HOST native histogram),
  `test-perf-hooks-histogram-record-zero.js` (`:15`, same host-native throw).
- Shim evidence: pure-JS also rejects — `src/perf_hooks.js:682`
  `validateInteger(val, "val", 1)` and `:678` `if (val < 1n) throw` for bigint.
  Node 26 accepts 0 / -0 / 0n (`lib/internal/histogram.js` record path;
  probe: node 26 `record(0) ok count 1 min 0`; host v24.22.1 throws
  `ERR_OUT_OF_RANGE`). v24.20.0 also rejects (tarball
  `lib/internal/histogram.js:292`: `validateInteger(val, 'val', 1)`).
  So the behaviour changed between 24.22.1 and 26.13.1.
- Second blockers: `record-zero` additionally needs F1 (`importHistogram`
  round-trip with zero counts, sliding-window `record(0)`), `recordCorrected(0,
  10)`, `add`/`subtract` with zero histograms, `countAt(0)`/`cdf(0)` with
  `lowest: 1000` (zero-bucket semantics — `BucketStore` bucket 0 covers
  `[0, …)` per `src/perf_hooks.js:312`, but `recordValue(0)` path is
  unverified for the `lowest: 1000` case). `sliding-window-fast-calls`
  records 0 on the sliding window (host sliding `record(0)` also throws —
  probe: `host sw record(0) throws ERR_OUT_OF_RANGE`, node 26 accepts).
- Classification: **host-version artefact for the harness lane, real shim
  work for the pure-JS (browser) lane.** Under the harness the bridge
  delegates `createHistogram()` to the host native object, which rejects 0
  before any shim code runs — relaxing the pure-JS validation cannot flip
  these two tests here. NOT a NO-FIX: pure JS can accept 0; the tests flip
  under the harness only when the host provides a Node with record(0)
  support (≥26 semantics) or the bridge stops delegating record paths.

### F4 — `monitorEventLoopDelay()` ignores lowest/highest/figures/samplePerIteration + missing validation (1)

- Test: `test-perf-hooks-monitor-event-loop-delay-options.js`. First failure:
  `countsLength: 46080n` actual vs `3456n` expected, for
  `{ lowest: 1000, highest: 3_600_000_000_000, figures: 2 }` — actual is the
  DEFAULT layout (figures 3n), i.e. the options were ignored. The test also
  covers `samplePerIteration: true` defaults (`lowest` 1n, counts 55296n),
  per-option `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` /
  `ERR_INVALID_ARG_VALUE` validation, default-lowest-vs-highest rules, and
  per-iteration sampling counts + `exceeds`.
- Shim evidence: `src/perf_hooks.js:2111-2130` validates only
  `samplePerIteration`/`resolution` and the pure-JS path hardcodes
  `new BucketStore(1, MAX_SAFE_INTEGER, 3)` — lowest/highest/figures never
  read. Host evidence: host native ALSO ignores the options (probe:
  `monitorEventLoopDelay({lowest:1000,highest:3.6e12,figures:2}).export()`
  first bytes show default highest `2^63-1` on host, honoured `3.6e12` on
  node 26) — the options are a 26 addition to ELD, so the bridge delegates
  into a host that drops them. `ELDHistogram extends Histogram`
  (`:712`), so `export()` from L-PH1 flows to ELD once implemented.
- Classification: **real shim work (pure-JS) + host-version artefact
  (harness lane)** — same bridge-bound shape as F3.

### F5 — `monitorEventLoopDelay()` resolution truncated to 32 bits (1)

- Test: `test-perf-hooks-monitor-event-loop-delay-resolution.js`. First
  failure: `11 !== 0` at `:21` — `histogram.count` is 11, expected 0, for
  `resolution: 2 ** 32 + 1` (truncated to 1 ms it samples; untruncated, the
  first sample lands ~99 days after enable).
- Host evidence (probe `/tmp/ph26/probe-a.mjs`, since wiped — rerun before
  relying on it): host v24.22.1 `big.count 80, ctl.count 80` after 200 ms
  (truncated to 1 ms); node 26.13.1 `big.count 0, ctl.count 86` (not
  truncated). Under the harness the bridge delegates to the truncating host.
- Shim evidence: pure-JS `_startSampler` (`src/perf_hooks.js:740-760`)
  passes `resolution` straight to `setInterval` as a JS number — no 32-bit
  truncation in shim code (Node clamps the timer to 2^31-1 ms, ~24.8 days,
  still no sample in-test). So the pure-JS path is already correct.
- Classification: **host-version artefact, no shim work needed** — flips
  under the harness only on a host with the 26 resolution fix (or if the
  bridge routes ELD to pure-JS).

### F6 — `PerformanceResourceTiming` missing 26 attributes (2)

- Tests: `test-perf-hooks-resourcetiming-attributes.js` (`:49`
  `undefined !== 0` for `finalResponseHeadersStart`),
  `test-perf-hooks-resourcetiming.js` (deep-equal diff: actual lacks
  `contentEncoding` etc.).
- Shim evidence: `PerformanceResourceTiming` (`src/perf_hooks.js:991`)
  has no `finalResponseHeadersStart`, `firstInterimResponseStart`,
  `renderBlockingStatus`, `contentType`, `contentEncoding` getters
  (grep for those names returns only `responseStart` at `:1083`, which
  returns `finalNetworkResponseStartTime` unconditionally); `toJSON`
  (`:1142`) omits them; `markResourceTiming` (`:1731-1751`) drops the
  `body` argument (contentType/contentEncoding source) — it is not passed
  to `createPerformanceResourceTiming`. Test requirements: defaults
  (`finalResponseHeadersStart` 0, `firstInterimResponseStart` 0,
  `renderBlockingStatus` 'non-blocking', `contentType`/`contentEncoding`
  ''), `responseStart` prefers non-zero `firstInterimResponseStart`
  (from `firstInterimNetworkResponseStartTime`) over
  `finalResponseHeadersStart` (from `finalNetworkResponseStartTime`),
  `renderBlocking` boolean → 'blocking'/'non-blocking', bodyInfo mapping,
  toJSON parity, and enumerable prototype getters with `ERR_INVALID_THIS`
  brand checks.
- Classification: **real shim work, pure-JS only** — no native delegation
  involved (`markResourceTiming` is shim code; `resourcetiming.js` drives
  the shim's own http server + performance entries).

### F7 — `fetch()` creates no shim resource-timing entry (1)

- Test: `test-perf-hooks-resourcetiming-fetch.mjs` (`:39`
  `0 !== 1` for `performance.getEntriesByName(url, 'resource').length`
  after a real `fetch()` to a local server). It also asserts
  `initiatorType` 'fetch', `responseStatus` 200,
  `finalResponseHeadersStart > 0`, `firstInterimResponseStart` 0,
  `responseStart === finalResponseHeadersStart`, and toJSON parity for the
  6 new attributes (so it needs F6 too).
- Cause (by construction, not yet probe-isolated): the test's `fetch` is the
  host's native fetch (undici), which records entries on the NATIVE global
  `performance`, while `performance` here is the shim's object (preload
  redirects `perf_hooks` only) — the entry never reaches the shim's buffer.
- Classification: **real shim work, cross-module integration** — needs a
  fetch→shim timing bridge (e.g. the shim's `performance` merging native
  resource entries, or fetch interception). Flip is conditional pending a
  spike proving native entries are visible to the shim under the harness.

## Lane candidates (conservative harness-lane flips)

Harness-lane = the parity-harness score (bridge active, host v24.22.1).
Browser-lane = the pure-JS fallback (no native delegation). A lane that only
fixes pure-JS scores 0 on the harness while the bridge delegates — stated
explicitly per lane, not hidden.

- **L-PH1 — Histogram 26 API surface (F1 + F2).** Add
  `createSlidingWindowHistogram` + `importHistogram` exports (delegate to
  native when present, pure-JS fallback otherwise); implement
  `RecordableHistogram.snapshot/diff/export`, `meanCI` (pure-JS; host already
  has it), read-only `ClonedHistogram` snapshots with `resetCount`, and a
  pure-JS `SlidingWindowHistogram` (chunked window, `snapshot/reset`,
  bigint record). CBOR export/import codec for the pure-JS path
  (documented format: keys 1 lowest, 2 highest, 3 figures, 9 counts length,
  10 counts). **Flips (harness): 3 certain** — `histogram-import`,
  `histogram-stats`, `sliding-window-histogram` (host native supplies the
  behaviour once exported). **+2 conditional** — `histogram-diff`,
  `histogram-snapshot` (need the snapshot-on-native design, e.g. via
  `export()` CBOR, without regressing `histogram.js` postMessage).
  `histogram-external-memory`: 0 (GC-accounting unproven — re-probe after
  snapshot lands). `sliding-window-histogram-fast-calls`: 0 in this lane
  (blocked on F3 record(0)). Total: **3, up to 5.**
- **L-PH2 — `record(0)` acceptance (F3).** Relax pure-JS validation to
  `val >= 0` (`record`, `recordCorrected`, bigint, sliding window) incl.
  zero-bucket stats (`min`/`countAt(0)`/`cdf`/`percentiles` with zero,
  `lowest: 1000` edge). **Flips (harness): 0** — host native rejects 0
  through the bridge. **Flips (browser lane): 3** — `histogram-fast-calls`,
  `histogram-record-zero` (needs L-PH1 too), `sliding-window-fast-calls`
  (needs L-PH1 too). Flips under the harness when the host moves to
  ≥26 record(0) semantics.
- **L-PH3 — ELD options + resolution (F4 + F5).** Pure-JS: honour
  `lowest/highest/figures/samplePerIteration` in the `BucketStore` config
  (incl. per-mode default `lowest` 1000 vs 1), add the validation matrix
  (`ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` / `ERR_INVALID_ARG_VALUE`),
  per-iteration sampling + `exceeds` accounting. Resolution needs no code
  change (pure-JS already untruncated). **Flips (harness): 0** — host
  ignores the options and truncates resolution through the bridge.
  **Flips (browser lane): 2** — `monitor-event-loop-delay-options`,
  `monitor-event-loop-delay-resolution`. Depends on L-PH1 for `export()`
  on ELD histograms (options test reads layout via `export()`).
- **L-PH4 — ResourceTiming 26 attributes (F6).** Add the 5 getters +
  `responseStart` interim preference + `body` plumbing through
  `markResourceTiming` + `toJSON` entries (enumerable prototype getters,
  `ERR_INVALID_THIS` brand checks). **Flips (harness): 2** —
  `resourcetiming-attributes`, `resourcetiming.js`. Pure-JS, no bridge
  involvement; the most certain lane in this module.
- **L-PH5 — fetch resource timing (F7).** Spike first: prove whether the
  shim can see native fetch resource entries under the harness, then bridge
  them into the shim's `performance` buffer. **Flips: 0–1 conditional**
  (`resourcetiming-fetch.mjs`, needs L-PH4 too). Do not commit to this lane
  before the spike.

**Totals (harness lane): 5 certain (L-PH1 3 + L-PH4 2), up to 7 with the
conditional diff/snapshot. +5 more become flippable only on a host with 26
semantics (F3 ×2, F5 ×1, F4 ×1, plus record-zero/sw-fast-calls counted in
F3's set — the 5 are fast-calls, record-zero, sliding-window-fast-calls,
monitor-options, monitor-resolution). 1 test (external-memory) has no
credible flip path yet; 1 test (fetch) is spike-conditional.**

## NO-FIX list

**None for perf_hooks.** Every family has a real shim-work path (pure-JS
and/or export), even where the harness lane is currently host-blocked —
host-blocked is not impossible-in-a-browser, so no NO-FIX is claimed.
`histogram-external-memory` is the closest call (GC accounting), but it is
left as "unproven, re-probe after L-PH1" rather than NO-FIX, with no probe
evidence for impossibility.

## Baseline corrections

- None of the 14 perf_hooks verdicts is a sweep flake: all 14 reproduced
  exit 1 in isolated baseline-exact re-runs (above). No timeout/load
  artefact (all harnessExit 1, none 124).
- One framing correction for the coordinator: 5 of the 14 (F3 ×2, F4, F5,
  + the record(0) half of sliding-window-fast-calls) are **host-version
  artefacts, not shim defects** — the harness host v24.22.1 natively rejects
  record(0), ignores ELD lowest/highest/figures, and truncates ELD
  resolution to 32 bits, while native 26.13.1 does none of those (oracle
  nativeExit 0 on all 14). They are genuine 26-vs-24 behaviour gaps and the
  pure-JS lane work is real, but the harness score for them cannot move
  until the host upgrades or the bridge stops delegating those paths. Do not
  count them as shim failures in the 26-gap total without that qualifier.
- The baseline ran all tests WITHOUT their declared `// Flags:` headers
  (`run-baseline.mjs:167-178` passes no flags; oracle parses them). For the
  three flagged perf tests this does not change the verdict: each self-
  respawns as a child with its flags (re-run output shows the
  `NOTE: The test started as a child_process using these flags: […]` line
  for fast-calls, stats, sliding-window-fast-calls). No correction needed
  for perf_hooks verdicts on that account.

## Evidence index

- Gap lists: `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node26-triage/gaps-perf_hooks.json`
- Node 26 tests: `~/workspace/local/node-26-src/test/parallel/test-perf-hooks-*.js`
- Node 26 lib: `~/workspace/local/node-26-src/lib/internal/histogram.js`,
  `lib/perf_hooks.js:28-29,48-49`
- v24.20.0 inventory + record validation: tarball
  `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/node-src/node-v24.20.0.tar.gz`
  (`test/parallel/test-perf-hooks-*`, `lib/internal/histogram.js:292`
  `validateInteger(val, 'val', 1)`)
- Shim: `src/perf_hooks.js` — bridge `:55-70`, `createHistogram` `:775-810`,
  `RecordableHistogram` `:663-683`, `ELDHistogram` `:712-766`,
  `monitorEventLoopDelay` `:2111-2130`, `PerformanceResourceTiming` `:991`,
  `responseStart` `:1083`, `markResourceTiming` `:1731-1751`, exports
  `:2221-2252`
- Probes (run 2026-11-19, host v24.22.1 vs node 26.13.1; re-run after a
  service restart with identical verdicts, counts varying only by timing):
  native histogram `snapshot/diff/export/meanCI` + `record(0)` + sliding
  `record(0)` + ELD default layout (`countsLength 46080n` both) + ELD
  options export bytes + ELD resolution counts (host `big 61–80, ctl 61–80`;
  node 26 `big 0, ctl 68–86`). Probe script `/tmp/ph26/probe-a.mjs`
  (ephemeral; re-create from the one-liners in the family sections).
