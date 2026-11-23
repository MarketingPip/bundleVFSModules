# NOTES-26-harness-timers — timer-restore extension to cluster/dgram (lane L-HARNESS)

## Ship

- PR: [#553](https://github.com/MarketingPip/bundleVFSModules/pull/553) —
  `fix(parity): timer-restore harness for cluster/dgram sweep path`
- Branch: `takeback-harness-timers` (base `51ada62d`, code SHA
  `0fcfa33931bdca9d44c3f1a9c068954f8600d0b5`)
- Merge SHA: `db576b10af6f3ea0129d8f9451c1694e112b82c9` (squash-merge,
  merged 2026-11-23T10:45:53Z; confirmed `merged: true` by direct read;
  merge SHA verified an ancestor of `origin/main`, which now sits at
  `db576b10`)
- CI: Parity (Node official tests) completed/success on the code SHA
  (waiter `hidden_files/pr553-ci-wait.log`, FINISHED-GREEN 2026-11-23T10:43:17Z);
  build job: completed/success on the same SHA (direct read
  2026-11-23T10:46Z). No dist-regen head move (head stayed `0fcfa339…`).
- Files: `parity/cluster-harness.mjs` (new), `parity/dgram-harness.mjs`
  (new), `parity/preload.mjs` (+28), `parity/hooks.mjs` (+16). Zero `src/`
  changes (`git diff --stat` shows no `src/` files; +114/−0).

## Mechanism (proven, not inferred)

- `als-browser` patches the four timer globals at import
  (`node_modules/als-browser/dist/index.mjs:507` calls `patchAll()` at top
  level). Pulled in via `src/async_hooks.js:29` → `src/events.js:47` →
  `src/cluster.js:32` / `src/dgram.js:22`, while `src/http.js:24` imports
  bare `"events"` (why http passes). The test common's exit handler fails
  the run on `Unexpected global(s) found: setImmediate, setInterval,
  setTimeout, queueMicrotask`.
- The preload snapshots the originals (`parity/preload.mjs`,
  `__PARITY_ORIG_TIMERS__`); the `*-harness.mjs` files restore them after
  the shim loads. Fast-sweep never invoked a harness for cluster/dgram.
- Reproduction on current main `51ada62d` (worktree, before any change):
  `test-cluster-rr-ref.js` control exit 1, 2x (leak assertion in stderr);
  restore probe (post-load / fs-harness order) exit 0, 2x.
- Timer-identity probe: after importing the shim, all four timers differ
  from the snapshot for cluster.js and dgram.js (`same: false` × 4 each);
  for inspector.js and inspector/promises.js all four are unchanged
  (`same: true` × 4 each).

## Design — the REAL fix (no inspector harness, by evidence)

- Two new harness files mirroring `parity/tty-harness.mjs` exactly
  (import shim → restore timers from `__PARITY_ORIG_TIMERS__` → re-export
  everything + default). No second restore mechanism: the 7-line restore
  block is copied, as every existing harness does. Wired in both
  `parity/preload.mjs` (`polyfillPath`, CJS require path) and
  `parity/hooks.mjs` (`polyfillURL`, ESM import path — needed by the
  ESM-only `test-dgram-async-dispose.mjs`).
- **No inspector harness (deliberate):** `src/inspector.js` imports bare
  `"events"`, so it never pulls in als-browser — the timer-identity probe
  proves no patch happens, and the salvage restore probe leaves the two
  non-network inspector loss candidates at exit 1 (real shim behaviour:
  `post()` never rejects, no Network events). An inspector harness would
  be dead code. Inspector flips from this mechanism: 0 (proven, not
  assumed).
- `ponytail:` comments in both harness files + both wiring branches name
  the ceiling (restore repairs only the four timer globals' identity for
  the leak detector; als-browser also patches Promise/microtasks,
  EventTarget, XHR, observers, and those stay patched) and the upgrade
  path (a non-patching als-browser import in `src/async_hooks.js`).

## Flips — 31 verified 2x (not 21: the probe only covered loss candidates)

Banked (parent-verified, re-confirmed in `parity/measured-rates.json` on
live main `51ada62d`): cluster 4/83, dgram 1/80, inspector 38/75.

Full differentials on the branch vs pristine baselines
(`fast-sweep.py --target <mod> --jobs 2`, fresh CSVs, `--base` diff):

- cluster 4/83 → **22/83** (18 flips, 0 regressions, 0 mode-changes)
- dgram 1/80 → **14/80** full set (13 flips: 12 `.js` + the `.mjs`
  `test-dgram-async-dispose.mjs`, 0 regressions, 0 mode-changes)
- inspector 38/75 → **38/75** (0 flips, 0 regressions; one 1→124
  mode-change on `test-inspector-ip-detection.js` re-ran 1,1 on the branch
  and 1,1 pre-fix — a pre-existing flake, pass count identical)

The 9 flips beyond the probe's 21 (4 cluster + 5 dgram) are tests the
salvage probe never ran (it ran only the 18 + 10 loss candidates); they
fail on the same leak at baseline (exit 1) and pass with the restore.

### Cluster flips (18)

child-index-dgram, child-index-net, disconnect-unshared-tcp,
disconnect-unshared-udp, disconnect-with-no-workers, fork-windowsHide,
listen-pipe-readable-writable, rr-domain-listen, rr-handle-keep-loop-alive,
rr-ref, setup-primary-argv (*), setup-primary-cumulative (*),
setup-primary-emit, setup-primary-multiple, uncaught-exception (*),
worker-constructor (*), worker-handle-close, worker-wait-server-close
(* = beyond the probe's 14)

### Dgram flips (13)

bind-socket-close-before-lookup, bind (*), close-signal (*),
cluster-bind-error, cluster-close-during-bind, cluster-close-in-listening,
listen-after-bind (*), ref, send-invalid-msg-type (*), sendto (*),
unref-in-cluster, unref, async-dispose.mjs (ESM)
(* = beyond the probe's 7)

### Verification record

- All 30 `.js` flips: exit 0 in the branch sweep AND in a targeted
  2nd run through the real harness path (`/tmp/harness-lane/verify2x.log`).
  The 21 probe tests are verified 3x (probe + sweep + targeted).
- `test-dgram-async-dispose.mjs`: pre-fix 1,1 (pristine worktree) →
  post-fix 0,0.
- `test-inspector-wait.mjs` / `test-inspector.js` (off-glob files):
  0,0 pre-fix and 0,0 post-fix — accounts for banked inspector 38/75
  (36 `.js` + these 2).
- Baselines (pristine `51ada62d` worktree): cluster 4/83, dgram 1/79
  (`.js` only; + `.mjs` fail = 1/80), inspector 36/73 (`.js` only;
  + 2 off-glob passes = 38/75). CSVs in `/tmp/harness-lane/`
  (`*-base-51ada62d.csv`, `*-branch-takeback-harness.csv`).

## Guards

- Repo jest (affected modules + footprint):
  `tests/cluster.test.js tests/dgram.test.js tests/inspector.test.js
  tests/export_surface_{cluster,dgram,inspector,inspector_promises}.test.js
  tests/ondemand-require.test.js` — 8 suites, 134 tests, all pass
  (`NODE_OPTIONS=--experimental-vm-modules`).
- CI parity loop (`node parity/run.mjs` × 6): path, punycode, querystring,
  string_decoder exit 0; events + assert exit 1 on the branch AND
  identically on pristine main (same newly-passing list for events, same
  new failure `test-assert-deep.js` for assert — the known host-Node
  24.22.1 vs CI-pinned 24.20.0 artifact, Gen 0 audit §7). The harness
  change breaks nothing else.

## Limits (do not over-claim)

- Inspector network tests (3× 124) were not re-run with the restore probe
  (hang is by mechanism — no Network events are ever emitted).
- The 4 remaining cluster losses (advanced-serialization,
  disconnect-idle-worker, disconnect-leak, invalid-message) fail on
  fabricated-lifecycle assertions, not the leak — deliberate-honesty
  deltas, out of scope.
- `test-dgram-bind-socket-close-before-cluster-reply.js` still hangs (124)
  with the restore: the bind waits for a cluster reply that never arrives.
