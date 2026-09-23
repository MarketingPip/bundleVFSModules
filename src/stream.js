// Port of Node v24.20.0 lib/stream.js — the main node:stream entry point.
//
// Dependency-free, browser-safe ESM. The class implementations live in
// src/stream/ (converted from lib/internal/streams/*); the WHATWG
// adapters in src/stream/web-adapters.js receive the stream classes via
// setStreamClasses(), and compose/duplexify via setComposeImpl() /
// setDuplexify(), keeping the module graph acyclic (mirroring Node's lazy
// requires).
import {
  ObjectDefineProperty,
  ObjectKeys,
  ReflectApply,
} from './stream/primordials.js';
import {
  streamReturningOperators,
  promiseReturningOperators,
} from './stream/operators.js';
import { codes } from './stream/errors.js';
import { Buffer } from './stream/buffer.js';
import * as utils from './stream/utils.js';
import { isArrayBufferView, isUint8Array } from './stream/util-types.js';
import { Stream } from './stream/legacy.js';
import Readable, { setComposeImpl } from './stream/readable.js';
import Writable from './stream/writable.js';
import Duplex, { setDuplexify } from './stream/duplex.js';
import Transform from './stream/transform.js';
import PassThrough from './stream/passthrough.js';
import duplexPair from './stream/duplexpair.js';
import duplexify from './stream/duplexify.js';
import compose from './stream/compose.js';
import { pipeline } from './stream/pipeline.js';
import { destroyer } from './stream/destroy.js';
import { eos } from './stream/end-of-stream.js';
import { addAbortSignal } from './stream/abort-listener-attach.js';
import { setDefaultHighWaterMark, getDefaultHighWaterMark } from './stream/state.js';
import promises from './stream/promises.js';
import { setStreamClasses } from './stream/web-adapters.js';

const {
  ERR_ILLEGAL_CONSTRUCTOR,
} = codes;

const customPromisify = Symbol.for('nodejs.util.promisify.custom');

// Wire up the lazily-installed implementations (see notes above).
setComposeImpl(compose);
setDuplexify(duplexify);
setStreamClasses({ Readable, Writable, Duplex });

Stream.isDestroyed = utils.isDestroyed;
Stream.isDisturbed = utils.isDisturbed;
Stream.isErrored = utils.isErrored;
Stream.isReadable = utils.isReadable;
Stream.isWritable = utils.isWritable;

Stream.Readable = Readable;
const streamKeys = ObjectKeys(streamReturningOperators);
for (let i = 0; i < streamKeys.length; i++) {
  const key = streamKeys[i];
  const op = streamReturningOperators[key];
  function fn(...args) {
    if (new.target) {
      throw new ERR_ILLEGAL_CONSTRUCTOR();
    }
    return Stream.Readable.from(ReflectApply(op, this, args));
  }
  ObjectDefineProperty(fn, 'name', { __proto__: null, value: op.name });
  ObjectDefineProperty(fn, 'length', { __proto__: null, value: op.length });
  ObjectDefineProperty(Stream.Readable.prototype, key, {
    __proto__: null,
    value: fn,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
const promiseKeys = ObjectKeys(promiseReturningOperators);
for (let i = 0; i < promiseKeys.length; i++) {
  const key = promiseKeys[i];
  const op = promiseReturningOperators[key];
  function fn(...args) {
    if (new.target) {
      throw new ERR_ILLEGAL_CONSTRUCTOR();
    }
    return ReflectApply(op, this, args);
  }
  ObjectDefineProperty(fn, 'name', { __proto__: null, value: op.name });
  ObjectDefineProperty(fn, 'length', { __proto__: null, value: op.length });
  ObjectDefineProperty(Stream.Readable.prototype, key, {
    __proto__: null,
    value: fn,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.duplexPair = duplexPair;
Stream.pipeline = pipeline;
Stream.addAbortSignal = addAbortSignal;
Stream.finished = eos;
Stream.destroy = destroyer;
Stream.compose = compose;
Stream.setDefaultHighWaterMark = setDefaultHighWaterMark;
Stream.getDefaultHighWaterMark = getDefaultHighWaterMark;

ObjectDefineProperty(Stream, 'promises', {
  __proto__: null,
  configurable: true,
  enumerable: true,
  get() {
    return promises;
  },
});

ObjectDefineProperty(pipeline, customPromisify, {
  __proto__: null,
  enumerable: true,
  get() {
    return promises.pipeline;
  },
});

ObjectDefineProperty(eos, customPromisify, {
  __proto__: null,
  enumerable: true,
  get() {
    return promises.finished;
  },
});

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;

Stream._isArrayBufferView = isArrayBufferView;
Stream._isUint8Array = isUint8Array;
Stream._uint8ArrayToBuffer = function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk.buffer,
                     chunk.byteOffset,
                     chunk.byteLength);
};

export default Stream;

// Named exports matching Node's ESM named-export detection for require('stream').
export const {
  Readable: StreamReadable,
  Writable: StreamWritable,
  Duplex: StreamDuplex,
  Transform: StreamTransform,
  PassThrough: StreamPassThrough,
  duplexPair: streamDuplexPair,
  pipeline: streamPipeline,
  addAbortSignal: streamAddAbortSignal,
  finished: streamFinished,
  destroy: streamDestroy,
  compose: streamCompose,
  setDefaultHighWaterMark: streamSetDefaultHighWaterMark,
  getDefaultHighWaterMark: streamGetDefaultHighWaterMark,
  isDestroyed: streamIsDestroyed,
  isDisturbed: streamIsDisturbed,
  isErrored: streamIsErrored,
  isReadable: streamIsReadable,
  isWritable: streamIsWritable,
  promises: streamPromises,
} = Stream;
export {
  StreamReadable as Readable,
  StreamWritable as Writable,
  StreamDuplex as Duplex,
  StreamTransform as Transform,
  StreamPassThrough as PassThrough,
  streamDuplexPair as duplexPair,
  streamPipeline as pipeline,
  streamAddAbortSignal as addAbortSignal,
  streamFinished as finished,
  streamDestroy as destroy,
  streamCompose as compose,
  streamSetDefaultHighWaterMark as setDefaultHighWaterMark,
  streamGetDefaultHighWaterMark as getDefaultHighWaterMark,
  streamIsDestroyed as isDestroyed,
  streamIsDisturbed as isDisturbed,
  streamIsErrored as isErrored,
  streamIsReadable as isReadable,
  streamIsWritable as isWritable,
  streamPromises as promises,
};
export { Stream };
