# NOTES-26-triage-crypto — Node 26 re-target triage, module `crypto`

- Base: worktree `~/workspace/worktrees/node26-triage-crypto`, HEAD `3c091022`
  (`feat(drift): Node 26 drift detector — export diff + baseline + oracle (#505)`).
- Banked numbers (parent-verified, not recomputed): overall 2,748 tests,
  2,144 pass / 575 fail / 29 timeout. crypto: 22 non-pass = **20 shim-gap +
  2 fails-natively**, 0 native-timeout.
- Versions verified by probe before trusting any result:
  `~/workspace/local/node-26/bin/node --version` = `v26.13.1`;
  harness host `node --version` = `v24.22.1`, OpenSSL `3.5.9`.
- Method: `parity/drift/run-baseline.mjs` read first. Isolated re-runs used its
  exact invocation (`PARITY_TARGET=crypto timeout N node --import
  parity/preload.mjs parity/node-test/parallel/<test>`, cwd = worktree) with
  the Node 26 test tree staged exactly as `run-baseline.mjs` stages it
  (parallel + common + fixtures from `~/workspace/local/node-26-src/test/`),
  then restored (`git checkout -- parity/node-test` + removal of staged-only
  files; `git status --porcelain -- parity/node-test` empty afterwards).
  Round 1 at 10 s, round 2 at 30 s for the slow/disputed tests. Every test
  also run natively on the Node 26.13.1 binary (no preload).
- Structural fact that explains most of this module: under the harness the
  shim's native bridge (`src/crypto.js`, `getBuiltinModuleSafe`) delegates
  to the **host Node v24.22.1** crypto. Most gaps below are therefore
  host-v24-vs-Node-26 behaviour skew surfacing through a pass-through, not
  missing browser code. The browser fallback is a separate concern per lane.

## Gap total: 20 (fails-natively 2 listed separately, §5)

## 1. New-in-26 vs pre-existing split (grounded, corrected — see §6)

v24.20.0 source pack has no extracted `test/` dir (only `lib/` +
`node-v24.20.0.tar.gz`); membership was checked by listing the tarball
(128 `test-crypto-*` files) and by `cmp` of the 11 shared files v24-vs-26.

- **New test files in 26 (11):** `test-crypto-ec-jwk-coordinates.js`,
  `test-crypto-job-error-parity.js`, `test-crypto-key-reuse-concurrent.js`,
  `test-crypto-mac-errors.js`, `test-crypto-mac-vectors.js`,
  `test-crypto-mac.js`, `test-crypto-pkcs12.js`,
  `test-crypto-provider-cache-snapshot.js`, `test-crypto-provider-cache.js`,
  `test-crypto-random-cache-snapshot.js`,
  `test-crypto-randomfill-properties.js`.
- **Files present in v24.20.0 with changed 26 expectations (11):**
  `test-crypto-argon2-job.js`, `test-crypto-async-sign-verify.js`,
  `test-crypto-default-shake-lengths-oneshot.js`,
  `test-crypto-default-shake-lengths.js`, `test-crypto-dh-stateless.js`,
  `test-crypto-encap-decap.js`, `test-crypto-gcm-implicit-short-tag.js`,
  `test-crypto-hash.js`, `test-crypto-key-objects-to-crypto-key.js`,
  `test-crypto-no-algorithm.js`, `test-crypto-secure-heap.js`.
  All 11 differ v24-vs-26 (`cmp` fails on all 11). These are
  **behaviour-change regressions in test expectations, not shim
  regressions**: the shim is unchanged since the v24 129/129 close
  (commit `d16b029a`); the tests now assert Node 26 semantics. Two
  diffs prove the pattern:
  - `test-crypto-gcm-implicit-short-tag.js`: v24 expected a DEP0182
    deprecation *warning* for a 12-byte tag; 26 expects a *throw*
    `Invalid authentication tag length: N` for every N in 0..15.
  - `test-crypto-hash.js`: 26 added a second expected warning, DEP0198
    (shake default output length); v24 had only DEP0179.
- No v24-era test that passed at 129/129 fails because the shim broke;
  every IN-V24 failure traces to a 26 semantic change listed in §2–§4.

## 2. Gap families (20 tests)

### F1. Missing Mac / PKCS#12 exports — 5 tests — real shim work (trivial)
- Tests: `test-crypto-mac.js`, `test-crypto-mac-errors.js`,
  `test-crypto-mac-vectors.js`, `test-crypto-pkcs12.js`,
  `test-crypto-provider-cache.js`.
- Evidence (isolated re-run, 30 s, harness exit 1):
  - `test-crypto-mac.js` / `test-crypto-mac-vectors.js:25`:
    `TypeError: getMacs is not a function`.
  - `test-crypto-pkcs12.js`: `TypeError: crypto.parsePKCS12 is not a function`.
  - `test-crypto-provider-cache.js:48`: `TypeError: crypto[name] is not a
    function` — `name` is `getMacs` (getters list at line 29:
    `['getCiphers', 'getHashes', 'getMacs', 'getCurves']`).
- Root cause: `src/crypto.js` has no `createMac` / `getMacs` /
  `parsePKCS12` in its export table (nor in `defaultExport`), so the
  native bridge never reaches the host for them — even though the host
  HAS them. Probe:
  - host v24.22.1: `createMac function, getMacs function, parsePKCS12
    function`, `getMacs()` =
    `blake2bmac,blake2smac,cmac,gmac,hmac,kmac-128,kmac-256,kmac128,kmac256,poly1305,siphash`.
  - Node 26.13.1: identical three functions and identical 11-name
    `getMacs()` list.
  - Export diff confirms the same three as ADDED in 26
    (`parity/drift/node26-export-diff.md:85`).
- Browser fallback: `createMac` subset is implementable from the
  already-installed `@noble/hashes` 2.4.0 (`hmac.js`; `kmac128`/`kmac256`
  in `sha3-addons.js`; keyed `blake2b`/`blake2s` in `blake2.js`).
  `cmac` / `gmac` / `poly1305` / `siphash` have **no in-tree primitive**
  (`@noble/ciphers` is NOT installed; no other ASN.1/PBE dep exists in
  the tree). No new dependency is named here: none was verified to
  survive esbuild `platform:browser`. `parsePKCS12` browser fallback
  likewise has no in-tree ASN.1/PBE/KDF path (fixtures use PKCS12KDF +
  3DES, FIPS fixtures PBMAC1/PBKDF2 + AES-256) — honest-unsupported in
  the browser until a dep is verified; the harness flip does not need it.

### F2. Node 26 error decoration / message parity — 6 tests — real shim work
- Tests: `test-crypto-argon2-job.js`, `test-crypto-encap-decap.js`,
  `test-crypto-job-error-parity.js`, `test-crypto-no-algorithm.js`
  (sync side); `test-crypto-async-sign-verify.js`,
  `test-crypto-dh-stateless.js` (async side).
- Evidence (isolated re-runs, harness exit 1; native26 exit 0):
  - argon2-job: `actual: 'error:1C8000EA:Provider routines::invalid thread
    pool size'`, `expected: /Argon2 derivation failed/`
    (`test-crypto-argon2-job.js:44`). Host gives the raw OpenSSL
    message; 26 prefixes a friendly `Argon2 derivation failed`.
  - encap-decap:229: `actual message: 'Failed to perform decapsulation'`,
    `expected: /Decapsulation failed/` (code `ERR_CRYPTO_OPERATION_FAILED`
    matches).
  - job-error-parity:211: same decapsulation message mismatch
    (`'Failed to perform decapsulation'` vs `/Decapsulation failed/`).
    This test's purpose (header comment) is sync/async error parity via
    a `CryptoErrorStore`; its first failure is the *sync* message text,
    i.e. the 26 canonical text changed, not an async divergence.
  - no-algorithm:40: `actual: 'error:0308010C:digital envelope
    routines::unsupported'`, `expected: /derivation failed/`; the test
    also requires `err.code === 'ERR_OSSL_EVP_UNSUPPORTED'` and an
    `err.opensslErrorStack` array containing
    `/digital envelope routines::unsupported/`. Host v24 gives the raw
    message with neither the prefix nor the stack property.
  - async-sign-verify:184: `actual: undefined`,
    `expected: 'ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE'`.
    The async `crypto.verify(undefined, data, <ed25519 key>, sig, cb)`
    callback receives an error whose `.code` is `undefined` under host
    v24.22; 26 decorates async job errors with `code`/`library`/`reason`
    (26.0.0 changelog row, verified against this failure).
  - dh-stateless:215: same shape — async `diffieHellman` callback error
    `.code` is `undefined`, `expected:
    'ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS'` (sync `assert.throws` in
    `testDHError` passes; only the async callback loses the code).
- Classification: real shim work, two sub-lanes (§3 L5/L6). Not a
  missing primitive: every operation itself succeeds/fails correctly;
  only the error's message text / decoration properties differ.

### F3. SHAKE default-length deprecation DEP0198 — 3 tests — real shim work
- Tests: `test-crypto-default-shake-lengths.js`,
  `test-crypto-default-shake-lengths-oneshot.js`, `test-crypto-hash.js`.
- Evidence: `default-shake-lengths.js:14` —
  `Mismatched <anonymous> function calls. Expected exactly 1, actual 0`
  for `common.expectWarning({ DeprecationWarning: { DEP0198: 'Creating
  SHAKE128/256 digests without an explicit options.outputLength is
  deprecated.' } })`. The oneshot test expects the same DEP0198 from
  `crypto.hash('shake128', 'test')`. `test-crypto-hash.js` expects 2
  warnings, got 1: DEP0179 fires (from host) but DEP0198 never does.
- Root cause: under the harness `createHash`/`hash` delegate to host
  v24.22, which has no DEP0198 (added 25.0.0); the shim never emits it.
  Browser fallback additionally lacks shake entirely:
  `src/crypto/hashes.js` `ALGORITHMS` has no shake entry and
  `FALLBACK_HASHES` (`src/crypto.js`) omits shake128/256 — but
  `@noble/hashes/sha3.js` already installed exports `shake128`/`shake256`
  (verified lines 428–445), so the fallback primitive exists in-tree.

### F4. Validation gaps: host v24 allows, 26 forbids — 2 tests — real shim work
- Tests: `test-crypto-gcm-implicit-short-tag.js`,
  `test-crypto-ec-jwk-coordinates.js`.
- Evidence:
  - gcm-implicit-short-tag: `AssertionError: Missing expected exception`
    for every tag length 0..15; 26 requires `setAuthTag` to throw
    `Invalid authentication tag length: ${tagLength}` unless the
    decipher was created with explicit `authTagLength` (DEP0182, 26.0.0;
    the explicit-tag sibling `test-crypto-gcm-explicit-short-tag.js`
    passes under the harness). Host v24.22 accepts the short tags.
  - ec-jwk-coordinates: `AssertionError: Missing expected exception`,
    `expected: { code: 'ERR_CRYPTO_INVALID_JWK' }`. A 33-byte `x`/`y`
    coordinate (P-256 field is 32 bytes) must throw from
    `createPublicKey({ key: <jwk>, format: 'jwk' })`; host v24.22
    accepts it. 26 fixed the JWK decoder (oversized coordinates no
    longer silently truncate/replace). Note the test also exercises
    `subtle.importKey('jwk', …)` (platform WebCrypto) for the same
    coordinates — that half is unverified on host v24 WebCrypto.

### F5. KeyObject export / validation — 2 tests — real shim work
- Tests: `test-crypto-key-objects-to-crypto-key.js`,
  `test-crypto-key-reuse-concurrent.js`.
- Evidence:
  - key-objects-to-crypto-key:140 (`macInvalid`, KMAC128 case):
    `AssertionError: Missing expected exception (NotSupportedError)`,
    `expected: { name: 'NotSupportedError', message: 'Invalid key
    length' }`. `createSecretKey(Buffer.alloc(0)).toCryptoKey({ name:
    'KMAC128', length: 0 }, …)` must throw; host v24.22 does not
    validate KMAC key length (26 added `validateKmacKeyLength` in
    `lib/internal/crypto/mac.js`).
  - key-reuse-concurrent:113: `privateKey.export({ type: 'sec1', format:
    'der' })` deep-equal fails — actual `Buffer(109)`, expected
    `Buffer(121)`. The 12-byte difference is the EC-parameters OID
    `a0 0a 06 08 2a 86 48 ce 3d 03 01 07` (P-256, 1.2.840.10045.3.1.7):
    the 26 fixture export includes the parameters, the host-v24.22
    export omits them. (The test's JWK/raw/spki/pkcs8 export assertions
    before line 113 pass; failure is SEC1-only.) This is host-v24-vs-26
    encoding skew, fixable by shim-side SEC1 re-encoding, not a missing API.

### F6. randomFill must not read view getters — 1 test — real shim work
- Test: `test-crypto-randomfill-properties.js` (harness exit 1; native26
  exit 0).
- Evidence: failure inside host native `randomFillSync
  (node:internal/crypto/random:137:27)` — `AssertionError: Unexpected
  BYTES_PER_ELEMENT getter`. The test shadows `byteLength`, `length`,
  `BYTES_PER_ELEMENT`, `buffer`, `byteOffset`, `Symbol.toStringTag` with
  `mustNotCall` getters on every TypedArray/DataView/Buffer/ArrayBuffer
  input, then calls `randomFill`/`randomFillSync` with offset/size in
  *element* units. Node 26's implementation uses internal slots only.
- Both current paths read getters: host v24.22 `randomFillSync` (proven
  by the stack) AND the shim fallback (`src/crypto/random.js:170,194`
  `buf.BYTES_PER_ELEMENT`; `:62` `isTypedArray` reads it; `toUint8`
  reads `buf.buffer`/`byteOffset`/`byteLength`).
- Viability probes (host v24.22.1, all OK, no getter read):
  `Atomics.store` on poisoned Int16Array; `.set()` on poisoned
  Float32Array/Uint8Array; `setUint8` on poisoned DataView;
  `input.constructor.BYTES_PER_ELEMENT` (= 2, instance getter not
  triggered) as the element-size source. Negative control: host
  `getRandomValues` (webcrypto and `node:crypto`) DOES read the
  poisoned `byteLength` getter on v24.22.1, while Node 26.13.1's does
  not — so the lane must use the Atomics/`set()` path, not a
  `getRandomValues` wrapper.
- So this is implementable pure-JS work, not a NO-FIX: stop delegating
  `randomFill`/`randomFillSync` to host native and rewrite
  `src/crypto/random.js` to be getter-proof.

### F7. Secure heap — 1 test — host artifact, NO-FIX (see §4)
- Test: `test-crypto-secure-heap.js`.

## 3. Lane candidates (conservative estimated flips; sum 19/20, 1 NO-FIX)

- **L1 — Mac/PKCS#12 export table (F1).** Add `createMac`, `getMacs`,
  `parsePKCS12` to the `pick()` table and `defaultExport` in
  `src/crypto.js` (native delegation; browser fallback: noble-backed
  `createMac` for hmac/kmac/blake2mac, honest-unsupported for
  cmac/gmac/poly1305/siphash and for `parsePKCS12` until a dep is
  verified). **Flips 5:** `test-crypto-mac.js`,
  `test-crypto-mac-errors.js`, `test-crypto-mac-vectors.js`,
  `test-crypto-pkcs12.js`, `test-crypto-provider-cache.js`.
  Conservative floor 3: `mac-vectors` (cmac/gmac/poly1305/siphash
  vectors), `provider-cache` (cache-snapshot semantics:
  fresh-sorted-copy-per-call, mutation-immune — host native provides it,
  but unproven until run), and `pkcs12` (fixture/KDF behaviour on host
  OpenSSL 3.5.9) each carry small residual host-vs-26 risk. `mac` +
  `mac-errors` are near-certain (same OpenSSL vectors, same getMacs list).
- **L2 — DEP0198 shake warning (F3).** Wrap `createHash`/`hash` in
  `src/crypto.js` to `process.emitWarning(…, { code: 'DEP0198' })`
  when algorithm is shake128/shake256 without `options.outputLength`;
  add shake128/256 to the browser fallback via `@noble/hashes/sha3.js`
  and to `getHashes()`. **Flips 3:**
  `test-crypto-default-shake-lengths.js`,
  `test-crypto-default-shake-lengths-oneshot.js`, `test-crypto-hash.js`.
- **L3 — GCM short-tag validation (F4, half).** Wrap `createDecipheriv`
  so `setAuthTag(tag)` throws
  `Invalid authentication tag length: ${tag.length}` for length < 16
  when no explicit `authTagLength` was given. **Flips 1:**
  `test-crypto-gcm-implicit-short-tag.js`.
- **L4 — EC JWK coordinate validation (F4, half).** Validate JWK `x`/`y`
  byte-lengths (≤ field size for the curve) in a `createPublicKey`
  wrapper, throwing `ERR_CRYPTO_INVALID_JWK`. **Flips 1 (at-risk, 0–1):**
  `test-crypto-ec-jwk-coordinates.js` — the `subtle.importKey` half is
  unverified on host v24 WebCrypto and may fail after the
  `createPublicKey` half is fixed.
- **L5 — Sync 26 error-message/decoration parity (F2 sync).** Normalize
  sync error text/properties in shim wrappers: decapsulate →
  `Decapsulation failed` (keep code `ERR_CRYPTO_OPERATION_FAILED`);
  argon2 sync/async-init errors → `Argon2 derivation failed`;
  `hkdfSync`/`pbkdf2Sync` failures → message matching
  `/derivation failed/`, code `ERR_OSSL_EVP_UNSUPPORTED`, plus an
  `opensslErrorStack` array carrying the raw OpenSSL line. **Flips 4:**
  `test-crypto-encap-decap.js`, `test-crypto-job-error-parity.js`
  (sync part), `test-crypto-argon2-job.js`, `test-crypto-no-algorithm.js`.
  Conservative floor 3: `no-algorithm` has unreached remainder
  (`setFips(1)` + async `randomBytes` assertions and a `spawnSync`
  child that must abort under `--openssl-config=base_only.cnf`) that
  was never exercised because the test fails first at line 40.
- **L6 — Async job error decoration (F2 async).** Attach
  `code`/`library`/`reason` (+ `opensslErrorStack` where applicable) to
  async callback errors for `sign`/`verify`/`diffieHellman` (and by
  extension the other async crypto jobs), matching the sync-equivalent
  error. Needs a design decision (derive from the sync error vs map
  from the OpenSSL stack); medium-hard. **Flips 2:**
  `test-crypto-async-sign-verify.js`, `test-crypto-dh-stateless.js`.
- **L7 — KeyObject validation + SEC1 normalization (F5).** Validate
  KMAC key length in `toCryptoKey` (`NotSupportedError: Invalid key
  length` for zero-length/overlong keys); re-encode SEC1 exports to
  include the EC parameters OID. **Flips 2:**
  `test-crypto-key-objects-to-crypto-key.js`,
  `test-crypto-key-reuse-concurrent.js`. Conservative floor 1:
  `key-objects-to-crypto-key` has further invalid cases after the KMAC
  one that are unverified on host v24.22.
- **L8 — Getter-proof randomFill (F6).** Stop delegating `randomFill` /
  `randomFillSync` to host native; rewrite `src/crypto/random.js` to
  derive element size from `buf.constructor.BYTES_PER_ELEMENT` and fill
  via `Atomics.store` / `.set()` / `setUint8` without reading the
  instance's `byteLength`/`length`/`BYTES_PER_ELEMENT`/`buffer`/
  `byteOffset` (all five paths probe-verified, §2 F6). **Flips 1:**
  `test-crypto-randomfill-properties.js`.
- **Total: 5 + 3 + 1 + 1 + 4 + 2 + 2 + 1 = 19 flips; conservative floor
  15–16.** The remaining 1 test is NO-FIX (§4).
- Not lanes (no gap test, noted only): `getCipherInfo` arity 2 → 1
  (`test-crypto-getcipherinfo.js` passes); DEP0203/DEP0204 CryptoKey
  deprecation (`test-crypto-dep0203.js`, `test-crypto-dep0204.js` pass);
  `randomUUIDv7` (already exported by `src/crypto.js` from native and
  from `src/crypto/random.js` fallback; no gap test);
  `diffieHellman` direct key data (26.1.0 — the sync paths in
  `test-crypto-dh-stateless.js` pass; only the async error code fails).

## 4. NO-FIX list (1 test)

- **`test-crypto-secure-heap.js` — host-runtime artifact, not a shim gap.**
  Probe evidence: the test `fork()`s children with
  `execArgv: ['--secure-heap=65536'|'--secure-heap=1024',
  '--secure-heap-min=4']` and asserts exit code 0 / signal null. The
  forked children run **without** `--import preload`, i.e. plain host
  Node v24.22.1 with real `node:crypto` — the shim never loads. The
  `workers` child (8 Workers, 1 KiB secure heap) aborts during V8
  isolate setup, before any JS executes:
  `Assertion failed: ncrypto::CSPRNG(buffer, length)` at
  `node::InitializeOncePerProcessInternal …/src/node.cc:1278`, then
  `SIGABRT` (`'SIGABRT' !== null` at `test-crypto-secure-heap.js:112`).
  Native run on Node 26.13.1 exits 0. No shim code can influence a child
  process's V8/OpenSSL secure-heap initialization; the shim's own
  `secureHeapUsed` fallback (zeros) is never exercised by this test.
  Nothing to implement; re-check only if the harness host becomes Node 26.

## 5. Fails-natively (2 tests — NOT shim gaps, excluded from the 20)

- **`test-crypto-provider-cache-snapshot.js`** and
  **`test-crypto-random-cache-snapshot.js`**: both build a V8 snapshot
  (`../common/snapshot` `buildSnapshot`) and fail on real Node 26.13.1
  itself — `Fatal error … CheckGlobalAndEternalHandles failed` in
  `node::SnapshotBuilder::CreateSnapshot` (native30 exit 1, confirmed in
  round-2 re-runs; harness exit 1 the same way). A Node 26.13.1
  snapshot-builder crash in this environment, not a shim behaviour.
  No lane; no flip available from shim work.

## 6. Baseline corrections

- **Round-1 10 s cap artifacts (4 tests, all resolved at 30 s, baseline
  classifications confirmed, no misclassification):**
  `test-crypto-key-reuse-concurrent.js` and
  `test-crypto-mac-vectors.js` showed harness exit 124 at 10 s;
  `test-crypto-provider-cache.js` and `test-crypto-secure-heap.js`
  showed native26 exit 124 at 10 s. At 30 s: harness exit 1 for the
  first two (matching baseline `harnessExit: 1`) and native26 exit 0
  for the latter two (matching baseline `nativeExit: 0`). The tests are
  slow under load (round-1 script averaged ~7 s per invocation), not
  timeouts. All 20 gap + 2 fails-natively classifications in
  `gaps-crypto.json` reproduce exactly at 30 s.
- **`/tmp` wipe mid-task:** the round-1 log (`/tmp/crypto26-rerun.log`)
  disappeared between turns (runtime restart wipes `/tmp`, per
  AGENTS.md). All round-1 findings quoted here were extracted before
  the loss; the disputed tests were re-run in round 2 with the log at
  `~/workspace/crypto26-rerun2.log` (since removed after extraction).
  Lesson recorded: keep re-run logs under `~/workspace/`, never `/tmp`.
- **My first v24-membership check was wrong and is corrected here:** I
  initially tested `hidden_files/node-src/test/parallel/`, which does
  not exist (the pack is `lib/` + `node-v24.20.0.tar.gz` only), and
  reported all 22 as new-in-26. The corrected check (tarball listing +
  `cmp` of extracted files) gives 11 new-in-26 / 11 in-v24-with-changed-
  expectations (§1). The family/lane analysis does not depend on that
  split, but the split itself is now grounded.
- **Drift-research adjudication:** the research called crypto the TOP
  drift module (27 rows). Grounded check: the export diff shows only 3
  added exports (`createMac`, `getMacs`, `parsePKCS12`) + 1 changed
  (`getCipherInfo` arity 2 → 1, no gap test). The 20 gaps are dominated
  by error-decoration/message parity (6), missing export-table entries
  (5), and deprecation mirroring (3) — i.e. the drift is real but
  narrower than "27 rows" suggests; there is no 27-API implementation
  backlog. The changelog cross-check's own caveat ("whether 24.22's new
  APIs also landed in 26 was NOT verified per-item") is now verified
  by probe: `createMac`/`getMacs`/`parsePKCS12`/`randomUUIDv7` all exist
  in Node 26.13.1 — and, decisively for the lanes, also in host
  v24.22.1, which is why L1 is an export-table change, not new crypto.
- **Worktree hygiene:** `parity/node-test/` restored clean after both
  re-run rounds (`git status --porcelain -- parity/node-test` empty);
  the temporary `node_modules` symlink (created for the run-baseline
  preflight, `memfs` resolution) was removed after the re-runs. No
  `src/` changes, no shim code, no `package.json` edits were made in
  this triage (docs only).
