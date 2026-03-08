// npm install buffer  (via ./stream → readable-stream)

/*!
 * stream-web/consumers — node:stream/consumers for browsers & bundlers
 * MIT License.
 * Node.js parity: node:stream/consumers @ Node 16.7.0+
 * Dependencies: buffer, readable-stream (via ../stream)
 * Limitations:
 *   - Blob constructor requires a browser/Node ≥ 15.7 environment.
 *   - CompressionStream / DecompressionStream not handled here (see stream/web).
 */

/**
 * @packageDocumentation
 * Implements `node:stream/consumers`: fully consumes a Readable, WHATWG
 * ReadableStream, async iterable, or Blob into a variety of formats.
 *
 * Accepted input for every export:
 *   - Node.js `stream.Readable` (from ../stream)
 *   - WHATWG `ReadableStream`
 *   - Any async iterable (`Symbol.asyncIterator`)
 *   - `Blob` / `File`
 */

import { Buffer } from 'buffer';
import stream from '../stream';

// ---------------------------------------------------------------------------
// Internal: normalise any supported input into an async iterable of Buffers
// ---------------------------------------------------------------------------

/**
 * Returns true if `v` is a WHATWG ReadableStream.
 * @param {unknown} v
 */
const isWHATWGReadable = v =>
  v != null &&
  typeof v === 'object' &&
  typeof v.getReader === 'function';

/**
 * Returns true if `v` is a Blob or File.
 * @param {unknown} v
 */
const isBlob = v =>
  v != null &&
  typeof v === 'object' &&
  typeof v.arrayBuffer === 'function' &&
  typeof v.stream === 'function';

/**
 * Returns true if `v` is a Node.js stream.Readable.
 * @param {unknown} v
 */
const isNodeReadable = v =>
  v instanceof stream.Readable ||
  (v != null && typeof v === 'object' && typeof v.pipe === 'function' && typeof v.read === 'function');

/**
 * Converts any accepted input into an async iterable that yields `Buffer` chunks.
 * @param {stream.Readable | ReadableStream | AsyncIterable<any> | Blob} src
 * @returns {AsyncIterable<Buffer>}
 */
async function* toChunks(src) {
  // Blob / File — stream it via its own .stream()
  if (isBlob(src)) {
    yield* toChunks(src.stream());
    return;
  }

  // WHATWG ReadableStream
  if (isWHATWGReadable(src)) {
    const reader = src.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield Buffer.isBuffer(value) ? value : Buffer.from(value);
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  // Node Readable or any async iterable (Node Readable is async iterable in ≥ 12)
  if (isNodeReadable(src) || src[Symbol.asyncIterator]) {
    for await (const chunk of src) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
    return;
  }

  throw new TypeError(
    'stream/consumers: expected a Readable, ReadableStream, async iterable, or Blob'
  );
}

/**
 * Concatenates all chunks from `src` into a single `Buffer`.
 * @param {stream.Readable | ReadableStream | AsyncIterable<any> | Blob} src
 * @returns {Promise<Buffer>}
 */
async function collectBuffer(src) {
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of toChunks(src)) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }
  return Buffer.concat(chunks, totalLength);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Consumes the stream and returns a `Buffer`.
 * @param {stream.Readable | ReadableStream | AsyncIterable<any> | Blob} readable
 * @returns {Promise<Buffer>}
 *
 * @example
 * import { buffer } from './stream/consumers';
 * const buf = await buffer(fs.createReadStream('file.bin'));
 */
export async function buffer(readable) {
  return collectBuffer(readable);
}

/**
 * Consumes the stream and returns a UTF-8 decoded string.
 * @param {stream.Readable | ReadableStream | AsyncIterable<any> | Blob} readable
 * @returns {Promise<string>}
 *
 * @example
 * const str = await text(res.body);
 */
export async function text(readable) {
  const buf = await collectBuffer(readable);
  return buf.toString('utf8');
}

/**
 * Consumes the stream, decodes as UTF-8, and JSON-parses the result.
 * @param {stream.Readable | ReadableStream | AsyncIterable<any> | Blob} readable
 * @returns {Promise<any>}
 * @throws {SyntaxError} if the accumulated text is not valid JSON.
 *
 * @example
 * const data = await json(res.body);
 */
export async function json(readable) {
  const str = await text(readable);
  return JSON.parse(str);
}

/**
 * Consumes the stream and returns an `ArrayBuffer`.
 * The underlying memory is a *copy* — not a view into a shared buffer.
 * @param {stream.Readable | ReadableStream | AsyncIterable<any> | Blob} readable
 * @returns {Promise<ArrayBuffer>}
 *
 * @example
 * const ab = await arrayBuffer(res.body);
 * const view = new Uint8Array(ab);
 */
export async function arrayBuffer(readable) {
  const buf = await collectBuffer(readable);
  // Buffer.buffer may be a shared ArrayBuffer; slice() gives us an owned copy.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Consumes the stream and returns a `Blob`.
 * Requires `Blob` to be available as a global (browsers, Node ≥ 15.7).
 * @param {stream.Readable | ReadableStream | AsyncIterable<any> | Blob} readable
 * @param {{ type?: string }} [options] - Optional MIME type for the Blob.
 * @returns {Promise<Blob>}
 *
 * @example
 * const b = await blob(res.body, { type: 'image/png' });
 * const url = URL.createObjectURL(b);
 */
export async function blob(readable, options = {}) {
  if (typeof globalThis.Blob === 'undefined')
    throw new Error('stream/consumers: Blob is not available in this environment');
  const ab = await arrayBuffer(readable);
  return new globalThis.Blob([ab], options);
}

export default { buffer, text, json, arrayBuffer, blob };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { buffer, text, json, arrayBuffer, blob } from './stream/consumers';
// import { Readable } from '../stream';
//
// // Node Readable → Buffer
// const r = Readable.from(['hello', ' ', 'world']);
// const buf = await buffer(r);                  // → <Buffer 68 65 6c 6c 6f 20 77 6f 72 6c 64>
//
// // WHATWG ReadableStream → string
// const res = await fetch('https://example.com');
// const str = await text(res.body);
//
// // WHATWG ReadableStream → parsed JSON
// const res2 = await fetch('https://api.example.com/data');
// const data = await json(res2.body);
//
// // Async iterable → ArrayBuffer
// async function* gen() { yield 'foo'; yield 'bar'; }
// const ab = await arrayBuffer(gen());
//
// // Blob → Blob (round-trip, adding a MIME type)
// const input = new Blob(['{"ok":true}'], { type: 'application/json' });
// const out   = await blob(input, { type: 'application/json' }); // re-wrapped
//
// // Edge: invalid JSON throws SyntaxError
// const bad = Readable.from(['{invalid}']);
// await json(bad).catch(e => console.log(e instanceof SyntaxError)); // true
