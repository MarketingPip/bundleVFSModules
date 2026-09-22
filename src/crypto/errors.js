/*!
 * crypto/errors — Node-style error classes used by the browser fallback of
 * node:crypto. Messages match Node.js v24.20.0 exactly (verified against the
 * real builtin); only the codes/messages asserted by tests are reproduced.
 */

function inspectReceived(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return `type string ('${value}')`;
  if (t === 'number' || t === 'bigint' || t === 'boolean') {
    return `type ${t} (${String(value)})`;
  }
  if (t === 'function') return `function ${value.name || 'anonymous'}`;
  if (t === 'symbol') return `type symbol (${String(value)})`;
  const name = value?.constructor?.name;
  return `an instance of ${name || 'Object'}`;
}

export class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual, customMessage) {
    super(
      customMessage ??
        `The "${name}" argument must be of type ${expected}. ` +
          `Received ${inspectReceived(actual)}`,
    );
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

export class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, actual, customMessage) {
    super(
      customMessage ??
        `The value of "${name}" is out of range. It must be ${range}. ` +
          `Received ${inspectReceived(actual)}`,
    );
    this.code = 'ERR_OUT_OF_RANGE';
  }
}

export class ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH extends RangeError {
  constructor() {
    super('Input buffers must have the same byte length');
    this.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
  }
}

export class ERR_CRYPTO_INVALID_DIGEST extends TypeError {
  constructor(digest) {
    super(`Invalid digest: ${digest}`);
    this.code = 'ERR_CRYPTO_INVALID_DIGEST';
  }
}

export class ERR_OPERATION_FAILED extends Error {
  constructor(operation) {
    super(`Operation failed: ${operation}`);
    this.code = 'ERR_OPERATION_FAILED';
  }
}

/** Clear, honest error for OpenSSL-only APIs in the browser fallback. */
export function unsupportedCrypto(what) {
  return new Error(
    `${what} is not available in this environment: it requires the OpenSSL ` +
      `backing of Node.js. The browser fallback of this module only supports ` +
      `getRandomValues, randomBytes, randomFill(Sync), randomInt, ` +
      `randomUUID(v7), timingSafeEqual, createHash/createHmac (MD5/SHA-1/SHA-2 ` +
      `family), hash, getHashes, webcrypto/subtle and constants.`,
  );
}

/** WebCrypto-style DOMException for getRandomValues validation. */
export function domException(message, name) {
  if (typeof DOMException === 'function') {
    return new DOMException(message, name);
  }
  const err = new Error(message);
  err.name = name;
  return err;
}
