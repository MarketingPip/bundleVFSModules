# NOTES-zlib-minitransform.md — L4: MiniTransform stream-error surfacing

Lane Z4 (triage L4). Base main `931951bf` (Z3 merged; zlib 46/65).
Fix: `src/zlib.js` only (MiniTransform). No codec, no new dependency, no
preload change. **Flips 0 tests alone** — convergent lane: it unlocks the
error halves of `test-zlib-invalid-input.js` and
`test-zlib-reject-garbage-after-end.js`, which flip only once L5 (brocha)
and L6 (zstdify) land too.

## Mechanism (grounded in Node v24.20.0 source, not the triage summary)

The triage summary said "finished() decides via stream.errored". The source
says something sharper (`lib/internal/streams/end-of-stream.js` +
`lib/internal/streams/utils.js`):

- `eos()` never reads `stream.errored`. `getEosErrored()` reads
  `isWritableErrored()` / `isReadableErrored()`, which read
  `stream.writableErrored` / `stream.readableErrored` first, then fall back
  to `stream._writableState?.errored` / `stream._readableState?.errored`.
  (Verified on host v24.22.1: `readableErrored`/`writableErrored` do not
  exist as properties on a real Transform — eos relies on the state fields.)
- `isReadableNodeStream()` returns false for MiniTransform: it has a
  `_writableState` but no `_readableState`, so the Duplex check
  `(!obj._writableState || obj._readableState)` fails. eos therefore takes
  its `!readable` immediate branch: writable already ended (`_wended`),
  no pending callbacks, error not yet known (discovered async in
  `_pumpWrites`) → `getEosErrored()` returns null → `finished()` resolves
  on nextTick, before `destroy(err)` ever runs.
- For a real Transform, `readable` is true, so no immediate branch is
  taken; the attached `'error'` listener rejects. That is the whole gap.

## Fix

MiniTransform now carries faithful stream states, synced at the existing
transition points:

- `_readableState`: `{ ended, endEmitted, errored: null, errorEmitted,
  closed, emitClose: true, autoDestroy: true, destroyed }` + live `length`
  getter over `_rlen`. `isReadableNodeStream()` now returns true, so eos
  no longer takes the `!readable` immediate branch.
- `_writableState` (was a bare `{}` with only `needDrain`): same fields +
  live `length` getter over `_wQueuedBytes` and `pendingcb` getter
  (`_wqueue.length + (_wprocessing ? 1 : 0)`). `needDrain` getter kept —
  `test-zlib-flush-drain.js` reads it.
- Getters mirroring Node (`lib/internal/streams/readable.js:1551,1585`,
  `writable.js:1093`): `readableEnded` (= `endEmitted`, not `ended`),
  `errored` (readable state first, else writable, else null), `closed`
  (readable state's).
- `destroy(err)` records the error on BOTH states, first error wins
  (`lib/internal/streams/destroy.js: checkError`), and marks `errorEmitted`
  when the `'error'` event fires. `closed` is set on both states just
  before the `'close'` emit (Node's `emitCloseNT` shape). `ended` /
  `endEmitted` / `finished` are set in `end()` / `push(null)` /
  `_maybeEmitEnd()` / the `_pumpWrites` finish path respectively.
- No `readableErrored` / `writableErrored` getters: verified absent on real
  Node streams; eos falls back to the state fields, so they add nothing.
- No `_readableState.buffer` getter, on purpose: it is not read by eos,
  and exposing the live `_rbuf` array changes `test-zlib-brotli-16GB`
  (NO-FIX) from a fast TypeError failure into an unbounded setImmediate
  spin — the test waits for the readable buffer to reach 4 chunks (the
  64 KiB HWM), which the passthrough stub never fills (it echoes the
  13 KiB input as 1 chunk). The test still fails either way; a hang is
  strictly worse than a fast failure for every sweep. Re-add `buffer`
  (one getter over `_rbuf`) if a future lane ships a real streaming
  decoder.
- ZlibBase is MiniTransform's only user; the real Transform in
  `src/stream/transform.js` was NOT adopted (minimal patch, per triage).

## Evidence

- Repro probe `zz-z4-collect.js` (exact `collect()` shape from
  `test-zlib-reject-garbage-after-end.js`): base RESOLVED (wrong) with the
  error event fired; after fix REJECTED `ERR_TRAILING_JUNK_AFTER_STREAM_END`,
  matching native. `errored` set, `readableEnded: false` on the error path
  / `true` on the clean path, `errored: null` clean — all matching native.
- Mechanism probe `zz-z4-collect2.js` (11 checks, shim == native on all):
  reject + clean shapes for inflate / inflateRaw / gunzip / unzip,
  late-attach error (rejects via the `isClosed` path) and clean (resolves),
  attach-before-end (rejects, no regression). All probes deleted after use.
- `test-zlib-reject-garbage-after-end.js` subtests, branch vs base
  (`931951bf`): base fails 6 (inflate/inflateRaw/gunzip/unzip all
  "Missing expected rejection (TypeError)" + brotli + zstd); branch passes
  the 4 pako subtests, only brotli + zstd still fail (need L5/L6 decoders).
  File still exits 1 — 0 flips alone, as briefed.
- Full sweep (branch, `--jobs 2`):
  `hidden_files/fast-sweep/zlib-sweep-2026-11-18-z4b.csv` — 45 pass /
  19 fail / 0 timeout. Diff vs triage CSV: exactly the 3 certain-lane
  flips (Z1/Z2/Z3); **0 regressions** (all 42 triage passes still pass).
  Still-failing 19 = 6 NO-FIX + 13 codec-contingent.
- `test-zlib.js` manual 2×: exit 0, 0.
- Repo tests: `tests/zlib.test.js` + `tests/export_surface_zlib.test.js` +
  `tests/zlib-native-compat.test.js` — 39/39.
- `node src/build-vfs.mjs` exit 0.
- Mid-lane catch: an early version exposed `_readableState.buffer` as a
  live getter over `_rbuf`; `test-zlib-brotli-16GB.js` went 1 → 124
  (isolated 120 s hang, proven by a debug probe: `buffer.length` stuck at
  1 < expected 4). The getter was removed; the test is fast exit 1 again.

## Ceilings / leftovers

- `write()` after destroy emits `'error'` directly without going through
  `destroy()` (pre-existing divergence from Node's `errorOrDestroy`, which
  returns early on an already-destroyed stream). Out of scope; no test
  covers it.
- `pendingcb` is a derived getter, not a counted field; nothing reads it
  on the eos path once `readable` is true. Kept for state fidelity.

## Ship

- PR #___ / Merge SHA: ___
