// buffer-shim.js

import * as buffer from 'buffer';

// Core exports from your polyfill
const {
  Buffer,
  SlowBuffer,
  INSPECT_MAX_BYTES,
  kMaxLength,
} = buffer;

// --- Missing pieces (polyfills / fallfalls) ---

// Node-style constants
const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: kMaxLength, // approximation
};

const kStringMaxLength = kMaxLength;

/**
 * Determines the actual byte length of a string or buffer-like object.
 * Mimics Buffer.byteLength() in Node.js.
 * @param {string | ArrayBuffer | ArrayBufferView | Buffer} stringOrBuffer 
 * @param {string} [encoding='utf8'] 
 * @returns {number}
 */
function byteLength(stringOrBuffer, encoding = 'utf8') {
  if (typeof stringOrBuffer === 'string') {
    if (encoding === 'hex') {
      return Math.ceil(stringOrBuffer.length / 2);
    }
    if (encoding === 'base64' || encoding === 'base64url') {
      // Rough approximation or use Buffer if available
      return Buffer.byteLength ? Buffer.byteLength(stringOrBuffer, encoding) : Math.floor((stringOrBuffer.length * 3) / 4);
    }
    // For utf8 and other standard string encodings, TextEncoder handles exact byte length
    return new TextEncoder().encode(stringOrBuffer).length;
  }

  if (Buffer.isBuffer(stringOrBuffer)) {
    return stringOrBuffer.length;
  }

  if (stringOrBuffer instanceof ArrayBuffer) {
    return stringOrBuffer.byteLength;
  }

  if (ArrayBuffer.isView(stringOrBuffer)) {
    return stringOrBuffer.byteLength;
  }

  // Fallback conversion attempt
  return Buffer.from(stringOrBuffer).length;
}

// Attach byteLength directly to the Buffer constructor to mirror Node.js API
if (!Buffer.byteLength) {
  Buffer.byteLength = byteLength;
}

// Encoding helpers (basic approximations)

// Optimized isUtf8 using TextDecoder
function isUtf8(input) {
  if (!input) return true;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  
  try {
    // 'fatal: true' makes it throw on invalid sequences.
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// Optimized isAscii using Regex or TypedArray
function isAscii(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) return false;
  }
  return true;
}

function transcode(source, fromEnc, toEnc) {
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(source, fromEnc);
  const encodedString = buf.toString(toEnc);
  return Buffer.from(encodedString); 
}

// Not really supported outside Node — stub safely
function resolveObjectURL() {
  throw new Error('resolveObjectURL is not implemented in this environment');
}

// Web APIs (use globals if available)
const atobFn = globalThis.atob?.bind(globalThis);
const btoaFn = globalThis.btoa?.bind(globalThis);
const BlobCtor = globalThis.Blob;
const FileCtor = globalThis.File;

// --- Exports ---

export {
  atobFn as atob,
  btoaFn as btoa,
  constants,
  kMaxLength,
  kStringMaxLength,
  BlobCtor as Blob,
  Buffer,
  FileCtor as File,
  SlowBuffer,
  isAscii,
  isUtf8,
  transcode,
  INSPECT_MAX_BYTES,
  resolveObjectURL,
  byteLength,
};

// Default export (must mirror named exports)
export default {
  atob: atobFn,
  btoa: btoaFn,
  constants,
  kMaxLength,
  kStringMaxLength,
  Blob: BlobCtor,
  Buffer,
  File: FileCtor,
  SlowBuffer,
  isAscii,
  isUtf8,
  transcode,
  INSPECT_MAX_BYTES,
  resolveObjectURL,
  byteLength,
};
