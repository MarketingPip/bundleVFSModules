// Port of Node v26.13.1 lib/internal/streams/iter/transform.js — converted
// to browser-safe ESM for the bundleVFSModules stream shim (Wave 3 lane L6).
// Validation helpers, factories and exports are byte-identical to Node;
// the bare-native-zlib engine section is reimplemented on the shim's
// zlib stream classes (src/zlib.js) — see the engine note below.
'use strict';

// Compression / Decompression Transforms
//
// Compression / Decompression Transforms
//
// SHIM REWRITE (Wave 3 lane L6): Node creates bare native zlib handles;
// this port drives the shim's zlib stream
// classes (src/zlib.js, pako/zstdify/brocha engines) instead, keeping the
// same factory surface, option validation, batching and backpressure
// behaviour. See makeZlibTransform below.
// Each factory returns a transform descriptor that can be passed to pull().

import { ArrayPrototypeMap, ArrayPrototypePush, ArrayPrototypeShift, FunctionPrototypeCall, MathMax, NumberIsNaN, ObjectEntries, ObjectKeys, PromisePrototypeThen, PromiseResolve, PromiseWithResolvers, StringPrototypeStartsWith, SymbolAsyncIterator, TypedArrayPrototypeFill, TypedArrayPrototypeGetByteLength, TypedArrayPrototypeSlice, Uint32Array } from "../primordials.js";

import { Buffer } from "../buffer.js";
import { codes, genericNodeError } from "../errors.js";
const { ERR_BROTLI_INVALID_PARAM, ERR_INVALID_ARG_TYPE, ERR_OUT_OF_RANGE, ERR_ZSTD_INVALID_PARAM } = codes;
import { isArrayBufferView, isAnyArrayBuffer } from "../util-types.js";
import { kValidatedTransform } from "./types.js";
import { checkRangesOrGetDefault, kValidateObjectAllowArray, validateFiniteNumber, validateObject } from "../validators.js";
import { markPromiseAsHandled } from "./internal-util.js";
import { constants } from "../../zlib.js";
import {
  brotliCompressSync,
  brotliDecompressSync,
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createGzip,
  createGunzip,
  createInflate,
  createZstdCompress,
  createZstdDecompress,
  deflateSync,
  gzipSync,
  gunzipSync,
  inflateSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "../../zlib.js";

const {
  // Zlib modes
  DEFLATE, INFLATE, GZIP, GUNZIP,
  BROTLI_ENCODE, BROTLI_DECODE,
  ZSTD_COMPRESS, ZSTD_DECOMPRESS,
  // Zlib flush
  Z_NO_FLUSH, Z_FINISH,
  // Zlib defaults
  Z_DEFAULT_WINDOWBITS,
  Z_DEFAULT_STRATEGY,
  // Brotli flush
  BROTLI_OPERATION_PROCESS, BROTLI_OPERATION_FINISH,
  // Zlib ranges
  Z_MIN_CHUNK, Z_MIN_WINDOWBITS, Z_MAX_WINDOWBITS,
  Z_MIN_LEVEL, Z_MAX_LEVEL,
  Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL,
  Z_FIXED,
  // Zstd flush
  ZSTD_e_continue, ZSTD_e_end,
} = constants;

// ---------------------------------------------------------------------------
// Option validation helpers (matching lib/zlib.js validation patterns)
// ---------------------------------------------------------------------------

// Default output buffer size for compression transforms. Larger than
// Z_DEFAULT_CHUNK (16KB) to reduce the number of threadpool re-entries
// when the engine has more output than fits in one buffer. 64KB matches
// BATCH_HWM and the typical input chunk size from pull().
const DEFAULT_OUTPUT_SIZE = 64 * 1024;

// Batch high water mark - yield output in chunks of approximately this size.
const BATCH_HWM = DEFAULT_OUTPUT_SIZE;

// Pre-allocated empty buffer for flush/finalize calls.
const kEmpty = Buffer.alloc(0);

function validateChunkSize(options) {
  let chunkSize = options.chunkSize;
  if (!validateFiniteNumber(chunkSize, 'options.chunkSize')) {
    chunkSize = DEFAULT_OUTPUT_SIZE;
  } else if (chunkSize < Z_MIN_CHUNK) {
    throw new ERR_OUT_OF_RANGE('options.chunkSize',
                               `>= ${Z_MIN_CHUNK}`, chunkSize);
  }
  return chunkSize;
}

function validateDictionary(dictionary) {
  if (dictionary === undefined) return undefined;
  if (isArrayBufferView(dictionary)) return dictionary;
  if (isAnyArrayBuffer(dictionary)) return Buffer.from(dictionary);
  throw new ERR_INVALID_ARG_TYPE(
    'options.dictionary',
    ['Buffer', 'TypedArray', 'DataView', 'ArrayBuffer'],
    dictionary);
}

function validateParams(params, maxParam, errClass) {
  if (params === undefined) return;
  validateObject(params, 'options.params', kValidateObjectAllowArray);
  const keys = ObjectKeys(params);
  for (let i = 0; i < keys.length; i++) {
    const origKey = keys[i];
    const key = +origKey;
    if (NumberIsNaN(key) || key < 0 || key > maxParam) {
      throw new errClass(origKey);
    }
    const value = params[origKey];
    if (typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ERR_INVALID_ARG_TYPE('options.params[key]', 'number', value);
    }
  }
}

// ---------------------------------------------------------------------------
// Brotli / Zstd parameter arrays (computed once, reused per init call).
// Mirrors the pattern in lib/zlib.js.
// ---------------------------------------------------------------------------
const kMaxBrotliParam = MathMax(
  ...ArrayPrototypeMap(
    ObjectEntries(constants),
    ({ 0: key, 1: value }) =>
      (StringPrototypeStartsWith(key, 'BROTLI_PARAM_') ? value : 0),
  ),
);

const kMaxZstdCParam = MathMax(
  ...ArrayPrototypeMap(
    ObjectKeys(constants),
    (key) => (StringPrototypeStartsWith(key, 'ZSTD_c_') ? constants[key] : 0),
  ),
);

const kMaxZstdDParam = MathMax(
  ...ArrayPrototypeMap(
    ObjectKeys(constants),
    (key) => (StringPrototypeStartsWith(key, 'ZSTD_d_') ? constants[key] : 0),
  ),
);

// ---------------------------------------------------------------------------
// Engine: shim-zlib stream wrapper (replaces Node's bare native handles).
//
// One engine wraps one shim zlib Transform stream (Gzip/Gunzip/... from
// src/zlib.js). Writes are awaited through the stream's write callback —
// the shim pushes all output for a chunk before invoking it (see
// src/zlib.js _processChunk), so after the callback the chunk's output is
// fully collected. Feeding input in small slices and yielding a batch
// whenever the pending output reaches BATCH_HWM reproduces Node's
// threadpool backpressure: the engine never holds more than ~one slice's
// output past the high-water mark (the transform-buffering memory bound).
//
// Brotli compression stays the shim zlib's honest pass-through stub
// (src/zlib.js header: no pure-JS brotli encoder exists), so brotli
// compress round-trips cannot pass here — see NOTES-26-stream-l6.md.
// ---------------------------------------------------------------------------

// Input slice sizes: decompression can expand ~1000x (32 MiB of zeroes
// from ~32 KiB of gzip), so decompress slices are small; compression
// output is bounded by input size, so compress slices are large.
const kDecompressSliceSize = 1024;
const kCompressSliceSize = 16384;

function createStreamEngine(createStream, options, isDecompress) {
  const stream = createStream(options);
  let out = [];
  let streamError = null;
  let ended = false;
  let notify = null;
  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };
  stream.on("data", (chunk) => {
    out.push(Buffer.from(chunk));
    wake();
  });
  stream.on("error", (error) => {
    streamError = error;
    wake();
  });
  stream.on("end", () => {
    ended = true;
    wake();
  });
  return {
    __proto__: null,
    isDecompress,
    async writeSlice(input) {
      if (streamError) throw streamError;
      await new Promise((resolve, reject) => {
        stream.write(input, (err) => (err ? reject(err) : resolve()));
      });
      if (streamError) throw streamError;
    },
    async finish() {
      if (streamError) throw streamError;
      stream.end();
      if (!ended && !streamError) {
        await new Promise((resolve) => {
          notify = resolve;
        });
      }
      if (streamError) throw streamError;
    },
    takeOutput() {
      const chunks = out;
      out = [];
      return chunks;
    },
    close() {
      stream.destroy();
    },
  };
}

// Option validation mirroring Node's create*Handle (same error codes,
// same timing: at transform invocation, not at factory call).
function createZlibEngine(mode, options) {
  validateChunkSize(options);
  checkRangesOrGetDefault(
    options.windowBits, 'options.windowBits',
    Z_MIN_WINDOWBITS, Z_MAX_WINDOWBITS, Z_DEFAULT_WINDOWBITS);
  checkRangesOrGetDefault(
    options.level, 'options.level',
    Z_MIN_LEVEL, Z_MAX_LEVEL, 4);
  checkRangesOrGetDefault(
    options.memLevel, 'options.memLevel',
    Z_MIN_MEMLEVEL, Z_MAX_MEMLEVEL, 9);
  checkRangesOrGetDefault(
    options.strategy, 'options.strategy',
    Z_DEFAULT_STRATEGY, Z_FIXED, Z_DEFAULT_STRATEGY);
  validateDictionary(options.dictionary);
  const create = mode === GZIP ? createGzip :
    mode === GUNZIP ? createGunzip :
    mode === DEFLATE ? createDeflate : createInflate;
  return createStreamEngine(create, options, mode === GUNZIP || mode === INFLATE);
}

function createBrotliEngine(mode, options) {
  validateChunkSize(options);
  validateDictionary(options.dictionary);
  validateParams(options.params, kMaxBrotliParam, ERR_BROTLI_INVALID_PARAM);
  return createStreamEngine(
    mode === BROTLI_ENCODE ? createBrotliCompress : createBrotliDecompress,
    options, mode === BROTLI_DECODE);
}

function createZstdEngine(mode, options) {
  const isCompress = mode === ZSTD_COMPRESS;
  validateChunkSize(options);
  validateDictionary(options.dictionary);
  const maxParam = isCompress ? kMaxZstdCParam : kMaxZstdDParam;
  validateParams(options.params, maxParam, ERR_ZSTD_INVALID_PARAM);
  return createStreamEngine(
    isCompress ? createZstdCompress : createZstdDecompress,
    options, !isCompress);
}

// ---------------------------------------------------------------------------
// Core: makeZlibTransform
//
// Same generator structure as Node (pre-read next batch while the current
// one compresses, explicit null flush signal, abort checks, finally
// cleanup that never replaces the transform's completion), with the
// handle.write/processCallback plumbing replaced by engine slices.
// ---------------------------------------------------------------------------
function makeZlibTransform(createEngine) {
  return {
    __proto__: null,
    [kValidatedTransform]: true,
    transform: async function*(source, options) {
      const { signal } = options;

      // Fail fast if already aborted - don't allocate a stream.
      signal?.throwIfAborted();

      let pending = [];
      let pendingBytes = 0;

      function collectOutput() {
        const chunks = engine.takeOutput();
        for (let i = 0; i < chunks.length; i++) {
          ArrayPrototypePush(pending, chunks[i]);
          pendingBytes += TypedArrayPrototypeGetByteLength(chunks[i]);
        }
      }

      function drainBatch() {
        if (pendingBytes <= BATCH_HWM) {
          // Swap instead of splice - avoids copying the array.
          const batch = pending;
          pending = [];
          pendingBytes = 0;
          return batch;
        }
        const batch = [];
        let batchBytes = 0;
        while (pending.length > 0 && batchBytes < BATCH_HWM) {
          const buf = ArrayPrototypeShift(pending);
          ArrayPrototypePush(batch, buf);
          const len = TypedArrayPrototypeGetByteLength(buf);
          batchBytes += len;
          pendingBytes -= len;
        }
        return batch;
      }

      // Feed one input chunk in slices, yielding a batch whenever the
      // pending output reaches the high-water mark (Node's resolve(false)
      // early-return inside onWriteComplete, same bound).
      async function* feedSlices(input) {
        const sliceSize = engine.isDecompress ?
          kDecompressSliceSize : kCompressSliceSize;
        for (let off = 0; off < input.length; off += sliceSize) {
          await engine.writeSlice(input.subarray(off, off + sliceSize));
          collectOutput();
          while (pendingBytes >= BATCH_HWM) {
            yield drainBatch();
          }
          signal?.throwIfAborted();
        }
      }

      async function* processInputBatches(input, isFinish) {
        if (isFinish) {
          await engine.finish();
          collectOutput();
          while (pending.length > 0) {
            yield drainBatch();
          }
          return;
        }
        yield* feedSlices(input);
      }

      const engine = createEngine();

      // Abort handler: the generator checks signal between awaits; no
      // in-flight threadpool write exists to reject here.
      const onAbort = () => {};
      signal.addEventListener('abort', onAbort, { __proto__: null, once: true });

      let finalized = false;

      const iter = source[SymbolAsyncIterator]();
      const nextMethod = iter.next;
      let returnMethod;
      try {
        returnMethod = iter.return;
      } catch {
        // Ignore cleanup-method access failures.
      }

      function readNext() {
        const result = PromisePrototypeThen(
          PromiseResolve(FunctionPrototypeCall(nextMethod, iter)),
          undefined,
          undefined);
        markPromiseAsHandled(result);
        return result;
      }

      try {
        // Manually iterate the source so we can pre-read: calling
        // iter.next() starts the upstream read + transform before we
        // await the current compression.
        let nextResult = readNext();

        while (true) {
          const { value: chunks, done } = await nextResult;
          if (done) break;

          signal?.throwIfAborted();

          if (chunks === null) {
            // Flush signal - finalize the engine.
            if (!finalized) {
              finalized = true;
              for await (const batch of processInputBatches(kEmpty, true)) {
                yield batch;
              }
              while (pending.length > 0) {
                yield drainBatch();
              }
            }
            nextResult = readNext();
            continue;
          }

          // Pre-read: start upstream I/O + transform for the NEXT batch
          // while we compress the current batch.
          nextResult = readNext();

          for (let i = 0; i < chunks.length; i++) {
            for await (const batch of processInputBatches(chunks[i], false)) {
              yield batch;
            }
          }

          if (pendingBytes >= BATCH_HWM) {
            while (pending.length > 0 && pendingBytes >= BATCH_HWM) {
              yield drainBatch();
            }
          }
          if (pending.length > 0) {
            yield drainBatch();
          }
        }

        // Source ended - finalize if not already done by a null signal.
        if (!finalized && !signal.aborted) {
          finalized = true;
          for await (const batch of processInputBatches(kEmpty, true)) {
            yield batch;
          }
          while (pending.length > 0) {
            yield drainBatch();
          }
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        engine.close();
        // Do not await return(): an async generator queues it behind any
        // outstanding next(), which is allowed to remain pending forever.
        if (typeof returnMethod === 'function') {
          try {
            const returned = FunctionPrototypeCall(returnMethod, iter);
            const cleanup = PromisePrototypeThen(
              PromiseResolve(returned), undefined, undefined);
            markPromiseAsHandled(cleanup);
          } catch {
            // Cleanup errors cannot replace the transform's completion.
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Core: makeZlibTransformSync
//
// ponytail: the shim's zlib has no incremental sync engine (its sync
// functions take a whole buffer), so the sync transform buffers the whole
// input and applies the sync function once at finalization, yielding the
// output in BATCH_HWM batches. Ceiling: incremental yields and
// mid-stream memory bounds are not preserved on the sync path; no target
// test exercises a sync zlib transform (only transform-sync.js, outside
// this lane's 35), and the factory surface, validation timing and final
// bytes are identical to Node.
// ---------------------------------------------------------------------------
function makeZlibTransformSync(syncFn, validate) {
  return {
    __proto__: null,
    [kValidatedTransform]: true,
    transform: function*(source) {
      validate();
      let chunks = [];
      let finalized = false;

      function* finalize() {
        if (finalized) return;
        finalized = true;
        // Node's handle writes into Buffer.allocUnsafe: output chunks are
        // Buffers. The shim's sync fns are mixed (gzipSync returns a Buffer,
        // gunzipSync a Uint8Array) — normalize so concatBytes' single-chunk
        // fast path returns a Buffer, as test-stream-iter-transform-sync.js
        // asserts with deepStrictEqual against a Buffer.
        let out = syncFn(Buffer.concat(chunks));
        if (!Buffer.isBuffer(out)) out = Buffer.from(out);
        // Node's handle writes into fresh Buffer.allocUnsafe slices
        // (byteOffset 0, backing buffer exactly the chunk). The shim's
        // sync fns return pooled Buffers / Uint8Arrays, so reallocate
        // exact: otherwise concatBytes' single-chunk fast path (offset 0
        // + full coverage) misses and copyBytes returns a plain
        // Uint8Array, failing test-stream-iter-transform-sync.js's
        // deepStrictEqual against a Buffer.
        if (out.byteOffset !== 0 || out.byteLength !== out.buffer.byteLength) {
          const exact = Buffer.allocUnsafeSlow(out.length);
          out.copy(exact);
          out = exact;
        }
        chunks = [];
        let off = 0;
        while (off < out.length) {
          yield [out.subarray(off, off + BATCH_HWM)];
          off += BATCH_HWM;
        }
      }

      try {
        for (const batch of source) {
          if (batch === null) {
            // Flush signal - finalize the engine.
            yield* finalize();
            continue;
          }
          for (let i = 0; i < batch.length; i++) {
            ArrayPrototypePush(chunks, batch[i]);
          }
        }
      } finally {
        // Nothing to close on the sync path.
      }
      yield* finalize();
    },
  };
}

// ---------------------------------------------------------------------------
// Async compression factories
// ---------------------------------------------------------------------------


const kNullPrototype = { __proto__: null };

function compressGzip(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createZlibEngine(GZIP, options));
}

function compressDeflate(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createZlibEngine(DEFLATE, options));
}

function compressBrotli(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createBrotliEngine(BROTLI_ENCODE, options));
}

function compressZstd(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createZstdEngine(ZSTD_COMPRESS, options));
}

// ---------------------------------------------------------------------------
// Decompression factories
// ---------------------------------------------------------------------------

function decompressGzip(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createZlibEngine(GUNZIP, options));
}

function decompressDeflate(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createZlibEngine(INFLATE, options));
}

function decompressBrotli(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createBrotliEngine(BROTLI_DECODE, options));
}

function decompressZstd(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransform(() => createZstdEngine(ZSTD_DECOMPRESS, options));
}

// ---------------------------------------------------------------------------
// Sync compression factories
// ---------------------------------------------------------------------------

function compressGzipSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(gzipSync, () => createZlibEngine(GZIP, options));
}

function compressDeflateSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(deflateSync, () => createZlibEngine(DEFLATE, options));
}

function compressBrotliSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(brotliCompressSync, () => createBrotliEngine(BROTLI_ENCODE, options));
}

function compressZstdSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(zstdCompressSync, () => createZstdEngine(ZSTD_COMPRESS, options));
}

// ---------------------------------------------------------------------------
// Sync decompression factories
// ---------------------------------------------------------------------------

function decompressGzipSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(gunzipSync, () => createZlibEngine(GUNZIP, options));
}

function decompressDeflateSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(inflateSync, () => createZlibEngine(INFLATE, options));
}

function decompressBrotliSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(brotliDecompressSync, () => createBrotliEngine(BROTLI_DECODE, options));
}

function decompressZstdSync(options = kNullPrototype) {
  validateObject(options, 'options');
  return makeZlibTransformSync(zstdDecompressSync, () => createZstdEngine(ZSTD_DECOMPRESS, options));
}

export {
  compressBrotli,
  compressBrotliSync,
  compressDeflate,
  compressDeflateSync,
  compressGzip,
  compressGzipSync,
  compressZstd,
  compressZstdSync,
  decompressBrotli,
  decompressBrotliSync,
  decompressDeflate,
  decompressDeflateSync,
  decompressGzip,
  decompressGzipSync,
  decompressZstd,
  decompressZstdSync,
};
