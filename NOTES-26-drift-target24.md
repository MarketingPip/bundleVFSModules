# NOTES — Lane A: parameterise the drift detector for a second target (Node 24)

Infra lane (version-support strategy §5 step 2). One PR, separate from module
lanes per the one-PR-per-module rule. Base: origin/main `0a6c9f19`. Branch:
`infra-drift-target24`.

## What changed per file

- `parity/drift/run-baseline.mjs` — `--target 24|26` (default 26).
  `TARGETS = { 24: "24.20.0", 26: "26.13.1" }` is the whole target table (a
  third target adds one line + its tree source). Target 26: unchanged
  behaviour — same tree source (`--node26-src`, or generic `--node-src`),
  same staging, same CSV/JSON names (`node26-baseline-<module>.csv`,
  `node: "26.13.1"`). Target 24: stages the repo's vendored v24.20.0 tree
  (`parity/node-test/` as committed — snapshotted to a temp dir first,
  because staging deletes the destination dirs before copying; the
  snapshot is removed in `finally`), `--node-src` overrides it with a
  24.20.0 source checkout; writes `node24-baseline-<module>.csv` and
  `node: "24.20.0"`. Both targets: child env gains
  `PARITY_TARGET_NODE=<target>` (explicit flag beats ambient env) — for 26
  this is the gate's default, so the 26 path is unchanged; for 24 it makes
  the run measure the down-versioned build (src/version-gate.js harness
  override), not the 26 build against v24 tests. `runOne`/`runPhase`
  parameters renamed `target` → `mod` (they carry the MODULE name for
  `PARITY_TARGET`; the old name shadowed the drift-target const — caught
  while editing, before any run). Invalid `--target` or `--node26-src`
  with `--target 24` exits 2 with a usage error.
  - Fix found by the smoke run (pre-existing, not mine): `--worktree .`
    (exactly what drift.yaml passes) made the memfs preflight mis-report
    "no usable node_modules" — `createRequire()` needs an absolute path
    and the relative join threw inside the try/catch. `--worktree` is now
    `resolve()`d at startup. One line; the file already imported `resolve`
    but never used it.
- `parity/drift/run-oracle.mjs` — `--target 24|26` (default 26).
  Target 26: unchanged (`--node26-src` + `--node26-bin`, headers from
  `<src>/test/parallel`, cwd `<src>`). Target 24: `--node24-bin`
  (24.20.0 binary) + vendored tree by default (headers from
  `parity/node-test/parallel`, cwd `parity/node-test/`); `--node-src` /
  `--node24-src` override the tree. Layout (`test/parallel` vs
  `parallel`) is detected from the directory itself, so an explicit
  `--node-src` pointing at either shape works. Output `node:` is the
  per-target version. Cross-target flags (`--node26-*` with 24 and
  vice versa) exit 2. Fix found by the smoke run (pre-existing shape):
  the layout detection ran before the usage check, so a missing
  `--node26-src` crashed with a TypeError instead of the usage error —
  validation now runs first.
- `parity/drift/export-diff.mjs` — NO CHANGE. It already diffs both
  versions in one run and writes both versioned JSONs
  (`exports-node24.20.0.json`, `exports-node26.13.1.json`) plus the one
  diff markdown. There is nothing target-parameterised left in it.
- `.github/workflows/drift.yaml` — second download/run block for target
  24: "Node 24 baseline" (`run-baseline.mjs --target 24`, no source
  download — stages the checkout's vendored tree) + "Native oracle
  (Node 24)" (`run-oracle.mjs --target 24 --node24-bin
  /tmp/node24/bin/node`; the 24.20.0 binary was already downloaded by the
  existing step). The 26 steps now pass `--target 26` explicitly.
  Artifact renamed `node26-drift` → `node-drift` and now includes
  `node24-baseline.jsonc`, `node24-oracle.json`, `/tmp/drift-csv-24/`.
  Workflow renamed "Node 26 Drift" → "Node Drift". Still informational
  only: never blocks merges, never commits.
- `NOTES-drift-detector.md` — new "Second target: Node 24 (`--target`)"
  section: exact invocations for both targets on both tools, the
  export-diff no-change note, the per-target flag re-probe note, the CI
  note. This is the tool's usage doc (there is no README under
  `parity/drift/`).
- `parity/drift/node24-baseline.jsonc` — NEW, produced by actually
  running the parameterised tooling for target 24 (see Counts below).
- `parity/drift/node24-oracle.json` — NEW, produced by running the
  parameterised oracle for target 24. Not strictly required by the
  brief, but the drift.yaml 24 block runs the oracle, so the block
  ships verified rather than assumed — and a baseline without an oracle
  is unclassified (a "fail" without the oracle can be a broken test,
  not a shim gap).
- NOT touched (deliberate): `parity/measured-rates.json`,
  `parity/HITLIST.md` (no banked numbers change in a fix PR — the docs
  sync follows separately; shape documented below), `src/` (no gate or
  shim change — the gate already exists from step 1), the capability
  matrix (rule 10), `parity/drift/export-diff.mjs` (see above).

## Exact invocations

Host: Node v24.22.1. Binaries: `~/workspace/local/node-24.20.0/bin/node`
(v24.20.0), `~/workspace/local/node-26/bin/node` (v26.13.1). Tree:
`~/workspace/local/node-26-src` (26.13.1 source). Worktree:
`~/workspace/worktrees/drift-target24` (branch `infra-drift-target24`,
base `0a6c9f19`, node_modules symlinked from
`~/workspace/bundleVFSModules-vite7`).

```sh
# Target 26 (regression check — output to the lane scratch dir, NOT /tmp:
# /tmp is wiped on runtime restarts. --out is NOT the checked-in path)
node parity/drift/run-baseline.mjs --target 26 \
  --node26-src ~/workspace/local/node-26-src \
  --worktree /home/hatch/workspace/worktrees/drift-target24 \
  --out /home/hatch/workspace/worktrees/drift-target24-scratch/drift-full-26.jsonc \
  --csv-dir /home/hatch/workspace/worktrees/drift-target24-scratch/drift-full-26 --jobs 2
node parity/drift/run-oracle.mjs --target 26 \
  --node26-src ~/workspace/local/node-26-src \
  --node26-bin ~/workspace/local/node-26/bin/node \
  --baseline /home/hatch/workspace/worktrees/drift-target24-scratch/drift-full-26.jsonc \
  --out /home/hatch/workspace/worktrees/drift-target24-scratch/drift-full-26-oracle.json --jobs 4

# Target 24 (produces the checked-in artifacts; --csv-dir in scratch, NOT /tmp)
node parity/drift/run-baseline.mjs --target 24 \
  --worktree /home/hatch/workspace/worktrees/drift-target24 \
  --out parity/drift/node24-baseline.jsonc \
  --csv-dir /home/hatch/workspace/worktrees/drift-target24-scratch/drift-full-24 --jobs 2
node parity/drift/run-oracle.mjs --target 24 \
  --node24-bin ~/workspace/local/node-24.20.0/bin/node \
  --baseline parity/drift/node24-baseline.jsonc --out parity/drift/node24-oracle.json --jobs 4
```

## Counts

- node26 regression: `~/workspace/worktrees/drift-target24-scratch/drift-full-26.jsonc`
  vs checked-in `parity/drift/node26-baseline.jsonc` (2,748 total: 2,144 pass / 575
  fail / 29 timeout; oracle 567 shim-gap / 32 fails-natively / 5
  native-timeout). The checked-in baseline is a **2026-11-19 snapshot**
  (worktree `6e3a1889`), BEFORE the Wave 1/2/4 lanes — so the re-run
  is NOT expected to be byte-identical. The regression criterion is
  per-test, not per-total: **zero pass→fail and zero pass→timeout
  flips** for tests present in both files; gains are enumerated and
  cross-checked against the wave banking in `measured-rates.json`
  (smoke proof: assert 13/14 and util 36/36 in the re-run match the
  banked node26 numbers exactly, vs 12/14 and 26/36 in the Nov 19
  snapshot). Coverage also grew since Nov 19 (PREFIXES fold-ins):
  async_hooks 36 → 48 files (12 `test-async-local-storage-*`),
  events 9 → 40 — new files are enumerated separately, not counted as
  flips. Header fields (`generated` date, `worktree` SHA) differ by
  construction and are excluded from the diff.
- **Full 26 re-run result (2026-11-25 ~00:00–02:00 UTC, exit 0, ~2.2h):**
  **2,324/2,814 pass, 423 fail, 67 timeout** (`drift-full-26.jsonc`,
  CSVs in `drift-full-26/`, log `drift-full-26.log`; restore clean;
  `oomKills: 1`). Vs the Nov 19 snapshot: 48 pass→fail/timeout
  regressions, 180 fail/timeout→pass gains, 66 new tests (48 pass,
  18 fail), 0 missing, 9 timeout↔fail changes. Vs the banked
  `measured-rates.json` node26 (2,373/2,814): 24/28 modules match
  banked EXACTLY; gaps are fs −44 (321 vs 365), repl −2 (98 vs 100),
  trace_events −1 (11 vs 12), zlib −2 (67 vs 69).
- **Adjudication (all 58 non-trivial changes re-run isolated, 2×,
  30s cap, then 60s cap for the survivors) — VERDICT: no regression
  from this lane.** `src/` diff vs origin/main is EMPTY (0 lines), so
  no deterministic failure in the re-run can be caused by this lane —
  the lane touched only `parity/drift/*`, `drift.yaml`, and NOTES.
  Per gap:
  - repl −2: BOTH proven load artifacts — `test-repl-history-navigation.js`
    and `test-repl-reverse-search.js` pass isolated [0,0].
  - trace_events −1: proven load artifact —
    `test-trace-events-worker-metadata-with-name.js` passes isolated [0,0].
  - zlib −2: BOTH proven parallel-run flakes — `test-zlib-zip-property.js`
    (exit 0, 2–4s isolated) and `test-zlib-zip-security.js` (exit 0, 4s
    isolated) pass under the shim; the Zip lane (PR #533) documents
    `zip-security.js` as failing ONLY in parallel runs (shared `.tmp.0`
    `refresh()` collision) and its serial run counted 69/89. The
    parallel full run counts 67–68; the banked 69 is the serial count.
  - fs −44 (45 timeouts): ALL explained as slow tests + load. 29 of the
    adjudicated fs items pass isolated at the 30s cap (2×); the
    remaining 19 pass isolated at the 60s cap except `test-fs-glob.mjs`
    (exit 1, was already fail in Nov 19 — not a pass regression).
    Isolated walls under load 4.6–8 run 4–28s (`test-fs-write-reuse-callback.js`
    22.7s, `test-fs-promises-file-handle-readFile.js` 27.6s) — the shim's
    cp/watch tests are genuinely slow, and the 10s run cap plus load
    6–15 (sibling step-3 lane sweeping concurrently) converts them to
    124s. Zero exit-1 fs pass-regressions.
  - The only genuine pass→fail set vs Nov 19 is stream
    `test-stream-iter-transform-{compat,errors,roundtrip,sync}.js`
    (exit 1, deterministic, isolated [1,1]) — but stream totals match
    banked EXACTLY (226/232), so these are banked-state fails from the
    stream iter-port wave, not a regression from this lane.
  - Non-pass either way (fail↔timeout churn, no pass lost):
    `test-repl-user-error-handler.js` (timeout→fail, exit 1),
    `test-fs-cp-async-socket.mjs` (fail→timeout, exit 1),
    `test-fs-glob.mjs` (fail→timeout, exit 1 at 60s),
    `test-inspector-ip-detection.js` (timeout→fail, exit 1 at 60s),
    `test-net-throttle.js` and `test-net-write-fully-async-hex-string.js`
    (fail→timeout, still 124 at 60s — genuinely hang under the shim),
    `test-net-write-fully-async-buffer.js` (fail in Nov 19, exit 137
    in the run, OOM-killed [-9,-9] isolated — memory pressure, not a
    pass regression).
  - Raw tool output is kept untouched (`drift-full-26.jsonc`); the
    adjudication results live separately in
    `drift-target24-scratch/adjudicate-26-redo-shard{0,1,2}.json` +
    `adjudicate-26-redo-round2.log`. The 26 oracle on the re-run
    baseline (`drift-full-26-oracle.json`, run-oracle `--target 26`,
    490/490 classified): shim-gap 448, fails-natively 37,
    native-timeout 5 (vs Nov 19's 567/32/5 — fewer shim-gaps because
    the re-run passes more).
  - **Adjudication worktree trap (lesson — cost a full redo):** the
    first adjudication round ran test files from a SEPARATE worktree
    (`adjudicate-26`) while using the drift worktree's preload. That
    measured the HOST, not the shim: `parity/preload.mjs` only
    redirects `require()` for importers under its OWN worktree's
    `parity/node-test/parallel/` (`testsDir` is computed from the
    preload's location), so every test in the other worktree fell
    through to host v24 builtins (e.g. `zlib.ZipEntry` undefined —
    the host has no Zip API — which briefly looked like a shim
    regression in `test-zlib-zip-property.js`). The void round's
    results were discarded; the redo staged the 26 tree into the
    drift worktree itself and re-ran all 58 tests correctly (PATH
    node v24.22.1, same binary the tool spawns). RULE: isolated
    re-runs must execute test files from the SAME worktree whose
    preload is imported — never a sibling worktree.
- **Load contamination (recorded 2026-11-25 ~00:05–00:20 UTC):** the
  sibling step-3 lane (`gate-fs-rmdir-base` worktree) ran its own fs
  sweep concurrently, driving load average to 6–11 on 1.5 shared CPUs
  during the fs module. fs phase 1 capped 286/385 tests at 10s (vs 29
  timeouts in the whole Nov 19 baseline) — a load artifact, not a
  shim result: the 10s/30s caps are wall-clock, so CPU starvation
  converts passes into 124s. Modules run before ~00:05 (assert,
  async_hooks, buffer, console, crypto — all matching banked numbers
  exactly) are clean. **Adjudication plan (repo precedent: the util
  row's "124 in-sweep is a load artifact — exit 0 isolated, twice"):**
  after each full run, every test recorded `timeout` is re-run in
  isolation (same harness invocation as `runOne`, 30s cap, 2×) once
  the load has subsided, and the JSONC takes the isolated exit. No
  timeout is banked on a contended run's word alone.
- node24 baseline artifact: `parity/drift/node24-baseline.jsonc`
  (`node: "24.20.0"`, generated 2026-11-25, 28 modules, 2,527 tests
  — exactly the `git ls-files` expectation). **2,113/2,527 pass, 379
  fail, 35 timeout** (full run 2026-11-25 ~03:11–04:28 UTC, exit 0;
  restore clean, 108 staged-only files removed; CSVs
  `drift-full-24/node24-baseline-<module>.csv`, 28 files). Per-module:
  assert 16/19, async_hooks 29/36, buffer 60/62, console 22/22,
  crypto 121/129, dns 8/31, events 9/9, fs 328/349, http 390/399,
  http2 90/277, https 58/67, inspector 38/75, module 30/32, net
  143/156, os 7/7, perf_hooks 15/15, process 92/97, readline 22/22,
  repl 94/102, stream 180/205, string_decoder 3/3, timers 45/45,
  trace_events 27/29, tty 3/3, util 29/31, vm 62/97, worker_threads
  140/143, zlib 52/65. Cross-checks against the banked v24 yardstick
  (top-level `modules`, 2,311/3,206 over 41 modules): util 29/31 and
  zlib 52/65 match banked EXACTLY (the two modules with clean
  per-module banked rows to compare against); the v24 tree holds only
  9 events files (the 26 fold-ins are not in the v24 tree), so events
  9/9 is complete coverage for this tree, not a shortfall. Load during
  the run rose to ~6–9 in the later modules (siblings active), so the
  35 timeouts carry the same load caveat as the 26 run — they are
  recorded as the tool measured them, not re-adjudicated (the 24
  artifact is a baseline, not a banked number; the docs sync takes it
  as-is).
- node24 oracle: `parity/drift/node24-oracle.json` (414/414 classified,
  exit 0): **shim-gap 381, fails-natively 27, native-timeout 6**.
  Entry shape `{mod, test, harnessExit, flags, nativeExit, class}`.
  The 26 oracle on the re-run baseline, for comparison
  (`drift-full-26-oracle.json`, scratch): shim-gap 448,
  fails-natively 37, native-timeout 5.

## Flag-support lists, measured per target (host v24.22.1)

The drop list is whatever the host rejects for the flags in THAT
tree's `// Flags:` headers — probed once per distinct flag by
`isFlagSupported` (exit 9 + "bad option" on stderr), never assumed.

- Target 26 (measured, host v24.22.1, from `drift-full-26.log` —
  exactly the brief's list): `--experimental-vfs`,
  `--experimental-web-worker`, `--js-immutable-arraybuffer`.
- Target 24 (measured, host v24.22.1, from `drift-full-24.log`):
  **the drop list is EMPTY — zero `flags: host rejects` lines in the
  whole run.** The v24 tree carries 358 `// Flags:` headers
  (`--expose-internals` ×157, `--experimental-stream-iter` ×41,
  `--expose-gc` ×30, `--experimental-vm-modules` ×21, …) and the host
  accepts every distinct flag the probe tried. None of the three
  26-era flags appears in the v24 tree at all (`--experimental-vfs`,
  `--experimental-web-worker`, `--js-immutable-arraybuffer` are
  26-only features) — which is why the 26 drop list does not transfer,
  exactly as the brief warned.

## measured-rates.json recording shape for a second build (docs sync writes this, NOT this PR)

A top-level `node24` key alongside `node26`, same per-module shape
exactly — `{ "date", "passed", "total", "source" }` per module, same
rules (parent-verified wave-end counts, never estimates; entries added
ONLY from actual runs). Example (field values illustrative — the docs
sync fills them from `node24-baseline.jsonc`):

```json
"node24": {
  "assert": {
    "date": "2026-11-24",
    "passed": 16,
    "total": 18,
    "source": "Node 24 baseline 2026-11-24 (parity/drift/node24-baseline.jsonc); <lane/provenance, same style as the node26 entries>."
  }
}
```

Scope notes for the docs sync:
- The `node24` key covers the SAME 28 drift modules as `node26`
  only. The 13 v24-only modules (child_process, cluster, dgram,
  diagnostics_channel, domain, path, querystring, sea, sqlite, tls,
  url, v8, wasi) have no node26 entry and get none under `node24`
  either — they already live under top-level `modules` (the v24
  yardstick, 2,311/3,206).
- The `_about` text currently describes only the `node26` object; the
  docs sync should extend it to name `node24` the same way (or leave
  it — the key is self-describing from its per-module `source`
  strings). Either way, that edit belongs to the docs sync, not this
  PR.
- `passed`/`total` come from `node24-baseline.jsonc` per-module
  counts (post-wave values replace the baseline values, exactly as
  the `node26` entries were updated by wave lanes). The baseline
  itself is the starting point, not the banked number.

## Gate differential probe (smoke, before the full runs)

`test-util-parse-env.js` (the step-1 datum case) proves
`PARITY_TARGET_NODE` flows through the harness per `--target`:
- `--target 24 --modules util`: v24 file PASSES (29/31 util; the 2
  fails are `test-util-inspect-proxy.js` + `test-util-inspect.js`,
  matching the banked v24 util 29/31).
- `--target 26 --modules util`: 26 file PASSES (36/36 util).
Same file, opposite expectations, both green — the target selects the
shim behaviour, not just the tree.

## `--node-src` override for target 24 (source-checkout layout path)

Validated after the full runs: the 24.20.0 `test/` tree extracted
from the source tarball (`node-v24.20.0.tar.gz`, scratch
`node24-src/node-v24.20.0/`, 79M) runs through `--target 24
--node-src <checkout> --modules util` → **29/31, identical to the
vendored-tree 24 util result**, restore clean (5,329 staged-only
files removed). This exercises the `treeDirs()` source-layout branch
for target 24, which the default (vendored flat-layout) runs do not.
Note: the FIRST attempt at this smoke crashed in the tool process
(ESM loader stack; the error text was lost — the run piped stdout
through `tail -5`, which also masked the real exit code as 0). Two
immediate retries with identical args passed cleanly (29/31 twice,
clean restores), so the crash is recorded as transient / not
reproduced, not as a code defect — but the loss of the error text is
a self-inflicted logging gap: always capture full tool output to a
log file, never pipe through `tail`.

## Ship

Merged as PR #562 (branch `infra-drift-target24`, code SHA `33c810a6d8450b8035d6aa7f5d6ba394c29ee62e`, merge `f084ca00`, 2026-11-25). CI green on the code SHA (build + Parity completed/success, verified via the check-runs API). No banked numbers change in this PR — the node24 baseline (2,113/2,527 pass, 379 fail, 35 timeout; oracle shim-gap 381 / fails-natively 27 / native-timeout 6) is recorded in `parity/measured-rates.json` under top-level `node24` by the docs sync (this PR).
