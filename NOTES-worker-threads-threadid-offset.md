# worker_threads threadId offset — W-A

Fixes `test-worker-event.js` and `test-worker-messaging.js` (and, unexpectedly,
`test-worker-name.js`) by skipping the ESM hooks registration for CJS-entry
processes under the `worker_threads` target.

## Root cause (probe-proven)

`module.register()` spawns a loader-hook worker thread to run the hooks
(Node `lib/internal/modules/esm/hooks.js`: `AsyncLoaderHookWorker`, one hooks
thread per non-hooks thread). That thread takes the next threadId, so every
`register()` shifts all later worker IDs by one — and every thread that runs
the preload registers again, so the shift compounds per thread:

- No preload: first three workers get IDs `1, 2, 3`.
- Empty `--import`: `1, 2, 3` (no offset — the preload file itself is innocent).
- Register-only `--import`: `2, 4, 6` (register alone is the consumer).
- Full preload (`PARITY_TARGET=worker_threads`): `2, 4, 6`.
- Fixed preload: `1, 2, 3`.

`test-worker-event.js:10` asserts the spawned worker's `threadId` equals
`parentThreadId + 1` (= 1); under the preload it was 2. `test-worker-messaging.js`
builds a 7-thread tree and derives each thread's level from
`source - mainThread`, so every level was wrong.

## Fix (`parity/preload.mjs` only)

Gate `register()` on `entryPointNeedsEsmHooks()` for the `worker_threads`
target — CJS entries skip register, `.mjs` entries still register:

```js
const needsEsmHooks = entryPointNeedsEsmHooks();
const skipRegisterForWorkerThreads =
  target === "worker_threads" && !needsEsmHooks;
if (
  workersAllowed &&
  !(isForkedChild && !needsEsmHooks) &&
  !skipRegisterForWorkerThreads
) {
  register("./hooks.mjs", import.meta.url);
}
```

The skip is safe for this target only:

- `src/worker_threads.js` imports just `"./_cloak.js"` — extension present,
  resolves natively in the ESM loader, no hooks needed.
- No worker test uses dynamic `import()` (grep-verified across all 144).
- No worker test `require()`s a `.mjs` file.
- `.mjs` entries (the 4 `.mjs` tests; workers spawned from `.mjs` fixtures
  `worker-script.mjs`, `worker-data.mjs`, `import-process-exit.mjs`) still
  register — `entryPointNeedsEsmHooks()` returns true for `.mjs`.
- CJS entries (all `.js` tests under `parity/node-test/package.json`,
  `"type": "commonjs"`) skip in the main thread AND in spawned workers
  (`new Worker(__filename)`), so the whole tree gets native IDs.
- `new Worker("", { eval: true })` (event test) has no `argv[1]` →
  `entryPointNeedsEsmHooks()` returns true → the eval worker registers, but
  its ID is already assigned, so the assertion is unaffected.

Other targets are untouched: the gate is `target === "worker_threads"` only,
same shape as `isFsHelper`/`isNetHelper`. A global gate was NOT taken —
other shims rely on the hooks for extensionless relative imports
(e.g. `src/repl.js` → `"./readline"`), and CJS-entry tests in other modules
may dynamically import ESM. If a future worker_threads test needs ESM
redirects from a CJS entry, that test needs its own carve-out, not a global
re-register (which would re-take ID 1).

NOT in `src/`: threadId compensation in the shim would be a fake (repo
rule 7). The IDs are now real.

## Triage correction (probe-proven)

The triage classified `test-worker-name.js` NO-FIX ("even with the offset
fixed, the inspector title path does not work under the harness"). WRONG —
with the offset fixed it passes `[0,0]` on the branch (and `[1,1]` on base).
The test expects the inspector title `[worker 1] Hello\0Thread`
(`test-worker-name.js:18`); under the preload the worker was `[worker 3]
WorkerThread`. Once the ID is 1, the title matches — the name option was
never broken, only the ID was. The triage's NO-FIX for `name` is superseded;
the inspector NO-FIX stands only for `test-worker-debug.js` (Session attach
hang, exit 124).

## Verification (branch head, worktree `wa-threadid-offset`)

- Flips 2× isolated, exit 0: `test-worker-event.js`, `test-worker-messaging.js`,
  `test-worker-name.js` (3rd flip, above). Base re-check: name `[1,1]` on
  `fbcc674e` without the fix.
- Full worker_threads differential (`sweep-mjs.py`, updated runner with
  absolute `--import`, 144-file list):
  `worker-threads-wa-branch.csv` — **141/144** (pass 141, timeout 1, fail 2)
  vs post-W-B base `worker-threads-sweep-2026-11-18-absimport.csv` (138).
  Diff: exactly the 3 flips above, **0 regressions**.
- Remaining 3: `test-worker-debug.js` (124, inspector Session — NO-FIX),
  `test-worker-message-port-inspect-during-init-hook.js` (1, ESM-loader entry
  path — NO-FIX), `test-worker-process-env.js` (1, register()/leak detector —
  NO-FIX; still fails with the fix, so the leak is not (only) the hooks
  thread — residual unknown from triage stands).
- Guards: repl sweep on branch head (`repl-wa-guard.csv`) 95/101, sorted CSV
  IDENTICAL to the wave-end sweep (`repl-sweep-2026-11-18-wave-end.csv`) —
  no cross-module movement. `test-worker-process-cwd.js` still 0,
  `test-worker.js` still 0 (in the branch sweep).
- Footprint test `tests/ondemand-require.test.js`: 29/29 green.
- `node --check parity/preload.mjs` clean.

## Count

Banked 138/144 (parent-verified post-W-B) + 3 flips verified 2× on live main
− 0 regressions = **141/144**. Remaining NO-FIX: 3 (debug, message-port-inspect,
process-env).

## Ship

- PR #479 / merge SHA 96682075 (squash-merged 2026-11-18)
