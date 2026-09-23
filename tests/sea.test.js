import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Repo tests for src/sea.js — node:sea backed by a virtual asset store.
//
// Without a host-provided store (no globalThis._RUNTIME_.__SEA_ASSETS__,
// which is the case under plain Node / direct import) the module keeps the
// honest empty behavior: isSea() === false and the getters return empty
// values (undefined / []) instead of throwing
// ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION the way real Node does outside
// a SEA binary. Argument validation (ERR_INVALID_ARG_TYPE) is preserved
// with Node-exact messages. Verified differentially against real node:sea
// @ v24.20.0.
//
// When the host runtime embeds assets (sandbox `seaAssets` option →
// __SEA_ASSETS__, or direct host assignment), the getters serve real data:
// isSea() === true and getAsset()/getRawAsset()/getAssetAsBlob()/
// getAssetKeys() round-trip the embedded bytes.

describe('sea without a virtual asset store (absent __SEA_ASSETS__)', () => {
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

    test('has no injectAsset escape hatch (injection is host-side, not a module export)', async () => {
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

describe('sea with a virtual asset store (__SEA_ASSETS__ present)', () => {
  let sea;

  const CONFIG_TEXT = '{"name":"demo","n":42}';
  const BINARY_BYTES = [0, 1, 2, 253, 254, 255];
  const BINARY_B64 = Buffer.from(BINARY_BYTES).toString('base64');

  function installStore(store) {
    globalThis._RUNTIME_ = { __SEA_ASSETS__: store };
  }

  beforeEach(async () => {
    jest.resetModules();
    sea = await import('../src/sea.js');
    installStore({
      'config.json': { encoding: 'utf8', data: CONFIG_TEXT },
      'logo.bin': { encoding: 'base64', data: BINARY_B64 },
    });
  });

  afterEach(() => {
    delete globalThis._RUNTIME_;
  });

  describe('isSea()', () => {
    test('returns true when the store holds assets', () => {
      expect(sea.isSea()).toBe(true);
    });

    test('returns false when the store is removed at runtime', () => {
      delete globalThis._RUNTIME_;
      expect(sea.isSea()).toBe(false);
    });

    test('returns false for a present-but-empty store', () => {
      installStore({});
      expect(sea.isSea()).toBe(false);
      expect(sea.getAssetKeys()).toEqual([]);
    });

    test('returns false when __SEA_ASSETS__ is not an object', () => {
      installStore('nope');
      expect(sea.isSea()).toBe(false);
    });
  });

  describe('getAssetKeys()', () => {
    test('lists the embedded keys', () => {
      expect(sea.getAssetKeys()).toEqual(['config.json', 'logo.bin']);
    });

    test('returns a fresh array each call', () => {
      const a = sea.getAssetKeys();
      a.push('mutated');
      expect(sea.getAssetKeys()).toEqual(['config.json', 'logo.bin']);
    });
  });

  describe('getAsset() round-trip', () => {
    test('returns the raw bytes as a Uint8Array', () => {
      const bytes = sea.getAsset('config.json');
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(bytes)).toBe(CONFIG_TEXT);
    });

    test('returns binary assets byte-identical', () => {
      expect(Array.from(sea.getAsset('logo.bin'))).toEqual(BINARY_BYTES);
    });

    test('returns a fresh copy on every call', () => {
      const a = sea.getAsset('logo.bin');
      a[0] = 99;
      expect(Array.from(sea.getAsset('logo.bin'))).toEqual(BINARY_BYTES);
    });

    test('missing key returns undefined', () => {
      expect(sea.getAsset('nope.txt')).toBeUndefined();
    });

    test('decodes with utf8 / utf-8', () => {
      expect(sea.getAsset('config.json', 'utf8')).toBe(CONFIG_TEXT);
      expect(sea.getAsset('config.json', 'utf-8')).toBe(CONFIG_TEXT);
    });

    test('decodes binary asset to base64 and hex', () => {
      expect(sea.getAsset('logo.bin', 'base64')).toBe(BINARY_B64);
      expect(sea.getAsset('logo.bin', 'hex')).toBe('000102fdfeff');
    });

    test('unknown encoding throws ERR_UNKNOWN_ENCODING', () => {
      expect(() => sea.getAsset('logo.bin', 'rot13')).toThrow(
        expect.objectContaining({ code: 'ERR_UNKNOWN_ENCODING', name: 'Error' }),
      );
      expect(() => sea.getAsset('logo.bin', 'rot13')).toThrow('Unknown encoding: rot13');
    });
  });

  describe('getRawAsset()', () => {
    test('returns an ArrayBuffer with the asset bytes', () => {
      const ab = sea.getRawAsset('logo.bin');
      expect(ab).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(ab))).toEqual(BINARY_BYTES);
    });

    test('returns a fresh copy each call', () => {
      const ab = sea.getRawAsset('logo.bin');
      new Uint8Array(ab)[0] = 99;
      expect(Array.from(new Uint8Array(sea.getRawAsset('logo.bin')))).toEqual(BINARY_BYTES);
    });

    test('missing key returns undefined', () => {
      expect(sea.getRawAsset('nope.txt')).toBeUndefined();
    });
  });

  describe('getAssetAsBlob()', () => {
    test('returns a Blob with the asset bytes', async () => {
      const blob = sea.getAssetAsBlob('config.json');
      expect(blob).toBeInstanceOf(Blob);
      expect(await blob.text()).toBe(CONFIG_TEXT);
    });

    test('honors options.type without validating options', async () => {
      const blob = sea.getAssetAsBlob('config.json', { type: 'application/json' });
      expect(blob.type).toBe('application/json');
      // Non-object options are ignored, not validated (matches real Node).
      expect(sea.getAssetAsBlob('config.json', 5)).toBeInstanceOf(Blob);
    });

    test('missing key returns undefined', () => {
      expect(sea.getAssetAsBlob('nope.txt')).toBeUndefined();
    });
  });

  describe('lenient host-assigned entry shapes', () => {
    test('plain string entries read as utf8', () => {
      installStore({ 'note.txt': 'hello' });
      expect(new TextDecoder().decode(sea.getAsset('note.txt'))).toBe('hello');
      expect(sea.getAsset('note.txt', 'utf8')).toBe('hello');
      expect(sea.getAssetKeys()).toEqual(['note.txt']);
      expect(sea.isSea()).toBe(true);
    });

    test('Uint8Array entries read as raw bytes', () => {
      installStore({ 'raw.bin': new Uint8Array(BINARY_BYTES) });
      expect(Array.from(sea.getAsset('raw.bin'))).toEqual(BINARY_BYTES);
    });

    test('malformed entries read as undefined but keep their key listed', () => {
      installStore({ 'bad.txt': { encoding: 'rot13', data: 'x' }, 'worse.txt': { nope: 1 } });
      expect(sea.getAsset('bad.txt')).toBeUndefined();
      expect(sea.getRawAsset('bad.txt')).toBeUndefined();
      expect(sea.getAssetAsBlob('worse.txt')).toBeUndefined();
      expect(sea.getAssetKeys()).toEqual(['bad.txt', 'worse.txt']);
    });
  });

  describe('argument validation still enforced with a store present', () => {
    test('invalid keys throw ERR_INVALID_ARG_TYPE', () => {
      for (const bad of [1, null, undefined, {}, []]) {
        expect(() => sea.getRawAsset(bad)).toThrow(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
        );
        expect(() => sea.getAsset(bad)).toThrow(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
        );
        expect(() => sea.getAssetAsBlob(bad)).toThrow(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
        );
      }
    });

    test('invalid encoding throws ERR_INVALID_ARG_TYPE', () => {
      expect(() => sea.getAsset('config.json', 5)).toThrow(
        'The "encoding" argument must be of type string. Received type number (5)',
      );
    });
  });
});
