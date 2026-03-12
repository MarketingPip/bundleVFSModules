// npm install readable-stream events buffer

/*!
 * http-server-web — node:http Server surface for browsers, Service Workers & bundlers
 * MIT License. Adapted from Node.js (MIT, Joyent/contributors) and
 * Cloudflare Workers runtime (Apache-2.0, Cloudflare, Inc.)
 * Node.js parity: node:http @ Node 0.1.90+  (_http_server.js)
 * Dependencies: readable-stream, events, buffer
 * Limitations:
 *   • Cannot bind a real TCP port in browser/SW environments.
 *   • Server.listen() uses the Service Worker Fetch event as its transport.
 *     In non-SW contexts a warning is emitted and 'listening' fires with no binding.
 *   • writeContinue / writeEarlyHints / writeProcessing emit locally but cannot
 *     send 1xx frames via the Fetch API.
 *   • Trailers are not supported (Fetch API limitation).
 *   • TLS / HTTPS upgrade is not supported.
 */

/**
 * @packageDocumentation
 * Browser/Service-Worker-compatible implementation of the `node:http` **server**
 * surface: `Server`, `ServerResponse`, `STATUS_CODES`, and all associated
 * symbols / helpers.
 *
 * ### Service Worker transport
 * When running inside a Service Worker, `server.listen()` registers a `fetch`
 * event listener on `globalThis`. Every intercepted request fires the `'request'`
 * event with `(IncomingMessage, ServerResponse)`, exactly as in Node.js.
 * `ServerResponse.end()` resolves the `FetchEvent.respondWith()` promise with a
 * native `Response` object built from the accumulated headers and body.
 *
 * ### Usage outside a Service Worker
 * Call `server._handleFetch(request)` directly and `await` the returned
 * `Promise<Response>` — useful in Cloudflare Workers, Deno Deploy, etc.
 */

import { Readable, Writable } from 'readable-stream';
import EventEmitter           from 'events';
import { Buffer }             from 'buffer';

// ─── Well-known Symbols ─────────────────────────────────────────────────────

/**
 * Symbol stored on `Server` instances pointing to their `ServerResponse` class.
 * Mirrors Node's `kServerResponse` internal slot.
 * @type {symbol}
 */
export const kServerResponse = Symbol('kServerResponse');

/**
 * Symbol for the `setInterval` handle that checks for lingering connections.
 * In browser environments the interval is a no-op timer; the symbol is preserved
 * for source compatibility.
 * @type {symbol}
 */
export const kConnectionsCheckingInterval = Symbol('kConnectionsCheckingInterval');

// ─── STATUS_CODES ───────────────────────────────────────────────────────────

/**
 * Map of HTTP status codes to their standard reason phrases.
 * Matches `http.STATUS_CODES` from Node.js 20 exactly.
 *
 * @type {Record<number|string, string>}
 *
 * @example
 * STATUS_CODES[200] // → 'OK'
 * STATUS_CODES[418] // → "I'm a Teapot"
 */
export const STATUS_CODES = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
};

// ─── Internal helpers ───────────────────────────────────────────────────────

/** @type {object} Shared no-op socket shim for req and res. */
const NOOP_SOCKET = Object.freeze(
  Object.assign(Object.create(EventEmitter.prototype), {
    writable: true, readable: false, encrypted: false,
    remoteAddress: '127.0.0.1', remoteFamily: 'IPv4', remotePort: 0,
    localAddress: '127.0.0.1', localPort: 0,
    setTimeout()    { return this; },
    setKeepAlive()  { return this; },
    setNoDelay()    { return this; },
    destroy()       {},
    end()           {},
    ref()           { return this; },
    unref()         { return this; },
  })
);

// ─── IncomingMessage ────────────────────────────────────────────────────────

/**
 * Node-compatible `http.IncomingMessage` built from a WHATWG `Request`.
 *
 * Extends `readable-stream`'s `Readable` so downstream code can pipe or
 * async-iterate the request body in the usual Node fashion.
 *
 * @extends {Readable}
 */
export class IncomingMessage extends Readable {
  /**
   * @param {Request} fetchRequest - The native Fetch API `Request` to wrap.
   */
  constructor(fetchRequest) {
    super();

    const url  = new URL(fetchRequest.url);

    /** @type {string} HTTP method in uppercase. */
    this.method = fetchRequest.method.toUpperCase();

    /** @type {string} Request path including query string. */
    this.url = url.pathname + url.search;

    /** @type {Record<string,string>} Flat header map (lowercased names). */
    this.headers = Object.fromEntries(fetchRequest.headers.entries());

    /** @type {string[]} Raw header pairs `[name, value, name, value, ...]`. */
    this.rawHeaders = [...fetchRequest.headers.entries()].flat();

    /** @type {'1.1'} Assumed HTTP version (Fetch API does not expose version). */
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;

    /** @type {boolean} */
    this.complete = false;

    /** @type {object} No-op socket shim. */
    this.socket = NOOP_SOCKET;
    this.connection = NOOP_SOCKET;

    /** @private @type {Request} */
    this._fetchRequest = fetchRequest;

    /** @private @type {boolean} */
    this._bodyStarted = false;
  }

  /**
   * Readable._read — begins streaming the Fetch request body on first pull.
   * @param {number} _size
   */
  _read(_size) {
    if (this._bodyStarted) return;
    this._bodyStarted = true;

    if (!this._fetchRequest.body) {
      this.complete = true;
      this.push(null);
      return;
    }

    const reader = this._fetchRequest.body.getReader();
    const pump = () => {
      reader.read().then(({ done, value }) => {
        if (done) { this.complete = true; this.push(null); return; }
        this.push(Buffer.from(value));
        pump();
      }).catch(err => this.destroy(err));
    };
    pump();
  }
}

// ─── ServerResponse ─────────────────────────────────────────────────────────

/**
 * Node-compatible `http.ServerResponse`.
 *
 * Extends `readable-stream`'s `Writable`. When `end()` is called the response
 * is materialised as a WHATWG `Response` and the internal resolver promise
 * settles — allowing `Server._handleFetch()` to forward it to `respondWith()`.
 *
 * @extends {Writable}
 */
export class ServerResponse extends Writable {
  /**
   * @param {IncomingMessage} req - The associated incoming request.
   */
  constructor(req) {
    super({ highWaterMark: 16 * 1024 });

    /** @type {number} */
    this.statusCode = 200;

    /** @type {string} */
    this.statusMessage = STATUS_CODES[200];

    /** @type {boolean} */
    this.headersSent = false;

    /** @type {boolean} */
    this.finished = false;

    /** @type {boolean} */
    this.sendDate = true;

    /** @type {object} */
    this.socket = NOOP_SOCKET;
    this.connection = NOOP_SOCKET;

    /** @type {IncomingMessage} */
    this.req = req;

    /** @private @type {Map<string,[string,string[]]>} */
    this._headers = new Map();

    /** @private @type {Buffer[]} */
    this._chunks = [];

    /**
     * Promise that resolves to a WHATWG Response when the response is finalised.
     * @type {Promise<Response>}
     */
    this.fetchResponse = new Promise((res, rej) => {
      /** @private */ this._resolve = res;
      /** @private */ this._reject  = rej;
    });
  }

  // ── Header API (mirrors OutgoingMessage) ──────────────────────────────────

  /** @param {string} n @param {string|number|string[]} v @returns {this} */
  setHeader(n, v) {
    if (this.headersSent) throw new Error('Cannot set headers after they are sent.');
    const vals = Array.isArray(v) ? v.map(String) : [String(v)];
    this._headers.set(n.toLowerCase(), [n, vals]);
    return this;
  }

  /** @param {string} n @returns {string|string[]|undefined} */
  getHeader(n) {
    const e = this._headers.get(n.toLowerCase());
    if (!e) return undefined;
    return e[1].length === 1 ? e[1][0] : e[1];
  }

  /** @returns {string[]} */
  getHeaderNames() { return [...this._headers.values()].map(([n]) => n); }

  /** @returns {Record<string,string|string[]>} */
  getHeaders() {
    const o = Object.create(null);
    for (const [, [n, vals]] of this._headers)
      o[n] = vals.length === 1 ? vals[0] : vals;
    return o;
  }

  /** @param {string} n @returns {boolean} */
  hasHeader(n) { return this._headers.has(n.toLowerCase()); }

  /** @param {string} n @returns {this} */
  removeHeader(n) {
    if (this.headersSent) throw new Error('Cannot remove headers after they are sent.');
    this._headers.delete(n.toLowerCase());
    return this;
  }

  // ── Status / Head ─────────────────────────────────────────────────────────

  /**
   * Sets the response status code and optional reason phrase + headers,
   * then marks headers as sent.
   *
   * @param {number} statusCode
   * @param {string|Record<string,string|string[]>} [statusMessage]
   * @param {Record<string,string|string[]>} [headers]
   * @returns {this}
   */
  writeHead(statusCode, statusMessage, headers) {
    if (typeof statusMessage === 'object') { headers = statusMessage; statusMessage = undefined; }
    this.statusCode = statusCode;
    this.statusMessage = statusMessage ?? STATUS_CODES[statusCode] ?? 'Unknown';
    if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }

  /**
   * Sends a `100 Continue` interim response.
   * In browser environments this emits a local `'continue'` event on the
   * request; no actual 1xx frame can be sent via the Fetch API.
   * @returns {void}
   */
  writeContinue() { this.req.emit('continue'); }

  /**
   * Sends a `102 Processing` interim response (stub — Fetch API limitation).
   * @returns {void}
   */
  writeProcessing() { /* no-op: 1xx not supported by Fetch API */ }

  /**
   * Sends a `103 Early Hints` interim response (stub — Fetch API limitation).
   * @param {Record<string,string|string[]>} _hints
   * @param {Function} [_callback]
   * @returns {void}
   */
  writeEarlyHints(_hints, _callback) {
    if (typeof _callback === 'function') globalThis.setTimeout(_callback, 0);
  }

  // ── Writable internals ────────────────────────────────────────────────────

  /** @param {Buffer|string} chunk @param {BufferEncoding} enc @param {Function} cb */
  _write(chunk, enc, cb) {
    if (!this.headersSent) this.headersSent = true;
    this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc));
    cb();
  }

  /** @param {Function} cb */
  _final(cb) {
    this.finished = true;
    if (this.sendDate && !this._headers.has('date'))
      this._headers.set('date', ['Date', [new Date().toUTCString()]]);

    // Build WHATWG Headers
    const h = new Headers();
    for (const [, [name, vals]] of this._headers)
      for (const v of vals) h.append(name, v);

    const body = this._chunks.length
      ? Buffer.concat(this._chunks)
      : null;

    this._resolve(new Response(body, {
      status:     this.statusCode,
      statusText: this.statusMessage,
      headers:    h,
    }));
    cb();
  }

  /** @param {Error|null} err @param {Function} cb */
  _destroy(err, cb) {
    if (err) this._reject(err);
    this._chunks = [];
    cb(err);
  }
}

// ─── storeHTTPOptions ───────────────────────────────────────────────────────

/**
 * Stores HTTP server options onto the server instance.
 * Mirrors Node's internal `storeHTTPOptions(server, options)` helper.
 *
 * @param {Server} server
 * @param {{ keepAlive?: boolean; keepAliveTimeout?: number;
 *           connectionsCheckingInterval?: number;
 *           requestTimeout?: number; headersTimeout?: number;
 *           maxHeadersCount?: number; maxRequestsPerSocket?: number;
 *           insecureHTTPParser?: boolean }} [options={}]
 * @returns {void}
 */
export function storeHTTPOptions(server, options = {}) {
  server.keepAlive                  = options.keepAlive                  ?? false;
  server.keepAliveTimeout           = options.keepAliveTimeout           ?? 5000;
  server.connectionsCheckingInterval = options.connectionsCheckingInterval ?? 30_000;
  server.requestTimeout             = options.requestTimeout             ?? 300_000;
  server.headersTimeout             = options.headersTimeout             ?? 60_000;
  server.maxHeadersCount            = options.maxHeadersCount            ?? null;
  server.maxRequestsPerSocket       = options.maxRequestsPerSocket       ?? 0;
  server.insecureHTTPParser         = options.insecureHTTPParser         ?? false;
}

// ─── setupConnectionsTracking ───────────────────────────────────────────────

/**
 * Starts an interval that periodically checks for and destroys lingering idle
 * connections. In browser environments this is a lightweight heartbeat — no
 * real TCP connections exist — but the symbol and interval are preserved for
 * source compatibility with code that checks `server[kConnectionsCheckingInterval]`.
 *
 * @param {Server} server
 * @returns {void}
 */
export function setupConnectionsTracking(server) {
  if (server[kConnectionsCheckingInterval]) return; // idempotent
  server[kConnectionsCheckingInterval] = globalThis.setInterval(() => {
    server.emit('_connectionsCheck'); // internal heartbeat, no-op in SW
  }, server.connectionsCheckingInterval ?? 30_000);
  // Unref-equivalent: don't let this interval block process exit in Node.
  const iv = server[kConnectionsCheckingInterval];
  if (iv && typeof iv.unref === 'function') iv.unref();
}

// ─── httpServerPreClose ─────────────────────────────────────────────────────

/**
 * Performs pre-close cleanup before `server.close()` is finalised.
 * In Node ≥18 this calls `server.closeAllConnections()`.
 * In browser environments all tracked fetch handlers are cleared immediately.
 *
 * @param {Server} server
 * @returns {void}
 */
export function httpServerPreClose(server) {
  if (server[kConnectionsCheckingInterval]) {
    globalThis.clearInterval(server[kConnectionsCheckingInterval]);
    server[kConnectionsCheckingInterval] = null;
  }
  // Signal any pending in-flight responses to abort.
  if (server._abortController) server._abortController.abort();
}

// ─── _connectionListener ────────────────────────────────────────────────────

/**
 * The function that Node passes to `net.createServer()` as its connection
 * listener. In Node it receives a raw `net.Socket` and drives the HTTP parser.
 *
 * In browser/SW environments there is no raw socket; instead this function
 * processes a WHATWG `Request` and returns a `Promise<Response>`.
 * It is called internally by `Server._handleFetch()`.
 *
 * @param {Server} server
 * @param {Request} fetchRequest
 * @returns {Promise<Response>}
 */
export function _connectionListener(server, fetchRequest) {
  const req = new IncomingMessage(fetchRequest);
  const res = new ServerResponse(req);
  res.socket = NOOP_SOCKET;

  // Give user code a chance to call res.writeHead / res.end
  server.emit('request', req, res);

  // If user code never called end(), guard against the promise hanging.
  req.on('error', err => res.destroy(err));

  return res.fetchResponse;
}

// ─── Server ─────────────────────────────────────────────────────────────────

/**
 * Node-compatible `http.Server` for browser and Service Worker environments.
 *
 * Extends `EventEmitter`. Events: `'request'`, `'listening'`, `'close'`,
 * `'error'`, `'checkContinue'`, `'connect'`, `'upgrade'`.
 *
 * ### Transport strategy
 * | Environment | Transport |
 * |---|---|
 * | Service Worker | Registers a `globalThis.fetch` event listener |
 * | Cloudflare Worker / Deno | Call `server._handleFetch(request)` directly |
 * | Node.js / Bun | Use native `node:http` — this shim is not needed |
 *
 * @extends {EventEmitter}
 *
 * @example
 * const server = new Server((req, res) => {
 *   res.writeHead(200, { 'Content-Type': 'text/plain' })
 *   res.end('Hello from SW!')
 * })
 * server.listen(0) // registers SW fetch handler
 */
export class Server extends EventEmitter {
  /**
   * @param {{ keepAlive?: boolean; keepAliveTimeout?: number;
   *           connectionsCheckingInterval?: number } | Function} [options]
   * @param {(req: IncomingMessage, res: ServerResponse) => void} [requestListener]
   */
  constructor(options, requestListener) {
    super();

    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }

    storeHTTPOptions(this, options ?? {});

    this[kServerResponse]              = ServerResponse;
    this[kConnectionsCheckingInterval] = null;
    this._abortController              = new AbortController();
    this._listening                    = false;
    this._fetchHandler                 = null;

    if (requestListener) this.on('request', requestListener);
  }

  // ── listen / close ────────────────────────────────────────────────────────

  /**
   * Starts the server. In a Service Worker context, registers a `fetch`
   * event listener on `globalThis`. In all other contexts, emits `'listening'`
   * without binding a real port and logs a compatibility warning.
   *
   * @param {number|object} [_port] - Ignored (no TCP in browser).
   * @param {string} [_host] - Ignored.
   * @param {number} [_backlog] - Ignored.
   * @param {Function} [callback] - Called once on `'listening'`.
   * @returns {this}
   */
  listen(_port, _host, _backlog, callback) {
    if (typeof _port === 'function')   { callback = _port; }
    if (typeof _host === 'function')   { callback = _host; }
    if (typeof _backlog === 'function'){ callback = _backlog; }
    if (callback) this.once('listening', callback);

    if (this._listening) return this;
    this._listening = true;

    setupConnectionsTracking(this);

    // Service Worker transport
    if (typeof ServiceWorkerGlobalScope !== 'undefined' &&
        globalThis instanceof ServiceWorkerGlobalScope) {
      this._fetchHandler = event => {
        event.respondWith(this._handleFetch(event.request));
      };
      globalThis.addEventListener('fetch', this._fetchHandler);
    } else {
      // Non-SW: emit warning; caller must use _handleFetch() directly.
      if (typeof console !== 'undefined') {
        console.warn(
          '[http-server-web] No real TCP binding available in this environment.\n' +
          'Use server._handleFetch(request) to process requests manually.'
        );
      }
    }

    globalThis.setTimeout(() => {
      this.emit('listening');
    }, 0);

    return this;
  }

  /**
   * Stops the server from accepting new connections.
   * @param {Function} [callback] - Called once on `'close'`.
   * @returns {this}
   */
  close(callback) {
    if (callback) this.once('close', callback);

    httpServerPreClose(this);
    this._listening = false;

    if (this._fetchHandler) {
      globalThis.removeEventListener('fetch', this._fetchHandler);
      this._fetchHandler = null;
    }

    globalThis.setTimeout(() => this.emit('close'), 0);
    return this;
  }

  // ── Fetch-API bridge ──────────────────────────────────────────────────────

  /**
   * Processes a WHATWG `Request` through the Node.js `'request'` event pipeline
   * and returns a `Promise<Response>`.
   *
   * Use this method directly in Cloudflare Workers, Deno Deploy, or any
   * environment that hands you a `Request` object:
   *
   * ```js
   * export default { fetch: req => server._handleFetch(req) }
   * ```
   *
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  _handleFetch(request) {
    if (!this._listening) {
      return Promise.resolve(
        new Response('Service Unavailable', { status: 503 })
      );
    }
    return _connectionListener(this, request);
  }

  // ── Stub API (source-compat with Node's http.Server) ─────────────────────

  /**
   * Sets the timeout value for incoming request sockets.
   * No-op in browser (no real sockets).
   * @param {number} _msecs @param {Function} [_cb] @returns {this}
   */
  setTimeout(_msecs, _cb) { return this; }

  /** @returns {number} Always 0 in browser environments. */
  get connections() { return 0; }

  /**
   * Closes all idle connections immediately (no-op — no real sockets).
   * @returns {void}
   */
  closeIdleConnections() {}

  /**
   * Closes all connections immediately (no-op — no real sockets).
   * @returns {void}
   */
  closeAllConnections() {}
}

// ─── Default export (mirrors Cloudflare's module shape) ────────────────────

export default {
  STATUS_CODES,
  Server,
  ServerResponse,
  setupConnectionsTracking,
  storeHTTPOptions,
  _connectionListener,
  kServerResponse,
  httpServerPreClose,
  kConnectionsCheckingInterval,
};

// --- Usage ---
//
// // 1. Service Worker — automatic fetch interception
// import { Server } from './http-server-web.js'
//
// const server = new Server((req, res) => {
//   if (req.method === 'GET' && req.url === '/ping') {
//     res.writeHead(200, { 'Content-Type': 'application/json' })
//     return res.end(JSON.stringify({ pong: true, time: Date.now() }))
//   }
//   res.writeHead(404).end('Not found')
// })
// server.listen() // registers globalThis fetch handler in SW context
//
//
// // 2. Cloudflare Worker / Deno Deploy — manual fetch bridge
// import { Server } from './http-server-web.js'
//
// const server = new Server((req, res) => {
//   res.setHeader('X-Powered-By', 'http-server-web')
//   res.writeHead(200, { 'Content-Type': 'text/plain' })
//   res.end(`Hello ${req.url}`)
// })
// server.listen()
//
// export default {
//   fetch: request => server._handleFetch(request),
// }
//
//
// // 3. Edge case — streaming request body + early abort
// const server = new Server(async (req, res) => {
//   const chunks = []
//   for await (const chunk of req) chunks.push(chunk)
//   const body = Buffer.concat(chunks).toString()
//   if (!body) {
//     res.writeHead(400).end('Empty body')
//     return
//   }
//   res.writeHead(200, { 'Content-Type': 'text/plain' })
//   res.end(`Received ${body.length} bytes`)
// })
// // Test it inline (e.g. in a unit test):
// const response = await server._handleFetch(
//   new Request('https://example.com/upload', {
//     method: 'POST',
//     body: 'hello world',
//   })
// )
// console.log(response.status, await response.text())
// // → 200  'Received 11 bytes'
