// src/zlib.js — Browser-first port of Node.js zlib (Node v24 API surface).
//
// Implements the Node v24 zlib API surface (deflate/inflate/gzip/gunzip,
// deflateRaw/inflateRaw/unzip, Brotli facades, Zstd via the vendored
// `zstdify` package, crc32) on top of the maintained `pako` package (a
// faithful JavaScript port of zlib) and a minimal stream implementation.
// No native delegation: the same code runs in the browser sandbox and
// under Node.
//
// Fidelity notes:
// - DEFLATE/inflate/gzip/gunzip/deflateRaw/inflateRaw/unzip are byte-
//   compatible with native zlib via pako, including compression levels,
//   strategies, dictionaries, concatenated gzip members and trailing-
//   garbage rules.
// - `params()` (mid-stream level/strategy changes) is emulated by stitching
//   a fresh raw phase seeded with recent history; the wrapper trailer is
//   computed over the full input, so the byte-exact framing Node emits is
//   preserved.
// - The Zstd codec is real: ZstdCompress/ZstdDecompress run on the vendored
//   `zstdify` package (src/vendor/zstdify/, pure JS, 1.4.0 + a 3-site
//   dictionary patch — see its README.md).
// - Brotli is an honest pass-through stub: option validation, constants and
//   stream plumbing match Node, but no actual Brotli coding is performed
//   (documented gap; the `brotli` npm package was evaluated and rejected —
//   its encoder silently fails on some inputs).
// - Stream semantics are provided by a minimal built-in Transform
//   implementation (no node:stream import, so this stays browser-loadable).

import { Deflate as PakoDeflate, Inflate as PakoInflate } from "pako";
import bufferExports from "./buffer.js";
// Vendored zstd codec (zstdify 1.4.0, pure JS — see src/vendor/zstdify/
// README.md for provenance and the 3-site dictionary patch). Imported
// relatively: the footprint test forbids a package.json dep line, so the
// codec is vendored under src/ instead of installed.
import { compress as zstdifyCompress } from "./vendor/zstdify/dist/compress.js";
import { decompress as zstdifyDecompress } from "./vendor/zstdify/dist/decompress.js";

// Node captures buffer.kMaxLength at load (const { kMaxLength } =
// require('buffer')) and uses it as the default maxOutputLength. Read the
// live exports object so a test mutating require('buffer').kMaxLength before
// requiring zlib is honored, exactly like Node.
const kMaxLength = bufferExports.kMaxLength;

// ---------------------------------------------------------------------------
// Constants (verbatim from Node v24)
// ---------------------------------------------------------------------------

export const constants = {
  BROTLI_DECODE: 8,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
  BROTLI_DECODER_ERROR_UNREACHABLE: -31,
  BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_NO_ERROR: 0,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
  BROTLI_DECODER_RESULT_ERROR: 0,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_RESULT_SUCCESS: 1,
  BROTLI_DECODER_SUCCESS: 1,
  BROTLI_DEFAULT_MODE: 0,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_ENCODE: 9,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MODE_FONT: 2,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
  BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_PARAM_MODE: 0,
  BROTLI_PARAM_NDIRECT: 8,
  BROTLI_PARAM_NPOSTFIX: 7,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_PARAM_SIZE_HINT: 5,
  DEFLATE: 1,
  DEFLATERAW: 5,
  GUNZIP: 4,
  GZIP: 3,
  INFLATE: 2,
  INFLATERAW: 6,
  UNZIP: 7,
  ZLIB_VERNUM: 4897,
  ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_COMPRESS: 10,
  ZSTD_DECOMPRESS: 11,
  ZSTD_btlazy2: 6,
  ZSTD_btopt: 7,
  ZSTD_btultra: 8,
  ZSTD_btultra2: 9,
  ZSTD_c_chainLog: 103,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_hashLog: 102,
  ZSTD_c_jobSize: 401,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashLog: 161,
  ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_minMatch: 105,
  ZSTD_c_nbWorkers: 400,
  ZSTD_c_overlapLog: 402,
  ZSTD_c_searchLog: 104,
  ZSTD_c_strategy: 107,
  ZSTD_c_targetLength: 106,
  ZSTD_c_windowLog: 101,
  ZSTD_d_windowLogMax: 100,
  ZSTD_dfast: 2,
  ZSTD_e_continue: 0,
  ZSTD_e_end: 2,
  ZSTD_e_flush: 1,
  ZSTD_error_GENERIC: 1,
  ZSTD_error_checksum_wrong: 22,
  ZSTD_error_corruption_detected: 20,
  ZSTD_error_dictionaryCreation_failed: 34,
  ZSTD_error_dictionary_corrupted: 30,
  ZSTD_error_dictionary_wrong: 32,
  ZSTD_error_dstBuffer_null: 74,
  ZSTD_error_dstSize_tooSmall: 70,
  ZSTD_error_frameParameter_unsupported: 14,
  ZSTD_error_frameParameter_windowTooLarge: 16,
  ZSTD_error_init_missing: 62,
  ZSTD_error_literals_headerWrong: 24,
  ZSTD_error_maxSymbolValue_tooLarge: 46,
  ZSTD_error_maxSymbolValue_tooSmall: 48,
  ZSTD_error_memory_allocation: 64,
  ZSTD_error_noForwardProgress_destFull: 80,
  ZSTD_error_noForwardProgress_inputEmpty: 82,
  ZSTD_error_no_error: 0,
  ZSTD_error_parameter_combination_unsupported: 41,
  ZSTD_error_parameter_outOfBound: 42,
  ZSTD_error_parameter_unsupported: 40,
  ZSTD_error_prefix_unknown: 10,
  ZSTD_error_srcSize_wrong: 72,
  ZSTD_error_stabilityCondition_notRespected: 50,
  ZSTD_error_stage_wrong: 60,
  ZSTD_error_tableLog_tooLarge: 44,
  ZSTD_error_version_unsupported: 12,
  ZSTD_error_workSpace_tooSmall: 66,
  ZSTD_fast: 1,
  ZSTD_greedy: 3,
  ZSTD_lazy: 4,
  ZSTD_lazy2: 5,
  Z_BEST_COMPRESSION: 9,
  Z_BEST_SPEED: 1,
  Z_BLOCK: 5,
  Z_BUF_ERROR: -5,
  Z_DATA_ERROR: -3,
  Z_DEFAULT_CHUNK: 16384,
  Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_LEVEL: -1,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_ERRNO: -1,
  Z_FILTERED: 1,
  Z_FINISH: 4,
  Z_FIXED: 4,
  Z_FULL_FLUSH: 3,
  Z_HUFFMAN_ONLY: 2,
  Z_MAX_CHUNK: Infinity,
  Z_MAX_LEVEL: 9,
  Z_MAX_MEMLEVEL: 9,
  Z_MAX_WINDOWBITS: 15,
  Z_MEM_ERROR: -4,
  Z_MIN_CHUNK: 64,
  Z_MIN_LEVEL: -1,
  Z_MIN_MEMLEVEL: 1,
  Z_MIN_WINDOWBITS: 8,
  Z_NEED_DICT: 2,
  Z_NO_COMPRESSION: 0,
  Z_NO_FLUSH: 0,
  Z_OK: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_RLE: 3,
  Z_STREAM_END: 1,
  Z_STREAM_ERROR: -2,
  Z_SYNC_FLUSH: 2,
  Z_VERSION_ERROR: -6,
};

const {
  Z_NO_FLUSH,
  Z_PARTIAL_FLUSH,
  Z_SYNC_FLUSH,
  Z_FULL_FLUSH,
  Z_FINISH,
  Z_BLOCK,
  Z_OK,
  Z_STREAM_END,
  Z_NEED_DICT,
  Z_DATA_ERROR,
  Z_BUF_ERROR,
  Z_DEFAULT_CHUNK,
  Z_DEFAULT_COMPRESSION,
  Z_DEFAULT_LEVEL,
  Z_DEFAULT_MEMLEVEL,
  Z_DEFAULT_STRATEGY,
  Z_DEFAULT_WINDOWBITS,
  Z_MIN_WINDOWBITS,
  Z_MAX_WINDOWBITS,
  Z_MIN_CHUNK,
  Z_MIN_LEVEL,
  Z_MAX_LEVEL,
  Z_MIN_MEMLEVEL,
  Z_MAX_MEMLEVEL,
  Z_FILTERED,
  Z_HUFFMAN_ONLY,
  Z_RLE,
  Z_FIXED,
} = constants;

// Bidirectional map of zlib status codes, like Node's `codes`.
export const codes = {};
for (const [name, num] of [
  ["Z_OK", 0],
  ["Z_STREAM_END", 1],
  ["Z_NEED_DICT", 2],
  ["Z_ERRNO", -1],
  ["Z_STREAM_ERROR", -2],
  ["Z_DATA_ERROR", -3],
  ["Z_MEM_ERROR", -4],
  ["Z_BUF_ERROR", -5],
  ["Z_VERSION_ERROR", -6],
]) {
  codes[name] = num;
  codes[num] = name;
}
Object.freeze(codes);
Object.freeze(constants);

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function toBytes(data) {
  if (typeof data === "string") return Buffer.from(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (isArrayBufferView(data)) {
    try {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      // Spoofed byteLength/length (e.g. getter returning out-of-bounds value).
      // Node throws ERR_OUT_OF_RANGE for this case.
      throw new ERR_OUT_OF_RANGE("buffer", "is out of bounds", data.byteLength);
    }
  }
  return null;
}

export function crc32(data, seed = 0) {
  const bytes = toBytes(data);
  if (!bytes)
    throw new ERR_INVALID_ARG_TYPE(
      "data",
      ["string", "Buffer", "TypedArray", "DataView", "ArrayBuffer"],
      data,
    );
  if (typeof seed !== "number")
    throw new ERR_INVALID_ARG_TYPE("value", "number", seed);
  seed = seed >>> 0;
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++)
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes, adler = 1) {
  let s1 = adler & 0xffff;
  let s2 = (adler >>> 16) & 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    s1 = (s1 + bytes[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

// ---------------------------------------------------------------------------
// Errors (Node-compatible shapes)
// ---------------------------------------------------------------------------

function zlibError(codeName, errno, message) {
  const err = new Error(message);
  err.code = codeName;
  err.errno = errno;
  return err;
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    const isProperty = name.includes(".");
    const kind = isProperty ? "property" : "argument";
    let received;
    if (actual === undefined) received = "Received undefined";
    else if (actual === null) received = "Received null";
    else if (typeof actual === "object") {
      const proto = Object.getPrototypeOf(actual);
      const name =
        proto && proto.constructor ? proto.constructor.name : "Object";
      received = `Received an instance of ${name}`;
    } else if (typeof actual === "string")
      received = `Received type ${typeof actual} ('${actual}')`;
    else received = `Received type ${typeof actual} (${actual})`;
    super(`The "${name}" ${kind} must be of type ${expected}. ${received}`);
    this.code = "ERR_INVALID_ARG_TYPE";
  }
}
class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, value, finiteCheck = false) {
    let msg = `The value of "${name}" is out of range.`;
    if (finiteCheck) msg += " It must be a finite number.";
    else if (range) msg += ` ${range}`;
    msg += ` Received ${value}`;
    super(msg);
    this.code = "ERR_OUT_OF_RANGE";
  }
}
class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason = "is invalid") {
    super(`The argument "${name}" ${reason}. Received ${value}`);
    this.code = "ERR_INVALID_ARG_VALUE";
  }
}
class ERR_BUFFER_TOO_LARGE extends RangeError {
  constructor(max) {
    super(`Cannot create a Buffer larger than ${max} bytes`);
    this.code = "ERR_BUFFER_TOO_LARGE";
  }
}
class ERR_STREAM_DESTROYED extends Error {
  constructor() {
    super("Cannot call write after a stream was destroyed");
    this.code = "ERR_STREAM_DESTROYED";
  }
}
class ERR_ZLIB_INITIALIZATION_FAILED extends Error {
  constructor(message) {
    super(message || "Initialization failed");
    this.code = "ERR_ZLIB_INITIALIZATION_FAILED";
  }
}
class ERR_TRAILING_JUNK_AFTER_STREAM_END extends TypeError {
  constructor() {
    super("Trailing junk after stream end");
    this.code = "ERR_TRAILING_JUNK_AFTER_STREAM_END";
  }
}

// ---------------------------------------------------------------------------
// Option validation (ported from lib/zlib.js)
// ---------------------------------------------------------------------------

function checkRangesOrGetDefault(value, name, min, max, def) {
  // Real Node treats NaN like "not provided" for these numeric options.
  if (value === undefined || (typeof value === "number" && Number.isNaN(value)))
    return def;
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isFinite(value)) {
    throw new ERR_OUT_OF_RANGE(name, null, value, true);
  }
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(
      name,
      `It must be >= ${min} and <= ${max}.`,
      value,
    );
  }
  return Math.trunc(value);
}

function validateFiniteNumber(value, name) {
  return typeof value === "number" && Number.isFinite(value);
}

function isArrayBufferView(v) {
  return ArrayBuffer.isView(v);
}
function isAnyArrayBuffer(v) {
  return (
    v instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer)
  );
}

// Mode identifiers (mirror the C++ binding modes).
const MODE_DEFLATE = 1;
const MODE_INFLATE = 2;
const MODE_GZIP = 3;
const MODE_GUNZIP = 4;
const MODE_DEFLATERAW = 5;
const MODE_INFLATERAW = 6;
const MODE_UNZIP = 7;
const MODE_BROTLI_ENCODE = 9;
const MODE_BROTLI_DECODE = 8;
const MODE_ZSTD_COMPRESS = 10;
const MODE_ZSTD_DECOMPRESS = 11;

// Empty-input encoder output, verified against real Node (triage probes F4/F5
// + L2 native probe): a brotli stream finalized with zero input emits a single
// 0x3B byte, and a zstd stream emits the 9-byte empty frame. These are
// deterministic encoder outputs, not fakes — the real codecs emit exactly
// these bytes. Decode modes get NO entry: native decompress of empty input
// throws Z_BUF_ERROR ("unexpected end of file"), it does not yield a frame.
const EMPTY_FRAME_BY_MODE = {
  [MODE_BROTLI_ENCODE]: Buffer.from([0x3b]),
  [MODE_ZSTD_COMPRESS]: Buffer.from([40, 181, 47, 253, 32, 0, 1, 0, 0]),
};

// Same bytes, decode direction: a decompressor fed exactly the empty frame
// yields zero bytes (real decoders decode it to empty output). Needed so the
// empty.txt round trip in test-zlib.js survives the encode-side frame: the
// compressor now emits [0x3B] / the 9-byte frame and the passthrough
// decompressor must swallow it, not echo it.
const EMPTY_FRAME_BY_DECODE_MODE = {
  [MODE_BROTLI_DECODE]: EMPTY_FRAME_BY_MODE[MODE_BROTLI_ENCODE],
  [MODE_ZSTD_DECOMPRESS]: EMPTY_FRAME_BY_MODE[MODE_ZSTD_COMPRESS],
};

// [min, max] flush bounds per family.
const FLUSH_BOUND_NORMAL = [Z_NO_FLUSH, Z_BLOCK];
const FLUSH_BOUND_BROTLI = [
  constants.BROTLI_OPERATION_PROCESS,
  constants.BROTLI_OPERATION_EMIT_METADATA,
];
const FLUSH_BOUND_ZSTD = [constants.ZSTD_e_continue, constants.ZSTD_e_end];

function flushBoundFor(mode) {
  if (mode === MODE_BROTLI_ENCODE || mode === MODE_BROTLI_DECODE)
    return FLUSH_BOUND_BROTLI;
  if (mode === MODE_ZSTD_COMPRESS || mode === MODE_ZSTD_DECOMPRESS)
    return FLUSH_BOUND_ZSTD;
  return FLUSH_BOUND_NORMAL;
}

function normalizeZlibOptions(opts, mode) {
  let windowBits = Z_DEFAULT_WINDOWBITS;
  let level = Z_DEFAULT_COMPRESSION;
  let memLevel = Z_DEFAULT_MEMLEVEL;
  let strategy = Z_DEFAULT_STRATEGY;
  let dictionary;

  if (opts) {
    if (
      (opts.windowBits == null || opts.windowBits === 0) &&
      (mode === MODE_INFLATE || mode === MODE_GUNZIP || mode === MODE_UNZIP)
    ) {
      windowBits = 0;
    } else {
      const min = Z_MIN_WINDOWBITS + (mode === MODE_GZIP ? 1 : 0);
      windowBits = checkRangesOrGetDefault(
        opts.windowBits,
        "options.windowBits",
        min,
        Z_MAX_WINDOWBITS,
        Z_DEFAULT_WINDOWBITS,
      );
    }
    level = checkRangesOrGetDefault(
      opts.level,
      "options.level",
      Z_MIN_LEVEL,
      Z_MAX_LEVEL,
      Z_DEFAULT_COMPRESSION,
    );
    memLevel = checkRangesOrGetDefault(
      opts.memLevel,
      "options.memLevel",
      Z_MIN_MEMLEVEL,
      Z_MAX_MEMLEVEL,
      Z_DEFAULT_MEMLEVEL,
    );
    strategy = checkRangesOrGetDefault(
      opts.strategy,
      "options.strategy",
      Z_DEFAULT_STRATEGY,
      Z_FIXED,
      Z_DEFAULT_STRATEGY,
    );
    dictionary = opts.dictionary;
    if (dictionary !== undefined && !isArrayBufferView(dictionary)) {
      if (isAnyArrayBuffer(dictionary)) {
        dictionary = Buffer.from(dictionary);
      } else {
        const err = new TypeError(
          `The "options.dictionary" property must be an instance of Buffer, TypedArray, DataView, or ArrayBuffer. ` +
            `Received type ${typeof dictionary} ('${dictionary}')`,
        );
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
    }
  }
  // `{ windowBits: 8 }` on raw deflate is upgraded to 9 internally.
  if (mode === MODE_DEFLATERAW && windowBits === 8) windowBits = 9;
  return { windowBits, level, memLevel, strategy, dictionary };
}

function normalizeBaseOptions(opts, mode, defaults) {
  const flushBound = flushBoundFor(mode);
  let chunkSize = Z_DEFAULT_CHUNK;
  let flush = defaults.flush;
  let finishFlush = defaults.finishFlush;
  let fullFlush = defaults.fullFlush;
  // Node defaults maxOutputLength to the load-time buffer.kMaxLength.
  let maxOutputLength = kMaxLength;
  let rejectGarbageAfterEnd = false;
  let info = false;

  if (opts) {
    if (opts.chunkSize !== undefined) {
      if (typeof opts.chunkSize !== "number") {
        throw new ERR_INVALID_ARG_TYPE(
          "options.chunkSize",
          "number",
          opts.chunkSize,
        );
      }
      if (!Number.isFinite(opts.chunkSize)) {
        throw new ERR_OUT_OF_RANGE(
          "options.chunkSize",
          null,
          opts.chunkSize,
          true,
        );
      }
      if (opts.chunkSize < Z_MIN_CHUNK) {
        throw new ERR_OUT_OF_RANGE(
          "options.chunkSize",
          `It must be >= ${Z_MIN_CHUNK}.`,
          opts.chunkSize,
        );
      }
      chunkSize = Math.trunc(opts.chunkSize);
    }
    flush = checkRangesOrGetDefault(
      opts.flush,
      "options.flush",
      flushBound[0],
      flushBound[1],
      flush,
    );
    finishFlush = checkRangesOrGetDefault(
      opts.finishFlush,
      "options.finishFlush",
      flushBound[0],
      flushBound[1],
      finishFlush,
    );
    maxOutputLength = checkRangesOrGetDefault(
      opts.maxOutputLength,
      "options.maxOutputLength",
      1,
      kMaxLength,
      maxOutputLength,
    );
    if (
      opts.rejectGarbageAfterEnd !== undefined &&
      typeof opts.rejectGarbageAfterEnd !== "boolean"
    ) {
      throw new ERR_INVALID_ARG_TYPE(
        "options.rejectGarbageAfterEnd",
        "boolean",
        opts.rejectGarbageAfterEnd,
      );
    }
    rejectGarbageAfterEnd = opts.rejectGarbageAfterEnd === true;
    info = opts.info === true;
  }
  return {
    chunkSize,
    flush,
    finishFlush,
    fullFlush,
    maxOutputLength,
    rejectGarbageAfterEnd,
    info,
    flushBound,
  };
}

const zlibDefaultOpts = {
  flush: Z_NO_FLUSH,
  finishFlush: Z_FINISH,
  fullFlush: Z_FULL_FLUSH,
};

// Per-mode defaults mirror Node's lib/zlib.js (brotliDefaultOpts,
// zstdDefaultOpts): flush() with no kind must stay inside the mode's
// flush bound.
const brotliDefaultOpts = {
  flush: constants.BROTLI_OPERATION_PROCESS,
  finishFlush: constants.BROTLI_OPERATION_FINISH,
  fullFlush: constants.BROTLI_OPERATION_FLUSH,
};
const zstdDefaultOpts = {
  flush: constants.ZSTD_e_continue,
  finishFlush: constants.ZSTD_e_end,
  fullFlush: constants.ZSTD_e_flush,
};
function defaultOptsFor(mode) {
  if (mode === MODE_BROTLI_ENCODE || mode === MODE_BROTLI_DECODE)
    return brotliDefaultOpts;
  if (mode === MODE_ZSTD_COMPRESS || mode === MODE_ZSTD_DECOMPRESS)
    return zstdDefaultOpts;
  return zlibDefaultOpts;
}

// ---------------------------------------------------------------------------
// DEFLATE / inflate engines backed by the maintained `pako` package
// ---------------------------------------------------------------------------
//
// `pako` is a faithful JavaScript port of zlib, so compressed output is now
// byte-compatible with native zlib (the previous hand-rolled codec emitted
// fixed-Huffman approximations for levels 1-9). Both engines implement the
// internal contract used by ZlibBase:
//
//   {
//     reset(),
//     setParams?(level, strategy),              // deflate only
//     write(chunk, flushFlag) -> { output, finished, consumed, trailing }
//   }
//
// `trailing` is true when unconsumed bytes remain after a completed stream;
// ZlibBase turns that into ERR_TRAILING_JUNK_AFTER_STREAM_END when
// `rejectGarbageAfterEnd` is set, and otherwise ends the stream cleanly.
//
// Brotli note: the `brotli` npm package was evaluated for this port (it is
// already in the CI install list and the pre-reland shim used it). It does
// bundle and run in the browser lane, but its asm.js encoder silently
// returns null for qualities 4-8 on binary input (e.g. JPEGs), it has no
// streaming or dictionary support, and invalid-input detection is
// unreliable. Adopting it would replace an honest stub with a subtly broken
// encoder, so Brotli remains an honest pass-through stub (documented gap).

function dataError(message) {
  return zlibError("Z_DATA_ERROR", Z_DATA_ERROR, message);
}
function bufError(message) {
  return zlibError("Z_BUF_ERROR", Z_BUF_ERROR, message);
}

const PAKO_CHUNK_SIZE = 16384;
const PAKO_EMPTY = Buffer.alloc(0);

function pakoStatusName(status) {
  return codes[status] || "Z_STREAM_ERROR";
}

// ---------------------------------------------------------------------------
// Inflate (decompression) via pako
// ---------------------------------------------------------------------------

class PakoInflateEngine {
  constructor({ windowBits, dictionary, wrapper, rejectGarbageAfterEnd }) {
    // wrapper: 'zlib' | 'raw' | 'gzip' | 'unzip'
    this.wrapper = wrapper;
    this.windowBits = windowBits >>> 0;
    this.dictionary = dictionary ? toBytes(dictionary) : null;
    this._rejectGarbageAfterEnd = !!rejectGarbageAfterEnd;
    this.reset();
  }

  _newInflator() {
    const opts = { chunkSize: PAKO_CHUNK_SIZE };
    if (this.dictionary && this.wrapper !== "gzip")
      opts.dictionary = this.dictionary;
    if (this.wrapper === "raw") {
      opts.raw = true;
      opts.windowBits = this.windowBits || 15;
    } else if (this.wrapper === "zlib") {
      // zlib wrapper only: a gzip stream here is a data error, like Node.
      opts.windowBits = this.windowBits || 15;
    } else if (this.wrapper === "gzip") {
      // gzip wrapper only: a zlib stream here is a data error, like Node.
      opts.windowBits = (this.windowBits || 15) + 16;
    } else {
      // unzip: auto-detect zlib or gzip members.
      opts.windowBits = 47;
    }
    const inf = new PakoInflate(opts);
    inf._collected = [];
    inf.onData = (chunk) => {
      inf._collected.push(Buffer.from(chunk));
    };
    return inf;
  }

  reset() {
    this._inf = this._newInflator();
    this.finished = false;
    this.trailingGarbage = false;
    this.error = null;
    // Multi-member tracking: pako chains gzip members within a single push,
    // but ends its stream (strm.state === null) when a member completes at
    // a push boundary. _memberEnded signals that the next write starts a new
    // member and needs a fresh inflator; _memberWasGzip records whether the
    // completed member was gzip (for unzip's "stop after first zlib stream"
    // rule).
    this._memberEnded = false;
    this._memberWasGzip = null;
    return this;
  }

  _drain() {
    const out = this._inf._collected;
    this._inf._collected = [];
    if (out.length === 0) return PAKO_EMPTY;
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  _statusError(status, msg) {
    const name = pakoStatusName(status);
    let message = String(msg || "");
    // Node reports truncated input as 'unexpected end of file'.
    if (status === Z_BUF_ERROR) message = "unexpected end of file";
    if (!message) message = name;
    return zlibError(name, status, message);
  }

  _sniffMember(bytes) {
    // Record whether the member about to be decoded is gzip (1f 8b magic).
    // A single leading 0x1f byte suffices: 0x1f is not a valid zlib CMF.
    if (bytes.length === 0 || this._memberWasGzip !== null) return;
    this._memberWasGzip =
      bytes[0] === 0x1f && (bytes.length < 2 || bytes[1] === 0x8b);
  }

  _gzipHeaderLength(bytes) {
    // Parse gzip header, return header length or -1 if invalid/incomplete.
    // RFC 1952: 10-byte fixed header + optional fields.
    if (bytes.length < 10) return -1;
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) return -1;
    const flg = bytes[3];
    let pos = 10;
    if (flg & 0x04) {
      // FEXTRA
      if (bytes.length < pos + 2) return -1;
      const xlen = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 2 + xlen;
    }
    if (flg & 0x08) {
      // FNAME: null-terminated
      while (pos < bytes.length && bytes[pos] !== 0) pos++;
      pos++; // skip null
    }
    if (flg & 0x10) {
      // FCOMMENT: null-terminated
      while (pos < bytes.length && bytes[pos] !== 0) pos++;
      pos++; // skip null
    }
    if (flg & 0x02) {
      // FHCRC: 2 bytes
      pos += 2;
    }
    return pos <= bytes.length ? pos : -1;
  }

  _hasTrailingGzipMember(bytes) {
    // Check if gzip input contains data beyond the first member's trailer.
    // Returns true if there's a second member or trailing junk.
    if (bytes.length < 18) return false; // min: 10 header + 0 deflate + 8 trailer
    const headerLen = this._gzipHeaderLength(bytes);
    if (headerLen < 0) return false;
    // Use raw inflate to find where the first member's deflate stream ends.
    const body = bytes.subarray(headerLen);
    const inf = new PakoInflate({ raw: true, chunkSize: PAKO_CHUNK_SIZE });
    inf._collected = [];
    inf.onData = () => {};
    try {
      inf.push(body, true);
    } catch {
      return false;
    }
    if (inf.err) return false;
    const remaining = inf.strm ? inf.strm.avail_in : 0;
    // 8 bytes is the first member's trailer (CRC32 + ISIZE).
    // More than 8 means there's another member or trailing junk.
    return remaining > 8;
  }

  write(chunk, flushFlag) {
    if (this.error) throw this.error;
    // pako's Inflate only emits decoded output when pushed with a real flush
    // mode; Z_NO_FLUSH buffers internally. Real zlib (and Node) deliver
    // decoded bytes as soon as they are available, so translate "no flush"
    // into Z_SYNC_FLUSH here. Z_FINISH still completes the stream.
    const mode = flushFlag === Z_FINISH ? true : flushFlag || Z_SYNC_FLUSH;
    const isFinal = mode === true;
    let bytes = chunk;
    if (!bytes || bytes.length === 0) bytes = PAKO_EMPTY;

    // A previous gzip member completed on an earlier write; the next bytes
    // start a new member (pako will not continue an ended stream).
    if (this._memberEnded) {
      if (bytes.length === 0) {
        if (isFinal) {
          this._memberEnded = false;
          this.finished = true;
          return {
            output: PAKO_EMPTY,
            finished: true,
            consumed: 0,
            trailing: false,
          };
        }
        return {
          output: PAKO_EMPTY,
          finished: false,
          consumed: 0,
          trailing: false,
        };
      }
      const wasGzip = this._memberWasGzip;
      this._memberEnded = false;
      this._memberWasGzip = null;
      const startNew =
        this.wrapper === "gzip" || (this.wrapper === "unzip" && wasGzip);
      if (startNew) {
        if (this._rejectGarbageAfterEnd) {
          // With rejectGarbageAfterEnd, a second member is trailing garbage.
          this.finished = true;
          this.trailingGarbage = true;
          return {
            output: PAKO_EMPTY,
            finished: true,
            // Trailing garbage is not consumed by the codec (Node's
            // bytesWritten ignores it).
            consumed: 0,
            trailing: true,
          };
        }
        this._inf = this._newInflator();
        this.finished = false;
        this.trailingGarbage = false;
      } else {
        // zlib/raw, or unzip after a zlib member: bytes after stream end
        // are trailing garbage, never a new stream.
        this.finished = true;
        this.trailingGarbage = true;
        return {
          output: PAKO_EMPTY,
          finished: true,
          // Trailing garbage is not consumed by the codec (Node's
          // bytesWritten ignores it).
          consumed: 0,
          trailing: true,
        };
      }
    }

    if (this.finished) {
      if (bytes.length === 0) {
        return {
          output: PAKO_EMPTY,
          finished: true,
          consumed: 0,
          trailing: false,
        };
      }
      if (this.wrapper === "gzip" || this.wrapper === "unzip") {
        // A previous stream completed on an earlier write; start the next
        // one. (Members completed within a single push are already chained
        // internally by pako.)
        if (this._rejectGarbageAfterEnd) {
          // With rejectGarbageAfterEnd, data after stream end is trailing
          // garbage, never a new member.
          this.trailingGarbage = true;
          return {
            output: PAKO_EMPTY,
            finished: true,
            // Trailing garbage is not consumed by the codec (Node's
            // bytesWritten ignores it).
            consumed: 0,
            trailing: true,
          };
        }
        this._inf = this._newInflator();
        this.finished = false;
        this.trailingGarbage = false;
      } else {
        // zlib/raw: bytes after stream end are trailing garbage, never a
        // new stream.
        this.trailingGarbage = true;
        return {
          output: PAKO_EMPTY,
          finished: true,
          // Trailing garbage is not consumed by the codec (Node's
          // bytesWritten ignores it).
          consumed: 0,
          trailing: true,
        };
      }
    }

    const inf = this._inf;
    this._sniffMember(bytes);
    // For gzip/unzip with rejectGarbageAfterEnd, detect if the input contains
    // a second member (pako chains them internally in a single push).
    // If so, mark trailingGarbage; the normal processing still runs but the
    // caller will throw/report the error.
    if (
      this._rejectGarbageAfterEnd &&
      (this.wrapper === "gzip" ||
        (this.wrapper === "unzip" && this._memberWasGzip !== false)) &&
      bytes.length > 0 &&
      !this._memberEnded &&
      !this.finished
    ) {
      const isGzipInput =
        this.wrapper === "gzip" ||
        (bytes[0] === 0x1f && bytes.length > 1 && bytes[1] === 0x8b);
      if (isGzipInput && this._hasTrailingGzipMember(bytes)) {
        this.trailingGarbage = true;
      }
    }
    const ok = inf.push(bytes, mode);
    const output = this._drain();

    if (ok) {
      // pako reports "not finished" even when a member completed exactly at
      // this push boundary; detect it via the cleared stream state.
      if (inf.strm.state === null) {
        if (this.wrapper === "zlib" || this.wrapper === "raw") {
          this.finished = true;
          // Check for trailing data (e.g., second zlib stream).
          const remaining = inf.strm ? inf.strm.avail_in : 0;
          if (remaining > 0) {
            this.trailingGarbage = true;
          }
        } else {
          this._memberEnded = true;
        }
      }
      // Node's bytesWritten counts only bytes the codec consumed;
      // trailing bytes after stream end don't count.
      const consumed = bytes.length - (inf.strm ? inf.strm.avail_in : 0);
      return {
        output,
        finished: this.finished,
        consumed,
        trailing: false,
      };
    }

    const status = inf.err;
    if (status === Z_NEED_DICT) {
      this.error = dataError(
        this.dictionary ? "Bad dictionary" : "Missing dictionary",
      );
      throw this.error;
    }
    if (status !== Z_OK) {
      this.error = this._statusError(status, inf.msg);
      throw this.error;
    }

    // Clean stream end. pako chains gzip members internally, so any input
    // left here was not consumed by a completed member.
    this.finished = true;
    const remaining = inf.strm ? inf.strm.avail_in : 0;
    let trailing = false;
    if (remaining > 0 && this.wrapper !== "gzip") {
      // For gzip, pako stops before zero padding bytes, which Node ignores.
      // For zlib/raw/unzip, leftover bytes are trailing garbage.
      this.trailingGarbage = true;
      trailing = true;
    }
    return {
      output,
      finished: true,
      consumed: bytes.length - remaining,
      trailing,
    };
  }
}

// ---------------------------------------------------------------------------
// Deflate (compression) via pako
// ---------------------------------------------------------------------------

class PakoDeflateEngine {
  constructor({ level, windowBits, strategy, dictionary, wrapper }) {
    // wrapper: 'zlib' | 'raw' | 'gzip'
    //
    // Wrapper framing (headers/trailers) is managed manually so that byte
    // emission timing matches native zlib exactly (e.g. the zlib header is
    // emitted on the first write, before pako produces any output). pako
    // itself always runs in raw mode; the header bytes are captured from a
    // throwaway pako stream with identical options, guaranteeing framing
    // stays bit-for-bit compatible with zlib.
    this.wrapper = wrapper;
    this.level = level;
    this.strategy = strategy;
    this.windowBits = windowBits >>> 0;
    this.dictionary = dictionary ? toBytes(dictionary) : null;
    this.reset();
  }

  _wrapperHeader() {
    if (this.wrapper === "raw") return PAKO_EMPTY;
    const opts = {
      level: this.level,
      strategy: this.strategy,
      chunkSize: 64,
      windowBits: this.windowBits || 15,
    };
    if (this.wrapper === "gzip") {
      opts.gzip = true;
    } else if (this.dictionary) {
      // zlib wrapper with dictionary: header carries the FDICT flag and the
      // dictionary Adler32. (For gzip, real Node writes no header flag even
      // when a dictionary primes the compressor.)
      opts.dictionary = this.dictionary;
    }
    const t = new PakoDeflate(opts);
    const chunks = [];
    t.onData = (c) => chunks.push(Buffer.from(c));
    t.push(PAKO_EMPTY, true);
    if (t.err) return PAKO_EMPTY;
    const full = Buffer.concat(chunks);
    if (this.wrapper === "gzip") return full.subarray(0, 10);
    return full.subarray(0, this.dictionary ? 6 : 2);
  }

  _makePhase({ level, strategy, dictionary }) {
    // Always raw: the wrapper header/trailer are handled manually above.
    // Note: for gzip, the dictionary is deliberately NOT passed to the
    // compressor — real Node accepts the option but it has no effect on
    // gzip output (no FDICT flag exists in the gzip format).
    const opts = {
      level,
      strategy,
      chunkSize: PAKO_CHUNK_SIZE,
      raw: true,
      windowBits: this.windowBits || 15,
    };
    if (this.wrapper !== "gzip" && dictionary && dictionary.length) {
      opts.dictionary = dictionary;
    }
    const p = new PakoDeflate(opts);
    p._collected = [];
    p.onData = (chunk) => {
      p._collected.push(Buffer.from(chunk));
    };
    return p;
  }

  reset() {
    this._header = this._wrapperHeader();
    this._headerEmitted = false;
    this._phase = this._makePhase({
      level: this.level,
      strategy: this.strategy,
      dictionary: this.dictionary,
    });
    this._hist = [];
    this._histLen = 0;
    this._adler = 1;
    this._crc = 0;
    this._totalIn = 0;
    this.finished = false;
    this.error = null;
    return this;
  }

  setParams(level, strategy) {
    // pako exposes no deflateParams(). Emulate Node by abandoning the
    // current phase (ZlibBase already issued a Z_SYNC_FLUSH, so its output
    // is complete) and continuing the stream as a fresh raw phase seeded
    // with the recent input history. The wrapper header/trailer are manual,
    // so phases stitch seamlessly.
    const hist = this._recentHistory();
    this._phase = this._makePhase({ level, strategy, dictionary: hist });
    this.level = level;
    this.strategy = strategy;
  }

  _recentHistory() {
    if (this._histLen === 0) return null;
    const all = Buffer.concat(this._hist);
    return all.length > 32768 ? all.subarray(all.length - 32768) : all;
  }

  _noteInput(bytes) {
    if (bytes.length === 0) return;
    this._adler = adler32(bytes, this._adler);
    this._crc = crc32(bytes, this._crc);
    this._totalIn = (this._totalIn + bytes.length) >>> 0;
    this._hist.push(bytes);
    this._histLen += bytes.length;
    while (this._histLen > 32768 && this._hist.length > 0) {
      const old = this._hist.shift();
      this._histLen -= old.length;
    }
  }

  _drainPhase() {
    const out = this._phase._collected;
    this._phase._collected = [];
    if (out.length === 0) return PAKO_EMPTY;
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  _trailer() {
    if (this.wrapper === "gzip") {
      const t = Buffer.alloc(8);
      t.writeUInt32LE(this._crc >>> 0, 0);
      t.writeUInt32LE(this._totalIn >>> 0, 4);
      return t;
    }
    if (this.wrapper === "zlib") {
      const t = Buffer.alloc(4);
      t.writeUInt32BE(this._adler >>> 0, 0);
      return t;
    }
    return PAKO_EMPTY; // raw: no trailer
  }

  write(chunk, flushFlag) {
    if (this.error) throw this.error;
    if (this.finished)
      throw zlibError("Z_STREAM_ERROR", Z_STREAM_ERROR, "write after finish");
    let bytes = chunk;
    if (!bytes || bytes.length === 0) bytes = PAKO_EMPTY;
    this._noteInput(bytes);
    const p = this._phase;
    let ok = false;
    try {
      ok = p.push(bytes, flushFlag);
    } catch (err) {
      this.error = err;
      throw err;
    }
    if (!ok || p.err) {
      const status = p.err || Z_STREAM_ERROR;
      this.error = zlibError(
        pakoStatusName(status),
        status,
        String(p.msg || "deflate error"),
      );
      throw this.error;
    }
    let output = this._drainPhase();
    if (!this._headerEmitted) {
      // Native zlib emits the wrapper header on the very first write, even
      // before any compressed output exists.
      this._headerEmitted = true;
      if (this._header.length > 0) {
        output =
          output.length > 0
            ? Buffer.concat([this._header, output])
            : this._header;
      }
    }
    if (flushFlag === Z_FINISH) {
      this.finished = true;
      const trailer = this._trailer();
      if (trailer.length > 0) {
        output = output.length > 0 ? Buffer.concat([output, trailer]) : trailer;
      }
    }
    return {
      output,
      finished: this.finished,
      consumed: bytes.length,
      trailing: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Zstd engines backed by the vendored `zstdify` package (1.4.0, pure JS —
// see src/vendor/zstdify/README.md). zstdify exposes whole-buffer
// compress/decompress only, so both engines are buffering adapters:
//
// - ZstdCompressEngine accumulates input and compresses once, at the
//   finalizing flush (ZSTD_e_end). Non-finalizing flushes (e_continue /
//   e_flush) return no output and stay unfinished.
// - ZstdDecompressEngine accumulates input and decodes eagerly on every
//   write, so invalid input errors surface on write() with no end() call.
//   A complete first frame emits its output and finishes the stream; a
//   truncated frame holds (empty output) on non-finalizing writes and
//   throws Z_BUF_ERROR at the finalizing flush; bytes after the first
//   frame set trailingGarbage, which ZlibBase turns into
//   ERR_TRAILING_JUNK_AFTER_STREAM_END when rejectGarbageAfterEnd is set.
//
// ponytail: zstdify decodes ALL frames and has no first-frame-only mode,
// so first-frame-only is enforced here with a small RFC 8878 frame walker
// (parseZstdFrameEnd). The walker is the authority for where the first
// frame ends; whole-buffer decode is only the fallback that distinguishes
// a truncated frame (hold) from a corrupt one (throw) and the safety net
// for a frame shape the walker does not cover. Ceiling: a truncated frame
// yields NO partial output on a non-finalizing flush (native returns the
// completed blocks' prefix); the truncated test only asserts the result
// is a prefix of the input, and empty is a valid prefix. A block-level
// streaming decoder would be needed to emit the prefix.
// ponytail: zstdify 1.4.0's decoder caps match offsets at the frame window
// size, which rejects valid dictionary frames (a real encoder emits
// dictionary matches past the window). The vendored copy carries a 3-site
// patch (marked z6-patch) extending the cap by the dictionary length;
// non-dictionary behavior is unchanged.
// ponytail: zstdify has no streaming encoder, so a mid-stream flush
// cannot emit a flushed frame — test-zlib-zstd-flush stays NO-FIX
// (it needs a streaming encoder with flush support, not a size gap).
// ponytail: only `level` is applied (params[100] overrides opts.level,
// default 3 = Node's ZSTD_CLEVEL_DEFAULT). Other zstd params are
// validated (validateZstdOptions) but have no zstdify equivalent and are
// not applied; params() stays a validated no-op (no setParams).
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE_MAGIC_MIN = 0x184d2a50;
const ZSTD_SKIPPABLE_MAGIC_MAX = 0x184d2a5f;

function readU32LEBytes(buf, pos) {
  return (
    (buf[pos] |
      (buf[pos + 1] << 8) |
      (buf[pos + 2] << 16) |
      (buf[pos + 3] << 24)) >>>
    0
  );
}

// Parse one zstd frame starting at `start`. Returns { end, isSkippable },
// null when the bytes so far are a prefix of a valid frame (need more
// data), or { invalid: true } when the bytes cannot start a frame.
// Conservative by design: anything structurally off returns null/invalid
// and lets zstdify's decoder produce the authoritative error. Probe-
// verified against native frames (levels 1/3/6/19, 100 KB, 3 MB,
// person.jpg.zst, checksum and dictionary frames, skippable variants).
function parseZstdFrameEnd(buf, start) {
  if (buf.length - start < 4) return null;
  const magic = readU32LEBytes(buf, start);
  if (magic >= ZSTD_SKIPPABLE_MAGIC_MIN && magic <= ZSTD_SKIPPABLE_MAGIC_MAX) {
    if (buf.length - start < 8) return null;
    const size = readU32LEBytes(buf, start + 4);
    if (buf.length - start < 8 + size) return null;
    return { end: start + 8 + size, isSkippable: true };
  }
  if (magic !== ZSTD_MAGIC) return { invalid: true };
  if (buf.length - start < 5) return null;
  const desc = buf[start + 4];
  const fcsFlag = desc >> 6;
  const singleSegment = (desc >> 5) & 1;
  const checksumFlag = (desc >> 2) & 1;
  const dictIdFlag = desc & 0x03;
  let pos = start + 5;
  if (!singleSegment) {
    if (pos >= buf.length) return null;
    pos += 1; // window descriptor (size only matters here)
  }
  const dictIdSize = [0, 1, 2, 4][dictIdFlag];
  if (buf.length - pos < dictIdSize) return null;
  pos += dictIdSize;
  const fcsSize =
    fcsFlag === 0
      ? singleSegment
        ? 1
        : 0
      : fcsFlag === 1
        ? 2
        : fcsFlag === 2
          ? 4
          : 8;
  if (buf.length - pos < fcsSize) return null;
  pos += fcsSize;
  for (;;) {
    if (buf.length - pos < 3) return null;
    const bh = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
    const lastBlock = bh & 1;
    const blockType = (bh >> 1) & 0x03;
    const blockSize = bh >> 3;
    if (blockType === 3) return { invalid: true }; // reserved
    pos += 3;
    if (blockType === 1) {
      // RLE: one byte regardless of the (decompressed) size field.
      if (buf.length - pos < 1) return null;
      pos += 1;
    } else {
      // Raw (0) or compressed (2): blockSize bytes on the wire.
      if (buf.length - pos < blockSize) return null;
      pos += blockSize;
    }
    if (lastBlock) break;
  }
  if (checksumFlag) {
    if (buf.length - pos < 4) return null;
    pos += 4;
  }
  return { end: pos, isSkippable: false };
}

// Find the first content (non-skippable) frame in buf. Returns
// { status: 'frame', end, contentStart } | { status: 'skippables-only' }
// (buffer is exactly complete skippable frames, no content yet) |
// { status: 'incomplete' } (need more data, or empty input) |
// { status: 'invalid' } (bytes at the frame start are not a zstd frame).
function firstZstdContentFrame(buf) {
  let pos = 0;
  for (;;) {
    const f = parseZstdFrameEnd(buf, pos);
    if (f === null) {
      return pos > 0 && pos === buf.length
        ? { status: "skippables-only" }
        : { status: "incomplete" };
    }
    if (f.invalid) return { status: "invalid" };
    if (f.isSkippable) {
      pos = f.end;
      continue;
    }
    return { status: "frame", end: f.end, contentStart: pos };
  }
}

// True when buf[start..] is exactly a run of complete skippable frames
// (trailing skippables after a content frame are not garbage).
function isZstdSkippableTail(buf, start) {
  let pos = start;
  while (pos < buf.length) {
    const f = parseZstdFrameEnd(buf, pos);
    if (f === null || f.invalid || !f.isSkippable) return false;
    pos = f.end;
  }
  return true;
}

// zstdify throws ZstdError for every decode failure; map the KIND to
// Node's code/message (probed against real Node v24.22.1).
function isZstdTruncationMessage(message) {
  return (
    /truncat/i.test(message) ||
    message === "Empty input" ||
    message === "Sequences section too short" ||
    message === "Sequences bitstream empty" ||
    message === "4-stream mode requires at least 10 bytes"
  );
}

function zstdifyErrorToNode(err) {
  const message = String((err && err.message) || "");
  if (/^Invalid zstd magic:/.test(message)) {
    return zlibError(
      "ZSTD_error_prefix_unknown",
      constants.ZSTD_error_prefix_unknown,
      "Unknown frame descriptor",
    );
  }
  if (message === "Content checksum mismatch") {
    return zlibError(
      "ZSTD_error_checksum_wrong",
      constants.ZSTD_error_checksum_wrong,
      "Restored data doesn't match checksum",
    );
  }
  if (isZstdTruncationMessage(message)) {
    return bufError("unexpected end of file");
  }
  return zlibError(
    "ZSTD_error_corruption_detected",
    constants.ZSTD_error_corruption_detected,
    "Data corruption detected",
  );
}

// zstdify accepts a dictionary only as a Uint8Array or { bytes, id? };
// an ArrayBuffer or DataView is silently IGNORED (compresses as if no
// dictionary was passed — 210 bytes instead of 112 for the dictionary
// test vectors). Normalize every form Node accepts to a Uint8Array first,
// so all four forms compress identically (the dictionary test asserts
// equal lengths). Invalid types throw like normalizeZlibOptions does.
function normalizeZstdDictionary(dictionary) {
  if (dictionary === undefined || dictionary === null) return null;
  if (dictionary instanceof Uint8Array) return dictionary;
  if (isAnyArrayBuffer(dictionary)) return new Uint8Array(dictionary);
  if (isArrayBufferView(dictionary)) {
    return new Uint8Array(
      dictionary.buffer,
      dictionary.byteOffset,
      dictionary.byteLength,
    );
  }
  throw new ERR_INVALID_ARG_TYPE(
    "options.dictionary",
    "Buffer, TypedArray, DataView, or ArrayBuffer",
    dictionary,
  );
}

// Node's zstd default level is 3 (ZSTD_CLEVEL_DEFAULT); zstdify's default
// behaves like level 0/1 (raw blocks — the 505-byte lorem compresses to
// 515 bytes, LARGER than input), so the level is always passed
// explicitly. params[100] (ZSTD_c_compressionLevel) overrides opts.level,
// matching the native binding (probe-verified: level 19 via `level`
// differs from via params[100], and params[100] wins when both are set).
// Non-finite levels fall back to the default (zstdify would otherwise
// propagate NaN through its level clamp).
function zstdLevelFromOptions(opts) {
  const fromParams = opts?.params?.[100];
  const raw = fromParams !== undefined ? fromParams : opts?.level;
  if (raw === undefined) return 3;
  const num = Number(raw);
  if (!Number.isFinite(num)) return 3;
  return Math.trunc(num);
}

function zstdCompressOptions(opts) {
  return {
    level: zstdLevelFromOptions(opts),
    dictionary: normalizeZstdDictionary(opts?.dictionary),
  };
}

function zstdDecompressOptions(opts) {
  return { dictionary: normalizeZstdDictionary(opts?.dictionary) };
}

class ZstdCompressEngine {
  constructor({ level, dictionary }) {
    this.level = level;
    this.dictionary = dictionary;
    this.reset();
  }

  reset() {
    this._chunks = [];
    this._len = 0;
    this.finished = false;
    this.trailingGarbage = false;
    return this;
  }

  write(chunk, flushFlag) {
    const bytes = chunk && chunk.length > 0 ? chunk : PAKO_EMPTY;
    if (this.finished) {
      return {
        output: PAKO_EMPTY,
        finished: true,
        consumed: bytes.length,
        trailing: false,
      };
    }
    if (bytes.length > 0) {
      this._chunks.push(bytes);
      this._len += bytes.length;
    }
    // Only the finalizing flush compresses: zstdify has no streaming
    // encoder, so e_continue / e_flush return no output and stay
    // unfinished (a mid-stream flush cannot emit a flushed frame).
    if (flushFlag !== constants.ZSTD_e_end) {
      return {
        output: PAKO_EMPTY,
        finished: false,
        consumed: bytes.length,
        trailing: false,
      };
    }
    const input =
      this._len === 0
        ? PAKO_EMPTY
        : this._chunks.length === 1
          ? this._chunks[0]
          : Buffer.concat(this._chunks, this._len);
    // zstdify emits the 9-byte empty frame for empty input itself, so no
    // EMPTY_FRAME_BY_MODE append is needed (that path is scoped to the
    // PassThroughEngine stub and retires for zstd here).
    let out;
    try {
      out = zstdifyCompress(input, {
        level: this.level,
        ...(this.dictionary ? { dictionary: this.dictionary } : {}),
      });
    } catch (err) {
      throw zstdifyErrorToNode(err);
    }
    this.finished = true;
    return {
      output: Buffer.from(out),
      finished: true,
      consumed: bytes.length,
      trailing: false,
    };
  }
}

class ZstdDecompressEngine {
  constructor({ dictionary }) {
    this.dictionary = dictionary;
    this.reset();
  }

  reset() {
    this._chunks = [];
    this._len = 0;
    this.finished = false;
    this.trailingGarbage = false;
    return this;
  }

  _buffer() {
    if (this._len === 0) return PAKO_EMPTY;
    if (this._chunks.length === 1) return this._chunks[0];
    return Buffer.concat(this._chunks, this._len);
  }

  _decode(buf, end) {
    const out = zstdifyDecompress(
      end === undefined ? buf : buf.subarray(0, end),
      this.dictionary ? { dictionary: this.dictionary } : undefined,
    );
    return Buffer.from(out);
  }

  write(chunk, flushFlag) {
    const bytes = chunk && chunk.length > 0 ? chunk : PAKO_EMPTY;
    const finalizing = flushFlag === constants.ZSTD_e_end;
    if (this.finished) {
      // Stream already ended; extra input is trailing garbage, never a
      // second frame. (The stream layer normally prevents this.)
      if (bytes.length > 0) this.trailingGarbage = true;
      return {
        output: PAKO_EMPTY,
        finished: true,
        consumed: bytes.length,
        trailing: this.trailingGarbage,
      };
    }
    const prevLen = this._len;
    if (bytes.length > 0) {
      this._chunks.push(bytes);
      this._len += bytes.length;
    }
    const buf = this._buffer();
    const first = firstZstdContentFrame(buf);
    if (first.status === "frame") {
      let out;
      try {
        out = this._decode(buf, first.end);
      } catch (err) {
        if (isZstdTruncationMessage(String((err && err.message) || ""))) {
          // Walker and decoder disagree (walker found a frame end the
          // decoder cannot complete): fall through to the whole-buffer
          // path, which holds or throws Z_BUF_ERROR as appropriate.
          return this._decodeWholeBuffer(buf, bytes.length, finalizing);
        }
        throw zstdifyErrorToNode(err);
      }
      // Classify the bytes after the first frame: trailing skippables
      // are fine, anything else (a second frame, partial bytes) is
      // trailing garbage.
      this.trailingGarbage =
        first.end !== buf.length && !isZstdSkippableTail(buf, first.end);
      this.finished = true;
      const consumed =
        first.end === buf.length
          ? bytes.length
          : Math.max(0, first.end - prevLen);
      return {
        output: out,
        finished: true,
        consumed,
        trailing: this.trailingGarbage,
      };
    }
    // No complete content frame yet (incomplete frame, only skippable
    // frames so far, or not a zstd frame at all): whole-buffer decode
    // distinguishes corrupt (throw now) from truncated (hold).
    return this._decodeWholeBuffer(buf, bytes.length, finalizing);
  }

  _decodeWholeBuffer(buf, consumed, finalizing) {
    let out;
    try {
      out = this._decode(buf);
    } catch (err) {
      if (isZstdTruncationMessage(String((err && err.message) || ""))) {
        if (finalizing) throw bufError("unexpected end of file");
        return {
          output: PAKO_EMPTY,
          finished: false,
          consumed,
          trailing: false,
        };
      }
      throw zstdifyErrorToNode(err);
    }
    // Whole-buffer decode succeeded but the walker found no complete
    // content frame: the buffer is only skippable frames (empty output),
    // or a frame shape the walker does not cover (real output). Emit what
    // decoded; finish only on real output or a finalizing flush, so a
    // skippable-only prefix does not end a stream more content may follow.
    const output = Buffer.from(out);
    if (output.length > 0 || finalizing) {
      this.finished = true;
      return { output, finished: true, consumed, trailing: false };
    }
    return {
      output: PAKO_EMPTY,
      finished: false,
      consumed,
      trailing: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal stream implementation (browser-safe; no node:stream import)
// ---------------------------------------------------------------------------

class MiniEmitter {
  constructor() {
    this._ev = new Map();
  }
  on(ev, fn) {
    let list = this._ev.get(ev);
    if (!list) {
      list = [];
      this._ev.set(ev, list);
    }
    list.push({ fn, once: false });
    if (this._onNewListener) this._onNewListener(ev);
    return this;
  }
  once(ev, fn) {
    let list = this._ev.get(ev);
    if (!list) {
      list = [];
      this._ev.set(ev, list);
    }
    list.push({ fn, once: true });
    if (this._onNewListener) this._onNewListener(ev);
    return this;
  }
  emit(ev, ...args) {
    const list = this._ev.get(ev);
    if (!list || list.length === 0) return false;
    const copy = list.slice();
    for (const h of copy) {
      if (h.once) {
        const idx = list.indexOf(h);
        if (idx >= 0) list.splice(idx, 1);
      }
      h.fn(...args);
    }
    return true;
  }
  removeListener(ev, fn) {
    const list = this._ev.get(ev);
    if (list) {
      const idx = list.findIndex((h) => h.fn === fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    return this;
  }
  removeAllListeners(ev) {
    if (ev) this._ev.delete(ev);
    else this._ev.clear();
    return this;
  }
  listenerCount(ev) {
    const list = this._ev.get(ev);
    return list ? list.length : 0;
  }
}

function maxFlush(a, b) {
  const order = [
    Z_NO_FLUSH,
    Z_BLOCK,
    Z_PARTIAL_FLUSH,
    Z_SYNC_FLUSH,
    Z_FULL_FLUSH,
    Z_FINISH,
  ];
  return order.indexOf(a) > order.indexOf(b) ? a : b;
}

const kFlushFlag = Symbol("kFlushFlag");
const kFlushBuffers = [];
for (const f of [
  Z_NO_FLUSH,
  Z_BLOCK,
  Z_PARTIAL_FLUSH,
  Z_SYNC_FLUSH,
  Z_FULL_FLUSH,
  Z_FINISH,
]) {
  const b = Buffer.alloc(0);
  b[kFlushFlag] = f;
  kFlushBuffers[f] = b;
}

class MiniTransform extends MiniEmitter {
  constructor() {
    super();
    this._wqueue = [];
    this._wprocessing = false;
    this._wended = false;
    this._wfinished = false;
    this._endCb = null;
    this._rbuf = [];
    this._rlen = 0;
    this._flowing = false;
    this._eof = false;
    this._endEmitted = false;
    this._encoding = null;
    this._destroyed = false;
    this._closeEmitted = false;
    this.bytesWritten = 0;
    // Writable-side backpressure accounting (mirrors WritableState).
    this._wHighWaterMark = 16384;
    this._wQueuedBytes = 0;
    this._needDrain = false;
    const self = this;
    // ponytail: native stream/promises finished() (eos) reads these states,
    // not a plain stream property — lib/internal/streams/utils.js:
    // isReadableErrored/isWritableErrored read stream._readableState.errored
    // / stream._writableState.errored, isReadableNodeStream requires a
    // _readableState on a stream that also has _writableState, and
    // willEmitClose reads state.emitClose/autoDestroy/closed. Without them
    // eos() takes its "!readable" immediate branch and resolves clean on
    // nextTick before the async destroy(err) ever runs (the
    // test-zlib-reject-garbage-after-end collect() shape). Fields are kept
    // in sync at the transition points below; length/buffer/pendingcb are
    // live getters over the MiniTransform bookkeeping.
    this._writableState = {
      ended: false,
      finished: false,
      errored: null,
      errorEmitted: false,
      closed: false,
      emitClose: true,
      autoDestroy: true,
      destroyed: false,
    };
    Object.defineProperty(this._writableState, "needDrain", {
      enumerable: true,
      get: () => self._needDrain,
    });
    Object.defineProperty(this._writableState, "length", {
      enumerable: true,
      get: () => self._wQueuedBytes,
    });
    Object.defineProperty(this._writableState, "pendingcb", {
      enumerable: true,
      get: () => self._wqueue.length + (self._wprocessing ? 1 : 0),
    });
    this._readableState = {
      ended: false,
      endEmitted: false,
      errored: null,
      errorEmitted: false,
      closed: false,
      emitClose: true,
      autoDestroy: true,
      destroyed: false,
    };
    Object.defineProperty(this._readableState, "length", {
      enumerable: true,
      get: () => self._rlen,
    });
    // ponytail: NO `buffer` getter here on purpose. It is not read by
    // eos()/finished() (the L4 mechanism), and exposing the live _rbuf
    // array changes test-zlib-brotli-16GB (NO-FIX) from a fast TypeError
    // failure into an unbounded setImmediate spin: the test waits for the
    // readable buffer to reach 4 chunks (the 64 KiB HWM), which the
    // passthrough stub never fills (it echoes the 13 KiB input as 1 chunk).
    // The test still fails either way; a hang is strictly worse than a
    // fast failure for every sweep. Re-add `buffer` (one getter over _rbuf)
    // if a future lane ships a real streaming decoder.
    this._onNewListener = (ev) => {
      if (ev === "data" && !this._flowing) {
        this._flowing = true;
        queueMicrotask(() => this._flow());
      }
    };
  }
  get writableEnded() {
    return this._wended;
  }
  // Legacy Stream.pipe gates writes on `dest.writable`; without it piped
  // data is silently dropped.
  get writable() {
    return !this._destroyed && !this._wended;
  }
  get readable() {
    return !this._destroyed;
  }
  get writableFinished() {
    return this._wfinished;
  }
  get destroyed() {
    return this._destroyed;
  }
  get readableLength() {
    return this._rlen;
  }
  // Node surface (lib/internal/streams/readable.js, writable.js, utils.js):
  // readableEnded is endEmitted, not ended; errored/readableErrored/
  // writableErrored read the states' .errored; closed reads the readable
  // state's .closed. eos()/finished() consult all of these.
  get readableEnded() {
    return this._readableState.endEmitted;
  }
  get errored() {
    return this._readableState.errored ?? this._writableState.errored ?? null;
  }
  get closed() {
    return this._readableState.closed;
  }

  _normalizeChunk(chunk, encoding) {
    if (chunk == null) return Buffer.alloc(0);
    if (typeof chunk === "string")
      return Buffer.from(chunk, encoding || "utf8");
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array)
      return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (isAnyArrayBuffer(chunk)) return Buffer.from(chunk);
    throw new ERR_INVALID_ARG_TYPE(
      "chunk",
      ["string", "Buffer", "TypedArray", "DataView", "ArrayBuffer"],
      chunk,
    );
  }

  write(chunk, encoding, cb) {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    if (this._destroyed) {
      if (cb) queueMicrotask(() => cb(new ERR_STREAM_DESTROYED()));
      else queueMicrotask(() => this.emit("error", new ERR_STREAM_DESTROYED()));
      return false;
    }
    if (this._wended) {
      const err = new Error("write after end");
      err.code = "ERR_STREAM_WRITE_AFTER_END";
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => this.emit("error", err));
      return false;
    }
    // Node validates the chunk type synchronously: an invalid chunk throws
    // ERR_INVALID_ARG_TYPE out of write() (even in objectMode for zlib).
    const buf = this._normalizeChunk(chunk, encoding);
    // Preserve flush-flagged buffers.
    if (chunk && chunk[kFlushFlag] !== undefined)
      buf[kFlushFlag] = chunk[kFlushFlag];
    this._wqueue.push({ chunk: buf, cb: cb || null, encoding });
    this._wQueuedBytes += buf.length;
    // Node: write() returns false (and arms needDrain) once the buffered
    // write bytes reach the writable highWaterMark.
    this._needDrain = this._wQueuedBytes >= this._wHighWaterMark;
    queueMicrotask(() => this._pumpWrites());
    return !this._needDrain;
  }

  end(chunk, encoding, cb) {
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this._wended = true;
    this._writableState.ended = true;
    if (cb) this._endCb = cb;
    queueMicrotask(() => this._pumpWrites());
    return this;
  }

  _pumpWrites() {
    if (this._wprocessing || this._destroyed) return;
    const item = this._wqueue.shift();
    if (!item) {
      // Write buffer drained after a false return: emit 'drain' like Node.
      if (this._needDrain) {
        this._needDrain = false;
        queueMicrotask(() => {
          if (!this._destroyed) this.emit("drain");
        });
      }
      if (this._wended && !this._wfinished) {
        this._wfinished = true;
        this._writableState.finished = true;
        this._wprocessing = true;
        queueMicrotask(() => {
          if (this._destroyed) {
            this._wprocessing = false;
            return;
          }
          this._flush((err) => {
            this._wprocessing = false;
            if (err) {
              this.destroy(err);
              if (this._endCb) {
                const cb = this._endCb;
                this._endCb = null;
                cb(err);
              }
              return;
            }
            this.push(null);
            this.emit("finish");
            if (this._endCb) {
              const cb = this._endCb;
              this._endCb = null;
              cb();
            }
          });
        });
      }
      return;
    }
    this._wprocessing = true;
    this._wQueuedBytes = Math.max(0, this._wQueuedBytes - item.chunk.length);
    // A queued chunk is always written with a non-finishing flush; the
    // Z_FINISH happens in the _flush() branch below after the queue drains.
    const isLast = false;
    queueMicrotask(() => {
      if (this._destroyed) {
        this._wprocessing = false;
        return;
      }
      this._transform(item.chunk, item.encoding, isLast, (err) => {
        this._wprocessing = false;
        if (err && !this._destroyed) {
          if (item.cb) item.cb(err);
          this.destroy(err);
          return;
        }
        if (item.cb) item.cb(err || null);
        if (!this._destroyed) this._pumpWrites();
      });
    });
  }

  _transform(chunk, encoding, isLast, cb) {
    cb();
  }
  _flush(cb) {
    cb();
  }

  push(chunk) {
    if (this._destroyed) return false;
    if (chunk === null || chunk === undefined) {
      this._eof = true;
      this._readableState.ended = true;
      this._maybeEmitEnd();
      return false;
    }
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return true;
    if (this._encoding) {
      const str = buf.toString(this._encoding);
      this._rbuf.push(str);
      this._rlen += str.length;
    } else {
      this._rbuf.push(buf);
      this._rlen += buf.length;
    }
    if (this._flowing) this._flow();
    else
      queueMicrotask(() => {
        if (!this._destroyed) this.emit("readable");
      });
    return true;
  }

  _flow() {
    while (this._flowing && this._rbuf.length > 0 && !this._destroyed) {
      const chunk = this._rbuf.shift();
      this._rlen -= chunk.length;
      this.emit("data", chunk);
    }
    this._maybeEmitEnd();
  }

  _maybeEmitEnd() {
    if (
      this._eof &&
      this._rbuf.length === 0 &&
      !this._endEmitted &&
      !this._destroyed
    ) {
      this._endEmitted = true;
      this._readableState.endEmitted = true;
      queueMicrotask(() => {
        if (this._destroyed) return;
        this.emit("end");
        // Node emits 'close' after a natural 'end' (emitClose defaults true).
        this._emitClose();
      });
    }
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    queueMicrotask(() => {
      // Node sets state.closed in emitCloseNT just before emitting 'close'.
      this._readableState.closed = true;
      this._writableState.closed = true;
      this.emit("close");
    });
  }

  read(n) {
    if (this._rbuf.length === 0) {
      this._maybeEmitEnd();
      return null;
    }
    if (this._encoding) {
      const s = this._rbuf.join("");
      this._rbuf = [];
      this._rlen = 0;
      this._maybeEmitEnd();
      return s;
    }
    const buf = Buffer.concat(this._rbuf);
    this._rbuf = [];
    this._rlen = 0;
    this._maybeEmitEnd();
    if (n == null || n >= buf.length) return buf;
    const head = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this._rbuf = [Buffer.from(rest)];
    this._rlen = rest.length;
    return Buffer.from(head);
  }

  pipe(dest) {
    this.on("data", (chunk) => {
      dest.write(chunk);
    });
    this.on("end", () => {
      dest.end();
    });
    this.on("error", (err) => {
      if (dest.emit) dest.emit("error", err);
    });
    return dest;
  }
  unpipe() {
    return this;
  }

  pause() {
    this._flowing = false;
    return this;
  }
  resume() {
    if (!this._flowing) {
      this._flowing = true;
      queueMicrotask(() => this._flow());
    }
    return this;
  }
  isPaused() {
    return !this._flowing;
  }

  setEncoding(enc) {
    // Validate lightly like Node (it throws for unknown encodings on use).
    this._encoding = enc;
    return this;
  }

  destroy(err) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this._readableState.destroyed = true;
    this._writableState.destroyed = true;
    this._wqueue = [];
    this._wQueuedBytes = 0;
    this._needDrain = false;
    this._rbuf = [];
    if (err) {
      // Node's destroy() records the error on BOTH states, first error
      // wins (lib/internal/streams/destroy.js: checkError) — eos() reads
      // exactly these fields, so finished() rejects on close even when it
      // attaches after the error event already fired.
      if (!this._readableState.errored) this._readableState.errored = err;
      if (!this._writableState.errored) this._writableState.errored = err;
      queueMicrotask(() => {
        this._readableState.errorEmitted = true;
        this._writableState.errorEmitted = true;
        this.emit("error", err);
      });
    }
    this._emitClose();
    return this;
  }

  close(cb) {
    if (cb) {
      // Node calls the close callback even when already closed/destroyed.
      if (this._destroyed) queueMicrotask(cb);
      else this.once("close", cb);
    }
    this.destroy();
    return this;
  }
}

// ---------------------------------------------------------------------------
// ZlibBase and public classes
// ---------------------------------------------------------------------------

class PassThroughEngine {
  constructor() {
    this.finished = false;
  }
  reset() {
    this.finished = false;
    return this;
  }
  setParams() {}
  write(chunk, flushFlag) {
    const bytes = chunk
      ? chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(chunk)
      : new Uint8Array(0);
    if (flushFlag === Z_FINISH) this.finished = true;
    return {
      output: Buffer.from(bytes),
      finished: this.finished,
      consumed: bytes.length,
      trailing: false,
    };
  }
}

class ZlibBase extends MiniTransform {
  constructor(opts, mode) {
    super();
    const isBrotli = mode === MODE_BROTLI_ENCODE || mode === MODE_BROTLI_DECODE;
    const isZstd = mode === MODE_ZSTD_COMPRESS || mode === MODE_ZSTD_DECOMPRESS;
    const base = normalizeBaseOptions(opts, mode, defaultOptsFor(mode));
    this._chunkSize = base.chunkSize;
    // Writable highWaterMark feeds MiniTransform backpressure/needDrain.
    if (
      opts &&
      opts.highWaterMark !== undefined &&
      typeof opts.highWaterMark === "number" &&
      Number.isFinite(opts.highWaterMark) &&
      opts.highWaterMark >= 0
    ) {
      this._wHighWaterMark = Math.trunc(opts.highWaterMark);
    }
    this._outOffset = 0;
    this._defaultFlushFlag = base.flush;
    this._finishFlushFlag = base.finishFlush;
    this._defaultFullFlushFlag = base.fullFlush;
    this._info = base.info;
    this._maxOutputLength = base.maxOutputLength;
    this._rejectGarbageAfterEnd = base.rejectGarbageAfterEnd;
    this._flushBound = base.flushBound;
    this._mode = mode;
    this._level = undefined;
    this._strategy = undefined;

    const zopts = isBrotli || isZstd ? {} : normalizeZlibOptions(opts, mode);
    if (zopts.level !== undefined) this._level = zopts.level;
    if (zopts.strategy !== undefined) this._strategy = zopts.strategy;
    // ponytail: zstd pledgedSrcSize — validated in validateZstdOptions
    // before super(); stored here so _processChunkSync can fail the
    // stream at the finishing flush on a size mismatch. Decompress
    // validates the option but never enforces the count.
    if (isZstd && opts && opts.pledgedSrcSize !== undefined) {
      this._pledgedSrcSize = opts.pledgedSrcSize;
    }

    this._engine = this._createEngine(mode, zopts, opts);
    const self = this;
    this._handle = {
      reset() {
        if (self._wqueue.length > 0 || self._wprocessing) {
          throw new Error(
            "Cannot reset zlib stream while a write is in progress",
          );
        }
        self._engine.reset();
        self._emptyFrameEmitted = false;
        self._inputPrefix = Buffer.alloc(0);
      },
      close() {
        self._closed = true;
      },
    };
    this._closed = false;
    this._emptyFrameEmitted = false;
    // First bytes seen, bounded to the longest empty frame (9) — the
    // decode-side empty-frame check below. Stops growing once full.
    this._inputPrefix = Buffer.alloc(0);
  }

  _createEngine(mode, zopts, opts) {
    switch (mode) {
      case MODE_ZSTD_COMPRESS:
        return new ZstdCompressEngine(zstdCompressOptions(opts));
      case MODE_ZSTD_DECOMPRESS:
        return new ZstdDecompressEngine(zstdDecompressOptions(opts));
      case MODE_DEFLATE:
        return new PakoDeflateEngine({ wrapper: "zlib", ...zopts });
      case MODE_DEFLATERAW:
        return new PakoDeflateEngine({ wrapper: "raw", ...zopts });
      case MODE_GZIP:
        return new PakoDeflateEngine({ wrapper: "gzip", ...zopts });
      case MODE_INFLATE:
        return new PakoInflateEngine({
          wrapper: "zlib",
          windowBits: zopts.windowBits,
          dictionary: zopts.dictionary,
          rejectGarbageAfterEnd: this._rejectGarbageAfterEnd,
        });
      case MODE_INFLATERAW:
        return new PakoInflateEngine({
          wrapper: "raw",
          windowBits: zopts.windowBits,
          dictionary: zopts.dictionary,
          rejectGarbageAfterEnd: this._rejectGarbageAfterEnd,
        });
      case MODE_GUNZIP:
        return new PakoInflateEngine({
          wrapper: "gzip",
          windowBits: zopts.windowBits,
          dictionary: zopts.dictionary,
          rejectGarbageAfterEnd: this._rejectGarbageAfterEnd,
        });
      case MODE_UNZIP:
        return new PakoInflateEngine({
          wrapper: "unzip",
          windowBits: zopts.windowBits,
          dictionary: zopts.dictionary,
          rejectGarbageAfterEnd: this._rejectGarbageAfterEnd,
        });
      default:
        // Brotli: honest pass-through fallback (no codec available).
        // Zstd has a real engine above; anything else is a stub too.
        return new PassThroughEngine();
    }
  }

  _transform(chunk, encoding, isLast, cb) {
    let flushFlag = this._defaultFlushFlag;
    if (chunk && chunk[kFlushFlag] !== undefined) flushFlag = chunk[kFlushFlag];
    if (isLast) flushFlag = maxFlush(flushFlag, this._finishFlushFlag);
    this._processChunk(chunk, flushFlag, cb);
  }

  _flush(cb) {
    // If the engine already finished (last write had Z_FINISH), don't transform again.
    if (this._engine.finished) {
      cb();
      return;
    }
    this._transform(Buffer.alloc(0), undefined, true, cb);
  }

  _processChunk(chunk, flushFlag, cb) {
    if (typeof cb === "function") {
      queueMicrotask(() => {
        let out;
        try {
          out = this._processChunkSync(chunk, flushFlag);
        } catch (err) {
          cb(err);
          return;
        }
        // Emit output in chunkSize pieces like the native binding does, so
        // large single transforms still produce multiple 'data' events.
        if (out && out.length > 0) {
          for (let off = 0; off < out.length; off += this._chunkSize)
            this.push(out.subarray(off, off + this._chunkSize));
        }
        if (this._engine.trailingGarbage && !this._destroyed) {
          if (this._rejectGarbageAfterEnd) {
            cb(new ERR_TRAILING_JUNK_AFTER_STREAM_END());
            return;
          }
          this.push(null);
        }
        cb(null);
      });
      return;
    }
    return this._processChunkSync(chunk, flushFlag);
  }

  _processChunkSync(chunk, flushFlag) {
    if (this._closed || !this._handle) throw new Error("zlib binding closed");
    if (this._outOffset > this._chunkSize) {
      throw new ERR_OUT_OF_RANGE(
        "_outOffset",
        `It must be <= ${this._chunkSize}.`,
        this._outOffset,
      );
    }
    const bytes = chunk ? this._normalizeChunk(chunk) : Buffer.alloc(0);
    const result = this._engine.write(bytes, flushFlag);
    this.bytesWritten += result.consumed;
    // ponytail: zstd pledgedSrcSize — the binding fails the stream at the
    // finishing flush when the bytes written differ from the pledged size.
    // The sync path reaches this through zlibBufferSync, the async path
    // through the stream's _flush; decompress never enforces the count.
    // Checked before the empty-frame append below: a failed stream emits
    // nothing (the output would be discarded on throw either way).
    if (
      flushFlag === this._finishFlushFlag &&
      this._mode === MODE_ZSTD_COMPRESS &&
      this._pledgedSrcSize !== undefined &&
      this.bytesWritten !== this._pledgedSrcSize
    ) {
      const err = new Error("Src size is incorrect");
      err.code = "ZSTD_error_srcSize_wrong";
      err.errno = constants.ZSTD_error_srcSize_wrong;
      throw err;
    }
    // ponytail: empty-input frame for the passthrough stub only. A brotli /
    // zstd stream finalized with zero total input must emit its empty frame
    // (EMPTY_FRAME_BY_MODE); the passthrough emits nothing. Scoped to the
    // stub on purpose: when L5/L6 give these modes a real codec engine the
    // encoder emits the frame itself, and this append must not double it.
    // The flag also covers an explicit flush(FINISH) before end().
    const emptyFrame = EMPTY_FRAME_BY_MODE[this._mode];
    if (
      emptyFrame !== undefined &&
      !this._emptyFrameEmitted &&
      this._engine instanceof PassThroughEngine &&
      flushFlag === this._finishFlushFlag &&
      this.bytesWritten === 0
    ) {
      this._emptyFrameEmitted = true;
      result.output =
        result.output.length > 0
          ? Buffer.concat([result.output, emptyFrame])
          : emptyFrame;
    }
    // ponytail: decode-side twin of the empty frame. A passthrough
    // decompressor fed exactly the empty frame must yield zero bytes (the
    // frame decodes to empty output); echoing it would break the empty.txt
    // round trip in test-zlib.js once the compressor emits the frame. Only
    // the exact, whole-input-so-far frame is swallowed; anything longer
    // echoes as before (the stub's pre-existing behavior). Ceiling:
    // split-frame arrival echoes the first fragment before the frame
    // completes — the L5/L6 buffering adapters handle that properly. As with
    // the encode side, this retires when these modes get a real codec engine.
    const decodeFrame = EMPTY_FRAME_BY_DECODE_MODE[this._mode];
    if (
      decodeFrame !== undefined &&
      this._engine instanceof PassThroughEngine
    ) {
      if (this._inputPrefix.length < decodeFrame.length && bytes.length > 0) {
        const need = decodeFrame.length - this._inputPrefix.length;
        this._inputPrefix = Buffer.concat([
          this._inputPrefix,
          bytes.subarray(0, need),
        ]);
      }
      if (
        this.bytesWritten === decodeFrame.length &&
        this._inputPrefix.equals(decodeFrame)
      ) {
        result.output = PAKO_EMPTY;
      }
    }
    if (result.output.length > this._maxOutputLength) {
      throw new ERR_BUFFER_TOO_LARGE(this._maxOutputLength);
    }
    return result.output;
  }

  flush(kind, cb) {
    if (
      typeof kind === "function" ||
      (kind === undefined && cb === undefined)
    ) {
      cb = kind;
      kind = this._defaultFullFlushFlag;
    }
    kind = checkRangesOrGetDefault(
      kind,
      "kind",
      this._flushBound[0],
      this._flushBound[1],
      this._defaultFullFlushFlag,
    );
    this._flushInner(kind, cb);
  }

  // Internal flush body; re-entered directly (not via the public flush) so
  // a userland flush wrapper is only invoked once per flush() call.
  _flushInner(kind, cb) {
    if (this.writableFinished) {
      if (cb) queueMicrotask(() => cb());
    } else if (this.writableEnded) {
      if (cb) this.once("end", cb);
    } else if (this._needDrain) {
      // Node defers flush until the write buffer drains.
      this.once("drain", () => this._flushInner(kind, cb));
    } else {
      this.write(kFlushBuffers[kind], cb);
    }
  }

  params(level, strategy, callback) {
    checkRangesOrGetDefault(level, "level", Z_MIN_LEVEL, Z_MAX_LEVEL);
    checkRangesOrGetDefault(strategy, "strategy", Z_DEFAULT_STRATEGY, Z_FIXED);
    if (
      this._engine.setParams &&
      (this._level !== level || this._strategy !== strategy)
    ) {
      this.flush(Z_SYNC_FLUSH, () => {
        if (this._destroyed || !this._handle) {
          if (callback) callback();
          return;
        }
        this._engine.setParams(level, strategy);
        this._level = level;
        this._strategy = strategy;
        if (callback) callback();
      });
    } else if (callback) {
      queueMicrotask(callback);
    }
  }

  reset() {
    if (!this._handle) throw new Error("zlib binding closed");
    this._handle.reset();
    return this;
  }

  destroy(err) {
    if (!this._destroyed) {
      this._handle = null;
      this._closed = true;
    }
    return super.destroy(err);
  }
}

// Constructors (callable with or without `new`).
function validateBrotliOptions(options) {
  if (options === undefined || options === null) return;
  if (typeof options !== "object") {
    throw new ERR_INVALID_ARG_TYPE("options", "object", options);
  }
  const params = options.params;
  if (params === undefined) return;
  if (typeof params !== "object" || params === null) {
    throw new ERR_INVALID_ARG_TYPE("options.params", "object", params);
  }
  const validParams = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const key of Object.keys(params)) {
    // Detect duplicate numeric keys like '0' and '00'.
    const numKey = Number(key);
    if (!validParams.has(numKey) || String(numKey) !== key) {
      const err = new RangeError(`${key} is not a valid Brotli parameter`);
      err.code = "ERR_BROTLI_INVALID_PARAM";
      throw err;
    }
    const value = params[key];
    if (!Number.isInteger(value)) {
      throw new ERR_INVALID_ARG_TYPE(`options.params.${key}`, "integer", value);
    }
    // BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING is a boolean flag; real
    // Node rejects any other integer with ERR_ZLIB_INITIALIZATION_FAILED.
    if (numKey === 4 && value !== 0 && value !== 1) {
      throw new ERR_ZLIB_INITIALIZATION_FAILED();
    }
  }
}

// Max zstd param keys, computed from the constants like Node v24.20.0
// lib/zlib.js (kMaxZstdCParam / kMaxZstdDParam): the highest ZSTD_c_* key
// is ZSTD_c_overlapLog (402), the only ZSTD_d_* key is ZSTD_d_windowLogMax
// (100).
const kMaxZstdCParam = Math.max(
  ...Object.keys(constants).map((key) =>
    key.startsWith("ZSTD_c_") ? constants[key] : 0,
  ),
);
const kMaxZstdDParam = Math.max(
  ...Object.keys(constants).map((key) =>
    key.startsWith("ZSTD_d_") ? constants[key] : 0,
  ),
);

// ponytail: zstd option validation — mirrors Node v24.20.0 lib/zlib.js
// Zstd constructor (params key range + duplicate detection via a
// -1-filled Uint32Array, value type check) plus the binding's
// pledgedSrcSize checks, all probe-verified against real Node v24.22.1.
// Native-range checks cover only strategy (0-9) and windowLogMax
// (0 = default, else 10-31): the binding accepts any compression level
// (clamped internally) and the remaining log params' ranges are
// unprobed — extend the table only if a test demands it. Ceiling:
// test-zlib-zstd-pledged-src-size.js flips; the validation blocks of
// test-zlib-zstd.js flip too (its level-scaling block still needs L6b).
function validateZstdOptions(options, isCompress) {
  const maxParam = isCompress ? kMaxZstdCParam : kMaxZstdDParam;
  const initParams = new Uint32Array(maxParam + 1);
  initParams.fill(-1);
  if (options?.params) {
    for (const origKey of Object.keys(options.params)) {
      const key = +origKey;
      if (
        Number.isNaN(key) ||
        key < 0 ||
        key > maxParam ||
        (initParams[key] | 0) !== -1
      ) {
        const err = new RangeError(`${origKey} is not a valid zstd parameter`);
        err.code = "ERR_ZSTD_INVALID_PARAM";
        throw err;
      }
      const value = options.params[origKey];
      if (typeof value !== "number" && typeof value !== "boolean") {
        throw new ERR_INVALID_ARG_TYPE(
          "options.params[key]",
          "number",
          options.params[origKey],
        );
      }
      initParams[key] = value;
    }
    // The binding's setter rejects out-of-range strategy / windowLogMax;
    // -1 is the array's unset sentinel, 0 means "default" for the log param.
    if (isCompress) {
      const strategy = initParams[constants.ZSTD_c_strategy] | 0;
      if (strategy !== -1 && (strategy < 0 || strategy > 9)) {
        throw new ERR_ZLIB_INITIALIZATION_FAILED("Setting parameter failed");
      }
    } else {
      const windowLogMax = initParams[constants.ZSTD_d_windowLogMax] | 0;
      if (
        windowLogMax !== -1 &&
        windowLogMax !== 0 &&
        (windowLogMax < 10 || windowLogMax > 31)
      ) {
        throw new ERR_ZLIB_INITIALIZATION_FAILED("Setting parameter failed");
      }
    }
  }
  const pledgedSrcSize = options?.pledgedSrcSize;
  if (pledgedSrcSize !== undefined) {
    if (typeof pledgedSrcSize !== "number") {
      const err = new TypeError("pledgedSrcSize must be a number");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    if (!Number.isSafeInteger(pledgedSrcSize)) {
      const err = new RangeError("pledgedSrcSize must be a safe integer");
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    if (pledgedSrcSize < 0) {
      const err = new RangeError("pledgedSrcSize must be non-negative");
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
  }
}

function makeZlibClass(mode, validate, className) {
  class Z extends ZlibBase {
    constructor(opts) {
      if (validate) validate(opts);
      super(opts, mode);
    }
  }
  function Factory(opts) {
    // Support old-style inheritance: DeflateRaw.call(this, opts)
    // When called via .call() with a Factory instance as `this`
    // (new.target undefined), initialize `this` by copying fields
    // from a fresh instance. Plain calls (DeflateRaw()) and `new`
    // use the fast path below.
    if (!new.target && this instanceof Factory) {
      const fresh = new Z(opts);
      // Copy all own properties (including _ev Map, etc.)
      for (const key of Object.getOwnPropertyNames(fresh)) {
        this[key] = fresh[key];
      }
      return this;
    }
    if (!new.target) {
      // Node emits DEP0184 when a zlib class is called without `new`.
      const proc =
        typeof globalThis.process !== "undefined" ? globalThis.process : null;
      if (proc && typeof proc.emitWarning === "function") {
        proc.emitWarning(
          `Instantiating ${className} without the 'new' keyword has been deprecated.`,
          "DeprecationWarning",
          "DEP0184",
        );
      }
    }
    return new Z(opts);
  }
  Factory.prototype = Z.prototype;
  Factory.prototype.constructor = Factory;
  return Factory;
}

const Deflate = makeZlibClass(MODE_DEFLATE, undefined, "Deflate");
const Inflate = makeZlibClass(MODE_INFLATE, undefined, "Inflate");
const Gzip = makeZlibClass(MODE_GZIP, undefined, "Gzip");
const Gunzip = makeZlibClass(MODE_GUNZIP, undefined, "Gunzip");
const DeflateRaw = makeZlibClass(MODE_DEFLATERAW, undefined, "DeflateRaw");
const InflateRaw = makeZlibClass(MODE_INFLATERAW, undefined, "InflateRaw");
const Unzip = makeZlibClass(MODE_UNZIP, undefined, "Unzip");
const BrotliCompress = makeZlibClass(
  MODE_BROTLI_ENCODE,
  validateBrotliOptions,
  "BrotliCompress",
);
const BrotliDecompress = makeZlibClass(
  MODE_BROTLI_DECODE,
  validateBrotliOptions,
  "BrotliDecompress",
);
const ZstdCompress = makeZlibClass(
  MODE_ZSTD_COMPRESS,
  (opts) => validateZstdOptions(opts, true),
  "ZstdCompress",
);
const ZstdDecompress = makeZlibClass(
  MODE_ZSTD_DECOMPRESS,
  (opts) => validateZstdOptions(opts, false),
  "ZstdDecompress",
);

function createDeflate(opts) {
  return new Deflate(opts);
}
function createInflate(opts) {
  return new Inflate(opts);
}
function createDeflateRaw(opts) {
  return new DeflateRaw(opts);
}
function createInflateRaw(opts) {
  return new InflateRaw(opts);
}
function createGzip(opts) {
  return new Gzip(opts);
}
function createGunzip(opts) {
  return new Gunzip(opts);
}
function createUnzip(opts) {
  return new Unzip(opts);
}
function createBrotliCompress(opts) {
  return new BrotliCompress(opts);
}
function createBrotliDecompress(opts) {
  return new BrotliDecompress(opts);
}
function createZstdCompress(opts) {
  return new ZstdCompress(opts);
}
function createZstdDecompress(opts) {
  return new ZstdDecompress(opts);
}

// Convenience helpers.
function normalizeBufferArgs(buffer, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const bytes = toBytes(buffer);
  return { bytes, options, callback };
}

function zlibBuffer(Engine, buffer, options, callback) {
  const {
    bytes,
    options: opts,
    callback: cb,
  } = normalizeBufferArgs(buffer, options, callback);
  if (bytes === null) {
    throw new ERR_INVALID_ARG_TYPE(
      "buffer",
      "string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer",
      buffer,
    );
  }
  if (typeof cb !== "function") {
    throw new ERR_INVALID_ARG_TYPE("callback", "function", cb);
  }
  const stream = new Engine(opts);
  const chunks = [];
  let called = false;
  const done = (err) => {
    if (called) return;
    called = true;
    if (err) {
      cb(err);
      return;
    }
    const result = Buffer.concat(chunks);
    if (opts && opts.info) cb(null, { buffer: result, engine: stream });
    else cb(null, result);
  };
  stream.on("error", done);
  stream.on("data", (c) =>
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
  );
  stream.on("end", () => done(null));
  stream.end(bytes);
}

function zlibBufferSync(Engine, buffer, options) {
  const bytes = toBytes(buffer);
  if (bytes === null) {
    throw new ERR_INVALID_ARG_TYPE(
      "buffer",
      "string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer",
      buffer,
    );
  }
  const stream = new Engine(options);
  const out = stream._processChunkSync(bytes, stream._finishFlushFlag);
  // Check for trailing garbage (e.g., concatenated gzip members with
  // rejectGarbageAfterEnd: true).
  if (stream._engine.trailingGarbage && stream._rejectGarbageAfterEnd) {
    throw new ERR_TRAILING_JUNK_AFTER_STREAM_END();
  }
  if (options && options.info) return { buffer: out, engine: stream };
  return out;
}

function deflate(buffer, options, callback) {
  return zlibBuffer(Deflate, buffer, options, callback);
}
function deflateSync(buffer, options) {
  return zlibBufferSync(Deflate, buffer, options);
}
function deflateRaw(buffer, options, callback) {
  return zlibBuffer(DeflateRaw, buffer, options, callback);
}
function deflateRawSync(buffer, options) {
  return zlibBufferSync(DeflateRaw, buffer, options);
}
function gzip(buffer, options, callback) {
  return zlibBuffer(Gzip, buffer, options, callback);
}
function gzipSync(buffer, options) {
  return zlibBufferSync(Gzip, buffer, options);
}
function gunzip(buffer, options, callback) {
  return zlibBuffer(Gunzip, buffer, options, callback);
}
function gunzipSync(buffer, options) {
  return zlibBufferSync(Gunzip, buffer, options);
}
function inflate(buffer, options, callback) {
  return zlibBuffer(Inflate, buffer, options, callback);
}
function inflateSync(buffer, options) {
  return zlibBufferSync(Inflate, buffer, options);
}
function inflateRaw(buffer, options, callback) {
  return zlibBuffer(InflateRaw, buffer, options, callback);
}
function inflateRawSync(buffer, options) {
  return zlibBufferSync(InflateRaw, buffer, options);
}
function unzip(buffer, options, callback) {
  return zlibBuffer(Unzip, buffer, options, callback);
}
function unzipSync(buffer, options) {
  return zlibBufferSync(Unzip, buffer, options);
}
function brotliCompress(buffer, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  validateBrotliOptions(options);
  return zlibBuffer(BrotliCompress, buffer, options, callback);
}
function brotliCompressSync(buffer, options) {
  validateBrotliOptions(options);
  return zlibBufferSync(BrotliCompress, buffer, options);
}
function brotliDecompress(buffer, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  validateBrotliOptions(options);
  return zlibBuffer(BrotliDecompress, buffer, options, callback);
}
function brotliDecompressSync(buffer, options) {
  validateBrotliOptions(options);
  return zlibBufferSync(BrotliDecompress, buffer, options);
}
function zstdCompress(buffer, options, callback) {
  return zlibBuffer(ZstdCompress, buffer, options, callback);
}
function zstdCompressSync(buffer, options) {
  return zlibBufferSync(ZstdCompress, buffer, options);
}
function zstdDecompress(buffer, options, callback) {
  return zlibBuffer(ZstdDecompress, buffer, options, callback);
}
function zstdDecompressSync(buffer, options) {
  return zlibBufferSync(ZstdDecompress, buffer, options);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  Deflate,
  Inflate,
  Gzip,
  Gunzip,
  DeflateRaw,
  InflateRaw,
  Unzip,
  BrotliCompress,
  BrotliDecompress,
  ZstdCompress,
  ZstdDecompress,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createGzip,
  createGunzip,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,
  createZstdCompress,
  createZstdDecompress,
  deflate,
  deflateSync,
  deflateRaw,
  deflateRawSync,
  gzip,
  gzipSync,
  gunzip,
  gunzipSync,
  inflate,
  inflateSync,
  inflateRaw,
  inflateRawSync,
  unzip,
  unzipSync,
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
};

const zlibDefaultExport = {
  constants,
  codes,
  crc32,
  Deflate,
  Inflate,
  Gzip,
  Gunzip,
  DeflateRaw,
  InflateRaw,
  Unzip,
  BrotliCompress,
  BrotliDecompress,
  ZstdCompress,
  ZstdDecompress,
  createDeflate,
  createInflate,
  createDeflateRaw,
  createInflateRaw,
  createGzip,
  createGunzip,
  createUnzip,
  createBrotliCompress,
  createBrotliDecompress,
  createZstdCompress,
  createZstdDecompress,
  deflate,
  deflateSync,
  deflateRaw,
  deflateRawSync,
  gzip,
  gzipSync,
  gunzip,
  gunzipSync,
  inflate,
  inflateSync,
  inflateRaw,
  inflateRawSync,
  unzip,
  unzipSync,
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
};
Object.freeze(zlibDefaultExport);
export default zlibDefaultExport;
