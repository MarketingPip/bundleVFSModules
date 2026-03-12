// npm install readable-stream events buffer stream-http

/*!
 * http-outgoing-web — node:http OutgoingMessage surface for browsers & bundlers
 * MIT License. Adapted from Node.js (MIT, Joyent/contributors) and
 * Cloudflare Workers runtime (Apache-2.0, Cloudflare, Inc.)
 * Node.js parity: node:http @ Node 0.1.90+  (_http_outgoing.js)
 * Dependencies: readable-stream, events, buffer, stream-http
 * Limitations: No real TCP socket. chunkedEncoding and trailer headers are
 *   stubs. stream-http handles the actual XHR transport layer separately.
 *   OutgoingMessage.socket is a no-op shim object.
 */

/**
 * @packageDocumentation
 * Browser/bundler-compatible implementation of the `node:http` outgoing-message
 * surface: `validateHeaderName`, `validateHeaderValue`, `OutgoingMessage`, and
 * associated well-known symbols / constants.
 *
 * This module mirrors the exports of Cloudflare Workers'
 * `node-internal:internal_http` + `node-internal:internal_http_outgoing`,
 * making it usable anywhere the browserify/Vite/Rollup ecosystem runs.
 *
 * Pair with `stream-http` for a complete `http.request()` / `http.get()` shim.
 */

import { Writable } from 'readable-stream';
import EventEmitter  from 'events';
import { Buffer }    from 'buffer';

// ─── Well-known Symbols & Constants ────────────────────────────────────────

/**
 * Symbol key used to store the unique-headers set on an OutgoingMessage.
 * Matches Node's `Symbol(kUniqueHeaders)` internal slot.
 * @type {symbol}
 */
export const kUniqueHeaders = Symbol('kUniqueHeaders');

/**
 * Default high-water mark for OutgoingMessage's internal Writable buffer.
 * Matches Node's _http_outgoing.js value of 16 KiB.
 * @type {number}
 */
export const kHighWaterMark = 16 * 1024; // 16384

// ─── Header Name / Value Validation ────────────────────────────────────────

/**
 * RFC 7230 §3.2.6 token production:
 * token = 1*tchar
 * tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
 *         "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
 *
 * We test the *inverse*: any char outside this set is invalid.
 */
const INVALID_TOKEN_RE = /[^\^_`a-zA-Z\-0-9!#$%&'*+.|~]/;

/**
 * Validates an HTTP header field name per RFC 7230 §3.2 and WHATWG Fetch.
 *
 * @param {string} name - The header field name to validate.
 * @param {string} [label='Header name'] - Label used in the error message.
 * @returns {void}
 * @throws {TypeError} If `name` is not a valid HTTP token.
 *
 * @example
 * validateHeaderName('Content-Type'); // ok
 * validateHeaderName('bad header');   // throws TypeError [ERR_INVALID_HTTP_TOKEN]
 */
export function validateHeaderName(name, label = 'Header name') {
  if (typeof name !== 'string' || name.length === 0 || INVALID_TOKEN_RE.test(name)) {
    const err = new TypeError(
      `${label} must be a valid HTTP token ["${name}"]`
    );
    err.code = 'ERR_INVALID_HTTP_TOKEN';
    throw err;
  }
}

/**
 * Validates an HTTP header field value per RFC 7230 §3.2.
 * Rejects values containing CR, LF, or NUL characters (header injection).
 *
 * @param {string} name  - The header name (used in error messages only).
 * @param {string|string[]} value - The header value(s) to validate.
 * @returns {void}
 * @throws {TypeError} If `value` contains forbidden characters.
 *
 * @example
 * validateHeaderValue('X-Foo', 'bar');         // ok
 * validateHeaderValue('X-Foo', 'bar\r\nbaz'); // throws TypeError [ERR_INVALID_CHAR]
 */
export function validateHeaderValue(name, value) {
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v !== 'string' && typeof v !== 'number') {
      const err = new TypeError(
        `Invalid value "${v}" for header "${name}"`
      );
      err.code = 'ERR_HTTP_INVALID_HEADER_VALUE';
      throw err;
    }
    const s = String(v);
    // Reject CR (\r), LF (\n), NUL (\0) — header-injection vectors
    if (/[\r\n\0]/.test(s)) {
      const err = new TypeError(
        `Invalid character in header content ["${name}"]`
      );
      err.code = 'ERR_INVALID_CHAR';
      throw err;
    }
  }
}

// ─── Unique-Headers Option Parser ──────────────────────────────────────────

/**
 * Parses the `uniqueHeaders` option accepted by `http.request()` options.
 * Returns a `Set<string>` of lowercased header names that must not be joined,
 * or `null` if the option was not provided.
 *
 * @param {string[]|null|undefined} value
 * @returns {Set<string>|null}
 * @throws {TypeError} If `value` is not an Array or null/undefined.
 *
 * @example
 * parseUniqueHeadersOption(['Content-Type', 'Authorization'])
 * // → Set { 'content-type', 'authorization' }
 */
export function parseUniqueHeadersOption(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new TypeError(
      'The "options.uniqueHeaders" property must be an Array or null/undefined.'
    );
  }
  const set = new Set();
  for (const h of value) {
    if (typeof h !== 'string') throw new TypeError(`uniqueHeaders entries must be strings, got ${typeof h}`);
    set.add(h.toLowerCase());
  }
  return set.size > 0 ? set : null;
}

// ─── OutgoingMessage ───────────────────────────────────────────────────────

/**
 * No-op socket shim. Replaces the real TCP socket that Node's OutgoingMessage
 * holds. Exposes the minimum surface consumed by higher-level code.
 * @type {object}
 */
const NOOP_SOCKET = Object.freeze(
  Object.assign(Object.create(EventEmitter.prototype), {
    writable: true,
    readable: false,
    encrypted: false,
    setTimeout() { return this; },
    setKeepAlive() { return this; },
    setNoDelay() { return this; },
    destroy() {},
    end() {},
    ref() { return this; },
    unref() { return this; },
  })
);

/**
 * Browser-compatible implementation of Node's `http.OutgoingMessage`.
 *
 * Extends `readable-stream`'s `Writable` so it can participate in pipe chains
 * and back-pressure. The actual network transport is handled externally
 * (e.g. by `stream-http`'s `ClientRequest`).
 *
 * @extends {Writable}
 *
 * @example
 * const msg = new OutgoingMessage();
 * msg.setHeader('Content-Type', 'application/json');
 * msg.setHeader('X-Request-ID', 'abc123');
 * msg.write(JSON.stringify({ ok: true }));
 * msg.end();
 */
export class OutgoingMessage extends Writable {
  constructor() {
    super({ highWaterMark: kHighWaterMark });

    /** @type {boolean} Whether the response headers have been sent. */
    this.headersSent = false;

    /** @type {boolean} Whether the message body is finished. */
    this.finished = false;

    /** @type {boolean} Whether the message should use chunked transfer encoding. */
    this.chunkedEncoding = false;

    /** @type {boolean} Whether to send Date header automatically. */
    this.sendDate = true;

    /**
     * Underlying socket shim (no real TCP in browser).
     * @type {object}
     */
    this.socket = NOOP_SOCKET;

    /**
     * @private
     * Internal ordered header store: Map<lowercaseName, [originalName, value[]]>
     * @type {Map<string, [string, string[]]>}
     */
    this._headers = new Map();

    /**
     * @private
     * Names of headers that must not be combined into a single value.
     * Populated from `parseUniqueHeadersOption`.
     * @type {Set<string>|null}
     */
    this[kUniqueHeaders] = null;

    /** @private Collected output chunks before flush. @type {Buffer[]} */
    this._chunks = [];

    /** @private Signal from .destroy() / abort. @type {AbortController} */
    this._ac = new AbortController();
  }

  // ── Header API ────────────────────────────────────────────────────────────

  /**
   * Sets a single header. Replaces any previously set value for `name`.
   *
   * @param {string} name
   * @param {string|number|string[]} value
   * @returns {this}
   * @throws {TypeError} on invalid name or value.
   */
  setHeader(name, value) {
    if (this.headersSent) throw new Error('Cannot set headers after they are sent.');
    validateHeaderName(name);
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    validateHeaderValue(name, values);
    this._headers.set(name.toLowerCase(), [name, values]);
    return this;
  }

  /**
   * Returns the value of a previously set header, or `undefined`.
   *
   * @param {string} name
   * @returns {string|string[]|undefined}
   */
  getHeader(name) {
    validateHeaderName(name);
    const entry = this._headers.get(name.toLowerCase());
    if (!entry) return undefined;
    const [, vals] = entry;
    return vals.length === 1 ? vals[0] : vals;
  }

  /**
   * Returns an array of names of the currently set outgoing headers.
   * @returns {string[]}
   */
  getHeaderNames() {
    return [...this._headers.values()].map(([n]) => n);
  }

  /**
   * Returns a shallow copy of the current outgoing headers as a plain object.
   * Values that are single-element arrays are unwrapped to a plain string.
   *
   * @returns {Record<string, string|string[]>}
   */
  getHeaders() {
    /** @type {Record<string, string|string[]>} */
    const out = Object.create(null);
    for (const [, [name, vals]] of this._headers) {
      out[name] = vals.length === 1 ? vals[0] : vals;
    }
    return out;
  }

  /**
   * Returns `true` if the named header has been set.
   * @param {string} name
   * @returns {boolean}
   */
  hasHeader(name) {
    validateHeaderName(name);
    return this._headers.has(name.toLowerCase());
  }

  /**
   * Removes a header from the outgoing headers map.
   * @param {string} name
   * @returns {this}
   */
  removeHeader(name) {
    if (this.headersSent) throw new Error('Cannot remove headers after they are sent.');
    validateHeaderName(name);
    this._headers.delete(name.toLowerCase());
    return this;
  }

  /**
   * Appends an additional header value for `name` instead of replacing it.
   * Creates the header entry if it does not exist.
   *
   * @param {string} name
   * @param {string|string[]} value
   * @returns {this}
   */
  appendHeader(name, value) {
    if (this.headersSent) throw new Error('Cannot append headers after they are sent.');
    validateHeaderName(name);
    const key  = name.toLowerCase();
    const vals = Array.isArray(value) ? value.map(String) : [String(value)];
    validateHeaderValue(name, vals);
    const existing = this._headers.get(key);
    if (existing) existing[1].push(...vals);
    else this._headers.set(key, [name, vals]);
    return this;
  }

  // ── Flush / Serialization ─────────────────────────────────────────────────

  /**
   * Marks headers as sent (idempotent). Called by the transport layer
   * (e.g. `ClientRequest`) before writing the header block to the wire.
   * @returns {void}
   */
  flushHeaders() {
    this.headersSent = true;
  }

  /**
   * Serializes headers to a flat `[name, value][]` array suitable for Fetch /
   * XHR header-setting loops, honoring unique-header semantics.
   *
   * @returns {[string, string][]}
   */
  _serializeHeaders() {
    /** @type {[string, string][]} */
    const out = [];
    const unique = this[kUniqueHeaders];
    for (const [key, [name, vals]] of this._headers) {
      if (unique && unique.has(key)) {
        // must not be joined — emit one entry per value
        for (const v of vals) out.push([name, v]);
      } else {
        out.push([name, vals.join(', ')]);
      }
    }
    return out;
  }

  // ── Writable internals ────────────────────────────────────────────────────

  /**
   * @param {Buffer|string} chunk
   * @param {BufferEncoding} _encoding
   * @param {(err?: Error|null) => void} callback
   */
  _write(chunk, _encoding, callback) {
    if (this._ac.signal.aborted) {
      return callback(new Error('OutgoingMessage was destroyed before write completed.'));
    }
    if (!this.headersSent) this.flushHeaders();
    this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, _encoding));
    callback();
  }

  /**
   * Called when `end()` has been called and all writes have flushed.
   * Emits `'finish'` via the Writable contract. Sets `this.finished = true`.
   * @param {(err?: Error|null) => void} callback
   */
  _final(callback) {
    this.finished = true;
    this.emit('prefinish');
    callback();
  }

  /**
   * Destroys the message (e.g. on abort), cancelling any pending write.
   * @param {Error|null} err
   * @param {(err?: Error|null) => void} callback
   */
  _destroy(err, callback) {
    this._ac.abort();
    this._chunks = [];
    callback(err);
  }

  /**
   * Returns all buffered body chunks as a single concatenated `Buffer`.
   * Typically called by the transport layer after `'finish'` fires.
   * @returns {Buffer}
   */
  _getBody() {
    return this._chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this._chunks);
  }
}

// ─── Default export (mirrors Cloudflare's module shape) ────────────────────

export default {
  validateHeaderName,
  validateHeaderValue,
  kUniqueHeaders,
  kHighWaterMark,
  parseUniqueHeadersOption,
  OutgoingMessage,
};

// --- Usage ---
//
// // 1. Basic header manipulation
// import { OutgoingMessage, parseUniqueHeadersOption } from './http-outgoing-web.js'
//
// const msg = new OutgoingMessage()
// msg[kUniqueHeaders] = parseUniqueHeadersOption(['Set-Cookie'])
// msg.setHeader('Content-Type', 'application/json; charset=utf-8')
// msg.appendHeader('Set-Cookie', 'a=1; Path=/')
// msg.appendHeader('Set-Cookie', 'b=2; Path=/')
// msg.write('{"ok":true}')
// msg.end()
// msg.on('finish', () => {
//   console.log(msg._serializeHeaders())
//   // → [['Content-Type','application/json; charset=utf-8'],
//   //    ['Set-Cookie','a=1; Path=/'], ['Set-Cookie','b=2; Path=/']]
//   console.log(msg._getBody().toString())  // → '{"ok":true}'
// })
//
// // 2. Validate headers before sending (standalone utility)
// import { validateHeaderName, validateHeaderValue } from './http-outgoing-web.js'
// validateHeaderName('X-Custom-Token')      // ok
// validateHeaderValue('X-Custom-Token', 'abc\r\nX-Injected: evil')  // throws ERR_INVALID_CHAR
//
// // 3. Edge case — writing after destroy (abort simulation)
// const m = new OutgoingMessage()
// m.destroy(new Error('Request aborted'))
// m.write('late data', err => console.error(err?.message))
// // → 'OutgoingMessage was destroyed before write completed.'
