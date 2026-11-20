/*!
 * crypto/mac — createMac / getMacs browser fallback, backed by the
 * already-installed @noble/hashes library (same primitive source as
 * crypto/hashes.js). Mirrors Node.js v26.13.0 `lib/internal/crypto/
 * provider_mac.js` validation order and error codes where the fallback can
 * know them (ERR_INVALID_ARG_TYPE / ERR_INVALID_ARG_VALUE /
 * ERR_OUT_OF_RANGE / ERR_CRYPTO_INVALID_MAC / ERR_CRYPTO_MAC_FINALIZED,
 * plus the OpenSSL key/salt/length codes for kmac/blake2 bounds).
 *
 * Supported in the browser: hmac (any digest in hashes.js), kmac128 /
 * kmac256 (+ hyphenated aliases), blake2bmac / blake2smac. Node option
 * names map onto noble option names: `customization` -> `personalization`
 * (KMAC), `salt` -> `salt` (BLAKE2, zero-padded when short, as OpenSSL
 * does); `outputLength` -> noble `dkLen` with Node's defaults (kmac128 32,
 * kmac256 64, blake2bmac 64, blake2smac 32).
 *
 * Honest gaps (ponytail: no in-tree primitive, no new dep verified to
 * survive esbuild platform:browser — @noble/ciphers is NOT installed):
 * cmac / gmac / poly1305 / siphash throw unsupportedCrypto naming the
 * missing OpenSSL backing, exactly like the other OpenSSL-only exports in
 * src/crypto.js. `parsePKCS12` has no fallback for the same reason (no
 * in-tree ASN.1/PBE/KDF path).
 *
 * Ceiling / upgrade path: a verified @noble/ciphers (or equivalent)
 * dependency would unlock cmac/gmac/poly1305; siphash needs a small
 * dedicated primitive. Until then the fallback `getMacs()` lists only
 * what it implements — same pattern as getCiphers() -> [] and
 * getHashes() -> FALLBACK_HASHES.
 */

import { Buffer } from "../buffer.js";
import { Transform } from "../stream.js";
import {
  createHmac as _createHmac,
  encodeDigest,
  toBytes,
} from "./hashes.js";
import { blake2b, blake2s } from "@noble/hashes/blake2.js";
import { kmac128, kmac256 } from "@noble/hashes/sha3-addons.js";
import {
  ERR_CRYPTO_INVALID_MAC,
  ERR_CRYPTO_MAC_FINALIZED,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_OSSL_INVALID_KEY_LENGTH,
  ERR_OSSL_INVALID_SALT_LENGTH,
  ERR_OSSL_NOT_XOF_OR_INVALID_LENGTH,
  ERR_OUT_OF_RANGE,
  unsupportedCrypto,
} from "./errors.js";

// Fallback-implemented MACs, sorted like Node's getMacs() list.
const FALLBACK_MACS = Object.freeze([
  "blake2bmac",
  "blake2smac",
  "hmac",
  "kmac-128",
  "kmac-256",
  "kmac128",
  "kmac256",
]);

const UNSUPPORTED_MACS = new Set(["cmac", "gmac", "poly1305", "siphash"]);
const KNOWN_MACS = new Set([...FALLBACK_MACS, ...UNSUPPORTED_MACS]);

// Encodings Node accepts for Mac update()/final() (normalizeEncoding).
const ENCODINGS = new Set([
  "utf8",
  "utf-8",
  "ascii",
  "latin1",
  "binary",
  "base64",
  "base64url",
  "hex",
  "ucs2",
  "ucs-2",
  "utf16le",
  "utf-16le",
]);

/** Fresh copy per call, like Node (provider-cache test asserts this). */
export function getMacs() {
  return [...FALLBACK_MACS];
}

function validateName(value, name) {
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }
  if (value.length === 0 || value.includes("\0")) {
    throw new ERR_INVALID_ARG_VALUE(
      name,
      value,
      "must be non-empty and contain no NUL bytes",
    );
  }
  return value;
}

function normalizeBytesOption(value, name) {
  if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
    throw new ERR_INVALID_ARG_TYPE(
      name,
      "an instance of ArrayBuffer, Buffer, TypedArray, or DataView",
      value,
    );
  }
  return toBytes(value);
}

function validateUint32(value, name) {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new ERR_OUT_OF_RANGE(
      name,
      "an integer between 0 and 4294967295",
      value,
    );
  }
  return value;
}

function parseOptions(options) {
  const spec = {
    digest: undefined,
    cipher: undefined,
    iv: undefined,
    customization: undefined,
    salt: undefined,
    outputLength: undefined,
  };
  if (options === undefined) return spec;
  if (options === null || typeof options !== "object") {
    throw new ERR_INVALID_ARG_TYPE("options", "object", options);
  }
  if (options.digest !== undefined) {
    spec.digest = validateName(options.digest, "options.digest");
  }
  if (options.cipher !== undefined) {
    spec.cipher = validateName(options.cipher, "options.cipher");
  }
  if (options.iv !== undefined) {
    spec.iv = normalizeBytesOption(options.iv, "options.iv");
  }
  if (options.customization !== undefined) {
    spec.customization = normalizeBytesOption(
      options.customization,
      "options.customization",
    );
  }
  if (options.salt !== undefined) {
    spec.salt = normalizeBytesOption(options.salt, "options.salt");
  }
  if (options.outputLength !== undefined) {
    spec.outputLength = validateUint32(
      options.outputLength,
      "options.outputLength",
    );
  }
  return spec;
}

function normalizeKey(key) {
  if (!ArrayBuffer.isView(key) && !(key instanceof ArrayBuffer)) {
    throw new ERR_INVALID_ARG_TYPE(
      "key",
      "an instance of ArrayBuffer, Buffer, TypedArray, DataView, or KeyObject",
      key,
    );
  }
  return toBytes(key);
}

// OpenSSL accepts a short BLAKE2 salt and zero-pads it; a salt longer
// than the parameter size is rejected.
function normalizeSalt(salt, fullLength) {
  if (salt === undefined || salt.length === 0) return undefined;
  if (salt.length > fullLength) {
    throw new ERR_OSSL_INVALID_SALT_LENGTH();
  }
  if (salt.length === fullLength) return salt;
  const padded = new Uint8Array(fullLength);
  padded.set(salt);
  return padded;
}

function checkBlake2Key(keyBytes, maxLength) {
  if (keyBytes.length === 0 || keyBytes.length > maxLength) {
    throw new ERR_OSSL_INVALID_KEY_LENGTH();
  }
}

function checkBlake2OutputLength(outputLength, maxLength) {
  if (outputLength < 1 || outputLength > maxLength) {
    throw new ERR_OSSL_NOT_XOF_OR_INVALID_LENGTH();
  }
}

// Every engine exposes update(Uint8Array) / digest() -> Buffer.
function buildEngine(name, keyBytes, spec) {
  switch (name) {
    case "hmac": {
      if (spec.digest === undefined) {
        throw new ERR_INVALID_ARG_VALUE(
          "options.digest",
          undefined,
          "is required for HMAC",
        );
      }
      if (spec.outputLength !== undefined) {
        throw new ERR_INVALID_ARG_VALUE(
          "options.outputLength",
          spec.outputLength,
          "is not supported by MAC hmac",
        );
      }
      // Unknown digest -> ERR_CRYPTO_INVALID_DIGEST from hashes.js, the
      // same fallback code createHmac already raises (Node raises the
      // OpenSSL ERR_OSSL_EVP_UNSUPPORTED there; only the native bridge
      // can produce that).
      const h = _createHmac(spec.digest, keyBytes);
      return {
        update: (bytes) => {
          h.update(bytes);
        },
        digest: () => Buffer.from(h.digest()),
      };
    }
    case "kmac128":
    case "kmac-128": {
      if (keyBytes.length === 0) throw new ERR_OSSL_INVALID_KEY_LENGTH();
      const state = kmac128.create(keyBytes, {
        dkLen: spec.outputLength ?? 32,
        personalization: spec.customization,
      });
      return {
        update: (bytes) => {
          state.update(bytes);
        },
        digest: () => Buffer.from(state.digest()),
      };
    }
    case "kmac256":
    case "kmac-256": {
      if (keyBytes.length === 0) throw new ERR_OSSL_INVALID_KEY_LENGTH();
      const state = kmac256.create(keyBytes, {
        dkLen: spec.outputLength ?? 64,
        personalization: spec.customization,
      });
      return {
        update: (bytes) => {
          state.update(bytes);
        },
        digest: () => Buffer.from(state.digest()),
      };
    }
    case "blake2bmac": {
      checkBlake2Key(keyBytes, 64);
      const dkLen = spec.outputLength ?? 64;
      checkBlake2OutputLength(dkLen, 64);
      const state = blake2b.create({
        dkLen,
        key: keyBytes,
        salt: normalizeSalt(spec.salt, 16),
      });
      return {
        update: (bytes) => {
          state.update(bytes);
        },
        digest: () => Buffer.from(state.digest()),
      };
    }
    case "blake2smac": {
      checkBlake2Key(keyBytes, 32);
      const dkLen = spec.outputLength ?? 32;
      checkBlake2OutputLength(dkLen, 32);
      const state = blake2s.create({
        dkLen,
        key: keyBytes,
        salt: normalizeSalt(spec.salt, 8),
      });
      return {
        update: (bytes) => {
          state.update(bytes);
        },
        digest: () => Buffer.from(state.digest()),
      };
    }
    case "cmac": {
      if (spec.cipher === undefined) {
        throw new ERR_INVALID_ARG_VALUE(
          "options.cipher",
          undefined,
          "is required for CMAC",
        );
      }
      throw unsupportedCrypto("createMac('cmac')");
    }
    case "gmac": {
      if (spec.iv === undefined || spec.iv.length === 0) {
        throw new ERR_INVALID_ARG_VALUE(
          "options.iv",
          spec.iv,
          "must be non-empty for GMAC",
        );
      }
      throw unsupportedCrypto("createMac('gmac')");
    }
    case "poly1305":
    case "siphash":
      throw unsupportedCrypto(`createMac('${name}')`);
    default:
      throw new ERR_CRYPTO_INVALID_MAC(name);
  }
}

class Mac extends Transform {
  constructor(algorithm, key, options) {
    super(options);
    const name = validateName(algorithm, "algorithm");
    const spec = parseOptions(options);
    const keyBytes = normalizeKey(key);
    const lower = name.toLowerCase();
    if (!KNOWN_MACS.has(lower)) {
      throw new ERR_CRYPTO_INVALID_MAC(name);
    }
    this._engine = buildEngine(lower, keyBytes, spec);
    this._finalized = false;
  }

  _updateBytes(bytes) {
    try {
      this._engine.update(bytes);
    } catch (err) {
      this._finalized = true;
      throw err;
    }
  }

  _finalize() {
    this._finalized = true;
    return this._engine.digest();
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.update(chunk);
    } catch (err) {
      callback(err);
      return;
    }
    callback();
  }

  _flush(callback) {
    if (this._finalized) {
      callback(new ERR_CRYPTO_MAC_FINALIZED());
      return;
    }
    let result;
    try {
      result = this._finalize();
    } catch (err) {
      callback(err);
      return;
    }
    if (result.length !== 0) this.push(result);
    callback();
  }

  update(data, inputEncoding) {
    if (this._finalized) throw new ERR_CRYPTO_MAC_FINALIZED();
    let bytes;
    if (typeof data === "string") {
      if (inputEncoding !== undefined) {
        if (typeof inputEncoding !== "string") {
          throw new ERR_INVALID_ARG_TYPE(
            "inputEncoding",
            "string",
            inputEncoding,
          );
        }
        if (!ENCODINGS.has(inputEncoding.toLowerCase())) {
          throw new ERR_INVALID_ARG_VALUE("inputEncoding", inputEncoding);
        }
      }
      // hashes.js toBytes predates the 'ucs-2' spelling; normalize it.
      const enc =
        inputEncoding !== undefined &&
        inputEncoding.toLowerCase() === "ucs-2"
          ? "ucs2"
          : inputEncoding;
      bytes = toBytes(data, enc);
    } else if (ArrayBuffer.isView(data)) {
      bytes = toBytes(data);
    } else {
      throw new ERR_INVALID_ARG_TYPE(
        "data",
        "string or an instance of Buffer, TypedArray, or DataView",
        data,
      );
    }
    this._updateBytes(bytes);
    return this;
  }

  final(outputEncoding) {
    if (this._finalized) throw new ERR_CRYPTO_MAC_FINALIZED();
    if (outputEncoding !== undefined) {
      if (typeof outputEncoding !== "string") {
        throw new ERR_INVALID_ARG_TYPE(
          "outputEncoding",
          "string",
          outputEncoding,
        );
      }
      if (outputEncoding.toLowerCase() !== "buffer" &&
          !ENCODINGS.has(outputEncoding.toLowerCase())) {
        throw new ERR_INVALID_ARG_VALUE("outputEncoding", outputEncoding);
      }
    }
    const bytes = this._finalize();
    if (
      outputEncoding === undefined ||
      outputEncoding.toLowerCase() === "buffer"
    ) {
      return bytes;
    }
    return encodeDigest(bytes, outputEncoding);
  }
}

export function createMac(algorithm, key, options) {
  return new Mac(algorithm, key, options);
}
