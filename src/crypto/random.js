/*!
 * crypto/random — pure-JS port of Node.js v24.20.0 lib/internal/crypto/random.js
 * for the browser fallback of node:crypto.
 *
 * Entropy comes from the WebCrypto `getRandomValues` when available
 * (browsers, workers, Node) and degrades to a Math.random-based filler only
 * when nothing better exists. Validation and error messages match Node
 * exactly (verified against the real builtin).
 */

import { Buffer } from '../buffer.js';
import {
  ERR_INVALID_ARG_TYPE,
  ERR_OUT_OF_RANGE,
  ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH,
  ERR_OPERATION_FAILED,
  domException,
} from './errors.js';

const kMaxInt32 = 2 ** 31 - 1;
const kMaxPossibleLength = kMaxInt32;

function validateNumber(value, name) {
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
}

function validateFunction(value, name) {
  if (typeof value !== 'function') {
    throw new ERR_INVALID_ARG_TYPE(name, 'function', value);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
  }
}

function validateObject(value, name) {
  if (value === null || typeof value !== 'object') {
    throw new ERR_INVALID_ARG_TYPE(name, 'object', value);
  }
}

function isArrayBufferView(v) {
  return ArrayBuffer.isView(v);
}

function isAnyArrayBuffer(v) {
  return (
    v instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)
  );
}

function isTypedArray(v) {
  return (
    isArrayBufferView(v) &&
    !(v instanceof DataView) &&
    typeof v.BYTES_PER_ELEMENT === 'number'
  );
}

// ---------------------------------------------------------------------------
// Entropy source
// ---------------------------------------------------------------------------

function fillFromWebCrypto(view, offset, size) {
  const g = globalThis.crypto;
  if (!g || typeof g.getRandomValues !== 'function') return false;
  // Browsers cap a single getRandomValues call at 65536 bytes.
  let remaining = size;
  let pos = offset;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 65536);
    const tmp = new Uint8Array(chunk);
    g.getRandomValues(tmp);
    view.set(tmp, pos);
    pos += chunk;
    remaining -= chunk;
  }
  return true;
}

function fillFromMathRandom(view, offset, size) {
  for (let i = 0; i < size; i++) {
    view[offset + i] = (Math.random() * 256) | 0;
  }
}

/** Fill `size` bytes of `view` (a Uint8Array) starting at `offset`. */
function fillRandom(view, offset, size) {
  if (!fillFromWebCrypto(view, offset, size)) {
    fillFromMathRandom(view, offset, size);
  }
}

function assertOffset(offset, elementSize, length) {
  validateNumber(offset, 'offset');
  offset *= elementSize;
  const maxLength = Math.min(length, kMaxPossibleLength);
  if (Number.isNaN(offset) || offset > maxLength || offset < 0) {
    throw new ERR_OUT_OF_RANGE('offset', `>= 0 && <= ${maxLength}`, offset);
  }
  return offset >>> 0;
}

function assertSize(size, elementSize, offset, length) {
  validateNumber(size, 'size');
  size *= elementSize;
  if (Number.isNaN(size) || size > kMaxPossibleLength || size < 0) {
    throw new ERR_OUT_OF_RANGE(
      'size',
      `>= 0 && <= ${kMaxPossibleLength}`,
      size,
    );
  }
  if (size + offset > length) {
    throw new ERR_OUT_OF_RANGE('size + offset', `<= ${length}`, size + offset);
  }
  return size >>> 0;
}

// ---------------------------------------------------------------------------
// randomBytes / randomFill / randomFillSync
// ---------------------------------------------------------------------------

function toUint8(buf) {
  if (isAnyArrayBuffer(buf)) return new Uint8Array(buf);
  return new Uint8Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength,
  );
}

export function randomBytes(size, callback) {
  size = assertSize(size, 1, 0, Infinity);
  if (callback !== undefined) {
    validateFunction(callback, 'callback');
  }

  const buf = Buffer.alloc(size);

  if (callback === undefined) {
    fillRandom(toUint8(buf), 0, size);
    return buf;
  }

  queueMicrotask(() => {
    try {
      fillRandom(toUint8(buf), 0, size);
      callback(null, buf);
    } catch (error) {
      callback(error);
    }
  });
  return undefined;
}

export function randomFillSync(buf, offset = 0, size) {
  if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) {
    throw new ERR_INVALID_ARG_TYPE(
      'buf',
      null,
      buf,
      `The "buf" argument must be an instance of ArrayBuffer or ArrayBufferView. ` +
        `Received ${typeof buf === 'string' ? `type string ('${buf}')` : String(buf)}`,
    );
  }

  const elementSize = buf.BYTES_PER_ELEMENT || 1;
  offset = assertOffset(offset, elementSize, buf.byteLength);

  if (size === undefined) {
    size = buf.byteLength - offset;
  } else {
    size = assertSize(size, elementSize, offset, buf.byteLength);
  }

  if (size === 0) return buf;

  fillRandom(toUint8(buf), offset, size);
  return buf;
}

export function randomFill(buf, offset, size, callback) {
  if (!isAnyArrayBuffer(buf) && !isArrayBufferView(buf)) {
    throw new ERR_INVALID_ARG_TYPE('buf', 'ArrayBuffer or ArrayBufferView', buf);
  }

  const elementSize = buf.BYTES_PER_ELEMENT || 1;

  if (typeof offset === 'function') {
    callback = offset;
    offset = 0;
    size = buf.length;
  } else if (typeof size === 'function') {
    callback = size;
    size = buf.length - offset;
  } else {
    validateFunction(callback, 'callback');
  }

  offset = assertOffset(offset, elementSize, buf.byteLength);

  if (size === undefined) {
    size = buf.byteLength - offset;
  } else {
    size = assertSize(size, elementSize, offset, buf.byteLength);
  }

  if (size === 0) {
    queueMicrotask(() => callback(null, buf));
    return;
  }

  queueMicrotask(() => {
    try {
      fillRandom(toUint8(buf), offset, size);
      callback(null, buf);
    } catch (error) {
      callback(error);
    }
  });
}

// ---------------------------------------------------------------------------
// randomInt
// ---------------------------------------------------------------------------

const RAND_MAX = 0xffff_ffff_ffff;
const randomCache = new Uint8Array(6 * 1024);
let randomCacheOffset = randomCache.length;

function readUInt48BE(buf, offset) {
  // 6 bytes fit safely in a double.
  return (
    buf[offset] * 0x10000000000 +
    buf[offset + 1] * 0x100000000 +
    buf[offset + 2] * 0x1000000 +
    (buf[offset + 3] << 16) +
    (buf[offset + 4] << 8) +
    buf[offset + 5]
  );
}

export function randomInt(min, max, callback) {
  const minNotSpecified =
    typeof max === 'undefined' || typeof max === 'function';

  if (minNotSpecified) {
    callback = max;
    max = min;
    min = 0;
  }

  const isSync = typeof callback === 'undefined';
  if (!isSync) {
    validateFunction(callback, 'callback');
  }
  if (!Number.isSafeInteger(min)) {
    throw new ERR_INVALID_ARG_TYPE(
      'min',
      null,
      min,
      `The "min" argument must be a safe integer. Received ${describeNotSafeInteger(min)}`,
    );
  }
  if (!Number.isSafeInteger(max)) {
    throw new ERR_INVALID_ARG_TYPE(
      'max',
      null,
      max,
      `The "max" argument must be a safe integer. Received ${describeNotSafeInteger(max)}`,
    );
  }
  if (max <= min) {
    throw new ERR_OUT_OF_RANGE(
      'max',
      `greater than the value of "min" (${min})`,
      max,
    );
  }

  const range = max - min;
  if (!(range <= RAND_MAX)) {
    throw new ERR_OUT_OF_RANGE(
      `max${minNotSpecified ? '' : ' - min'}`,
      `<= ${RAND_MAX}`,
      range,
    );
  }

  const randLimit = RAND_MAX - (RAND_MAX % range);

  const draw = () => {
    while (true) {
      if (randomCacheOffset === randomCache.length) {
        fillRandom(randomCache, 0, randomCache.length);
        randomCacheOffset = 0;
      }
      const x = readUInt48BE(randomCache, randomCacheOffset);
      randomCacheOffset += 6;
      if (x < randLimit) return (x % range) + min;
    }
  };

  if (isSync) return draw();
  queueMicrotask(() => {
    try {
      callback(undefined, draw());
    } catch (error) {
      callback(error);
    }
  });
  return undefined;
}

function describeNotSafeInteger(v) {
  if (typeof v === 'bigint') return `type bigint (${v}n)`;
  if (typeof v === 'number') return `type number (${String(v)})`;
  if (typeof v === 'string') return `type string ('${v}')`;
  return `type ${typeof v}`;
}

// ---------------------------------------------------------------------------
// getRandomValues (WebCrypto-compatible)
// ---------------------------------------------------------------------------

export function getRandomValues(data) {
  if (
    !isTypedArray(data) ||
    data instanceof Float16Array ||
    data instanceof Float32Array ||
    data instanceof Float64Array
  ) {
    throw domException(
      'The data argument must be an integer-type TypedArray',
      'TypeMismatchError',
    );
  }
  if (data.byteLength > 65536) {
    throw domException(
      'The requested length exceeds 65,536 bytes',
      'QuotaExceededError',
    );
  }
  randomFillSync(data, 0);
  return data;
}

// ---------------------------------------------------------------------------
// randomUUID / randomUUIDv7 (RFC 4122)
// ---------------------------------------------------------------------------

const kBatchSize = 128;
let uuidData;
let uuidNotBuffered;
let uuidBatch = 0;

const hexBytesCache = new Array(256);
for (let i = 0; i < 256; i++) {
  hexBytesCache[i] = i.toString(16).padStart(2, '0');
}

function serializeUUID(buf, version, variant, offset = 0) {
  return (
    hexBytesCache[buf[offset]] +
    hexBytesCache[buf[offset + 1]] +
    hexBytesCache[buf[offset + 2]] +
    hexBytesCache[buf[offset + 3]] +
    '-' +
    hexBytesCache[buf[offset + 4]] +
    hexBytesCache[buf[offset + 5]] +
    '-' +
    hexBytesCache[(buf[offset + 6] & 0x0f) | version] +
    hexBytesCache[buf[offset + 7]] +
    '-' +
    hexBytesCache[(buf[offset + 8] & 0x3f) | variant] +
    hexBytesCache[buf[offset + 9]] +
    '-' +
    hexBytesCache[buf[offset + 10]] +
    hexBytesCache[buf[offset + 11]] +
    hexBytesCache[buf[offset + 12]] +
    hexBytesCache[buf[offset + 13]] +
    hexBytesCache[buf[offset + 14]] +
    hexBytesCache[buf[offset + 15]]
  );
}

function getBufferedUUID() {
  uuidData ??= new Uint8Array(16 * kBatchSize);
  if (uuidData === undefined) throw new ERR_OPERATION_FAILED('Out of memory');
  if (uuidBatch === 0) fillRandom(uuidData, 0, uuidData.length);
  uuidBatch = (uuidBatch + 1) % kBatchSize;
  return serializeUUID(uuidData, 0x40, 0x80, uuidBatch * 16);
}

function getUnbufferedUUID() {
  uuidNotBuffered ??= new Uint8Array(16);
  if (uuidNotBuffered === undefined) {
    throw new ERR_OPERATION_FAILED('Out of memory');
  }
  fillRandom(uuidNotBuffered, 0, 16);
  return serializeUUID(uuidNotBuffered, 0x40, 0x80);
}

export function randomUUID(options) {
  if (options !== undefined) validateObject(options, 'options');
  const { disableEntropyCache = false } = options || {};
  validateBoolean(disableEntropyCache, 'options.disableEntropyCache');
  return disableEntropyCache ? getUnbufferedUUID() : getBufferedUUID();
}

function writeTimestamp(buf, offset) {
  const now = Date.now();
  const msb = now / 2 ** 32;
  buf[offset] = msb >>> 8;
  buf[offset + 1] = msb;
  buf[offset + 2] = now >>> 24;
  buf[offset + 3] = now >>> 16;
  buf[offset + 4] = now >>> 8;
  buf[offset + 5] = now;
}

function getBufferedUUIDv7() {
  uuidData ??= new Uint8Array(16 * kBatchSize);
  if (uuidData === undefined) throw new ERR_OPERATION_FAILED('Out of memory');
  if (uuidBatch === 0) fillRandom(uuidData, 0, uuidData.length);
  uuidBatch = (uuidBatch + 1) % kBatchSize;
  const offset = uuidBatch * 16;
  writeTimestamp(uuidData, offset);
  return serializeUUID(uuidData, 0x70, 0x80, offset);
}

function getUnbufferedUUIDv7() {
  uuidNotBuffered ??= new Uint8Array(16);
  if (uuidNotBuffered === undefined) {
    throw new ERR_OPERATION_FAILED('Out of memory');
  }
  fillRandom(uuidNotBuffered, 6, 10);
  writeTimestamp(uuidNotBuffered, 0);
  return serializeUUID(uuidNotBuffered, 0x70, 0x80);
}

export function randomUUIDv7(options) {
  if (options !== undefined) validateObject(options, 'options');
  const { disableEntropyCache = false } = options || {};
  validateBoolean(disableEntropyCache, 'options.disableEntropyCache');
  return disableEntropyCache ? getUnbufferedUUIDv7() : getBufferedUUIDv7();
}

// ---------------------------------------------------------------------------
// timingSafeEqual (constant-time compare)
// ---------------------------------------------------------------------------

export function timingSafeEqual(a, b) {
  const aOk = isAnyArrayBuffer(a) || isArrayBufferView(a);
  if (!aOk) {
    throw new ERR_INVALID_ARG_TYPE(
      'buf1',
      null,
      a,
      'The "buf1" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.',
    );
  }
  const bOk = isAnyArrayBuffer(b) || isArrayBufferView(b);
  if (!bOk) {
    throw new ERR_INVALID_ARG_TYPE(
      'buf2',
      null,
      b,
      'The "buf2" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.',
    );
  }
  const va = toUint8(a);
  const vb = toUint8(b);
  if (va.byteLength !== vb.byteLength) {
    throw new ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH();
  }
  let diff = 0;
  for (let i = 0; i < va.byteLength; i++) {
    diff |= va[i] ^ vb[i];
  }
  return diff === 0;
}
