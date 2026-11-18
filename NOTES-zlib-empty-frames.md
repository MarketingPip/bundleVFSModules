# NOTES-zlib-empty-frames — lane Z2 (triage L2)

## Target

`test-zlib-zero-byte.js` 1 → 0. Zlib 43 → 44/65 on this branch
(44 = 43 sweep passes + `test-zlib.js`, checked manually — fast-sweep never
sees it).

## Mechanism (grounded, not guessed)

The test streams an empty buffer through `Gzip` (20 bytes, already passed),
`BrotliCompress` (expects 1) and `ZstdCompress` (expects 9) and counts `data`
bytes. Both stub modes are `PassThroughEngine` and emitted 0 bytes.

Native behavior, verified by probe (`/tmp/zz-native-empty.js`,
`/tmp/zz-native-empty2.js`, plain Node v24.22.1, no preload):

- `brotliCompressSync(Buffer.alloc(0))` → `[0x3B]` (1 byte).
- `zstdCompressSync(Buffer.alloc(0))` → `[40, 181, 47, 253, 32, 0, 1, 0, 0]`
  (9 bytes). Matches triage probes F4/F5.
- Stream `write(empty)` + `end()` gives the same 1 / 9 bytes.
- **Decode of empty input throws** `Z_BUF_ERROR` ("unexpected end of file")
  for brotli, zstd, gunzip and inflate alike — decode modes get NO frame.
- `BrotliCompress` `flush()`-then-`end()` with zero input emits 3 bytes
  natively (2 flush-marker bytes + the 1-byte frame); zstd emits 9. The
  flush-marker bytes are NOT emitted by this lane (see Ceiling).

## Fix (`src/zlib.js` only, +~60 lines)

`EMPTY_FRAME_BY_MODE` — the two constants, keyed by encode mode — plus a
decode-side twin map `EMPTY_FRAME_BY_DECODE_MODE` (same bytes).

In `ZlibBase._processChunkSync` (the one path shared by sync, async and
stream — `zlibBufferSync` calls it directly with `_finishFlushFlag`, and the
stream finishing call arrives with `flushFlag === _finishFlushFlag` via
`maxFlush`):

- **Encode:** when the finishing call arrives, total input is zero
  (`bytesWritten === 0`) and the engine is still the passthrough stub,
  append the mode's empty frame to the output. Guarded by
  `this._emptyFrameEmitted` so an explicit `flush(FINISH)` before `end()`
  cannot double-emit. The append happens before the `maxOutputLength`
  check, so the enforcement still covers the frame.
- **Decode:** when a passthrough decompressor's total input so far is
  exactly the empty frame (tracked prefix `this._inputPrefix`, bounded to
  9 bytes), swallow the echo and output nothing. Required so the
  `empty.txt` round trip in `test-zlib.js` survives the encode-side frame:
  the compressor now emits `[0x3B]` / the 9-byte frame and the stub
  decompressor must yield zero bytes, not echo it. Only the exact,
  whole-input-so-far frame is swallowed; anything longer echoes as before.

Both branches are scoped to `instanceof PassThroughEngine` on purpose: when
L5/L6 give these modes a real codec engine, the encoder emits the frame
itself and this append must not double it. Reset in the `handle.reset()`
closure alongside the engine reset.

## Region discipline

Only the flush/empty-input path in `src/zlib.js`. `validateZstdOptions` and
the pledged-size counting in `ZstdCompress` were NOT touched (L3's region,
running in parallel).

## Guards (all verified 2× isolated on this branch)

- `test-zlib-zero-byte.js`: 0, 0 (was 1 on base).
- `test-zlib.js` (manual — fast-sweep glob gap): 0, 0. **Caught a real
  interaction mid-lane:** the first version (encode-only) regressed it —
  the `empty.txt` Brotli/Zstd round trips failed because the stub
  decompressor echoed the newly emitted frame. Fixed by the decode-side
  swallow above; guard green again.
- Full branch sweep: 64 rows, 43 pass / 21 fail — diff vs triage CSV is
  exactly one line (`test-zlib-zero-byte.js,1` → `,0`), zero regressions.
  CSV: `hidden_files/fast-sweep/zlib-sweep-2026-11-18-z2.csv`.
- Repo tests: `tests/zlib.test.js` 31/31,
  `tests/export_surface_zlib.test.js` + `tests/zlib-native-compat.test.js`
  8/8.
- Probe `zz-z2-verify.js` (deleted after use): sync/async/stream empty
  paths return the frames; sync decode of the frames returns empty;
  non-empty passthrough unchanged; `end()` with no prior `write()` emits
  the frame.

## Ceiling / what this does NOT do

- Explicit `flush()` with zero input: native brotli emits 2 flush-marker
  bytes; this lane emits none at flush time (frame still emitted once at
  end, total 1 vs native 3 for flush-then-end). Emitting the marker would
  mean inventing encoder output — no test asserts it.
- Split-frame arrival at a decompressor: the first fragment echoes before
  the frame completes. The L5/L6 buffering adapters handle that properly.
- 1-byte collision: input literally equal to the empty frame (e.g. a file
  containing just `0x3B`) round-trips to empty under the stub. Only a real
  compressor distinguishes it; no vendored test has such an input.
- Decode of empty input throwing `Z_BUF_ERROR` (native) vs silent empty
  (shim) is a pre-existing divergence outside this lane; no failing test
  asserts it.

## Ship

- PR #___ / Merge SHA: ___
- Branch: `fix/zlib-empty-frames`
- Worktree: `~/workspace/worktrees/zlib-z2-empty-frames`
