/*!
 * ffi — Node.js FFI Shim for Browsers
 * MIT License.
 * Node.js parity: internalBinding('ffi')
 * Limitations: Operating system dynamic library loading and direct raw pointer access are not supported in browser environments.
 */

/**
 * @packageDocumentation
 * Browser shim for Node.js FFI (Foreign Function Interface).
 * Throws descriptive errors for unsupported native operations.
 */

function throwNotImplemented(apiName) {
  throw new Error(`${apiName} is not supported in this enviroment`);
}

export class DynamicLibrary {
  constructor() {
    throwNotImplemented('DynamicLibrary');
  }
}

export function dlopen() {
  throwNotImplemented('dlopen');
}

export function dlclose() {
  throwNotImplemented('dlclose');
}

export function dlsym() {
  throwNotImplemented('dlsym');
}

export function exportString() {
  throwNotImplemented('exportString');
}

export function exportBuffer() {
  throwNotImplemented('exportBuffer');
}

export function exportArrayBuffer() {
  throwNotImplemented('exportArrayBuffer');
}

export function exportArrayBufferView() {
  throwNotImplemented('exportArrayBufferView');
}

export const types = Object.freeze({
  __proto__: null,
  VOID: 'void',
  POINTER: 'pointer',
  BUFFER: 'buffer',
  ARRAY_BUFFER: 'arraybuffer',
  FUNCTION: 'function',
  BOOL: 'bool',
  CHAR: 'char',
  STRING: 'string',
  FLOAT: 'float',
  DOUBLE: 'double',
  INT_8: 'int8',
  UINT_8: 'uint8',
  INT_16: 'int16',
  UINT_16: 'uint16',
  INT_32: 'int32',
  UINT_32: 'uint32',
  INT_64: 'int64',
  UINT_64: 'uint64',
  FLOAT_32: 'float32',
  FLOAT_64: 'float64',
});

export default {
  DynamicLibrary,
  dlopen,
  dlclose,
  dlsym,
  exportString,
  exportBuffer,
  exportArrayBuffer,
  exportArrayBufferView,
  types,
};

// --- Usage ---
// try {
//   dlopen('mylibrary.so');
// } catch (err) {
//   console.error(err.message);
//   // Output: dlopen is not supported in the browser ffi shim
// }
