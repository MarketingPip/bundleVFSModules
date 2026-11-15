# NOTES-fs-rm-lstat — fs wave F1 lane 5 (rm lstat syscall)

Base: main `5d6b0f71`. Target: `test-fs-rm.js` (exit 1). Triage L5.

## What real Node does (grounded, not guessed)

`lib/fs.js` `rm`/`rmSync` validate through `lib/internal/fs/utils.js`
`validateRmOptions` / `validateRmOptionsSync` (lines 810–882), which **lstat
first**:

- lstat error: `force && ENOENT` → no error; otherwise the lstat error itself
  propagates (syscall `lstat`). A directory with `!recursive` → `ERR_FS_EISDIR`
  with syscall `rm`.
- `rmSync` then calls the C++ `binding.rmSync`; async `rm` runs the JS rimraf
  (`lib/internal/fs/rimraf.js`), which also lstats first and unlinks
  non-directories.

## What was wrong

The shim's `checkRm` probed existence with `vol.statSync` (follows links) and
then delegated to memfs's `rmSync`/`rm`, which **stat** the top-level path:

- Missing target: memfs throws ENOENT with syscall `stat` in the message;
  `enrichErr` canonicalized it to `rm`. Real Node reports `lstat`.
- Dangling symlink: memfs `rmSync` throws ENOENT (probe-proven).
- Symlink to a directory: memfs `rmSync` throws `ERR_FS_EISDIR` (probe-proven).
  Real Node unlinks the link.

## Fix (`src/fs.js` only, +40/−12)

- `checkRm`: `statSync` → `lstatSync`. On lstat ENOENT with `!force`, throw a
  `makeFsError("ENOENT", "lstat", ps, "no such file or directory")` with
  `err._syscallOverride = "lstat"` (the sticky override `enrichErr` already
  honors, so the canonical `rm` rewrite cannot undo it). `force + ENOENT`
  falls through — memfs `rmSync` with `force` no-ops, matching Node. The
  EISDIR gate now keys on the lstat result, so a symlink to a directory is
  unlinked, not rejected. `checkRm` returns the lstat stats for dispatch.
- `rmSync`/`rm` wrappers: when the lstat stats say symbolic link, unlink the
  link itself (`vol.unlinkSync` / `vol.unlink`) instead of memfs `rmSync`/`rm`.
  Everything else still delegates to memfs (recursive tree removal included —
  memfs handles dangling/loop symlinks inside a tree, probe-proven).

Ceiling (`ponytail:` in `checkRm`): lstat-first covers the top-level path
only; errors raised mid-walk inside a recursive removal still surface with
memfs's syscall surface (canonicalized to `rm` by `enrichErr`). A fully
lstat-faithful recursive walk would need the shim to walk the tree itself
(like `rmdirRecursiveSync`) instead of delegating to memfs.

## Differential

In-tree zz probe (`zz-rm-lstat.js`, 14 cases, deleted after use) — all 14 now
match real Node exactly (base: 6 mismatches, all `syscall=rm` instead of
`lstat`, plus dangling-symlink ENOENT and symlink-to-dir EISDIR):
rmSync nonexistent / nonexistent-force / nonexistent-force-recursive /
gone-dir / non-empty-no-recursive (EISDIR, syscall rm — unchanged) /
dangling-symlink / symlink-to-dir / file; async rm gone-dir / nonexistent /
nonexistent-force; promises rm nonexistent / gone-dir / nonexistent-force.

Full file `test-fs-rm.js` (isolated, 2x): still exit 1 — but the ONLY remaining
failure is now the `validateRmOptionsSync` block at test:498 (native
`internal/fs/utils` lstat on a memfs-only file → ENOENT). That is **lane 3's**
territory (needs the `internal/fs/utils` redirect + shim port); with git on
PATH the file fails earlier at the git block (test:235, `git init` spawnSync
ENOENT) — **lane 6's** territory. This lane's half is done; the flip banks
after L6 + L3 land (parent verifies).

Guards (branch, 1x each, all 0): rmdir-recursive, rmdir-recursive-sync-warns-
not-found, rmdir-recursive-sync-warns-on-file, rmdir-recursive-throws-
not-found, rmdir-recursive-throws-on-file, rmdir-recursive-warns-not-found,
rmdir-recursive-warns-on-file, rmdir-type-check, symlink, symlink-buffer-path,
symlink-dir, mkdir-rmdir, unlink-type-check. `test-fs-mkdir` exits 1 on branch
AND on pristine base (identical failure, `validateMkdirOptions` boolean
message — lane 10 territory, pre-existing, not a regression).

Repo suites (branch): `tests/fs.test.js` + `tests/fs_promises.test.js` +
`tests/ondemand-require.test.js` — 116/116 pass (incl. footprint 29/29).

## Ship

- PR #___ / Merge SHA: ___ (filled at ship time)
