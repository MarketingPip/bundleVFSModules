# NOTES-fs-watch-recursive.md — triage lane 8 (wave F1)

## Target
`test-fs-watch-recursive-delete-race.js` — 1 → 0.

## Mechanism (triage, confirmed)
The test requires `internal/fs/watchers` (`kFSWatchStart`) and
`internal/fs/recursive_watch` (`FSWatcher`). Under `PARITY_TARGET=fs` both
resolved to native Node internals (no preload redirect), whose FSWatcher
`lazyLoadFsSync()` returns native fs — its `statSync` on the memfs-only
parent threw ENOENT at `[kFSWatchStart]`
(`node:internal/fs/recursive_watch:322`). Base repro confirmed.

## Fix (3 files)
- `parity/preload.mjs`: two redirects under target fs (#232 shape, stated in
  PR body): `internal/fs/watchers` →
  `parity/internal-fs-watchers-adapter.mjs`, `internal/fs/recursive_watch` →
  `parity/internal-fs-recursive-watch-adapter.mjs`.
- `parity/internal-fs-watchers-adapter.mjs`: re-exports real Node's
  `internal/fs/watchers` wholesale (the `kFSWatchStart` symbol identity is
  Node's own, so the test's destructured symbol matches the recursive
  adapter's method key). Same pattern as the net adapter for `internal/net`.
- `parity/internal-fs-recursive-watch-adapter.mjs`: faithful port of Node
  v24.20.0's `lib/internal/fs/recursive_watch.js` FSWatcher (constructor
  validation, close, `#watchFolder`/`#watchFile`, `[kFSWatchStart]`,
  ref/unref, async iterator), with exactly one substitution: fs operations
  (`statSync`, `readdirSync`, `watch`) run through the shim
  (`../src/fs.js` default export) instead of native fs. Methods are read off
  the shared shim object AT CALL TIME — the harness wraps the shim's methods
  in place on that object and the test monkey-patches `fs.watch` on it, so
  a captured reference would miss the patch (same shape as Node's
  `lazyLoadFsSync()`). Validators, error classes, `getValidatedPath`,
  `createIgnoreMatcher` and the symbol come from real Node internals (via
  `createRequire` — the adapter lives under `parity/`, so the preload's
  testsDir-guarded redirect does not apply) and from the sibling watchers
  adapter.
- `src/fs.js` (one condition, watch-machinery fix): the memfs delete-handler
  overflow bites NON-recursive watchers too. Plain `fs.watch(dir)` +
  `rmSync(dir/sub)` threw `RangeError: Maximum call stack size exceeded` on
  base (probe-proven): the parent watcher's memfs `child:delete` handler
  (`removeLinkNodeListeners`) recurses through the `.`/`..` links. The
  existing `hardenRecursiveWatcher` call was gated on `recursiveOpt`; the
  gate is removed so the hardening applies to every watcher. This is the
  watch call site L7 also works in, but a different region: L7 owns the
  encoding validation (`validateEncodingOpt` allowBuffer) and the error
  `.path`/`.filename` shape; this change touches only the hardening
  condition below them. Full watch suite run as guards (see below).

## Two memfs-vs-libuv timing divergences (port adaptations)
1. memfs delivers watch events SYNCHRONOUSLY inside the mutating call;
   libuv delivers them on a later turn. The port's `#watchFile` callback can
   therefore run while `const watcher = watch(...)` is still initializing
   (TDZ `ReferenceError`, observed in the debug probe). Fixed with a `let`
   cell + `watcher?.close()` guard.
2. Same cause, second half: the sync callback deletes the child from
   `#files` before `watch()` returns, so the port's `close()` (which iterates
   `#files`) never closed that watcher and its memfs timer held the event
   loop forever (exit 124). Fixed: after `watch()` returns, if the callback
   already found the file gone, close immediately instead of registering.

## Differential
- Target: `test-fs-watch-recursive-delete-race.js` 1 → 0, isolated 2x on
  branch (see `hidden_files/fs-f1-watch-recursive-results.txt`).
- Guards: all `test-fs-watch*.js` + `test-fs-watchfile*.js` — 36 runs = 35
  unique tests on branch, 32 pass, 3 fail, all pre-existing base failures
  owned by other lanes: `test-fs-watch-encoding.js` (L7),
  `test-fs-watch-enoent.js` (L7), `test-fs-watchfile-bigint.js` (L3).
  Zero regressions from this lane.
- Repo tests: `tests/ondemand-require.test.js` via jest, 29/29 pass.
- Plain-watch probe (base 1 RangeError → branch 0): `fs.watch(dir)` +
  `rmSync(dir/sub, {recursive: true})` now succeeds.

## Ship
- PR #451 — https://github.com/MarketingPip/bundleVFSModules/pull/451
- Code SHA: `aadc1875` (local commit `5eb12321` re-created by the git-database API)
- Merge SHA: ___ (filled at merge time)
