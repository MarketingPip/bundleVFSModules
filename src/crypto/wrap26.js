/*!
 * crypto/wrap26 — Node 26 behaviour wrappers for the native bridge.
 *
 * Under the parity harness the shim delegates to host Node v24.22.1, whose
 * crypto predates several Node 26 behaviours. These wrappers sit between
 * the native functions and the shim's exports and reproduce the Node 26
 * semantics that the host lacks — each one grounded in a probe against
 * Node 26.13.1 (see NOTES-26-crypto-l2l8.md for the probe table):
 *
 *  L2  createHash/hash — DEP0198 shake warning (no options.outputLength).
 *  L3  createDecipheriv — GCM/SIV/ChaCha20-Poly1305 setAuthTag must match
 *      the configured tag length (16 by default); host accepts short tags.
 *  L4  createPublicKey — JWK EC coordinates longer than the curve field
 *      (after stripping leading zero bytes) throw ERR_CRYPTO_INVALID_JWK.
 *  L5  decapsulate — sync message 'Failed to perform decapsulation' ->
 *      'Decapsulation failed'; hkdfSync/pbkdf2Sync raw OpenSSL failures ->
 *      '<OP> derivation failed' + ERR_OSSL_EVP_UNSUPPORTED + stack.
 *  L6  sign/verify/diffieHellman/encapsulate/decapsulate (async) — the
 *      callback error is replaced by the sync-equivalent error, which
 *      carries code/library/reason (host async errors have the message
 *      but no decoration; host async decapsulate even has a DIFFERENT
 *      message, 'Deriving bits failed').
 *  L7  createSecretKey — toCryptoKey validates KMAC key length
 *      (NotSupportedError: Invalid key length). subtle.exportKey('pkcs8')
 *      for EC private keys always carries the public point (host
 *      preserves the stored minimal encoding) — see ./subtle-pkcs8.js.
 *      SEC1 export normalization lives in ./sec1.js (prototype patch:
 *      structuredClone/KeyObject.from drop per-instance wrappers).
 *
 * Wrappers only run on the native side; the browser fallbacks keep their
 * own behaviour (they never see host-v24 skew). Every wrapper delegates
 * first and decorates after, so native validation errors still come from
 * the native function unchanged.
 */

import {
  ERR_CRYPTO_INVALID_AUTH_TAG,
  ERR_CRYPTO_INVALID_JWK,
  decorateOpensslError,
  domException,
  parseOpensslErrorLine,
} from "./errors.js";
import { maybeWarnShakeDefault } from "./hashes.js";
import {
  isEcPrivateCryptoKey,
  makeDeriveRawPublic,
  normalizeSubtlePkcs8Export,
} from "./subtle-pkcs8.js";

// ---------------------------------------------------------------------------
// L2 — DEP0198 shake warning
// ---------------------------------------------------------------------------

export function wrapCreateHash(nativeCreateHash) {
  return function createHash(algorithm, options) {
    const result = nativeCreateHash(algorithm, options);
    maybeWarnShakeDefault(algorithm, options);
    return result;
  };
}

export function wrapHash(nativeHash) {
  return function hash(algorithm, data, options) {
    const result = nativeHash(algorithm, data, options);
    maybeWarnShakeDefault(algorithm, options);
    return result;
  };
}

// ---------------------------------------------------------------------------
// L3 — GCM short-tag validation
// ---------------------------------------------------------------------------

// Node 26 (src/crypto/crypto_cipher.cc, SetAuthTag): GCM, SIV and
// ChaCha20-Poly1305 default the tag length to 16 bytes, and setAuthTag
// throws ERR_CRYPTO_INVALID_AUTH_TAG unless the given tag matches the
// configured length exactly. Other modes (CCM, OCB) require an explicit
// authTagLength at creation, so they are out of scope here.
function isDefault16TagCipher(algorithm) {
  const alg = String(algorithm).toLowerCase();
  return (
    alg.includes("gcm") || alg.includes("siv") || alg.includes("poly1305")
  );
}

export function wrapCreateDecipheriv(nativeCreateDecipheriv) {
  return function createDecipheriv(algorithm, key, iv, options) {
    const decipher = nativeCreateDecipheriv(algorithm, key, iv, options);
    // Never READ options.authTagLength here: test-crypto-cipherbase-
    // options-fast-path defines it as a getter and asserts exactly
    // which getters the constructor reads (an extra read breaks the
    // access-order assertion). Walk the prototype chain with
    // getOwnPropertyDescriptor instead — descriptors never invoke
    // getters. Explicit data value → native already validates
    // setAuthTag against it, don't wrap. Accessor (getter) → also
    // don't wrap: native read it during construction and configured
    // the length itself. Absent/undefined → default 16, wrap.
    if (authTagLengthState(options) !== "absent") return decipher;
    if (!isDefault16TagCipher(algorithm)) return decipher;
    const origSetAuthTag = decipher.setAuthTag;
    decipher.setAuthTag = function setAuthTag(tag) {
      const tagLength = ArrayBuffer.isView(tag)
        ? tag.byteLength
        : tag instanceof ArrayBuffer
          ? tag.byteLength
          : undefined;
      if (tagLength !== undefined && tagLength !== 16) {
        throw new ERR_CRYPTO_INVALID_AUTH_TAG(tagLength);
      }
      return origSetAuthTag.call(this, tag);
    };
    return decipher;
  };
}

function authTagLengthState(options) {
  if (options === null || typeof options !== "object") return "absent";
  let obj = options;
  while (obj !== null) {
    const desc = Object.getOwnPropertyDescriptor(obj, "authTagLength");
    if (desc) {
      if ("value" in desc) return desc.value !== undefined ? "explicit" : "absent";
      return "accessor";
    }
    obj = Object.getPrototypeOf(obj);
  }
  return "absent";
}

// ---------------------------------------------------------------------------
// L4 — EC JWK coordinate validation (shared by createPublicKey + subtle)
// ---------------------------------------------------------------------------

const EC_JWK_FIELD_BYTES = {
  "P-256": 32,
  "P-384": 48,
  "P-521": 66,
  secp256k1: 32,
};

function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin =
    typeof atob === "function"
      ? atob(padded)
      : Buffer.from(padded, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function strippedLength(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  return bytes.length - i;
}

/**
 * True when a JWK EC key carries an x/y coordinate that does not fit the
 * curve field: Node 26's decoder rejects coordinates longer than the
 * field size, but still accepts equivalent integer encodings (short
 * values, or values with leading zero bytes, e.g. a 33-byte all-zero x
 * for P-256). Non-EC keys, unknown curves and non-string coordinates
 * return false so the native function reports its own error.
 */
export function jwkEcCoordinatesOversized(jwk) {
  if (!jwk || typeof jwk !== "object" || jwk.kty !== "EC") return false;
  const fieldBytes = EC_JWK_FIELD_BYTES[jwk.crv];
  if (fieldBytes === undefined) return false;
  for (const field of ["x", "y"]) {
    const value = jwk[field];
    if (typeof value !== "string") continue;
    let bytes;
    try {
      bytes = base64urlToBytes(value);
    } catch {
      return false;
    }
    if (strippedLength(bytes) > fieldBytes) return true;
  }
  return false;
}

export function wrapCreatePublicKey(nativeCreatePublicKey) {
  return function createPublicKey(key) {
    if (
      key !== null &&
      typeof key === "object" &&
      key.format === "jwk" &&
      jwkEcCoordinatesOversized(key.key)
    ) {
      throw new ERR_CRYPTO_INVALID_JWK();
    }
    return nativeCreatePublicKey(key);
  };
}

/**
 * Patch the native SubtleCrypto instance in place (L4 + L7): install
 * own-property `importKey` / `exportKey` wrappers and leave the object
 * itself untouched, so `shim.subtle === shim.webcrypto.subtle ===
 * globalThis.crypto.subtle` keeps holding — all three are the same
 * instance (probe-verified), so the patch covers the globalThis path
 * that key-reuse-concurrent reads, in the main thread and in workers
 * (workers inherit the preload and load the shim per thread).
 *
 * importKey: oversized EC JWK coordinates reject with DataError
 * 'Invalid keyData' as a rejected promise (a sync throw escapes
 * assert.rejects). exportKey('pkcs8') for EC private keys is normalized
 * to Node 26's form (public point always included — see
 * ./subtle-pkcs8.js). Every other call delegates to the bound originals.
 * Installed once per module load; the browser fallback never reaches
 * here (no native subtle). Same justification as the SEC1 prototype
 * patch (./sec1.js): the behaviour is Node 26's, the host's is the
 * outlier, and a per-instance wrapper cannot survive the test's
 * structuredClone/KeyObject.from/worker transfers.
 */
let subtlePatched = false;

export function patchSubtle(native) {
  if (subtlePatched) return;
  const nativeSubtle = native?.subtle;
  if (!nativeSubtle || typeof nativeSubtle !== "object") return;
  if (typeof nativeSubtle.importKey !== "function") return;
  if (typeof nativeSubtle.exportKey !== "function") return;
  const origImportKey = nativeSubtle.importKey.bind(nativeSubtle);
  const origExportKey = nativeSubtle.exportKey.bind(nativeSubtle);
  const deriveRawPublic = makeDeriveRawPublic(native);
  nativeSubtle.importKey = function importKey(
    format,
    keyData,
    algorithm,
    extractable,
    keyUsages,
  ) {
    if (format === "jwk" && jwkEcCoordinatesOversized(keyData)) {
      // WebCrypto methods return promises: the rejection must be a
      // rejected promise, not a synchronous throw — assert.rejects
      // only catches the former (a sync throw escapes the call).
      return Promise.reject(domException("Invalid keyData", "DataError"));
    }
    return origImportKey(format, keyData, algorithm, extractable, keyUsages);
  };
  nativeSubtle.exportKey = function exportKey(format, key) {
    if (
      format !== "pkcs8" ||
      !isEcPrivateCryptoKey(key) ||
      typeof deriveRawPublic !== "function"
    ) {
      return origExportKey(format, key);
    }
    return normalizeSubtlePkcs8Export(
      origExportKey(format, key),
      key,
      deriveRawPublic,
    );
  };
  subtlePatched = true;
}

// ---------------------------------------------------------------------------
// L7 — KMAC key-length validation in toCryptoKey
// ---------------------------------------------------------------------------

// Node 26 lib/internal/crypto/util.js validateKmacKeyLength: the length in
// BITS must be >= 32 and a multiple of 8. The WebIDL layer applies it to
// algorithm.length when present, and normalizeKeyLength applies it to the
// key's own bit length otherwise — both surfacing as NotSupportedError
// 'Invalid key length'. The host applies neither (zero-length and
// sub-32-bit KMAC keys are accepted).
//
// Prototype patch, not a per-instance wrapper: a per-instance own
// `toCryptoKey` breaks test-crypto-keyobject-no-own-symbols and
// test-crypto-keyobject-clone-transfer, which assert KeyObjects expose
// NO own properties (Object.getOwnPropertyNames(key) === []). The
// validation needs no per-key state anyway — the algorithm comes from
// the toCryptoKey call's argument, the length from algorithm.length
// or this.symmetricKeySize — so the shared KeyObject.prototype method
// covers every secret key however it was created, cloned, or
// transferred. Only secret keys are checked (a non-secret key with a
// KMAC algorithm delegates to the native error).
let kmacPatched = false;

export function patchKmacToCryptoKey(native) {
  if (kmacPatched) return;
  const proto = native?.KeyObject?.prototype;
  if (!proto || typeof proto.toCryptoKey !== "function") return;
  const origToCryptoKey = proto.toCryptoKey;
  proto.toCryptoKey = function toCryptoKey(algorithm, extractable, keyUsages) {
    const name =
      algorithm !== null && typeof algorithm === "object"
        ? algorithm.name
        : undefined;
    if (
      (name === "KMAC128" || name === "KMAC256") &&
      this?.type === "secret"
    ) {
      const length =
        algorithm.length !== undefined
          ? algorithm.length
          : (this.symmetricKeySize ?? 0) * 8;
      if (
        typeof length !== "number" ||
        length < 32 ||
        length % 8 !== 0
      ) {
        throw domException("Invalid key length", "NotSupportedError");
      }
    }
    return origToCryptoKey.call(this, algorithm, extractable, keyUsages);
  };
  kmacPatched = true;
}

// ---------------------------------------------------------------------------
// L5 — sync error-message / decoration parity
// ---------------------------------------------------------------------------

export function wrapDecapsulateSync(nativeDecapsulate) {
  return function decapsulate(key, ciphertext, callback) {
    if (typeof callback === "function") {
      return nativeDecapsulate(key, ciphertext, callback);
    }
    try {
      return nativeDecapsulate(key, ciphertext);
    } catch (err) {
      // Host v24: 'Failed to perform decapsulation'; Node 26:
      // 'Decapsulation failed' (code ERR_CRYPTO_OPERATION_FAILED is
      // already right on both).
      if (
        err &&
        typeof err === "object" &&
        err.message === "Failed to perform decapsulation"
      ) {
        err.message = "Decapsulation failed";
      }
      throw err;
    }
  };
}

function wrapDerivationSync(nativeFn, opName) {
  return function (...args) {
    try {
      return nativeFn(...args);
    } catch (err) {
      // Node 26 decorates raw OpenSSL derivation failures as
      // '<OP> derivation failed' + ERR_OSSL_EVP_UNSUPPORTED + the raw
      // line in opensslErrorStack (FIPS mode: the digest is unavailable).
      // Validation errors (ERR_CRYPTO_INVALID_DIGEST, INVALID_KEYLEN,
      // ...) already carry a code and a non-OpenSSL message, so
      // decorateOpensslError leaves them untouched.
      if (err && typeof err === "object" && !err.code) {
        decorateOpensslError(err, `${opName} derivation failed`);
      }
      throw err;
    }
  };
}

export function wrapHkdfSync(nativeHkdfSync) {
  return wrapDerivationSync(nativeHkdfSync, "HKDF");
}

export function wrapPbkdf2Sync(nativePbkdf2Sync) {
  return wrapDerivationSync(nativePbkdf2Sync, "PBKDF2");
}

// ---------------------------------------------------------------------------
// L6 — async job error decoration (derive from the sync error)
// ---------------------------------------------------------------------------

/**
 * Wrap an async crypto function (last argument a callback) so callback
 * errors carry the sync-equivalent error: same message, code, library,
 * reason and opensslErrorStack. Host v24 async errors have the message
 * but no decoration — and for decapsulate not even the same message
 * ('Deriving bits failed' vs sync 'Failed to perform decapsulation').
 * `syncFn` is the (already L5-wrapped) sync version of the same
 * operation; it is only invoked on the error path, with the same
 * arguments minus the callback. If the sync re-run unexpectedly
 * succeeds, fall back to decorating the async error from its own
 * OpenSSL line (message unchanged).
 */
export function wrapAsyncWithSyncFallback(nativeAsyncFn, syncFn) {
  return function (...args) {
    const last = args[args.length - 1];
    if (typeof last !== "function") {
      // No callback: sync throws (setup errors) propagate unchanged,
      // exactly as the native async function does.
      return nativeAsyncFn(...args);
    }
    const callback = last;
    const syncArgs = args.slice(0, -1);
    const wrappedCallback = (err, result) => {
      if (!err) {
        callback(null, result);
        return;
      }
      // Error path: call back with EXACTLY one argument. Node's async
      // crypto jobs invoke the callback as callback(err) on failure —
      // test-crypto-pqc-sign-verify-ml-dsa asserts this via
      // common.expectsError (which requires arguments.length === 1),
      // and it passes on Node 26. Passing (err, undefined) breaks it.
      try {
        syncFn(...syncArgs);
        // Sync succeeded where async failed (non-deterministic, e.g.
        // threadpool exhaustion): decorate from the async error's own
        // OpenSSL line if it has one.
        if (!err.code && typeof err.message === "string") {
          const parsed = parseOpensslErrorLine(err.message);
          if (parsed) {
            err.code = parsed.code;
            err.library = parsed.library;
            err.reason = parsed.reason;
            err.opensslErrorStack = [parsed.raw];
          }
        }
        callback(err);
      } catch (syncErr) {
        callback(syncErr);
      }
    };
    return nativeAsyncFn(...syncArgs, wrappedCallback);
  };
}

/** Full decapsulate: L5 sync message normalization + L6 async decoration. */
export function wrapDecapsulate(nativeDecapsulate) {
  const dual = wrapDecapsulateSync(nativeDecapsulate);
  return wrapAsyncWithSyncFallback(
    (key, ciphertext, callback) => dual(key, ciphertext, callback),
    (key, ciphertext) => dual(key, ciphertext),
  );
}

/** Encapsulate: L6 async decoration only (sync errors already carry codes). */
export function wrapEncapsulate(nativeEncapsulate) {
  return wrapAsyncWithSyncFallback(nativeEncapsulate, nativeEncapsulate);
}
