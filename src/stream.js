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

export const _isArrayBufferView = isArrayBufferView;
export const _isUint8Array = isUint8Array;
export function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk.buffer,
                     chunk.byteOffset,
                     chunk.byteLength);
}
Stream._isArrayBufferView = _isArrayBufferView;
Stream._isUint8Array = _isUint8Array;
Stream._uint8ArrayToBuffer = _uint8ArrayToBuffer;

export default Stream;

// Named exports matching Node's ESM named-export detection for require('stream').
const {
  Readable: ReadableExport,
  Writable: WritableExport,
  Duplex: DuplexExport,
  Transform: TransformExport,
  PassThrough: PassThroughExport,
  duplexPair: duplexPairExport,
  pipeline: pipelineExport,
  addAbortSignal: addAbortSignalExport,
  finished: finishedExport,
  destroy: destroyExport,
  compose: composeExport,
  setDefaultHighWaterMark: setDefaultHighWaterMarkExport,
  getDefaultHighWaterMark: getDefaultHighWaterMarkExport,
  isDestroyed: isDestroyedExport,
  isDisturbed: isDisturbedExport,
  isErrored: isErroredExport,
  isReadable: isReadableExport,
  isWritable: isWritableExport,
  promises: promisesExport,
} = Stream;
export {
  ReadableExport as Readable,
  WritableExport as Writable,
  DuplexExport as Duplex,
  TransformExport as Transform,
  PassThroughExport as PassThrough,
  duplexPairExport as duplexPair,
  pipelineExport as pipeline,
  addAbortSignalExport as addAbortSignal,
  finishedExport as finished,
  destroyExport as destroy,
  composeExport as compose,
  setDefaultHighWaterMarkExport as setDefaultHighWaterMark,
  getDefaultHighWaterMarkExport as getDefaultHighWaterMark,
  isDestroyedExport as isDestroyed,
  isDisturbedExport as isDisturbed,
  isErroredExport as isErrored,
  isReadableExport as isReadable,
  isWritableExport as isWritable,
  promisesExport as promises,
};
export { Stream };
