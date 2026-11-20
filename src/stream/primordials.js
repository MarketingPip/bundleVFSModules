// Browser-safe primordials shim for the node:stream port.
//
// Node's lib/internal/streams/* files destructure their built-ins from the
// `primordials` object (uncurried, tamper-proof references captured at
// startup). This module provides the same names bound to the host's real
// built-ins, captured once at module evaluation. Semantics match for all
// uses in the stream port: each `ArrayPrototypePush(arr, x)`-style call
// behaves like the uncurried method.
//
// Only the primordials actually used by the stream sources are provided.

const uncurry = (fn) => Function.prototype.call.bind(fn);

// Bare globals re-bound as module-local bindings so they can be exported.
const { Array, BigInt, Boolean, Error, Number, Promise, String, Symbol, TypeError, Uint8Array, Uint32Array } =
  globalThis;
const SymbolFor = Symbol.for;
const SymbolHasInstance = Symbol.hasInstance;
const SymbolAsyncIterator = Symbol.asyncIterator;
const SymbolIterator = Symbol.iterator;
const SymbolSpecies = Symbol.species;

const ArrayIsArray = Array.isArray;
const ArrayPrototypeEvery = uncurry(Array.prototype.every);
const ArrayPrototypeIndexOf = uncurry(Array.prototype.indexOf);
const ArrayPrototypeMap = uncurry(Array.prototype.map);
const ArrayPrototypePop = uncurry(Array.prototype.pop);
const ArrayPrototypePush = uncurry(Array.prototype.push);
const ArrayPrototypeShift = uncurry(Array.prototype.shift);
const ArrayPrototypeSlice = uncurry(Array.prototype.slice);
const ArrayPrototypeToSorted = uncurry(Array.prototype.toSorted);
const ArrayBufferIsView = ArrayBuffer.isView;
const ArrayBufferPrototypeGetByteLength = uncurry(
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get,
);
const ArrayBufferPrototypeGetDetached = uncurry(
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached").get,
);
const ArrayBufferPrototypeGetResizable = uncurry(
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable").get,
);
const ArrayBufferPrototypeSlice = uncurry(ArrayBuffer.prototype.slice);
const DataViewPrototypeGetBuffer = uncurry(
  Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get,
);
const DataViewPrototypeGetByteLength = uncurry(
  Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get,
);
const DataViewPrototypeGetByteOffset = uncurry(
  Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset").get,
);
const FunctionPrototypeCall = uncurry(Function.prototype.call);
const FunctionPrototypeSymbolHasInstance = uncurry(
  Function.prototype[Symbol.hasInstance],
);
const JSONParse = JSON.parse;
const MathAbs = Math.abs;
const MathFloor = Math.floor;
const MathMax = Math.max;
const MathMin = Math.min;
const MathPow = Math.pow;
const MathSign = Math.sign;
const MathTrunc = Math.trunc;
const NumberIsFinite = Number.isFinite;
const NumberIsInteger = Number.isInteger;
const NumberIsNaN = Number.isNaN;
const NumberMAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const NumberMIN_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;
const NumberParseInt = Number.parseInt;
const ObjectDefineProperties = Object.defineProperties;
const ObjectDefineProperty = Object.defineProperty;
const ObjectEntries = Object.entries;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectKeys = Object.keys;
const ObjectPrototypeHasOwnProperty = uncurry(
  Object.prototype.hasOwnProperty,
);
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const PromisePrototypeThen = (p, onF, onR) => p.then(onF, onR);
const PromiseReject = Promise.reject.bind(Promise);
const PromiseResolve = Promise.resolve.bind(Promise);
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const StringPrototypeStartsWith = uncurry(String.prototype.startsWith);
const StringPrototypeToLowerCase = uncurry(String.prototype.toLowerCase);
const StringPrototypeToWellFormed = uncurry(String.prototype.toWellFormed);
// TypedArray.prototype.{set,fill,slice} + buffer/byteLength/byteOffset,
// uncurried via the %TypedArray% prototype.
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const TypedArrayPrototypeFill = uncurry(TypedArrayPrototype.fill);
const TypedArrayPrototypeGetBuffer = uncurry(
  Object.getOwnPropertyDescriptor(TypedArrayPrototype, "buffer").get,
);
const TypedArrayPrototypeGetByteLength = uncurry(
  Object.getOwnPropertyDescriptor(TypedArrayPrototype, "byteLength").get,
);
const TypedArrayPrototypeGetByteOffset = uncurry(
  Object.getOwnPropertyDescriptor(TypedArrayPrototype, "byteOffset").get,
);
const TypedArrayPrototypeSet = uncurry(TypedArrayPrototype.set);
const TypedArrayPrototypeSlice = uncurry(TypedArrayPrototype.slice);

const SymbolAsyncDispose =
  typeof Symbol.asyncDispose === "symbol"
    ? Symbol.asyncDispose
    : Symbol("Symbol.asyncDispose");
const SymbolDispose =
  typeof Symbol.dispose === "symbol"
    ? Symbol.dispose
    : Symbol("Symbol.dispose");

// Aliases that exist in Node's primordials under these exact names.
const SafeMap = Map;
const SafeSet = Set;
const SafeWeakMap = WeakMap;
const SafeWeakSet = WeakSet;
const SafePromiseRace = (promises, mapFn) =>
  Promise.race(
    promises.map((p, i) => (mapFn == null ? p : mapFn(p, i))),
  );
// Port of Node primordials SafePromiseAllReturnVoid (promises, mapFn?):
// resolves void once every (mapped) promise fulfills, rejects on the
// first rejection. Used by consumers.js iterator cleanup and duplex.js.
const SafePromiseAllReturnVoid = (promises, mapFn) =>
  new Promise((resolve, reject) => {
    let pending = promises.length;
    if (pending === 0) resolve();
    const onFulfilled = () => {
      if (--pending === 0) resolve();
    };
    for (let i = 0; i < promises.length; i++) {
      const p = mapFn == null ? promises[i] : mapFn(promises[i], i);
      PromiseResolve(p).then(onFulfilled, reject);
    }
  });
const SafePromisePrototypeFinally = (promise, onFinally) =>
  promise.finally(onFinally);
const PromiseWithResolvers =
  typeof Promise.withResolvers === "function"
    ? Promise.withResolvers.bind(Promise)
    : (promise, resolve, reject) => {
        promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      };

export {
  Array,
  ArrayBufferIsView,
  ArrayBufferPrototypeGetByteLength,
  ArrayBufferPrototypeGetDetached,
  ArrayBufferPrototypeGetResizable,
  ArrayBufferPrototypeSlice,
  ArrayIsArray,
  ArrayPrototypeEvery,
  ArrayPrototypeIndexOf,
  ArrayPrototypeMap,
  ArrayPrototypePop,
  ArrayPrototypePush,
  ArrayPrototypeShift,
  ArrayPrototypeSlice,
  ArrayPrototypeToSorted,
  BigInt,
  Boolean,
  DataViewPrototypeGetBuffer,
  DataViewPrototypeGetByteLength,
  DataViewPrototypeGetByteOffset,
  Error,
  FunctionPrototypeCall,
  FunctionPrototypeSymbolHasInstance,
  JSONParse,
  MathAbs,
  MathFloor,
  MathMax,
  MathMin,
  MathPow,
  MathSign,
  MathTrunc,
  Number,
  NumberIsFinite,
  NumberIsInteger,
  NumberIsNaN,
  NumberMAX_SAFE_INTEGER,
  NumberMIN_SAFE_INTEGER,
  NumberParseInt,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectEntries,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectKeys,
  ObjectPrototypeHasOwnProperty,
  ObjectSetPrototypeOf,
  Promise,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  PromiseWithResolvers,
  ReflectApply,
  ReflectOwnKeys,
  SafeMap,
  SafePromiseAllReturnVoid,
  SafePromisePrototypeFinally,
  SafePromiseRace,
  SafeSet,
  SafeWeakMap,
  SafeWeakSet,
  String,
  StringPrototypeStartsWith,
  StringPrototypeToLowerCase,
  StringPrototypeToWellFormed,
  Symbol,
  SymbolAsyncDispose,
  SymbolAsyncIterator,
  SymbolDispose,
  SymbolFor,
  SymbolHasInstance,
  SymbolIterator,
  SymbolSpecies,
  TypedArrayPrototypeFill,
  TypedArrayPrototypeGetBuffer,
  TypedArrayPrototypeGetByteLength,
  TypedArrayPrototypeGetByteOffset,
  TypedArrayPrototypeSet,
  TypedArrayPrototypeSlice,
  TypeError,
  Uint8Array,
  Uint32Array,
};
