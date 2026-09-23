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

describe('zlib (pako-backed ESM)', () => {
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

  describe('pako-backed codec behavior', () => {
    const text = 'Pack my box with five dozen liquor jugs! '.repeat(200);
    const data = Buffer.from(text);

    test('compression levels all round-trip; higher levels compress better', () => {
      const sizes = [];
      for (const level of [0, 1, 6, 9]) {
        const c = deflateSync(data, { level });
        expect(inflateSync(c).toString()).toBe(text);
        sizes.push(c.length);
      }
      expect(sizes[0]).toBeGreaterThan(sizes[3]); // stored >> best
      expect(sizes[3]).toBeLessThanOrEqual(sizes[1]);
    });

    test('deflate strategies all round-trip', () => {
      for (const strategy of [
        constants.Z_DEFAULT_STRATEGY,
        constants.Z_FILTERED,
        constants.Z_HUFFMAN_ONLY,
        constants.Z_RLE,
        constants.Z_FIXED,
      ]) {
        const c = deflateSync(data, { strategy });
        expect(inflateSync(c).toString()).toBe(text);
      }
    });

    test('gunzipSync decodes concatenated gzip members', () => {
      const cat = Buffer.concat([gzipSync('one '), gzipSync('two '), gzipSync('three')]);
      expect(gunzipSync(cat).toString()).toBe('one two three');
      expect(unzipSync(cat).toString()).toBe('one two three');
    });

    test('unzipSync stops after the first zlib stream', () => {
      const cat = Buffer.concat([deflateSync('first'), deflateSync('second')]);
      expect(unzipSync(cat).toString()).toBe('first');
    });

    test('gunzipSync ignores zero padding but rejects junk', () => {
      const gz = gzipSync('padded');
      const padded = Buffer.concat([gz, Buffer.alloc(16)]);
      expect(gunzipSync(padded).toString()).toBe('padded');
      const junky = Buffer.concat([gz, Buffer.from([0x1f, 0x8b, 0x00])]);
      expect(() => gunzipSync(junky)).toThrow();
    });

    test('dictionary round-trip and Node-shaped dictionary errors', () => {
      const dict = Buffer.from('common prefix data ');
      const c = deflateSync('common prefix data hello', { dictionary: dict });
      expect(inflateSync(c, { dictionary: dict }).toString()).toBe('common prefix data hello');
      expect(() => inflateSync(c)).toThrow(/Missing dictionary/);
      expect(() => inflateSync(c, { dictionary: Buffer.from('wrong') })).toThrow(/Bad dictionary/);
    });

    test('empty and truncated input report Z_BUF_ERROR', () => {
      for (const bad of [Buffer.alloc(0), gzipSync('x').subarray(0, 10)]) {
        try {
          gunzipSync(bad);
          throw new Error('should have thrown');
        } catch (err) {
          expect(err.code).toBe('Z_BUF_ERROR');
          expect(err.message).toMatch(/unexpected end of file/);
        }
      }
    });

    test('inflateSync rejects gzip data; gunzipSync rejects zlib data', () => {
      expect(() => inflateSync(gzipSync('x'))).toThrow();
      expect(() => gunzipSync(deflateSync('x'))).toThrow();
    });

    test('stream flush emits incremental output', (done) => {
      const def = new Deflate({ level: 6 });
      const inf = new Inflate({});
      const chunks = [];
      let sawDataBeforeEnd = false;
      def.on('data', (c) => inf.write(c));
      def.on('end', () => inf.end());
      inf.on('data', (c) => chunks.push(c));
      inf.on('end', () => {
        expect(Buffer.concat(chunks).toString()).toBe('flush me');
        expect(sawDataBeforeEnd).toBe(true);
        done();
      });
      inf.on('error', done);
      def.on('error', done);
      def.write(Buffer.from('flush '));
      def.flush(() => {
        // data flushed mid-stream must already be decodable
        setImmediate(() => {
          sawDataBeforeEnd = chunks.length > 0;
          def.end(Buffer.from('me'));
        });
      });
    });

    test('params() mid-stream level change stays decodable', (done) => {
      const def = new Deflate({ level: 1 });
      const inf = new Inflate({});
      const chunks = [];
      def.on('data', (c) => inf.write(c));
      def.on('end', () => inf.end());
      inf.on('data', (c) => chunks.push(c));
      inf.on('end', () => {
        expect(Buffer.concat(chunks).toString()).toBe('aaaabbbb');
        done();
      });
      inf.on('error', done);
      def.on('error', done);
      def.write(Buffer.from('aaaa'));
      def.params(9, constants.Z_DEFAULT_STRATEGY, () => {
        def.end(Buffer.from('bbbb'));
      });
    });
  });

  describe('browser lane', () => {
    test('no native delegation: works with process.getBuiltinModule disabled', async () => {
      const orig = process.getBuiltinModule;
      process.getBuiltinModule = () => { throw new Error('no builtins in browser'); };
      try {
        // fresh import proves module init needs no builtins either
        const fresh = await import(`../src/zlib.js?browser-lane=${Date.now()}`);
        const c = fresh.deflateSync('browser lane');
        expect(fresh.inflateSync(c).toString()).toBe('browser lane');
        const g = fresh.gzipSync('browser lane');
        expect(fresh.gunzipSync(g).toString()).toBe('browser lane');
        const r = fresh.deflateRawSync('browser lane');
        expect(fresh.inflateRawSync(r).toString()).toBe('browser lane');
      } finally {
        process.getBuiltinModule = orig;
      }
    });
  });
});
