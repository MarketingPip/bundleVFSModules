// npm install web-streams-polyfill

/*!
 * stream-web/web — node:stream/web for browsers & bundlers
 * MIT License.
 * Node.js parity: node:stream/web @ Node 16.5.0+
 * Dependencies: web-streams-polyfill (fallback only — native globals preferred)
 * Limitations:
 *   - CompressionStream / DecompressionStream require native browser support
 *     or a separate polyfill (e.g. compression-streams-polyfill); not provided
 *     here as no universal npm-only implementation exists.
 *   - TextEncoderStream / TextDecoderStream fall back to a manual shim when
 *     not available as globals (all modern browsers have them natively).
 */

/**
 * @packageDocumentation
 * Re-exports the full WHATWG Streams API surface as named exports, mirroring
 * `node:stream/web`.
 *
 * Strategy (in priority order for each export):
 *   1. Native global  — zero overhead, spec-compliant.
 *   2. web-streams-polyfill — faithful WHATWG spec implementation.
 *   3. Manual shim    — for TextEncoderStream / TextDecoderStream only.
 *
 * This module does NOT import from `../stream` because the WHATWG Streams API
 * and the Node.js streams API are parallel, independent specifications.
 * `../stream` (readable-stream) provides Node Streams2; this module provides
 * the WHATWG counterparts.
 */

import * as poly from 'web-streams-polyfill';

// ---------------------------------------------------------------------------
// Helper: prefer a native global, fall back to the polyfill export
// ---------------------------------------------------------------------------

/**
 * @template T
 * @param {string} name  - globalThis property name
 * @param {T} fallback   - polyfill value
 * @returns {T}
 */
const native = (name, fallback) =>
  (name in globalThis && globalThis[name] != null)
    ? globalThis[name]
    : fallback;

// ---------------------------------------------------------------------------
// Core stream classes
// ---------------------------------------------------------------------------

/**
 * WHATWG ReadableStream.
 * @see https://streams.spec.whatwg.org/#rs-class
 */
export const ReadableStream = native('ReadableStream', poly.ReadableStream);

/**
 * WHATWG WritableStream.
 * @see https://streams.spec.whatwg.org/#ws-class
 */
export const WritableStream = native('WritableStream', poly.WritableStream);

/**
 * WHATWG TransformStream.
 * @see https://streams.spec.whatwg.org/#ts-class
 */
export const TransformStream = native('TransformStream', poly.TransformStream);

// ---------------------------------------------------------------------------
// Readers & writers
// ---------------------------------------------------------------------------

/** Default reader for ReadableStream. */
export const ReadableStreamDefaultReader = native(
  'ReadableStreamDefaultReader', poly.ReadableStreamDefaultReader,
);

/** BYOB reader for ReadableStream (byte streams only). */
export const ReadableStreamBYOBReader = native(
  'ReadableStreamBYOBReader', poly.ReadableStreamBYOBReader,
);

/** Default writer for WritableStream. */
export const WritableStreamDefaultWriter = native(
  'WritableStreamDefaultWriter', poly.WritableStreamDefaultWriter,
);

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** Default controller for ReadableStream. */
export const ReadableStreamDefaultController = native(
  'ReadableStreamDefaultController', poly.ReadableStreamDefaultController,
);

/** Byte controller for ReadableStream (enables zero-copy BYOB reads). */
export const ReadableByteStreamController = native(
  'ReadableByteStreamController', poly.ReadableByteStreamController,
);

/** BYOB request object inside a ReadableByteStreamController. */
export const ReadableStreamBYOBRequest = native(
  'ReadableStreamBYOBRequest', poly.ReadableStreamBYOBRequest,
);

/** Default controller for WritableStream. */
export const WritableStreamDefaultController = native(
  'WritableStreamDefaultController', poly.WritableStreamDefaultController,
);

/** Default controller for TransformStream. */
export const TransformStreamDefaultController = native(
  'TransformStreamDefaultController', poly.TransformStreamDefaultController,
);

// ---------------------------------------------------------------------------
// Queuing strategies
// ---------------------------------------------------------------------------

/**
 * Queuing strategy that measures backpressure by byte length.
 * Use for binary streams (`Uint8Array` chunks).
 */
export const ByteLengthQueuingStrategy = native(
  'ByteLengthQueuingStrategy', poly.ByteLengthQueuingStrategy,
);

/**
 * Queuing strategy that measures backpressure by chunk count.
 * Use for object-mode streams.
 */
export const CountQueuingStrategy = native(
  'CountQueuingStrategy', poly.CountQueuingStrategy,
);

// ---------------------------------------------------------------------------
// Text encoding/decoding streams
// ---------------------------------------------------------------------------

/**
 * Encodes a stream of strings into UTF-8 Uint8Array chunks.
 * Native in all modern browsers (Chrome 67+, Firefox 113+, Safari 14.1+).
 * Falls back to a hand-written TransformStream shim when absent.
 */
export const TextEncoderStream = native(
  'TextEncoderStream',
  (() => {
    // Minimal shim: encode each string chunk with TextEncoder.
    const Encoder = globalThis.TextEncoder ?? poly.TextEncoder;
    return class TextEncoderStream {
      constructor() {
        const enc = new Encoder();
        this.encoding = 'utf-8';
        const ts = new TransformStream({
          transform(chunk, ctrl) { ctrl.enqueue(enc.encode(String(chunk))); },
          flush(ctrl) { ctrl.terminate(); },
        });
        this.readable = ts.readable;
        this.writable = ts.writable;
      }
    };
  })(),
);

/**
 * Decodes a stream of UTF-8 (or other encoding) Uint8Array chunks into strings.
 * Falls back to a hand-written TransformStream shim when absent.
 *
 * @example
 * const ds = new TextDecoderStream('utf-8');
 * byteReadable.pipeThrough(ds);
 * for await (const str of ds.readable) console.log(str);
 */
export const TextDecoderStream = native(
  'TextDecoderStream',
  (() => {
    const Decoder = globalThis.TextDecoder;
    return class TextDecoderStream {
      /** @param {string} [encoding='utf-8'] @param {{ fatal?: boolean; ignoreBOM?: boolean }} [options] */
      constructor(encoding = 'utf-8', options = {}) {
        if (!Decoder)
          throw new Error('TextDecoder is not available in this environment');
        const dec = new Decoder(encoding, { ...options, stream: true });
        this.encoding = dec.encoding;
        this.fatal    = dec.fatal;
        this.ignoreBOM = dec.ignoreBOM;
        const ts = new TransformStream({
          transform(chunk, ctrl) {
            const str = dec.decode(chunk, { stream: true });
            if (str) ctrl.enqueue(str);
          },
          flush(ctrl) {
            const str = dec.decode();
            if (str) ctrl.enqueue(str);
            ctrl.terminate();
          },
        });
        this.readable = ts.readable;
        this.writable = ts.writable;
      }
    };
  })(),
);

// ---------------------------------------------------------------------------
// Compression (native-only — no universal npm polyfill available)
// ---------------------------------------------------------------------------

/**
 * Compresses a byte stream using gzip, deflate, or deflate-raw.
 * Only available when the browser / runtime exposes `CompressionStream` natively.
 * Throws a clear error if unavailable rather than silently exporting `undefined`.
 */
export const CompressionStream = (() => {
  if ('CompressionStream' in globalThis) return globalThis.CompressionStream;
  return class CompressionStream {
    constructor() {
      throw new Error(
        'CompressionStream is not available in this environment. ' +
        'Install "compression-streams-polyfill" and import it before this module.',
      );
    }
  };
})();

/**
 * Decompresses a byte stream using gzip, deflate, or deflate-raw.
 * Only available when the browser / runtime exposes `DecompressionStream` natively.
 */
export const DecompressionStream = (() => {
  if ('DecompressionStream' in globalThis) return globalThis.DecompressionStream;
  return class DecompressionStream {
    constructor() {
      throw new Error(
        'DecompressionStream is not available in this environment. ' +
        'Install "compression-streams-polyfill" and import it before this module.',
      );
    }
  };
})();

export default {
  // Core
  ReadableStream, WritableStream, TransformStream,
  // Readers & writers
  ReadableStreamDefaultReader, ReadableStreamBYOBReader,
  WritableStreamDefaultWriter,
  // Controllers
  ReadableStreamDefaultController, ReadableByteStreamController,
  ReadableStreamBYOBRequest, WritableStreamDefaultController,
  TransformStreamDefaultController,
  // Queuing strategies
  ByteLengthQueuingStrategy, CountQueuingStrategy,
  // Text streams
  TextEncoderStream, TextDecoderStream,
  // Compression (native-only)
  CompressionStream, DecompressionStream,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import {
//   ReadableStream, WritableStream, TransformStream,
//   TextEncoderStream, TextDecoderStream,
//   ByteLengthQueuingStrategy, CountQueuingStrategy,
//   CompressionStream,
// } from './stream/web';
//
// // ReadableStream — produce values
// const rs = new ReadableStream({
//   start(ctrl) { ctrl.enqueue('hello'); ctrl.enqueue(' world'); ctrl.close(); }
// });
//
// // TransformStream — uppercase transform
// const upper = new TransformStream({
//   transform(chunk, ctrl) { ctrl.enqueue(chunk.toUpperCase()); }
// });
// const reader = rs.pipeThrough(upper).getReader();
// console.log((await reader.read()).value); // 'HELLO'
//
// // TextEncoderStream / TextDecoderStream — round-trip
// const enc = new TextEncoderStream();
// const dec = new TextDecoderStream();
// const out = enc.readable.pipeThrough(dec);
// const w = enc.writable.getWriter();
// w.write('café'); w.close();
// for await (const str of out) console.log(str); // 'café'
//
// // ByteLengthQueuingStrategy — backpressure by bytes
// const sink = new WritableStream(
//   { write(chunk) { /* ... */ } },
//   new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 64 })
// );
//
// // CountQueuingStrategy — backpressure by object count
// const objSink = new WritableStream(
//   { write(obj) { /* ... */ } },
//   new CountQueuingStrategy({ highWaterMark: 16 })
// );
//
// // CompressionStream — gzip (native only)
// try {
//   const gz = new CompressionStream('gzip');
// } catch (e) { console.warn(e.message); } // clear error if unavailable
