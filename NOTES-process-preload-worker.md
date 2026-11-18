# NOTES-process-preload-worker.md — L2+L3: preload `Module.register` handling

## Mechanism

`parity/preload.mjs:654` called `register("./hooks.mjs", import.meta.url)`
unconditionally, spawning an ESM hooks worker thread in every process that
loads the preload — including processes that never need ESM redirects.

- **L2** (triage, probe-proven): the execve-permission tests respawn
  themselves with `--permission` flags (execArgv forwarded, so the child
  loads the preload). Under `--permission` without `--allow-worker`, worker
  creation is denied and `register()` throws `ERR_ACCESS_DENIED`
  (`permission: 'WorkerThreads'`) at preload load, before any test code
  runs. Native runs pass (no preload).
- **L3** (triage, proven by bisection, not by timing): the hooks worker is a
  live thread in every preloaded process, including forked children (which
  inherit it via `process.execArgv`). In the forked child of
  test-process-external-stdio-close, the live worker deterministically flips
  console's async write-error ordering so the EPIPE protection in Node
  source `lib/internal/console/constructor.js:303-325, 383-402` loses the
  race and the `write EPIPE` error is uncaught (exit 1 instead of 0). Bare
  `new Worker(...)` alone reproduces it 3/3; empty/marker-only `--import`s
  do not.

## Fix shape (`parity/preload.mjs` only)

The final `register(...)` call is now conditional:

1. **Workers allowed?** `process.permission?.has('worker')` — `false` under
   `--permission` without `--allow-worker` (probe-verified on host Node
   v24.22.1: `false` without the flag, `true` with it; `process.permission`
   is `undefined` when the permission model is off, so the check defaults
   to "allowed"). When workers are denied, skip `register()`; the CJS
   redirect in the preload still works, and the execve tests are CJS.
   Grounded in Node v24.20.0 source
   `lib/internal/process/permission.js:23-34` (`has(scope, reference)`).
2. **Forked CJS child?** `typeof process.send === 'function'` (probe-verified
   visible at preload time in a forked child) AND the entry point
   (`process.argv[1]`) is CJS → skip `register()`. Entry-type check mirrors
   Node's own `.js` resolution: `.mjs` → ESM, `.cjs` → CJS, `.js` →
   nearest `package.json` `"type"` (default commonjs; the vendored tree is
   `"type": "commonjs"` under `parity/node-test/`). Default is to register
   (current behavior) whenever the type cannot be established, so a forked
   child that genuinely needs ESM redirects is unaffected. A package.json
   unreadable for a reason other than "absent" (e.g. permission-denied
   read) also defaults to registering.

`ponytail:` ceiling — a CJS forked child that later dynamically imports an
ESM module needing a redirect will not get one; restoring hooks lazily is
impossible because `register()` must precede the import. No forked child in
the process suite does this (survey: only external-stdio-close and the two
redirect-warnings tests fork, all CJS `.js` entries; the three `.mjs` tests
use spawn, not fork, so they never see `process.send`).

## Differential (branch, worktree `process-p2-preload-worker` @ `8ed96c8d`)

Targets, 2× isolated each on branch (base all exit 1):

| test | base | branch run 1 | branch run 2 |
|---|---|---|---|
| test-process-execve-permission-fail.js | 1 | 0 | 0 |
| test-process-execve-permission-granted.js | 1 | 0 | 0 |
| test-process-external-stdio-close.js | 1 | 0 | 0 |

Full process `.js` sweep on branch
(`hidden_files/fast-sweep/process-sweep-2026-11-18-p2.csv`, fast-sweep
`--target process --force --jobs 2`, 94 rows, 0 missing): **86 pass / 8
fail**, vs triage base 83/94. Diff of the sorted CSVs shows exactly the
three flips above (1→0) and no other changed line — zero regressions.
`.mjs` sidecar on branch
(`process-sweep-2026-11-18-p2-mjs.csv`, 3 rows): 0/3, identical to triage
base — all three fail on base for other lanes' reasons (get-builtin.mjs
L1, finalization/warnings.mjs L4).

Guards (ESM redirect must survive):

- zz probe `zz-process-esm-redirect.mjs` (`import 'node:process'` under
  `PARITY_TARGET=process` resolves to the shim,
  `versions.node === '0.0.0-shim'`): PASS 2×.
- zz probe `zz-process-fork-esm.mjs` + child `zz-process-fork-esm-child.mjs`
  (forked `.mjs` child imports `node:process`): child exit 0, PASS 2× —
  hooks are NOT dropped for a forked child that genuinely needs them.
  (Probes deleted after use.)
- `test-process-get-builtin.mjs` exits 1 on branch AND on base (identical
  failure output) — pre-existing L1 failure, not a regression.
- Cross-module guard: `test-net-listen-handle-in-cluster-2.js`
  (`PARITY_TARGET=net`, forked CJS cluster workers) exit 0 on branch.
- Footprint test `tests/ondemand-require.test.js`: 29/29 locally.

## Ship

- PR #___ / Merge SHA: ___ (fill at ship time)
- Branch: `fix/process-preload-worker`; files: `parity/preload.mjs`,
  `NOTES-process-preload-worker.md`.
