import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// Repo tests for src/sea.js — the honest browser stub for node:sea.
//
// A browser sandbox is NEVER a Single Executable Application binary, so the
// stub reports isSea() === false and returns empty values (undefined / [])
// instead of throwing ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION the way real
// Node does outside a SEA binary. Argument validation (ERR_INVALID_ARG_TYPE)
// is preserved with Node-exact messages. Verified differentially against
// real node:sea @ v24.20.0.

describe('sea stub (browser: never a SEA binary)', () => {
  let sea;

  beforeEach(async () => {
    jest.resetModules();
    sea = await import('../src/sea.js');
  });

  describe('export surface matches node:sea', () => {
    test('named exports are exactly the five Node functions', async () => {
      const mod = await import('../src/sea.js');
      expect(new Set(Object.keys(mod))).toEqual(
        new Set(['default', 'getAsset', 'getAssetAsBlob', 'getAssetKeys', 'getRawAsset', 'isSea']),
      );
      for (const name of ['isSea', 'getRawAsset', 'getAsset', 'getAssetAsBlob', 'getAssetKeys']) {
        expect(typeof mod[name]).toBe('function');
      }
    });

    test('default export exposes the same five functions', async () => {
      const mod = await import('../src/sea.js');
      expect(typeof mod.default).toBe('object');
      for (const name of ['isSea', 'getRawAsset', 'getAsset', 'getAssetAsBlob', 'getAssetKeys']) {
        expect(mod.default[name]).toBe(mod[name]);
      }
    });

    test('has no injectAsset escape hatch (sandbox can never be a SEA binary)', async () => {
      const mod = await import('../src/sea.js');
      expect(mod.injectAsset).toBeUndefined();
      expect(mod.default.injectAsset).toBeUndefined();
    });
  });

  describe('isSea()', () => {
    test('returns false', () => {
      expect(sea.isSea()).toBe(false);
    });

    test('ignores extra arguments like real Node', () => {
      expect(sea.isSea(1)).toBe(false);
      expect(sea.isSea('x', {})).toBe(false);
    });

    test('stays false across calls (no hidden state)', () => {
      sea.getAsset('anything');
      sea.getAssetKeys();
      expect(sea.isSea()).toBe(false);
    });
  });

  describe('getters return empty values instead of throwing', () => {
    test('getRawAsset returns undefined for any string key', () => {
      expect(sea.getRawAsset('foo')).toBeUndefined();
      expect(sea.getRawAsset('')).toBeUndefined();
      expect(sea.getRawAsset('config.json')).toBeUndefined();
    });

    test('getAsset returns undefined with and without encoding', () => {
      expect(sea.getAsset('foo')).toBeUndefined();
      expect(sea.getAsset('foo', 'utf-8')).toBeUndefined();
      expect(sea.getAsset('foo', undefined)).toBeUndefined();
    });

    test('getAssetAsBlob returns undefined (never fabricates a Blob)', () => {
      expect(sea.getAssetAsBlob('foo')).toBeUndefined();
      expect(sea.getAssetAsBlob('foo', {})).toBeUndefined();
      expect(sea.getAssetAsBlob('foo', { type: 'text/plain' })).toBeUndefined();
    });

    test('getAssetKeys returns an empty array', () => {
      expect(sea.getAssetKeys()).toEqual([]);
    });

    test('getAssetKeys returns a fresh array each call', () => {
      const a = sea.getAssetKeys();
      const b = sea.getAssetKeys();
      expect(a).not.toBe(b);
      a.push('mutated');
      expect(sea.getAssetKeys()).toEqual([]);
    });
  });

  describe('argument validation (ERR_INVALID_ARG_TYPE, Node-exact)', () => {
    const invalidKeys = [1, 1n, Symbol('s'), false, null, undefined, {}, []];

    test.each(invalidKeys)('getRawAsset(%p) throws ERR_INVALID_ARG_TYPE', (key) => {
      expect(() => sea.getRawAsset(key)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),
      );
    });

    test.each(invalidKeys)('getAsset(%p) throws ERR_INVALID_ARG_TYPE', (key) => {
      expect(() => sea.getAsset(key)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),
      );
    });

    test.each(invalidKeys)('getAssetAsBlob(%p) throws ERR_INVALID_ARG_TYPE', (key) => {
      expect(() => sea.getAssetAsBlob(key)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),
      );
    });

    test.each([1, 1n, Symbol('e'), false, null, {}, []])(
      'getAsset("k", %p) throws ERR_INVALID_ARG_TYPE for encoding',
      (enc) => {
        expect(() => sea.getAsset('k', enc)).toThrow(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),
        );
      },
    );

    test('error messages match real Node rendering', () => {
      expect(() => sea.getRawAsset(123)).toThrow(
        'The "key" argument must be of type string. Received type number (123)',
      );
      expect(() => sea.getRawAsset(undefined)).toThrow(
        'The "key" argument must be of type string. Received undefined',
      );
      expect(() => sea.getRawAsset(null)).toThrow(
        'The "key" argument must be of type string. Received null',
      );
      expect(() => sea.getRawAsset([])).toThrow(
        'The "key" argument must be of type string. Received an instance of Array',
      );
      expect(() => sea.getAsset('k', 5)).toThrow(
        'The "encoding" argument must be of type string. Received type number (5)',
      );
    });

    test('getAssetAsBlob does not validate options when not in SEA (matches real Node)', () => {
      // Real Node only inspects `options` on the SEA success path; in non-SEA
      // mode getAssetAsBlob('x', 5) reaches the not-in-SEA error instead.
      expect(sea.getAssetAsBlob('x', 5)).toBeUndefined();
      expect(sea.getAssetAsBlob('x', 'text/plain')).toBeUndefined();
    });
  });
});
