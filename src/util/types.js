// src/util/types.js — browser-native port of node:util/types (Node v24.20.0).
//
// Pure, dependency-free ESM. Every predicate is implemented with native
// brand checks (internal-slot-requiring prototype methods/getters,
// ArrayBuffer.isView, structuredClone) so behaviour matches Node's V8
// `internalBinding('types')` checks — including cross-realm objects,
// subclasses, prototype-tampered ("stealthy") objects, and detached buffers.
//
// No imports, no `globalThis._RUNTIME_` access, no `window`/`document`:
// this module loads standalone in a browser, a worker, or under Node.
//
// Known platform gaps (honest stubs, never throws):
//   isProxy      → always false. Proxies are undetectable from pure JS.
//                  (Node: true for Proxy objects.)
//   isExternal   → always false. Externals only exist via C++ bindings.
//   isKeyObject  → always false. KeyObjects only exist via node:crypto internals.
//
// Heuristic approximations (match Node except under deliberate spoofing):
//   isMapIterator / isSetIterator / isModuleNamespaceObject
//     → @@toStringTag checks; a plain object with a forged
//        Symbol.toStringTag would fool these (Node returns false).
//   isPromise    → instanceof, else tag + thenable check; a forged
//        { [Symbol.toStringTag]: 'Promise', then() {} } would fool it.
//   isCryptoKey  → WebIDL 'type' getter brand check (cross-realm safe).
//   isNativeError → structuredClone brand check (an instanceof fast path is
//        deliberately NOT used: Object.create(Error.prototype) passes
//        instanceof but Node reports false); matches Node on every probed
//        case (subclasses, cross-realm, proto-swapped, deleted stack,
//        DOMException, AggregateError) except errors carrying non-cloneable
//        own data (e.g. a function-valued `cause`), which report false.
//   Typed-array kind (isUint8Array & co.)
//     → prototype-identity fast path, verified by slot-measured element
//        size; cross-realm via the foreign prototype's own @@toStringTag;
//        prototype-tampered ("stealthy") objects via structuredClone.
//        Residual: deliberately re-prototyping a typed array to a DIFFERENT
//        kind's prototype with the SAME element size (e.g. Int8Array →
//        Uint8Array.prototype) is undetectable read-only and misreports;
//        needs structuredClone (present in all real browsers) to detect,
//        and even then only when the size check raises doubt.
//        Proto-tampered typed arrays report false where structuredClone is
//        unavailable (non-browser edge; browsers all have it).
//
// Node.js parity: node:util/types @ v24.20.0 — 43 named exports, no default
// export in Node. This shim additionally exports a default `types` namespace
// object for test-suite ergonomics (harmless extra).

// ─── Internal helpers ───────────────────────────────────────────────────────

const objectToString = Object.prototype.toString;

/** @param {unknown} v @returns {string} toString tag, '' if unreadable (e.g. revoked Proxy) */
function getTag(v) {
  try {
    return objectToString.call(v);
  } catch {
    return '';
  }
}

/** @param {unknown} v @returns {boolean} */
function isObjectLike(v) {
  return v !== null && (typeof v === 'object' || typeof v === 'function');
}

// ─── ArrayBuffers ───────────────────────────────────────────────────────────
// ArrayBuffer.prototype.byteLength's getter requires the [[ArrayBufferData]]
// slot and rejects SharedArrayBuffers; SharedArrayBuffer.prototype.byteLength
// requires the slot and accepts both. Together they brand-check precisely.

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
).get;
const sharedArrayBufferByteLength =
  typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')
        .get
    : null;

/** @param {unknown} v @returns {boolean} */
export function isArrayBuffer(v) {
  if (!isObjectLike(v)) return false;
  try {
    arrayBufferByteLength.call(v);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} v @returns {boolean} */
export function isSharedArrayBuffer(v) {
  if (sharedArrayBufferByteLength === null || !isObjectLike(v)) return false;
  if (isArrayBuffer(v)) return false;
  try {
    sharedArrayBufferByteLength.call(v);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} v @returns {boolean} */
export function isAnyArrayBuffer(v) {
  return isArrayBuffer(v) || isSharedArrayBuffer(v);
}

/** @param {unknown} v @returns {boolean} */
export function isArrayBufferView(v) {
  try {
    return ArrayBuffer.isView(v);
  } catch {
    return false;
  }
}

// ─── Typed arrays ───────────────────────────────────────────────────────────
// The %TypedArray%.prototype 'length' getter requires the [[TypedArrayName]]
// slot, so it brand-checks real typed arrays (any realm, any prototype,
// detached) and rejects DataViews and fakes. The concrete kind is found by
// walking the prototype chain for a known concrete prototype (covers
// subclasses and instance-level @@toStringTag overrides); when the chain was
// tampered with or the object is cross-realm, structuredClone materialises a
// fresh current-realm typed array of the same kind.

const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(
  typedArrayProto,
  'length',
).get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayProto,
  'byteLength',
).get;

const KIND_BY_PROTO = new Map();
const KIND_NAMES = new Set();
const BYTES_PER_ELEMENT = new Map();
for (const name of [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]) {
  const Ctor = globalThis[name];
  if (typeof Ctor === 'function') {
    KIND_BY_PROTO.set(Ctor.prototype, name);
    KIND_NAMES.add(name);
    BYTES_PER_ELEMENT.set(name, Ctor.BYTES_PER_ELEMENT);
  }
}

/** @param {unknown} v @returns {boolean} */
function hasTypedArraySlot(v) {
  try {
    typedArrayLength.call(v);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} v @returns {string|undefined} e.g. 'Uint8Array' */
function typedArrayKind(v) {
  if (!isObjectLike(v)) return undefined;
  let len;
  try {
    len = typedArrayLength.call(v); // internal-slot check
  } catch {
    return undefined;
  }
  let candidate;
  try {
    for (
      let p = Object.getPrototypeOf(v);
      p !== null;
      p = Object.getPrototypeOf(p)
    ) {
      const k = KIND_BY_PROTO.get(p);
      if (k !== undefined) {
        candidate = k;
        break;
      }
      // Cross-realm: the foreign concrete prototype carries its own
      // @@toStringTag naming the kind.
      if (
        Object.prototype.hasOwnProperty.call(p, Symbol.toStringTag) &&
        KIND_NAMES.has(p[Symbol.toStringTag])
      ) {
        candidate = p[Symbol.toStringTag];
        break;
      }
    }
  } catch {
    return undefined;
  }
  if (candidate !== undefined && len > 0) {
    // Sanity: the candidate kind's element size must match the
    // slot-measured size, otherwise the prototype chain was tampered with
    // (e.g. an Int8Array re-prototyped to Uint16Array.prototype).
    let byteLen;
    try {
      byteLen = typedArrayByteLength.call(v);
    } catch {
      return undefined;
    }
    if (byteLen / len !== BYTES_PER_ELEMENT.get(candidate)) {
      candidate = undefined;
    }
  }
  if (candidate === undefined) {
    // Prototype tampered with ("stealthy") or otherwise unrecognised:
    // re-materialise via structuredClone, whose result carries the true kind
    // on a freshly minted (hence genuine) prototype. Identified by
    // constructor NAME, not identity — see isNativeError.
    if (typeof structuredClone === 'function') {
      try {
        const p = Object.getPrototypeOf(structuredClone(v));
        const n = p?.constructor?.name;
        if (KIND_NAMES.has(n)) return n;
      } catch {
        // Detached-and-tampered or otherwise uncloneable: unknown.
      }
    }
    return undefined;
  }
  return candidate;
}

/** @param {unknown} v @returns {boolean} */
export function isTypedArray(v) {
  return isObjectLike(v) && hasTypedArraySlot(v);
}

/** @param {unknown} v @returns {boolean} */
export function isUint8Array(v) {
  return typedArrayKind(v) === 'Uint8Array';
}

/** @param {unknown} v @returns {boolean} */
export function isUint8ClampedArray(v) {
  return typedArrayKind(v) === 'Uint8ClampedArray';
}

/** @param {unknown} v @returns {boolean} */
export function isUint16Array(v) {
  return typedArrayKind(v) === 'Uint16Array';
}

/** @param {unknown} v @returns {boolean} */
export function isUint32Array(v) {
  return typedArrayKind(v) === 'Uint32Array';
}

/** @param {unknown} v @returns {boolean} */
export function isInt8Array(v) {
  return typedArrayKind(v) === 'Int8Array';
}

/** @param {unknown} v @returns {boolean} */
export function isInt16Array(v) {
  return typedArrayKind(v) === 'Int16Array';
}

/** @param {unknown} v @returns {boolean} */
export function isInt32Array(v) {
  return typedArrayKind(v) === 'Int32Array';
}

/** @param {unknown} v @returns {boolean} */
export function isFloat16Array(v) {
  return typedArrayKind(v) === 'Float16Array';
}

/** @param {unknown} v @returns {boolean} */
export function isFloat32Array(v) {
  return typedArrayKind(v) === 'Float32Array';
}

/** @param {unknown} v @returns {boolean} */
export function isFloat64Array(v) {
  return typedArrayKind(v) === 'Float64Array';
}

/** @param {unknown} v @returns {boolean} */
export function isBigInt64Array(v) {
  return typedArrayKind(v) === 'BigInt64Array';
}

/** @param {unknown} v @returns {boolean} */
export function isBigUint64Array(v) {
  return typedArrayKind(v) === 'BigUint64Array';
}

/** @param {unknown} v @returns {boolean} */
export function isDataView(v) {
  try {
    return isObjectLike(v) && ArrayBuffer.isView(v) && !hasTypedArraySlot(v);
  } catch {
    return false;
  }
}

// ─── Collections ────────────────────────────────────────────────────────────
// Prototype-method brand checks: they require the internal slot, so they are
// cross-realm safe and reject fakes. (Proxies forward to their target —
// undetectable from pure JS; see isProxy.)

export function isMap(v) {
  if (!isObjectLike(v)) return false;
  try {
    Map.prototype.has.call(v, undefined);
    return true;
  } catch {
    return false;
  }
}

export function isSet(v) {
  if (!isObjectLike(v)) return false;
  try {
    Set.prototype.has.call(v, undefined);
    return true;
  } catch {
    return false;
  }
}

export function isWeakMap(v) {
  if (!isObjectLike(v)) return false;
  try {
    WeakMap.prototype.has.call(v, undefined);
    return true;
  } catch {
    return false;
  }
}

export function isWeakSet(v) {
  if (!isObjectLike(v)) return false;
  try {
    WeakSet.prototype.has.call(v, undefined);
    return true;
  } catch {
    return false;
  }
}

// Iterator prototypes are not exposed as globals; capture them once.
// %MapIteratorPrototype%.next would brand-check but consumes the iterator,
// so identity (same realm) + @@toStringTag (cross-realm) is used instead.
const mapIteratorProto = Object.getPrototypeOf(new Map().keys());
const setIteratorProto = Object.getPrototypeOf(new Set().keys());

/** @param {unknown} v @returns {boolean} */
export function isMapIterator(v) {
  if (!isObjectLike(v)) return false;
  try {
    if (mapIteratorProto.isPrototypeOf(v)) return true;
  } catch {
    return false;
  }
  return getTag(v) === '[object Map Iterator]';
}

/** @param {unknown} v @returns {boolean} */
export function isSetIterator(v) {
  if (!isObjectLike(v)) return false;
  try {
    if (setIteratorProto.isPrototypeOf(v)) return true;
  } catch {
    return false;
  }
  return getTag(v) === '[object Set Iterator]';
}

// ─── Boxed primitives ───────────────────────────────────────────────────────
// The wrapper prototype's valueOf requires the internal slot, so this is
// cross-realm safe and rejects forged @@toStringTags.

export function isNumberObject(v) {
  if (!isObjectLike(v)) return false;
  try {
    Number.prototype.valueOf.call(v);
    return true;
  } catch {
    return false;
  }
}

export function isStringObject(v) {
  if (!isObjectLike(v)) return false;
  try {
    String.prototype.valueOf.call(v);
    return true;
  } catch {
    return false;
  }
}

export function isBooleanObject(v) {
  if (!isObjectLike(v)) return false;
  try {
    Boolean.prototype.valueOf.call(v);
    return true;
  } catch {
    return false;
  }
}

export function isBigIntObject(v) {
  if (!isObjectLike(v)) return false;
  try {
    BigInt.prototype.valueOf.call(v);
    return true;
  } catch {
    return false;
  }
}

export function isSymbolObject(v) {
  if (!isObjectLike(v)) return false;
  try {
    Symbol.prototype.valueOf.call(v);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} v @returns {boolean} */
export function isBoxedPrimitive(v) {
  return (
    isNumberObject(v) ||
    isStringObject(v) ||
    isBooleanObject(v) ||
    isBigIntObject(v) ||
    isSymbolObject(v)
  );
}

// ─── Date / RegExp ──────────────────────────────────────────────────────────
// Slot-requiring accessors: side-effect free (unlike exec/test, which move
// lastIndex) and cross-realm safe.

const regexpSourceGetter = Object.getOwnPropertyDescriptor(
  RegExp.prototype,
  'source',
).get;

/** @param {unknown} v @returns {boolean} */
export function isDate(v) {
  if (!isObjectLike(v)) return false;
  try {
    Date.prototype.getTime.call(v);
    return true;
  } catch {
    return false;
  }
}

/** @param {unknown} v @returns {boolean} */
export function isRegExp(v) {
  if (!isObjectLike(v)) return false;
  try {
    regexpSourceGetter.call(v);
    return true;
  } catch {
    return false;
  }
}

// ─── Functions / promises ───────────────────────────────────────────────────

/** @param {unknown} v @returns {boolean} */
export function isAsyncFunction(v) {
  if (typeof v !== 'function') return false;
  const tag = getTag(v);
  // Node also reports true for async generator functions.
  return tag === '[object AsyncFunction]' || tag === '[object AsyncGeneratorFunction]';
}

/** @param {unknown} v @returns {boolean} */
export function isGeneratorFunction(v) {
  if (typeof v !== 'function') return false;
  const tag = getTag(v);
  // Node also reports true for async generator functions.
  return tag === '[object GeneratorFunction]' || tag === '[object AsyncGeneratorFunction]';
}

/** @param {unknown} v @returns {boolean} */
export function isGeneratorObject(v) {
  if (!isObjectLike(v)) return false;
  const tag = getTag(v);
  // Node also reports true for async generator objects.
  return tag === '[object Generator]' || tag === '[object AsyncGenerator]';
}

/** @param {unknown} v @returns {boolean} */
export function isPromise(v) {
  try {
    if (!isObjectLike(v)) return false;
    if (v instanceof Promise) return true;
    // Cross-realm promise: the tag is driven by the internal slot.
    return getTag(v) === '[object Promise]' && typeof v.then === 'function';
  } catch {
    return false;
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────────
// V8 marks genuine error objects internally (survives prototype swaps and
// `delete err.stack`; lost through proxies). structuredClone preserves that
// brand while reducing fakes and tag-forgeries to plain objects.

/** @param {unknown} v @returns {boolean} */
export function isNativeError(v) {
  try {
    if (!isObjectLike(v)) return false;
    const tag = getTag(v);
    const looksErr =
      tag === '[object Error]' || tag === '[object DOMException]';
    if (typeof structuredClone === 'function') {
      // structuredClone preserves V8's internal error brand (survives
      // prototype swaps; lost through proxies) while reducing fakes and
      // tag-forgeries to plain objects. Note: `instanceof Error` alone is
      // NOT sufficient — Object.create(Error.prototype) passes instanceof
      // but Node reports false.
      //
      // The clone is identified by its prototype's constructor NAME, not
      // instanceof: under test runners (or cross-realm hosts) structuredClone
      // may deserialize with a different realm's Error.prototype, where
      // instanceof would wrongly fail. The clone is freshly minted by the
      // serializer, so its prototype is always genuine.
      if (!looksErr) return false;
      // Walk the clone's prototype chain for a genuine Error/DOMException
      // prototype (identified by constructor name — see above). This accepts
      // specific subtypes (TypeError, RangeError, …), whose clones keep their
      // concrete prototype, while rejecting plain-object clones of fakes.
      for (
        let p = Object.getPrototypeOf(structuredClone(v));
        p !== null;
        p = Object.getPrototypeOf(p)
      ) {
        const n = p.constructor?.name;
        if (n === 'Error' || n === 'DOMException') return true;
      }
      return false;
    }
    // No structuredClone: instanceof + tag (rejects
    // Object.create(Error.prototype), whose tag is '[object Object]').
    return (
      looksErr &&
      (v instanceof Error ||
        (typeof DOMException !== 'undefined' && v instanceof DOMException))
    );
  } catch {
    return false;
  }
}

// ─── Misc builtins ──────────────────────────────────────────────────────────

/** @param {unknown} v @returns {boolean} */
export function isArgumentsObject(v) {
  return isObjectLike(v) && getTag(v) === '[object Arguments]';
}

/** @param {unknown} v @returns {boolean} */
export function isModuleNamespaceObject(v) {
  return isObjectLike(v) && getTag(v) === '[object Module]';
}

// WebIDL 'type' getter brand-checks genuine CryptoKeys (cross-realm safe).
const cryptoKeyTypeGetter =
  typeof CryptoKey !== 'undefined'
    ? Object.getOwnPropertyDescriptor(CryptoKey.prototype, 'type')?.get
    : undefined;

/** @param {unknown} v @returns {boolean} */
export function isCryptoKey(v) {
  if (!isObjectLike(v) || typeof cryptoKeyTypeGetter !== 'function') {
    return false;
  }
  try {
    cryptoKeyTypeGetter.call(v);
    return true;
  } catch {
    return false;
  }
}

// ─── Honest platform gaps ───────────────────────────────────────────────────

/**
 * Always false: proxies are undetectable from pure JS.
 * (Node returns true for Proxy objects.)
 * @param {unknown} _v
 * @returns {boolean}
 */
export function isProxy(_v) {
  return false;
}

/**
 * Always false: externals only exist via C++ bindings.
 * @param {unknown} _v
 * @returns {boolean}
 */
export function isExternal(_v) {
  return false;
}

/**
 * Always false: KeyObjects only exist via node:crypto internals.
 * @param {unknown} _v
 * @returns {boolean}
 */
export function isKeyObject(_v) {
  return false;
}

// ─── Namespace ──────────────────────────────────────────────────────────────
// Node's node:util/types has no default export; this shim adds one for
// test-suite ergonomics (harmless extra).

const types = {
  isAnyArrayBuffer,
  isArgumentsObject,
  isArrayBuffer,
  isArrayBufferView,
  isAsyncFunction,
  isBigInt64Array,
  isBigIntObject,
  isBigUint64Array,
  isBooleanObject,
  isBoxedPrimitive,
  isCryptoKey,
  isDataView,
  isDate,
  isExternal,
  isFloat16Array,
  isFloat32Array,
  isFloat64Array,
  isGeneratorFunction,
  isGeneratorObject,
  isInt16Array,
  isInt32Array,
  isInt8Array,
  isKeyObject,
  isMap,
  isMapIterator,
  isModuleNamespaceObject,
  isNativeError,
  isNumberObject,
  isPromise,
  isProxy,
  isRegExp,
  isSet,
  isSetIterator,
  isSharedArrayBuffer,
  isStringObject,
  isSymbolObject,
  isTypedArray,
  isUint16Array,
  isUint32Array,
  isUint8Array,
  isUint8ClampedArray,
  isWeakMap,
  isWeakSet,
};

export default types;
