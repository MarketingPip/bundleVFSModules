# Node 26 Wave 2 — CRYPTO lane L2–L8 (NOTES-26-crypto-l2l8.md)

Branch `feat/w2-crypto-l2l8`, base origin/main `b5f2e94f` (stream PR #522
merged after the task's stated base `652333e7`; based on current
origin/main per "own persistent worktree at origin/main").
Banked count (coordinator-verified on live main, this run): **crypto
149/167**. New count = 149 + flips verified 2x on LIVE main − regressions
in the differential (computed at merge time, never from triage).

## Method

- Oracle: Node 26.13.1 binary (`~/workspace/local/node-26/bin/node`) +
  Node 26 src (`~/workspace/local/node-26-src`, lib/ + test/parallel/).
  No fresh web research; probes + repo tree + source pack only.
- Isolated runs: `~/workspace/w2-crypto-l2l8-probes/run-one.mjs` — stages
  the Node 26 test tree into `parity/node-test/`, runs
  `PARITY_TARGET=crypto timeout N node [--flags] --import <abs preload>
  parity/node-test/parallel/<test>`, restores the tree. Logs:
  `logs-r0/` (pre-fix), `logs-r1/` (post-fix round 1), `logs-r1b/`
  (ec-jwk + key-reuse fixes), `logs-r1c/` (key-reuse subtle fix),
  `logs-r2/` (post-fix round 2, [0,0] x2 evidence).
- `test-crypto-argon2-job.js` declares `// Flags:
  --expose-internals --no-warnings` — run-baseline.mjs does NOT honor
  Flags headers, so it was run directly WITH the flags (as above).
- Full guard: `parity/drift/run-baseline.mjs --modules crypto --jobs 2`
  with fresh output filenames (see §Guards).

## Probe table (host v24.22.1 vs Node 26.13.1; scripts in `~/workspace/w2-crypto-l2l8-probes/`)

| # | Fact | Evidence |
|---|------|----------|
| P1 | Shake digests byte-identical; only DEP0198 missing. Defaults shake128 16 B, shake256 32 B. | probe1.mjs |
| P2 | Host accepts 12 B GCM tag (+DEP0182); Node 26 throws `ERR_CRYPTO_INVALID_AUTH_TAG`. | probe1.mjs; `crypto_cipher.cc` SetAuthTag |
| P3 | JWK: host accepts 33 B x, rejects 33 B y; Node 26 rejects both. Rule: strip leading zeroes, reject if remainder > field size (P-256: 32, P-384: 48, P-521: 66, secp256k1: 32). | probe1.mjs |
| P4 | Async errors: same message + opensslErrorStack as Node 26, but NO code/library/reason; sync errors identical (code/library/reason present). Decap async message differs (`Deriving bits failed` vs sync `Failed to perform decapsulation`). | probe1.mjs, probe7.mjs |
| P5 | KMAC toCryptoKey: host accepts 0-length and 3-byte keys; Node 26 throws `NotSupportedError: Invalid key length` (bits must be ≥ 32 and % 8 == 0). | probe1.mjs; `lib/internal/crypto/util.js:724` |
| P6 | FIPS: hkdf/pbkdf2 sync — host raw message only; Node 26 `…derivation failed` + `ERR_OSSL_EVP_UNSUPPORTED` + library/reason/stack. randomBytes async under FIPS asserts only message + stack → passes as-is. | probe6.mjs |
| P7 | Argon2 (CJS `require('internal/test/binding')`, `--expose-internals`): host raw message only; Node 26 `Argon2 derivation failed` + `ERR_OSSL_*` + `Provider routines` + stack, sync and async. ESM import of it does not work; CJS require is the path. | probe6b.cjs |
| P8 | SEC1: host export is usage-history-dependent — PEM key 121 B fresh, 109 B after repeated sign use (run 1 iter 5, reproduced natively, no shim). Node 26 stable (= fresh-import answer: 121 PEM, 51 minimal). Degradation is per-key, not global (fresh import in the same process after 60 signs: 121). | probe5-test.js, probe-sec1.mjs |
| P9 | `KeyObject.prototype` does NOT carry `export` on host v24 — it lives on `PrivateKeyObject.prototype` (instance → PrivateKeyObject → AsymmetricKeyObject → KeyObject), and PrivateKeyObject is not exported from 'crypto'. A prototype patch must reach it via a throwaway generated key. | probe chain walk |
| P10 | Workers DO inherit the `--import` preload when the worker file is under `parity/node-test/parallel/` (shim visible); a worker file in /tmp does not (outside testsDir, no redirect). | probe-worker-preload(2).mjs |
| P11 | subtle.exportKey('pkcs8') of a minimal EC key: host 67 B, Node 26 138 B (public point included) — deterministic, both runtimes, native. KeyObject pkcs8/sec1 (67/51) and KeyObject.from pkcs8/sec1 (67/51) agree on BOTH runtimes. So the divergence is WebCrypto-export-path-only; no key re-encoding can satisfy both the pkcs8 (67) and subtle-pkcs8 (138) assertions. | probe-subtle-pkcs8.mjs, probe-from-pkcs8.mjs |
| P12 | no-algorithm spawn children on host: BOTH abort with SIGABRT at startup (`ncrypto::CSPRNG`). The `base_only.cnf` child is asserted to abort (passes); the `random_unavailable.cnf` child is asserted NOT to abort (fails on host). | probe6.mjs + test :73 |

## Flips (13 of 14; round-1 exit 0, round-2 exit 0 = [0,0] x2)

| Lane | Test | Fix (file) |
|------|------|-----------|
| L2 | test-crypto-default-shake-lengths.js | `src/crypto/hashes.js`: shake128/256 via @noble/hashes, `options.outputLength`, `copy()` resets to default; `src/crypto/wrap26.js`: DEP0198 once-per-process |
| L2 | test-crypto-default-shake-lengths-oneshot.js | same |
| L2 | test-crypto-hash.js | same + DEP0179 is native; null options accepted |
| L3 | test-crypto-gcm-implicit-short-tag.js | `src/crypto/wrap26.js` wrapCreateDecipheriv: setAuthTag throws `ERR_CRYPTO_INVALID_AUTH_TAG` unless tag == configured length (16 default); explicit `authTagLength` untouched |
| L4 | test-crypto-ec-jwk-coordinates.js | `src/crypto/wrap26.js` patchSubtle: createPublicKey wrapper (ERR_CRYPTO_INVALID_JWK) + in-place patch of the shared SubtleCrypto instance's `importKey` (DataError, rejected promise). NOTE: the rejection must be a **rejected promise**, not a throw — assert.rejects only catches the former (found in round 1, fixed in r1b) |
| L5 | test-crypto-encap-decap.js | decapsulate sync message → `Decapsulation failed` (wrap26.js) |
| L5 | test-crypto-job-error-parity.js | L5 (decap/hkdf/pbkdf2 sync) + L6 (async) jointly; scrypt sections native |
| L5 | test-crypto-argon2-job.js | `parity/internal-test-binding-crypto-adapter.mjs` + crypto-gated `internal/test/binding` redirect in `parity/preload.mjs`: DecoratedArgon2Job subclass decorates sync `[err, result]` and async `ondone`; everything else passes through (provider-cache still fails the same way, L1 §4) |
| L5 | test-crypto-no-algorithm.js | **NOT flipped** — see NO-FIX below. FIPS sync parts + base_only child pass; only the random_unavailable child fails |
| L6 | test-crypto-async-sign-verify.js | `wrapAsyncWithSyncFallback`: callback errors replaced by the sync-equivalent error (re-run on the error path only); message-parse fallback if sync unexpectedly succeeds |
| L6 | test-crypto-dh-stateless.js | same (diffieHellman) |
| L7 | test-crypto-key-objects-to-crypto-key.js | per-instance `toCryptoKey` on createSecretKey results validates KMAC length (wrap26.js) |
| L7 | test-crypto-key-reuse-concurrent.js | SEC1 prototype patch (`src/crypto/sec1.js`, PKCS8 round-trip — see P9 for the location fix) + subtle pkcs8 splice (`src/crypto/subtle-pkcs8.js`, installed by patchSubtle in place on the shared SubtleCrypto instance — `require('crypto').subtle === globalThis.crypto.subtle`, so one patch covers both paths, main thread and workers). Splice verified 67 → 138, re-imports identically |
| L8 | test-crypto-randomfill-properties.js | `src/crypto/random.js` getter-proof rewrite; `randomFill(Sync)` never delegate to host native (`src/crypto.js` always-fallback). Direct check 215/215 |

Round-0 first errors (all exit 1 pre-fix): shake tests + hash —
`_expectWarning` (DEP0198 never fired); gcm — `Missing expected
exception`; ec-jwk — `Missing expected exception`; encap-decap —
deepStrictEqual (decap message); job-error-parity — `/Decapsulation
failed/` no match; argon2 — `/Argon2 derivation failed/` no match;
no-algorithm — `/derivation failed/` no match; async-sign-verify,
dh-stateless — assertion on async error decoration; key-objects —
`Missing expected exception (NotSupportedError)`; key-reuse —
`Buffer(109)` vs `Buffer(121)` (run 1 iter 5); randomfill —
`Unexpected BYTES_PER_ELEMENT getter` (:54).

Round-1 exits: 11/14 exit 0; ec-jwk exit 1 (sync-throw bug, fixed r1b →
exit 0); key-reuse exit 1 (SEC1 patch never installed — P9; fixed r1b,
then exit 1 at :125 subtle-pkcs8 — P11; fixed r1c → exit 0);
no-algorithm exit 1 at :73 (NO-FIX remainder). Argon2 exit 0 (flags).

Round-2 exits (final code, logs-r2/): 13/14 exit 0; no-algorithm exit 1
at :73 (NO-FIX remainder, same as round 1). [0,0] x2 confirmed for all
13 flips (round 1: 11 exit 0 + ec-jwk exit 0 in r1b + key-reuse exit 0
in r1c + argon2 exit 0; round 2: all 13 exit 0).

Post-round-2 refactor (subtle Proxy → in-place patchSubtle, harness
wrap removed, repo test updated — see §Design decisions): round 3
(logs-r3/) re-verified the two subtle-dependent tests on the final
code: ec-jwk exit 0, key-reuse exit 0. Jest 16/16 on the final code.

## Design decisions (ponytail)

- L6 derives async decoration from the SYNC-equivalent error (sync
  re-run on the error path only), NOT from message parsing — host async
  decapsulate has a different message from sync, so parsing alone
  cannot fix it; sync errors already carry the exact Node 26
  code/library/reason/message.
- L5 hkdf/pbkdf2: narrow decoration — only codeless raw-OpenSSL-line
  errors are rewritten; validation errors pass through untouched.
- L7 SEC1: prototype patch required (per-instance wrappers die on
  structuredClone/KeyObject.from/worker transfer); round-trip via PKCS8
  because blind "always insert params" would break run 3 (51 B).
  Any round-trip failure falls back to the native result.
- L7 subtle pkcs8: DER splice (not key re-encoding) because the test
  asserts both 67 (KeyObject pkcs8) and 138 (subtle pkcs8) from the
  same key material (P11). Installed in place on the shared
  SubtleCrypto instance by patchSubtle (wrap26.js) — `require('crypto')
  .subtle === webcrypto.subtle === globalThis.crypto.subtle` (probe-
  verified), so one patch covers both paths, main thread and workers,
  with no harness wrap and no Proxy (an earlier Proxy design broke the
  repo's `subtle === webcrypto.subtle` identity test; the in-place
  patch preserves it).
- L8: randomFill(Sync) always use the rewritten fallback; randomBytes /
  getRandomValues stay native-picked.
- Wrappers delegate first, decorate after; native validation errors
  come from the native function unchanged. No new export names; the
  SEC1 patch and subtle patch are the only process-global mutations,
  both scoped to Node 26 semantics.

## NO-FIX with proof

- **test-crypto-no-algorithm.js (remainder):** the `random_unavailable.cnf`
  spawn child aborts with SIGABRT on host v24.22.1 at startup
  (`Assertion failed: ncrypto::CSPRNG(nullptr, 0)`); the test asserts
  it does NOT abort, exits 1, stderr matches `/unable to fetch drbg/`.
  Host-runtime difference, no shim involvement (plain children, no
  preload). The FIPS sync sections (hkdf/pbkdf2 decoration) and the
  `base_only.cnf` child (asserted to abort) pass. L5 lands 3/4.
- **test-crypto-secure-heap.js:** NO-FIX per task (host artifact, shim
  never loads). Untouched.
- **test-crypto-provider-cache-snapshot.js,
  test-crypto-random-cache-snapshot.js:** fail natively on Node 26
  (snapshot-builder crash); not shim gaps. Untouched.

## Guards held

- Full 149-test pass set guarded by `parity/drift/run-baseline.mjs
  --modules crypto --jobs 2`. First guard (`26w2-crypto-guard.jsonc`,
  phase-2 cap 30 s): 154/167 pass, 10 fail, 3 timeout — 7 regressions
  vs the baseline file + key-reuse timeout. Triaged isolated
  (logs-guard/): the 3 timeouts (dh, kem-shared-key, key-reuse) all
  pass at 120 s (slow-test artifacts of the 30 s phase-2 cap); 5 real
  regressions, all repaired (see §Regression repairs) and re-verified
  in round 4 (logs-r4/, all 13 exit 0). Second guard
  (`26w2-crypto-guard2.jsonc`, `--full 120`): **PENDING.**
- Repo tests: `NODE_OPTIONS=--experimental-vm-modules npx --no-install
  jest tests/export_surface_crypto.test.js tests/crypto.test.js` —
  16/16 pass on the final code (after the WRAPPED_EXPORTS test update
  + the regression repairs).

## Regression repairs (guard 1 → round 4)

Guard 1 newly failed 5 baseline-passing tests; all 5 were my
wrappers' side effects, all repaired with no flip lost:

1. `test-crypto-keyobject-no-own-symbols.js`,
   `test-crypto-keyobject-clone-transfer.js` — the per-instance own
   `toCryptoKey` on createSecretKey results broke `assertNoOwnKeys`
   (`Object.getOwnPropertyNames(key) === []`). Fix: KMAC validation
   moved to a `KeyObject.prototype.toCryptoKey` patch
   (`patchKmacToCryptoKey`, wrap26.js) — the check needs no per-key
   state (algorithm from the call argument, length from
   `algorithm.length` or `this.symmetricKeySize`), so the prototype
   covers every secret key, cloned or transferred; createSecretKey
   is plain `pick` again (identity restored).
2. `test-crypto-cipherbase-options-fast-path.js` — my
   `options.authTagLength` read invoked the test's getter, adding an
   extra access to the asserted order. Fix: prototype-chain
   `getOwnPropertyDescriptor` walk (`authTagLengthState`), which
   never invokes getters; explicit data value → don't wrap, accessor
   → don't wrap (native configured it), absent/undefined → wrap.
3. `test-crypto-pqc-sign-verify-ml-dsa.js` — my async wrapper called
   back with `(err, undefined)` on failure; Node calls back with
   exactly one argument (`common.expectsError` requires
   `arguments.length === 1`, passes on Node 26). Fix: error path
   calls `callback(err)` (one arg); success still `(null, result)`.
4. `test-crypto-random.js` — crypto's `ERR_OUT_OF_RANGE` rendered
   `Received type number (NaN)` (the ERR_INVALID_ARG_TYPE format);
   Node renders bare values (`Received NaN`). Fix: separate
   `inspectOutOfRange` renderer for ERR_OUT_OF_RANGE only
   (errors.js); ERR_INVALID_ARG_TYPE keeps `inspectReceived`.

## Files changed

- `src/crypto.js` — wrapPick wiring (createHash, hash,
  createDecipheriv, createPublicKey, createSecretKey, decapsulate,
  encapsulate, sign, verify, diffieHellman, hkdfSync, pbkdf2Sync);
  randomFill(Sync) always-fallback; shake128/256 in
  FALLBACK_HASHES; `patchSec1Export(native)` + `patchSubtle(native)` at
  load; `subtle` stays the native instance by identity.
- `src/crypto/errors.js` — ERR_CRYPTO_INVALID_JWK,
  ERR_CRYPTO_INVALID_AUTH_TAG, OSSL_LIB_PREFIX, parseOpensslErrorLine,
  decorateOpensslError.
- `src/crypto/hashes.js` — shake fallback (@noble/hashes/sha3.js),
  outputLength, copy(), hash() options, DEP0198 emitter, null options.
- `src/crypto/random.js` — getter-proof rewrite (L8).
- `src/crypto/wrap26.js` — all wrappers above + patchSubtle.
- `src/crypto/sec1.js` — NEW: SEC1 prototype patch.
- `src/crypto/subtle-pkcs8.js` — NEW: DER splice + normalizer.
- `parity/preload.mjs` — crypto-gated `internal/test/binding` redirect.
- `parity/internal-test-binding-crypto-adapter.mjs` — NEW: decorated Argon2Job.
- `tests/crypto.test.js` — WRAPPED_EXPORTS allowlist in the identity
  test (14 exports are wrappers/fallback, not native by identity;
  behaviour covered by the differential) + shake128/256 in the
  fallback getHashes expectation. `parity/crypto-harness.mjs`
  unchanged (the in-place subtle patch covers globalThis; no harness
  wrap needed).
