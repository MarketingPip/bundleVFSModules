// npm install events

/*!
 * _http_incoming-web — node:_http_incoming for browsers & bundlers
 * MIT License.
 * Node.js parity: node:_http_incoming @ Node 0.1.90+ (internal, stable surface)
 * Dependencies: events
 * Limitations:
 *   - Backed by a WHATWG ReadableStream / fetch Response body — no raw TCP socket.
 *   - socket property is a synthetic placeholder, not a real net.Socket.
 *   - pipe() is best-effort (fires data/end events on dest).
 *   - HTTP trailers (rawTrailers / trailers) are always empty (not exposed by fetch).
 *   - httpVersionMajor / httpVersionMinor default to 1/1; actual HTTP/2 or
 *     HTTP/3 connections from fetch() are not distinguished.
 *   - push() is present for Readable interface parity but always returns false.
 */

/**
 * @packageDocumentation
 * Browser-compatible `IncomingMessage` — the readable request/response object
 * passed to `http.Server` request handlers and `http.ClientRequest` response
 * callbacks.
 *
 * Implements the full Node.js `http.IncomingMessage` public surface:
 *   - EventEmitter with 'data', 'end', 'error', 'close', 'aborted' events.
 *   - Readable stream duck-type: resume(), pause(), read(), setEncoding(),
 *     destroy(), pipe(), unpipe(), [Symbol.asyncIterator]().
 *   - HTTP metadata: statusCode, statusMessage, headers, rawHeaders,
 *     httpVersion, method, url, complete, aborted, trailers, rawTrailers.
 *   - Socket-shape accessors: socket, connection, localAddress, remoteAddress.
 */

import EventEmitter from 'events';
import { _checkInvalidHeaderChar } from './_http_common';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts a WHATWG `Headers` object into Node's parallel arrays.
 * @param {Headers} headers
 * @returns {{ raw: string[]; obj: Record<string, string | string[]> }}
 */
function parseHeaders(headers) {
  const raw = [];
  const obj = Object.create(null);

  for (const [name, value] of headers.entries()) {
    const key = name.toLowerCase();
    raw.push(name, value);

    if (key === 'set-cookie') {
      // Node preserves multiple Set-Cookie as an array.
      if (Array.isArray(obj[key])) obj[key].push(value);
      else if (obj[key] !== undefined) obj[key] = [obj[key], value];
      else obj[key] = value;
    } else {
      // Node joins duplicates with ', ' (RFC 7230 §3.2.2).
      obj[key] = obj[key] !== undefined ? `${obj[key]}, ${value}` : value;
    }
  }

  return { raw, obj };
}

/**
 * Synthetic socket placeholder — satisfies code that reads
 * `req.socket.remoteAddress` or calls `req.socket.destroy()`.
 * @param {{ remoteAddress?: string; remotePort?: number }} [opts]
 */
function makeSyntheticSocket(opts = {}) {
  return {
    remoteAddress:  opts.remoteAddress ?? '127.0.0.1',
    remotePort:     opts.remotePort    ?? 0,
    localAddress:   '127.0.0.1',
    localPort:      0,
    encrypted:      false,
    destroyed:      false,
    readable:       true,
    writable:       true,
    setKeepAlive:   () => {},
    setNoDelay:     () => {},
    setTimeout:     () => {},
    destroy:        () => {},
    ref:            () => {},
    unref:          () => {},
  };
}

// ---------------------------------------------------------------------------
// IncomingMessage
// ---------------------------------------------------------------------------

/**
 * Node-compatible HTTP incoming message (request or response).
 *
 * When used as a **response** (from `http.request`):
 *   - `statusCode` / `statusMessage` are populated.
 *   - `method` and `url` are empty strings.
 *
 * When used as a **request** (from `http.Server`):
 *   - `method` and `url` are populated.
 *   - `statusCode` is `null`.
 *
 * @extends EventEmitter
 *
 * @example
 * // Response usage (typical)
 * const msg = IncomingMessage.fromResponse(fetchResponse);
 * msg.on('data', chunk => process(chunk));
 * msg.on('end',  ()    => console.log('done'));
 * msg.resume();
 *
 * @example
 * // Manual construction (server-side)
 * const msg = new IncomingMessage(socket);
 * msg._addHeaderLine('content-type', 'application/json');
 * msg.url    = '/api/data';
 * msg.method = 'POST';
 */
export class IncomingMessage extends EventEmitter {
  /**
   * @param {object} [socket] - Synthetic socket placeholder or real net.Socket.
   */
  constructor(socket) {
    super();

    // ── Readable state ───────────────────────────────────────────────────────
    this.readable    = true;
    this.destroyed   = false;
    this._reading    = false;   // true once body streaming has started
    this._paused     = false;
    this._encoding   = null;
    /** @type {Uint8Array[]} queued chunks when paused */
    this._queue      = [];
    /** @type {ReadableStreamDefaultReader | null} */
    this._reader     = null;

    // ── HTTP metadata ────────────────────────────────────────────────────────
    /** @type {number | null} Response status code; null for requests. */
    this.statusCode    = null;
    /** @type {string} */
    this.statusMessage = '';
    /** @type {string} */
    this.httpVersion   = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    /** @type {string} Request method; empty for responses. */
    this.method = '';
    /** @type {string} Request URL; empty for responses. */
    this.url    = '';
    /** @type {boolean} True once all body data has been received. */
    this.complete = false;
    /** @deprecated Node deprecated this in v17 */
    this.aborted = false;

    // ── Headers ───────────────────────────────────────────────────────────────
    /** @type {Record<string, string | string[]>} */
    this.headers    = Object.create(null);
    /** @type {string[]} Flat [name, value, name, value, …] array */
    this.rawHeaders = [];
    /** @type {Record<string, string>} Always empty (trailers not exposed by fetch) */
    this.trailers    = Object.create(null);
    /** @type {string[]} */
    this.rawTrailers = [];

    // ── Socket ────────────────────────────────────────────────────────────────
    this.socket     = socket ?? makeSyntheticSocket();
    /** Alias — Node exposes both `.socket` and `.connection`. */
    this.connection = this.socket;
  }

  // ── Static factory ─────────────────────────────────────────────────────────

  /**
   * Constructs an `IncomingMessage` from a WHATWG `Response` object.
   * This is the primary path used by `_http_client.ClientRequest`.
   *
   * @param {Response} response
   * @param {{ remoteAddress?: string; remotePort?: number }} [socketOpts]
   * @returns {IncomingMessage}
   */
  static fromResponse(response, socketOpts) {
    const msg = new IncomingMessage(makeSyntheticSocket(socketOpts));

    msg.statusCode    = response.status;
    msg.statusMessage = response.statusText;

    const { raw, obj } = parseHeaders(response.headers);
    msg.rawHeaders = raw;
    msg.headers    = obj;

    // Infer HTTP version — fetch doesn't expose the wire version.
    msg.httpVersion      = '1.1';
    msg.httpVersionMajor = 1;
    msg.httpVersionMinor = 1;

    // Attach the response body ReadableStream for streaming.
    if (response.body) {
      msg._reader = response.body.getReader();
    } else {
      // Bodyless responses (204, 304, HEAD) — mark complete immediately.
      msg.complete = true;
      msg.readable = false;
    }

    return msg;
  }

  // ── Internal header management (used by server-side parsers) ───────────────

  /**
   * Adds a single header line to `headers` and `rawHeaders`.
   * Handles duplicate merging per RFC 7230 (join with ', '; Set-Cookie as array).
   *
   * @param {string} field - Header name (will be lowercased).
   * @param {string} value - Header value.
   */
  _addHeaderLine(field, value) {
    const key = field.toLowerCase();
    this.rawHeaders.push(field, value);

    if (_checkInvalidHeaderChar(value)) return; // silently drop invalid values

    if (key === 'set-cookie') {
      if (Array.isArray(this.headers[key])) {
        this.headers[key].push(value);
      } else if (this.headers[key] !== undefined) {
        this.headers[key] = [/** @type {string} */ (this.headers[key]), value];
      } else {
        this.headers[key] = value;
      }
    } else {
      this.headers[key] = this.headers[key] !== undefined
        ? `${this.headers[key]}, ${value}`
        : value;
    }
  }

  /**
   * Bulk-adds raw headers from a flat [name, value, …] array.
   * @param {string[]} pairs
   */
  _addHeaderLines(pairs) {
    for (let i = 0; i < pairs.length; i += 2) {
      this._addHeaderLine(pairs[i], pairs[i + 1]);
    }
  }

  // ── Readable interface ─────────────────────────────────────────────────────

  /**
   * Switches the stream to flowing mode, starting body download.
   * @returns {this}
   */
  resume() {
    this._paused = false;
    if (!this._reading && !this.complete) this._startStreaming();
    this._flushQueue();
    return this;
  }

  /**
   * Pauses the stream — 'data' events stop until `resume()` is called.
   * @returns {this}
   */
  pause() {
    this._paused = true;
    return this;
  }

  /**
   * Reads a single chunk synchronously from the internal queue, or `null`
   * when no data is currently buffered. Calling `read()` without arguments
   * starts the stream.
   * @param {number} [_size] - Ignored (not supported by fetch streams).
   * @returns {Buffer | null}
   */
  read(_size) {
    if (!this._reading) this.resume();
    return this._queue.length ? Buffer.from(this._queue.shift()) : null;
  }

  /**
   * Sets the encoding for 'data' events. When set, chunks are emitted as
   * strings decoded with `TextDecoder(encoding)` instead of `Buffer`s.
   * @param {string} encoding
   * @returns {this}
   */
  setEncoding(encoding) {
    this._encoding = encoding;
    this._decoder  = new TextDecoder(encoding);
    return this;
  }

  /**
   * Destroys the stream, optionally emitting an error.
   * Cancels the underlying fetch body reader.
   * @param {Error} [err]
   * @returns {this}
   */
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable  = false;
    this._reader?.cancel?.().catch(() => {});
    this._reader = null;
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  }

  /**
   * Pipes this message's body into a writable destination.
   * @param {object} dest - Any object with `.write()` and optional `.end()`.
   * @param {{ end?: boolean }} [options]
   * @returns {object} dest
   */
  pipe(dest, options = {}) {
    const endDest = options.end !== false;
    this.on('data', chunk => dest.write?.(chunk));
    this.on('end',  ()    => { if (endDest) dest.end?.(); });
    this.on('error', err  => dest.emit?.('error', err));
    this.resume();
    return dest;
  }

  /**
   * Removes a previously piped destination.
   * @param {object} [_dest]
   * @returns {this}
   */
  unpipe(_dest) {
    this.removeAllListeners('data');
    this.removeAllListeners('end');
    return this;
  }

  /**
   * No-op for Readable parity — always returns `false` (push is internal).
   * @param {any} _chunk
   * @returns {false}
   */
  push(_chunk) { return false; }

  // ── Async iterator ─────────────────────────────────────────────────────────

  /**
   * Async iterator support — enables `for await (const chunk of req) {}`.
   * @returns {AsyncGenerator<Buffer>}
   */
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.destroyed) return;

      if (this._queue.length) {
        yield Buffer.from(this._queue.shift());
        continue;
      }

      if (this.complete) return;

      yield await new Promise((resolve, reject) => {
        this.once('data',  resolve);
        this.once('end',   () => resolve(null));
        this.once('error', reject);
        if (!this._reading) this.resume();
      }).then(chunk => {
        if (chunk === null) return null;
        return chunk;
      });

      if (this.complete && !this._queue.length) return;
    }
  }

  // ── Auto-resume on first 'data' listener ──────────────────────────────────

  on(event, listener) {
    super.on(event, listener);
    if (event === 'data' && !this._reading && !this.complete) this.resume();
    return this;
  }

  // ── Internal streaming engine ──────────────────────────────────────────────

  async _startStreaming() {
    if (this._reading) return;
    this._reading = true;

    if (!this._reader) {
      // No body (bodyless response or already consumed).
      this.complete = true;
      this.readable = false;
      this.emit('end');
      this.emit('close');
      return;
    }

    try {
      while (true) {
        const { done, value } = await this._reader.read();

        if (done) {
          this.complete = true;
          this.readable = false;
          this._flushQueue();
          this.emit('end');
          this.emit('close');
          return;
        }

        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);

        if (this._paused) {
          this._queue.push(chunk);
        } else {
          this._emitChunk(chunk);
        }
      }
    } catch (err) {
      if (!this.destroyed) this.destroy(err);
    }
  }

  /** Drains buffered chunks after `resume()`. */
  _flushQueue() {
    while (!this._paused && this._queue.length) {
      this._emitChunk(this._queue.shift());
    }
  }

  /**
   * Emits a single chunk, applying encoding if set.
   * @param {Uint8Array} chunk
   */
  _emitChunk(chunk) {
    if (this._encoding && this._decoder) {
      this.emit('data', this._decoder.decode(chunk, { stream: true }));
    } else {
      this.emit('data', Buffer.from(chunk));
    }
  }

  // ── Convenience accessors ─────────────────────────────────────────────────

  get remoteAddress() { return this.socket.remoteAddress; }
  get remotePort()    { return this.socket.remotePort; }
  get localAddress()  { return this.socket.localAddress; }
  get localPort()     { return this.socket.localPort; }
}

export default { IncomingMessage };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { IncomingMessage } from './_http_incoming';
//
// // ── From a fetch() Response (ClientRequest path) ──────────────────────────
// const response = await fetch('https://jsonplaceholder.typicode.com/todos/1');
// const msg = IncomingMessage.fromResponse(response);
//
// console.log(msg.statusCode);    // 200
// console.log(msg.statusMessage); // 'OK'
// console.log(msg.headers['content-type']); // 'application/json; charset=utf-8'
//
// // Event-based consumption
// const chunks = [];
// msg.on('data', chunk => chunks.push(chunk));
// msg.on('end',  ()    => console.log(Buffer.concat(chunks).toString()));
//
// // ── setEncoding — emit strings instead of Buffers ─────────────────────────
// const msg2 = IncomingMessage.fromResponse(await fetch('https://example.com'));
// msg2.setEncoding('utf-8');
// msg2.on('data', str => console.log(typeof str)); // 'string'
// msg2.resume();
//
// // ── Async iterator ────────────────────────────────────────────────────────
// const msg3 = IncomingMessage.fromResponse(await fetch('https://example.com'));
// for await (const chunk of msg3) {
//   console.log(chunk.length); // Buffer
// }
//
// // ── pause() / resume() ────────────────────────────────────────────────────
// const msg4 = IncomingMessage.fromResponse(await fetch('https://example.com'));
// msg4.on('data', chunk => {
//   msg4.pause();
//   setTimeout(() => msg4.resume(), 100); // back-pressure simulation
// });
// msg4.resume();
//
// // ── pipe() ────────────────────────────────────────────────────────────────
// const writable = { write: c => process.stdout.write(c), end: () => {} };
// IncomingMessage.fromResponse(await fetch('https://example.com')).pipe(writable);
//
// // ── Server-side manual construction ───────────────────────────────────────
// const req = new IncomingMessage();
// req.method = 'POST';
// req.url    = '/api/data';
// req._addHeaderLine('Content-Type',   'application/json');
// req._addHeaderLine('Content-Length', '42');
// req._addHeaderLine('Set-Cookie',     'a=1');
// req._addHeaderLine('Set-Cookie',     'b=2');
// console.log(req.headers['set-cookie']); // ['a=1', 'b=2']
// console.log(req.rawHeaders);            // ['Content-Type','application/json',…]
//
// // ── destroy() ────────────────────────────────────────────────────────────
// const msg5 = IncomingMessage.fromResponse(await fetch('https://example.com'));
// msg5.on('error', e => console.log(e.message));
// msg5.destroy(new Error('aborted'));
