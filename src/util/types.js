/*!
 * util/types — browser-compatible implementation of node:util.types
 * MIT License.
 * Node.js parity: node:util.types @ Node 22+ (v25 API surface)
 * Dependencies: esm.sh/util (base shim — we override incorrect/missing methods)
 *
 * Limitations:
 *   isExternal               → always false (requires V8 C++ binding)
 *   isProxy                  → always false (requires V8 binding; no JS workaround exists)
 *   isKeyObject              → always false (requires node:crypto internal binding)
 *   isCryptoKey              → uses SubtleCrypto CryptoKey check via duck-typing / brand check
 *   isModuleNamespaceObject  → heuristic only (@@toStringTag === 'Module' + Object.isSealed)
 *   isWebAssemblyCompiledModule → always false (deprecated in Node 14, removed in v22)
 *
 * Canonical spec reference:
 *   https://nodejs.org/api/util.html#utiltypes
 *   Source: lib/internal/util/types.js + internalBinding('types')
 */

import { types as nodeTypes } from "util";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** @param {unknown} val @returns {string} */
const getTag = (val) => Object.prototype.toString.call(val);

/**
 * Safe TypedArray brand-check — mirrors Node's
 * TypedArrayPrototypeGetSymbolToStringTag. Rejects DataView and plain objects
 * with a spoofed @@toStringTag by requiring ArrayBuffer.isView AND not DataView.
 * @param {unknown} v
 * @returns {string|undefined}
 */
const getTypedArrayTag = (v) => {
  if (v === null || typeof v !== 'object') return undefined;
  if (!ArrayBuffer.isView(v) || v instanceof DataView) return undefined;
  return v[Symbol.toStringTag];
};

// ─── Spec-compliant overrides / additions ─────────────────────────────────────
// We spread nodeTypes first so that any methods the esm.sh shim already gets
// right (isMap, isSet, isRegExp, isDate, isPromise, …) are kept unchanged.
// We only override or add where the shim is wrong, missing, or non-spec.

export const types = {
  ...nodeTypes,

  // ── Typed arrays ───────────────────────────────────────────────────────────
  // Node uses TypedArrayPrototypeGetSymbolToStringTag (our getTypedArrayTag).
  // The esm.sh shim uses instanceof which fails across realms; ours is correct.

  /**
   * Returns `true` if the value is any TypedArray instance.
   * Mirrors: `TypedArrayPrototypeGetSymbolToStringTag(v) !== undefined`
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isTypedArray(new Uint8Array())  // true
   * @example types.isTypedArray(new DataView(new ArrayBuffer(1)))  // false
   */
  isTypedArray: (v) => getTypedArrayTag(v) !== undefined,

  /**
   * Returns `true` if the value is a `Uint8Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isUint8Array(new Uint8Array())  // true
   */
  isUint8Array: (v) => getTypedArrayTag(v) === 'Uint8Array',

  /**
   * Returns `true` if the value is a `Uint8ClampedArray` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isUint8ClampedArray: (v) => getTypedArrayTag(v) === 'Uint8ClampedArray',

  /**
   * Returns `true` if the value is a `Uint16Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isUint16Array: (v) => getTypedArrayTag(v) === 'Uint16Array',

  /**
   * Returns `true` if the value is a `Uint32Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isUint32Array: (v) => getTypedArrayTag(v) === 'Uint32Array',

  /**
   * Returns `true` if the value is an `Int8Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isInt8Array: (v) => getTypedArrayTag(v) === 'Int8Array',

  /**
   * Returns `true` if the value is an `Int16Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isInt16Array: (v) => getTypedArrayTag(v) === 'Int16Array',

  /**
   * Returns `true` if the value is an `Int32Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isInt32Array: (v) => getTypedArrayTag(v) === 'Int32Array',

  /**
   * Returns `true` if the value is a `Float16Array` instance.
   * Added in Node 22 / V8 (TC39 Float16Array proposal, Stage 4).
   * Returns `false` on engines that do not yet support Float16Array.
   * @param {unknown} v
   * @returns {boolean}
   */
  isFloat16Array: (v) => getTypedArrayTag(v) === 'Float16Array',

  /**
   * Returns `true` if the value is a `Float32Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isFloat32Array: (v) => getTypedArrayTag(v) === 'Float32Array',

  /**
   * Returns `true` if the value is a `Float64Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isFloat64Array: (v) => getTypedArrayTag(v) === 'Float64Array',

  /**
   * Returns `true` if the value is a `BigInt64Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isBigInt64Array: (v) => getTypedArrayTag(v) === 'BigInt64Array',

  /**
   * Returns `true` if the value is a `BigUint64Array` instance.
   * @param {unknown} v
   * @returns {boolean}
   */
  isBigUint64Array: (v) => getTypedArrayTag(v) === 'BigUint64Array',

  // ── Buffers / views ────────────────────────────────────────────────────────

  /**
   * Returns `true` for any `ArrayBuffer` view — both TypedArrays and `DataView`.
   * Mirrors Node's `ArrayBufferIsView` which is literally `ArrayBuffer.isView`.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isArrayBufferView(new Uint8Array())   // true
   * @example types.isArrayBufferView(new DataView(...))  // true
   * @example types.isArrayBufferView([])                 // false
   */
  isArrayBufferView: (v) => ArrayBuffer.isView(v),

  /**
   * Returns `true` for `ArrayBuffer` but NOT `SharedArrayBuffer`.
   * Node spec explicitly separates the two; the esm.sh shim conflates them.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isArrayBuffer(new ArrayBuffer(8))         // true
   * @example types.isArrayBuffer(new SharedArrayBuffer(8))   // false
   */
  isArrayBuffer: (v) =>
    v instanceof ArrayBuffer && !(v instanceof SharedArrayBuffer),

  /**
   * Returns `true` for `SharedArrayBuffer` only (not plain `ArrayBuffer`).
   * @param {unknown} v
   * @returns {boolean}
   */
  isSharedArrayBuffer: (v) =>
    typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,

  /**
   * Returns `true` for either `ArrayBuffer` or `SharedArrayBuffer`.
   * In V8's memory model `SharedArrayBuffer` extends `ArrayBuffer`; this
   * mirrors `util.types.isAnyArrayBuffer` which accepts both.
   * @param {unknown} v
   * @returns {boolean}
   */
  isAnyArrayBuffer: (v) =>
    v instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer),

  /**
   * Returns `true` if the value is a `DataView`.
   * A `DataView` satisfies `ArrayBuffer.isView` but is NOT a TypedArray.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isDataView(new DataView(new ArrayBuffer(1)))  // true
   * @example types.isDataView(new Uint8Array())                  // false
   */
  isDataView: (v) => ArrayBuffer.isView(v) && v instanceof DataView,

  // ── Boxed primitives ───────────────────────────────────────────────────────
  // Node checks the internal [[Class]] via Object.prototype.toString, not
  // instanceof. The esm.sh shim omits BigInt boxed objects entirely.

  /**
   * Returns `true` if the value is a boxed `Number` object (`new Number(...)`).
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isNumberObject(new Number(42))  // true
   * @example types.isNumberObject(42)              // false
   */
  isNumberObject: (v) =>
    typeof v === 'object' && v !== null && getTag(v) === '[object Number]',

  /**
   * Returns `true` if the value is a boxed `String` object (`new String(...)`).
   * @param {unknown} v
   * @returns {boolean}
   */
  isStringObject: (v) =>
    typeof v === 'object' && v !== null && getTag(v) === '[object String]',

  /**
   * Returns `true` if the value is a boxed `Boolean` object (`new Boolean(...)`).
   * @param {unknown} v
   * @returns {boolean}
   */
  isBooleanObject: (v) =>
    typeof v === 'object' && v !== null && getTag(v) === '[object Boolean]',

  /**
   * Returns `true` if the value is a boxed `BigInt` object (`Object(42n)`).
   * Missing from the esm.sh shim entirely — added here for Node 22 parity.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isBigIntObject(Object(42n))  // true
   * @example types.isBigIntObject(42n)          // false
   */
  isBigIntObject: (v) =>
    typeof v === 'object' && v !== null && getTag(v) === '[object BigInt]',

  /**
   * Returns `true` if the value is a boxed `Symbol` object (`Object(Symbol())`).
   * @param {unknown} v
   * @returns {boolean}
   */
  isSymbolObject: (v) =>
    typeof v === 'object' && v !== null && getTag(v) === '[object Symbol]',

  /**
   * Returns `true` if the value is any boxed primitive wrapper object.
   * Covers: `Boolean`, `Number`, `String`, `Symbol`, and `BigInt` wrappers.
   * The esm.sh shim misses `BigInt` — fixed here.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isBoxedPrimitive(new Boolean(false))  // true
   * @example types.isBoxedPrimitive(false)               // false
   */
  isBoxedPrimitive: (v) => {
    if (v === null || typeof v !== 'object') return false;
    const t = getTag(v);
    return t === '[object Boolean]' || t === '[object Number]' ||
           t === '[object String]'  || t === '[object Symbol]' ||
           t === '[object BigInt]';
  },

  // ── NativeError ────────────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is a native ECMAScript `Error` instance.
   * Unlike a simple `instanceof Error`, this rejects plain objects whose
   * `@@toStringTag` has been spoofed — matching Node's V8 binding behaviour.
   * Accepts all seven built-in error constructors plus direct `Error` instances.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isNativeError(new TypeError('x'))  // true
   * @example types.isNativeError({ name: 'Error' })   // false — plain object
   */
  isNativeError: (v) =>
    v instanceof Error && (
      Object.getPrototypeOf(v) === Error.prototype ||
      v instanceof EvalError      || v instanceof RangeError     ||
      v instanceof ReferenceError || v instanceof SyntaxError    ||
      v instanceof TypeError      || v instanceof URIError
    ),

  // ── Function shapes ────────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is a native async function.
   * Note: async functions transpiled by Babel / TypeScript return `false`.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isAsyncFunction(async () => {})  // true
   * @example types.isAsyncFunction(() => {})        // false
   */
  isAsyncFunction: (v) =>
    typeof v === 'function' && v.constructor?.name === 'AsyncFunction',

  /**
   * Returns `true` if the value is a native generator function.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isGeneratorFunction(function*(){})  // true
   */
  isGeneratorFunction: (v) =>
    typeof v === 'function' && v.constructor?.name === 'GeneratorFunction',

  /**
   * Returns `true` if the value is a generator object (the iterator returned
   * by calling a generator function).
   * @param {unknown} v
   * @returns {boolean}
   * @example const gen = (function*(){})(); types.isGeneratorObject(gen)  // true
   */
  isGeneratorObject: (v) =>
    v !== null && typeof v === 'object' && getTag(v) === '[object Generator]',

  // ── Iterators ──────────────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is a `Map` iterator
   * (e.g. returned by `map.entries()`, `map.keys()`, `map.values()`).
   * @param {unknown} v
   * @returns {boolean}
   */
  isMapIterator: (v) =>
    v !== null && typeof v === 'object' && getTag(v) === '[object Map Iterator]',

  /**
   * Returns `true` if the value is a `Set` iterator
   * (e.g. returned by `set.values()`, `set.entries()`).
   * @param {unknown} v
   * @returns {boolean}
   */
  isSetIterator: (v) =>
    v !== null && typeof v === 'object' && getTag(v) === '[object Set Iterator]',

  // ── Arguments object ───────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is an `arguments` object created inside a
   * non-arrow function. Node uses an internal V8 check; we replicate via
   * `Object.prototype.toString` which returns `[object Arguments]`.
   * @param {unknown} v
   * @returns {boolean}
   * @example function f() { return types.isArgumentsObject(arguments); } f()  // true
   * @example types.isArgumentsObject([])  // false
   */
  isArgumentsObject: (v) => getTag(v) === '[object Arguments]',

  // ── WeakRef ────────────────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is a `WeakRef` instance (ES2021 / Node 14.6+).
   * Missing from the esm.sh shim — added here for Node 22 parity.
   * @param {unknown} v
   * @returns {boolean}
   * @example types.isWeakRef(new WeakRef({}))  // true
   */
  isWeakRef: (v) =>
    v !== null && typeof v === 'object' && getTag(v) === '[object WeakRef]',

  // ── CryptoKey ──────────────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is a Web Crypto API `CryptoKey`.
   * Node delegates to an OpenSSL internal binding; we use `instanceof
   * globalThis.CryptoKey` which is available in all modern browsers and
   * Node ≥ 15 with the global Web Crypto API enabled.
   * Falls back to `() => false` on environments without `CryptoKey`.
   * @param {unknown} v
   * @returns {boolean}
   */
  isCryptoKey: typeof globalThis.CryptoKey !== 'undefined'
    ? (v) => v instanceof globalThis.CryptoKey
    : () => false,

  // ── V8-internal stubs ──────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is an external value created with
   * `napi_create_external` / `v8::External`. Requires a V8 C++ binding.
   * Always returns `false` in browser / bundler environments.
   * @param {unknown} _v
   * @returns {false}
   */
  isExternal: (_v) => false,

  /**
   * Returns `true` if the value is a `Proxy`. Requires the V8 internal
   * `v8::Value::IsProxy` binding — there is no JavaScript reflection API
   * that can detect a Proxy without cooperation from the proxy itself.
   * Always returns `false` in browser / bundler environments.
   * @param {unknown} _v
   * @returns {false}
   */
  isProxy: (_v) => false,

  /**
   * Returns `true` if the value is a Node.js `KeyObject` from `node:crypto`.
   * Requires the OpenSSL internal binding. Always returns `false` in browser /
   * bundler environments.
   * @param {unknown} _v
   * @returns {false}
   */
  isKeyObject: (_v) => false,

  // ── Module namespace ───────────────────────────────────────────────────────

  /**
   * Returns `true` if the value is a module namespace object
   * (`import * as ns from '...'`). Node uses an internal V8 flag.
   * Heuristic: the object must be sealed AND have `@@toStringTag === 'Module'`.
   * May produce false positives for hand-crafted objects — unavoidable in JS.
   * @param {unknown} v
   * @returns {boolean}
   */
  isModuleNamespaceObject: (v) =>
    v !== null && typeof v === 'object' &&
    v[Symbol.toStringTag] === 'Module' && Object.isSealed(v),

  // ── Deprecated ─────────────────────────────────────────────────────────────

  /**
   * @deprecated Deprecated in Node 14, removed in Node 22.
   * Retained as a no-op stub for backward compatibility with older code that
   * checks for `WebAssembly.Module` instances via `util.types`.
   * Use `value instanceof WebAssembly.Module` directly instead.
   * @param {unknown} _v
   * @returns {false}
   */
  isWebAssemblyCompiledModule: (_v) => false,
};

// ─── Named exports (the full Node 22 util.types surface) ─────────────────────

export const {
  // TypedArrays
  isTypedArray,
  isUint8Array, isUint8ClampedArray, isUint16Array, isUint32Array,
  isInt8Array, isInt16Array, isInt32Array,
  isFloat16Array, isFloat32Array, isFloat64Array,
  isBigInt64Array, isBigUint64Array,

  // Buffers / views
  isArrayBuffer, isSharedArrayBuffer, isAnyArrayBuffer,
  isArrayBufferView, isDataView,

  // Boxed primitives
  isNumberObject, isStringObject, isBooleanObject,
  isBigIntObject, isSymbolObject, isBoxedPrimitive,

  // Error
  isNativeError,

  // Collections
  isMap, isSet, isWeakMap, isWeakSet, isWeakRef,
  isMapIterator, isSetIterator,

  // Functions / async / generators
  isAsyncFunction, isGeneratorFunction, isGeneratorObject,

  // Other built-ins
  isArgumentsObject, isDate, isRegExp, isPromise,

  // Crypto (Node 15+)
  isCryptoKey, isKeyObject,

  // V8-only stubs
  isExternal, isProxy,

  // Module
  isModuleNamespaceObject,

  // Deprecated
  isWebAssemblyCompiledModule,
} = types;

export default types;
