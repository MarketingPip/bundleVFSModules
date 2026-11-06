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
  hasPipeServer as netHasPipeServer,
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

// ponytail: process-wide --insecure-http-parser default, read lazily at
// server/client construction (not module scope: the flag lives on the
// host process, and the sandbox's cloaked process only exists after this
// module loads). Real Node (probed v24.22.1): the flag is a DEFAULT that
// any explicit insecureHTTPParser/httpValidation option overrides
// (explicit false/strict under the flag stays strict), and it enables
// the FULL lenient set (obs-fold + header-value chars, server and
// client sides). A browser deployment has no CLI flags, so the default
// is strict there. Deliberately NOT imported from ./process.js: that
// module installs its shim as globalThis.process, which would trip the
// parity harness's global-leak detector and change common's exit
// handling for every http test — the host process is still intact when
// servers/clients are constructed in this lane.
function _insecureHttpParserFlag() {
  const p = typeof globalThis !== "undefined" ? globalThis.process : undefined;
  return (
    !!p &&
    Array.isArray(p.execArgv) &&
    p.execArgv.includes("--insecure-http-parser")
  );
}

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
const ERR_HTTP_BODY_NOT_ALLOWED = () =>
  makeError(
    "ERR_HTTP_BODY_NOT_ALLOWED",
    "Adding content for this request method or response status is not allowed.",
  );
const ERR_HTTP_SOCKET_ENCODING = () =>
  makeError(
    "ERR_HTTP_SOCKET_ENCODING",
    "Changing the socket encoding is not allowed per RFC7230 Section 3.",
  );
const ERR_HTTP_CONTENT_LENGTH_MISMATCH = (actual, expected) =>
  makeError(
    "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
    `Response body's content-length of ${actual} byte(s) does not match the content-length of ${expected} byte(s) set in header`,
  );
const ERR_HTTP_SOCKET_ASSIGNED = () =>
  makeError("ERR_HTTP_SOCKET_ASSIGNED", "Socket already assigned");
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
// Node's true-argument validation shape (http.request's `timeout` option
// and ClientRequest.setTimeout's `msecs`): "argument" (not "property")
// with the same invalidArgTypeHelper suffix (null → "Received null",
// string → "Received type string ('x')"). The shared factory above
// renders a plain "Received type <typeof> (<value>)" suffix, which is
// wrong for null (real Node: "Received null", no "type object (null)").
const ERR_INVALID_ARG_TYPE_ARGUMENT = (name, expected, actual) => {
  const err = new TypeError(
    `The "${name}" argument must be of type ${expected}.${_invalidArgTypeSuffix(actual)}`,
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
    RangeError,
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
    TypeError,
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

// Byte length of a validated outgoing chunk (Buffer, Uint8Array, or
// string with an optional write encoding). Used only by the strict
// Content-Length check below.
function _strictByteLength(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  try {
    return Buffer.byteLength(
      chunk,
      typeof encoding === "string" ? encoding : "utf8",
    );
  } catch {
    return String(chunk).length;
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
export function validateHeaderValue(name, value, lenient = false) {
  if (value === undefined) {
    throw ERR_HTTP_INVALID_HEADER_VALUE(value, name);
  }
  if (_checkInvalidHeaderChar(String(value), lenient)) {
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
function normalizeArrayHeaders(headers, lenient = false) {
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
          validateHeaderValue(name, el, lenient);
          pairs.push([name, String(el)]);
        }
      } else {
        validateHeaderValue(name, value, lenient);
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
          validateHeaderValue(headers[n], el, lenient);
          pairs.push([headers[n], String(el)]);
        }
      } else {
        validateHeaderValue(headers[n], value, lenient);
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

// Numeric slot of the server socket.parser facade that mirrors real
// Node's HTTPParser.kOnTimeout (probed v24.22.1: 6 — a numeric
// parser-callback slot, hence `| 0` works in the test). The facade
// holds a function here while the connection lives; the close handler
// nulls it after free(). Ceiling: the vendored suite pins the era, but
// a future Node renumbering would break this mapping.
const HTTP_PARSER_K_ON_TIMEOUT = 6;

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
    // Real Node's OutgoingMessage is NOT a stream.Writable: `writable`
    // is a plain own property that stays true through end/finish/close
    // and even destroy (probed v24.22.1). The Writable getter flips
    // false at end(), which breaks finish-writable assertions, so
    // shadow it with the plain property real Node carries.
    // ponytail: a prototype getter returning true would also work;
    // the own property additionally matches real Node's assignable
    // plain-property shape.
    Object.defineProperty(this, "writable", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: true,
    });
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

  get writableFinished() {
    // ClientRequest emits 'finish' manually when its round trip
    // completes (see end()), never through Writable finish machinery,
    // so the Writable finished bit is never set for it. The flag set
    // in end()'s finish closure covers that path; every other message
    // finishes through Writable machinery, where the bit is set before
    // the 'finish' event (so the handler already reads true).
    return this._outgoingFinishEmitted === true || super.writableFinished;
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
        // writeHead(obj) headers reach here without passing setHeader,
        // so this is where their values are validated (strict rejects
        // control chars, relaxed/insecure allow them per the Fetch
        // spec — test-http-header-value-relaxed Tests 17/18). kOutHeaders
        // entries were already validated at set time under the same
        // mode, so re-checking them is a no-op.
        if (
          _checkInvalidHeaderChar(String(v), this._isLenientHeaderValidation())
        ) {
          throw ERR_INVALID_CHAR("header content", name);
        }
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

  // Strict Content-Length accounting (probed real Node v24.22.1, both
  // ServerResponse and ClientRequest carry the flag, default false):
  // - The byte count is unconditional (like Node's _contentLength):
  //   bytes written while the flag is off still count if it is turned
  //   on later.
  // - The check runs only when strictContentLength is truthy, an
  //   explicit Content-Length is set (either header store: writeHead
  //   (obj) headers live in _renderedHeaders only, while getHeader()
  //   sees kOutHeaders only), and the framing is not chunked (a CL +
  //   TE-chunked write never throws mismatch on real Node).
  // - write(): prospective total > CL throws; end(): prospective total
  //   !== CL throws, including a chunkless end with a short total.
  // - A throw leaves the count unchanged and (in end()) runs before
  //   `finished` is set, so a retry write/end still delivers — the
  //   mismatch test's fewer-bytes case relies on it.
  // - Known untested divergence: after an end() that throws for
  //   OVERFLOW, real Node's retry end() throws again, while this
  //   helper (overflow chunk not counted) would let a retry deliver.
  //   No official test covers retry-after-overflow.
  // `count` is false when the caller routes the chunk through
  // OutgoingMessage.write right after (ServerResponse.end, buffered
  // ClientRequest.end), which counts it once via the write check.
  _strictCheck(len, isEnd, count = true) {
    const prev = this._clWritten ?? 0;
    const total = prev + len;
    if (this.strictContentLength) {
      let clRaw = this.getHeader("content-length");
      if (clRaw === undefined) {
        clRaw = (this._renderedHeaders || {})["content-length"];
      }
      let teRaw = this.getHeader("transfer-encoding");
      if (teRaw === undefined) {
        teRaw = (this._renderedHeaders || {})["transfer-encoding"];
      }
      const cl =
        Array.isArray(clRaw) && clRaw.length === 1
          ? Number(clRaw[0])
          : Number(clRaw);
      const teVals =
        teRaw === undefined ? [] : Array.isArray(teRaw) ? teRaw : [teRaw];
      const chunked =
        this._chunkedStreaming ||
        teVals.some((v) => /(^|[, \t])chunked([, \t]|$)/i.test(String(v)));
      if (
        clRaw !== undefined &&
        Number.isFinite(cl) &&
        cl >= 0 &&
        !chunked &&
        (isEnd ? total !== cl : total > cl)
      ) {
        throw ERR_HTTP_CONTENT_LENGTH_MISMATCH(total, cl);
      }
    }
    if (count) this._clWritten = total;
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
    if (
      this._rejectNonStandardBodyWrites &&
      (this._hasBody === false || this.req?.method === "HEAD")
    ) {
      // Probed real Node v24.22.1: with the server option enabled, ANY
      // body write to a 204/304/1xx or HEAD response throws
      // ERR_HTTP_BODY_NOT_ALLOWED — even an empty write. Default/false
      // keeps the silent drop in the branch below. Only ServerResponse
      // ever carries the flag, so ClientRequest is unaffected.
      throw ERR_HTTP_BODY_NOT_ALLOWED();
    }
    if (this._hasBody === false) {
      // 204/304/1xx responses MUST NOT have a body: ignore writes (Node parity).
      if (typeof encoding === "function") callback = encoding;
      if (typeof callback === "function") queueMicrotask(callback);
      return true;
    }
    // Strict Content-Length enforcement (probed real Node v24.22.1):
    // with strictContentLength truthy (truthy 1 enables it too) and an
    // explicit Content-Length, a write whose prospective total exceeds
    // it throws ERR_HTTP_CONTENT_LENGTH_MISMATCH. The throw leaves the
    // count unchanged, so a retry write/end still delivers.
    this._strictCheck(_strictByteLength(chunk, encoding), false);
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
    // Bare OutgoingMessage with an assigned real socket: real Node
    // writes straight through to the socket (no buffering, outputSize
    // stays 0, write returns true) and end() appends the terminating
    // empty chunk before 'finish' (probed v24.22.1). The Writable path
    // below only buffers into outputData and never touches the socket,
    // so bare messages never delivered. User subclasses (like the
    // message-inheritance test's Response) share the base behavior;
    // ServerResponse/ClientRequest have their own delivery machinery
    // and are excluded.
    // ponytail: writes buffered BEFORE socket assignment are not
    // flushed on assignment (no official test covers that order).
    if (
      !(this instanceof ServerResponse) &&
      !(this instanceof ClientRequest) &&
      this.socket !== null &&
      !this.finished &&
      this.socket.constructor?.name !== "FakeSocket" &&
      typeof this.socket.write === "function"
    ) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk, encoding ?? undefined)
          : Buffer.from(chunk);
      if (typeof callback === "function") this.socket.write(buf, callback);
      else this.socket.write(buf);
      return true;
    }
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
    if (
      chunk !== null &&
      chunk !== undefined &&
      this._rejectNonStandardBodyWrites &&
      (this._hasBody === false || this.req?.method === "HEAD")
    ) {
      // Same rule as write() above, for end(body); a chunkless end()
      // never throws (probed real Node v24.22.1). Thrown before
      // `finished` is set so a retry end() still delivers.
      throw ERR_HTTP_BODY_NOT_ALLOWED();
    }
    // Strict Content-Length (see _strictCheck): end() throws when the
    // prospective total differs from the declared length, including a
    // chunkless end with a short total. Dropped bodies (204/304/1xx)
    // are not counted, mirroring write(). Thrown before `finished` is
    // set so a retry end() still delivers.
    if (this._hasBody !== false) {
      this._strictCheck(
        chunk !== null && chunk !== undefined
          ? _strictByteLength(chunk, encoding)
          : 0,
        true,
      );
    }
    this.finished = true;
    // Bare message with an assigned real socket (see write()): the
    // chunk goes straight to the socket, followed by the terminating
    // empty chunk, and only then does 'finish' fire (probed
    // v24.22.1). Routing through super.write would buffer without
    // ever touching the socket.
    if (
      !(this instanceof ServerResponse) &&
      !(this instanceof ClientRequest) &&
      this.socket !== null &&
      this.socket.constructor?.name !== "FakeSocket" &&
      typeof this.socket.write === "function"
    ) {
      if (chunk !== null && chunk !== undefined && this._hasBody !== false) {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === "string"
            ? Buffer.from(chunk, encoding ?? undefined)
            : Buffer.from(chunk);
        this.socket.write(buf);
      }
      this.socket.write(Buffer.alloc(0));
      super.end(callback);
      return this;
    }
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
    if (!t || typeof t !== "object") return "0\r\n\r\n";
    // Array form: addTrailers([[name, value], ...]) — the form
    // test-http-raw-headers uses (repeated trailer names, order kept).
    // One line per pair, verbatim casing and order.
    if (Array.isArray(t)) {
      const lines = [];
      for (const pair of t) {
        if (Array.isArray(pair) && pair.length >= 2) {
          lines.push(`${pair[0]}: ${String(pair[1])}\r\n`);
        }
      }
      return lines.length === 0 ? "0\r\n\r\n" : `0\r\n${lines.join("")}\r\n`;
    }
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
    const sock = this.socket;
    if (sock && !sock.destroyed && sock.constructor.name !== "FakeSocket") {
      if (this._isForeignSocket()) {
        // Foreign sockets report write failures through the callback.
        // The queued _write callbacks fire with the outcome (see
        // _write): on failure the error reaches the user's write
        // callback, and the stream 'error' it triggers is swallowed
        // (see emit) because the error is already delivered through
        // the callbacks — real Node surfaces it only there.
        const wCbs = this._pendingFrameCallbacks || [];
        this._pendingFrameCallbacks = [];
        try {
          sock.write(frame, (err) => {
            if (err) this._socketWriteError ??= err;
            this._maybeEmitStreamDrain();
            for (const cb of wCbs) {
              if (err) {
                (this._suppressedWriteErrors ??= new Set()).add(err);
                cb(err);
              } else cb();
            }
          });
        } catch {
          /* socket write threw synchronously; the frame is lost */
          this._maybeEmitStreamDrain();
          for (const cb of wCbs) cb();
        }
      } else {
        try {
          sock.write(frame);
        } catch {
          /* socket write failed; ignore */
        }
        // Drain AFTER the write, not before: a drain listener may
        // end() the response, and end()'s terminator must follow this
        // frame on the wire. Emitting first let the terminator overtake
        // the frame (end-cork: the client saw chunk bytes before the
        // status line and failed the parse).
        this._maybeEmitStreamDrain();
      }
    } else {
      this._maybeEmitStreamDrain();
    }
  }

  flushHeaders() {
    if (!this._header) {
      this._implicitHeader();
    }
  }

  // A socket the shim did not create: a user-supplied Duplex (server
  // emit("connection") / request createConnection) or a real net
  // socket. Shim sockets carry the loopback peer slot (_peer, always
  // present on the shim's Socket class, null before pairing); user
  // sockets never do. FakeSocket is the placeholder, never a delivery
  // target. Foreign sockets can fail writes, so delivery to them needs
  // callback plumbing (see _flushPendingFrame / end()); virtual
  // sockets keep the fire-and-forget path.
  // ponytail: if net.js ever renames _peer, foreign sockets silently
  // fall back to the fire-and-forget path (status quo, no regression).
  _isForeignSocket() {
    const sock = this.socket;
    return (
      !!sock &&
      sock.constructor?.name !== "FakeSocket" &&
      sock._peer === undefined &&
      typeof sock.write === "function"
    );
  }

  setTimeout(msecs, callback) {
    if (callback) this.once("timeout", callback);
    // Real Node forwards to the socket: immediately when assigned, or
    // deferred to the 'socket' event when assigned later (probed
    // v24.22.1). The previous stub registered the callback but never
    // forwarded, so socket.setTimeout was never called.
    if (this.socket && typeof this.socket.setTimeout === "function") {
      this.socket.setTimeout(msecs);
    } else {
      this.once("socket", (sock) => {
        if (sock && typeof sock.setTimeout === "function") {
          sock.setTimeout(msecs);
        }
      });
    }
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
    // test-http-parser-memory-retention: the client parser's props are
    // nulled at response end, before 'end' fires (push(null) delivers
    // it), and the request drops its parser reference. Server-side
    // messages have no .req.parser, so this is a no-op there.
    const parser = this.req?.parser;
    if (parser) {
      parser.onIncoming = null;
      parser.joinDuplicateHeaders = null;
      this.req.parser = null;
    }
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
    // Server option, forwarded at dispatch (see ServerBase): when true,
    // body writes to a body-not-allowed response throw instead of being
    // silently dropped (OutgoingMessage.write/end below).
    this._rejectNonStandardBodyWrites =
      options?.rejectNonStandardBodyWrites === true;
    // Server httpValidation mode, forwarded at dispatch: when true,
    // setHeader/writeHead allow control chars per the Fetch spec
    // (test-http-header-value-relaxed).
    this._lenientHeaderValidation = options?.lenientHeaderValidation === true;
    // statusMessage stays undefined until writeHead (Node: prototype default).
    this.sendDate = true;
    this._resolve = null;
    // Standalone responses (test-http-server-response-standalone) have
    // no dispatch finish listener to serialize them: at finish, flush
    // the rendered header block + buffered body to the assigned socket
    // followed by an empty write (real Node's final empty socket
    // write). Dispatch-created responses carry _serverReqNo (set by
    // dispatch before finish can fire) and are serialized by
    // _finishSocketResponse instead, so they skip this.
    this.once("finish", () => {
      if (this._serverReqNo !== undefined) return;
      const sock = this.socket;
      if (!sock || sock.destroyed || sock.constructor.name === "FakeSocket") {
        return;
      }
      try {
        const body = Buffer.concat(this.outputData.map((e) => e.data));
        const header =
          this._headerFlushed || !this._header
            ? Buffer.alloc(0)
            : Buffer.from(this._header, "latin1");
        sock.write(Buffer.concat([header, body]));
        sock.write(Buffer.alloc(0));
      } catch {
        /* socket write failed; ignore */
      }
    });
    // 'finish'-emitted tracking for end(): a post-finish end() reports
    // ERR_STREAM_ALREADY_FINISHED while a pre-finish one queues (see
    // end()). Registered here, before any user listener, so a finish
    // listener that calls end() already sees the flag set.
    this.once("finish", () => {
      this._finishEmitted = true;
    });
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

  // Outbound header-value validation follows the server's mode (see
  // the constructor field above).
  _isLenientHeaderValidation() {
    return this._lenientHeaderValidation === true;
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
  // onSocketError, when given, receives foreign-socket write failures
  // (see end()'s early delivery): without it failures are ignored, as
  // before. Only end() passes one; every other caller keeps the old
  // fire-and-forget behavior.
  _flushHeaders(onSocketError) {
    if (this._headerFlushed || !this._header) return;
    const sock = this.socket;
    // Only stream to real sockets, not the FakeSocket (used for non-virtual paths).
    if (!sock || sock.constructor.name === "FakeSocket") return;
    if (sock.destroyed) return;

    const header = this._streamingHeader();
    // A callback only when the caller wants failures: passing an
    // undefined callback is identical to passing none, but branching
    // keeps the hot path byte-identical for virtual sockets.
    const write = (bytes) => {
      if (onSocketError) sock.write(bytes, onSocketError);
      else sock.write(bytes);
    };
    try {
      write(header);
      // Flush any data buffered before the first write().
      for (const entry of this.outputData) {
        const chunk = entry.data;
        if (this._chunkedStreaming && chunk.length > 0) {
          // One write per frame, not three: a chunk split across
          // delivery events lets a naive client split-count mis-pair
          // headers and bodies (test-http-server-keep-alive-defaults
          // false-triggers its 8-part check on a bare size line).
          write(
            Buffer.concat([
              Buffer.from(chunk.length.toString(16) + "\r\n", "latin1"),
              chunk,
              Buffer.from("\r\n", "latin1"),
            ]),
          );
        } else if (chunk.length > 0) {
          write(chunk);
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
      // Foreign sockets: the write callback fires with the flush
      // outcome (see _flushPendingFrame); calling it now with null
      // would report success before the socket even saw the bytes.
      // EXCEPT empty writes: they pend no frame, so no flush is ever
      // scheduled for them — queueing their callback deadlocks the
      // Writable (later writes never reach _write, finish never
      // fires). An empty write has no bytes whose outcome to await,
      // so its callback fires immediately, as before.
      if (this._isForeignSocket() && buf.length > 0) {
        (this._pendingFrameCallbacks ??= []).push(callback);
      } else {
        callback();
      }
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
        // Foreign sockets: see the streaming branch above — the
        // callback waits for the flush outcome, it does not fire null
        // before the bytes reach the socket.
        if (this._isForeignSocket()) {
          (this._pendingFrameCallbacks ??= []).push(callback);
        } else {
          callback();
        }
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

  // Foreign-socket write failures are delivered through write
  // callbacks (see _flushPendingFrame), not as stream 'error' events:
  // real Node surfaces them only through the callbacks (plus server
  // 'clientError'), and a test that attaches no 'error' listener would
  // throw on an emitted 'error'. Swallow exactly the recorded failure
  // objects; any other error still emits.
  emit(event, ...args) {
    if (
      event === "error" &&
      args.length > 0 &&
      this._suppressedWriteErrors?.has(args[0])
    ) {
      return false;
    }
    return super.emit(event, ...args);
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

  // 1xx interim responses ride the socket as raw status lines ahead of
  // the final response (test-http-information-*, test-http-early-hints,
  // test-http-expect-continue): the client round trip routes them to
  // 'continue' (100) / 'information' (other 1xx) instead of 'response'.
  // ponytail: one shared renderer + socket write; no new stream state —
  // interim bytes are fire-and-forget wire bytes, and the final response
  // still frames through _finishSocketResponse. Ceiling: pipelined
  // responses with a null socket drop interim bytes (no test covers
  // interim + pipelined-unfinished).
  _writeInterim(statusCode, pairs) {
    const sock = this.socket;
    if (!sock || sock.destroyed || sock.constructor.name === "FakeSocket") {
      return;
    }
    let head = `HTTP/1.1 ${statusCode} ${STATUS_CODES[statusCode] || ""}\r\n`;
    for (const [name, value] of pairs) head += `${name}: ${value}\r\n`;
    head += "\r\n";
    try {
      sock.write(head);
    } catch {
      /* a failed socket write must not break the final response */
    }
  }

  _checkInterimHeadersSent(op) {
    if (this.headersSent) throw ERR_HTTP_HEADERS_SENT(op);
  }

  writeContinue(callback) {
    this._checkInterimHeadersSent("write");
    this._writeInterim(100, []);
    if (typeof callback === "function") queueMicrotask(callback);
  }

  writeProcessing(callback) {
    this._checkInterimHeadersSent("write");
    this._writeInterim(102, []);
    if (typeof callback === "function") queueMicrotask(callback);
  }

  writeEarlyHints(hints, callback) {
    if (typeof hints !== "object" || hints === null) {
      throw ERR_INVALID_ARG_TYPE("hints", "object", hints);
    }
    // Probed real Node v24.22.1: headers-sent reports as ARG_VALUE here,
    // not HEADERS_SENT (unlike writeContinue/writeInformation).
    if (this.headersSent) {
      throw ERR_INVALID_ARG_VALUE("hints", hints, "headers already sent");
    }
    const pairs = [];
    for (const name of Object.keys(hints)) {
      validateHeaderName(name);
      const value = hints[name];
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        for (const el of value) validateHeaderValue(name, el);
        pairs.push([name, value.map(String).join(", ")]);
      } else {
        validateHeaderValue(name, value);
        pairs.push([name, String(value)]);
      }
    }
    // Empty hints ({} or all-empty arrays) send nothing — the client
    // observes no 'information' event (test-http-early-hints).
    if (pairs.length > 0) this._writeInterim(103, pairs);
    if (typeof callback === "function") queueMicrotask(callback);
  }

  writeInformation(statusCode, headers, callback) {
    if (typeof statusCode !== "number") {
      throw ERR_INVALID_ARG_TYPE("statusCode", "number", statusCode);
    }
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 199) {
      throw ERR_OUT_OF_RANGE("statusCode", "100-199", statusCode);
    }
    if (statusCode === 101) {
      throw ERR_HTTP_INVALID_STATUS_CODE(statusCode);
    }
    this._checkInterimHeadersSent("write");
    const pairs = [];
    if (headers !== undefined && headers !== null) {
      const list = Array.isArray(headers) ? headers : Object.entries(headers);
      for (const entry of list) {
        const [name, value] = Array.isArray(entry) ? entry : [entry, undefined];
        validateHeaderName(name);
        validateHeaderValue(name, value);
        pairs.push([name, String(value)]);
      }
    }
    this._writeInterim(statusCode, pairs);
    if (typeof callback === "function") queueMicrotask(callback);
    return true;
  }

  assignSocket(socket) {
    // Probed real Node v24.22.1: only assignSocket itself arms the
    // guard — a second assignSocket throws ERR_HTTP_SOCKET_ASSIGNED
    // (test-http-server-response-standalone), while a server-created
    // response (whose socket arrives via the dispatch path, not this
    // method) still accepts one assignSocket call.
    if (this._socketAssigned) throw ERR_HTTP_SOCKET_ASSIGNED();
    this._socketAssigned = true;
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
        // An error destroy carries the error to the socket (real Node:
        // ServerResponse.destroy(err) destroys the server socket WITH
        // the error, so socket 'error' fires with it and 'close' carries
        // hadError=true). This is the path a captureRejections drain
        // throw takes: the stream machinery routes the rejection through
        // destroy(err), and the socket 'error' mustCall in
        // test-http-outgoing-message-capture-rejection block 1 only fires
        // if the socket gets the error — a graceful destroy left the
        // socket closing cleanly, the test's server.close() never ran,
        // and the test hung. A graceful destroy still passes no error.
        if (err) sock.destroy(err);
        else sock.destroy();
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
    // Normalize BEFORE the finished check: real Node calls end(fn)
    // after finish with fn (it reports ERR_STREAM_ALREADY_FINISHED),
    // it does not drop it — the old order dropped chunk-as-callback
    // and encoding-as-callback forms (end-multiple: end2/end3 and the
    // post-finish end never fired).
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    // Sticky foreign-socket write failure (see _socketWriteError):
    // the failure was already reported through write callbacks; end()
    // only re-reports it, never delivers or finishes.
    if (this._socketWriteError) {
      if (typeof callback === "function") {
        queueMicrotask(() => callback(this._socketWriteError));
      }
      if (!this.destroyed) this.destroy();
      return this;
    }
    if (this.finished) {
      if (typeof callback === "function") {
        if (chunk === null || chunk === undefined) {
          if (this._finishEmitted) {
            // (c) chunkless post-finish: ERR_STREAM_ALREADY_FINISHED,
            // no 'error' event (probed v24.22.1).
            const er = new Error("Stream already finished");
            er.code = "ERR_STREAM_ALREADY_FINISHED";
            queueMicrotask(() => callback(er));
          } else {
            // (a) chunkless pre-finish: queue at finish, called with
            // null before the 'finish' event (Writable onFinished).
            // Routes through OutgoingMessage.end so validation and
            // the finished flag stay consistent.
            super.end(callback);
          }
        } else {
          // (b)/(d) chunk end: always ERR_STREAM_WRITE_AFTER_END;
          // the 'error' event fires only pre-finish (b), after the
          // finish event, callback first (probed v24.22.1).
          const er = new Error("write after end");
          er.code = "ERR_STREAM_WRITE_AFTER_END";
          if (this._finishEmitted) {
            queueMicrotask(() => callback(er));
          } else {
            this.once("finish", () => {
              queueMicrotask(() => {
                callback(er);
                this.emit("error", er);
              });
            });
          }
        }
      }
      return this;
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
    if (
      chunk !== null &&
      chunk !== undefined &&
      this._rejectNonStandardBodyWrites &&
      (this._hasBody === false || this.req?.method === "HEAD")
    ) {
      // Same rule as OutgoingMessage.write/end: end(body) to a
      // body-not-allowed response throws when the server option is
      // enabled (probed real Node v24.22.1); thrown before `finished`
      // is set so a retry end() still delivers.
      throw ERR_HTTP_BODY_NOT_ALLOWED();
    }
    // Strict Content-Length (see _strictCheck): end() throws when the
    // prospective total differs from the declared length. The chunk
    // below routes through OutgoingMessage.write, which counts it, so
    // the check here does not count; a chunkless end counts nothing
    // either way. Thrown before `finished` is set so a retry end()
    // still delivers.
    if (this._hasBody !== false) {
      this._strictCheck(
        chunk !== null && chunk !== undefined
          ? _strictByteLength(chunk, encoding)
          : 0,
        true,
        chunk === null || chunk === undefined,
      );
    }
    this.finished = true;
    const done = () => {
      // The flag check comes first: on the foreign-failure path the
      // end callback already fired from the flush handler (below) or
      // the _write wrapper, and destroy() may still invoke done — it
      // must not fire the callback twice or re-deliver.
      if (this._endCallbackFired) return;
      this._endCallbackFired = true;
      this._deliver();
      // NOTE: no manual 'finish' emit — Writable emits it exactly once via
      // super.end() below, matching node:http. (A manual emit here used to
      // double-fire 'finish' for on('finish') consumers.)
      if (callback) {
        if (this._socketWriteError) callback(this._socketWriteError);
        else callback();
      }
    };
    if (chunk !== null && chunk !== undefined) {
      super.write(chunk, encoding, () => {
        if (this._socketWriteError) {
          if (callback && !this._endCallbackFired) {
            this._endCallbackFired = true;
            callback(this._socketWriteError);
          }
          if (!this.destroyed) this.destroy();
        } else super.end(done);
      });
    } else {
      super.end(done);
    }
    // Foreign-socket early delivery (dispatch-created responses
    // only): a foreign socket can fail, and finish-time delivery (via
    // _finishSocketResponse) is too late — the end callback and
    // 'finish' would already have fired with success. Delivering here,
    // before finish is scheduled, lets a failure divert to the error
    // path instead. Virtual sockets keep finish-time delivery (a
    // synchronous end flush broke incremental readers — see
    // _finishSocketResponse's #279 note). Gated on _serverReqNo:
    // standalone responses (no dispatch) keep finish-time delivery
    // via their own listener, which sends headers + body as ONE
    // write — _flushHeaders sends them as separate writes, and a
    // standalone test asserts the first write ends with the body.
    // ponytail: a FAILING standalone foreign socket is not reported
    // (finish-time delivery ignores it) — no official test covers it.
    if (
      this._isForeignSocket() &&
      this._serverReqNo !== undefined &&
      !this._headerFlushed
    ) {
      this._flushHeaders((err) => {
        if (err) this._socketWriteError ??= err;
      });
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
    // so they are already correctly ordered. HEAD responses never get a
    // terminator here: real Node sends headers-only for HEAD+chunked
    // (probed v24.22.1), and a terminator after a HEAD response parses
    // as a new message start on the client (test-http-head-request).
    if (
      this._headerFlushed &&
      this._chunkedStreaming &&
      this.req?.method !== "HEAD"
    ) {
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
          const bytes = pending ? Buffer.concat([pending, term]) : term;
          // Foreign sockets: capture a terminator-write failure so the
          // sticky check below can divert to the error path.
          if (this._isForeignSocket()) {
            sock.write(bytes, (err) => {
              if (err) this._socketWriteError ??= err;
            });
          } else {
            sock.write(bytes);
          }
          this._chunkTerminatorSent = true;
          // Drain after the write (see _flushPendingFrame).
          this._maybeEmitStreamDrain();
          // The tail just delivered every pended frame, so their
          // queued _write callbacks (foreign only — virtual callbacks
          // already ran synchronously) fire now: plain writes with
          // null (their bytes went out), the end-chunk wrapper via
          // its sticky check (see above).
          const queued = this._pendingFrameCallbacks || [];
          this._pendingFrameCallbacks = [];
          for (const cb of queued) cb();
        } catch {
          /* socket write failed; finish listener skips destroyed sockets */
        }
      }
    }
    // A failure the early delivery just learned about: report it
    // through the end callback and close, never through finish.
    if (this._socketWriteError) {
      if (callback && !this._endCallbackFired) {
        this._endCallbackFired = true;
        queueMicrotask(() => callback(this._socketWriteError));
      }
      if (!this.destroyed) this.destroy();
      return this;
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

/**
 * Remove the six request listeners onSocket() attaches at assignment
 * (error forwarder, end observer, timeout observer, agent-timeout
 * forwarder, close untracker, response-timeout forwarder). Used by the
 * CONNECT/upgrade detach paths and by the agent's parking path; the
 * stashed refs make removal exact even when a listener was never
 * attached (e.g. no agent timeout option). The response forwarder is
 * removed here as a backstop for responses that never end (the primary
 * removal is the response's own 'end'/'close' handler).
 */
function _removeRequestSocketListeners(socket) {
  if (!socket || typeof socket.removeListener !== "function") return;
  if (socket._requestErrorListener) {
    socket.removeListener("error", socket._requestErrorListener);
    socket._requestErrorListener = null;
  }
  if (socket._requestEndListener) {
    socket.removeListener("end", socket._requestEndListener);
    socket._requestEndListener = null;
  }
  if (socket._requestTimeoutListener) {
    socket.removeListener("timeout", socket._requestTimeoutListener);
    socket._requestTimeoutListener = null;
  }
  if (socket._requestTimeoutCb) {
    socket.removeListener("timeout", socket._requestTimeoutCb);
    socket._requestTimeoutCb = null;
  }
  if (socket._responseTimeoutListener) {
    socket.removeListener("timeout", socket._responseTimeoutListener);
    socket._responseTimeoutListener = null;
  }
  if (socket._requestCloseListener) {
    socket.removeListener("close", socket._requestCloseListener);
    socket._requestCloseListener = null;
  }
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

    // insecureHTTPParser is a strict boolean on real Node: any other
    // type throws at construction (test-http-client-insecure-http-parser-
    // error, test-http-insecure-parser-per-stream Test 5). The flag
    // itself is threaded to the client round-trip parser, where it
    // enables lenient obs-fold unfolding (test-http-multi-line-headers).
    if (
      options.insecureHTTPParser !== undefined &&
      typeof options.insecureHTTPParser !== "boolean"
    ) {
      throw ERR_INVALID_ARG_TYPE_PROPERTY(
        "options.insecureHTTPParser",
        "of type boolean",
        options.insecureHTTPParser,
      );
    }
    this.insecureHTTPParser =
      options.insecureHTTPParser === true ||
      (options.httpValidation === undefined &&
        options.insecureHTTPParser === undefined &&
        _insecureHttpParserFlag());

    // httpValidation: 'strict' | 'relaxed' | 'insecure' (probed
    // v24.22.1): unknown values throw ERR_INVALID_ARG_VALUE, and
    // setting it together with insecureHTTPParser — even false —
    // throws ERR_INVALID_ARG_VALUE (mutual exclusion). 'relaxed'
    // enables only the header-value leniency; 'insecure' enables the
    // full lenient set (same as insecureHTTPParser). Default is
    // strict; insecureHTTPParser: true alone also implies lenient
    // header validation (test-http-header-value-relaxed Test 9's
    // converse: false alone stays strict).
    if (
      options.httpValidation !== undefined &&
      !["strict", "relaxed", "insecure"].includes(options.httpValidation)
    ) {
      throw ERR_INVALID_ARG_VALUE(
        "options.httpValidation",
        options.httpValidation,
        "must be one of: 'strict', 'relaxed', 'insecure'.",
      );
    }
    if (
      options.httpValidation !== undefined &&
      options.insecureHTTPParser !== undefined
    ) {
      throw ERR_INVALID_ARG_VALUE(
        "options.httpValidation",
        options.httpValidation,
        "cannot be used together with options.insecureHTTPParser.",
      );
    }
    this._lenientHeaderValidation =
      options.httpValidation === "relaxed" ||
      options.httpValidation === "insecure" ||
      this.insecureHTTPParser;

    // joinDuplicateHeaders is stored raw (default undefined, matching
    // real Node's probe: no option -> undefined, not false). It is
    // exposed as request.parser.joinDuplicateHeaders from 'socket' time
    // (test-http-parser-memory-retention).
    this.joinDuplicateHeaders = options.joinDuplicateHeaders;

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
        this._headersArray = normalizeArrayHeaders(
          options.headers,
          this._lenientHeaderValidation,
        );
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
    // Request-level createConnection: when set, the agent stays
    // undefined (above) and _performRequest honors the factory below
    // (test-http-header-value-relaxed Test 10's duplexPair shape).
    // Stored raw; _performRequest calls it with ({ port, host }, cb)
    // like real Node (probed v24.22.1).
    this._createConnection =
      typeof options.createConnection === "function"
        ? options.createConnection
        : null;

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
    // Unix-socket target (Node passes it through to createConnection
    // as { socketPath, path } — probed v24.22.1); previously dropped,
    // so a request-level factory for a socketPath target got bare
    // { port, host } and dialed TCP instead of the path.
    this.socketPath = options.socketPath || null;
    this.protocol = protocol;
    this.auth = options.auth;
    // The `timeout` option is validated at construction (probed
    // v24.22.1): non-number → ERR_INVALID_ARG_TYPE "timeout";
    // NaN/negative/Infinity → ERR_OUT_OF_RANGE non-negative finite;
    // floats are accepted. The option value is stashed separately
    // because setTimeout() must never overwrite it: the option applies
    // at socket assignment, a later setTimeout() at connect, and the
    // two must compose (option at assignment, setTimeout at connect).
    if (options.timeout !== undefined) {
      if (typeof options.timeout !== "number") {
        throw ERR_INVALID_ARG_TYPE_ARGUMENT(
          "timeout",
          "number",
          options.timeout,
        );
      }
      if (!(options.timeout >= 0) || !Number.isFinite(options.timeout)) {
        throw ERR_OUT_OF_RANGE(
          "timeout",
          "a non-negative finite number",
          options.timeout,
        );
      }
    }
    this.timeout = options.timeout;
    this._timeoutOption = options.timeout;
    this._responseReceived = false;
    this._roundTripStarted = false;
    this._suppressDestroyError = false;
    this._deferredTimeout = undefined;
    this._deferredTimeoutHook = false;
    this.maxHeaderSize = options.maxHeaderSize;
    this.reusedSocket = false;
    this.aborted = false;
    this.upgradeOrConnect = false;
    this._ended = false;
    this._aborted = false;
    this._errorEmitted = false;
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
    // Thread a request-level lookup option to the agent's connect options
    // (Node passes it through to net.connect). A lookup that never calls
    // back keeps the socket pending instead of erroring — the shape
    // test-http-agent-timeout-option relies on. Queued requests reuse
    // these stashed options on reprocessing.
    if (typeof options.lookup === "function") {
      this._agentOptions.lookup = options.lookup;
    }
    // Unix-socket target: the agent dials the path, so it must travel
    // in the stashed options (real Node: _http_agent sets
    // options.path = options.socketPath in addRequest/createSocket).
    // Previously dropped here, so the agent dialed TCP localhost:80
    // and every socketPath request failed ECONNREFUSED.
    if (options.socketPath) {
      this._agentOptions.socketPath = options.socketPath;
    }
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
    // Stashed for the request serializer: implicit Content-Length: 0
    // for empty POST/PUT/PATCH bodies is a default header — it must not
    // be added when the caller disabled default headers
    // (test-http-dont-set-default-headers-with-set-header asserts the
    // exact raw header list for an empty POST with defaults off).
    this._setDefaultHeaders = options.setDefaultHeaders !== false;
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
        // Node destroys synchronously for an already-aborted signal
        // (add-abort-signal: sync destroy when signal.aborted is
        // already true), so req.destroyed reads true right after
        // construction (test-http-client-abort-destroy, pre-aborted
        // block). The AbortError itself still arrives async — destroy
        // schedules 'error' on nextTick — so a listener attached after
        // http.get() returns still catches it.
        this._onAbortSignal();
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
    // Mark graceful abort for the socket error forwarder (it must not
    // re-emit a socket error for an aborted request). Whether abort()
    // itself errors is destroy()'s rule: a pending request errors with
    // ECONNRESET "socket hang up", a still-queued one closes silently
    // (both probed v24.22.1) — and an abort that lands before the round
    // trip started (socket assigned but the request never sent, e.g.
    // end() then abort() in the same tick) also closes silently: the
    // request never got going, so there is nothing to hang up.
    this._abortGraceful = true;
    this._suppressDestroyError = !this._roundTripStarted;
    queueMicrotask(() => this.emit("abort"));
    this.destroy();
  }

  _onAbortSignal() {
    if (this.aborted || this._aborted) return;
    // Node destroys (never aborts) on signal: lib/_http_client.js
    // addAbortSignal destroys the stream with an AbortError, so
    // req.aborted stays false while req.destroyed becomes true
    // (test-http-client-abort-destroy). _aborted (internal) is set
    // by destroy() below; the public flag is untouched here.
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
    // Teardown-initiated failure (see run()): a later round-trip
    // rejection from this teardown must not report through the end
    // callback — the request was torn down, not failed on flush.
    this._abortSwallow = true;
    // Deferred write callbacks (see write()) must still fire: before
    // this change they already fired null at write() time, so firing
    // null at teardown preserves the observable value.
    this._flushDeferredWriteCallbacks(null);
    // Node emits ECONNRESET "socket hang up" when a request is
    // destroyed before any response arrives (probed v24.22.1: pending,
    // timed-out, even unsent requests all error, whether via destroy()
    // or abort(); only a completed response avoids it). Pass it
    // through super.destroy so the emission order is error-then-close,
    // like a destroy(err) call. Three exceptions, all probed: (a) a
    // request still queued in the agent (no socket yet) closes
    // silently; (b) a request still waiting for socket assignment
    // gets its error from that wait's rejection (via end()'s handler),
    // so injecting here would double-fire; (c) an explicit error arg,
    // an already-destroyed request, and one whose error already fired
    // keep their existing outcome. The gate is error emission, NOT
    // _aborted: the round-trip timer sets _aborted when it kills an
    // unresponsive socket without emitting any error, and that must
    // not suppress the destroy error (test-http-client-timeout-on-
    // connect: timeout -> abort -> 'socket hang up').
    if (
      !err &&
      !this.destroyed &&
      !this._responseReceived &&
      !this._errorEmitted &&
      !this._suppressDestroyError &&
      // A request whose custom createConnection was never invoked
      // (no end() yet, so the shim still holds the FakeSocket
      // placeholder) has no socket to hang up: real Node emits
      // neither error nor close for a factory that returns undefined
      // (probed v24.22.1 — the path-toctou shape), while a default
      // agent or an already-assigned socket errors (probed: unsent
      // default-agent destroy, unsent real-socket-factory destroy).
      // Scope limit, documented: a real-socket factory destroyed
      // before end() also skips here (the shim only invokes the
      // factory at end() time, unlike Node's eager construction-time
      // invocation) — no official test covers that shape.
      !(this._createConnection && this.socket instanceof FakeSocket) &&
      this._agentQueueName === undefined &&
      !this._onSocketAssigned
    ) {
      err = new Error("socket hang up");
      err.code = "ECONNRESET";
      this._errorEmitted = true;
    }
    this._suppressDestroyError = false;
    // An explicit destroy error owns the request's error emission
    // (super.destroy emits it): the _performVirtualRequest continuation
    // and the socket-wait catch must not synthesize a second ECONNRESET
    // for it (signal abort: single AbortError, not ECONNRESET +
    // AbortError — test-http-agent-abort-controller).
    if (err) this._errorEmitted = true;
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
    // Do NOT remove it from the agent's tracking here: real Node removes
    // the socket from agent.sockets only on its 'close' event, so
    // synchronously after abort() the (destroyed) socket is still listed
    // (test-http-agent-maxsockets-respected asserts the list right after
    // abort(); synchronous removal emptied the list and its assert threw
    // inside the response handler, hanging the test). The close listener
    // installed in onSocket removes it and wakes the queue.
    // Pre-round-trip, the socket destroy is deferred one macrotask
    // (setTimeout 0): Node assigns req.socket only in onSocketNT (a
    // tick after construction), so a destroy() landing before that
    // tick never touches the socket — and a factory-queued error
    // destroy on the next tick (test-http-client-abort3:
    // socket.destroy(Error("Oops")) queued during construction)
    // still lands first and surfaces as the request's single
    // 'error'. A synchronous destroy here would kill the socket
    // first and swallow it (the ported stream destroy no-ops on an
    // already-destroyed socket, exactly like Node's). The deferral
    // must be a macrotask, not a microtask: under the parity harness
    // the test module runs inside a dynamic-import microtask, so
    // microtasks drain before nextTicks there (inverted vs real
    // Node) — a queueMicrotask destroy would still beat the
    // factory's nextTick. setTimeout(0) runs after all pending
    // nextTicks and microtasks in every environment (this file
    // already relies on that for the FIN-to-close chain).
    // Once the round trip started the destroy stays synchronous
    // (an in-flight abort must kill the socket at once).
    const sock = this.socket;
    if (sock && typeof sock.destroy === "function" && !sock.destroyed) {
      if (!this._roundTripStarted && !(sock instanceof FakeSocket)) {
        setTimeout(() => {
          if (!sock.destroyed) {
            try {
              sock.destroy();
            } catch {
              /* best effort */
            }
          }
        }, 0);
      } else {
        try {
          sock.destroy();
        } catch {
          /* best effort */
        }
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

  /**
   * Attach the request's socket-timeout listener (this.timeoutCb,
   * probed name `emitRequestTimeout`) exactly once. Real Node attaches
   * it at assignment whenever the request carries a timeout (agent
   * option, timeout option, or an already-called setTimeout), and it is
   * one-shot: after it fires, re-arming the socket timer does not
   * re-fire the request 'timeout' (probed v24.22.1) — hence `once`,
   * not `on`. `listeners()` unwraps once wrappers, so the
   * `listeners[1] === request.timeoutCb` assertions still hold.
   */
  _ensureRequestTimeoutListener() {
    const sock = this.socket;
    if (
      !sock ||
      sock instanceof FakeSocket ||
      typeof sock.on !== "function" ||
      this.timeoutCb
    ) {
      return;
    }
    const request = this;
    const emitRequestTimeout = () => {
      // Records that the request's timeout was already delivered via
      // the socket timer, so the virtual round-trip timer below does
      // not deliver a second one (test-http-client-timeout-event:
      // req.setTimeout(1) + agent timeout would otherwise fire once
      // from the socket and once from the round-trip timer).
      request._timeoutFired = true;
      request.emit("timeout");
    };
    this.timeoutCb = emitRequestTimeout;
    sock._requestTimeoutCb = emitRequestTimeout;
    sock.once("timeout", emitRequestTimeout);
  }

  /**
   * Attach the response's socket-timeout listener (probed name
   * `responseOnTimeout`) before the user response callback runs: at
   * response time the socket carries [onTimeout, emitRequestTimeout,
   * responseOnTimeout] whenever a timeout exists, and [onTimeout,
   * responseOnTimeout] even with no timeout at all (probed v24.22.1).
   * It emits 'timeout' on the response object and never destroys: a
   * stalled body still ends normally with complete === true. Both
   * timeout listeners come off at response 'end' (or 'close' for
   * abort-before-end), leaving [onTimeout] — the agent parking path
   * removes them too, as a backstop.
   */
  _attachResponseTimeout(msg) {
    const sock = this.socket;
    if (
      !sock ||
      sock instanceof FakeSocket ||
      typeof sock.on !== "function" ||
      sock._responseTimeoutListener
    ) {
      return;
    }
    const responseOnTimeout = () => {
      msg.emit("timeout");
    };
    sock._responseTimeoutListener = responseOnTimeout;
    sock.once("timeout", responseOnTimeout);
    // Identity-safe removal: a response's 'close' fires asynchronously
    // AFTER 'end' (emitCloseNT), by which time a keep-alive socket may
    // already be reused by the next request — so never remove via the
    // mutable socket stash (that would kill the next request's
    // listener, as the timeout-option-listeners reuse case proved).
    // The request listener is removed only while the stash still holds
    // THIS request's function; the response listener is removed by its
    // own captured identity, which no later response can share.
    const request = this;
    const remove = () => {
      if (request.timeoutCb && sock._requestTimeoutCb === request.timeoutCb) {
        sock.removeListener("timeout", request.timeoutCb);
      }
      sock.removeListener("timeout", responseOnTimeout);
      if (sock._responseTimeoutListener === responseOnTimeout) {
        sock._responseTimeoutListener = null;
      }
    };
    msg.once("end", remove);
    msg.once("close", remove);
  }

  setTimeout(timeout, callback) {
    if (callback) this.once("timeout", callback);
    // Validate synchronously like Node (probed v24.22.1): a pre-connect
    // call must throw at call time, not at connect (the socket's own
    // setTimeout validates too, but deferral below would delay it).
    if (typeof timeout !== "number") {
      throw ERR_INVALID_ARG_TYPE_ARGUMENT("msecs", "number", timeout);
    }
    if (!(timeout >= 0) || !Number.isFinite(timeout)) {
      throw ERR_OUT_OF_RANGE("msecs", "a non-negative finite number", timeout);
    }
    this.timeout = timeout;
    // Real Node applies a pre-connect setTimeout at CONNECT, never at
    // assignment (probed: socket.timeout still shows the option/agent
    // value at 'socket' time, the setTimeout value only at 'connect').
    // Forward immediately only when the socket is already connected
    // (reused keep-alive sockets take this path); otherwise store one
    // deferred slot and apply the latest value once, on 'connect'.
    // Queued requests (FakeSocket placeholder, no real socket yet) just
    // store the slot; onSocket() applies it at assignment/connect.
    const sock = this.socket;
    if (
      sock &&
      !(sock instanceof FakeSocket) &&
      typeof sock.setTimeout === "function"
    ) {
      // setTimeout(0) disables the timeout (it clears the socket timer
      // below) and attaches no request-timeout listener: after a
      // response ends, the socket must show exactly [onTimeout]
      // (set-timeout-after-end). A nonzero value attaches the
      // one-shot listener the request-timeout event needs.
      if (timeout !== 0) this._ensureRequestTimeoutListener();
      if (sock._connected) {
        sock.setTimeout(timeout);
      } else {
        this._deferredTimeout = timeout;
        if (!this._deferredTimeoutHook) {
          this._deferredTimeoutHook = true;
          sock.once("connect", () => {
            this._deferredTimeoutHook = false;
            if (!sock.destroyed) sock.setTimeout(this._deferredTimeout);
          });
        }
      }
    } else {
      this._deferredTimeout = timeout;
    }
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
    // Normalize BEFORE the _ended check, like ServerResponse.end:
    // end(fn) after end must still call fn, not drop it (the second
    // end() in the write-failure test passes its callback this way).
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = null;
      encoding = null;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    // Replay a sticky flush failure (see run()): a second end() after
    // a failed flush reports the SAME error object (probed v24.22.1).
    // Checked before the _ended early-return: after a failure the
    // request already ended, but the replay must still fire.
    if (this._flushError) {
      if (typeof callback === "function") {
        queueMicrotask(() => callback(this._flushError));
      }
      return this;
    }
    if (this._ended) {
      if (typeof callback === "function") queueMicrotask(callback);
      return this;
    }
    // Validate before _ended=true (see OutgoingMessage.end): a bad
    // chunk throws without poisoning the request.
    if (chunk !== null && chunk !== undefined) {
      validateOutgoingChunk(chunk);
    }
    // Strict Content-Length (see _strictCheck): end() throws when the
    // prospective total differs from the declared length. Checked
    // before _ended is set so a retry end() still delivers. The
    // buffered branch routes the chunk through OutgoingMessage.write,
    // which counts it, so the check there does not count; the
    // streaming branch forwards via _streamForward, which does not
    // count, so the check counts it.
    if (this._hasBody !== false) {
      const streaming = !!(this._stream && this._stream.roundTrip);
      this._strictCheck(
        chunk !== null && chunk !== undefined
          ? _strictByteLength(chunk, encoding)
          : 0,
        true,
        chunk === null || chunk === undefined || streaming,
      );
    }
    this._ended = true;
    this.finished = true;
    const finish = () => {
      this._flushDeferredWriteCallbacks(null);
      // Real Node's ClientRequest finishes through Writable machinery,
      // whose finished bit is already set when finish callbacks run;
      // the shim emits finish manually (no Writable finish bit), so
      // set the flag before the callbacks (see writableFinished).
      this._outgoingFinishEmitted = true;
      if (callback) callback();
      this.emit("finish");
    };
    const run = () => {
      this._performRequest().then(finish, (err) => {
        // The socket error forwarder may already have emitted this
        // error; never emit twice (a second emission breaks mustCall
        // counts for the write-failure test).
        if (!this._errorEmitted && this.listenerCount("error") > 0) {
          this._errorEmitted = true;
          this.emit("error", err);
        } else if (!this._errorEmitted) this.emit("abort");
        // A socket write failure (not a teardown-initiated failure)
        // is also the end callback's error, and it sticks for a
        // second end() (probed v24.22.1). Teardown-initiated failures
        // keep the old behavior (no end callback). Gated on
        // _errorEmitted: the socket error forwarder sets it, so this
        // runs only for genuine socket failures. Ungated, a
        // non-socket rejection (server closed, unvalidated early
        // hints) would get an end callback it never had AND a
        // destroy() that synthesizes a "socket hang up" error
        // _destroy only skips when _errorEmitted is already true.
        if (!this._abortSwallow && this._errorEmitted) {
          this._flushDeferredWriteCallbacks(err);
          this._flushError = err;
          if (callback) callback(err);
          // A failed request still closes (probed v24.22.1: 'close'
          // with writableFinished false). Without this the request
          // never closes: the rejection path emits no 'finish', and
          // no finish means no autoDestroy close. The error already
          // fired, so destroy() adds no second emission.
          if (!this.destroyed) this.destroy();
        }
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
    // Defer user write callbacks to round-trip settlement (see end())
    // ONLY for request-level custom connections: the buffered path
    // calls back null at write() time, before the socket ever saw the
    // bytes, so a socket write failure could never reach the callback
    // — real Node reports it there. Narrowed to custom connections on
    // purpose: streaming requests (virtual servers) and the fetch path
    // chain further writes inside write callbacks (write-callbacks:
    // write → cb → write → end), and deferring those deadlocks — the
    // callback that would trigger end() waits for the settlement that
    // end() would start. Custom-connection requests never stream (the
    // stream decision requires a virtual server), so no chain can
    // deadlock here. The machinery still gets a noop so Writable
    // accounting is unchanged.
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = null;
    }
    let cb = callback;
    // Writes after end (or after a sticky flush failure) are not
    // deferred: the Writable machinery reports them (write-after-end /
    // destroyed errors) directly, and no settlement will ever flush a
    // callback stashed now.
    if (
      typeof cb === "function" &&
      !this._ended &&
      !this._flushError &&
      typeof this._createConnection === "function"
    ) {
      (this._deferredWriteCallbacks ??= []).push(cb);
      cb = () => {};
    }
    const ret = super.write(chunk, encoding, cb);
    if (!this._ended && !this._aborted) {
      this._streamForward(
        chunk,
        typeof encoding === "string" ? encoding : undefined,
      );
    }
    return ret;
  }

  // Fire deferred write callbacks (see write()) with the round-trip
  // outcome: null on success, the failure on error. Take-and-clear, so
  // a later destroy() or second settlement cannot double-fire them.
  _flushDeferredWriteCallbacks(err) {
    const cbs = this._deferredWriteCallbacks || [];
    this._deferredWriteCallbacks = [];
    for (const cb of cbs) cb(err);
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
      method !== "CONNECT" &&
      upgrade !== "websocket" &&
      ((method !== "GET" &&
        method !== "HEAD" &&
        (method === "POST" ||
          method === "PUT" ||
          method === "PATCH" ||
          hasCL ||
          te === "chunked")) ||
        // ponytail: upgrade handshakes must reach the server on first
        // write(), not at end() — the client never ends an upgraded
        // request (it owns the socket after 101), so a buffered GET
        // upgrade would hang forever (test-http-upgrade-client2). No
        // other upgrade test writes before end, so this branch only
        // newly affects upgrade requests that do. Ceiling: if a future
        // upgrade test writes before end on a path that must stay
        // buffered, that case needs its own eligibility carve-out.
        upgrade !== "");
    if (!eligible) {
      this._stream = null;
      return null;
    }
    // ponytail: GET/HEAD bodies go raw on real Node (probed: no
    // Transfer-Encoding, no chunk framing, even for upgrade GETs) —
    // only explicit chunked TE chunks them. POST/PUT/PATCH without CL
    // still chunk, as before.
    const framing =
      hasCL || ((method === "GET" || method === "HEAD") && te !== "chunked")
        ? "raw"
        : "chunked";
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
    // The body bytes are now owned by the round trip/fetch below: drain
    // the request's buffer, mirroring real Node's flush-into-socket (so a
    // later socket.writableLength read no longer counts bytes already
    // handed off — the agent's drained check reads the socket, not the
    // request's stale buffer).
    this.outputData = [];
    this.outputSize = 0;
    if (body.length > 0 && this.method !== "GET" && this.method !== "HEAD") {
      fetchOptions.body = body;
    }
    // No GET/HEAD+body throw here: real Node http sends GET bodies fine,
    // and the loopback virtual/raw round trips below carry them like any
    // body (test-http-agent-reuse-drained-socket-only writes 192MB on a
    // GET). The fetch path below still throws: fetch forbids GET/HEAD
    // bodies, and no official test covers the old early throw.

    // Request-level createConnection goes FIRST, before the virtual/raw
    // gates: the factory replaces the agent entirely (real Node: no
    // agent when createConnection is set), and the gates need an
    // agent-assigned socket — a factory request reaching them crashes
    // in _performVirtualRequest on the undefined agent (probed
    // v24.22.1 shape: TypeError reading 'addRequest';
    // test-http-client-with-create-connection names the server's port,
    // so the virtual gate used to swallow its TCP half). Obtain the
    // socket from the request's own factory and round-trip over it.
    // All factory shapes (test-http-createConnection): synchronous
    // return, async callback delivery, both at once (first wins), sync
    // throw, async callback error. The factory vouches for readiness
    // (duplexPair sockets are already linked; net sockets from
    // net.connect are connected), so the socket is marked connected —
    // otherwise _performVirtualRequest's connect wait would hang on
    // sockets with no 'connect' event (native Duplex never emits one).
    // A factory that neither returns a socket nor calls back never
    // settles, like Node's pending socket — and falls through to
    // nothing: the request simply never completes.
    if (typeof this._createConnection === "function") {
      // Node's factory args (probed v24.22.1): the full connect
      // options — { port, host } for TCP, plus { socketPath, path }
      // for unix-socket targets.
      const factoryOptions = { port: this.port, host: this.host };
      if (this.socketPath) {
        factoryOptions.socketPath = this.socketPath;
        factoryOptions.path = this.socketPath;
      }
      const customSock = await new Promise((resolve, reject) => {
        let settled = false;
        const done = (err, sock) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve(sock || null);
        };
        let ret;
        try {
          ret = this._createConnection(factoryOptions, done);
        } catch (err) {
          done(err);
          return;
        }
        if (ret) {
          // Wire the socket synchronously, like Node's onSocket: the
          // error listener must be attached before user code runs, so
          // a factory-queued error destroy on the next tick still
          // reaches the request even after a synchronous abort()
          // (test-http-client-abort3). The continuation's onSocket
          // below is then a no-op via its duplicate guard. _connected
          // is set first, exactly as the continuation does — a
          // factory socket vouches for its own readiness (duplexPair
          // never emits 'connect').
          ret._connected = true;
          this.onSocket(ret);
          done(null, ret);
        }
      });
      if (customSock) {
        customSock._connected = true;
        this.onSocket(customSock);
        await this._performVirtualRequest(
          null,
          this._virtualHeaders(),
          body.length > 0 ? body : null,
          false,
          !!this._headersArray,
        );
        return;
      }
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

    // Unix-socket target owned by a pipe server (a virtual http server
    // bound via listen(path), or a raw net pipe server): route over the
    // agent socket like the raw-net gate above. Without this, a
    // socketPath request falls through to the assigned-socket branch
    // below and hangs forever — the agent socket is connected, but no
    // round trip is ever started for it. (The virtual-server gate
    // cannot serve it: the http registry is keyed by port, and a
    // socketPath request carries the default port 80.) Both registries
    // are consulted: the net bind lands after the 'listening' callback
    // (the backing net server binds on a later turn), so a request
    // made inside that callback would miss the net registry — the
    // http pipe registry is written synchronously at listen() time
    // and covers it; the net registry covers raw net pipe servers.
    if (
      this.socketPath &&
      (netHasPipeServer(this.socketPath) ||
        _httpShared().pipeRegistry.has(this.socketPath))
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

    // Agent-assigned real socket, no virtual/raw server to round-trip
    // against (the gates above already excluded servers): do NOT fall
    // through to fetch(). On real Node the request sits on its socket —
    // a lookup that never calls back never connects and never errors
    // (test-http-agent-timeout-option) — while fetching would fail
    // with 'fetch failed' and the agent's own connect error would
    // surface a second, spurious error. Emit 'socket' at assignment
    // (the socket is already assigned via onSocket) and wait on the
    // socket's fate: an error surfaces once via the request error
    // forwarder, and a never-connecting socket simply never settles,
    // so the loop drains and the process can exit — matching Node's
    // pending-socket hang. (A connected real socket cannot reach this
    // branch: connection needs a peer, and peer targets take the gates
    // above.)
    const assignedSock = this.socket;
    // Loopback only: creation-time assignment means every request now
    // holds a real socket here, but a non-loopback target must keep the
    // fetch path — the shim has no DNS/TCP for real hosts (netConnect
    // fails non-loopback names with ENOTFOUND), so deferring would
    // hijack fetch-bridge requests away from fetch (tests/http.test.js
    // and tests/https.test.js regressed on exactly this: example.com
    // requests errored ENOTFOUND instead of reaching mocked fetch).
    // The pending-socket shape this branch serves (a lookup that never
    // calls back) only exists for loopback targets.
    if (
      assignedSock &&
      !(assignedSock instanceof FakeSocket) &&
      this._isLoopbackTarget()
    ) {
      if (this._aborted) {
        const err = new Error("socket hang up");
        err.code = "ECONNRESET";
        throw err;
      }
      if (this.agent) {
        try {
          this.agent.emit("request", this);
        } catch {
          /* noop */
        }
      }
      // 'socket' fires async (microtask), like the fetch path's
      // queueMicrotask emission and the virtual path's waiter: the
      // request is constructed (and this branch reached) synchronously
      // inside get()/end(), before the caller can attach 'socket'
      // listeners — a synchronous emission would be lost. Skipped when
      // onSocket() already emitted at assignment time.
      if (!this._aborted && !this._socketEmitted) {
        this._socketEmitted = true;
        const sockForEvent = assignedSock;
        queueMicrotask(() => {
          if (!this._aborted) this.emit("socket", sockForEvent);
        });
      }
      // Never resolves: the socket's own error/close handlers own the
      // outcome from here (error → forwarder emits once; pending →
      // hang until loop drain). Returning would wrongly finish a
      // request whose socket never delivered.
      await new Promise(() => {});
      return;
    }

    // Committing to the fetch path: the agent socket's errors are now
    // irrelevant (see socketErrorListener's _usingFetch guard) — fetch
    // owns this request's outcome from here. Fetch forbids GET/HEAD
    // bodies, so the early GET+body throw lives here now (moved from
    // above _performRequest's body build, where it wrongly rejected
    // loopback round trips too).
    if ((this.method === "GET" || this.method === "HEAD") && body.length > 0) {
      throw makeError(
        "ERR_INVALID_ARG_VALUE",
        `Request with ${this.method} method cannot have a body.`,
      );
    }
    this._usingFetch = true;
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
      // Skipped when onSocket() already emitted at assignment time.
      if (!this._socketEmitted) {
        this._socketEmitted = true;
        queueMicrotask(() => {
          if (!this._aborted) this.emit("socket", this.socket);
        });
      }
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
    this._responseReceived = true;
    this._inFlightMessage = msg;
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
  // Outbound header-value validation follows the request's mode:
  // relaxed/insecure (or insecureHTTPParser) allow control chars per
  // the Fetch spec; strict rejects them (test-http-header-value-relaxed).
  _isLenientHeaderValidation() {
    return this._lenientHeaderValidation === true;
  }

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
    // Agent-socket listener lifecycle, probed on real Node (v24.22.1) at
    // assignment: exactly one 'error' listener (the request error
    // forwarder), two 'end' listeners (stream-internal onReadableStreamEnd
    // plus the request's observer — a no-op: 'end' listeners never affect
    // flow, and a 'data' listener here would wrongly switch the socket to
    // flowing mode), and one 'timeout' observer. The request's timeout
    // listener (this.timeoutCb) is appended as the SECOND 'timeout'
    // listener whenever the request carries a timeout — agent option,
    // timeout option, or an already-called setTimeout — and the timer
    // arms in precedence order: agent value, then the request option
    // overriding it, then a deferred setTimeout value at connect
    // (test-http-agent-timeout-option,
    // test-http-client-timeout-option-with-agent). The handlers are
    // stashed on the socket so the agent's parking path and the
    // CONNECT/upgrade detach paths can remove exactly these.
    // (test-http-agent-keepalive's checkListeners asserts error==1 and
    // end==2 at assignment, and error==1/end==1 after free.)
    const request = this;
    const socketErrorListener = (err) => {
      // Fetch-path requests never had a socket error forwarder (base
      // attached it only inside _performVirtualRequest): the agent
      // socket for a fetched host is meaningless (fetch owns the
      // outcome — e.g. the ENOTFOUND from netConnect for example.com
      // must not clear the request's timeout timer or set _aborted,
      // or tests/http.test.js "timeout emits timeout" loses its 20ms
      // timer to an unrelated DNS error). Ignore the error entirely
      // here; the listener's presence still consumes it, so nothing
      // throws unhandled on the socket.
      if (request._usingFetch) return;
      if (request._timeoutId) {
        clearTimeout(request._timeoutId);
        request._timeoutId = null;
      }
      // Node's socketErrorListener has NO aborted check
      // (lib/_http_client.js:757): any socket error reaches the
      // request, aborted or not. The synthetic 'socket hang up' is
      // suppressed at emission time instead (destroy() only injects
      // it when no error was already emitted, and onSocketNT skips
      // it when req.aborted) — so an explicit socket error that
      // arrives after abort() still surfaces (test-http-client-
      // abort3: factory destroys the socket with Error("Oops") on
      // the next tick, after a synchronous abort()). The single-fire
      // guard is _errorEmitted, not _aborted: a request whose error
      // already fired (signal abort's AbortError, a destroy-injected
      // ECONNRESET) never double-fires.
      if (request._errorEmitted) return;
      // If the socket is idle in the agent's free pool, the agent handles
      // the error (removes from pool, destroys). Don't propagate to this
      // (possibly completed) request — that would be an unhandled 'error'.
      if (socket._inFreePool) return;
      request._aborted = true;
      request._errorEmitted = true;
      request.emit(
        "error",
        err instanceof Error ? err : new Error(String(err)),
      );
    };
    // FIN on an active socket: agent sockets run with autoDestroy
    // disabled (see createSocket), so the FIN-to-close chain stalls
    // unless the HTTP layer closes the socket itself. The decision
    // must be deferred a turn: at 'end' time the parser has not
    // consumed the buffered body yet (probed: parser _state is still
    // "start-line" when FIN's 'end' fires — body parsing runs on
    // later nextTicks), so no state read here can tell a finished
    // response from a truncated one. A setTimeout(0) runs after all
    // pending nextTicks and microtasks — data delivery, parser
    // completion, round-trip settlement — so by then a finished
    // response shows msg.complete (or parser _state "complete") and
    // a truncated one still does not. Destroy only the latter:
    // destroying a finished response's socket now would close it
    // before the user's 'end' handlers run
    // (test-http-agent-destroyed-socket) — releaseSocket destroys
    // after 'end' instead — while a truncated message never
    // completes without the close (its 'aborted' + request error
    // come from the close machinery:
    // test-http-agent-keepalive's remoteError,
    // test-http-client-aborted-event). Pooled sockets never reach
    // here (their request listeners come off at release; the
    // pool-time autoDestroy flip owns FIN-while-pooled), and the
    // re-checks skip a socket released or destroyed meanwhile.
    const socketOnEnd = () => {
      if (socket._inFreePool) return;
      setTimeout(() => {
        if (socket._inFreePool || socket.destroyed) return;
        const msg = request._inFlightMessage;
        if (msg && (msg.complete || request.parser?._state === "complete")) {
          return;
        }
        try {
          socket.destroy();
        } catch {
          /* best effort */
        }
      }, 0);
    };
    const onTimeout = () => {};
    // An active socket's close untracks it: a request that errors
    // (remoteError: server destroys its side) never releases, so without
    // this the dead socket stays in agent.sockets and totalSocketCount
    // never drops (test-http-agent-keepalive's remoteError). removeSocket
    // only decrements when the socket is still in the active list, so a
    // close after release (already untracked) is a safe no-op; parking
    // removes this listener and installs the free-pool close handler.
    // The removal is deferred one turn: the request's 'error' is
    // delivered async via the round-trip rejection, and its handler
    // still observes the socket tracked (remoteError asserts
    // sockets=1 there); the 1ms-later close check sees it gone.
    const socketCloseListener = () => {
      setTimeout(() => {
        const agent = request.agent;
        if (!agent) return;
        const name =
          socket._agentName ||
          agent.getName({
            host: request.host,
            port: Number(request.port) || 80,
          });
        try {
          agent.removeSocket(socket, name);
        } catch {
          /* best effort */
        }
        // A closed active socket frees capacity: wake queued requests.
        // Real Node drains the queue from removeSocket (same origin
        // first, then the first queued origin with no active sockets);
        // the shim's releaseSocket already wakes on release, but a
        // socket closed without release (user destroy, abort, server
        // close) must wake too, or queued requests hang forever
        // (test-http-agent-maxsockets-respected: abort in the response
        // handler destroys the socket without releasing it). The
        // close drain is GATED (unlike the release drain): close
        // already freed an active slot and dropped the total, so the
        // gate passes for the freed origin — while an ungated close
        // drain would create a second socket for an origin whose
        // release drain already assigned one
        // (test-http-keep-alive-close-on-header: maxSockets 1 with
        // three queued requests must never show two active sockets).
        // The _drainQueue guard is load-bearing for custom agents
        // without it; _processQueue is the pre-drain fallback.
        if (typeof agent._drainQueue === "function") {
          agent._drainQueue(name, false);
        } else if (typeof agent._processQueue === "function") {
          agent._processQueue(name);
        }
      }, 0);
    };
    socket.on("error", socketErrorListener);
    socket.on("end", socketOnEnd);
    socket.on("timeout", onTimeout);
    socket.once("close", socketCloseListener);
    socket._requestErrorListener = socketErrorListener;
    socket._requestEndListener = socketOnEnd;
    socket._requestTimeoutListener = onTimeout;
    socket._requestCloseListener = socketCloseListener;
    socket._requestTimeoutCb = null;
    // Timeout precedence at assignment (probed v24.22.1): the agent
    // timeout arms first, then the request timeout option overrides it
    // (agent 50 + option 100 → socket.timeout 100, listeners
    // [onTimeout, emitRequestTimeout] — one shared listener, never a
    // second copy), then a pre-assignment setTimeout() value applies
    // at connect (or now, for an already-connected reused socket).
    const agentTimeout = this.agent?.options?.timeout;
    if (agentTimeout !== undefined && agentTimeout !== null) {
      this._ensureRequestTimeoutListener();
      if (typeof socket.setTimeout === "function") {
        socket.setTimeout(agentTimeout);
      }
    }
    if (this._timeoutOption !== undefined) {
      this._ensureRequestTimeoutListener();
      if (typeof socket.setTimeout === "function") {
        socket.setTimeout(this._timeoutOption);
      }
    }
    if (this._deferredTimeout !== undefined) {
      this._ensureRequestTimeoutListener();
      if (socket._connected) {
        if (typeof socket.setTimeout === "function") {
          socket.setTimeout(this._deferredTimeout);
        }
      } else if (!this._deferredTimeoutHook) {
        this._deferredTimeoutHook = true;
        socket.once("connect", () => {
          this._deferredTimeoutHook = false;
          if (!socket.destroyed) socket.setTimeout(this._deferredTimeout);
        });
      }
    }
    // test-http-parser-memory-retention + test-http-parser-free: real
    // Node pools parsers per socket — successive requests on a reused
    // socket observe the SAME parser object (parser-free asserts
    // identity across 100 pooled requests), while memory-retention
    // wants the props (re)set at each assignment and nulled at
    // response end. So the parser lives on the socket: onSocket reuses
    // it and refreshes its per-request props (and the lenient flag, in
    // case pooled requests differ). Parser state itself resets at
    // message completion (_resetMessage), so reuse across sequential
    // messages is safe. Created here, before the 'socket' microtask
    // below, so the handler observes it.
    // ponytail: one pooled object per socket, no separate pool — the
    // socket already owns the lifetime (destroy frees it with the
    // socket), and a global pool would add lifecycle for no test gain.
    let parser = socket._pooledParser;
    if (!parser) {
      parser = new HTTPParser("response", {
        insecureHTTPParser: this.insecureHTTPParser,
      });
      socket._pooledParser = parser;
    }
    parser.insecureHTTPParser = this.insecureHTTPParser;
    parser.lenientHeaderValue = this._lenientHeaderValidation;
    this.parser = parser;
    parser.onIncoming = () => {};
    parser.joinDuplicateHeaders = this.joinDuplicateHeaders;
    // Emit 'socket' at assignment time, like Node: the event fires while
    // the socket is still connecting (probed v24.22.1: connecting=true,
    // pending=true at 'socket' time), asynchronously so listeners attached
    // after http.request() returns still catch it. Previously the virtual
    // path emitted 'socket' only when the round trip started (at end()),
    // so a request that defers end() until 'connect' deadlocked: no
    // 'socket' → no 'connect' handler → no end() → no round trip
    // (test-http-agent-reuse-drained-socket-only). _performVirtualRequest
    // and the pending/fetch paths skip their emission once this flag is
    // set, so 'socket' fires exactly once per request.
    // ponytail: assignment-time emission is the Node shape; the flag is
    // the only new state, and it retires if Node ever changes 'socket'
    // to fire at round-trip time (it does not — the event is defined by
    // assignment, not by the first byte).
    if (!this._aborted && !this._socketEmitted) {
      this._socketEmitted = true;
      queueMicrotask(() => {
        if (!this._aborted) this.emit("socket", socket);
      });
    }
    if (this._onSocketAssigned) {
      const resolve = this._onSocketAssigned;
      this._onSocketAssigned = null;
      resolve(socket);
    }
    // Expect requests must put their head on the wire before end(): the
    // server can only answer (100 Continue / 417) once it sees the head,
    // and an expect-continue client only ends after 'continue' fires
    // (test-http-expect-continue) — a buffered head would deadlock.
    // Start the streaming round trip at assignment when an Expect header
    // is present; _streamEnsureStarted no-ops (buffered path at end())
    // for stream-ineligible shapes like GET + Expect, and for
    // non-virtual targets. ponytail: reuses the existing streaming path
    // (which already renders chunked framing exactly like Node's
    // expect-continue wire bytes); ceiling: headers set after assignment
    // miss the stream snapshot — no test covers post-assignment
    // setHeader on Expect requests.
    if (
      !this._ended &&
      !this._aborted &&
      this._stream === undefined &&
      (this.getHeader("expect") !== undefined ||
        this._headersArray?.some(([n]) => String(n).toLowerCase() === "expect"))
    ) {
      this._streamEnsureStarted();
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
    // The message is done; a later FIN must not re-trigger the
    // incomplete-message destroy in socketOnEnd.
    this._inFlightMessage = null;
    const name =
      sock._agentName ||
      agent.getName({ host: this.host, port: Number(this.port) || 80 });
    // Only release once.
    if (sock._releasedToAgent) return;
    sock._releasedToAgent = true;
    // Normal completion closes the request stream: real Node emits
    // request 'close' after the response ends and before the socket is
    // pooled (test-http-agent-free-socket-data-guard waits for it, then
    // nextTicks into the free pool). Drive the ported stream's destroy
    // directly — NOT this.destroy(), whose override would kill the
    // socket being released. The stream destroy is once-guarded, so a
    // later abort cannot emit a second 'close'.
    try {
      Writable.prototype.destroy.call(this, null);
    } catch {
      /* best effort */
    }
    try {
      agent.releaseSocket(sock, name, this._agentOptions);
    } catch {
      /* best effort */
    }
  }

  /**
   * Release the socket after the response's 'end' listeners run (or on
   * 'close' for abort-before-'end'). _finishBody()/_setBody() schedule
   * 'end' async, and user 'end' listeners attached at 'response' time
   * precede this completion-time once listener in emission order, so
   * they see the socket still assigned (destroyed === false) and
   * nextTick callbacks see it freed (test-http-agent-keepalive,
   * test-http-agent-destroyed-socket). The two listeners remove each
   * other: a stale 'close' firing after the socket was reused for a
   * later request must NOT re-park the live socket.
   */
  _releaseAfterEnd(msg) {
    const releaseOnEnd = () => {
      msg.removeListener("close", releaseOnClose);
      this._releaseAgentSocket();
    };
    const releaseOnClose = () => {
      msg.removeListener("end", releaseOnEnd);
      this._releaseAgentSocket();
    };
    msg.once("end", releaseOnEnd);
    msg.once("close", releaseOnClose);
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
        headers = { ...(headers || {}), Connection: "keep-alive" };
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
      // And not when destroy() already carried an explicit error (signal
      // abort): that error is the single emission (see destroy()).
      if (this._aborted || err?.code === "ECONNRESET") {
        if (!this._abortGraceful && !this._errorEmitted) {
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
      // Defer the destroy one macrotask (setTimeout 0), like
      // destroy()'s pre-round-trip deferral: a factory-queued error
      // destroy on the next tick (test-http-client-abort3) must land
      // while the socket is still alive, or its error is swallowed
      // (the ported stream destroy no-ops on an already-destroyed
      // socket). This continuation is a microtask, which the parity
      // harness drains before nextTicks (inverted vs real Node), so
      // a synchronous destroy here would beat the factory's nextTick.
      setTimeout(() => {
        if (!sock.destroyed) {
          try {
            sock.destroy();
          } catch {
            /* best effort */
          }
        }
      }, 0);
      // Graceful abort() while waiting closes silently, like its
      // sibling catch above (which already gates on !_abortGraceful):
      // the request never got going, so there is nothing to hang up.
      // A non-graceful destroy() while waiting errors here — that is
      // also why destroy()'s own injection skips when a socket wait is
      // pending (this wait's error is the single one) — and when the
      // wait already resolved before destroy() ran, destroy()'s
      // injection is the single one, so this branch also skips when
      // _errorEmitted is already set (close-event: destroy() then the
      // wait continuation must not emit a second ECONNRESET).
      if (!this._abortGraceful && !this._errorEmitted) {
        queueMicrotask(() => {
          if (this.listenerCount("error") > 0) {
            const err = new Error("socket hang up");
            err.code = "ECONNRESET";
            this.emit("error", err);
          }
        });
      }
      return;
    }
    // The round trip is committed from here: the assignment wait
    // resolved and the request proceeds to connect/write. abort()
    // from this point on is aborting a live request (ECONNRESET),
    // while abort() before this point closes silently.
    this._roundTripStarted = true;
    // The agent assigned the socket; onSocket() already set this.socket
    // and scheduled the assignment-time 'socket' emission. Emit here only
    // if that emission never happened (e.g. a socket assigned without
    // onSocket); the connect replay below is unchanged: listeners
    // attaching 'connect' inside 'socket' still catch an already-connected
    // socket's replayed 'connect'.
    if (!this._aborted) {
      if (!this._socketEmitted) {
        this._socketEmitted = true;
        this.emit("socket", sock);
      }
      if (sock._connectedBeforeAssign) {
        sock._connectedBeforeAssign = false;
        queueMicrotask(() => {
          if (!sock.destroyed) sock.emit("connect");
        });
      }
    }
    // Writes must not start until the socket is connected. 'socket'
    // was emitted above at assignment time (Node order), but the
    // round trip body below must wait: pre-connect writes are flushed
    // during pairing, before the server socket's HTTP machinery is
    // attached, so the server processes them asynchronously (after all
    // client writes) instead of synchronously during delivery. That
    // changes error timing two ways: a server destroy during the
    // head's delivery must error a later frame's write
    // (test-http-outgoing-destroyed), and a server handler throw must
    // land inside the round-trip writer's catch
    // (test-http-double-content-length, where base swallows the
    // clientError assertion throw). Waiting here restores
    // post-connect write timing; reused and already-connected sockets
    // skip the wait. On connect failure the socket's 'error' was
    // already forwarded by socketErrorListener, so a dead socket just
    // returns without a second emission.
    if (!(sock instanceof FakeSocket) && !sock._connected && !sock.destroyed) {
      await new Promise((resolve) => {
        const done = () => {
          sock.removeListener("connect", done);
          sock.removeListener("error", done);
          sock.removeListener("close", done);
          resolve();
        };
        sock.once("connect", done);
        sock.once("error", done);
        sock.once("close", done);
      });
    }
    if (sock.destroyed) return;
    // The request-level socket error forwarder lives in onSocket()
    // (socketErrorListener, attached at assignment so 'socket' handlers
    // already observe it); it is NOT re-attached here. The CONNECT and
    // upgrade detach paths below remove it (plus the other four
    // request listeners) before handing the socket to the app.

    if (this.timeout) {
      this._timeoutId = setTimeout(() => {
        this._timeoutId = null;
        // The socket destroy below always runs: it is what unblocks a
        // round trip to a server that never responds (no handler), letting
        // end()'s callback fire — without it, end() to a never-responding
        // server hangs (probed on pristine main). The 'timeout' emit is
        // skipped only when the socket timer already delivered this
        // request's timeout (flag set by the agent-timeout forwarder):
        // emitting again would double-fire 'timeout' for one idle period
        // (test-http-client-timeout-event). Requests without an agent
        // timeout never set the flag — the socket fire is a no-op for
        // them — so this timer remains their only 'timeout' source.
        this._aborted = true;
        // Teardown-initiated failure (see run()): the round-trip
        // rejection from this timeout keeps the old swallow behavior
        // (no end callback), unlike a socket write failure.
        this._abortSwallow = true;
        try {
          sock.destroy();
        } catch {
          /* best effort */
        }
        if (!this._timeoutFired) this.emit("timeout");
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
          insecureHTTPParser: this.insecureHTTPParser,
          parser: this.parser,
          setDefaultHeaders: this._setDefaultHeaders,
          // Request trailers ride the chunked terminator (rendered here
          // so _serializeRequestHead needs no trailer knowledge).
          chunkedTerminator: this._chunkTerminator(),
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
                  true,
                  this._setDefaultHeaders,
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
            // Whether anyone observes this response (a 'response'
            // listener exists now, including once() callbacks about to
            // fire — the constructor attaches the response callback via
            // once(), so checking later would miss it). Real Node
            // releases an UNOBSERVED response's keep-alive socket at
            // completion, but holds an observed-but-unconsumed one (both
            // probed v24.22.1); the completion branch below keys off
            // this flag.
            streamedMsg._responseObserved = this.listenerCount("response") > 0;
            // The response's socket-timeout listener goes on before the
            // user callback runs, so response-time listener counts match
            // real Node ([onTimeout, emitRequestTimeout,
            // responseOnTimeout], or [onTimeout, responseOnTimeout] with
            // no request timeout).
            this._attachResponseTimeout(streamedMsg);
            this._responseReceived = true;
            this._inFlightMessage = msg;
            this.emit("response", msg);
          },
          // 1xx interim: 100 → the request's 'continue' event, other 1xx
          // → 'information' carrying a full IncomingMessage (status,
          // version 1.1, raw headers preserved). Mirrors onHeaders but
          // without response bookkeeping: an interim message is not the
          // in-flight response (no timeout attach, no _responseObserved).
          onInformation: (info) => {
            if (this._aborted) return;
            if (info.statusCode === 100) {
              this.emit("continue");
              return;
            }
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
            this.emit("information", msg);
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
        if (
          !isAbort &&
          typeof err?.code === "string" &&
          err.code.startsWith("HPE_")
        ) {
          // Parse error after the response was emitted (e.g. trailing
          // garbage after a complete CL:0 response): real Node reports
          // it on the REQUEST, not the response stream — the response
          // gets 'aborted' + 'close' only, never an 'error' (emitting
          // one with no listener would throw, and mapping the code to
          // ECONNRESET would corrupt the parse error). Abort + close
          // the stream, then rethrow so the request's 'error' carries
          // the unmutated parse error (test-http-client-parse-error).
          streamedMsg._aborted = true;
          streamedMsg.emit("aborted");
          try {
            sock.destroy();
          } catch {
            /* best effort */
          }
          try {
            streamedMsg.destroy();
          } catch {
            /* best effort */
          }
          throw err;
        }
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
          // server destroys the response mid-stream) — but only when
          // the response stream actually listens for 'error': emitting
          // an unlistened 'error' throws inside this catch, skipping
          // the stream destroy and the request close below (and the
          // throw is then swallowed upstream, so the request just never
          // closes — test-http-server-capture-rejections block 2, whose
          // client attaches no res 'error' listener, hung on its req
          // 'close' mustCall exactly this way). Real Node passes that
          // test, so its error delivery here is effectively guarded.
          const e = err instanceof Error ? err : new Error(String(err));
          e.code = "ECONNRESET";
          if (streamedMsg.listenerCount("error") > 0) {
            streamedMsg.emit("error", e);
          }
        }
        // Don't call _finishBody() — 'end' must NOT fire on abort.
        // Destroy the message which emits 'close'.
        try {
          streamedMsg.destroy();
        } catch {
          /* best effort */
        }
        // The request itself closes when its socket dies mid-response
        // (probed v24.22.1: req 'close' fires, no req 'error' — the
        // error went to the response stream). ClientRequest.destroy()
        // synthesizes ECONNRESET only before a response arrives, and
        // _responseReceived is set for a streamed response, so this
        // stays error-free (test-http-server-capture-rejections
        // block 2: req 'close' with the partial body intact).
        try {
          this.destroy();
        } catch {
          /* best effort */
        }
        return;
      }
      if (this._aborted && this._abortSwallow) return;
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
      // already detached its own listeners; the five request listeners
      // attached in onSocket() are the ones left — remove all of them
      // (error 0, end 1, timeout 0 at handoff, per test-http-connect).
      try {
        _removeRequestSocketListeners(this.socket);
      } catch {
        /* already detached */
      }
      this.socket._httpMessage = null;
      // A CONNECT settles the request like a response does: the tunnel
      // is the app's now, so a later destroy() (e.g. the socket-close
      // hook below) must not report a hangup for it.
      this._responseReceived = true;
      // Detached means unmanaged: the agent's autoDestroy=false (see
      // createSocket) must not survive handoff, or the tunnel socket
      // never closes on end — its finish would not destroy it, so
      // neither socket 'close' nor the request 'close' below ever
      // fires (test-http-connect, test-http-connect-req-res). Restore
      // the normal socket lifecycle for the app-owned socket.
      this.socket.autoDestroy = true;
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
      // Same detach as the CONNECT path: the five request listeners from
      // onSocket() come off so the handed-off socket carries only the
      // stream-internal 'end' listener (test-http-connect shape).
      try {
        _removeRequestSocketListeners(this.socket);
      } catch {
        /* already detached */
      }
      this.socket._httpMessage = null;
      this.socket.parser = null;
      // Detached means unmanaged, as in the CONNECT branch: restore
      // autoDestroy for the app-owned socket, or its finish never
      // destroys it and socket 'close' never fires
      // (test-http-upgrade-client, test-http-upgrade-agent).
      this.socket.autoDestroy = true;
      try {
        this.agent?.removeSocket(this.socket, this.socket._agentName);
      } catch {
        /* best effort */
      }
      // An upgrade settles the request like a response does (see the
      // CONNECT branch above): a later destroy() must not report a
      // hangup for it.
      this._responseReceived = true;
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
      // With a non-keep-alive agent the release destroys the socket and
      // removes it from agent.sockets; Node removes it when the socket
      // actually closes, which is after the response's 'end' has been
      // delivered, so defer that case one turn to reproduce the
      // ordering (test-http-keep-alive-close-on-header asserts
      // agent.sockets[name].length === 1 inside its 'end' handler).
      // With a keep-alive agent the release happens AFTER 'end'
      // listeners run (probed on real Node: 'end' handlers still see
      // the socket assigned, nextTick callbacks see it freed — see the
      // branch below). The exception is an UNOBSERVED response (no
      // 'response' listener at all): real Node releases that at
      // completion (probed), so the loop drains. An observed-but-
      // unconsumed response is never released on real Node (probed:
      // still assigned at +500ms); such tests pass because
      // server.close() destroys the connection, not because the agent
      // released it (test-http-agent-uninitialized asserts nothing
      // about counts).
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
        sock._responseConnectionClose = isConnectionClose(streamedMsg.headers);
      }
      if (agent && sock && !(sock instanceof FakeSocket) && !agent.keepAlive) {
        // Non-keep-alive: the release destroys the socket, and Node
        // removes it when the socket actually closes, which is after
        // the response's 'end' has been delivered — so an observed
        // response releases after 'end' listeners run, exactly like
        // keep-alive (test-http-agent-destroyed-socket: 'end' handlers
        // must see destroyed === false and be able to destroy the
        // socket themselves). An unobserved response still releases
        // one turn after completion so the loop drains (the old
        // setTimeout-0 behavior, kept).
        if (streamedMsg._responseObserved) {
          this._releaseAfterEnd(streamedMsg);
        } else {
          const req = this;
          setTimeout(() => req._releaseAgentSocket(), 0);
        }
      } else if (
        agent &&
        sock &&
        !(sock instanceof FakeSocket) &&
        agent.keepAlive
      ) {
        if (!streamedMsg._responseObserved) {
          // Nobody observes this response (no 'response' listener at
          // all): real Node releases at completion, so the loop can
          // drain even though nothing ever reads the message
          // (test-http-server-delete-parser: the client attaches no
          // response handler, yet the process must exit).
          this._releaseAgentSocket();
        } else {
          // Keep-alive: release after 'end' listeners run. An
          // observed-but-unconsumed response is never released on real
          // Node (probed) — the process still exits because
          // server.close() destroys the connection
          // (test-http-agent-uninitialized). See _releaseAfterEnd.
          this._releaseAfterEnd(streamedMsg);
        }
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
      this.socket._responseConnectionClose = isConnectionClose(msg.headers);
    }
    // Release the socket to the agent. For a non-keep-alive agent with
    // an observed response, release after 'end' listeners run (see the
    // streamed path): the listeners attach AFTER 'response' is emitted
    // below, so user 'end' handlers attached in the response callback
    // precede them in emission order. Every other case releases here,
    // as before (keep-alive parks immediately; unobserved responses
    // must not stall the loop).
    const bufferedAgent = this.agent;
    const bufferedSock = this.socket;
    const bufferedObserved = this.listenerCount("response") > 0;
    if (!(
      bufferedAgent &&
      bufferedSock &&
      !(bufferedSock instanceof FakeSocket) &&
      !bufferedAgent.keepAlive &&
      bufferedObserved
    )) {
      this._releaseAgentSocket();
    }
    // Same response-timeout attach as the headers path above (this
    // branch runs when headers never arrived via onHeaders).
    this._attachResponseTimeout(msg);
    this._responseReceived = true;
    this._inFlightMessage = msg;
    this.emit("response", msg);
    if (
      bufferedAgent &&
      bufferedSock &&
      !(bufferedSock instanceof FakeSocket) &&
      !bufferedAgent.keepAlive &&
      bufferedObserved
    ) {
      this._releaseAfterEnd(msg);
    }
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
  pipeRegistry: new Map(),
  waitPromise: null,
  waitResolve: null,
};
function _httpShared() {
  if (RT) {
    if (!RT.__httpSharedState) {
      RT.__httpSharedState = {
        registry: new Map(),
        pipeRegistry: new Map(),
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

// Pipe (unix-socket) servers live in a separate registry keyed by path:
// the port registry cannot hold them (a socketPath request carries the
// default port 80), and listen(path) needs the same EADDRINUSE guard
// the port registry gives TCP servers.
function _registerPipeServer(path, server) {
  _httpShared().pipeRegistry.set(path, server);
}

function _unregisterPipeServer(path) {
  _httpShared().pipeRegistry.delete(path);
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
  // Streaming heads (pre-serialized at first write) carry no body yet:
  // body bytes follow via the writer, so the empty-body rule below must
  // not fire for them — a streaming POST is chunked, not zero-length.
  bodyFollows = false,
  // Implicit Content-Length: 0 is a default header: it is added only
  // when default headers are enabled (ClientRequest stashes the option
  // as _setDefaultHeaders).
  setDefaultHeaders = true,
  // Chunked-request terminator (bare "0\r\n\r\n", or with request
  // trailers when the caller renders them via _chunkTerminator).
  chunkedTerminator = "0\r\n\r\n",
) {
  const lines = [`${method} ${path} HTTP/1.1`];
  let hasHost = false;
  let hasContentLength = false;
  let hasTransferEncoding = false;
  let transferEncodingValue = "";
  let hasConnection = false;
  const push = (name, value) => lines.push(`${name}: ${value}`);
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (lower === "host") hasHost = true;
    else if (lower === "content-length") hasContentLength = true;
    else if (lower === "transfer-encoding") {
      hasTransferEncoding = true;
      transferEncodingValue = Array.isArray(value)
        ? value.join(", ")
        : String(value);
    } else if (lower === "connection") hasConnection = true;
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
  if (!hasContentLength && !hasTransferEncoding) {
    if (bodyBuf && bodyBuf.length > 0) {
      push("Content-Length", String(bodyBuf.length));
    } else if (
      !bodyFollows &&
      setDefaultHeaders &&
      (method === "POST" || method === "PUT" || method === "PATCH")
    ) {
      // Probed real Node v24.22.1: POST/PUT/PATCH with an empty body
      // send `Content-Length: 0`; GET/HEAD/DELETE/OPTIONS send no
      // length header at all. Previously the serializer added a length
      // only for non-empty bodies, so an empty POST reached the server
      // with no length header and the server-side assertion failed
      // (test-http-content-length, /empty case).
      push("Content-Length", "0");
    }
  }
  if (!hasConnection) push("Connection", "close");
  lines.push("", "");
  const head = Buffer.from(lines.join("\r\n"));
  // Chunked request framing (test-http-raw-headers): a BUFFERED request
  // carrying Transfer-Encoding: chunked must frame its body — previously
  // the body was appended raw, so the server's chunked parser waited
  // forever and req 'end' never fired. Streaming heads (bodyFollows)
  // are excluded: their terminator is written by the streaming end
  // path (_chunkTerminator), and appending one here would end the
  // request before its body frames arrive (desync + socket destroy).
  // The terminator (with request trailers, when the caller renders them
  // via _chunkTerminator) rides along; an empty chunked body still sends
  // the terminator alone. Non-chunked TE keeps the raw append.
  if (
    !bodyFollows &&
    hasTransferEncoding &&
    /\bchunked\b/i.test(transferEncodingValue)
  ) {
    if (bodyBuf && bodyBuf.length > 0) {
      return Buffer.concat([
        head,
        Buffer.from(`${bodyBuf.length.toString(16)}\r\n`, "latin1"),
        bodyBuf,
        Buffer.from(`\r\n${chunkedTerminator}`, "latin1"),
      ]);
    }
    return Buffer.concat([head, Buffer.from(chunkedTerminator, "latin1")]);
  }
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
    // 1xx interim routing: the caller (ClientRequest) delivers these as
    // 'continue'/'information' instead of the final 'response'.
    onInformation,
    streaming,
    headBytes,
    onStreamReady,
    noDefaultHost = false,
    insecureHTTPParser = false,
    // test-http-parser-memory-retention: the caller may supply the
    // request's already-exposed parser (created in onSocket); the
    // runtime-bridge caller omits it and gets a fresh one.
    parser: providedParser = null,
    // Threaded from ClientRequest._setDefaultHeaders by the virtual
    // path: implicit Content-Length: 0 is a default header. Other
    // callers (emulated inbound requests) keep the default true.
    setDefaultHeaders = true,
    // Rendered chunked-request terminator from the caller (includes
    // request trailers when set via addTrailers); default is bare.
    chunkedTerminator = "0\r\n\r\n",
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
    // A failed round trip also drops the request's 'end' observer from
    // the socket before the rejection propagates: real Node shows
    // exactly one 'end' listener (the stream-internal
    // onReadableStreamEnd) on the socket inside a request 'error'
    // handler, while the assignment-time observer would make two
    // (test-http-client-parse-error asserts end==1; the observer stays
    // attached at assignment for test-http-agent-keepalive's end==2).
    const fail = (err) => {
      if (sock._requestEndListener) {
        try {
          sock.removeListener("end", sock._requestEndListener);
        } catch {
          /* already detached */
        }
        sock._requestEndListener = null;
      }
      settle(reject)(err);
    };

    const parser =
      providedParser || new HTTPParser("response", { insecureHTTPParser });
    // HEAD responses never have a body, regardless of framing.
    parser.isHeadResponse = method === "HEAD";
    const chunks = [];
    let info = null;
    // Deferred completion (see onMessageComplete): set when a message
    // completes, consumed by onData/onSockClose after the current
    // execute()/end() returns, so a trailing parse error in the same
    // chunk wins over the response.
    let pendingResult = null;
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
      // 1xx interim (except 101 upgrade, handled above): delivered to the
      // caller as information, never as the final response — the round
      // trip stays open for the real response (test-http-information-*).
      // A caller without onInformation keeps the old shape (1xx as
      // 'response') rather than hanging.
      if (
        info.statusCode >= 100 &&
        info.statusCode <= 199 &&
        info.statusCode !== 101 &&
        typeof onInformation === "function"
      ) {
        try {
          onInformation(info);
        } catch {
          /* listener errors are not fatal */
        }
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
      // Deferred, first-wins: the caller settles only after execute()
      // returns (see onData), so a parse error in trailing bytes after
      // a complete response (e.g. "hi world" after a CL:0 302) still
      // surfaces as a request 'error' instead of being swallowed by an
      // already-settled promise (test-http-client-parse-error: real
      // Node emits BOTH 'response' and 'error' there; the shim delivers
      // the error, which is what the test counts). A second complete
      // message in the same chunk never overwrites the first — only a
      // later error overrides, via fail() above.
      // Interim messages complete without settling the round trip: the
      // deferred result must describe the FINAL response, not a 1xx.
      if (
        info.statusCode >= 100 &&
        info.statusCode <= 199 &&
        info.statusCode !== 101
      ) {
        return;
      }
      if (!pendingResult) {
        pendingResult = {
          statusCode: info.statusCode,
          statusMessage: info.statusMessage,
          rawHeaders: info.rawHeaders.slice(),
          body: Buffer.concat(chunks),
          rawTrailers: parser.rawTrailers ? parser.rawTrailers.slice() : [],
        };
      }
    };
    parser.onError = (err) => {
      // Node's client socket-error shape (probed v24.22.1, mirrored from
      // the server-side clientError normalization): message "Parse
      // Error: <llhttp reason>", code, bytesParsed, rawPacket, reason
      // (the llhttp reason verbatim — test-http-client-error-rawbytes
      // asserts it; the parser sets it, this only repairs the
      // INVALID_METHOD special case and the bare-"Parse Error" EOF
      // shape). HPE_TRUNCATED keeps today's shape: real Node reports
      // a truncated response as response 'aborted' + ECONNRESET, not
      // a parse error, and that divergence is separate work (no test
      // hinges on it).
      if (err.code !== "HPE_TRUNCATED") {
        if (err.code === "HPE_INVALID_METHOD") {
          err.message = "Parse Error: Invalid method encountered";
          err.reason = "Invalid method encountered";
        } else {
          if (err.reason === undefined) {
            err.reason = err.message.startsWith("Parse Error: ")
              ? err.message.slice("Parse Error: ".length)
              : err.message;
          }
          if (
            typeof err.message === "string" &&
            err.message !== "Parse Error" &&
            !err.message.startsWith("Parse Error:")
          ) {
            err.message = `Parse Error: ${err.message}`;
          }
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
            _serializeRequestHead(
              method,
              path,
              headers,
              body,
              noDefaultHost,
              false,
              setDefaultHeaders,
              chunkedTerminator,
            ),
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
      // Deferred completion: only now, with the whole chunk consumed,
      // does a completed response settle — a parse error above already
      // settled via fail(), so an error after a complete message in
      // the same chunk correctly wins over the response.
      if (pendingResult && !settled) {
        const result = pendingResult;
        pendingResult = null;
        ok(result);
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
      // EOF-framed completion via parser.end() records a pending result
      // instead of settling immediately (see onMessageComplete); settle
      // it here before the truncated-response branch below.
      if (pendingResult && !settled) {
        const result = pendingResult;
        pendingResult = null;
        ok(result);
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

// Server timeout option validation (probed real Node v24.22.1):
// headersTimeout / requestTimeout / keepAliveTimeout must be integers
// in [0, 2^53 - 1] when given (null is a type error, not "missing"),
// and headersTimeout must be <= requestTimeout unless requestTimeout
// is 0 (disabled). No official test covers the error shapes beyond
// the code, but the values are asserted exactly.
const _validateServerTimeout = (name, value) => {
  if (value === undefined) return;
  if (typeof value !== "number") {
    throw ERR_INVALID_ARG_TYPE_ARGUMENT(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw ERR_OUT_OF_RANGE(name, ">= 0 && <= 9007199254740991", value);
  }
};

// Bridge key for the connections-checker interval object that
// test-http-server-{async-dispose,clear-timer,close-destroy-timeout}
// read via require("_http_server").kConnectionsCheckingInterval.
// Real Node (probed v24.22.1): the slot is undefined at construction;
// each 'listening' emit destroys the previous interval object and
// creates a NEW one (a Timeout with _destroyed=false); close()
// destroys the current one (same object identity afterwards).
// Product code cannot import Node internals, so the shim exposes the
// slot under this Symbol.for key, and parity/http-server-adapter.mjs
// exports the identical key — the global registry is the sharing
// mechanism (same precedent as src/net.js kTimeout /
// internal-timers-adapter).
// ponytail: the bridged value is a plain {_destroyed} object, not a
// real Timeout — no suite test asserts timer identity or firing, only
// _destroyed; the shim's real checker timer (_checkTimer, started
// lazily on first connection) stays separate. Ceiling: if a test ever
// asserts the object IS a Timeout, this bridge needs a real timer
// behind it.
const kConnectionsCheckingInterval = Symbol.for(
  "bundleVFSModules.http.kConnectionsCheckingInterval",
);

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
    // Internal 'listening' listener, registered at construction so it
    // runs before any user listener on every emit — including manual
    // server.emit("listening") (test-http-server-clear-timer emits it
    // twice by hand). Each emit destroys the previous bridged interval
    // object and creates a new one; close() destroys the current one.
    // _stopConnectionChecker must NOT touch this slot: it only clears
    // the shim's real _checkTimer, and a connection draining to zero
    // while listening must not destroy the bridged object.
    this.on("listening", () => {
      const prev = this[kConnectionsCheckingInterval];
      if (prev) prev._destroyed = true;
      this[kConnectionsCheckingInterval] = { _destroyed: false };
    });

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
    // createServer({ rejectNonStandardBodyWrites }) — probed real Node
    // v24.22.1: only the literal `true` enables it (truthy 1 does not
    // throw); default/false silently drops body writes to 204/304/1xx
    // and HEAD responses. Forwarded to each ServerResponse at dispatch;
    // when true, write()/end(body) throw ERR_HTTP_BODY_NOT_ALLOWED
    // instead of dropping (test-http-head-throw-on-response-body-write).
    this._rejectNonStandardBodyWrites =
      options.rejectNonStandardBodyWrites === true;
    // createServer({ uniqueHeaders }) — same send-side-only semantics as
    // the request option (probed real Node v24.22.1); forwarded to each
    // ServerResponse at dispatch. Affects response headers (via
    // _storeHeader) and response trailers (via _chunkTerminator).
    this._serverUniqueHeaders = Array.isArray(options.uniqueHeaders)
      ? new Set(options.uniqueHeaders.map((n) => String(n).toLowerCase()))
      : null;
    // httpValidation: 'strict' | 'relaxed' | 'insecure' (probed
    // v24.22.1, same rules as the client option): unknown values throw
    // ERR_INVALID_ARG_VALUE, and setting it together with
    // insecureHTTPParser — even false — throws ERR_INVALID_ARG_VALUE.
    // 'relaxed' enables only header-value leniency; 'insecure' enables
    // the full lenient set. insecureHTTPParser: true alone is the same
    // full set (server-side alias; the server parser previously got no
    // leniency flags at all). Forwarded to each ServerResponse (for
    // setHeader/writeHead validation) and to the per-connection parser
    // (for inbound values + duplicate Transfer-Encoding).
    if (
      options.httpValidation !== undefined &&
      !["strict", "relaxed", "insecure"].includes(options.httpValidation)
    ) {
      throw ERR_INVALID_ARG_VALUE(
        "options.httpValidation",
        options.httpValidation,
        "must be one of: 'strict', 'relaxed', 'insecure'.",
      );
    }
    if (
      options.httpValidation !== undefined &&
      options.insecureHTTPParser !== undefined
    ) {
      throw ERR_INVALID_ARG_VALUE(
        "options.httpValidation",
        options.httpValidation,
        "cannot be used together with options.insecureHTTPParser.",
      );
    }
    this._lenientHeaderValidation =
      options.httpValidation === "relaxed" ||
      options.httpValidation === "insecure" ||
      options.insecureHTTPParser === true ||
      (options.httpValidation === undefined &&
        options.insecureHTTPParser === undefined &&
        _insecureHttpParserFlag());
    this._insecureParser =
      options.httpValidation === "insecure" ||
      options.insecureHTTPParser === true ||
      (options.httpValidation === undefined &&
        options.insecureHTTPParser === undefined &&
        _insecureHttpParserFlag());
    this.timeout = 0;
    // Timeout defaulting (probed v24.22.1): requestTimeout defaults to
    // 300000, and headersTimeout defaults to min(requestTimeout, 60000)
    // — so { requestTimeout: 20000 } reads headersTimeout 20000, while
    // { requestTimeout: 100000 } keeps the 60000 ceiling.
    _validateServerTimeout("headersTimeout", options.headersTimeout);
    _validateServerTimeout("requestTimeout", options.requestTimeout);
    _validateServerTimeout("keepAliveTimeout", options.keepAliveTimeout);
    this.requestTimeout = options.requestTimeout ?? 300000;
    this.headersTimeout =
      options.headersTimeout ?? Math.min(this.requestTimeout, 60000);
    this.keepAliveTimeout = options.keepAliveTimeout ?? 5000;
    if (
      this.requestTimeout !== 0 &&
      this.headersTimeout > this.requestTimeout
    ) {
      throw ERR_OUT_OF_RANGE(
        "headersTimeout",
        "<= requestTimeout",
        this.headersTimeout,
      );
    }
    // optimizeEmptyRequests (probed v24.22.1): with the option, a
    // request carrying neither Content-Length nor Transfer-Encoding is
    // delivered already dumped (see dispatch).
    this._optimizeEmptyRequests = options.optimizeEmptyRequests === true;
    // Async request-listener rejections are captured only when the
    // EventEmitter capture default was on at construction (probed
    // v24.22.1: the global events.captureRejections at createServer
    // time decides; a later global flip or an own property does not).
    // The static reads in both builds: native events under the harness,
    // the shim's mirrored static in the browser build.
    this._captureRejections = EventEmitter.captureRejections === true;
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
    // Unix-socket listen target (server.listen(path)); null for TCP.
    this._pipePath = null;
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
    // Unix-socket target: a non-numeric string, or { path }.
    let pipePath = null;

    if (
      typeof portOrOptions === "number" ||
      typeof portOrOptions === "string"
    ) {
      port = Number(portOrOptions);
      if (Number.isNaN(port)) pipePath = portOrOptions;
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
      if (typeof portOrOptions.path === "string") pipePath = portOrOptions.path;
      cb = typeof hostOrCallback === "function" ? hostOrCallback : callback;
    } else if (typeof portOrOptions === "function") {
      cb = portOrOptions;
    } else if (portOrOptions == null && typeof hostOrCallback === "function") {
      cb = hostOrCallback;
    }

    // Unix-socket listen: bind the backing net server to the pipe
    // instead of a TCP port (real Node: server.listen(path) /
    // listen({ path })). Previously Number(path) was NaN, so the
    // ephemeral branch below bound a random TCP port and the pipe was
    // never listened on at all.
    if (pipePath) {
      if (_httpShared().pipeRegistry.has(pipePath)) {
        const err = makeError(
          "EADDRINUSE",
          `listen EADDRINUSE: address already in use ${pipePath}`,
        );
        err.path = pipePath;
        queueMicrotask(() => this.emit("error", err));
        return this;
      }
    } else {
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
    }

    if (pipePath) {
      this._pipePath = pipePath;
      _registerPipeServer(pipePath, this);
    } else {
      this._port = port;
      this._host = host || "::";
      _registerServer(port, this);
    }
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
    if (pipePath) netServer.listen(pipePath);
    else netServer.listen(port, this._host);
    // Apply a sticky unref() issued before this listen() (see _unrefed).
    if (this._unrefed) netServer.unref();
    this.listening = true;
    // emitMe(fn, method, ...args) serializes only ...args — the payload must
    // go in args (3rd position), not method, or the parent sees an empty message.
    emitEvent?.(
      "serverListening",
      null,
      pipePath ? { path: pipePath } : { port },
    );
    queueMicrotask(() => {
      this.emit("listening");
      if (cb) cb.call(this);
    });
    return this;
  }

  close(callback) {
    // Destroy (do not replace) the bridged connections-checker object:
    // tests read server[kConnectionsCheckingInterval]._destroyed after
    // close and expect the SAME object, now destroyed.
    const checker = this[kConnectionsCheckingInterval];
    if (checker) checker._destroyed = true;
    if (typeof callback === "function") {
      // Real Node (http close delegates to net Server.close): a server
      // that is not running calls back with ERR_SERVER_NOT_RUNNING
      // (probed v24.22.1, never-listened and already-closed alike).
      if (!this.listening)
        queueMicrotask(() =>
          callback(
            makeError("ERR_SERVER_NOT_RUNNING", "Server is not running."),
          ),
        );
      else this.once("close", callback);
    }
    if (this._port !== null) {
      const port = this._port;
      this._port = null;
      _unregisterServer(port);
      emitEvent?.("serverClosed", null, { port });
    }
    if (this._pipePath) {
      const pipePath = this._pipePath;
      this._pipePath = null;
      _unregisterPipeServer(pipePath);
      emitEvent?.("serverClosed", null, { path: pipePath });
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

  // test-http-server-async-dispose: Symbol.asyncDispose closes the
  // server and resolves when it is closed (close()'s callback runs on
  // the "close" emit, or via microtask when not listening).
  [Symbol.asyncDispose]() {
    return new Promise((resolve) => {
      this.close(() => resolve());
    });
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
        if (state.idleSince !== null && !state.hasSocketTimeout) {
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
    // Unix-socket servers report the path string (real Node, probed).
    if (this.listening && this._pipePath) return this._pipePath;
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
      dropResponse: null, // a 503 drop response still outstanding; its finish owns the socket close
      // Server timeout accounting (headersTimeout / requestTimeout /
      // keepAliveTimeout, enforced by _checkConnections polling):
      connectedAt: Date.now(),
      fresh: true, // no request has started on this socket yet
      receiving: false, // a request is currently being received
      requestStart: 0, // first byte of the current request
      headersDone: false, // current request's headers are complete
      idleSince: null, // set when a response finishes and the socket idles
      hasSocketTimeout: false, // server.setTimeout applied at connect (below)
      idleTimer: null, // prompt keepAliveTimeout close (see _finishSocketResponse)
      upgraded: false, // connection upgraded; HTTP timeouts no longer apply
      connect: false, // CONNECT tunnel; no response pending, peer FIN ends it
      timedOut: false, // a 408 was already sent on this socket
      parserFreed: false, // socket.parser.free() called (exactly once)
    };
    socket._httpState = state;
    // Real Node installs setEncoding as an OWN property on HTTP server
    // sockets that throws for any argument (probed v24.22.1: own property
    // on http server sockets, absent on plain net server sockets, where
    // setEncoding works normally). Mirrors that exactly: an own thrower
    // here, so net sockets and client sockets keep Readable's setEncoding.
    socket.setEncoding = () => {
      throw ERR_HTTP_SOCKET_ENCODING();
    };
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
      // Function while the connection lives; nulled at close, after
      // free() (test-http-parser-memory-retention).
      [HTTP_PARSER_K_ON_TIMEOUT]: () => {},
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
        // The stashed response's request never gets 'aborted' from the
        // state.current branch above: for a bodyless request (GET) the
        // body already completed at dispatch, so current was cleared
        // at onMessageComplete while the response was still running
        // (test-http-client-abort: server-side req 'aborted' N=8).
        // Real Node's IncomingMessage._destroy emits 'aborted' when
        // the socket closes mid-response; the guard keeps a request
        // that already got it (via current) from double-firing.
        const stashedReq = stashed.req;
        if (stashedReq && !stashedReq.aborted) {
          stashedReq.aborted = true;
          stashedReq.emit("aborted");
        }
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
        // Null the callback slot on the facade object itself (not just
        // socket.parser): the test reads the CAPTURED facade on close.
        facade[HTTP_PARSER_K_ON_TIMEOUT] = null;
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
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
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
      // A server socket timeout owns idle sockets (probed v24.22.1:
      // keepAliveTimeout=50 + setTimeout(500) fires 'timeout' at 500ms,
      // no destroy at 50ms) — so the keepAlive destroy paths below
      // (prompt timer + checker backstop) must not fire for it.
      state.hasSocketTimeout = true;
    }
    const onHttpTimeout = () => {
      this.emit("timeout", socket);
      const cur = state.current;
      if (cur) cur.req.emit("timeout");
    };
    socket.on("timeout", onHttpTimeout);

    const parser = new HTTPParser("request", {
      insecureHTTPParser: this._insecureParser,
      lenientHeaderValue: this._lenientHeaderValidation,
    });
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
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = null;
      }
    };
    parser.onHeadersComplete = (info) => {
      state.busy = true;
      state.headersDone = true;
      state.awaitingBody = info.hasBody;
      const created = this._dispatchSocketRequest(socket, info, state);
      state.current = created;
      // Body callbacks are wired inside dispatch (before emit) now, so
      // a reentrant body pulled by an interim reply is not lost; the
      // 100-continue auto-ack stays gated on no checkContinue listener
      // (a listener owns the reply via writeContinue instead).
      if (
        typeof info.headers.expect === "string" &&
        info.headers.expect.toLowerCase() === "100-continue" &&
        info.httpVersionMajor === 1 &&
        info.httpVersionMinor === 1 &&
        this.listenerCount("checkContinue") === 0
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
      // bytesParsed, rawPacket, reason (the llhttp reason verbatim).
      // Only the method reason is asserted exactly by official tests;
      // other codes keep the parser's message behind the same prefix.
      // The parser sets reason; this only repairs the INVALID_METHOD
      // special case and leaves the bare-"Parse Error" EOF shape
      // (empty reason) unprefixed.
      // EOF mid-message on the server side: real Node reports
      // HPE_INVALID_EOF_STATE with a bare "Parse Error" message and an
      // empty reason (probed v24.22.1; test-http-parser-finish-error).
      // HPE_TRUNCATED is emitted only by parser.end(), so this mapping
      // is unambiguous; the client round trip keeps the truncation
      // shape, and the parser-level code stays HPE_TRUNCATED (repo
      // suite tests/http-socket.test.js asserts it).
      if (err.code === "HPE_TRUNCATED") {
        err.code = "HPE_INVALID_EOF_STATE";
        err.message = "Parse Error";
        err.reason = "";
      }
      if (err.code === "HPE_INVALID_METHOD") {
        err.message = "Parse Error: Invalid method encountered";
        err.reason = "Invalid method encountered";
      } else {
        if (err.reason === undefined) {
          err.reason = err.message.startsWith("Parse Error: ")
            ? err.message.slice("Parse Error: ".length)
            : err.message;
        }
        if (
          err.message !== "Parse Error" &&
          !err.message.startsWith("Parse Error:")
        ) {
          err.message = `Parse Error: ${err.message}`;
        }
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
      // Peer DESTROYED (not half-closed) with a response outstanding:
      // the handler never ends, so _finishSocketResponse never runs
      // and the socket would never close — the server-side request
      // never gets 'aborted' and the process hangs
      // (test-http-client-abort). A destroyed peer is distinguished
      // from a graceful half-close by the nulled peer link: net.js
      // _destroy nulls peer._peer before delivering the EOF, while a
      // graceful FIN keeps the link up (real-Node probe order:
      // client close -> server socket end -> server req 'aborted' ->
      // server socket close). Destroy the socket one microtask later
      // so the app's own 'end' listeners still run first (same
      // deference as the CONNECT branch); onHttpClose then emits
      // 'aborted' on the stashed request. Idle FINs (inFlight === 0)
      // keep the existing path below.
      if (socket._peer === null && state.inFlight > 0 && !socket.destroyed) {
        queueMicrotask(() => {
          if (!socket.destroyed) {
            try {
              socket.destroy();
            } catch {
              /* already closing */
            }
          }
        });
      }
      if (state.inFlight === 0) {
        state.parser.unpause();
        // A peer FIN with a partial message buffered must surface as
        // clientError, not vanish with the socket: end() fires onError
        // for a mid-message EOF (mapped to HPE_INVALID_EOF_STATE
        // above); a clean EOF between messages is a no-op here. The
        // close below is guarded: if the handler destroys the socket,
        // ending it again is a no-op, and a throwing handler must not
        // skip the close decision. (test-http-parser-finish-error.)
        try {
          state.parser.end();
        } catch {
          /* onError owns parse failures; the close below still runs */
        }
        if (state.inFlight === 0 && !state.busy && !socket.destroyed) {
          socket.end();
        }
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

    // Body callbacks are wired BEFORE any emit below: a handler may
    // synchronously emit interim bytes (writeContinue) whose client
    // reply (the request body) arrives reentrantly through synchronous
    // virtual delivery — wiring after dispatch (the old shape, in the
    // outer onHeadersComplete) drops that body and never fires req
    // 'end' (test-http-expect-continue). Non-reentrant behavior is
    // unchanged: these are the same closures, just bound earlier.
    state.parser.onBody = (chunk) => req._pushBody(chunk);
    state.parser.onMessageComplete = () => {
      state.awaitingBody = false;
      state.receiving = false;
      // Trailers arrive with the chunked terminator, after dispatch:
      // fold them into the request before 'end' fires, so handlers
      // asserting req.rawTrailers / req.trailers in 'end' see them
      // (test-http-multiple-headers). parser.rawTrailers resets per
      // message (_resetMessage), so no cross-request leak.
      if (state.parser.rawTrailers && state.parser.rawTrailers.length > 0) {
        IncomingMessage._applyRawTrailers(req, state.parser.rawTrailers);
      }
      req._finishBody();
      state.current = null;
    };

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
        // Async delivery window for the upgrade handoff only: a
        // synchronous push would let the peer's 'data' handler run
        // inside the handler's socket.write(), before the handler's
        // next statement — so an upgrade handler that writes 101 and
        // then records the upgrade head hands the client a null head
        // (test-http-upgrade-server). The flag is cleared in a
        // finally so a throwing handler (test-http-upgrade-server2)
        // cannot leave later writes on this socket async.
        const prevUpgradeDispatch = socket._upgradeDispatch;
        socket._upgradeDispatch = true;
        try {
          this.emit("upgrade", req, socket, head);
        } finally {
          socket._upgradeDispatch = prevUpgradeDispatch;
        }
        return { req, res: null };
      }
      // Fall through to normal 'request' dispatch below (callback false,
      // or no callback and no 'upgrade' listener).
    }

    // maxRequestsPerSocket drop (test-http-keep-alive-drop-requests):
    // once the served count on this socket reaches the limit, further
    // requests are NOT dispatched to 'request' listeners. Real Node
    // (probed v24.22.1) emits 'dropRequest' with (req, socket) and
    // answers 503 Service Unavailable with Connection: close, then
    // closes the socket. Placed after the CONNECT/upgrade early-returns
    // so those paths are untouched; only normal 'request' dispatches
    // are subject to dropping. A null/undefined/0 limit means unlimited
    // (test-http-server-keep-alive-max-requests-null).
    const maxReq = this.maxRequestsPerSocket;
    if (typeof maxReq === "number" && maxReq > 0 && state.reqCount >= maxReq) {
      this.emit("dropRequest", req, socket);
      // Answer through the normal finish machinery (not a direct socket
      // write) so byte order holds: earlier pipelined responses serialize
      // first via finish FIFO. A bare 503 with implicit headers frames
      // exactly like real Node: Date, Connection: close, chunked, empty
      // body ("0\r\n\r\n"). The dropped request does not increment the
      // served count, and its finish owns the socket close (see the
      // dropResponse guard in _finishSocketResponse).
      const prevRes = state.lastResponse;
      const dropRes = new ServerResponse(req, {
        highWaterMark: this._highWaterMark,
        rejectNonStandardBodyWrites: this._rejectNonStandardBodyWrites,
        lenientHeaderValidation: this._lenientHeaderValidation,
      });
      const dropPrevUnfinished =
        state.lastResponse && !state.lastResponse.finished;
      if (dropPrevUnfinished) {
        dropRes.socket = null;
        dropRes.connection = null;
      }
      const dropSockHwm = socket?.writableHighWaterMark;
      if (typeof dropSockHwm === "number" && dropRes._writableState) {
        dropRes._writableState.highWaterMark = dropSockHwm;
      }
      state.lastResponse = dropRes;
      const dropReqNo = state.reqCount;
      dropRes.shouldKeepAlive = false;
      dropRes._serverKeepAliveTimeout = this.keepAliveTimeout;
      dropRes._serverMaxRequestsPerSocket = this.maxRequestsPerSocket;
      dropRes._serverReqNo = dropReqNo;
      dropRes[kUniqueHeaders] = this._serverUniqueHeaders;
      dropRes._reqHadTE = /chunked/i.test(
        String(req.headers?.te || req.headers?.TE || ""),
      );
      dropRes.on("finish", () => {
        this._finishSocketResponse(
          socket,
          info,
          state,
          req,
          dropRes,
          dropReqNo,
        );
      });
      state.inFlight++;
      state.dropResponse = dropRes;
      // Explicit writeHead (not a bare end()): the finish framing rules
      // send an explicit-headers response with no length framing as
      // chunked, which is exactly real Node's drop shape — Date,
      // Connection: close, Transfer-Encoding: chunked, empty body. A
      // bare end() would instead take the implicit-headers branch and
      // frame Content-Length: 0.
      dropRes.writeHead(503);
      // Do not end the drop response while the previous pipelined
      // response's stream finish is still pending: a zero-body finish
      // fires on nextTick and would jump ahead of the previous
      // response's microtask-delayed write callback, so the earlier
      // response's bytes would be lost to the socket close. Waiting on
      // the previous finish keeps byte order (earlier response, then
      // 503) — the server's finish listener runs first (attached at
      // dispatch), then this one ends the drop. When the previous
      // response is already finished or destroyed, end immediately.
      if (prevRes && !prevRes.writableFinished && !prevRes.destroyed) {
        prevRes.once("finish", () => dropRes.end());
      } else {
        dropRes.end();
      }
      if (!info.hasBody) req._finishBody();
      return { req, res: dropRes };
    }

    // Expect routing (test-http-expect-continue, test-http-expect-handling,
    // probed real Node v24.22.1): 'Expect: 100-continue' with a
    // checkContinue listener dispatches to 'checkContinue' (never
    // 'request'); any other Expect value with a checkExpectation
    // listener dispatches to 'checkExpectation'; any other Expect value
    // with NEITHER listener is answered 417 Expectation Failed with
    // Connection: close through the normal finish machinery (mirroring
    // the drop branch above), and 'request' never fires. With no
    // Expect header, or 100-continue with no listener, dispatch is the
    // normal 'request' (the auto-ack in onHeadersComplete covers the
    // no-listener 100 case).
    let dispatchEvent = "request";
    let expect417 = false;
    const expectVal = req.headers.expect;
    if (expectVal !== undefined) {
      if (String(expectVal).toLowerCase() === "100-continue") {
        if (this.listenerCount("checkContinue") > 0) {
          dispatchEvent = "checkContinue";
        }
      } else if (this.listenerCount("checkExpectation") > 0) {
        dispatchEvent = "checkExpectation";
      } else {
        expect417 = true;
      }
    }
    if (expect417) {
      const prevRes417 = state.lastResponse;
      const res417 = new ServerResponse(req, {
        highWaterMark: this._highWaterMark,
        rejectNonStandardBodyWrites: this._rejectNonStandardBodyWrites,
        lenientHeaderValidation: this._lenientHeaderValidation,
      });
      const prevUnfinished417 =
        state.lastResponse && !state.lastResponse.finished;
      if (prevUnfinished417) {
        res417.socket = null;
        res417.connection = null;
      }
      const sockHwm417 = socket?.writableHighWaterMark;
      if (typeof sockHwm417 === "number" && res417._writableState) {
        res417._writableState.highWaterMark = sockHwm417;
      }
      state.lastResponse = res417;
      const reqNo417 = state.reqCount;
      res417.shouldKeepAlive = false;
      res417._serverKeepAliveTimeout = this.keepAliveTimeout;
      res417._serverMaxRequestsPerSocket = this.maxRequestsPerSocket;
      res417._serverReqNo = reqNo417;
      res417[kUniqueHeaders] = this._serverUniqueHeaders;
      res417._reqHadTE = /chunked/i.test(
        String(req.headers?.te || req.headers?.TE || ""),
      );
      res417.on("finish", () => {
        this._finishSocketResponse(socket, info, state, req, res417, reqNo417);
      });
      state.inFlight++;
      res417.writeHead(417);
      if (prevRes417 && !prevRes417.writableFinished && !prevRes417.destroyed) {
        prevRes417.once("finish", () => res417.end());
      } else {
        res417.end();
      }
      if (!info.hasBody) req._finishBody();
      return { req, res: res417 };
    }

    const res = new ServerResponse(req, {
      highWaterMark: this._highWaterMark,
      rejectNonStandardBodyWrites: this._rejectNonStandardBodyWrites,
      lenientHeaderValidation: this._lenientHeaderValidation,
    });
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

    // optimizeEmptyRequests (probed v24.22.1): header presence — not
    // method or value — decides. A request with neither Content-Length
    // nor Transfer-Encoding arrives already dumped: _dumped,
    // readableEnded and destroyed all read true at listener time, and
    // no 'data'/'end' ever fires for it (complete short-circuits
    // _finishBody below and at message completion). POST with
    // Content-Length: 0 and HEAD with Content-Length stay unoptimized.
    if (
      this._optimizeEmptyRequests &&
      req.headers["content-length"] === undefined &&
      req.headers["transfer-encoding"] === undefined
    ) {
      req._dumped = true;
      req.complete = true;
      if (req._readableState) {
        req._readableState.ended = true;
        req._readableState.endEmitted = true;
        req._readableState.destroyed = true;
      }
    }

    // test-http-server-keepalive-end: the socket parser facade tracks
    // the in-flight request. incoming reads req from dispatch until the
    // tick after req 'end' (probed v24.22.1). The once('end') hook is
    // registered before emit so it runs ahead of user 'end' handlers
    // (registration order): user handlers still see incoming === req,
    // and the queued nextTick nulls it before any nextTick a user
    // handler schedules. The identity check keeps a pipelined successor
    // from being nulled by its predecessor's hook. nextTick via
    // globalThis.process (real under the harness); queueMicrotask
    // fallback would run after user nextTicks, so it is only a
    // no-crash fallback for builds without a process shim.
    if (socket.parser) socket.parser.incoming = req;
    req.once("end", () => {
      // Capture the facade object, not the live socket.parser slot:
      // onHttpClose nulls the slot at socket close, but a test holding
      // the facade (keepalive-end captures it inside 'end') must still
      // see incoming nulled on the next tick even if the close landed
      // between 'end' and this tick.
      const facade = socket.parser;
      const run = () => {
        if (facade && facade.incoming === req) {
          facade.incoming = null;
        }
      };
      if (typeof globalThis.process?.nextTick === "function") {
        globalThis.process.nextTick(run);
      } else {
        queueMicrotask(run);
      }
    });

    // Dispatch synchronously, like Node's parserOnIncoming: the handler
    // must attach its req listeners before the parser feeds the body and
    // before a peer FIN queued behind this chunk is processed. Deferring
    // to a microtask loses both races — body EOF fires before the handler
    // attaches, and the socket's EOF handling (nextTick-ordered) runs
    // before the microtask, closing the socket under the pending response.
    // (test-http-chunk-extensions-limit)
    try {
      // captureRejections covers 'request' only; checkContinue /
      // checkExpectation dispatch through a plain emit (a sync throw
      // still lands in clientError below, as before).
      if (dispatchEvent === "request" && this._captureRejections) {
        this._emitRequestCaptured(req, res);
      } else {
        this.emit(dispatchEvent, req, res);
      }
    } catch (err) {
      this.emit("clientError", err, socket);
      socket.destroy(err);
    }
    // No body finish here: completion belongs to the parser. A no-body
    // request is finished by _finishMessage -> onMessageComplete (wired
    // above) immediately after _finishHeaders returns from
    // onHeadersComplete — same tick, same 'end' delivery. Finishing
    // here would pre-empt the parser's post-dispatch validation: a
    // request whose Transfer-Encoding fails llhttp's
    // after_headers_complete check ("Request has invalid
    // `Transfer-Encoding`") is dispatched and THEN errored, and must
    // never see req 'end' (test-http-transfer-encoding-
    // repeated-chunked). The dispatch-time finish predates the
    // onMessageComplete wiring (#99) and is redundant with it.
    return { req, res };
  }

  // Async request-listener rejections under captureRejections (probed
  // v24.22.1): listeners are invoked directly, not via emit, so the
  // native capture path cannot also emit 'error' on the server (real
  // Node sends the 500 / destroys without any server 'error' event).
  // rawListeners preserves once-wrapper semantics; a sync throw still
  // propagates to the dispatch catch (clientError + socket destroy).
  _emitRequestCaptured(req, res) {
    const listeners =
      typeof this.rawListeners === "function"
        ? this.rawListeners("request")
        : this.listeners("request");
    for (const fn of listeners) {
      const ret = fn.call(this, req, res);
      if (ret && typeof ret.catch === "function") {
        ret.catch((err) => this._onRequestListenerRejection(req, res, err));
      }
    }
  }

  // Rejection outcome (probed v24.22.1): a rejection after the response
  // already finished is ignored (the client already got a clean 200);
  // before headers are sent it becomes a clean 500 ("Internal Server
  // Error", user headers dropped — only Date/Connection/Keep-Alive/
  // Content-Length go out); after headers are sent the response is
  // destroyed with the error (the client sees res 'aborted' +
  // ECONNRESET once body bytes were delivered, or bare ECONNRESET on
  // the request when nothing was delivered yet).
  _onRequestListenerRejection(req, res, err) {
    if (!res || res.finished || res.destroyed) return;
    if (!res.headersSent) {
      res[kOutHeaders] = null;
      res._renderedHeaders = null;
      try {
        res.writeHead(500);
        res.end("Internal Server Error");
      } catch {
        /* handler already tore the response down */
      }
      return;
    }
    try {
      res.destroy(err);
    } catch {
      /* best effort */
    }
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
    // test-http-server-keepalive-end: real Node drains an unconsumed
    // request body when its response finishes, so req 'end' fires even
    // with only an 'end' listener (probed v24.22.1: 'end' fires with
    // res.end, never without it — writes alone do not dump). Resuming
    // here flows buffered body + EOF through the stream machinery;
    // this also covers the already-complete-but-never-ended case
    // (body arrived before finish, stream never consumed), which a
    // complete-only guard would miss. A destroyed or already-ended
    // (or already-dumped: readableEnded) request skips this.
    if (req && !req.destroyed && !req.readableEnded) {
      try {
        req.resume();
      } catch {
        /* best effort */
      }
    }
    // Streaming case: headers + body were already flushed via write().
    // Just terminate the chunked stream (if used) and handle keep-alive.
    // ponytail: non-chunked streaming responses need their pended frame
    // flushed here too, not just chunked ones. #279 pends streaming
    // frames for a microtask flush, but for a close-delimited (e.g.
    // HTTP/1.0) response the finish path closes the socket before that
    // microtask runs, so the frame was dropped and the client got EOF
    // with zero bytes (test-http-1.0, regressed by #279). Flushing at
    // _deliver time — after end() returns, before the keep-alive/close
    // decision below — restores delivery without the synchronous end()
    // flush, which broke incremental readers: flushing inside end()
    // lets a second chunk arrive within the client's first readable
    // callback, so read() never returns the null the test expects
    // (test-http-readable-data-event). The chunked path is untouched.
    // Ceiling: if a future streaming mode needs its pended frame held
    // past _deliver, that mode needs its own flush rule.
    if (res._headerFlushed) {
      if (
        !socket.destroyed &&
        res._chunkedStreaming &&
        !res._chunkTerminatorSent &&
        req.method !== "HEAD"
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
      } else if (!socket.destroyed && !res._chunkedStreaming) {
        try {
          const pending = res._pendingFrame;
          res._pendingFrame = null;
          if (pending) {
            res._framedPending = Math.max(
              0,
              (res._framedPending || 0) - pending.length,
            );
            res._maybeEmitStreamDrain?.();
            socket.write(pending);
          }
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
      // A Trailer header forces chunked framing (probed v24.22.1: Trailer
      // + end(body) with no CL/TE frames chunked, terminator carrying
      // the trailers). addTrailers WITHOUT the header keeps
      // Content-Length and drops the trailers, so only the header
      // triggers this. The header lives in either store (setHeader vs
      // writeHead(obj)), like Content-Length above.
      const hasTrailerHeader =
        res.hasHeader("trailer") || rendered["trailer"] !== undefined;
      // Node frames with Content-Length only when the header block was
      // rendered implicitly by end() itself, so the length is known before
      // anything is committed. An explicit writeHead() commits the headers
      // first; the body that follows is chunked instead.
      // (test-http-chunk-extensions-limit block 3)
      const implicitHeader = res._headersImplicit === true;
      if (
        !hasCL &&
        !hasTE &&
        !noBodyStatus &&
        !isHttp10 &&
        implicitHeader &&
        !hasTrailerHeader
      ) {
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
      if (hasTrailerHeader && !hasCL && !hasTE && !noBodyStatus && !isHttp10) {
        // Trailers need chunked framing: without this, the CL branch
        // above (or the raw fallthrough below) would swallow them
        // (test-http-raw-headers response half). The chunked branch
        // below appends _chunkTerminator, which renders the trailers.
        te = "chunked";
        headOut = headOut.replace(
          /\r\n$/,
          "Transfer-Encoding: chunked\r\n\r\n",
        );
        rendered["transfer-encoding"] = "chunked";
      }
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
        } else if (!noBodyStatus && req.method !== "HEAD") {
          // Send terminator only if a body is allowed. 204/304 (and 1xx)
          // MUST NOT have a body, so no chunked terminator (RFC 2616 10.2.5).
          // HEAD likewise gets headers-only: real Node sends no terminator
          // for HEAD+chunked (probed v24.22.1), and one parses as a new
          // message start on the client (test-http-head-request).
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
      // Prompt idle close: real Node closes an idle keep-alive socket
      // ~keepAliveTimeout after the response (probed v24.22.1: 6.06s with
      // the 5000ms default), NOT at the next connectionsCheckingInterval
      // tick (30s default) — polling alone closes at 30s, past the window
      // for a test waiting on the client's 'end' (test-http-insecure-parser).
      // _checkConnections stays as backstop. Unref'd: open sockets keep
      // the loop alive; the timer itself must not. Suppressed when the
      // server set a socket timeout at connect (see hasSocketTimeout).
      if (this.keepAliveTimeout > 0 && !state.hasSocketTimeout) {
        if (state.idleTimer) clearTimeout(state.idleTimer);
        const idleSocket = socket;
        const idleState = state;
        state.idleTimer = setTimeout(() => {
          idleState.idleTimer = null;
          if (
            !idleSocket.destroyed &&
            idleSocket._httpState === idleState &&
            idleState.idleSince !== null &&
            !idleState.busy &&
            !idleState.receiving
          ) {
            try {
              idleSocket.destroy();
            } catch {
              /* best effort */
            }
          }
        }, this.keepAliveTimeout);
        state.idleTimer.unref?.();
      }
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
    } else if (
      state.dropResponse &&
      state.dropResponse !== res &&
      !state.dropResponse.finished
    ) {
      // A drop (503) response is still outstanding behind this one: do
      // not destroy the socket yet — the drop response's own finish
      // takes this same branch and owns the close, so the 503 bytes
      // (serialized by finish FIFO after this response) still reach the
      // client instead of being lost to an already-destroyed socket
      // (test-http-keep-alive-drop-requests).
    } else {
      // Not keep-alive: destroy (not just end) so both sides release their
      // loop timers and the process can exit. (end() alone leaves the
      // virtual socket half-open.)
      // Peer half-closed exception (test-http-server-keepalive-end):
      // the dump hook above resumed the request this same tick, so its
      // 'end' is queued as a nextTick and has not fired yet — destroying
      // now nulls socket.parser (onHttpClose) before 'end' handlers run,
      // and the test reads req.socket.parser.incoming inside 'end'.
      // Defer one nextTick: it queues after the 'end' delivery but
      // before the nextTick a user 'end' handler schedules, so 'end'
      // still sees a live parser and the post-'end' check still sees
      // null. Narrowly scoped to peerEnded + a not-yet-ended request;
      // all other closes stay synchronous. (The nextTick fallback only
      // matters in builds without a process shim, where this test
      // cannot run — the harness guarantees globalThis.process.nextTick.)
      if (
        state.peerEnded &&
        req &&
        !req.destroyed &&
        !req.readableEnded &&
        typeof globalThis.process?.nextTick === "function"
      ) {
        const closingSocket = socket;
        globalThis.process.nextTick(() => {
          try {
            closingSocket.destroy();
          } catch {
            try {
              closingSocket.end();
            } catch {
              /* ignore */
            }
          }
        });
      } else {
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
    }
    // Release the dispatch stash: state.lastResponse pins res -> req
    // (res.req), and the client-side socket still links to this socket
    // via _peer after a graceful FIN — without this release a finished
    // request stays reachable forever and GC-gated tests hang
    // (test-http-server-keepalive-req-gc). Only clear when this
    // response is still the stashed one: a pipelined next request may
    // already have replaced it, and its pending frame must survive.
    if (state.lastResponse === res) state.lastResponse = null;
    if (state.dropResponse === res) state.dropResponse = null;
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
      const res = new ServerResponse(req, {
        rejectNonStandardBodyWrites: this._rejectNonStandardBodyWrites,
        lenientHeaderValidation: this._lenientHeaderValidation,
      });
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

// Whether a response's Connection header says "close" (case-insensitive,
// string or array form): the server closed its side, so the socket must
// not be pooled (see keepSocketAlive's veto).
function isConnectionClose(headers) {
  const value = headers?.connection;
  if (typeof value === "string") return value.toLowerCase() === "close";
  if (Array.isArray(value)) {
    return value.some((v) => String(v).toLowerCase() === "close");
  }
  return false;
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
      // Real Node validates via validateOneOf, whose message differs
      // from the generic ERR_INVALID_ARG_VALUE shape ("is invalid.",
      // double-quoted value): "The argument 'scheduling' must be one
      // of: 'fifo', 'lifo'. Received 'filo'".
      const v = this.scheduling;
      throw makeError(
        "ERR_INVALID_ARG_VALUE",
        `The argument 'scheduling' must be one of: 'fifo', 'lifo'. Received ${typeof v === "string" ? `'${v}'` : String(v)}`,
      );
    }
    this.maxTotalSockets = opts.maxTotalSockets;
    if (this.maxTotalSockets !== undefined) {
      // Real Node: non-number → ERR_INVALID_ARG_TYPE; anything not
      // >= 1 (incl. NaN, -Infinity) → ERR_OUT_OF_RANGE. Infinity and
      // fractions pass (probed v24.22.1) — no integer requirement.
      if (typeof this.maxTotalSockets !== "number") {
        throw ERR_INVALID_ARG_TYPE_ARGUMENT(
          "maxTotalSockets",
          "number",
          this.maxTotalSockets,
        );
      }
      if (!(this.maxTotalSockets >= 1)) {
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

  /**
   * Default socket creation: the virtual-network path. This method is the
   * override point — createSocket calls it, never netConnect directly —
   * so tests that replace it observe or fail creation (test-http-agent
   * replaces it to fail every creation; test-http-agent-keepalive-delay
   * wraps it to assert the options it receives: keepAlive from the agent,
   * keepAliveInitialDelay from keepAliveMsecs). The callback fires on
   * connect with (null, socket); socket errors are NOT delivered via
   * this callback on the default path — they reach the request through
   * socketErrorListener (see below). An override that calls back with
   * an error returns undefined and creates no socket; createSocket's
   * error path handles that (addRequest then errors the request via
   * onSocketError).
   */
  createConnection(options, callback) {
    // Number form (test-http-socket-encoding-error):
    // createConnection(port[, host][, callback]). Destructuring
    // options.port on a number yields undefined and netConnect throws
    // ERR_MISSING_ARGS; normalize first (a string second argument is
    // the host, as in net.createConnection's overloads).
    if (typeof options === "number") {
      const host = typeof callback === "string" ? callback : undefined;
      if (typeof callback === "string") callback = undefined;
      options = { port: options, host };
    }
    // Unix-socket target (real Node _http_agent: createSocket sets
    // options.path = options.socketPath, and net.connect treats `path`
    // as the pipe). Forwarded only when present, so TCP callers see
    // exactly the options they passed (test-http-agent-keepalive-delay
    // asserts keepAlive/keepAliveInitialDelay and nothing else).
    const connectOptions = {
      port: options.port,
      host: options.host,
      noDelay: options.noDelay,
      keepAlive: options.keepAlive,
      keepAliveInitialDelay: options.keepAliveInitialDelay,
      lookup: options.lookup,
    };
    if (options.path) connectOptions.path = options.path;
    if (options.socketPath) {
      connectOptions.path = options.socketPath;
      connectOptions.socketPath = options.socketPath;
    }
    const socket = netConnect(connectOptions);
    // AbortSignal (test-http-agent-abort-controller): Node's
    // net.createConnection wires exactly one 'abort' listener on the
    // signal, and aborting destroys the socket with an AbortError
    // (emitted async by the stream machinery, so a listener attached
    // after abort() still catches it). An already-aborted signal
    // errors the socket async with no listener added.
    const signal = options.signal;
    if (signal) {
      const abortSocket = () => {
        if (socket.destroyed) return;
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        err.code = "ABORT_ERR";
        socket.destroy(err);
      };
      if (signal.aborted) {
        queueMicrotask(abortSocket);
      } else {
        signal.addEventListener("abort", abortSocket, { once: true });
      }
    }
    // The callback fires on connect ONLY — deliberately no 'error'
    // listener here. Socket errors are forwarded to the request by
    // socketErrorListener (attached in onSocket at assignment); a
    // second 'error' listener would break the assignment-time counts
    // (test-http-agent-keepalive asserts exactly one) and would
    // double-emit with the forwarder. Creation errors from OVERRIDES
    // (which return undefined and call back with the error themselves,
    // e.g. test-http-agent) still reach createSocket's oncreate.
    if (typeof callback === "function") {
      socket.once("connect", () => callback(null, socket));
    }
    return socket;
  }

  createSocket(req, options, callback) {
    const name = this.getName(options);
    // For the virtual-server path, create a real virtual socket via
    // createConnection (overridable). The port comes from the request
    // options, falling back to the request's own host/port (for manual
    // addRequest(req, {}) calls).
    const port =
      options.port || req.port || req._port || this.defaultPort || 80;
    const host = options.host || options.hostname || req.host || "localhost";
    // Real Node passes the agent's noDelay (default true) into the
    // connect options; a request-level noDelay is ignored (probed
    // v24.22.1: http.request({ noDelay: false }) still connects with
    // noDelay true, while new Agent({ noDelay: false }) connects
    // with false). The agent consumes the option internally — Agent
    // exposes no noDelay property on real Node. keepAlive /
    // keepAliveInitialDelay and lookup flow the same way (the latter so
    // a never-returning lookup keeps the socket pending instead of
    // erroring — test-http-agent-timeout-option).
    const createOptions = {
      port,
      host,
      noDelay: this.options.noDelay ?? true,
      keepAlive: this.keepAlive,
      keepAliveInitialDelay: this.keepAliveMsecs,
      lookup: options.lookup,
    };
    // Unix-socket target: translate socketPath to net's `path`, like
    // real Node's Agent.createSocket (options.path = options.socketPath).
    // Falls back to the request itself so queued/drained re-creations
    // (which rebuild options) keep the target.
    const socketPath = options.socketPath || req.socketPath || null;
    if (socketPath) {
      createOptions.path = socketPath;
      createOptions.socketPath = socketPath;
    }
    let socket;
    let creationHandled = false;
    const oncreate = (err, sock) => {
      // Late creation outcome: the original's once('connect') wiring,
      // or an async-creation override's callback. The synchronous path
      // below already assigned the socket and invoked the addRequest
      // callback, so late successes are no-ops. Late errors only arrive
      // from overrides (the original wires no 'error' listener) and
      // propagate to the addRequest error path — which errors the
      // request exactly once, since no socket exists for
      // socketErrorListener to forward through.
      if (creationHandled) return;
      if (err) {
        creationHandled = true;
        if (typeof callback === "function") callback(err);
        return;
      }
      if (!sock || req.socket === sock) return;
      // Async-creation override delivered a socket after the sync path
      // returned null: track and assign it now (the old connect-time
      // path, kept for overrides that create asynchronously).
      creationHandled = true;
      sock.autoDestroy = false;
      (this.sockets[name] ??= []).push(sock);
      this.totalSocketCount++;
      sock._agentName = name;
      sock._agent = this;
      sock._connectedBeforeAssign = sock._connected === true;
      // Queued-creation 'free' (see _processQueue): before assignment.
      if (req._fromQueue) {
        delete req._fromQueue;
        this.emit("free", sock, options);
      }
      req.onSocket(sock);
      if (typeof callback === "function") callback(null, sock);
    };
    try {
      socket = this.createConnection(createOptions, oncreate);
    } catch (err) {
      if (typeof callback === "function") {
        queueMicrotask(() => callback(err));
      }
      return null;
    }
    if (!socket) {
      // The override took over creation (returns undefined, calls back
      // itself with either a socket or an error). Nothing to track or
      // assign here; oncreate handles the outcome.
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
    // Assign at creation, like Node: the request's 'socket' event fires
    // while the socket is still connecting (probed: connecting=true,
    // pending=true at 'socket' time), and 'connect' follows naturally —
    // no replay needed. (Previously assignment waited for connect and
    // _performVirtualRequest replayed 'connect'; the replay path is kept
    // for sockets that arrive already connected, e.g. via a
    // synchronous-connect override.) Pre-connect writes buffer in the
    // socket's pending-write queue and flush on connect, so the round
    // trip can start immediately. A never-connecting socket (lookup that
    // never calls back) simply never delivers — no error, matching Node.
    socket._connectedBeforeAssign = socket._connected === true;
    // Queued-creation 'free' (see _processQueue): before assignment.
    if (req._fromQueue) {
      delete req._fromQueue;
      this.emit("free", socket, options);
    }
    req.onSocket(socket);
    // Invoke the addRequest callback synchronously at creation (not on
    // connect): assignment already happened, so its success branch is a
    // guarded no-op except for the redundant-socket case (a request
    // that already holds a real socket via another path — the second
    // addRequest in test-http-agent-uninitialized — whose cleanup the
    // callback performs). Socket errors now surface solely through
    // socketErrorListener, so no connect/error listener is attached
    // here — keeping the assignment-time error count at exactly one.
    creationHandled = true;
    if (typeof callback === "function") callback(null, socket);
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
        // A dequeued request reusing a pooled socket gets no new 'free'
        // emission (the socket's release already emitted one) — just
        // clear the flags.
        delete req._fromQueue;
        delete req._drainBypass;
        this.reuseSocket(socket, req);
        return;
      }
    }
    // 2. Create a new socket if under the per-origin and total limits —
    // or when draining: real Node's removeSocket drain calls
    // createSocket directly with no gate, so a drained request creates
    // even at cap (test-http-agent-maxtotalsockets: pooled sockets
    // still count toward totalSocketCount, so a gated drain would
    // deadlock the second origin forever). The flag is consumed here
    // so a request that somehow re-queues loses the privilege.
    const active = this.sockets[name] || [];
    const drainBypass = Boolean(req._drainBypass);
    delete req._drainBypass;
    if (
      drainBypass ||
      (active.length < this.maxSockets &&
        this.totalSocketCount < this.maxTotalSockets)
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
          // A request still waiting for socket assignment (end() called,
          // _performVirtualRequest pending) keeps the existing path: the
          // wait rejects with the original error and its handler owns
          // emission. Otherwise the error must arrive async and destroy
          // the request: a synchronous createSocket override that calls
          // back with an error fires during construction, before the
          // caller can attach 'error'/'close' listeners — emitting
          // synchronously would throw (no listener) inside the
          // constructor's try/catch and be swallowed, losing the error
          // entirely (test-http-agent-close). destroy(err) gives
          // error-then-close with destroyed === true, like real Node.
          if (req._onSocketAssigned) {
            if (typeof req.onSocketError === "function") {
              req.onSocketError(err);
            } else {
              req.emit("error", err);
            }
          } else {
            queueMicrotask(() => {
              if (!req.destroyed) req.destroy(err);
            });
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
  releaseSocket(socket, name, options) {
    // Remove from active. Only a socket actually tracked here still
    // contributes to totalSocketCount: a release racing agent.destroy()
    // (a user 'end' handler destroying the agent while this release
    // is still queued behind it in the same 'end' emission) must not
    // decrement a count destroy() already reset to 0, or the count
    // goes negative (test-http-agent-maxtotalsockets endgame).
    const active = this.sockets[name];
    let wasActive = false;
    if (active) {
      const idx = active.indexOf(socket);
      if (idx !== -1) {
        active.splice(idx, 1);
        wasActive = true;
        if (active.length === 0) delete this.sockets[name];
      }
    }
    if (this.keepAlive && !socket.destroyed) {
      // The completed request's listeners come off first: after free,
      // the socket carries exactly one 'error' listener (the free-pool
      // handler below) and one 'end' listener (stream-internal), per
      // test-http-agent-keepalive's checkListeners. The pooled-timeout
      // handler added below is the agent's own, not the request's.
      _removeRequestSocketListeners(socket);
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
        if (wasActive) this.totalSocketCount--;
        this._emitFree(socket, options);
        this._drainQueue(name);
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
        // (Real Node's name for this handler is freeSocketErrorListener.)
        const freeSocketErrorListener = () => {
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
        socket.once("error", freeSocketErrorListener);
        // Store for cleanup on reuse (avoid listener leak).
        socket._idleErrorHandler = freeSocketErrorListener;
        // Agent owns close handling for idle sockets too: when the
        // remote server closes a pooled connection (FIN), the socket
        // must leave the free pool and the count must drop — otherwise
        // the pool holds a dead socket forever
        // (test-http-agent-keepalive's remoteClose: 200ms after the
        // server ends, freeSockets and totalSocketCount are both 0).
        // No destroy here: the socket is already closed.
        const freeSocketCloseListener = () => {
          socket._inFreePool = false;
          if (socket._pooledTimeoutHandler) {
            socket.removeListener("timeout", socket._pooledTimeoutHandler);
            socket._pooledTimeoutHandler = null;
          }
          const wasPooled = (this.freeSockets[name] || []).includes(socket);
          this.removeSocket(socket, name);
          if (wasPooled) this.totalSocketCount--;
          // A pooled close frees capacity like any close: drain, so a
          // queued origin is not left waiting on a dead pool entry.
          this._drainQueue(name);
        };
        socket.once("close", freeSocketCloseListener);
        // Store for cleanup on reuse (avoid listener leak).
        socket._idleCloseHandler = freeSocketCloseListener;
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
        // Pooled sockets carry a null parser (the guard test reads it).
        socket.parser = null;
        // Pooled sockets die on FIN again: while active, autoDestroy
        // is false so the socket survives its response end (see
        // createSocket); once pooled, restore true so a server FIN
        // ('end' + self-end + finish) destroys it and the free-pool
        // close handler removes it (test-http-agent-keepalive's
        // remoteClose: the pool must empty when the server ends the
        // connection). Flipping the flag is inert by itself — the
        // destroy check runs only at end/finish events, and at pool
        // time neither side has ended.
        socket.autoDestroy = true;
      } else {
        socket.destroy();
        if (wasActive) this.totalSocketCount--;
      }
    } else {
      socket.destroy();
      if (wasActive) this.totalSocketCount--;
    }
    // Every release frees the socket: the socket 'free' event fires
    // whether the socket is pooled or destroyed (real Node emits it
    // from the release path in both cases), and the agent forwards it
    // as its own 'free' (test-http-agent-destroyed-socket counts 3
    // agent 'free' events: release-destroyed, queued-creation,
    // release-destroyed).
    this._emitFree(socket, options);
    // Wake a queued request, if any — via the removeSocket-style drain
    // (same origin first, else the first queued origin with no active
    // sockets, gate-bypassing), so a release whose own origin has no
    // waiter still unblocks other origins
    // (test-http-agent-maxtotalsockets).
    this._drainQueue(name);
  }

  // Socket 'free' + agent 'free' for one release. Real Node's agent
  // forwards the socket's 'free' event (installListeners/onFree), so
  // both fire, socket first.
  _emitFree(socket, options) {
    socket.emit("free");
    this.emit("free", socket, options);
  }

  _processQueue(name, bypassGate = false) {
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
    // Mark dequeued requests: when one gets a NEW socket (not a pooled
    // reuse), real Node emits 'free' for it before assignment — the
    // removeSocket queue-drain path creates the socket and its
    // callback does only socket.emit('free')
    // (test-http-agent-destroyed-socket's free#2).
    req._fromQueue = true;
    // Drain creations bypass addRequest's caps (see the creation
    // gate); initial requests never carry the flag.
    if (bypassGate) req._drainBypass = true;
    // Re-run addRequest: it will find the free socket or create a new one.
    this.addRequest(req, req._agentOptions || {});
  }

  // Queue drain, mirroring real Node's removeSocket: the released
  // origin first, else the first queued origin in key order that has
  // no active sockets (Node breaks at the first origin WITH active
  // sockets — it does not scan past it — and drains exactly one
  // request). The release drain bypasses the creation gate (see
  // _processQueue): each drain frees exactly one active slot first
  // (release removes from active before draining; close removes in
  // removeSocket before waking), so active counts stay within caps
  // while the total may transiently exceed maxTotalSockets, as on
  // real Node (test-http-agent-maxtotalsockets). The close drain
  // passes bypassGate=false: close already freed a slot, so the gate
  // passes for the freed origin, and gating stops a close that
  // follows a release from creating a second socket for an origin
  // whose release drain already assigned one
  // (test-http-keep-alive-close-on-header).
  _drainQueue(name, bypassGate = true) {
    if (typeof this._processQueue !== "function") return;
    if (this.requests[name]?.length) {
      this._processQueue(name, bypassGate);
      return;
    }
    for (const prop of Object.keys(this.requests)) {
      if (this.sockets[prop]?.length) break;
      this._processQueue(prop, bypassGate);
      break;
    }
  }

  keepSocketAlive(socket) {
    // Drained-only reuse (test-http-agent-reuse-drained-socket-only):
    // a socket with pending write data is never pooled. Probed on real
    // Node v24.22.1: after the first response ends with 192MB still
    // queued, the socket sits in agent.sockets (active, count 1), NOT
    // in freeSockets, and is NOT destroyed — the second request gets a
    // new socket, while a drained socket is reused. The shim's
    // releaseSocket destroys on veto (the existing hint-veto path);
    // the test observes only reuse, not the socket's fate, so the
    // shared veto path serves here. The divergence (destroy vs keep)
    // is recorded in NOTES, not papered over.
    if (socket.writableLength > 0) {
      return false;
    }
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
    // Response said `Connection: close`: the server already closed
    // its side, so pooling this socket hands the next request a dead
    // peer — its first write dies EPIPE
    // (test-http-get-pipeline-problem: ten Connection: close
    // responses through the keep-alive globalAgent must each get a
    // fresh socket). The flag is stashed per response beside the
    // hint above and cleared on reuse.
    if (socket._responseConnectionClose) {
      return false;
    }
    return true;
  }

  reuseSocket(socket, req) {
    // A reused socket connected for an earlier request; never replay
    // that 'connect' for the new request.
    socket._connectedBeforeAssign = false;
    // Back to active duty: autoDestroy false again, so the socket
    // survives its next response end like a fresh agent socket (the
    // pool-time true flip is only for FIN-while-pooled).
    socket.autoDestroy = false;
    // Drop the previous response's keep-alive hint: the next release
    // re-stashes from its own response (or null when it has none), so
    // a stale hint can never veto an unrelated response's pooling.
    socket._serverKeepAliveTimeout = null;
    // Same for the previous response's Connection: close verdict.
    socket._responseConnectionClose = false;
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
    // Remove the idle close handler likewise: a reused socket's later
    // close belongs to the new request, not the pool.
    if (socket._idleCloseHandler) {
      socket.removeListener("close", socket._idleCloseHandler);
      socket._idleCloseHandler = null;
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
