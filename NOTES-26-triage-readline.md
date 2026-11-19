# NOTES — Node 26 triage: readline (1 gap → 0 true gaps)

- Base: `3c091022` (drift detector #505). Node 26.13.1 verified
  (`~/workspace/local/node-26/bin/node --version` → `v26.13.1`) before any probe.
- Banked (parent-verified, not recomputed): readline 1 non-pass, classed
  shim-gap, 0 fails-natively, 0 native-timeout (gaps-readline.json).
- **Verdict: the single gap is a baseline misclassification. True readline
  shim-gap on Node 26 is 0. No lanes, no NO-FIX.**
- v24 close: readline 22/22 (100%). Node 26 has the same 22
  `test-readline*` files; 21 pass in the baseline, 1 is the artifact below.

## The gap

### test-readline-promises-csi.mjs (1) — baseline artifact, NOT a shim gap

- Failure (isolated re-run, baseline invocation — no flags):
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'internal' imported
  from .../test-readline-promises-csi.mjs`, at `parity/hooks.mjs:209`.
- Cause: the test imports `internal/readline/utils` (test:12,
  `import utils from 'internal/readline/utils'`) and carries the header
  `// Flags: --expose-internals` (test:1). ESM `internal/...` imports only
  resolve with `--expose-internals`. The baseline runner
  (`parity/drift/run-baseline.mjs` `runOne`, mirroring `fast-sweep.py`
  `run_one`) passes NO flags — confirmed by reading both runners — so the
  test cannot resolve its import and fails before any assertion runs.
- Probe (same harness invocation, flag added — the only change):
  `PARITY_TARGET=readline timeout 30 node --expose-internals --import
  <worktree>/parity/preload.mjs parity/node-test/parallel/test-readline-promises-csi.mjs`
  → **exit 0**. The CSI surface (`clearScreenDown`, `clearLine`,
  `moveCursor`, `commit`/`rollback`, the `ERR_INVALID_ARG_TYPE`
  constructor checks) all pass under the shim once the test's own declared
  flag is honoured.
- The test file itself is formatting-only vs v24 (quote style + line
  wrapping; tokdiff shows no semantic change), and `lib/readline.js` is
  byte-identical between the v24.20.0 source pack and Node 26.13.1
  (`diff -q` clean). Nothing in the module changed; only the runner's
  flag handling misclassifies it.
- The oracle agrees in the other direction: nativeExit 0 under Node 26
  (the oracle passes the Flags header for native runs).

## Families

None — the module has no gap families on Node 26. (For the record: the
only other readline-adjacent Node 26 lib change is in
`lib/internal/readline/{emitKeypressEvents,interface}.js`, which no
readline gap test exercises; the 21 passing tests cover the rest.)

## Lane candidates

None. There is no shim work to propose for readline on Node 26.

## NO-FIX list (0)

None.

## New-in-26 vs pre-existing

- Pre-existing: 0. New in 26: 0. The 1 banked gap is a runner artifact,
  not a module change.

## Baseline corrections

1. **`test-readline-promises-csi.mjs` must be reclassified from shim-gap
   to harness/flags artifact.** With its declared `--expose-internals`
   flag it passes under the harness (exit 0, probed). The baseline runner
   should pass each test file's `// Flags:` header (the oracle already
   does) — until then, any flagged test that fails only on import
   resolution is suspect. For repl, the four flagged gaps were re-probed
   WITH flags and still fail, so this correction is isolated to this one
   test (see NOTES-26-triage-repl.md, Baseline corrections §2).
2. Corrected module totals for the coordinator: readline true shim-gap
   **0** (banked 1), readline 22/22 on Node 26 with flags honoured.
   Overall true shim-gap drops by 1 on this correction alone (566 → 565,
   before the repl nested-repls correction in NOTES-26-triage-repl.md).

## Work notes

- Method: Node 26 test tree staged into `parity/node-test/` (as
  `parity/drift/run-baseline.mjs` stages it), isolated re-runs as
  `timeout 30 node --import <worktree>/parity/preload.mjs
  parity/node-test/parallel/<test>` with `PARITY_TARGET=readline`,
  then restored (`git status --porcelain -- parity/node-test` = 0).
- Export surface: no change (parity/drift/node26-export-diff.md:
  readline 0). Changelog cross-check: readline "no change found".
