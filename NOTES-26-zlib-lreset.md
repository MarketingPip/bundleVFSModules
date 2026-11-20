# NOTES — Node 26 Wave 2 L-RESET: reset() state semantics (zlib)

- Date: 2026-11-20. Lane: L-RESET (F3). Base: origin/main `b5f2e94f`
  (task brief cited `652333e7`; that SHA predates the merged L-SMALL #511
  and stream #522 — the worktree was cut at live origin/main instead).
- Banked (coordinator-verified on live main, this run): zlib **51/89**
  (37 fail + 1 timeout: test-zlib-brotli-16GB.js, the same NO-FIX timeout
  as the baseline, not a lane test).
- Baseline differential (this lane, before the fix):
  `node parity/drift/run-baseline.mjs --node26-src ~/workspace/local/node-26-src
  --worktree <worktree> --out /tmp/zlib-lreset/base.jsonc
  --csv-dir /tmp/zlib-lreset/base-csv --modules zlib --jobs 2 --short 10 --full 30`
  → **51/89 pass, 37 fail, 1 timeout** — reproduces the banked count exactly.
  Guard set = the 51 passes (list in § Guards).
- Oracle: all 4 lane tests exit 0 on real Node 26.13.1
  (`~/workspace/local/node-26/bin/node`).

## Method

Diagnosed from Node 26 source FIRST (`~/workspace/local/node-26-src/src/node_zlib.cc`),
then confirmed with probes on the Node 26.13.1 binary. No fresh web research.

Native reset semantics (node_zlib.cc):

- `ZlibContext::ResetStream` (:1281): refuses ONLY when
  `mode_ == GZIP && !stream_complete_ && output_emitted_` — deflateReset is
  deflateEnd + deflateInit and the gzip header cannot be taken back.
  zlib-wrapped deflate still allows reset after flush; raw deflate has no
  wrapper header. `CompressionStream::Reset` (:706) reports a refusal via
  `EmitError` — a stream error, never a sync throw.
- `ZstdCompressContext::ResetStream` (:1816): refuses iff
  `!frame_complete_ && frame_output_emitted_` (ZSTD_reset_session_only
  cannot take back emitted bytes). Any non-end call clears
  `frame_complete_`; output sets `frame_output_emitted_`.
- `BrotliDecoderContext::ResetStream` (:1679) / `BrotliEncoderContext::ResetStream`
  (:1579): re-Init with the saved dictionary + replay saved params —
  reset preserves dictionary/params.
- `ZstdDecompressContext::ResetStream` (:1940): `ZSTD_DCtx_reset(session_only)` —
  parameters set at init (e.g. `ZSTD_d_windowLogMax`) survive reset.

## Fix (one file: `src/zlib.js`)

1. **Gzip refusal** — `PakoDeflateEngine` tracks `_outputEmitted` (set on any
   write returning output, header included); `reset()` throws
   `ERR_ZLIB_INCOMPLETE_FRAME` (errno `Z_STREAM_ERROR`, native message
   verbatim) iff wrapper is gzip AND output was emitted AND the stream has
   not finished. Deflate/deflateRaw/inflate paths are untouched.
2. **Zstd compress refusal + mid-stream emission** — `ZstdCompressEngine`
   tracks `_frameComplete` / `_frameOutputEmitted` (native names); `reset()`
   refuses on the same condition. A flush (`ZSTD_e_flush`) with buffered
   input, or a single write large enough to fill a zstd block
   (`ZSTD_BLOCKSIZE_MAX` = 128 KiB), now emits a complete frame for the
   input so far and starts a new frame. zstdify cannot emit a frame
   *fragment*, so the flushed bytes differ from native's — see
   test-zlib-zstd-flush below. `end()` with nothing buffered after a
   mid-stream emission emits nothing (no spurious second empty frame);
   total-empty input still gets its 9-byte empty frame. Ceiling:
   single-frame continuation needs a real streaming encoder.
   The bound keys on the SINGLE write's size, not the accumulated length
   — see § Regression caught by the differential.
3. **Refusal surfacing** — `_handle.reset()` catches only
   `ERR_ZLIB_INCOMPLETE_FRAME` and destroys the stream with it on a
   microtask (native `EmitError` timing). Inline destroy would let a
   following `end()` emit a second `ERR_STREAM_DESTROYED`; the microtask
   lets the end's write queue first, so destroy fails it silently.
   `finished()` rejects with the refusal code. Other engine errors still
   throw synchronously; the write-in-progress guard is unchanged.
4. **Zstd decompress params** — `zstdDecompressOptions` now plumbs
   `ZSTD_d_windowLogMax` (params[100]) into `ZstdDecompressEngine` as a
   constructor field, so `reset()` (which clears only buffered input)
   cannot drop it. `_checkWindowLog` parses the frame header
   (`zstdFrameWindowLog`: window descriptor `10 + (b >> 3)`, or for
   single-segment frames `ceil(log2(FCS))` floored at 10) and throws
   `ZSTD_error_frameParameter_windowTooLarge` (errno 16, native message
   "Frame requires too much memory for decoding", probed on 26.13.1)
   before decoding. Probe: native windowLog-11 frame → max 10 rejects,
   max 11 passes; the shim's own 4096-byte single-segment frame reports
   windowLog 12 (zstdify ignores `ZSTD_c_windowLog`, so the boundary
   differs from native for max 11/12 — the test only pins max 10).
5. **Zstd multi-frame decode (dependency, not a counted flip)** —
   `ZstdDecompressEngine.write` now walks the remainder after the first
   complete frame while it parses as complete frames and concatenates
   each frame's output. Required: a flush-emitted frame plus the final
   frame must round-trip through the shim's own decompressor
   (reset-incomplete-frame "flush followed by end"). Anything
   unparseable (incomplete/corrupt frame, junk) falls back to the old
   first-frame-only + trailing-garbage result. Ceiling: a frame split
   across writes still ends the stream after the first frame (F4
   chunking work); `test-zlib-reject-garbage-after-end.js` still fails
   on its brotli half, so F4 flips 0 whole tests, as triaged.
6. **Incidental fix** — the `const { ... } = constants` destructure
   omitted `Z_STREAM_ERROR`, so the pre-existing bare references at the
   write-after-finish throw and the `p.err` fallback were latent
   `ReferenceError`s. Added the name (one word); my gzip refusal needed
   it on a live path.

Not touched: L-ZIP (Wave 3), L-SMALL files (merged #511), F4 as a counted
flip, F1/F2/F6/F7 NO-FIX tests, any other module. No docs-number changes.

## Flips (3) — each isolated [0,0] x2 under the harness

Harness form: `PARITY_TARGET=zlib timeout 30 node --import ./parity/preload.mjs
parity/node-test/parallel/<test>` with the Node 26 test file staged.

| test | run 1 | run 2 | baseline subtests |
|---|---|---|---|
| test-zlib-reset-incomplete-output.js | 0 | 0 | was 5/7 (2 gzip refusals: "Missing expected rejection"); now 7/7 |
| test-zlib-zstd-reset-incomplete-frame.js | 0 | 0 | was 3/5 (both `assert.ok(chunks.length > 0)` failed — flush / 512 KiB write emitted nothing); now 5/5 |
| test-zlib-zstd-reset.js | 0 | 0 | was 2/3 (params subtest "Missing expected rejection" :65); now 3/3 |

New count: **51 + 3 = 54/89**.

## Guards held (full 51-test pass set — branch differential)

Branch differential (same run-baseline.mjs invocation, `--out
/tmp/zlib-lreset/branch2.jsonc --csv-dir /tmp/zlib-lreset/branch2-csv`):
**54/89 pass, 34 fail, 1 timeout** — the 51 baseline passes all still
pass (0 regressions); the only movement is the 3 flips above.

## Regression caught by the differential (repaired)

The first branch differential (`branch.jsonc`) came back **53/89**: the
3 flips held, but `test-zlib-zstd-pledged-src-size.js` (L-SMALL guard)
regressed. Root cause: the first mid-stream emission bound was the
accumulated length (`_len >= chunkSize`, 16384). The sync/async
convenience paths drive the engine in small `chunkSize` pieces, so the
18 KiB async compress (`'héllo wörld 🚀 '.repeat(1000)`) split into two
frames (46 bytes) while the sync path stayed one frame (37 bytes) —
`assert.deepStrictEqual(compressed, zlib.zstdCompressSync(input, opts))`
failed. Repair: the bound now keys on the single write's size
(`bytes.length >= 128 * 1024`, one full zstd block); the `chunkSize`
threading was reverted, and `end()` after a mid-stream emission with
nothing buffered emits nothing. Re-ran the 3 flips isolated (exit 0)
plus the pledged test (exit 0), then the full differential again:
**54/89, 0 regressions**. A `rm -f` during that repair briefly deleted
the tracked vendored `parity/node-test/parallel/test-zlib-zstd-pledged-src-size.js`
(it is v24-vendored, not a staged 26 file); restored with
`git checkout --` — the worktree diff is `src/zlib.js` only.

Guard list (51, all exit 0 on branch): test-zlib-brotli-flush-invalid-kind,
test-zlib-brotli-from-brotli, test-zlib-brotli-kmaxlength-rangeerror,
test-zlib-close-after-error, test-zlib-close-after-write,
test-zlib-close-in-ondata, test-zlib-const, test-zlib-crc32,
test-zlib-create-raw, test-zlib-deflate-constructors,
test-zlib-deflate-raw-inherits, test-zlib-destroy-pipe, test-zlib-destroy,
test-zlib-dictionary-fail, test-zlib-dictionary, test-zlib-empty-buffer,
test-zlib-failed-init, test-zlib-flush-drain-longblock,
test-zlib-flush-drain, test-zlib-flush-flags,
test-zlib-flush-write-sync-interleaved, test-zlib-flush,
test-zlib-from-concatenated-gzip, test-zlib-from-gzip-with-trailing-garbage,
test-zlib-from-gzip, test-zlib-from-string,
test-zlib-invalid-arg-value-brotli-compress, test-zlib-invalid-input-memory,
test-zlib-kmaxlength-rangeerror, test-zlib-maxOutputLength,
test-zlib-negative-zero, test-zlib-no-stream,
test-zlib-not-string-or-buffer, test-zlib-object-write, test-zlib-params,
test-zlib-reset-before-write, test-zlib-reset-during-write,
test-zlib-sync-no-event, test-zlib-truncated, test-zlib-unused-weak,
test-zlib-unzip-one-byte-chunks, test-zlib-write-after-close,
test-zlib-write-after-end, test-zlib-zero-byte, test-zlib-zero-windowBits,
test-zlib-zstd-dictionary, test-zlib-zstd-from-string,
test-zlib-zstd-from-zstd, test-zlib-zstd-kmaxlength-rangeerror,
test-zlib-zstd-pledged-src-size, test-zlib-zstd.

Spot checks during development: test-zlib-zstd-flush still exit 1
(F2 NO-FIX preserved — flush now emits zstdify's 25-byte frame
`KLUv/SAQgQAA/9j/4AAQSkZJRgABAQEASA==` vs native's flushed fragment
`KLUv/QBYgAAA/9j/4AAQSkZJRgABAQEASA==`, differing at the frame-header
bytes); test-zlib-zstd.js exit 0 on branch (an early loop typo double-
appended `.js` and reported a harness artifact, re-run clean).

## NO-FIX (1) — test-zlib-brotli-reset.js, with proof

The brief's F3 row says "the reset drops the dictionary". The probe
disproves it: under the harness, `brotliCompressSync(input, {dictionary})`
returns the input **unchanged** (`compressed.equals(input) === true`,
5700 bytes — the PassThroughEngine stub, F1), and brocha then throws
`Error: unexpected end of file` (`src/zlib.js:2220` brochaDecodeError)
on those plain-text bytes. The failure is **identical with and without
`reset()`** — stream decompress (no reset), stream decompress (reset),
and sync decompress all throw `Z_BUF_ERROR / unexpected end of file`.
Reset is irrelevant: no dictionary-preserving reset can make brocha
decode bytes that were never brotli-compressed. The file flips only
when a real Brotli compressor exists (F1 NO-FIX). Its compress subtest
("BrotliCompress reset preserves its initial options") already passes.
Follow-up for the compressor lane: `BrochaDecodeEngine` drops the
dictionary at construction (brocha's `decompress(input, {customDictionary})`
does accept one), so when a real compressor lands the decoder must be
plumbed the dictionary too — not done here (no flip depends on it).

Not counted: test-zlib-brotli-16GB.js (timeout, NO-FIX per baseline).

## Ship

- Branch: `feat/w2-zlib-lreset`
- PR: #524
- Merge SHA: `4a05cd91f01f417fa06c37a2509b26fc7bd83cf7` (squash-merge of PR #524)
- Final count: **zlib 54/89** (51 banked + 3 flips, 0 regressions)

CI on first head `af84fcc2` (run 44689647790): Parity **success**; Build **failure**
on exactly one test — `tests/timers.test.js`, `timers-web › setInterval /
clearInterval › interval fires repeatedly until cleared`, jest 30 s timeout
(226 suites / 3070 tests passed). Zero zlib references in that file; the test
is a 10 ms interval / 50 ms timeout timing assertion — a load flake, not this
lane (diff is `src/zlib.js` only). Re-run-failed-jobs refused 403 (token lacks
actions scope), so CI was retriggered by this NOTES commit (PR number
recorded); no code changed since the 54/89 differential.
