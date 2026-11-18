# NOTES — zlib lane Z6: Zstd codec via vendored zstdify

Lane: L6 (triage) + zstd-dictionary. Branch: `fix/zlib-zstdify`.
Base at work: `931951bf` (PR #464, Z3); rebased onto `41a4e4cb` (PR #465, L4)
before shipping. Score: **46/65 → 52/65** (sweep 45/64 → 51/64, plus
test-zlib.js which the sweep never sees).

## What changed

- `src/zlib.js` — `ZstdCompressEngine` / `ZstdDecompressEngine` (buffering
  adapters over zstdify), an RFC 8878 frame walker for first-frame-only
  semantics, zstdify→Node error mapping, level/dictionary normalization;
  wired into `_createEngine` for `MODE_ZSTD_COMPRESS` / `MODE_ZSTD_DECOMPRESS`.
  No other mode touched; MiniTransform, the brotli branch, and the 6 NO-FIX
  tests are untouched.
- `src/vendor/zstdify/` — zstdify 1.4.0 vendored (31 files: the exact set
  reachable from `dist/compress.js` + `dist/decompress.js`, esbuild
  `--metafile`), plus `README.md` (provenance, regeneration, patch).
- `NOTES-zlib-zstdify.md` — this file.

## Why vendored, not a package.json dep (flagged to parent)

The lane brief says "add `zstdify@1.4.0` to package.json by hand". That
conflicts with the repo's footprint test (`tests/ondemand-require.test.js`,
CI-enforced): allowed paths are only `^src/`, `^parity/`,
`^NOTES-[^/]+\.md$`, `^docs/capability-matrix.json$` — `package.json` is
NOT allowed, so a dep line there would fail CI. The footprint rule wins.
The codec is therefore vendored under `src/` (precedent: `src/vendor/`
already holds esbuild-shim.cjs and rollup-parseast.mjs), exact version
1.4.0, no `npm install` run anywhere in this lane. If the project later
decides a package.json dep is acceptable, the vendored tree can be deleted
and the two imports in `src/zlib.js` repointed at the package.

## Mechanism

- **Compress:** accumulate input; only the finalizing flush (`ZSTD_e_end`)
  compresses, via `zstdifyCompress(input, { level, dictionary })`.
  Non-finalizing flushes (`e_continue` / `e_flush`) return empty and stay
  unfinished. zstdify emits the 9-byte empty frame for empty input itself,
  so the `EMPTY_FRAME_BY_MODE` append (scoped to `PassThroughEngine`) retires
  for zstd automatically.
- **Level:** always passed explicitly. Node's default is 3
  (`ZSTD_CLEVEL_DEFAULT`); zstdify's default behaves like level 0/1 (the
  505-byte lorem compresses to 515 bytes, LARGER than input; level 3 gives
  406). `params[100]` (`ZSTD_c_compressionLevel`) overrides `opts.level`
  (native-probe-verified); non-finite levels fall back to 3. zstdify clamps
  to 0–9 internally. Other params are validated (`validateZstdOptions`,
  Z3) but have no zstdify equivalent and are not applied.
- **Dictionary:** normalized to a `Uint8Array` before zstdify sees it.
  zstdify accepts only `Uint8Array | { bytes, id? }` and SILENTLY IGNORES
  an `ArrayBuffer` or `DataView` dictionary (compresses as if no dictionary
  was passed: 208–210 bytes instead of 112 for the test vectors). The
  adapter converts ArrayBuffer / DataView / other views to a `Uint8Array`
  over the same bytes, so all four dict forms compress identically (the
  dictionary test asserts equal lengths). Invalid dict types throw
  `ERR_INVALID_ARG_TYPE`.
- **Decompress:** eager decode on every write (invalid input errors surface
  on `write()` with no `end()` call). A complete first frame emits its
  output and finishes; a truncated frame holds (empty output) on
  non-finalizing writes and throws `Z_BUF_ERROR` ("unexpected end of
  file") at the finalizing flush; bytes after the first frame set
  `trailingGarbage` (default: emit first-frame output and end cleanly;
  `rejectGarbageAfterEnd`: `ERR_TRAILING_JUNK_AFTER_STREAM_END`).
- **First-frame-only:** zstdify decodes ALL frames (doubled frame → `"aa"`);
  Node returns the first frame only. Enforced with a small RFC 8878 frame
  walker (`parseZstdFrameEnd` / `firstZstdContentFrame` / `isZstdSkippableTail`):
  magic + descriptor + window descriptor + dictID + FCS + block walk
  (raw/RLE/compressed) + checksum, skippable frames skipped (leading and
  trailing). Whole-buffer decode is only the fallback that distinguishes a
  truncated frame (hold) from a corrupt one (throw) and the safety net for
  a frame shape the walker does not cover.
- **Error mapping** (zstdify `ZstdError` → Node, probed vs real Node
  v24.22.1): truncation messages (`*truncated*`, `Empty input`,
  `Sequences section too short`, `Sequences bitstream empty`,
  `4-stream mode requires at least 10 bytes`) → `Z_BUF_ERROR`
  ("unexpected end of file", errno -5); `Invalid zstd magic: …` →
  `ZSTD_error_prefix_unknown` ("Unknown frame descriptor", errno 10);
  `Content checksum mismatch` → `ZSTD_error_checksum_wrong`
  ("Restored data doesn't match checksum", errno 22); everything else →
  `ZSTD_error_corruption_detected` ("Data corruption detected", errno 20).
- **`params()` stays a validated no-op** (no `setParams` on the new engines,
  as directed); `setParams` would have flushed through a `Z_SYNC_FLUSH`
  that is out of the zstd flush bound.

## L0 correction: zstdify's dictionary decoder bug (patched in the vendored copy)

L0's verdict (Z10) claimed dictionary round-trips work. That is WRONG for
the test's vectors at level 3: `zstdify decompress` of a dictionary frame
throws `Invalid match offset: offset=370 maxReachBack=362` — in ALL FOUR
dict forms, and also for a NATIVE dict-compressed frame. Root cause: the
decoder caps every match offset at the frame's window size
(`maxReachBack = min(produced + history, windowSize)`), but a real encoder
emits dictionary matches with offsets past the window (the native frame
for the test vectors carries offset 407 with windowSize 362, and native
decodes it fine) — the dictionary is part of the window. Patched at 3
sites (`dist/decode/fusedSequences.js`, `dist/decode/reconstruct.js` ×2,
marked `z6-patch`) to
`maxReachBack = min(produced + history, windowSize + history)`.
Non-dictionary behavior is unchanged (`historyLength === 0` reduces to the
old formula); the no-history path in `reconstruct.js` is untouched.
Verified: dict round-trips pass in all four forms AND against native
frames; all non-dict probe results (truncated, garbage, empty, doubled,
person.jpg.zst, levels, checksum) unchanged. The patch is the ONLY
difference from the pristine npm package (plus stripped
`//# sourceMappingURL=` lines); verify with
`diff -r <pristine>/dist src/vendor/zstdify/dist` against the L0 worktree
copy (`~/workspace/worktrees/zlib-l0-codec-probe/node_modules/zstdify`).

## Evidence

- **Frame walker:** 18/18 against real native frames (levels 1/3/6/19,
  100 KB, 3 MB, person.jpg.zst, doubled, truncated, garbage, checksum,
  dict, skippable-only, skippable+frame, frame+skippable, empty frame)
  — probe `/tmp/z6-scratch/parser-probe.mjs` (tmp, since wiped).
- **Dict probe:** zstdify dict round-trip fails pre-patch in all forms,
  passes post-patch in all forms + native frames; no-dict and wrong-dict
  still throw.
- **Build:** `node src/build-vfs.mjs` exit 0 (platform browser);
  dist/zlib.js 147,601 → 211,242 bytes; the built bundle round-trips zstd
  and the dictionary case (111 bytes, round-trip true). dist/ restored to
  HEAD afterwards (regen churn only, never committed).
- **Targets (isolated 2× each, parity preload):**
  test-zlib-zstd-kmaxlength-rangeerror, test-zlib-zstd-from-string,
  test-zlib-zstd-from-zstd, test-zlib-truncated, test-zlib-zstd-dictionary —
  all exit 0.
- **Bonus flip — test-zlib-zstd.js (L6b's test):** fails 2× on base
  (level-scaling block: stub echoes 10049 bytes at every quality),
  passes 2× on this branch (zstdify level scaling + Z3 validation).
  L6b may now be closed or reduced — parent to adjudicate.
- **Convergent halves (zz-probe, deleted after use):** invalid-input zstd
  half PASS (error event `ZSTD_error_prefix_unknown`, no `end`);
  reject-garbage zstd halves PASS (sync/async default → `"a"`, sync/async
  reject → `ERR_TRAILING_JUNK_AFTER_STREAM_END`, stream collect default
  → `"a"`, stream collect reject → `ERR_TRAILING_JUNK_AFTER_STREAM_END` —
  the last one needed L4's `finished()` surfacing, PR #465, and passes
  after the rebase onto `41a4e4cb`). Both files still fail as a whole:
  invalid-input's brotli half needs L5; reject-garbage's brotli case
  needs L5.
- **Post-rebase re-verification (onto `41a4e4cb`):** all 6 flips re-run
  2× isolated (exit 0 each); convergent zz-probe re-run (all zstd halves
  PASS, incl. stream-collect-reject); test-zlib.js 2× (exit 0); fresh
  sweep differential vs the `41a4e4cb` base: 45/64 → 51/64, 0 regressions,
  same 6 toward-pass. (The `41a4e4cb` base alone is also 45/64 — L4 flips
  nothing at file granularity; its contribution is sub-test.)
- **Guards (isolated 2×):** test-zlib.js exit 0 (both runs);
  test-zlib-write-after-flush, test-zlib-random-byte-pipes,
  test-zlib-convenience-methods exit 0.
- **Repo tests:** `NODE_OPTIONS=--experimental-vm-modules npx jest
  tests/zlib.test.js tests/zlib-native-compat.test.js
  tests/export_surface_zlib.test.js tests/ondemand-require.test.js` —
  4 suites, 68 tests, all pass (footprint test included).
- **Sweep differential** (fast-sweep, `--jobs 2`, `test-zlib-*.js`):
  base (931951bf) 45/64 pass, branch 51/64 pass, **0 regressions**,
  toward-pass 6 (the 5 targets + test-zlib-zstd.js). Branch failures
  (13) are all expected: NO-FIX 6 (brotli.js, brotli-flush,
  brotli-from-string, brotli-dictionary, brotli-16GB, zstd-flush),
  L5 brotli (brotli-from-brotli, brotli-kmaxlength-rangeerror),
  convergent (invalid-input, reject-garbage-after-end), pre-existing
  (maxOutputLength, premature-end, type-error — all failing at base too).

## Ceilings (honest gaps, not bugs)

- Truncated frame on a non-finalizing flush yields NO partial output
  (native returns the completed blocks' prefix); the truncated test only
  asserts the result is a prefix of the input, and empty is a valid
  prefix. A block-level streaming decoder would be needed to emit it.
- Wrong-dictionary decompress THROWS (`Invalid match offset` →
  corruption_detected); native returns wrong output silently. No test
  covers it.
- A corrupted payload byte with no checksum returns wrong output silently
  (zstdify has no checksum by default) — same ceiling as L0 noted.
- `zstd-flush` stays NO-FIX (needs a streaming encoder with flush
  support); `params()` beyond level is validated but not applied.

## Ship

- PR: #467
- Merge SHA: 12532c04
- Branch ref deletion: confirmed (ls-remote empty)
- Worktrees removed: confirmed
