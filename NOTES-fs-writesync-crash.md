# fs lane 13 — writesync-crash (test-fs-writesync-crash.js)

Base: origin/main @ `5d6b0f71`. Branch: `fix/fs-writesync-crash`.
Target: `test-fs-writesync-crash.js` (exit 134 → 0). One test, harness-only fix.

## Mechanism (probe-proven, Node source grounded)

The test poisons `Object.prototype.errno` with a setter that throws a
specific Error object, then opens a file read-only and calls
`writeSync(fd, "test")`, asserting writeSync throws that exact object.

Native behavior (Node v24.20.0 source + probe):
- `writeSync` (lib/fs.js:944) calls the binding, then
  `handleErrorFromBinding(ctx)` (lib/internal/fs/utils.js:345), which throws
  `new UVException(ctx)`. The `UVException` constructor
  (lib/internal/errors.js:638) assigns every ctx property with plain JS
  assignments (`this[prop] = ctx[prop]`, including `errno`) — unguarded, so
  the poisoned setter throws the poison out of writeSync. Probe
  (/tmp/zz-probe-ws.js, native): writeSync throws the poison, same identity.
- The C++ side is the opposite: `node::UVException` constructs its error in
  C++ and `Set`s `.errno` via `FromJust` — a throwing setter makes the Set
  return Nothing and the process FATALS (`FATAL ERROR: v8::FromJust Maybe
  value is Nothing`). Uncatchable from JS. Probe (/tmp/zz-probe-abort.js,
  native): `lstatSync` on a nonexistent path under the poisoned setter →
  exit 134.

Shim failure, two stacked halves:
1. **Harness FATAL (the 134):** `syncPath` (parity/fs-harness.mjs:130) calls
   native `realFs.lstatSync(srcPath)` on the memfs-only path during
   `openSync` (test:34). The path is not on real disk, so lstatSync fails
   ENOENT — and constructing that ENOENT in C++ trips the poisoned setter
   and aborts the process before the shim runs. Reproduced on base:
   `FATAL ERROR ... node::UVException ... lstatSync (node:fs:1770:25) ...
   syncPath (fs-harness.mjs:130) ... test-fs-writesync-crash.js:34:12`.
2. **Shim side (already correct, no change needed):** `fs.writeSync`
   (src/fs.js:2477) calls `checkFdWritable(fd, "write")` BEFORE the
   try/enrichErr block; for the read-only fd it builds the EBADF error with
   `makeFsError` (which does NOT assign `.errno`) and then does the plain,
   unguarded assignment `err.errno = -9` (src/fs.js:1595) — the poison
   throws there and propagates out of writeSync, exactly like native
   `UVException`. Proved with an in-tree zz probe (deleted after use):
   `thrown===poison: true`. The brief's (b) — "shim lets the errno-assignment
   throw propagate" — was already satisfied; `enrichErr`'s swallowing
   try/catch is never reached on this path, so src/fs.js is untouched.

## Fix (parity/fs-harness.mjs only, +21/-1)

- `nativeErrorUnsafe()`: returns true when `Object.prototype` carries a
  setter for any property the C++ error constructor assigns
  (`errno`, `code`, `syscall`, `path`). Descriptor read only — the guard
  never INVOKES a setter (calling unknown user code to test it could have
  side effects).
- `syncPath` returns early when the guard fires, before `realFs.lstatSync`.
  Skipping the mirror is behaviorally identical in the common case: the
  lstatSync on a memfs-only path fails ENOENT and the existing
  `catch { return; }` path runs anyway ("the shim's own ENOENT stands").
  All other native calls in syncPath (`readlinkSync`, `readdirSync`,
  `readFileSync`) run only after a successful lstatSync, so the one guard
  point covers them. No other harness native call runs post-poison
  (module-top realFs calls run at import, before any test body poisons;
  `raw.*` calls are shim/JS calls).
- No legitimate code defines these setters (Object.prototype has none of
  them by default), so the guard never fires in normal operation. Grep of
  the fs suite: only `test-fs-writesync-crash.js` poisons `errno`.
- ponytail: ceiling — a poisoned setter on any OTHER property the C++
  constructor sets (e.g. `dest`) would still FATAL; no test in the suite
  poisons one.

## Differential

- Target `test-fs-writesync-crash.js`: base 134 (FATAL, stack above) →
  branch 0, 0, 0 isolated (2x in the loop + 1x split-stream run: exit 0,
  stdout 78 bytes = the test's own `console.log(tmpdir.path)`,
  stderr 0 bytes). Native: 0.
- Guards, all exit 0 on branch (15/15): write-sync, write,
  write-sync-optional-params, open, open-flags, chmod, error-messages,
  write-file-sync, write-file, write-stream, write-stream-err,
  append-file-sync, fsync, readfile, promises-file-handle-readFile.
  The two non-empty stderrs (error-messages 168B, write-stream-err 83B)
  are byte-identical to pristine base (only the PID in the warning line
  differs) — expected test output, not regressions.
- `test-fs-rm.js` (L5/L6 target, not this lane): still exit 1, unchanged.
- Repo suites: `tests/fs.test.js`, `tests/fs_promises.test.js`,
  `tests/export_surface_fs.test.js`,
  `tests/export_surface_fs_promises.test.js` — 89/89 pass.
  Footprint `tests/ondemand-require.test.js` — 29/29 pass.
- Results file:
  `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/fs-f1-writesync-crash-results.txt`

## Ship

- PR #___ / Merge SHA: ___ (filled at ship time)
- CI: waiter pinned to the code SHA (see template); green Parity + build
  required on the code SHA before squash-merge.
