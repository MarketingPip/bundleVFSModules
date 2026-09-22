// Minimal port of the internal/util/types helpers used by node:stream.

function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

function isUint8Array(value) {
  return value instanceof Uint8Array;
}

function isAnyArrayBuffer(value) {
  return value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
}

function isBlob(value) {
  return value instanceof Blob;
}

export {
  isAnyArrayBuffer,
  isArrayBufferView,
  isBlob,
  isUint8Array,
};
