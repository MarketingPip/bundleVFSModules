// src/http.js — port of node:http (Node v24.20.0) for the browser runtime.
//
// Browser strategy:
//   * Client (ClientRequest / request / get) is backed by fetch(). The browser
//     owns TLS and connection pooling, so Agent socket pooling is metadata
//     only (best-effort options, no real sockets).
//   * Server is virtual: listen() registers the server in an in-process
//     registry keyed by port. The host runtime delivers emulated inbound
//     requests through globalThis._RUNTIME_.__httpServerRunTime.handleRequest.
//   * Header validation, STATUS_CODES, METHODS, and the OutgoingMessage /
//     IncomingMessage / ServerResponse state machines are ported faithfully
//     from Node's lib/ (see /tmp/node-lib for the reference sources).
//
// Differences from Node you should know about:
//   * fetch() follows redirects automatically; Node's http client does not.
//     There is no way to observe the 3xx hop in a browser (redirect:'manual'
//     yields an opaque response), so redirects are followed and documented.
//   * No raw TCP: req.socket / res.socket are synthetic placeholders, the
//     'connection'/'connect' events fire with them, trailers are unsupported.

import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { Buffer } from 'buffer';
import {
  _checkInvalidHeaderChar,
  _checkIsHttpToken,
} from './_http_common.js';
import {
  kUniqueHeaders,
  kHighWaterMark,
} from './internals/http-symbols.js';

// ---------------------------------------------------------------------------
// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
// ---------------------------------------------------------------------------
const RT = (typeof globalThis._RUNTIME_ !== "undefined")
  ? globalThis._RUNTIME_
  : undefined;

// Guarded host-call pattern: forward lifecycle events to the host when the
// runtime provides an emitter, silently skip otherwise.
const emitEvent = RT?.emit;

// Save the native WebSocket at module load time, BEFORE any bundled CLI can
// overwrite it (e.g. Convex CLI does `globalThis.WebSocket = bundledWs`).
// No `window` reference: globalThis keeps this worker-loadable.
const _NativeWebSocket =
  typeof globalThis.WebSocket === "function" ? globalThis.WebSocket : null;

// ---------------------------------------------------------------------------
// 2. Error helpers — same codes/messages as Node v24.20.0.
// ---------------------------------------------------------------------------
function makeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const ERR_INVALID_HTTP_TOKEN = (kind, val) =>
  makeError('ERR_INVALID_HTTP_TOKEN',
    `${kind} must be a valid HTTP token [${JSON.stringify(String(val))}]`);
const ERR_INVALID_CHAR = (kind, val) =>
  makeError('ERR_INVALID_CHAR',
    val === undefined
      ? `Invalid character in ${kind}`
      : `Invalid character in ${kind} [${JSON.stringify(String(val))}]`);
const ERR_HTTP_INVALID_HEADER_VALUE = (value, name) =>
  makeError('ERR_HTTP_INVALID_HEADER_VALUE',
    `Invalid value ${JSON.stringify(String(value))} for header ${JSON.stringify(String(name))}`);
const ERR_HTTP_HEADERS_SENT = (op) =>
  makeError('ERR_HTTP_HEADERS_SENT',
    op === 'write'
      ? 'Cannot write headers after they are sent to the client'
      : `Cannot ${op} headers after they are sent to the client`);
const ERR_HTTP_INVALID_STATUS_CODE = (code) =>
  makeError('ERR_HTTP_INVALID_STATUS_CODE', `Invalid status code: ${code}`);
const ERR_INVALID_ARG_TYPE = (name, expected, actual) =>
  makeError('ERR_INVALID_ARG_TYPE',
    `The "${name}" argument must be ${expected}. Received type ${typeof actual} (${String(actual)})`);
const ERR_INVALID_ARG_VALUE = (name, value, reason) =>
  makeError('ERR_INVALID_ARG_VALUE',
    `The argument '${name}' is invalid.${reason ? ` ${reason}` : ''} Received ${JSON.stringify(value)}`);
const ERR_OUT_OF_RANGE = (name, range, received) =>
  makeError('ERR_OUT_OF_RANGE',
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`);
const ERR_INVALID_PROTOCOL = (protocol, expected) =>
  makeError('ERR_INVALID_PROTOCOL',
    `Protocol "${protocol}" not supported. Expected "${expected}"`);
const ERR_UNESCAPED_CHARACTERS = (what) =>
  makeError('ERR_UNESCAPED_CHARACTERS', `${what} contains unescaped characters`);

function validateString(value, name) {
  if (typeof value !== 'string') {
    throw ERR_INVALID_ARG_TYPE(name, 'of type string', value);
  }
}

// ---------------------------------------------------------------------------
// 3. Constants — STATUS_CODES (63 entries) and METHODS (35, sorted),
//    verbatim from Node v24.20.0.
// ---------------------------------------------------------------------------
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

export const METHODS = [
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD',
  'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL',
  'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH',
  'PURGE', 'PUT', 'QUERY', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE',
  'SUBSCRIBE', 'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
];

/** Default --max-http-header-size in Node v24 (no CLI flags in a browser). */
export const maxHeaderSize = 16384;

let maxIdleHTTPParsers = 1000;

/** Matches Node: validates and stores the parser-cache size (no pool here). */
export function setMaxIdleHTTPParsers(max) {
  if (typeof max !== 'number') {
    throw ERR_INVALID_ARG_TYPE('max', 'number', max);
  }
  if (!Number.isInteger(max)) {
    throw ERR_OUT_OF_RANGE('max', 'an integer', max);
  }
  if (max < 1 || max > Number.MAX_SAFE_INTEGER) {
    throw ERR_OUT_OF_RANGE('max', '>= 1 && <= 9007199254740991', max);
  }
  maxIdleHTTPParsers = max;
}

/**
 * Node reads proxy env and rewrites client requests to absolute-form.
 * Browsers apply their own proxy configuration to fetch(); nothing to do.
 */
export function setGlobalProxyFromEnv() {}

/** Throw unless name is a valid HTTP token (Node's validateHeaderName). */
export function validateHeaderName(name) {
  if (typeof name !== 'string' || !name || !_checkIsHttpToken(name)) {
    throw ERR_INVALID_HTTP_TOKEN('Header name', name);
  }
}

/** Throw unless value holds no invalid header chars (Node's validateHeaderValue). */
export function validateHeaderValue(name, value) {
  if (value === undefined) {
    throw ERR_HTTP_INVALID_HEADER_VALUE(value, name);
  }
  if (_checkInvalidHeaderChar(String(value))) {
    throw ERR_INVALID_CHAR('header content', name);
  }
}

// ---------------------------------------------------------------------------
// 4. Minimal synthetic socket — stands in for net.Socket (src/net.js is an
//    npm-style shim; http must stay dependency-free, so we carry our own).
// ---------------------------------------------------------------------------
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writable = true;
    this.readable = true;
    this.remoteAddress = '127.0.0.1';
    this.remotePort = 0;
    this.localAddress = '127.0.0.1';
    this.localPort = 0;
  }
  write(chunk, encoding, cb) {
    const callback = typeof encoding === 'function' ? encoding : cb;
    if (callback) queueMicrotask(() => callback(null));
    return true;
  }
  end(cb) {
    if (cb) queueMicrotask(cb);
    return this;
  }
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    this.readable = false;
    queueMicrotask(() => {
      if (err) this.emit('error', err);
      this.emit('close', false);
    });
    return this;
  }
  address() {
    return { address: this.localAddress, family: 'IPv4', port: this.localPort };
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  cork() {}
  uncork() {}
}

// Module-local symbols mirroring Node's internal slots.
// (kUniqueHeaders / kHighWaterMark live in ./internals/http-symbols.js so the
// http module family shares them without exposing them on the public surface.)
const kOutHeaders = Symbol('kOutHeaders');
const kPath = Symbol('kPath');

const INVALID_PATH_REGEX = /[^\u0021-\u00ff]/;

// ---------------------------------------------------------------------------
// 5. OutgoingMessage — port of node:_http_outgoing (Writable-based).
// ---------------------------------------------------------------------------
export class OutgoingMessage extends Writable {
  constructor(options) {
    super({ highWaterMark: options?.highWaterMark });
    this[kHighWaterMark] = options?.highWaterMark;
    this[kOutHeaders] = null;
    this._header = null; // rendered header block; truthy => headers sent
    this._renderedHeaders = null; // flattened map for the server bridge
    this.finished = false;
    this.sendDate = true;
    this.chunkedEncoding = false;
    this.shouldKeepAlive = true;
    this.useChunkedEncodingByDefault = true;
    this._hasBody = true;
    this._removedConnection = false;
    this._removedContLen = false;
    this._removedTE = false;
    this.outputData = [];
    this.outputSize = 0;
    this.socket = null;
    this.connection = null;
    this._trailer = null;
  }

  // Buffer written chunks until the message is finished (no real socket).
  _write(chunk, encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.outputData.push({ data: buf, encoding: 'buffer' });
    this.outputSize += buf.length;
    callback();
  }

  get headersSent() {
    return !!this._header;
  }

  get writableEnded() {
    return this.finished;
  }

  _isLenientHeaderValidation() {
    return false;
  }

  setHeader(name, value) {
    if (this._header) {
      throw ERR_HTTP_HEADERS_SENT('set');
    }
    validateHeaderName(name);
    if (value === undefined) {
      throw ERR_HTTP_INVALID_HEADER_VALUE(value, name);
    }
    if (_checkInvalidHeaderChar(String(value), this._isLenientHeaderValidation())) {
      throw ERR_INVALID_CHAR('header content', name);
    }

    let headers = this[kOutHeaders];
    if (headers === null) {
      this[kOutHeaders] = headers = { __proto__: null };
    }
    headers[name.toLowerCase()] = [name, value];
    return this;
  }

  setHeaders(headers) {
    if (this._header) {
      throw ERR_HTTP_HEADERS_SENT('set');
    }
    if (
      !headers ||
      Array.isArray(headers) ||
      typeof headers.keys !== 'function' ||
      typeof headers.get !== 'function'
    ) {
      throw ERR_INVALID_ARG_TYPE('headers', 'an instance of Headers or Map', headers);
    }

    // set-cookie values are collected so setHeader does not overwrite them.
    let cookies = null;
    for (const { 0: key, 1: value } of headers) {
      if (String(key).toLowerCase() === 'set-cookie') {
        cookies ??= [];
        if (Array.isArray(value)) cookies.push(...value);
        else cookies.push(value);
        continue;
      }
      this.setHeader(key, value);
    }
    if (cookies !== null) {
      this.setHeader('set-cookie', cookies);
    }
    return this;
  }

  appendHeader(name, value) {
    if (this._header) {
      throw ERR_HTTP_HEADERS_SENT('append');
    }
    validateHeaderName(name);
    if (value === undefined) {
      throw ERR_HTTP_INVALID_HEADER_VALUE(value, name);
    }
    if (_checkInvalidHeaderChar(String(value), this._isLenientHeaderValidation())) {
      throw ERR_INVALID_CHAR('header content', name);
    }

    const field = name.toLowerCase();
    const headers = this[kOutHeaders];
    if (headers === null || !headers[field]) {
      return this.setHeader(name, value);
    }

    if (!Array.isArray(headers[field][1])) {
      headers[field][1] = [headers[field][1]];
    }
    const existing = headers[field][1];
    if (Array.isArray(value)) {
      for (const v of value) existing.push(v);
    } else {
      existing.push(value);
    }
    return this;
  }

  getHeader(name) {
    validateString(name, 'name');
    const headers = this[kOutHeaders];
    if (headers === null) return undefined;
    const entry = headers[name.toLowerCase()];
    return entry?.[1];
  }

  getHeaders() {
    const headers = this[kOutHeaders];
    const ret = { __proto__: null };
    if (headers) {
      for (const key of Object.keys(headers)) {
        ret[key] = headers[key][1];
      }
    }
    return ret;
  }

  getHeaderNames() {
    return this[kOutHeaders] !== null ? Object.keys(this[kOutHeaders]) : [];
  }

  getRawHeaderNames() {
    const headersMap = this[kOutHeaders];
    if (headersMap === null) return [];
    return Object.values(headersMap).map((entry) => entry[0]);
  }

  hasHeader(name) {
    validateString(name, 'name');
    return this[kOutHeaders] !== null && !!this[kOutHeaders][name.toLowerCase()];
  }

  removeHeader(name) {
    validateString(name, 'name');
    if (this._header) {
      throw ERR_HTTP_HEADERS_SENT('remove');
    }
    const key = name.toLowerCase();
    switch (key) {
      case 'connection':
        this._removedConnection = true;
        break;
      case 'content-length':
        this._removedContLen = true;
        break;
      case 'transfer-encoding':
        this._removedTE = true;
        break;
    }
    if (this[kOutHeaders] !== null) {
      delete this[kOutHeaders][key];
    }
  }

  /**
   * Render the header block (simplified _storeHeader). Sets this._header so
   * headersSent becomes true, and stashes a flattened header map for the
   * virtual-server bridge.
   */
  _storeHeader(firstLine, headers) {
    const flat = { __proto__: null }; // lowercase -> string | string[]
    const lines = [];
    const pushLine = (name, value) => {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        lines.push(`${name}: ${v}\r\n`);
      }
      const key = String(name).toLowerCase();
      if (key === 'set-cookie' && values.length > 1) {
        flat[key] = values.map(String);
      } else {
        flat[key] = values.map(String).join(', ');
      }
    };

    if (headers) {
      if (headers === this[kOutHeaders]) {
        for (const key of Object.keys(headers)) {
          const entry = headers[key];
          this._renderHeaderEntry(pushLine, entry[0], entry[1]);
        }
      } else if (Array.isArray(headers)) {
        if (headers.length && Array.isArray(headers[0])) {
          // Array of [name, value] pairs.
          for (const entry of headers) {
            validateHeaderName(entry[0]);
            this._renderHeaderEntry(pushLine, entry[0], entry[1]);
          }
        } else {
          // Flat array: name, value, name, value, ...
          if (headers.length % 2 !== 0) {
            throw ERR_INVALID_ARG_VALUE('headers', headers);
          }
          for (let n = 0; n < headers.length; n += 2) {
            validateHeaderName(headers[n]);
            this._renderHeaderEntry(pushLine, headers[n], headers[n + 1]);
          }
        }
      } else {
        for (const key of Object.keys(headers)) {
          validateHeaderName(key);
          this._renderHeaderEntry(pushLine, key, headers[key]);
        }
      }
    }

    let header = firstLine;
    if (this.sendDate && !flat.date) {
      const date = new Date().toUTCString();
      header += `Date: ${date}\r\n`;
      flat.date = date;
    }
    header += lines.join('');
    header += '\r\n';

    this._header = header;
    this._renderedHeaders = flat;
  }

  // Mirrors Node's processHeader array semantics: set-cookie (and other
  // multi-value arrays of length >= 2 on non-cookie fields) stay separate
  // lines; single-element arrays collapse to one line.
  _renderHeaderEntry(pushLine, name, value) {
    if (Array.isArray(value)) {
      const isCookie = String(name).toLowerCase() === 'set-cookie';
      if ((value.length < 2 || !isCookie) &&
          !(this[kUniqueHeaders]?.has(String(name).toLowerCase()))) {
        for (const v of value) pushLine(name, v);
        return;
      }
      value = value.join('; ');
    }
    pushLine(name, value);
  }

  _implicitHeader() {
    throw makeError('ERR_METHOD_NOT_IMPLEMENTED', '_implicitHeader()');
  }

  write(chunk, encoding, callback) {
    if (!this._header) {
      this._implicitHeader();
    }
    if (this._hasBody === false) {
      // 204/304/1xx responses MUST NOT have a body: ignore writes (Node parity).
      if (typeof encoding === 'function') callback = encoding;
      if (typeof callback === 'function') queueMicrotask(callback);
      return true;
    }
    return super.write(chunk, encoding, callback);
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = null;
    }
    if (!this._header) {
      this._implicitHeader();
    }
    this.finished = true;
    if (chunk !== null && chunk !== undefined && this._hasBody !== false) {
      super.write(chunk, encoding);
    }
    super.end(callback);
    return this;
  }

  addTrailers(headers) {
    this._trailer = headers;
  }

  flushHeaders() {
    if (!this._header) {
      this._implicitHeader();
    }
  }

  setTimeout(msecs, callback) {
    if (callback) this.once('timeout', callback);
    return this;
  }

  // get/set for the unique-headers option (used by _http_outgoing consumers).
  get [kUniqueHeaders]() {
    return this._uniqueHeaders ?? null;
  }
  set [kUniqueHeaders](value) {
    this._uniqueHeaders = value;
  }
}

// ---------------------------------------------------------------------------
// 6. IncomingMessage — port of node:_http_incoming (Readable-based).
// ---------------------------------------------------------------------------
export class IncomingMessage extends Readable {
  constructor(socket) {
    super();
    this.socket = socket || new FakeSocket();
    this.connection = this.socket;
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.httpVersion = '1.1';
    this.complete = false;
    this.aborted = false;
    this.headers = {};
    this.headersDistinct = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    this.method = null;
    this.url = null;
    this.statusCode = null;
    this.statusMessage = null;
    this._dumped = false;
  }

  _read() {
    // Data is pushed manually via _setBody / pushBodyChunk.
  }

  get connection() {
    return this.socket;
  }
  set connection(val) {
    this.socket = val;
  }

  setTimeout(msecs, callback) {
    if (callback) this.once('timeout', callback);
    if (this.socket?.setTimeout) this.socket.setTimeout(msecs);
    return this;
  }

  _destroy(err, cb) {
    if (!this.aborted) {
      this.aborted = true;
    }
    cb(err);
  }

  // Internal: push one body chunk (Buffer/Uint8Array/string).
  _pushBody(chunk) {
    if (chunk === null || chunk === undefined) return;
    this.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  // Internal: mark the message complete (end of body).
  _finishBody() {
    if (this.complete) return;
    this.complete = true;
    this.push(null);
  }

  // Internal: set the entire body at once (used by the virtual server and
  // the fetch-backed client).
  _setBody(body) {
    if (body === null || body === undefined) {
      this._finishBody();
      return;
    }
    const buf = typeof body === 'string'
      ? Buffer.from(body)
      : Buffer.isBuffer(body)
        ? body
        : Buffer.from(body);
    if (buf.length > 0) this.push(buf);
    this._finishBody();
  }

  /**
   * Build a server-side request message from the runtime's emulated inbound
   * request. Duplicate headers are joined with ", " (set-cookie stays an
   * array), mirroring Node's parser.
   */
  static fromRequest(method, url, headers, body) {
    const msg = new IncomingMessage();
    msg.method = method;
    msg.url = url;

    for (const [key, value] of Object.entries(headers || {})) {
      const lower = key.toLowerCase();
      msg.rawHeaders.push(key, String(value));
      if (lower === 'set-cookie') {
        const arr = Array.isArray(value) ? value.map(String) : [String(value)];
        if (msg.headers[lower] === undefined) {
          msg.headers[lower] = arr.length === 1 ? arr[0] : arr;
        } else {
          const cur = Array.isArray(msg.headers[lower]) ? msg.headers[lower] : [msg.headers[lower]];
          msg.headers[lower] = cur.concat(arr);
        }
        msg.headersDistinct[lower] = Array.isArray(msg.headers[lower])
          ? msg.headers[lower].slice()
          : [msg.headers[lower]];
      } else {
        const val = Array.isArray(value) ? value.map(String).join(', ') : String(value);
        msg.headers[lower] = lower in msg.headers ? `${msg.headers[lower]}, ${val}` : val;
        msg.headersDistinct[lower] = (msg.headersDistinct[lower] || []).concat(val);
      }
    }

    if (body !== null && body !== undefined &&
        (typeof body === 'string' || ArrayBuffer.isView(body))) {
      msg._setBody(body);
    } else {
      msg._finishBody();
    }
    return msg;
  }

  /**
   * Build a client-side response message from a fetch() Response.
   * fetch() already joins duplicate headers; set-cookie is not observable
   * through the Headers API (documented gap).
   */
  static async fromFetchResponse(response) {
    const msg = new IncomingMessage();
    msg.statusCode = response.status;
    msg.statusMessage = response.statusText || STATUS_CODES[response.status] || '';
    msg.httpVersion = '1.1';
    msg.httpVersionMajor = 1;
    msg.httpVersionMinor = 1;

    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      msg.headers[lower] = value;
      msg.headersDistinct[lower] = [value];
      msg.rawHeaders.push(key, value);
    });

    // Read the body as an ArrayBuffer and slice it through Uint8Array so we
    // never retain a larger shared backing store.
    const ab = await response.arrayBuffer();
    msg._setBody(Buffer.from(new Uint8Array(ab)));
    return msg;
  }
}

// ---------------------------------------------------------------------------
// 7. ServerResponse — port of node:_http_server's ServerResponse.
// ---------------------------------------------------------------------------
export class ServerResponse extends OutgoingMessage {
  constructor(req) {
    super();
    this.socket = req?.socket || new FakeSocket();
    this.connection = this.socket;
    this.statusCode = 200;
    // statusMessage stays undefined until writeHead (Node: prototype default).
    this.sendDate = true;
    this._resolve = null;
  }

  _implicitHeader() {
    this.writeHead(this.statusCode);
  }

  writeHead(statusCode, reason, obj) {
    if (this._header) {
      throw ERR_HTTP_HEADERS_SENT('write');
    }

    const originalStatusCode = statusCode;
    statusCode |= 0;
    if (statusCode < 100 || statusCode > 999) {
      throw ERR_HTTP_INVALID_STATUS_CODE(originalStatusCode);
    }

    if (typeof reason === 'string') {
      // writeHead(statusCode, reasonPhrase[, headers])
      this.statusMessage = reason;
    } else {
      // writeHead(statusCode[, headers])
      this.statusMessage = this.statusMessage || STATUS_CODES[statusCode] || 'unknown';
      obj ??= reason;
    }
    this.statusCode = statusCode;

    let headers;
    if (this[kOutHeaders]) {
      // Slow-case: progressive API was used; obj headers merge in.
      if (Array.isArray(obj)) {
        if (obj.length % 2 !== 0) {
          throw ERR_INVALID_ARG_VALUE('headers', obj);
        }
        for (let n = 0; n < obj.length; n += 2) {
          if (obj[n]) this.removeHeader(obj[n]);
        }
        for (let n = 0; n < obj.length; n += 2) {
          if (obj[n]) this.appendHeader(obj[n], obj[n + 1]);
        }
      } else if (obj) {
        for (const k of Object.keys(obj)) {
          if (k) this.setHeader(k, obj[k]);
        }
      }
      headers = this[kOutHeaders];
    } else {
      // Only writeHead() called: headers render but stay out of getHeaders(),
      // exactly like Node (kOutHeaders remains null).
      headers = obj;
    }

    if (_checkInvalidHeaderChar(this.statusMessage)) {
      throw ERR_INVALID_CHAR('statusMessage');
    }

    const statusLine = `HTTP/1.1 ${statusCode} ${this.statusMessage}\r\n`;

    if (statusCode === 204 || statusCode === 304 ||
        (statusCode >= 100 && statusCode <= 199)) {
      // RFC 2616: these responses MUST NOT include a message body.
      this._hasBody = false;
    }

    this._storeHeader(statusLine, headers);
    return this;
  }

  // Legacy alias.
  writeHeader(statusCode, reason, obj) {
    return this.writeHead(statusCode, reason, obj);
  }

  // 1xx informational responses cannot be emitted through the emulated
  // server bridge; they are accepted and ignored (noop over throw).
  writeContinue() {}
  writeProcessing() {}
  writeEarlyHints(hints, callback) {
    if (typeof callback === 'function') queueMicrotask(callback);
  }
  writeInformation(info, callback) {
    if (typeof callback === 'function') queueMicrotask(callback);
    return false;
  }

  assignSocket(socket) {
    this.socket = socket;
    this.connection = socket;
  }
  detachSocket(socket) {
    if (socket) {
      this.socket = null;
      this.connection = null;
    }
  }

  // Internal: the virtual server installs a resolver; end() settles it with
  // the full response once the body stream finishes.
  _setResolver(resolve) {
    this._resolve = resolve;
    if (this.finished) this._deliver();
  }

  _deliver() {
    if (!this._resolve) return;
    const resolve = this._resolve;
    this._resolve = null;
    const body = Buffer.concat(this.outputData.map((e) => e.data));
    const headers = {};
    const flat = this._renderedHeaders || {};
    for (const key of Object.keys(flat)) {
      headers[key] = flat[key];
    }
    resolve({
      statusCode: this.statusCode,
      statusMessage: this.statusMessage,
      headers,
      body,
    });
  }

  end(chunk, encoding, callback) {
    if (this.finished) {
      if (typeof callback === 'function') queueMicrotask(callback);
      return this;
    }
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = null;
    }
    if (!this._header) {
      this._implicitHeader();
    }
    this.finished = true;
    const done = () => {
      this._deliver();
      this.emit('finish');
      if (callback) callback();
    };
    if (chunk !== null && chunk !== undefined) {
      super.write(chunk, encoding, () => super.end(done));
    } else {
      super.end(done);
    }
    return this;
  }

  // --- Express-style conveniences (carried over from the previous shim) ---

  send(data) {
    if (typeof data === 'object' && data !== null && !Buffer.isBuffer(data)) {
      this.setHeader('Content-Type', 'application/json');
      data = JSON.stringify(data);
    }
    if (!this.hasHeader('Content-Type')) {
      this.setHeader('Content-Type', 'text/html');
    }
    return this.end(typeof data === 'string' ? data : data);
  }

  json(data) {
    this.setHeader('Content-Type', 'application/json');
    return this.end(JSON.stringify(data));
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  redirect(urlOrStatus, url) {
    if (typeof urlOrStatus === 'number') {
      this.statusCode = urlOrStatus;
      this.setHeader('Location', url);
    } else {
      this.statusCode = 302;
      this.setHeader('Location', urlOrStatus);
    }
    return this.end();
  }

  // Test/debug helpers.
  _getBody() {
    return Buffer.concat(this.outputData.map((e) => e.data));
  }
  _getBodyAsString() {
    return this._getBody().toString('utf8');
  }
}

// ---------------------------------------------------------------------------
// 8. ClientRequest — port of node:_http_client, backed by fetch().
// ---------------------------------------------------------------------------

/** Parse the (url[, options][, callback]) / (options[, callback]) overloads. */
function parseRequestArgs(urlOrOptions, optionsOrCallback, callback) {
  let options;
  let cb = callback;

  if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
    const parsed = new URL(urlOrOptions.toString());
    options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: `${parsed.pathname}${parsed.search}`,
      hash: parsed.hash,
      auth: parsed.username
        ? `${parsed.username}:${parsed.password}`
        : undefined,
      method: 'GET',
    };
    if (typeof optionsOrCallback === 'function') {
      cb = optionsOrCallback;
    } else if (optionsOrCallback) {
      options = { __proto__: null, ...options, ...optionsOrCallback };
    }
  } else {
    options = urlOrOptions || {};
    if (typeof optionsOrCallback === 'function') {
      cb = optionsOrCallback;
    }
  }

  return { options, callback: cb };
}

export class ClientRequest extends OutgoingMessage {
  constructor(input, options, cb, defaultAgent) {
    // Propagate the user's highWaterMark to the Writable base (Node parity).
    const rawOpts = typeof options === 'object' && options !== null ? options
      : typeof input === 'object' && input !== null ? input : null;
    const hw = rawOpts?.highWaterMark;
    super(hw == null ? undefined : { highWaterMark: hw });

    // Normalize (url, options?, cb?) and (options, cb?) signatures.
    if (typeof options === 'function') {
      cb = options;
      options = undefined;
    }
    let urlOpts = null;
    if (typeof input === 'string' || input instanceof URL) {
      const parsed = new URL(input.toString(), 'http://localhost');
      urlOpts = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        auth: parsed.username
          ? decodeURIComponent(parsed.username) +
            (parsed.password ? `:${decodeURIComponent(parsed.password)}` : '')
          : undefined,
      };
    } else if (input && typeof input === 'object') {
      urlOpts = input;
    }
    options = { __proto__: null, ...urlOpts, ...(options || {}) };

    // --- agent -----------------------------------------------------------
    let agent = options.agent;
    const defAgent = options._defaultAgent || defaultAgent || globalAgent;
    if (agent === false) {
      agent = new defAgent.constructor();
    } else if (agent === null || agent === undefined) {
      if (typeof options.createConnection !== 'function') {
        agent = defAgent;
      }
    } else if (typeof agent.addRequest !== 'function') {
      throw ERR_INVALID_ARG_TYPE(
        'options.agent', 'one of Agent-like Object, undefined, or false', agent);
    }
    this.agent = agent;

    const protocol = options.protocol || defAgent.protocol || 'http:';
    const expectedProtocol = this.agent?.protocol || defAgent.protocol || 'http:';
    if (options.path !== undefined && options.path !== null) {
      const p = String(options.path);
      if (INVALID_PATH_REGEX.test(p)) {
        throw ERR_UNESCAPED_CHARACTERS('Request path');
      }
    }
    if (protocol !== expectedProtocol) {
      throw ERR_INVALID_PROTOCOL(protocol, expectedProtocol);
    }

    const defaultPort = options.defaultPort || this.agent?.defaultPort || 80;
    const port = options.port || defaultPort || 80;
    let host = options.hostname || options.host || 'localhost';
    if (host !== null && host !== undefined && typeof host !== 'string') {
      throw ERR_INVALID_ARG_TYPE('options.host', 'of type string', host);
    }
    host = host || 'localhost';

    let method = options.method;
    if (method != null) validateString(method, 'options.method');
    if (method) {
      if (!_checkIsHttpToken(method)) {
        throw ERR_INVALID_HTTP_TOKEN('Method', method);
      }
      method = method.toUpperCase();
    } else {
      method = 'GET';
    }

    if (options.maxHeaderSize !== undefined &&
        (!Number.isInteger(options.maxHeaderSize) || options.maxHeaderSize < 0)) {
      throw ERR_OUT_OF_RANGE('maxHeaderSize', '>= 0', options.maxHeaderSize);
    }

    this[kPath] = options.path || '/';
    this.method = method;
    this.host = host;
    this.port = port;
    this.protocol = protocol;
    this.auth = options.auth;
    this.timeout = options.timeout;
    this.maxHeaderSize = options.maxHeaderSize;
    this.reusedSocket = false;
    this.aborted = false;
    this.upgradeOrConnect = false;
    this._ended = false;
    this._aborted = false;
    this._timeoutId = null;
    this._abortController = null;

    // Synthetic socket: browsers have no raw TCP.
    this.socket = new FakeSocket();
    this.connection = this.socket;

    // Default headers (Host, Authorization), mirroring Node.
    if (options.headers) {
      for (const key of Object.keys(options.headers)) {
        this.setHeader(key, options.headers[key]);
      }
    }
    if (host && !this.getHeader('host') && options.setHost !== false &&
        options.setDefaultHeaders !== false) {
      let hostHeader = host;
      if (port && Number(port) !== Number(defaultPort)) {
        hostHeader += `:${port}`;
      }
      this.setHeader('Host', hostHeader);
    }
    if (options.auth && !this.getHeader('authorization')) {
      this.setHeader('Authorization',
        `Basic ${Buffer.from(options.auth).toString('base64')}`);
    }

    if (cb) {
      this.once('response', cb);
    }

    if (method === 'GET' || method === 'HEAD' || method === 'DELETE' ||
        method === 'OPTIONS' || method === 'TRACE' || method === 'CONNECT') {
      this.useChunkedEncodingByDefault = false;
    }
  }

  get path() {
    return this[kPath];
  }
  set path(value) {
    const p = String(value);
    if (INVALID_PATH_REGEX.test(p)) {
      throw ERR_UNESCAPED_CHARACTERS('Request path');
    }
    this[kPath] = p;
  }

  _implicitHeader() {
    // The request line is rendered by fetch(); just mark headers sent.
    this._header = `${this.method} ${this.path} HTTP/1.1\r\n`;
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this._aborted = true;
    queueMicrotask(() => this.emit('abort'));
    this.destroy();
  }

  // Node 24: abort() is the legacy spelling; destroy() is canonical.
  destroy(err) {
    this._aborted = true;
    if (this._abortController) {
      try { this._abortController.abort(); } catch { /* noop */ }
    }
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    super.destroy(err);
    return this;
  }

  setTimeout(timeout, callback) {
    if (callback) this.once('timeout', callback);
    this.timeout = timeout;
    return this;
  }

  clearTimeout() {
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    return this;
  }

  setNoDelay() { return this; }
  setSocketKeepAlive() { return this; }

  getHeader(name) {
    return super.getHeader(name);
  }
  setHeader(name, value) {
    return super.setHeader(name, value);
  }
  removeHeader(name) {
    return super.removeHeader(name);
  }

  end(chunk, encoding, callback) {
    if (this._ended) {
      if (typeof callback === 'function') queueMicrotask(callback);
      return this;
    }
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = null;
    }
    this._ended = true;
    this.finished = true;
    const finish = () => {
      if (callback) callback();
      this.emit('finish');
    };
    const run = () => {
      this._performRequest().then(finish, (err) => {
        // 'error' must not throw when unhandled during perform; Node emits.
        if (this.listenerCount('error') > 0) this.emit('error', err);
        else this.emit('abort');
      });
    };
    if (chunk !== null && chunk !== undefined) {
      super.write(chunk, encoding, run);
    } else {
      run();
    }
    return this;
  }

  _buildURL() {
    const protocol = this.protocol === 'https:' ? 'https:' : 'http:';
    let hostname = this.host;
    let portPart = '';
    // `host` may be "example.com:8080".
    const colon = hostname.lastIndexOf(':');
    if (colon !== -1 && hostname.indexOf(':') === colon) {
      const maybePort = Number(hostname.slice(colon + 1));
      if (Number.isInteger(maybePort)) {
        portPart = `:${maybePort}`;
        hostname = hostname.slice(0, colon);
      }
    } else if (this.port) {
      const defPort = this.agent?.defaultPort || (protocol === 'https:' ? 443 : 80);
      if (Number(this.port) !== Number(defPort)) portPart = `:${this.port}`;
    }
    // IPv6 literals need brackets.
    if (hostname.includes(':') && !hostname.startsWith('[')) {
      hostname = `[${hostname}]`;
    }
    return `${protocol}//${hostname}${portPart}${this.path}`;
  }

  _getFetch() {
    const f = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
    return f;
  }

  async _performRequest() {
    if (this._aborted) return;

    const fetchFn = this._getFetch();
    if (!fetchFn) {
      throw makeError('ERR_NO_FETCH', 'fetch() is not available in this environment');
    }

    const url = this._buildURL();

    // WebSocket upgrade requests cannot use fetch(): browsers strip
    // Connection/Upgrade headers. Bridge to the native WebSocket instead.
    if (String(this.getHeader('upgrade') || '').toLowerCase() === 'websocket') {
      this._handleWebSocketUpgrade(url);
      return;
    }

    // Optional CORS proxy (configured via localStorage by the host page).
    let fetchUrl = url;
    try {
      const ls = globalThis.localStorage;
      const proxy = typeof ls !== 'undefined' && ls
        ? ls.getItem('__corsProxyUrl')
        : null;
      if (proxy) fetchUrl = proxy + encodeURIComponent(url);
    } catch { /* storage may be unavailable; ignore */ }

    const fetchOptions = {
      method: this.method,
      headers: {},
      // Unlike Node, fetch() follows redirects automatically; the browser
      // gives us no way to observe the 3xx hop (documented gap).
      redirect: 'follow',
    };
    for (const [k, v] of Object.entries(this.getHeaders())) {
      fetchOptions.headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    // fetch forbids user-set Host; the browser derives it from the URL.
    delete fetchOptions.headers.host;

    const body = Buffer.concat(this.outputData.map((e) => e.data));
    if (body.length > 0 && this.method !== 'GET' && this.method !== 'HEAD') {
      fetchOptions.body = body;
    } else if ((this.method === 'GET' || this.method === 'HEAD') && body.length > 0) {
      throw makeError('ERR_INVALID_ARG_VALUE',
        `Request with ${this.method} method cannot have a body.`);
    }

    // In-process loopback: a virtual server registered for this local
    // host:port answers without touching the network. This makes
    // same-process client/server round trips (the common test shape, and a
    // genuinely useful browser pattern) work with zero native sockets.
    const virtualServer = this._getVirtualServer();
    if (virtualServer) {
      await this._performVirtualRequest(
        virtualServer, fetchOptions.headers, body.length > 0 ? body : null);
      return;
    }

    const controller = new AbortController();
    this._abortController = controller;
    fetchOptions.signal = controller.signal;

    if (this.timeout) {
      this._timeoutId = setTimeout(() => {
        this._timeoutId = null;
        controller.abort();
        this.emit('timeout');
      }, this.timeout);
    }
    if (this.agent) {
      try { this.agent.emit('request', this); } catch { /* noop */ }
    }

    let response;
    try {
      // Emit 'socket' with the synthetic socket, like Node does on connect.
      queueMicrotask(() => {
        if (!this._aborted) this.emit('socket', this.socket);
      });
      response = await fetchFn(fetchUrl, fetchOptions);
    } catch (err) {
      if (this._timeoutId) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }
      if (this._aborted) return;
      if (err && err.name === 'AbortError') return; // timeout already emitted
      throw err;
    }

    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._aborted) return;

    const msg = await IncomingMessage.fromFetchResponse(response);
    msg.socket = this.socket;
    msg.connection = this.socket;
    this.emit('response', msg);
  }

  /**
   * Find a virtual server registered for this request's local host:port.
   * Returns the Server or null (→ the request goes to fetch()).
   */
  _getVirtualServer() {
    let hostname = this.host;
    let port = Number(this.port);
    // `host` may be "example.com:8080".
    const colon = hostname.lastIndexOf(':');
    if (colon !== -1 && hostname.indexOf(':') === colon) {
      const maybePort = Number(hostname.slice(colon + 1));
      if (Number.isInteger(maybePort)) {
        port = maybePort;
        hostname = hostname.slice(0, colon);
      }
    }
    const local = hostname === 'localhost' || hostname === '127.0.0.1' ||
      hostname === '::1' || hostname === '[::1]' || hostname === '';
    if (!local || !Number.isInteger(port)) return null;
    return serverRegistry.get(port) || null;
  }

  /** Emulate a client→server round trip against a virtual server. */
  async _performVirtualRequest(server, headers, body) {
    if (this.timeout) {
      this._timeoutId = setTimeout(() => {
        this._timeoutId = null;
        this._aborted = true;
        this.emit('timeout');
      }, this.timeout);
    }
    if (this.agent) {
      try { this.agent.emit('request', this); } catch { /* noop */ }
    }
    // Emit 'socket' with the synthetic socket, like Node does on connect.
    queueMicrotask(() => {
      if (!this._aborted) this.emit('socket', this.socket);
    });

    let result;
    try {
      result = await server.handleRequest(this.method, this.path, headers, body);
    } catch (err) {
      if (this._timeoutId) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }
      if (this._aborted) return;
      throw err;
    }
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._aborted) return;

    const msg = new IncomingMessage();
    msg.statusCode = result.statusCode;
    msg.statusMessage = result.statusMessage ||
      STATUS_CODES[result.statusCode] || '';
    msg.httpVersion = '1.1';
    msg.httpVersionMajor = 1;
    msg.httpVersionMinor = 1;
    for (const [key, value] of Object.entries(result.headers || {})) {
      const lower = key.toLowerCase();
      msg.headers[lower] = value;
      msg.headersDistinct[lower] = Array.isArray(value) ? value.map(String) : [String(value)];
      msg.rawHeaders.push(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
    msg.socket = this.socket;
    msg.connection = this.socket;
    const bodyBuf = Buffer.isBuffer(result.body)
      ? result.body
      : Buffer.from(result.body || '');
    msg._setBody(bodyBuf);
    this.emit('response', msg);
  }

  /**
   * Bridge a WebSocket upgrade request to the browser's native WebSocket.
   * (Carried over from the previous shim: the bundled `ws` client creates
   * upgrade requests via http.request() and expects frame-level I/O on the
   * socket from the 'upgrade' event.)
   */
  _handleWebSocketUpgrade(url) {
    const wsUrl = url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    const wsKey = String(this.getHeader('sec-websocket-key') || '');
    const NativeWS = _NativeWebSocket;

    if (!NativeWS) {
      queueMicrotask(() => {
        this.emit('error', new TypeError('WebSocket is not available in this environment'));
      });
      return;
    }

    // RFC 6455 §1.3: Sec-WebSocket-Accept = base64(sha1(key + GUID)).
    const acceptValue = _sha1Base64(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');

    let nativeWs;
    try {
      nativeWs = new NativeWS(wsUrl);
      nativeWs.binaryType = 'arraybuffer';
    } catch (e) {
      queueMicrotask(() => {
        this.emit('error', e instanceof Error ? e : new Error(String(e)));
      });
      return;
    }

    const socket = this.socket;
    if (typeof socket.cork !== 'function') socket.cork = () => {};
    if (typeof socket.uncork !== 'function') socket.uncork = () => {};

    let writeBuffer = new Uint8Array(0);
    socket.write = (chunk, encodingOrCallback, callback) => {
      const data = typeof chunk === 'string'
        ? Buffer.from(chunk)
        : new Uint8Array(chunk);
      const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      const next = new Uint8Array(writeBuffer.length + data.length);
      next.set(writeBuffer, 0);
      next.set(data, writeBuffer.length);
      writeBuffer = next;

      while (writeBuffer.length >= 2) {
        const parsed = _parseWsFrame(writeBuffer);
        if (!parsed) break;
        const { opcode, payload, totalLength } = parsed;
        writeBuffer = writeBuffer.slice(totalLength);
        if (nativeWs.readyState !== NativeWS.OPEN) continue;

        if (opcode === 0x08) nativeWs.close();
        else if (opcode === 0x09) nativeWs.send(payload); // ping -> pong-ish
        else if (opcode === 0x0a) { /* pong: ignore */ }
        else if (opcode === 0x01) nativeWs.send(new TextDecoder().decode(payload));
        else if (opcode === 0x02) nativeWs.send(payload);
      }
      if (cb) queueMicrotask(() => cb(null));
      return true;
    };

    nativeWs.onopen = () => {
      const response = new IncomingMessage(socket);
      response.statusCode = 101;
      response.statusMessage = 'Switching Protocols';
      response.headers = {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-accept': acceptValue,
      };
      response.rawHeaders.push(
        'upgrade', 'websocket',
        'connection', 'Upgrade',
        'sec-websocket-accept', acceptValue,
      );
      response.complete = true;
      response.push(null);
      this.emit('upgrade', response, socket, Buffer.alloc(0));
    };

    nativeWs.onmessage = (event) => {
      let payload;
      let opcode;
      if (typeof event.data === 'string') {
        payload = new TextEncoder().encode(event.data);
        opcode = 0x01;
      } else if (event.data instanceof ArrayBuffer) {
        payload = new Uint8Array(event.data);
        opcode = 0x02;
      } else {
        return;
      }
      socket.emit('data', Buffer.from(_createWsFrame(opcode, payload, false)));
    };

    nativeWs.onclose = (event) => {
      const code = event.code || 1000;
      const closePayload = new Uint8Array(2);
      closePayload[0] = (code >> 8) & 0xff;
      closePayload[1] = code & 0xff;
      socket.emit('data', Buffer.from(_createWsFrame(0x08, closePayload, false)));
      setTimeout(() => {
        socket.emit('end');
        socket.emit('close', false);
      }, 10);
    };

    nativeWs.onerror = () => {
      socket.emit('error', new Error('WebSocket connection error'));
      socket.destroy();
    };

    const origDestroy = socket.destroy.bind(socket);
    socket.destroy = (error) => {
      if (nativeWs.readyState === NativeWS.OPEN ||
          nativeWs.readyState === NativeWS.CONNECTING) {
        try { nativeWs.close(); } catch { /* noop */ }
      }
      return origDestroy(error);
    };
  }
}

// ---------------------------------------------------------------------------
// 9. Pure-JS SHA-1 (for Sec-WebSocket-Accept; dependency-free).
// ---------------------------------------------------------------------------
function _sha1Base64(ascii) {
  const bytes = [];
  for (let i = 0; i < ascii.length; i++) bytes.push(ascii.charCodeAt(i) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64-bit big-endian length
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push(
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  );

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE,
      h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const w = new Array(80);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
              (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const tmp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  for (const [i, h] of [[0, h0], [1, h1], [2, h2], [3, h3], [4, h4]]) {
    digest[i * 4] = (h >>> 24) & 0xff;
    digest[i * 4 + 1] = (h >>> 16) & 0xff;
    digest[i * 4 + 2] = (h >>> 8) & 0xff;
    digest[i * 4 + 3] = h & 0xff;
  }
  // base64 (binary-safe, no btoa dependency assumptions)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < digest.length; i += 3) {
    const b0 = digest[i], b1 = digest[i + 1] ?? 0, b2 = digest[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += chars[(n >>> 18) & 63] + chars[(n >>> 12) & 63] +
           (i + 1 < digest.length ? chars[(n >>> 6) & 63] : '=') +
           (i + 2 < digest.length ? chars[n & 63] : '=');
  }
  return out;
}

// ---------------------------------------------------------------------------
// 10. WebSocket frame helpers (kept from the previous shim).
// ---------------------------------------------------------------------------
function _parseWsFrame(data) {
  if (data.length < 2) return null;

  const opcode = data[0] & 0x0f;
  const masked = (data[1] & 0x80) !== 0;
  let payloadLength = data[1] & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (data.length < 4) return null;
    payloadLength = (data[2] << 8) | data[3];
    offset = 4;
  } else if (payloadLength === 127) {
    if (data.length < 10) return null;
    payloadLength = (data[6] * 0x1000000) + ((data[7] << 16) | (data[8] << 8) | data[9]);
    offset = 10;
  }

  if (masked) {
    if (data.length < offset + 4 + payloadLength) return null;
    const maskKey = data.slice(offset, offset + 4);
    offset += 4;
    const payload = new Uint8Array(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = data[offset + i] ^ maskKey[i % 4];
    }
    return { opcode, payload, totalLength: offset + payloadLength };
  }

  if (data.length < offset + payloadLength) return null;
  return {
    opcode,
    payload: data.slice(offset, offset + payloadLength),
    totalLength: offset + payloadLength,
  };
}

function _createWsFrame(opcode, payload, masked) {
  const length = payload.length;
  let headerSize = 2;
  if (length > 125 && length <= 65535) headerSize += 2;
  else if (length > 65535) headerSize += 8;
  if (masked) headerSize += 4;

  const frame = new Uint8Array(headerSize + length);
  frame[0] = 0x80 | opcode; // FIN + opcode

  let offset = 2;
  if (length <= 125) {
    frame[1] = (masked ? 0x80 : 0) | length;
  } else if (length <= 65535) {
    frame[1] = (masked ? 0x80 : 0) | 126;
    frame[2] = (length >> 8) & 0xff;
    frame[3] = length & 0xff;
    offset = 4;
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127;
    frame[6] = (length >>> 24) & 0xff;
    frame[7] = (length >>> 16) & 0xff;
    frame[8] = (length >>> 8) & 0xff;
    frame[9] = length & 0xff;
    offset = 10;
  }

  if (masked) {
    const maskKey = new Uint8Array(4);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(maskKey);
    } else {
      for (let i = 0; i < 4; i++) maskKey[i] = Math.floor(Math.random() * 256);
    }
    frame.set(maskKey, offset);
    offset += 4;
    for (let i = 0; i < length; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i % 4];
    }
  } else {
    frame.set(payload, offset);
  }
  return frame;
}

// ---------------------------------------------------------------------------
// 11. Server — virtual (no TCP in the browser). listen() registers the server
//     in the in-process registry; the host runtime delivers emulated inbound
//     requests via __httpServerRunTime.handleRequest.
// ---------------------------------------------------------------------------
const serverRegistry = new Map();

let _waitForServersPromise = null;
let _waitForServersResolve = null;

function _resolveWaitForServers() {
  if (_waitForServersResolve) {
    const resolve = _waitForServersResolve;
    _waitForServersPromise = null;
    _waitForServersResolve = null;
    resolve();
  }
}

/** Resolves when every virtual server has closed (runtime completion hook). */
function _waitForAllServers() {
  if (serverRegistry.size === 0) {
    return Promise.resolve();
  }
  if (!_waitForServersPromise) {
    _waitForServersPromise = new Promise((resolve) => {
      _waitForServersResolve = resolve;
    });
  }
  return _waitForServersPromise;
}

function _registerServer(port, server) {
  serverRegistry.set(port, server);
}

function _unregisterServer(port) {
  serverRegistry.delete(port);
  if (serverRegistry.size === 0) {
    _resolveWaitForServers();
  }
}

function getServer(port) {
  return serverRegistry.get(port);
}

function getAllServers() {
  return new Map(serverRegistry);
}

class ServerBase extends EventEmitter {
  constructor(optionsOrListener, requestListener) {
    super();
    let options;
    if (typeof optionsOrListener === 'function') {
      requestListener = optionsOrListener;
      options = {};
    } else if (optionsOrListener == null) {
      options = {};
    } else if (typeof optionsOrListener === 'object' && !Array.isArray(optionsOrListener)) {
      options = optionsOrListener;
    } else {
      throw ERR_INVALID_ARG_TYPE('options', ['Object', 'Function'], optionsOrListener);
    }
    this._requestListener = requestListener;
    if (requestListener) {
      this.on('request', requestListener);
    }

    this.listening = false;
    this.maxHeadersCount = null;
    this.maxRequestsPerSocket = options.maxRequestsPerSocket ?? 0;
    this.timeout = 0;
    this.headersTimeout = options.headersTimeout ?? 60000;
    this.requestTimeout = options.requestTimeout ?? 300000;
    this.keepAliveTimeout = options.keepAliveTimeout ?? 5000;
    this.connectionsCheckingInterval = options.connectionsCheckingInterval ?? 30000;
    this._port = null;
    this._host = null;
  }

  listen(portOrOptions, hostOrCallback, callback) {
    let port;
    let host;
    let cb;

    if (typeof portOrOptions === 'number' || typeof portOrOptions === 'string') {
      port = Number(portOrOptions);
      if (typeof hostOrCallback === 'string') {
        host = hostOrCallback;
        cb = callback;
      } else {
        cb = hostOrCallback;
      }
    } else if (portOrOptions && typeof portOrOptions === 'object') {
      port = portOrOptions.port !== undefined ? Number(portOrOptions.port) : port;
      host = portOrOptions.host;
      cb = typeof hostOrCallback === 'function' ? hostOrCallback : callback;
    } else if (typeof portOrOptions === 'function') {
      cb = portOrOptions;
    } else if (portOrOptions == null && typeof hostOrCallback === 'function') {
      cb = hostOrCallback;
    }

    if (!port || Number.isNaN(port)) {
      // Ephemeral port, like Node's listen(0).
      do {
        port = 1024 + Math.floor(Math.random() * (65535 - 1024));
      } while (serverRegistry.has(port));
    }

    if (serverRegistry.has(port)) {
      const err = makeError('EADDRINUSE',
        `listen EADDRINUSE: address already in use :::${port}`);
      err.port = port;
      queueMicrotask(() => this.emit('error', err));
      return this;
    }

    this._port = port;
    this._host = host || '::';
    _registerServer(port, this);
    this.listening = true;
    emitEvent?.('serverListening', { port });
    queueMicrotask(() => {
      this.emit('listening');
      if (cb) cb.call(this);
    });
    return this;
  }

  close(callback) {
    if (typeof callback === 'function') {
      if (!this.listening) queueMicrotask(callback);
      else this.once('close', callback);
    }
    if (this._port !== null) {
      const port = this._port;
      this._port = null;
      _unregisterServer(port);
      emitEvent?.('serverClosed', { port });
    }
    this.listening = false;
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  closeAllConnections() {}
  closeIdleConnections() {}

  address() {
    if (!this.listening || this._port === null) return null;
    return { address: this._host, family: 'IPv6', port: this._port };
  }

  getConnections(callback) {
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, 0));
    }
    return this;
  }

  setTimeout(msecs, callback) {
    this.timeout = msecs || 0;
    if (callback) this.on('timeout', callback);
    return this;
  }

  ref() { return this; }
  unref() { return this; }

  /**
   * Handle an emulated inbound request (called by the runtime bridge).
   * Returns a promise for { statusCode, statusMessage, headers, body }.
   */
  async handleRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const req = IncomingMessage.fromRequest(method, url, headers, body);
      const res = new ServerResponse(req);
      res._setResolver(resolve);

      let timeoutId = null;
      if (this.timeout) {
        timeoutId = setTimeout(() => {
          reject(makeError('ERR_HTTP_REQUEST_TIMEOUT', 'Request timeout'));
        }, this.timeout);
        timeoutId.unref?.();
      }
      res.once('finish', () => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      queueMicrotask(() => {
        try {
          this.emit('request', req, res);
        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId);
          reject(error);
        }
      });
    });
  }
}

/** Create a virtual HTTP server. */
export function createServer(optionsOrListener, requestListener) {
  return new Server(optionsOrListener, requestListener);
}

/**
 * Node's Server is a classic function constructor, so `http.Server(listener)`
 * without `new` works (several official tests rely on this). The wrapper
 * preserves that; subclassing keeps working through Reflect.construct's
 * new.target forwarding.
 */
export function Server(...args) {
  return Reflect.construct(ServerBase, args, new.target ?? Server);
}
Object.setPrototypeOf(Server, ServerBase);
Server.prototype = ServerBase.prototype;

/**
 * Wire a raw connection source to the server (Node calls this per TCP
 * connection). Without raw sockets there is nothing to parse; the function
 * exists so code that references it keeps working, and it emits
 * 'connection' for synthetic sockets handed to it.
 */
export function _connectionListener(socket) {
  const server = this;
  server.emit('connection', socket);
}

// ---------------------------------------------------------------------------
// 12. Agent — connection-pool metadata only; the browser owns real sockets.
// ---------------------------------------------------------------------------
class AgentBase extends EventEmitter {
  constructor(options) {
    super();
    const opts = { __proto__: null, ...(options || {}) };
    this.options = opts;

    this.defaultPort = opts.defaultPort || 80;
    this.protocol = opts.protocol || 'http:';
    this.keepAliveMsecs = opts.keepAliveMsecs || 1000;
    this.keepAlive = opts.keepAlive || false;
    this.maxSockets = opts.maxSockets || AgentBase.defaultMaxSockets;
    this.maxFreeSockets = opts.maxFreeSockets || 256;
    this.scheduling = opts.scheduling || 'lifo';
    if (this.scheduling !== 'fifo' && this.scheduling !== 'lifo') {
      throw ERR_INVALID_ARG_VALUE(
        'scheduling', this.scheduling, "must be one of: 'fifo', 'lifo'.");
    }
    this.maxTotalSockets = opts.maxTotalSockets;
    if (this.maxTotalSockets !== undefined) {
      if (typeof this.maxTotalSockets !== 'number' || this.maxTotalSockets < 1) {
        throw ERR_OUT_OF_RANGE('maxTotalSockets', '>= 1', this.maxTotalSockets);
      }
    } else {
      this.maxTotalSockets = Infinity;
    }

    this.requests = { __proto__: null };
    this.sockets = { __proto__: null };
    this.freeSockets = { __proto__: null };
    this.totalSocketCount = 0;
  }

  /** No real sockets in the browser: hand out a synthetic placeholder. */
  createConnection(_options, callback) {
    const socket = new FakeSocket();
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, socket));
    }
    return socket;
  }

  createSocket(req, options, callback) {
    const name = this.getName(options);
    const socket = this.createConnection(options, callback);
    (this.sockets[name] ??= []).push(socket);
    return socket;
  }

  getName(options = {}) {
    const host = options.host || options.hostname || 'localhost';
    const port = options.port || this.defaultPort || 80;
    return `${host}:${port}:${options.localAddress || ''}`;
  }

  addRequest(_req, _options) {
    // Browsers pool connections natively; fetch() is issued directly.
  }

  removeSocket(_socket, _options) {}
  keepSocketAlive(_socket) { return true; }
  reuseSocket(_socket, _req) {}

  destroy() {
    this.sockets = { __proto__: null };
    this.freeSockets = { __proto__: null };
    this.requests = { __proto__: null };
    this.totalSocketCount = 0;
  }
}
AgentBase.defaultMaxSockets = Infinity;

/**
 * Node's Agent is a classic function constructor: `http.Agent(options)`
 * without `new` works. Same wrapper pattern as Server.
 */
export function Agent(...args) {
  return Reflect.construct(AgentBase, args, new.target ?? Agent);
}
Object.setPrototypeOf(Agent, AgentBase);
Agent.prototype = AgentBase.prototype;

/** The default agent used when none is supplied. */
export const globalAgent = new Agent({ keepAlive: true, scheduling: 'lifo', timeout: 5000 });

// ---------------------------------------------------------------------------
// 13. request / get.
// ---------------------------------------------------------------------------
export function request(urlOrOptions, optionsOrCallback, callback) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions, optionsOrCallback, callback);
  const req = new ClientRequest(options, undefined, cb);
  return req;
}

export function get(urlOrOptions, optionsOrCallback, callback) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions, optionsOrCallback, callback);
  const req = new ClientRequest({ __proto__: null, ...options, method: 'GET' }, undefined, cb);
  req.end();
  return req;
}

/**
 * Internal: build a client request with an explicit default protocol/agent.
 * Used by the https module (avoids an import cycle: https -> http only).
 */
function _createClientRequest(
  urlOrOptions, optionsOrCallback, callback, defaultProtocol, defaultAgent) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions, optionsOrCallback, callback);
  if (defaultProtocol && options.protocol === undefined) {
    options.protocol = defaultProtocol;
  }
  return new ClientRequest(options, undefined, cb, defaultAgent);
}

// ---------------------------------------------------------------------------
// 14. Runtime bridge: publish __httpServerRunTime (guarded — never create a
//     a placeholder runtime object outside the sandbox).
// ---------------------------------------------------------------------------
/**
 * Entry point for emulated inbound requests.
 *
 * Documented runtime signature: handleRequest(port, url, method, body, headers).
 * The previous shim used (port, method, url, headers, body); both orders are
 * accepted — the URL/method positions are disambiguated by shape (methods are
 * uppercase tokens, URLs start with '/').
 */
async function handleRequest(port, urlOrMethod, methodOrUrl, bodyOrHeaders, headersOrBody) {
  let url = urlOrMethod;
  let method = methodOrUrl;
  let body = bodyOrHeaders;
  let headers = headersOrBody;
  if (typeof urlOrMethod === 'string' && /^[A-Z]+$/.test(urlOrMethod) &&
      typeof methodOrUrl === 'string' && methodOrUrl.startsWith('/')) {
    // Legacy order: (port, method, url, headers, body).
    method = urlOrMethod;
    url = methodOrUrl;
    headers = bodyOrHeaders;
    body = headersOrBody;
  }

  let server = serverRegistry.get(port);
  if (!server) {
    throw makeError('ERR_NO_SERVER', `No active HTTP server found for port ${port}`);
  }
  return server.handleRequest(method, url, headers, body);
}

if (RT) {
  RT.__httpServerRunTime = {
    handleRequest,
    waitForAllServers: _waitForAllServers,
  };
}

// ---------------------------------------------------------------------------
// 15. Undici WebSocket globals (node:http re-exports them; in the browser the
//     globals are native).
// ---------------------------------------------------------------------------
export const WebSocket = _NativeWebSocket;
export const CloseEvent =
  typeof globalThis.CloseEvent === 'function' ? globalThis.CloseEvent : undefined;
export const MessageEvent =
  typeof globalThis.MessageEvent === 'function' ? globalThis.MessageEvent : undefined;

// ---------------------------------------------------------------------------
// 16. Module exports.
// ---------------------------------------------------------------------------
export default {
  _connectionListener,
  METHODS,
  STATUS_CODES,
  Agent,
  ClientRequest,
  IncomingMessage,
  OutgoingMessage,
  Server,
  ServerResponse,
  createServer,
  validateHeaderName,
  validateHeaderValue,
  get,
  request,
  setMaxIdleHTTPParsers,
  setGlobalProxyFromEnv,
  maxHeaderSize,
  globalAgent,
  getServer,
  getAllServers,
  // kHighWaterMark / default export additions
  kHighWaterMark,
  kUniqueHeaders,
  WebSocket,
  CloseEvent,
  MessageEvent,
  _createClientRequest,
  _parseWsFrame,
  _createWsFrame,
};
