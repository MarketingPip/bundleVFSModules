# NOTES-fs-binding-adapter.md — fs wave F1 lane 2

Triage L2: the fs internal-binding adapter. Base main `5d6b0f71`.
Recorded fs 324/349, ceiling 344/349.

## Flips (3, all exit 1 → 0, isolated 2× each)

- `test-fs-promises-readfile.js` — `validateZeroByteLiar`: the test patches
  `binding.fstat` to report size 0 and expects the shim's promises
  `readFile` to consult it and still read to EOF.
- `test-fs-readdir-types.js` — the test patches `binding.readdir` to
  rewrite every dirent type to `UV_DIRENT_UNKNOWN` and expects the shim
  to re-stat (getDirents) so real Dirents still come back.
- `test-fs-sync-fd-leak.js` — the test mocks `fs.openSync` → 42,
  `fs.writeSync` → throws `BAM`, `fs.closeSync` → mustCall 1×, and
  expects `writeFileSync` (non-fast path) to open/write/close through
  the fs object so the mock fires.

## Design (Option B — prototype-merged adapter window onto a shared cell)

Net #425 precedent. Returning the shim binding object directly (Option A)
was rejected: it would force reimplementing `openFileHandle` +
`FSReqCallback` faithfully enough for the two currently-passing consumer
tests (`test-fs-filehandle.js`, `test-fs-existssync-memleak-longpath.js`).

- New shared cell `src/internals/fs-binding-state.js`:
  `{ fstat, readdir, writeFileUtf8, kUsePromises }` (`kUsePromises` is the
  cell's own symbol). The shim looks the cell up by property on every
  call, so a test patch lands immediately.
- `parity/internal-test-binding-adapter.mjs`: `internalBinding('fs')`
  returns a stable object built as `Object.create(realFsBinding)` with
  accessor properties `fstat` / `readdir` / `writeFileUtf8` (get → cell,
  set → cell) and `kUsePromises` (get → cell). Everything else
  (`openFileHandle`, `FSReqCallback`, `read`, …) falls through the
  prototype to the real binding, so the currently-passing consumer tests
  behave exactly as today. Each test file runs in its own process, so no
  patch leaks across tests.
- `parity/preload.mjs`: `internal/test/binding` redirect under target
  `fs`, right after the net branch (#232 shape).
- `src/fs.js` `buildApi` installs the default binding implementations
  (closures over memfs `vol`) into the cell once.

## Default binding implementations (Node v24.20.0 shapes, probed)

- `fstat(fd, bigint, req)`: returns the real binding's 36-field array
  `[dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks,
  atimeSec, atimeNs, mtimeSec, mtimeNs, ctimeSec, ctimeNs, birthtimeSec,
  birthtimeNs, 0 × 18]` (memfs Stats → sec/ns split); `bigint` maps the
  first 18 fields to BigInt. No req → sync return; `req === kUsePromises`
  → Promise; `req.oncomplete` → callback form.
- `readdir(path, encoding, withFileTypes, req?)`: names via
  `vol.readdirSync`; `'buffer'` encoding → Buffers; withFileTypes →
  `[names, types]` with lstat-derived `UV_DIRENT_*` ints (unresolvable →
  `UV_DIRENT_UNKNOWN`, which the caller re-stats). Errors go to
  `oncomplete(err)` / throw, matching the sync/async split.
- `writeFileUtf8(path, data, flags, mode)`: open/write/close for a path
  (numeric flags — memfs accepts them), current-position write for a
  numeric fd. Returns undefined.
- `stringToFlags` (lib/internal/fs/utils.js) and `parseFileMode`
  (lib/internal/validators.js:73) ported into `buildApi` for the
  writeFileSync fast path.

## Shim routing

- `FileHandle.readFile`: `await binding.fstat(this.fd, false,
  binding.kUsePromises)` once (then `throwIfAborted` again), and the
  stat fields drive `readFileSyncManual` via a new optional `statFields`
  parameter (size/mode from the binding: `S_IFREG ? statFields[8] : 0`;
  the `size > 2**31-1` `ERR_FS_FILE_TOO_LARGE` check uses the binding
  size). Sync/callback `readFile`/`readFileSync` keep their
  `vol.fstatSync` path — no vendored test patches `binding.fstat` for
  them, and their `binding.fstat` wrapper stays dormant (verified by
  `test-fs-readfile-buffer-option.js` passing).
- Path-based `promises.readFile`: opens the path, reads through the
  handle (`binding.fstat` drives the read), closes via `handleFdClose`
  (close errors never mask the read result). The old callback-`fs.readFile`
  path never consults the binding, so the fstat patch stayed dormant
  there. (Rebase note: this routing is now L1's `openHandle` /
  `handleFdClose` shape, which does exactly the same thing — my
  restructure was subsumed at rebase; the behavior is unchanged.)
  Signal validation happens before the open (same outcome as Node's
  `readFileHandle` check); abort-before, abort-during, and wrong-signal
  tests all still pass.
- `readdir` / `readdirSync`: routed through
  `binding.readdir(path, encoding, !!withFileTypes[, req])`; Dirents are
  built by a `getDirentsFromBinding` port (lib/internal/fs/utils.js:245)
  — `UNKNOWN` entries are re-statted (`DirentFromStats`). Recursive
  readdir stays vol-based (`readdirImpl` walk); Node recurses through
  `binding.readdir` per directory, which no vendored test patches.
  `validateEncodingOpt` now passes `allowBuffer=true` (Node's readdir
  accepts `'buffer'` encoding; previously rejected — untested on Linux,
  `test-fs-readdir-buffer.js` skips on non-macOS).
- `writeFileSync` inner wrapper: after the fd and flush branches, the
  Node fast path — string + utf8/utf-8 → `binding.writeFileUtf8(file,
  data, stringToFlags(flag), parseFileMode(mode))` — then the non-fast
  path mirroring Node (open via the fs object so mocks are observed,
  `fs.writeSync` loop, `fs.closeSync` in `finally`). The memfs
  `origWriteFileSync` fallback is gone.
- New `appendFileSync` wrapper next to it: Node shape (default flag
  `'a'`, forced `'a'` when falsy or when the target is an fd), delegates
  to `fs.writeFileSync` so the fast path and the open/write/close
  structure apply. Previously `appendFileSync` was memfs's (only the
  outer validation wrapper).

## Bug found during verification: harness syncPath re-entrancy (fixed in-lane)

Symptom: the three targets' logic all passed, but the test processes
never exited (timeout 124, 3/3; base exits 1, 3/3). Root cause: the
harness's `syncPath` copies real files into memfs via `raw.writeFileSync`
(the pristine inner wrapper). My non-fast path routed through the
harness-wrapped `fs.openSync`, whose `syncArgs` re-entered `syncPath`
for the same file, which copied it again — unbounded recursion, bounded
only by stack overflow per file, so a full-tree sync (the exit-time
`process.chdir` in `tmpdir.onexit`) effectively hung. Diagnosed by
stripping exit listeners (exit then worked), then tracing the single
remaining listener (`tmpdir.onexit` → `process.chdir` → harness
`syncArgs` → `syncPath` → `raw.writeFileSync` → `fs.openSync` → …).

Fix (in this lane, `src/fs.js` only): a `writeFileSyncActive`
re-entrancy guard in the inner wrapper. While a non-fast write is in
flight, a nested call uses the vol-level primitives directly (exactly
the old memfs-fallback shape). A test call is never nested, so it takes
the `fs.*` path and its mocks are observed (`test-fs-sync-fd-leak`
still passes). The fast path already uses vol-level ops, so it never
re-entered.

Follow-up (not this lane): `syncPath`'s file copy could use the
low-level `raw.openSync` / `raw.writeSync` / `raw.closeSync`
primitives instead of `raw.writeFileSync`, removing the re-entrancy
hazard for any future `writeFileSync` routing change. Left as a note —
the guard above makes the shim side safe regardless.

## Fixes found during sweep verification (in-lane, before ship)

Two real regressions surfaced in the first full .js sweep and were
fixed before the re-run:

1. `test-fs-buffer.js` (readdir encoding): the test calls
   `fs.readdir(dir, "hex", cb)` and hex-decodes each name. My first
   `bindingReaddir` returned names unencoded for any encoding other
   than `'buffer'` (the old code delegated to memfs, which encodes).
   Fix: `bindingReaddir` now encodes names per the requested encoding
   — `'buffer'` → Buffers, `'utf8'`/`'utf-8'`/unset → as stored,
   anything else (`hex`, `base64`, `latin1`, `ucs2`, …) →
   `Buffer.from(name, 'utf8').toString(encoding)`. Same fix in the
   sync wrapper.
2. Same test, second cause: both wrappers did
   `options?.encoding ?? "utf8"`, but the call passes a bare string
   (`"hex"`), so `.encoding` is `undefined` and it silently defaulted
   to utf8. Fix: both wrappers normalize first —
   `typeof options === "string" ? options : options?.encoding ?? "utf8"`.
   (This was my own code, not a pre-existing shim bug: the old wrappers
   passed `options` straight to memfs, which handles string encodings.)

## Guards (all green on the branch)

- Targets isolated 2×: all three exit 0 twice (second run after the
  encoding fix).
- The four other `internalBinding('fs')` consumers:
  `test-fs-existssync-memleak-longpath.js`,
  `test-fs-filehandle.js`,
  `test-fs-promises-readfile-buffer-option.js`,
  `test-fs-readfile-buffer-option.js` — all exit 0 (re-run after the
  encoding fix).
- Full fs sweep differential vs the triage CSV
  (`hidden_files/fast-sweep/fs-sweep-2026-11-15.csv`):
  - .js: `fs-sweep-2026-11-15-f1-2b.csv` — 260 rows, 239 pass (triage
    235), 0 timeout, 21 fail (20×1 + 1×134). Toward-pass exactly the
    3 targets; 0 real regressions. Adjudicated sweep artifacts:
    `test-fs-readfile.js` 137 in the first run = OOM under sweep load
    (exit 0 isolated); `test-fs-watch-recursive-prefix-sibling.js` 1
    in the second run = watch-timing load flake (0 on base, 0 in the
    first branch run, 0/0 isolated). The 134 is
    `test-fs-writesync-crash.js`, L13's target, already 134 in triage.
    First sweep run (`fs-sweep-2026-11-15-f1-2.csv`, jobs=3) had the
    buffer regression + the readfile 137; the re-run above is the
    authoritative differential.
  - .mjs: `fs-sweep-2026-11-15-f1-2-mjs.csv` — 89 rows, 87 pass,
    byte-identical differential to triage (the 2 failures are the
    cp-socket NO-FIX pair).
  - Repo tests: `tests/fs.test.js` + `tests/fs_promises.test.js` +
    `tests/export_surface_fs.test.js` — 88/88. Footprint:
    `tests/ondemand-require.test.js` — 29/29.

## Rebase onto dc25a75e (L1 #450, L8 #451, L10 #452, L12 merged) — before ship

Conflicts (4, all composed, markers 0, syntax clean):

- `parity/preload.mjs`: HEAD's three fs redirects (L8 watchers /
  recursive_watch, L1 internal/fs/promises) + mine
  (internal/test/binding) — kept all four, HEAD's first.
- `src/fs.js` imports: HEAD's `src/internals/fs-utils.js` import (L3)
  + mine (`fs-binding-state`) — kept both.
- `src/fs.js` readdirSync/readdir: HEAD's shape was L12's
  (memfs `orig` + `decodeFsName`); mine routes through
  `binding.readdir` (required by test-fs-readdir-types, which patches
  the binding). Composed: my binding routing, but `bindingReaddir`
  now encodes names via L12's `decodeFsName` instead of my inline
  `Buffer.from(n, 'utf8')` logic — mine would have mangled
  latin1-stored names and broken L12's test-fs-readdir-ucs2.
- `src/fs.js` promises assembly: L1's `openHandle` / `handleFdClose` /
  `promiseSignal` shape already routes path-based readFile through
  the handle (exactly what my restructure achieved) — took HEAD's
  side wholesale; my readFile restructure is subsumed.

Rebase fallout, fixed in-lane (amended into the rebased commit):

- L3 moved `S_IFMT` / `S_IFREG` / `UV_DIRENT_*` / `modeToDirentType`
  into `src/internals/fs-utils.js` and deleted the src/fs.js locals —
  my `readFileSyncManual` (`S_IFMT`/`S_IFREG`) and
  `getDirentsFromBinding` (`UV_DIRENT_UNKNOWN`) threw
  `ReferenceError`, failing 4 tests on the rebased tree
  (promises-readfile, readdir-types, promises-readfile-buffer-option,
  file-handle-close-errors). Fix: exported the two const groups from
  fs-utils.js, imported `S_IFMT`, `S_IFREG`, `UV_DIRENT_UNKNOWN`
  (plus the already-imported `modeToDirentType`) in src/fs.js.
  Importing does not change src/fs.js's export surface.
- My local `stringToFlags` port duplicated L3's fuller exported port
  (mine even threw on `undefined` where Node returns `O_RDONLY`) —
  deleted the local copy, imported L3's. `parseFileMode` stays local
  (no equivalent in fs-utils.js).
- `test-fs-watch-recursive-delete-race` (L8) failed once in the first
  rebased batch (`false !== true`, line 39) then passed 0/0 isolated
  twice and 0 in the full re-run — timing flake, not a rebase
  regression (my change does not touch watch).

Re-verified on the rebased tree (d344b34f + fixes, all exit 0): my 3
targets, 4 binding guards, test-fs-buffer, L12 test-fs-readdir-ucs2,
L8 test-fs-watch-recursive-delete-race, L1 aggregate/close/op-errors,
test-fs-mkdir (L10).

- `binding.read` is not routed: `readFileSyncManual` still reads via
  `readMemfs` internally. No vendored test patches `binding.read`.
- Recursive `readdir` stays vol-based (see above).
- Sync/callback `readFile` never calls `binding.fstat` (see above).

## Files changed

- `src/fs.js` (binding defaults + cell install, `parseFileMode`,
  writeFileSync fast path + non-fast path + re-entrancy guard, new
  `appendFileSync` wrapper, readdir routing + `getDirentsFromBinding`,
  readdir encoding via `decodeFsName` + bare-string options
  normalization, `FileHandle.readFile` fstat routing,
  `readFileSyncManual` `statFields` param; imports `S_IFMT` /
  `S_IFREG` / `UV_DIRENT_UNKNOWN` / `stringToFlags` /
  `modeToDirentType` from `src/internals/fs-utils.js`)
- `src/internals/fs-binding-state.js` (new shared cell)
- `src/internals/fs-utils.js` (rebase fix only: `export` on the
  `S_IFMT`/`S_IFREG`/… and `UV_DIRENT_*` const groups so src/fs.js
  can import them — no behavior change)
- `parity/internal-test-binding-adapter.mjs` (`fs` prototype-merged window)
- `parity/preload.mjs` (fs-target `internal/test/binding` redirect)

## PR

- Branch: `fix/fs-binding-adapter`
- PR #___ (filled at ship time)
