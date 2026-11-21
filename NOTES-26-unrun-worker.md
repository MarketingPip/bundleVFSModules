# Node 26 Wave 4 — WORKER-DIAGNOSTICS triage

Worktree: `~/workspace/worktrees/w4-worker` (detached HEAD 6e4e6370)
Date: 2026-11-21. Host node for shim runs: v24.22.1. Oracle node: 26.13.1
(`~/workspace/local/node-26/bin/node`).

## Per-file table

| File | Oracle (native Node 26.13.1, no preload) | Baseline (shim, `--import <worktree>/parity/preload.mjs`, `PARITY_TARGET=worker_threads`, host v24.22.1) | Classification + reason |
|---|---|---|---|
| `test/parallel/test-diagnostics-channel-worker-threads.js` | PASS, exit 0, 60 s timeout | PASS, exit 0 — run 1 and isolated re-run (exit 0 twice) | **PASS already** — passes under a correct harness invocation (isolated, no `// Flags:` header in file, right host). No gap. |

## Evidence

- File count verified: `ls test-diagnostics-channel-worker-*` in
  `~/workspace/local/node-26-src/test/parallel/` returns exactly 1 file:
  `test-diagnostics-channel-worker-threads.js` (11 lines, no `// Flags:`
  header — first lines are `'use strict'; const common = require('../common');`).
- Test body: `dc.subscribe('worker_threads', common.mustCall(...))` then
  `new Worker('const a = 1;', { eval: true })`. Asserts the published
  `worker instanceof Worker`.
- Staging per method: file copied to `parity/node-test/parallel/`,
  `parity/node-test/common/` replaced with Node 26 `test/common/` (v24
  common backed up to `/tmp/w4-worker-common-v24`), run, then restored.
  Restored `common/` verified byte-identical (`diff -r` clean);
  `git status` clean except pre-existing `?? node_modules` symlink;
  `git diff --quiet` clean. Staged file was new (not tracked in v24 tree),
  so no tracked file was at risk; it was removed after the runs.
- Why the pass is structural, not a flake (source-grounded):
  - Node source pack `lib/internal/worker.js:104-105,378-379`: the native
    `Worker` constructor publishes `{ worker }` to
    `dc.channel('worker_threads')` when it has subscribers.
  - `src/worker_threads.js`: under real Node the shim's `Worker` is a
    subclass of the native `Worker`, so `super()` runs the native
    constructor and the publish fires.
  - `diagnostics_channel` is NOT redirected (`PARITY_TARGET=worker_threads`
    only), so the test's `require('diagnostics_channel')` is the native
    host module — the same channel instance the native Worker publishes to.
    The shim's own `src/diagnostics_channel.js` is not exercised by this
    test at all.
- No fresh web research used. No code changes, commits, pushes, or PRs.

## Group totals (of 1)

- Pass already: **1**
- Flippable: 0
- NO-FIX: 0
- Not-a-gap: 0

Net effect on the gap count: this test leaves the gap count (was never run,
now passes under the shim — it was not a gap).
