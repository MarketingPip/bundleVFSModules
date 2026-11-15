# NOTES-fs-internal-utils — fs wave F1 lane 3 (triage L3)

## Target tests (both exit 1 on base `5d6b0f71`, both exit 0 on this branch)

- `test-fs-utils-get-dirents.js` — native `getDirent` lstats the real-disk
  path; the fixture lives only in memfs → ENOENT at test:85.
- `test-fs-watchfile-bigint.js` — deepStrictEqual: actual `Stats {
  blksize: 4096n, ... }` vs expected `BigIntStats { blksize: 0n, ... }`
  (wrong class AND wrong blksize for the zero stat).

## Fix (3 files)

1. **`parity/preload.mjs`** — CJS-wrap redirect, #232 shape (fs target
   only): `require("internal/fs/utils")` →
   `parity/internal-fs-utils-adapter.mjs`. Stated in the PR body.
2. **`parity/internal-fs-utils-adapter.mjs`** (new) — faithful port of the
   Node functions the fs tests use (`lib/internal/fs/utils.js`, Node
   v24.20.0), over the harness-wrapped shim fs:
   - `join` (Node port incl. the `errArgType("path", ["string","Buffer"])`
     message the get-dirents test asserts verbatim),
   - `getDirents` / `getDirent` (Node port; UNKNOWN types lstat through
     the shim, so memfs-only paths resolve; known types `new Dirent`
     directly; the callback form uses a local `once`),
   - `validateRmdirOptions` / `validateRmOptionsSync` (Node port; EISDIR
     shape mirrors the shim's `checkRm`, probed identical against real
     Node v24.20.0),
   - re-exports `BigIntStats`, `Dirent`, `DirentFromStats`,
     `stringToFlags`, `validateOffsetLengthRead`,
     `validateOffsetLengthWrite` from `src/internals/fs-utils.js`.
   NOT ported (no fs test in this wave uses them): `validateRmOptions`
   (async), `getValidatedPath` / `getValidatedFd`, `getOptions`,
   `getValidMode`, `Stats`. If a future test needs one, port it here
   rather than falling back to native.
3. **`src/internals/fs-utils.js`** (new) — the shared pieces the adapter
   and the shim both build on, moved verbatim from `src/fs.js`:
   - `BigIntStats extends Stats` (Node's 14-arg positional ctor; `*Ns`
     are authoritative, `*Ms` derived as ns/1e6; exact ns restored after
     `super()` because the ms round-trip can lose a digit).
   - `Stats` (blksize default `||` → `??`, so 0/0n are real values),
     `Dirent`, `DirentFromStats extends Dirent` (non-enumerable `_stats`;
     `is*()` delegates to the stats — used for UNKNOWN dirent types),
     plus the `S_IF*` / `UV_DIRENT_*` constants and `modeToDirentType`.
   - `stringToFlags` (module-level Node port from the O_* constants
     table, so `fs.constants` values match by construction; number form
     coerces -0 → +0; invalid flags throw `ERR_INVALID_ARG_VALUE` with
     Node's message shape).
   - `validateOffsetLengthWrite` (hoisted out of `buildApi`, where a copy
     lived for the write paths; the in-`buildApi` callers resolve to it
     with identical messages — `errOutOfRangeFmt` formats numbers the
     same as the deleted local `errOutOfRange`; the nested
     `validateIntegerArg` call at the write path now uses module-level
     `validateInteger`, same messages). The nested `validateIntegerArg` +
     local `errOutOfRange` are deleted; all other in-scope
     `errOutOfRange(` callers bind to the module-level one with the
     identical format string, so their messages are unchanged.
   - `errArgType`, `errOutOfRangeFmt`, `validateInteger`,
     `validateOffsetLengthRead` (with their `_specificType` /
     `_outOfRangeReceived` / `_fmtTypeList` / `_numSep` helpers).
   `src/fs.js` imports the nine names it uses (`BigIntStats`, `Dirent`,
   `errArgType`, `errOutOfRangeFmt`, `modeToDirentType`, `Stats`,
   `validateInteger`, `validateOffsetLengthRead`,
   `validateOffsetLengthWrite`); `validateBuffer` / `validatePosition`
   stay in `src/fs.js` (module-private, using the imported builders).
   `toStats` stays in `src/fs.js` (routes `bigint` →
   `new BigIntStats(...)`, ns from ms via
   `BigInt(Math.trunc(ms*1e6))`); the `watchFile` zero stat is
   `toStats({ blksize: 0 }, { bigint })` (Node's uv_fs_poll initial
   callback reports all-zero stats for a missing file; `Stats` defaults
   blksize to 4096 for real files).
4. **`src/fs.js`** — imports from `./internals/fs-utils.js`; no new named
   exports (see the export-surface note below).

## Why the adapter (not just a shim change)

The two targets fail in the HARNESS layer (native internal module), not
in `src/fs.js` behavior — the shim's `toStats`/`Dirent` were already
almost right. The redirect keeps `src/` changes to the shared pieces
other lanes need too (L1's FileHandle work and L2's binding adapter both
consume the same validators), and the guard tests below prove the
redirect doesn't regress the four tests that already passed against
native `internal/fs/utils`.

## Export-surface note (caught by the repo suite, fixed in-lane)

The first shape exported the eight shared names from `src/fs.js`
(`BigIntStats`, `DirentFromStats`, `stringToFlags`,
`validateOffsetLengthRead/Write`, `validateInteger`, `errArgType`,
`errOutOfRangeFmt`). `tests/export_surface_fs.test.js` failed on them:
it asserts `src/fs.js`'s named exports equal real `node:fs` exactly, and
none of the eight are on it (verified against real Node v24.22.1 — only
`Dirent` and `Stats` of the group are real `node:fs` exports). Adding
them to the test's EXPECTED list would falsify the parity check, so the
shared pieces moved verbatim to `src/internals/fs-utils.js` instead
(same pattern as `stream-wrap-state.js` for the net adapter): `src/fs.js`
imports the nine names it uses, the adapter imports from internals
directly, and `src/fs.js` gains zero new named exports. After the move
the full repo set passes: 118/118 (see below).

## Differential (branch, isolated runs)

- Targets 2× each, before AND after the internals move:
  `test-fs-utils-get-dirents` 0,0; `test-fs-watchfile-bigint` 0,0.
- Guards 2× each, before AND after the move: `test-fs-filehandle` 0,0;
  `test-fs-open-flags` 0,0; `test-fs-rmdir-recursive` 0,0;
  `test-fs-util-validateoffsetlength` 0,0.
- rm.js `validateRmOptionsSync` assertions (rm.js:498-565) replicated in
  a zz probe (the full file dies earlier at its L6 git block, line 235):
  `zz-rm-validate` 0,0 — incl. extra EISDIR / missing-path+force cases.
  rm.js itself stays exit 1 on this branch, failing at line 235
  (`spawnSync /bin/sh ENOENT`, the L6 harness-mirror part) — as triaged.
  rm.js flips only with L5 + L6 together; this lane is its guard.
- Broader guard batch (1× each, branch, after the move): write,
  write-file, write-sync, write-buffer, writev, write-stream,
  write-stream-err, stat, stat-bigint, statfs, watchfile,
  watch-file-enoent-after-deletion, readdir, readdir-buffer,
  readdir-types-symlinks, readfile, readfile-zero-byte-liar,
  promises-file-handle-stat/read/write/readFile, truncate, open — all 0.
- Two exit-1s in the batch are OTHER lanes' targets, unchanged from
  base (verified against a scratch worktree at main `eca141cf`, which
  includes sibling lanes 4/9/11/13): `test-fs-readdir-types` fails at
  :116 `mustCall` expected 2 actual 0 (L2's binding gap, identical on
  base); `test-fs-mkdir` fails on the `options.recursive` function
  message (L10, identical on base).
- Repo tests (after the move): `tests/fs.test.js`,
  `tests/fs_promises.test.js`, `tests/export_surface_fs.test.js`,
  `tests/export_surface_fs_promises.test.js`,
  `tests/ondemand-require.test.js` — **5 suites, 118/118 passed**.

## Ship (filled at ship time)

- PR #___ / Merge SHA: ___
- Base at branch time: `5d6b0f71`; rebased onto main `___` before ship
  (sibling lanes 4, 9, 11, 13 merged meanwhile: #442, #443, #445, #444).
- CI: Parity + build green on code SHA ___ (poll ___).
