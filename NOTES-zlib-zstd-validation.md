# NOTES — zlib lane Z3: zstd validation + pledged-size wrapper

- Lane: L3 (triage `test-zlib-zstd-pledged-src-size.js`), branch
  `fix/zlib-zstd-validation`, base main `06e7b51c`.
- Target flips 1→0, verified 2× isolated. Module goes 43/65 → 44/65
  (43 dashed + `test-zlib.js`, which fast-sweep never sees).

## Mechanism

Root cause: `src/zlib.js:1664` skips option normalization for brotli/zstd
(`isBrotli || isZstd ? {} : normalizeZlibOptions(...)`) and the Zstd
classes were built with `validate: undefined`, so every zstd option check
was NO THROW. Fix, all in `src/zlib.js` (118 insertions, 4 deletions):

1. **`validateZstdOptions(options, isCompress)` (new)** — mirrors Node
   v24.20.0 `lib/zlib.js` Zstd constructor + the binding's pledged-size
   checks, probe-verified against real Node v24.22.1:
   - `params` keys: range 0–402 compress / 0–100 decompress, computed from
     the shim constants exactly like Node (`MathMax` over `ZSTD_c_*` /
     `ZSTD_d_*`); out-of-range, non-numeric (`"abc"`), or negative keys →
     `RangeError` `ERR_ZSTD_INVALID_PARAM`, message
     `"<origKey> is not a valid zstd parameter"`.
   - Duplicate numeric keys (`0` + `"00"`) → same error naming the second
     key, via the `-1`-filled `Uint32Array` sentinel check, exactly Node's
     `(initParamsArray[key] | 0) !== -1` semantics (fractional keys throw
     the same way — `initParams[50.5]` is not an element).
   - Param value not number/boolean → `ERR_INVALID_ARG_TYPE`
     (`options.params[key]`, `number`) with Node's exact message shape.
   - Native-range checks for the two params the binding's setter
     validates: strategy (`ZSTD_c_strategy`, compress) 0–9, windowLogMax
     (`ZSTD_d_windowLogMax`, decompress) 0 (= default) or 10–31; anything
     else → `Error` `ERR_ZLIB_INITIALIZATION_FAILED`, message
     `"Setting parameter failed"`. `-1` is the array's unset sentinel and
     is skipped. The binding accepts any compression level (clamped
     internally — level 32/100 compress fine natively), so no level check.
   - `pledgedSrcSize`: non-number → `TypeError` `ERR_INVALID_ARG_TYPE`
     `"pledgedSrcSize must be a number"`; not a safe integer → `RangeError`
     `ERR_OUT_OF_RANGE` `"pledgedSrcSize must be a safe integer"`;
     negative safe integer → `RangeError` `ERR_OUT_OF_RANGE`
     `"pledgedSrcSize must be non-negative"` (checked in that order).
     Applies to both Zstd classes; top-level `strategy` / `windowLogMax`
     options are ignored, like Node.
   - `ERR_ZLIB_INITIALIZATION_FAILED` now accepts an optional message
     (default `"Initialization failed"` — the brotli call site is
     unchanged).
2. **Pledged-size counting** — `ZlibBase` stores `_pledgedSrcSize` in the
   constructor (validated first, since `makeZlibClass` runs the validator
   before `super()`); `_processChunkSync` throws `Error`
   `ZSTD_error_srcSize_wrong` / `errno` 72 / `"Src size is incorrect"` when
   the finishing flush arrives on a `MODE_ZSTD_COMPRESS` stream whose
   `bytesWritten` differs from the pledge. This covers the stream path
   (final transform via `_flush`), the sync path (`zlibBufferSync` calls
   `_processChunkSync` once with the finish flag), and the async path
   (stream-based). Decompress validates the option but never enforces the
   count, like Node. Flush-flagged buffers are 0 bytes, so they cannot
   inflate `bytesWritten`.

## Evidence

- Native probes (`/tmp/z3-verify-probe*.mjs`, real Node v24.22.1):
  pledged messages/codes for all 9 invalid values; params max keys
  (402 compress / 100 decompress); dup keys; bad value type; strategy
  0/9 OK, -1 = unset, -2/10 throw; windowLogMax 0/10/31 OK, 1/9/32/-2
  throw; windowLog (compress key 101) same 0/10–31 shape; compression
  level 22/23/32/100/-2 all OK incl. at write time; sync + stream
  mismatch error `errno` 72.
- Target `test-zlib-zstd-pledged-src-size.js`: baseline 1,1 → after fix
  0,0 (isolated, `PARITY_TARGET=zlib`).
- `zz-z3-validate.js` (temporary, deleted after use): the validation +
  flush blocks of `test-zlib-zstd.js` replicated through the shim — all
  assertions passed (key 10000, dup keys, strategy 130, windowLogMax 1,
  flush/finishFlush `Z_FINISH` range, decompress pledged validation +
  no-enforcement, bad param value type).
- Differential fast-sweep (64 dashed zlib tests, `--jobs 2`, vs base
  `zlib-sweep-2026-11-18.csv`): pass 43 (was 42), fail 21 (was 22);
  toward-pass 1 (`test-zlib-zstd-pledged-src-size.js`); regressions 0;
  mode-changes 0; timeouts 0.

## Guards (all still 0)

- `test-zlib.js` 2× isolated (manual — fast-sweep never sees it).
- Passing zlib sample: `test-zlib-deflate-constructors.js`,
  `test-zlib-convenience-methods.js`, `test-zlib-close-after-error.js`,
  `test-zlib-crc32.js`, `test-zlib-const.js`.

## What this does NOT do

- `test-zlib-zstd.js` still fails — now at its FIRST block (line 28,
  level scaling: all sizes 10049, pass-through output). Its validation
  blocks are proven above via the zz probe but are unreachable until L6b
  lands level scaling. Do not claim zstd.js here.
- Native-range checks cover only strategy + windowLogMax, per the frozen
  triage design. Probed-but-unimplemented: windowLog (101, compress)
  0/10–31, hashLog (102) 6–30, minMatch (105) 3–7 — same one-branch shape
  if a future test demands them. No codec touched; no L2 region touched
  (flush/empty-input emission path untouched).
- The 6 NO-FIX tests were not touched.

## Ship

- PR #464 / Merge SHA: 931951bf
- Branch: `fix/zlib-zstd-validation`
- Worktree: `~/workspace/worktrees/zlib-z3-zstd-validation`
- Rebased 2026-11-18 onto main `dda6f97` (Z1 #462 + Z2 #463 landed first);
  single content conflict in `_processChunkSync`, resolved by keeping
  both: pledged check first, then Z2's empty-frame append + decode twin.
  Post-rebase differential vs new main: toward-pass 1 (target only),
  regressions 0.
