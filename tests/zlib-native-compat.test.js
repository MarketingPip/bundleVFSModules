import { Buffer } from 'buffer';
import { createRequire } from 'module';
import {
  deflateSync, inflateSync,
  gzipSync, gunzipSync,
  deflateRawSync, inflateRawSync,
  unzipSync,
} from '../src/zlib.js';

// Differential tests against the real native node:zlib. These only run
// under Node; in a browser lane without node:zlib they skip gracefully.
const require = createRequire(import.meta.url);
let native = null;
try {
  native = require('node:zlib');
} catch {
  native = null;
}

(native ? describe : describe.skip)('zlib native differential (pako vs node:zlib)', () => {
  const payload = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(200));

  test('native accepts our deflate output (levels 0/1/6/9)', () => {
    for (const level of [0, 1, 6, 9]) {
      const ours = deflateSync(payload, { level });
      expect(Buffer.compare(native.inflateSync(ours), payload)).toBe(0);
    }
  });

  test('we accept native deflate output', () => {
    for (const level of [0, 1, 6, 9]) {
      const theirs = native.deflateSync(payload, { level });
      expect(Buffer.compare(inflateSync(theirs), payload)).toBe(0);
    }
  });

  test('native accepts our gzip output; we accept native gzip output', () => {
    expect(Buffer.compare(native.gunzipSync(gzipSync(payload)), payload)).toBe(0);
    expect(Buffer.compare(gunzipSync(native.gzipSync(payload)), payload)).toBe(0);
  });

  test('raw cross-compatibility both ways', () => {
    expect(Buffer.compare(native.inflateRawSync(deflateRawSync(payload)), payload)).toBe(0);
    expect(Buffer.compare(inflateRawSync(native.deflateRawSync(payload)), payload)).toBe(0);
  });

  test('deflate output is byte-identical to native zlib', () => {
    // pako is a faithful zlib port; framing must match exactly.
    for (const level of [1, 6, 9]) {
      expect(deflateSync(payload, { level }).equals(native.deflateSync(payload, { level }))).toBe(true);
    }
    expect(deflateRawSync(payload).equals(native.deflateRawSync(payload))).toBe(true);
  });

  test('unzip accepts native gzip and zlib streams', () => {
    expect(unzipSync(native.gzipSync(payload)).equals(payload)).toBe(true);
    expect(unzipSync(native.deflateSync(payload)).equals(payload)).toBe(true);
  });

  test('dictionary output is accepted by native with the same dictionary', () => {
    const dict = Buffer.from('common prefix data ');
    const input = Buffer.from('common prefix data hello world');
    const ours = deflateSync(input, { dictionary: dict });
    expect(Buffer.compare(native.inflateSync(ours, { dictionary: dict }), input)).toBe(0);
  });
});
