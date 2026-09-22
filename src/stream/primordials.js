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
const { Boolean, Error, Number, Promise, Symbol, Uint8Array } = globalThis;
const SymbolFor = Symbol.for;
const SymbolHasInstance = Symbol.hasInstance;
const SymbolAsyncIterator = Symbol.asyncIterator;
const SymbolIterator = Symbol.iterator;
const SymbolSpecies = Symbol.species;

const ArrayIsArray = Array.isArray;
const ArrayPrototypeIndexOf = uncurry(Array.prototype.indexOf);
const ArrayPrototypePop = uncurry(Array.prototype.pop);
const ArrayPrototypePush = uncurry(Array.prototype.push);
const ArrayPrototypeSlice = uncurry(Array.prototype.slice);
const FunctionPrototypeCall = uncurry(Function.prototype.call);
const FunctionPrototypeSymbolHasInstance = uncurry(Function.prototype[Symbol.hasInstance]);
const JSONParse = JSON.parse;
const MathFloor = Math.floor;
const NumberIsInteger = Number.isInteger;
const NumberIsNaN = Number.isNaN;
const NumberParseInt = Number.parseInt;
const ObjectDefineProperties = Object.defineProperties;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectKeys = Object.keys;
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const PromisePrototypeThen = (p, onF, onR) => p.then(onF, onR);
const PromiseReject = Promise.reject.bind(Promise);
const PromiseResolve = Promise.resolve.bind(Promise);
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const StringPrototypeToLowerCase = uncurry(String.prototype.toLowerCase);
// TypedArray.prototype.set, uncurried via the %TypedArray% prototype.
const TypedArrayPrototypeSet = uncurry(Object.getPrototypeOf(Uint8Array.prototype).set);

const SymbolAsyncDispose =
  typeof Symbol.asyncDispose === 'symbol' ? Symbol.asyncDispose : Symbol('Symbol.asyncDispose');
const SymbolDispose =
  typeof Symbol.dispose === 'symbol' ? Symbol.dispose : Symbol('Symbol.dispose');

// Aliases that exist in Node's primordials under these exact names.
const SafeSet = Set;
const PromiseWithResolvers = typeof Promise.withResolvers === 'function' ?
  Promise.withResolvers.bind(Promise) :
  ((promise, resolve, reject) => {
    promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  });

export {
  ArrayIsArray,
  ArrayPrototypeIndexOf,
  ArrayPrototypePop,
  ArrayPrototypePush,
  ArrayPrototypeSlice,
  Boolean,
  Error,
  FunctionPrototypeCall,
  FunctionPrototypeSymbolHasInstance,
  JSONParse,
  MathFloor,
  Number,
  NumberIsInteger,
  NumberIsNaN,
  NumberParseInt,
  ObjectDefineProperties,
  ObjectDefineProperty,
  ObjectFreeze,
  ObjectGetOwnPropertyDescriptor,
  ObjectKeys,
  ObjectSetPrototypeOf,
  Promise,
  PromisePrototypeThen,
  PromiseReject,
  PromiseResolve,
  PromiseWithResolvers,
  ReflectApply,
  ReflectOwnKeys,
  SafeSet,
  StringPrototypeToLowerCase,
  Symbol,
  SymbolAsyncDispose,
  SymbolAsyncIterator,
  SymbolDispose,
  SymbolFor,
  SymbolHasInstance,
  SymbolIterator,
  SymbolSpecies,
  TypedArrayPrototypeSet,
  Uint8Array,
};
