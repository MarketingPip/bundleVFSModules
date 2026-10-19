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

### 2026-10-18 ~22:30–24:00 EDT — night-shift stream-lifecycle pass (43/65)

Commits (all on feat/zlib-parity):
- `5bdffb6f` — destroy-close callback, writable backpressure/drain,
  chunkSize output chunking → test-zlib-destroy, test-zlib-flush-drain,
  test-zlib-flush-drain-longblock
- `b89d474a` — inflate engine reports actually-consumed bytes
  (bytesWritten parity) → test-zlib-premature-end (deflate pairs)
- `fb0af31b` — sync chunk-type throw, per-mode flush defaults,
  writable/readable getters → test-zlib-object-write,
  test-zlib-write-after-flush, test-zlib-random-byte-pipes,
  test-zlib-brotli-flush-invalid-kind (bonus)
- `40877370` — kMaxLength integration (default maxOutputLength +
  validation bound captured at load; ERR_BUFFER_TOO_LARGE now extends
  RangeError) + zlib→buffer extra redirect in parity harness →
  test-zlib-kmaxlength-rangeerror
- `6df7b14a` — 'close' after natural 'end', DEP0184 without-new warning
  → test-zlib.js

Root causes worth remembering:
- **Legacy pipe gates on `dest.writable`.** Our MiniTransform lacked it,
  so `legacyStream.pipe(zlibStream)` silently dropped all data. Fixed
  with `writable`/`readable` getters (native legacy pipe has the same
  gate — verified against real Node).
- **Flush deferral must not re-enter the public method.** Node defers
  flush() until 'drain' internally; re-calling `this.flush` would hit a
  userland wrapper twice. Ours goes through private `_flushInner`.
- **Per-mode flush defaults** (brotli PROCESS/FINISH/FLUSH, zstd
  e_continue/e_end/e_flush) — copied from Node's lib/zlib.js; the old
  single Z_FULL_FLUSH default threw ERR_OUT_OF_RANGE for stubs.
- **Output chunking at chunkSize** in `_processChunk` — the native
  binding emits output in chunkSize pieces; single transforms of >16KB
  must still produce multiple 'data' events.
- **Harness gotcha:** manual `node --import ./parity/preload.mjs <test>`
  runs with PARITY_TARGET unset → target=undefined → EVERY builtin
  redirects to shims (incl. stream, which patches timer globals via
  als-browser and trips the global-leak detector). The real runner sets
  PARITY_TARGET=zlib. Always run manual probes with
  `PARITY_TARGET=zlib` to match.
- **kMaxLength:** Node captures `require('buffer').kMaxLength` at zlib
  load; the test mutates it pre-require. Needed a zlib→buffer extra
  redirect (http→net precedent) in parity/preload.mjs + parity/hooks.mjs
  so the mutation lands on the cell our zlib reads.

Remaining failures are all inherent: 13 brotli/zstd stub tests, missing
pseudo-multimember-gzip fixture, and stub-only parts of invalid-input /
maxOutputLength / premature-end / reject-garbage-after-end / truncated /
type-error / zero-byte.
