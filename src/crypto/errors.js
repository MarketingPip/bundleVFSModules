/*!
 * crypto/errors — Node-style error classes used by the browser fallback of
 * node:crypto. Messages match Node.js v24.20.0 exactly (verified against the
 * real builtin); only the codes/messages asserted by tests are reproduced.
 */

function inspectReceived(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return `type string ('${value}')`;
  if (t === "number" || t === "bigint" || t === "boolean") {
    return `type ${t} (${String(value)})`;
  }
  if (t === "function") return `function ${value.name || "anonymous"}`;
  if (t === "symbol") return `type symbol (${String(value)})`;
  const name = value?.constructor?.name;
  return `an instance of ${name || "Object"}`;
}

export class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual, customMessage) {
    super(
      customMessage ??
        `The "${name}" argument must be of type ${expected}. ` +
          `Received ${inspectReceived(actual)}`,
    );
    this.code = "ERR_INVALID_ARG_TYPE";
  }
}

export class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, actual, customMessage) {
    super(
      customMessage ??
        `The value of "${name}" is out of range. It must be ${range}. ` +
          `Received ${inspectOutOfRange(actual)}`,
    );
    this.code = "ERR_OUT_OF_RANGE";
  }
}

// Node's ERR_OUT_OF_RANGE renders the value with util.inspect — numbers
// bare (NaN, 5), strings single-quoted — NOT the `type X (...)` form
// ERR_INVALID_ARG_TYPE uses (inspectReceived above). The two errors
// have different formats; sharing the renderer broke
// test-crypto-random.js, which expects `Received NaN`, not
// `Received type number (NaN)`.
function inspectOutOfRange(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return `'${value}'`;
  if (t === "bigint") return `${value}n`;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "symbol") return String(value);
  if (t === "function") return `[Function: ${value.name || "anonymous"}]`;
  const name = value?.constructor?.name;
  return name && name !== "Object" ? `[${name}]` : "[Object]";
}

export class ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH extends RangeError {
  constructor() {
    super("Input buffers must have the same byte length");
    this.code = "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH";
  }
}

export class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason = "is invalid") {
    const inspected =
      typeof value === "string" ? `'${value}'` : inspectReceived(value);
    const type = name.includes(".") ? "property" : "argument";
    super(`The ${type} '${name}' ${reason}. Received ${inspected}`);
    this.code = "ERR_INVALID_ARG_VALUE";
  }
}

export class ERR_CRYPTO_INVALID_DIGEST extends TypeError {
  constructor(digest) {
    super(`Invalid digest: ${digest}`);
    this.code = "ERR_CRYPTO_INVALID_DIGEST";
  }
}

export class ERR_CRYPTO_INVALID_MAC extends TypeError {
  constructor(algorithm) {
    super(`Invalid MAC: ${algorithm}`);
    this.code = "ERR_CRYPTO_INVALID_MAC";
  }
}

export class ERR_CRYPTO_MAC_FINALIZED extends Error {
  constructor() {
    super("MAC already finalized");
    this.code = "ERR_CRYPTO_MAC_FINALIZED";
  }
}

// OpenSSL-flavoured validation codes raised by the Mac fallback where Node
// reports the provider error directly (short message; the full OpenSSL
// error stack only exists under the native bridge).
export class ERR_OSSL_INVALID_KEY_LENGTH extends Error {
  constructor() {
    super("Invalid key length");
    this.code = "ERR_OSSL_INVALID_KEY_LENGTH";
  }
}

export class ERR_OSSL_INVALID_SALT_LENGTH extends Error {
  constructor() {
    super("Invalid salt length");
    this.code = "ERR_OSSL_INVALID_SALT_LENGTH";
  }
}

export class ERR_OSSL_NOT_XOF_OR_INVALID_LENGTH extends Error {
  constructor() {
    super("not xof or invalid length");
    this.code = "ERR_OSSL_NOT_XOF_OR_INVALID_LENGTH";
  }
}

export class ERR_CRYPTO_INVALID_JWK extends TypeError {
  constructor() {
    super("Invalid JWK EC key");
    this.code = "ERR_CRYPTO_INVALID_JWK";
  }
}

export class ERR_CRYPTO_INVALID_AUTH_TAG extends TypeError {
  constructor(length) {
    super(`Invalid authentication tag length: ${length}`);
    this.code = "ERR_CRYPTO_INVALID_AUTH_TAG";
  }
}

// ---------------------------------------------------------------------------
// OpenSSL error decoration (Node 26 parity).
//
// Host Node v24's crypto jobs surface raw OpenSSL lines
// ("error:0308010C:digital envelope routines::unsupported") with no
// code/library/reason/opensslErrorStack, while Node 26 decorates them
// (CryptoErrorStore): a friendly message, an ERR_OSSL_* code, the
// library/reason pair, and the raw line in opensslErrorStack. The code is
// ERR_OSSL_<LIB>_<REASON> with LIB from the probe-grounded map below
// ('digital envelope routines' -> EVP, 'rsa routines' -> RSA) and no LIB
// prefix for other libraries ('Provider routines', 'DECODER routines'
// both yield the bare reason — verified against Node 26.13.1 and host
// v24.22.1 probes, see NOTES-26-crypto-l2l8.md).
// ---------------------------------------------------------------------------

const OSSL_LIB_PREFIX = {
  "digital envelope routines": "EVP",
  "rsa routines": "RSA",
};

export function parseOpensslErrorLine(message) {
  if (typeof message !== "string") return null;
  const m = /^error:[0-9A-Fa-f]+:(.+)::(.+)$/.exec(message);
  if (!m) return null;
  const library = m[1];
  const reason = m[2];
  const reasonSnake = reason
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefix = OSSL_LIB_PREFIX[library];
  const code =
    "ERR_OSSL_" +
    (prefix === undefined || prefix === "" ? "" : prefix + "_") +
    reasonSnake;
  return { library, reason, code, raw: message };
}

/**
 * Rewrite a raw-OpenSSL-line error in place to its Node 26 decorated
 * shape: friendly message, ERR_OSSL_* code, library/reason, and an
 * opensslErrorStack carrying the raw line. Returns the error unchanged
 * when its message is not a raw OpenSSL line (validation errors with a
 * code already set pass through untouched).
 */
export function decorateOpensslError(err, friendlyMessage) {
  if (!err || typeof err !== "object" || typeof err.message !== "string") {
    return err;
  }
  const parsed = parseOpensslErrorLine(err.message);
  if (!parsed) return err;
  err.message = friendlyMessage;
  err.code = parsed.code;
  err.library = parsed.library;
  err.reason = parsed.reason;
  err.opensslErrorStack = [parsed.raw];
  return err;
}

export class ERR_OPERATION_FAILED extends Error {
  constructor(operation) {
    super(`Operation failed: ${operation}`);
    this.code = "ERR_OPERATION_FAILED";
  }
}

/** Clear, honest error for OpenSSL-only APIs in the browser fallback. */
export function unsupportedCrypto(what) {
  return new Error(
    `${what} is not available in this environment: it requires the OpenSSL ` +
      `backing of Node.js. The browser fallback of this module only supports ` +
      `getRandomValues, randomBytes, randomFill(Sync), randomInt, ` +
      `randomUUID(v7), timingSafeEqual, createHash/createHmac (MD5/SHA-1/SHA-2 ` +
      `family), createMac (hmac/kmac/blake2mac), hash, getHashes, getMacs, ` +
      `webcrypto/subtle and constants.`,
  );
}

/** WebCrypto-style DOMException for getRandomValues validation. */
export function domException(message, name) {
  if (typeof DOMException === "function") {
    return new DOMException(message, name);
  }
  const err = new Error(message);
  err.name = name;
  return err;
}
