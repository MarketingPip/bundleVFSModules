// Port of the WHATWG/node:stream conversion helpers from Node v24.20.0
// lib/internal/webstreams/adapters.js (the six functions used by
// Readable/Writable/Duplex fromWeb/toWeb). Native-only pieces (zlib error
// mapping, StreamBase helpers, internalBinding) are omitted; everything
// here works with host-global WHATWG classes, so it runs in browsers.
//
// The module graph has intentional cycles (readable.js <-> web-adapters.js)
// mirroring Node's lazy require('internal/webstreams/adapters'); all uses
// of the stream classes below are deferred to call time, so ESM live
// bindings make this safe.
import { Buffer } from './buffer.js';
import { AbortError, codes } from './errors.js';
import { kEmptyObject } from './internal-util.js';
import { nextTick } from './task-queues.js';
import { isAnyArrayBuffer } from './util-types.js';
import {
  validateBoolean,
  validateObject,
  validateOneOf,
} from './validators.js';
import { destroy } from './destroy.js';
import { eos, kEosNodeSynchronousCallback } from './end-of-stream.js';
import {
  isDestroyed,
  isReadable,
  isReadableStream,
  isWritable,
  isWritableEnded,
  isWritableStream,
} from './utils.js';

// The Node stream classes are installed by src/stream.js via
// setStreamClasses(). This keeps the import graph acyclic (readable.js and
// friends import the adapter functions from this module), mirroring Node's
// lazy require('internal/webstreams/adapters'); every use below is deferred
// to call time, so the late binding is safe.
let Readable;
let Writable;
let Duplex;
export function setStreamClasses(classes) {
  Readable ??= classes.Readable;
  Writable ??= classes.Writable;
  Duplex ??= classes.Duplex;
}

const {
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
  ERR_STREAM_PREMATURE_CLOSE,
} = codes;

const {
  ReadableStream,
  WritableStream,
  CountQueuingStrategy,
  ByteLengthQueuingStrategy,
  TextEncoder,
} = globalThis;

const encoder = new TextEncoder();

const kValidateChunk = Symbol('kValidateChunk');
const kDestroyOnSyncError = Symbol('kDestroyOnSyncError');
const kErrorSentinelAttached = Symbol('kErrorSentinelAttached');

const noop = () => {};

// Premature close of a node stream surfaces as AbortError on the web side,
// matching Node. (Node additionally maps native zlib error codes, which
// cannot occur in this dependency-free port.)
function handleKnownInternalErrors(cause) {
  if (cause?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    return new AbortError(undefined, { cause });
  }
  return cause;
}

function normalizeEncoding(enc) {
  if (enc == null || enc === 'utf8' || enc === 'utf-8') return 'utf8';
  const nenc = `${enc}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  switch (nenc) {
    case 'utf8': return 'utf8';
    case 'utf16le': case 'utf16': case 'ucs2': case 'ucs2le': return 'utf16le';
    case 'latin1': case 'binary': case 'iso88591': return 'latin1';
    case 'base64': return 'base64';
    case 'base64url': return 'base64url';
    case 'hex': return 'hex';
    case 'ascii': return 'ascii';
    default: return nenc;
  }
}

function allReturnVoid(promises, mapFn) {
  return Promise.all(promises.map(mapFn)).then(() => undefined);
}

/**
 * @param {Writable} streamWritable
 * @param {object} [options]
 * @returns {WritableStream}
 */
function newWritableStreamFromStreamWritable(streamWritable, options = kEmptyObject) {
  // Not using the internal/streams/utils isWritableNodeStream utility
  // here because it will return false if streamWritable is a Duplex
  // whose writable option is false. For a Duplex that is not writable,
  // we want it to pass this check but return a closed WritableStream.
  // We check if the given stream is a stream.Writable or http.OutgoingMessage
  const checkIfWritableOrOutgoingMessage =
    streamWritable &&
    typeof streamWritable?.write === 'function' &&
    typeof streamWritable?.on === 'function';
  if (!checkIfWritableOrOutgoingMessage) {
    throw new ERR_INVALID_ARG_TYPE(
      'streamWritable',
      'stream.Writable',
      streamWritable,
    );
  }

  if (isDestroyed(streamWritable) || !isWritable(streamWritable)) {
    const writable = new WritableStream();
    writable.close();
    return writable;
  }

  const highWaterMark = streamWritable.writableHighWaterMark;
  const strategy =
    streamWritable.writableObjectMode ?
      new CountQueuingStrategy({ highWaterMark }) :
      {
        highWaterMark,
        size(chunk) {
          return chunk?.byteLength ?? chunk?.length ?? 1;
        },
      };

  let controller;
  let backpressurePromise;
  let closed;

  function onDrain() {
    backpressurePromise?.resolve();
  }

  const cleanup = eos(streamWritable, (error) => {
    error = handleKnownInternalErrors(error);

    cleanup();
    // This is a protection against non-standard, legacy streams
    // that happen to emit an error event again after finished is called.
    streamWritable.on('error', () => {});
    if (error != null) {
      backpressurePromise?.reject(error);
      // If closed is not undefined, the error is happening
      // after the WritableStream close has already started.
      // We need to reject it here.
      if (closed !== undefined) {
        closed.reject(error);
        closed = undefined;
      }
      controller?.error(error);
      controller = undefined;
      return;
    }

    if (closed !== undefined) {
      closed.resolve();
      closed = undefined;
      return;
    }
    controller?.error(new AbortError());
    controller = undefined;
  });

  streamWritable.on('drain', onDrain);

  return new WritableStream({
    start(c) { controller = c; },

    write(chunk) {
      try {
        options[kValidateChunk]?.(chunk);
        if (!streamWritable.writableObjectMode && isAnyArrayBuffer(chunk)) {
          chunk = new Uint8Array(chunk);
        }
        if (streamWritable.writableNeedDrain || !streamWritable.write(chunk)) {
          backpressurePromise = Promise.withResolvers();
          if (!streamWritable.writableNeedDrain) {
            backpressurePromise.resolve();
          }
          return backpressurePromise.promise.finally(() => {
            backpressurePromise = undefined;
          });
        }
      } catch (error) {
        // When the kDestroyOnSyncError flag is set (e.g. for
        // CompressionStream), a sync throw must also destroy the
        // stream so the readable side is errored too. Without this
        // the readable side hangs forever. This replicates the
        // TransformStream semantics: error both sides on any throw
        // in the transform path.
        if (options[kDestroyOnSyncError]) {
          destroy.call(streamWritable, error);
        }
        throw error;
      }
    },

    abort(reason) {
      destroy.call(streamWritable, reason);
    },

    close() {
      if (closed === undefined && !isWritableEnded(streamWritable)) {
        closed = Promise.withResolvers();
        streamWritable.end();
        return closed.promise;
      }

      controller = undefined;
      return Promise.resolve();
    },
  }, strategy);
}

/**
 * @param {WritableStream} writableStream
 * @param {{decodeStrings?: boolean, highWaterMark?: number, objectMode?: boolean,
 *   signal?: AbortSignal}} [options]
 * @returns {Writable}
 */
function newStreamWritableFromWritableStream(writableStream, options = kEmptyObject) {
  if (!isWritableStream(writableStream)) {
    throw new ERR_INVALID_ARG_TYPE(
      'writableStream',
      'WritableStream',
      writableStream);
  }

  validateObject(options, 'options');
  const {
    highWaterMark,
    decodeStrings = true,
    objectMode = false,
    signal,
  } = options;

  validateBoolean(objectMode, 'options.objectMode');
  validateBoolean(decodeStrings, 'options.decodeStrings');

  const writer = writableStream.getWriter();
  let closed = false;

  const writable = new Writable({
    highWaterMark,
    objectMode,
    decodeStrings,
    signal,

    writev(chunks, callback) {
      function done(error) {
        try {
          callback(error);
        } catch (error) {
          // In a next tick because this is happening within
          // a promise context, and if there are any errors
          // thrown we don't want those to cause an unhandled
          // rejection. Let's just escape the promise and
          // handle it separately.
          nextTick(() => destroy.call(writable, error));
        }
      }

      writer.ready.then(
        () => allReturnVoid(chunks, (data) => writer.write(data.chunk)),
      ).then(done, done);
    },

    write(chunk, encoding, callback) {
      if (typeof chunk === 'string' && decodeStrings && !objectMode) {
        const enc = normalizeEncoding(encoding);

        if (enc === 'utf8') {
          chunk = encoder.encode(chunk);
        } else {
          chunk = Buffer.from(chunk, encoding);
          chunk = new Uint8Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          );
        }
      }

      function done(error) {
        try {
          callback(error);
        } catch (error) {
          destroy.call(writable, error);
        }
      }

      writer.ready.then(() => writer.write(chunk)).then(done, done);
    },

    destroy(error, callback) {
      function done() {
        try {
          callback(error);
        } catch (error) {
          // In a next tick because this is happening within
          // a promise context, and if there are any errors
          // thrown we don't want those to cause an unhandled
          // rejection. Let's just escape the promise and
          // handle it separately.
          nextTick(() => { throw error; });
        }
      }

      if (!closed) {
        if (error != null) {
          writer.abort(error).then(done, done);
        } else {
          writer.close().then(done, done);
        }
        return;
      }

      done();
    },

    final(callback) {
      function done(error) {
        try {
          callback(error);
        } catch (error) {
          // In a next tick because this is happening within
          // a promise context, and if there are any errors
          // thrown we don't want those to cause an unhandled
          // rejection. Let's just escape the promise and
          // handle it separately.
          nextTick(() => destroy.call(writable, error));
        }
      }

      if (!closed) {
        writer.close().then(done, done);
      }
    },
  });

  writer.closed.then(
    () => {
      // If the WritableStream closes before the stream.Writable has been
      // ended, we signal an error on the stream.Writable.
      closed = true;
      if (!isWritableEnded(writable))
        destroy.call(writable, new ERR_STREAM_PREMATURE_CLOSE());
    },
    (error) => {
      // If the WritableStream errors before the stream.Writable has been
      // destroyed, signal an error on the stream.Writable.
      closed = true;
      destroy.call(writable, error);
    });

  return writable;
}

/**
 * @param {Readable} streamReadable
 * @param {{strategy?: QueuingStrategy, type?: 'bytes'}} [options]
 * @returns {ReadableStream}
 */
function newReadableStreamFromStreamReadable(streamReadable, options = kEmptyObject) {
  // Not using the internal/streams/utils isReadableNodeStream utility
  // here because it will return false if streamReadable is a Duplex
  // whose readable option is false. For a Duplex that is not readable,
  // we want it to pass this check but return a closed ReadableStream.
  if (typeof streamReadable?._readableState !== 'object') {
    throw new ERR_INVALID_ARG_TYPE(
      'streamReadable',
      'stream.Readable',
      streamReadable);
  }
  validateObject(options, 'options');
  if (options.type !== undefined) {
    validateOneOf(options.type, 'options.type', ['bytes', undefined]);
  }

  const isBYOB = options.type === 'bytes';
  let controller;
  let wasCanceled = false;
  let strategy;

  /** @type {UnderlyingSource} */
  const underlyingSource = {
    __proto__: null,
    type: isBYOB ? 'bytes' : undefined,
    start(c) { controller = c; },
    cancel(reason) {
      wasCanceled = true;
      destroy.call(streamReadable, reason);
    },
  };

  const readable = isReadable(streamReadable);
  const objectMode = streamReadable.readableObjectMode;
  if (readable) {
    underlyingSource.pull = function pull() {
      streamReadable.resume();
    };

    const highWaterMark = streamReadable.readableHighWaterMark;
    strategy = isBYOB ? { highWaterMark } :
      options.strategy ?? new (objectMode ? CountQueuingStrategy : ByteLengthQueuingStrategy)({ highWaterMark });
  }
  const readableStream = new ReadableStream(underlyingSource, strategy);

  // When adapting a Duplex as a ReadableStream, readable completion should not
  // wait for a half-open writable side to finish as well.
  let cleanup = noop;
  cleanup = eos(streamReadable, {
    __proto__: null,
    writable: false,
    [kEosNodeSynchronousCallback]: true,
  }, (error) => {
    error = handleKnownInternalErrors(error);

    // If eos calls the callback synchronously, cleanup is still a no-op here.
    cleanup();

    if (!(kErrorSentinelAttached in streamReadable)) {
      // This is a protection against non-standard, legacy streams
      // that happen to emit an error event again after finished is called.
      streamReadable.on('error', noop);
      streamReadable[kErrorSentinelAttached] = true;
    }
    if (wasCanceled) {
      return;
    }
    wasCanceled = true;
    if (error)
      return controller.error(error);
    controller.close();
    if (isBYOB)
      controller.byobRequest?.respond(0);
  });

  if (wasCanceled) {
    // `eos` called the callback synchronously
    cleanup();
  } else if (readable) {
    streamReadable.pause();

    streamReadable.on('data', function onData(chunk) {
      // Copy the Buffer to detach it from the pool.
      if (Buffer.isBuffer(chunk) && !objectMode)
        chunk = new Uint8Array(chunk);
      controller.enqueue(chunk);
      if (controller.desiredSize <= 0)
        streamReadable.pause();
    });
  }

  return readableStream;
}

/**
 * @param {ReadableStream} readableStream
 * @param {{highWaterMark?: number, encoding?: string, objectMode?: boolean,
 *   signal?: AbortSignal}} [options]
 * @returns {Readable}
 */
function newStreamReadableFromReadableStream(readableStream, options = kEmptyObject) {
  if (!isReadableStream(readableStream)) {
    throw new ERR_INVALID_ARG_TYPE(
      'readableStream',
      'ReadableStream',
      readableStream);
  }

  validateObject(options, 'options');
  const {
    highWaterMark,
    encoding,
    objectMode = false,
    signal,
  } = options;

  if (encoding !== undefined && !Buffer.isEncoding(encoding))
    throw new ERR_INVALID_ARG_VALUE('options.encoding', encoding);
  validateBoolean(objectMode, 'options.objectMode');

  const reader = readableStream.getReader();
  let closed = false;

  const readable = new Readable({
    objectMode,
    highWaterMark,
    encoding,
    signal,

    read() {
      reader.read().then(
        (chunk) => {
          if (chunk.done) {
            // Value should always be undefined here.
            readable.push(null);
          } else {
            readable.push(chunk.value);
          }
        },
        (error) => destroy.call(readable, error));
    },

    destroy(error, callback) {
      function done() {
        try {
          callback(error);
        } catch (error) {
          // In a next tick because this is happening within
          // a promise context, and if there are any errors
          // thrown we don't want those to cause an unhandled
          // rejection. Let's just escape the promise and
          // handle it separately.
          nextTick(() => { throw error; });
        }
      }

      if (!closed) {
        reader.cancel(error).then(done, done);
        return;
      }
      done();
    },
  });

  reader.closed.then(
    () => {
      closed = true;
    },
    (error) => {
      closed = true;
      destroy.call(readable, error);
    });

  return readable;
}

/**
 * @param {Duplex} duplex
 * @param {{readableType?: 'bytes'}} [options]
 * @returns {{readable: ReadableStream, writable: WritableStream}}
 */
function newReadableWritablePairFromDuplex(duplex, options = kEmptyObject) {
  // Not using the internal/streams/utils isWritableNodeStream and
  // isReadableNodeStream utilities here because they will return false
  // if the duplex was created with writable or readable options set to
  // false. Instead, we'll check the readable and writable state after
  // and return closed WritableStream or closed ReadableStream as
  // necessary.
  if (typeof duplex?._writableState !== 'object' ||
      typeof duplex?._readableState !== 'object') {
    throw new ERR_INVALID_ARG_TYPE('duplex', 'stream.Duplex', duplex);
  }

  validateObject(options, 'options');

  const readableOptions = {
    __proto__: null,
    // DEP0201: 'options.type' is a deprecated alias for 'options.readableType'
    type: options.readableType ?? options.type,
  };

  if (isDestroyed(duplex)) {
    const writable = new WritableStream();
    const readable = new ReadableStream({ type: readableOptions.type });
    writable.close();
    readable.cancel();
    return { readable, writable };
  }

  const writableOptions = {
    __proto__: null,
    [kValidateChunk]: options[kValidateChunk],
    [kDestroyOnSyncError]: options[kDestroyOnSyncError],
  };

  const writable =
    isWritable(duplex) ?
      newWritableStreamFromStreamWritable(duplex, writableOptions) :
      new WritableStream();

  if (!isWritable(duplex))
    writable.close();

  const readable =
    isReadable(duplex) ?
      newReadableStreamFromStreamReadable(duplex, readableOptions) :
      new ReadableStream({ type: readableOptions.type });

  if (!isReadable(duplex))
    readable.cancel();

  return { writable, readable };
}

/**
 * @param {{readable: ReadableStream, writable: WritableStream}} pair
 * @param {{allowHalfOpen?: boolean, decodeStrings?: boolean, encoding?: string,
 *   highWaterMark?: number, objectMode?: boolean, signal?: AbortSignal}} [options]
 * @returns {Duplex}
 */
function newStreamDuplexFromReadableWritablePair(pair = kEmptyObject, options = kEmptyObject) {
  validateObject(pair, 'pair');
  const {
    readable: readableStream,
    writable: writableStream,
  } = pair;

  if (!isReadableStream(readableStream)) {
    throw new ERR_INVALID_ARG_TYPE(
      'pair.readable',
      'ReadableStream',
      readableStream);
  }
  if (!isWritableStream(writableStream)) {
    throw new ERR_INVALID_ARG_TYPE(
      'pair.writable',
      'WritableStream',
      writableStream);
  }

  validateObject(options, 'options');
  const {
    allowHalfOpen = false,
    objectMode = false,
    encoding,
    decodeStrings = true,
    highWaterMark,
    signal,
  } = options;

  validateBoolean(objectMode, 'options.objectMode');
  if (encoding !== undefined && !Buffer.isEncoding(encoding))
    throw new ERR_INVALID_ARG_VALUE('options.encoding', encoding);

  const writer = writableStream.getWriter();
  const reader = readableStream.getReader();
  let writableClosed = false;
  let readableClosed = false;

  const duplex = new Duplex({
    allowHalfOpen,
    highWaterMark,
    objectMode,
    encoding,
    decodeStrings,
    signal,

    writev(chunks, callback) {
      function done(error) {
        try {
          callback(error);
        } catch (error) {
          // In a next tick because this is happening within
          // a promise context, and if there are any errors
          // thrown we don't want those to cause an unhandled
          // rejection. Let's just escape the promise and
          // handle it separately.
          nextTick(() => destroy.call(duplex, error));
        }
      }

      writer.ready.then(
        () => allReturnVoid(chunks, (data) => writer.write(data.chunk)),
      ).then(done, done);
    },

    write(chunk, encoding, callback) {
      if (typeof chunk === 'string' && decodeStrings && !objectMode) {
        const enc = normalizeEncoding(encoding);

        if (enc === 'utf8') {
          chunk = encoder.encode(chunk);
        } else {
          chunk = Buffer.from(chunk, encoding);
          chunk = new Uint8Array(
            chunk.buffer,
            chunk.byteOffset,
            chunk.byteLength,
          );
        }
      }

      function done(error) {
        try {
          callback(error);
        } catch (error) {
          destroy.call(duplex, error);
        }
      }

      writer.ready.then(() => writer.write(chunk)).then(done, done);
    },

    final(callback) {
      function done(error) {
        try {
          callback(error);
        } catch (error) {
          // In a next tick because this is happening within
          // a promise context, and if there are any errors
          // thrown we don't want those to cause an unhandled
          // rejection. Let's just escape the promise and
          // handle it separately.
          nextTick(() => destroy.call(duplex, error));
        }
      }

      if (!writableClosed) {
        writer.close().then(done, done);
      }
    },

    read() {
      reader.read().then(
        (chunk) => {
          if (chunk.done) {
            duplex.push(null);
          } else {
            duplex.push(chunk.value);
          }
        },
        (error) => destroy.call(duplex, error));
    },

    destroy(error, callback) {
      function done() {
        try {
          callback(error);
        } catch (error) {
          // In a next tick because this is happening within
          // a promise context, and if there are any errors
          // thrown we don't want those to cause an unhandled
          // rejection. Let's just escape the promise and
          // handle it separately.
          nextTick(() => { throw error; });
        }
      }

      async function closeWriter() {
        if (!writableClosed)
          await writer.abort(error);
      }

      async function closeReader() {
        if (!readableClosed)
          await reader.cancel(error);
      }

      if (!writableClosed || !readableClosed) {
        allReturnVoid([closeWriter(), closeReader()], (p) => p).then(done, done);
        return;
      }

      done();
    },
  });

  writer.closed.then(
    () => {
      writableClosed = true;
      if (!isWritableEnded(duplex))
        destroy.call(duplex, new ERR_STREAM_PREMATURE_CLOSE());
    },
    (error) => {
      writableClosed = true;
      readableClosed = true;
      destroy.call(duplex, error);
    });

  reader.closed.then(
    () => {
      readableClosed = true;
    },
    (error) => {
      writableClosed = true;
      readableClosed = true;
      destroy.call(duplex, error);
    });

  return duplex;
}

export {
  newWritableStreamFromStreamWritable,
  newReadableStreamFromStreamReadable,
  newStreamWritableFromWritableStream,
  newStreamReadableFromReadableStream,
  newReadableWritablePairFromDuplex,
  newStreamDuplexFromReadableWritablePair,
  kValidateChunk,
  kDestroyOnSyncError,
};
