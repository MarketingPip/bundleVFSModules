# NOTES — zlib L1: vendor 3 missing fixtures

## Mechanism

`test-zlib-from-concatenated-gzip.js` failed natively AND under the shim with ENOENT:
the test reads `fixtures/pseudo-multimember-gzip.z` + `.gz`, which were absent from the
vendored tree. The shim's multi-member gzip engine was already correct (triage probes
C6/R7/P2: multi-member sync `"abcdef"`, pseudo-multimember stream 129,791 bytes equal,
all 6 offset-split member-boundary writes `"abcdef"`). The fix is pure vendoring:
copy the 3 files verbatim from the local SHA256-verified Node v24.20.0 tarball
(`hidden_files/node-src/node-v24.20.0.tar.gz`, `node-v24.20.0/test/fixtures/`).
No web fetch, no `src/` change, no preload change.

Files vendored (sizes verified against triage):

- `parity/node-test/fixtures/person.jpg.br` — 45,173 bytes (enables
  brotli-from-brotli with L5; does NOT flip it here — that test needs the brocha
  decoder)
- `parity/node-test/fixtures/pseudo-multimember-gzip.z` — 148 bytes
- `parity/node-test/fixtures/pseudo-multimember-gzip.gz` — 161 bytes

## Evidence

- Target `test-zlib-from-concatenated-gzip.js`: 1 → 0, isolated 2× under
  `PARITY_TARGET=zlib` on the branch head.
- Guards (all exit 0): `test-zlib.js` 2× (manual — fast-sweep's `test-zlib-*.js`
  glob never sees it), `test-zlib-close-after-error.js`,
  `test-zlib-const.js`, `test-zlib-convenience-methods.js`, `test-zlib-crc32.js`,
  `test-zlib-deflate-constructors.js`, `test-zlib-destroy.js`.
- NOT claimed: `test-zlib-brotli-from-brotli.js` still exits 1 (needs L5 brocha
  decoder); the `.br` fixture only removes its ENOENT half.
- Binary fixtures: no lint-hook trip (no source files changed).

## Ship

- PR #___ / Merge SHA: ___
- Branch: `fix/zlib-fixtures` (fold the ship-section wart into the wave docs sync,
  per the P1/P2/P3 precedent)
