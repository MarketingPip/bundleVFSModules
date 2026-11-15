# NOTES-fs-readdir-ucs2 — fs wave F1 lane 12

Target: `test-fs-readdir-ucs2.js` (exit 1 → 0). Base main `5d6b0f71`.
Branch `fix/fs-readdir-ucs2`.

## Mechanism (traced end to end)

The test creates a file whose name is a lone surrogate pair, given as a
Buffer path of UTF-16LE bytes (`[3D, D8, 04, DC]`), then reads the directory
with encoding `'ucs2'` and expects the name back byte-identical.

Two stacked gaps in `src/fs.js`:

1. **Write side — `toPathString` decoded every Buffer path as UTF-8.**
   UTF-8 decoding is lossy for byte sequences that are not valid UTF-8
   (`D8 04` → U+FFFD, `DC` → U+FFFD), so memfs stored the file under the
   mangled name `"=\uFFFD\u0004\uFFFD"` and the raw bytes were unrecoverable.
2. **Read side — memfs applied the encoding conversion itself.**
   `readdirBase` does `Buffer.from(storedName).toString(enc)`. No JS string
   UTF-8-encodes to `[3D, D8, 04, DC]` (those bytes are not valid UTF-8), so
   even a losslessly stored name could never come back as `"🐄"` through
   memfs's conversion. The shim must get the raw stored names and convert
   them itself.

## Fix (`src/fs.js` only, +~120 lines)

- `toPathString`: a Buffer path whose bytes are valid UTF-8 still decodes as
  UTF-8 (status quo — string paths and their UTF-8 Buffer equivalents still
  coincide). A Buffer path whose bytes are NOT valid UTF-8 decodes as latin1
  (a byte→code-unit bijection, lossless) and every segment is recorded in
  the module-scope `_nonUtf8PathSegments` Set. Validity is a UTF-8
  round-trip check (`Buffer`) with a fatal-`TextDecoder` fallback.
- `decodeFsName(name, encoding)`: the conversion Node's binding does with
  the raw directory bytes. Normal names: bytes = UTF-8 of the name (identical
  to what memfs did before). Recorded names: bytes = latin1 of the name (the
  raw bytes). Handles `utf8` (default), `buffer` (returns the raw Buffer),
  and every other `Buffer.isEncoding` encoding via `bytes.toString(enc)`.
- `fs.readdir` / `fs.readdirSync` (plain path): memfs is now called with the
  encoding forced to `'utf8'` so it returns raw stored names; the shim
  converts each name with `decodeFsName`. `readdirImpl`
  (withFileTypes/recursive): same conversion at every output point (Dirent
  names, recursive relative paths); lookups keep using the raw stored name.
  `promises.readdir` delegates to `fs.readdir`, so it is covered.
- Adjacent one-word fix in the same two wrappers: `validateEncodingOpt`
  is now called with `allowBuffer = true` for readdir. Native accepts
  `readdir(path, 'buffer')`; the shim threw `ERR_INVALID_ARG_VALUE`
  (pre-existing — no vendored test asserted the throw). `decodeFsName`
  already implements the `'buffer'` arm, so the conversion is complete.

## What it is NOT (ceilings)

- Only readdir consults the Set. `readlink`/`realpath`/`glob`/`opendir`
  still surface the lossy UTF-8 form for invalid-UTF-8 Buffer-path names
  (same as before this fix, not a regression). `opendir` validates an
  encoding option but never stores it on `Dir`, so `Dir` names are never
  encoding-converted (pre-existing gap, separate lane if ever wanted).
- The Set is per-process and never pruned: a segment lingers after its file
  is deleted, so a later normal file with the identical segment string would
  be misdecoded on non-utf8 readdir. Only reachable by deliberately reusing
  the exact latin1 segment string; no vendored test does.
- A string path whose text exactly equals a latin1 segment collides with
  the Buffer path's memfs key (both are valid spellings of different raw
  byte sequences in Node). Same vanishingly-unlikely class as above.
- `readdir` with encoding `'buffer'` now returns results in memfs's sorted
  order (forcing memfs to `'utf8'` sorts; memfs skipped sorting for
  `'buffer'`). Node returns directory order for every encoding and memfs
  already sorted for non-buffer encodings, so nothing in the suite observes
  the difference (`test-fs-readdir-buffer.js` is macOS-only and asserts only
  `err === null`; `test-fs-readdir.js` sorts before asserting).

## Differential

- Target `test-fs-readdir-ucs2.js`: 1 → 0, isolated 2× on branch, empty
  stderr. (Base: exit 1, `Buffer.from(fn,'ucs2')` = `[61, 239, 191, 189, 4,
  239, 191, 189]` vs expected `[61, 216, 4, 220]`.)
- In-tree probe `zz-ucs2-guard.js` (deleted after use): 13/13 checks pass on
  the shim AND on native Node, identical behavior — async/sync `ucs2`,
  default-utf8 lossy decode, `'buffer'` raw bytes, withFileTypes Dirent
  name, valid-UTF-8 Buffer path cross-form with string path, `ucs2` decode
  of a UTF-8 name's raw bytes. (One probe check was wrong as first written —
  native fails it too: `ucs2` readdir of `"café"` does NOT return `"café"`,
  it returns the UTF-16LE decode of café's UTF-8 bytes. Corrected to compare
  against `Buffer.from("café", "utf8").toString("ucs2")`; both agree.)
- Guards: 65-test readdir/readlink/realpath/opendir/glob/readfile/writefile/
  mkdir/open/stat/promises set, run isolated 1× each on the branch; results
  in `hidden_files/fs-f1-readdir-ucs2-results.txt`, diffed against the
  triage base CSV — exactly ONE changed line (the target flip). The 9
  non-zero guards are 1 on base AND branch (other lanes' targets,
  unchanged): `test-fs-mkdir.js` (L10), `test-fs-promises-readfile.js` (L2),
  `test-fs-readdir-types.js` (L2), `test-fs-readfile-pipe-large.js` (L6),
  `test-fs-readfilesync-pipe-large.js` (L6), `test-fs-realpath-native.js`
  (L9), `test-fs-watch-encoding.js` (L7), `test-fs-watch-enoent.js` (L7),
  `test-fs-watchfile-bigint.js` (L3).
- Repo suites: `tests/ondemand-require.test.js` 29/29,
  `tests/fs.test.js` + `tests/fs_promises.test.js` 87/87,
  `tests/export_surface_fs.test.js` +
  `tests/export_surface_fs_promises.test.js` 2/2.

## Ship

- PR #___ / Merge SHA: ___ (filled at ship time)
- CI: (filled at ship time)
