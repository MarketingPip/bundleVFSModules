// Export-surface parity: src/zlib.js  <->  node:zlib
// captured from real Node v24.20.0 (node:zlib)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
// The 8 Zip names are Node 26 additions (the ZIP archive API, 26.8.0),
// implemented ahead of the v24.20.0 capture — same forward-extra pattern as
// the Wave 1 util lane's debounce/throttle/markPromiseAsHandled.
import * as shim from "../src/zlib.js";

const EXPECTED = [
  "BrotliCompress",
  "BrotliDecompress",
  "Deflate",
  "DeflateRaw",
  "Gunzip",
  "Gzip",
  "Inflate",
  "InflateRaw",
  "Unzip",
  "ZipBuffer",
  "ZipEntry",
  "ZipFile",
  "ZstdCompress",
  "ZstdDecompress",
  "brotliCompress",
  "brotliCompressSync",
  "brotliDecompress",
  "brotliDecompressSync",
  "codes",
  "constants",
  "crc32",
  "createBrotliCompress",
  "createBrotliDecompress",
  "createDeflate",
  "createDeflateRaw",
  "createGunzip",
  "createGzip",
  "createInflate",
  "createInflateRaw",
  "createUnzip",
  "createZipArchive",
  "createZipArchiveSync",
  "createZstdCompress",
  "createZstdDecompress",
  "default",
  "deflate",
  "deflateRaw",
  "deflateRawSync",
  "deflateSync",
  "getMaxZipContentSize",
  "gunzip",
  "gunzipSync",
  "gzip",
  "gzipSync",
  "inflate",
  "inflateRaw",
  "inflateRawSync",
  "inflateSync",
  "setMaxZipContentSize",
  "unzip",
  "unzipSync",
  "zipFiles",
  "zstdCompress",
  "zstdCompressSync",
  "zstdDecompress",
  "zstdDecompressSync",
];

test("node:zlib export surface matches the defined contract", () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
