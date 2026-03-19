// buffer-shim.js

import * as buffer from 'buffer';

// Core exports from your polyfill
const {
  Buffer,
  SlowBuffer,
  INSPECT_MAX_BYTES,
  kMaxLength,
} = buffer;

// --- Missing pieces (polyfills / fallbacks) ---

// Node-style constants
const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: kMaxLength, // approximation
};

const kStringMaxLength = kMaxLength;

// Encoding helpers (basic approximations)

// Optimized isUtf8 using TextDecoder
function isUtf8(input) {
  if (!input) return true;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  
  try {
    // 'fatal: true' makes it throw on invalid sequences.
    // We don't actually need the string, so we use a small overhead approach.
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

// Optimized isAscii using Regex or TypedArray
function isAscii(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  
  // For very large buffers, checking 7-bit compliance in a loop is slow.
  // This uses a typed array check which V8 can often vectorize.
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) return false;
  }
  return true;
}

function transcode(source, fromEnc, toEnc) {
  return Buffer.from(
    Buffer.from(source, fromEnc).toString(toEnc),
    toEnc
  );
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
};
