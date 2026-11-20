# NOTES-26-zlib-zip — Wave 3 ZLIB L-ZIP lane

## Task
Implement the Node 26.8 Zip API (8 exports: `ZipBuffer`, `ZipEntry`,
`ZipFile`, `createZipArchive`, `createZipArchiveSync`,
`getMaxZipContentSize`, `setMaxZipContentSize`, `zipFiles`) by porting
Node's MIT-licensed pure-JS `lib/internal/zip/*.js` onto the shim's
existing engines (pako, vendored zstdify, shim `crc32`, virtual fs).
Base: origin/main @ `10bdfcaa`. Banked zlib count (coordinator-confirmed
on live main): **54/89** (34 fail, 1 timeout).

## Implementation
- `src/zlib-zip.js` (new, ~3430 lines): near-verbatim port of Node's
  `lib/internal/zip/{constants,content-size,binary,dos,extra-fields,
  headers,header-builders,compression,entry,buffer,archive,file,fs-util}.js`.
  Primordials / `internal/*` requires / `internalBinding` replaced by
  plain globals and shim primitives; validation, error codes/messages,
  header layout and hardening checks are Node's verbatim.
- `src/zlib.js` (edit): imports the raw classes from `./zlib-zip.js` and
  wraps them exactly like Node's `lib/zlib.js` zip section — thin
  subclasses with `[Symbol.hasInstance]` overrides, warn-on-call factory
  wrappers, `ZipBuffer` constructor warns, warning fires on USE (not on
  import/access/instanceof). Adds the 8 names to the named export list and
  the frozen default export.
- Deliberate deviations (each marked `ponytail:` in code):
  1. `fs`/`stream` via `import fs from "node:fs"` /
     `import { Readable } from "node:stream"` (net.js precedent): real
     modules under the parity harness (so `ZipFile` sees the same files
     the tests write, and a test's `fs.writeSync` monkey-patch is visible
     via call-time member lookup), memfs-backed shim fs / shim stream in
     the sandbox build. Same honest virtual-fs-only scope as the fs shim.
  2. `zipFiles` streams with path-based `fs.createReadStream(path)` after
     an `isFile()` pre-check, instead of Node's fd-pinned
     `fs.promises.open` + `createReadStream({ fd })` (no TOCTOU window in
     single-threaded memfs / parity use; FIFO/device rejected before open).
  3. zstd streaming = accumulate + one-shot zstdify (no streaming zstd
     encoder in the shim); observable semantics (chunks, CRC, declared-size
     caps, errors) preserved.
  4. `Buffer` is the GLOBAL (like `src/zlib.js`), not
     `bufferExports.Buffer`: under parity the global is the real Node
     Buffer, so buffers handed to a test are `deepStrictEqual`-comparable
     with the test's own Buffers; in the sandbox the runtime installs the
     shim Buffer as the global. (First failure mode found: store-path
     `content()` returned shim Buffers and 4 subtests failed on prototype
     mismatch; deflate/zstd paths already returned real Buffers via the
     shim engine. Fixed by dropping the local `Buffer` binding.)
  5. `decodeMemberStream` has NO try/catch (like Node): source errors
     propagate raw. (First failure mode found: a catch-all re-wrap turned
     `#rawChunks`' `ERR_INVALID_STATE` on close-with-paused-iterator into
     `ERR_ZIP_ENTRY_CORRUPT`; removed the catch.)

## Differential (full zlib suite, Node 26 tests under parity harness)
- Baseline (before, `--jobs 2`): **54/89** pass, 34 fail, 1 timeout
  (`/tmp/w3-zip/base-before.jsonc`, `/tmp/w3-zip/csv-before/`).
- After, parallel `--jobs 2`: **68/89** pass, 20 fail, 1 timeout
  (`/tmp/w3-zip/after.jsonc`, `/tmp/w3-zip/csv-after/`) — 14 flips, 0
  regressions. `test-zlib-zip-security.js` failed ONLY in the parallel
  run: Node 26's `test/common/tmpdir.js` shares one `.tmp.<id>` directory
  (`.tmp.0` unless `TEST_SERIAL_ID`/`TEST_THREAD_ID` is set) across all
  test processes, and `refresh()` does `rm -rf` on it — a concurrent
  test's refresh wiped security.js's files mid-test. Harness artifact,
  not a shim defect.
- After, serial `--jobs 1` (confirms the diagnosis): **69/89** pass, 19
  fail, 1 timeout (`/tmp/w3-zip/after-serial.jsonc`,
  `/tmp/w3-zip/csv-after-serial/`) — **15 flips, 0 regressions**.
- **New count: 54 → 69** (15 flips verified twice: standalone per-file
  runs + serial full differential).

## Flips (15) — standalone subtest counts
| test | subtests |
|---|---|
| test-zlib-zip.js | 11/11 |
| test-zlib-zip-sync.js | 12/12 |
| test-zlib-zip-coverage.js | 40/40 |
| test-zlib-zip-edgecases.js | 10/10 |
| test-zlib-zip-encoding.js | 13/13 |
| test-zlib-zip-file-lifecycle.js | 3/3 |
| test-zlib-zip-metadata.js | 9/9 |
| test-zlib-zip-property.js | 2/2 |
| test-zlib-zip-zip64.js | 2/2 |
| test-zlib-zip-fuzz.js | 1/1 |
| test-zlib-zip-hardening.js | 30/30 |
| test-zlib-zip-files.js | 10/10 |
| test-zlib-zip-interop.js | 1 pass, 1 skip (bsdtar not installed on VM) |
| test-zlib-zip-security.js | 9/9 |
| test-zlib-zip-writable.js | 13/13 |

## Not flipped (documented, not shim defects)
- `test-zlib-zip-security-hardening.js` (5/6 subtests pass): the FIFO
  subtest spawns a NATIVE child (`spawnSync(process.execPath, ['-e',
  ...])` with no preload), so it requires the harness host itself to be
  Node 26. Host is v24.22.1 (`zlib.zipFiles` undefined →
  `REJECTED:undefined`). Proven: a Node 26.13.1 child rejects the same
  FIFO with `ERR_ZIP_UNSUPPORTED_FEATURE`, and the shim rejects it
  in-process with exactly that code/message (zz-fifo probe, deleted
  after use). Host-blocked, same category as experimental-warning.
- `test-zlib-zip-experimental-warning.js` (exit 1): conditional,
  host-blocked — spawns plain-`node` children (host v24, no zip API).
- `test-zlib-zip-internals.js` (exit 1): NO-FIX — requires
  `internal/zip/*` via `--expose-internals`.
- `test-zlib-zip-vfs.js` (exit 9): NO-FIX — requires `node:vfs` /
  `--experimental-vfs`, unknown to the host.
- All other still-failing tests are unchanged from baseline (same exit
  codes), incl. `test-zlib-brotli-16GB.js` still timing out (124).

## Guards held
- Zero regressions in the full differential (all 54 baseline passes
  still pass, serial run).
- Footprint: `NODE_OPTIONS=--experimental-vm-modules npx --no-install
  jest tests/ondemand-require.test.js` → 29/29 pass.
- `node --check src/zlib-zip.js` / `src/zlib.js` OK.
- Sandbox build: `node src/build-vfs.mjs` exit 0; built `dist/zlib.js`
  contains the zip API (`ZipBuffer`, `createZipArchive`,
  `getMaxZipContentSize`, `zipFiles`); `dist/` restored afterwards (not
  part of this PR — the dist-regen bot owns it). The esm.sh fetch
  retries in the build log are pre-existing and non-fatal.
- No `zz-*.js` probes remain; staged test copies removed;
  `parity/node-test/` clean (verified by run-baseline's restore step
  and `git status`).

## Ship
- Branch: `fix/zlib-26-zip`
- PR: (to fill)
- Merge SHA: (to fill)
