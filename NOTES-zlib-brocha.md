# NOTES — Z5: Brotli decoder via brocha 0.1.1

**Status: HELD — DO NOT MERGE.** The decoder is implemented and correct on
real frames (+3 flips, verified 2×), but landing it regresses 4 currently
passing tests (net −1), because there is no brotli compressor. A stored-block
compressor rescue was probed and disproven (brocha cannot decode stored
metablocks). The parent decides: ship for fidelity (52/65) or hold (52/65) —
both paths total 52; see "Ship decision" below.

- Branch: `fix/zlib-brocha` (worktree `~/workspace/worktrees/zlib-z5-brocha`)
- Base: main `931951bf` (PR #464, Z3)
- Date: 2026-11-18
- Lane: L5 (triage), dependency `brocha@0.1.1` (exact pin)

## What was built

`BrochaDecodeEngine` in `src/zlib.js` (~1637-1840): a buffering adapter
around brocha's whole-buffer `decompress()`, wired into `_createEngine` for
`MODE_BROTLI_DECODE` only. BrotliCompress stays the passthrough stub; Zstd
untouched (L6).

- Accumulates input; attempts decode on every write.
- Success → emit output, mark finished. Code 3 (trailing data) → binary
  search for the first clean prefix (`brochaFirstFrameEnd`), emit the first
  frame, set `trailingGarbage` (ZlibBase turns it into
  `ERR_TRAILING_JUNK_AFTER_STREAM_END` when `rejectGarbageAfterEnd` is set).
- Codes 2 (`NEEDS_MORE_INPUT`) / −22 (`ALLOC_TREE_GROUPS`): mid-stream,
  buffer and wait; at the final flush, `Z_BUF_ERROR` "unexpected end of file".
- Other negative codes: throw now, mapped to Node's shape
  (`ERR__ERROR_<NAME>` "Decompression failed", `BROTLI_DECODER_ERROR_` prefix
  stripped; errno = brocha code).
- `consumed` accounting via `_counted` (buffered writes count `bytes.length`;
  success counts `accumulatedLength − _counted`; prefix-scan counts
  `frameLen − _counted`; input after `finished` counts 0).
- `reset()` clears buf/counted/finished/trailingGarbage/error; noop `setParams()`.
- `package.json`: `"brocha": "0.1.1"` (alphabetical, after `als-browser`).
  No `npm install` was run (would destroy the `node_modules` symlink); brocha
  was already present in `vite7/node_modules/brocha` (copied by L0).
- Build check: `esbuild src/zlib.js --bundle --platform=browser` → 446,960
  bytes to `/tmp`, no errors.

## Differential (full sweep, `--jobs 2`, fresh filename)

Base: `hidden_files/fast-sweep/zlib-sweep-2026-11-18.csv` (42/64 in-sweep;
test-zlib.js is outside the sweep glob and was checked manually).
Branch CSV: `zlib-z5-sweep.csv` (45/64 in-sweep).

**Flips (+3), each exit 0 in manual run 1, the sweep, and isolated run 2:**

| test | base | branch |
|---|---|---|
| test-zlib-maxOutputLength.js | 1 | 0 |
| test-zlib-brotli-kmaxlength-rangeerror.js | 1 | 0 |
| test-zlib-brotli-from-brotli.js | 1 | 0 |

**Regressions (−4), each exit 1 in the sweep and in 2 isolated runs:**

| test | base | branch | mechanism (all the same) |
|---|---|---|---|
| test-zlib.js (manual, outside sweep) | 0 | 1 | round-trip `[BrotliCompress, BrotliDecompress]` over person.jpg / elipses.txt: stub compressor emits raw bytes, real decoder throws `ERR__ERROR_FORMAT_PADDING_1` → uncaught 'error' → crash |
| test-zlib-convenience-methods.js | 0 | 1 | `:132` `brotliDecompressSync(brotliCompressSync(expect))` → throws `ERR__ERROR_ALLOC_BLOCK_TYPE_TREES` (−30) on the raw string |
| test-zlib-random-byte-pipes.js | 0 | 1 | `:145` pipes random bytes through `[createBrotliCompress, createBrotliDecompress]` → `ERR__ERROR_FORMAT_PADDING_1` (−14) → uncaught 'error' on HashStream |
| test-zlib-write-after-flush.js | 0 | 1 | `:34-38` pipes `"A line of data\n"` through the pair with `gunz.on("error", mustNotCall())` → `ERR__ERROR_ALLOC_BLOCK_TYPE_TREES` (−30) |

**Not flips (flakes, 0 in the earlier z4 sweep, 1 in base, 0 in branch):**
from-concatenated-gzip, zero-byte, zstd-pledged-src-size.

**Mode change:** brotli-16GB 1 → 124 (timeout). Whole-buffer decode of a
16 GB-output frame cannot finish in 30 s; the test needs incremental decoding
with backpressure, which brocha's whole-buffer API cannot provide. NO-FIX.
Not re-run in isolation (would attempt a 16 GB allocation in a 6 GB VM).

**invalid-input:** brotli half now errors (zz probe: 5 of 6 unzips fire
'error' on garbage write; only ZstdDecompress is silent — L6's job). The
test still fails at `:100` on the zstd half; it flips once L6 lands **and**
this engine is in.

**type-error, premature-end, reject-garbage-after-end:** still fail, as
triaged — their brotli inputs come from the shim's passthrough
`brotliCompressSync` (`brotliDouble` is literally `"aa"`; premature-end's
`compressed` is the raw 40-char string) and no faithful decoder accepts
those (native throws `Z_BUF_ERROR` on `"aa"`; brocha throws −1 on `"aa"`,
−14 on the raw string). They need a brotli compressor. See the probe below.

## Triage correction — ceiling 59 → 52

The triage's L5 (+5) was already corrected to +3 (type-error and
premature-end cannot flip; convergent 2 → 1). This lane finds a second,
larger correction: the decoder also **regresses 4 passing tests**, all
round-trips through the stub compressor.

- Triage ceiling: 59/65 (43 + 15 flips + 1 possible).
- Corrected ceiling: **52/65**.
- Arithmetic (ship-L5 path): 46 banked + 3 (L5) − 4 (regressions) + 4 (L6)
  + 1 (invalid-input) + 1 (L6b) + 1 (zstd-dictionary) = 52.
- Arithmetic (hold-L5 path): 46 banked + 4 (L6) + 1 (L6b) + 1 (zstd-dict)
  = 52 (invalid-input stays blocked — its brotli half needs this engine).
- Both paths total 52. NO-FIX grows 6 → 13: the original 6
  (brotli.js, brotli-flush, brotli-from-string, brotli-dictionary, brotli-16GB,
  zstd-flush) + type-error + premature-end + reject-garbage-after-end +
  test-zlib.js + convenience-methods + random-byte-pipes + write-after-flush
  (the last four only count as NO-FIX on the ship-L5 path; on the hold path
  they pass and invalid-input is the blocked one instead).
- The 2026-11-18 ~04:08 EST checkpoint report to Jared (43/65, ceiling 58)
  is stale on both numbers; the correction goes in the final batched report.

Why the 4 regressions are unavoidable without a compressor (proof, not a
hunch): the decoder sees only bytes. In the round-trips the bytes are the
stub compressor's identity output; in invalid-input the bytes are garbage.
The two are indistinguishable, and the requirements contradict (echo the
former, error on the latter). A sync-only gate does not save it either:
convenience-methods uses the sync path (`brotliDecompressSync`), and a
sync-decodes / stream-passes-through split would be an incoherent fake.
The decoder cannot land while BrotliCompress is a stub without losing
these 4 tests.

## Compressor rescue — probed and disproven

Idea: hand-roll a stored-block (uncompressed-metablock) compressor from
RFC 7932 §11.1 "Trivial Compressor" — ~25 lines, no dependency, no WASM.
The RFC gives the code verbatim (empty → `[0x06]`; first byte 12; 65536-byte
blocks `(248,255,15)`; final partial block; end byte 3).

Probe (`/tmp/zz-z5-trivial-compressor.js`, 8 cases: empty, 1 byte, the
write-after-flush input, ASCII, binary 0–255, random 1 KB, random 70 KB
multi-metablock, 200 KB zeroes):

- **Native Node decodes all 8** — the transliteration is byte-correct and
  the frames are valid (RFC + reference decoder agree).
- **Brocha fails all 8 non-empty cases** (`-30 ALLOC_BLOCK_TYPE_TREES` for
  small frames, `-14 FORMAT_PADDING_1` for large ones). Bit-level parse of
  the 1-byte frame confirms it is well-formed per §9.2 (ISLAST=0,
  MNIBBLES=4, MLEN=1, ISUNCOMPRESSED=1, skip bits zero, literal `a`, final
  empty metablock `0x03`); brocha reads it as a *compressed* metablock and
  tries to parse block-type trees from the literals.
- **Conclusion: brocha cannot decode uncompressed (stored) metablocks.**
  A stored-block compressor + brocha decoder do not round-trip, so the
  rescue fails. A real (compressed-output) brotli encoder in pure JS does
  not exist — the original NO-FIX stands. (Remaining unexplored path, for a
  future probe lane, not this one: a WASM build of the real brotli encoder —
  the repo's rule-8 pattern. The known `brotli` npm package's encoder
  silently fails on qualities 4–8 for binary input, the exact case
  test-zlib.js exercises at level 6 on person.jpg, so a WASM encoder would
  need its own probe before anyone claims it rescues the round-trips.)

## Guards

- test-zlib.js: REGRESSED (see above) — this is the blocker.
- Currently-passing zlib tests: 3 regressed (convenience-methods,
  random-byte-pipes, write-after-flush); all others unchanged in the sweep.
- Full sweep: `zlib-z5-sweep.csv` (45/64 in-sweep + test-zlib.js failing
  manually = 45/65 on the branch vs 46/65 banked).

## Known limits of this engine (for a future lane)

- Whole-buffer decode: O(n²) on many small writes; cannot stream a 16 GB
  output (brotli-16GB); a true incremental decoder (brocha State, once its
  boundary reporting is usable) is the upgrade path.
- The 2/−22 "buffer" rule defers errors on short invalid input until end()
  (probed: ~27% of random 1–6 byte garbage throws −22); at end() it
  surfaces as `Z_BUF_ERROR` instead of the format error native raises.
  Exact for the suite (invalid-input's garbage is 34 bytes, throws a
  FORMAT code), but not bit-exact for arbitrary short garbage.

## Ship decision (parent's call — DO NOT MERGE without it)

- **No PR opened, no CI waiter run, no merge.** Branch `fix/zlib-brocha`
  is committed locally and pushed (see below); the work is preserved for
  the day a compressor exists or for a fidelity-first decision.
- Option A (ship for fidelity): merge this lane; zlib goes 46 → 45
  immediately (3 flips − 4 regressions), then L6/L6b/dict bring it to 52,
  with real brotli decoding live. The 4 regressions are reclassified as
  compressor-blocked NO-FIX.
- Option B (hold for count): leave this branch unmerged; zlib stays 46,
  L6/L6b/dict bring it to 52, with brotli decode staying a stub and
  invalid-input unflippable. The decoder lives on this branch.
- Either way the wave ceiling is 52/65. L4 and L6 are unaffected by this
  decision (L6's zstd has a real compressor in zstdify, so no asymmetry).

## Ship section

- PR: none (HELD — see above).
- Merge SHA: none.
- Branch: `fix/zlib-brocha`, pushed to origin (verify the remote SHA with
  `git ls-remote origin fix/zlib-brocha` — the API push re-creates the
  commit object, so the remote SHA differs from the local one); the local
  commit is on the branch.
- Worktree: `~/workspace/worktrees/zlib-z5-brocha` (kept, do not delete
  until the parent decides A vs B).
