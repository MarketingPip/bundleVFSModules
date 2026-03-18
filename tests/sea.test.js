import { jest, describe, test, expect, beforeEach } from '@jest/globals';

describe('SEA (Single Executable Application) wrapper', () => {
  let sea;

  // Since sea.js runs logic on load, we re-import it for clean state
  beforeEach(async () => {
    jest.resetModules();
    // Ensure the global is undefined by default
    delete global.__SEA_INJECT__;
    sea = await import('../src/sea.js');
  });

  describe('Initial State (Non-SEA)', () => {
    test('isSea() returns false when no assets are present', () => {
      expect(sea.isSea()).toBe(false);
    });

    test('getAssetKeys() throws ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION', () => {
      expect(() => sea.getAssetKeys()).toThrow(/API is only available in single executable/);
      expect(() => sea.getAssetKeys()).toThrow(/ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION/);
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
      view[0] = 99; // Mutate the copy

      const original = new Uint8Array(sea.getRawAsset('data.bin'));
      expect(original[0]).toBe(1); // Original remains unchanged
      expect(view[0]).toBe(99);
    });

    test('getAsset with encoding returns string', () => {
      const text = 'hello';
      sea.injectAsset('msg.txt', btoa(text)); // inject as base64
      
      expect(sea.getAsset('msg.txt', 'utf-8')).toBe(text);
    });
  });

  describe('Global Injection (__SEA_INJECT__)', () => {
    test('decodes base64 assets from global object on load', async () => {
      // Setup global before importing the module
      global.__SEA_INJECT__ = {
        'config.json': btoa(JSON.stringify({ port: 8080 }))
      };

      // Isolate module to trigger the load-time injection logic
      const isolatedSea = await jest.isolateModulesAsync(async () => {
        return await import('../src/sea.js');
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
      delete globalThis.Blob;
      
      sea.injectAsset('test.bin', new Uint8Array([0, 1]));
      expect(() => sea.getAssetAsBlob('test.bin')).toThrow(/Blob is not available/);
      
      globalThis.Blob = originalBlob; // Restore
    });
  });

  describe('Error Handling and Validation', () => {
    test('throws ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND', () => {
      sea.injectAsset('exists.txt', 'YmVlcA=='); // 'beep'
      expect(() => sea.getAsset('missing.txt')).toThrow(/Cannot find asset/);
      expect(() => sea.getAsset('missing.txt')).toThrow(/ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND/);
    });

    test('validates argument types', () => {
      expect(() => sea.getRawAsset(123)).toThrow(/must be of type string/);
      expect(() => sea.getRawAsset(123)).toThrow(/ERR_INVALID_ARG_TYPE/);
      
      sea.injectAsset('a', 'Yg==');
      expect(() => sea.getAsset('a', 456)).toThrow(/encoding" argument must be of type string/);
    });

    test('injectAsset validates data type', () => {
      expect(() => sea.injectAsset('key', 123)).toThrow(/must be of type ArrayBuffer, ArrayBufferView, or base64 string/);
    });
  });
});
