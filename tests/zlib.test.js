import { Buffer } from 'buffer';
import zlib, {
  gzipSync, gunzipSync,
  deflateSync, inflateSync,
  deflateRawSync, inflateRawSync,
  unzipSync,
  brotliCompressSync, brotliDecompressSync,
  gzip,
  constants
} from '../src/zlib.js';

describe('zlib-web', () => {
  const payload = 'The quick brown fox jumps over the lazy dog. 🦊';
  const bufferPayload = Buffer.from(payload);

  describe('Sync API (pako-based)', () => {
    test('gzipSync -> gunzipSync roundtrip', () => {
      const compressed = gzipSync(payload);
      const decompressed = gunzipSync(compressed);
      expect(decompressed.toString()).toBe(payload);
      expect(Buffer.isBuffer(compressed)).toBe(true);
    });

    test('deflateSync -> inflateSync roundtrip', () => {
      const compressed = deflateSync(bufferPayload, { level: 9 });
      const decompressed = inflateSync(compressed);
      expect(decompressed.toString()).toBe(payload);
    });

    test('deflateRawSync -> inflateRawSync roundtrip', () => {
      const compressed = deflateRawSync(payload);
      const decompressed = inflateRawSync(compressed);
      expect(decompressed.toString()).toBe(payload);
    });

    test('unzipSync auto-detects formats', () => {
      const gz = gzipSync(payload);
      const zz = deflateSync(payload);
      const raw = deflateRawSync(payload);

      expect(unzipSync(gz).toString()).toBe(payload);
      expect(unzipSync(zz).toString()).toBe(payload);
      expect(unzipSync(raw).toString()).toBe(payload);
    });

    test('throws on corrupt data', () => {
      const corrupt = Buffer.from([0x00, 0x11, 0x22, 0x33]);
      expect(() => inflateSync(corrupt)).toThrow();
    });
  });

  describe('Async Callback API', () => {
    test('gzip provides result via callback', (done) => {
      gzip(payload, (err, result) => {
        expect(err).toBeNull();
        expect(Buffer.isBuffer(result)).toBe(true);
        expect(gunzipSync(result).toString()).toBe(payload);
        done();
      });
    });

    test('handles options argument correctly', (done) => {
      gzip(payload, { level: 1 }, (err, result) => {
        expect(err).toBeNull();
        expect(gunzipSync(result).toString()).toBe(payload);
        done();
      });
    });
  });

  describe('Brotli (Current Implementation)', () => {
    // These tests reflect your current code where result = null
    test('brotliCompressSync throws error on null result', () => {
      expect(() => brotliCompressSync(payload)).toThrow(/brotliCompressSync failed/);
    });

    test('brotliDecompressSync throws error on null result', () => {
      expect(() => brotliDecompressSync(payload)).toThrow(/brotliDecompressSync failed/);
    });
  });

  describe('Constants and Exports', () => {
    test('exposed constants match Node.js expectations', () => {
      expect(constants.Z_OK).toBe(0);
      expect(constants.BROTLI_PARAM_QUALITY).toBe(1);
      expect(zlib.Z_BEST_COMPRESSION).toBe(9);
    });

    test('default export contains expected functions', () => {
      expect(typeof zlib.gzipSync).toBe('function');
      expect(typeof zlib.brotliCompress).toBe('function');
    });
  });

  describe('Input Normalization (toU8)', () => {
    test('accepts string, Buffer, and Uint8Array', () => {
      const strRes = gzipSync("test");
      const bufRes = gzipSync(Buffer.from("test"));
      const u8Res = gzipSync(new Uint8Array([116, 101, 115, 116]));
      
      expect(gunzipSync(strRes).toString()).toBe("test");
      expect(gunzipSync(bufRes).toString()).toBe("test");
      expect(gunzipSync(u8Res).toString()).toBe("test");
    });

    test('throws TypeError on invalid input', () => {
      expect(() => gzipSync(12345)).toThrow(TypeError);
      expect(() => gzipSync({ foo: 'bar' })).toThrow(TypeError);
    });
  });
});
