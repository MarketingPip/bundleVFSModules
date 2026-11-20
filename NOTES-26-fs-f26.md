# NOTES-26-fs-f26 — Node 26 Wave 1 lane FS F-26

Base: origin/main `d587825d` (PR #506 triage merged). Banked fs: **346/385**
on the Node 26 suite. Branch: `fix/26w1-fs-f26`.

## Flips (4 of 5 targeted — each verified 2x isolated under the harness)

| # | Test | Result |
|---|---|---|
| F6 | `test-fs-openAsBlobSync.js` | **FLIP** — exit 0, 2x |
| F7 | `test-fs-rmdir-recursive-error.js` | **FLIP** — exit 0, 2x |
| F9 | `test-fs-filehandle.js` (flags `--expose-gc --no-warnings --expose-internals`) | **FLIP** — exit 0, 2x with flags |
| F12 | `test-fs-negative-zero.js` | **NO FLIP** — in-process `writeFileSync(-0, '')` / `appendFileSync(-0, '')` fixed and verified 2x by probe, but the test file still exits 1 on the child round-trip (host-bound, see below) |
| F13 | `test-fs-stream-windows-handle.js` | **FLIP** — exit 0, 2x |

New count: **350/385** (346 + 4), pending the guard sweep below. F8
explicitly out of scope (later wave).

## Changes

All in `src/fs.js` except the one noted F9 adapter change.

### F6 — `openAsBlobSync` (new in Node 26)
- `src/fs.js` (~6156): new `fs.openAsBlobSync` + strict validation shared
  with `fs.openAsBlob`. Both validate options BEFORE path validation:
  null/non-object options → `ERR_INVALID_ARG_TYPE`; non-string `type` →
  `ERR_INVALID_ARG_TYPE` (NB: Node destructures `const { type = '' }`,
  whose default applies only to `undefined` — a null type must still
  throw; `??` is wrong here). Missing file → `ENOENT` with syscall
  `stat` (forced via `_syscallOverride`, since memfs stat errors carry
  no syscall field).
- The blob is LAZY and file-backed (`FileBackedBlob extends Blob`):
  open only stats; `size`/`type` are fixed at open; every read
  (`text()`/`arrayBuffer()`/`bytes()`/`slice()`/`stream()`) re-stats
  and rejects with `NotReadableError` if size/mtimeMs changed or the
  file vanished. Eager reads are gone — the old async `openAsBlob`
  read the whole file at open.
- `fs.openAsBlob` is now a plain (non-async) function returning
  `Promise.resolve(...)` so option validation AND the stat throw
  synchronously, like Node's (an `async function` would reject and
  `assert.throws` would never see it).
- **Singleton-only export:** `openAsBlobSync` is assigned on the `fs`
  singleton only, NOT added to the named `export const {...}` list.
  `tests/export_surface_fs.test.js` asserts exact equality against the
  v24.20.0 capture — a named export would fail it. Deferred to the
  export-surface re-capture wave. The 26 test uses `require('fs')`, so
  the singleton property flips it.
- Ceiling (ponytail in code): the freshness re-stat compares size AND
  mtimeMs; a same-size rewrite within the same millisecond would slip
  past memfs's ms-resolution mtime. Real Node compares the same fields.

### F7 — `rmdir` recursive removal (25.0.0)
- `src/fs.js` (~3311): deleted `warnRmdirRecursive` / `rmdirRecursiveWarned` /
  `rmdirRecursiveSync` (the DEP0147 recursive implementation). Any defined
  `recursive` option — including `false` — now throws
  `ERR_INVALID_ARG_VALUE` via `throwRmdirRecursive`. Order matches Node
  (`lib/fs.js` rmdir/rmdirSync, `lib/internal/fs/promises.js` rmdir):
  async throws BEFORE callback/path validation; sync throws after path
  validation. `promises.rmdir` inherits it (it delegates to callback
  `fs.rmdir` inside a Promise executor; `ERR_INVALID_ARG_VALUE` is in
  `NO_ENRICH_CODES`, so the code survives `enrichErr`).

### F9 — FileHandle close-on-GC now THROWS (25.0.0)
- `src/fs.js` (~8244): the `FinalizationRegistry` callback no longer
  warns + DEP0137. It closes the fd synchronously, then throws from
  `setImmediateSafe` — `ERR_INVALID_STATE` with Node 26's exact message
  (`A FileHandle object was closed during garbage collection. ... File
  descriptor: <fd> (<path>)`). Close-failure path throws the
  `Closing file descriptor <fd> on garbage collection failed (...)`
  UVException instead, matching Node's C++ close-failure branch. The
  registry now holds `{fd, path}`; `FileHandle` takes an optional `path`
  (default `"<unknown path>"`); `openHandle` passes `toPathString(p)`.
- `parity/internal-test-binding-adapter.mjs`: `openFileHandle` override
  on `shimFsBinding` (the noted exception to "all in `src/fs.js`").
  The test calls `internalBinding('fs').openFileHandle(...)`, which
  falls through to the REAL host binding (v24) — the shim's own
  `FileHandle` registry is never involved. The override forwards all
  args verbatim (so `ctx.errno` stays `undefined`) and registers the
  returned handle in a `FinalizationRegistry` that throws the Node 26
  error from a `setImmediate`, surfacing as `uncaughtException`. The
  host binding owns the fd close; this registry only supplies the throw.
  Only `test-fs-filehandle.js` calls `openFileHandle` among fs tests.
- **Flags note:** `run-baseline.mjs` does NOT honor `// Flags:`
  headers, so the guard sweep will still show this test as failing
  (no flags → `globalThis.gc` undefined → TypeError). The flip is
  proven by direct flagged runs (2x isolated, above).

### F12 — `-0` is fd 0 (Node 26.1.0)
- `src/fs.js` (~2134, ~2191): `writeFileSync`'s utf8 fast path is
  hoisted ABOVE the fd-number branch and the flush branch, matching
  Node's order. A number file is an fd only when int32 — `file | 0`
  normalizes `-0` to `0`; a non-int32 number falls through to
  `validatePath` (`ERR_INVALID_ARG_TYPE`). `bindingWriteFileUtf8`'
  fd path returns 0 without calling `vol.writeSync` for empty data
  (Node's C++ loop is `while (offset < length)` — empty data issues NO
  write, so fd 0/stdin must not EBADF). The non-fast fd branch likewise
  skips the write (and the writability check) for empty buffers.
- **Flush subtlety (resolved by oracle probe, not assumed):** Node's
  `getOptions` does NOT merge defaults into a provided object, so the
  fast-path encoding test uses the RAW `options.encoding`. `{flush:
  true}` (no encoding) takes the NON-fast path and DOES fsync;
  `{encoding: 'utf8', flush: true}` takes the fast path and does NOT
  (probed on Node 26.13.1: 1 vs 0 `fsyncSync` calls). The hoist uses
  the raw encoding, so `test-fs-write-file-flush.js` and
  `test-fs-append-file-flush.js` (both baseline PASS) keep passing.
  `appendFileSync` delegates to `writeFileSync` with flag `'a'` and
  explicit `encoding: 'utf8'`, so it inherits the fast path.
- **NO FLIP — host-bound remainder:** the test's child round-trip
  (`spawnSync(process.execPath, ['-e', '...readFileSync(-0, "utf8")'])`)
  runs the HOST node (v24.22.1), which SIGABRTs in C++
  `ReadFileUtf8` (`Assertion failed: (*path) != nullptr`,
  `node_file.cc:2956`). Node 26.13.1 runs the same child code fine
  (verified: prints `hello`, exit 0) — Node 26 fixed `readFileSync`
  with the same `path |= 0` line. The shim is never involved in the
  child's fs calls, and no shim change can fix the host binary, so
  this test file cannot pass under this harness until the host node is
  ≥ 26.1 (or the harness maps the child to the Node 26 binary — a
  shared-harness change, out of this lane's scope). The in-process
  assertions (lines 24–37) all pass now. In-process `readFileSync(-0)`
  was deliberately NOT changed: fd 0 (stdin) has no memfs backing, so
  normalizing it would only change which EBADF surfaces, not make
  piped stdin readable.

### F13 — `windowsHandle` validation order
- `src/fs.js` (~7396): new `validateWindowsHandleOption(opts)`, called
  FIRST in `FsReadStream._initReadStream` and in the `FsWriteStream`
  constructor — before signal/fd/path validation, matching Node's
  `lib/internal/fs/streams.js` order. Pair check (raw `options.fd`)
  → `ERR_INCOMPATIBLE_OPTION_PAIR`; platform (`process.platform !==
  'win32'`) → `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`; custom `fs` →
  `ERR_METHOD_NOT_IMPLEMENTED`; non-bigint → `ERR_INVALID_ARG_TYPE`;
  out-of-int64-range → `ERR_OUT_OF_RANGE` (`windowsHandle does not fit
  into 64 bits`, matching C++ `HandleToFd`'s `Int64Value` lossless
  check). Ceiling (ponytail in code): on win32 with a valid handle
  there is no `handleToFd` binding in a browser shim, so it throws
  `ERR_METHOD_NOT_IMPLEMENTED` — a future host-provided `handleToFd`
  hook would slot in there.

## Guard

- Repo jest (`NODE_OPTIONS=--experimental-vm-modules npx --no-install
  jest tests/fs.test.js tests/export_surface_fs.test.js`): **62/62 pass**.
- Full fs differential via `parity/drift/run-baseline.mjs --modules fs
  --jobs 2 --short 60 --full 120`: **[PENDING — sweep running at write
  time; fill in before merge]**.
- Baseline guard set: the 346 fs passes in
  `parity/drift/node26-baseline.jsonc` (list: `/tmp/fs26-pass.txt`).

## Environment notes

- **Exit tax (load artifact, not a shim gap):** `tmpdir.refresh()`
  registers a `process.on('exit')` handler whose `onexit()` calls
  `process.chdir(testRoot)`; the harness patches `process.chdir` to
  `syncPath` the whole staged tree (~5000 files) from real disk into
  memfs (~31s under load). Isolated runs need generous timeouts
  (90s used here); any timeout must be re-run isolated before being
  called a regression. Load during this lane: ~5–17.
- No `zz-*.js` probes remain; `parity/node-test/` restored to
  committed state before the jest + guard runs.
