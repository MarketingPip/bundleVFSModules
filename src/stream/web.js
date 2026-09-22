// Port of Node v24.20.0 lib/stream/web.js — the node:stream/web entry point.
//
// Dependency-free, browser-safe ESM. Node's stream/web re-exports the
// platform WHATWG Streams implementation; this port re-exports the host
// globals (native in browsers and Node 16.5+), plus a spec-shaped
// ReadableStreamTee helper. No polyfill dependency.
import { codes } from './errors.js';
import { validateBoolean } from './validators.js';

const {
  ERR_INVALID_ARG_TYPE,
} = codes;

const {
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
  ReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableByteStreamController,
  ReadableStreamDefaultController,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  TextEncoderStream,
  TextDecoderStream,
  CompressionStream,
  DecompressionStream,
} = globalThis;

function ReadableStreamTee(stream, cloneForBranch2 = false) {
  if (!(stream instanceof ReadableStream)) {
    throw new ERR_INVALID_ARG_TYPE('stream', 'ReadableStream', stream);
  }
  validateBoolean(cloneForBranch2, 'cloneForBranch2');
  return stream.tee();
}

export {
  ReadableStream,
  ReadableStreamTee,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableByteStreamController,
  ReadableStreamDefaultController,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultWriter,
  WritableStreamDefaultController,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  TextEncoderStream,
  TextDecoderStream,
  CompressionStream,
  DecompressionStream,
};

export default {
  ReadableStream,
  ReadableStreamTee,
  ReadableStreamDefaultReader,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableByteStreamController,
  ReadableStreamDefaultController,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultWriter,
  WritableStreamDefaultController,
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  TextEncoderStream,
  TextDecoderStream,
  CompressionStream,
  DecompressionStream,
};
