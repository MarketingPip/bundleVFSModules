// npm install events

/*!
 * _http_client-web — node:_http_client for browsers & bundlers
 * MIT License.
 * Node.js parity: node:_http_client @ Node 0.1.90+ (internal, stable surface)
 * Dependencies: events
 * Limitations:
 *   - Backed by fetch() — no raw TCP socket, no upgrade/connect tunnelling.
 *   - socket / connection events fire with a synthetic placeholder, not a real net.Socket.
 *   - pipe() on the response is not supported (use 'data' events or async iteration).
 *   - HTTP trailers are not accessible (not exposed by fetch).
 *   - agent.addRequest() / agent.removeSocket() are called for lifecycle parity but
 *     have no effect on actual connection reuse (browser controls that).
 *   - maxHeaderSize / insecureHTTPParser options are silently ignored.
 *   - AbortController-based timeout replaces Node's socket-timeout mechanism.
 */

/**
 * @packageDocumentation
 * Browser-compatible `ClientRequest` that mirrors the Node.js `http.ClientRequest`
 * class, backed by the Fetch API.
 *
 * Emits the full Node event sequence:
 *   socket → connect → response → finish → close
 *
 * The `response` event carries an `IncomingMessage`-shaped object with:
 *   statusCode, statusMessage, headers, httpVersion, readable stream interface.
 */

import EventEmitter from 'events';
import { globalAgent } from './_http_agent';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const _noop = () => {};

/**
 * Converts a `Headers` object to a plain Node-style headers object.
 * All header names are lower-cased; Set-Cookie is preserved as an array.
 * @param {Headers} headers
 * @returns {Record<string, string | string[]>}
 */
function headersToObject(headers) {
  const out = Object.create(null);
  for (const [k, v] of headers.entries()) {
    const key = k.toLowerCase();
    if (key === 'set-cookie') {
      out[key] = out[key] ? [...(Array.isArray(out[key]) ? out[key] : [out[key]]), v] : [v];
    } else {
      out[key] = v;
    }
  }
  return out;
}

/**
 * Parses the HTTP version string from a Response.
 * fetch() doesn't expose the wire version, so we default to '1.1'.
 * @returns {string}
 */
function httpVersion(/* response */) { return '1.1'; }

// ---------------------------------------------------------------------------
// IncomingMessage — response object emitted on ClientRequest's 'response' event
// ---------------------------------------------------------------------------

/**
 * Minimal `http.IncomingMessage`-compatible response object.
 * Extends EventEmitter and implements the Readable duck-type interface
 * (on('data'), on('end'), resume(), destroy(), pipe() stub).
 */
class IncomingMessage extends EventEmitter {
  /**
   * @param {Response} fetchResponse
   */
  constructor(fetchResponse) {
    super();

    this.statusCode    = fetchResponse.status;
    this.statusMessage = fetchResponse.statusText;
    this.headers       = headersToObject(fetchResponse.headers);
    this.rawHeaders    = [...fetchResponse.headers.entries()].flat();
    this.httpVersion   = httpVersion();
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete      = false;
    this.readable      = true;
    this.destroyed     = false;
    this.trailers      = {};
    this.rawTrailers   = [];
    this.url           = '';

    this._body = fetchResponse.body;
    this._reading = false;
  }

  // ── Readable interface ────────────────────────────────────────────────────

  /**
   * Begins streaming the response body, emitting 'data' and 'end' events.
   * Called automatically when a 'data' listener is added.
   */
  resume() {
    if (this._reading || !this._body) return this;
    this._reading = true;
    this._stream();
    return this;
  }

  async _stream() {
    const reader = this._body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.emit('data', Buffer.from(value));
      }
      this.complete = true;
      this.readable = false;
      this.emit('end');
      this.emit('close');
    } catch (err) {
      this.destroy(err);
    } finally {
      reader.releaseLock();
    }
  }

  /** @param {string} enc @returns {this} */
  setEncoding(enc) {
    // Stored but not applied — data events always emit Buffers.
    this._encoding = enc;
    return this;
  }

  /** @param {Error} [err] */
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable  = false;
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  }

  /** Pipe stub — redirects consumers to event-based streaming. */
  pipe(dest) {
    this.on('data', chunk => dest.write?.(chunk));
    this.on('end',  ()    => dest.end?.());
    this.resume();
    return dest;
  }

  // Auto-resume when 'data' listener is attached.
  on(event, listener) {
    super.on(event, listener);
    if (event === 'data' && !this._reading) this.resume();
    return this;
  }
}

// ---------------------------------------------------------------------------
// ClientRequest
// ---------------------------------------------------------------------------

/**
 * Browser-compatible `http.ClientRequest`.
 * Mirrors the Node.js class: writable stream interface + EventEmitter,
 * backed by the Fetch API.
 *
 * @extends EventEmitter
 *
 * @example
 * const req = new ClientRequest('https://example.com/api', {
 *   method: 'POST',
 *   headers: { 'content-type': 'application/json' },
 * });
 * req.on('response', res => {
 *   res.on('data', chunk => console.log(chunk.toString()));
 *   res.on('end',  ()    => console.log('done'));
 * });
 * req.write(JSON.stringify({ hello: 'world' }));
 * req.end();
 */
export class ClientRequest extends EventEmitter {
  /**
   * @param {string | URL | {
   *   protocol?: string; host?: string; hostname?: string; port?: number | string;
   *   path?: string;     method?: string;  headers?: Record<string, string | string[]>;
   *   agent?: object;    timeout?: number; auth?: string;
   * }} input
   * @param {{
   *   method?:   string;
   *   headers?:  Record<string, string | string[]>;
   *   agent?:    object | false;
   *   timeout?:  number;
   *   auth?:     string;
   * }} [options]
   * @param {(res: IncomingMessage) => void} [callback]
   */
  constructor(input, options = {}, callback) {
    super();

    // Normalise overloads: (url, cb) or (url, options, cb)
    if (typeof options === 'function') { callback = options; options = {}; }
    if (callback) this.once('response', callback);

    // ── Build URL ───────────────────────────────────────────────────────────
    let url;
    if (typeof input === 'string' || input instanceof URL) {
      url = new URL(input);
    } else {
      // options-object form (used internally by http.request())
      const opts  = input;
      const proto = opts.protocol ?? 'http:';
      const host  = opts.hostname ?? opts.host ?? 'localhost';
      const port  = opts.port ? `:${opts.port}` : '';
      const path  = opts.path ?? '/';
      url = new URL(`${proto}//${host}${port}${path}`);
      options = { ...opts, ...options };
    }

    this.url    = url;
    this.method = (options.method ?? 'GET').toUpperCase();
    this.path   = url.pathname + url.search;

    // ── Headers ─────────────────────────────────────────────────────────────
    this._headers = new Headers();
    const inHeaders = options.headers ?? {};
    for (const [k, v] of Object.entries(inHeaders)) {
      const vals = Array.isArray(v) ? v : [v];
      for (const val of vals) this._headers.append(k, val);
    }

    // Basic auth via options.auth → Authorization header
    if (options.auth && !this._headers.has('Authorization')) {
      this._headers.set('Authorization', 'Basic ' + btoa(options.auth));
    }

    // ── Agent ────────────────────────────────────────────────────────────────
    this.agent = options.agent === false ? null : (options.agent ?? globalAgent);

    // ── Timeout ──────────────────────────────────────────────────────────────
    this._timeout     = options.timeout ?? 0;
    this._timeoutId   = null;
    this._ac          = new AbortController();

    // ── Body accumulator ─────────────────────────────────────────────────────
    /** @type {Uint8Array[]} */
    this._chunks    = [];
    this._finished  = false;
    this._aborted   = false;
    this.destroyed  = false;
    this.writable   = true;

    // ── Synthetic socket placeholder ─────────────────────────────────────────
    // Emitted synchronously (next microtask) to match Node's behaviour where
    // 'socket' fires before 'connect'.
    this._socket = {
      _agentKey:      this.agent?.getName?.({ host: url.hostname, port: url.port }) ?? '',
      remoteAddress:  url.hostname,
      remotePort:     Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      destroyed:      false,
      setKeepAlive:   _noop,
      setNoDelay:     _noop,
      setTimeout:     _noop,
      ref:            _noop,
      unref:          _noop,
    };

    queueMicrotask(() => {
      if (this._aborted) return;
      this.emit('socket', this._socket);
      this.emit('connect');
      // Inform agent of new request slot.
      this.agent?.addRequest?.(this, {
        host: url.hostname,
        port: url.port,
        path: this.path,
      });
    });
  }

  // ── Writable interface ────────────────────────────────────────────────────

  /**
   * Appends a chunk to the request body.
   * @param {string | Buffer | Uint8Array} chunk
   * @param {string | Function} [encoding]
   * @param {Function} [callback]
   * @returns {boolean}
   */
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = 'utf8'; }
    if (this._finished) throw new Error('write after end');
    if (typeof chunk === 'string') {
      this._chunks.push(new TextEncoder().encode(chunk));
    } else if (chunk instanceof Uint8Array) {
      this._chunks.push(chunk);
    } else if (chunk) {
      this._chunks.push(new Uint8Array(chunk));
    }
    callback?.();
    return true;
  }

  /**
   * Finalises the request and initiates the fetch.
   * @param {string | Buffer | Uint8Array} [chunk]
   * @param {string | Function} [encoding]
   * @param {Function} [callback]
   */
  end(chunk, encoding, callback) {
    if (typeof chunk === 'function')    { callback = chunk; chunk = null; encoding = null; }
    if (typeof encoding === 'function') { callback = encoding; encoding = null; }
    if (chunk) this.write(chunk, encoding ?? 'utf8');
    if (callback) this.once('finish', callback);
    this._finished = true;
    this.writable  = false;
    this._send();
    return this;
  }

  // ── Core fetch dispatch ───────────────────────────────────────────────────

  async _send() {
    if (this._aborted) return;

    // Assemble body
    let body = null;
    if (this._chunks.length) {
      const total = this._chunks.reduce((n, c) => n + c.length, 0);
      const buf   = new Uint8Array(total);
      let offset  = 0;
      for (const chunk of this._chunks) { buf.set(chunk, offset); offset += chunk.length; }
      body = buf;
      // Set Content-Length if not already set
      if (!this._headers.has('content-length'))
        this._headers.set('content-length', String(total));
    }

    // Timeout
    if (this._timeout > 0) {
      this._timeoutId = setTimeout(() => {
        this._ac.abort();
        const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        this.emit('timeout');
        this.emit('error', err);
      }, this._timeout);
    }

    try {
      const fetchOptions = {
        method:  this.method,
        headers: this._headers,
        signal:  this._ac.signal,
        // Only attach body for methods that carry one
        ...(body && !['GET','HEAD','OPTIONS'].includes(this.method) ? { body } : {}),
      };

      const fetchRes = await fetch(this.url.toString(), fetchOptions);
      clearTimeout(this._timeoutId);

      const res = new IncomingMessage(fetchRes);
      this.emit('finish');
      this.emit('response', res);

      // Release agent socket slot after response headers arrive
      this.agent?.removeSocket?.(this._socket, {
        host: this.url.hostname,
        port: this.url.port,
        path: this.path,
      });
    } catch (err) {
      clearTimeout(this._timeoutId);
      if (this._aborted) return;
      this.destroyed = true;
      this._socket.destroyed = true;
      this.emit('error', Object.assign(err, { code: err.name === 'AbortError' ? 'ECONNRESET' : 'ECONNREFUSED' }));
      this.emit('close');
    }
  }

  // ── Abort / destroy ───────────────────────────────────────────────────────

  /**
   * Aborts the in-flight request. Deprecated in Node (use `destroy()`).
   * @deprecated use destroy()
   */
  abort() {
    if (this._aborted) return;
    this._aborted = true;
    this.destroyed = true;
    this._ac.abort();
    this.emit('abort');
    this.emit('close');
  }

  /** @param {Error} [err] @returns {this} */
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._aborted  = true;
    clearTimeout(this._timeoutId);
    this._ac.abort();
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  }

  // ── Headers API ──────────────────────────────────────────────────────────

  /**
   * @param {string} name
   * @param {string | string[]} value
   * @returns {this}
   */
  setHeader(name, value) {
    if (this._finished) throw new Error('Cannot set headers after they are sent');
    const vals = Array.isArray(value) ? value : [value];
    this._headers.delete(name);
    for (const v of vals) this._headers.append(name, v);
    return this;
  }

  /** @param {string} name @returns {string | undefined} */
  getHeader(name) {
    return this._headers.get(name) ?? undefined;
  }

  /** @param {string} name @returns {string[]} */
  getHeaderNames() { return [...this._headers.keys()]; }

  /** @returns {Record<string, string>} */
  getHeaders() {
    const out = Object.create(null);
    for (const [k, v] of this._headers.entries()) out[k] = v;
    return out;
  }

  /** @param {string} name @returns {boolean} */
  hasHeader(name) { return this._headers.has(name); }

  /** @param {string} name @returns {this} */
  removeHeader(name) {
    if (this._finished) throw new Error('Cannot remove headers after they are sent');
    this._headers.delete(name);
    return this;
  }

  // ── Misc Node API stubs ───────────────────────────────────────────────────

  /**
   * Sets the socket timeout. Fires 'timeout' event and aborts via AbortController.
   * @param {number} ms
   * @param {Function} [cb]
   * @returns {this}
   */
  setTimeout(ms, cb) {
    this._timeout = ms;
    if (cb) this.once('timeout', cb);
    return this;
  }

  /** No-op in browsers — no raw socket to configure. @returns {this} */
  setNoDelay()    { return this; }
  /** No-op in browsers. @returns {this} */
  setSocketKeepAlive() { return this; }
  /** No-op — flushAllowed headers already set. @returns {this} */
  flushHeaders()  { return this; }
}

export default { ClientRequest };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { ClientRequest } from './_http_client';
//
// // ── GET request ───────────────────────────────────────────────────────────
// const req = new ClientRequest('https://jsonplaceholder.typicode.com/todos/1');
// req.on('response', res => {
//   console.log(res.statusCode, res.headers['content-type']);
//   const chunks = [];
//   res.on('data', c => chunks.push(c));
//   res.on('end',  () => console.log(JSON.parse(Buffer.concat(chunks).toString())));
// });
// req.on('error', err => console.error(err));
// req.end();
//
// // ── POST with body ────────────────────────────────────────────────────────
// const post = new ClientRequest('https://httpbin.org/post', {
//   method: 'POST',
//   headers: { 'content-type': 'application/json' },
// });
// post.on('response', res => { res.resume(); });
// post.write(JSON.stringify({ hello: 'world' }));
// post.end();
//
// // ── Response callback shorthand ───────────────────────────────────────────
// const req2 = new ClientRequest('https://example.com', {}, res => {
//   console.log(res.statusCode); // 200
//   res.resume(); // drain to trigger 'end'
// });
// req2.end();
//
// // ── Timeout ───────────────────────────────────────────────────────────────
// const slow = new ClientRequest('https://example.com', { timeout: 100 });
// slow.on('timeout', () => console.log('timed out'));
// slow.on('error',   e => console.log(e.code)); // 'ECONNRESET'
// slow.end();
//
// // ── Headers API ───────────────────────────────────────────────────────────
// const req3 = new ClientRequest('https://example.com');
// req3.setHeader('x-custom', 'value');
// console.log(req3.getHeader('x-custom')); // 'value'
// console.log(req3.hasHeader('x-custom')); // true
// req3.removeHeader('x-custom');
// req3.end();
//
// // ── destroy() ────────────────────────────────────────────────────────────
// const req4 = new ClientRequest('https://example.com');
// req4.destroy(new Error('cancelled'));
// req4.on('error', e => console.log(e.message)); // 'cancelled'
//
// // ── Options-object form (as used by http.request internally) ─────────────
// const req5 = new ClientRequest({
//   protocol: 'https:', hostname: 'api.example.com',
//   port: 443, path: '/v1/data', method: 'GET',
// });
// req5.end();
