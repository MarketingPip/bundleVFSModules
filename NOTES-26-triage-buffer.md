# NOTES-26-triage-buffer — Node 26.13.1 drift triage (buffer)

- Base: `3c091022` (worktree `~/workspace/worktrees/node26-triage-core-small`).
- Scope: 10 gap tests, all class `shim-gap` in
  `hidden_files/node26-triage/gaps-buffer.json`, nativeExit 0 for all 10.
- Node 26 binary verified: `~/workspace/local/node-26/bin/node --version` → `v26.13.1`.
  Host node running the harness: v24.22.1 (appears in every re-run footer
  `Node.js v24.22.1` — matters for B7/B8 below).
- Method: staged the Node 26 test tree (`test/parallel` + `test/common` +
  `test/fixtures` from `~/workspace/local/node-26-src/`) over the worktree's
  `parity/node-test/`, then re-ran each gap with the exact
  `parity/drift/run-baseline.mjs` invocation
  (`timeout N node --import <abs preload> parity/node-test/parallel/<test>`,
  `PARITY_TARGET=buffer`, N=10, N=30 for the 124 case). All 10 reproduced
  (see per-family exits). Tree restored afterwards (`git checkout --`
  + removal of staged-only files); `git status -- parity/node-test` clean.
- Export diff (`parity/drift/node26-export-diff.md`): buffer ADDED `isLatin1`,
  REMOVED `SlowBuffer`.
- Changelog cross-check: 25.0.0 SlowBuffer removed; 26.3.0 Buffer.poolSize
  8 KiB → 64 KiB. Shim already has `Buffer.poolSize = 64 * 1024`
  (`src/buffer.js:2653`) — poolSize drift is already closed.

## Families

### B1 — Detached buffers now treated as empty in isAscii/isUtf8 (2, real shim work)
- Tests: `test-buffer-isascii.js` (exit 1), `test-buffer-isutf8.js` (exit 1).
- Failure (isolated re-run): `Error: Cannot validate on a detached buffer`
  from `src/buffer.js:3878` (`isUtf8`) / `:3893` (`isAscii`),
  `code: 'ERR_INVALID_STATE'`, at test line 47 / 91.
- What changed in 26: the v24 test expected a throw —
  `assert.throws(() => isAscii(arrayBuffer), { code: 'ERR_INVALID_STATE' })`.
  The 26 test says `// Detached array buffers and views are treated as empty`
  and asserts `isAscii(input) === true` for the detached ArrayBuffer, its
  Uint8Array view, and `Buffer.from(arrayBuffer)` (same shape in isutf8).
- Probe (node 26.13.1 binary): after `port1.postMessage(ab, [ab])`
  (byteLength 0), `require('buffer').isUtf8(ab)` → `true`,
  `.isAscii(ab)` → `true`. The shim's `isAnyArrayBuffer` misclassifies
  detached buffers (its DataView probe fails) and then throws.
- Fix: treat detached inputs as empty (return `true`). Small.
- Lane: **buffer-detached-validate — flip 2**.

### B2 — New-in-26 APIs missing (2, real shim work)
- Tests: `test-buffer-islatin1.js` (exit 1, `TypeError: isLatin1 is not a function`),
  `test-buffer-stringlength.js` (exit 1, `TypeError: Buffer.stringLength is not a function`).
- Both absent from the 24.20.0 source pack (`grep stringLength|isLatin1` in
  `hidden_files/node-src/lib/buffer.js` → 0 hits); both present in Node 26
  `lib/buffer.js` (`isLatin1` :1508, `stringLength` :1513, export :1544,
  `Buffer.stringLength` static :944).
- API shape is asymmetric — probe-verified on the 26 binary, do not get this
  backwards in the lane:
  - `isLatin1`: exists ONLY on the module namespace
    (`require('buffer').isLatin1` = function; `Buffer.isLatin1` = undefined).
    `isLatin1('é')` → true, `isLatin1('\u0100')` → false.
  - `stringLength`: exists ONLY as a `Buffer` static
    (`Buffer.stringLength` = function; `require('buffer').stringLength` =
    undefined). Signature `(TypedArray|ArrayBuffer, encoding='utf8')`;
    throws `ERR_INVALID_ARG_TYPE` for strings/numbers/`{}`/`[]`/`Blob`/
    `DataView`, `ERR_UNKNOWN_ENCODING` for bad encodings. Semantics per
    `lib/buffer.js:1513-1541`: utf8 → binding count matching `toString()`
    decoding (one U+FFFD per maximal subpart — the test checks 30+ invalid
    sequences, 2000 random byte-soup cases, and >1 MiB inputs);
    utf16le → `floor(byteLength/2)`; hex → `byteLength*2`;
    base64 → `ceil(byteLength/3)*4`; base64url → `ceil(byteLength*4/3)`;
    latin1/ascii → byteLength. Detached → 0. SharedArrayBuffer accepted.
- Shim exports (`src/buffer.js:3970-4050`) list `isUtf8, isAscii` only.
- Lane: **buffer-new-apis (isLatin1 + Buffer.stringLength) — flip 2**.

### B3 — indexOf with ucs2/utf16le and an odd byte offset (1, real shim work)
- Test: `test-buffer-indexof.js` (exit 1), failing at line 313:
  `buf.indexOf('\u6881', 1, 'utf16le')` — actual `0`, expected `4`.
- The two assertions are NEW in 26 (only on the `>` side of the
  vendored→26 diff):
  `buf.indexOf('\u6881', 1, 'utf16le') === 4`,
  `buf.indexOf('\u6881', -1, 'utf16le') === -1`
  (buf = `Buffer.from('\u6881\u6882\u6881', 'utf16le')`, 6 bytes).
- Mechanism: `src/buffer.js:1328` `bindingIndexOfString` →
  `bindingIndexOfBuffer` (`:1270`) uses `Math.floor(offset / 2)` to convert
  a byte offset to a 2-byte-unit offset. Offset 1 floors to unit 0 → match
  at byte 0. Node ceils: probe on the 26 binary gives offset 1 → 4,
  offset 3 → 4, offset -1 → -1, offset 2 → 4 — i.e. an odd byte offset
  starts at the NEXT unit boundary.
- Fix: ceil (not floor) the forward ucs2 offset conversion (and check the
  backward path the same way). Small.
- Lane: **buffer-indexof-ucs2-offset — flip 1**.

### B4 — xxxWrite coerces the offset argument twice (1, real shim work)
- Test: `test-buffer-write.js` (exit 1), failing at line 142:
  `assert.strictEqual(calls, 1)` — actual `2`, expected `1`.
- The `calls` assertion is NEW in 26 (only on the `>` side of the diff).
  Test: an `offset` object whose `valueOf()` counts calls and returns 2,
  passed to `Buffer.alloc(1)[method]('ww', offset, 1)` for
  `asciiWrite`/`latin1Write`/`utf8Write`; the throw is
  `ERR_BUFFER_OUT_OF_BOUNDS` either way, but `valueOf` must run exactly once.
- Mechanism: `src/buffer.js:2382/2392/2407` (`asciiWrite`/`latin1Write`/
  `utf8Write`) validate with `if (offset < 0 || offset > buf.byteLength)` —
  two comparisons, each coercing the object → two `valueOf` calls.
  (The default `length = buf.byteLength - offset` does not run here —
  length is passed as 1.)
- Fix: coerce the offset once on entry (e.g. `parseArrayIndex`, as
  `stringWriteChecked` at `:2421` already does for the other write methods).
  Small.
- Lane: **buffer-write-coerce-once — flip 1**.

### B5 — Pooled buffers are untransferable (1, NO-FIX)
- Test: `test-buffer-pool-untransferable.js` (exit 1).
- Failure: `AssertionError: Missing expected exception (DataCloneError)`
  at test line 16 — `port1.postMessage(a, [a.buffer])` did NOT throw.
  The test asserts BOTH `a.buffer === b.buffer` (shared pool, lines 9-11)
  AND that transferring that pool ArrayBuffer throws `DataCloneError`
  (code 25) and `a.buffer.transfer()` throws `TypeError`.
- Node 26 marks the pool ArrayBuffer untransferable at the C++ level
  (refs nodejs/node#32752, cited in the test). There is no Web/JS API
  that marks an `ArrayBuffer` untransferable: in a browser (and under the
  harness) `structuredClone` transfer of an ordinary ArrayBuffer succeeds
  and `ArrayBuffer.prototype.transfer()` succeeds. The two assertions are
  jointly unsatisfiable in a browser — a shared pool buffer cannot also
  be untransferable.
- Probe evidence: the isolated re-run itself (transfer succeeded where
  Node throws). No lane; record as honest gap.

### B6 — Aligned allocation needs an internal binding (1, NO-FIX / fixture gap)
- Test: `test-buffer-alloc-alignment.js` (exit 1, flags `--expose-internals`).
- Failure: `TypeError: arrayBufferAlignedOffset is not a function` at test
  line 19. The test gets it from `internalBinding('buffer')`
  (`require('internal/test/binding')`, line 7) and exercises the NEW
  `Buffer.allocUnsafe(size, alignment)` / `allocUnsafeSlow(size, alignment)`
  second argument (alignments 1…65536; Node 26 `lib/buffer.js:540`
  `if (alignment > kPoolAlignment ...)`). The 24.20.0 `lib/buffer.js`
  contains no `alignment` at all — the parameter is new in 26.
- The test's own comment (lines 12-17): "Addresses are not observable
  from JS, so alignment cannot be checked against `byteOffset` alone."
  There is no browser equivalent of `internalBinding('buffer')` or of a
  V8 base-address offset, and the preload has an `internal/test/binding`
  adapter only for the net/fs targets — not a product gap.
- NO-FIX. If a lane is ever attempted it would first need a harness
  adapter for `internal/test/binding` under the buffer target, and even
  then the alignment value itself is unobservable from JS.

### B7 — Baseline correction: copy-immutable never runs under this host (1)
- Test: `test-buffer-copy-immutable.js` (baseline exit 9, re-run exit 9).
- Failure is before any test code: `node: bad option: --js-immutable-arraybuffer`.
  The host node (v24.22.1) does not accept the flag; the Node 26.13.1
  binary does (`node --js-immutable-arraybuffer -e 1` → `flag accepted by 26`).
- Class in `gaps-buffer.json` (`shim-gap`) is wrong for this host: the
  test is UNASSESSED, not a shim gap. It needs a Node 26 host to run
  (it then exercises `ArrayBuffer.prototype.transferToImmutable` +
  copy-into-immutable no-op semantics — the shim's `Buffer.copy` behavior
  on immutable backing stores is still unprobed).
- No lane, no NO-FIX verdict — re-run under a Node 26 host.

### B8 — Baseline correction: isutf8-isascii-fast crashes the host V8 (1)
- Test: `test-buffer-isutf8-isascii-fast.js` (baseline exit 129,
  re-run killed by signal, same cause).
- Failure is a V8 fatal before any assertion:
  `Check failed: v8_flags.fuzzing` (native stack, `V8_Fatal`).
  The test uses `--allow-natives-syntax` and calls
  `%PrepareFunctionForOptimization` / `%OptimizeFunctionOnNextCall` on
  the native `isAscii`/`isUtf8`/`isLatin1` builtins.
- Probe: the same file run natively under the Node 26.13.1 binary exits 0
  (oracle `nativeExit: 0` agrees). The crash is a host-V8 (24.22.1)
  artifact, not a shim verdict.
- Class in `gaps-buffer.json` (`shim-gap`) is wrong for this host:
  UNASSESSED. (In a browser the `%...` intrinsics have no equivalent at
  all, so a future NO-FIX is likely — but that is an inference, not
  probe evidence; do not record it as NO-FIX until run under a Node 26 host.)

## Lane candidates (conservative flips)
| Lane | Tests | Est. flips |
|---|---|---|
| buffer-detached-validate (B1) | isascii, isutf8 | 2 |
| buffer-new-apis: isLatin1 + Buffer.stringLength (B2) | islatin1, stringlength | 2 |
| buffer-indexof-ucs2-offset (B3) | indexof | 1 |
| buffer-write-coerce-once (B4) | write | 1 |
| **Total** | | **6 / 10** |

## NO-FIX list
- `test-buffer-pool-untransferable.js` — pool ArrayBuffer untransferable
  (B5): no JS API marks an ArrayBuffer untransferable; jointly
  unsatisfiable with the shared-pool assertion in a browser.

## New-in-26 vs pre-existing
- NEW test files in 26 (not in vendored `parity/node-test/parallel/`):
  6 — alloc-alignment, copy-immutable, islatin1, isutf8-isascii-fast,
  pool-untransferable, stringlength.
- Pre-existing files, failing on NEW 26 assertions/behavior: 4 —
  indexof (new utf16le offset assertions), isascii + isutf8 (detached
  now returns true instead of throwing ERR_INVALID_STATE), write (new
  single-coercion assertion). All 4 were passing in the v24 sweep
  (buffer 62/62).

## Baseline corrections
- `test-buffer-copy-immutable.js`: exit 9 is the host rejecting
  `--js-immutable-arraybuffer`, not a shim failure. Reclassify
  shim-gap → unassessed (needs Node 26 host).
- `test-buffer-isutf8-isascii-fast.js`: exit 129 is a host-V8 fatal
  (`v8_flags.fuzzing`), not a shim failure; passes natively under
  Node 26.13.1 (exit 0). Reclassify shim-gap → unassessed.

## Drift note (no gap test covers it)
- Shim still exports `SlowBuffer` (`src/buffer.js:2983`, deprecated
  wrapper at `:3943`, exported at `:3978`) — Node 26 REMOVED it
  (export diff). Deleting the export is a one-line drift item for a
  lane, not a flip.
