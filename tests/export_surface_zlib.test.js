// Export-surface parity: src/zlib.js  <->  node:zlib
// captured from real Node v24.20.0 (node:zlib)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/zlib.js';

const EXPECTED = ["BrotliCompress","BrotliDecompress","Deflate","DeflateRaw","Gunzip","Gzip","Inflate","InflateRaw","Unzip","ZstdCompress","ZstdDecompress","brotliCompress","brotliCompressSync","brotliDecompress","brotliDecompressSync","codes","constants","crc32","createBrotliCompress","createBrotliDecompress","createDeflate","createDeflateRaw","createGunzip","createGzip","createInflate","createInflateRaw","createUnzip","createZstdCompress","createZstdDecompress","default","deflate","deflateRaw","deflateRawSync","deflateSync","gunzip","gunzipSync","gzip","gzipSync","inflate","inflateRaw","inflateRawSync","inflateSync","unzip","unzipSync","zstdCompress","zstdCompressSync","zstdDecompress","zstdDecompressSync"];

test('node:zlib export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
