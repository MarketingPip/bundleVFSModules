import { jest, describe, test, expect } from '@jest/globals';
import types from '../src/util/types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────
const ab  = () => new ArrayBuffer(8);
const sab = () => (typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(8) : null);

describe('util/types shim', () => {

  // ── isAnyArrayBuffer ────────────────────────────────────────────────────────
  describe('isAnyArrayBuffer', () => {
    test('true for ArrayBuffer',        () => expect(types.isAnyArrayBuffer(ab())).toBe(true));
    test('true for SharedArrayBuffer',  () => {
      const s = sab();
      if (s) expect(types.isAnyArrayBuffer(s)).toBe(true);
    });
    test('false for plain object',      () => expect(types.isAnyArrayBuffer({})).toBe(false));
    test('false for Uint8Array',        () => expect(types.isAnyArrayBuffer(new Uint8Array(4))).toBe(false));
  });

  // ── isArrayBuffer ───────────────────────────────────────────────────────────
  describe('isArrayBuffer', () => {
    test('true for ArrayBuffer',        () => expect(types.isArrayBuffer(ab())).toBe(true));
    test('false for SharedArrayBuffer', () => {
      const s = sab();
      if (s) expect(types.isArrayBuffer(s)).toBe(false);
    });
    test('false for typed array',       () => expect(types.isArrayBuffer(new Uint8Array(4))).toBe(false));
  });

  // ── isSharedArrayBuffer ─────────────────────────────────────────────────────
  describe('isSharedArrayBuffer', () => {
    test('true for SharedArrayBuffer', () => {
      const s = sab();
      if (s) expect(types.isSharedArrayBuffer(s)).toBe(true);
    });
    test('false for ArrayBuffer',       () => expect(types.isSharedArrayBuffer(ab())).toBe(false));
  });

  // ── isTypedArray ────────────────────────────────────────────────────────────
  describe('isTypedArray', () => {
    const typedViews = [
      Uint8Array, Int8Array, Uint16Array, Int16Array,
      Uint32Array, Int32Array, Float32Array, Float64Array,
      Uint8ClampedArray, BigInt64Array, BigUint64Array,
    ];
    for (const Ctor of typedViews) {
      test(`true for ${Ctor.name}`, () => {
        expect(types.isTypedArray(new Ctor(2))).toBe(true);
      });
    }
    test('false for ArrayBuffer',  () => expect(types.isTypedArray(ab())).toBe(false));
    test('false for DataView',     () => expect(types.isTypedArray(new DataView(ab()))).toBe(false));
    test('false for plain array',  () => expect(types.isTypedArray([])).toBe(false));
  });

  // ── individual typed-array predicates ──────────────────────────────────────
  const typedArrayCases = [
    ['isUint8Array',        Uint8Array],
    ['isUint8ClampedArray', Uint8ClampedArray],
    ['isInt8Array',         Int8Array],
    ['isUint16Array',       Uint16Array],
    ['isInt16Array',        Int16Array],
    ['isUint32Array',       Uint32Array],
    ['isInt32Array',        Int32Array],
    ['isFloat32Array',      Float32Array],
    ['isFloat64Array',      Float64Array],
    ['isBigInt64Array',     BigInt64Array],
    ['isBigUint64Array',    BigUint64Array],
  ];

  describe('typed array predicates', () => {
    for (const [method, Ctor] of typedArrayCases) {
      test(`${method} true for ${Ctor.name}`,   () => expect(types[method](new Ctor(2))).toBe(true));
      test(`${method} false for plain array`,   () => expect(types[method]([])).toBe(false));
      // Cross-type: pick a different typed array to verify exclusivity
      const other = typedArrayCases.find(([, C]) => C !== Ctor)?.[1];
      if (other) {
        test(`${method} false for ${other.name}`, () => expect(types[method](new other(2))).toBe(false));
      }
    }
  });

  // ── isDataView ──────────────────────────────────────────────────────────────
  describe('isDataView', () => {
    test('true for DataView',      () => expect(types.isDataView(new DataView(ab()))).toBe(true));
    test('false for ArrayBuffer',  () => expect(types.isDataView(ab())).toBe(false));
    test('false for Uint8Array',   () => expect(types.isDataView(new Uint8Array(4))).toBe(false));
  });

  // ── isDate ──────────────────────────────────────────────────────────────────
  describe('isDate', () => {
    test('true for Date',          () => expect(types.isDate(new Date())).toBe(true));
    test('false for date string',  () => expect(types.isDate('2024-01-01')).toBe(false));
    test('false for number',       () => expect(types.isDate(Date.now())).toBe(false));
  });

  // ── isRegExp ────────────────────────────────────────────────────────────────
  describe('isRegExp', () => {
    test('true for RegExp literal',    () => expect(types.isRegExp(/abc/)).toBe(true));
    test('true for new RegExp()',      () => expect(types.isRegExp(new RegExp('abc'))).toBe(true));
    test('false for string',           () => expect(types.isRegExp('abc')).toBe(false));
  });

  // ── isMap / isSet / isWeakMap / isWeakSet ───────────────────────────────────
  describe('isMap', () => {
    test('true for Map',    () => expect(types.isMap(new Map())).toBe(true));
    test('false for Set',   () => expect(types.isMap(new Set())).toBe(false));
    test('false for object',() => expect(types.isMap({})).toBe(false));
  });

  describe('isSet', () => {
    test('true for Set',    () => expect(types.isSet(new Set())).toBe(true));
    test('false for Map',   () => expect(types.isSet(new Map())).toBe(false));
  });

  describe('isWeakMap', () => {
    test('true for WeakMap',  () => expect(types.isWeakMap(new WeakMap())).toBe(true));
    test('false for Map',     () => expect(types.isWeakMap(new Map())).toBe(false));
  });

  describe('isWeakSet', () => {
    test('true for WeakSet',  () => expect(types.isWeakSet(new WeakSet())).toBe(true));
    test('false for Set',     () => expect(types.isWeakSet(new Set())).toBe(false));
  });

  // ── isMapIterator / isSetIterator ───────────────────────────────────────────
  describe('isMapIterator', () => {
    test('true for Map values()',   () => expect(types.isMapIterator(new Map().values())).toBe(true));
    test('true for Map keys()',     () => expect(types.isMapIterator(new Map().keys())).toBe(true));
    test('true for Map entries()', () => expect(types.isMapIterator(new Map().entries())).toBe(true));
    test('false for Set values()', () => expect(types.isMapIterator(new Set().values())).toBe(false));
    test('false for Array values()',() => expect(types.isMapIterator([].values())).toBe(false));
  });

  describe('isSetIterator', () => {
    test('true for Set values()',   () => expect(types.isSetIterator(new Set().values())).toBe(true));
    test('true for Set keys()',     () => expect(types.isSetIterator(new Set().keys())).toBe(true));
    test('true for Set entries()', () => expect(types.isSetIterator(new Set().entries())).toBe(true));
    test('false for Map values()', () => expect(types.isSetIterator(new Map().values())).toBe(false));
  });

  // ── isPromise ───────────────────────────────────────────────────────────────
  describe('isPromise', () => {
    test('true for Promise',             () => expect(types.isPromise(Promise.resolve())).toBe(true));
    test('true for async fn result',     () => expect(types.isPromise((async () => {})())).toBe(true));
    test('false for thenable object',    () => expect(types.isPromise({ then: () => {} })).toBe(false));
    test('false for null',               () => expect(types.isPromise(null)).toBe(false));
  });

  // ── isGeneratorObject / isGeneratorFunction ─────────────────────────────────
  describe('isGeneratorFunction', () => {
    test('true for function*',     () => expect(types.isGeneratorFunction(function* () {})).toBe(true));
    test('false for async fn',     () => expect(types.isGeneratorFunction(async () => {})).toBe(false));
    test('false for regular fn',   () => expect(types.isGeneratorFunction(() => {})).toBe(false));
  });

  describe('isGeneratorObject', () => {
    test('true for generator instance', () => {
      const gen = (function* () { yield 1; })();
      expect(types.isGeneratorObject(gen)).toBe(true);
    });
    test('false for generator function', () => expect(types.isGeneratorObject(function* () {})).toBe(false));
    test('false for plain iterator',     () => expect(types.isGeneratorObject([].values())).toBe(false));
  });

  // ── isAsyncFunction ─────────────────────────────────────────────────────────
  describe('isAsyncFunction', () => {
    test('true for async function',   () => expect(types.isAsyncFunction(async () => {})).toBe(true));
    test('false for regular function',() => expect(types.isAsyncFunction(() => {})).toBe(false));
    test('false for generator fn',    () => expect(types.isAsyncFunction(function* () {})).toBe(false));
  });

  // ── isNativeError ───────────────────────────────────────────────────────────
  describe('isNativeError', () => {
    test('true for Error',          () => expect(types.isNativeError(new Error())).toBe(true));
    test('true for TypeError',      () => expect(types.isNativeError(new TypeError())).toBe(true));
    test('true for RangeError',     () => expect(types.isNativeError(new RangeError())).toBe(true));
    test('false for plain object',  () => expect(types.isNativeError({ message: 'x' })).toBe(false));
    test('false for string',        () => expect(types.isNativeError('error')).toBe(false));
  });

  // ── isBoxedPrimitive ────────────────────────────────────────────────────────
  describe('isBoxedPrimitive', () => {
    test('true for new Number()',   () => expect(types.isBoxedPrimitive(new Number(1))).toBe(true));
    test('true for new String()',   () => expect(types.isBoxedPrimitive(new String('x'))).toBe(true));
    test('true for new Boolean()',  () => expect(types.isBoxedPrimitive(new Boolean(true))).toBe(true));
    test('false for number literal',() => expect(types.isBoxedPrimitive(1)).toBe(false));
    test('false for string literal',() => expect(types.isBoxedPrimitive('x')).toBe(false));
  });

  // ── isArgumentsObject ───────────────────────────────────────────────────────
  describe('isArgumentsObject', () => {
    test('true for arguments object', () => {
      const args = (function () { return arguments; })();
      expect(types.isArgumentsObject(args)).toBe(true);
    });
    test('false for plain array',     () => expect(types.isArgumentsObject([])).toBe(false));
  });

  // ── isSymbolObject ──────────────────────────────────────────────────────────
  describe('isSymbolObject', () => {
    test('true for Object(Symbol())',  () => expect(types.isSymbolObject(Object(Symbol()))).toBe(true));
    test('false for symbol primitive', () => expect(types.isSymbolObject(Symbol())).toBe(false));
  });

  // ── isBigIntObject ──────────────────────────────────────────────────────────
  describe('isBigIntObject', () => {
    test('true for Object(BigInt)',    () => expect(types.isBigIntObject(Object(BigInt(1)))).toBe(true));
    test('false for bigint primitive', () => expect(types.isBigIntObject(1n)).toBe(false));
  });

  // ── isNumberObject ──────────────────────────────────────────────────────────
  describe('isNumberObject', () => {
    test('true for new Number()',      () => expect(types.isNumberObject(new Number(42))).toBe(true));
    test('false for number primitive', () => expect(types.isNumberObject(42)).toBe(false));
  });

  // ── isStringObject ──────────────────────────────────────────────────────────
  describe('isStringObject', () => {
    test('true for new String()',       () => expect(types.isStringObject(new String('hi'))).toBe(true));
    test('false for string primitive',  () => expect(types.isStringObject('hi')).toBe(false));
  });

  // ── isBooleanObject ─────────────────────────────────────────────────────────
  describe('isBooleanObject', () => {
    test('true for new Boolean()',       () => expect(types.isBooleanObject(new Boolean(true))).toBe(true));
    test('false for boolean primitive',  () => expect(types.isBooleanObject(true)).toBe(false));
  });

  // ── isExternal ──────────────────────────────────────────────────────────────
  describe('isExternal', () => {
    test('always returns false in browser', () => {
      expect(types.isExternal({})).toBe(false);
      expect(types.isExternal(null)).toBe(false);
    });
  });

  // ── isProxy ─────────────────────────────────────────────────────────────────
  describe('isProxy', () => {
    test('always returns false (undetectable in JS)', () => {
      const p = new Proxy({}, {});
      expect(types.isProxy(p)).toBe(false);
      expect(types.isProxy({})).toBe(false);
    });
  });

  // ── isModuleNamespaceObject ─────────────────────────────────────────────────
  describe('isModuleNamespaceObject', () => {
    test('true for an ESM namespace import', async () => {
      const ns = await import('../src/v8.js');
      expect(types.isModuleNamespaceObject(ns)).toBe(true);
    });
    test('false for plain object', () => {
      expect(types.isModuleNamespaceObject({})).toBe(false);
    });
  });

  // ── isCryptoKey ─────────────────────────────────────────────────────────────
  describe('isCryptoKey', () => {
    test('false for plain object',  () => expect(types.isCryptoKey({})).toBe(false));
    test('true for CryptoKey if available', async () => {
      if (typeof globalThis.crypto?.subtle === 'undefined') return;
      const key = await globalThis.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 128 }, true, ['encrypt', 'decrypt']
      );
      expect(types.isCryptoKey(key)).toBe(true);
    });
  });
});
