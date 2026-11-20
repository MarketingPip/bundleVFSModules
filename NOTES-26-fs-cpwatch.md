# Node 26 Wave 2 FS lane — cp/watch (F1–F5, F10, F11, F14, F15)

Worktree `~/workspace/worktrees/w2-fs-cpwatch`, base origin/main `dc70e38d`
(task's stated base `652333e7` is older; live main had moved on).
Branch `feat/w2-fs-cpwatch`. One PR.

Banked count (coordinator-verified on live main this run,
`--short 60 --full 120`): fs **350/385** (349 in-sweep +
`test-fs-realpath.js` adjudicated isolated [0,0] x2 — sweep flake).
New count = 350 + flips verified 2x isolated − regressions in differential.

## Method

- Read `NOTES-26-triage-fs.md` in full before touching code.
- Oracle: Node 26.13.1 binary (`~/workspace/local/node-26/bin/node`) and
  source (`~/workspace/local/node-26-src`, lib/ + test/parallel/). No fresh
  web research.
- Differentials run against the Node 26 test files under the parity
  harness (`PARITY_TARGET=fs timeout N node --import <abs preload>
  parity/node-test/parallel/<test>`), isolated at 90 s unless noted.
- `parity/drift/run-baseline.mjs` does NOT honor `// Flags:` headers.
  Tests declaring flags were verified isolated WITH the flag and are
  marked below; the differential cannot show them green and that is a
  runner limitation, not a regression.
- All fixes are in `src/fs.js` except F15, which rewrites the harness
  adapter `parity/internal-fs-recursive-watch-adapter.mjs` (harness-only;
  no `src/` behavior change for F15).

## Flips (all isolated [0,0] x2)

### F1 — cp async/sync preserveTimestamps (2)
`test-fs-cp-async-preserve-timestamps-dir.mjs`,
`test-fs-cp-sync-preserve-timestamps-dir.mjs` — [0,0] x2.

Root cause is memfs, not cp: `Link.getChild` stamps the PARENT dir's
mtime on EVERY path traversal, so a test's own `statSync` calls re-stamp
src/dest dirs ~1 ms apart. Fix (src/fs.js, `createVolume`): neutralize
the traversal bump once on the shared Link prototype (lookup unchanged;
`setChild`/`deleteChild` still bump on real mutations). Plus cp sets
dest dir times post-order, times LAST (memfs chmod touches mtime):
`cpOnDir` async/sync-filtered paths via `cpHandleTimestamps` /
`cpSetTimesExact`, and `cpCopyDirFast` post-order.

### F2 — cpSync dir mode (1)
`test-fs-cp-sync-directory-mode.mjs` — [0,0] x2.

Only the sync fast path lacked dir chmod. Fix: `cpCopyDirFast` tracks
whether it created each dest dir (pre-mkdir lstat / parent-loop flag)
and chmods newly-created dirs to the src mode post-order; an existing
dest keeps its mode.

### F3 — cpSync dereference nested symlink (1)
`test-fs-cp-sync-dereference-nested-symlink.mjs` — [0,0] x2.

Only the sync fast path never dereferenced. Fix: in `cpCopyDirFast`,
a symlinked child under `dereference` stats the target first (dangling
ENOENT / cycle ELOOP propagate before the dest is touched) and routes
through `cpDispatch`, so force / errorOnExist / dir-vs-file dest rules
apply. A dest dir under a dereferenced file + force is removed first
(`rmSync` recursive; `unlink` cannot remove a dir). Two memfs gaps
surfaced by this test and fixed in the same area:
- memfs `getResolvedLink` has no MAXSYMLINKS cap: a symlink cycle
  recurses until the stack overflows instead of ELOOP. Fix (src/fs.js,
  `createVolume`): count symlink expansions per resolution in the
  `getChild` patch and throw ELOOP past 40 (kernel SYMLOOP_MAX).
- The fast path resolves symlinked dirs to their physical path
  (`cpDirPhys`), so a cycle recurses on the same physical dir while the
  dest path grows. Fix: `derefDepth` threaded through
  `cpDispatch`/`cpGetStatsForCopy`/`cpOnDir`/`cpCopyDirFast`; the 41st
  dereferenced link on one chain throws ELOOP.
- memfs `mkdirSync(d, {recursive:true})` on an existing symlink-to-dir
  throws ENOTDIR instead of EEXIST: `cpCopyDirFast` now skips the mkdir
  when the dest already is a dir (directly or through a link).

### F4 — cpSync dir exists errorOnExist (1)
`test-fs-cp-sync-dir-exists-error-on-exist.mjs` — [0,0] x2.

One line: `cpOnDir` threw `ERR_FS_CP_EEXIST` only when `isAsync`; the
`isAsync &&` guard was dropped so sync throws too.

### F5 — cp async destination-appears-late (1)
`test-fs-cp-async-destination-appears-late.mjs` — [0,0] x2.

The test injects a symlink at dest from an async_hooks `FSREQCALLBACK`
init hook; the shim's async cp creates no libuv requests. Fix:
`cpAsyncTop` runs the dispatch inside a real `AsyncResource('FSREQCALLBACK')`
(native under Node via `src/async_hooks.js`, stub in the browser),
created after the dest check and before the dispatch, so the hook fires
at the same point as in real Node. The racing mkdir's EEXIST is tagged
`_syscallOverride = 'mkdir'` in `cpMkdirDir` (else `enrichErr` would
rewrite the syscall to the cp boundary's `lstat`).

### F10 — fs.stat abortSignal (1)
`test-fs-stat-abort-test.js` — [0,0] x2.

`fs.fstat` was the one stat-family member not wrapped in
`withAbortSignal`; it is now, exactly like `stat`/`lstat`.
`FileHandle.stat` validates `options.signal` and awaits
`throwIfAborted(signal)` before its sync work, so an in-flight abort
rejects with ABORT_ERR.

### F11 — FileHandle.pull (1)
`test-fs-promises-file-handle-pull.js` — [0,0] x2, run with
`--experimental-stream-iter` (the test's declared flag).

Node 26 acquires the handle lock when iteration STARTS, not at `pull()`
creation. Fix: `pull()`/`pullSync()` keep the creation-time check
(closed/locked still throw synchronously) but move lock acquisition
into the first `next()`; only the iterator that acquired the lock
releases it in `finally` (a failed second iterator never unlocks the
first). First `next()` also re-checks closed (handle closed after
creation rejects with `ERR_INVALID_STATE`). Abort now throws
`signal.reason` directly (an `abort(null)` rejects with `err === null`).

### F14 — fs.readdir recursive tree (1)
`test-fs-readdir-recursive-tree.js` — [0,0] x2.

Two problems. (1) The shim walk was DFS + lstat, never following dir
symlinks; Node 26 is BFS following dir symlinks. Fix: `readdirImpl`
rewritten as a port of Node 26's `collectRecursiveReaddirResult` /
permission-model BFS (`dirs` + `prefixes` queues, binding readdir per
dir, dir-symlink detection via a following stat, dangling links listed
but not queued). (2) memfs `lstatSync` cannot traverse a symlinked dir
component (ENOENT), so non-recursive dirents under a symlinked dir had
all types false — breaking the test's own reference walk. Fix: new
`lstatSyncPhys(p)` helper (resolve the parent via `realpathSync`, then
lstat the final name), used in `readdirImpl`, `getDirentsFromBinding`,
`bindingReaddir`'s type computation, and as an ENOENT-only fallback in
the `fs.lstatSync` wrapper. Buffer rules honored: the root keeps the
path as given (a Buffer root keeps its exact Buffer object as
`parentPath`); below the root, `joinParentPath` semantics (string+string
joins lexically, anything else `Buffer.concat`s). Options are
snapshotted in `readdirImpl` (the test mutates them after the
callback-form call). Errors from a queued dir propagate with syscall
`scandir` + the failing path (via the callers' `enrichErr`).

### F15 — fs.watch recursive (6: 5 race + watch-enoent)
- `test-fs-watch-recursive-retry-directory-disappears-before-read.js` — [0,0] x2, `--expose-internals`
- `test-fs-watch-recursive-retry-directory-disappears-before-watch.js` — [0,0] x2, `--expose-internals`
- `test-fs-watch-recursive-root-disappears-before-read.js` — [0,0] x2, `--expose-internals`
- `test-fs-watch-recursive-root-disappears-before-watch.js` — [0,0] x2, `--expose-internals`
- `test-fs-watch-recursive-root-disappears-before-watch-no-throw.js` — [0,0] x2, `--expose-internals`
- `test-fs-watch-enoent.js` (recursive block) — [0,0] x2, `--expose-internals`
- Guards held isolated: `test-fs-watch-recursive-prefix-sibling.js` [0,0] (was already green),
  `test-fs-watch-recursive-delete-race.js` [0,0], `test-fs-watch-recursive-watch-before-read.js` [0,0].

The adapter (`parity/internal-fs-recursive-watch-adapter.mjs`) was a port
of Node v24.20.0's recursive watcher; it is now a port of Node v26.13.1's
(`lib/internal/fs/recursive_watch.js`): Linux-only dir watchers
(`kDirectoryWatchReportsEntries`), `#entries`/`#watchers`/`#symbolicLinks`
sets, `#watch` returning false for paths that vanish before the watch
lands, `#scanFolder` watching BEFORE reading, `#forget` with the
exact-or-`file + sep` prefix, `[kFSWatchStart]` throwing unless
`!throwIfNoEntry && code === 'ENOENT'`. The v24 adapter's kFSWatchStart
condition was inverted (it swallowed the ENOSPC error watch-enoent
asserts on). fs operations are still read off the shim at call time
(tests monkey-patch `fs.watch` / `fs.readdirSync`). Two memfs-only
deviations from Node 26, both commented in the adapter:
- `#watch` closes a just-created watcher instead of registering it if
  a synchronous callback already forgot the entry (or closed the
  watcher) while `watch()` was on the stack.
- `#scanFolder` has a `#scanning` re-entrancy guard: memfs delivers
  events synchronously, so an event fired during a scan can re-enter
  `#scanFolder` for the same folder — the harness's sync-on-read
  resurrects a just-deleted dir from real disk while its memfs deletion
  is still in flight, and the re-scan re-arms the mock `rmSync` that
  deleted it (unbounded resurrect/delete cycle; `delete-race` hung at
  exit 124 without it). libuv never delivers re-entrantly, so the guard
  is inert under real Node; the outer scan's own readdir still sees the
  post-event state.

## NO-FIX (with proof)

### F15 linux-directory-watchers — NO-FIX, host-bound
`test-fs-watch-recursive-linux-directory-watchers.js` still fails:
`0 !== 3` at test:51 (`countFSEventHandles() - before`, expected one
native handle per directory plus one for the symlink). The shim's
watchers are pure JS (memfs); they never create a libuv `FSEventWrap`
handle, so the count is always 0. Creating real native handles would
require native delegation, which the browser-first shim forbids by
design (AGENTS.md). The event-reporting and ref/unref parts of the test
are not reached (it fails at the first assertion).

Correction to triage: `NOTES-26-triage-fs.md` lists this test under
"fails-natively" (`nativeExit: 1` in `gaps-fs.json`), but direct runs
against real Node 26.13.1 pass 3/3 (exit 0, empty output) from
`~/workspace/local/node-26-src/test/parallel/`. The NO-FIX stands on the
host-bound handle count, not on a native failure.

## Differential (full fs suite)

`parity/drift/run-baseline.mjs --modules fs --short 60 --full 120`
(worktree `w2-fs-cpwatch`, Node 26 src, jobs 2; first attempt killed by
a VM restart at ~13 min, re-run to completion in ~53 min):

**fs: 365/385 pass, 20 fail, 0 timeout** (CSV
`parity/drift/w2-fs-csv/node26-baseline-fs.csv`, baseline
`parity/drift/w2-fs-baseline.jsonc` — scratch, not committed).
2 tests hit the 60 s cap and passed on the 120 s re-run; 0 timeouts.

- **Regressions: 0.** No test fails in this differential that passed
  in the committed Nov 19 baseline (346 pass / 39 fail).
- Flipped vs the Nov 19 baseline: 19 = the 15 lane flips below plus
  Wave 1 (F6 `openAsBlobSync`, F7 `rmdir-recursive-error`, F9
  `filehandle`, F13 `stream-windows-handle`) — so 346 + 4 Wave 1 = 350
  banked, + 15 lane = **365**.
- Lane flips in the differential itself: all 15 show exit 0 in the CSV,
  including the flag-declaring ones (the runner does not pass flags, so
  their differential passes are under no-flag conditions; the [0,0] x2
  isolated runs WITH flags are the authoritative evidence for those).
- Still failing (20, all pre-existing, all in the Nov 19 baseline's 39):
  F12 `test-fs-negative-zero.js` (host-bound, NO FLIP); F16 socket/FIFO
  (5: `cp-async-socket`, `cp-async-special-files-in-tree`,
  `cp-sync-copy-socket-error`, `read-stream`,
  `realpath-stale-stat-values`); F17 `promises-file-handle-read-worker`;
  F18 `stat-cancel-inflight`; F19 `mkdir-recursive-enoent`; F15 NO-FIX
  `watch-recursive-linux-directory-watchers`; and 10 fails-natively
  (`glob`, `glob-no-follow-symlink-globstar`, `promises-file-handle-pullsync`,
  `promises-file-handle-writer`, `promises.js`,
  `readdir-recursive-permission`, `readfile-one-roundtrip`,
  `writefile-one-roundtrip`, `rmSync-special-char-additional-error`,
  `syncwritestream`).

## Guards held

- F6/F7/F9/F13 (Wave 1, merged) — green in the differential
  (`openAsBlobSync`, `rmdir-recursive-error`, `filehandle`,
  `stream-windows-handle` all exit 0).
- `test-fs-realpath.js` — green in the differential (exit 0).
- `test-fs-watch-recursive-prefix-sibling.js`,
  `test-fs-watch-recursive-delete-race.js`,
  `test-fs-watch-recursive-watch-before-read.js` — green in the
  differential (exit 0).
