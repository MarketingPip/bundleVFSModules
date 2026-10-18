# NOTES-zlib-deep.md — Deep zlib parity investigation (2026-10-18)

Branch: `feat/zlib-parity` (local only)
Baseline: 34/65 zlib tests pass.

## Commits
- `5b8b92f0` — GOOD: validates buffer arg type (test-zlib-not-string-or-buffer passes). Keep cherry-pickable.
- `b3645805` — INCOMPLETE: rejectGarbageAfterEnd sync-path check (engine doesn't set trailingGarbage). Do NOT include in PR.

## Investigation plan (priority order)
1. Engine-level `trailingGarbage` detection for concatenated gzip members → test-zlib-type-error + reject-garbage-after-end
2. Error-event emission → test-zlib-invalid-input
3. Stream lifecycle issues (destroy, flush-drain, etc.), easiest first

## Key test expectations (from test-zlib-type-error.js)
- `DecompressionStream("gzip")` must reject with TypeError on trailing data (double gzip, gzip+empty, etc.)
- `zlib.gunzipSync(double)` returns "aa" normally, but throws ERR_TRAILING_JUNK_AFTER_STREAM_END with `rejectGarbageAfterEnd: true`
- Same for brotli (brotliDecompressSync) — but brotli is an honest stub, so those subtests are inherent failures

## Engine code (src/zlib.js)
- `PakoDeflateEngine` ~line 848 — pako-based engine
- `ZlibBase` ~line 1444 — stream base class
- `_processChunkSync` ~line 1564
- `zlibBufferSync` ~line 1805 — checks `stream._engine.trailingGarbage && stream._rejectGarbageAfterEnd`

## Notes

### 2026-10-18 ~15:45 EDT — trailingGarbage engine fix (commit e9aecc6e)

**Problem:** `zlib.gunzipSync(double, { rejectGarbageAfterEnd: true })` did not throw.
The b3645805 commit added the check in `zlibBufferSync`, but the engine never
set `trailingGarbage` for concatenated gzip (pako chains members internally
in a single push, exposing no member count).

**Fix (src/zlib.js, +106/-2):**
1. `PakoInflateEngine` constructor accepts `rejectGarbageAfterEnd`
2. New `_gzipHeaderLength()` — RFC 1952 header parser (handles FEXTRA/FNAME/
   FCOMMENT/FHCRC)
3. New `_hasTrailingGzipMember()` — uses raw pako inflate to find first
   member's deflate end; `avail_in > 8` means trailing data
4. `write()`: pre-scan for single-push concatenated gzip when
   `rejectGarbageAfterEnd`
5. `write()`: `_memberEnded` and `finished` paths set `trailingGarbage`
   instead of chaining when `rejectGarbageAfterEnd`
6. `write()`: `if (ok)` block checks `avail_in` for zlib/raw trailing data
7. `ERR_TRAILING_JUNK_AFTER_STREAM_END` now extends `TypeError` (was `Error`)

**Results:**
- test-zlib-reject-garbage-after-end: 5/7 (inflate, inflateRaw, gunzip,
  unzip, boolean check pass; brotli/zstd fail = honest stubs, inherent)
- test-zlib-type-error: 3/4 (DecompressionStream x3 pass; sync test fails
  only on brotli stub part — cannot parse brotli framing without decoder)

**Branch note:** Was accidentally on `fix/http-parity-hangs` mid-session;
stashed, switched back to `feat/zlib-parity`, popped. The two
`fix/cookie-jar-rewire` stashes were NOT touched.

### test-zlib-invalid-input — triaged (inherent for stubs)

The 4 real decompressors (Unzip, Gunzip, Inflate, InflateRaw) correctly emit
`error` on invalid input. The 2 stubs (BrotliDecompress, ZstdDecompress) do
not — `PassThroughEngine` has no codec to validate with. This is inherent
to the honest-stub design; cannot fix without a real brotli/zstd decoder.

### Remaining failures (2026-10-18 ~16:00 EDT)

**Inherent (don't fix):**
- 15 brotli/zstd stub tests
- 1 missing fixture (test-zlib-from-concatenated-gzip needs
  `parity/node-test/fixtures/pseudo-multimember-gzip.z`)
- test-zlib-invalid-input brotli/zstd parts, test-zlib-type-error brotli
  part, test-zlib-reject-garbage-after-end brotli/zstd parts

**Stream lifecycle (deeper architecture work):**
- test-zlib-destroy: destroy callback not called (mustCall 1 vs 0)
- test-zlib-flush-drain, flush-drain-longblock: `ws.needDrain` undefined
- test-zlib-truncated: truncated input doesn't throw
- test-zlib-premature-end: byte count mismatch (40 vs 15)
- test-zlib-maxOutputLength, object-write, random-byte-pipes,
  write-after-flush: need investigation
- test-zlib-zero-byte: loop includes brotli stub

**Needs Buffer integration:**
- test-zlib-kmaxlength-rangeerror: test sets `buffer.kMaxLength = 64`,
  needs integration with our Buffer shim

**Current score:** 33/48 non-stub tests pass (was 34/65 with stubs counted).
The gzip rejectGarbageAfterEnd work is the main win.
