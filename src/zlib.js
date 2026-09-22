// src/zlib.js — Browser-first, dependency-free port of Node.js zlib.
//
// Implements the Node v24 zlib API surface (deflate/inflate/gzip/gunzip,
// deflateRaw/inflateRaw/unzip, Brotli and Zstd facades, crc32) on top of a
// self-contained pure-JavaScript DEFLATE codec and a minimal stream
// implementation. No npm imports, no native delegation: the same code runs
// in the browser sandbox and under Node.
//
// Fidelity notes:
// - Level-0 (stored) deflate reproduces zlib's exact block emission rules,
//   including the pending-buffer path and the BFINAL=0-then-empty-final-block
//   sequence at Z_FINISH.
// - Levels 1-9 produce valid (fixed-Huffman) deflate streams. They are not
//   bit-identical to zlib's output, but round-trip correctly and are decoded
//   by the bundled inflate as well as by native implementations.
// - Inflate decodes stored/fixed/dynamic blocks and the zlib/gzip wrappers,
//   with Node-compatible error codes/messages, dictionary handling,
//   concatenated gzip members and trailing-garbage rules.
// - Brotli and Zstd codecs are honest pass-through stubs: option validation,
//   constants and stream plumbing match Node, but no actual Brotli/Zstd
//   coding is performed (documented gap).
// - Stream semantics are provided by a minimal built-in Transform
//   implementation (no node:stream import, so this stays browser-loadable).

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
  ['Z_OK', 0],
  ['Z_STREAM_END', 1],
  ['Z_NEED_DICT', 2],
  ['Z_ERRNO', -1],
  ['Z_STREAM_ERROR', -2],
  ['Z_DATA_ERROR', -3],
  ['Z_MEM_ERROR', -4],
  ['Z_BUF_ERROR', -5],
  ['Z_VERSION_ERROR', -6],
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
  if (typeof data === 'string') return Buffer.from(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (isArrayBufferView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function crc32(data, seed = 0) {
  const bytes = toBytes(data);
  if (!bytes)
    throw new ERR_INVALID_ARG_TYPE('data', ['string', 'Buffer', 'TypedArray', 'DataView', 'ArrayBuffer'], data);
  if (typeof seed !== 'number')
    throw new ERR_INVALID_ARG_TYPE('value', 'number', seed);
  seed = seed >>> 0;
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
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
    const isProperty = name.includes('.');
    const kind = isProperty ? 'property' : 'argument';
    let received;
    if (actual === undefined) received = 'Received undefined';
    else if (actual === null) received = 'Received null';
    else if (typeof actual === 'object') received = `Received ${Object.prototype.toString.call(actual)}`;
    else received = `Received type ${typeof actual} ('${actual}')`;
    super(`The "${name}" ${kind} must be of type ${expected}. ${received}`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}
class ERR_OUT_OF_RANGE extends RangeError {
  constructor(name, range, value, finiteCheck = false) {
    let msg = `The value of "${name}" is out of range.`;
    if (finiteCheck) msg += ' It must be a finite number.';
    else if (range) msg += ` ${range}`;
    msg += ` Received ${value}`;
    super(msg);
    this.code = 'ERR_OUT_OF_RANGE';
  }
}
class ERR_INVALID_ARG_VALUE extends TypeError {
  constructor(name, value, reason = 'is invalid') {
    super(`The argument "${name}" ${reason}. Received ${value}`);
    this.code = 'ERR_INVALID_ARG_VALUE';
  }
}
class ERR_BUFFER_TOO_LARGE extends Error {
  constructor(max) {
    super(`Cannot create a Buffer larger than ${max} bytes`);
    this.code = 'ERR_BUFFER_TOO_LARGE';
  }
}
class ERR_TRAILING_JUNK_AFTER_STREAM_END extends Error {
  constructor() {
    super('Trailing junk after stream end');
    this.code = 'ERR_TRAILING_JUNK_AFTER_STREAM_END';
  }
}

// ---------------------------------------------------------------------------
// Option validation (ported from lib/zlib.js)
// ---------------------------------------------------------------------------

function checkRangesOrGetDefault(value, name, min, max, def) {
  if (value === undefined) return def;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
  if (!Number.isFinite(value)) {
    throw new ERR_OUT_OF_RANGE(name, null, value, true);
  }
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(name, `It must be >= ${min} and <= ${max}.`, value);
  }
  return Math.trunc(value);
}

function validateFiniteNumber(value, name) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isArrayBufferView(v) {
  return ArrayBuffer.isView(v);
}
function isAnyArrayBuffer(v) {
  return v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);
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

// [min, max] flush bounds per family.
const FLUSH_BOUND_NORMAL = [Z_NO_FLUSH, Z_BLOCK];
const FLUSH_BOUND_BROTLI = [constants.BROTLI_OPERATION_PROCESS, constants.BROTLI_OPERATION_EMIT_METADATA];
const FLUSH_BOUND_ZSTD = [constants.ZSTD_e_continue, constants.ZSTD_e_end];

function flushBoundFor(mode) {
  if (mode === MODE_BROTLI_ENCODE || mode === MODE_BROTLI_DECODE) return FLUSH_BOUND_BROTLI;
  if (mode === MODE_ZSTD_COMPRESS || mode === MODE_ZSTD_DECOMPRESS) return FLUSH_BOUND_ZSTD;
  return FLUSH_BOUND_NORMAL;
}

function normalizeZlibOptions(opts, mode) {
  let windowBits = Z_DEFAULT_WINDOWBITS;
  let level = Z_DEFAULT_COMPRESSION;
  let memLevel = Z_DEFAULT_MEMLEVEL;
  let strategy = Z_DEFAULT_STRATEGY;
  let dictionary;

  if (opts) {
    if ((opts.windowBits == null || opts.windowBits === 0) &&
        (mode === MODE_INFLATE || mode === MODE_GUNZIP || mode === MODE_UNZIP)) {
      windowBits = 0;
    } else {
      const min = Z_MIN_WINDOWBITS + (mode === MODE_GZIP ? 1 : 0);
      windowBits = checkRangesOrGetDefault(opts.windowBits, 'options.windowBits', min, Z_MAX_WINDOWBITS, Z_DEFAULT_WINDOWBITS);
    }
    level = checkRangesOrGetDefault(opts.level, 'options.level', Z_MIN_LEVEL, Z_MAX_LEVEL, Z_DEFAULT_COMPRESSION);
    memLevel = checkRangesOrGetDefault(opts.memLevel, 'options.memLevel', Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL, Z_DEFAULT_MEMLEVEL);
    strategy = checkRangesOrGetDefault(opts.strategy, 'options.strategy', Z_DEFAULT_STRATEGY, Z_FIXED, Z_DEFAULT_STRATEGY);
    dictionary = opts.dictionary;
    if (dictionary !== undefined && !isArrayBufferView(dictionary)) {
      if (isAnyArrayBuffer(dictionary)) {
        dictionary = Buffer.from(dictionary);
      } else {
        const err = new TypeError(
          `The "options.dictionary" property must be an instance of Buffer, TypedArray, DataView, or ArrayBuffer. ` +
          `Received type ${typeof dictionary} ('${dictionary}')`
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
    }
  }
  // `{ windowBits: 8 }` on raw deflate is upgraded to 9 internally.
  if ((mode === MODE_DEFLATERAW) && windowBits === 8) windowBits = 9;
  return { windowBits, level, memLevel, strategy, dictionary };
}

function normalizeBaseOptions(opts, mode, defaults) {
  const flushBound = flushBoundFor(mode);
  let chunkSize = Z_DEFAULT_CHUNK;
  let flush = defaults.flush;
  let finishFlush = defaults.finishFlush;
  let fullFlush = defaults.fullFlush;
  let maxOutputLength = Infinity;
  let rejectGarbageAfterEnd = false;
  let info = false;

  if (opts) {
    if (opts.chunkSize !== undefined) {
      if (typeof opts.chunkSize !== 'number') {
        throw new ERR_INVALID_ARG_TYPE('options.chunkSize', 'number', opts.chunkSize);
      }
      if (!Number.isFinite(opts.chunkSize)) {
        throw new ERR_OUT_OF_RANGE('options.chunkSize', null, opts.chunkSize, true);
      }
      if (opts.chunkSize < Z_MIN_CHUNK) {
        throw new ERR_OUT_OF_RANGE('options.chunkSize', `It must be >= ${Z_MIN_CHUNK}.`, opts.chunkSize);
      }
      chunkSize = Math.trunc(opts.chunkSize);
    }
    flush = checkRangesOrGetDefault(opts.flush, 'options.flush', flushBound[0], flushBound[1], flush);
    finishFlush = checkRangesOrGetDefault(opts.finishFlush, 'options.finishFlush', flushBound[0], flushBound[1], finishFlush);
    maxOutputLength = checkRangesOrGetDefault(opts.maxOutputLength, 'options.maxOutputLength', 1, Number.MAX_SAFE_INTEGER, maxOutputLength);
    if (opts.rejectGarbageAfterEnd !== undefined && typeof opts.rejectGarbageAfterEnd !== 'boolean') {
      throw new ERR_INVALID_ARG_TYPE('options.rejectGarbageAfterEnd', 'boolean', opts.rejectGarbageAfterEnd);
    }
    rejectGarbageAfterEnd = opts.rejectGarbageAfterEnd === true;
    info = opts.info === true;
  }
  return { chunkSize, flush, finishFlush, fullFlush, maxOutputLength, rejectGarbageAfterEnd, info, flushBound };
}

const zlibDefaultOpts = { flush: Z_NO_FLUSH, finishFlush: Z_FINISH, fullFlush: Z_FULL_FLUSH };

// ---------------------------------------------------------------------------
// INFLATE — pure-JavaScript DEFLATE decoder
// ---------------------------------------------------------------------------

function dataError(message) {
  return zlibError('Z_DATA_ERROR', Z_DATA_ERROR, message);
}
function bufError(message) {
  return zlibError('Z_BUF_ERROR', Z_BUF_ERROR, message);
}

// Incremental bit reader over a list of input chunks.
class BitStream {
  constructor() {
    this.chunks = [];
    this.ci = 0;
    this.off = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
    this.consumed = 0;
  }
  append(chunk) {
    if (chunk && chunk.length) {
      this.chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
  }
  avail() {
    let n = 0;
    for (let i = this.ci; i < this.chunks.length; i++) {
      n += this.chunks[i].length - (i === this.ci ? this.off : 0);
    }
    return n;
  }
  need(n) {
    while (this.bitcnt < n) {
      if (this.ci >= this.chunks.length) return false;
      const c = this.chunks[this.ci];
      if (this.off >= c.length) { this.ci++; this.off = 0; continue; }
      this.bitbuf |= c[this.off++] << this.bitcnt;
      this.consumed++;
      this.bitcnt += 8;
    }
    return true;
  }
  get(n) {
    const v = this.bitbuf & ((1 << n) - 1);
    this.bitbuf >>>= n;
    this.bitcnt -= n;
    return v;
  }
  align() {
    const skip = this.bitcnt & 7;
    this.bitbuf >>>= skip;
    this.bitcnt -= skip;
  }
  // Byte-aligned read of exactly n bytes; null when not enough input.
  readBytes(n) {
    this.align();
    if (this.avail() < n) return null;
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      if (this.ci >= this.chunks.length) return null;
      const c = this.chunks[this.ci];
      const take = Math.min(n - o, c.length - this.off);
      out.set(c.subarray(this.off, this.off + take), o);
      this.off += take;
      this.consumed += take;
      o += take;
      if (this.off >= c.length) { this.ci++; this.off = 0; }
    }
    return out;
  }
  // Byte-aligned read of up to n bytes; null when no input at all.
  readAvailable(n) {
    this.align();
    const a = this.avail();
    if (a === 0) return null;
    return this.readBytes(Math.min(n, a));
  }
  // Discard up to n bytes, tracking remainder. Returns remaining count.
  skip(n, state) {
    this.align();
    const a = this.avail();
    const take = Math.min(n, a);
    let left = take;
    while (left > 0) {
      const c = this.chunks[this.ci];
      const t = Math.min(left, c.length - this.off);
      this.off += t;
      this.consumed += t;
      left -= t;
      if (this.off >= c.length) { this.ci++; this.off = 0; }
    }
    return n - take;
  }
  peekByte() {
    if (!this.need(8)) return -1;
    return this.bitbuf & 0xff;
  }
  // Look at the next n bytes without consuming (requires byte alignment).
  peekBytes(n) {
    if (this.bitcnt !== 0) return null;
    if (this.avail() < n) return null;
    const out = new Uint8Array(n);
    let o = 0;
    let ci = this.ci;
    let off = this.off;
    while (o < n) {
      const c = this.chunks[ci];
      const take = Math.min(n - o, c.length - off);
      out.set(c.subarray(off, off + take), o);
      off += take;
      o += take;
      if (off >= c.length) { ci++; off = 0; }
    }
    return out;
  }
  // Bytes not yet consumed (for trailing-garbage detection).
  remaining() {
    return this.avail() + (this.bitcnt > 0 ? 1 : 0);
  }
  gc() {
    if (this.ci > 8) {
      this.chunks.splice(0, this.ci);
      this.ci = 0;
    }
  }
}

// Canonical Huffman decoder built from code lengths.
function buildHuffman(lengths) {
  const n = lengths.length;
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  if (maxLen === 0) return null;
  if (maxLen > 15) throw dataError('invalid code lengths set');
  const count = new Array(maxLen + 1).fill(0);
  for (let i = 0; i < n; i++) if (lengths[i]) count[lengths[i]]++;
  let left = 1;
  for (let len = 1; len <= maxLen; len++) {
    left <<= 1;
    left -= count[len];
    if (left < 0) throw dataError('invalid code lengths set');
  }
  const first = new Array(maxLen + 1).fill(0);
  const base = new Array(maxLen + 1).fill(0);
  const symbols = [];
  let code = 0;
  let idx = 0;
  for (let len = 1; len <= maxLen; len++) {
    first[len] = code;
    base[len] = idx;
    for (let s = 0; s < n; s++) if (lengths[s] === len) { symbols.push(s); idx++; }
    code = (code + count[len]) << 1;
  }
  return { count, first, base, symbols, maxLen };
}

// Decode one symbol. `st` is {code, len} preserved across suspends.
// Returns the symbol, or -1 when more input is needed.
function decodeSymbol(h, br, st) {
  while (true) {
    if (st.len > h.maxLen) throw dataError('invalid code');
    if (!br.need(1)) return -1;
    st.code |= br.get(1);
    const len = st.len;
    if (h.count[len] !== 0) {
      const f = h.first[len];
      if (st.code >= f && st.code < f + h.count[len]) {
        const sym = h.symbols[h.base[len] + (st.code - f)];
        st.code = 0;
        st.len = 1;
        return sym;
      }
    }
    st.code <<= 1;
    st.len++;
  }
}

// Fixed Huffman tables (BTYPE=01).
const FIXED_LIT = buildHuffman(
  Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8)),
);
const FIXED_DIST = buildHuffman(new Array(32).fill(5));

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Incremental inflate engine. Feed input via write(); each call returns the
// newly produced output bytes. Throws Node-shaped errors on corrupt input.
class InflateEngine {
  constructor({ windowBits, dictionary, wrapper }) {
    // wrapper: 'zlib' | 'raw' | 'gzip' | 'unzip'
    this.wrapper = wrapper;
    this.windowBits = windowBits;
    this.dictionary = dictionary ? toBytes(dictionary) : undefined;
    this.reset();
    if (this.dictionary && wrapper === 'raw') this.seedWindow(this.dictionary);
  }
  reset() {
    this.br = new BitStream();
    this.out = [];
    this.window = new Uint8Array(32768);
    this.wpos = 0;
    this.whave = 0;
    this.adler = 1;
    this.crcState = 0xffffffff;
    this.totalOut = 0;
    this.memberOut = 0;
    this.finished = false;
    this.error = null;
    this.state = this.wrapper === 'unzip' ? 'HEAD' :
      this.wrapper === 'gzip' ? 'GH' :
      this.wrapper === 'zlib' ? 'ZH' : 'BI';
    this.bfinal = 0;
    this.litHuff = null;
    this.distHuff = null;
    this.huffState = { code: 0, len: 1 };
    this.ddNeed = 'lit';
    this.ddExt = 0;
    this.pendingLen = 0;
    this.pendingDist = 0;
    this.storedLen = 0;
    this.dl = null;
    this.skipLeft = 0;
    this.gzipFlags = 0;
    return this;
  }
  resetForNextMember() {
    this.wpos = 0;
    this.whave = 0;
    this.crcState = 0xffffffff;
    this.memberOut = 0;
    this.bfinal = 0;
    this.litHuff = null;
    this.distHuff = null;
    this.huffState = { code: 0, len: 1 };
    this.ddNeed = 'lit';
  }
  seedWindow(dict) {
    const n = Math.min(dict.length, 32768);
    const start = dict.length - n;
    for (let i = 0; i < n; i++) this.window[i] = dict[start + i];
    this.wpos = n & 32767;
    this.whave = n;
  }
  emitByte(b) {
    this.out.push(b);
    this.window[this.wpos] = b;
    this.wpos = (this.wpos + 1) & 32767;
    if (this.whave < 32768) this.whave++;
    // incremental checksums
    let s1 = this.adler & 0xffff;
    let s2 = (this.adler >>> 16) & 0xffff;
    s1 += b; if (s1 >= 65521) s1 -= 65521;
    s2 += s1; if (s2 >= 65521) s2 -= 65521;
    this.adler = (s2 << 16) | s1;
    this.crcState = (CRC_TABLE[(this.crcState ^ b) & 0xff] ^ (this.crcState >>> 8)) >>> 0;
    this.totalOut++;
    this.memberOut++;
  }
  emitBytes(bytes) {
    for (let i = 0; i < bytes.length; i++) this.emitByte(bytes[i]);
  }
  copyMatch(len, dist) {
    if (dist < 1 || dist > this.whave) throw dataError('invalid distance too far back');
    for (let i = 0; i < len; i++) {
      const b = this.window[(this.wpos - dist) & 32767];
      this.emitByte(b);
    }
  }
  // Returns { output: Buffer, finished, error, consumed }
  write(chunk, isFinal) {
    if (this.error) throw this.error;
    if (chunk && chunk.length) {
      const b = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.length);
      this.br.append(b);
    }
    const consumedBefore = this.br.consumed;
    this._isFinal = !!isFinal;
    try {
      this.pump();
    } catch (e) {
      this.error = e;
      throw e;
    } finally {
      this._isFinal = false;
    }
    const output = Buffer.from(this.out);
    this.out = [];
    if (this.finished) {
      // Trailing input after stream end (zlib/raw only; gzip handles members).
      if ((this.wrapper === 'zlib' || this.wrapper === 'raw') && this.br.remaining() > 0) {
        this.trailingGarbage = true;
      }
    } else if (isFinal && !this.error) {
      const err = bufError('unexpected end of file');
      this.error = err;
      throw err;
    }
    this.br.gc();
    return {
      output,
      finished: this.finished,
      trailing: !!this.trailingGarbage,
      consumed: this.br.consumed - consumedBefore,
    };
  }
  pump() {
    const br = this.br;
    let guard = 0;
    while (true) {
      if (++guard > 100000000) throw dataError('invalid stored block lengths');
      switch (this.state) {
        case 'DONE':
          return;
        case 'HEAD': {
          const pb = br.peekBytes(2);
          if (!pb) return;
          if (pb[0] === 0x1f && pb[1] === 0x8b) { this.wrapper = 'gzip'; this.state = 'GH'; }
          else { this.wrapper = 'zlib'; this.state = 'ZH'; }
          continue;
        }
        case 'ZH': {
          const hdr = br.readBytes(2);
          if (!hdr) return;
          const cmf = hdr[0];
          const flg = hdr[1];
          if (((cmf << 8) | flg) % 31 !== 0) throw dataError('incorrect header check');
          if ((cmf & 0x0f) !== 8) throw dataError('unknown compression method');
          if ((cmf >> 4) > 7) throw dataError('unknown compression method');
          if (this.windowBits !== 0 && (cmf >> 4) + 8 > this.windowBits) {
            throw dataError('invalid window size');
          }
          if (flg & 0x20) this.state = 'ZD';
          else this.state = 'BI';
          continue;
        }
        case 'ZD': {
          const id = br.readBytes(4);
          if (!id) return;
          const dictId = (((id[0] << 24) | (id[1] << 16) | (id[2] << 8) | id[3]) >>> 0);
          if (!this.dictionary) {
            throw zlibError('Z_NEED_DICT', Z_NEED_DICT, 'Missing dictionary');
          }
          if (adler32(this.dictionary) !== dictId) {
            throw zlibError('Z_NEED_DICT', Z_NEED_DICT, 'Bad dictionary');
          }
          this.seedWindow(this.dictionary);
          this.state = 'BI';
          continue;
        }
        case 'GH': {
          const h = br.readBytes(10);
          if (!h) return;
          if (h[0] !== 0x1f || h[1] !== 0x8b) throw dataError('incorrect header check');
          if (h[2] !== 8) throw dataError('unknown compression method');
          this.gzipFlags = h[3];
          this.state = 'GX';
          continue;
        }
        case 'GX': {
          if (this.gzipFlags & 0x04) {
            const xl = br.readBytes(2);
            if (!xl) return;
            this.skipLeft = xl[0] | (xl[1] << 8);
            this.state = 'GXS';
          } else this.state = 'GN';
          continue;
        }
        case 'GXS': {
          if (this.skipLeft > 0) {
            this.skipLeft = br.skip(this.skipLeft);
            if (this.skipLeft > 0) return;
          }
          this.state = 'GN';
          continue;
        }
        case 'GN': {
          if (this.gzipFlags & 0x08) {
            // null-terminated original file name
            while (true) {
              if (!br.need(8)) return;
              if (br.get(8) === 0) break;
            }
          }
          this.state = 'GC';
          continue;
        }
        case 'GC': {
          if (this.gzipFlags & 0x10) {
            while (true) {
              if (!br.need(8)) return;
              if (br.get(8) === 0) break;
            }
          }
          this.state = 'GHCRC';
          continue;
        }
        case 'GHCRC': {
          if (this.gzipFlags & 0x02) {
            if (!br.readBytes(2)) return;
          }
          this.state = 'BI';
          continue;
        }
        case 'BI': {
          if (!br.need(3)) return;
          this.bfinal = br.get(1);
          const btype = br.get(2);
          if (btype === 3) throw dataError('invalid block type');
          this.huffState.code = 0;
          this.huffState.len = 1;
          this.ddNeed = 'lit';
          if (btype === 0) { br.align(); this.state = 'SL'; }
          else if (btype === 1) {
            this.litHuff = FIXED_LIT;
            this.distHuff = FIXED_DIST;
            this.state = 'DD';
          } else this.state = 'DH';
          continue;
        }
        case 'SL': {
          const len = br.readBytes(4);
          if (!len) return;
          const LEN = len[0] | (len[1] << 8);
          const NLEN = len[2] | (len[3] << 8);
          if ((LEN ^ 0xffff) !== NLEN) throw dataError('invalid stored block lengths');
          this.storedLen = LEN;
          this.state = 'SD';
          continue;
        }
        case 'SD': {
          if (this.storedLen === 0) { this.state = 'BNEXT'; continue; }
          const chunk = br.readAvailable(this.storedLen);
          if (!chunk) return;
          this.emitBytes(chunk);
          this.storedLen -= chunk.length;
          continue;
        }
        case 'DH': {
          if (!br.need(14)) return;
          const hlit = br.get(5) + 257;
          const hdist = br.get(5) + 1;
          const hclen = br.get(4) + 4;
          this.dl = {
            hlit, hdist, hclen,
            clHuff: null,
            clLens: new Array(19).fill(0),
            clPos: 0,
            lens: new Array(hlit + hdist).fill(0),
            pos: 0, prev: 0, needRepeat: 0,
          };
          this.state = 'DL';
          continue;
        }
        case 'DL': {
          const dl = this.dl;
          if (!dl.clHuff) {
            // Read code lengths incrementally (3 bits at a time to avoid bitbuf overflow).
            while (dl.clPos < dl.hclen) {
              if (!br.need(3)) return;
              dl.clLens[CL_ORDER[dl.clPos]] = br.get(3);
              dl.clPos++;
            }
            dl.clHuff = buildHuffman(dl.clLens);
            if (!dl.clHuff) throw dataError('invalid code lengths set');
          }
          let progressed = false;
          while (dl.pos < dl.hlit + dl.hdist) {
            if (dl.needRepeat) {
              const rep = dl.needRepeat;
              const bits = rep === 16 ? 2 : rep === 17 ? 3 : 7;
              if (!br.need(bits)) break;
              const n = br.get(bits) + (rep === 18 ? 11 : 3);
              if (dl.pos + n > dl.hlit + dl.hdist) throw dataError('invalid code lengths set');
              const val = rep === 16 ? dl.prev : 0;
              for (let i = 0; i < n; i++) dl.lens[dl.pos++] = val;
              if (rep !== 16) dl.prev = 0;
              dl.needRepeat = 0;
              progressed = true;
              continue;
            }
            const sym = decodeSymbol(dl.clHuff, br, this.huffState);
            if (sym < 0) break;
            if (sym < 16) { dl.lens[dl.pos++] = sym; dl.prev = sym; }
            else {
              if (sym === 16 && dl.pos === 0) throw dataError('invalid code lengths set');
              dl.needRepeat = sym;
            }
            progressed = true;
          }
          if (dl.pos < dl.hlit + dl.hdist) {
            if (!progressed) return;
            continue;
          }
          if (dl.lens[256] === 0) throw dataError('invalid code lengths set');
          this.litHuff = buildHuffman(dl.lens.slice(0, dl.hlit));
          this.distHuff = buildHuffman(dl.lens.slice(dl.hlit));
          if (!this.litHuff) throw dataError('invalid code lengths set');
          // dist table may legitimately be empty (1 code); use a dummy that errors on use
          this.ddNeed = 'lit';
          this.state = 'DD';
          continue;
        }
        case 'DD': {
          let advanced = true;
          while (advanced) {
            advanced = false;
            if (this.ddNeed === 'lit') {
              const sym = decodeSymbol(this.litHuff, br, this.huffState);
              if (sym < 0) return;
              advanced = true;
              if (sym < 256) { this.emitByte(sym); continue; }
              if (sym === 256) { this.state = 'BNEXT'; break; }
              const li = sym - 257;
              this.pendingLen = LBASE[li];
              this.ddExt = LEXT[li];
              this.ddNeed = this.ddExt ? 'lenext' : 'dist';
              continue;
            }
            if (this.ddNeed === 'lenext') {
              if (!br.need(this.ddExt)) return;
              this.pendingLen += br.get(this.ddExt);
              this.ddNeed = 'dist';
              advanced = true;
              continue;
            }
            if (this.ddNeed === 'dist') {
              if (!this.distHuff) throw dataError('invalid code');
              const sym = decodeSymbol(this.distHuff, br, this.huffState);
              if (sym < 0) return;
              if (sym > 29) throw dataError('invalid distance code');
              this.pendingDist = DBASE[sym];
              this.ddExt = DEXT[sym];
              this.ddNeed = this.ddExt ? 'distext' : 'match';
              advanced = true;
              continue;
            }
            if (this.ddNeed === 'distext') {
              if (!br.need(this.ddExt)) return;
              this.pendingDist += br.get(this.ddExt);
              this.ddNeed = 'match';
              advanced = true;
              continue;
            }
            if (this.ddNeed === 'match') {
              this.copyMatch(this.pendingLen, this.pendingDist);
              this.ddNeed = 'lit';
              advanced = true;
              continue;
            }
          }
          if (this.state === 'DD') return;
          continue;
        }
        case 'BNEXT': {
          if (this.bfinal) {
            if (this.wrapper === 'zlib') this.state = 'ZA';
            else if (this.wrapper === 'gzip') { br.align(); this.state = 'GT'; }
            else { this.finished = true; this.state = 'DONE'; }
          } else {
            this.state = 'BI';
          }
          continue;
        }
        case 'ZA': {
          const a = br.readBytes(4);
          if (!a) return;
          const expect = (((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0);
          if (expect !== (this.adler >>> 0)) throw dataError('incorrect data check');
          this.finished = true;
          this.state = 'DONE';
          continue;
        }
        case 'GT': {
          const t = br.readBytes(8);
          if (!t) return;
          const crcExpect = ((t[0] | (t[1] << 8) | (t[2] << 16) | (t[3] << 24)) >>> 0);
          const isizeExpect = ((t[4] | (t[5] << 8) | (t[6] << 16) | (t[7] << 24)) >>> 0);
          if (crcExpect !== ((this.crcState ^ 0xffffffff) >>> 0)) throw dataError('incorrect data check');
          if (isizeExpect !== (this.memberOut >>> 0)) throw dataError('incorrect length check');
          this.state = 'GNEXT';
          continue;
        }
        case 'GNEXT': {
          br.gc();
          if (br.remaining() === 0) {
            if (this._isFinal) {
              this.finished = true;
              this.state = 'DONE';
            }
            // Otherwise wait: another member may arrive in a later write.
            return;
          }
          const pb = br.peekBytes(1);
          if (!pb) return;
          if (pb[0] === 0x00) {
            // Trailing zero padding is ignored.
            this.finished = true;
            this.state = 'DONE';
            continue;
          }
          this.resetForNextMember();
          this.state = 'GH';
          continue;
        }
        default:
          throw dataError('invalid state');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DEFLATE — pure-JavaScript DEFLATE encoder
// ---------------------------------------------------------------------------

class BitWriter {
  constructor() {
    this.out = [];
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  bits(value, n) {
    this.bitbuf |= (value << this.bitcnt) >>> 0;
    this.bitcnt += n;
    while (this.bitcnt >= 8) {
      this.out.push(this.bitbuf & 0xff);
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  align() {
    if (this.bitcnt > 0) {
      this.out.push(this.bitbuf & 0xff);
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
  }
  bytes(arr) {
    this.align();
    for (let i = 0; i < arr.length; i++) this.out.push(arr[i] & 0xff);
  }
  u16le(v) {
    this.bytes([(v & 0xff), (v >>> 8) & 0xff]);
  }
  u32le(v) {
    this.bytes([(v & 0xff), (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  }
  u32be(v) {
    this.bytes([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  }
}

// Fixed-Huffman encode tables (RFC 1951 §3.2.6).
// Codes are bit-reversed for LSB-first writing (Huffman codes are packed MSB-first).
function reverseBits(code, len) {
  let rev = 0;
  for (let i = 0; i < len; i++) {
    rev = (rev << 1) | ((code >> i) & 1);
  }
  return rev;
}
const FIXED_LIT_CODE = new Array(288);
const FIXED_LIT_LEN = new Array(288);
for (let i = 0; i < 144; i++) { FIXED_LIT_CODE[i] = reverseBits(0x30 + i, 8); FIXED_LIT_LEN[i] = 8; }
for (let i = 144; i < 256; i++) { FIXED_LIT_CODE[i] = reverseBits(0x190 + (i - 144), 9); FIXED_LIT_LEN[i] = 9; }
for (let i = 256; i < 280; i++) { FIXED_LIT_CODE[i] = reverseBits(i - 256, 7); FIXED_LIT_LEN[i] = 7; }
for (let i = 280; i < 288; i++) { FIXED_LIT_CODE[i] = reverseBits(0xc0 + (i - 280), 8); FIXED_LIT_LEN[i] = 8; }
// Fixed distance codes (5 bits, MSB-first).
const FIXED_DIST_CODE = new Array(32);
for (let i = 0; i < 32; i++) FIXED_DIST_CODE[i] = reverseBits(i, 5);

function lengthCode(len) {
  for (let i = 0; i < 29; i++) {
    const base = LBASE[i];
    const ext = LEXT[i];
    if (len >= base && len < base + (1 << ext)) return [257 + i, ext, len - base];
  }
  return [285, 0, 0];
}

function distCode(dist) {
  for (let i = 0; i < 30; i++) {
    const base = DBASE[i];
    const ext = DEXT[i];
    if (dist >= base && dist < base + (1 << ext)) return [i, ext, dist - base];
  }
  return [29, 13, 0];
}

class DeflateEngine {
  constructor({ level, windowBits, strategy, dictionary, wrapper }) {
    this.level = level === Z_DEFAULT_COMPRESSION ? 6 : level;
    this.windowBits = windowBits;
    this.strategy = strategy;
    this.wrapper = wrapper; // 'zlib' | 'raw' | 'gzip'
    this.dictionary = dictionary ? toBytes(dictionary) : undefined;
    this.bw = new BitWriter();
    this.reset();
  }
  reset() {
    this.pending = [];
    this.hist = [];
    this.hash = new Map();
    this.finished = false;
    this.adler = 1;
    this.crcState = 0xffffffff;
    this.totalIn = 0;
    this.headerDone = false;
    this.bw = new BitWriter();
    if (this.dictionary) {
      const n = Math.min(this.dictionary.length, 32768);
      for (let i = this.dictionary.length - n; i < this.dictionary.length; i++) {
        this.hist.push(this.dictionary[i]);
      }
      // Prime the hash with dictionary positions.
      for (let i = 0; i + 3 <= n; i++) {
        const p = this.hist.length - n + i;
        const h = ((this.hist[p] << 10) ^ (this.hist[p + 1] << 5) ^ this.hist[p + 2]) & 32767;
        let chain = this.hash.get(h);
        if (!chain) { chain = []; this.hash.set(h, chain); }
        chain.push(p);
      }
    }
    return this;
  }
  setParams(level, strategy) {
    this.level = level === Z_DEFAULT_COMPRESSION ? 6 : level;
    this.strategy = strategy;
  }
  updateChecksums(bytes) {
    let s1 = this.adler & 0xffff;
    let s2 = (this.adler >>> 16) & 0xffff;
    let crc = this.crcState;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      s1 += b; if (s1 >= 65521) s1 -= 65521;
      s2 += s1; if (s2 >= 65521) s2 -= 65521;
      crc = (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
    }
    this.adler = ((s2 << 16) | s1) >>> 0;
    this.crcState = crc;
    this.totalIn += bytes.length;
  }
  writeHeader() {
    const bw = this.bw;
    if (this.wrapper === 'zlib') {
      const flevel = this.level <= 1 ? 0 : this.level <= 5 ? 1 : this.level <= 6 ? 2 : 3;
      let flg = flevel << 6;
      if (this.dictionary) flg |= 0x20;
      const cmf = 0x78;
      flg |= (31 - (((cmf << 8) | flg) % 31)) % 31;
      bw.bytes([cmf, flg]);
      if (this.dictionary) bw.u32be(adler32(this.dictionary));
    } else if (this.wrapper === 'gzip') {
      const xfl = this.level === 9 ? 2 : this.level <= 1 ? 4 : 0;
      bw.bytes([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, xfl, 0x03]);
    }
    this.headerDone = true;
  }
  writeTrailer() {
    const bw = this.bw;
    bw.align();
    if (this.wrapper === 'zlib') bw.u32be(this.adler);
    else if (this.wrapper === 'gzip') {
      bw.u32le((this.crcState ^ 0xffffffff) >>> 0);
      bw.u32le(this.totalIn >>> 0);
    }
  }
  // Stored (level-0) block emission with zlib's exact rules.
  storedBlock(data, bfinal) {
    const bw = this.bw;
    bw.bits(bfinal ? 1 : 0, 1);
    bw.bits(0, 2); // BTYPE=00
    bw.align();
    const len = data.length;
    bw.u16le(len);
    bw.u16le(len ^ 0xffff);
    bw.bytes(data);
  }
  deflateStored(flushFlag) {
    // Observable rules derived from zlib's deflate_stored:
    // - Z_NO_FLUSH: buffer; emit BFINAL=0 blocks while >= 32768 pending.
    // - SYNC/FULL_FLUSH: emit all pending as BFINAL=0, then empty stored block.
    // - FINISH: emit all pending (last data block BFINAL=1); empty BFINAL=1
    //   block when nothing was pending.
    const MIN_BLOCK = 32768;
    const MAX_STORED = 65531; // pending_buf_size - 5
    if (flushFlag === Z_NO_FLUSH) {
      while (this.pending.length >= MIN_BLOCK) {
        const n = Math.min(this.pending.length, MAX_STORED);
        this.storedBlock(this.pending.slice(0, n), false);
        this.pending = this.pending.slice(n);
      }
      return;
    }
    if (flushFlag === Z_SYNC_FLUSH || flushFlag === Z_FULL_FLUSH || flushFlag === Z_PARTIAL_FLUSH || flushFlag === Z_BLOCK) {
      while (this.pending.length > 0) {
        const n = Math.min(this.pending.length, MAX_STORED);
        const last = n === this.pending.length;
        // Sync flush: data blocks are BFINAL=0, then an empty stored block.
        this.storedBlock(this.pending.slice(0, n), false);
        this.pending = this.pending.slice(n);
      }
      this.storedBlock([], false); // empty stored block
      return;
    }
    if (flushFlag === Z_FINISH) {
      if (this.pending.length === 0) {
        this.storedBlock([], true);
      } else {
        while (this.pending.length > 0) {
          const n = Math.min(this.pending.length, MAX_STORED);
          const last = n === this.pending.length;
          this.storedBlock(this.pending.slice(0, n), last);
          this.pending = this.pending.slice(n);
        }
      }
      this.writeTrailer();
      this.finished = true;
    }
  }
  getHistByte(p) {
    return this.hist[p];
  }
  lz77(data) {
    const strategy = this.strategy;
    const level = this.level;
    const symbols = [];
    const n = data.length;
    const basePos = this.hist.length;
    const maxChain = [0, 2, 4, 8, 16, 32, 64, 128, 256, 512][level] || 32;
    const niceLen = [0, 8, 16, 32, 32, 64, 128, 128, 258, 258][level] || 32;
    const useMatches = strategy !== Z_HUFFMAN_ONLY && level > 0;
    let i = 0;
    const getByte = (p) => (p < basePos ? this.hist[p] : data[p - basePos]);
    while (i < n) {
      let bestLen = 0;
      let bestDist = 0;
      if (useMatches && i + 3 <= n) {
        const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 32767;
        const chain = this.hash.get(h);
        if (chain) {
          const absPos = basePos + i;
          let searched = 0;
          for (let ci = chain.length - 1; ci >= 0 && searched < maxChain; ci--, searched++) {
            const p = chain[ci];
            const dist = absPos - p;
            if (dist < 1 || dist > 32768) continue;
            if (strategy === Z_RLE && dist !== 1) continue;
            if (getByte(p) !== data[i]) continue;
            let len = 1;
            const maxLen = Math.min(258, n - i);
            while (len < maxLen && getByte(p + len) === data[i + len]) len++;
            if (len >= 3 && len > bestLen) {
              bestLen = len;
              bestDist = dist;
              if (len >= niceLen) break;
            }
          }
        }
      }
      if (bestLen >= 3) {
        symbols.push({ len: bestLen, dist: bestDist });
        for (let k = 0; k < bestLen; k++) {
          if (i + k + 3 <= n) {
            const h = ((data[i + k] << 10) ^ (data[i + k + 1] << 5) ^ data[i + k + 2]) & 32767;
            let chain = this.hash.get(h);
            if (!chain) { chain = []; this.hash.set(h, chain); }
            chain.push(basePos + i + k);
          }
        }
        i += bestLen;
      } else {
        symbols.push(data[i]);
        if (i + 3 <= n) {
          const h = ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 32767;
          let chain = this.hash.get(h);
          if (!chain) { chain = []; this.hash.set(h, chain); }
          chain.push(basePos + i);
        }
        i++;
      }
    }
    for (let k = 0; k < n; k++) this.hist.push(data[k]);
    // Bound memory: keep at most 1M history bytes.
    if (this.hist.length > 1048576) {
      const drop = this.hist.length - 1048576;
      this.hist.splice(0, drop);
      // Hash positions are now stale; rebuild lazily by clearing.
      this.hash.clear();
    }
    return symbols;
  }
  writeFixedBlock(symbols, bfinal) {
    const bw = this.bw;
    bw.bits(bfinal ? 1 : 0, 1);
    bw.bits(1, 2); // BTYPE=01 fixed Huffman
    for (const s of symbols) {
      if (typeof s === 'number') {
        bw.bits(FIXED_LIT_CODE[s], FIXED_LIT_LEN[s]);
      } else {
        const [lc, lext, lval] = lengthCode(s.len);
        bw.bits(FIXED_LIT_CODE[lc], FIXED_LIT_LEN[lc]);
        if (lext) bw.bits(lval, lext);
        const [dc, dext, dval] = distCode(s.dist);
        bw.bits(FIXED_DIST_CODE[dc], 5);
        if (dext) bw.bits(dval, dext);
      }
    }
    bw.bits(FIXED_LIT_CODE[256], FIXED_LIT_LEN[256]); // end of block
  }
  deflateCompressed(flushFlag) {
    const NO_FLUSH_THRESHOLD = 32768;
    const emitBlock = (bfinal) => {
      if (this.pending.length === 0) return false;
      // Split very large buffers to keep blocks sane.
      let offset = 0;
      let first = true;
      while (offset < this.pending.length) {
        const chunk = this.pending.slice(offset, offset + 32768);
        const isLast = offset + 32768 >= this.pending.length;
        const symbols = this.lz77(chunk);
        this.writeFixedBlock(symbols, bfinal && isLast);
        offset += 32768;
        first = false;
      }
      this.pending = [];
      return true;
    };
    if (flushFlag === Z_NO_FLUSH) {
      while (this.pending.length >= NO_FLUSH_THRESHOLD) {
        const chunk = this.pending.slice(0, 32768);
        this.pending = this.pending.slice(32768);
        const symbols = this.lz77(chunk);
        this.writeFixedBlock(symbols, false);
      }
      return;
    }
    if (flushFlag === Z_SYNC_FLUSH || flushFlag === Z_FULL_FLUSH || flushFlag === Z_PARTIAL_FLUSH || flushFlag === Z_BLOCK) {
      emitBlock(false);
      this.bw.align();
      this.storedBlock([], false); // empty stored block
      if (flushFlag === Z_FULL_FLUSH) this.hash.clear();
      return;
    }
    if (flushFlag === Z_FINISH) {
      if (this.pending.length === 0) {
        // Emit an empty fixed block with BFINAL=1.
        this.writeFixedBlock([], true);
      } else {
        emitBlock(true);
      }
      this.bw.align();
      this.writeTrailer();
      this.finished = true;
    }
  }
  write(chunk, flushFlag) {
    if (this.finished) {
      throw zlibError('Z_STREAM_ERROR', -2, 'write after finish');
    }
    const bytes = chunk ? (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.length)) : new Uint8Array(0);
    if (bytes.length) {
      const arr = Array.from(bytes);
      for (let i = 0; i < arr.length; i++) this.pending.push(arr[i]);
      this.updateChecksums(bytes);
    }
    if (!this.headerDone) this.writeHeader();
    if (this.level === 0) this.deflateStored(flushFlag);
    else this.deflateCompressed(flushFlag);
    const output = Buffer.from(this.bw.out);
    this.bw.out = [];
    return { output, finished: this.finished, consumed: bytes.length, trailing: false };
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
    if (!list) { list = []; this._ev.set(ev, list); }
    list.push({ fn, once: false });
    if (this._onNewListener) this._onNewListener(ev);
    return this;
  }
  once(ev, fn) {
    let list = this._ev.get(ev);
    if (!list) { list = []; this._ev.set(ev, list); }
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
  const order = [Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH];
  return order.indexOf(a) > order.indexOf(b) ? a : b;
}

const kFlushFlag = Symbol('kFlushFlag');
const kFlushBuffers = [];
for (const f of [Z_NO_FLUSH, Z_BLOCK, Z_PARTIAL_FLUSH, Z_SYNC_FLUSH, Z_FULL_FLUSH, Z_FINISH]) {
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
    this.bytesWritten = 0;
    this._onNewListener = (ev) => {
      if (ev === 'data' && !this._flowing) {
        this._flowing = true;
        queueMicrotask(() => this._flow());
      }
    };
  }
  get writableEnded() { return this._wended; }
  get writableFinished() { return this._wfinished; }
  get destroyed() { return this._destroyed; }
  get readableLength() { return this._rlen; }

  _normalizeChunk(chunk, encoding) {
    if (chunk == null) return Buffer.alloc(0);
    if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (isAnyArrayBuffer(chunk)) return Buffer.from(chunk);
    throw new ERR_INVALID_ARG_TYPE('chunk', ['string', 'Buffer', 'TypedArray', 'DataView', 'ArrayBuffer'], chunk);
  }

  write(chunk, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (this._destroyed) {
      if (cb) queueMicrotask(() => cb(new Error('write after destroy')));
      return false;
    }
    if (this._wended) {
      const err = new Error('write after end');
      err.code = 'ERR_STREAM_WRITE_AFTER_END';
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => this.emit('error', err));
      return false;
    }
    let buf;
    try {
      buf = this._normalizeChunk(chunk, encoding);
    } catch (err) {
      if (cb) queueMicrotask(() => cb(err));
      else queueMicrotask(() => this.emit('error', err));
      return false;
    }
    // Preserve flush-flagged buffers.
    if (chunk && chunk[kFlushFlag] !== undefined) buf[kFlushFlag] = chunk[kFlushFlag];
    this._wqueue.push({ chunk: buf, cb: cb || null, encoding });
    queueMicrotask(() => this._pumpWrites());
    return this._rlen < 16384;
  }

  end(chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
    else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this._wended = true;
    if (cb) this._endCb = cb;
    queueMicrotask(() => this._pumpWrites());
    return this;
  }

  _pumpWrites() {
    if (this._wprocessing || this._destroyed) return;
    const item = this._wqueue.shift();
    if (!item) {
      if (this._wended && !this._wfinished) {
        this._wfinished = true;
        this._wprocessing = true;
        queueMicrotask(() => {
          if (this._destroyed) { this._wprocessing = false; return; }
          this._flush((err) => {
            this._wprocessing = false;
            if (err) {
              this.destroy(err);
              if (this._endCb) { const cb = this._endCb; this._endCb = null; cb(err); }
              return;
            }
            this.push(null);
            this.emit('finish');
            if (this._endCb) { const cb = this._endCb; this._endCb = null; cb(); }
          });
        });
      }
      return;
    }
    this._wprocessing = true;
    // A queued chunk is always written with a non-finishing flush; the
    // Z_FINISH happens in the _flush() branch below after the queue drains.
    const isLast = false;
    queueMicrotask(() => {
      if (this._destroyed) { this._wprocessing = false; return; }
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

  _transform(chunk, encoding, isLast, cb) { cb(); }
  _flush(cb) { cb(); }

  push(chunk) {
    if (this._destroyed) return false;
    if (chunk === null || chunk === undefined) {
      this._eof = true;
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
    else queueMicrotask(() => { if (!this._destroyed) this.emit('readable'); });
    return true;
  }

  _flow() {
    while (this._flowing && this._rbuf.length > 0 && !this._destroyed) {
      const chunk = this._rbuf.shift();
      this._rlen -= chunk.length;
      this.emit('data', chunk);
    }
    this._maybeEmitEnd();
  }

  _maybeEmitEnd() {
    if (this._eof && this._rbuf.length === 0 && !this._endEmitted && !this._destroyed) {
      this._endEmitted = true;
      queueMicrotask(() => { if (!this._destroyed) this.emit('end'); });
    }
  }

  read(n) {
    if (this._rbuf.length === 0) {
      this._maybeEmitEnd();
      return null;
    }
    if (this._encoding) {
      const s = this._rbuf.join('');
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
    this.on('data', (chunk) => { dest.write(chunk); });
    this.on('end', () => { dest.end(); });
    this.on('error', (err) => { if (dest.emit) dest.emit('error', err); });
    return dest;
  }
  unpipe() { return this; }

  pause() { this._flowing = false; return this; }
  resume() {
    if (!this._flowing) {
      this._flowing = true;
      queueMicrotask(() => this._flow());
    }
    return this;
  }
  isPaused() { return !this._flowing; }

  setEncoding(enc) {
    // Validate lightly like Node (it throws for unknown encodings on use).
    this._encoding = enc;
    return this;
  }

  destroy(err) {
    if (this._destroyed) return this;
    this._destroyed = true;
    this._wqueue = [];
    this._rbuf = [];
    if (err) queueMicrotask(() => this.emit('error', err));
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  close(cb) {
    if (cb) this.once('close', cb);
    this.destroy();
    return this;
  }
}

// ---------------------------------------------------------------------------
// ZlibBase and public classes
// ---------------------------------------------------------------------------

class PassThroughEngine {
  constructor() { this.finished = false; }
  reset() { this.finished = false; return this; }
  setParams() {}
  write(chunk, flushFlag) {
    const bytes = chunk ? (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)) : new Uint8Array(0);
    if (flushFlag === Z_FINISH) this.finished = true;
    return { output: Buffer.from(bytes), finished: this.finished, consumed: bytes.length, trailing: false };
  }
}

class ZlibBase extends MiniTransform {
  constructor(opts, mode) {
    super();
    const isBrotli = mode === MODE_BROTLI_ENCODE || mode === MODE_BROTLI_DECODE;
    const isZstd = mode === MODE_ZSTD_COMPRESS || mode === MODE_ZSTD_DECOMPRESS;
    const base = normalizeBaseOptions(opts, mode, zlibDefaultOpts);
    this._chunkSize = base.chunkSize;
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

    const zopts = (isBrotli || isZstd) ? {} : normalizeZlibOptions(opts, mode);
    if (zopts.level !== undefined) this._level = zopts.level;
    if (zopts.strategy !== undefined) this._strategy = zopts.strategy;

    this._engine = this._createEngine(mode, zopts);
    const self = this;
    this._handle = {
      reset() {
        if (self._wqueue.length > 0 || self._wprocessing) {
          throw new Error('Cannot reset zlib stream while a write is in progress');
        }
        self._engine.reset();
      },
      close() {
        self._closed = true;
      },
    };
    this._closed = false;
  }

  _createEngine(mode, zopts) {
    switch (mode) {
      case MODE_DEFLATE:
        return new DeflateEngine({ wrapper: 'zlib', ...zopts });
      case MODE_DEFLATERAW:
        return new DeflateEngine({ wrapper: 'raw', ...zopts });
      case MODE_GZIP:
        return new DeflateEngine({ wrapper: 'gzip', ...zopts });
      case MODE_INFLATE:
        return new InflateEngine({ wrapper: 'zlib', windowBits: zopts.windowBits, dictionary: zopts.dictionary });
      case MODE_INFLATERAW:
        return new InflateEngine({ wrapper: 'raw', windowBits: zopts.windowBits, dictionary: zopts.dictionary });
      case MODE_GUNZIP:
        return new InflateEngine({ wrapper: 'gzip', windowBits: zopts.windowBits, dictionary: zopts.dictionary });
      case MODE_UNZIP:
        return new InflateEngine({ wrapper: 'unzip', windowBits: zopts.windowBits, dictionary: zopts.dictionary });
      default:
        // Brotli / Zstd: honest pass-through fallback (no codec available).
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
    if (typeof cb === 'function') {
      queueMicrotask(() => {
        let out;
        try {
          out = this._processChunkSync(chunk, flushFlag);
        } catch (err) {
          cb(err);
          return;
        }
        if (out && out.length > 0) this.push(out);
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
    if (this._closed || !this._handle) throw new Error('zlib binding closed');
    if (this._outOffset > this._chunkSize) {
      throw new ERR_OUT_OF_RANGE('_outOffset', `It must be <= ${this._chunkSize}.`, this._outOffset);
    }
    const bytes = chunk ? this._normalizeChunk(chunk) : Buffer.alloc(0);
    const result = this._engine.write(bytes, flushFlag);
    this.bytesWritten += result.consumed;
    if (result.output.length > this._maxOutputLength) {
      throw new ERR_BUFFER_TOO_LARGE(this._maxOutputLength);
    }
    return result.output;
  }

  flush(kind, cb) {
    if (typeof kind === 'function' || (kind === undefined && cb === undefined)) {
      cb = kind;
      kind = this._defaultFullFlushFlag;
    }
    kind = checkRangesOrGetDefault(kind, 'kind', this._flushBound[0], this._flushBound[1], this._defaultFullFlushFlag);
    if (this.writableFinished) {
      if (cb) queueMicrotask(() => cb());
    } else if (this.writableEnded) {
      if (cb) this.once('end', cb);
    } else {
      this.write(kFlushBuffers[kind], cb);
    }
  }

  params(level, strategy, callback) {
    checkRangesOrGetDefault(level, 'level', Z_MIN_LEVEL, Z_MAX_LEVEL);
    checkRangesOrGetDefault(strategy, 'strategy', Z_DEFAULT_STRATEGY, Z_FIXED);
    if (this._engine.setParams && (this._level !== level || this._strategy !== strategy)) {
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
    if (!this._handle) throw new Error('zlib binding closed');
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
  if (typeof options !== 'object') {
    throw new ERR_INVALID_ARG_TYPE('options', 'object', options);
  }
  const params = options.params;
  if (params === undefined) return;
  if (typeof params !== 'object' || params === null) {
    throw new ERR_INVALID_ARG_TYPE('options.params', 'object', params);
  }
  const validParams = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  for (const key of Object.keys(params)) {
    // Detect duplicate numeric keys like '0' and '00'.
    const numKey = Number(key);
    if (!validParams.has(numKey) || String(numKey) !== key) {
      const err = new RangeError(`${key} is not a valid Brotli parameter`);
      err.code = 'ERR_BROTLI_INVALID_PARAM';
      throw err;
    }
    const value = params[key];
    if (!Number.isInteger(value)) {
      throw new ERR_INVALID_ARG_TYPE(`options.params.${key}`, 'integer', value);
    }
  }
}

function makeZlibClass(mode, validate) {
  class Z extends ZlibBase {
    constructor(opts) {
      if (validate) validate(opts);
      super(opts, mode);
    }
  }
  function Factory(opts) {
    return new Z(opts);
  }
  Factory.prototype = Z.prototype;
  Factory.prototype.constructor = Factory;
  return Factory;
}

const Deflate = makeZlibClass(MODE_DEFLATE);
const Inflate = makeZlibClass(MODE_INFLATE);
const Gzip = makeZlibClass(MODE_GZIP);
const Gunzip = makeZlibClass(MODE_GUNZIP);
const DeflateRaw = makeZlibClass(MODE_DEFLATERAW);
const InflateRaw = makeZlibClass(MODE_INFLATERAW);
const Unzip = makeZlibClass(MODE_UNZIP);
const BrotliCompress = makeZlibClass(MODE_BROTLI_ENCODE, validateBrotliOptions);
const BrotliDecompress = makeZlibClass(MODE_BROTLI_DECODE, validateBrotliOptions);
const ZstdCompress = makeZlibClass(MODE_ZSTD_COMPRESS);
const ZstdDecompress = makeZlibClass(MODE_ZSTD_DECOMPRESS);

function createDeflate(opts) { return new Deflate(opts); }
function createInflate(opts) { return new Inflate(opts); }
function createDeflateRaw(opts) { return new DeflateRaw(opts); }
function createInflateRaw(opts) { return new InflateRaw(opts); }
function createGzip(opts) { return new Gzip(opts); }
function createGunzip(opts) { return new Gunzip(opts); }
function createUnzip(opts) { return new Unzip(opts); }
function createBrotliCompress(opts) { return new BrotliCompress(opts); }
function createBrotliDecompress(opts) { return new BrotliDecompress(opts); }
function createZstdCompress(opts) { return new ZstdCompress(opts); }
function createZstdDecompress(opts) { return new ZstdDecompress(opts); }

// Convenience helpers.
function normalizeBufferArgs(buffer, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  const bytes = toBytes(buffer);
  return { bytes, options, callback };
}

function zlibBuffer(Engine, buffer, options, callback) {
  const { bytes, options: opts, callback: cb } = normalizeBufferArgs(buffer, options, callback);
  if (typeof cb !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('callback', 'function', cb);
  }
  const stream = new Engine(opts);
  const chunks = [];
  let called = false;
  const done = (err) => {
    if (called) return;
    called = true;
    if (err) { cb(err); return; }
    const result = Buffer.concat(chunks);
    if (opts && opts.info) cb(null, { buffer: result, engine: stream });
    else cb(null, result);
  };
  stream.on('error', done);
  stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  stream.on('end', () => done(null));
  stream.end(bytes);
}

function zlibBufferSync(Engine, buffer, options) {
  const bytes = toBytes(buffer);
  const stream = new Engine(options);
  const out = stream._processChunkSync(bytes, stream._finishFlushFlag);
  if (options && options.info) return { buffer: out, engine: stream };
  return out;
}

function deflate(buffer, options, callback) { return zlibBuffer(Deflate, buffer, options, callback); }
function deflateSync(buffer, options) { return zlibBufferSync(Deflate, buffer, options); }
function deflateRaw(buffer, options, callback) { return zlibBuffer(DeflateRaw, buffer, options, callback); }
function deflateRawSync(buffer, options) { return zlibBufferSync(DeflateRaw, buffer, options); }
function gzip(buffer, options, callback) { return zlibBuffer(Gzip, buffer, options, callback); }
function gzipSync(buffer, options) { return zlibBufferSync(Gzip, buffer, options); }
function gunzip(buffer, options, callback) { return zlibBuffer(Gunzip, buffer, options, callback); }
function gunzipSync(buffer, options) { return zlibBufferSync(Gunzip, buffer, options); }
function inflate(buffer, options, callback) { return zlibBuffer(Inflate, buffer, options, callback); }
function inflateSync(buffer, options) { return zlibBufferSync(Inflate, buffer, options); }
function inflateRaw(buffer, options, callback) { return zlibBuffer(InflateRaw, buffer, options, callback); }
function inflateRawSync(buffer, options) { return zlibBufferSync(InflateRaw, buffer, options); }
function unzip(buffer, options, callback) { return zlibBuffer(Unzip, buffer, options, callback); }
function unzipSync(buffer, options) { return zlibBufferSync(Unzip, buffer, options); }
function brotliCompress(buffer, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  validateBrotliOptions(options);
  return zlibBuffer(BrotliCompress, buffer, options, callback);
}
function brotliCompressSync(buffer, options) {
  validateBrotliOptions(options);
  return zlibBufferSync(BrotliCompress, buffer, options);
}
function brotliDecompress(buffer, options, callback) {
  if (typeof options === 'function') { callback = options; options = undefined; }
  validateBrotliOptions(options);
  return zlibBuffer(BrotliDecompress, buffer, options, callback);
}
function brotliDecompressSync(buffer, options) {
  validateBrotliOptions(options);
  return zlibBufferSync(BrotliDecompress, buffer, options);
}
function zstdCompress(buffer, options, callback) { return zlibBuffer(ZstdCompress, buffer, options, callback); }
function zstdCompressSync(buffer, options) { return zlibBufferSync(ZstdCompress, buffer, options); }
function zstdDecompress(buffer, options, callback) { return zlibBuffer(ZstdDecompress, buffer, options, callback); }
function zstdDecompressSync(buffer, options) { return zlibBufferSync(ZstdDecompress, buffer, options); }

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
