# NOTES-26-crypto-l1 — Mac/PKCS#12 export table (F1)

- Base: origin/main `d587825d` (PR #506 triage merged). Branch:
  `fix/26w1-crypto-mac`. Worktree: `~/workspace/worktrees/26w1-crypto`.
- Banked count: crypto **145/167** on the Node 26 suite
  (`parity/drift/node26-baseline.jsonc`, Node 26.13.1 tests, host v24.22.1).
- Result: **4 flips, verified 2x isolated each** (see §2). New count:
  **149/167**. `test-crypto-provider-cache.js` does NOT flip: after the L1
  fix it fails on a different, newly-exposed root cause (§4).

## 1. Change

`src/crypto.js`: added `createMac`, `getMacs`, `parsePKCS12` to the
`pick()` table and to `defaultExport` (native delegation under genuine
Node). Verified by direct import: all three are `===` the native
`node:crypto` functions, on the named exports and on `default`; `Mac`
is not exported (`crypto.Mac === undefined`, as the test asserts).

New `src/crypto/mac.js`: browser fallback for `createMac`/`getMacs`,
backed by the already-installed `@noble/hashes` 2.4.0 — no new
dependency. Supported: `hmac` (any digest in `hashes.js`), `kmac128` /
`kmac256` (+ `kmac-128` / `kmac-256` aliases), `blake2bmac` /
`blake2smac`. `Mac` extends the shim `Transform` (update/final +
`_transform`/`_flush`, `ERR_CRYPTO_MAC_FINALIZED` after final).
Validation order and error codes mirror Node 26.13.1
`lib/internal/crypto/provider_mac.js` (probed, not assumed):
`ERR_INVALID_ARG_TYPE` / `ERR_INVALID_ARG_VALUE` / `ERR_OUT_OF_RANGE` /
`ERR_CRYPTO_INVALID_MAC` / `ERR_CRYPTO_MAC_FINALIZED`, plus the
OpenSSL key/salt/length codes for kmac/blake2 bounds. Node option
names map onto noble names (`customization` -> `personalization`,
`salt` zero-padded when short as OpenSSL does, `outputLength` ->
`dkLen` with Node's defaults: kmac128 32, kmac256 64, blake2bmac 64,
blake2smac 32). Honest-unsupported (no in-tree primitive;
`@noble/ciphers` is NOT installed): `cmac` / `gmac` / `poly1305` /
`siphash`, and `parsePKCS12` (no in-tree ASN.1/PBE/KDF path) — both
throw `unsupportedCrypto` naming the missing OpenSSL backing.
`getMacs()` in the fallback lists only what it implements (7 names,
sorted, fresh copy per call), same pattern as `getCiphers() -> []`.

`src/crypto/errors.js`: added `ERR_INVALID_ARG_VALUE`,
`ERR_CRYPTO_INVALID_MAC`, `ERR_CRYPTO_MAC_FINALIZED`,
`ERR_OSSL_INVALID_KEY_LENGTH`, `ERR_OSSL_INVALID_SALT_LENGTH`,
`ERR_OSSL_NOT_XOF_OR_INVALID_LENGTH` (messages per Node 26
`lib/internal/errors.js`). `src/crypto/hashes.js`: `toBytes` /
`encodeDigest` exported for reuse by the fallback (no behaviour
change). `tests/export_surface_crypto.test.js`: EXPECTED +3 names
(the v24.20.0 contract grows by the three Node 26 additions).

## 2. Flips (2x isolated each, harness invocation per triage §6)

Staged Node 26 tree into `parity/node-test/` exactly as
`run-baseline.mjs` stages it; ran
`PARITY_TARGET=crypto timeout 30 node [--expose-internals] --import
parity/preload.mjs parity/node-test/parallel/<test>` (cwd = worktree).
Flagged tests ran WITH their `// Flags:` header
(`--expose-internals` for mac/mac-vectors;
`--expose-internals --no-warnings` for provider-cache) because
`run-baseline.mjs` does not yet honor Flags headers. Logs:
`~/workspace/26w1-crypto-r1-logs/` (round 1) and
`~/workspace/26w1-crypto-r2-logs/` (round 2).

| test | r1 | r2 |
|---|---|---|
| `test-crypto-mac.js` | 0 | 0 |
| `test-crypto-mac-errors.js` | 0 | 0 |
| `test-crypto-mac-vectors.js` | 0 | 0 |
| `test-crypto-pkcs12.js` | 0 | 0 |
| `test-crypto-provider-cache.js` | 1 | 1 (§4) |

## 3. Regression the fix itself caused, and the repair

The first cut imported `Transform` from `../stream.js` in
`src/crypto/mac.js`. That regressed the whole suite: a baseline
passer (`test-crypto-hmac.js`) went exit 1 with Node 26
`test/common`'s global-leak detector —
`Unexpected global(s) found: setImmediate, setInterval, setTimeout,
queueMicrotask` at `common/index.js:439` — and the four flip targets
failed the same way at exit (after their assertions had passed).
Root cause, probe-proven: importing `src/stream.js` pulls
`events -> async_hooks -> als-browser`, which replaces all four
timer globals at import time (verified per-module: `src/events.js`,
`src/async_hooks.js`, `src/async_context.js` each replace them;
`src/stream/readable.js` inherits it via `../events.js`).

Repair follows the repo's established per-module pattern (http2
precedent, commit `9b466a26`, same-PR wiring): new
`parity/crypto-harness.mjs` (loads `src/crypto.js`, restores the
originals from `globalThis.__PARITY_ORIG_TIMERS__`, re-exports) plus
an additive, `target === "crypto"`-gated redirect in
`parity/preload.mjs` (CJS path) and `parity/hooks.mjs` (ESM path —
`test-crypto-mac.js` does `await import('node:crypto')`). After the
repair `test-crypto-hmac.js` is exit 0 again and the four flips hold
2x. The preload/hooks touches are 6 lines each, crypto-gated only;
no other module's behaviour changes.

## 4. NOT flipped: `test-crypto-provider-cache.js` — new root cause

After the L1 fix the test passes its L1 assertions (`checkLists`
over `getMacs`, `checkMacAliases` via `binding.getCachedMacAliases`)
and fails later, at line 99:
`TypeError: binding.isKeyAlgorithmAvailable is not a function`
(`checkNamedKeygen`, via `internalBinding('crypto')` from
`internal/test/binding`, under `--expose-internals`).
Probe: host v24.22.1 `typeof binding.isKeyAlgorithmAvailable ===
'undefined'`; Node 26.13.1 `=== 'function'`. The test needs a
Node 26 internal binding the host does not have — a host-vs-26
internal-binding gap, not the export table. Fixing it would mean a
`internal/test/binding` adapter for the crypto target (shared
harness work, different root cause); out of scope for this lane.
Conservative floor was 3; landed 4.

## 5. Guard

Full crypto differential via `parity/drift/run-baseline.mjs
--modules crypto --jobs 2` (fresh out/csv under
`~/workspace/26w1-crypto-guard.jsonc` /
`~/workspace/26w1-crypto-guard-csv/`): **147/167 pass, 17 fail,
3 timeout** (baseline 145/167 pass, 22 fail, 0 timeout). Per-test
diff vs baseline: the four flips hold in the guard run (mac,
mac-errors, mac-vectors, pkcs12 fail -> pass — including mac and
mac-vectors, which pass even though the runner does not pass their
`--expose-internals` flag); provider-cache stays fail/1 (same
`isKeyAlgorithmAvailable` gap, §4); no other test changed status
except three 10s/30s-cap timeouts, all proven load artifacts by
isolated re-run (see below). Net guard delta: +2 pass in-run
(+4 flips, −2 pass->timeout under parallel load); isolated
re-runs recover both, for a true **149/167**.

Timeout triage (isolated, staged tree, 30s cap then 60s cap):
`test-crypto-dh-leak.js` exit 0 (26s, then 24s);
`test-crypto-kem-shared-key.js` exit 0 (30s, then 22s) — both
genuinely slow tests, pass 2x isolated; `test-crypto-key-reuse-
concurrent.js` exit 1 in 8s at its baseline failure
(`exercise` :113 SEC1 deep-equal, the known L7 gap, not this lane).
No regressions: the full 145-test baseline pass set is intact.

Repo tests: `NODE_OPTIONS=--experimental-vm-modules npx --no-install
jest tests/export_surface_crypto.test.js tests/crypto.test.js` —
16/16 pass (the bare `npx jest` invocation fails on ESM loading;
the repo's own `npm test` uses `--experimental-vm-modules`).

Fallback differential (zz-probe, deleted after use):
`src/crypto/mac.js` vs Node 26.13.1 `createMac` — 67/67 checks pass
(hmac sha256/sha512/sha1/md5 incl. string/hex encodings, empty key,
incremental, view offsets; kmac128/256 NIST samples incl.
customization + streaming + defaults + out0; blake2bmac/blake2smac
vectors incl. salt DataView, short-salt zero-padding matching
OpenSSL, empty salt, defaults; 30+ error-path codes; Transform
instanceof, stream write/end tag, kmac-out0 no-data, mixed
final-then-end `ERR_CRYPTO_MAC_FINALIZED`). Noble mapping verified
separately first (8/8 incl. kmac customization -> personalization).

## 6. Ceiling / upgrade path

- `cmac`/`gmac`/`poly1305` need a verified browser-safe primitive
  (`@noble/ciphers` or equivalent, verified to survive esbuild
  `platform:browser`); `siphash` needs a small dedicated primitive.
  Until then the fallback throws honest-unsupported for them.
- `parsePKCS12` browser support needs a verified ASN.1/PBE/KDF dep.
- Fallback `hmac` digest set is limited to `hashes.js` (no sha3);
  Node accepts more via OpenSSL.
- Fallback error messages for the OpenSSL codes are short
  descriptions (`Invalid key length`, etc.), not the full OpenSSL
  error stack — only the native bridge can produce that.

## 7. CI red on first push — oracle surface vs pinned 24.20.0 runner (fixed)

- PR #514, first head `455b07df`: Build VFS run 44641409004 — Parity job
  success, build job failure in the "Run Tests" step only (57 s; Build VFS
  and later steps skipped).
- Root cause, proven under the exact CI runtime
  (`~/workspace/local/node-24.20.0/bin/node`): Node 24.20.0's live
  `node:crypto` has no `createMac`/`getMacs`/`parsePKCS12` (all
  `typeof === 'undefined'`; also absent from the 24.20.0 source pack's
  `lib/crypto.js`). `tests/oracle-export-surface.test.js` compares shim vs
  live and flags shim-only keys as `Extra exports` — crypto had no
  allowlist entry. Under 24.20.0 the oracle crypto test fails with exactly
  `Extra exports: createMac, getMacs, parsePKCS12` (15/16 pass); under host
  24.22.1 it passes (live has all three). This is the CI failure, not a
  regression in the shim: the lane intentionally ships Node 26 exports the
  pinned runner predates.
- Fix (second commit on the branch): `crypto: ["createMac", "getMacs",
  "parsePKCS12"]` in the oracle test's allowlist, with a comment stating
  the direction (forward extras, not deprecated extras). Smallest correct
  fix; reuses the test's existing intentional-extras mechanism.
- Verified: full jest suite under Node 24.20.0
  (`NODE_OPTIONS=--experimental-vm-modules ... jest --runInBand
  --forceExit`) exits 0, zero FAIL lines — the exact CI "Run Tests" step.
- Note: `node src/build-vfs.mjs` fails on this VM (esm.sh fetch for acorn
  fails inside the esm-sh plugin, 2/2 runs, while curl to the same URL
  returns 200) — a VM-local network issue, NOT the CI failure (CI skipped
  Build VFS after "Run Tests" failed; crypto itself builds fine:
  `Built crypto -> dist/crypto.js`). Local dist/ churn from those runs was
  restored with `git checkout -- dist/`.
