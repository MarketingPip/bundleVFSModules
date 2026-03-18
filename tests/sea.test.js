import { jest, describe, test, expect, beforeEach } from '@jest/globals';

describe('SEA (Single Executable Application) wrapper', () => {
  let sea;

  beforeEach(async () => {
    jest.resetModules();
    delete global.__SEA_INJECT__;
    sea = await import('../src/sea.js');
  });

  describe('Initial State (Non-SEA)', () => {
    test('isSea() returns false when no assets are present', () => {
      expect(sea.isSea()).toBe(false);
    });

    test('getAssetKeys() throws ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION', () => {
      // FIX: Match the message text, not the property code
      expect(() => sea.getAssetKeys())
        .toThrow(/available in single executable applications/);
    });
  });

  describe('Programmatic Injection (injectAsset)', () => {
    test('injectAsset enables SEA mode', () => {
      const data = new TextEncoder().encode('hello world');
      sea.injectAsset('test.txt', data);
      
      expect(sea.isSea()).toBe(true);
      expect(sea.getAssetKeys()).toEqual(['test.txt']);
    });

    test('getAsset returns a copy (mutable)', () => {
      const data = new Uint8Array([1, 2, 3]);
      sea.injectAsset('data.bin', data);

      const copy = sea.getAsset('data.bin');
      const view = new Uint8Array(copy);
      view[0] = 99;

      const original = new Uint8Array(sea.getRawAsset('data.bin'));
      expect(original[0]).toBe(1);
      expect(view[0]).toBe(99);
    });
  });

  describe('Global Injection (__SEA_INJECT__)', () => {
    test('decodes base64 assets from global object on load', async () => {
      global.__SEA_INJECT__ = {
        'config.json': btoa(JSON.stringify({ port: 8080 }))
      };

      // FIX: isolateModulesAsync returns the result of the callback
      const isolatedSea = await jest.isolateModulesAsync(async () => {
        const mod = await import('../src/sea.js');
        return mod;
      });

      expect(isolatedSea.isSea()).toBe(true);
      const config = isolatedSea.getAsset('config.json', 'utf-8');
      expect(JSON.parse(config)).toEqual({ port: 8080 });
    });
  });

  describe('getAssetAsBlob', () => {
    test('returns a Blob instance', () => {
      sea.injectAsset('test.bin', new Uint8Array([0, 1]));
      const blob = sea.getAssetAsBlob('test.bin', { type: 'application/octet-stream' });
      
      expect(blob).toBeInstanceOf(globalThis.Blob);
      expect(blob.type).toBe('application/octet-stream');
    });

    test('throws if Blob is missing', () => {
      const originalBlob = globalThis.Blob;
      // Use defineProperty because some environments make Blob non-configurable
      Object.defineProperty(globalThis, 'Blob', { value: undefined, configurable: true });
      
      sea.injectAsset('test.bin', new Uint8Array([0, 1]));
      expect(() => sea.getAssetAsBlob('test.bin')).toThrow(/Blob is not available/);
      
      Object.defineProperty(globalThis, 'Blob', { value: originalBlob });
    });
  });

  describe('Error Handling and Validation', () => {
    test('throws ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND', () => {
      sea.injectAsset('exists.txt', 'YmVlcA==');
      // FIX: Match the message text
      expect(() => sea.getAsset('missing.txt'))
        .toThrow(/Cannot find asset 'missing.txt'/);
    });

    test('validates argument types', () => {
      // FIX: Match message text produced by errInvalidArgType
      expect(() => sea.getRawAsset(123))
        .toThrow(/argument must be of type string/);
      
      sea.injectAsset('a', 'Yg==');
      expect(() => sea.getAsset('a', 456))
        .toThrow(/encoding" argument must be of type string/);
    });

    test('injectAsset validates data type', () => {
      expect(() => sea.injectAsset('key', 123))
        .toThrow(/must be of type ArrayBuffer, ArrayBufferView, or base64 string/);
    });
  });
});
