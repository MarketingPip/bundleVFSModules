# NOTES-26-buffer-b1b4 — Node 26 Wave 1, buffer B1–B4

- Base: `d587825d` (origin/main, PR #506 triage merged). Banked buffer count
  on the Node 26 suite: **64/74**. Lane scope: NOTES-26-triage-buffer.md
  §B1–B4 (6 estimated flips). Changes in `src/buffer.js`, plus a one-line
  test-expectation update in `tests/export_surface_buffer.test.js` (see
  "Repo-test fallout" below).
- Host: `node v24.22.1`; Node 26 oracle binary `~/workspace/local/node-26/bin/node`
  (`v26.13.1`). Node 26 tests from `~/workspace/local/node-26-src/test/parallel/`.
- None of the 6 target tests carries a `// Flags:` header, so
  `parity/drift/run-baseline.mjs --modules buffer` applies directly.
  (One non-target test, `test-buffer-isutf8-isascii-fast.js`, DOES carry a
  flags header — `--expose-internals --no-warnings --allow-natives-syntax` —
  but `test/common` self-respawns with those flags, so it runs flagged even
  under the runner; see the B8 note below.)

## Result: 71/74 (64 + 7 flips, verified 2x)

| Test | Baseline | Run 1 (full suite) | Run 2 (full suite) | Isolated re-run |
|---|---|---|---|---|
| test-buffer-isascii.js (B1) | fail 1 | 0 | 0 | — |
| test-buffer-isutf8.js (B1) | fail 1 | 0 | 0 | — |
| test-buffer-islatin1.js (B2) | fail 1 | 0 | 0 | — |
| test-buffer-stringlength.js (B2) | fail 1 | 0 | 124 (load) | 0 (23s wall) |
| test-buffer-indexof.js (B3) | fail 1 | 0 | 0 | — |
| test-buffer-write.js (B4) | fail 1 | 0 | 0 | — |
| test-buffer-isutf8-isascii-fast.js (B8, side effect of B2) | fail 129 | 0 | 0 | 0 |

- Run 1: `parity/drift/run-baseline.mjs --modules buffer --jobs 2` →
  **71/74 pass, 3 fail, 0 timeout** (`/tmp/node26-buffer-b1b4-run1.jsonc`).
  8 files hit the 10s cap in phase 1, all passed at 30s in phase 2.
- Run 2: same invocation → **68/74 pass, 3 fail, 3 timeout**
  (`/tmp/node26-buffer-b1b4-run2.jsonc`). The 3 timeouts are load artifacts:
  5+ Wave 1 lanes were running `run-baseline` concurrently (load avg ~8–18,
  16 files hit the 10s cap in phase 1). All 3 re-ran isolated at 90s and
  exited 0: `test-buffer-stringlength.js` (23s wall),
  `test-buffer-constructor-node-modules-paths.js` (23s),
  `test-buffer-tostring-rangeerror.js` (33s; its only output is the expected
  DEP0005 deprecation warning).
- Guard held in both runs: every test passing in the baseline still passes.
  The only non-zero exits in either run are the 3 expected non-flips below
  plus the run-2 load timeouts, all re-confirmed 0 in isolation.

## Repo-test fallout (caught before CI, then by CI)

- `tests/export_surface_buffer.test.js` pins the exact `node:buffer`
  export surface captured from Node v24.20.0, so adding `isLatin1` made
  it fail locally with `extra: ["isLatin1"]` (verified:
  `jest tests/export_surface_buffer.test.js tests/buffer.test.js` —
  1 failed / 13 passed before the fix, 14 passed after). `isLatin1`
  was added to its `EXPECTED` list with a comment noting it is a Node 26
  addition; the `SlowBuffer` entry is deliberately left in place (its
  Node 26 removal is separate drift, not this lane). No other repo test
  references `isLatin1` / `stringLength` / the write fns, and no test
  enumerates `Buffer` statics.
- `tests/oracle-export-surface.test.js` compares shim exports against
  the LIVE Node runtime (CI pins 24.20.0), so it also flagged
  `Extra exports: isLatin1` — the first CI run failed on exactly this
  one test (1 failed / 3070 passed, run 44641416884). Fix: a new
  `NEWER_NODE_ALLOWLIST` (`buffer: ["isLatin1"]`) next to the existing
  `DEPRECATED_ALLOWLIST`, for exports from a Node release newer than the
  pinned oracle; entries are removed when the oracle's Node pin catches
  up. Verified locally: `node:buffer` oracle test passes.
- Pre-existing, NOT this lane: on this host (v24.22.1) the oracle test
  also fails for `node:util` (missing `debounce`, `markPromiseAsHandled`,
  `throttle`) and `node:crypto` (missing `createMac`, `getMacs`,
  `parsePKCS12`) — the shims are pinned to v24.20.0 and the host is
  newer. Proved pre-existing by running the oracle suite on the stashed
  base (3 failures: buffer + util + crypto) vs with the fix (2: util +
  crypto only). In CI (Node 24.20.0) those two pass, as the run above
  shows.

## Remaining fails (expected, out of scope)

- `test-buffer-alloc-alignment.js` (exit 1, B6 NO-FIX): needs
  `internalBinding('buffer')` / a V8 base-address offset — no browser
  equivalent; alignment itself is unobservable from JS.
- `test-buffer-copy-immutable.js` (exit 9, B7 unassessed): the host
  v24.22.1 rejects the `--js-immutable-arraybuffer` flag before any test
  code runs; needs a Node 26 host to assess.
- `test-buffer-pool-untransferable.js` (exit 1, B5 NO-FIX): requires the
  pool ArrayBuffer to be simultaneously shared AND untransferable — no JS
  API marks an ArrayBuffer untransferable.

## B1 — detached buffers treated as empty in isAscii/isUtf8 (2 flips)

- `src/buffer.js:3905-3940` (`isUtf8`, `isAscii`): the detached branch now
  returns `true` instead of throwing `ERR_INVALID_STATE`. The DataView
  probe in `isAnyArrayBuffer` still fails on a detached genuine
  ArrayBuffer, so `isDetachedArrayBuffer` detects it; detached views and
  `Buffer.from(detached)` already reached the bindings with byteLength 0
  and returned `true`.
- Oracle (26.13.1 binary): after `structuredClone(ab, { transfer: [ab] })`,
  `isUtf8(ab)`, `isAscii(ab)`, and the same on its Uint8Array view and
  `Buffer.from(ab)` are all `true`.
- `ERR_INVALID_STATE`'s constructor is now unused by these paths; the
  helper itself is left in place (shared error-constructor section).

## B2 — isLatin1 + Buffer.stringLength (2 flips + 1 side effect)

- `isLatin1` (`src/buffer.js`, after `isAscii`): `validateString` then one
  pass checking every code unit `<= 0xFF` (surrogates/lone surrogates are
  `> 0xFF` → `false`). Exported on the module namespace ONLY
  (`bufferExports` + named ESM export); `Buffer.isLatin1` stays undefined.
- `stringLength` (`src/buffer.js`, after `isLatin1`): mirrors Node 26
  `lib/buffer.js:1513-1541`. Input check (`isTypedArray` /
  `isAnyArrayBuffer`, detached ArrayBuffer → `0`, else
  `ERR_INVALID_ARG_TYPE` — DataView/Blob/strings/numbers all throw);
  `validateString(encoding)` then `getEncodingOps` (unknown →
  `ERR_UNKNOWN_ENCODING`). Semantics: utf8 → the WHATWG decoder behind
  `toString('utf8')` reused (`utf8Slice(...).length`, so invalid sequences
  count one U+FFFD per maximal subpart, exactly as the test's own
  `buf.toString(encoding).length` oracle); utf16le → `floor(len/2)`; hex →
  `len*2`; base64 → `ceil(len/3)*4`; base64url → `ceil(len*4/3)`; latin1 /
  ascii → `len`. Assigned ONLY as `Buffer.stringLength`
  (`src/buffer.js`, next to `Buffer.byteLength`); the module namespace
  does NOT export it.
- Cost note: the utf8 path builds the decoded string (~2.1s for the
  3 MiB `€` case vs ~1.4s for `toString()` alone); acceptable — the test
  itself builds the same string as its oracle.
- B8 side effect (7th flip): `test-buffer-isutf8-isascii-fast.js` now
  passes. It was failing 129 in the baseline because `isLatin1` did not
  exist in the shim, so `%PrepareFunctionForOptimization(isLatin1)` /
  `%OptimizeFunctionOnNextCall(isLatin1)` ran on `undefined` and the host
  V8 fatalled (`Check failed: v8_flags.fuzzing`). Proved by direct probe:
  the base shim reproduces the fatal on this test (exit 133, same
  `v8_flags.fuzzing` check, SIGTRAP vs the baseline's 129 SIGABRT — same
  V8 fatal, signal varies), `%OptimizeFunctionOnNextCall(undefined)` alone
  on host v24.22.1 exits 133, and the same intrinsic on the shim's real
  `isAscii` exits 0. With a real JS function to optimize, the intrinsics
  succeed. Verified in both full runs and in isolation (the test self-respawns with its flags header via
  `test/common`, which is why the runner's lack of flags support does not
  matter here).

## B3 — indexOf ucs2/utf16le odd byte offset (1 flip)

- `src/buffer.js` `bindingIndexOfBuffer` (~:1301): forward search now
  `Math.ceil(offset / 2)` instead of `Math.floor(offset / 2)`; backward
  stays `Math.floor(offset / 2)`. The directions differ by construction:
  forward, an odd byte offset starts at the NEXT unit boundary
  (`indexOf('\u6881', 1, 'utf16le')` is 4, not 0; `-1` → `-1` via the
  ceil of the wrapped offset 5); backward, a match must start at or before
  the byte offset (`lastIndexOf('\u6881', 3, 'utf16le')` is 0, not 4 —
  ceiling the backward path would return matches starting past the offset).
- Oracle (26.13.1 binary, `Buffer.from('\u6881\u6882\u6881', 'utf16le')`):
  forward 1 → 4, 3 → 4, 2 → 4, -1 → -1; backward 1 → 0, 3 → 0, 5 → 4,
  -1 → 4. All match the shim after the fix.

## B4 — asciiWrite/latin1Write/utf8Write coerce offset exactly once (1 flip)

- `src/buffer.js` (`asciiWrite`/`latin1Write`/`utf8Write`): the offset is
  now coerced once on entry (`offset === undefined ? 0 : Number(offset)`),
  the default `length` is computed inside the body from the coerced value,
  and the bounds checks run on the raw double while the static writer gets
  `ToIntegerOrInfinity(offset)` (`NaN` → 0, fractions truncated).
- Why not `parseArrayIndex` (as `stringWriteChecked` does): it throws
  `ERR_OUT_OF_RANGE` for negative offsets, but Node throws
  `ERR_BUFFER_OUT_OF_BOUNDS` for `asciiWrite('ww', -1)` — probed on the
  26.13.1 binary, along with the fractional semantics the raw-double
  checks preserve (0.9 with length 1 on a 1-byte buffer is OOB via the
  length check; 0.5 writes at 0; `NaN`/`'a'`/`{}` behave as 0; `10n` is
  OOB; Symbol throws TypeError). The old code coerced an object offset
  2–3x (two comparisons + the default-length expression); the 26 test
  counts exactly one `valueOf` call.
- Callers are unaffected: `Buffer.prototype.write` already validates the
  offset as an integer via `validateOffset` before calling these, and the
  `encodingOps` write paths pass validated numbers.

## Ship

- PR: #512
- Merge SHA: `bb6905b58ef37ec10ac96c0806a38ea7b1786a2e` (squash-merge of PR #512)
- Final count: **buffer 71/74** (64 banked + 7 flips, 0 regressions)
