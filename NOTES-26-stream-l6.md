# NOTES-26-stream-l6 — Wave 3 STREAM L6: `stream/iter` port

Base: `origin/main @ 10bdfcaa`. Banked stream count (coordinator-confirmed on
live main): **197/232 (35 fail, 0 timeout)**. Node 26.13.1 oracle:
`~/workspace/local/node-26/bin/node`; Node 26 source pack:
`~/workspace/local/node-26-src/`.

## What this lane did

Ported Node 26 `lib/stream/iter.js` + `lib/internal/streams/iter/*` (~9,000
lines) into the shim as `src/stream/iter*`, plus `lib/zlib/iter.js` as
`src/zlib-iter.js` (`src/zlib.js` is a file, so no `src/zlib/` directory can
exist), with preload redirects for `stream/iter` and `zlib/iter` (CJS
`parity/preload.mjs` + ESM `parity/hooks.mjs`). Also fixed the proven shim-side
stub: `Readable.prototype[Symbol.for("Stream.toAsyncStreamable")]` now works
via `setIterClassicImpl()` registered by `classic.js` on load.

Mechanical conversion (`/tmp/w3-l6/convert.py`): bodies byte-identical to Node;
only import/export/binding headers rewritten. `transform.js` is a hand-built
engine (`/tmp/w3-l6/make-transform.py`): the shim's zlib stream classes drive
compression, fed in slices (decompress 1024 B, compress 16384 B), yielding
`BATCH_HWM` (64 KiB) batches — the shape that makes the transform-buffering
memory-bound test representable. Sync transforms buffer whole input and apply
the shim sync fn once at finalization (documented ceiling in code).

## Result — differential on live main

- Before (baseline-before): **197/232, 35 fail, 0 timeout**
- After (baseline-after2): **226/232, 6 fail, 0 timeout**
- **33 flips** (all 33 verified 2× in targeted runs with
  `--experimental-stream-iter` + a 3rd time in the full differential):
  broadcast-backpressure, broadcast-basic, broadcast-from,
  broadcast-waiter-cleanup, consumers-bytes, consumers-dump.mjs,
  consumers-merge, consumers-tap, consumers-text, duplex, factory-signal,
  from-async, from-sync, namespace, pipeto-edge, pull-async,
  push-backpressure, push-writer, reason-propagation, resizable-buffers,
  share-async, share-coverage, share-sync, transform-output, writable-from,
  writer-reentrancy, from-writable-lifecycle, property-access,
  readable-interop, to-readable, validation, webidl, writable-interop.
- **6 fails, all brotli-only** (see NO-FIX below): transform-buffering,
  transform-coverage (target files, never flipped) + transform-compat,
  transform-errors, transform-roundtrip, transform-sync (4 regressions vs
  live main — see merge-blocker note).
- **0 other regressions.** `cross-realm` regressed in the first differential
  and was repaired in-lane (see below); it passes in the final differential.
- Repo tests: `tests/ondemand-require.test.js` 29/29,
  stream export-surface suites 3/3 (with
  `NODE_OPTIONS=--experimental-vm-modules`).

## Flags note (recorded per brief)

`parity/drift/run-baseline.mjs` does NOT honor `// Flags:` headers. The iter
tests carry `// Flags: --experimental-stream-iter` (some also `--expose-gc`);
Node's `test/common` re-spawns each such test as a child process with those
flags, and the child inherits `--import <preload>` + `PARITY_TARGET=stream`,
so the differential still exercises the shim. Targeted runs in this lane used
`PARITY_TARGET=stream timeout 60 node --experimental-stream-iter --import
<absolute preload path> parity/node-test/parallel/<test>.js` directly.

## NO-FIX — brotli (proof)

The shim's zlib Brotli compression is a documented pass-through stub
(`src/zlib.js` header: "no pure-JS brotli compressor exists at all"; the
`brotli` npm package was evaluated and rejected). Probe (deleted after use):
`brotliCompressSync("hello world…")` returned the plaintext hex; roundtrip
via `brotliDecompressSync` threw `ERR__ERROR_ALLOC_BLOCK_TYPE_TREES`.
Consequences, each verified by running the file with ONLY its brotli subtests
stubbed (probe copies, deleted after use — all pass):

- transform-buffering: `testLargeFinishOutput`, `testExplicitFlushSignal`
  (native `brotliDecompressSync` on shim output →
  `ERR__ERROR_FORMAT_CL_SPACE`).
- transform-coverage: `testBrotliWithParams` (brotli roundtrip).
- transform-compat: `testBrotliCompatWithZlib`,
  `testZlibBrotliToNewStreams`.
- transform-roundtrip: `testBrotliRoundTrip`, `testBrotliLargeData`,
  `testBrotliActuallyCompresses`, `testBinaryRoundTripBrotli`.
- transform-sync: `testBrotliRoundTrip`, `testBrotliLargeData`,
  `testBrotliWithOptions` (all other subtests pass, incl. gzip/deflate/zstd
  roundtrips and the `deepStrictEqual(Buffer)` binary test).
- transform-errors: `testCorruptBrotliData` only — native reports
  `ERR__ERROR_FORMAT_PADDING_2` for `[0xFF,0xFF,0xFF,0xFF]`; the shim's
  brocha decoder reports `ERR__ERROR_FORMAT_PADDING_1` (decoder-fidelity
  difference inside brocha, not a mapping bug — `brochaDecodeError` passes
  brocha's error name through verbatim). Gzip/deflate/zstd corrupt-data
  subtests pass.

Using host native zlib would violate the repo's browser-first rule. A real
brotli encoder is a zlib-lane project, not this lane.

## MERGE BLOCKER — coordinator decision needed

The 4 regressions (transform-compat, transform-errors, transform-roundtrip,
transform-sync) passed on live main because, with no shim `stream/iter`,
the child re-spawn loaded **host native v24** `stream/iter` + `zlib/iter`
(real brotli). This lane's redirect routes them to the shim, exposing the
pre-existing brotli gap above. The lane rule "never merge with a known
regression" and the NO-FIX rule ("unrepresentable shape → return NO-FIX with
proof") conflict here: the shape is unrepresentable in this lane, but the
files did pass before. **Do not squash-merge this PR until the coordinator
decides: merge at 226/232 with the brotli NO-FIX documented, or hold the lane
for a zlib brotli fix.** Everything else in the lane is complete and green.

## Fixes made inside the lane (root causes, not symptoms)

- `src/stream/errors.js`: `E()` now takes Node's `...otherClasses` and
  attaches `ErrClass[clazz.name]` siblings (Node `lib/internal/errors.js:556`).
  `ERR_INVALID_STATE` (Error + TypeError + RangeError),
  `ERR_STREAM_WRITE_AFTER_END` (Error + TypeError),
  `ERR_INVALID_ARG_VALUE` (TypeError + RangeError). Was:
  `ERR_X.TypeError is not a constructor` at 15 call sites.
- `parity/stream-iter-harness.mjs`, `parity/zlib-iter-harness.mjs` (new):
  timer-globals restore, mirroring `parity/stream-harness.mjs`. Importing
  the iter chain replaces `setTimeout/setInterval/setImmediate/queueMicrotask`
  (als-browser via async_hooks), tripping Node's global-leak detector in 27
  tests. The plain `stream` harness does not cover the `stream/iter`
  subpath.
- `src/stream/iter/internal-util.js`: `abortWithReason(controller, reason)` —
  Node's internal `abortSignal()` sets the signal reason verbatim, including
  `undefined`; `controller.abort(undefined)` substitutes a default AbortError.
  Shadows the prototype `reason` getter with an own property before aborting
  (6 call sites in `pull.js`/`broadcast.js`). Fixes reason-propagation's
  `thrownReason === undefined` case. Ceiling documented in code:
  `signal.throwIfAborted()` still throws the host default (no tested path
  hits it).
- `src/stream/util-types.js`: `isAnyArrayBuffer`/`isUint8Array`/
  `isSharedArrayBuffer`/`isTypedArray`/`isBlob` now use
  `Object.prototype.toString` brand tags instead of `instanceof` (cross-realm
  safe; Node's are C++ brand checks). Fixes cross-realm `fromSync` of a
  cross-realm ArrayBuffer (`ERR_INVALID_ARG_TYPE`).
- `src/stream/iter/transform.js` (sync path): output normalized to an exact,
  unpooled Buffer (`Buffer.allocUnsafeSlow` + copy when pooled/Uint8Array),
  matching Node's `Buffer.allocUnsafe` handle output — fixes
  transform-sync's `deepStrictEqual(result, inputBuf)` (Buffer identity).
- `src/stream/iter/webidl.js`: two unterminated JSDoc blocks (missing `*/`)
  swallowed `type()` and `converters.DOMString` (found by the smoke test).

## Files

- New: `src/stream/iter.js`, `src/stream/iter/{types,ringbuffer,utils,from,
  pull,push,consumers,duplex,broadcast,share,classic,transform,internal-util,
  webidl}.js`, `src/zlib-iter.js`, `parity/stream-iter-harness.mjs`,
  `parity/zlib-iter-harness.mjs`.
- Edited: `src/stream/{primordials,errors,validators,util-types,readable}.js`
  (shared helpers only), `parity/{preload,hooks}.mjs` (redirects).
- Footprint: all new files under `^src/` / `^parity/`; this NOTES file under
  `^NOTES-[^/]+\.md$`. No new deps, nothing vendored, no `package.json` change.

## Ship section

- Branch: `fix/stream-26-l6-iter` (worktree `~/workspace/worktrees/w3-stream-l6`)
- PR: (to be filled on push)
- Merge SHA: (blocked — see merge-blocker note above)
