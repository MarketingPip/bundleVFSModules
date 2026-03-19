import shim, * as namedExports from '../src/buffer/js';

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
    test('should return true for valid ASCII strings', () => {
      expect(shim.isAscii('Hello World!')).toBe(true);
    });

    test('should return false for non-ASCII characters', () => {
      // '©' is 0xA9 in Latin-1, or 0xC2 0xA9 in UTF-8
      expect(shim.isAscii('Hello ©')).toBe(false);
    });

    test('should handle Buffer input', () => {
      const buf = shim.Buffer.from([0x41, 0x42]); // "AB"
      expect(shim.isAscii(buf)).toBe(true);
    });
  });

  describe('isUtf8()', () => {
    test('should return true for valid UTF-8', () => {
      expect(shim.isUtf8('🔥')).toBe(true);
    });

    test('should return false for invalid UTF-8 sequences', () => {
      // 0xFF is an invalid start byte in UTF-8
      const invalid = shim.Buffer.from([0xFF, 0xAA]);
      expect(shim.isUtf8(invalid)).toBe(false);
    });
  });

  describe('transcode()', () => {
    test('should transcode between encodings', () => {
      const source = 'hello';
      const transcoded = shim.transcode(source, 'utf8', 'base64');
      
      // "hello" in base64 is "aGVsbG8="
      expect(transcoded.toString()).toBe(shim.Buffer.from(source).toString('base64'));
    });
  });

  describe('Safety Stubs', () => {
    test('resolveObjectURL should throw a clear error', () => {
      expect(() => shim.resolveObjectURL()).toThrow('not implemented');
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
