// npm install readable-stream buffer

/*!
 * stream-readable-web — node:stream Readable surface for browsers & bundlers
 * MIT License. Adapted from Node.js (MIT, Joyent/contributors) and
 * Cloudflare Workers runtime (Apache-2.0, Cloudflare, Inc.)
 * Node.js parity: node:stream Readable @ Node 0.9.4+
 *                 Readable.from    @ Node 12.3.0+
 *                 fromWeb / toWeb  @ Node 17.0.0+
 *                 ReadableState    @ Node 0.9.4+ (internal, re-exported)
 * Dependencies: readable-stream, buffer
 * Limitations:
 *   • toWeb() readable side does not expose a BYOB reader (no byte source).
 *   • ReadableState is extracted from a live instance; treat it as opaque —
 *     its internal shape differs slightly across readable-stream versions.
 *   • fromWeb() with a locked ReadableStream will throw synchronously,
 *     matching Node behaviour.
 *   • Encoding / objectMode interop in fromWeb/toWeb: WHATWG streams have no
 *     native concept of objectMode; callers must set options explicitly.
 */

/**
 * @packageDocumentation
 * Browser/bundler-compatible implementation of the `node:stream` **Readable**
 * surface: the `Readable` class, `ReadableState`, and the `from`, `fromWeb`,
 * `toWeb`, and `wrap` utility functions.
 *
 * Mirrors the exports of Cloudflare Workers' `node-internal:streams_readable`.
 *
 * ### Export reference
 * | Export | Node parity | Since |
 * |---|---|---|
 * | `Readable` | `require('stream').Readable` | Node 0.9.4 |
 * | `ReadableState` | `stream.Readable` internal state class | Node 0.9.4 |
 * | `from(src, opts?)` | `stream.Readable.from()` | Node 12.3 |
 * | `fromWeb(rs, opts?)` | `stream.Readable.fromWeb()` | Node 17.0 |
 * | `toWeb(readable, opts?)` | `stream.Readable.toWeb()` | Node 17.0 |
 * | `wrap(stream)` | `new Readable().wrap()` | Node 0.9.4 |
 */

import { Readable as _Readable } from 'readable-stream';
import { Buffer } from 'buffer';

// ─── Readable ───────────────────────────────────────────────────────────────

/**
 * Full Node.js-compatible `Readable` stream, powered by `readable-stream`.
 *
 * Supports: objectMode, highWaterMark, encoding, `pipe()`, `async for-await`,
 * `Symbol.asyncIterator`, cork/uncork, `destroy()`, and the complete
 * Streams2/3 event contract (`'data'`, `'end'`, `'error'`, `'close'`,
 * `'readable'`, `'pause'`, `'resume'`).
 *
 * @class
 * @extends {_Readable}
 *
 * @example
 * const r = new Readable({ read() {} })
 * r.push('hello')
 * r.push(null)      // EOF
 * r.on('data', chunk => console.log(chunk.toString())) // → 'hello'
 */
export { _Readable as Readable };

// ─── ReadableState ───────────────────────────────────────────────────────────

/**
 * The internal state class attached to every `Readable` as `stream._readableState`.
 *
 * Rarely constructed directly; exported for source-compatibility with code that
 * performs `instanceof ReadableState` checks or reads state properties for
 * diagnostics (e.g. `stream._readableState.length`, `stream._readableState.ended`).
 *
 * @class
 *
 * @example
 * import { Readable, ReadableState } from './stream-readable-web.js'
 * const r = new Readable({ read() {} })
 * console.log(r._readableState instanceof ReadableState) // → true
 * console.log(r._readableState.objectMode)               // → false
 */
export const ReadableState = new _Readable({ read() {} })._readableState.constructor;

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * @param {unknown} v
 * @returns {v is ReadableStream}
 */
const isWHATWGReadable = v =>
  v != null && typeof v === 'object' && typeof v.getReader === 'function';

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isAsyncIterable = v =>
  v != null && typeof v[Symbol.asyncIterator] === 'function';

/**
 * @param {unknown} v
 * @returns {boolean}
 */
const isSyncIterable = v =>
  v != null && typeof v[Symbol.iterator] === 'function' && typeof v !== 'string';

/**
 * Normalises a chunk to `Buffer` for binary-mode streams, or leaves it
 * as-is for objectMode streams.
 *
 * @param {unknown} chunk
 * @param {boolean} objectMode
 * @returns {Buffer|unknown}
 */
function normaliseChunk(chunk, objectMode) {
  if (objectMode) return chunk;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

// ─── from ────────────────────────────────────────────────────────────────────

/**
 * Creates a `Readable` from a variety of source types.
 * Mirrors `stream.Readable.from()` (Node 12.3+).
 *
 * ### Supported sources
 * | Source type | Behaviour |
 * |---|---|
 * | `AsyncIterable` / `AsyncGenerator` | Streamed lazily, respects back-pressure |
 * | `Iterable` (sync, non-string) | Iterated synchronously chunk-by-chunk |
 * | `string` | Emitted as a single UTF-8 chunk |
 * | `Buffer` / `Uint8Array` | Emitted as a single binary chunk |
 * | `Blob` | Body streamed via `Blob.stream()` |
 * | WHATWG `ReadableStream` | Delegates to {@link fromWeb} |
 * | `Promise<any of the above>` | Resolved then re-processed |
 *
 * Destroying the returned `Readable` before iteration completes calls
 * `iterator.return()` on the underlying iterator, releasing any held resources.
 *
 * @template T
 * @param {AsyncIterable<T>|Iterable<T>|ReadableStream<T>|
 *         Buffer|Uint8Array|string|Blob|Promise<any>} src
 * @param {{ objectMode?: boolean; highWaterMark?: number;
 *           encoding?: BufferEncoding }} [options]
 * @returns {_Readable}
 * @throws {TypeError} For unsupported source types.
 *
 * @example
 * // Async generator
 * async function* gen() { yield 'a'; yield 'b'; yield 'c'; }
 * const r = from(gen())
 * for await (const chunk of r) process.stdout.write(chunk) // → 'abc'
 *
 * @example
 * // Array (sync iterable)
 * const r = from([1, 2, 3], { objectMode: true })
 * r.on('data', n => console.log(n)) // → 1, 2, 3
 */
export function from(src, options = {}) {
  // WHATWG ReadableStream
  if (isWHATWGReadable(src)) return fromWeb(src, options);

  // Promise — unwrap, then recurse
  if (src != null && typeof src.then === 'function') {
    const objectMode = options.objectMode ?? true;
    let inner = null;
    const r = new _Readable({
      objectMode,
      highWaterMark: options.highWaterMark,
      read() {
        if (inner) { inner.resume(); return; }
        src.then(
          resolved => {
            inner = from(resolved, options);
            inner.on('data',  chunk => { if (!r.push(chunk)) inner.pause(); });
            inner.on('end',   ()    => r.push(null));
            inner.on('error', err   => r.destroy(err));
          },
          err => r.destroy(err)
        );
      },
    });
    r._destroy = (err, cb) => {
      inner?.destroy();
      cb(err);
    };
    return r;
  }

  // Blob
  if (typeof Blob !== 'undefined' && src instanceof Blob)
    return from(src.stream(), options);

  // Buffer / Uint8Array
  if (Buffer.isBuffer(src) || src instanceof Uint8Array) {
    const buf = Buffer.isBuffer(src) ? src : Buffer.from(src);
    return _singleChunkReadable(buf, false);
  }

  // String — emit as one UTF-8 chunk
  if (typeof src === 'string') return _singleChunkReadable(Buffer.from(src, options.encoding ?? 'utf8'), false);

  // AsyncIterable
  if (isAsyncIterable(src)) return _readableFromAsyncIterable(src, options);

  // Sync Iterable (but not string — already handled above)
  if (isSyncIterable(src)) return _readableFromSyncIterable(src, options);

  throw new TypeError(
    `stream.Readable.from() does not support the provided source type: ${
      src === null ? 'null' : typeof src
    }`
  );
}

/**
 * @param {Buffer} buf
 * @param {boolean} objectMode
 * @returns {_Readable}
 * @private
 */
function _singleChunkReadable(buf, objectMode) {
  let sent = false;
  return new _Readable({
    objectMode,
    read() { if (!sent) { sent = true; this.push(buf); this.push(null); } },
  });
}

/**
 * @template T
 * @param {AsyncIterable<T>} iterable
 * @param {{ objectMode?: boolean; highWaterMark?: number }} opts
 * @returns {_Readable}
 * @private
 */
function _readableFromAsyncIterable(iterable, opts) {
  const objectMode = opts.objectMode ?? true;
  let iterator = null;
  let pumping  = false;

  const r = new _Readable({ objectMode, highWaterMark: opts.highWaterMark });

  /**
   * Pull loop: continues as long as push() returns true (no back-pressure)
   * and the iterator is not exhausted. Re-enters on each _read() call when
   * the consumer is ready for more data.
   */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      if (!iterator) iterator = iterable[Symbol.asyncIterator]();
      while (true) {
        const { done, value } = await iterator.next();
        if (done) { r.push(null); break; }
        const chunk = normaliseChunk(value, objectMode);
        const canContinue = r.push(chunk);
        if (!canContinue) break; // back-pressure — wait for next _read()
      }
    } catch (err) {
      r.destroy(err);
    } finally {
      pumping = false;
    }
  }

  r._read  = () => pump();
  r._destroy = (err, cb) => {
    const fin = iterator && typeof iterator.return === 'function'
      ? Promise.resolve(iterator.return()).catch(() => {})
      : Promise.resolve();
    fin.then(() => cb(err));
  };

  return r;
}

/**
 * @template T
 * @param {Iterable<T>} iterable
 * @param {{ objectMode?: boolean; highWaterMark?: number }} opts
 * @returns {_Readable}
 * @private
 */
function _readableFromSyncIterable(iterable, opts) {
  const objectMode = opts.objectMode ?? true;
  const iter = iterable[Symbol.iterator]();
  const r = new _Readable({ objectMode, highWaterMark: opts.highWaterMark });

  r._read = function () {
    try {
      let res;
      while (!(res = iter.next()).done) {
        const chunk = normaliseChunk(res.value, objectMode);
        if (!this.push(chunk)) return; // back-pressure
      }
      this.push(null); // exhausted
    } catch (err) {
      this.destroy(err);
    }
  };

  r._destroy = (err, cb) => {
    if (typeof iter.return === 'function') iter.return();
    cb(err);
  };

  return r;
}

// ─── fromWeb ─────────────────────────────────────────────────────────────────

/**
 * Converts a WHATWG `ReadableStream` into a Node.js `Readable`.
 * Mirrors `stream.Readable.fromWeb()` (Node 17+).
 *
 * Back-pressure is fully honoured: the WHATWG reader is only advanced when
 * Node's `_read()` is called, preventing unbounded memory growth when the
 * Node consumer is slower than the WHATWG producer.
 *
 * Destroying the returned `Readable` cancels the underlying WHATWG reader.
 *
 * @param {ReadableStream<any>} webReadableStream - Must not already be locked.
 * @param {{ objectMode?: boolean; highWaterMark?: number;
 *           encoding?: BufferEncoding; signal?: AbortSignal }} [options]
 * @returns {_Readable}
 * @throws {TypeError} If `webReadableStream` is not a WHATWG `ReadableStream`.
 * @throws {Error} If `webReadableStream` is already locked.
 *
 * @example
 * const resp = await fetch('https://example.com/data.json')
 * const nodeReadable = fromWeb(resp.body)
 * nodeReadable.pipe(process.stdout)
 */
export function fromWeb(webReadableStream, options = {}) {
  if (!isWHATWGReadable(webReadableStream))
    throw new TypeError('fromWeb: argument must be a WHATWG ReadableStream.');
  if (webReadableStream.locked)
    throw new Error('fromWeb: ReadableStream is already locked.');

  const {
    objectMode   = false,
    highWaterMark,
    encoding,
    signal,
  } = options;

  const reader = webReadableStream.getReader();
  let reading  = false;

  const r = new _Readable({
    objectMode,
    highWaterMark: highWaterMark ?? (objectMode ? 16 : 16 * 1024),
    encoding: objectMode ? undefined : encoding,
  });

  r._read = function () {
    if (reading) return;
    reading = true;
    reader.read().then(
      ({ done, value }) => {
        reading = false;
        if (done) {
          this.push(null);
          return;
        }
        const chunk = normaliseChunk(value, objectMode);
        const canContinue = this.push(chunk);
        if (canContinue) this._read(); // eagerly drain while consumer keeps up
      },
      err => { reading = false; this.destroy(err); }
    );
  };

  r._destroy = function (err, cb) {
    reader.cancel(err ?? undefined)
      .catch(() => {})
      .then(() => cb(err));
  };

  if (signal) {
    const onAbort = () =>
      r.destroy(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) globalThis.setTimeout(onAbort, 0);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return r;
}

// ─── toWeb ───────────────────────────────────────────────────────────────────

/**
 * Converts a Node.js `Readable` into a WHATWG `ReadableStream`.
 * Mirrors `stream.Readable.toWeb()` (Node 17+).
 *
 * ### Back-pressure contract
 * - WHATWG `pull()` → `readable.resume()` (requests more data from Node).
 * - Node `'data'` event → `controller.enqueue()` (feeds the WHATWG queue).
 * - Node `'end'` → `controller.close()`.
 * - Node `'error'` → `controller.error()`.
 * - WHATWG `cancel()` → `readable.destroy()`.
 * - When `controller.desiredSize <= 0` the Node stream is `pause()`d until
 *   the WHATWG consumer catches up.
 *
 * @param {_Readable} readable - A Node.js Readable stream.
 * @param {{ objectMode?: boolean; strategy?: QueuingStrategy }} [options]
 * @returns {ReadableStream<any>}
 * @throws {TypeError} If `readable` is not a Node.js Readable.
 *
 * @example
 * import { PassThrough } from 'readable-stream'
 * const pt = new PassThrough()
 * const web = toWeb(pt)
 * pt.end('hello world')
 * const reader = web.getReader()
 * const { value } = await reader.read()
 * console.log(Buffer.from(value).toString()) // → 'hello world'
 */
export function toWeb(readable, options = {}) {
  if (!readable || typeof readable.pipe !== 'function' || typeof readable.read !== 'function')
    throw new TypeError('toWeb: argument must be a Node.js Readable stream.');

  const objectMode = options.objectMode
    ?? readable._readableState?.objectMode
    ?? false;

  const strategy = options.strategy ?? (
    objectMode
      ? new CountQueuingStrategy({ highWaterMark: 16 })
      : new ByteLengthQueuingStrategy({ highWaterMark: 16 * 1024 })
  );

  let controller = null;
  let finished   = false;

  const webStream = new ReadableStream({
    start(c) {
      controller = c;

      readable.on('data', chunk => {
        if (finished) return;
        const out = normaliseChunk(chunk, objectMode);
        controller.enqueue(out);
        // Apply back-pressure: pause Node stream when WHATWG queue is saturated.
        if (controller.desiredSize !== null && controller.desiredSize <= 0)
          readable.pause();
      });

      readable.on('end', () => {
        if (!finished) { finished = true; controller.close(); }
      });

      readable.on('error', err => {
        if (!finished) { finished = true; controller.error(err); }
      });

      readable.on('close', () => {
        // Stream destroyed before 'end' — close the WHATWG stream gracefully.
        if (!finished) { finished = true; try { controller.close(); } catch (_) {} }
      });
    },

    pull() {
      // WHATWG consumer is ready for more — unpause the Node stream.
      readable.resume();
    },

    cancel(reason) {
      finished = true;
      readable.destroy(
        reason instanceof Error ? reason
          : reason != null ? new Error(String(reason))
          : undefined
      );
    },
  }, strategy);

  return webStream;
}

// ─── wrap ────────────────────────────────────────────────────────────────────

/**
 * Wraps a Node.js 0.x "classic" (Streams1) stream in a Streams2 `Readable`.
 *
 * Classic streams use push-style `'data'` / `'end'` events and expose
 * `.pause()` / `.resume()` but have no `.read()` method. `wrap()` bridges
 * them into the Streams2 pull model so they can be piped, async-iterated,
 * or used anywhere a Streams2 `Readable` is expected.
 *
 * This is a convenience standalone function; internally it delegates to
 * `readable-stream`'s built-in `Readable.prototype.wrap()`.
 *
 * @param {object} classicStream - A Streams1-style stream with `'data'` /
 *   `'end'` events and optional `.pause()` / `.resume()` methods.
 * @param {{ highWaterMark?: number; encoding?: BufferEncoding }} [options]
 * @returns {_Readable} A Streams2 Readable wrapping the classic stream.
 *
 * @example
 * // Wrap a legacy stream that predates Streams2
 * const legacyStream = getLegacyStream()  // has .on('data') but no .read()
 * const modern = wrap(legacyStream)
 * modern.pipe(process.stdout)
 *
 * @example
 * // Async-iterate a classic stream
 * for await (const chunk of wrap(classicStream)) {
 *   console.log(chunk.toString())
 * }
 */
export function wrap(classicStream, options = {}) {
  if (classicStream instanceof _Readable) return classicStream; // already Streams2
  const r = new _Readable({
    highWaterMark: options.highWaterMark,
    encoding:      options.encoding,
    read() {},
  });
  return r.wrap(classicStream); // built-in Readable.prototype.wrap
}

// ─── Attach as static methods (mirrors Node's Readable.from / .fromWeb etc.) ─

_Readable.from    = from;
_Readable.fromWeb = fromWeb;
_Readable.toWeb   = toWeb;

// ─── Default export (mirrors Cloudflare's module shape) ─────────────────────

export default _Readable;

// --- Usage ---
//
// // 1. from() — async generator with back-pressure
// import { from } from './stream-readable-web.js'
//
// async function* paginate(url) {
//   while (url) {
//     const res  = await fetch(url)
//     const data = await res.json()
//     yield data.items          // yields arrays of records
//     url = data.nextPageUrl
//   }
// }
// const r = from(paginate('https://api.example.com/items'), { objectMode: true })
// for await (const page of r) console.log(`Got ${page.length} items`)
//
//
// // 2. fromWeb() — stream a Fetch response body through a Node transform
// import { fromWeb } from './stream-readable-web.js'
// import { createGunzip } from 'pako'  // or any Transform
//
// const response = await fetch('https://example.com/data.ndjson.gz')
// const lines    = fromWeb(response.body, { encoding: 'utf8' })
// lines.on('data', line => console.log(JSON.parse(line)))
//
//
// // 3. toWeb() — pipe a Node Readable into a WHATWG Response body
// import { Readable } from 'readable-stream'
// import { toWeb }    from './stream-readable-web.js'
//
// const nodeStream = new Readable({ read() {} })
// nodeStream.push('{"status":"streaming"}')
// nodeStream.push(null)
//
// const response = new Response(toWeb(nodeStream), {
//   headers: { 'Content-Type': 'application/json' },
// })
// console.log(await response.text()) // → '{"status":"streaming"}'
//
//
// // 4. wrap() — async-iterate a Streams1 legacy source
// import { wrap } from './stream-readable-web.js'
//
// const chunks = []
// for await (const chunk of wrap(legacyStream))
//   chunks.push(chunk)
// console.log(Buffer.concat(chunks).toString())
//
//
// // 5. Edge case — destroy mid-iteration releases iterator resources
// import { from } from './stream-readable-web.js'
//
// async function* infinite() { let i = 0; while (true) yield i++; }
// const r = from(infinite())
// r.once('data', chunk => {
//   console.log(chunk)  // → <Buffer 00 00 00 00> (first value)
//   r.destroy()         // calls iterator.return(), stopping the generator cleanly
// })
// r.resume()
