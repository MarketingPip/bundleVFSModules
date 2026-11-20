// Port of Node v26.13.1 lib/zlib/iter.js — converted to browser-safe ESM for the
// bundleVFSModules stream shim (Wave 3 lane L6). Function bodies are
// byte-identical to the Node source except for the import/binding
// rewrites noted in the converter (see /tmp/w3-l6/convert.py) and,
// for transform.js, the bare-native-zlib engine section, which is
// reimplemented on the shim's zlib (src/zlib.js).
'use strict';

// Public entry point for the iterable compression/decompression API.
// Usage: require('zlib/iter') or require('node:zlib/iter')
// Requires: --experimental-stream-iter

import { emitExperimentalWarning } from "./stream/iter/internal-util.js";
emitExperimentalWarning('zlib/iter');

import { compressGzip, compressGzipSync, compressDeflate, compressDeflateSync, compressBrotli, compressBrotliSync, compressZstd, compressZstdSync, decompressGzip, decompressGzipSync, decompressDeflate, decompressDeflateSync, decompressBrotli, decompressBrotliSync, decompressZstd, decompressZstdSync } from "./stream/iter/transform.js";

export {
  // Compression transforms (async)
  compressGzip,
  compressDeflate,
  compressBrotli,
  compressZstd,

  // Compression transforms (sync)
  compressGzipSync,
  compressDeflateSync,
  compressBrotliSync,
  compressZstdSync,

  // Decompression transforms (async)
  decompressGzip,
  decompressDeflate,
  decompressBrotli,
  decompressZstd,

  // Decompression transforms (sync)
  decompressGzipSync,
  decompressDeflateSync,
  decompressBrotliSync,
  decompressZstdSync,
};
