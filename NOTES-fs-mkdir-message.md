# NOTES-fs-mkdir-message.md — fs wave F1 lane 10 (mkdir message)

Base: main `5d6b0f71`. Branch: `fix/fs-mkdir-message`. Worktree:
`~/workspace/worktrees/fs-f1-mkdir-message`.

## Target

- `test-fs-mkdir.js`: 1 → 0 (isolated 2× on branch, exit 0, empty stderr).

## Fix 1 — `errInvalidArgType` / `errInvalidArgTypeProp` function rendering (src/fs.js)

Root cause: both legacy helpers formatted a function received value as
`type function (() => {})` via `String(received)`. Node's
`determineSpecificType` (lib/internal/errors.js:1023-1024, Node v24.20.0
source pack) renders functions as `` `function ${value.name}` `` — no "type"
prefix, no parens, so an anonymous arrow renders as `function ` (trailing
space). The test at :277 asserts exactly that via
`common.invalidArgTypeHelper`.

Change (both helpers, same shape): a `typeof received === "function"` branch
rendering `` `function ${received.name || ""}` ``. Deliberately minimal —
only the function branch changed; string/bigint/-0 rendering differences in
these legacy helpers are pre-existing Node divergences, out of scope for this
lane (the v24-exact `errArgType`/`_specificType` builder already exists for
newer code paths).

## Fix 2 — harness must not pre-create mkdir parents (parity/fs-harness.mjs)

The :277 fix unmasked a second failure at :376: recursive `mkdirSync` on a
fresh two-level path returned the full path instead of the first created
directory. Root cause is a harness/shim interaction, not the shim:

- `mkdirImpl` (src/fs.js) already computes the first created directory by
  walking the path and returning the first prefix `vol.statSync` misses.
- But the harness `wrapFn` → `syncArgs` runs FIRST and does
  `raw.mkdirSync(realPath.dirname(p), { recursive: true })` for every path
  under a sync root — creating the parent (`.../test35`) in memfs before the
  shim runs, so the walk finds it existing and returns the full path.
- The same pre-creation also broke non-recursive mkdir: probe-proven that
  `mkdirSync(missingParent/child)` (non-recursive) wrongly SUCCEEDED under
  the shim while native Node throws ENOENT.

Change: `syncArgs` skips the eager parent-chain creation for `mkdir` /
`mkdirSync` (same exception shape as the existing mkdtemp/mkdtempSync one).
The shim creates parents itself for recursive mkdir, and non-recursive mkdir
must fail ENOENT on a missing parent. `syncPath(p)` still runs (no-op for
new paths; syncs existing real-disk paths so EEXIST still works).

## Differential

- Target: `test-fs-mkdir.js` 1 → 0, isolated 2× on branch (exit 0, empty
  stderr both runs). Baseline on main `5d6b0f71`: exit 1 at :277 (message
  mismatch), then after Fix 1 alone exit 1 at :376 (first-created return).
- Guards: all 76 test files referencing `ERR_INVALID_ARG_TYPE` + 11
  mkdir-heavy extras (rm, readdir, open, write-file, copyfile, mkdtemp,
  mkdtemp-prefix-check, exists, stat, lstat, access), each run isolated once
  on the branch and diffed against the triage baseline CSV
  (`hidden_files/fast-sweep/fs-sweep-2026-11-15.csv`). Results:
  `hidden_files/fs-f1-mkdir-message-guards.txt`. 78 real files (one EXTRA
  name, `test-fs-lstat.js`, does not exist in the tree — ERR_MODULE_NOT_FOUND,
  not a failure): **0 regressions, exactly 1 flip (test-fs-mkdir.js)**. The
  two other non-zero guard exits are pre-existing at baseline 1:
  `test-fs-promises-readfile.js` (L2 target) and `test-fs-rm.js` (L5+L6
  target), both untouched by this lane.
- Repo suites on branch: `tests/fs.test.js` + `tests/fs_promises.test.js` +
  `tests/export_surface_fs.test.js` +
  `tests/export_surface_fs_promises.test.js` = 89/89 passed (4 suites);
  `tests/ondemand-require.test.js` = 29/29 passed.

## Ship

- Round 1 CI GREEN on code SHA 2b9b2d2d (base eca141cf); round 2 CI GREEN on
  0b2f975f (base ee0a2490) — both invalidated by sibling merges + dist-regen
  bot commits moving the head (merge race, not conflicts).
- Round 3 CI on e2f61233 (base 42f7bd56): Parity success, build failure at
  step "Build VFS" — proven transient: all three local build steps clean on
  the same tree (build-vfs exit 0, build-sandbox --check 0, build-runtime
  --check 0). Retriggered with this notes-only commit (round 4).

PR #452 / Merge SHA: ___ (filled at ship time)
