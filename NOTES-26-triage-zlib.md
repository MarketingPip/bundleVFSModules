# NOTES — Node 26 triage: zlib

- Date: 2026-11-19. Worker: Node 26 re-target triage, module **zlib**. DOCS ONLY.
- Base SHA: `3c091022`. Worktree: `~/workspace/worktrees/node26-triage-zlib`.
- Node 26 binary verified first: `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
- Node 26 source: `~/workspace/local/node-26-src/` (`lib/zlib.js`, `lib/internal/zip/`,
  `test/parallel/test-zlib-*.js`). v24 context: `NOTES-zlib-*.md` in this worktree,
  v24 source pack `hidden_files/node-src/`, vendored v24 tests `parity/node-test/parallel/`.
- Harness invocation (from `parity/drift/run-baseline.mjs` `runOne`):
  `timeout N node --import parity/preload.mjs parity/node-test/parallel/<test>`
  with `PARITY_TARGET=zlib`, cwd = worktree. All isolated re-runs below use exactly
  that, with the Node 26 test tree staged into `parity/node-test/` and restored
  afterwards (`git checkout -- parity/node-test` + delete untracked staged files;
  verified clean, vendored set back to 65 zlib tests).

## Banked numbers (parent-verified, used as given)

- Overall: 2,748 tests, 2,144 pass / 575 fail / 29 timeout; true shim-gap 566.
- zlib: total non-pass **41**, shim-gap **36**, fails-natively **5**, native-timeout 0.

## Headline correction — true fails-natively is 0, true shim-gap is 41

All 5 "fails-natively" pass on real Node 26.13.1 when run sequentially
(15/15 runs, exit 0 — see § Baseline corrections). They are Zip tests, so they
belong to the Zip lane's flip set, not to fails-natively. Corrected zlib totals:
**41 shim-gaps, 0 fails-natively, 0 native-timeout.**

## Gap families (36 banked shim-gaps + 5 reclassified = 41)

### F1 — Brotli compressor-blocked (NO-FIX) — 13 tests

Needs a real Brotli **compressor** in pure JS. None exists: the shim's
`BrotliCompress` is a passthrough stub and the vendored brocha decoder is
decode-only; the RFC 7932 §11.1 stored-block compressor rescue was probed and
disproven (brocha cannot decode stored metablocks — `NOTES-zlib-brocha.md`,
"Compressor rescue — probed and disproven"). The decoder also cannot land
further without regressing the 4 round-trip tests that currently fail only
because the stub compressor's identity output is undecodable (same note,
"Why the 4 regressions are unavoidable").

| test | first failure in isolated re-run (exit 1 unless noted) |
|---|---|
| test-zlib-brotli.js | `:30` chunk-size assert `10048,10048,…` — needs real encoder output shape |
| test-zlib-brotli-flush.js | deep-equal `Buffer(16)` vs `Buffer(19)` — flush bytes differ |
| test-zlib-brotli-from-string.js | `assert(inputString.length > buffer.length)` — stub emits identity, no shrinkage |
| test-zlib-brotli-dictionary.js | `Error: unexpected end of file` at `src/zlib.js:333` — dictionary frame is stub bytes |
| test-zlib-brotli-16GB.js | **exit 124** at 10 s (baseline phase 2: 124 at 30 s) — 16 GB streaming decode; brocha is whole-buffer, cannot finish in 30 s (see `NOTES-zlib-brocha.md`, "Mode change") |
| test-zlib-convenience-methods.js | `Error: Decompression failed` at `src/zlib.js:333` — `brotliDecompressSync(brotliCompressSync(…))` round-trip |
| test-zlib.js | same `Decompression failed` — round-trip over person.jpg / elipses.txt |
| test-zlib-write-after-flush.js | `mustNotCall` error handler fired with `Decompression failed` (`:42`) |
| test-zlib-random-byte-pipes.js | hash mismatch `da39a3ee…` vs `e22464e8…` — random bytes through `[BrotliCompress, BrotliDecompress]` |
| test-zlib-decode-strings.js | `Decompression failed` — brotli half of the `[BrotliCompress, brotliDecompressSync]` round-trip (zstd half passes) |
| test-zlib-premature-end.js | `mustCall` 'end' at `:27` never fires — brotli variants feed stub-compressed input to the real decoder |
| test-zlib-type-error.js | 1 failing subtest: `zlib sync decompression honors rejectGarbageAfterEnd`. Shim probe: the gunzip half **passes** (`gunzipSync(double, {rejectGarbageAfterEnd:true})` throws `ERR_TRAILING_JUNK_AFTER_STREAM_END`); the brotli half fails because `brotliDouble` is stub output (`"a"+"a"`) which brocha rejects |
| test-zlib-reject-garbage-after-end.js | failing subtest `rejectGarbageAfterEnd rejects trailing input for brotli` (plus 2 zstd subtests — see F4; the test flips only when both halves pass, so it stays compressor-blocked) |

Classification: **NO-FIX** (13). v24-adjudicated for 12 of them
(`NOTES-zlib-brocha.md`: the 6 original + type-error + premature-end +
reject-garbage-after-end + the 4 round-trip regressions = 13 NO-FIX at v24
close, minus zstd-flush which is F2); `decode-strings` is new in 26 with the
same mechanism. Remaining unexplored path (not claimed): a WASM build of the
real brotli encoder per repo rule 8 — needs its own probe before anyone claims
it rescues the round-trips.

### F2 — Zstd streaming flush (NO-FIX) — 1 test

| test | first failure |
|---|---|
| test-zlib-zstd-flush.js | `:26` deep-equal: actual `''` vs expected `'KLUv/QBYgAAA/9j/4AAQSkZJRgABAQEASA=='` — `flush()` emits nothing; the zstdify engine is whole-buffer (`NOTES-zlib-zstdify.md`: "zstd-flush stays NO-FIX (needs a streaming encoder with flush)") |

Classification: **NO-FIX**. Needs a streaming zstd encoder with flush; vendored
zstdify compresses whole buffers only.

### F3 — Reset() state semantics (real shim work) — 4 tests, all NEW in 26

Node 26 `lib/zlib.js:323-326`: `reset()` delegates to the native binding. The new
tests pin two binding behaviours the shim's silent `reset()` does not reproduce:

| test | first failure |
|---|---|
| test-zlib-reset-incomplete-output.js | `Gzip reset throws when write/flush has emitted wrapper output` — native surfaces `ERR_ZLIB_INCOMPLETE_FRAME` via `finished()` after `reset()` on a gzip stream whose header already went out (deflateReset ≡ deflateEnd + deflateInit; the header cannot be taken back). Shim resets silently, stream finishes cleanly |
| test-zlib-zstd-reset-incomplete-frame.js | `ZstdCompress reset throws when an incomplete frame has emitted output` / `…when write itself emitted frame output` — same `ERR_ZLIB_INCOMPLETE_FRAME` shape for zstd |
| test-zlib-brotli-reset.js | `BrotliDecompress reset preserves its dictionary` — after `reset()`, decoding a second dictionary-compressed frame throws `Error: unexpected end of file` (`src/zlib.js:2220` brochaDecodeError via `:2365`); the reset drops the dictionary |
| test-zlib-zstd-reset.js | `ZstdDecompress reset preserves its parameters` — `AssertionError: Missing expected rejection` at `:65`; reset loses the decompressor parameters |

Classification: **real shim work** (stream-state semantics: track emitted
member/frame output per stream; refuse reset after output with
`ERR_ZLIB_INCOMPLETE_FRAME`; preserve dictionary/params across reset).
Lane candidate L-RESET below.

### F4 — Zstd multi-frame / trailing-garbage (real shim work, 0 whole-test flips alone) — 1 test

| test | failing subtests |
|---|---|
| test-zlib-reject-garbage-after-end.js | `zstd decompresses concatenated frames regardless of chunking`, `zstd reports errors in subsequent frames` (test file rewritten in 26, `:133-240`: concatenated `zstdCompressSync('a') + zstdCompressSync('b')` must decode to `'ab'`; errors in a later frame must surface). The shim's zstdify decompress is single-frame whole-buffer. |

Classification: **real shim work, subtest-level**. It flips **0 whole tests**
on its own: the file also contains the brotli subtest (F1), so the file exits 1
until a compressor exists. A zstd-multi-frame lane is separable work whose
payoff is subtests, not a flip — do not count it as a flip lane.

### F5 — Small validation / encoding gaps (real shim work) — 3 tests

| test | first failure (probe-proven mechanism) |
|---|---|
| test-zlib-zstd-dictionary.js | `:51` `Missing expected exception (TypeError)` — probe: `createZstdCompress({dictionary: d})` throws `ERR_INVALID_ARG_TYPE` for `'string'`, `123`, `true`, `{}`, `[1,2,3]` but **not for `null`** (shim treats null as "no dictionary"; native throws for all six). The round-trip halves pass (Z6 fixed dictionary decode). New validation loop in 26 (59 normalized-diff lines) |
| test-zlib-zstd-pledged-src-size.js | `:156` deep-equal `Buffer(2) [195, 169]` vs `Buffer(1) [233]` — the new latin1 assertion: async `zstdCompress('é', {defaultEncoding:'latin1'})` must decompress to `[0xe9]`, but the async path encodes the string as UTF-8 (`[0xc3, 0xa9]`) while the sync path handles latin1 correctly (earlier async-vs-sync asserts at `:135/:142` pass). New assertions in 26 (140 normalized-diff lines) |
| test-zlib-params.js | `:46` `mustCall` callback never fires — probe: shim `createDeflate().write('x'); params(9, …, cb); destroy()` → callback **never fires**; native node-26 → callback fires with `err.code === 'ERR_STREAM_DESTROYED'`. Shim `src/zlib.js:2682` `params()` routes through `flush(Z_SYNC_FLUSH, cb)` and the deferred flush never runs after destroy (and the destroyed branch calls back with no error, not `ERR_STREAM_DESTROYED`). **Test is byte-identical to the v24 vendored file modulo quotes** (normalized diff empty) yet fails now — either a shim regression since the 52/65 verification or node-26 `common/` drift; the lane must bisect before claiming which. Do not claim a proven regression. |

Classification: **real shim work** (validation/encoding/lifecycle). Lane
candidate L-SMALL below.

### F6 — Brotli decoder error-code fidelity (NO-FIX) — 1 test

| test | first failure |
|---|---|
| test-zlib-invalid-input.js | `:103` `assert.strictEqual(expectedError.errno, -17)` — `undefined !== -17`: the shim's `constants` lacks exactly one native code, `BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH` (native probe lists 26 `BROTLI_DECODER_ERROR_*` codes; the shim has the other 25). But adding the constant does **not** flip the test — probe: shim `brotliDecompressSync` on the `:95` block-switch frame throws `ERR__ERROR_FORMAT_BLOCK_LENGTH_1` errno **-9**, while native throws `ERR__ERROR_FORMAT_BLOCK_SWITCH` errno **-17**. Brocha reports the wrong error for this malformed frame. The zstd half of the file already passes (everything before `:103` passes, incl. the spoofed-length `ERR_OUT_OF_RANGE` checks). |

Classification: **NO-FIX** (decoder error-mapping fidelity; brocha's code for
this frame is -9, native is -17; no mapping layer can fix it without
re-deriving the error from the frame bytes).

### F7 — Zip API, 26.8 (real shim work) — 19 tests, all NEW in 26

Export diff (`parity/drift/node26-export-diff.md:125`): zlib ADDED 8 exports,
no removals: `ZipBuffer`, `ZipEntry`, `ZipFile`, `createZipArchive`,
`createZipArchiveSync`, `getMaxZipContentSize`, `setMaxZipContentSize`,
`zipFiles`. The shim exports none of them (`src/zlib.js:3094-3145` export list).
Changelog cross-check: Brotli decoder security fix Oct 2026, no API change; no
listed zlib behaviour change in 25/26.0.0 — the Zip API is the only zlib delta.

Node's implementation is pure JS (`lib/internal/zip/*.js`: entry, buffer,
file, archive, content-size, headers, compression, …) on top of
`deflateRaw`/`inflateRaw`/`zstd` + `crc32` + `fs` — every one of those engines
already exists in the shim (pako, vendored zstdify, `crc32` at
`src/zlib.js:301`, virtual fs). No new dependency and no wholesale polyfill is
needed: the lane ports/adapts Node's own MIT-licensed pure-JS zip modules onto
the existing engines. `ZipFile`'s fd use maps to the virtual fs (same honest
scope as the fs shim — real OS paths are virtual-fs only in the browser).

First failure for the core tests is uniformly `TypeError: Cannot read
properties of undefined (reading 'create' / 'read' / 'createSync' / 'createStream')`
— `zlib.ZipEntry` / `zlib.ZipBuffer` are `undefined`.

| test | scope note |
|---|---|
| test-zlib-zip.js, test-zlib-zip-sync.js, test-zlib-zip-coverage.js (1320 lines), test-zlib-zip-edgecases.js, test-zlib-zip-encoding.js, test-zlib-zip-file-lifecycle.js, test-zlib-zip-metadata.js, test-zlib-zip-property.js, test-zlib-zip-zip64.js (65,536 entries forces Zip64 EOCD), test-zlib-zip-fuzz.js, test-zlib-zip-hardening.js | core ZipEntry/ZipBuffer/ZipFile/createZipArchive(+Sync)/zipFiles/get/setMaxZipContentSize surface |
| test-zlib-zip-files.js, test-zlib-zip-interop.js, test-zlib-zip-security.js, test-zlib-zip-security-hardening.js, test-zlib-zip-writable.js | banked as fails-natively; **reclassified as shim-gaps** (see § Baseline corrections) — same missing-exports failure under the harness |
| test-zlib-zip-experimental-warning.js | all 5 subtests fail under the harness, but the failure is a host-version artifact (children spawn host v24 — see § Baseline corrections). Flips only under a node-26 harness host, after the Zip exports + use-time `ExperimentalWarning` exist. Conditional flip, not counted in L-ZIP's conservative estimate |
| test-zlib-zip-internals.js | NO-FIX for the zlib lane: requires `internal/zip/binary`, `internal/zip/extra-fields`, `internal/zip/headers`, `internal/zip/compression` via `--expose-internals` — Node's internal modules, not public API. Isolated re-run **with** `--expose-internals` still exit 1: `Error: Cannot find module 'internal/zip/binary'`. The file's own header says these guards "exist for 32-bit limits, or for hypothetical callers that skip the pre-validation every current call site performs" |
| test-zlib-zip-vfs.js | NO-FIX for the zlib lane: requires `node:vfs` (`--experimental-vfs`, `vfs.create()` MemoryProvider). Isolated re-run with the flag: exit **9**, `node: bad option: --experimental-vfs` — the flag is unknown to the host v24 binary before any test code runs. Belongs to a vfs-module lane, if any, not zlib |

Classification: **real shim work** (F7 core = L-ZIP below); internals + vfs =
**NO-FIX for zlib**; experimental-warning = **host-blocked conditional**.

## Lane candidates (conservative flip estimates; counts are whole-test flips)

### L-ZIP — implement the 26.8 Zip API — 16 flips (conservative 13)

Flips: `test-zlib-zip.js`, `test-zlib-zip-sync.js`, `test-zlib-zip-coverage.js`,
`test-zlib-zip-edgecases.js`, `test-zlib-zip-encoding.js`,
`test-zlib-zip-file-lifecycle.js`, `test-zlib-zip-metadata.js`,
`test-zlib-zip-property.js`, `test-zlib-zip-zip64.js`, `test-zlib-zip-fuzz.js`,
`test-zlib-zip-hardening.js` (11 from the banked 36) +
`test-zlib-zip-files.js`, `test-zlib-zip-interop.js`, `test-zlib-zip-security.js`,
`test-zlib-zip-security-hardening.js`, `test-zlib-zip-writable.js` (5 reclassified).
Exports needed: all 8 added exports (above); methods exercised include
`ZipEntry.create/createSync/read/content/contentSync/createStream`,
`ZipBuffer` index/`has`/`size`/`toBuffer`, `ZipFile.open/openSync/add/delete`,
`createZipArchive/createZipArchiveSync`, `zipFiles`,
`getMaxZipContentSize/setMaxZipContentSize`. Methods `deflate` (8), `store` (0),
`zstd` (93) all exercised — zstd entries depend on the vendored zstdify engine.
Conservative 13: `zip-hardening`, `zip-security-hardening`, `zip-fuzz` are the
deepest validation/fuzz coverage and may not flip on a first pass; the other 13
are straight API-surface round-trips. +1 conditional:
`test-zlib-zip-experimental-warning.js` (needs node-26 harness host + use-time
warning emission; 0 flips under the current v24 host).

### L-RESET — reset() state semantics — 4 flips

Flips: `test-zlib-brotli-reset.js`, `test-zlib-zstd-reset.js`,
`test-zlib-zstd-reset-incomplete-frame.js`,
`test-zlib-reset-incomplete-output.js`. Work: track per-stream emitted
member/frame output; `reset()` after output refuses with
`ERR_ZLIB_INCOMPLETE_FRAME` (gzip, zstd-compress); `reset()` preserves
dictionary (brotli-decompress) and parameters (zstd-decompress). Conservative
4 — each test pins exactly one behaviour, all four are narrowly scoped.

### L-SMALL — three one-line-class validation/encoding fixes — 3 flips

Flips: `test-zlib-zstd-dictionary.js` (throw `ERR_INVALID_ARG_TYPE` for
`dictionary: null`), `test-zlib-zstd-pledged-src-size.js` (async convenience
methods must honor `defaultEncoding: 'latin1'` when encoding string input —
sync path already does), `test-zlib-params.js` (`params()` callback after
`destroy()` must fire with `ERR_STREAM_DESTROYED`). Conservative 3, but
`params` carries the bisect caveat in F5 (mechanism of its newly-failing state
is unproven — lane must determine whether the fix is in `params()`, the flush
deferral, or the destroy path).

### Not a flip lane — F4 zstd multi-frame

`test-zlib-reject-garbage-after-end.js` needs the F4 work (concatenated zstd
frames, errors in subsequent frames) **and** a Brotli compressor (F1). Fixing
F4 alone flips 0 whole tests. Do it as subtest-level fidelity inside a zstd
lane, or not at all; never count it as a flip.

## NO-FIX list (17)

| # | test | one-line reason (probe/file evidence in F-sections) |
|---|---|---|
| 1–12 | brotli.js, brotli-flush, brotli-from-string, brotli-dictionary, brotli-16GB, convenience-methods, test-zlib.js, write-after-flush, random-byte-pipes, decode-strings, premature-end, type-error | need a real pure-JS Brotli compressor; none exists, stored-block rescue disproven (`NOTES-zlib-brocha.md`) |
| 13 | reject-garbage-after-end | brotli half needs the compressor (zstd half is separable F4 work, 0 flips alone) |
| 14 | invalid-input | brocha reports errno -9, native -17, for the block-switch frame; adding the missing constant does not flip it |
| 15 | zstd-flush | needs a streaming zstd encoder with flush; zstdify is whole-buffer (`flush()` emits `''`) |
| 16 | zip-internals | tests Node's `internal/zip/*` modules, not public API (`Cannot find module 'internal/zip/binary'` even with `--expose-internals`) |
| 17 | zip-vfs | needs the `node:vfs` module, not zlib (`node: bad option: --experimental-vfs` on the host binary) |

## New-in-26 vs pre-existing split

- **New files in 26 (24 of 41):** all 19 zip tests + 5 others —
  `test-zlib-brotli-reset.js`, `test-zlib-decode-strings.js`,
  `test-zlib-reset-incomplete-output.js`,
  `test-zlib-zstd-reset-incomplete-frame.js`, `test-zlib-zstd-reset.js`
  (absent from the vendored v24 `parity/node-test/parallel/` set).
- **Pre-existing files (17 of 41):** the other 17 gap tests. Of these, 13 were
  already v24 NO-FIX (F1 × 12 incl. reject-garbage + F2 zstd-flush); 3 pass on
  v24 but fail on **new assertions in 26** (`zstd-dictionary` validation loop,
  `zstd-pledged-src-size` latin1/async-consistency, `reject-garbage-after-end`
  rewritten with new zstd cases — still blocked by F1 overall); 1
  (`test-zlib-params.js`) is byte-identical to v24 modulo quotes yet fails now
  (bisect owed, F5).
- **Changed-but-same-shape:** the other pre-existing files differ from v24
  only by the Node 26 tree's formatting pass (single quotes, re-wrapping) plus
  the `node:test` migration; normalized diffs (quotes/whitespace stripped) are
  small except where noted above.
- v24 close was 52/65 with 13 NO-FIX. Node 26 has 89 zlib test files
  (65 v24 + 24 new); the 41 non-passes are 17 pre-existing + 24 new.

## Baseline corrections (what the sweep got wrong)

1. **5 "fails-natively" are oracle parallel-run artifacts — true fails-natively
   is 0.** Each of `test-zlib-zip-files.js`, `test-zlib-zip-interop.js`,
   `test-zlib-zip-security-hardening.js`, `test-zlib-zip-security.js`,
   `test-zlib-zip-writable.js` passes on real Node 26.13.1 when run
   sequentially: 3 sequential runs × 5 tests = **15/15 exit 0**. Reproducing
   the oracle's conditions (4 concurrent runs, same cwd, `--jobs 4`) fails
   3 of 4 with `ENOENT … '/…/test/.tmp.0/zlib-zipfiles-…/link'` — the tests
   share `test/.tmp.0` and one test's `tmpdir.refresh()` deletes another's
   files. `run-oracle.mjs` runs with `--jobs 4` and a 30 s kill timer; the
   classification is a tmpdir collision, not a native failure. Corrected
   zlib totals: **41 shim-gaps, 0 fails-natively**. (The same caveat may apply
   to other modules' fails-natively — out of scope here, flagged for the
   coordinator.)
2. **`run-baseline.mjs` ignores `// Flags:` headers; `run-oracle.mjs` parses
   them.** `runOne` in the baseline spawns `node --import preload <test>` with
   no flags, so 3 gap tests ran without the flags Node requires:
   `test-zlib-zip-internals.js` (`--expose-internals`),
   `test-zlib-zip-vfs.js` (`--experimental-vfs`), `test-zlib.js`
   (`--no-warnings`). Isolated re-runs **with** the flags: internals still
   exit 1 (genuine — internal modules missing), test-zlib.js still exit 1
   (genuine — F1 compressor), zip-vfs exit **9** = `node: bad option:
   --experimental-vfs` (not shim evidence at all — see 3).
3. **`test-zlib-zip-vfs.js` harnessExit 9 is a host-binary artifact.** The
   harness host is `/usr/bin/node` **v24.22.1** (checked: `node --version`),
   which does not know `--experimental-vfs`. The flag is rejected before any
   test code runs.
4. **`test-zlib-zip-experimental-warning.js` harnessExit 1 is a host-version
   artifact.** The test spawns children via `spawnSync(process.execPath, …)`;
   probe under the harness shows `process.execPath` is `/usr/bin/node`
   (v24.22.1) and the child dies with `SyntaxError: The requested module
   'node:zlib' does not provide an export named 'ZipFile'`, status 1.
   Natively under node-26 it passes 5/5. The test cannot adjudicate the shim
   until the harness host is node-26.
5. **`test-zlib-brotli-16GB.js` 124 is genuine, not a sweep flake.** Isolated
   re-run at 10 s also exits 124; the baseline phase-2 30 s run also 124.
   Consistent with the whole-buffer brocha decode of a 16 GB-output frame
   (`NOTES-zlib-brocha.md`).
6. **`test-zlib-params.js` newly fails on an unchanged test** (see F5) —
   mechanism unproven; lane must bisect. Not claimed as a proven regression.

## Arithmetic check

- Banked: 36 shim-gap + 5 fails-natively = 41. Corrected: 41 shim-gap + 0
  fails-natively.
- Families: F1 13 + F2 1 + F3 4 + F4 1 + F5 3 + F6 1 + F7 19 = 42? No — F4's
  test (`reject-garbage-after-end`) is already counted in F1 (13); F4 is a
  subtest-level aspect of that same file, not an additional test. Unique tests:
  13 + 1 + 4 + 3 + 1 + 19 = **41**. ✓
- Lanes: L-ZIP 16 + L-RESET 4 + L-SMALL 3 = **23 flips**; NO-FIX 17;
  conditional (experimental-warning, host-blocked) 1. 23 + 17 + 1 = **41**. ✓
- Conservative lane total: 13 + 4 + 3 = **20 flips** (+1 conditional).

## Isolated re-run log (all under the harness invocation, exit codes quoted)

Pre-existing, all exit 1 except brotli-16GB: brotli-dictionary, brotli-flush,
brotli-from-string, brotli-reset, brotli.js, convenience-methods,
decode-strings, invalid-input, params, premature-end, random-byte-pipes,
reject-garbage-after-end, reset-incomplete-output, type-error,
write-after-flush, zstd-dictionary, zstd-flush, zstd-pledged-src-size,
zstd-reset-incomplete-frame, zstd-reset, test-zlib.js; brotli-16GB exit 124
(10 s cap). Zip, all exit 1: zip-coverage, zip-edgecases, zip-encoding,
zip-experimental-warning, zip-file-lifecycle, zip-files, zip-fuzz,
zip-hardening, zip-interop, zip-metadata, zip-property, zip-security,
zip-security-hardening, zip-sync, zip-writable, zip-zip64, zip.js;
zip-internals exit 1 with `--expose-internals`; zip-vfs exit 9 with
`--experimental-vfs`; test-zlib.js exit 1 with `--no-warnings`. Full per-test
stderr/stdout captured in `/tmp/z26-logs/` (ephemeral; key lines quoted above).
