# NOTES-fs-rm-async-root — skip the tmpdir root in #455 deletion propagation

## Lane
Follow-up to the rm-async lane (PR #455, merge `5322dce5`). Target:
`test-fs-readdir-recursive.js` ONLY.

## Regression (parent-diagnosed, verified in-lane before fixing)
- `test-fs-readdir-recursive.js`: 1 on live main `5322dce5` (4/4 isolated,
  EACCES on unix-socket `listen` for
  `parity/node-test/.tmp.0/node-test.<pid>.sock`), 0 on the pre-#455 tree
  `82d117de` (3/3 isolated). After a failing run the real `.tmp.0` directory
  was gone; after a passing run it existed.
- Mechanism (read from source, not guessed): `deleteRealPath` in
  `parity/fs-harness.mjs` (#455) allows `p === tmpdir` — its guard only
  excludes paths *outside* the tmpdir. `tmpdir.refresh()` (Node
  `common/tmpdir.js:43-45`) does `rmSync(tmpPath)` then `mkdirSync(tmpPath)`.
  The rmSync went through `wrapFn` → `deleteRealPath(tmpPath)` →
  `realFs.rmSync(tmpPath, { recursive: true, force: true })`, deleting the
  REAL tmpdir root; the mkdir recreated it in memfs only. The test's native
  `net.createServer().listen(PIPE)` then bound a socket in a directory that
  no longer existed on real disk → EACCES.

## Fix (`parity/fs-harness.mjs` only, +9 lines)
`deleteRealPath` returns early when `realPath.resolve(p) === tmpdir` — the
tmpdir root itself is never propagated to real disk. File and subdirectory
deletions inside the root still propagate (the #455 fix is untouched).
`ponytail:` comment names the ceiling: if a test ever needs the real root
itself gone, re-create it on real disk after the memfs mkdir instead.

## Differential (isolated, branch at `5322dce5` + fix)
- Flip: `test-fs-readdir-recursive.js` 1 → 0 (isolated 2×, exit 0, empty
  stderr). Real `.tmp.0` survives the run.
- `test-fs-rm.js` (the #455 flip) still 0 (isolated 2×) — the root carve-out
  does not break the rm.js fix.
- Guards, all 0 isolated: `test-fs-rmdir-recursive`, `test-fs-mkdir`,
  `test-fs-readdir`, `test-fs-promises-file-handle-close`,
  `test-fs-utils-get-dirents`, `test-fs-watch-encoding`.
- Repo suites: `fs` + `fs_promises` + `export_surface_fs` +
  `ondemand-require` 117/117 (footprint 29/29 inside that run).

## Ship
- PR #___ / Merge SHA: ___ (filled at ship time)
