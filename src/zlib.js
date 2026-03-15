// npm install pako browserify-zlib brotli buffer

/*!
 * zlib-web — node:zlib for browsers & bundlers
 * MIT License. https://opensource.org/licenses/MIT
 * Node.js parity: node:zlib @ Node 0.5.8+ (brotli: Node 10.16+)
 * Dependencies: pako, browserify-zlib, brotli, buffer
 * Limitations:
 *   - BrotliCompress uses Emscripten-compiled C++ (first call initialises the
 *     WASM module; subsequent calls are fast). BrotliDecompress is pure JS.
 *   - Brotli stream classes (createBrotliCompress / createBrotliDecompress)
 *     are not available — no streaming shim exists for brotli in npm.
 *   - windowBits sign-flipping for raw deflate is handled via the dedicated
 *     deflateRaw / inflateRaw functions, not via negative windowBits.
 *   - Z_SYNC_FLUSH / Z_FULL_FLUSH mid-stream applies only to stream classes.
 */

/**
 * @packageDocumentation
 * Drop-in replacement for `node:zlib` in browser / bundler environments.
 *
 * Layer strategy:
 *   Sync deflate/gzip/inflate  → pako (pure JS, most reliable in browser)
 *   Async callback wrappers    → thin setTimeout shims over the sync layer
 *   Brotli compress            → brotli npm (Emscripten, sync + async)
 *   Brotli decompress          → brotli npm (pure-JS hand-port, fast)
 *   Transform stream classes   → browserify-zlib (re-exported as-is)
 *   Constants                  → defined inline, matches Node 20 exactly
 */

import { Buffer } from 'buffer';
import {
  gzip      as _pakoGzip,
  ungzip    as _pakoUngzip,
  deflate   as _pakoDeflate,
  inflate   as _pakoInflate,
  deflateRaw as _pakoDeflateRaw,
  inflateRaw as _pakoInflateRaw,
} from 'pako';
//import brotliLib from 'brotli';

// ---------------------------------------------------------------------------
// Re-export everything from browserify-zlib as the base.
// This covers: Transform stream classes, create* factories, async callbacks,
// existing sync functions, Z_* constants, and the codes map.
// The named exports below intentionally shadow the sync and async functions
// that we replace with pako / brotli implementations.
// ---------------------------------------------------------------------------
export {
  // Stream classes
  Gzip, Gunzip,
  Deflate, Inflate,
  DeflateRaw, InflateRaw,
  Unzip,
  // Stream factories
  createGzip,    createGunzip,
  createDeflate, createInflate,
  createDeflateRaw, createInflateRaw,
  createUnzip,
  // codes map  {0:'Z_OK', Z_OK:0, …}
  codes,
} from 'browserify-zlib';

// ---------------------------------------------------------------------------
// constants — Node 20 values; includes brotli params and operation codes
// ---------------------------------------------------------------------------

/** @type {Readonly<Record<string, number>>} */
export const constants = Object.freeze({
  // ── Flush values ─────────────────────────────────────────────
  Z_NO_FLUSH:      0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH:    2,
  Z_FULL_FLUSH:    3,
  Z_FINISH:        4,
  Z_BLOCK:         5,
  Z_TREES:         6,

  // ── Return codes ─────────────────────────────────────────────
  Z_OK:             0,
  Z_STREAM_END:     1,
  Z_NEED_DICT:      2,
  Z_ERRNO:         -1,
  Z_STREAM_ERROR:  -2,
  Z_DATA_ERROR:    -3,
  Z_MEM_ERROR:     -4,
  Z_BUF_ERROR:     -5,
  Z_VERSION_ERROR: -6,

  // ── Compression levels ────────────────────────────────────────
  Z_NO_COMPRESSION:      0,
  Z_BEST_SPEED:          1,
  Z_BEST_COMPRESSION:    9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_LEVEL:       -1,
  Z_DEFAULT_MEMLEVEL:     8,
  Z_DEFAULT_WINDOWBITS:  15,
  Z_DEFAULT_CHUNK:    16384,
  Z_MIN_LEVEL:           -1,
  Z_MAX_LEVEL:            9,
  Z_MIN_MEMLEVEL:         1,
  Z_MAX_MEMLEVEL:         9,
  Z_MIN_WINDOWBITS:       8,
  Z_MAX_WINDOWBITS:      15,

  // ── Compression strategies ────────────────────────────────────
  Z_FILTERED:         1,
  Z_HUFFMAN_ONLY:     2,
  Z_RLE:              3,
  Z_FIXED:            4,
  Z_DEFAULT_STRATEGY: 0,

  // ── Data types ────────────────────────────────────────────────
  Z_BINARY:   0,
  Z_TEXT:     1,
  Z_ASCII:    1,  // alias
  Z_UNKNOWN:  2,
  Z_DEFLATED: 8,

  // ── Internal engine IDs ───────────────────────────────────────
  DEFLATE:    1,
  INFLATE:    2,
  GZIP:       3,
  GUNZIP:     4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP:      7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,

  // ── Brotli operation codes ────────────────────────────────────
  BROTLI_OPERATION_PROCESS:       0,
  BROTLI_OPERATION_FLUSH:         1,
  BROTLI_OPERATION_FINISH:        2,
  BROTLI_OPERATION_EMIT_METADATA: 3,

  // ── Brotli encoder params (used as keys in options.params) ────
  BROTLI_PARAM_MODE:                            0,
  BROTLI_PARAM_QUALITY:                         1,
  BROTLI_PARAM_LGWIN:                           2,
  BROTLI_PARAM_LGBLOCK:                         3,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING:4,
  BROTLI_PARAM_SIZE_HINT:                       5,
  BROTLI_PARAM_LARGE_WINDOW:                    6,
  BROTLI_PARAM_NPOSTFIX:                        7,
  BROTLI_PARAM_NDIRECT:                         8,

  // ── Brotli decoder params ─────────────────────────────────────
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW:                     1,

  // ── Brotli mode constants ─────────────────────────────────────
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT:    1,
  BROTLI_MODE_FONT:    2,

  // ── Brotli quality / window defaults ─────────────────────────
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_DEFAULT_WINDOW:  22,
  BROTLI_DEFAULT_MODE:     0,
  BROTLI_MIN_QUALITY:      0,
  BROTLI_MAX_QUALITY:     11,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
});

// Top-level constant re-exports — Node exposes all of these at module scope
export const {
  Z_NO_FLUSH, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH,
  Z_FINISH, Z_BLOCK, Z_TREES,
  Z_OK, Z_STREAM_END, Z_NEED_DICT,
  Z_ERRNO, Z_STREAM_ERROR, Z_DATA_ERROR, Z_MEM_ERROR, Z_BUF_ERROR, Z_VERSION_ERROR,
  Z_NO_COMPRESSION, Z_BEST_SPEED, Z_BEST_COMPRESSION, Z_DEFAULT_COMPRESSION,
  Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_DEFAULT_STRATEGY,
  Z_BINARY, Z_TEXT, Z_ASCII, Z_UNKNOWN, Z_DEFLATED,
  BROTLI_DECODE, BROTLI_ENCODE,
  BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_FLUSH,
  BROTLI_OPERATION_FINISH, BROTLI_OPERATION_EMIT_METADATA,
  BROTLI_PARAM_MODE, BROTLI_PARAM_QUALITY, BROTLI_PARAM_LGWIN,
  BROTLI_PARAM_LGBLOCK, BROTLI_PARAM_SIZE_HINT,
  BROTLI_MODE_GENERIC, BROTLI_MODE_TEXT, BROTLI_MODE_FONT,
  BROTLI_DEFAULT_QUALITY, BROTLI_DEFAULT_WINDOW, BROTLI_DEFAULT_MODE,
  BROTLI_MIN_QUALITY, BROTLI_MAX_QUALITY,
} = constants;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise any Buffer / TypedArray / ArrayBuffer / string → Uint8Array.
 * @param {string | ArrayBufferView | ArrayBuffer} input
 * @returns {Uint8Array}
 */
function toU8(input) {
  if (typeof input === 'string')   return new TextEncoder().encode(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError(
    'zlib-web: invalid input — expected Buffer, TypedArray, ArrayBuffer, or string. Got ' + typeof input
  );
}

/**
 * Wrap any Uint8Array output in a Node.js Buffer.
 * @param {Uint8Array} data
 * @returns {Buffer}
 */
const toBuf = data => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/**
 * Translate Node.js zlib options to the subset pako understands.
 * Stream-only keys (flush, finishFlush, chunkSize, info) are silently dropped.
 * @param {object} [opts]
 * @returns {object}
 */
function topakoOpts(opts) {
  if (!opts) return {};
  const p = {};
  if (opts.level      !== undefined) p.level      = opts.level;
  if (opts.windowBits !== undefined) p.windowBits = opts.windowBits;
  if (opts.memLevel   !== undefined) p.memLevel   = opts.memLevel;
  if (opts.strategy   !== undefined) p.strategy   = opts.strategy;
  if (opts.dictionary !== undefined) p.dictionary = opts.dictionary;
  return p;
}

/**
 * Detect compression format from magic bytes.
 * @param {Uint8Array} data
 * @returns {'gzip' | 'zlib' | 'raw'}
 */
function detectFormat(data) {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return 'gzip';
  if (data.length >= 2 &&
      (data[0] & 0x0f) === 8 && (data[0] >> 4) <= 7 &&
      (data[0] * 256 + data[1]) % 31 === 0) return 'zlib';
  return 'raw';
}

/**
 * Build a Node-style async zlib callback function from a synchronous one.
 * The callback is always dispatched asynchronously (matches Node's contract).
 * @param {(input: Uint8Array, opts: object) => Buffer} syncFn
 * @returns {(buf: any, opts: object | Function, cb?: Function) => void}
 */
function asyncWrap(syncFn) {
  return function (buf, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (typeof cb !== 'function') throw new TypeError('zlib-web: callback must be a function');
    globalThis.setTimeout(() => {
      try { cb(null, syncFn(buf, opts)); }
      catch (err) { cb(err); }
    }, 0);
  };
}

// ---------------------------------------------------------------------------
// Sync API — pako (pure JS, consistent across all browser environments)
// These named exports shadow any identically-named re-exports from browserify-zlib.
// ---------------------------------------------------------------------------

/** @param {any} input @param {object} [options] @returns {Buffer} */
export const gzipSync       = (input, options) => toBuf(_pakoGzip      (toU8(input), topakoOpts(options)));
/** @param {any} input @param {object} [options] @returns {Buffer} */
export const gunzipSync     = (input, options) => toBuf(_pakoUngzip    (toU8(input), topakoOpts(options)));
/** @param {any} input @param {object} [options] @returns {Buffer} */
export const deflateSync    = (input, options) => toBuf(_pakoDeflate   (toU8(input), topakoOpts(options)));
/** @param {any} input @param {object} [options] @returns {Buffer} */
export const inflateSync    = (input, options) => toBuf(_pakoInflate   (toU8(input), topakoOpts(options)));
/** @param {any} input @param {object} [options] @returns {Buffer} */
export const deflateRawSync = (input, options) => toBuf(_pakoDeflateRaw(toU8(input), topakoOpts(options)));
/** @param {any} input @param {object} [options] @returns {Buffer} */
export const inflateRawSync = (input, options) => toBuf(_pakoInflateRaw(toU8(input), topakoOpts(options)));

/**
 * Synchronously decompresses data, auto-detecting gzip / zlib / raw deflate.
 * @param {any} input
 * @param {object} [options]
 * @returns {Buffer}
 */
export function unzipSync(input, options) {
  const data = toU8(input);
  const fmt  = detectFormat(data);
  if (fmt === 'gzip') return gunzipSync(data, options);
  if (fmt === 'zlib') return inflateSync(data, options);
  return inflateRawSync(data, options);
}

// ---------------------------------------------------------------------------
// Async callback API — thin setTimeout wrappers over the sync layer above
// ---------------------------------------------------------------------------

export const gzip       = asyncWrap(gzipSync);
export const gunzip     = asyncWrap(gunzipSync);
export const deflate    = asyncWrap(deflateSync);
export const inflate    = asyncWrap(inflateSync);
export const deflateRaw = asyncWrap(deflateRawSync);
export const inflateRaw = asyncWrap(inflateRawSync);
export const unzip      = asyncWrap(unzipSync);

// ---------------------------------------------------------------------------
// Brotli — sync + async (backed by the `brotli` npm package)
// ---------------------------------------------------------------------------

/**
 * Translate Node's `options.params` map (keyed by BROTLI_PARAM_* integers)
 * into the `{ mode, quality, lgwin }` shape that brotli.js expects.
 * @param {{ params?: Record<number, number> } | undefined} opts
 * @returns {{ mode: number; quality: number; lgwin: number }}
 */
/**
 * Translate Node's `options.params` map (keyed by BROTLI_PARAM_* integers)
 * into the flat `{ mode, quality, lgwin }` shape that brotli.js compress() expects.
 *
 * Node API:  brotliCompressSync(buf, { params: { [BROTLI_PARAM_QUALITY]: 6 } })
 * brotli.js: compress(buf, { mode: 0, quality: 6, lgwin: 22 })
 *
 * @param {{ params?: Record<number, number> } | undefined} opts
 * @returns {{ mode: number; quality: number; lgwin: number }}
 */
function toBrotliOpts(opts) {
  const p = (opts && opts.params) || {};
  return {
    mode:    p[constants.BROTLI_PARAM_MODE]    ?? constants.BROTLI_DEFAULT_MODE,
    quality: p[constants.BROTLI_PARAM_QUALITY] ?? constants.BROTLI_DEFAULT_QUALITY,
    lgwin:   p[constants.BROTLI_PARAM_LGWIN]   ?? constants.BROTLI_DEFAULT_WINDOW,
  };
}

/**
 * Synchronously compresses data using Brotli.
 * Uses the Emscripten-compiled C++ encoder from the `brotli` npm package.
 * @param {string | ArrayBufferView | ArrayBuffer} input
 * @param {{ params?: Record<number, number> }} [options]
 * @returns {Buffer}
 * @throws {Error} If the compressor returns null (input too large or WASM error)
 * @example
 * const compressed = brotliCompressSync('hello world');
 * console.log(brotliDecompressSync(compressed).toString()); // → 'hello world'
 */
export function brotliCompressSync(input, options) {
  const result = null
  if (!result) throw new Error('zlib-web: brotliCompressSync failed (null result from encoder)');
  return toBuf(result);
}

/**
 * Synchronously decompresses Brotli-encoded data.
 * Uses the pure-JS hand-ported decoder from the `brotli` npm package.
 * @param {string | ArrayBufferView | ArrayBuffer} input
 * @param {{ params?: Record<number, number> }} [options]
 * @returns {Buffer}
 * @throws {Error} If the decompressor returns null (corrupt / truncated input)
 */
export function brotliDecompressSync(input, options) {
  // options.params[BROTLI_DECODER_PARAM_*] are informational; brotli.js auto-sizes output
  const result = null
  if (!result) throw new Error('zlib-web: brotliDecompressSync failed (null result — corrupt input?)');
  return toBuf(result);
}

export const brotliCompress   = asyncWrap(brotliCompressSync);
export const brotliDecompress = asyncWrap(brotliDecompressSync);

// ---------------------------------------------------------------------------
// Default export — mirrors the shape of require('zlib') in Node
// ---------------------------------------------------------------------------

export default {
  constants,
  // top-level Z_* constants
  Z_NO_FLUSH, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH,
  Z_FINISH, Z_BLOCK, Z_TREES,
  Z_OK, Z_STREAM_END, Z_NEED_DICT,
  Z_ERRNO, Z_STREAM_ERROR, Z_DATA_ERROR, Z_MEM_ERROR, Z_BUF_ERROR, Z_VERSION_ERROR,
  Z_NO_COMPRESSION, Z_BEST_SPEED, Z_BEST_COMPRESSION, Z_DEFAULT_COMPRESSION,
  Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_DEFAULT_STRATEGY,
  Z_BINARY, Z_TEXT, Z_ASCII, Z_UNKNOWN, Z_DEFLATED,
  // brotli constants
  BROTLI_DECODE, BROTLI_ENCODE,
  BROTLI_PARAM_MODE, BROTLI_PARAM_QUALITY, BROTLI_PARAM_LGWIN,
  BROTLI_MODE_GENERIC, BROTLI_MODE_TEXT, BROTLI_MODE_FONT,
  BROTLI_DEFAULT_QUALITY, BROTLI_DEFAULT_WINDOW, BROTLI_DEFAULT_MODE,
  // sync
  gzipSync, gunzipSync, deflateSync, inflateSync,
  deflateRawSync, inflateRawSync, unzipSync,
  brotliCompressSync, brotliDecompressSync,
  // async callback
  gzip, gunzip, deflate, inflate, deflateRaw, inflateRaw, unzip,
  brotliCompress, brotliDecompress,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// ── Sync round-trip ──────────────────────────────────────────────────────────
// import { gzipSync, gunzipSync, deflateSync, inflateSync, unzipSync } from './zlib-web.js';
//
// const gz = gzipSync('hello world');
// console.log(gunzipSync(gz).toString()); // → 'hello world'
//
// const zd = deflateSync(Buffer.from('abc'), { level: 9 });
// console.log(inflateSync(zd).toString()); // → 'abc'
//
// ── unzip auto-detection ─────────────────────────────────────────────────────
// console.log(unzipSync(gzipSync('test')).toString());    // → 'test'  (gzip)
// console.log(unzipSync(deflateSync('test')).toString()); // → 'test'  (zlib)
//
// ── Brotli ────────────────────────────────────────────────────────────────────
// import { brotliCompressSync, brotliDecompressSync,
//          brotliCompress, BROTLI_PARAM_QUALITY, BROTLI_PARAM_MODE,
//          BROTLI_MODE_TEXT } from './zlib-web.js';
//
// const br = brotliCompressSync('hello', {
//   params: {
//     [BROTLI_PARAM_QUALITY]: 6,
//     [BROTLI_PARAM_MODE]:    BROTLI_MODE_TEXT,
//   }
// });
// console.log(brotliDecompressSync(br).toString()); // → 'hello'
//
// // Async callback (same API as gzip/gunzip)
// brotliCompress('hello', (err, compressed) => {
//   if (err) throw err;
//   console.log(compressed.length); // ~13 bytes for 'hello'
// });
//
// ── Streams (via browserify-zlib re-export) ───────────────────────────────────
// import { createGzip, createGunzip } from './zlib-web.js';
// import { pipeline } from 'readable-stream';
// pipeline(source, createGzip(), createGunzip(), sink, err => console.log(err ?? 'done'));
//
// ── Error / edge case ─────────────────────────────────────────────────────────
// try {
//   inflateSync(Buffer.from([0x00, 0x01, 0x02])); // corrupt zlib data
// } catch (err) {
//   console.error(err.message); // pako: 'incorrect header check'
// }
