# NOTES-26-triage-fs — Node 26.13.1 re-target triage, module fs

DOCS ONLY. Base: origin/main @ `3c091022` (drift detector #505).
Worktree: `~/workspace/worktrees/node26-triage-fs` (detached @ `3c091022`,
node_modules symlinked, clean except the symlink). No src/ changes.

## Banked numbers (parent-verified, used as-is)

- Overall: 2,748 tests, 2,144 pass / 575 fail / 29 timeout; true shim-gap 566.
- fs: 39 non-pass = **28 shim-gap + 11 fails-natively + 0 native-timeout**.
- Node 26 binary verified first: `~/workspace/local/node-26/bin/node --version`
  = `v26.13.1`. Host node for the harness is v24.22.1 (matters for one
  NO-FIX below).

## Gap total check: 28 = 20 lane-able + 8 NO-FIX

| family | n | class | tests |
|---|---|---|---|
| F1 cp dir timestamps | 2 | real shim work | cp-async-preserve-timestamps-dir, cp-sync-preserve-timestamps-dir |
| F2 cp dir modes | 1 | real shim work | cp-sync-directory-mode |
| F3 cp dereference nested | 1 | real shim work | cp-sync-dereference-nested-symlink |
| F4 cp errorOnExist on dir | 1 | real shim work | cp-sync-dir-exists-error-on-exist |
| F5 cp async dest-appears-late | 1 | real shim work, LOW confidence | cp-async-destination-appears-late |
| F6 openAsBlobSync missing | 1 | real shim work (addition) | openAsBlobSync |
| F7 rmdir recursive removal | 1 | deletion lane | rmdir-recursive-error |
| F8 F_OK/R_OK/W_OK/X_OK removal | 0 | deletion lane, no failing test in the 28 | (export-diff only) |
| F9 FileHandle GC-close throws | 1 | real shim work (behavior change) | filehandle |
| F10 stat signal (fstat + FileHandle.stat) | 1 | real shim work | stat-abort-test |
| F11 FileHandle pull lock deferral | 1 | real shim work | promises-file-handle-pull |
| F12 negative-zero fd fast path | 1 | real shim work | negative-zero |
| F13 windowsHandle validation order | 1 | validation gap | stream-windows-handle |
| F14 readdir recursive BFS + symlink-follow | 1 | real shim work | readdir-recursive-tree |
| F15 recursive-watch adapter races | 6 | real shim work | watch-enoent (recursive block), watch-recursive-retry-directory-disappears-before-read, watch-recursive-retry-directory-disappears-before-watch, watch-recursive-root-disappears-before-read, watch-recursive-root-disappears-before-watch-no-throw, watch-recursive-root-disappears-before-watch |
| F16 socket/FIFO nodes (cp + realpath + read-stream) | 5 | NO-FIX | cp-async-socket, cp-async-special-files-in-tree, cp-sync-copy-socket-error, read-stream, realpath-stale-stat-values |
| F17 FileHandle worker transfer | 1 | NO-FIX | promises-file-handle-read-worker |
| F18 stat cancel needs host Node 26 binding | 1 | NO-FIX (harness/host) | stat-cancel-inflight |
| F19 procfs mkdir ENOENT | 1 | NO-FIX | mkdir-recursive-enoent |

Lane-able families F1–F7 + F9–F15 cover 20 tests. NO-FIX F16–F19 cover 8.
F8 is a deletion with 0 flips in this set (see lane L8).

## Per-family evidence

All isolated re-runs use the exact baseline invocation
(`timeout N node --import <abs preload> parity/node-test/parallel/<test>`,
`PARITY_TARGET=fs`) from `parity/drift/run-baseline.mjs`, against the Node 26
test tree staged into `parity/node-test/` (restored afterwards; tree verified
clean, 349 vendored fs tests back). Probe evidence comes from one batched
probe process run under the same invocation (probes that ran outside
`parity/node-test/parallel/` saw NATIVE fs — see Baseline corrections §3;
only the in-tree probe runs are cited).

### F1 — cp preserveTimestamps for directories (2 tests)

- `test-fs-cp-async-preserve-timestamps-dir.mjs`, exit 1 isolated:
  `AssertionError: Expected values to be strictly equal: + actual
  1795125724194 - expected 1795125724195` at test:38 — the DIRECTORY mtime
  assert; the FILE assert on the line above passes. Same on the sync twin
  (`+ 1795125747346 - 1795125747347` at test:39). Both sides are "now", not
  the 2020 past date, and differ by exactly 1 ms.
- Code: `src/fs.js` `cpCopyDirFast` (:4540–4560) creates dest dirs with
  `vol.mkdirSync(di)` and never calls `cpHandleTimestamps` for them; only
  `cpCopyFile`/`cpFastFile` (:4299, :4582) preserve times. Direct probe:
  `utimesSync` on a memfs dir DOES stick (`file=947030400000
  dir=947030400000 want=947030400000`), so the gap is in cp, not utimes —
  but the 1 ms diff (not the 2020 date) means the lane must also verify the
  harness does not clobber dir mtimes via its real-disk sync on the
  `statSync` read path.
- Classification: real shim work. Lane L1, est. flip 2.

### F2 — cp directory modes (1 test)

- `test-fs-cp-sync-directory-mode.mjs`. Probe: src dirs 0o700/0o700/0o775,
  dest dirs `private=777 inner=777 shared=777` after
  `cpSync(src, dest, {recursive:true})`. Code: same `cpCopyDirFast` path
  never chmods created dirs (contrast `cpCopyFile`, which chmods to the src
  mode). The test also covers the async path and read-only dirs in one file.
- Classification: real shim work. Lane L2, est. flip 1.

### F3 — cpSync dereference of nested symlinks (1 test)

- `test-fs-cp-sync-dereference-nested-symlink.mjs`. Probe with
  `{dereference:true, recursive:true}`: `link-to-file=symlink
  link-to-dir=symlink` — nested links are copied as links, not dereferenced.
  Code: `cpDirPhys` (src/fs.js:4468) handles only the top-level src;
  `cpFastLink` never dereferences children.
- Classification: real shim work. Lane L3, est. flip 1.

### F4 — cpSync errorOnExist on an existing directory (1 test)

- `test-fs-cp-sync-dir-exists-error-on-exist.mjs`, exit 1 isolated:
  `AssertionError: Missing expected exception ... expected
  { code: 'ERR_FS_CP_EEXIST' }` at test:25. Probe (with `recursive:true`):
  `cp-dir-exists-recursive: ok(no throw)` — no error at all. (An earlier
  probe without `recursive:true` threw `ERR_FS_EISDIR` instead; that was a
  probe bug, not the shim — the test passes `recursive`.)
- Classification: real shim work. Lane L4, est. flip 1.

### F5 — cp async destination-appears-late (1 test, LOW confidence)

- `test-fs-cp-async-destination-appears-late.mjs`, exit 1 isolated:
  `AssertionError: the hook found no request to inject the symbolic link at`
  (test:31). The test injects a symlink at `dest` from an `async_hooks`
  `FSREQCALLBACK` init hook; the hook never fires because the shim's async
  cp creates no libuv fs requests (nextTick + sync memfs calls only).
- Fix shape if pursued: run async-cp steps inside
  `AsyncResource('FSREQCALLBACK')` so the hook can fire, plus the dest
  re-check at copy time (`vol.mkdirSync(d)` in `cpDispatch` would then throw
  EEXIST). That is a real but unusual fix; the alternative reading is NO-FIX
  (test depends on libuv request timing). Coordinator decides; counted as
  lane-able with LOW confidence.
- Classification: real shim work, LOW confidence. Lane L5, est. flip 1
  (low confidence).

### F6 — openAsBlobSync missing (1 test)

- `test-fs-openAsBlobSync.js`. Probe: `typeof fs.openAsBlobSync` =
  `undefined`; call throws `TypeError: fs.openAsBlobSync is not a function`.
  Code: `src/fs.js:6172` implements async `openAsBlob` only; no sync twin.
  Node 26 export diff: ADDED `openAsBlobSync`.
- Classification: real shim work (addition). Lane L6, est. flip 1.

### F7 — rmdir recursive must throw (1 test, deletion)

- `test-fs-rmdir-recursive-error.js` (NEW in 26): asserts `rmdir`,
  `rmdirSync`, `promises.rmdir` with `{recursive:true}` all throw
  `ERR_INVALID_ARG_VALUE` (25.0.0 removal). Probe: `rmdir-recursive:
  ok(removed, no throw)` and the process emits the old DEP0147 warning
  (`In future versions of Node.js, fs.rmdir(path, { recursive: true })
  will be removed`). Code: `src/fs.js:3293–3435` implements recursive rmdir
  with a once-only warning.
- Classification: deletion lane — remove the recursive path, throw
  `ERR_INVALID_ARG_VALUE` on all three forms. Lane L7, est. flip 1.

### F8 — F_OK/R_OK/W_OK/X_OK getters must be removed (0 tests, deletion)

- Node 26 export diff: REMOVED `F_OK`, `R_OK`, `W_OK`, `X_OK` (25.0.0).
  Probe: `'F_OK' in fs` = true, `typeof fs.F_OK` = number, value 0, and
  access emits DEP0176 (`fs.F_OK is deprecated, use fs.constants.F_OK
  instead`). Code: `src/fs.js:9684–9690` defines the getters.
- No test in the 28 exercises this; no flip counted here. Still a required
  deletion lane for export parity (a test asserting absence would flip 0
  today and only exists after the lane). Lane L8, est. flip 0 in this set.

### F9 — FileHandle close-on-GC now throws (1 test)

- `test-fs-filehandle.js` (vendored name, v26 test changed — see
  New-in-26 §). Exit 1 isolated: `Mismatched <anonymous> function calls.
  Expected exactly 1, actual 0` at test:15 — the `uncaughtException`
  handler expecting `ERR_INVALID_STATE` (`/^A FileHandle object was closed
  during/`) never fires. Probe (with `--expose-gc --expose-internals`):
  the shim still emits the v24 behavior — `Warning: Closing file descriptor
  21 on garbage collection` + DEP0137 DeprecationWarning. Code:
  `src/fs.js:8101–8122` FinalizationRegistry warns; Node 26 throws instead
  (25.0.0 "FileHandle close-on-GC removed").
- Classification: real shim work (behavior change). Lane L9, est. flip 1.

### F10 — stat signal: fstat + FileHandle.stat in-flight (1 test)

- `test-fs-stat-abort-test.js` (vendored name, v26 adds in-flight cases for
  the 26.1.0 signal option). Exit 1 isolated; node:test reports exactly 2
  of 10 subtests failing, both "Missing expected rejection (AbortError)":
  `fs.fstat aborts in-flight` (test:63) and `filehandle.stat rejects
  in-flight` (test:101). The other 8 pass — already-aborted signal,
  in-flight `fs.stat`/`fs.lstat`/`fsPromises.stat`/`fsPromises.lstat`,
  invalid-signal — including via the shim's deferred async stat path.
  Probe: already-aborted `fs.stat` throws `ABORT_ERR` correctly.
- Classification: real shim work, narrow: signal plumbing on the `fstat`
  and `FileHandle.stat` paths only. Lane L10, est. flip 1.

### F11 — FileHandle pull lock error deferred to iteration (1 test)

- `test-fs-promises-file-handle-pull.js` (vendored name, v26 lock semantics
  changed). Probe: calling `fh.pull()` a second time while the first
  iterable is unconsumed throws synchronously `ERR_INVALID_STATE: The
  FileHandle is locked`. Node 26 expects the second `pull()` to succeed at
  creation and the error to surface on iteration
  (`other[Symbol.asyncIterator]().next()` rejects `ERR_INVALID_STATE`),
  and `fh.writer()` while locked to throw. Also `ac.abort(null)` must yield
  `err === null`, not AbortError (diff at test:195–224).
- Classification: real shim work. Lane L11, est. flip 1.

### F12 — negative-zero fd fast path (1 test)

- `test-fs-negative-zero.js` (vendored name, v26 adds `writeFileSync(-0,
  '')` / `appendFileSync(-0, '')` plus a child stdin round-trip). Exit 1
  isolated: `Error: EBADF: bad file descriptor, open` from
  `src/fs.js:191` makeFsError. Node 26: `-0` is fd 0; writing an empty
  string reaches the utf8 fast path without issuing a write.
- Classification: real shim work. Lane L12, est. flip 1.

### F13 — windowsHandle validation order (1 test, validation gap)

- `test-fs-stream-windows-handle.js` (NEW). Exit 1 isolated:
  `AssertionError: Missing expected exception ... expected
  { code: 'ERR_INCOMPATIBLE_OPTION_PAIR' }`. Probe: `createReadStream(null,
  {windowsHandle:1n})` throws `ERR_INVALID_ARG_TYPE` for the null path
  (shim validates path first); `create(null, {windowsHandle:1n, fd:2})`
  throws nothing at all. Node: `windowsHandle` alone on non-Windows →
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; with `fd` →
  `ERR_INCOMPATIBLE_OPTION_PAIR` — both before path validation.
- Classification: validation gap. Lane L13, est. flip 1.

### F14 — readdir recursive: BFS order + follow dir symlinks (1 test)

- `test-fs-readdir-recursive-tree.js` (NEW). Exit 1 isolated:
  `assert(expectedPaths.includes(path.join('d', 'link-to-a', 'b', 'c',
  '3')))` — actual false. The reference walk is breadth-first and follows
  directory symlinks (stat, not lstat). Probe of the shim:
  `[".hidden","a","a/1","a/b","a/b/2","a/b/c","a/b/c/3","d","d/4",
  "d/link-to-a","top"]` — depth-first, and `d/link-to-a` is listed but never
  followed. Code: `src/fs.js:2323` `readdirImpl` walks DFS with
  `vol.lstatSync` (`st.isDirectory()` false for a symlink). The test also
  deep-equals the full ordered arrays (sync, callback, promises, Buffer and
  Dirent forms), so both order and following must match.
- Classification: real shim work. Lane L14, est. flip 1.

### F15 — recursive-watch adapter race handling (6 tests)

- `test-fs-watch-enoent.js` (recursive block only — the plain
  watch-enoent blocks pass; probe: shim throws ENOENT with `.path` and
  `.filename` set, syscall `watch`), exit 1 isolated at test:111:
  `Missing expected exception` — `watcher[kFSWatchStart](directory)` must
  throw the mocked ENOSPC error with `error.filename === directory` when
  the second `fs.watch` call throws.
- `test-fs-watch-recursive-root-disappears-before-watch-no-throw.js`,
  exit 1 isolated: uncaught `Error: ENOENT: no such file or directory,
  watch '<dir>'` from `src/fs.js:6702` normalizeWatchStartError —
  kFSWatchStart propagates the watch error where the no-throw variant must
  swallow it.
- The other four (`retry-directory-disappears-before-read`,
  `retry-directory-disappears-before-watch`,
  `root-disappears-before-read`, `root-disappears-before-watch`) assert the
  same adapter surface: retry after re-creation, close-count when the
  directory disappears before read, error identity + `filename` when it
  disappears before watch. Read, not re-run (one representative re-run +
  shared adapter code at `parity/internal-fs-recursive-watch-adapter.mjs`,
  the v24 L8 lane).
- Classification: real shim work in the recursive-watch adapter.
  Lane L15, est. flip 4 of 6 (conservative — race-handling lanes
  historically flip in a batch, but each test asserts a distinct race).

### F16 — socket/FIFO nodes: cp + realpath + read-stream (5 tests, NO-FIX)

- `test-fs-cp-async-socket.mjs`, `test-fs-cp-sync-copy-socket-error.mjs`
  (both vendored names; v24 NO-FIX, carried over — see triage-fs-2026-11-15):
  expect `ERR_FS_CP_SOCKET`. Probe: native server listening on a real
  `/tmp/probe26-<pid>.sock`; shim `existsSync(sock)` = false;
  `cpSync(sock, dest)` throws `ENOENT, syscall lstat` — memfs has no socket
  nodes, so the shim cannot even see the socket to reject it.
- `test-fs-cp-async-special-files-in-tree.mjs` (NEW): expects
  `ERR_FS_CP_SOCKET` and `ERR_FS_CP_FIFO_PIPE` for a socket/FIFO inside the
  copied tree — same root cause.
- `test-fs-read-stream.js` (vendored name; v24 NO-FIX): exit 1 isolated,
  `syscall: 'open', errno: -2` — the FIFO block only; `spawnSync("mkfifo")`
  creates a REAL FIFO the memfs-backed `createReadStream` cannot open.
- `test-fs-realpath-stale-stat-values.js` (NEW): exit 1 isolated, fails at
  test:60 before reaching any realpath assertion — `fs.statSync(fifo)`
  throws `ENOENT ... stat '.../.tmp.0/fifo'` (memfs volume.js:1296): the
  test's premise needs a real FIFO stat'ed through the shim.
- NO-FIX reason (one line each): socket/FIFO nodes cannot exist in memfs;
  a browser has no Unix sockets or named pipes to expose. (v24 triage
  already adjudicated the two socket tests + read-stream identically.)

### F17 — FileHandle worker transfer (1 test, NO-FIX)

- `test-fs-promises-file-handle-read-worker.js` (vendored name; v24 NO-FIX,
  mechanism unchanged — the v26 diff is formatting plus the same two
  blocks). Transfers a FileHandle to a real worker thread
  (`transferList: [handle]`); under `PARITY_TARGET=fs` worker_threads is
  native, so the worker needs a real shared OS fd. The shim's FileHandle
  wraps a per-realm memfs fd number that structured clone cannot carry.
- NO-FIX reason: needs real worker_threads + real shared OS fds — a
  cross-module design, not a lane.

### F18 — stat cancel needs a host Node 26 binding (1 test, NO-FIX)

- `test-fs-stat-cancel-inflight.js` (NEW). Exit 1 isolated; the CHILD
  process fails: `TypeError: req.cancel is not a function` at test:39.
  The child is spawned with `process.execPath` (host Node v24.22.1) and NO
  `--import` preload (child stack shows native `Module._load`), so it uses
  the host's native binding. Probed: `typeof new
  FSReqCallback(false).cancel` = `function` on real Node 26.13.1,
  `undefined` on host v24.22.1. The adapter
  (`parity/internal-test-binding-adapter.mjs`) also has no `cancel`
  (grep: 0 hits), but that is moot — the child never loads it.
- NO-FIX reason: the test can only pass when the spawned child runs Node
  ≥26; no shim code can change the child's native binding. (A harness
  change to spawn the Node 26 binary is out of scope for a shim lane.)

### F19 — procfs mkdir ENOENT (1 test, NO-FIX)

- `test-fs-mkdir-recursive-enoent.js` (NEW; Linux-only, refs
  nodejs/node#66268). Exit 1 isolated: `Missing expected exception` at
  test:14 — `mkdirSync('/proc/node-test-<pid>', {recursive:true})` must
  throw `{code:'ENOENT', syscall:'mkdir'}`. Probe: `mkdir-proc-recursive:
  ok(no throw)` — the shim creates the path in memfs. Code:
  `src/fs.js:2994` `mkdirImpl` walks memfs only; `/proc` does not exist
  there, so it is created happily.
- NO-FIX reason: procfs is host-kernel state; a browser has no `/proc`, and
  the shim cannot know an absolute path is a read-only pseudo-fs without
  faking host knowledge. (A `/proc` special-case would be a fake, not a
  fix; coordinator may overrule.)

## Lane candidates (conservative flips; total est. 18 of 20 lane-able)

| lane | family | tests | est. flip |
|---|---|---|---|
| L1 cp dir timestamps | F1 | cp-async-preserve-timestamps-dir, cp-sync-preserve-timestamps-dir | 2 |
| L2 cp dir modes | F2 | cp-sync-directory-mode | 1 |
| L3 cp dereference nested | F3 | cp-sync-dereference-nested-symlink | 1 |
| L4 cp errorOnExist on dir | F4 | cp-sync-dir-exists-error-on-exist | 1 |
| L5 cp async dest-appears-late | F5 | cp-async-destination-appears-late | 1 (LOW confidence) |
| L6 openAsBlobSync | F6 | openAsBlobSync | 1 |
| L7 rmdir recursive removal | F7 | rmdir-recursive-error | 1 |
| L8 F_OK getters removal | F8 | (none in this set) | 0 |
| L9 FileHandle GC-close throws | F9 | filehandle | 1 |
| L10 stat signal fstat + FileHandle.stat | F10 | stat-abort-test | 1 |
| L11 pull lock deferral | F11 | promises-file-handle-pull | 1 |
| L12 negative-zero fd | F12 | negative-zero | 1 |
| L13 windowsHandle validation order | F13 | stream-windows-handle | 1 |
| L14 readdir recursive BFS + follow | F14 | readdir-recursive-tree | 1 |
| L15 recursive-watch races | F15 | watch-enoent, watch-recursive-retry-directory-disappears-before-read, watch-recursive-retry-directory-disappears-before-watch, watch-recursive-root-disappears-before-read, watch-recursive-root-disappears-before-watch-no-throw, watch-recursive-root-disappears-before-watch | 4 of 6 |

Estimated flips 18/28; ceiling if every lane lands: 20/28 (remaining 8 are
the NO-FIX set F16–F19). L5 is the least certain lane; L15 the widest.

## New-in-26 vs pre-existing split (of the 28 gaps)

- **Vendored names (9):** a same-named test existed in the v24 vendored set.
  All 12 vendored files checked (9 gaps + 3 fails-natively) DIFFER from
  their v24 versions — "vendored" means same filename, not same test.
  - Carried-over v24 NO-FIX (4): cp-async-socket, cp-sync-copy-socket-error,
    promises-file-handle-read-worker, read-stream. Same mechanism, same
    verdict as `triage-fs-2026-11-15.md`.
  - v24 PASS, v26 test changed (5): filehandle (GC warning → GC throw),
    negative-zero (new `-0` write/append + child stdin cases),
    promises-file-handle-pull (lock-error timing + `abort(null)`),
    stat-abort-test (new in-flight abort cases for the 26.1.0 signal
    option), watch-enoent (new RecursiveFSWatcher block). These are
    regressions-by-test-change, not shim regressions.
- **New Node 26 test files (19):** cp-async-destination-appears-late,
  cp-async-preserve-timestamps-dir, cp-async-special-files-in-tree,
  cp-sync-dereference-nested-symlink, cp-sync-dir-exists-error-on-exist,
  cp-sync-directory-mode, cp-sync-preserve-timestamps-dir,
  mkdir-recursive-enoent, openAsBlobSync, readdir-recursive-tree,
  realpath-stale-stat-values, rmdir-recursive-error, stat-cancel-inflight,
  stream-windows-handle, watch-recursive-retry-directory-disappears-before-read,
  watch-recursive-retry-directory-disappears-before-watch,
  watch-recursive-root-disappears-before-read,
  watch-recursive-root-disappears-before-watch-no-throw,
  watch-recursive-root-disappears-before-watch.
- **Changelog mapping (cross-check-changelog-2026-11-19.md, fs rows):**
  25.0.0 F_OK getters removed → F8 (no test); rmdir recursive removed → F7;
  FileHandle close-on-GC removed → F9; fs stream open method removed →
  no gap test in the 28. 26.1.0 stat signal → F10. 26.2.0 Stats/BigIntStats
  Temporal.Instant fields (`mtimeInstant` etc.) → NO gap test in the 28
  exercises them (no lane proposed; export diff shows only `Stats`
  deprecated:14 → deprecated:18, which no failing test covers).

## Fails-natively (11, NOT shim gaps — listed separately)

From `gaps-fs.json` (`nativeExit: 1` on real Node 26.13.1):

- test-fs-glob-no-follow-symlink-globstar.mjs (NEW)
- test-fs-glob.mjs (VENDORED; v26 version heavily reworked, 1180 diff lines)
- test-fs-promises-file-handle-pullsync.js (VENDORED)
- test-fs-promises-file-handle-writer.js (VENDORED)
- test-fs-promises.js (VENDORED)
- test-fs-readdir-recursive-permission.js (NEW)
- test-fs-readfile-one-roundtrip.js (NEW)
- test-fs-rmSync-special-char-additional-error.js (NEW)
- test-fs-syncwritestream.js (VENDORED; was a v24 NO-FIX, now ALSO fails
  natively on 26 — doubly excluded, not a shim gap per the oracle)
- test-fs-watch-recursive-linux-directory-watchers.js (NEW)
- test-fs-writefile-one-roundtrip.js (NEW)

## Baseline corrections

1. **One classification correction: `test-fs-stat-cancel-inflight.js` is
   NOT a shim gap.** Baseline class `shim-gap` is wrong in substance: the
   failure is `TypeError: req.cancel is not a function` in a child spawned
   with host Node v24.22.1 (no preload), whose native binding has no
   `cancel` (probed: Node 26.13.1 `function`, host v24.22.1 `undefined`).
   Reclassified NO-FIX (F18). True fs shim-gap becomes 27 if the
   coordinator accepts this; the banked 28 is otherwise unchanged.
2. **No exit-code correction.** My 10 s isolated re-runs returned 124 for
   every test — including the known-passing control `test-fs-mkdir.js`,
   which also hung past 60 s under the preload — because sibling triage
   workers were saturating the box at the time (16 test processes alive,
   ~6 GB used of 7.9 GB). Those 124s are contention artifacts, not test
   hangs. Sequential 60 s re-runs reproduced the baseline `exit=1` for all
   14 tests attempted (list in §Evidence). No baseline exit is overturned.
3. **A probe artifact of mine, corrected:** a probe file placed at the
   worktree root saw NATIVE fs (`probe26/blob.txt` appeared on real disk),
   because `parity/preload.mjs:392` redirects `require('fs')` only for
   importers under `parity/node-test/parallel/` (plus fs helpers) — and
   `.cjs` entries skip the ESM hooks worker. Only the in-tree probe runs
   are cited above. Related: `require('internal/test/binding')` etc. fail
   with `MODULE_NOT_FOUND` unless the process carries `--expose-internals`
   — under the harness that comes from Node's `// Flags:` respawn via
   `common/index.js` (logs confirm: "test started as a child_process using
   these flags: [ '--expose-internals' ]"), so flag-gated tests were run
   correctly by the baseline; no correction needed.
4. **Runtime restart mid-flight:** the first background 10 s re-run batch
   was killed by a runtime restart with no saved output (`/tmp` wiped);
   it was re-run from scratch with restart-safe logging. No results were
   taken from the killed run.

## Evidence index (all quoted above; scratch deleted after use)

- Isolated 60 s re-runs, full stderr: 14 tests (watch-enoent,
  stat-abort-test, filehandle, realpath-stale-stat-values,
  readdir-recursive-tree, stat-cancel-inflight,
  watch-recursive-root-disappears-before-watch-no-throw, negative-zero,
  stream-windows-handle, cp-async-destination-appears-late,
  cp-async-preserve-timestamps-dir, cp-sync-preserve-timestamps-dir,
  cp-sync-dir-exists-error-on-exist, mkdir-recursive-enoent) — all exit 1,
  matching the baseline.
- Batched in-tree shim probes (2 runs): openAsBlobSync, rmdir-recursive,
  F_OK, windowsHandle, stat-aborted-signal, negzero, cp-dir-exists,
  cp-dir-mode, cp-preserve-ts-dir, cp-deref-nested, cp-socket,
  readdir-recursive, watch-enoent, binding-fs, internal-fs-utils,
  recursive_watch, mkdir-proc-recursive, pull, FileHandle GC.
- Native probes: Node 26.13.1 vs host v24.22.1 `FSReqCallback.cancel`.
- v24 adjudication source:
  `~/workspace/goals/node-parity-sweep-bundlevfsmodules-runtime/hidden_files/triage-fs-2026-11-15.md`
  (fs closed 344/349 on v24.20.0, 5 NO-FIX; lanes L1–L13 + ceiling).
- Staged tree restored: `git status --porcelain -- parity/node-test` empty;
  vendored count back to 349 fs tests; no scratch files left in the worktree
  (only the `node_modules` symlink, untracked, as in the v24 triage).
