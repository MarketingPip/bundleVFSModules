# NOTES-fs-realpath-native.md — fs wave F1 lane 9 (realpath.native)

## Target
- `test-fs-realpath-native.js`: 1 → 0 (isolated 2×, empty stderr).

## Mechanism
`fs.realpathSync.native('./test/parallel/test-fs-realpath-native.js')` must
equal `__filename`. At the repo root `test/` is a symlink →
`parity/node-test` (same inode) — native realpath resolves it; the shim's
`realpathImpl` (src/fs.js:6040) resolves in memfs → ENOENT. The test calls
ONLY the `.native` variants (sync + async, and the async callback asserts
`this === undefined`).

## Fix (harness-only, `parity/fs-harness.mjs`, +33 lines)
`.native` IS the native implementation in Node, so in the harness it resolves
against the REAL disk: after `wrapInPlace(shimFs)`, override
`shimFs.realpath.native` / `shimFs.realpathSync.native` to delegate to
`realFs.realpath` / `realFs.realpathSync`, falling back to the shim's memfs
`.native` (captured before the override) when realFs throws ENOENT.

The fallback is load-bearing, not belt-and-braces: `test-fs-realpath.js`
runs every subtest through `.native` too, on tmpdir entries that exist only
in memfs (fixtures are created via the shim). A blanket realFs delegation
would regress it. The fallback keeps those green while real-disk paths
resolve natively. Only ENOENT falls back — a path present on real disk with
different symlink structure would answer from real disk (correct: that IS
the native answer).

## Guards (all exit 0 on the branch)
- test-fs-realpath, test-fs-realpath-buffer-encoding, test-fs-realpath-pipe,
  test-fs-realpath-on-substed-drive, test-fs-error-messages (`.native` on a
  nonexistent file still throws the shim ENOENT with syscall `realpath`),
  test-fs-symlink, test-fs-symlink-buffer-path.
- test-fs-long-path.js is Windows-only (skipped on Linux); tests/fs.test.js
  imports src/fs.js directly, not the harness — unaffected.
- Repo suites: tests/fs.test.js 61/61, tests/ondemand-require.test.js 29/29.
- `test-fs-readlink` does not exist (exit 1 is ERR_MODULE_NOT_FOUND on base
  AND branch — filename trap, not a regression).

## Ship
- PR #___ / Merge SHA: ___ (filled at ship time)
- Differential: `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/fs-f1-realpath-native-results.txt`
