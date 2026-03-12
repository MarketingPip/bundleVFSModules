
// npm install readable-stream

/*!
 * stream-duplex-web — node:stream Duplex + from/fromWeb/toWeb for browsers & bundlers
 * MIT License. Adapted from Node.js (MIT, Joyent/contributors) and
 * Cloudflare Workers runtime (Apache-2.0, Cloudflare, Inc.)
 * Node.js parity: node:stream Duplex @ Node 0.9.4+
 *                 Duplex.from  @ Node 16.0.0+
 *                 fromWeb/toWeb @ Node 17.0.0+
 * Dependencies: readable-stream
 * Limitations:
 *   • WHATWG objectMode interop in fromWeb/toWeb uses CountQueuingStrategy;
 *     true object serialisation is the caller's responsibility.
 *   • toWeb() readable does not support BYOB readers (no byte source).
 *   • Half-open duplex behaviour across fromWeb/toWeb matches Node semantics
 *     but WHATWG WritableStream has no equivalent of allowHalfOpen; the
 *     writable side is closed when the readable ends if allowHalfOpen=false.
 */

/**
 * @packageDocumentation
 * Browser/bundler-compatible implementation of the `node:stream` **Duplex**
 * surface: the `Duplex` class plus the `from`, `fromWeb`, and `toWeb` utilities.
 *
 * Mirrors the exports of Cloudflare Workers' `node-internal:streams_duplex`.
 *
 * ### Quick reference
 * | Export | Node parity |
 * |---|---|
 * | `Duplex` | `require('stream').Duplex` |
 * | `from(src)` | `stream.Duplex.from(src)` |
 * | `fromWeb({readable,writable})` | `stream.Duplex.fromWeb(...)` |
 * | `toWeb(duplex)` | `stream.Duplex.toWeb(duplex)` |
 */

import { Duplex as _Duplex, Readable, PassThrough } from 'readable-stream';
import { Buffer } from 'buffer';

// ─── Re-export Duplex ───────────────────────────────────────────────────────

/**
 * Full Node.js-compatible `Duplex` stream class, powered by `readable-stream`.
 * Supports objectMode, highWaterMark, cork/uncork, pipe, allowHalfOpen, and
 * the complete Streams2/Streams3 contract.
 *
 * @class
 * @extends {_Duplex}
 */
export { _Duplex as Duplex };

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Returns true if `v` looks like a WHATWG ReadableStream.
 * Uses `'getReader' in v` rather than `instanceof` for cross-realm compat.
 * @param {unknown} v
 * @returns {v is ReadableStream}
 */
const isWHATWGReadable = v =>
  v != null && typeof v === 'object' && typeof v.getReader === 'function';

/**
 * Returns true if `v` looks like a WHATWG WritableStream.
 * @param {unknown} v
 * @returns {v is WritableStream}
 */
const isWHATWGWritable = v =>
  v != null && typeof v === 'object' && typeof v.getWriter === 'function';

/**
 * Returns true if `v` is an AsyncIterable (but not a plain string).
 * @param {unknown} v
 * @returns {boolean}
 */
const isAsyncIterable = v =>
  v != null && typeof v === 'object' && typeof v[Symbol.asyncIterator] === 'function';

/**
 * Returns true if `v` is a Node.js Readable (readable-stream or native).
 * @param {unknown} v
 * @returns {boolean}
 */
const isNodeReadable = v =>
  v != null && typeof v === 'object' && typeof v.pipe === 'function' && typeof v.read === 'function';

/**
 * Returns true if `v` is a Node.js Writable.
 * @param {unknown} v
 * @returns {boolean}
 */
const isNodeWritable = v =>
  v != null && typeof v === 'object' && typeof v.write === 'function' && typeof v.end === 'function';

/**
 * Creates a `Duplex` that reads from an AsyncIterable and exposes a
 * passthrough writable side. Used by `from()` for generators.
 *
 * @param {AsyncIterable<any>} iterable
 * @param {{ objectMode?: boolean }} [opts]
 * @returns {_Duplex}
 */
function duplexFromAsyncIterable(iterable, opts = {}) {
  let reading = false;
  const d = new _Duplex({
    objectMode: opts.objectMode ?? true,
    read() {
      if (reading) return;
      reading = true;
      (async () => {
        try {
          for await (const chunk of iterable) {
            if (!d.push(chunk)) {
              // Back-pressure: pause and wait for _read to be called again.
              reading = false;
              return;
            }
          }
          d.push(null); // EOF
        } catch (err) {
          d.destroy(err);
        }
      })();
    },
    write(chunk, _enc, cb) { cb(); }, // writable side is a sink
    final(cb) { cb(); },
  });
  return d;
}

/**
 * Creates a `Duplex` that reads from a single buffered value (Buffer, string,
 * Uint8Array). The writable side is a no-op sink.
 *
 * @param {Buffer|Uint8Array|string} value
 * @returns {_Duplex}
 */
function duplexFromBuffer(value) {
  const buf = Buffer.isBuffer(value) ? value
    : value instanceof Uint8Array ? Buffer.from(value)
    : Buffer.from(String(value));
  let sent = false;
  return new _Duplex({
    read() { if (!sent) { sent = true; this.push(buf); this.push(null); } },
    write(_c, _e, cb) { cb(); },
    final(cb) { cb(); },
  });
}

// ─── from ───────────────────────────────────────────────────────────────────

/**
 * Creates a `Duplex` from a variety of source types. Mirrors `stream.Duplex.from()`.
 *
 * Supported sources:
 * - `AsyncGenerator` / `AsyncIterable` → readable side streamed, writable is sink
 * - `Buffer` / `Uint8Array` / `string` → single-chunk readable, writable is sink
 * - `Blob` → body streamed as readable
 * - WHATWG `ReadableStream` → delegates to `fromWeb({ readable: src })`
 * - Node.js `Readable` → wrapped in a passthrough Duplex
 * - Node.js `Duplex` → returned as-is
 * - `Promise<any>` → resolved then passed back through `from()`
 *
 * @param {AsyncIterable<any>|ReadableStream|Readable|_Duplex|
 *         Buffer|Uint8Array|string|Blob|Promise<any>} src
 * @param {{ objectMode?: boolean }} [options]
 * @returns {_Duplex}
 * @throws {TypeError} For unsupported source types.
 *
 * @example
 * const d = from(async function* () { yield 'hello'; yield ' world'; }())
 * d.pipe(process.stdout) // → 'hello world'
 */
export function from(src, options = {}) {
  // Already a Duplex
  if (src instanceof _Duplex) return src;

  // Promise — unwrap asynchronously
  if (src && typeof src.then === 'function') {
    const d = new _Duplex({ objectMode: options.objectMode ?? true, read() {}, write(_c, _e, cb) { cb(); } });
    src.then(
      resolved => {
        const inner = from(resolved, options);
        inner.on('data',  chunk => { if (!d.push(chunk)) inner.pause(); });
        inner.on('end',   ()    => d.push(null));
        inner.on('error', err   => d.destroy(err));
        d.on('drain', () => inner.resume());
      },
      err => d.destroy(err)
    );
    return d;
  }

  // WHATWG ReadableStream
  if (isWHATWGReadable(src)) return fromWeb({ readable: src }, options);

  // Node.js Readable (not Duplex) — wrap with a passthrough writable
  if (isNodeReadable(src) && !isNodeWritable(src)) {
    const pt = new PassThrough(options);
    src.pipe(pt);
    src.on('error', err => pt.destroy(err));
    return pt; // PassThrough is a Duplex subclass
  }

  // Node.js Writable (not Readable) — wrap with a passthrough readable
  if (isNodeWritable(src) && !isNodeReadable(src)) {
    const pt = new PassThrough(options);
    pt.pipe(src);
    pt.on('error', err => src.destroy?.(err));
    return pt;
  }

  // Blob
  if (typeof Blob !== 'undefined' && src instanceof Blob)
    return from(src.stream(), options);

  // Buffer / Uint8Array / string
  if (Buffer.isBuffer(src) || src instanceof Uint8Array || typeof src === 'string')
    return duplexFromBuffer(src);

  // AsyncIterable / AsyncGenerator
  if (isAsyncIterable(src)) return duplexFromAsyncIterable(src, options);

  throw new TypeError(
    `stream.Duplex.from() does not support the provided source type: ${
      src === null ? 'null' : typeof src
    }`
  );
}

// ─── fromWeb ─────────────────────────────────────────────────────────────────

/**
 * Converts a pair of WHATWG streams into a single Node.js `Duplex`.
 * Mirrors `stream.Duplex.fromWeb({ readable, writable }, options)` (Node 17+).
 *
 * Either `readable` or `writable` may be omitted:
 * - Omitting `readable` → the Duplex's readable side is always EOF.
 * - Omitting `writable` → the Duplex's writable side is a sink (writes discarded).
 *
 * Backpressure is honoured:
 * - Readable side: Duplex `_read()` calls `reader.read()` and respects push return value.
 * - Writable side: Duplex `_write()` awaits `writer.ready` before writing.
 *
 * @param {{ readable?: ReadableStream<any>; writable?: WritableStream<any> }} webStreams
 * @param {{ objectMode?: boolean; highWaterMark?: number;
 *           allowHalfOpen?: boolean; signal?: AbortSignal }} [options]
 * @returns {_Duplex}
 *
 * @example
 * const { readable, writable } = new TransformStream()
 * const duplex = fromWeb({ readable, writable })
 * duplex.write('hello')
 * duplex.on('data', chunk => console.log(chunk.toString())) // → 'hello'
 * duplex.end()
 */
export function fromWeb(
  { readable: webReadable, writable: webWritable } = {},
  options = {}
) {
  const {
    objectMode   = false,
    highWaterMark = objectMode ? 16 : 16 * 1024,
    allowHalfOpen = true,
    signal,
  } = options;

  let reader = null;
  let writer = null;
  let reading = false;
  let writableEnded = false;
  let readableEnded = false;

  const d = new _Duplex({ objectMode, highWaterMark, allowHalfOpen });

  // ── Readable side ─────────────────────────────────────────────────────────
  if (webReadable) {
    if (!isWHATWGReadable(webReadable))
      throw new TypeError('fromWeb: options.readable must be a WHATWG ReadableStream.');

    reader = webReadable.getReader();

    d._read = function () {
      if (reading) return;
      reading = true;
      reader.read().then(
        ({ done, value }) => {
          reading = false;
          if (done) {
            readableEnded = true;
            d.push(null);
            if (!allowHalfOpen && !writableEnded && writer) {
              writer.close().catch(() => {});
            }
          } else {
            const canContinue = d.push(objectMode ? value : Buffer.from(value));
            if (canContinue) d._read(); // drain the WHATWG stream eagerly
          }
        },
        err => { reading = false; d.destroy(err); }
      );
    };
  } else {
    // No readable source — immediately EOF
    d._read = function () { this.push(null); };
  }

  // ── Writable side ─────────────────────────────────────────────────────────
  if (webWritable) {
    if (!isWHATWGWritable(webWritable))
      throw new TypeError('fromWeb: options.writable must be a WHATWG WritableStream.');

    writer = webWritable.getWriter();

    d._write = function (chunk, _enc, cb) {
      writer.ready.then(
        ()    => writer.write(objectMode ? chunk : Buffer.from(chunk))
      ).then(
        ()    => cb(),
        err   => cb(err)
      );
    };

    d._final = function (cb) {
      writableEnded = true;
      writer.close().then(() => cb(), err => cb(err));
    };
  } else {
    d._write = function (_c, _e, cb) { cb(); };
    d._final = function (cb) { cb(); };
  }

  // ── Destroy / abort ───────────────────────────────────────────────────────
  d._destroy = function (err, cb) {
    const p1 = reader
      ? reader.cancel(err).catch(() => {})
      : Promise.resolve();
    const p2 = writer && !writableEnded
      ? writer.abort(err).catch(() => {})
      : Promise.resolve();
    Promise.all([p1, p2]).then(() => cb(err), () => cb(err));
  };

  // External AbortSignal support
  if (signal) {
    const onAbort = () => d.destroy(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) { globalThis.setTimeout(onAbort, 0); }
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return d;
}

// ─── toWeb ───────────────────────────────────────────────────────────────────

/**
 * Converts a Node.js `Duplex` (or any `Readable`/`Writable`) into a pair of
 * WHATWG streams. Mirrors `stream.Duplex.toWeb(duplex)` (Node 17+).
 *
 * Backpressure contract:
 * - `readable` pull → calls `duplex.read()` / resumes the stream.
 * - `writable` write → calls `duplex.write()` and awaits drain if needed.
 * - `writable` close → calls `duplex.end()`.
 * - Cancelling `readable` or aborting `writable` → calls `duplex.destroy()`.
 *
 * @param {_Duplex|import('readable-stream').Readable} duplex
 * @param {{ objectMode?: boolean }} [options]
 * @returns {{ readable: ReadableStream<any>; writable: WritableStream<any> }}
 *
 * @example
 * const pt = new PassThrough()
 * const { readable, writable } = toWeb(pt)
 * const writer = writable.getWriter()
 * await writer.write(new TextEncoder().encode('hello'))
 * await writer.close()
 * const reader = readable.getReader()
 * const { value } = await reader.read()
 * console.log(new TextDecoder().decode(value)) // → 'hello'
 */
export function toWeb(duplex, { objectMode = false } = {}) {
  if (!isNodeReadable(duplex))
    throw new TypeError('toWeb: argument must be a Node.js Readable or Duplex stream.');

  const qs = objectMode
    ? new CountQueuingStrategy({ highWaterMark: 16 })
    : new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 });

  // ── Readable (Node → WHATWG) ───────────────────────────────────────────────
  let readableController = null;
  let destroyed = false;

  const readable = new ReadableStream({
    start(controller) {
      readableController = controller;

      duplex.on('data', chunk => {
        if (destroyed) return;
        const out = objectMode ? chunk : (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        readableController.enqueue(out);
        // Apply backpressure: pause the Node stream when WHATWG queue is full.
        if (readableController.desiredSize !== null && readableController.desiredSize <= 0) {
          duplex.pause();
        }
      });

      duplex.on('end', () => {
        if (!destroyed) readableController.close();
      });

      duplex.on('error', err => {
        if (!destroyed) readableController.error(err);
      });
    },
    pull() {
      // WHATWG is ready for more — resume the Node stream.
      duplex.resume();
    },
    cancel(reason) {
      destroyed = true;
      duplex.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    },
  }, qs);

  // ── Writable (WHATWG → Node) ───────────────────────────────────────────────
  const writable = isNodeWritable(duplex)
    ? new WritableStream({
        write(chunk) {
          return new Promise((resolve, reject) => {
            const out = objectMode ? chunk : (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const ok = duplex.write(out, err => { if (err) reject(err); });
            if (ok) resolve();
            else duplex.once('drain', resolve);
          });
        },
        close() {
          return new Promise((resolve, reject) => {
            duplex.end(err => (err ? reject(err) : resolve()));
          });
        },
        abort(reason) {
          destroyed = true;
          duplex.destroy(reason instanceof Error ? reason : new Error(String(reason)));
          return Promise.resolve();
        },
      }, new CountQueuingStrategy({ highWaterMark: 1 }))
    : (() => {
        // Readable-only source: provide an immediately-closing writable sink.
        const { writable: sink } = new TransformStream();
        return sink;
      })();

  return { readable, writable };
}

// ─── Attach as static methods (mirrors Node's Duplex.from / Duplex.fromWeb) ─

_Duplex.from    = from;
_Duplex.fromWeb = fromWeb;
_Duplex.toWeb   = toWeb;

// ─── Default export (mirrors Cloudflare's module shape) ────────────────────

export default _Duplex;

// --- Usage ---
//
// // 1. from() — async generator source
// import { from } from './stream-duplex-web.js'
//
// async function* counter() { for (let i = 0; i < 3; i++) yield `chunk-${i}\n` }
// const d = from(counter())
// d.on('data', chunk => process.stdout.write(chunk))
// // → 'chunk-0\n' 'chunk-1\n' 'chunk-2\n'
//
//
// // 2. fromWeb() — TransformStream bridge
// import { fromWeb } from './stream-duplex-web.js'
//
// const transform = new TransformStream({
//   transform(chunk, controller) {
//     controller.enqueue(chunk.toString().toUpperCase())
//   }
// })
// const duplex = fromWeb({ readable: transform.readable, writable: transform.writable })
// duplex.on('data', chunk => console.log(chunk.toString())) // → 'HELLO'
// duplex.write('hello')
// duplex.end()
//
//
// // 3. toWeb() — pipe a Node PassThrough into a WHATWG fetch body
// import { PassThrough } from 'readable-stream'
// import { toWeb } from './stream-duplex-web.js'
//
// const pt = new PassThrough()
// const { readable } = toWeb(pt)
// pt.end('{"status":"ok"}')
//
// // Use as a streaming fetch response body:
// const response = new Response(readable, { headers: { 'Content-Type': 'application/json' } })
// const text = await response.text()  // → '{"status":"ok"}'
//
//
// // 4. Edge case — AbortSignal cancellation on fromWeb()
// import { fromWeb } from './stream-duplex-web.js'
//
// const ac = new AbortController()
// const { readable } = new TransformStream()
// const duplex = fromWeb({ readable }, { signal: ac.signal })
// duplex.on('error', err => console.error(err.name)) // → 'AbortError'
// ac.abort()
