// src/http.js — port of node:http (Node v24.20.0) for the browser runtime.
//
// Browser strategy:
//   * Client (ClientRequest / request / get) is backed by fetch(). The browser
//     owns TLS and connection pooling, so Agent socket pooling is metadata
//     only (best-effort options, no real sockets).
//   * Server is virtual: listen() registers the server in an in-process
//     registry keyed by port AND binds a real in-memory socket server via
//     src/net.js, so req.socket / res.socket are genuine connected sockets
//     (remoteAddress, bytesRead/bytesWritten, getConnections all real).
//     The host runtime delivers emulated inbound requests through
//     globalThis._RUNTIME_.__httpServerRunTime.handleRequest.
//   * Header validation, STATUS_CODES, METHODS, and the OutgoingMessage /
//     IncomingMessage / ServerResponse state machines are ported faithfully
//     from Node's lib/ (see /tmp/node-lib for the reference sources).
//
// Differences from Node you should know about:
//   * fetch() follows redirects automatically; Node's http client does not.
//     There is no way to observe the 3xx hop in a browser (redirect:'manual'
//     yields an opaque response), so redirects are followed and documented.
//   * No raw TCP to the outside world: external client requests stay on
//     fetch(). Trailers are unsupported.

import { EventEmitter } from "events";
import { Readable, Writable } from "stream";
// NOTE: imported from the relative path, NOT bare "stream": the esbuild
// browser build resolves bare "stream" to node-modules-polyfills:stream,
// which does not export getDefaultHighWaterMark (that import broke the
// build — CI build failure on PR #268's first head, reproduced locally).
import { getDefaultHighWaterMark } from "./stream/state.js";
import { Buffer } from "buffer";
import {
  _checkInvalidHeaderChar,
  _checkIsHttpToken,
  parsers,
} from "./_http_common.js";
import { kUniqueHeaders, kHighWaterMark } from "./internals/http-symbols.js";
import { HTTPParser } from "./_http_parser.js";
import {
  connect as netConnect,
  createServer as createNetServer,
  hasTcpServer as netHasTcpServer,
} from "./net.js";

// ---------------------------------------------------------------------------
// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
// ---------------------------------------------------------------------------
const RT =
  typeof globalThis._RUNTIME_ !== "undefined"
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
function makeError(code, message, Constructor = Error) {
  const err = new Constructor(message);
  err.code = code;
  return err;
}

const ERR_INVALID_HTTP_TOKEN = (kind, val) =>
  makeError(
    "ERR_INVALID_HTTP_TOKEN",
    `${kind} must be a valid HTTP token [${JSON.stringify(String(val))}]`,
    TypeError,
  );
const ERR_INVALID_CHAR = (kind, val) =>
  makeError(
    "ERR_INVALID_CHAR",
    val === undefined
      ? `Invalid character in ${kind}`
      : `Invalid character in ${kind} [${JSON.stringify(String(val))}]`,
    TypeError,
  );
const ERR_HTTP_INVALID_HEADER_VALUE = (value, name) =>
  makeError(
    "ERR_HTTP_INVALID_HEADER_VALUE",
    `Invalid value ${JSON.stringify(String(value))} for header ${JSON.stringify(String(name))}`,
    TypeError,
  );
const ERR_HTTP_HEADERS_SENT = (op) =>
  makeError(
    "ERR_HTTP_HEADERS_SENT",
    op === "write"
      ? "Cannot write headers after they are sent to the client"
      : `Cannot ${op} headers after they are sent to the client`,
  );
const ERR_HTTP_INVALID_STATUS_CODE = (code) =>
  makeError("ERR_HTTP_INVALID_STATUS_CODE", `Invalid status code: ${code}`);
const ERR_HTTP_TRAILER_INVALID = () =>
  makeError(
    "ERR_HTTP_TRAILER_INVALID",
    "Trailers are invalid with this transfer encoding",
  );
const ERR_INVALID_ARG_TYPE = (name, expected, actual) =>
  makeError(
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be ${expected}. Received type ${typeof actual} (${String(actual)})`,
  );
// Node's options-property validation shape (used by http.request's agent
// check): "property", TypeError, and the invalidArgTypeHelper suffix
// (object → "an instance of <Ctor>", function → "function <name>",
// otherwise "type <typeof> (<inspect>)"). The shared factory above says
// "argument" with a plain Error, which is right for true arguments but
// wrong for options properties (test-http-client-reject-unexpected-agent).
const _invalidArgTypeSuffix = (actual) => {
  if (actual == null) return ` Received ${actual}`;
  if (typeof actual === "function") return ` Received function ${actual.name}`;
  if (typeof actual === "object") {
    if (actual.constructor?.name) {
      return ` Received an instance of ${actual.constructor.name}`;
    }
    return " Received [Object: null prototype] {}";
  }
  let inspected = typeof actual === "string" ? `'${actual}'` : String(actual);
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return ` Received type ${typeof actual} (${inspected})`;
};
const ERR_INVALID_ARG_TYPE_PROPERTY = (name, expected, actual) => {
  const err = new TypeError(
    `The "${name}" property must be ${expected}.${_invalidArgTypeSuffix(actual)}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
};
const ERR_INVALID_ARG_VALUE = (name, value, reason) =>
  makeError(
    "ERR_INVALID_ARG_VALUE",
    `The argument '${name}' is invalid.${reason ? ` ${reason}` : ""} Received ${JSON.stringify(value)}`,
  );
const ERR_OUT_OF_RANGE = (name, range, received) =>
  makeError(
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${received}`,
  );
const ERR_INVALID_PROTOCOL = (protocol, expected) =>
  makeError(
    "ERR_INVALID_PROTOCOL",
    `Protocol "${protocol}" not supported. Expected "${expected}"`,
  );
const ERR_UNESCAPED_CHARACTERS = (what) =>
  makeError(
    "ERR_UNESCAPED_CHARACTERS",
    `${what} contains unescaped characters`,
  );

// Chunk validation for OutgoingMessage.write()/end(), mirroring Node's
// write_ (probed v24.22.1): validation runs BEFORE _implicitHeader and
// before the destroyed check, so a bad chunk throws synchronously even
// on a destroyed message, and a failed end() leaves `finished` unset so
// a retry still delivers (test-http-outgoing-end-types,
// test-http-outgoing-write-types). The ported Writable's own message
// ("Buffer, TypedArray, or DataView") differs from Node's http message,
// so the check lives here, ahead of super.write().
const ERR_STREAM_NULL_VALUES = () =>
  makeError(
    "ERR_STREAM_NULL_VALUES",
    "May not write null values to stream",
    TypeError,
  );
function invalidChunkReceived(chunk) {
  if (chunk === undefined) return "undefined";
  if (typeof chunk === "object") {
    const name = chunk.constructor ? chunk.constructor.name : "Object";
    return `an instance of ${name}`;
  }
  if (typeof chunk === "function") {
    return `function ${chunk.name || "anonymous"}`;
  }
  return `type ${typeof chunk} (${String(chunk)})`;
}
const ERR_INVALID_CHUNK_TYPE = (chunk) =>
  makeError(
    "ERR_INVALID_ARG_TYPE",
    `The "chunk" argument must be of type string or an instance of ` +
      `Buffer or Uint8Array. Received ${invalidChunkReceived(chunk)}`,
    TypeError,
  );
function validateOutgoingChunk(chunk) {
  if (chunk === null) throw ERR_STREAM_NULL_VALUES();
  if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
    throw ERR_INVALID_CHUNK_TYPE(chunk);
  }
}

function validateString(value, name) {
  if (typeof value !== "string") {
    throw ERR_INVALID_ARG_TYPE(name, "of type string", value);
  }
}

// ---------------------------------------------------------------------------
// 3. Constants — STATUS_CODES (63 entries) and METHODS (35, sorted),
//    verbatim from Node v24.20.0.
// ---------------------------------------------------------------------------
export const STATUS_CODES = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Payload Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Entity",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  509: "Bandwidth Limit Exceeded",
  510: "Not Extended",
  511: "Network Authentication Required",
};

export const METHODS = [
  "ACL",
  "BIND",
  "CHECKOUT",
  "CONNECT",
  "COPY",
  "DELETE",
  "GET",
  "HEAD",
  "LINK",
  "LOCK",
  "M-SEARCH",
  "MERGE",
  "MKACTIVITY",
  "MKCALENDAR",
  "MKCOL",
  "MOVE",
  "NOTIFY",
  "OPTIONS",
  "PATCH",
  "POST",
  "PROPFIND",
  "PROPPATCH",
  "PURGE",
  "PUT",
  "QUERY",
  "REBIND",
  "REPORT",
  "SEARCH",
  "SOURCE",
  "SUBSCRIBE",
  "TRACE",
  "UNBIND",
  "UNLINK",
  "UNLOCK",
  "UNSUBSCRIBE",
];

/** Default --max-http-header-size in Node v24 (no CLI flags in a browser). */
export const maxHeaderSize = 16384;

/** Matches Node: validates and writes the parser-cap on the shared parsers cell (src/_http_common.js). No pool exists in the browser — only the cap is observable. */
export function setMaxIdleHTTPParsers(max) {
  if (typeof max !== "number") {
    throw ERR_INVALID_ARG_TYPE("max", "number", max);
  }
  if (!Number.isInteger(max)) {
    throw ERR_OUT_OF_RANGE("max", "an integer", max);
  }
  if (max < 1 || max > Number.MAX_SAFE_INTEGER) {
    throw ERR_OUT_OF_RANGE("max", ">= 1 && <= 9007199254740991", max);
  }
  parsers.max = max;
}

/**
 * Node reads proxy env and rewrites client requests to absolute-form.
 * Browsers apply their own proxy configuration to fetch(); nothing to do.
 */
export function setGlobalProxyFromEnv() {}

/** Throw unless name is a valid HTTP token (Node's validateHeaderName). */
export function validateHeaderName(name) {
  if (typeof name !== "string" || !name || !_checkIsHttpToken(name)) {
    throw ERR_INVALID_HTTP_TOKEN("Header name", name);
  }
}

/** Throw unless value holds no invalid header chars (Node's validateHeaderValue). */
export function validateHeaderValue(name, value) {
  if (value === undefined) {
    throw ERR_HTTP_INVALID_HEADER_VALUE(value, name);
  }
  if (_checkInvalidHeaderChar(String(value))) {
    throw ERR_INVALID_CHAR("header content", name);
  }
}

/**
 * Normalize ClientRequest array-form headers to [[name, value], ...]
 * pairs, preserving order and casing so duplicates survive to the wire
 * as separate lines. Probed on real Node v24.22.1:
 * - array of [name, value] pairs, or a flat [name, value, ...] array;
 * - odd-length flat arrays throw ERR_INVALID_ARG_VALUE at construction;
 * - an undefined value throws ERR_HTTP_INVALID_HEADER_VALUE (this is
 *   also what a non-array entry in pairs mode, or a short pair,
 *   reduces to: [entry, undefined]);
 * - number values are coerced to strings (wire shows "5").
 */
function normalizeArrayHeaders(headers) {
  const pairs = [];
  if (headers.length === 0) return pairs;
  if (Array.isArray(headers[0])) {
    for (const entry of headers) {
      const name = Array.isArray(entry) ? entry[0] : entry;
      const value = Array.isArray(entry) ? entry[1] : undefined;
      validateHeaderName(name);
      // An array value expands to one pair per element (probed: a
      // ["cookie", ["a=1", "b=2", "c=3"]] pair reaches the server as
      // three cookie lines, joined there with "; ").
      if (Array.isArray(value)) {
        for (const el of value) {
          validateHeaderValue(name, el);
          pairs.push([name, String(el)]);
        }
      } else {
        validateHeaderValue(name, value);
        pairs.push([name, String(value)]);
      }
    }
  } else {
    if (headers.length % 2 !== 0) {
      throw ERR_INVALID_ARG_VALUE("headers", headers);
    }
    for (let n = 0; n < headers.length; n += 2) {
      validateHeaderName(headers[n]);
      // An array value expands to one pair per element, as in pairs mode.
      const value = headers[n + 1];
      if (Array.isArray(value)) {
        for (const el of value) {
          validateHeaderValue(headers[n], el);
          pairs.push([headers[n], String(el)]);
        }
      } else {
        validateHeaderValue(headers[n], value);
        pairs.push([headers[n], String(value)]);
      }
    }
  }
  return pairs;
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
    this.remoteAddress = "127.0.0.1";
    this.remotePort = 0;
    this.localAddress = "127.0.0.1";
    this.localPort = 0;
  }
  write(chunk, encoding, cb) {
    const callback = typeof encoding === "function" ? encoding : cb;
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
      if (err) this.emit("error", err);
      this.emit("close", false);
    });
    return this;
  }
  address() {
    return { address: this.localAddress, family: "IPv4", port: this.localPort };
  }
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  cork() {}
  uncork() {}
}

// Module-local symbols mirroring Node's internal slots.
// (kUniqueHeaders / kHighWaterMark live in ./internals/http-symbols.js so the
// http module family shares them without exposing them on the public surface.)
const kOutHeaders = Symbol("kOutHeaders");
const kPath = Symbol("kPath");

const INVALID_PATH_REGEX = /[^\u0021-\u00ff]/;

// ---------------------------------------------------------------------------
// 5. OutgoingMessage — port of node:_http_outgoing (Writable-based).
// ---------------------------------------------------------------------------
export class OutgoingMessage extends Writable {
  constructor(options) {
    super({ highWaterMark: options?.highWaterMark });
    // Node: the symbol always reads a value — the default when no option
    // is given (probed real Node v24.22.1: server res and client req both
    // read getDefaultHighWaterMark(), 65536, with no option).
    this[kHighWaterMark] =
      options?.highWaterMark ?? getDefaultHighWaterMark(false);
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
    // Bare OutgoingMessage instances bypass Writable buffering (see
    // write()): their buffered bytes live only in outputData/outputSize,
    // so writableLength must read outputSize to match real Node
    // (test-http-outgoing-properties: write("asd") → writableLength 3).
    // Subclasses keep the Writable getter: their writes flow through
    // Writable state (streaming, pipelining, drain timing).
    if (new.target === OutgoingMessage) {
      Object.defineProperty(this, "writableLength", {
        configurable: true,
        get() {
          return this.outputSize;
        },
      });
    }
    this.socket = null;
    this.connection = null;
    this._trailer = null;
  }

  // Buffer written chunks until the message is finished (no real socket).
  // The callback is deferred to a microtask, not invoked synchronously:
  // real Node fires write callbacks only once the buffered data is
  // flushed (for a pre-connect client request, after the socket connects),
  // never during write() itself. A synchronous callback would drain
  // Writable's length accounting before write() computes its return
  // value, so write() would always return true regardless of
  // highWaterMark (test-http-client-highwatermark Test 3: a 2KB write
  // with HWM 512 must return false, with 'drain' firing after the
  // buffer flushes). Buffering itself stays synchronous — only the
  // callback timing changes, so outputData/outputSize reads after
  // write() are unaffected.
  _write(chunk, encoding, callback) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.outputData.push({ data: buf, encoding: "buffer" });
    this.outputSize += buf.length;
    queueMicrotask(callback);
  }

  get headersSent() {
    // Array-form request headers count as sent from construction
    // (probed on real Node v24.22.1: headersSent is true and setHeader
    // throws immediately). _headersArray exists only on ClientRequest.
    return !!this._header || !!this._headersArray;
  }

  get writableEnded() {
    return this.finished;
  }

  _isLenientHeaderValidation() {
    return false;
  }

  setHeader(name, value) {
    if (this._header || this._headersArray) {
      throw ERR_HTTP_HEADERS_SENT("set");
    }
    validateHeaderName(name);
    if (value === undefined) {
      throw ERR_HTTP_INVALID_HEADER_VALUE(value, name);
    }
    if (
      _checkInvalidHeaderChar(String(value), this._isLenientHeaderValidation())
    ) {
      throw ERR_INVALID_CHAR("header content", name);
    }

    let headers = this[kOutHeaders];
    if (headers === null) {
      this[kOutHeaders] = headers = { __proto__: null };
    }
    headers[name.toLowerCase()] = [name, value];
    return this;
  }

  setHeaders(headers) {
    if (this._header || this._headersArray) {
      throw ERR_HTTP_HEADERS_SENT("set");
    }
    if (
      !headers ||
      Array.isArray(headers) ||
      typeof headers.keys !== "function" ||
      typeof headers.get !== "function"
    ) {
      throw ERR_INVALID_ARG_TYPE(
        "headers",
        "an instance of Headers or Map",
        headers,
      );
    }

    // set-cookie values are collected so setHeader does not overwrite them.
    let cookies = null;
    for (const { 0: key, 1: value } of headers) {
      if (String(key).toLowerCase() === "set-cookie") {
        cookies ??= [];
        if (Array.isArray(value)) cookies.push(...value);
        else cookies.push(value);
        continue;
      }
      this.setHeader(key, value);
    }
    if (cookies !== null) {
      this.setHeader("set-cookie", cookies);
    }
    return this;
  }

  appendHeader(name, value) {
    if (this._header || this._headersArray) {
      throw ERR_HTTP_HEADERS_SENT("append");
    }
    validateHeaderName(name);
    if (value === undefined) {
      throw ERR_HTTP_INVALID_HEADER_VALUE(value, name);
    }
    if (
      _checkInvalidHeaderChar(String(value), this._isLenientHeaderValidation())
    ) {
      throw ERR_INVALID_CHAR("header content", name);
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
    validateString(name, "name");
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
    validateString(name, "name");
    return (
      this[kOutHeaders] !== null && !!this[kOutHeaders][name.toLowerCase()]
    );
  }

  removeHeader(name) {
    validateString(name, "name");
    if (this._header || this._headersArray) {
      throw ERR_HTTP_HEADERS_SENT("remove");
    }
    const key = name.toLowerCase();
    switch (key) {
      case "connection":
        this._removedConnection = true;
        break;
      case "content-length":
        this._removedContLen = true;
        break;
      case "transfer-encoding":
        this._removedTE = true;
        break;
      case "date":
        // Probed real Node v24.22.1: removeHeader('date') suppresses the
        // auto Date header (test-http-multiple-headers expects no Date
        // line after removing it).
        this._removedDate = true;
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
      if (key === "set-cookie") {
        // Accumulate across calls: each set-cookie value stays a separate
        // array entry so the cookie jar can store every cookie.
        const cur = flat[key];
        const arr = Array.isArray(cur) ? cur : cur === undefined ? [] : [cur];
        flat[key] = arr.concat(values.map(String));
      } else {
        flat[key] = values.map(String).join(", ");
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
            throw ERR_INVALID_ARG_VALUE("headers", headers);
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
    header += lines.join("");
    // Real Node renders app headers first, in insertion order, and only
    // then the auto headers (Date, Connection, Keep-Alive, ...). Previously
    // the auto Date was prepended ahead of app headers, so a response with
    // an app-set Connection header started "Date: ...\r\nConnection: ..."
    // instead of "Connection: ...\r\nDate: ..." (test-http-server-close-idle).
    if (this.sendDate && !flat.date && !this._removedDate) {
      const date = new Date().toUTCString();
      header += `Date: ${date}\r\n`;
      flat.date = date;
    }
    // Node's server response framing (probed on real Node v24.22.1):
    // an app-set Connection header always wins — it is never overridden
    // and never supplemented with Keep-Alive. Otherwise the header
    // reflects whether the connection will be kept alive: keep-alive
    // gets `Connection: keep-alive` plus `Keep-Alive: timeout=N`
    // (N = floor of the server's keepAliveTimeout in seconds; omitted
    // when the timeout is 0, and never overriding an app-set Keep-Alive);
    // anything else gets `Connection: close`. The keep-alive decision
    // mirrors _finishSocketResponse's: the request-level flag (already
    // folded with the no-body-with-TE rule by writeHead), the
    // max-requests budget, and HTTP/1.0 length framing (Content-Length /
    // Transfer-Encoding, or a TE: chunked request advertising chunked
    // support). Previously only the close half existed, so every
    // keep-alive response went out with neither header
    // (test-http-server-keep-alive-defaults).
    if (
      typeof ServerResponse !== "undefined" &&
      this instanceof ServerResponse &&
      !flat.connection &&
      !this._removedConnection
    ) {
      const max = this._serverMaxRequestsPerSocket;
      const reqNo = this._serverReqNo;
      const maxOk =
        max === undefined ||
        max === null ||
        max === 0 ||
        reqNo === undefined ||
        reqNo < max;
      let framingOk = true;
      if (this._reqHttpVersion === "1.0") {
        framingOk =
          flat["content-length"] !== undefined ||
          flat["transfer-encoding"] !== undefined ||
          this._reqHadTE === true;
      }
      const noBodyWithTE =
        this._hasBody === false && flat["transfer-encoding"] !== undefined;
      if (this.shouldKeepAlive && maxOk && framingOk && !noBodyWithTE) {
        header += "Connection: keep-alive\r\n";
        flat.connection = "keep-alive";
        const kaTimeout = this._serverKeepAliveTimeout ?? 5000;
        if (kaTimeout > 0 && flat["keep-alive"] === undefined) {
          const secs = Math.floor(kaTimeout / 1000);
          // When the server caps requests per socket, Node appends the
          // configured max (not the remaining count — probed: max=3 on
          // both the first and second of three responses).
          const maxPart =
            typeof max === "number" && max > 0 ? `, max=${max}` : "";
          header += `Keep-Alive: timeout=${secs}${maxPart}\r\n`;
          flat["keep-alive"] = `timeout=${secs}${maxPart}`;
        }
      } else {
        header += "Connection: close\r\n";
        flat.connection = "close";
      }
    }
    header += "\r\n";

    this._header = header;
    this._renderedHeaders = flat;
  }

  // Mirrors Node's processHeader array semantics (probed v24.22.1):
  // multi-value arrays render one line per element — except headers in
  // the uniqueHeaders list, which render a single line with values
  // joined by '; ' (set-cookie included: probed, it joins too).
  // pushLine already emits one line per array element and folds flat
  // with ', ', so arrays reach it intact; only unique-listed arrays
  // are pre-joined. Empty arrays render nothing.
  _renderHeaderEntry(pushLine, name, value) {
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      if (this[kUniqueHeaders]?.has(String(name).toLowerCase())) {
        pushLine(name, value.map(String).join("; "));
        return;
      }
      pushLine(name, value);
      return;
    }
    pushLine(name, value);
  }

  _implicitHeader() {
    throw makeError(
      "ERR_METHOD_NOT_IMPLEMENTED",
      "The _implicitHeader() method is not implemented",
    );
  }

  /**
   * Port of Node's OutgoingMessage._send: flush headers (if not yet sent)
   * then write data directly, bypassing Writable buffering. Used by tests
   * and internals to coalesce headers + first body chunk.
   */
  _send(data, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    if (!this._header) {
      this._implicitHeader();
    }
    if (!this._headerFlushed) {
      this._flushHeaders();
    }
    const buf =
      data == null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data, encoding);
    const sock = this.socket;
    if (
      sock &&
      !sock.destroyed &&
      sock.constructor.name !== "FakeSocket" &&
      buf.length > 0 &&
      this._hasBody !== false
    ) {
      try {
        if (this._chunkedStreaming) {
          sock.write(buf.length.toString(16) + "\r\n");
          sock.write(buf);
          sock.write("\r\n");
        } else {
          sock.write(buf);
        }
      } catch {
        /* socket write failed; ignore */
      }
    }
    if (typeof callback === "function") queueMicrotask(callback);
    return true;
  }

  // Real Node's OutgoingMessage.destroy never emits 'error' on itself:
  // the error is recorded as `errored` (the ported stream destroy sets
  // that before calling here) and only 'close' follows (probed
  // v24.22.1: bare destroy(err) with no 'error' listener does not
  // throw, and server res.destroy(err) likewise never emits 'error').
  // The ported Writable default would callback with the error and emit
  // it; swallowing the callback error keeps close-only semantics.
  // ClientRequest overrides this to preserve its own error emission
  // (real Node surfaces client destroy(err) as 'error' via socket
  // forwarding, and the shim's ClientRequest.destroy relies on this
  // path for that event).
  _destroy(err, cb) {
    cb(null);
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    // Validation first (see validateOutgoingChunk): a bad chunk throws
    // before _implicitHeader, so a failed write leaves headers unrendered
    // and a failed end() retry still works.
    validateOutgoingChunk(chunk);
    if (this.destroyed) {
      // The ported Writable reports write-after-destroy as a callback
      // ERR_STREAM_DESTROYED with no 'error' event (probed v24.22.1:
      // return false, callback async, no error event) — but only if it
      // is reached; the old code threw ERR_METHOD_NOT_IMPLEMENTED from
      // _implicitHeader first for bare messages.
      return super.write(chunk, encoding, callback);
    }
    if (!this._header) {
      this._implicitHeader();
    }
    if (this._hasBody === false) {
      // 204/304/1xx responses MUST NOT have a body: ignore writes (Node parity).
      if (typeof encoding === "function") callback = encoding;
      if (typeof callback === "function") queueMicrotask(callback);
      return true;
    }
    // Bare OutgoingMessage (never socket-assigned, base class only):
    // real Node's OutgoingMessage is NOT a Writable — write() appends to
    // outputData/outputSize synchronously and returns false once buffered
    // bytes reach the highWaterMark, with the write callback stored in the
    // entry (probed v24.22.1: it never fires, not on a tick and not on
    // end() — only on flush). Routing through Writable would leave
    // outputSize lagging: Writable buffers every chunk after the first
    // internally while _write is in flight, so after a loop that wrote
    // 64KB outputSize would still read 3 bytes (test-http-outgoing-buffer:
    // loop terminates on Writable length, but outputSize >= HWM fails).
    // Scoped to the base class on purpose: pipelined ServerResponses
    // (socket null while queued) rely on Writable state for
    // writableNeedDrain/drain timing, and ClientRequest pre-connect
    // buffering relies on the _write path (#272).
    if (
      this.socket === null &&
      this.constructor === OutgoingMessage &&
      !this.finished
    ) {
      if (typeof encoding === "function") {
        callback = encoding;
        encoding = null;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.outputData.push({ data: buf, encoding: "buffer", callback });
      this.outputSize += buf.length;
      const hwm = this.writableHighWaterMark ?? getDefaultHighWaterMark(false);
      return this.outputSize < hwm;
    }
    return super.write(chunk, encoding, callback);
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    // Validate before _implicitHeader/finished: a bad chunk throws
    // without poisoning `finished`, so a retry end() still delivers
    // (test-http-outgoing-end-types). null/undefined mean "no chunk".
    if (chunk !== null && chunk !== undefined) {
      validateOutgoingChunk(chunk);
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

  // Port of Node's OutgoingMessage._renderHeaders: the flattened header
  // map (first-seen casing as keys), throwing ERR_HTTP_HEADERS_SENT
  // once headers are rendered. The store is normally this[kOutHeaders];
  // under parity the test injects via real Node's internal/http symbol
  // (--expose-internals respawn), so a foreign same-description symbol
  // store on the instance wins when present — in a real browser no such
  // symbol exists and the shim store is used untouched.
  _renderHeaders() {
    if (this._header) {
      throw ERR_HTTP_HEADERS_SENT("render");
    }
    let store = this[kOutHeaders];
    if (store === null || store === undefined) {
      for (const sym of Object.getOwnPropertySymbols(this)) {
        if (sym !== kOutHeaders && sym.description === "kOutHeaders") {
          store = this[sym];
          break;
        }
      }
    }
    const headers = {};
    if (store) {
      for (const key of Object.keys(store)) {
        const entry = store[key];
        headers[entry[0]] = entry[1];
      }
    }
    return headers;
  }

  addTrailers(headers) {
    // Real Node ignores trailers added after end() (probed v24.22.1:
    // no throw, no bytes) — the terminator is already written by then.
    if (this.finished) return;
    // Real Node validates trailer names/values (addTrailers with no
    // argument throws a TypeError from the engine; bad names/values
    // throw the http errors below).
    if (headers === null || headers === undefined) {
      throw new TypeError("Cannot convert undefined or null to object");
    }
    for (const name of Object.keys(headers)) {
      if (!_checkIsHttpToken(name)) {
        throw ERR_INVALID_HTTP_TOKEN("Trailer name", name);
      }
      if (_checkInvalidHeaderChar(String(headers[name]), false)) {
        throw ERR_INVALID_CHAR("trailer content", name);
      }
    }
    this._trailer = headers;
  }

  /**
   * Render the chunked terminator, including any trailers set via
   * addTrailers(): `0\r\n` + one `name: value\r\n` line per trailer
   * value (array values expand to one line per element) + `\r\n`.
   * With no trailers (or an empty object) this renders the bare
   * `0\r\n\r\n`, byte-identical to the previous output. Only called
   * for chunked framing; non-chunked responses (Content-Length,
   * close-delimited) never reach a terminator, so their trailers are
   * silently dropped, matching real Node.
   */
  _chunkTerminator() {
    const t = this._trailer;
    if (!t || typeof t !== "object" || Array.isArray(t)) return "0\r\n\r\n";
    const lines = [];
    for (const [name, value] of Object.entries(t)) {
      if (Array.isArray(value)) {
        // Unique-listed trailers render one '; '-joined line, like
        // unique-listed headers (test-http-multiple-headers: X-req-Y /
        // X-Res-Y); all others one line per element.
        if (this[kUniqueHeaders]?.has(String(name).toLowerCase())) {
          lines.push(`${name}: ${value.map(String).join("; ")}\r\n`);
        } else {
          for (const v of value) lines.push(`${name}: ${String(v)}\r\n`);
        }
      } else {
        lines.push(`${name}: ${String(value)}\r\n`);
      }
    }
    return lines.length === 0 ? "0\r\n\r\n" : `0\r\n${lines.join("")}\r\n`;
  }

  /**
   * Coalesced streaming delivery (test-http-keep-alive-max-requests):
   * real Node flushes a synchronous write();end() sequence as one TCP
   * segment, so the client sees headers + chunk + terminator in a
   * single 'data' event. The loopback delivers one 'data' event per
   * socket.write, so streaming frames pend here instead of going
   * straight to the socket: end() flushes the pending frame together
   * with the terminator in a single write, and a microtask flush
   * covers handlers that stream without ending (delivery stays
   * prompt, and the next request's dispatch flushes any pending
   * frame first, so pipelined responses can never overtake an
   * unfinished one). _flushHeaders() keeps its synchronous send:
   * an explicit flush means "send now".
   */
  _pendFrame(buf) {
    this._pendingFrame = this._pendingFrame
      ? Buffer.concat([this._pendingFrame, buf])
      : buf;
    // Framed-pending accounting (test-http-outgoing-properties): the
    // pended frame's byte length is the framed size, so a streaming
    // response's writableLength can count framed bytes (headers +
    // chunk frames) instead of the Writable's raw lengths, which drain
    // to 0 the moment a synchronous _write callback runs. Subtracted
    // exactly once at each flush site below.
    this._framedPending = (this._framedPending || 0) + buf.length;
    if (!this._pendingFlushScheduled) {
      this._pendingFlushScheduled = true;
      queueMicrotask(() => {
        this._pendingFlushScheduled = false;
        this._flushPendingFrame();
      });
    }
  }

  // Emit a streaming 'drain' once pended bytes drop below the mark after
  // a write() returned false for backpressure (see ServerResponse.write:
  // the Writable never emits drain for streaming responses because its
  // synchronous callbacks keep its length at 0).
  _maybeEmitStreamDrain() {
    if (
      this._streamNeedDrain &&
      (this._framedPending || 0) < (this.writableHighWaterMark ?? 65536)
    ) {
      this._streamNeedDrain = false;
      this.emit("drain");
    }
  }

  _flushPendingFrame() {
    const frame = this._pendingFrame;
    if (!frame) return;
    this._pendingFrame = null;
    this._framedPending = Math.max(
      0,
      (this._framedPending || 0) - frame.length,
    );
    this._maybeEmitStreamDrain();
    const sock = this.socket;
    if (sock && !sock.destroyed && sock.constructor.name !== "FakeSocket") {
      try {
        sock.write(frame);
      } catch {
        /* socket write failed; ignore */
      }
    }
  }

  flushHeaders() {
    if (!this._header) {
      this._implicitHeader();
    }
  }

  setTimeout(msecs, callback) {
    if (callback) this.once("timeout", callback);
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
// Singleton headers whose later duplicates Node's parser drops (first
// wins) instead of joining — probed on real Node v24.22.1, and matching
// the multipleForbidden list in test-http-server-multiheaders2.
const DUPLICATES_REMOVED = new Set([
  "age",
  "authorization",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "from",
  "host",
  "if-modified-since",
  "if-unmodified-since",
  "last-modified",
  "location",
  "max-forwards",
  "proxy-authorization",
  "referer",
  "retry-after",
  "server",
  "user-agent",
]);

export class IncomingMessage extends Readable {
  constructor(socket) {
    super();
    this.socket = socket || new FakeSocket();
    this.connection = this.socket;
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.httpVersion = "1.1";
    this.complete = false;
    this.aborted = false;
    this.headers = {};
    // headersDistinct is null-prototype (probed on real Node v24.22.1):
    // a "constructor" header must not read Object.prototype when its
    // values are accumulated (test-http-server-multiheaders).
    this.headersDistinct = Object.create(null);
    this.rawHeaders = [];
    this.trailers = {};
    this.rawTrailers = [];
    // trailersDistinct is null-prototype like headersDistinct (probed
    // real Node v24.22.1): every trailer line's value, unjoined.
    this.trailersDistinct = Object.create(null);
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
    if (callback) this.once("timeout", callback);
    if (this.socket?.setTimeout) this.socket.setTimeout(msecs);
    return this;
  }

  _destroy(err, cb) {
    if (!this.aborted) {
      this.aborted = true;
    }
    // Real Node (probed v24.22.1): destroying an INCOMPLETE incoming
    // message destroys its socket — client res.destroy() closes the
    // client socket, the server sees socket close, and the server
    // response gets 'close' (test-http-outgoing-destroyed block 3).
    // A complete message's socket is already detached for agent reuse,
    // so it is left alone (killing a pooled socket would corrupt the
    // agent). The destroy must be ABORTIVE (resetAndDestroy), not a
    // graceful destroy: the shim's socket.destroy() only delivers a
    // FIN to the peer, and an allowHalfOpen HTTP server socket never
    // closes on FIN — so the server would never see 'close' and the
    // server response would never fire 'close'. Real Node agrees:
    // even a no-error client destroy gives the server socket an error
    // (Parse Error, truncated message) + close with hadError=true.
    // With an error, the socket is destroyed with it: the server side
    // then sees an error + close, as on real Node. The server socket's
    // HTTP error handler is a no-op; 'close' does the cleanup.
    if (!this.complete && this.socket && !this.socket.destroyed) {
      try {
        if (this.socket.server) {
          // Server-side requests destroy their socket GRACEFULLY, not
          // abortively: probed on real Node v24.22.1, the client of a
          // req.destroy(err) sees FIN ('end') + a clean close, and the
          // HTTP layer generates ECONNRESET "socket hang up" for the
          // incomplete response — while a reset would wrongly surface
          // 'read ECONNRESET' on the client
          // (test-http-server-incomingmessage-destroy). Accepted
          // sockets carry `.server` (net.js accept path) and client
          // sockets never do, so that marker selects the behavior.
          this.socket.destroy();
        } else if (typeof this.socket.resetAndDestroy === "function") {
          this.socket.resetAndDestroy();
        } else if (typeof this.socket.destroy === "function") {
          this.socket.destroy(err);
        }
      } catch {
        /* ignore */
      }
    }
    // Server-side requests swallow the destroy error (close-only), like
    // OutgoingMessage._destroy: probed on real Node v24.22.1, a server
    // req.destroy(err) with no 'error' listener produces NO
    // uncaughtException — the error is recorded as `errored` (the ported
    // stream destroy sets that before calling here) and only 'close'
    // follows (test-http-server-incomingmessage-destroy). Client
    // responses keep cb(err): their destroy error surfaces as 'error'
    // (and, unlistened, as uncaughtException, which
    // test-http-client-incomingmessage-destroy requires).
    cb(this.socket && this.socket.server ? null : err);
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
    const buf =
      typeof body === "string"
        ? Buffer.from(body)
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(body);
    if (buf.length > 0) this.push(buf);
    this._finishBody();
  }

  /**
   * Fold raw [name, value] header pairs into headers / headersDistinct /
   * rawHeaders, mirroring Node's parser: duplicates join with ", ",
   * set-cookie stays an array. Shared by fromRequest() and the real socket
   * server path so both observe identical header semantics.
   */
  static _applyRawHeaders(msg, pairs) {
    for (const [key, value] of pairs) {
      const lower = key.toLowerCase();
      msg.rawHeaders.push(key, String(value));
      if (lower === "set-cookie") {
        const arr = Array.isArray(value) ? value.map(String) : [String(value)];
        if (msg.headers[lower] === undefined) {
          msg.headers[lower] = arr.length === 1 ? arr[0] : arr;
        } else {
          const cur = Array.isArray(msg.headers[lower])
            ? msg.headers[lower]
            : [msg.headers[lower]];
          msg.headers[lower] = cur.concat(arr);
        }
        msg.headersDistinct[lower] = Array.isArray(msg.headers[lower])
          ? msg.headers[lower].slice()
          : [msg.headers[lower]];
      } else {
        const val = Array.isArray(value)
          ? value.map(String).join(", ")
          : String(value);
        // Node's parser drops later duplicates of singleton headers
        // (first wins) but keeps every value in headersDistinct; other
        // duplicates join with ", " (cookie with "; "). Probed on real
        // Node v24.22.1 (host/cookie/content-type/x-foo duplicates).
        // hasOwnProperty, not `in`: a "constructor" header must not read
        // Object.prototype (test-http-server-multiheaders).
        const owned = Object.prototype.hasOwnProperty.call(msg.headers, lower);
        if (DUPLICATES_REMOVED.has(lower)) {
          if (!owned) msg.headers[lower] = val;
        } else if (lower === "cookie") {
          msg.headers[lower] = owned ? `${msg.headers[lower]}; ${val}` : val;
        } else {
          msg.headers[lower] = owned ? `${msg.headers[lower]}, ${val}` : val;
        }
        msg.headersDistinct[lower] = (msg.headersDistinct[lower] || []).concat(
          val,
        );
      }
    }
  }

  /**
   * Fold flat [name, value] trailer pairs (wire casing preserved, one
   * pair per line) into trailers / rawTrailers / trailersDistinct,
   * mirroring Node's trailer parsing: the same folding as headers
   * (singletons first-wins, other duplicates join with ", ", cookie
   * with "; ", set-cookie stays an array), but keys are lowercased
   * plain-object keys; trailersDistinct is null-prototype and keeps
   * EVERY line's value unjoined (probed real Node v24.22.1, including
   * singleton and cookie lines).
   */
  static _applyRawTrailers(msg, flatPairs) {
    for (let i = 0; i + 1 < flatPairs.length; i += 2) {
      const key = flatPairs[i];
      const value = flatPairs[i + 1];
      const lower = String(key).toLowerCase();
      msg.rawTrailers.push(key, String(value));
      if (msg.trailersDistinct) {
        if (!msg.trailersDistinct[lower]) msg.trailersDistinct[lower] = [];
        msg.trailersDistinct[lower].push(String(value));
      }
      if (lower === "set-cookie") {
        const arr = [String(value)];
        if (msg.trailers[lower] === undefined) {
          msg.trailers[lower] = arr[0];
        } else {
          const cur = Array.isArray(msg.trailers[lower])
            ? msg.trailers[lower]
            : [msg.trailers[lower]];
          msg.trailers[lower] = cur.concat(arr);
        }
      } else {
        const val = String(value);
        // hasOwnProperty, not `in`: a "constructor" trailer must not read
        // Object.prototype (same trap as headers).
        const owned = Object.prototype.hasOwnProperty.call(msg.trailers, lower);
        if (DUPLICATES_REMOVED.has(lower)) {
          if (!owned) msg.trailers[lower] = val;
        } else if (lower === "cookie") {
          msg.trailers[lower] = owned ? `${msg.trailers[lower]}; ${val}` : val;
        } else {
          msg.trailers[lower] = owned ? `${msg.trailers[lower]}, ${val}` : val;
        }
      }
    }
  }

  static fromRequest(method, url, headers, body) {
    const msg = new IncomingMessage();
    msg.method = method;
    msg.url = url;

    IncomingMessage._applyRawHeaders(msg, Object.entries(headers || {}));

    if (
      body !== null &&
      body !== undefined &&
      (typeof body === "string" || ArrayBuffer.isView(body))
    ) {
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
    msg.statusMessage =
      response.statusText || STATUS_CODES[response.status] || "";
    msg.httpVersion = "1.1";
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
// Read one header's value from a writeHead header view, which takes three
// shapes: the kOutHeaders map ([name, value] entries keyed lowercase, after
// setHeader/writeHead-obj merging), a plain object, or an array (flat
// name/value pairs or [name, value] pairs). Undefined when absent. Used by
// the Trailer validation, which must see the merged view: hasHeader() alone
// would miss writeHead-only headers, since it only sees kOutHeaders.
function _lookupHeader(headers, name, isOutHeadersMap) {
  const want = name.toLowerCase();
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    if (headers.length && Array.isArray(headers[0])) {
      for (const entry of headers) {
        if (String(entry[0]).toLowerCase() === want) return entry[1];
      }
    } else {
      for (let i = 0; i + 1 < headers.length; i += 2) {
        if (String(headers[i]).toLowerCase() === want) return headers[i + 1];
      }
    }
    return undefined;
  }
  if (isOutHeadersMap) {
    const entry = headers[want];
    return entry === undefined ? undefined : entry[1];
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return undefined;
}

export class ServerResponse extends OutgoingMessage {
  constructor(req, options) {
    super(options);
    // Node: res.req is the request this response belongs to
    // (test-http-server asserts res.req === req).
    this.req = req;
    this.socket = req?.socket || new FakeSocket();
    this.connection = this.socket;
    this.statusCode = 200;
    // statusMessage stays undefined until writeHead (Node: prototype default).
    this.sendDate = true;
    this._resolve = null;
    // Streaming state: once headers are flushed to the socket, writes go
    // directly instead of buffering (needed for abort/destroy tests where
    // the client must see the response before res.end()).
    this._headerFlushed = false;
    // Coalesced streaming delivery (see _pendFrame): frames pended here
    // instead of going straight to the socket, so a synchronous
    // write();end() sequence reaches the client as one 'data' event.
    this._pendingFrame = null;
    this._pendingFlushScheduled = false;
    // Framed-pending bytes for the streaming writableLength/backpressure
    // accounting (see _pendFrame): only grows on streaming pends.
    this._framedPending = 0;
    // Set when a streaming write() returns false for backpressure; the
    // streaming 'drain' fires from _maybeEmitStreamDrain at flush time.
    this._streamNeedDrain = false;
    // HTTP version from the request (for 1.0 vs 1.1 response semantics).
    // HTTP/1.0 does not support chunked transfer encoding.
    this._reqHttpVersion = req?.httpVersion || "1.1";
  }

  _implicitHeader() {
    this.writeHead(this.statusCode);
    // The header block was rendered by end()/write() itself, not committed
    // by an explicit writeHead() — _finishSocketResponse may therefore
    // frame a single buffered body with Content-Length (Node behavior).
    // An explicit writeHead() leaves this unset and the body is chunked.
    this._headersImplicit = true;
  }

  /**
   * Header block to send when streaming starts. Node defaults to chunked
   * when Content-Length isn't set (like Node). Shared by _flushHeaders()
   * (headers alone, explicit flush) and _write() (headers + first chunk
   * coalesced — see _write).
   */
  _streamingHeader() {
    let header = this._header;
    // Dual header stores (same trap as _finishSocketResponse): headers
    // set via writeHead(obj) live in _renderedHeaders only, while
    // hasHeader() sees kOutHeaders only. Consulting one store alone
    // re-adds Transfer-Encoding: chunked on top of an app-set
    // Content-Length — a response real Node's client would reject
    // (HPE_INVALID_TRANSFER_ENCODING) and that the shim's own client
    // parser now rejects too (test-http-keep-alive: writeHead CL +
    // write() + end() stalled until this check saw both stores).
    const rendered = this._renderedHeaders || {};
    const hasCL =
      this.hasHeader("content-length") ||
      rendered["content-length"] !== undefined;
    const hasTE =
      this.hasHeader("transfer-encoding") ||
      rendered["transfer-encoding"] !== undefined;
    // HTTP/1.0 does not support chunked transfer encoding — the connection
    // closes after the response instead (Node behavior). Exception: when the
    // request advertised `TE: chunked`, Node does use chunked for 1.0.
    const isHttp10 = this._reqHttpVersion === "1.0";
    const allowChunked10 = isHttp10 && this._reqHadTE;
    if (!hasCL && this._hasBody !== false && (!isHttp10 || allowChunked10)) {
      if (!hasTE) {
        // Node defaults to chunked when length is unknown and we're streaming.
        header = header.replace(/\r\n$/, "Transfer-Encoding: chunked\r\n\r\n");
        this._chunkedStreaming = true;
      } else {
        // The app already set Transfer-Encoding: chunked (via setHeader
        // or writeHead(obj)) — the stream is still chunked, so chunk
        // framing and the terminator must apply even though no header
        // is added here. Without this, a proxy forwarding a chunked
        // response (writeHead with the upstream TE header, then
        // write/end) sent unframed chunks and no terminator, and the
        // client hung waiting for it (test-http-proxy). Non-chunked
        // TE (e.g. gzip) leaves _chunkedStreaming false: raw body, no
        // terminator, as on real Node.
        const teVals = [];
        const h = this.getHeader("transfer-encoding");
        if (h !== undefined) teVals.push(...(Array.isArray(h) ? h : [h]));
        const r = rendered["transfer-encoding"];
        if (r !== undefined) teVals.push(...(Array.isArray(r) ? r : [r]));
        if (
          teVals.some((v) => /(^|[, \t])chunked([, \t]|$)/i.test(String(v)))
        ) {
          this._chunkedStreaming = true;
        }
      }
    }
    return header;
  }

  /**
   * Flush buffered headers + body to the socket for streaming.
   * Uses chunked encoding when Content-Length isn't set (like Node).
   */
  _flushHeaders() {
    if (this._headerFlushed || !this._header) return;
    const sock = this.socket;
    // Only stream to real sockets, not the FakeSocket (used for non-virtual paths).
    if (!sock || sock.constructor.name === "FakeSocket") return;
    if (sock.destroyed) return;

    const header = this._streamingHeader();
    try {
      sock.write(header);
      // Flush any data buffered before the first write().
      for (const entry of this.outputData) {
        const chunk = entry.data;
        if (this._chunkedStreaming && chunk.length > 0) {
          // One write per frame, not three: a chunk split across
          // delivery events lets a naive client split-count mis-pair
          // headers and bodies (test-http-server-keep-alive-defaults
          // false-triggers its 8-part check on a bare size line).
          sock.write(
            Buffer.concat([
              Buffer.from(chunk.length.toString(16) + "\r\n", "latin1"),
              chunk,
              Buffer.from("\r\n", "latin1"),
            ]),
          );
        } else if (chunk.length > 0) {
          sock.write(chunk);
        }
      }
      this.outputData = [];
      this.outputSize = 0;
      this._headerFlushed = true;
    } catch {
      /* socket write failed; ignore */
    }
  }

  /**
   * Override _write to stream directly to the socket once headers are flushed.
   * Before the first flush, buffer normally (so end()-only responses can
   * still compute Content-Length).
   */
  _write(chunk, encoding, callback) {
    // If headers are already flushed, stream the chunk directly.
    if (this._headerFlushed) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const sock = this.socket;
      if (sock && !sock.destroyed && sock.constructor.name !== "FakeSocket") {
        try {
          if (this._chunkedStreaming && buf.length > 0) {
            // One frame per chunk, not three (see _flushHeaders): a
            // chunk split across delivery events lets a naive client
            // split-count mis-pair headers and bodies. Frames pend
            // (see _pendFrame) so end() can join the terminator.
            this._pendFrame(
              Buffer.concat([
                Buffer.from(buf.length.toString(16) + "\r\n", "latin1"),
                buf,
                Buffer.from("\r\n", "latin1"),
              ]),
            );
          } else if (buf.length > 0) {
            this._pendFrame(buf);
          }
        } catch {
          /* ignore */
        }
      }
      callback();
      return;
    }
    // First chunk with headers already rendered (writeHead called) via
    // an explicit write(): send headers + chunk as ONE write, like
    // Node's first write does. Sending headers alone first lets a naive
    // client that asserts on every blank-line-terminated buffer
    // (test-http-keep-alive-max-requests asserts on
    // buffer.endsWith("\r\n\r\n")) fire on a headers-only buffer with
    // no body yet — and the throw it produces is swallowed by the
    // delivery path, derailing the request sequence. Explicit
    // flushHeaders() still sends headers alone (see _flushHeaders).
    // Excluded when finishing (end(chunk) sets finished before its
    // internal write): end-chunks stay buffered so the finish path
    // sends headers + body + terminator as one write, which tests
    // counting data events per response (test-http-1.0-keep-alive)
    // rely on.
    if (this._header && !this.finished) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const sock = this.socket;
      if (sock && !sock.destroyed && sock.constructor.name !== "FakeSocket") {
        try {
          const header = this._streamingHeader();
          if (this._chunkedStreaming && buf.length > 0) {
            this._pendFrame(
              Buffer.concat([
                Buffer.from(header, "latin1"),
                Buffer.from(buf.length.toString(16) + "\r\n", "latin1"),
                buf,
                Buffer.from("\r\n", "latin1"),
              ]),
            );
          } else if (buf.length > 0) {
            this._pendFrame(
              Buffer.concat([Buffer.from(header, "latin1"), buf]),
            );
          } else {
            this._pendFrame(Buffer.from(header, "latin1"));
          }
        } catch {
          /* ignore */
        }
        this._headerFlushed = true;
        callback();
        return;
      }
    }
    // Buffer normally; flush happens on first write() call (below) or end().
    super._write(chunk, encoding, callback);
  }

  /**
   * Override write to stream to the client immediately.
   * This makes res.writeHead(); res.write() stream to the client immediately,
   * matching Node behavior for abort/destroy tests. Headers go out
   * coalesced with the first chunk (see _write) rather than flushed alone
   * beforehand.
   */
  // Streaming writableLength (test-http-outgoing-properties): once
  // headers are flushed, real Node counts framed bytes still pending
  // (header block + chunk frames), not the Writable's raw lengths —
  // with synchronous _write callbacks the Writable length reads 0
  // immediately after every write, so a chunked "asd" would read +0
  // instead of +8. Before streaming starts (buffered, pipelined
  // socketless, FakeSocket) the Writable verdict stands.
  get writableLength() {
    if (
      this._headerFlushed &&
      this.socket &&
      this.socket.constructor.name !== "FakeSocket"
    ) {
      return this._framedPending || 0;
    }
    return super.writableLength;
  }

  // Streaming writableNeedDrain mirrors the counter-gated write()
  // return below; buffered/corked writes keep the Writable verdict.
  get writableNeedDrain() {
    if (this._streamNeedDrain) return true;
    return super.writableNeedDrain;
  }

  write(chunk, encoding, callback) {
    // Write-after-end must emit 'error' (test-http-res-write-after-end):
    // the ported Writable routes the WRITE_AFTER_END error through
    // destroy(), and OutgoingMessage._destroy deliberately swallows it
    // (close-only: destroy(err) must not emit 'error' — destroyed
    // blocks 2/4) — so without this the 'error' event would never
    // fire. Emit it here when the message already ended (finished)
    // but is not yet destroyed; the ported path still returns false
    // and calls back with the error, and destroy's close-only callback
    // prevents a double emission. Scoped to ServerResponse on purpose:
    // ClientRequest._destroy propagates the error (its destroy path
    // already emits), and bare messages never reach this override.
    if (this.finished && !this.destroyed) {
      const er = new Error("write after end");
      er.code = "ERR_STREAM_WRITE_AFTER_END";
      // Async like the ported path's onDestroy emission; with no
      // listener this throws, exactly as the ported emitErrorNT does.
      queueMicrotask(() => this.emit("error", er));
    }
    const ret = super.write(chunk, encoding, callback);
    // Streaming backpressure (test-http-outgoing-finish): with
    // synchronous _write callbacks the Writable length is always 0, so
    // super.write always returns true and a `while (res.write())` loop
    // never terminates. Real Node returns false once the pended
    // (framed) bytes reach the highWaterMark. Buffered/corked writes
    // keep the Writable verdict: their bytes never pend, so the counter
    // cannot gate them.
    if (
      ret &&
      this._headerFlushed &&
      (this._framedPending || 0) >= (this.writableHighWaterMark ?? 65536)
    ) {
      this._streamNeedDrain = true;
      return false;
    }
    return ret;
  }

  /**
   * Node sends headers immediately on flushHeaders(); the inherited
   * version only renders them. Without the socket write, a handler that
   * flushes headers and then waits for request body data (e.g.
   * test-http-server-consumed-timeout) never delivers its response, and
   * the client callback that would produce that body never runs.
   * _flushHeaders() is a no-op when already flushed or socketless, so
   * this only adds the missing send.
   */
  flushHeaders() {
    super.flushHeaders();
    this._flushHeaders();
  }

  writeHead(statusCode, reason, obj) {
    if (this._header) {
      throw ERR_HTTP_HEADERS_SENT("write");
    }

    const originalStatusCode = statusCode;
    statusCode |= 0;
    if (statusCode < 100 || statusCode > 999) {
      throw ERR_HTTP_INVALID_STATUS_CODE(originalStatusCode);
    }

    if (typeof reason === "string") {
      // writeHead(statusCode, reasonPhrase[, headers])
      this.statusMessage = reason;
    } else {
      // writeHead(statusCode[, headers])
      this.statusMessage =
        this.statusMessage || STATUS_CODES[statusCode] || "unknown";
      obj ??= reason;
    }
    this.statusCode = statusCode;

    let headers;
    if (this[kOutHeaders]) {
      // Slow-case: progressive API was used; obj headers merge in.
      if (Array.isArray(obj)) {
        if (obj.length % 2 !== 0) {
          throw ERR_INVALID_ARG_VALUE("headers", obj);
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
      throw ERR_INVALID_CHAR("statusMessage");
    }

    const statusLine = `HTTP/1.1 ${statusCode} ${this.statusMessage}\r\n`;

    if (
      statusCode === 204 ||
      statusCode === 304 ||
      (statusCode >= 100 && statusCode <= 199)
    ) {
      // RFC 2616: these responses MUST NOT include a message body.
      this._hasBody = false;
      // If Transfer-Encoding is explicitly set on a no-body response,
      // Node closes the connection (the framing is a protocol error).
      // This ensures `Connection: close` is sent and the socket is
      // destroyed in _finishSocketResponse. (test-http-chunked-304)
      let hasTE = false;
      if (headers) {
        if (Array.isArray(headers)) {
          for (let n = 0; n < headers.length; n += 2) {
            if (String(headers[n]).toLowerCase() === "transfer-encoding") {
              hasTE = true;
              break;
            }
          }
        } else if (typeof headers === "object") {
          for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === "transfer-encoding") {
              hasTE = true;
              break;
            }
          }
        }
      }
      // Also check kOutHeaders (set via setHeader before writeHead)
      if (!hasTE && this[kOutHeaders]) {
        for (const k of Object.keys(this[kOutHeaders])) {
          if (k.toLowerCase() === "transfer-encoding") {
            hasTE = true;
            break;
          }
        }
      }
      if (hasTE) {
        this.shouldKeepAlive = false;
      }
    }

    // Node: a Trailer header is only valid with chunked transfer encoding
    // (ERR_HTTP_TRAILER_INVALID otherwise). The check runs here, before
    // _storeHeader renders anything, so a throw leaves headers unsent and
    // the handler can removeHeader("Trailer") and end() normally — exactly
    // what test-http-server-de-chunked-trailer does. Because every server
    // header path funnels through writeHead (_implicitHeader calls it),
    // this also covers implicit headers (end()/write() without writeHead)
    // and flushHeaders(). Chunked means: explicit Transfer-Encoding with a
    // chunked token (any case, list, or array value) on a body-carrying
    // response, or the default-chunked framing (no TE, no Content-Length,
    // body allowed, HTTP/1.1 — or HTTP/1.0 when the request advertised
    // TE: chunked). Probed on real Node v24.22.1: Content-Length,
    // identity/gzip TE, 204/304/1xx, HEAD-without-chunked-TE, and plain
    // HTTP/1.0 all throw; explicit chunked TE passes even for HEAD.
    const trailer = _lookupHeader(
      headers,
      "trailer",
      headers === this[kOutHeaders],
    );
    if (trailer !== undefined) {
      const te = _lookupHeader(
        headers,
        "transfer-encoding",
        headers === this[kOutHeaders],
      );
      const teValues = te === undefined ? [] : Array.isArray(te) ? te : [te];
      const teChunked = teValues.some((v) =>
        String(v)
          .split(",")
          .some((t) => t.trim().toLowerCase() === "chunked"),
      );
      let chunked;
      if (te !== undefined) {
        chunked = teChunked && this._hasBody !== false;
      } else if (
        _lookupHeader(
          headers,
          "content-length",
          headers === this[kOutHeaders],
        ) !== undefined ||
        this._hasBody === false ||
        this.req?.method === "HEAD"
      ) {
        chunked = false;
      } else if (this._reqHttpVersion === "1.0" && !this._reqHadTE) {
        chunked = false;
      } else {
        chunked = true;
      }
      if (!chunked) {
        throw ERR_HTTP_TRAILER_INVALID();
      }
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
    if (typeof callback === "function") queueMicrotask(callback);
  }
  writeInformation(info, callback) {
    if (typeof callback === "function") queueMicrotask(callback);
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

  // Destroying the response destroys the socket (Node behavior): the client
  // sees the connection reset. Without this, the virtual socket's loop-keeping
  // timer survives and the process hangs (http parity hang).
  // Exceptions: when the server finished the response normally on a keep-alive
  // connection, the socket is preserved for reuse (flagged by
  // _finishSocketResponse); and a destroy after end() with no error must
  // not kill the socket before the async finish delivers the response
  // (test-http-outgoing-destroyed block 5: end, destroy, end('asd')
  // must still deliver the response end to the client). The finish path
  // owns the socket lifecycle for a finished response (keep-alive
  // preserve, else destroy), so there is nothing left for destroy to
  // tear down. Stream autoDestroy must not kill it — the socket
  // lifecycle is owned by the server (next pipelined request) and the
  // client's agent pool. An explicit destroy with an error (abort) still
  // destroys the socket.
  _destroy(err, cb) {
    const sock = this.socket;
    const preserved = (this._keepAliveSocket || this.finished) && !err;
    if (
      !preserved &&
      sock &&
      typeof sock.destroy === "function" &&
      !sock.destroyed
    ) {
      try {
        sock.destroy();
      } catch {
        /* best effort */
      }
    }
    // end() then destroy() with no error (test-http-outgoing-destroyed
    // block 5): the ported Writable suppresses 'finish' once destroyed
    // (needFinish excludes kDestroyed), so the finish delivery would
    // never run and the client would never see the response. Emit
    // 'finish' manually: the dispatch listener runs
    // _finishSocketResponse, which is idempotent, so this is safe even
    // if 'finish' somehow fires later. Skipped for aborts (err): an
    // aborted response must not be delivered.
    if (this.finished && !err && !this._finishDelivered) {
      try {
        this.emit("finish");
      } catch {
        /* delivery errors are swallowed by dispatch */
      }
    }
    super._destroy(err, cb);
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
      if (typeof callback === "function") queueMicrotask(callback);
      return this;
    }
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    // Validate before finished=true (see OutgoingMessage.end): a bad
    // chunk throws without poisoning `finished`, so a retry end() still
    // delivers (test-http-outgoing-end-types).
    if (chunk !== null && chunk !== undefined) {
      validateOutgoingChunk(chunk);
    }
    if (!this._header) {
      this._implicitHeader();
    }
    this.finished = true;
    const done = () => {
      this._deliver();
      // NOTE: no manual 'finish' emit — Writable emits it exactly once via
      // super.end() below, matching node:http. (A manual emit here used to
      // double-fire 'finish' for on('finish') consumers.)
      if (callback) callback();
    };
    if (chunk !== null && chunk !== undefined) {
      super.write(chunk, encoding, () => super.end(done));
    } else {
      super.end(done);
    }
    // Chunked terminator ordering (test-http-server-keep-alive-defaults):
    // in the streaming path the headers + chunks already went out during
    // write(), but the "0\r\n\r\n" terminator was only written by the
    // async 'finish' listener — after the parser had already dispatched
    // (and flushed) the next pipelined response, so terminators bunched
    // after all responses instead of terminating each one. The test's
    // naive header/body split then mis-pairs them and its assertion
    // throws. Real Node terminates each response before the next
    // response's bytes. Write it synchronously here, in call order: by
    // now every chunk is already on the socket (the flushed _write path
    // is synchronous, verified by probe), and the finish listener skips
    // it via the flag. Buffered (non-flushed) responses are untouched:
    // their headers go out at finish time together with the terminator,
    // so they are already correctly ordered.
    if (this._headerFlushed && this._chunkedStreaming) {
      const sock = this.socket;
      if (sock && !sock.destroyed && sock.constructor.name !== "FakeSocket") {
        try {
          // Join the terminator to any pended frame in one write, so
          // a synchronous write();end() reaches the client as a
          // single 'data' event (see _pendFrame).
          const term = Buffer.from(this._chunkTerminator(), "latin1");
          const pending = this._pendingFrame;
          this._pendingFrame = null;
          if (pending) {
            this._framedPending = Math.max(
              0,
              (this._framedPending || 0) - pending.length,
            );
          }
          this._maybeEmitStreamDrain();
          sock.write(pending ? Buffer.concat([pending, term]) : term);
          this._chunkTerminatorSent = true;
        } catch {
          /* socket write failed; finish listener skips destroyed sockets */
        }
      }
    }
    return this;
  }

  // --- Express-style conveniences (carried over from the previous shim) ---

  send(data) {
    if (typeof data === "object" && data !== null && !Buffer.isBuffer(data)) {
      this.setHeader("Content-Type", "application/json");
      data = JSON.stringify(data);
    }
    if (!this.hasHeader("Content-Type")) {
      this.setHeader("Content-Type", "text/html");
    }
    return this.end(typeof data === "string" ? data : data);
  }

  json(data) {
    this.setHeader("Content-Type", "application/json");
    return this.end(JSON.stringify(data));
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  redirect(urlOrStatus, url) {
    if (typeof urlOrStatus === "number") {
      this.statusCode = urlOrStatus;
      this.setHeader("Location", url);
    } else {
      this.statusCode = 302;
      this.setHeader("Location", urlOrStatus);
    }
    return this.end();
  }

  // Test/debug helpers.
  _getBody() {
    return Buffer.concat(this.outputData.map((e) => e.data));
  }
  _getBodyAsString() {
    return this._getBody().toString("utf8");
  }
}

// ---------------------------------------------------------------------------
// 8. ClientRequest — port of node:_http_client, backed by fetch().
// ---------------------------------------------------------------------------

/** Parse the (url[, options][, callback]) / (options[, callback]) overloads. */
function parseRequestArgs(urlOrOptions, optionsOrCallback, callback) {
  let options;
  let cb = callback;

  if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
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
      method: "GET",
    };
    if (typeof optionsOrCallback === "function") {
      cb = optionsOrCallback;
    } else if (optionsOrCallback) {
      options = { __proto__: null, ...options, ...optionsOrCallback };
    }
  } else {
    options = urlOrOptions || {};
    if (typeof optionsOrCallback === "function") {
      cb = optionsOrCallback;
    }
  }

  return { options, callback: cb };
}

export class ClientRequest extends OutgoingMessage {
  constructor(input, options, cb, defaultAgent) {
    // Propagate the user's highWaterMark to the Writable base (Node parity).
    const rawOpts =
      typeof options === "object" && options !== null
        ? options
        : typeof input === "object" && input !== null
          ? input
          : null;
    const hw = rawOpts?.highWaterMark;
    super(hw == null ? undefined : { highWaterMark: hw });

    // Normalize (url, options?, cb?) and (options, cb?) signatures.
    if (typeof options === "function") {
      cb = options;
      options = undefined;
    }
    let urlOpts = null;
    if (typeof input === "string" || input instanceof URL) {
      const parsed = new URL(input.toString(), "http://localhost");
      urlOpts = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: `${parsed.pathname}${parsed.search}`,
        auth: parsed.username
          ? decodeURIComponent(parsed.username) +
            (parsed.password ? `:${decodeURIComponent(parsed.password)}` : "")
          : undefined,
      };
    } else if (input && typeof input === "object") {
      urlOpts = input;
    }
    options = { __proto__: null, ...urlOpts, ...(options || {}) };

    // request({ uniqueHeaders }) — probed real Node v24.22.1: send-side
    // only (parsing never joins). Listed headers with array values
    // serialize as one '; '-joined line; everything else one line per
    // value. Stored as a lowercase Set for the virtual-path serializer
    // and the chunked terminator; non-array values are ignored (no
    // official test covers them).
    this[kUniqueHeaders] = Array.isArray(options.uniqueHeaders)
      ? new Set(options.uniqueHeaders.map((n) => String(n).toLowerCase()))
      : null;

    // Apply options.headers BEFORE any agent/socket activity: malformed
    // headers throw at construction on real Node, and a throw after
    // agent.addRequest() would leave a connection attempt racing the
    // failed construction (unhandled 'error' on a dead request —
    // test-http-client-headers-host-array).
    // Default headers (Host, Authorization), mirroring Node. Array-form
    // headers bypass kOutHeaders entirely (see normalizeArrayHeaders):
    // getHeaders()/getHeader() do not reflect them, setHeader() throws
    // once they are set, and no Host/Authorization default is added —
    // the probed wire shows neither when array headers are supplied.
    if (options.headers) {
      if (Array.isArray(options.headers)) {
        this._headersArray = normalizeArrayHeaders(options.headers);
      } else {
        for (const key of Object.keys(options.headers)) {
          // A host header given as an array throws at construction
          // (probed on real Node v24.22.1; setHeader("host", []) does
          // not throw, so the check lives here, not in setHeader).
          if (
            key.toLowerCase() === "host" &&
            Array.isArray(options.headers[key])
          ) {
            throw ERR_INVALID_ARG_TYPE(
              "host",
              "of type string",
              options.headers[key],
            );
          }
          this.setHeader(key, options.headers[key]);
        }
      }
    }

    // --- agent -----------------------------------------------------------
    let agent = options.agent;
    const defAgent = options._defaultAgent || defaultAgent || globalAgent;
    if (agent === false) {
      agent = new defAgent.constructor();
    } else if (agent === null || agent === undefined) {
      if (typeof options.createConnection !== "function") {
        agent = defAgent;
      }
    } else if (typeof agent.addRequest !== "function") {
      throw ERR_INVALID_ARG_TYPE_PROPERTY(
        "options.agent",
        "one of Agent-like Object, undefined, or false",
        agent,
      );
    }
    this.agent = agent;

    const protocol = options.protocol || defAgent.protocol || "http:";
    const expectedProtocol =
      this.agent?.protocol || defAgent.protocol || "http:";
    if (options.path !== undefined && options.path !== null) {
      const p = String(options.path);
      if (INVALID_PATH_REGEX.test(p)) {
        throw ERR_UNESCAPED_CHARACTERS("Request path");
      }
    }
    if (protocol !== expectedProtocol) {
      throw ERR_INVALID_PROTOCOL(protocol, expectedProtocol);
    }

    const defaultPort = options.defaultPort || this.agent?.defaultPort || 80;
    const port = options.port || defaultPort || 80;
    let host = options.hostname || options.host || "localhost";
    if (host !== null && host !== undefined && typeof host !== "string") {
      throw ERR_INVALID_ARG_TYPE("options.host", "of type string", host);
    }
    host = host || "localhost";

    let method = options.method;
    if (method != null) validateString(method, "options.method");
    if (method) {
      if (!_checkIsHttpToken(method)) {
        throw ERR_INVALID_HTTP_TOKEN("Method", method);
      }
      method = method.toUpperCase();
    } else {
      method = "GET";
    }

    if (
      options.maxHeaderSize !== undefined &&
      (!Number.isInteger(options.maxHeaderSize) || options.maxHeaderSize < 0)
    ) {
      throw ERR_OUT_OF_RANGE("maxHeaderSize", ">= 0", options.maxHeaderSize);
    }

    this[kPath] = options.path || "/";
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

    // Register with the agent synchronously (Node behavior): the agent
    // assigns a socket (or queues the request if at maxSockets). The socket
    // is delivered via onSocket(), which _performVirtualRequest waits for.
    // Stash the options for queued-request reprocessing.
    this._agentOptions = {
      host,
      hostname: host,
      port: Number(port) || 80,
    };
    if (agent) {
      try {
        agent.addRequest(this, this._agentOptions);
        this._agentAddRequestCalled = true;
      } catch {
        /* agent bookkeeping must not break construction */
      }
    }

    // Synthetic socket: browsers have no raw TCP. If the agent synchronously
    // assigned a real socket from the free pool (keep-alive reuse), keep it
    // instead of clobbering it with the FakeSocket.
    if (!this.socket) {
      this.socket = new FakeSocket();
    }
    this.connection = this.socket;

    if (
      host &&
      !this._headersArray &&
      !this.getHeader("host") &&
      options.setHost !== false &&
      options.setDefaultHeaders !== false
    ) {
      let hostHeader = host;
      if (port && Number(port) !== Number(defaultPort)) {
        hostHeader += `:${port}`;
      }
      this.setHeader("Host", hostHeader);
    }
    if (
      options.auth &&
      !this._headersArray &&
      !this.getHeader("authorization")
    ) {
      this.setHeader(
        "Authorization",
        `Basic ${Buffer.from(options.auth).toString("base64")}`,
      );
    }

    if (cb) {
      this.once("response", cb);
    }

    // Wire up AbortSignal: Node's http.ClientRequest listens for abort on
    // options.signal and destroys the request with an AbortError.
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) {
        queueMicrotask(() => this._onAbortSignal());
      } else {
        signal.addEventListener("abort", () => this._onAbortSignal(), {
          once: true,
        });
      }
    }

    if (
      method === "GET" ||
      method === "HEAD" ||
      method === "DELETE" ||
      method === "OPTIONS" ||
      method === "TRACE" ||
      method === "CONNECT"
    ) {
      this.useChunkedEncodingByDefault = false;
    }
  }

  get path() {
    return this[kPath];
  }
  set path(value) {
    const p = String(value);
    if (INVALID_PATH_REGEX.test(p)) {
      throw ERR_UNESCAPED_CHARACTERS("Request path");
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
    // Mark graceful abort: if the request is still queued (waiting for a
    // socket), Node emits 'abort' but NOT 'error'. This flag is only checked
    // in the socket-waiting promise path; active requests are unaffected.
    this._abortGraceful = true;
    queueMicrotask(() => this.emit("abort"));
    this.destroy();
  }

  _onAbortSignal() {
    if (this.aborted || this._aborted) return;
    this.aborted = true;
    this._aborted = true;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    // Match Node: emit 'abort' then destroy with the AbortError.
    queueMicrotask(() => this.emit("abort"));
    this.destroy(err);
  }

  // Node 24: abort() is the legacy spelling; destroy() is canonical.
  destroy(err) {
    this._aborted = true;
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch {
        /* noop */
      }
    }
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    // If the request was queued in the agent (waiting for a socket), don't
    // remove it synchronously — Node keeps aborted queued requests in
    // agent.requests until the queue is processed. Just mark it aborted;
    // _processQueue will skip it.
    const agent = this.agent;
    // Cancel a pending socket assignment.
    if (this._onSocketAssigned) {
      this._onSocketAssigned = null;
      const reject = this._onSocketRejected;
      this._onSocketRejected = null;
      // Reject the waiting _performVirtualRequest promise so it doesn't hang.
      if (reject) {
        const err = new Error("socket hang up");
        err.code = "ECONNRESET";
        queueMicrotask(() => reject(err));
      }
    }
    // Destroy the socket: in the virtual-server path this is a real net.js
    // socket with a loop-keeping timer. If we don't destroy it here, the
    // event loop never drains and the process hangs (http parity hang).
    // Also remove it from the agent's tracking so counts stay accurate.
    const sock = this.socket;
    if (sock && typeof sock.destroy === "function" && !sock.destroyed) {
      if (agent && !(sock instanceof FakeSocket) && sock._agentName) {
        try {
          agent.removeSocket(sock, sock._agentName);
        } catch {
          /* best effort */
        }
      }
      try {
        sock.destroy();
      } catch {
        /* best effort */
      }
    }
    super.destroy(err);
    return this;
  }

  // Client requests keep the ported Writable's error emission on
  // destroy(err): real Node surfaces client destroy(err) as 'error'
  // (via socket-error forwarding), and the shim's ClientRequest.destroy
  // relies on this path for that event. This preserves the status quo
  // that OutgoingMessage._destroy deliberately suppresses for bare
  // messages and server responses.
  _destroy(err, cb) {
    cb(err);
  }

  setTimeout(timeout, callback) {
    if (callback) this.once("timeout", callback);
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

  setNoDelay() {
    return this;
  }
  setSocketKeepAlive() {
    return this;
  }

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
      if (typeof callback === "function") queueMicrotask(callback);
      return this;
    }
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    // Validate before _ended=true (see OutgoingMessage.end): a bad
    // chunk throws without poisoning the request.
    if (chunk !== null && chunk !== undefined) {
      validateOutgoingChunk(chunk);
    }
    this._ended = true;
    this.finished = true;
    const finish = () => {
      if (callback) callback();
      this.emit("finish");
    };
    const run = () => {
      this._performRequest().then(finish, (err) => {
        // 'error' must not throw when unhandled during perform; Node emits.
        if (this.listenerCount("error") > 0) this.emit("error", err);
        else this.emit("abort");
      });
    };
    if (chunk !== null && chunk !== undefined) {
      if (this._stream && this._stream.roundTrip) {
        // Streaming request: the round trip already started on first
        // write()/flushHeaders(). Forward the final chunk (if any), close
        // the body framing, then await the in-flight round trip. The
        // final chunk is NOT re-buffered: it already went (or is queued
        // to go) through the stream writer.
        this._streamForward(chunk, encoding);
        this._streamFinish();
        run();
      } else {
        super.write(chunk, encoding, run);
      }
    } else if (this._stream && this._stream.roundTrip) {
      this._streamFinish();
      run();
    } else {
      run();
    }
    return this;
  }

  /**
   * Node streams request bodies: headers + first chunk go out on the
   * first write(), not at end(). For virtual-server requests with a
   * body-capable method, forward the chunk to the streaming round trip
   * (started by _streamEnsureStarted). Buffered behavior is unchanged
   * for fetch-path requests, no-body methods, and requests that never
   * write before end().
   */
  write(chunk, encoding, callback) {
    // Validate before _streamEnsureStarted: a bad chunk throws without
    // starting the streaming round trip (see OutgoingMessage.write).
    validateOutgoingChunk(chunk);
    // Start streaming BEFORE super.write(): super.write() marks headers
    // sent via _implicitHeader(), and setHeader() throws after that —
    // the chunked framing header must be set while headers are open.
    if (!this._ended && !this._aborted) this._streamEnsureStarted();
    const ret = super.write(chunk, encoding, callback);
    if (!this._ended && !this._aborted) {
      this._streamForward(
        chunk,
        typeof encoding === "string" ? encoding : undefined,
      );
    }
    return ret;
  }

  flushHeaders() {
    // Node sends headers immediately; for a virtual server this starts
    // the streaming round trip (headers only, body chunks follow).
    if (!this._ended && !this._aborted) this._streamEnsureStarted();
    super.flushHeaders();
  }

  /**
   * Decide once, on first write()/flushHeaders(), whether this request
   * streams to its virtual server. Returns the stream state, or null
   * for the buffered whole-body-at-end() path. Never throws: header
   * validation failures leave the request on the buffered path.
   */
  /**
   * Merge stashed array-form headers into a headers object for the
   * virtual round trip, preserving duplicates as array values so
   * _serializeRequestHead emits one line per pair (like Node on the
   * wire). First-seen casing wins for the object key; the server
   * parser lowercases anyway. Object-form requests pass through
   * untouched (same reference).
   */
  _mergeArrayHeaders(headers) {
    if (!this._headersArray) return headers;
    const merged = { ...(headers || {}) };
    const seen = new Map(); // lower -> key in merged
    for (const key of Object.keys(merged)) seen.set(key.toLowerCase(), key);
    for (const [name, value] of this._headersArray) {
      const lower = String(name).toLowerCase();
      const key = seen.get(lower);
      if (key === undefined) {
        seen.set(lower, name);
        merged[name] = value;
      } else if (Array.isArray(merged[key])) {
        merged[key].push(value);
      } else {
        merged[key] = [merged[key], value];
      }
    }
    return merged;
  }

  /**
   * Headers for the virtual-server round trip, preserving what the old
   * ', '-flattening destroyed: first-seen casing (kOutHeaders entry[0])
   * and per-value arrays, so _serializeRequestHead emits one wire line
   * per value like Node — except headers in this request's
   * uniqueHeaders list, whose arrays collapse to one '; '-joined line.
   * Array-form pairs merge in after (their values join too when the
   * name is unique). The real-fetch path keeps its own ', ' flattening;
   * this builder is virtual-path only.
   */
  _virtualHeaders() {
    const headers = {};
    const kOut = this[kOutHeaders];
    if (kOut) {
      for (const lower of Object.keys(kOut)) {
        const [name, value] = kOut[lower];
        headers[name] = Array.isArray(value) ? [...value] : value;
      }
    }
    const merged = this._mergeArrayHeaders(headers);
    const unique = this[kUniqueHeaders];
    if (unique) {
      for (const key of Object.keys(merged)) {
        const v = merged[key];
        if (Array.isArray(v) && unique.has(key.toLowerCase())) {
          merged[key] = v.map(String).join("; ");
        }
      }
    }
    return merged;
  }

  _streamEnsureStarted() {
    if (this._stream !== undefined) return this._stream;
    const server = this._getVirtualServer();
    const method = this.method;
    // Array-form headers are invisible to getHeader()/hasHeader()
    // (probed Node behavior), so consult the stashed pairs too.
    const arrayHeader = (name) =>
      this._headersArray?.find(([n]) => String(n).toLowerCase() === name)?.[1];
    const hasCL =
      this.hasHeader("content-length") ||
      arrayHeader("content-length") !== undefined;
    const te = String(
      this.getHeader("transfer-encoding") ||
        arrayHeader("transfer-encoding") ||
        "",
    ).toLowerCase();
    const upgrade = String(
      this.getHeader("upgrade") || arrayHeader("upgrade") || "",
    ).toLowerCase();
    const eligible =
      server &&
      method !== "GET" &&
      method !== "HEAD" &&
      method !== "CONNECT" &&
      upgrade !== "websocket" &&
      (method === "POST" ||
        method === "PUT" ||
        method === "PATCH" ||
        hasCL ||
        te === "chunked");
    if (!eligible) {
      this._stream = null;
      return null;
    }
    const framing = hasCL ? "raw" : "chunked";
    if (framing === "chunked" && !te && !this._headersArray) {
      // Materialize chunked framing like Node does on first write.
      // This runs before _implicitHeader(), so setHeader() cannot throw.
      // (Skipped for array headers: setHeader() throws once they are
      // set, so the framing header is folded into the stream headers
      // below instead.) Casing is 'Transfer-Encoding': real Node's wire
      // shows it capitalized (test-http-multiple-headers rawHeaders).
      this.setHeader("Transfer-Encoding", "chunked");
    }
    const st = {
      framing,
      pending: [],
      writer: null,
      finished: false,
      roundTrip: null,
    };
    this._stream = st;
    // Preserve casing + per-value arrays for the wire (see
    // _virtualHeaders); the old ', ' flattening collapsed multi-value
    // headers into one line and lowercased every name.
    let streamHeaders = this._virtualHeaders();
    if (
      framing === "chunked" &&
      !te &&
      this._headersArray &&
      arrayHeader("transfer-encoding") === undefined
    ) {
      streamHeaders = { ...streamHeaders, "transfer-encoding": "chunked" };
    }
    st.roundTrip = this._performVirtualRequest(
      server,
      streamHeaders,
      null,
      true,
      !!this._headersArray,
    );
    // An early rejection (e.g., socket assignment failure) must not
    // become an unhandled rejection before end(); _performRequest awaits
    // the same promise at end() and routes the error through its handler.
    st.roundTrip.catch(() => {});
    return st;
  }

  /** Frame one written chunk and forward it to the stream writer. */
  _streamForward(chunk, encoding) {
    const st = this._streamEnsureStarted();
    if (!st || st.finished) return;
    let buf;
    try {
      if (Buffer.isBuffer(chunk)) buf = chunk;
      else if (chunk instanceof Uint8Array) buf = Buffer.from(chunk);
      else buf = Buffer.from(chunk, encoding);
    } catch {
      return;
    }
    // Empty writes send nothing (probed Node behavior: headers only).
    if (buf.length === 0) return;
    const frame =
      st.framing === "chunked"
        ? Buffer.concat([
            Buffer.from(buf.length.toString(16) + "\r\n"),
            buf,
            Buffer.from("\r\n"),
          ])
        : buf;
    if (st.writer) st.writer.write(frame);
    else st.pending.push(frame);
  }

  /** Close the streamed body framing (chunked terminator; raw: nothing). */
  _streamFinish() {
    const st = this._stream;
    if (!st || st.finished) return;
    st.finished = true;
    if (st.framing !== "chunked") return;
    // Render via _chunkTerminator, not a bare terminator: request
    // trailers set via addTrailers() must reach the server
    // (test-http-multiple-headers asserts req.rawTrailers). With no
    // trailers this is byte-identical to the old bare terminator.
    const term = Buffer.from(this._chunkTerminator(), "latin1");
    if (st.writer) st.writer.write(term);
    else st.pending.push(term);
  }

  _buildURL() {
    const protocol = this.protocol === "https:" ? "https:" : "http:";
    let hostname = this.host;
    let portPart = "";
    // `host` may be "example.com:8080".
    const colon = hostname.lastIndexOf(":");
    if (colon !== -1 && hostname.indexOf(":") === colon) {
      const maybePort = Number(hostname.slice(colon + 1));
      if (Number.isInteger(maybePort)) {
        portPart = `:${maybePort}`;
        hostname = hostname.slice(0, colon);
      }
    } else if (this.port) {
      const defPort =
        this.agent?.defaultPort || (protocol === "https:" ? 443 : 80);
      if (Number(this.port) !== Number(defPort)) portPart = `:${this.port}`;
    }
    // IPv6 literals need brackets.
    if (hostname.includes(":") && !hostname.startsWith("[")) {
      hostname = `[${hostname}]`;
    }
    return `${protocol}//${hostname}${portPart}${this.path}`;
  }

  _getFetch() {
    const f = typeof globalThis.fetch === "function" ? globalThis.fetch : null;
    return f;
  }

  async _performRequest() {
    if (this._aborted) return;

    // Streaming request already started by an early write()/flushHeaders():
    // await its round trip instead of starting a second one.
    if (this._stream && this._stream.roundTrip) {
      return this._stream.roundTrip;
    }

    const fetchFn = this._getFetch();
    if (!fetchFn) {
      throw makeError(
        "ERR_NO_FETCH",
        "fetch() is not available in this environment",
      );
    }

    const url = this._buildURL();

    // WebSocket upgrade requests cannot use fetch(): browsers strip
    // Connection/Upgrade headers. Bridge to the native WebSocket instead
    // — but NOT for loopback targets: a loopback upgrade goes over an
    // agent socket (virtual http server, or a raw net server), never a
    // real TCP dial. The bridge dials ws://localhost:port where no real
    // server listens, so every loopback websocket upgrade ECONNREFUSED
    // and the error landed on the still-unassigned FakeSocket
    // (test-http-upgrade-client/agent). Non-loopback keeps the bridge.
    if (
      String(this.getHeader("upgrade") || "").toLowerCase() === "websocket" &&
      !this._isLoopbackTarget()
    ) {
      this._handleWebSocketUpgrade(url);
      return;
    }

    // Optional CORS proxy (configured via localStorage by the host page).
    let fetchUrl = url;
    try {
      const ls = globalThis.localStorage;
      const proxy =
        typeof ls !== "undefined" && ls ? ls.getItem("__corsProxyUrl") : null;
      if (proxy) fetchUrl = proxy + encodeURIComponent(url);
    } catch {
      /* storage may be unavailable; ignore */
    }

    const fetchOptions = {
      method: this.method,
      headers: {},
      // Unlike Node, fetch() follows redirects automatically; the browser
      // gives us no way to observe the 3xx hop (documented gap).
      redirect: "follow",
    };
    for (const [k, v] of Object.entries(this.getHeaders())) {
      fetchOptions.headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    // fetch forbids user-set Host; the browser derives it from the URL.
    delete fetchOptions.headers.host;

    const body = Buffer.concat(this.outputData.map((e) => e.data));
    if (body.length > 0 && this.method !== "GET" && this.method !== "HEAD") {
      fetchOptions.body = body;
    } else if (
      (this.method === "GET" || this.method === "HEAD") &&
      body.length > 0
    ) {
      throw makeError(
        "ERR_INVALID_ARG_VALUE",
        `Request with ${this.method} method cannot have a body.`,
      );
    }

    // In-process loopback: a virtual server registered for this local
    // host:port answers without touching the network. This makes
    // same-process client/server round trips (the common test shape, and a
    // genuinely useful browser pattern) work with zero native sockets.
    const virtualServer = this._getVirtualServer();
    if (virtualServer) {
      // The fetch path above deleted Host (browsers forbid user-set
      // Host); the virtual path needs the real header set: first-seen
      // casing, array-form pairs (duplicates as array values, one wire
      // line per element), and uniqueHeaders '; ' joining — see
      // _virtualHeaders. Object-form values pass through as arrays,
      // not ', '-flattened.
      await this._performVirtualRequest(
        virtualServer,
        this._virtualHeaders(),
        body.length > 0 ? body : null,
        false,
        !!this._headersArray,
      );
      return;
    }

    // Loopback target owned by a raw net server (not a virtual http
    // server): route over an agent socket like the websocket branch
    // below, so the response bytes are parsed by the real HTTP parser
    // instead of fetch(), which cannot reach the virtual network.
    // Without this, every client request to a net server failed with
    // 'fetch failed' and malformed responses never surfaced as parse
    // errors (test-http-client-reject-chunked-with-content-length,
    // test-http-client-reject-cr-no-lf). The gate is the registry
    // lookup only: loopback targets with no virtual listener keep the
    // fetch path exactly (real local servers in a browser still work).
    if (this._hasRawNetServer()) {
      await this._performVirtualRequest(
        null,
        this._virtualHeaders(),
        body.length > 0 ? body : null,
        false,
        !!this._headersArray,
      );
      return;
    }

    // Loopback websocket upgrade with no virtual http server: the target
    // is a raw net server (or nothing listening). Same agent-socket
    // round trip as the virtual path — the server side is the app's net
    // 'connection'/'data' handlers, not HTTP dispatch — so a null server
    // is all the round trip needs. A refused connection surfaces as a
    // request 'error' (ECONNREFUSED), never a bridge failure on the
    // FakeSocket placeholder. Array-form headers are invisible to
    // getHeader() (they bypass kOutHeaders), so consult the stashed
    // pairs too — test-http-upgrade-client's second request is
    // array-form, and without this it fell through to fetch().
    if (
      this._isLoopbackTarget() &&
      String(
        this.getHeader("upgrade") ??
          this._headersArray?.find(
            ([n]) => String(n).toLowerCase() === "upgrade",
          )?.[1] ??
          "",
      ).toLowerCase() === "websocket"
    ) {
      await this._performVirtualRequest(
        null,
        this._virtualHeaders(),
        body.length > 0 ? body : null,
        false,
        !!this._headersArray,
      );
      return;
    }

    const controller = new AbortController();
    this._abortController = controller;
    fetchOptions.signal = controller.signal;

    if (this.timeout) {
      this._timeoutId = setTimeout(() => {
        this._timeoutId = null;
        controller.abort();
        this.emit("timeout");
      }, this.timeout);
    }
    if (this.agent) {
      try {
        this.agent.emit("request", this);
      } catch {
        /* noop */
      }
    }

    let response;
    try {
      // Emit 'socket' with the synthetic socket, like Node does on connect.
      queueMicrotask(() => {
        if (!this._aborted) this.emit("socket", this.socket);
      });
      response = await fetchFn(fetchUrl, fetchOptions);
    } catch (err) {
      if (this._timeoutId) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }
      if (this._aborted) return;
      if (err && err.name === "AbortError") return; // timeout already emitted
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
    msg.req = this;
    this.emit("response", msg);
  }

  /**
   * Parse this request's target into { local, port, hostname }: `host`
   * may carry a port ("example.com:8080"), which wins over the port
   * option. Shared by the virtual-server lookup, the raw-net-server
   * lookup, and the websocket-upgrade routing.
   */
  _parseTarget() {
    let hostname = this.host;
    let port = Number(this.port);
    // `host` may be "example.com:8080".
    const colon = hostname.lastIndexOf(":");
    if (colon !== -1 && hostname.indexOf(":") === colon) {
      const maybePort = Number(hostname.slice(colon + 1));
      if (Number.isInteger(maybePort)) {
        port = maybePort;
        hostname = hostname.slice(0, colon);
      }
    }
    const local =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "";
    return { local, port, hostname };
  }

  /**
   * Whether a raw net server (not a virtual http server) is registered
   * for this request's loopback target. Bracketed IPv6 literals are
   * unbracketed for the registry lookup (net's connect lookup only
   * matches the bare form).
   */
  _hasRawNetServer() {
    const { local, port, hostname } = this._parseTarget();
    if (!local || !Number.isInteger(port)) return false;
    let host = hostname;
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return netHasTcpServer(host, port);
  }

  /**
   * Whether this request targets the loopback network (localhost /
   * 127.0.0.1 / ::1, any port). Loopback upgrades never take the
   * native-WebSocket bridge.
   */
  _isLoopbackTarget() {
    const { local, port } = this._parseTarget();
    return local && Number.isInteger(port);
  }

  /**
   * Find a virtual server registered for this request's local host:port.
   * Returns the Server or null (→ the request goes to fetch()).
   */
  _getVirtualServer() {
    const { local, port } = this._parseTarget();
    if (!local || !Number.isInteger(port)) return null;
    return _httpShared().registry.get(port) || null;
  }

  /**
   * Emulate a client→server round trip against a virtual server — over a
   * real virtual socket now (phase 2): the request is serialized to
   * HTTP/1.1 bytes and the response parsed from bytes, so req.socket on
   * both ends is genuine and byte counts are real.
   */
  /**
   * Called by the Agent when a socket is assigned to this request
   * (either a fresh socket or a reused keep-alive socket).
   */
  onSocket(socket) {
    // Ignore late/duplicate assignments (e.g., manual addRequest after the
    // constructor's agent already assigned a socket). Only a REAL socket
    // counts as an assignment: the constructor installs a FakeSocket
    // placeholder, and treating it as assigned would swallow every
    // asynchronous delivery — the waiter in _performVirtualRequest would
    // never resolve. (test-http-agent-uninitialized)
    if (this.socket && !(this.socket instanceof FakeSocket)) return;
    this.socket = socket;
    this.connection = socket;
    // Node sets the socket's _httpMessage on assignment (probed: the
    // 'socket' event already observes it); CONNECT detach clears it.
    socket._httpMessage = this;
    if (this._onSocketAssigned) {
      const resolve = this._onSocketAssigned;
      this._onSocketAssigned = null;
      resolve(socket);
    }
  }

  /**
   * Called by the Agent when socket creation fails.
   */
  onSocketError(err) {
    if (this._onSocketAssigned) {
      const reject = this._onSocketRejected;
      this._onSocketAssigned = null;
      this._onSocketRejected = null;
      if (reject) reject(err);
      return;
    }
    // Don't emit 'error' for aborted requests — Node only emits 'abort'
    // for abort(), and destroy() already emitted its error (if any).
    // Emitting here would cause "unhandled 'error' event" for tests that
    // abort requests without an error listener.
    if (this._aborted || this._abortGraceful) return;
    this.emit("error", err instanceof Error ? err : new Error(String(err)));
  }

  /**
   * Release the socket back to the agent's pool (keep-alive) or destroy it.
   * Called when the response completes or the request is done with the socket.
   */
  _releaseAgentSocket() {
    const agent = this.agent;
    const sock = this.socket;
    if (!agent || !sock || sock instanceof FakeSocket) return;
    const name =
      sock._agentName ||
      agent.getName({ host: this.host, port: Number(this.port) || 80 });
    // Only release once.
    if (sock._releasedToAgent) return;
    sock._releasedToAgent = true;
    try {
      agent.releaseSocket(sock, name);
    } catch {
      /* best effort */
    }
  }

  async _performVirtualRequest(
    server,
    headers,
    body,
    streaming,
    // Array-form request headers: the probed wire carries no Host
    // default when no host pair is supplied, so suppress the
    // serializer's "Host: localhost" fallback for such requests.
    noDefaultHost = false,
  ) {
    // The agent was already notified in the constructor (synchronous
    // addRequest). Wait for the socket assignment via onSocket().
    // Note: the agent used this.port; for virtual servers the actual port
    // is server._port. If they differ, re-key the socket tracking.
    const agent = this.agent;

    // If the agent has keepAlive enabled, ensure the Connection header is set
    // so the server keeps the socket open for reuse (Node behavior).
    if (agent && agent.keepAlive) {
      const hasConnection = Object.keys(headers || {}).some(
        (k) => k.toLowerCase() === "connection",
      );
      if (!hasConnection) {
        headers = { ...(headers || {}), connection: "keep-alive" };
      }
    }

    const sock = await new Promise((resolve, reject) => {
      // If the socket was already assigned (synchronous free-socket reuse),
      // use it immediately.
      if (this.socket && !(this.socket instanceof FakeSocket)) {
        resolve(this.socket);
        return;
      }
      // Race: abort() may have been called synchronously after end(), before
      // this async method ran. If so, don't wait for a socket.
      if (this._aborted) {
        const err = new Error("socket hang up");
        err.code = "ECONNRESET";
        reject(err);
        return;
      }
      // If the request was queued (at maxSockets), wait for the agent to
      // assign a socket via onSocket().
      this._onSocketAssigned = resolve;
      this._onSocketRejected = reject;
      // If addRequest already ran in the constructor but the socket isn't
      // assigned yet (async createSocket), the promise will resolve via
      // onSocket(). If for some reason addRequest wasn't called, call it now.
      if (!this._agentAddRequestCalled) {
        this._agentAddRequestCalled = true;
        try {
          agent.addRequest(this, this._agentOptions);
        } catch (err) {
          this._onSocketAssigned = null;
          this._onSocketRejected = null;
          reject(err);
        }
      }
    }).catch((err) => {
      // Aborted while waiting for a socket. Node emits ECONNRESET 'error'
      // for destroy(), but NOT for graceful abort() (which only emits 'abort').
      if (this._aborted || err?.code === "ECONNRESET") {
        if (!this._abortGraceful) {
          queueMicrotask(() => {
            if (this.listenerCount("error") > 0) {
              const e = new Error("socket hang up");
              e.code = "ECONNRESET";
              this.emit("error", e);
            }
          });
        }
        return null;
      }
      throw err;
    });
    if (!sock) return;
    // If aborted while waiting, destroy the socket and bail.
    if (this._aborted) {
      try {
        agent.removeSocket(sock, sock._agentName);
      } catch {
        /* best effort */
      }
      try {
        sock.destroy();
      } catch {
        /* best effort */
      }
      queueMicrotask(() => {
        if (this.listenerCount("error") > 0) {
          const err = new Error("socket hang up");
          err.code = "ECONNRESET";
          this.emit("error", err);
        }
      });
      return;
    }
    // The agent assigned the socket; onSocket() already set this.socket.
    // Emit 'socket' at assignment time, like Node. A freshly created
    // virtual socket has usually already emitted 'connect' by now
    // (the agent's create callback runs on 'connect'), so listeners
    // attaching a 'connect' handler inside their 'socket' handler
    // would miss it; replay 'connect' once for exactly that case.
    // Reused sockets never replay (their _connectedBeforeAssign flag
    // is cleared when they are parked and when they are reused).
    if (!this._aborted) {
      this.emit("socket", sock);
      if (sock._connectedBeforeAssign) {
        sock._connectedBeforeAssign = false;
        queueMicrotask(() => {
          if (!sock.destroyed) sock.emit("connect");
        });
      }
    }
    const onSocketError = (err) => {
      if (this._timeoutId) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }
      if (this._aborted) return;
      // If the socket is idle in the agent's free pool, the agent handles
      // the error (removes from pool, destroys). Don't propagate to this
      // (possibly completed) request — that would be an unhandled 'error'.
      if (sock._inFreePool) return;
      this._aborted = true;
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    };
    sock.on("error", onSocketError);

    if (this.timeout) {
      this._timeoutId = setTimeout(() => {
        this._timeoutId = null;
        this._aborted = true;
        try {
          sock.destroy();
        } catch {
          /* best effort */
        }
        this.emit("timeout");
      }, this.timeout);
    }
    if (this.agent) {
      try {
        this.agent.emit("request", this);
      } catch {
        /* noop */
      }
    }

    let result;
    let streamedMsg = null;
    try {
      // A null server means a raw loopback target (a net server, not a
      // virtual http server): the agent socket already pairs with it, so
      // the round trip needs only the request's own target port. The
      // port argument is unused when a socket is supplied, but keep it
      // exact (a host-carried port wins over the port option).
      result = await _socketHttpRoundTrip(
        server ? server._port : this._parseTarget().port,
        {
          method: this.method,
          path: this.path,
          headers,
          body: body && body.length > 0 ? body : null,
          socket: sock,
          noDefaultHost,
          // Streaming request (started by an early write()): the head was
          // pre-serialized with its framing; body chunks arrive via the
          // writer. The round-trip promise still resolves on response
          // completion, exactly like the buffered path.
          ...(streaming
            ? {
                streaming: true,
                headBytes: _serializeRequestHead(
                  this.method,
                  this.path,
                  headers,
                  null,
                  noDefaultHost,
                ),
                onStreamReady: (writer) => {
                  const st = this._stream;
                  if (!st) return;
                  st.writer = writer;
                  const pending = st.pending;
                  st.pending = [];
                  for (const frame of pending) writer.write(frame);
                },
              }
            : {}),
          // Streaming: emit 'response' as soon as headers arrive, push body
          // chunks as they come. This matches Node for abort/destroy tests
          // where the client must see the response before res.end().
          onHeaders: (info) => {
            if (this._aborted) return;
            const msg = new IncomingMessage();
            msg.statusCode = info.statusCode;
            msg.statusMessage =
              info.statusMessage || STATUS_CODES[info.statusCode] || "";
            msg.httpVersion = "1.1";
            msg.httpVersionMajor = 1;
            msg.httpVersionMinor = 1;
            const pairs = [];
            for (let i = 0; i < info.rawHeaders.length; i += 2) {
              pairs.push([info.rawHeaders[i], info.rawHeaders[i + 1]]);
            }
            IncomingMessage._applyRawHeaders(msg, pairs);
            msg.socket = this.socket;
            msg.connection = this.socket;
            msg.req = this;
            streamedMsg = msg;
            this.emit("response", msg);
          },
          onBody: (chunk) => {
            if (streamedMsg && !this._aborted) {
              streamedMsg._pushBody(chunk);
            }
          },
        },
      );
    } catch (err) {
      if (this._timeoutId) {
        clearTimeout(this._timeoutId);
        this._timeoutId = null;
      }
      if (streamedMsg) {
        // Streaming: the response was already emitted; propagate the error
        // to it (e.g., ECONNRESET when the server destroys the response).
        const isAbort = this._aborted;
        if (!isAbort) {
          streamedMsg._aborted = true;
          streamedMsg.emit("aborted");
        }
        // Destroy the socket to release the loop keeper.
        try {
          sock.destroy();
        } catch {
          /* best effort */
        }
        if (!isAbort) {
          // Map socket-closed errors to ECONNRESET (Node behavior when the
          // server destroys the response mid-stream).
          const e = err instanceof Error ? err : new Error(String(err));
          e.code = "ECONNRESET";
          streamedMsg.emit("error", e);
        }
        // Don't call _finishBody() — 'end' must NOT fire on abort.
        // Destroy the message which emits 'close'.
        try {
          streamedMsg.destroy();
        } catch {
          /* best effort */
        }
        return;
      }
      if (this._aborted) return;
      // A failed round trip kills the connection on real Node (a parse
      // error destroys the socket); leaving it open hangs the loop, since
      // the peer never closes a socket it already answered on
      // (test-http-client-reject-*: the net server writes once and
      // waits). Sockets already dead or closing make destroy a no-op.
      try {
        sock.destroy();
      } catch {
        /* already dead */
      }
      throw err;
    }
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._aborted) return;

    // CONNECT tunnel established: 'connect', not 'response', and never
    // released to the agent pool — the socket is the app's now. With no
    // 'connect' listener Node destroys the unclaimed tunnel socket
    // (probed v24.22.1), which is what lets the loop drain in
    // test-http-server-unconsume-consume.
    if (result.isConnect) {
      const msg = new IncomingMessage();
      msg.statusCode = result.statusCode;
      msg.statusMessage =
        result.statusMessage || STATUS_CODES[result.statusCode] || "";
      msg.httpVersion = "1.1";
      msg.httpVersionMajor = 1;
      msg.httpVersionMinor = 1;
      const pairs = [];
      for (let i = 0; i < result.rawHeaders.length; i += 2) {
        pairs.push([result.rawHeaders[i], result.rawHeaders[i + 1]]);
      }
      IncomingMessage._applyRawHeaders(msg, pairs);
      msg.socket = this.socket;
      msg.connection = this.socket;
      // Detach before handing the tunnel to the app: real Node delivers
      // it with only the stream-internal 'end' listener left (probed
      // v24.22.1) and _httpMessage cleared to null. The round trip
      // already detached its own listeners; the request-level error
      // forwarder is the one left.
      try {
        this.socket.removeListener("error", onSocketError);
      } catch {
        /* already detached */
      }
      this.socket._httpMessage = null;
      this.emit("connect", msg, this.socket, result.connectHead);
      if (
        this.listenerCount("connect") === 0 &&
        this.socket &&
        !(this.socket instanceof FakeSocket)
      ) {
        try {
          this.socket.destroy();
        } catch {
          /* best effort */
        }
      }
      // The tunnel socket's close completes the request: Node destroys
      // the request and emits 'close' (test-http-connect-req-res asserts
      // req.destroyed === true in 'close'). A second destroy is a
      // stream no-op, so this is safe if the app destroys first.
      if (this.socket && !(this.socket instanceof FakeSocket)) {
        const req = this;
        this.socket.once("close", () => {
          if (!req.destroyed) req.destroy();
        });
      }
      return;
    }

    // 101 Switching Protocols: 'upgrade', not 'response', and never
    // released to the agent pool — the socket is the app's now. Detach
    // mirrors the CONNECT branch, plus the two upgrade-specific shapes
    // probed on real Node v24.22.1: the socket's _httpMessage is null
    // (not merely unset) and socket.parser is null (the client-side
    // parser is freed before 'upgrade' — test-http-parser-freed-before-
    // upgrade asserts strict null). The agent pool removal is what
    // drops totalSocketCount to 0 at 'upgrade' (test-http-upgrade-
    // agent). With no 'upgrade' listener the socket is destroyed, like
    // an unclaimed CONNECT tunnel (test-http-upgrade-advertise's
    // destroy case: the client observes socket 'close').
    if (result.isUpgrade) {
      const msg = new IncomingMessage();
      msg.statusCode = result.statusCode;
      msg.statusMessage =
        result.statusMessage || STATUS_CODES[result.statusCode] || "";
      msg.httpVersion = "1.1";
      msg.httpVersionMajor = 1;
      msg.httpVersionMinor = 1;
      const pairs = [];
      for (let i = 0; i < result.rawHeaders.length; i += 2) {
        pairs.push([result.rawHeaders[i], result.rawHeaders[i + 1]]);
      }
      IncomingMessage._applyRawHeaders(msg, pairs);
      msg.socket = this.socket;
      msg.connection = this.socket;
      msg.req = this;
      try {
        this.socket.removeListener("error", onSocketError);
      } catch {
        /* already detached */
      }
      this.socket._httpMessage = null;
      this.socket.parser = null;
      try {
        this.agent?.removeSocket(this.socket, this.socket._agentName);
      } catch {
        /* best effort */
      }
      this.emit("upgrade", msg, this.socket, result.upgradeHead);
      if (
        this.listenerCount("upgrade") === 0 &&
        this.socket &&
        !(this.socket instanceof FakeSocket)
      ) {
        try {
          this.socket.destroy();
        } catch {
          /* best effort */
        }
      }
      // The round trip paused the socket before settling (see the 101
      // branch): if the app attached a 'data' listener in its 'upgrade'
      // handler, resume now so buffered post-header bytes flow to it
      // (test-http-upgrade-client's "nurtzo"). Without a data listener
      // the bytes stay buffered for a later read/resume, as on a paused
      // Node stream — resuming blindly would emit them to zero
      // listeners and lose them the same way the pause prevents.
      if (
        this.socket &&
        !(this.socket instanceof FakeSocket) &&
        !this.socket.destroyed &&
        this.socket.listenerCount("data") > 0
      ) {
        try {
          this.socket.resume();
        } catch {
          /* best effort */
        }
      }
      // The request completes at upgrade: real Node destroys it
      // (emitting 'close') with no socket activity at all (probed
      // v24.22.1: req.destroyed true and 'close' fires while the tunnel
      // socket is still open — test-http-upgrade-agent's 'close'
      // handler is what ends the socket, not the other way round).
      // ClientRequest.destroy() would destroy the socket, so go through
      // Writable's destroy with the keep-alive preservation flag, which
      // OutgoingMessage._destroy honors by skipping the socket kill.
      // The socket-once-close hook below stays as a backstop (inert
      // once destroyed is set).
      this._keepAliveSocket = true;
      try {
        Writable.prototype.destroy.call(this);
      } catch {
        /* best effort */
      }
      if (this.socket && !(this.socket instanceof FakeSocket)) {
        const req = this;
        this.socket.once("close", () => {
          if (!req.destroyed) req.destroy();
        });
      }
      return;
    }

    // Streaming case: message already emitted; just finish the body.
    if (streamedMsg) {
      // Trailers arrive with message completion, after the body: attach
      // them before 'end' fires so 'end' handlers see res.trailers.
      if (result.rawTrailers && result.rawTrailers.length > 0) {
        IncomingMessage._applyRawTrailers(streamedMsg, result.rawTrailers);
      }
      streamedMsg._finishBody();
      // Release the socket to the agent's pool for keep-alive reuse.
      // The release always happens at message-complete time, consumed
      // or not (test-http-agent-uninitialized never reads its
      // response, and its socket must still be released). With a
      // keep-alive agent the socket is parked — its bookkeeping moves
      // lists immediately, as in Node. With a non-keep-alive agent the
      // release destroys the socket and removes it from
      // agent.sockets; Node removes it when the socket actually
      // closes, which is after the response's 'end' has been
      // delivered, so defer that case one turn to reproduce the
      // ordering (test-http-keep-alive-close-on-header asserts
      // agent.sockets[name].length === 1 inside its 'end' handler).
      const agent = this.agent;
      const sock = this.socket;
      // Record the response's keep-alive timeout hint on the socket
      // so the agent's keepSocketAlive veto can read it at release
      // time (null when the response carried no hint — this also
      // clears any stale hint from an earlier response on a reused
      // socket). Stashed before the release even in the deferred
      // non-keep-alive case, so the value is fixed at response time.
      if (sock && !(sock instanceof FakeSocket)) {
        sock._serverKeepAliveTimeout = parseKeepAliveTimeoutHint(
          streamedMsg.headers,
        );
      }
      if (agent && sock && !(sock instanceof FakeSocket) && !agent.keepAlive) {
        const req = this;
        setTimeout(() => req._releaseAgentSocket(), 0);
      } else {
        this._releaseAgentSocket();
      }
      return;
    }

    const msg = new IncomingMessage();
    msg.statusCode = result.statusCode;
    msg.statusMessage =
      result.statusMessage || STATUS_CODES[result.statusCode] || "";
    msg.httpVersion = "1.1";
    msg.httpVersionMajor = 1;
    msg.httpVersionMinor = 1;
    const pairs = [];
    for (let i = 0; i < result.rawHeaders.length; i += 2) {
      pairs.push([result.rawHeaders[i], result.rawHeaders[i + 1]]);
    }
    IncomingMessage._applyRawHeaders(msg, pairs);
    if (result.rawTrailers && result.rawTrailers.length > 0) {
      IncomingMessage._applyRawTrailers(msg, result.rawTrailers);
    }
    msg.socket = this.socket;
    msg.connection = this.socket;
    msg.req = this;
    msg._setBody(result.body);
    // Record the response's keep-alive timeout hint on the socket
    // for the agent's keepSocketAlive veto (see the streamed path
    // above for why this is stashed, and why null clears stale hints).
    if (this.socket && !(this.socket instanceof FakeSocket)) {
      this.socket._serverKeepAliveTimeout = parseKeepAliveTimeoutHint(
        msg.headers,
      );
    }
    // Release the socket to the agent's pool for keep-alive reuse.
    this._releaseAgentSocket();
    this.emit("response", msg);
  }

  /**
   * Bridge a WebSocket upgrade request to the browser's native WebSocket.
   * (Carried over from the previous shim: the bundled `ws` client creates
   * upgrade requests via http.request() and expects frame-level I/O on the
   * socket from the 'upgrade' event.)
   */
  _handleWebSocketUpgrade(url) {
    const wsUrl = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    const wsKey = String(this.getHeader("sec-websocket-key") || "");
    const NativeWS = _NativeWebSocket;

    if (!NativeWS) {
      queueMicrotask(() => {
        this.emit(
          "error",
          new TypeError("WebSocket is not available in this environment"),
        );
      });
      return;
    }

    // RFC 6455 §1.3: Sec-WebSocket-Accept = base64(sha1(key + GUID)).
    const acceptValue = _sha1Base64(
      wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
    );

    let nativeWs;
    try {
      nativeWs = new NativeWS(wsUrl);
      nativeWs.binaryType = "arraybuffer";
    } catch (e) {
      queueMicrotask(() => {
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
      });
      return;
    }

    const socket = this.socket;
    if (typeof socket.cork !== "function") socket.cork = () => {};
    if (typeof socket.uncork !== "function") socket.uncork = () => {};

    let writeBuffer = new Uint8Array(0);
    socket.write = (chunk, encodingOrCallback, callback) => {
      const data =
        typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
      const cb =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
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
        else if (opcode === 0x09)
          nativeWs.send(payload); // ping -> pong-ish
        else if (opcode === 0x0a) {
          /* pong: ignore */
        } else if (opcode === 0x01)
          nativeWs.send(new TextDecoder().decode(payload));
        else if (opcode === 0x02) nativeWs.send(payload);
      }
      if (cb) queueMicrotask(() => cb(null));
      return true;
    };

    nativeWs.onopen = () => {
      const response = new IncomingMessage(socket);
      response.statusCode = 101;
      response.statusMessage = "Switching Protocols";
      response.headers = {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-accept": acceptValue,
      };
      response.rawHeaders.push(
        "upgrade",
        "websocket",
        "connection",
        "Upgrade",
        "sec-websocket-accept",
        acceptValue,
      );
      response.complete = true;
      response.push(null);
      this.emit("upgrade", response, socket, Buffer.alloc(0));
    };

    nativeWs.onmessage = (event) => {
      let payload;
      let opcode;
      if (typeof event.data === "string") {
        payload = new TextEncoder().encode(event.data);
        opcode = 0x01;
      } else if (event.data instanceof ArrayBuffer) {
        payload = new Uint8Array(event.data);
        opcode = 0x02;
      } else {
        return;
      }
      socket.emit("data", Buffer.from(_createWsFrame(opcode, payload, false)));
    };

    nativeWs.onclose = (event) => {
      const code = event.code || 1000;
      const closePayload = new Uint8Array(2);
      closePayload[0] = (code >> 8) & 0xff;
      closePayload[1] = code & 0xff;
      socket.emit(
        "data",
        Buffer.from(_createWsFrame(0x08, closePayload, false)),
      );
      setTimeout(() => {
        socket.emit("end");
        socket.emit("close", false);
      }, 10);
    };

    nativeWs.onerror = () => {
      socket.emit("error", new Error("WebSocket connection error"));
      socket.destroy();
    };

    const origDestroy = socket.destroy.bind(socket);
    socket.destroy = (error) => {
      if (
        nativeWs.readyState === NativeWS.OPEN ||
        nativeWs.readyState === NativeWS.CONNECTING
      ) {
        try {
          nativeWs.close();
        } catch {
          /* noop */
        }
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
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  );

  let h0 = 0x67452301,
    h1 = 0xefcdab89,
    h2 = 0x98badcfe,
    h3 = 0x10325476,
    h4 = 0xc3d2e1f0;
  const w = new Array(80);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        ((bytes[off + i * 4] << 24) |
          (bytes[off + i * 4 + 1] << 16) |
          (bytes[off + i * 4 + 2] << 8) |
          bytes[off + i * 4 + 3]) >>>
        0;
    }
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const digest = new Uint8Array(20);
  for (const [i, h] of [
    [0, h0],
    [1, h1],
    [2, h2],
    [3, h3],
    [4, h4],
  ]) {
    digest[i * 4] = (h >>> 24) & 0xff;
    digest[i * 4 + 1] = (h >>> 16) & 0xff;
    digest[i * 4 + 2] = (h >>> 8) & 0xff;
    digest[i * 4 + 3] = h & 0xff;
  }
  // base64 (binary-safe, no btoa dependency assumptions)
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < digest.length; i += 3) {
    const b0 = digest[i],
      b1 = digest[i + 1] ?? 0,
      b2 = digest[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out +=
      chars[(n >>> 18) & 63] +
      chars[(n >>> 12) & 63] +
      (i + 1 < digest.length ? chars[(n >>> 6) & 63] : "=") +
      (i + 2 < digest.length ? chars[n & 63] : "=");
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
    payloadLength =
      data[6] * 0x1000000 + ((data[7] << 16) | (data[8] << 8) | data[9]);
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
    if (typeof globalThis.crypto?.getRandomValues === "function") {
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
// Shared server state across duplicate module copies.
//
// The dist bundles are self-contained (esbuild `external: []`), so every
// builtin bundle that transitively includes this module (http, https,
// node:_http_*) carries its OWN copy of this module's top-level state --
// including its own server registry -- and its own `RT.__httpServerRunTime`
// publication (last write wins). The bootstrap also preloads every
// builtin, so by the time user code runs, the published handleRequest may
// belong to a different copy than the Server class user code instantiates.
// Result: "No active HTTP server found" for servers that ARE listening
// (the host's documented __serverRequest__ flow).
//
// The registry (and the wait-for-servers coordination) MUST therefore live
// on the per-sandbox RT object so all copies share one registry per realm.
// Under real Node / direct import (no RT) fall back to module-local state,
// preserving existing behavior.
const _localHttpShared = {
  registry: new Map(),
  waitPromise: null,
  waitResolve: null,
};
function _httpShared() {
  if (RT) {
    if (!RT.__httpSharedState) {
      RT.__httpSharedState = {
        registry: new Map(),
        waitPromise: null,
        waitResolve: null,
      };
    }
    return RT.__httpSharedState;
  }
  return _localHttpShared;
}

function _resolveWaitForServers() {
  const s = _httpShared();
  if (s.waitResolve) {
    const resolve = s.waitResolve;
    s.waitPromise = null;
    s.waitResolve = null;
    resolve();
  }
}

/** Resolves when every virtual server has closed (runtime completion hook). */
function _waitForAllServers() {
  const s = _httpShared();
  if (s.registry.size === 0) {
    return Promise.resolve();
  }
  if (!s.waitPromise) {
    s.waitPromise = new Promise((resolve) => {
      s.waitResolve = resolve;
    });
  }
  return s.waitPromise;
}

function _registerServer(port, server) {
  _httpShared().registry.set(port, server);
}

function _unregisterServer(port) {
  const s = _httpShared();
  s.registry.delete(port);
  if (s.registry.size === 0) {
    _resolveWaitForServers();
  }
}

// Host-side hook: forcibly close the server bound to `port`. The parent
// runtime uses this to revoke a port whose host-route claim was lost — e.g.
// a second sandbox claimed the same port first at the host registry. The
// server gets an EADDRINUSE 'error' (mirroring listen() on a taken port,
// delivered to 'error' listeners only) followed by 'close', and the port is
// unregistered. Returns true if a server was closed, false otherwise.
function closeServer(port) {
  const server = _httpShared().registry.get(port);
  if (!server) return false;
  const err = makeError(
    "EADDRINUSE",
    `listen EADDRINUSE: address already in use :::${port}`,
  );
  err.port = port;
  queueMicrotask(() => {
    try {
      server.emit("error", err);
    } catch {}
  });
  server.close();
  return true;
}

function getServer(port) {
  return _httpShared().registry.get(port);
}

function getAllServers() {
  return new Map(_httpShared().registry);
}

// ---------------------------------------------------------------------------
// Phase 2: real byte-level HTTP round trips over virtual net.js sockets.
// The client loopback and the host runtime bridge both go through here —
// the request is serialized to HTTP/1.1 bytes, written to net.connect(port),
// and the response is parsed with HTTPParser in response mode. No more
// direct handleRequest() calls on the hot path.
// ---------------------------------------------------------------------------

/**
 * Serialize one HTTP/1.1 request head (+ optional body) to bytes.
 * Ensures Host, Content-Length (when there is a body) and
 * `Connection: close` (the client does no socket pooling, so every
 * loopback request gets a fresh connection like Node's default agent
 * would eventually recycle).
 */
function _serializeRequestHead(
  method,
  path,
  headers,
  body,
  noDefaultHost = false,
) {
  const lines = [`${method} ${path} HTTP/1.1`];
  let hasHost = false;
  let hasContentLength = false;
  let hasConnection = false;
  const push = (name, value) => lines.push(`${name}: ${value}`);
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (lower === "host") hasHost = true;
    else if (lower === "content-length") hasContentLength = true;
    else if (lower === "connection") hasConnection = true;
    if (Array.isArray(value)) {
      // Like Node on the wire: one header line per element.
      for (const v of value) push(name, v);
    } else {
      push(name, value);
    }
  }
  if (!hasHost && !noDefaultHost) push("Host", "localhost");
  const bodyBuf =
    body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (!hasContentLength && bodyBuf && bodyBuf.length > 0) {
    push("Content-Length", String(bodyBuf.length));
  }
  if (!hasConnection) push("Connection", "close");
  lines.push("", "");
  const head = Buffer.from(lines.join("\r\n"));
  return bodyBuf && bodyBuf.length > 0 ? Buffer.concat([head, bodyBuf]) : head;
}

/**
 * Perform one HTTP request/response exchange over a virtual socket.
 *
 * Resolves { statusCode, statusMessage, rawHeaders, body }. Rejects on
 * socket errors, parser errors, or a close before the response completes.
 * `onSocket` (optional) receives the connected socket — the client uses it
 * to swap its synthetic socket for the real one and emit 'socket'.
 */
// Whether the request headers carry an Upgrade header (object form from
// _virtualHeaders, or array-form pairs). Used to gate 101-at-headers
// resolution: only an upgrade request can legitimately receive a 101.
function _requestHasUpgradeHeader(headers) {
  if (!headers) return false;
  if (Array.isArray(headers)) {
    return headers.some(
      ([k]) => typeof k === "string" && k.toLowerCase() === "upgrade",
    );
  }
  return Object.keys(headers).some((k) => k.toLowerCase() === "upgrade");
}

function _socketHttpRoundTrip(
  port,
  {
    method,
    path,
    headers,
    body,
    socket,
    onSocket,
    onHeaders,
    onBody,
    streaming,
    headBytes,
    onStreamReady,
    noDefaultHost = false,
  },
) {
  return new Promise((resolve, reject) => {
    const sock = socket || netConnect(port);
    let settled = false;
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      // This round trip is over: detach its socket listeners. The socket
      // may return to the agent pool and be reused by another request,
      // whose own round trip attaches fresh listeners — leaving ours in
      // place would feed the next response to this trip's parser too,
      // emitting 'response' on the completed request as well.
      // (test-http-agent-timeout block 1)
      sock.removeListener("data", onData);
      sock.removeListener("error", onSockError);
      sock.removeListener("close", onSockClose);
      // The caller owns the socket in all cases now (streaming or not).
      // It releases it to the agent pool via _releaseAgentSocket() or
      // destroys it via ClientRequest.destroy().
      fn(value);
    };
    const ok = settle(resolve);
    const fail = settle(reject);

    const parser = new HTTPParser("response");
    // HEAD responses never have a body, regardless of framing.
    parser.isHeadResponse = method === "HEAD";
    const chunks = [];
    let info = null;
    parser.onHeadersComplete = (i) => {
      info = i;
      // CONNECT responses are tunnels, not responses: real Node delivers
      // EVERY status via the request's 'connect' event, never 'response'
      // (probed v24.22.1: 100, 200, 201, 404, 407, 500 all 'connect').
      // Resolve at headers with the head bytes — never wait for EOF,
      // since a 200 has no length framing. The caller emits 'connect'
      // and owns (or destroys) the socket; settling here detaches the
      // round trip's data listener, so later tunnel bytes flow only to
      // the app's socket listeners.
      if (method === "CONNECT") {
        let head = Buffer.alloc(0);
        try {
          head = parser.takeRemainder();
        } catch {
          /* empty head */
        }
        ok({
          statusCode: info.statusCode,
          statusMessage: info.statusMessage,
          rawHeaders: info.rawHeaders.slice(),
          body: Buffer.alloc(0),
          connectHead: head,
          isConnect: true,
        });
        return;
      }
      // 101 Switching Protocols: like CONNECT, a 101 has no body
      // framing, so the round trip must resolve at headers — never wait
      // for onMessageComplete, which never fires for a 101. Gated on the
      // request carrying an Upgrade header: only an upgrade request can
      // legitimately receive a 101. The caller emits 'upgrade' with the
      // head bytes (parser remainder) instead of 'response'. Pause
      // first: settling detaches the round trip's data listener mid-flow
      // (the flow loop is already running), and a detached-but-still-
      // flowing socket emits the next buffered chunk to zero listeners,
      // losing it (test-http-upgrade-client's "nurtzo", written as a
      // separate chunk after the header block). Pausing stops the loop
      // so post-header bytes stay buffered for the app; the caller
      // resumes after 'upgrade' is emitted.
      if (info.statusCode === 101 && _requestHasUpgradeHeader(headers)) {
        try {
          sock.pause();
        } catch {
          /* best effort */
        }
        let head = Buffer.alloc(0);
        try {
          head = parser.takeRemainder();
        } catch {
          /* empty head */
        }
        ok({
          statusCode: info.statusCode,
          statusMessage: info.statusMessage,
          rawHeaders: info.rawHeaders.slice(),
          body: Buffer.alloc(0),
          upgradeHead: head,
          isUpgrade: true,
        });
        return;
      }
      // Streaming: notify the caller immediately so it can emit 'response'.
      if (typeof onHeaders === "function") {
        try {
          onHeaders(i);
        } catch {
          /* listener errors are not fatal */
        }
      }
    };
    parser.onBody = (chunk) => {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      // Streaming: push body chunks to the caller as they arrive.
      if (typeof onBody === "function") {
        try {
          onBody(buf);
        } catch {
          /* listener errors are not fatal */
        }
      }
    };
    parser.onMessageComplete = () => {
      ok({
        statusCode: info.statusCode,
        statusMessage: info.statusMessage,
        rawHeaders: info.rawHeaders.slice(),
        body: Buffer.concat(chunks),
        rawTrailers: parser.rawTrailers ? parser.rawTrailers.slice() : [],
      });
    };
    parser.onError = (err) => {
      // Node's client socket-error shape (probed v24.22.1, mirrored from
      // the server-side clientError normalization): message "Parse
      // Error: <llhttp reason>", code, bytesParsed, rawPacket.
      // HPE_TRUNCATED keeps today's shape: real Node reports a truncated
      // response as response 'aborted' + ECONNRESET, not a parse error,
      // and that divergence is separate work (no test hinges on it).
      if (err.code !== "HPE_TRUNCATED") {
        if (err.code === "HPE_INVALID_METHOD") {
          err.message = "Parse Error: Invalid method encountered";
        } else if (
          typeof err.message === "string" &&
          !err.message.startsWith("Parse Error:")
        ) {
          err.message = `Parse Error: ${err.message}`;
        }
      }
      fail(err);
    };

    const doConnect = () => {
      if (typeof onSocket === "function") {
        try {
          onSocket(sock);
        } catch {
          /* listener errors are not fatal */
        }
      }
      try {
        if (streaming) {
          // Streaming request: head bytes were pre-serialized by the
          // caller (framing decided at first write); body chunks arrive
          // later via the writer. Head first, then frames, in order.
          sock.write(headBytes);
          if (typeof onStreamReady === "function") {
            onStreamReady({
              write(buf) {
                try {
                  // Never write into a socket that was released to the
                  // agent pool (possibly reused by another request) or
                  // destroyed: further body bytes are dropped, matching
                  // the post-response-complete case.
                  if (sock.destroyed || sock._inFreePool) return;
                  sock.write(buf);
                } catch {
                  /* socket write failed; the round trip surfaces it */
                }
              },
            });
          }
        } else {
          sock.write(
            _serializeRequestHead(method, path, headers, body, noDefaultHost),
          );
        }
      } catch (err) {
        fail(err);
      }
    };
    // If the socket is already connected (e.g. reused from the agent pool),
    // write the request immediately; otherwise wait for 'connect'.
    if (sock.connecting) {
      sock.once("connect", doConnect);
    } else {
      queueMicrotask(doConnect);
    }
    const onData = (chunk) => {
      try {
        parser.execute(chunk);
      } catch (err) {
        fail(err);
      }
    };
    const onSockError = (err) =>
      fail(err instanceof Error ? err : new Error(String(err)));
    const onSockClose = () => {
      if (settled) return;
      // A response framed to EOF completes on close; anything else closing
      // early is a truncated response.
      try {
        parser.end();
      } catch {
        /* fall through to fail */
      }
      if (!settled) {
        // No headers ever arrived (server destroyed the socket before
        // responding, e.g. an unhandled upgrade): real Node reports
        // ECONNRESET "socket hang up", not a truncation error
        // (test-http-upgrade-server-callback's true-without-handler
        // case). Headers received but body cut short stays
        // ERR_SOCKET_CLOSED.
        if (info === null) {
          const e = new Error("socket hang up");
          e.code = "ECONNRESET";
          fail(e);
        } else {
          fail(
            makeError(
              "ERR_SOCKET_CLOSED",
              "Socket closed before the HTTP response completed",
            ),
          );
        }
      }
    };
    sock.on("data", onData);
    sock.on("error", onSockError);
    sock.on("close", onSockClose);
  });
}

class ServerBase extends EventEmitter {
  constructor(optionsOrListener, requestListener) {
    super();
    let options;
    if (typeof optionsOrListener === "function") {
      requestListener = optionsOrListener;
      options = {};
    } else if (optionsOrListener == null) {
      options = {};
    } else if (
      typeof optionsOrListener === "object" &&
      !Array.isArray(optionsOrListener)
    ) {
      options = optionsOrListener;
    } else {
      throw ERR_INVALID_ARG_TYPE(
        "options",
        ["Object", "Function"],
        optionsOrListener,
      );
    }
    this._requestListener = requestListener;
    if (requestListener) {
      this.on("request", requestListener);
    }

    this.listening = false;
    this.maxHeadersCount = null;
    // maxConnections is a plain property in real Node, read at accept
    // time — so it must work whether assigned before or after listen().
    // The accessor stores the value and forwards it to the backing net
    // server whenever one exists; listen() applies the stored value to a
    // freshly created net server. Without this, an http server's
    // maxConnections never reached net's _acceptConnection check and
    // over-limit connections were served instead of dropped.
    this._maxConnections = null;
    this.maxRequestsPerSocket = options.maxRequestsPerSocket ?? 0;
    // createServer({ shouldUpgradeCallback }) — probed real Node
    // v24.22.1 (test-http-upgrade-server-callback): the callback decides
    // whether an Upgrade request is really upgraded. false routes the
    // request to normal 'request' dispatch (even with an 'upgrade'
    // listener); true with no 'upgrade' listener destroys the socket
    // (client sees ECONNRESET); a throw propagates to uncaughtException.
    // A non-function value is ignored (no official test covers it).
    this._shouldUpgradeCallback =
      typeof options.shouldUpgradeCallback === "function"
        ? options.shouldUpgradeCallback
        : null;
    // createServer({ noDelay }) — probed real Node v24.22.1: default
    // true; the option is Boolean-coerced at construction (0 -> false,
    // 'x' -> true, null -> true). Later assignment stores verbatim
    // (plain property, no setter). No JS-level setNoDelay call on
    // accepted sockets was observed on real Node, so the property is
    // the whole contract here (test-http-nodelay asserts the property
    // and the client connect options, nothing server-side).
    this.noDelay = options.noDelay == null ? true : Boolean(options.noDelay);
    // createServer({ uniqueHeaders }) — same send-side-only semantics as
    // the request option (probed real Node v24.22.1); forwarded to each
    // ServerResponse at dispatch. Affects response headers (via
    // _storeHeader) and response trailers (via _chunkTerminator).
    this._serverUniqueHeaders = Array.isArray(options.uniqueHeaders)
      ? new Set(options.uniqueHeaders.map((n) => String(n).toLowerCase()))
      : null;
    this.timeout = 0;
    this.headersTimeout = options.headersTimeout ?? 60000;
    this.requestTimeout = options.requestTimeout ?? 300000;
    this.keepAliveTimeout = options.keepAliveTimeout ?? 5000;
    // createServer({ IncomingMessage }) — the per-request message class.
    // Stored raw; dispatch uses it only when it is a constructor, so an
    // invalid value falls back to the default instead of crashing the
    // loop (real Node dies with "ParserIncomingMessage is not a
    // constructor" there; no official test covers invalid values, and a
    // browser shim must not take the whole page down for one bad option).
    this._incomingMessageClass = options.IncomingMessage;
    // createServer({ highWaterMark }) — forwarded to every req/res pair:
    // req._readableState.highWaterMark and res[kHighWaterMark] (plus the
    // res Writable state) all read it; the default is
    // getDefaultHighWaterMark() (65536). Probed real Node v24.22.1:
    // non-number values throw ERR_INVALID_ARG_TYPE at createServer;
    // negative integers fall back to the default; non-integer numbers
    // throw ERR_INVALID_ARG_VALUE at connection time in real Node — here
    // at createServer instead, so a bad value fails loudly at setup
    // rather than as a swallowed mid-dispatch throw (which would hang
    // the exchange, the failure mode this lane family keeps fixing).
    if (
      options.highWaterMark !== undefined &&
      typeof options.highWaterMark !== "number"
    ) {
      throw ERR_INVALID_ARG_TYPE(
        "options.highWaterMark",
        "number",
        options.highWaterMark,
      );
    }
    if (
      typeof options.highWaterMark === "number" &&
      !Number.isInteger(options.highWaterMark)
    ) {
      throw ERR_INVALID_ARG_VALUE(
        "options.highWaterMark",
        options.highWaterMark,
      );
    }
    const serverHwm = options.highWaterMark;
    this._highWaterMark =
      serverHwm === undefined || serverHwm < 0
        ? getDefaultHighWaterMark(false)
        : serverHwm;
    this.connectionsCheckingInterval =
      options.connectionsCheckingInterval ?? 30000;
    this._port = null;
    this._host = null;
    // Real virtual-network connections (src/net.js sockets), tracked for
    // getConnections() / closeAllConnections() / closeIdleConnections().
    this._connections = new Set();
    this._netServer = null;
    // server.unref() state, sticky across listen() calls: the net server
    // is recreated on every listen(), so an unref() issued before the
    // first (or a later) listen must be re-applied to the fresh net
    // server — real Node keeps an unref-before-listen (probed: the
    // process still exits once the server-side socket drains). Without
    // this, ServerBase.unref() was a no-op and the net server's
    // ref'd loop-keeper timer held the process open forever after the
    // exchange drained (test-http-server-delete-parser).
    this._unrefed = false;
    // Node's http.Server IS a net.Server: emitting 'connection' on it
    // runs the HTTP connection handling (test-http-server-multiple-
    // client-error manually emits 'connection' after reading one byte
    // off a net socket). The guard in _onSocketConnection makes the
    // normal path (netServer accept -> _onSocketConnection -> this
    // emit) idempotent, so this listener is a no-op there.
    this.on("connection", (socket) => this._onSocketConnection(socket, true));
    // Connections-checking interval timer (Node's connectionsCheckingInterval
    // polling for headersTimeout/requestTimeout/keepAliveTimeout). Started
    // lazily on first connection, unref'd, stopped when idle/closed.
    this._checkTimer = null;
  }

  // Real Node reads maxConnections at accept time, so assignment after
  // listen() must take effect too: forward to the backing net server
  // whenever one exists (listen() applies the stored value at creation).
  get maxConnections() {
    return this._maxConnections;
  }
  set maxConnections(value) {
    this._maxConnections = value;
    if (this._netServer) this._netServer.maxConnections = value;
  }

  listen(portOrOptions, hostOrCallback, callback) {
    let port;
    let host;
    let cb;

    if (
      typeof portOrOptions === "number" ||
      typeof portOrOptions === "string"
    ) {
      port = Number(portOrOptions);
      if (typeof hostOrCallback === "string") {
        host = hostOrCallback;
        cb = callback;
      } else {
        cb = hostOrCallback;
      }
    } else if (portOrOptions && typeof portOrOptions === "object") {
      port =
        portOrOptions.port !== undefined ? Number(portOrOptions.port) : port;
      host = portOrOptions.host;
      cb = typeof hostOrCallback === "function" ? hostOrCallback : callback;
    } else if (typeof portOrOptions === "function") {
      cb = portOrOptions;
    } else if (portOrOptions == null && typeof hostOrCallback === "function") {
      cb = hostOrCallback;
    }

    if (!port || Number.isNaN(port)) {
      // Ephemeral port, like Node's listen(0).
      do {
        port = 1024 + Math.floor(Math.random() * (65535 - 1024));
      } while (_httpShared().registry.has(port));
    }

    if (_httpShared().registry.has(port)) {
      const err = makeError(
        "EADDRINUSE",
        `listen EADDRINUSE: address already in use :::${port}`,
      );
      err.port = port;
      queueMicrotask(() => this.emit("error", err));
      return this;
    }

    this._port = port;
    this._host = host || "::";
    _registerServer(port, this);
    // Real virtual-network round trip: bind a net.js socket server on the
    // same port so req.socket is a genuine connected socket with real
    // remoteAddress/remotePort/byte counts. net.connect(port) finds this
    // server through the wildcard keys ('::' / '0.0.0.0').
    // Forward the server highWaterMark: real Node gives http accepted
    // sockets the server's mark (default 65536, probed v24.22.1), so
    // res.writableHighWaterMark === req.socket.writableHighWaterMark
    // (test-http-outgoing-properties); without it the net default
    // 16384 leaks through and the equality fails.
    const netServer = createNetServer({ highWaterMark: this._highWaterMark });
    netServer.on("connection", (socket) => this._onSocketConnection(socket));
    netServer.on("error", (err) => this.emit("error", err));
    // Forward the backing net server's 'drop' event: the test listens for
    // 'drop' on the http server, and net's _acceptConnection is the only
    // enforcement point (over-limit sockets never reach
    // _onSocketConnection).
    netServer.on("drop", (data) => this.emit("drop", data));
    netServer.maxConnections = this._maxConnections;
    this._netServer = netServer;
    netServer.listen(port, this._host);
    // Apply a sticky unref() issued before this listen() (see _unrefed).
    if (this._unrefed) netServer.unref();
    this.listening = true;
    // emitMe(fn, method, ...args) serializes only ...args — the payload must
    // go in args (3rd position), not method, or the parent sees an empty message.
    emitEvent?.("serverListening", null, { port });
    queueMicrotask(() => {
      this.emit("listening");
      if (cb) cb.call(this);
    });
    return this;
  }

  close(callback) {
    if (typeof callback === "function") {
      if (!this.listening) queueMicrotask(callback);
      else this.once("close", callback);
    }
    if (this._port !== null) {
      const port = this._port;
      this._port = null;
      _unregisterServer(port);
      emitEvent?.("serverClosed", null, { port });
    }
    if (this._netServer) {
      this._netServer.close();
      this._netServer = null;
    }
    // Real Node (probed v24.22.1): server.close() destroys connections
    // that are idle at close time — the client sees EOF + close at once
    // and the loop drains — while connections with a request in flight
    // survive and complete. Refined by test-http-outgoing-drain-
    // writable-length: "survive" means the response still completes,
    // not that the socket lives forever — when such a response
    // finishes, the socket is destroyed (the client sees close and the
    // loop drains). Flagged here; _finishSocketResponse takes the
    // destroy path at finish when the flag is set and no further
    // pipelined dispatch started. Same predicate as
    // closeIdleConnections(). Refined by test-http-server-close-idle:
    // a connection mid-request — even a partial start line with no
    // CRLF yet, which never dispatched — is NOT idle (parser
    // onMessageStart has fired, state.receiving is true), so it
    // survives close() too. Unlike a busy connection it gets no
    // serverClosing flag: probed real Node leaves it open after its
    // late response completes, so it keeps keep-alive like normal.
    for (const socket of [...this._connections]) {
      const state = socket._httpState;
      if (!state || (!state.busy && !state.receiving)) {
        try {
          socket.destroy();
        } catch {
          /* best effort */
        }
      } else if (state.busy) {
        state.serverClosing = true;
      }
    }
    this._stopConnectionChecker();
    this.listening = false;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  closeAllConnections() {
    for (const socket of this._connections) {
      socket.destroy();
    }
    return this;
  }

  closeIdleConnections() {
    for (const socket of this._connections) {
      const state = socket._httpState;
      if (!state || (!state.busy && !state.receiving)) socket.destroy();
    }
    return this;
  }

  /**
   * Server timeout enforcement (Node's connectionsCheckingInterval
   * polling model — probed real Node v24: a 408 lands on the first tick
   * AFTER its deadline, not exactly at it).
   *
   * Per socket, exactly one clock runs at a time:
   * - fresh (no request ever started): headersTimeout/requestTimeout
   *   from connection time — a connection that sends nothing still gets
   *   a 408 (test-http-server-*-delayed-headers).
   * - receiving: headersTimeout until headers complete, requestTimeout
   *   until the whole request is received, both from the request's first
   *   byte (probed: headers at +1500ms with a 2000ms requestTimeout
   *   still 408s at ~2000ms, not ~3500ms).
   * - idle after a response: keepAliveTimeout from response finish;
   *   the socket is destroyed silently (no 408). Fresh sockets are
   *   exempt (probed: never-requested connections are not closed).
   * - responding (request received, response in flight): no clock.
   * - upgraded: exempt entirely.
   *
   * A 0 timeout disables that clock; a non-numeric timeout (app-assigned
   * garbage) compares false everywhere and can neither fire nor crash
   * (test-http-server-invalid-headers-timeout-no-abort). headers/request
   * timeouts never emit the server 'timeout' event — they send the exact
   * 408 Node sends and close (the tests assert 'timeout' mustNotCall).
   */
  _startConnectionChecker() {
    if (this._checkTimer) return;
    const raw = Number(this.connectionsCheckingInterval);
    const interval = Number.isFinite(raw) && raw > 0 ? raw : 30000;
    const timer = setInterval(() => this._checkConnections(), interval);
    timer.unref?.();
    this._checkTimer = timer;
  }

  _stopConnectionChecker() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  _checkConnections() {
    const now = Date.now();
    for (const socket of [...this._connections]) {
      try {
        if (socket.destroyed) continue;
        const state = socket._httpState;
        if (!state || state.upgraded || state.timedOut) continue;
        if (state.fresh) {
          const elapsed = now - state.connectedAt;
          if (
            (this.headersTimeout > 0 && elapsed > this.headersTimeout) ||
            (this.requestTimeout > 0 && elapsed > this.requestTimeout)
          ) {
            this._timeoutSocket(socket, state);
          }
          continue;
        }
        if (state.receiving) {
          const elapsed = now - state.requestStart;
          const headersOver =
            !state.headersDone &&
            this.headersTimeout > 0 &&
            elapsed > this.headersTimeout;
          const requestOver =
            this.requestTimeout > 0 && elapsed > this.requestTimeout;
          if (headersOver || requestOver) {
            this._timeoutSocket(socket, state);
          }
          continue;
        }
        if (state.idleSince !== null) {
          if (
            this.keepAliveTimeout > 0 &&
            now - state.idleSince > this.keepAliveTimeout
          ) {
            try {
              socket.destroy();
            } catch {
              /* best effort */
            }
          }
        }
      } catch {
        // One bad socket (or one weird timeout value) must not kill the
        // checker for every other connection.
      }
    }
  }

  _timeoutSocket(socket, state) {
    state.timedOut = true;
    try {
      socket.write("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n");
    } catch {
      /* best effort */
    }
    try {
      socket.destroy();
    } catch {
      /* best effort */
    }
  }

  address() {
    if (!this.listening || this._port === null) return null;
    return { address: this._host, family: "IPv6", port: this._port };
  }

  getConnections(callback) {
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, this._connections.size));
    }
    return this;
  }

  /**
   * Accept a real virtual-network connection (from the net.js server bound
   * in listen()). Requests are parsed from actual HTTP bytes; req.socket is
   * the genuine connected socket. One request is handled at a time per
   * connection (no pipelined concurrency); further bytes are gated until the
   * current response finishes.
   */
  _onSocketConnection(socket, fromManualEmit = false) {
    // Idempotence guard for the constructor's 'connection' listener:
    // _onSocketConnection itself emits 'connection' below, and a
    // manually-emitted connection re-enters here — the socket already
    // has its parser and handlers from the first call.
    if (socket._httpState) return;
    this._connections.add(socket);
    // Like Node's _http_server, the HTTP layer — not the stream layer —
    // decides when an EOF'd socket closes: with allowHalfOpen set, a peer
    // FIN no longer auto-ends the writable side while a response is still
    // in flight. The 'end' handler below records the EOF (state.peerEnded)
    // and _finishSocketResponse closes the socket after the response.
    socket.allowHalfOpen = true;
    const state = {
      busy: false, // a request is being handled; parser input is gated
      awaitingBody: false, // the in-flight request still expects body bytes
      pending: [], // chunks received while busy
      reqCount: 0,
      current: null, // { req, res } for the in-flight request
      peerEnded: false, // peer sent FIN; close once the response is out
      inFlight: 0, // dispatched requests whose response has not finished
      // Server timeout accounting (headersTimeout / requestTimeout /
      // keepAliveTimeout, enforced by _checkConnections polling):
      connectedAt: Date.now(),
      fresh: true, // no request has started on this socket yet
      receiving: false, // a request is currently being received
      requestStart: 0, // first byte of the current request
      headersDone: false, // current request's headers are complete
      idleSince: null, // set when a response finishes and the socket idles
      upgraded: false, // connection upgraded; HTTP timeouts no longer apply
      connect: false, // CONNECT tunnel; no response pending, peer FIN ends it
      timedOut: false, // a 408 was already sent on this socket
      parserFreed: false, // socket.parser.free() called (exactly once)
    };
    socket._httpState = state;
    // Node parity: server sockets expose their HTTP parser as socket.parser
    // (real Node: the llhttp HTTPParser instance, freed exactly once at
    // socket close, after which socket.parser reads null — probed on real
    // Node v24.22.1: free() fires at socket close, NOT at response finish).
    // The shim's parser is internal, so this is a minimal facade with the
    // shape the surface needs: free()/close() plus the socket reference.
    // The 'close' handler below invokes the CURRENT facade's free(), so
    // app replacements of parser.free (e.g. mustCall wrappers) observe
    // the real close-time call.
    socket.parser = {
      socket,
      incoming: null,
      outgoing: null,
      free() {
        // No pool to return to: the shim's parser is per-connection.
      },
      close() {
        // No-op: the shim parser holds no native resources.
      },
    };
    const onHttpClose = () => {
      this._connections.delete(socket);
      if (this._connections.size === 0) this._stopConnectionChecker();
      if (state.current) {
        state.current.req.aborted = true;
        state.current.req.emit("aborted");
        // Real Node (probed): a socket close destroys the in-flight
        // response, so its 'close' fires (test-http-outgoing-destroyed
        // block 3: client res.destroy() -> server socket close ->
        // server res 'close'). The dispatch stash covers requests
        // whose body already completed (current is cleared at
        // onMessageComplete), so destroy that too when unfinished.
        const curRes = state.current.res;
        if (curRes && !curRes.destroyed && !curRes.closed) {
          try {
            curRes.destroy();
          } catch {
            /* ignore */
          }
        }
        state.current = null;
      }
      const stashed = state.lastResponse;
      if (
        stashed &&
        !stashed.destroyed &&
        !stashed.closed &&
        !stashed.finished
      ) {
        try {
          stashed.destroy();
        } catch {
          /* ignore */
        }
      }
      // Free the parser facade exactly once at socket close, then read
      // socket.parser as null (real-Node behavior). The try/catch keeps a
      // throwing app replacement from breaking close handling.
      const facade = socket.parser;
      if (facade && !state.parserFreed) {
        state.parserFreed = true;
        try {
          facade.free();
        } catch {
          /* app replacement threw; close proceeds */
        }
        socket.parser = null;
      }
      // Release the real parser's request-capturing callbacks at socket
      // close, so a finished request can be garbage collected on a clean
      // keep-alive close (test-http-server-keepalive-req-gc): onBody and
      // onMessageComplete close over the dispatched { req, res }, and the
      // client-side socket still links to this socket via _peer after a
      // graceful FIN (a FIN deliberately does not null the link, so the
      // peer stays writable). Before #246, the trailing CRLF tripped a
      // parse error whose socket.destroy() nulled the peer link and freed
      // req by accident; the clean-close path never released it, so req
      // stayed reachable forever and the test hung. Clearing here is
      // safe: a closed socket is never parsed again.
      parser.onBody = null;
      parser.onMessageComplete = null;
      parser.onHeadersComplete = null;
      parser.onMessageStart = null;
      parser.onError = null;
      state.parser = null;
      // Same release as _finishSocketResponse below: the dispatch stash
      // pins res -> req, and the peer link survives a graceful FIN.
      state.lastResponse = null;
    };
    socket.on("close", onHttpClose);
    // Node parity: servers emit 'connection' for every accepted socket.
    // A manually-emitted connection (fromManualEmit) already fired the
    // app's 'connection' listeners via the outer emit — re-emitting
    // here would fire them twice (Node's connectionListenerInternal
    // never re-emits).
    if (!fromManualEmit) this.emit("connection", socket);
    this._startConnectionChecker();
    // Socket timeout wiring (server.setTimeout): applied at connection
    // time ONLY — a later setTimeout() call does not touch existing
    // connections (probed real-Node behavior). The socket is NOT
    // destroyed on 'timeout'; the app decides. The event is forwarded to
    // the server and to the in-flight request, so req.setTimeout
    // callbacks fire on socket inactivity while body data resets the
    // timer (net.js refreshes it on every received chunk).
    if (typeof socket.setTimeout === "function" && this.timeout > 0) {
      socket.setTimeout(this.timeout);
    }
    const onHttpTimeout = () => {
      this.emit("timeout", socket);
      const cur = state.current;
      if (cur) cur.req.emit("timeout");
    };
    socket.on("timeout", onHttpTimeout);

    const parser = new HTTPParser("request");
    // Strict one-request-at-a-time: the parser pauses after each message and
    // only resumes once the in-flight response has been fully written.
    parser.pauseBetweenMessages = true;
    // A request's headersTimeout/requestTimeout clock starts at its first
    // byte (probed real Node); the fresh-connection clock (below) runs
    // from connection time until this first fires.
    parser.onMessageStart = () => {
      state.fresh = false;
      state.receiving = true;
      state.requestStart = Date.now();
      state.headersDone = false;
      state.idleSince = null;
    };
    parser.onHeadersComplete = (info) => {
      state.busy = true;
      state.headersDone = true;
      state.awaitingBody = info.hasBody;
      const created = this._dispatchSocketRequest(socket, info, state);
      state.current = created;
      // Wired BEFORE the 100-continue ack below: net.js virtual sockets
      // deliver writes synchronously, so the interim response can
      // reentrantly pull the request body in on this same tick.
      parser.onBody = (chunk) => created.req._pushBody(chunk);
      parser.onMessageComplete = () => {
        state.awaitingBody = false;
        state.receiving = false;
        // Trailers arrive with the chunked terminator, after dispatch:
        // fold them into the request before 'end' fires, so handlers
        // asserting req.rawTrailers / req.trailers in 'end' see them
        // (test-http-multiple-headers). parser.rawTrailers resets per
        // message (_resetMessage), so no cross-request leak. The client
        // round-trip path already applies its own copy (result.rawTrailers).
        if (parser.rawTrailers && parser.rawTrailers.length > 0) {
          IncomingMessage._applyRawTrailers(created.req, parser.rawTrailers);
        }
        created.req._finishBody();
        state.current = null;
      };
      if (
        info.headers.expect === "100-continue" &&
        info.httpVersionMajor === 1 &&
        info.httpVersionMinor === 1
      ) {
        socket.write("HTTP/1.1 100 Continue\r\n\r\n");
      }
    };
    parser.onError = (err) => {
      // The message is dead: a later close()/closeIdleConnections()
      // must not mistake this socket for one still receiving a request
      // (test-http-double-content-length: the clientError handler throws
      // before destroying, the client still errors, and server.close()
      // must destroy the errored socket so the loop drains — sparing it
      // as "receiving" hangs the test). Busy sockets are unaffected:
      // they stay spared via state.busy.
      state.receiving = false;
      // Node's clientError/socket-error shape (probed on real Node
      // v24.22.1): message "Parse Error: <llhttp reason>", code,
      // bytesParsed, rawPacket. Only the method reason is asserted
      // exactly by official tests; other codes keep the parser's
      // message behind the same prefix.
      if (err.code === "HPE_INVALID_METHOD") {
        err.message = "Parse Error: Invalid method encountered";
      } else if (!err.message.startsWith("Parse Error:")) {
        err.message = `Parse Error: ${err.message}`;
      }
      if (this.listenerCount("clientError") > 0) {
        // The handler owns the socket now: no automatic 400, no
        // destroy, no socket 'error' (probed: a listener that does not
        // destroy leaves the socket open and silent).
        this.emit("clientError", err, socket);
        return;
      }
      // No listener: Node writes the 400 and destroys the socket with
      // the error, so socket 'error' fires (test-http-server-destroy-
      // socket-on-client-error) and the client sees 'end' after the
      // 400 bytes. Chunk extension too large → 413 (Node's behavior).
      this.emit("clientError", err, socket);
      if (!socket.destroyed) {
        try {
          if (err.statusCode === 413) {
            socket.write(
              "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n",
            );
          } else {
            // Node's default clientError response carries no
            // Content-Length (test-http-blank-header matches it exactly).
            socket.write(
              "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n",
            );
          }
        } catch {
          /* best effort */
        }
        socket.destroy(err);
      }
    };
    // Malformed pipelined data must surface clientError even when it
    // arrived in the same chunk as a complete request — no further 'data'
    // event is guaranteed to arrive and feed the parser's buffered
    // remainder (test-http-blank-header). Validate the remainder whenever
    // a message completes and its response is still pending.
    const validatePipelinedRemainder = () => {
      while (
        state.busy &&
        !state.awaitingBody &&
        parser.hasBufferedRemainder()
      ) {
        try {
          parser.unpause();
          parser.execute();
        } catch (err) {
          // Parser errors are reported via onError; an owner-callback
          // throw (parser.execute rethrows non-HPE errors) propagates
          // like the bare execute() paths below.
          if (!(typeof err.code === "string" && err.code.startsWith("HPE_"))) {
            throw err;
          }
          break;
        }
      }
    };
    const onHttpData = (chunk) => {
      // Upgraded connections belong to the app now (e.g. socket.pipe
      // echo): their bytes are not HTTP and must never reach the parser,
      // or a WebSocket frame would trip clientError and destroy the
      // socket (test-http-server-request-timeout-upgrade).
      if (state.upgraded) return;
      // While a request is in flight, only its own body may flow; anything
      // else (e.g. a pipelined next request) waits for the response.
      // Exception: if we're not awaiting a body, feed the parser so it can
      // detect malformed pipelined data (e.g. blank header test) and emit
      // clientError → 400. The dispatch is still gated by state.busy.
      if (state.busy && !state.awaitingBody) {
        // Peek: if this looks like a new request (not body data), let the
        // parser validate it. The parser is paused between messages; unpause
        // to check. If it errors, onError sends 400.
        try {
          parser.unpause();
          parser.execute(chunk);
        } catch (err) {
          // Parser error handled via onError; an owner-callback throw
          // propagates (see the parser.execute rethrow rule).
          if (!(typeof err.code === "string" && err.code.startsWith("HPE_"))) {
            throw err;
          }
        }
        // If the parser completed a message (onHeadersComplete fired), it
        // will have set state.busy (already true). We do NOT dispatch here;
        // the dispatch happens when the current response finishes. For now,
        // just buffer if not yet handled.
        // (If onHeadersComplete didn't fire, the data was invalid and 400
        // was sent via onError, or it's partial and will be buffered.)
        validatePipelinedRemainder();
        return;
      }
      if (state.busy && state.awaitingBody) {
        // The parser is mid-message: these bytes are the in-flight
        // request's body. Feed them — parking them until the response
        // finishes deadlocks, since the response waits for the body.
        // Bytes past the end of this message stay buffered inside the
        // parser (it pauses between messages) and are parsed once
        // _finishSocketResponse unpauses it.
        // (test-http-chunk-extensions-limit block 2)
        parser.execute(chunk);
        validatePipelinedRemainder();
        return;
      }
      parser.execute(chunk);
      validatePipelinedRemainder();
    };
    socket.on("data", onHttpData);
    const onHttpError = () => {
      /* 'close' handles cleanup */
    };
    socket.on("error", onHttpError);
    const onHttpEnd = () => {
      // Upgraded connections are the app's lifecycle, not HTTP's: the
      // pipe (not this handler) decides when the socket ends.
      if (state.upgraded) return;
      // CONNECT tunnels have no response to drain and busy stays true
      // forever (no _finishSocketResponse ever runs), so a peer FIN must
      // still close the socket — otherwise it never closes and the loop
      // never drains (test-http-server-unconsume-consume's exit path).
      // Deferred past this emission: the app's own 'end' listeners were
      // attached after this handler, and the app may still write
      // farewell bytes in 'end' (test-http-connect-req-res echoes on
      // 'end'); ending synchronously here would drop them. The deferred
      // end is a no-op if the app already ended or destroyed the socket.
      // No unpause: tunnel bytes buffered in the paused parser belong to
      // the app, not to a next HTTP message.
      if (state.connect) {
        state.peerEnded = true;
        queueMicrotask(() => {
          if (!socket.destroyed) {
            try {
              socket.end();
            } catch {
              /* already ending */
            }
          }
        });
        return;
      }
      // Client half-closed. If a request is in flight, the response still
      // has to be written first — record the EOF and let
      // _finishSocketResponse close the socket afterwards. Only an idle
      // connection is closed immediately — and "idle" means no response
      // outstanding, not just "not busy": a FIN queued behind pipelined
      // requests arrives after the first response finishes (busy is
      // already false) but while later responses are still pending;
      // closing there drops them and hangs the client (test-http-server).
      // Unpausing first flushes any request still buffered in the parser
      // into the outstanding count, so it is drained rather than dropped.
      state.peerEnded = true;
      if (state.inFlight === 0) {
        state.parser.unpause();
        if (state.inFlight === 0 && !state.busy) socket.end();
      }
    };
    socket.on("end", onHttpEnd);
    // Stored by reference so CONNECT dispatch can detach the HTTP layer
    // (real Node hands the tunnel to the app with only the stream-
    // internal 'end' listener left) without touching app listeners.
    state.httpListeners = {
      close: onHttpClose,
      timeout: onHttpTimeout,
      data: onHttpData,
      error: onHttpError,
      end: onHttpEnd,
    };
    state.parser = parser;
  }

  /**
   * Build req/res for one parsed request and dispatch to 'request' handlers.
   * The request body streams into req via parser.onBody as bytes arrive.
   */
  _dispatchSocketRequest(socket, info, state) {
    // A previous response on this socket may still hold a pended
    // streaming frame (flushed at end() or on a microtask); flush it
    // now so pipelined responses can never overtake it.
    if (state.lastResponse) state.lastResponse._flushPendingFrame();
    // createServer({ IncomingMessage: Sub }) delivers Sub instances:
    // the subclass constructor receives exactly one argument, the socket
    // (probed on real Node v24.22.1). Default behavior is byte-identical
    // — no option means the plain IncomingMessage, as before.
    const ReqClass =
      typeof this._incomingMessageClass === "function"
        ? this._incomingMessageClass
        : IncomingMessage;
    const req = new ReqClass(socket);
    // createServer({ highWaterMark }) reaches every request's readable
    // state — including custom IncomingMessage subclasses, whose
    // constructors take exactly one argument (the socket) and so cannot
    // receive the option (probed real Node v24.22.1: a custom subclass
    // still reads the server value). Post-construction set is the only
    // uniform mechanism; the state field is read dynamically everywhere.
    if (req._readableState) {
      req._readableState.highWaterMark = this._highWaterMark;
    }
    req.method = info.method;
    req.url = info.url;
    req.httpVersionMajor = info.httpVersionMajor;
    req.httpVersionMinor = info.httpVersionMinor;
    req.httpVersion = info.httpVersion;
    const pairs = [];
    for (let i = 0; i < info.rawHeaders.length; i += 2) {
      pairs.push([info.rawHeaders[i], info.rawHeaders[i + 1]]);
    }
    IncomingMessage._applyRawHeaders(req, pairs);

    // CONNECT requests are not 'request' dispatches: Node emits 'connect'
    // with (req, socket, head) and hands the socket to the app as a tunnel
    // (test-http-server-unconsume-consume). With no 'connect' listener the
    // socket is destroyed and no 'request' fires (probed real Node
    // v24.22.1). No response is expected, so nothing is counted inFlight;
    // the timeout checker never fires on it (not receiving, never
    // idle-after-response), and a peer FIN ends it via the 'end' handler.
    if (req.method === "CONNECT") {
      state.connect = true;
      state.receiving = false;
      let head = Buffer.alloc(0);
      try {
        if (typeof state.parser.takeRemainder === "function") {
          head = state.parser.takeRemainder();
        }
      } catch {
        /* empty head */
      }
      // Detach the HTTP layer before handing the socket to the app:
      // real Node delivers a CONNECT tunnel with only the stream-
      // internal 'end' listener left (probed v24.22.1: close/data/
      // error/timeout all 0, end 1). Removed by stored reference so
      // app listeners (e.g. from 'connection') survive. Close
      // bookkeeping moves to the destroy hook (net.js invokes
      // socket._onHttpSocketClose in _destroy), so connection tracking
      // and parser release still run without an EventEmitter listener.
      // The HTTP 'end' handler goes too: a CONNECT tunnel's close on
      // peer FIN is the app's lifecycle now (test-http-connect echoes
      // and ends in its own 'end' handler), and the loop still drains
      // when the peer destroys (peer link null => transport inactive).
      const hl = state.httpListeners;
      if (hl) {
        socket.removeListener("close", hl.close);
        socket.removeListener("data", hl.data);
        socket.removeListener("error", hl.error);
        socket.removeListener("timeout", hl.timeout);
        socket.removeListener("end", hl.end);
        socket._onHttpSocketClose = hl.close;
      }
      if (this.listenerCount("connect") > 0) {
        this.emit("connect", req, socket, head);
      } else {
        socket.destroy();
      }
      return { req, res: null };
    }

    // Upgrade requests are not 'request' dispatches: Node emits 'upgrade'
    // and detaches the socket from HTTP timeout handling (requestTimeout
    // is disabled after upgrade — test-http-server-request-timeout-upgrade).
    // No response is expected, so nothing is counted inFlight.
    if (
      req.headers.upgrade !== undefined &&
      /upgrade/i.test(String(req.headers.connection || ""))
    ) {
      // shouldUpgradeCallback gate (probed real Node v24.22.1): false
      // routes to normal 'request' dispatch below, even with an 'upgrade'
      // listener; true with no 'upgrade' listener destroys the socket;
      // a throw propagates (parser.execute rethrows non-HPE errors) to
      // uncaughtException. With no callback, no 'upgrade' listener also
      // falls back to 'request' dispatch (probed: 200 OK) — only a
      // callback-true verdict destroys an unhandled upgrade.
      let shouldUpgrade = true;
      if (this._shouldUpgradeCallback) {
        try {
          shouldUpgrade = this._shouldUpgradeCallback(req);
        } catch (err) {
          // A throw must surface as uncaughtException (real Node), not
          // as a round-trip failure: on the virtual path the throw
          // travels back through the client's write call stack, whose
          // try/catch would swallow it into a silent hang (the raw path
          // has no such catch, which is why test-http-upgrade-server2
          // already surfaces). Scheduling past the write stack makes it
          // uncaught on both paths; the socket is destroyed so a
          // surviving process doesn't stall on the dead request.
          queueMicrotask(() => {
            throw err;
          });
          socket.destroy();
          return { req, res: null };
        }
      }
      if (
        shouldUpgrade &&
        (this._shouldUpgradeCallback || this.listenerCount("upgrade") > 0)
      ) {
        if (this.listenerCount("upgrade") === 0) {
          socket.destroy();
          return { req, res: null };
        }
        state.upgraded = true;
        state.receiving = false;
        let head = Buffer.alloc(0);
        try {
          if (typeof state.parser.takeRemainder === "function") {
            head = state.parser.takeRemainder();
          }
        } catch {
          /* empty head */
        }
        // Detach the HTTP layer before handing the socket to the app,
        // mirroring the CONNECT branch: real Node delivers an upgraded
        // server socket with only the stream-internal 'end' listener
        // left (probed v24.22.1: close/data/error/timeout all 0, end 1)
        // and socket.parser null. Removed by stored reference so app
        // listeners (e.g. from 'connection') survive. Close bookkeeping
        // moves to the destroy hook, so connection tracking and parser
        // release still run without an EventEmitter listener. The
        // parser facade is nulled here (not at close): the app observes
        // socket.parser === null at 'upgrade' time, and the stashed
        // close handler's free() block is a no-op facade anyway.
        const hl = state.httpListeners;
        if (hl) {
          socket.removeListener("close", hl.close);
          socket.removeListener("data", hl.data);
          socket.removeListener("error", hl.error);
          socket.removeListener("timeout", hl.timeout);
          socket.removeListener("end", hl.end);
          socket._onHttpSocketClose = hl.close;
        }
        socket.parser = null;
        this.emit("upgrade", req, socket, head);
        return { req, res: null };
      }
      // Fall through to normal 'request' dispatch below (callback false,
      // or no callback and no 'upgrade' listener).
    }

    const res = new ServerResponse(req, { highWaterMark: this._highWaterMark });
    // Pipelined response (test-http-outgoing-drain-writable-length):
    // while a previous response on this socket is still unfinished,
    // real Node delivers the new response with a null socket — its
    // writes buffer (outputData) instead of streaming, write() returns
    // false past the highWaterMark, and 'drain' fires when the flush
    // drains. The previous response is state.lastResponse until its
    // finish clears the stash; a synchronously finished previous
    // response (finished=true, finish event still queued) is NOT
    // deferred, so finish-event FIFO keeps byte order for the common
    // synchronous-handler pipeline.
    const prevUnfinished = state.lastResponse && !state.lastResponse.finished;
    if (prevUnfinished) {
      res.socket = null;
      res.connection = null;
    }
    // Socket-driven response highWaterMark
    // (test-http-response-drain-cork): real Node gives the response
    // the socket's live mark at dispatch, so a 'connection' listener
    // that mutates socket._writableState.highWaterMark is honored and
    // corked writes report backpressure against it. The server option
    // already reaches the socket via listen(), so the default and
    // option cases are unchanged — this only picks up later mutations.
    const sockHwm = socket?.writableHighWaterMark;
    if (typeof sockHwm === "number" && res._writableState) {
      res._writableState.highWaterMark = sockHwm;
    }
    state.lastResponse = res;
    const reqNo = ++state.reqCount;
    // Node syncs res.shouldKeepAlive from the request's keep-alive status;
    // _storeHeader uses it to decide on `Connection: close`.
    res.shouldKeepAlive = info.shouldKeepAlive;
    // _storeHeader also needs the server's keep-alive framing inputs
    // (Node reads them at header time): the keepAliveTimeout for the
    // Keep-Alive value, and the max-requests budget for the close-on-
    // limit response. Fallbacks in _storeHeader cover responses not
    // built by this dispatch path (unlimited budget, 5000 ms default).
    res._serverKeepAliveTimeout = this.keepAliveTimeout;
    res._serverMaxRequestsPerSocket = this.maxRequestsPerSocket;
    res._serverReqNo = reqNo;
    res[kUniqueHeaders] = this._serverUniqueHeaders;
    // HTTP/1.0 keep-alive framing: Node uses chunked encoding for 1.0
    // responses when the request advertised `TE: chunked`.
    res._reqHadTE = /chunked/i.test(
      String(req.headers?.te || req.headers?.TE || ""),
    );

    res.on("finish", () => {
      this._finishSocketResponse(socket, info, state, req, res, reqNo);
    });
    // Counted before dispatch: a handler that finishes synchronously
    // (or a pipelined request dispatched while an earlier response is
    // still in flight) must still be outstanding when the earlier
    // response finishes, or a half-closed socket is destroyed under it.
    state.inFlight++;

    // Dispatch synchronously, like Node's parserOnIncoming: the handler
    // must attach its req listeners before the parser feeds the body and
    // before a peer FIN queued behind this chunk is processed. Deferring
    // to a microtask loses both races — body EOF fires before the handler
    // attaches, and the socket's EOF handling (nextTick-ordered) runs
    // before the microtask, closing the socket under the pending response.
    // (test-http-chunk-extensions-limit)
    try {
      this.emit("request", req, res);
    } catch (err) {
      this.emit("clientError", err, socket);
      socket.destroy(err);
    }
    if (!info.hasBody) req._finishBody();
    return { req, res };
  }

  /**
   * Serialize a finished ServerResponse onto the socket as real HTTP/1.1
   * bytes, then either resume parsing (keep-alive) or close the connection.
   */
  _finishSocketResponse(socket, info, state, req, res, reqNo) {
    // Idempotence: the finish listener calls this once, and
    // ServerResponse._destroy may emit 'finish' manually for the
    // end-then-destroy case — never deliver twice.
    if (res._finishDelivered) return;
    res._finishDelivered = true;
    // Streaming case: headers + body were already flushed via write().
    // Just terminate the chunked stream (if used) and handle keep-alive.
    if (res._headerFlushed) {
      if (
        !socket.destroyed &&
        res._chunkedStreaming &&
        !res._chunkTerminatorSent
      ) {
        try {
          const term = Buffer.from(res._chunkTerminator(), "latin1");
          const pending = res._pendingFrame;
          res._pendingFrame = null;
          if (pending) {
            res._framedPending = Math.max(
              0,
              (res._framedPending || 0) - pending.length,
            );
          }
          res._maybeEmitStreamDrain?.();
          socket.write(pending ? Buffer.concat([pending, term]) : term);
          res._chunkTerminatorSent = true;
        } catch {
          /* ignore */
        }
      }
    } else if (!socket.destroyed) {
      const head = res._header || "HTTP/1.1 200 OK\r\n\r\n";
      const body = res._getBody();
      const noBodyStatus = res._hasBody === false;
      const sendBody =
        body.length > 0 && req.method !== "HEAD" && !noBodyStatus;
      let headOut = head;
      // hasHeader() only sees kOutHeaders (the setHeader API);
      // writeHead(obj) headers live in _renderedHeaders, so
      // Content-Length must be checked in both stores — with only
      // hasHeader(), a writeHead content-length was invisible here and
      // the response was framed chunked ON TOP of the rendered
      // Content-Length header (test-http-get-pipeline-problem).
      const rendered = res._renderedHeaders || {};
      const hasCL =
        res.hasHeader("content-length") ||
        rendered["content-length"] !== undefined;
      const hasTE = res.hasHeader("transfer-encoding");
      const isHttp10 = res._reqHttpVersion === "1.0";
      // Node frames with Content-Length only when the header block was
      // rendered implicitly by end() itself, so the length is known before
      // anything is committed. An explicit writeHead() commits the headers
      // first; the body that follows is chunked instead.
      // (test-http-chunk-extensions-limit block 3)
      const implicitHeader = res._headersImplicit === true;
      if (!hasCL && !hasTE && !noBodyStatus && !isHttp10 && implicitHeader) {
        // Frame the body like Node does when its length is known at end():
        // HEAD responses carry the length but no bytes.
        // (Not for HTTP/1.0: Node closes instead of auto-framing.)
        headOut = head.replace(
          /\r\n$/,
          `Content-Length: ${body.length}\r\n\r\n`,
        );
      }
      // TE can come from setHeader (kOutHeaders) or writeHead(obj)
      // (_renderedHeaders). For HTTP/1.0 with a `TE: chunked` request, Node
      // uses chunked encoding even though the app didn't set the header.
      let te = hasTE
        ? String(res.getHeader("transfer-encoding"))
        : rendered["transfer-encoding"] || "";
      if (
        !te &&
        !hasCL &&
        !noBodyStatus &&
        !isHttp10 &&
        !implicitHeader &&
        req.method !== "HEAD"
      ) {
        // Explicit writeHead() committed the headers with no length
        // framing: the buffered body is sent chunked, like Node.
        te = "chunked";
        headOut = headOut.replace(
          /\r\n$/,
          "Transfer-Encoding: chunked\r\n\r\n",
        );
        rendered["transfer-encoding"] = "chunked";
      }
      if (!te && !hasCL && isHttp10 && res._reqHadTE && !noBodyStatus) {
        te = "chunked";
        headOut = headOut.replace(
          /\r\n$/,
          "Transfer-Encoding: chunked\r\n\r\n",
        );
        rendered["transfer-encoding"] = "chunked";
      }
      if (/chunked/i.test(te)) {
        // Coalesce headers + body + terminator into one write like Node
        // (test counts data events per response, not per write). Two
        // separate writes split the response into two 'data' events,
        // which breaks clients that increment a counter per event
        // (e.g. test-http-1.0-keep-alive).
        // The body is a Buffer of raw bytes: it must reach the wire
        // byte-exact. Interpolating body.toString() (UTF-8) inflates
        // or replaces non-ASCII bytes while the chunk-size line still
        // declares the original byte count, desynchronizing the
        // client's parser ("expected CRLF after chunk data" on any
        // binary body — test-http-get-pipeline-problem). Build the
        // coalesced write as Buffers instead.
        let out;
        if (sendBody) {
          out = Buffer.concat([
            Buffer.from(headOut, "latin1"),
            Buffer.from(`${body.length.toString(16)}\r\n`, "latin1"),
            body,
            Buffer.from("\r\n" + res._chunkTerminator(), "latin1"),
          ]);
        } else if (!noBodyStatus) {
          // Send terminator only if a body is allowed. 204/304 (and 1xx)
          // MUST NOT have a body, so no chunked terminator (RFC 2616 10.2.5).
          out = headOut + res._chunkTerminator();
        } else {
          // For noBodyStatus (204/304/1xx), send nothing more; headers already written.
          out = headOut;
        }
        socket.write(out);
      } else if (sendBody) {
        // Coalesce headers + body into one write (Node behavior; the test
        // counts 'data' events per response, not per write). Buffer
        // concat, not string concat — the body is raw bytes (see above).
        socket.write(Buffer.concat([Buffer.from(headOut, "latin1"), body]));
      } else {
        socket.write(headOut);
      }
    }
    const maxOk =
      this.maxRequestsPerSocket === 0 || reqNo < this.maxRequestsPerSocket;
    // HTTP/1.0 keep-alive requires explicit length framing (Content-Length
    // or chunked Transfer-Encoding); otherwise Node closes the connection
    // to delimit the response, even if keep-alive was negotiated.
    // Note: hasHeader() only sees kOutHeaders (setHeader API); writeHead(obj)
    // headers live in _renderedHeaders, so check both.
    const rendered = res._renderedHeaders || {};
    const hasLen =
      res.hasHeader("content-length") ||
      rendered["content-length"] !== undefined ||
      res.hasHeader("transfer-encoding") ||
      rendered["transfer-encoding"] !== undefined ||
      res._chunkedStreaming === true;
    let framingOk = true;
    if (res._reqHttpVersion === "1.0") {
      framingOk = hasLen;
    }
    // 204/304/1xx responses MUST NOT have a body (RFC 2616 10.2.5). If the
    // app explicitly sets Transfer-Encoding (e.g. chunked) on such a
    // response, Node closes the connection rather than keeping it alive —
    // the framing is a protocol error and can't delimit a body that must
    // not exist. (test-http-chunked-304 expects Connection: close.)
    const noBodyWithTE =
      res._hasBody === false &&
      (res.hasHeader("transfer-encoding") ||
        (res._renderedHeaders || {})["transfer-encoding"] !== undefined);
    const keepAlive =
      info.shouldKeepAlive &&
      maxOk &&
      !socket.destroyed &&
      framingOk &&
      !noBodyWithTE &&
      !state.peerEnded;
    // Half-closed drain: the peer sent FIN, so no NEW request can arrive,
    // but responses for already-dispatched pipelined requests must still
    // go out before the socket closes. Destroying on the first finished
    // response drops them: the client never sees responses 2..N, its
    // 'close' never fires, and the test hangs (test-http-server).
    // Drain exactly like keep-alive while responses remain — the last
    // one takes the close path below. Narrowly scoped: only when the
    // response would otherwise have kept the connection alive.
    state.inFlight = Math.max(0, state.inFlight - 1);
    const drainPeerEnded =
      state.peerEnded &&
      state.inFlight > 0 &&
      info.shouldKeepAlive &&
      maxOk &&
      !socket.destroyed &&
      framingOk &&
      !noBodyWithTE;
    if (keepAlive || drainPeerEnded) {
      state.busy = false;
      state.awaitingBody = false;
      // The socket is idle from here: the keep-alive clock runs from this
      // moment (fresh connections that never served a request are exempt —
      // probed real Node leaves them alone).
      state.idleSince = Date.now();
      // Preserve the socket for keep-alive reuse: flag the response so the
      // stream autoDestroy in ServerResponse._destroy doesn't kill it. The
      // socket stays open for the next pipelined request (server side) and
      // the client's agent free pool (client side).
      res._keepAliveSocket = true;
      // Resume the parser (it may hold a fully-buffered pipelined request),
      // then feed bytes that arrived while the response was in flight.
      const parser = state.parser;
      parser.unpause();
      while (state.pending.length > 0 && !state.busy) {
        parser.execute(state.pending.shift());
      }
      // Closing server (test-http-outgoing-drain-writable-length): a
      // connection that was busy at close() time completes its response
      // and is then destroyed, so the client sees close and the loop
      // drains — instead of being preserved for keep-alive reuse
      // forever. Only when NOTHING further is outstanding: inFlight
      // zero (after this finish's decrement), no pending pipelined
      // bytes, and no further dispatch started (busy). Destroying at
      // the first finish after close() drops still-outstanding
      // pipelined responses (test-http-server: close() runs at req3
      // dispatch while res1/res2/res3 timers are still pending — an
      // early destroy loses /quit). A newly dispatched response owns
      // its own finish, which takes this same path. Never on the
      // half-closed drain path (drainPeerEnded): remaining in-flight
      // responses must still go out before any close.
      if (
        keepAlive &&
        !drainPeerEnded &&
        state.serverClosing &&
        !state.busy &&
        state.inFlight === 0 &&
        state.pending.length === 0
      ) {
        try {
          socket.destroy();
        } catch {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      // Not keep-alive: destroy (not just end) so both sides release their
      // loop timers and the process can exit. (end() alone leaves the
      // virtual socket half-open.)
      try {
        socket.destroy();
      } catch {
        try {
          socket.end();
        } catch {
          /* ignore */
        }
      }
    }
    // Release the dispatch stash: state.lastResponse pins res -> req
    // (res.req), and the client-side socket still links to this socket
    // via _peer after a graceful FIN — without this release a finished
    // request stays reachable forever and GC-gated tests hang
    // (test-http-server-keepalive-req-gc). Only clear when this
    // response is still the stashed one: a pipelined next request may
    // already have replaced it, and its pending frame must survive.
    if (state.lastResponse === res) state.lastResponse = null;
  }

  setTimeout(msecs, callback) {
    this.timeout = msecs || 0;
    if (callback) this.on("timeout", callback);
    return this;
  }

  ref() {
    this._unrefed = false;
    if (this._netServer) this._netServer.ref();
    return this;
  }
  unref() {
    // Real Node's http.Server IS a net.Server: unref() releases the
    // listening handle's loop keeper. The net server is recreated on
    // every listen(), so the flag is sticky (re-applied in listen()).
    this._unrefed = true;
    if (this._netServer) this._netServer.unref();
    return this;
  }

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
          reject(makeError("ERR_HTTP_REQUEST_TIMEOUT", "Request timeout"));
        }, this.timeout);
        timeoutId.unref?.();
      }
      res.once("finish", () => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      queueMicrotask(() => {
        try {
          this.emit("request", req, res);
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
  // Classic-constructor call pattern: a subclass that does
  // `http.Server.call(this, listener)` (test-http-upgrade-server's
  // testServer shape) must initialize `this` in place. A class
  // constructor cannot be .call()ed, and Reflect.construct would return
  // a NEW object that .call() discards, leaving `this` uninitialized
  // (the upgrade-server crash: this._connections undefined at
  // _onSocketConnection). So construct a throwaway instance and
  // transplant its own properties (string + symbol keys, descriptors
  // intact — EventEmitter state is plain own properties) onto `this`.
  // `this` keeps its own prototype chain, so instanceof checks still
  // work. (Node returns undefined here; returning `this` is harmless
  // and more useful, and no official test distinguishes.)
  if (new.target === undefined && this instanceof Server) {
    const inst = Reflect.construct(ServerBase, args, Server);
    for (const key of [
      ...Object.getOwnPropertyNames(inst),
      ...Object.getOwnPropertySymbols(inst),
    ]) {
      Object.defineProperty(
        this,
        key,
        Object.getOwnPropertyDescriptor(inst, key),
      );
    }
    return this;
  }
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
  server.emit("connection", socket);
}

// ---------------------------------------------------------------------------
// 12. Agent — connection-pool metadata only; the browser owns real sockets.
// ---------------------------------------------------------------------------
/**
 * Parse the `timeout=N` (seconds) hint from a response's `Keep-Alive`
 * header value (headers object with lowercase keys, as built by
 * IncomingMessage._applyRawHeaders). Returns null when absent or
 * unparsable. A value like `timeout=5, max=100` yields 5.
 */
function parseKeepAliveTimeoutHint(headers) {
  const value = headers?.["keep-alive"];
  if (typeof value !== "string") return null;
  const m = /timeout\s*=\s*(\d+)/i.exec(value);
  return m ? Number(m[1]) : null;
}

class AgentBase extends EventEmitter {
  constructor(options) {
    super();
    const opts = { __proto__: null, ...(options || {}) };
    this.options = opts;

    this.defaultPort = opts.defaultPort || 80;
    this.protocol = opts.protocol || "http:";
    this.keepAliveMsecs = opts.keepAliveMsecs || 1000;
    this.keepAlive = opts.keepAlive || false;
    // Server keep-alive timeout hint buffer (Node v22.20+/v24.7+):
    // milliseconds subtracted from the server's `Keep-Alive: timeout`
    // hint when deciding whether a pooled socket is already expired.
    // Default 1000; only a finite number >= 0 is accepted — anything
    // else (negative, Infinity, NaN, non-number) falls back to 1000
    // (probed against real Node: -100/Infinity/NaN/"500"/null/true
    // all yield 1000, while 0, -0 and 500.5 pass through).
    const buf = opts.agentKeepAliveTimeoutBuffer;
    this.agentKeepAliveTimeoutBuffer =
      typeof buf === "number" && Number.isFinite(buf) && buf >= 0 ? buf : 1000;
    this.maxSockets = opts.maxSockets || AgentBase.defaultMaxSockets;
    this.maxFreeSockets = opts.maxFreeSockets || 256;
    this.scheduling = opts.scheduling || "lifo";
    if (this.scheduling !== "fifo" && this.scheduling !== "lifo") {
      throw ERR_INVALID_ARG_VALUE(
        "scheduling",
        this.scheduling,
        "must be one of: 'fifo', 'lifo'.",
      );
    }
    this.maxTotalSockets = opts.maxTotalSockets;
    if (this.maxTotalSockets !== undefined) {
      if (
        typeof this.maxTotalSockets !== "number" ||
        this.maxTotalSockets < 1
      ) {
        throw ERR_OUT_OF_RANGE("maxTotalSockets", ">= 1", this.maxTotalSockets);
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
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, socket));
    }
    return socket;
  }

  createSocket(req, options, callback) {
    const name = this.getName(options);
    // For the virtual-server path, create a real virtual socket via net.js.
    // The port comes from the request options, falling back to the request's
    // own host/port (for manual addRequest(req, {}) calls).
    const port =
      options.port || req.port || req._port || this.defaultPort || 80;
    const host = options.host || options.hostname || req.host || "localhost";
    let socket;
    try {
      // Real Node passes the agent's noDelay (default true) into the
      // connect options; a request-level noDelay is ignored (probed
      // v24.22.1: http.request({ noDelay: false }) still connects with
      // noDelay true, while new Agent({ noDelay: false }) connects
      // with false). The agent consumes the option internally — Agent
      // exposes no noDelay property on real Node.
      socket = netConnect({
        port,
        host,
        noDelay: this.options.noDelay ?? true,
      });
    } catch (err) {
      if (typeof callback === "function") {
        queueMicrotask(() => callback(err));
      }
      return null;
    }
    // Disable autoDestroy: the agent manages the socket lifecycle explicitly.
    // Otherwise the socket destroys itself when the writable side finishes,
    // breaking keep-alive reuse.
    socket.autoDestroy = false;
    (this.sockets[name] ??= []).push(socket);
    this.totalSocketCount++;
    // Track the agent name on the socket for removal on destroy.
    socket._agentName = name;
    socket._agent = this;
    if (typeof callback === "function") {
      // netConnect emits 'connect' asynchronously; invoke callback then.
      const onError = (err) => callback(err);
      socket.once("connect", () => {
        // Connection succeeded: remove the error listener so later
        // errors on the (possibly pooled) socket don't hit this stale
        // callback.
        socket.removeListener("error", onError);
        // The socket connected before it could be assigned to the
        // request, so the request's 'socket' event necessarily comes
        // after 'connect'. Remember that: _performVirtualRequest
        // replays 'connect' after emitting 'socket', restoring the
        // observable Node order (assignment first, then connect) for
        // listeners attached in a 'socket' handler
        // (test-http-keep-alive-close-on-header counts connects).
        socket._connectedBeforeAssign = true;
        callback(null, socket);
      });
      socket.once("error", onError);
    }
    return socket;
  }

  getName(options = {}) {
    const host = options.host || options.hostname || "localhost";
    // Node does NOT default the port in getName() — empty string if unspecified.
    // (test-http-agent-getname expects 'localhost::' not 'localhost:80:')
    const port = options.port ?? "";
    let name = `${host}:${port}:${options.localAddress || ""}`;
    // Unix socket path and IP family are appended (Node behavior).
    if (options.socketPath) name += `:${options.socketPath}`;
    else if (options.family === 4 || options.family === 6)
      name += `:${options.family}`;
    return name;
  }

  addRequest(req, options) {
    // For manual addRequest(req, {}) calls, derive host/port from the request
    // itself so the freeSockets name matches getName(req).
    const effectiveOptions =
      options && (options.host || options.hostname || options.port)
        ? options
        : {
            ...options,
            host: req.host || req.hostname,
            port: req.port || req._port,
          };
    const name = this.getName(effectiveOptions);
    // 1. Try to reuse a free (keep-alive) socket.
    const free = this.freeSockets[name];
    if (free && free.length > 0) {
      const socket = this.scheduling === "fifo" ? free.shift() : free.pop();
      if (free.length === 0) delete this.freeSockets[name];
      // Validate the socket before reuse: a manually-stuffed or stale socket
      // may have no _handle (never connected) or be destroyed. Node checks
      // _handle before calling asyncReset(); we skip unusable sockets.
      if (!socket._handle || socket.destroyed) {
        try {
          socket.destroy();
        } catch {
          /* best effort */
        }
        // Fall through to create a new socket.
      } else {
        (this.sockets[name] ??= []).push(socket);
        req.reusedSocket = true;
        this.reuseSocket(socket, req);
        return;
      }
    }
    // 2. Create a new socket if under the per-origin and total limits.
    const active = this.sockets[name] || [];
    if (
      active.length < this.maxSockets &&
      this.totalSocketCount < this.maxTotalSockets
    ) {
      req.reusedSocket = false;
      this.createSocket(req, options, (err, socket) => {
        if (err) {
          // Socket creation failed: remove from tracking, error the request.
          this.removeSocket(socket, name);
          // A request that already obtained a real socket elsewhere (e.g.
          // a second agent was asked via a manual addRequest, as in
          // test-http-agent-uninitialized) must not be failed by this
          // redundant creation attempt erroring afterwards.
          if (req.socket && !(req.socket instanceof FakeSocket)) return;
          if (typeof req.onSocketError === "function") {
            req.onSocketError(err);
          } else {
            req.emit("error", err);
          }
          return;
        }
        if (
          req.socket &&
          !(req.socket instanceof FakeSocket) &&
          req.socket !== socket
        ) {
          // Redundant socket: the request was already assigned one via
          // another path. Drop this one instead of leaking an untracked
          // open connection.
          this.removeSocket(socket, socket._agentName || name);
          try {
            socket.destroy();
          } catch {
            /* best effort */
          }
          return;
        }
        req.onSocket(socket);
      });
      return;
    }
    // 3. At maxSockets: queue the request until a socket frees up.
    (this.requests[name] ??= []).push(req);
    req._agentQueueName = name;
  }

  removeSocket(socket, nameOrOptions) {
    const name =
      typeof nameOrOptions === "string"
        ? nameOrOptions
        : this.getName(nameOrOptions || {});
    const active = this.sockets[name];
    if (active) {
      const idx = active.indexOf(socket);
      if (idx !== -1) {
        active.splice(idx, 1);
        this.totalSocketCount--;
        if (active.length === 0) delete this.sockets[name];
      }
    }
    const free = this.freeSockets[name];
    if (free) {
      const idx = free.indexOf(socket);
      if (idx !== -1) {
        free.splice(idx, 1);
        if (free.length === 0) delete this.freeSockets[name];
      }
    }
  }

  /**
   * Return a socket to the free pool after a response completes, and process
   * any queued requests waiting for a socket to this origin.
   */
  releaseSocket(socket, name) {
    // Remove from active.
    const active = this.sockets[name];
    if (active) {
      const idx = active.indexOf(socket);
      if (idx !== -1) {
        active.splice(idx, 1);
        if (active.length === 0) delete this.sockets[name];
      }
    }
    if (this.keepAlive && !socket.destroyed) {
      // Apply the agent's idle timeout to the socket first; the
      // keepSocketAlive() hook below may override it via
      // socket.setTimeout() (test-http-agent-timeout block 4: a custom
      // agent's 60ms must win over the agent option's 50ms).
      const idleTimeout = Number(this.options.timeout) || 0;
      if (idleTimeout > 0 && typeof socket.setTimeout === "function") {
        socket.setTimeout(idleTimeout);
      }
      if (!this.keepSocketAlive(socket)) {
        // The hook vetoed pooling: close the socket instead.
        socket.destroy();
        this.totalSocketCount--;
        this._processQueue(name);
        return;
      }
      // Keep-alive: park in the free pool (bounded by maxFreeSockets).
      let free = this.freeSockets[name];
      if (!free) {
        free = [];
        this.freeSockets[name] = free;
      }
      if (free.length < this.maxFreeSockets) {
        free.push(socket);
        // Mark as idle: the request's socket error handler will skip
        // errors on free-pool sockets (agent handles them below).
        socket._inFreePool = true;
        // Agent owns error handling for idle sockets: remove from pool
        // and destroy, don't propagate to any (completed) request.
        const onIdleError = () => {
          socket._inFreePool = false;
          if (socket._pooledTimeoutHandler) {
            socket.removeListener("timeout", socket._pooledTimeoutHandler);
            socket._pooledTimeoutHandler = null;
          }
          const wasPooled = (this.freeSockets[name] || []).includes(socket);
          this.removeSocket(socket, name);
          try {
            socket.destroy();
          } catch {
            /* best effort */
          }
          if (wasPooled) this.totalSocketCount--;
        };
        socket.once("error", onIdleError);
        // Store for cleanup on reuse (avoid listener leak).
        socket._idleErrorHandler = onIdleError;
        // Idle reaping (Node): a pooled socket that reaches the timeout
        // set above emits 'timeout' (the socket's own timer); the agent
        // then removes and destroys it, so timed-out sockets are never
        // reused and a process on the default keep-alive globalAgent
        // (timeout 5000) can exit. (test-http-agent-timeout block 2,
        // test-http-agent-uninitialized)
        const onPooledTimeout = () => {
          socket._pooledTimeoutHandler = null;
          if (!socket._inFreePool) return;
          socket._inFreePool = false;
          const wasPooled = (this.freeSockets[name] || []).includes(socket);
          this.removeSocket(socket, name);
          try {
            socket.destroy();
          } catch {
            /* best effort */
          }
          if (wasPooled) this.totalSocketCount--;
        };
        socket.once("timeout", onPooledTimeout);
        socket._pooledTimeoutHandler = onPooledTimeout;
        socket.emit("free");
      } else {
        socket.destroy();
        this.totalSocketCount--;
      }
    } else {
      socket.destroy();
      this.totalSocketCount--;
    }
    // Wake a queued request, if any.
    this._processQueue(name);
  }

  _processQueue(name) {
    const queue = this.requests[name];
    if (!queue || queue.length === 0) return;
    // A socket just freed up (or was destroyed); try the next queued request.
    // Skip aborted requests (they stay in the queue until processed).
    let req;
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (candidate._aborted || candidate.aborted) {
        // Aborted while queued: drop it, don't assign a socket.
        continue;
      }
      req = candidate;
      break;
    }
    if (queue.length === 0) delete this.requests[name];
    if (!req) return;
    delete req._agentQueueName;
    // Re-run addRequest: it will find the free socket or create a new one.
    this.addRequest(req, req._agentOptions || {});
  }

  keepSocketAlive(socket) {
    // Server keep-alive timeout hint (Node): when the last response
    // carried `Keep-Alive: timeout=N`, the socket is already expired
    // if N seconds minus this agent's buffer leaves nothing — veto
    // pooling and let releaseSocket destroy it instead
    // (test-http-client-keep-alive-hint: timeout=1 with the default
    // 1000ms buffer closes at once, well before the test's 3s guard).
    // A hint with time remaining is pooled normally; real Node
    // enforces nothing further (no timer, no reuse-time check —
    // probed: a timeout=3/buffer=1500 socket stays pooled past
    // 1500ms and is reused after 2000ms).
    const hint = socket._serverKeepAliveTimeout;
    if (
      typeof hint === "number" &&
      hint * 1000 <= this.agentKeepAliveTimeoutBuffer
    ) {
      return false;
    }
    return true;
  }

  reuseSocket(socket, req) {
    // A reused socket connected for an earlier request; never replay
    // that 'connect' for the new request.
    socket._connectedBeforeAssign = false;
    // Drop the previous response's keep-alive hint: the next release
    // re-stashes from its own response (or null when it has none), so
    // a stale hint can never veto an unrelated response's pooling.
    socket._serverKeepAliveTimeout = null;
    socket._agentReused = true;
    // The socket is checked out of the free pool for a new request; clear the
    // released flag so _releaseAgentSocket can park it again on completion.
    socket._releasedToAgent = false;
    // Clear the idle flag: the new request's error handler should now fire.
    socket._inFreePool = false;
    // Cancel the pooled-timeout handling armed when the socket was
    // parked: the request's own timeout semantics take over from here.
    if (socket._pooledTimeoutHandler) {
      socket.removeListener("timeout", socket._pooledTimeoutHandler);
      socket._pooledTimeoutHandler = null;
    }
    if (typeof socket.setTimeout === "function") {
      socket.setTimeout(0);
    }
    // Remove the idle error handler (was once(), but may not have fired).
    if (socket._idleErrorHandler) {
      socket.removeListener("error", socket._idleErrorHandler);
      socket._idleErrorHandler = null;
    }
    req.onSocket(socket);
  }

  destroy() {
    // Node: destroy any sockets currently in use by the agent, both
    // active and idle (free pool). Merely dropping the bookkeeping
    // leaves the sockets' loop keepers alive and the process never exits.
    for (const name of Object.keys(this.sockets)) {
      for (const socket of this.sockets[name] || []) {
        try {
          socket.destroy();
        } catch {
          /* best effort */
        }
      }
    }
    for (const name of Object.keys(this.freeSockets)) {
      for (const socket of this.freeSockets[name] || []) {
        try {
          socket.destroy();
        } catch {
          /* best effort */
        }
      }
    }
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
export const globalAgent = new Agent({
  keepAlive: true,
  scheduling: "lifo",
  timeout: 5000,
});

// ---------------------------------------------------------------------------
// 13. request / get.
// ---------------------------------------------------------------------------
export function request(urlOrOptions, optionsOrCallback, callback) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions,
    optionsOrCallback,
    callback,
  );
  const req = new ClientRequest(options, undefined, cb);
  return req;
}

export function get(urlOrOptions, optionsOrCallback, callback) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions,
    optionsOrCallback,
    callback,
  );
  const req = new ClientRequest(
    { __proto__: null, ...options, method: "GET" },
    undefined,
    cb,
  );
  req.end();
  return req;
}

/**
 * Internal: build a client request with an explicit default protocol/agent.
 * Used by the https module (avoids an import cycle: https -> http only).
 */
function _createClientRequest(
  urlOrOptions,
  optionsOrCallback,
  callback,
  defaultProtocol,
  defaultAgent,
) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions,
    optionsOrCallback,
    callback,
  );
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
async function handleRequest(
  port,
  urlOrMethod,
  methodOrUrl,
  bodyOrHeaders,
  headersOrBody,
) {
  let url = urlOrMethod;
  let method = methodOrUrl;
  let body = bodyOrHeaders;
  let headers = headersOrBody;
  if (
    typeof urlOrMethod === "string" &&
    /^[A-Z]+$/.test(urlOrMethod) &&
    typeof methodOrUrl === "string" &&
    methodOrUrl.startsWith("/")
  ) {
    // Legacy order: (port, method, url, headers, body).
    method = urlOrMethod;
    url = methodOrUrl;
    headers = bodyOrHeaders;
    body = headersOrBody;
  }

  const _reg = _httpShared().registry;
  let server = _reg.get(port);
  if (!server && _reg.size > 0) {
    server = _reg.values().next().value;
  }
  if (!server) {
    throw makeError(
      "ERR_NO_SERVER",
      `No active HTTP server found for port ${port}`,
    );
  }

  // Node lowercases incoming header names; Express relies on that.
  // (fromRequest also lowercases, but the bridge needs lowercase keys for
  // the content-type/content-length checks below.)
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) {
    h[k.toLowerCase()] = v;
  }

  // Plain object body -> JSON; empty object -> no body.
  // A non-object-mode Readable can only push string/Buffer/Uint8Array,
  // so a stray {} must never reach the stream (it caused a "chunk" TypeError).
  let payload = body;
  if (
    payload != null &&
    typeof payload === "object" &&
    !ArrayBuffer.isView(payload) &&
    !(payload instanceof ArrayBuffer)
  ) {
    if (Object.keys(payload).length > 0) {
      payload = JSON.stringify(payload);
      h["content-type"] ??= "application/json";
    } else {
      payload = null;
    }
  }
  if (payload instanceof ArrayBuffer) payload = new Uint8Array(payload);

  // Mimic a real HTTP client: set content-length if the caller didn't.
  // body-parser (express.json()) skips parsing when content-length is
  // absent, so requests via __serverRequest__ would see req.body undefined.
  if (payload != null && h["content-length"] === undefined) {
    h["content-length"] = String(Buffer.byteLength(payload));
  }

  // Phase 2: emulated inbound requests go over a real virtual socket, so
  // the handler observes genuine HTTP bytes (and req.socket is real).
  // Servers that never listened have no socket endpoint: keep the direct
  // call for those.
  if (server._netServer && server._port != null) {
    const res = await _socketHttpRoundTrip(server._port, {
      method,
      path: url,
      headers: h,
      body: payload,
    });
    const headers = {};
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      const key = res.rawHeaders[i].toLowerCase();
      const value = res.rawHeaders[i + 1];
      headers[key] =
        headers[key] === undefined ? value : `${headers[key]}, ${value}`;
    }
    return {
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      headers,
      body: res.body,
    };
  }

  return server.handleRequest(method, url, h, payload);
}

if (RT) {
  RT.__httpServerRunTime = {
    handleRequest,
    waitForAllServers: _waitForAllServers,
    closeServer,
  };
}

// ---------------------------------------------------------------------------
// 15. Undici WebSocket globals (node:http re-exports them; in the browser the
//     globals are native).
// ---------------------------------------------------------------------------
export const WebSocket = _NativeWebSocket;
export const CloseEvent =
  typeof globalThis.CloseEvent === "function"
    ? globalThis.CloseEvent
    : undefined;
export const MessageEvent =
  typeof globalThis.MessageEvent === "function"
    ? globalThis.MessageEvent
    : undefined;

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
