import shim, * as namedExports from '../src/buffer.js';

describe('Buffer Shim Compliance', () => {
  
  describe('Export Integrity', () => {
    test('default export should match named exports', () => {
      expect(shim.Buffer).toBe(namedExports.Buffer);
      expect(shim.isAscii).toBe(namedExports.isAscii);
      expect(shim.constants.MAX_LENGTH).toBe(namedExports.kMaxLength);
    });

    test('should export core Node.js Buffer properties', () => {
      expect(shim.Buffer).toBeDefined();
      expect(typeof shim.kMaxLength).toBe('number');
      expect(shim.INSPECT_MAX_BYTES).toBeDefined();
    });
  });

  describe('isAscii()', () => {
    test('should throw ERR_INVALID_ARG_TYPE for string input (matches real Node)', () => {
      expect(() => shim.isAscii('Hello World!')).toThrow(/must be an instance of/);
    });

    test('should throw ERR_INVALID_ARG_TYPE for non-ASCII string input', () => {
      // '©' is 0xA9 in Latin-1, or 0xC2 0xA9 in UTF-8 — still a string, still throws
      expect(() => shim.isAscii('Hello ©')).toThrow(/must be an instance of/);
    });

    test('should handle Buffer input', () => {
      const buf = shim.Buffer.from([0x41, 0x42]); // "AB"
      expect(shim.isAscii(buf)).toBe(true);
    });
  });

  describe('isUtf8()', () => {
    test('should throw ERR_INVALID_ARG_TYPE for string input (matches real Node)', () => {
      expect(() => shim.isUtf8('🔥')).toThrow(/must be an instance of/);
    });

    test('should return false for invalid UTF-8 sequences', () => {
      // 0xFF is an invalid start byte in UTF-8
      const invalid = shim.Buffer.from([0xFF, 0xAA]);
      expect(shim.isUtf8(invalid)).toBe(false);
    });
  });

  describe('transcode()', () => {
    test('should transcode between encodings', () => {
      const source = shim.Buffer.from('hello', 'utf8');
      const transcoded = shim.transcode(source, 'utf8', 'ascii');
      expect(shim.Buffer.isBuffer(transcoded)).toBe(true);
      expect(transcoded.toString()).toBe('hello');
    });

    test('should throw ERR_INVALID_ARG_TYPE for string input (matches real Node)', () => {
      expect(() => shim.transcode('hello', 'utf8', 'base64')).toThrow(/must be an instance of/);
    });
  });

  describe('Safety Stubs', () => {
    test('resolveObjectURL matches real Node when native buffer is available', () => {
      // Real Node implements buffer.resolveObjectURL; our shim delegates to it
      // when process.getBuiltinModule exists. It must not throw 'not implemented'.
      expect(typeof shim.resolveObjectURL).toBe('function');
    });

    test('resolveObjectURL is undefined (not silently broken) in the browser fallback lane', async () => {
      const realGbm = process.getBuiltinModule;
      process.getBuiltinModule = undefined;
      try {
        const fb = await import('../src/buffer.js?fallback=jest');
        // No native buffer in the fallback lane: the lazy getter yields
        // undefined rather than a fake function.
        expect(fb.default.resolveObjectURL).toBeUndefined();
      } finally {
        process.getBuiltinModule = realGbm;
      }
    });
  });

  describe('Web API Mapping', () => {
    test('atob/btoa should be function or undefined depending on environment', () => {
      if (globalThis.atob) {
        expect(typeof shim.atob).toBe('function');
      }
    });

    test('Blob and File should be exported if available', () => {
      // In Node environment, these might be undefined unless using Node 18+
      if (globalThis.Blob) {
        expect(shim.Blob).toBe(globalThis.Blob);
      }
    });
  });
});
