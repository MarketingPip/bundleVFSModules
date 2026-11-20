// Minimal port of the internal/util/types helpers used by node:stream.
//
// ponytail: Node's implementations are C++ brand checks (internal slots),
// so they accept cross-realm values (vm.runInNewContext). `instanceof`
// fails cross-realm, so these use Object.prototype.toString brand tags
// instead — the same approximation webidl.js already uses for Uint8Array.
// A forged Symbol.toStringTag could spoof the tag; the host's
// ArrayBuffer.isView (used where a view check suffices) cannot be spoofed.

const tagOf = (value) => Object.prototype.toString.call(value);

function isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

function isUint8Array(value) {
  return tagOf(value) === "[object Uint8Array]";
}

function isAnyArrayBuffer(value) {
  const tag = tagOf(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
}

function isBlob(value) {
  return tagOf(value) === "[object Blob]";
}

function isPromise(value) {
  return (
    value instanceof Promise ||
    (value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      typeof value.then === "function")
  );
}

function isTypedArray(value) {
  return ArrayBuffer.isView(value) && tagOf(value) !== "[object DataView]";
}

function isSharedArrayBuffer(value) {
  return tagOf(value) === "[object SharedArrayBuffer]";
}

export { isAnyArrayBuffer, isArrayBufferView, isBlob, isPromise, isSharedArrayBuffer, isTypedArray, isUint8Array };
