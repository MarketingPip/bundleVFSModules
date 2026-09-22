import { Buffer } from 'buffer';
import zlib, {
  gzipSync, gunzipSync,
  deflateSync, inflateSync,
  deflateRawSync, inflateRawSync,
  unzipSync,
  gzip, gunzip,
  deflate, inflate,
  Deflate, Inflate,
  Gzip, Gunzip,
  DeflateRaw, InflateRaw,
  constants, codes,
  crc32,
} from '../src/zlib.js';

describe('zlib (dependency-free ESM)', () => {
  const payload = 'The quick brown fox jumps over the lazy dog. 🦊';
  const bufferPayload = Buffer.from(payload);

  describe('constants and codes', () => {
    test('constants are frozen', () => {
      expect(Object.isFrozen(constants)).toBe(true);
      expect(constants.Z_OK).toBe(0);
      expect(constants.Z_STREAM_END).toBe(1);
      expect(constants.Z_BEST_COMPRESSION).toBe(9);
    });

    test('codes are frozen and bidirectional', () => {
      expect(Object.isFrozen(codes)).toBe(true);
      expect(codes[0]).toBe('Z_OK');
      expect(codes[1]).toBe('Z_STREAM_END');
    });

    test('default export is frozen', () => {
      expect(Object.isFrozen(zlib)).toBe(true);
      expect(zlib.constants).toBe(constants);
    });
  });

  describe('crc32', () => {
    test('crc32("hello") === 907060870', () => {
      expect(crc32('hello')).toBe(907060870);
    });

    test('crc32 of empty is 0', () => {
      expect(crc32('')).toBe(0);
      expect(crc32(Buffer.alloc(0))).toBe(0);
    });
  });

  describe('deflate/inflate sync roundtrips', () => {
    test('deflateSync -> inflateSync', () => {
      const compressed = deflateSync(bufferPayload, { level: 9 });
      const decompressed = inflateSync(compressed);
      expect(decompressed.toString()).toBe(payload);
      expect(Buffer.isBuffer(compressed)).toBe(true);
    });

    test('deflateSync level 0 (stored)', () => {
      const compressed = deflateSync(bufferPayload, { level: 0 });
      const decompressed = inflateSync(compressed);
      expect(decompressed.toString()).toBe(payload);
    });

    test('deflateRawSync -> inflateRawSync', () => {
      const compressed = deflateRawSync(bufferPayload);
      const decompressed = inflateRawSync(compressed);
      expect(decompressed.toString()).toBe(payload);
    });

    test('gzipSync -> gunzipSync', () => {
      const compressed = gzipSync(payload);
      const decompressed = gunzipSync(compressed);
      expect(decompressed.toString()).toBe(payload);
      expect(Buffer.isBuffer(compressed)).toBe(true);
    });

    test('unzipSync handles gzip and deflate', () => {
      const gz = gzipSync(payload);
      expect(unzipSync(gz).toString()).toBe(payload);
      const df = deflateSync(bufferPayload);
      expect(unzipSync(df).toString()).toBe(payload);
    });

    test('roundtrip with larger data', () => {
      const big = Buffer.from('abc123'.repeat(10000));
      const compressed = deflateSync(big);
      const decompressed = inflateSync(compressed);
      expect(Buffer.compare(big, decompressed)).toBe(0);
    });
  });

  describe('async convenience methods', () => {
    test('gzip -> gunzip callback', (done) => {
      gzip(payload, (err, compressed) => {
        expect(err).toBeNull();
        gunzip(compressed, (err2, decompressed) => {
          expect(err2).toBeNull();
          expect(decompressed.toString()).toBe(payload);
          done();
        });
      });
    });

    test('deflate -> inflate callback', (done) => {
      deflate(bufferPayload, (err, compressed) => {
        expect(err).toBeNull();
        inflate(compressed, (err2, decompressed) => {
          expect(err2).toBeNull();
          expect(decompressed.toString()).toBe(payload);
          done();
        });
      });
    });
  });

  describe('stream classes', () => {
    test('Deflate -> Inflate stream roundtrip', (done) => {
      const def = new Deflate({ level: 6 });
      const inf = new Inflate({});
      const chunks = [];
      inf.on('data', (c) => chunks.push(c));
      inf.on('end', () => {
        const result = Buffer.concat(chunks);
        expect(result.toString()).toBe(payload);
        done();
      });
      inf.on('error', done);
      def.on('data', (c) => inf.write(c));
      def.on('end', () => inf.end());
      def.on('error', done);
      def.write(bufferPayload);
      def.end();
    });

    test('Gzip -> Gunzip stream roundtrip', (done) => {
      const gz = new Gzip();
      const gunz = new Gunzip();
      const chunks = [];
      gunz.on('data', (c) => chunks.push(c));
      gunz.on('end', () => {
        expect(Buffer.concat(chunks).toString()).toBe(payload);
        done();
      });
      gunz.on('error', done);
      gz.on('data', (c) => gunz.write(c));
      gz.on('end', () => gunz.end());
      gz.on('error', done);
      gz.end(bufferPayload);
    });

    test('DeflateRaw -> InflateRaw stream roundtrip', (done) => {
      const def = new DeflateRaw();
      const inf = new InflateRaw();
      const chunks = [];
      inf.on('data', (c) => chunks.push(c));
      inf.on('end', () => {
        expect(Buffer.concat(chunks).toString()).toBe(payload);
        done();
      });
      inf.on('error', done);
      def.on('data', (c) => inf.write(c));
      def.on('end', () => inf.end());
      def.on('error', done);
      def.end(bufferPayload);
    });
  });

  describe('error handling', () => {
    test('inflateSync throws on invalid data', () => {
      expect(() => inflateSync(Buffer.from([0x00, 0x01, 0x02]))).toThrow();
    });

    test('gunzipSync throws on invalid gzip', () => {
      expect(() => gunzipSync(Buffer.from('not gzip data'))).toThrow();
    });
  });

  describe('brotli and zstd (pass-through, not real codecs)', () => {
    // These are honest pass-throughs, not real Brotli/Zstd implementations.
    // They accept input and return it unchanged (no compression).
    test('brotliCompressSync passes through', () => {
      const input = Buffer.from('hello brotli');
      const output = zlib.brotliCompressSync(input);
      expect(Buffer.compare(input, output)).toBe(0);
    });

    test('brotliDecompressSync passes through', () => {
      const input = Buffer.from('hello brotli');
      const output = zlib.brotliDecompressSync(input);
      expect(Buffer.compare(input, output)).toBe(0);
    });
  });
});
