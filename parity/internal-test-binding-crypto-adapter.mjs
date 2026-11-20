// Parity adapter for `require('internal/test/binding')` used by the crypto
// tests (test-crypto-argon2-job.js, L5).
//
// The problem: the test exercises the native Argon2Job directly via
// internalBinding, bypassing the JS layer — so no src/ wrapper can reach
// it. Host v24.22.1's job errors carry the raw OpenSSL line
// ('error:1C8000EA:Provider routines::invalid thread pool size') with no
// code/library/reason/opensslErrorStack, while Node 26.13.1 decorates
// them ('Argon2 derivation failed' + ERR_OSSL_* code + library/reason +
// the raw line in opensslErrorStack — probe-verified, see
// NOTES-26-crypto-l2l8.md).
//
// The adapter merges the two: everything from real Node's
// internal/test/binding, except `internalBinding('crypto')`, which is
// real Node's crypto binding with Argon2Job replaced by a subclass that
// decorates the job error on both paths — the sync [err, result] return
// of run(), and the async ondone callback (wrapped inside run(), before
// the job starts). The decoration itself (decorateOpensslError) is the
// same helper the src/ hkdf/pbkdf2 wrappers use, so the shapes cannot
// drift apart. No behaviour change for any other consumer: the only
// other crypto test requiring internal/test/binding is
// test-crypto-provider-cache.js, whose failure (isKeyAlgorithmAvailable
// missing on the host binding, L1 §4) is unchanged — the adapter passes
// the real binding through for everything except Argon2Job.
//
// Harness-only; src/ behaviour is untouched. The adapter's own require()
// below reaches real Node because the adapter lives under parity/, not
// under parity/node-test/parallel/, so the preload's testsDir-guarded
// redirect does not apply to it. The test runs with --expose-internals,
// so the top-level require cannot throw for it.
import { createRequire } from "node:module";
import { decorateOpensslError } from "../src/crypto/errors.js";

const require = createRequire(import.meta.url);
const real = require("internal/test/binding");
const realInternalBinding = real.internalBinding;

const realCrypto = realInternalBinding("crypto");
const RealArgon2Job = realCrypto.Argon2Job;

class DecoratedArgon2Job extends RealArgon2Job {
  run() {
    // Async path: the test sets job.ondone before run(); wrap it now so
    // the callback receives the decorated error. Sync path: run()
    // returns [err, result] — decorate err in place.
    const origOndone = this.ondone;
    if (
      typeof origOndone === "function" &&
      !origOndone.__argon2Decorated
    ) {
      const wrapped = (err, result) =>
        origOndone(
          decorateOpensslError(err, "Argon2 derivation failed"),
          result,
        );
      wrapped.__argon2Decorated = true;
      this.ondone = wrapped;
    }
    const result = super.run();
    if (Array.isArray(result) && result[0]) {
      result[0] = decorateOpensslError(
        result[0],
        "Argon2 derivation failed",
      );
    }
    return result;
  }
}

const shimCryptoBinding = {
  ...realCrypto,
  Argon2Job: DecoratedArgon2Job,
};

export function internalBinding(name) {
  if (name === "crypto") return shimCryptoBinding;
  return realInternalBinding(name);
}
export const primordials = real.primordials;
export default { internalBinding, primordials };
