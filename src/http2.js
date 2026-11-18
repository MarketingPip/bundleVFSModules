// src/http2.js — browser emulation of node:http2 (Node v24.20.0).
//
// What this is:
//   * The REAL static surface of node:http2: the full 240-entry `constants`
//     object (values copied verbatim from Node v24.20.0), `sensitiveHeaders`
//     (a symbol, like Node), and real implementations of the pure functions
//     `getDefaultSettings()`, `getPackedSettings()` and
//     `getUnpackedSettings()` (SETTINGS frame payload packing —
//     differential-tested against node:http2).
//   * The real class/method shapes: Http2Server, Http2SecureServer,
//     Http2Session, ClientHttp2Session, ServerHttp2Session, Http2Stream,
//     Http2ServerRequest, Http2ServerResponse, plus createServer(),
//     createSecureServer(), connect() and performServerHandshake().
//   * An in-process virtual client/server loop: createServer().listen(port)
//     registers in a module-local registry; connect(authority).request()
//     dispatches to the registered server on the next microtask, the server
//     handler responds through Http2ServerResponse, and the client stream
//     emits 'response' / 'data' / 'end'. No network involved.
//
// What it is NOT: true HTTP/2 framing. Browsers expose no raw socket API,
// so no SETTINGS/HEADERS/DATA frames are ever encoded, no HPACK runs, no
// TLS/ALPN negotiation happens, and nothing is ever sent over a network.
// Every method that would perform real HTTP/2 I/O is an honest noop (or a
// virtual-loop emulation) with the real callback/event signature.
//
// Honest gaps (also listed in the PR body):
//   * No real framing, flow control, HPACK, multiplexing over a socket,
//     ALPN, or TLS. `encrypted` is a flag, not a guarantee.
//   * The virtual loop shares one Http2Stream object between client and
//     server (real Node has distinct objects per side) and delivers the
//     whole response body as a single 'data' chunk.
//   * Http2ServerRequest/Http2ServerResponse are EventEmitters, not real
//     Readable/Writable streams; trailers, backpressure and 'checkContinue'
//     are unsupported.
//   * session.setTimeout() accepts its arguments but does not track
//     inactivity (no 'timeout' is ever emitted from inactivity).
//   * session.state / stream.state return plausible static values, not live
//     nghttp2 internals. ping() reports a 0ms round-trip.
//   * Push streams are impossible: pushStream() calls back with
//     ERR_HTTP2_PUSH_DISABLED.
//   * connect() to an authority with no registered virtual server emits an
//     async ECONNREFUSED 'error' on the session.
//   * respondWithFile/respondWithFD are noops (no file descriptors).

import { EventEmitter } from "./events.js";
import { Buffer } from "buffer";

// ---------------------------------------------------------------------------
// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
// ---------------------------------------------------------------------------
const RT =
  typeof globalThis._RUNTIME_ !== "undefined"
    ? globalThis._RUNTIME_
    : undefined;
void RT;

// ---------------------------------------------------------------------------
// 2. Error helpers — exact Node shapes: the right Error subclass, the right
//    .code, and the message WITHOUT a code prefix (Node's messages don't
//    include one). No invented codes.
// ---------------------------------------------------------------------------
function http2Error(code, message, Kind = Error) {
  const err = new Kind(message);
  err.code = code;
  return err;
}
const rangeError = (code, message) => http2Error(code, message, RangeError);
const typeError = (code, message) => http2Error(code, message, TypeError);

// Approximation of Node's test-helper invalidArgTypeHelper (used in real
// Node error messages, asserted by official tests).
function invalidArgTypeHelper(input) {
  if (input === null || input === undefined)
    return ` Received ${String(input)}`;
  if (typeof input === "function") {
    // Node's helper uses input.name verbatim — an anonymous function
    // gives "Received function " (probe-proven), not "anonymous".
    return ` Received function ${input.name}`;
  }
  if (typeof input === "object") {
    const name = input.constructor && input.constructor.name;
    if (name) return ` Received an instance of ${name}`;
    return ` Received ${String(input)}`;
  }
  let inspected = typeof input === "string" ? `'${input}'` : String(input);
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return ` Received type ${typeof input} (${inspected})`;
}

// H2-V4: Node validator shapes (lib/internal/validators.js) + the
// http2 header-validation core (lib/internal/http2/util.js
// buildNgHeaderString, lib/internal/http2/compat.js assertValidHeader).
// All messages are the exact Node v24.20.0 strings, probe-verified
// against real Node where the oracle is unclear.

// HTTP token: !#$%&'*+-.^_`|~ + alphanumerics (Node checkIsHttpToken).
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function checkIsHttpToken(name) {
  return typeof name === "string" && HTTP_TOKEN_RE.test(name);
}

// Approximation of util.inspect for the scalar/container values the
// official tests put in ERR_INVALID_ARG_VALUE messages (probe-verified:
// function -> "[Function: function]", string -> "'   '", {} -> "{}").
function inspectValue(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string")
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (typeof value === "function")
    return value.name ? `[Function: ${value.name}]` : "[Function (anonymous)]";
  if (typeof value === "symbol" || typeof value === "number" ||
      typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[ ${value.map(inspectValue).join(", ")} ]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    return `{ ${keys.map((k) => `${k}: ${inspectValue(value[k])}`).join(", ")} }`;
  }
  return String(value);
}

function invalidArgValue(name, value) {
  let inspected = inspectValue(value);
  if (inspected.length > 128) inspected = `${inspected.slice(0, 128)}...`;
  const type = name.includes(".") ? "property" : "argument";
  return typeError(
    "ERR_INVALID_ARG_VALUE",
    `The ${type} '${name}' is invalid. Received ${inspected}`,
  );
}

function validateString(value, name) {
  if (typeof value !== "string") {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be of type string.${invalidArgTypeHelper(value)}`,
    );
  }
}
function validateNumber(value, name, min, max) {
  if (typeof value !== "number") {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be of type number.${invalidArgTypeHelper(value)}`,
    );
  }
  if (min !== undefined && value < min) {
    throw rangeError(
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be >= ${min}. Received ${value}`,
    );
  }
  if (max !== undefined && value > max) {
    throw rangeError(
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be <= ${max}. Received ${value}`,
    );
  }
}
function validateBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be of type boolean.${invalidArgTypeHelper(value)}`,
    );
  }
}
function validateFunction(value, name) {
  if (typeof value !== "function") {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be of type function.${invalidArgTypeHelper(value)}`,
    );
  }
}
function validateBuffer(value, name) {
  if (!Buffer.isBuffer(value) && !ArrayBuffer.isView(value)) {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be an instance of Buffer, TypedArray, or DataView.${invalidArgTypeHelper(value)}`,
    );
  }
}
// Node validateInteger: non-number -> ERR_INVALID_ARG_TYPE; non-integer
// -> ERR_OUT_OF_RANGE ("It must be an integer"); out of [min, max] ->
// ERR_OUT_OF_RANGE with the caller's range wording (rangeMsg).
function validateInteger(value, name, min, max, rangeMsg) {
  if (typeof value !== "number") {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be of type number.${invalidArgTypeHelper(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw rangeError(
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. It must be an integer. Received ${value}`,
    );
  }
  if (value < min || value > max) {
    throw rangeError(
      "ERR_OUT_OF_RANGE",
      `The value of "${name}" is out of range. ${rangeMsg || `It must be >= ${min} && <= ${max}.`} Received ${value}`,
    );
  }
}

// Node lib/internal/http2/compat.js:82-96 assertValidHeader (used by
// setHeader / writeEarlyHints / trailers): empty, non-string or spaced
// names -> ERR_INVALID_HTTP_TOKEN; pseudo-headers -> the
// NOT_ALLOWED error (not the buildNgHeaderString one); undefined/null
// values -> ERR_HTTP2_INVALID_HEADER_VALUE. Connection headers are only
// warned about here, never thrown (unlike the request path).
function assertValidHeader(name, value) {
  if (name === "" || typeof name !== "string" || name.includes(" ")) {
    throw typeError(
      "ERR_INVALID_HTTP_TOKEN",
      `Header name must be a valid HTTP token ["${name}"]`,
    );
  }
  if (name[0] === ":") {
    throw typeError(
      "ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED",
      "Cannot set HTTP/2 pseudo-headers",
    );
  }
  if (value === undefined || value === null) {
    throw typeError(
      "ERR_HTTP2_INVALID_HEADER_VALUE",
      `Invalid value "${String(value)}" for header "${name}"`,
    );
  }
}

// Node lib/internal/http2/util.js kValidPseudoHeaders / kSingleValueFields.
const kValidPseudoHeaders = new Set([
  ":status", ":method", ":authority", ":scheme", ":path", ":protocol",
]);
const kSingleValueFields = new Set([
  ":status", ":method", ":authority", ":scheme", ":path", ":protocol",
  "access-control-allow-credentials", "access-control-max-age",
  "access-control-request-method", "age", "authorization",
  "content-encoding", "content-language", "content-length",
  "content-location", "content-md5", "content-range", "content-type",
  "date", "dnt", "etag", "expires", "from", "host", "if-match",
  "if-modified-since", "if-none-match", "if-range",
  "if-unmodified-since", "last-modified", "location", "max-forwards",
  "proxy-authorization", "range", "referer", "retry-after", "tk",
  "upgrade-insecure-requests", "user-agent", "x-content-type-options",
]);
// Node lib/internal/http2/util.js kNoPayloadMethods.
const kNoPayloadMethods = new Set(["DELETE", "GET", "HEAD"]);

function assertValidPseudoHeader(key) {
  if (!kValidPseudoHeaders.has(key)) {
    throw typeError(
      "ERR_HTTP2_INVALID_PSEUDOHEADER",
      `"${key}" is an invalid pseudoheader or is used incorrectly`,
    );
  }
}
function assertValidPseudoHeaderResponse(key) {
  if (key !== ":status") {
    throw typeError(
      "ERR_HTTP2_INVALID_PSEUDOHEADER",
      `"${key}" is an invalid pseudoheader or is used incorrectly`,
    );
  }
}
function assertValidPseudoHeaderTrailer(key) {
  throw typeError(
    "ERR_HTTP2_INVALID_PSEUDOHEADER",
    `"${key}" is an invalid pseudoheader or is used incorrectly`,
  );
}

// Node lib/internal/http2/util.js isIllegalConnectionSpecificHeader.
function isIllegalConnectionSpecificHeader(name, value) {
  switch (name) {
    case "connection":
    case "upgrade":
    case "http2-settings":
    case "keep-alive":
    case "proxy-connection":
    case "transfer-encoding":
      return true;
    case "te":
      return value !== "trailers";
    default:
      return false;
  }
}

// The validation half of Node's buildNgHeaderString
// (lib/internal/http2/util.js:767-860): keys are lowercased first;
// single-value fields (strict, the session default) throw on a second
// instance or an array with >1 element; ':' keys go through the
// caller-supplied pseudo validator; other keys must be valid HTTP tokens
// and not connection-specific. Undefined values and '' keys are skipped,
// like Node. pseudoValidator is assertValidPseudoHeader (requests),
// assertValidPseudoHeaderResponse (responses) or
// assertValidPseudoHeaderTrailer (trailers).
function validateHeaderList(pairs, pseudoValidator, strict = true) {
  const singles = new Set();
  for (const [rawKey, value] of pairs) {
    if (value === undefined || rawKey === "") continue;
    const key = typeof rawKey === "string" ? rawKey.toLowerCase() : rawKey;
    const isSingle = typeof key === "string" && kSingleValueFields.has(key);
    // H2-V4: the single-value rule applies only when the session's
    // strictSingleValueFields is true (the default). With
    // strictSingleValueFields: false, duplicate single-value headers
    // (user-agent twice, an expires pair) are allowed.
    if (strict && isSingle) {
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        if (value.length > 1) {
          throw typeError(
            "ERR_HTTP2_HEADER_SINGLE_VALUE",
            `Header field "${key}" must only have a single value`,
          );
        }
      }
      if (singles.has(key)) {
        throw typeError(
          "ERR_HTTP2_HEADER_SINGLE_VALUE",
          `Header field "${key}" must only have a single value`,
        );
      }
      singles.add(key);
    }
    if (typeof key === "string" && key[0] === ":") {
      pseudoValidator(key);
      continue;
    }
    if (!isSingle) {
      if (typeof key !== "string" || !checkIsHttpToken(key)) {
        throw typeError(
          "ERR_INVALID_HTTP_TOKEN",
          `Header name must be a valid HTTP token ["${key}"]`,
        );
      }
      if (isIllegalConnectionSpecificHeader(key, value)) {
        throw typeError(
          "ERR_HTTP2_INVALID_CONNECTION_HEADERS",
          `HTTP/1 Connection specific headers are forbidden: "${key}"`,
        );
      }
    }
  }
}

// Fold flat [name, value] pairs into a header object the way Node's
// toHeaderObject does: duplicate names join with ", " (set-cookie stays
// an array). Names are already lowercased, values already strings.
function foldToHeaderObject(pairs) {
  const obj = { __proto__: null };
  for (const [k, v] of pairs) {
    const existing = obj[k];
    if (existing === undefined) obj[k] = k === "set-cookie" ? [v] : v;
    else if (Array.isArray(existing)) existing.push(v);
    else obj[k] = `${existing}, ${v}`;
  }
  return obj;
}

// Normalize a trailers object/array to flat [lowercased-name, string]
// pairs, in order (Node buildNgHeaderString stringifies values).
function normalizeTrailerPairs(headers) {
  const pairs = [];
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2)
      pairs.push([headers[i], headers[i + 1]]);
  } else if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (Array.isArray(v)) for (const el of v) pairs.push([k, el]);
      else pairs.push([k, v]);
    }
  }
  return pairs.map(([k, v]) => [
    typeof k === "string" ? k.toLowerCase() : k,
    String(v),
  ]);
}

// H2-V3: Node (lib/internal/http2/compat.js:75,112-120,698-706) warns once
// per process when Http2ServerResponse.statusMessage is read or set — the
// getter always returns '' and the setter discards the value. Module-level
// guard, like Node's `statusMessageWarned`.
let statusMessageWarned = false;
function statusMessageWarn() {
  if (statusMessageWarned) return;
  statusMessageWarned = true;
  // process.emitWarning where available (Node, sandbox); silent elsewhere
  // (same guard shape as src/dns.js emitDeprecationWarning).
  const proc = globalThis.process;
  if (proc && typeof proc.emitWarning === "function") {
    proc.emitWarning(
      "Status message is not supported by HTTP/2 (RFC7540 8.1.2.4)",
      "UnsupportedWarning",
    );
  }
}

// H2-V6: header normalization, mirroring Node
// lib/internal/http2/util.js prepareRequestHeadersArray/Object and
// lib/internal/http2/core.js prepareResponseHeadersArray/Object
// (v24.20.0). Flat [k, v, ...] arrays and objects both normalize to a
// null-prototype object (duplicate exact-name keys fold to arrays, case
// preserved, symbol keys copied verbatim); the flat pairs list is kept
// alongside because the folded object loses interleaved duplicate order,
// which rawHeaders must preserve. The wire order (buildNgHeaderString)
// is pseudo-headers first (input relative order), then regular headers
// (input relative order), every name lowercased, every value stringified.
function foldHeaderPairs(pairs) {
  const obj = { __proto__: null };
  for (const [k, v] of pairs) {
    const existing = obj[k];
    if (existing === undefined) obj[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else obj[k] = [existing, v];
  }
  return obj;
}

function pairsFromObject(obj) {
  const pairs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) for (const el of v) pairs.push([k, el]);
    else pairs.push([k, v]);
  }
  return pairs;
}

function toWireRawHeaders(rawPairs) {
  const out = [];
  const push = ([k, v]) => {
    out.push(typeof k === "string" ? k.toLowerCase() : k, String(v));
  };
  for (const p of rawPairs)
    if (typeof p[0] === "string" && p[0].startsWith(":")) push(p);
  for (const p of rawPairs)
    if (!(typeof p[0] === "string" && p[0].startsWith(":"))) push(p);
  return out;
}

function requestPseudoDefaults(session) {
  const authority =
    (session && session._authority) ||
    `localhost:${(session && session._virtualPort) || 80}`;
  const scheme = (session && session._scheme) || "http";
  return [
    [":method", "GET"],
    [":authority", authority],
    [":scheme", scheme],
    [":path", "/"],
  ];
}

function normalizeRequestHeaders(headers, session) {
  const defaults = requestPseudoDefaults(session);
  // H2-V4: Node prepareRequestHeadersArray/Object
  // (lib/internal/http2/util.js:621-766) — CONNECT with no :protocol
  // requires :authority and forbids :scheme/:path; otherwise the missing
  // pseudo-headers are filled from the session defaults.
  const checkConnect = (authority, scheme, path) => {
    if (authority === undefined)
      throw http2Error(
        "ERR_HTTP2_CONNECT_AUTHORITY",
        ":authority header is required for CONNECT requests",
      );
    if (scheme !== undefined)
      throw http2Error(
        "ERR_HTTP2_CONNECT_SCHEME",
        "The :scheme header is forbidden for CONNECT requests",
      );
    if (path !== undefined)
      throw http2Error(
        "ERR_HTTP2_CONNECT_PATH",
        "The :path header is forbidden for CONNECT requests",
      );
  };
  if (Array.isArray(headers)) {
    // Node prepareRequestHeadersArray: missing pseudo-headers are
    // PREPENDED to the raw array in canonical order; sentHeaders folds
    // from the raw array in order.
    const pairs = [];
    for (let i = 0; i < headers.length; i += 2)
      pairs.push([headers[i], headers[i + 1]]);
    const present = new Set();
    for (const [k] of pairs)
      if (typeof k === "string") present.add(k.toLowerCase());
    const lower = (name) => {
      for (const [k, v] of pairs)
        if (typeof k === "string" && k.toLowerCase() === name) return v;
      return undefined;
    };
    const method = lower(":method");
    const protocol = lower(":protocol");
    if (method === "CONNECT" && protocol === undefined) {
      checkConnect(lower(":authority"), lower(":scheme"), lower(":path"));
    }
    const missing =
      method === "CONNECT" && protocol === undefined
        ? []
        : defaults.filter(([k]) => !present.has(k));
    const rawPairs = [...missing, ...pairs];
    validateHeaderList(
      rawPairs,
      assertValidPseudoHeader,
      session._strictSingleValueFields !== false,
    );
    const obj = foldHeaderPairs(rawPairs);
    for (const s of Object.getOwnPropertySymbols(headers))
      obj[s] = headers[s];
    return { headersObject: obj, rawPairs };
  }
  // Object path (Node prepareRequestHeadersObject): verbatim copy, then
  // missing pseudo-headers are APPENDED by assignment. :authority is
  // skipped when a Host header is present (getAuthority semantics).
  const obj = { __proto__: null };
  Object.assign(obj, headers);
  if (obj[":method"] === "CONNECT" && obj[":protocol"] === undefined) {
    checkConnect(obj[":authority"], obj[":scheme"], obj[":path"]);
  } else {
    for (const [k, v] of defaults) {
      if (k === ":authority") {
        if (obj[":authority"] === undefined && obj["host"] === undefined)
          obj[":authority"] = v;
      } else if (obj[k] === undefined) {
        obj[k] = v;
      }
    }
  }
  const rawPairs = pairsFromObject(obj);
  validateHeaderList(
    rawPairs,
    assertValidPseudoHeader,
    session._strictSingleValueFields !== false,
  );
  return { headersObject: obj, rawPairs };
}

function normalizeResponseHeaders(headers, options = {}, strict = true) {
  const sendDate = options.sendDate == null || options.sendDate;
  if (Array.isArray(headers)) {
    // Node prepareResponseHeadersArray: scan for :status/:date
    // (case-insensitive); a missing :status 200 is UNSHIFTED to the
    // front, a missing date is PUSHED to the end; sentHeaders folds
    // from the final array.
    const pairs = [];
    for (let i = 0; i < headers.length; i += 2)
      pairs.push([headers[i], headers[i + 1]]);
    let statusCode = 0;
    let isDateSet = false;
    for (const [k, v] of pairs) {
      const name = typeof k === "string" ? k.toLowerCase() : "";
      if (name === ":status") statusCode = v | 0;
      else if (name === "date") isDateSet = true;
    }
    if (!statusCode) {
      statusCode = 200;
      pairs.unshift([":status", 200]);
    }
    // H2-V4: Node validatePreparedResponseHeaders
    // (lib/internal/http2/core.js:2719-2727) — respond() rejects any
    // status outside 200-599 (probe-proven: writeHead(103) throws too,
    // via respond()).
    if (statusCode < 200 || statusCode > 599) {
      throw http2Error(
        "ERR_HTTP2_STATUS_INVALID",
        `Invalid status code: ${statusCode}`,
        RangeError,
      );
    }
    if (!isDateSet && sendDate)
      pairs.push(["date", new Date().toUTCString()]);
    validateHeaderList(pairs, assertValidPseudoHeaderResponse, strict);
    const obj = foldHeaderPairs(pairs);
    for (const s of Object.getOwnPropertySymbols(headers))
      obj[s] = headers[s];
    return { headersObject: obj, rawPairs: pairs };
  }
  // Object path (Node prepareResponseHeadersObject): verbatim copy;
  // :status coerced to a number (default 200, appended if missing);
  // date appended unless an exact 'date' key is present.
  if (headers === null || headers === undefined) headers = {};
  if (typeof headers !== "object") {
    throw http2Error(
      "ERR_INVALID_ARG_TYPE",
      'The "headers" argument must be of type object',
    );
  }
  const obj = { __proto__: null };
  Object.assign(obj, headers);
  let statusCode;
  let hasDate = false;
  for (const k of Object.keys(obj)) {
    if (k === ":status") statusCode = obj[k];
    else if (k === "date") hasDate = obj[k] != null;
  }
  obj[":status"] = (statusCode | 0) || 200;
  // H2-V4: Node validatePreparedResponseHeaders
  // (lib/internal/http2/core.js:2719-2727) — respond() rejects any status
  // outside 200-599 (probe-proven: writeHead(103) throws too, via
  // respond()).
  if (obj[":status"] < 200 || obj[":status"] > 599) {
    throw http2Error(
      "ERR_HTTP2_STATUS_INVALID",
      `Invalid status code: ${obj[":status"]}`,
      RangeError,
    );
  }
  if (!hasDate && sendDate) obj["date"] = new Date().toUTCString();
  for (const s of Object.getOwnPropertySymbols(headers))
    obj[s] = headers[s];
  const rawPairs = pairsFromObject(obj);
  validateHeaderList(rawPairs, assertValidPseudoHeaderResponse, strict);
  return { headersObject: obj, rawPairs };
}

// ---------------------------------------------------------------------------
// 3. constants — the real values from Node v24.20.0 (static, safe to embed).
// ---------------------------------------------------------------------------
export const constants = {
  DEFAULT_SETTINGS_ENABLE_CONNECT_PROTOCOL: 0,
  DEFAULT_SETTINGS_ENABLE_PUSH: 1,
  DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
  DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
  DEFAULT_SETTINGS_MAX_CONCURRENT_STREAMS: 4294967295,
  DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384,
  DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE: 65535,
  HTTP2_HEADER_ACCEPT: "accept",
  HTTP2_HEADER_ACCEPT_CHARSET: "accept-charset",
  HTTP2_HEADER_ACCEPT_ENCODING: "accept-encoding",
  HTTP2_HEADER_ACCEPT_LANGUAGE: "accept-language",
  HTTP2_HEADER_ACCEPT_RANGES: "accept-ranges",
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS:
    "access-control-allow-credentials",
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: "access-control-allow-headers",
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: "access-control-allow-methods",
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: "access-control-allow-origin",
  HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: "access-control-expose-headers",
  HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: "access-control-max-age",
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: "access-control-request-headers",
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: "access-control-request-method",
  HTTP2_HEADER_AGE: "age",
  HTTP2_HEADER_ALLOW: "allow",
  HTTP2_HEADER_ALT_SVC: "alt-svc",
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_AUTHORIZATION: "authorization",
  HTTP2_HEADER_CACHE_CONTROL: "cache-control",
  HTTP2_HEADER_CONNECTION: "connection",
  HTTP2_HEADER_CONTENT_DISPOSITION: "content-disposition",
  HTTP2_HEADER_CONTENT_ENCODING: "content-encoding",
  HTTP2_HEADER_CONTENT_LANGUAGE: "content-language",
  HTTP2_HEADER_CONTENT_LENGTH: "content-length",
  HTTP2_HEADER_CONTENT_LOCATION: "content-location",
  HTTP2_HEADER_CONTENT_MD5: "content-md5",
  HTTP2_HEADER_CONTENT_RANGE: "content-range",
  HTTP2_HEADER_CONTENT_SECURITY_POLICY: "content-security-policy",
  HTTP2_HEADER_CONTENT_TYPE: "content-type",
  HTTP2_HEADER_COOKIE: "cookie",
  HTTP2_HEADER_DATE: "date",
  HTTP2_HEADER_DNT: "dnt",
  HTTP2_HEADER_EARLY_DATA: "early-data",
  HTTP2_HEADER_ETAG: "etag",
  HTTP2_HEADER_EXPECT: "expect",
  HTTP2_HEADER_EXPECT_CT: "expect-ct",
  HTTP2_HEADER_EXPIRES: "expires",
  HTTP2_HEADER_FORWARDED: "forwarded",
  HTTP2_HEADER_FROM: "from",
  HTTP2_HEADER_HOST: "host",
  HTTP2_HEADER_HTTP2_SETTINGS: "http2-settings",
  HTTP2_HEADER_IF_MATCH: "if-match",
  HTTP2_HEADER_IF_MODIFIED_SINCE: "if-modified-since",
  HTTP2_HEADER_IF_NONE_MATCH: "if-none-match",
  HTTP2_HEADER_IF_RANGE: "if-range",
  HTTP2_HEADER_IF_UNMODIFIED_SINCE: "if-unmodified-since",
  HTTP2_HEADER_KEEP_ALIVE: "keep-alive",
  HTTP2_HEADER_LAST_MODIFIED: "last-modified",
  HTTP2_HEADER_LINK: "link",
  HTTP2_HEADER_LOCATION: "location",
  HTTP2_HEADER_MAX_FORWARDS: "max-forwards",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_ORIGIN: "origin",
  HTTP2_HEADER_PATH: ":path",
  HTTP2_HEADER_PREFER: "prefer",
  HTTP2_HEADER_PRIORITY: "priority",
  HTTP2_HEADER_PROTOCOL: ":protocol",
  HTTP2_HEADER_PROXY_AUTHENTICATE: "proxy-authenticate",
  HTTP2_HEADER_PROXY_AUTHORIZATION: "proxy-authorization",
  HTTP2_HEADER_PROXY_CONNECTION: "proxy-connection",
  HTTP2_HEADER_PURPOSE: "purpose",
  HTTP2_HEADER_RANGE: "range",
  HTTP2_HEADER_REFERER: "referer",
  HTTP2_HEADER_REFRESH: "refresh",
  HTTP2_HEADER_RETRY_AFTER: "retry-after",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_SERVER: "server",
  HTTP2_HEADER_SET_COOKIE: "set-cookie",
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: "strict-transport-security",
  HTTP2_HEADER_TE: "te",
  HTTP2_HEADER_TIMING_ALLOW_ORIGIN: "timing-allow-origin",
  HTTP2_HEADER_TK: "tk",
  HTTP2_HEADER_TRAILER: "trailer",
  HTTP2_HEADER_TRANSFER_ENCODING: "transfer-encoding",
  HTTP2_HEADER_UPGRADE: "upgrade",
  HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: "upgrade-insecure-requests",
  HTTP2_HEADER_USER_AGENT: "user-agent",
  HTTP2_HEADER_VARY: "vary",
  HTTP2_HEADER_VIA: "via",
  HTTP2_HEADER_WARNING: "warning",
  HTTP2_HEADER_WWW_AUTHENTICATE: "www-authenticate",
  HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: "x-content-type-options",
  HTTP2_HEADER_X_FORWARDED_FOR: "x-forwarded-for",
  HTTP2_HEADER_X_FRAME_OPTIONS: "x-frame-options",
  HTTP2_HEADER_X_XSS_PROTECTION: "x-xss-protection",
  HTTP2_METHOD_ACL: "ACL",
  HTTP2_METHOD_BASELINE_CONTROL: "BASELINE-CONTROL",
  HTTP2_METHOD_BIND: "BIND",
  HTTP2_METHOD_CHECKIN: "CHECKIN",
  HTTP2_METHOD_CHECKOUT: "CHECKOUT",
  HTTP2_METHOD_CONNECT: "CONNECT",
  HTTP2_METHOD_COPY: "COPY",
  HTTP2_METHOD_DELETE: "DELETE",
  HTTP2_METHOD_GET: "GET",
  HTTP2_METHOD_HEAD: "HEAD",
  HTTP2_METHOD_LABEL: "LABEL",
  HTTP2_METHOD_LINK: "LINK",
  HTTP2_METHOD_LOCK: "LOCK",
  HTTP2_METHOD_MERGE: "MERGE",
  HTTP2_METHOD_MKACTIVITY: "MKACTIVITY",
  HTTP2_METHOD_MKCALENDAR: "MKCALENDAR",
  HTTP2_METHOD_MKCOL: "MKCOL",
  HTTP2_METHOD_MKREDIRECTREF: "MKREDIRECTREF",
  HTTP2_METHOD_MKWORKSPACE: "MKWORKSPACE",
  HTTP2_METHOD_MOVE: "MOVE",
  HTTP2_METHOD_OPTIONS: "OPTIONS",
  HTTP2_METHOD_ORDERPATCH: "ORDERPATCH",
  HTTP2_METHOD_PATCH: "PATCH",
  HTTP2_METHOD_POST: "POST",
  HTTP2_METHOD_PRI: "PRI",
  HTTP2_METHOD_PROPFIND: "PROPFIND",
  HTTP2_METHOD_PROPPATCH: "PROPPATCH",
  HTTP2_METHOD_PUT: "PUT",
  HTTP2_METHOD_REBIND: "REBIND",
  HTTP2_METHOD_REPORT: "REPORT",
  HTTP2_METHOD_SEARCH: "SEARCH",
  HTTP2_METHOD_TRACE: "TRACE",
  HTTP2_METHOD_UNBIND: "UNBIND",
  HTTP2_METHOD_UNCHECKOUT: "UNCHECKOUT",
  HTTP2_METHOD_UNLINK: "UNLINK",
  HTTP2_METHOD_UNLOCK: "UNLOCK",
  HTTP2_METHOD_UPDATE: "UPDATE",
  HTTP2_METHOD_UPDATEREDIRECTREF: "UPDATEREDIRECTREF",
  HTTP2_METHOD_VERSION_CONTROL: "VERSION-CONTROL",
  HTTP_STATUS_ACCEPTED: 202,
  HTTP_STATUS_ALREADY_REPORTED: 208,
  HTTP_STATUS_BAD_GATEWAY: 502,
  HTTP_STATUS_BAD_REQUEST: 400,
  HTTP_STATUS_BANDWIDTH_LIMIT_EXCEEDED: 509,
  HTTP_STATUS_CONFLICT: 409,
  HTTP_STATUS_CONTINUE: 100,
  HTTP_STATUS_CREATED: 201,
  HTTP_STATUS_EARLY_HINTS: 103,
  HTTP_STATUS_EXPECTATION_FAILED: 417,
  HTTP_STATUS_FAILED_DEPENDENCY: 424,
  HTTP_STATUS_FORBIDDEN: 403,
  HTTP_STATUS_FOUND: 302,
  HTTP_STATUS_GATEWAY_TIMEOUT: 504,
  HTTP_STATUS_GONE: 410,
  HTTP_STATUS_HTTP_VERSION_NOT_SUPPORTED: 505,
  HTTP_STATUS_IM_USED: 226,
  HTTP_STATUS_INSUFFICIENT_STORAGE: 507,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
  HTTP_STATUS_LENGTH_REQUIRED: 411,
  HTTP_STATUS_LOCKED: 423,
  HTTP_STATUS_LOOP_DETECTED: 508,
  HTTP_STATUS_METHOD_NOT_ALLOWED: 405,
  HTTP_STATUS_MISDIRECTED_REQUEST: 421,
  HTTP_STATUS_MOVED_PERMANENTLY: 301,
  HTTP_STATUS_MULTIPLE_CHOICES: 300,
  HTTP_STATUS_MULTI_STATUS: 207,
  HTTP_STATUS_NETWORK_AUTHENTICATION_REQUIRED: 511,
  HTTP_STATUS_NON_AUTHORITATIVE_INFORMATION: 203,
  HTTP_STATUS_NOT_ACCEPTABLE: 406,
  HTTP_STATUS_NOT_EXTENDED: 510,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_NOT_IMPLEMENTED: 501,
  HTTP_STATUS_NOT_MODIFIED: 304,
  HTTP_STATUS_NO_CONTENT: 204,
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_PARTIAL_CONTENT: 206,
  HTTP_STATUS_PAYLOAD_TOO_LARGE: 413,
  HTTP_STATUS_PAYMENT_REQUIRED: 402,
  HTTP_STATUS_PERMANENT_REDIRECT: 308,
  HTTP_STATUS_PRECONDITION_FAILED: 412,
  HTTP_STATUS_PRECONDITION_REQUIRED: 428,
  HTTP_STATUS_PROCESSING: 102,
  HTTP_STATUS_PROXY_AUTHENTICATION_REQUIRED: 407,
  HTTP_STATUS_RANGE_NOT_SATISFIABLE: 416,
  HTTP_STATUS_REQUEST_HEADER_FIELDS_TOO_LARGE: 431,
  HTTP_STATUS_REQUEST_TIMEOUT: 408,
  HTTP_STATUS_RESET_CONTENT: 205,
  HTTP_STATUS_SEE_OTHER: 303,
  HTTP_STATUS_SERVICE_UNAVAILABLE: 503,
  HTTP_STATUS_SWITCHING_PROTOCOLS: 101,
  HTTP_STATUS_TEAPOT: 418,
  HTTP_STATUS_TEMPORARY_REDIRECT: 307,
  HTTP_STATUS_TOO_EARLY: 425,
  HTTP_STATUS_TOO_MANY_REQUESTS: 429,
  HTTP_STATUS_UNAUTHORIZED: 401,
  HTTP_STATUS_UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  HTTP_STATUS_UNPROCESSABLE_ENTITY: 422,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE: 415,
  HTTP_STATUS_UPGRADE_REQUIRED: 426,
  HTTP_STATUS_URI_TOO_LONG: 414,
  HTTP_STATUS_USE_PROXY: 305,
  HTTP_STATUS_VARIANT_ALSO_NEGOTIATES: 506,
  MAX_INITIAL_WINDOW_SIZE: 2147483647,
  MAX_MAX_FRAME_SIZE: 16777215,
  MIN_MAX_FRAME_SIZE: 16384,
  NGHTTP2_CANCEL: 8,
  NGHTTP2_COMPRESSION_ERROR: 9,
  NGHTTP2_CONNECT_ERROR: 10,
  NGHTTP2_DEFAULT_WEIGHT: 16,
  NGHTTP2_ENHANCE_YOUR_CALM: 11,
  NGHTTP2_ERR_FRAME_SIZE_ERROR: -522,
  NGHTTP2_FLAG_ACK: 1,
  NGHTTP2_FLAG_END_HEADERS: 4,
  NGHTTP2_FLAG_END_STREAM: 1,
  NGHTTP2_FLAG_NONE: 0,
  NGHTTP2_FLAG_PADDED: 8,
  NGHTTP2_FLAG_PRIORITY: 32,
  NGHTTP2_FLOW_CONTROL_ERROR: 3,
  NGHTTP2_FRAME_SIZE_ERROR: 6,
  NGHTTP2_HTTP_1_1_REQUIRED: 13,
  NGHTTP2_INADEQUATE_SECURITY: 12,
  NGHTTP2_INTERNAL_ERROR: 2,
  NGHTTP2_NO_ERROR: 0,
  NGHTTP2_PROTOCOL_ERROR: 1,
  NGHTTP2_REFUSED_STREAM: 7,
  NGHTTP2_SESSION_CLIENT: 1,
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
  NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
  NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
  NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
  NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
  NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
  NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
  NGHTTP2_SETTINGS_TIMEOUT: 4,
  NGHTTP2_STREAM_CLOSED: 5,
  NGHTTP2_STREAM_STATE_CLOSED: 7,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_LOCAL: 5,
  NGHTTP2_STREAM_STATE_HALF_CLOSED_REMOTE: 6,
  NGHTTP2_STREAM_STATE_IDLE: 1,
  NGHTTP2_STREAM_STATE_OPEN: 2,
  NGHTTP2_STREAM_STATE_RESERVED_LOCAL: 3,
  NGHTTP2_STREAM_STATE_RESERVED_REMOTE: 4,
  PADDING_STRATEGY_ALIGNED: 1,
  PADDING_STRATEGY_CALLBACK: 1,
  PADDING_STRATEGY_MAX: 2,
  PADDING_STRATEGY_NONE: 0,
};

// ---------------------------------------------------------------------------
// 4. Settings utilities — real SETTINGS payload packing (RFC 7540 §6.5:
//    each entry is a 16-bit identifier + 32-bit value, big-endian).
//
// Behavior is differential-tested against node:http2, including its quirks:
// id-sorted packing, boolean settings requiring real booleans, unknown keys
// ignored, unknown ids -> customSettings on unpack, undefined values
// skipped, NaN in a known numeric setting making the whole pack call return
// undefined, maxHeaderSize winning id 6 over maxHeaderListSize, and the
// customSettings id remap table below.
// ---------------------------------------------------------------------------
const SETTINGS_NAME_TO_ID = {
  headerTableSize: 1,
  enablePush: 2,
  maxConcurrentStreams: 3,
  initialWindowSize: 4,
  maxFrameSize: 5,
  maxHeaderListSize: 6,
  maxHeaderSize: 6, // same wire id as maxHeaderListSize; wins on conflict
  enableConnectProtocol: 8,
};
const SETTINGS_ID_TO_NAME = {
  1: "headerTableSize",
  2: "enablePush",
  3: "maxConcurrentStreams",
  4: "initialWindowSize",
  5: "maxFrameSize",
  // 6 -> both maxHeaderListSize and maxHeaderSize (Node sets both on unpack)
  8: "enableConnectProtocol",
};
// [min, max] per setting, from Node's http2 binding validation.
const SETTINGS_RANGES = {
  headerTableSize: [0, 0xffffffff],
  enablePush: [0, 1],
  maxConcurrentStreams: [0, 0xffffffff],
  initialWindowSize: [0, 2147483647], // MAX_INITIAL_WINDOW_SIZE
  maxFrameSize: [16384, 16777215], // MIN/MAX_MAX_FRAME_SIZE
  maxHeaderListSize: [0, 0xffffffff],
  maxHeaderSize: [0, 0xffffffff],
  enableConnectProtocol: [0, 1],
};
const BOOLEAN_SETTINGS = new Set(["enablePush", "enableConnectProtocol"]);
// Custom settings ids 1..8 are remapped by Node's binding through this
// table (verified empirically against Node v24.20.0); id "3" maps to
// nothing, which makes the whole getPackedSettings call return undefined.
const CUSTOM_ID_REMAP = {
  1: 2,
  2: 4,
  3: undefined,
  4: 3,
  5: 6,
  6: 8,
  7: 7,
  8: 8,
};
const MAX_CUSTOM_SETTINGS = 10;

function invalidSettingValue(name, value, Kind = RangeError) {
  return http2Error(
    "ERR_HTTP2_INVALID_SETTING_VALUE",
    `Invalid value for setting "${name}": ${value}`,
    Kind,
  );
}

function normalizeSettingValue(name, value) {
  const range = SETTINGS_RANGES[name];
  if (BOOLEAN_SETTINGS.has(name)) {
    // Node requires real booleans here; numbers/strings/NaN throw TypeError.
    if (typeof value !== "boolean") {
      throw invalidSettingValue(name, value, TypeError);
    }
    return value ? 1 : 0;
  }
  if (typeof value !== "number") {
    throw invalidSettingValue(name, value, RangeError);
  }
  if (Number.isNaN(value)) return NaN; // sentinel: whole pack call returns undefined
  if (!Number.isFinite(value)) {
    throw invalidSettingValue(name, value, RangeError);
  }
  const num = Math.trunc(value);
  if (num < range[0] || num > range[1]) {
    throw invalidSettingValue(name, value, RangeError);
  }
  return num >>> 0;
}

// Reads [id, value] entries from a settings object (known settings only;
// customSettings handled separately). Returns undefined when any value is
// NaN (mirrors Node). Unknown keys and undefined values are skipped.
function readKnownSettingsEntries(settings) {
  const entries = [];
  let id6; // maxHeaderSize wins over maxHeaderListSize for wire id 6
  let id6Name;
  for (const name of Object.keys(settings)) {
    if (name === "customSettings") continue;
    const id = SETTINGS_NAME_TO_ID[name];
    if (id === undefined) continue; // unknown keys ignored, like Node
    const value = settings[name];
    if (value === undefined) continue; // undefined values skipped, like Node
    const normalized = normalizeSettingValue(name, value);
    if (Number.isNaN(normalized)) return undefined;
    if (id === 6) {
      if (name === "maxHeaderSize" || id6 === undefined) {
        id6 = normalized;
        id6Name = name;
      }
      continue;
    }
    entries.push([id, normalized]);
  }
  if (id6 !== undefined) entries.push([6, id6]);
  void id6Name;
  return entries;
}

// Reads custom settings entries as [id, value]. Mirrors Node's validation:
// customSettings must be an object; >10 entries throws
// ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS; ids are uint16 (remapped for 1..8);
// non-number values are skipped; NaN throws RangeError.
function readCustomSettingsEntries(customSettings) {
  if (
    customSettings === null ||
    typeof customSettings !== "object" ||
    Array.isArray(customSettings)
  ) {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      'The "customSettings" argument must be an instance of Number.' +
        invalidArgTypeHelper(customSettings),
    );
  }
  const keys = Object.keys(customSettings);
  if (keys.length > MAX_CUSTOM_SETTINGS) {
    throw http2Error(
      "ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS",
      "Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS",
    );
  }
  const entries = [];
  for (const key of keys) {
    const value = customSettings[key];
    if (value === undefined || typeof value !== "number") continue; // skipped, like Node
    if (Number.isNaN(value)) {
      throw invalidSettingValue("customSettings:value", value, RangeError);
    }
    let id = Math.trunc(Number(key));
    if (!Number.isFinite(id)) {
      throw invalidSettingValue("customSettings:id", key, RangeError);
    }
    if (id >= 1 && id <= 8) {
      const remapped = CUSTOM_ID_REMAP[id];
      if (remapped === undefined) return undefined; // id "3": whole call returns undefined
      id = remapped;
    } else if (id < 1 || id > 65535) {
      throw invalidSettingValue("customSettings:id", key, RangeError);
    }
    const num = Math.trunc(value);
    if (num < 0 || num > 0xffffffff) {
      throw invalidSettingValue("customSettings:value", value, RangeError);
    }
    entries.push([id, num >>> 0]);
  }
  return entries;
}

function readSettingsEntries(settings) {
  if (settings === undefined) return [];
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  ) {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      'The "settings" argument must be of type object.' +
        invalidArgTypeHelper(settings),
    );
  }
  const entries = readKnownSettingsEntries(settings);
  if (entries === undefined) return undefined; // NaN sentinel
  if (settings.customSettings !== undefined) {
    const custom = readCustomSettingsEntries(settings.customSettings);
    if (custom === undefined) return undefined; // id "3" sentinel
    entries.push(...custom);
  }
  return entries;
}

export function getDefaultSettings() {
  return {
    headerTableSize: 4096,
    enablePush: true,
    initialWindowSize: 65535,
    maxFrameSize: 16384,
    maxConcurrentStreams: 4294967295,
    maxHeaderSize: 65535,
    maxHeaderListSize: 65535,
    enableConnectProtocol: false,
  };
}

export function getPackedSettings(settings) {
  const entries = readSettingsEntries(settings);
  if (entries === undefined) return undefined; // Node quirk: NaN / id "3"
  entries.sort((a, b) => a[0] - b[0]); // Node packs settings sorted by id
  const buf = Buffer.alloc(entries.length * 6);
  entries.forEach(([id, value], i) => {
    buf.writeUInt16BE(id, i * 6);
    buf.writeUInt32BE(value, i * 6 + 2);
  });
  return buf;
}

function validateUnpackedValue(id, value) {
  // Only these two are range-checked with { validate: true } in Node.
  if (id === 4 && (value < 0 || value > 2147483647)) {
    throw invalidSettingValue("initialWindowSize", value, RangeError);
  }
  if (id === 5 && (value < 16384 || value > 16777215)) {
    throw invalidSettingValue("maxFrameSize", value, RangeError);
  }
}

export function getUnpackedSettings(buf, options) {
  const isView =
    typeof buf === "object" &&
    buf !== null &&
    typeof ArrayBuffer !== "undefined" &&
    ArrayBuffer.isView(buf) &&
    !(typeof DataView !== "undefined" && buf instanceof DataView);
  if (!isView) {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      'The "buf" argument must be an instance of Buffer or TypedArray.' +
        invalidArgTypeHelper(buf),
    );
  }
  const len = buf.length; // element count: Node reads TypedArray elements, not raw bytes
  if (len % 6 !== 0) {
    throw rangeError(
      "ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH",
      "Packed settings length must be a multiple of six",
    );
  }
  // Element-wise byte view (matches Node: a Uint16Array's elements become
  // the byte stream, each truncated to uint8).
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = buf[i] & 0xff;
  const validate = !!(
    options !== null &&
    typeof options === "object" &&
    options.validate
  );
  const settings = {};
  const customSettings = {};
  for (let i = 0; i < bytes.length; i += 6) {
    const id = (bytes[i] << 8) | bytes[i + 1];
    const value =
      (bytes[i + 2] * 0x1000000 +
        (bytes[i + 3] << 16) +
        (bytes[i + 4] << 8) +
        bytes[i + 5]) >>>
      0;
    if (validate) validateUnpackedValue(id, value);
    if (id === 6) {
      // Node sets both names on unpack.
      settings.maxHeaderListSize = value;
      settings.maxHeaderSize = value;
    } else {
      const name = SETTINGS_ID_TO_NAME[id];
      if (name === undefined) {
        customSettings[String(id)] = value;
      } else {
        settings[name] = BOOLEAN_SETTINGS.has(name) ? value !== 0 : value;
      }
    }
  }
  if (Object.keys(customSettings).length > 0) {
    settings.customSettings = customSettings;
  }
  return settings;
}

export const sensitiveHeaders = Symbol("sensitiveHeaders");

// ---------------------------------------------------------------------------
// 5. Http2Session — real method shapes; I/O methods are honest noops or
//    virtual-loop wiring with the real callback/event signatures.
// ---------------------------------------------------------------------------

const kEncrypted = Symbol("http2.encrypted");

class Http2Session extends EventEmitter {
  constructor(options = {}) {
    super();
    this._closed = false;
    this._destroyed = false;
    this._connecting = true;
    this[kEncrypted] = !!(options && options.encrypted);
    this._localSettings = getDefaultSettings();
    this._remoteSettings = getDefaultSettings();
    this._pendingSettingsAck = false;
    this._nextStreamID = 1;
    this._timeout = 0;
    // H2-V4: window sizes tracked for real (probe-proven: local is the
    // high-water mark of the initial 65535 and every setLocalWindowSize
    // value; effective is the last set value).
    this._localWindowSize = 65535;
    this._effectiveLocalWindowSize = 65535;
    // H2-V4: server-initiated (push) stream ids are even, starting at
    // 2 (Node lib/internal/http2/core.js). Only server sessions use it.
    this._nextPushStreamID = 2;
    // H2-V4: snapshots of this session's local settings waiting to be
    // delivered to the paired server session as 'remoteSettings'
    // (flushed at first dispatch, or promptly once the server session
    // exists). One snapshot per settings() call, plus one for the
    // connect-time initial settings.
    this._pendingRemoteSettings = [];
    // H2-V4: streams owned by this session, so destroy() can tear
    // them down (a destroyed session closes its streams in Node).
    this._streams = new Set();
  }

  get closed() {
    return this._closed;
  }
  get destroyed() {
    return this._destroyed;
  }
  get connecting() {
    return this._connecting;
  }
  get encrypted() {
    return this[kEncrypted];
  }
  get alpnProtocol() {
    return undefined;
  } // no real TLS handshake
  get originSet() {
    return undefined;
  } // origins not tracked in emulation
  get socket() {
    return null;
  } // no real socket
  get type() {
    return constants.NGHTTP2_SESSION_CLIENT;
  }
  get pendingSettingsAck() {
    return this._pendingSettingsAck;
  }
  get localSettings() {
    return { ...this._localSettings };
  }
  get remoteSettings() {
    return { ...this._remoteSettings };
  }
  get state() {
    // H2-V4: nextStreamID and the window sizes are tracked for real;
    // the rest stay plausible static values (documented gap).
    return {
      effectiveLocalWindowSize: this._effectiveLocalWindowSize,
      effectiveReceiveDataLength: 0,
      nextStreamID: this._nextStreamID,
      localWindowSize: this._localWindowSize,
      lastProcStreamID: 0,
      remoteWindowSize: 65535,
      outboundQueueSize: 0,
      deflateDynamicTableSize: 4096,
      inflateDynamicTableSize: 4096,
    };
  }

  _assertUsable() {
    if (this._destroyed || this._closed) {
      throw http2Error(
        "ERR_HTTP2_INVALID_SESSION",
        "The session has been destroyed",
      );
    }
  }

  close(callback) {
    if (typeof callback !== "function" && callback !== undefined) {
      throw http2Error(
        "ERR_INVALID_ARG_TYPE",
        'The "callback" argument must be of type function',
      );
    }
    if (!this._closed) {
      this._closed = true;
      this._connecting = false;
      this.emit("close");
    }
    if (callback) setTimeout(callback, 0);
  }

  destroy(error, code = constants.NGHTTP2_NO_ERROR) {
    if (!this._destroyed) {
      this._destroyed = true;
      this._closed = true;
      this._connecting = false;
      if (error) this.emit("error", error);
      this.emit("close", code);
      // H2-V4: destroying a session tears down its streams (Node
      // closes the session's streams with 'close'). Only destroy()
      // does this — close() leaves streams alone.
      for (const stream of [...(this._streams || [])]) {
        if (!stream._destroyed) stream._destroy();
      }
    }
  }

  goaway(code = constants.NGHTTP2_NO_ERROR, lastStreamID = 0, opaqueData) {
    // H2-V4: Node lib/internal/http2/core.js:1588-1596 goaway() validates
    // even though nothing is sent on the wire in the browser emulation.
    if (this._destroyed) {
      throw http2Error(
        "ERR_HTTP2_INVALID_SESSION",
        "The session has been destroyed",
      );
    }
    if (opaqueData !== undefined) validateBuffer(opaqueData, "opaqueData");
    validateNumber(code, "code");
    validateNumber(lastStreamID, "lastStreamID");
    void code;
    void lastStreamID;
    void opaqueData;
  }

  ping(payload, callback) {
    if (typeof payload === "function") {
      callback = payload;
      payload = undefined;
    }
    this._assertUsable();
    const data = payload === undefined ? Buffer.alloc(8) : Buffer.from(payload);
    if (callback) {
      // Emulated: 0ms round-trip; no real PING frame is exchanged.
      setTimeout(() => callback(null, 0, data), 0);
    }
    return true;
  }

  ref() {
    return this;
  }
  unref() {
    return this;
  }

  setTimeout(msecs, callback) {
    // Noop: inactivity is not tracked, so no 'timeout' is ever emitted.
    // Kept for shape compatibility; the gap is documented.
    this._timeout = msecs;
    if (callback) this.once("timeout", callback);
  }

  settings(settings, callback) {
    // H2-V4: Node validates the callback like every other callback
    // (validateFunction); the settings values were already validated by
    // readSettingsEntries in earlier lanes.
    if (callback !== undefined) validateFunction(callback, "callback");
    const entries = readSettingsEntries(settings === undefined ? {} : settings);
    if (entries !== undefined) {
      for (const [id, value] of entries) {
        if (id === 6) {
          this._localSettings.maxHeaderListSize = value;
          this._localSettings.maxHeaderSize = value;
        } else {
          const name = SETTINGS_ID_TO_NAME[id];
          if (name !== undefined) {
            this._localSettings[name] = BOOLEAN_SETTINGS.has(name)
              ? value !== 0
              : value;
          }
        }
      }
    }
    this._pendingSettingsAck = false;
    const snapshot = { ...this._localSettings };
    queueMicrotask(() => this.emit("localSettings", snapshot));
    if (callback) setTimeout(() => callback(null, snapshot, 0), 0);
    // H2-V4: the peer learns these settings as its remoteSettings
    // (virtual SETTINGS exchange). Queued until the paired server
    // session exists, then applied + emitted in order.
    this._queueRemoteSettingsSnapshot(snapshot);
  }

  // H2-V4: queue one remoteSettings snapshot for the paired server
  // session (one per settings() call, plus the connect-time initial
  // settings). The snapshot is applied to the server session's
  // _remoteSettings synchronously once it exists (so pushAllowed reads
  // the right value in the stream handler) and the 'remoteSettings'
  // event is emitted on a microtask after that (so the server's
  // 'session' handler, queued first, has attached its listener).
  _queueRemoteSettingsSnapshot(snapshot) {
    if (!this._pendingRemoteSettings) this._pendingRemoteSettings = [];
    this._pendingRemoteSettings.push(snapshot);
    this._flushRemoteSettings();
  }

  _flushRemoteSettings() {
    const pending = this._pendingRemoteSettings;
    if (!pending || pending.length === 0) return;
    const server =
      this._virtualPort !== undefined
        ? serverRegistry.get(this._virtualPort)
        : undefined;
    const serverSession = server && server._serverSession;
    if (!serverSession) return;
    const snapshots = pending.splice(0, pending.length);
    for (const snapshot of snapshots) {
      Object.assign(serverSession._remoteSettings, snapshot);
      queueMicrotask(() => serverSession.emit("remoteSettings", snapshot));
    }
  }

  rstStream(stream, code = constants.NGHTTP2_NO_ERROR) {
    // Noop: tears down the local stream object only.
    if (stream && typeof stream.rstStream === "function")
      stream.rstStream(code);
  }

  priority(stream, prioritySpec) {
    // Noop: no PRIORITY frame is sent.
    void stream;
    void prioritySpec;
  }

  setLocalWindowSize(windowSize) {
    // H2-V4: Node lib/internal/http2/core.js setLocalWindowSize()
    // validates exactly: non-number -> ERR_INVALID_ARG_TYPE,
    // non-integer -> ERR_OUT_OF_RANGE ("It must be an integer"),
    // outside [0, 2147483647] -> ERR_OUT_OF_RANGE
    // ("It must be >= 0 && <= 2147483647"). Probe-proven messages.
    // No WINDOW_UPDATE frame is sent, but the state is tracked:
    // effective is the last set value, local is the high-water mark.
    validateInteger(
      windowSize,
      "windowSize",
      0,
      2147483647,
      "It must be >= 0 && <= 2147483647.",
    );
    this._effectiveLocalWindowSize = windowSize;
    if (windowSize > this._localWindowSize)
      this._localWindowSize = windowSize;
  }

  setNextStreamID(id) {
    // H2-V4: Node validateInteger(id, 'id', 1, 2**32-1) with the
    // '> 0 and <=' wording (probe-proven); the old shim threw
    // ERR_HTTP2_INVALID_STREAM for every bad id.
    validateInteger(
      id,
      "id",
      1,
      4294967295,
      "It must be > 0 and <= 4294967295.",
    );
    this._nextStreamID = id;
  }

  altsvc(alt, originOrStream) {
    // Noop: no ALTSVC frame is sent in the emulation. But validate like Node.
    if (typeof alt !== "string") {
      throw http2Error(
        "ERR_INVALID_ARG_TYPE",
        `The "alt" argument must be of type string.${invalidArgTypeHelper(alt)}`,
        TypeError,
      );
    }
    if (typeof originOrStream === "number") {
      // Numeric stream ID: must be > 0 && < 2^32. Non-existent streams
      // don't error, but out-of-range IDs do.
      if (
        !Number.isInteger(originOrStream) ||
        originOrStream <= 0 ||
        originOrStream >= 4294967296
      ) {
        throw http2Error(
          "ERR_OUT_OF_RANGE",
          `The value of "originOrStream" is out of range. It must be > 0 && < 4294967296. Received ${originOrStream}`,
          RangeError,
        );
      }
    }
    void alt;
    void originOrStream;
  }

  origin(...args) {
    // Noop: no ORIGIN frame is sent in the emulation.
    void args;
  }
}

class ClientHttp2Session extends Http2Session {
  constructor(options = {}) {
    super(options);
  }

  get type() {
    return constants.NGHTTP2_SESSION_CLIENT;
  }

  request(headers = {}, options = {}) {
    this._assertUsable();
    if (headers === null || typeof headers !== "object") {
      throw http2Error(
        "ERR_INVALID_ARG_TYPE",
        'The "headers" argument must be of type object',
      );
    }
    // H2-V6: flat [k, v, ...] arrays normalize like objects (Node
    // prepareRequestHeadersArray/Object); the normalized object is the
    // client's sentHeaders and the raw pairs feed the server rawHeaders.
    const { headersObject, rawPairs } = normalizeRequestHeaders(
      headers,
      this,
    );
    // H2-V4: Node lib/internal/http2/core.js request() validates the
    // options after the headers (assertIsObject + priority options +
    // endStream boolean). Header preparation throws first, like Node.
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== "object" ||
        Array.isArray(options))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options" argument must be of type object.${invalidArgTypeHelper(options)}`,
      );
    }
    options = options || {};
    if (options.endStream !== undefined)
      validateBoolean(options.endStream, "options.endStream");
    if (options.parent !== undefined)
      validateNumber(options.parent, "options.parent", 0);
    if (options.exclusive !== undefined)
      validateBoolean(options.exclusive, "options.exclusive");
    if (options.silent !== undefined)
      validateBoolean(options.silent, "options.silent");
    const stream = new Http2Stream(this, headersObject);
    stream._requestSentHeaders = headersObject;
    stream._requestRawPairs = rawPairs;
    stream._id = this._nextStreamID;
    this._nextStreamID += 2; // client-initiated streams use odd ids
    this._streams.add(stream);
    if (options.waitForTrailers) stream._requestWaitForTrailers = true;
    // H2-V4: a content-length on a payload-meaningless method (GET/HEAD/
    // DELETE) is rejected by nghttp2 with PROTOCOL_ERROR (probe-proven:
    // the stream errors and never reaches the server; content-length: 0
    // is fine). Emulated here because there is no real nghttp2.
    const contentLength = headersObject["content-length"];
    const clNum =
      contentLength === undefined ? NaN : Number(contentLength);
    const method = headersObject[":method"];
    if (
      kNoPayloadMethods.has(method) &&
      contentLength !== undefined &&
      (Number.isNaN(clNum) || clNum > 0)
    ) {
      queueMicrotask(() => {
        if (!stream._destroyed) {
          stream._destroyed = true;
          stream._closed = true;
        }
        if (stream.listenerCount("error") > 0) {
          stream.emit(
            "error",
            http2Error(
              "ERR_HTTP2_STREAM_ERROR",
              "Stream closed with error code NGHTTP2_PROTOCOL_ERROR",
            ),
          );
        }
        stream._emitCloseOnce(constants.NGHTTP2_NO_ERROR);
      });
      return stream;
    }
    // Dispatch to the virtual server on the next microtask, mirroring the
    // async nature of real HEADERS transmission.
    queueMicrotask(() => dispatchVirtualRequest(this, stream));
    if (options && options.endStream) stream.end();
    return stream;
  }
}

class ServerHttp2Session extends Http2Session {
  constructor(options = {}) {
    super(options);
  }

  get type() {
    return constants.NGHTTP2_SESSION_SERVER;
  }
}

// ---------------------------------------------------------------------------
// 6. Http2Stream — real method shapes. In the virtual loop one stream object
//    is shared between the client and server sides (documented
//    simplification); the whole response body is delivered as one 'data'
//    chunk. Not a real Duplex: no backpressure. Request-side 'data'/'end'
//    are delivered lazily once the client ends the request (see
//    _deliverRequestBody, H2-V1); before that the body is still in flight.
// ---------------------------------------------------------------------------

class Http2Stream extends EventEmitter {
  constructor(session = null, headers = {}) {
    super();
    this.session = session;
    this._requestHeaders = { ...headers };
    this._id = 0; // 0 = not yet assigned; real ids come from the session
    this._closed = false;
    this._destroyed = false;
    this._aborted = false;
    this._rstCode = constants.NGHTTP2_NO_ERROR;
    // H2-V4: 'close' fires exactly once (see _emitCloseOnce).
    this._closeEmitted = false;
    this._sentHeaders = null;
    // H2-V6: the client's request headers, kept apart from _sentHeaders
    // (the response headers) — _responseStarted keys on _sentHeaders
    // being non-null, so storing the request headers there would make
    // the client's end() take the server branch and deliver a response
    // made of request headers. sentHeaders returns the response
    // headers once respond() has run, else the request headers.
    this._requestSentHeaders = null;
    // H2-V6: flat [k, v, ...] pairs as given (request) / as normalized
    // (response); the wire-order rawHeaders are derived from these.
    this._requestRawPairs = null;
    this._responseRawPairs = null;
    this._sentInfoHeaders = [];
    this._sentTrailers = null;
    this._requestChunks = []; // client -> server
    this._responseChunks = []; // server -> client
    this._requestEnded = false;
    this._responseDelivered = false;
    this._timeout = 0;
    // Request-body lazy delivery (H2-V1): the virtual loop dispatches on a
    // microtask, before the client has written anything, so a server-side
    // body consumer must wait for the client stream's 'finish' and then
    // read requestBody live. _dataListenersAtDispatch snapshots the
    // client-side 'data' listeners so a server-side consumer added by the
    // handler can be told apart from them.
    this._dataListenersAtDispatch = 0;
    this._requestBodyDeliveryStarted = false;
    this._requestEndEmitted = false;
    this._responsePending = false;
    // H2-V1: the server has ended the response (stream.end() classified
    // as the server's end, or Http2ServerResponse.end() via _endResponse).
    // _deliverResponse waits for this once the body was awaited, so a
    // response body piped in the body-end handler is not lost.
    this._responseEnded = false;
    // H2-V4: trailers state. The virtual loop shares one stream object
    // between client and server, so the two sides' trailers are tracked
    // separately: _requestTrailers (client -> server, read by the server
    // as request.trailers / the stream 'trailers' event) and
    // _sentTrailers (server -> client, read by _deliverResponse).
    // _requestWaitForTrailers / _responseWaitForTrailers record which
    // side asked for trailers; _trailersReady is per side; _trailersSide
    // is the side whose 'wantTrailers' is currently being emitted (so
    // sendTrailers knows which store to write); _clientWantTrailers
    // snapshots the 'wantTrailers' listeners registered before dispatch
    // (the client's) so the server-side emit does not re-invoke them.
    this._requestWaitForTrailers = false;
    this._responseWaitForTrailers = false;
    this._trailersReady = { request: false, response: false };
    this._trailersSent = { request: false, response: false };
    this._trailersSide = null;
    this._clientWantTrailers = null;
    this._requestTrailers = null;
    this._requestTrailerPairs = null;
    // H2-V4: 'end' is emitted at most once per stream (guarded across
    // _deliverRequestBody, _deliverResponse, destroy() and end()).
    this._endEmitted = false;
  }

  get id() {
    return this._id;
  }
  get closed() {
    return this._closed;
  }
  get destroyed() {
    return this._destroyed;
  }
  get pending() {
    return this._id === 0;
  }
  get rstCode() {
    return this._rstCode;
  }
  get aborted() {
    return this._aborted;
  }
  get headersSent() {
    return this._sentHeaders !== null;
  }
  get pushAllowed() {
    // H2-V4: push is allowed only when the peer (client) has not
    // disabled it — read from the paired server session's remote
    // settings, which the virtual SETTINGS exchange keeps current.
    // Before dispatch (no server session yet) this is false: a client
    // stream cannot push.
    return !!(
      this._serverSession &&
      this._serverSession._remoteSettings &&
      this._serverSession._remoteSettings.enablePush === true
    );
  } // push is impossible in the emulation
  get sentHeaders() {
    // H2-V6: real Node returns a null-prototype object (deepStrictEqual
    // against { __proto__: null, ... } in the official tests). The
    // response headers win once respond() has run; before that the
    // client's request headers are the sent headers.
    const src = this._sentHeaders || this._requestSentHeaders;
    if (!src) return null;
    const copy = { __proto__: null };
    return Object.assign(copy, src);
  }
  get sentInfoHeaders() {
    return this._sentInfoHeaders.map((h) => ({ ...h }));
  }
  get sentTrailers() {
    return this._sentTrailers ? { ...this._sentTrailers } : null;
  }
  get headRequest() {
    return (this._requestHeaders[":method"] || "").toUpperCase() === "HEAD";
  }
  get endAfterHeaders() {
    return false;
  }
  get bufferSize() {
    return this._responseChunks.reduce((n, c) => n + c.length, 0);
  }
  get state() {
    // Emulated static values; documented gap.
    return {
      localWindowSize: 65535,
      sumDependencyWeight: 0,
      weight: 16,
      localClose: this._closed ? 1 : 0,
      remoteClose: 0,
    };
  }

  abort() {
    this._aborted = true;
    this.destroy();
  }

  additionalHeaders(headers) {
    // H2-V4: Node lib/internal/http2/core.js additionalHeaders() —
    // destroyed/closed -> ERR_HTTP2_INVALID_STREAM; after respond ->
    // ERR_HTTP2_HEADERS_AFTER_RESPOND; a :status must be 1xx (101 is
    // its own error); other headers go through the response validator.
    if (this._destroyed || this._closed) {
      throw http2Error(
        "ERR_HTTP2_INVALID_STREAM",
        "The stream has been destroyed",
      );
    }
    if (this.headersSent) {
      throw http2Error(
        "ERR_HTTP2_HEADERS_AFTER_RESPOND",
        "Cannot specify additional headers after response initiated",
      );
    }
    if (
      headers !== undefined &&
      (headers === null ||
        typeof headers !== "object" ||
        Array.isArray(headers))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "headers" argument must be of type object.${invalidArgTypeHelper(headers)}`,
      );
    }
    headers = headers || {};
    if (headers[":status"] != null) {
      const statusCode = headers[":status"] | 0;
      if (statusCode === 101) {
        throw http2Error(
          "ERR_HTTP2_STATUS_101",
          "HTTP status code 101 (Switching Protocols) is forbidden in HTTP/2",
        );
      }
      if (statusCode < 100 || statusCode >= 200) {
        throw http2Error(
          "ERR_HTTP2_INVALID_INFO_STATUS",
          `Invalid informational status code: ${headers[":status"]}`,
          RangeError,
        );
      }
    }
    validateHeaderList(
      pairsFromObject(headers),
      assertValidPseudoHeaderResponse,
    );
    // Informational headers are recorded locally only.
    if (headers && typeof headers === "object") {
      this._sentInfoHeaders.push({ ...headers });
    }
  }

  info(headers) {
    this.additionalHeaders(headers);
  }

  // H2-V4: the real destroy implementation, exposed as _destroy so the
  // official tests can wrap it (test-http2-client-rststream-before-
  // connect replaces req._destroy with a mustCall wrapper and expects
  // the close flow to call it). Idempotent: a second call is a noop.
  _destroy(err, callback) {
    if (this._destroyed) {
      if (typeof callback === "function") callback();
      return this;
    }
    this._destroyed = true;
    this._closed = true;
    // H2-V4: drop out of the owning sessions' stream sets (destroy()
    // iterates them; deleting during iteration is safe for a Set).
    if (this.session && this.session._streams)
      this.session._streams.delete(this);
    if (this._serverSession && this._serverSession._streams)
      this._serverSession._streams.delete(this);
    if (err) this.emit("error", err);
    this._emitCloseOnce(this._rstCode);
    if (typeof callback === "function") callback();
    return this;
  }

  // H2-V4: a stream emits 'close' exactly once (Node). _deliverResponse
  // and _destroy both close the stream, and a close() racing a delivery
  // used to emit it twice (test-http2-misused-pseudoheaders).
  _emitCloseOnce(code) {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close", code);
  }

  close(code = constants.NGHTTP2_NO_ERROR, callback) {
    if (typeof code === "function") {
      callback = code;
      code = constants.NGHTTP2_NO_ERROR;
    }
    // H2-V4: Node lib/internal/http2/core.js close() — validateInteger
    // (code in [0, 2^32-1]) then validateFunction (callback). A second
    // close is a no-op, like Node.
    validateInteger(
      code,
      "code",
      0,
      4294967295,
      "It must be >= 0 && <= 4294967295.",
    );
    if (callback !== undefined) validateFunction(callback, "callback");
    if (this._closed) return;
    this._rstCode = code;
    this._closed = true;
    if (callback !== undefined) this.once("close", callback);
    // The RST_STREAM reaches the peer asynchronously (probe-proven:
    // the server's stream handler still runs after a client close(),
    // and its 'error'/'close' fire after the client's). So the close
    // completes on a microtask: NO_ERROR ends the readable side
    // gracefully ('end' then 'close'); PROTOCOL_ERROR errors both sides
    // ('error' then 'close'); other codes just close.
    queueMicrotask(() => {
      if (code === constants.NGHTTP2_NO_ERROR) this._emitEndOnce();
      if (
        code === constants.NGHTTP2_PROTOCOL_ERROR &&
        this.listenerCount("error") > 0
      ) {
        this.emit(
          "error",
          http2Error(
            "ERR_HTTP2_STREAM_ERROR",
            "Stream closed with error code NGHTTP2_PROTOCOL_ERROR",
          ),
        );
      }
      this._destroy();
    });
  }

  // Emit 'end' at most once (shared by close(), destroy() and end()).
  _emitEndOnce() {
    if (this._endEmitted) return;
    this._endEmitted = true;
    this.emit("end");
  }

  destroy(error) {
    if (!this._destroyed) {
      // H2-V4: destroying a stream with no error ends its readable side
      // too (the client 'end' fires when the server destroys the stream
      // before responding, as in test-http2-respond-errors); destroying
      // with an error emits 'error' instead, like a real stream.
      if (!error) this._emitEndOnce();
      this._destroy(error);
    }
  }

  priority(options) {
    // Noop: no PRIORITY frame is sent.
    void options;
  }

  rstStream(code = constants.NGHTTP2_NO_ERROR, callback) {
    this._rstCode = code;
    this.destroy();
    if (callback) setTimeout(callback, 0);
  }

  setTimeout(msecs, callback) {
    // Noop: inactivity is not tracked; documented gap.
    this._timeout = msecs;
    if (callback) this.once("timeout", callback);
  }

  respond(headers = {}, options = {}) {
    // H2-V4: Node lib/internal/http2/core.js respond() — destroyed or
    // closed -> ERR_HTTP2_INVALID_STREAM (checked first: after a
    // destroy() the headers-sent flag is also set); headers already sent
    // -> ERR_HTTP2_HEADERS_SENT; options must be an object. The :status
    // range and header validation live in normalizeResponseHeaders.
    if (this._destroyed || this._closed) {
      throw http2Error(
        "ERR_HTTP2_INVALID_STREAM",
        "The stream has been destroyed",
      );
    }
    if (this.headersSent) {
      throw http2Error(
        "ERR_HTTP2_HEADERS_SENT",
        "Response has already been initiated.",
      );
    }
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== "object" ||
        Array.isArray(options))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options" argument must be of type object.${invalidArgTypeHelper(options)}`,
      );
    }
    options = options || {};
    // Noop on the wire: records response headers locally. The virtual
    // server delivers them when the response is ended.
    // H2-V6: array-form headers normalize like objects (Node
    // prepareResponseHeadersArray/Object); :status defaults to 200 and
    // a date is added unless one is present or options.sendDate is false.
    const { headersObject, rawPairs } = normalizeResponseHeaders(
      headers,
      options,
      this._serverSession
        ? this._serverSession._strictSingleValueFields !== false
        : true,
    );
    this._sentHeaders = headersObject;
    this._responseRawPairs = rawPairs;
    if (options.waitForTrailers) this._responseWaitForTrailers = true;
  }

  respondWithFD(fd, headers = {}, options = {}) {
    // H2-V4: Node lib/internal/http2/core.js respondWithFD() validates
    // (destroyed/closed, headers-sent, options types, fd type, then
    // the response headers incl. the 204/205/304 payload rule) and only
    // then reads the file. No file descriptors exist in the browser, so
    // after validation this stays a noop — every official test that
    // reaches a successful call expects the validation to throw first.
    if (this._destroyed || this._closed) {
      throw http2Error(
        "ERR_HTTP2_INVALID_STREAM",
        "The stream has been destroyed",
      );
    }
    if (this.headersSent) {
      throw http2Error(
        "ERR_HTTP2_HEADERS_SENT",
        "Response has already been initiated.",
      );
    }
    this._validateRespondWithOptions(options);
    if (typeof fd !== "number") {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "fd" argument must be of type number or an instance of FileHandle.${invalidArgTypeHelper(fd)}`,
      );
    }
    const { statusCode } = this._prepareFileResponseHeaders(
      headers,
      options,
    );
    void statusCode;
    void fd;
  }

  respondWithFile(path, headers = {}, options = {}) {
    // H2-V4: Node lib/internal/http2/core.js respondWithFile() — same
    // validation order as respondWithFD (minus the fd check), then the
    // file is opened. No filesystem file delivery in the browser, so
    // after validation this stays a noop.
    if (this._destroyed || this._closed) {
      throw http2Error(
        "ERR_HTTP2_INVALID_STREAM",
        "The stream has been destroyed",
      );
    }
    if (this.headersSent) {
      throw http2Error(
        "ERR_HTTP2_HEADERS_SENT",
        "Response has already been initiated.",
      );
    }
    this._validateRespondWithOptions(options);
    const { statusCode } = this._prepareFileResponseHeaders(
      headers,
      options,
    );
    void statusCode;
    void path;
  }

  // Shared by respondWithFD/respondWithFile: the options type checks
  // (offset/length numbers, statCheck a function) and the response
  // headers, including the 204/205/304 payload-forbidden rule (Node
  // lib/internal/http2/core.js:3155-3163 / 3215-3223). The :status range
  // check is inside normalizeResponseHeaders.
  _validateRespondWithOptions(options) {
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== "object" ||
        Array.isArray(options))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options" argument must be of type object.${invalidArgTypeHelper(options)}`,
      );
    }
    options = options || {};
    if (options.offset !== undefined && typeof options.offset !== "number")
      throw invalidArgValue("options.offset", options.offset);
    if (options.length !== undefined && typeof options.length !== "number")
      throw invalidArgValue("options.length", options.length);
    if (
      options.statCheck !== undefined &&
      typeof options.statCheck !== "function"
    )
      throw invalidArgValue("options.statCheck", options.statCheck);
    if (options.waitForTrailers) this._responseWaitForTrailers = true;
  }

  _prepareFileResponseHeaders(headers, options) {
    const { headersObject } = normalizeResponseHeaders(
      headers,
      options,
      this._serverSession
        ? this._serverSession._strictSingleValueFields !== false
        : true,
    );
    const statusCode = headersObject[":status"];
    if (
      statusCode === 204 ||
      statusCode === 205 ||
      statusCode === 304 ||
      this.headRequest
    ) {
      throw http2Error(
        "ERR_HTTP2_PAYLOAD_FORBIDDEN",
        `Responses with ${statusCode} status must not have a payload`,
      );
    }
    return { headersObject, statusCode };
  }

  sendTrailers(headers) {
    // H2-V4: Node lib/internal/http2/core.js sendTrailers() — the
    // trailers state machine. Destroyed/closed -> INVALID_STREAM;
    // before the side's 'wantTrailers' fires -> NOT_READY; a second
    // send for the same side -> ALREADY_SENT. Pseudo-headers are never
    // valid in trailers (assertValidPseudoHeaderTrailer). Names are
    // lowercased and values stringified (Node buildNgHeaderString).
    // The side is the one whose 'wantTrailers' is being emitted
    // (_trailersSide, set by _emitWantTrailers); the two sides keep
    // separate stores on this shared stream object.
    if (this._destroyed || this._closed) {
      throw http2Error(
        "ERR_HTTP2_INVALID_STREAM",
        "The stream has been destroyed",
      );
    }
    const side = this._trailersSide;
    if (!side || !this._trailersReady[side]) {
      throw http2Error(
        "ERR_HTTP2_TRAILERS_NOT_READY",
        "Trailing headers cannot be sent until after the wantTrailers event is emitted",
      );
    }
    if (this._trailersSent[side]) {
      throw http2Error(
        "ERR_HTTP2_TRAILERS_ALREADY_SENT",
        "Trailing headers have already been sent",
      );
    }
    const pairs = normalizeTrailerPairs(headers);
    validateHeaderList(pairs, assertValidPseudoHeaderTrailer);
    if (side === "request") {
      this._requestTrailerPairs = pairs;
      this._requestTrailers = foldToHeaderObject(pairs);
    } else {
      this._sentTrailers = foldToHeaderObject(pairs);
    }
    this._trailersSent[side] = true;
  }

  // H2-V4: emit 'wantTrailers' for one side only. The virtual loop
  // shares one stream object between client and server, but the two
  // sides register their 'wantTrailers' listeners at different times:
  // the client's before dispatch, the server's in the stream handler.
  // _clientWantTrailers snapshots the pre-dispatch listeners; the
  // request-side emit invokes those, the response-side emit invokes
  // the rest. Invoked directly (not via emit()) so the other side's
  // listeners do not fire. Sets _trailersSide + the side's ready flag
  // first, so a synchronous sendTrailers in the handler is accepted.
  _emitWantTrailers(side) {
    this._trailersSide = side;
    this._trailersReady[side] = true;
    const snapshot = this._clientWantTrailers;
    let targets;
    if (side === "request") {
      targets = snapshot || this.listeners("wantTrailers");
    } else {
      const all = this.listeners("wantTrailers");
      targets = snapshot ? all.filter((fn) => !snapshot.includes(fn)) : [];
    }
    for (const fn of [...targets]) fn.call(this);
    this._trailersSide = null;
  }

  // H2-V4: emit 'data' to one side only (same shared-object split as
  // 'trailers'). Request-body chunks go to the server's consumers
  // (registered at dispatch); response chunks go to the rest (the
  // client's pre-dispatch listeners plus any it registered in its
  // 'response' handler).
  _emitData(chunk, side) {
    const serverListeners = this._serverDataListeners || [];
    const all = this.listeners("data");
    const targets =
      side === "request"
        ? serverListeners
        : all.filter((fn) => !serverListeners.includes(fn));
    for (const fn of [...targets]) fn.call(this, chunk);
  }

  // H2-V4: emit 'trailers' to one side only. The virtual loop shares
  // one stream object, but request trailers belong to the server and
  // response trailers to the client. _serverTrailersListeners holds the
  // listeners the server registered at dispatch ('stream'/'request'
  // handlers); request trailers go to those, response trailers to the
  // rest (the client's pre-dispatch listeners plus any it registered
  // in its 'response' handler).
  _emitTrailers(headers, side) {
    const serverListeners = this._serverTrailersListeners || [];
    const all = this.listeners("trailers");
    const targets =
      side === "request"
        ? serverListeners
        : all.filter((fn) => !serverListeners.includes(fn));
    for (const fn of [...targets]) fn.call(this, headers, 0);
  }

  pushStream(headers, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    // H2-V4: Node lib/internal/http2/core.js pushStream() checks
    // pushAllowed FIRST (sync throw when the client disabled push),
    // then the callback, then the headers (connection-specific headers
    // throw ERR_HTTP2_INVALID_CONNECTION_HEADERS via the request
    // validator). Push itself is impossible in the browser emulation,
    // so a fully valid call still reports ERR_HTTP2_PUSH_DISABLED
    // asynchronously, as before.
    if (!this.pushAllowed) {
      throw http2Error(
        "ERR_HTTP2_PUSH_DISABLED",
        "HTTP/2 client has disabled push streams",
      );
    }
    validateFunction(callback, "callback");
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== "object" ||
        Array.isArray(options))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options" argument must be of type object.${invalidArgTypeHelper(options)}`,
      );
    }
    if (
      headers !== undefined &&
      (headers === null ||
        typeof headers !== "object" ||
        Array.isArray(headers))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "headers" argument must be of type object.${invalidArgTypeHelper(headers)}`,
      );
    }
    validateHeaderList(
      normalizeTrailerPairs(headers || {}),
      assertValidPseudoHeader,
    );
    // H2-V4: when push is allowed, this actually creates the push
    // stream (Node lib/internal/http2/core.js pushStream()): an
    // even-id stream on the client session, delivered via the client's
    // 'stream' event. The server's callback fires asynchronously with
    // (null, pushStream, headers, options), like Node. When push is
    // disabled the sync throw above already fired, so a fully valid
    // call never reaches the old async PUSH_DISABLED callback.
    const serverSession = this._serverSession;
    const pushId = serverSession._nextPushStreamID;
    serverSession._nextPushStreamID += 2;
    const { headersObject, rawPairs } = normalizeRequestHeaders(
      headers || {},
      this.session,
    );
    const pushStream = new Http2Stream(this.session, headersObject);
    pushStream._id = pushId;
    pushStream._isPush = true;
    pushStream._serverSession = serverSession;
    // A push stream has no request body to wait for: mark the body
    // delivery as complete (a dedicated flag — _requestEndEmitted
    // must stay false so _deliverResponse still emits 'end').
    pushStream._requestBodyDeliveryStarted = true;
    pushStream._requestBodyComplete = true;
    this.session.emit("stream", pushStream, headersObject, 0, rawPairs);
    if (callback) {
      queueMicrotask(() =>
        callback(null, pushStream, headersObject, {}),
      );
    }
  }

  // -- shared write/end: route by side ------------------------------------
  // The client writes the request body strictly before it ends the
  // request, so until _requestEnded any write is a request chunk — even
  // after the server has responded. (The old _responseStarted test routed
  // a piped upload written after respond() into the response body, so
  // requestBody stayed empty and the body arrived as 0 bytes — H2-V1
  // probe-proven.) Once the request has ended, writes are response data.
  // Known shared-stream limit: a server early-response write while the
  // request is still in flight would land in the request body; the compat
  // res.write() path bypasses this router via _writeResponse directly.
  get _responseStarted() {
    return this._sentHeaders !== null || this._responseDelivered;
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this._requestEnded) {
      this._writeResponse(chunk, encoding);
    } else {
      const buf =
        typeof chunk === "string"
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk);
      this._requestChunks.push(buf);
    }
    if (callback) setTimeout(callback, 0);
    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === "function") {
      callback = data;
      data = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    // H2-V4: the client ends exactly once, so an end() that lands after
    // the client already ended — with response data but no respond()
    // call yet — is the server's end (test-http2-server-push-stream-
    // errors-args: stream.end("test") with no respond() must deliver a
    // 200 + the data). Route its payload as a response and deliver.
    const wasRequestEnded = this._requestEnded;
    if (data !== undefined && data !== null) {
      // Route the end() payload by side, not via write(): the server ends
      // with response data once respond() has run (test-http2-async-local-
      // storage calls stream.end("data") while the client request is still
      // un-ended), while the client ends with request data. write() routes
      // by _requestEnded; end() must route by _responseStarted.
      if (this._responseStarted) this._writeResponse(data, encoding);
      else this.write(data, encoding);
    }
    if (this._responseStarted) {
      // Shared stream: distinguish the client's end() (completes the
      // request) from the server's end() (completes the response). The
      // client ends exactly once, so once _requestEnded is set any later
      // end() is the server's. For the first end():
      // - If the response already ended or was delivered, this can only
      //   be the client's end (the server already ended once).
      // - Else, a first end() with request bytes buffered is the client's
      //   end: the server's first end() lands synchronously in the
      //   dispatch handler, before the client has written anything
      //   (test-http2-zero-length-write: the client ends first after
      //   piping a file; the server ends later, via pipe in the body-end
      //   handler). The server's first end() must NOT mark the request
      //   ended — the client may still be writing.
      // Known shared-stream limits: a client end() with an empty body
      // that lands before any server end() is not distinguishable from
      // the server's own first end(); a server end() that lands after
      // the client wrote (but before it ended) is not distinguishable
      // from the client's end().
      const clientEnd =
        !this._requestEnded &&
        (this._responseEnded ||
          this._responseDelivered ||
          this._requestChunks.length > 0);
      if (clientEnd) {
        if (!this._requestEnded) {
          this._requestEnded = true;
          this.emit("finish");
        }
      } else {
        // The server's end: if it asked for trailers, emit
        // 'wantTrailers' first so its handler can send them before the
        // response is delivered.
        if (this._responseWaitForTrailers) this._emitWantTrailers("response");
        this._responseEnded = true;
      }
      this._deliverResponse();
    } else if (wasRequestEnded) {
      // H2-V4: the client already ended, so this end() is the server's
      // (it just never called respond()): deliver the default 200 +
      // whatever response data was written.
      this._responseEnded = true;
      this._deliverResponse();
    } else {
      // The client's end: if it asked for trailers, emit 'wantTrailers'
      // first so its handler can send them before the request completes.
      if (this._requestWaitForTrailers) this._emitWantTrailers("request");
      this._requestEnded = true;
      this.emit("finish");
      // H2-V4: ending a stream that was already reset closes its
      // readable side (test-http2-client-rststream-before-connect:
      // req.end() after req.close(1) still emits 'end').
      if (this._closed || this._destroyed) this._emitEndOnce();
    }
    if (callback) setTimeout(callback, 0);
    return this;
  }

  // -- Readable-side stream compatibility ---------------------------------
  // Http2Stream is an EventEmitter, not a real Duplex. These methods exist
  // so code written against the stream API doesn't crash. Data flows via
  // 'data'/'end' events from _deliverResponse() regardless of paused state,
  // so resume() is honest (not a fake): it just ensures flowing mode.
  setEncoding(encoding) {
    this._encoding = encoding || null;
    return this;
  }

  resume() {
    // Data is delivered via _deliverResponse() when the virtual server
    // responds; resume() ensures the stream is in flowing mode.
    return this;
  }

  pause() {
    // Noop: the virtual loop delivers the whole body as one chunk anyway.
    return this;
  }

  isPaused() {
    return false;
  }

  read(size) {
    // No buffered read API; data arrives via 'data' events.
    void size;
    return null;
  }

  pipe(dest, options) {
    const doEnd = !options || options.end !== false;
    this.on("data", (chunk) => dest.write(chunk));
    this.on("end", () => {
      if (doEnd && typeof dest.end === "function") dest.end();
    });
    return dest;
  }

  unpipe(dest) {
    void dest;
    return this;
  }

  unshift(chunk) {
    void chunk;
    return this;
  }

  wrap(stream) {
    void stream;
    return this;
  }

  // -- server side (used by Http2ServerResponse): response body -----------
  // Request-body lazy delivery (H2-V1): the virtual loop dispatches before
  // the client has written anything, so the body must be read live once
  // the client stream ends ('finish') and delivered as 'data' + 'end' on
  // this shared stream. Real Node does this per DATA frame
  // (lib/internal/http2/compat.js onStreamData/onStreamEnd); the shim
  // delivers the whole body as one chunk, like _deliverResponse does for
  // the response. If a response was already requested, it is delivered
  // right after the body (see _deliverResponse's _responsePending gate),
  // so the stream emits exactly one 'end'.
  _deliverRequestBody() {
    if (this._requestBodyDeliveryStarted) return;
    this._requestBodyDeliveryStarted = true;
    const deliver = () => {
      const body = this.requestBody;
      if (body.length > 0) {
        // H2-V4: side-scoped — the request body goes to the server's
        // consumers only, not the client's 'data' listener.
        this._emitData(
          this._encoding ? body.toString(this._encoding) : body,
          "request",
        );
      }
      this._requestEndEmitted = true;
      this._requestBodyComplete = true;
      this._emitEndOnce();
      // H2-V4: the client's trailers arrive after the body (Node emits
      // 'trailers' on the server stream once the request ends).
      // Side-scoped: only the server's listeners see request trailers.
      if (this._requestTrailers) {
        this._emitTrailers({ ...this._requestTrailers }, "request");
      }
      if (this._responsePending) {
        this._responsePending = false;
        this._deliverResponse();
      }
    };
    if (this._requestEnded) queueMicrotask(deliver);
    else this.once("finish", () => queueMicrotask(deliver));
  }

  _writeResponse(chunk, encoding) {
    const buf =
      typeof chunk === "string"
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk);
    this._responseChunks.push(buf);
  }

  _endResponse(data, encoding) {
    if (data !== undefined && data !== null)
      this._writeResponse(data, encoding);
    // Compat res.end(): the server has ended the response. If it asked
    // for trailers, emit 'wantTrailers' first so its handler can send
    // them before the response is delivered.
    if (this._responseWaitForTrailers) this._emitWantTrailers("response");
    this._responseEnded = true;
    this._deliverResponse();
  }

  _deliverResponse() {
    if (this._responseDelivered) return;
    // Request body still in flight; deliver the response once it lands.
    if (this._requestBodyDeliveryStarted && !this._requestBodyComplete) {
      this._responsePending = true;
      return;
    }
    if (!this._requestBodyDeliveryStarted) {
      // A server-side request-body consumer attached after dispatch (any
      // 'data' listener beyond the client-side ones snapshotted at
      // dispatch) means the handler wants the body: start lazy delivery
      // and hold the response until it lands, so 'end' fires after the
      // body instead of on an empty snapshot.
      const serverDataConsumers =
        this.listenerCount("data") - (this._dataListenersAtDispatch || 0);
      if (serverDataConsumers > 0) {
        this._deliverRequestBody();
        this._responsePending = true;
        return;
      }
    }
    // The body was awaited and has now landed, but the server has not
    // ended the response yet: it may still pipe a response body in the
    // body-end handler (test-http2-zero-length-write), so wait for the
    // server's end instead of delivering an empty response now.
    if (this._requestBodyDeliveryStarted && !this._responseEnded) {
      this._responsePending = true;
      return;
    }
    this._responseDelivered = true;
    const headers = this._sentHeaders || { ":status": 200 };
    const body = Buffer.concat(this._responseChunks);
    // H2-V6: the 'response' event carries rawHeaders as its 3rd
    // argument (Node: pseudo-headers first, then regulars, names
    // lowercased, duplicates in order, date last when auto-added).
    const rawHeaders = this._responseRawPairs
      ? toWireRawHeaders(this._responseRawPairs)
      : toWireRawHeaders(pairsFromObject(headers));
    // Client-side observable events, in real order.
    if (this._isPush) {
      // H2-V4: a push stream signals its response with a 'push' event
      // (Node Http2Stream 'push'), and the headers always carry a date.
      const pushHeaders = { ...headers };
      if (!pushHeaders.date) pushHeaders.date = new Date().toUTCString();
      this.emit("push", pushHeaders, 0);
    } else {
      this.emit("response", { ...headers }, 0, rawHeaders);
    }
    if (body.length > 0 && !this.headRequest) {
      // H2-V4: side-scoped — the response body goes to the client's
      // listeners only, not the server's request-body consumers.
      this._emitData(
        this._encoding ? body.toString(this._encoding) : body,
        "response",
      );
    }
    // H2-V4: side-scoped — only the client's listeners see response
    // trailers (the server's 'trailers' listener is for request
    // trailers and must not fire again here).
    if (this._sentTrailers)
      this._emitTrailers({ ...this._sentTrailers }, "response");
    // The request body already emitted 'end' (lazy delivery above); a
    // second one would double-fire the client's 'end' mustCalls.
    if (!this._requestEndEmitted) this._emitEndOnce();
    this._closed = true;
    this._emitCloseOnce(constants.NGHTTP2_NO_ERROR);
  }

  get requestBody() {
    return Buffer.concat(this._requestChunks);
  }
}

// ---------------------------------------------------------------------------
// 7. HTTP/2 <-> HTTP/1 compatibility layer (Http2ServerRequest/Response).
//    EventEmitters with the real property names; not real Readable/Writable
//    streams (documented gap). The request body is available via req.body.
// ---------------------------------------------------------------------------

export class Http2ServerRequest extends EventEmitter {
  constructor(stream, headers = {}) {
    super();
    this.stream = stream;
    this.headers = { ...headers };
    this.httpVersion = "2.0";
    this.httpVersionMajor = 2;
    this.httpVersionMinor = 0;
    // H2-V4: method/url/scheme/authority are prototype accessors now
    // (Node lib/internal/http2/compat.js:407-435) — the constructor
    // must NOT assign them (the method setter validates, and the
    // authority/scheme getters are read-only). The getters read the
    // live headers object, so a handler that sets request.method sees
    // it reflected in request.headers, like Node.
    // H2-V6: rawHeaders is the wire-order flat list — pseudo-headers
    // first, then regulars, names lowercased, duplicates in order
    // (Node buildNgHeaderString). The stream carries the request's raw
    // pairs; without them (host-bridge streams) derive from headers.
    this.rawHeaders = stream && stream._requestRawPairs
      ? toWireRawHeaders(stream._requestRawPairs)
      : toWireRawHeaders(pairsFromObject(this.headers));
    this._body = stream ? stream.requestBody : Buffer.alloc(0);
  }

  // H2-V4: Node lib/internal/http2/compat.js:407-435. method is a
  // validating setter (non-string -> ERR_INVALID_ARG_TYPE, blank after
  // trim -> ERR_INVALID_ARG_VALUE); url is a plain setter onto :path;
  // authority falls back to the Host header (util.js getAuthority);
  // scheme is a getter. There is no `path` property (it is undefined).
  get method() {
    return this.headers[":method"];
  }
  set method(method) {
    validateString(method, "method");
    if (method.trim() === "")
      throw invalidArgValue("method", method);
    this.headers[":method"] = method;
  }
  get url() {
    return this.headers[":path"];
  }
  set url(url) {
    this.headers[":path"] = url;
  }
  get scheme() {
    return this.headers[":scheme"];
  }
  get authority() {
    if (this.headers[":authority"] !== undefined)
      return this.headers[":authority"];
    return this.headers["host"];
  }
  // H2-V4: the request trailers the client sent (folded object) and
  // their wire-order flat list (Node Http2ServerRequest.trailers /
  // rawTrailers, read live from the stream).
  get trailers() {
    return this.stream && this.stream._requestTrailers
      ? { ...this.stream._requestTrailers }
      : {};
  }
  get rawTrailers() {
    if (!this.stream || !this.stream._requestTrailerPairs) return [];
    const out = [];
    for (const [k, v] of this.stream._requestTrailerPairs) out.push(k, v);
    return out;
  }

  get body() {
    // Read live: the virtual loop dispatches before the client has written
    // anything, so the construction-time snapshot is empty for streamed
    // bodies (H2-V1). The stream's requestBody is the current truth.
    return this.stream ? this.stream.requestBody : this._body;
  }
  get aborted() {
    return this.stream ? this.stream.aborted : false;
  }
  get complete() {
    return this.stream ? this.stream._requestEnded : true;
  }

  // -- Readable-side stream compatibility ---------------------------------
  // Http2ServerRequest is an EventEmitter, not a real Readable. The virtual
  // loop dispatches before the client has written anything, so the request
  // body is NOT captured at construction: resume()/pipe() wait for the
  // client stream's 'finish' and then read stream.requestBody live (H2-V1).
  // Real Node streams the body in as DATA frames arrive
  // (lib/internal/http2/compat.js onStreamData/onStreamEnd); the shim
  // delivers the whole body as one chunk once the client ends.
  setEncoding(encoding) {
    this._encoding = encoding || null;
    return this;
  }

  // Wait for the client stream to end, then deliver the live body.
  // Returns the deliver callback so resume()/pipe() share the wait.
  _deliverWhenEnded(deliver) {
    if (!this.stream || this.stream._requestEnded) {
      queueMicrotask(deliver);
    } else {
      this.stream.once("finish", () => queueMicrotask(deliver));
    }
  }

  resume() {
    if (!this._resumed) {
      this._resumed = true;
      this._deliverWhenEnded(() => {
        const body = this.stream ? this.stream.requestBody : this._body;
        const b = body && body.length ? body : null;
        queueMicrotask(() => {
          if (b) {
            this.emit(
              "data",
              this._encoding ? b.toString(this._encoding) : b,
            );
          }
          this.emit("end");
        });
      });
    }
    return this;
  }

  pause() {
    return this;
  }

  isPaused() {
    return false;
  }

  read(size) {
    void size;
    return null;
  }

  pipe(dest, options) {
    const doEnd = !options || options.end !== false;
    this._deliverWhenEnded(() => {
      const body = this.stream ? this.stream.requestBody : this._body;
      queueMicrotask(() => {
        if (body && body.length && typeof dest.write === "function")
          dest.write(body);
        if (doEnd && typeof dest.end === "function") dest.end();
      });
    });
    return dest;
  }

  unpipe(dest) {
    void dest;
    return this;
  }

  unshift(chunk) {
    void chunk;
    return this;
  }

  setTimeout(msecs, callback) {
    // Noop: no real sockets; documented gap.
    void msecs;
    if (typeof callback === "function") this.once("timeout", callback);
    return this;
  }
}

export class Http2ServerResponse extends EventEmitter {
  constructor(stream) {
    super();
    this.stream = stream;
    this._statusCode = 200;
    // H2-V3: no `this.statusMessage = undefined` here — Node
    // (lib/internal/http2/compat.js:698-706) defines statusMessage as a
    // prototype getter/setter pair; assigning in the constructor would burn
    // the warn-once guard before any test read.
    this._headers = {};
    this._headersSent = false;
    this.sendDate = true;
  }

  get statusCode() {
    return this._statusCode;
  }

  set statusCode(code) {
    // Validate like Node: 1xx via statusCode setter is not allowed (use
    // writeHead for informational), out-of-range throws.
    if (!Number.isInteger(code) || code < 100 || code > 599) {
      throw http2Error(
        "ERR_HTTP2_STATUS_INVALID",
        `Invalid status code: ${code}`,
        RangeError,
      );
    }
    if (code >= 100 && code < 200) {
      throw http2Error(
        "ERR_HTTP2_INFO_STATUS_NOT_ALLOWED",
        `Informational status code ${code} not allowed via statusCode setter`,
        RangeError,
      );
    }
    this._statusCode = code;
  }

  // H2-V3: Node (lib/internal/http2/compat.js:698-706) — the getter warns
  // once and always returns ''; the setter warns once and discards the
  // value. writeHead's `this.statusMessage = statusMessage` assignment
  // routes through this setter, matching Node's writeHead warning on a
  // string statusMessage (compat.js:722-723).
  get statusMessage() {
    statusMessageWarn();
    return "";
  }

  set statusMessage(msg) {
    void msg;
    statusMessageWarn();
  }

  setHeader(name, value) {
    // H2-V4: Node lib/internal/http2/compat.js setHeader /
    // [kSetHeader]: validateString first, throw if headers are already
    // sent, then the name is trimmed + lowercased BEFORE
    // assertValidHeader — so " test" is accepted (it becomes "test")
    // while "t est" throws ERR_INVALID_HTTP_TOKEN and ":path" throws
    // ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED. A connection header is
    // dropped silently with a warning (Node isConnectionHeaderAllowed),
    // not stored.
    validateString(name, "name");
    if (this._headersSent) {
      throw http2Error(
        "ERR_HTTP2_HEADERS_SENT",
        "Response has already been initiated.",
      );
    }
    const lowered = name.trim().toLowerCase();
    assertValidHeader(lowered, value);
    if (
      lowered === "connection" ||
      lowered === "upgrade" ||
      lowered === "http2-settings" ||
      lowered === "keep-alive" ||
      lowered === "proxy-connection" ||
      lowered === "transfer-encoding" ||
      (lowered === "te" && value !== "trailers")
    ) {
      return this;
    }
    if (lowered[0] === ":") assertValidPseudoHeader(lowered);
    else if (!checkIsHttpToken(lowered)) {
      throw typeError(
        "ERR_INVALID_HTTP_TOKEN",
        `Header name must be a valid HTTP token ["${lowered}"]`,
      );
    }
    this._headers[lowered] = value;
    return this;
  }

  getHeader(name) {
    return this._headers[name.toLowerCase()];
  }
  getHeaders() {
    return { ...this._headers };
  }
  getHeaderNames() {
    return Object.keys(this._headers);
  }
  hasHeader(name) {
    return name.toLowerCase() in this._headers;
  }
  removeHeader(name) {
    delete this._headers[name.toLowerCase()];
  }

  writeHead(statusCode, statusMessage, headers) {
    // H2-V4: Node (lib/internal/http2/compat.js:717-718) — a closed or
    // destroyed stream makes writeHead a silent noop (return this),
    // checked BEFORE the headers-sent throw. The V2 gate below only
    // throws when the stream is still open.
    if (this.stream._closed || this.stream._destroyed) return this;
    // H2-V2: Node (lib/internal/http2/compat.js:719-720) throws
    // ERR_HTTP2_HEADERS_SENT on a second writeHead — unless the stream is
    // already closed/destroyed, in which case writeHead is a noop
    // (compat.js:717-718). The gate matters: the compat writehead test
    // calls writeHead(300) again after 'finish' and asserts it does NOT
    // throw — by then _deliverResponse has set stream._closed = true.
    if (
      this._headersSent &&
      !this.stream._closed &&
      !this.stream._destroyed
    ) {
      throw http2Error(
        "ERR_HTTP2_HEADERS_SENT",
        "Response has already been initiated.",
      );
    }
    if (typeof statusMessage === "object" && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    // writeHead allows 1xx (informational); the statusCode setter does not.
    // Validate range only.
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw http2Error(
        "ERR_HTTP2_STATUS_INVALID",
        `Invalid status code: ${statusCode}`,
        RangeError,
      );
    }
    this._statusCode = statusCode;
    if (statusMessage !== undefined) this.statusMessage = statusMessage;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    }
    const out = { ":status": statusCode, ...this._headers };
    // H2-V6: the compat response's sendDate flag flows into respond()
    // (Node lib/internal/http2/compat.js:900) — a handler that sets
    // response.sendDate = false must get no auto date.
    this.stream.respond(out, { sendDate: this.sendDate });
    this._headersSent = true;
    return this;
  }

  get headersSent() {
    return this._headersSent;
  }

  write(chunk, encoding, callback) {
    if (!this._headersSent) this.writeHead(this.statusCode);
    this.stream._writeResponse(chunk, encoding);
    if (typeof encoding === "function") callback = encoding;
    if (callback) setTimeout(callback, 0);
    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === "function") {
      callback = data;
      data = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (!this._headersSent) this.writeHead(this.statusCode);
    this.stream._endResponse(data, encoding);
    this.emit("finish");
    if (callback) setTimeout(callback, 0);
    return this;
  }

  // -- Writable-side compatibility ----------------------------------------
  createPushResponse(headers, callback) {
    // H2-V4: Node lib/internal/http2/compat.js:878-891 — validate the
    // callback FIRST (a missing/non-function callback throws
    // ERR_INVALID_ARG_TYPE synchronously); a closed stream reports
    // ERR_HTTP2_INVALID_STREAM to the callback asynchronously;
    // otherwise delegate to the stream's pushStream, which creates
    // the push stream and wraps it in a new Http2ServerResponse.
    validateFunction(callback, "callback");
    if (this.stream._closed || this.stream._destroyed) {
      queueMicrotask(() =>
        callback(
          http2Error(
            "ERR_HTTP2_INVALID_STREAM",
            "The stream has been destroyed",
          ),
        ),
      );
      return;
    }
    this.stream.pushStream(headers, {}, (err, pushStream) => {
      if (err) {
        callback(err);
        return;
      }
      callback(null, new Http2ServerResponse(pushStream));
    });
  }

  writeEarlyHints(hints, callback) {
    // H2-V4: Node lib/internal/http2/compat.js writeEarlyHints() —
    // hints must be an object; every non-link key is trimmed +
    // lowercased and validated with assertValidHeader (empty/spaced
    // names -> ERR_INVALID_HTTP_TOKEN, undefined/null values ->
    // ERR_HTTP2_INVALID_HEADER_VALUE) plus the token check. The hints
    // themselves are not transmitted in the emulation, but the callback
    // contract is honored asynchronously.
    if (
      hints === undefined ||
      hints === null ||
      typeof hints !== "object" ||
      Array.isArray(hints)
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "hints" argument must be of type object.${invalidArgTypeHelper(hints)}`,
      );
    }
    for (const key of Object.keys(hints)) {
      if (key === "link") continue;
      const name = key.trim().toLowerCase();
      assertValidHeader(name, hints[key]);
      if (!checkIsHttpToken(name)) {
        throw typeError(
          "ERR_INVALID_HTTP_TOKEN",
          `Header name must be a valid HTTP token ["${name}"]`,
        );
      }
    }
    if (typeof callback === "function") setTimeout(callback, 0);
    return this;
  }

  writeContinue() {
    // Noop: 100 Continue is not transmitted; the virtual loop delivers the
    // request body lazily once the client ends it (see _deliverRequestBody).
    this.emit("continue");
    return this;
  }

  writeInformation(info, headers) {
    // Noop: 1xx informational responses are recorded locally only.
    void info;
    void headers;
    return this;
  }

  addTrailers(headers) {
    // H2-V4: the compat layer stores trailers on the response and
    // delivers them with the response body (Node compat.js stores them
    // in [kTrailers] and sends them on 'wantTrailers'). Unlike the
    // low-level stream.sendTrailers, this does NOT require a prior
    // 'wantTrailers' — it validates names/values and writes straight
    // into the stream's response-trailer store (lowercased, stringified).
    const pairs = normalizeTrailerPairs(headers);
    for (const [name, value] of pairs) {
      // Node's addTrailers delegates to setTrailer, whose only checks
      // are assertValidHeader (empty/spaced names, pseudo-headers,
      // undefined/null values) — no separate token check.
      assertValidHeader(name, value);
    }
    const current = this.stream ? this.stream._sentTrailers || {} : {};
    const merged = foldToHeaderObject([
      ...Object.entries(current).flatMap(([k, v]) =>
        Array.isArray(v) ? v.map((el) => [k, el]) : [[k, v]],
      ),
      ...pairs,
    ]);
    if (this.stream) this.stream._sentTrailers = merged;
    return this;
  }

  setTrailer(name, value) {
    // H2-V4: Node lib/internal/http2/compat.js setTrailer() — the
    // http1-style singular setter. validateString first (a missing name
    // is ERR_INVALID_ARG_TYPE), then trim + lowercase, then
    // assertValidHeader ("" is ERR_INVALID_HTTP_TOKEN, undefined/null
    // values are ERR_HTTP2_INVALID_HEADER_VALUE with the 'Invalid value
    // "x" for header "y"' message). No separate token check, like Node.
    // Stored like addTrailers.
    validateString(name, "name");
    const lowered = name.trim().toLowerCase();
    assertValidHeader(lowered, value);
    const current = this.stream ? this.stream._sentTrailers || {} : {};
    if (this.stream) {
      this.stream._sentTrailers = {
        ...current,
        [lowered]: String(value),
      };
    }
    return this;
  }

  getTrailer(name) {
    const trailers = this.stream ? this.stream._sentTrailers : null;
    return trailers ? trailers[name] : undefined;
  }

  hasTrailer(name) {
    const trailers = this.stream ? this.stream._sentTrailers : null;
    return !!trailers && name in trailers;
  }

  removeTrailer(name) {
    if (this.stream && this.stream._sentTrailers) {
      delete this.stream._sentTrailers[name];
    }
  }

  cork() {
    return this;
  }

  uncork() {
    return this;
  }

  setTimeout(msecs, callback) {
    // Noop: no real sockets; documented gap.
    void msecs;
    if (typeof callback === "function") this.once("timeout", callback);
    return this;
  }

  destroy(error) {
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }
}

// ---------------------------------------------------------------------------
// 8. Servers + virtual in-process loop.
// ---------------------------------------------------------------------------

const serverRegistry = new Map(); // port -> Http2Server
let nextEphemeralPort = 40000;

function lookupServer(port) {
  if (serverRegistry.has(port)) return serverRegistry.get(port);
  // Fallback: first registered server (matches the historical stub).
  return serverRegistry.size > 0
    ? serverRegistry.values().next().value
    : undefined;
}

function dispatchVirtualRequest(session, stream) {
  // H2-V4: only a DESTROYED stream never dispatches (its request is
  // gone). An RST-closed stream still dispatches — the server's
  // handler must see it, so it can observe the reset (its 'error'
  // fires there). The old _closed check swallowed it.
  if (stream._destroyed) return;
  const server = lookupServer(session._virtualPort);
  if (!server) {
    const err = http2Error(
      "ECONNREFUSED",
      `connect ECONNREFUSED 127.0.0.1:${session._virtualPort}`,
    );
    err.code = "ECONNREFUSED";
    err.errno = -111;
    err.syscall = "connect";
    queueMicrotask(() => {
      session.emit("error", err);
      stream.emit("error", err);
    });
    return;
  }
  server._dispatchVirtualStream(session, stream, true);
}

class Http2Server extends EventEmitter {
  constructor(options = {}, requestListener) {
    super();
    if (typeof options === "function") {
      requestListener = options;
      options = {};
    }
    // H2-V4: Node lib/internal/http2/core.js initializeOptions() —
    // options and options.settings must be objects (undefined is
    // allowed); maxSessionInvalidFrames / maxSessionRejectedStreams /
    // unknownProtocolTimeout must be uint32s. The ALPNCallback +
    // ALPNProtocols combination is rejected by the TLS layer
    // (createSecureServer only — see below).
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== "object" ||
        Array.isArray(options))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options" argument must be of type object.${invalidArgTypeHelper(options)}`,
      );
    }
    options = options || {};
    if (
      options.settings !== undefined &&
      (options.settings === null ||
        typeof options.settings !== "object" ||
        Array.isArray(options.settings))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options.settings" property must be of type object.${invalidArgTypeHelper(options.settings)}`,
      );
    }
    for (const name of [
      "maxSessionInvalidFrames",
      "maxSessionRejectedStreams",
      "unknownProtocolTimeout",
    ]) {
      if (options[name] !== undefined) {
        validateInteger(
          options[name],
          `options.${name}`,
          0,
          4294967295,
          "It must be >= 0 && <= 4294967295.",
        );
      }
    }
    // H2-V4: strictSingleValueFields is a boolean session option
    // (Node lib/internal/http2/core.js:3429-3435), default true.
    if (
      options.strictSingleValueFields !== undefined &&
      typeof options.strictSingleValueFields !== "boolean"
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options.strictSingleValueFields" property must be of type boolean.${invalidArgTypeHelper(options.strictSingleValueFields)}`,
      );
    }
    this._options = { ...options };
    // Custom request/response classes (Node supports overriding via
    // options.Http2ServerRequest / options.Http2ServerResponse).
    this._RequestClass = this._options.Http2ServerRequest || Http2ServerRequest;
    this._ResponseClass =
      this._options.Http2ServerResponse || Http2ServerResponse;
    this.timeout = 0;
    this._listening = false;
    this._port = null;
    this._sessions = new Set();
    if (requestListener) this.on("request", requestListener);
  }

  get listening() {
    return this._listening;
  }

  listen(...args) {
    // Supports listen(port[, host][, backlog][, callback]),
    // listen(options[, callback]) and listen(callback) like net.Server.
    let port;
    let callback;
    for (const arg of args) {
      if (typeof arg === "function") callback = arg;
      else if (typeof arg === "number") port = arg;
      else if (arg && typeof arg === "object") {
        if (typeof arg.port === "number") port = arg.port;
      }
    }
    if (port === undefined || port === 0) port = nextEphemeralPort++;
    this._port = port;
    this._listening = true;
    serverRegistry.set(port, this);
    queueMicrotask(() => {
      this.emit("listening");
      if (callback) callback();
    });
    return this;
  }

  address() {
    if (!this._listening) return null;
    return { address: "::", family: "IPv6", port: this._port };
  }

  getConnections(callback) {
    if (typeof callback === "function") setTimeout(() => callback(null, 0), 0);
  }

  setTimeout(msecs, callback) {
    // H2-V4: Node lib/net.js setTimeout() — a callback that is not a
    // function (and not undefined) throws ERR_INVALID_ARG_TYPE; a valid
    // call returns the server so setTimeout(...).timeout is settable.
    // Noop: no real sockets, so no socket timeouts; documented gap.
    if (callback !== undefined && typeof callback !== "function") {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "callback" argument must be of type function.${invalidArgTypeHelper(callback)}`,
      );
    }
    this.timeout = msecs;
    if (callback) this.on("timeout", callback);
    return this;
  }

  updateSettings(settings) {
    for (const session of this._sessions) session.settings(settings);
  }

  close(callback) {
    if (this._port !== null) {
      if (serverRegistry.get(this._port) === this)
        serverRegistry.delete(this._port);
    }
    this._listening = false;
    for (const session of this._sessions) session.close();
    this._sessions.clear();
    queueMicrotask(() => {
      this.emit("close");
      if (callback) callback();
    });
    return this;
  }

  // Support `await using server = http2.createServer()` (explicit resource
  // management): close the server and resolve when done.
  async [Symbol.asyncDispose]() {
    await new Promise((resolve) => this.close(resolve));
  }

  ref() {
    return this;
  }
  unref() {
    return this;
  }

  // -- virtual loop -------------------------------------------------------
  _getServerSession() {
    if (!this._serverSession) {
      this._serverSession = new ServerHttp2Session({
        encrypted: this instanceof Http2SecureServer,
      });
      // H2-V4: the server's strictSingleValueFields option (default
      // true) flows to the server session, so respond() validates
      // response headers against it.
      this._serverSession._strictSingleValueFields =
        this._options.strictSingleValueFields !== false;
      this._serverSession._connecting = false;
      this._sessions.add(this._serverSession);
      queueMicrotask(() => this.emit("session", this._serverSession));
    }
    return this._serverSession;
  }

  _dispatchVirtualStream(clientSession, stream, immediate = false) {
    this._getServerSession(); // ensure exactly one server session per server
    // H2-V4: the stream needs the paired server session so pushAllowed
    // can read the peer's remote enablePush (set here, before the
    // handler runs — the SETTINGS flush in _emitVirtualStream keeps
    // the session's _remoteSettings current).
    stream._serverSession = this._serverSession;
    this._serverSession._streams.add(stream);
    const headers = { ...stream._requestHeaders };
    const flags = 0;
    // H2-V6: rawHeaders is the wire-order flat list (pseudo-headers
    // first, names lowercased, duplicates in order) — the stream
    // carries the request's raw pairs; without them (host-bridge
    // streams) derive from the headers object.
    const rawHeaders = stream._requestRawPairs
      ? toWireRawHeaders(stream._requestRawPairs)
      : toWireRawHeaders(pairsFromObject(headers));
    // H2-V4: the normal path (dispatchVirtualRequest) runs the emit
    // synchronously — it is already one microtask after request(), and
    // a second queued microtask lets a client close() (one microtask)
    // overtake the dispatch, so the server never sees an RST'd stream
    // (test-http2-client-rststream-before-connect). The host-bridge
    // path keeps the queued emit (it calls this synchronously).
    if (immediate) {
      this._emitVirtualStream(clientSession, stream, headers, flags, rawHeaders);
    } else {
      queueMicrotask(() =>
        this._emitVirtualStream(
          clientSession,
          stream,
          headers,
          flags,
          rawHeaders,
        ),
      );
    }
  }

  _emitVirtualStream(clientSession, stream, headers, flags, rawHeaders) {
    {
      // Snapshot the client's pre-dispatch 'wantTrailers' listeners:
      // the request side's wantTrailers goes to those, the response
      // side's to the ones the server registers later (H2-V4).
      stream._clientWantTrailers = stream.listeners("wantTrailers");
      // Snapshot the client-side 'data' listeners: any 'data' listener
      // added from here on is a server-side request-body consumer (H2-V1).
      stream._dataListenersAtDispatch = stream.listenerCount("data");
      // H2-V4: deliver any pending remote-settings snapshot to this
      // session now (the server's 'session' handler, queued first,
      // attaches 'remoteSettings' before the microtask flush emits).
      // Guarded: the host-bridge's fake session object has no method.
      if (typeof clientSession._flushRemoteSettings === "function")
        clientSession._flushRemoteSettings();
      // H2-V4: the 'trailers' event is side-scoped on the shared stream
      // object — request trailers go to the server's listeners, response
      // trailers to the client's. Snapshot the client's listeners
      // before the handlers run so the server-side ones can be told
      // apart (they are registered by the 'stream'/'request' handlers).
      // The same split applies to 'data': the request body goes to the
      // server's consumers, the response body to the client's.
      const trailersBefore = stream.listeners("trailers");
      const dataBefore = stream.listeners("data");
      this.emit("stream", stream, headers, flags, rawHeaders);
      if (
        this.listenerCount("request") > 0 ||
        this.listenerCount("checkContinue") > 0
      ) {
        const req = new this._RequestClass(stream, headers);
        const res = new this._ResponseClass(stream);
        if (
          this.listenerCount("checkContinue") > 0 &&
          headers.expect === "100-continue"
        ) {
          this.emit("checkContinue", req, res);
        } else {
          this.emit("request", req, res);
        }
      }
      stream._serverTrailersListeners = stream
        .listeners("trailers")
        .filter((fn) => !trailersBefore.includes(fn));
      stream._serverDataListeners = stream
        .listeners("data")
        .filter((fn) => !dataBefore.includes(fn));
      // If the handler attached a server-side request-body consumer but
      // never responded, start lazy delivery anyway so its 'end' still
      // fires (a response already delivered means 'end' already fired).
      // H2-V4: a 'trailers' listener counts as a body consumer too —
      // its handler expects the body to complete so the trailers fire.
      if (
        !stream._requestBodyDeliveryStarted &&
        !stream._responseDelivered &&
        (stream.listenerCount("data") -
          (stream._dataListenersAtDispatch || 0) >
          0 ||
          stream.listenerCount("trailers") > 0)
      ) {
        stream._deliverRequestBody();
      }
    }
  }

  // Host-delivered inbound request (used by the __http2ServerRunTime bridge).
  _handleInboundRequest(method, url, headers = {}, body) {
    return new Promise((resolve, reject) => {
      const h2Headers = {
        ":method": method,
        ":path": url,
        ":scheme": "http",
        ":authority": headers.host || headers[":authority"] || "localhost",
        ...headers,
      };
      const stream = new Http2Stream(null, h2Headers);
      if (body !== undefined && body !== null) {
        stream._requestChunks.push(
          typeof body === "string" ? Buffer.from(body) : Buffer.from(body),
        );
        stream._requestEnded = true;
      }
      const onResponse = (responseHeaders) => {
        const responseBody = Buffer.concat(stream._responseChunks);
        const outHeaders = {};
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (!k.startsWith(":")) outHeaders[k.toLowerCase()] = v;
        }
        resolve({
          statusCode: Number(responseHeaders[":status"] || 200),
          headers: outHeaders,
          body: responseBody,
        });
      };
      stream.once("response", onResponse);
      stream.once("error", reject);
      const timeoutId = this.timeout
        ? setTimeout(() => {
            const err = new Error("Request timeout");
            err.code = "ETIMEDOUT";
            reject(err);
          }, this.timeout)
        : null;
      const clear = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };
      stream.once("response", clear);
      stream.once("error", clear);
      try {
        this._dispatchVirtualStream({ _virtualPort: this._port }, stream);
      } catch (err) {
        clear();
        reject(err);
      }
    });
  }
}

class Http2SecureServer extends Http2Server {
  constructor(options = {}, requestListener) {
    // H2-V4: Node lib/internal/http2/core.js Http2SecureServer extends
    // TLSServer and runs initializeTLSOptions(options) FIRST — a
    // function first arg throws ERR_INVALID_ARG_TYPE (probe-proven),
    // unlike the plain server where a function is the request handler.
    // The ALPNCallback + ALPNProtocols combination is rejected by the
    // TLS layer (ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS, probe-proven
    // message). After that the base constructor validates settings /
    // maxSession* the same as the plain server.
    if (
      options !== undefined &&
      (options === null ||
        typeof options !== "object" ||
        Array.isArray(options))
    ) {
      throw typeError(
        "ERR_INVALID_ARG_TYPE",
        `The "options" argument must be of type object.${invalidArgTypeHelper(options)}`,
      );
    }
    if (
      options &&
      options.ALPNCallback !== undefined &&
      options.ALPNProtocols !== undefined
    ) {
      throw typeError(
        "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS",
        "The ALPNCallback and ALPNProtocols TLS options are mutually exclusive",
      );
    }
    super(options, requestListener);
  }
}

// ---------------------------------------------------------------------------
// 9. Factories.
// ---------------------------------------------------------------------------

export function createServer(options, onRequestHandler) {
  return new Http2Server(options, onRequestHandler);
}

export function createSecureServer(options, onRequestHandler) {
  return new Http2SecureServer(options, onRequestHandler);
}

export function connect(authority, options, listener) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  options = options || {};
  const url = normalizeConnectAuthority(authority, options);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw http2Error(
      "ERR_HTTP2_UNSUPPORTED_PROTOCOL",
      `The protocol "${url.protocol}" is not supported`,
    );
  }
  const session = new ClientHttp2Session({
    encrypted: url.protocol === "https:",
  });
  // H2-V4: connect() options.strictSingleValueFields (default true,
  // Node lib/internal/http2/core.js:3657-3663) flows to the session,
  // so request() validates request headers against it.
  if (
    options.strictSingleValueFields !== undefined &&
    typeof options.strictSingleValueFields !== "boolean"
  ) {
    throw typeError(
      "ERR_INVALID_ARG_TYPE",
      `The "options.strictSingleValueFields" property must be of type boolean.${invalidArgTypeHelper(options.strictSingleValueFields)}`,
    );
  }
  session._strictSingleValueFields =
    options.strictSingleValueFields !== false;
  session._virtualPort = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  // H2-V6: request() defaults :authority/:scheme from the session
  // (Node prepareRequestHeadersObject).
  session._authority = url.host;
  session._scheme = url.protocol.slice(0, -1);
  if (options.settings) session.settings(options.settings);
  else {
    // H2-V4: a fresh connection carries the peer's default settings
    // (Node emits 'remoteSettings' on connect with the defaults when
    // no options.settings were given); one snapshot per connect.
    session._queueRemoteSettingsSnapshot();
  }
  if (listener) session.once("connect", listener);
  queueMicrotask(() => {
    // TLS/plain mismatch: real Node fails the handshake when an encrypted
    // client connects to a plain server (probe-proven: ECONNRESET, then
    // 'close'). Checked against an exactly-registered port only — the
    // registry's first-server fallback must not misfire here.
    const server = serverRegistry.has(session._virtualPort)
      ? serverRegistry.get(session._virtualPort)
      : undefined;
    if (
      server &&
      (server instanceof Http2SecureServer) !== session.encrypted
    ) {
      const err = http2Error("ECONNRESET", "read ECONNRESET");
      err.code = "ECONNRESET";
      err.errno = -104;
      err.syscall = "read";
      session.destroy(err);
      return;
    }
    session._connecting = false;
    session.emit("connect", session, null);
  });
  return session;
}

// Authority normalization, mirroring Node lib/internal/http2/core.js
// connect(): a string or URL instance is parsed as a URL; a url.parse()
// result or plain { port[, hostname|host][, protocol] } object is built
// into one from its fields (protocol falls back to options.protocol,
// then 'https:').
function normalizeConnectAuthority(authority, options) {
  if (typeof authority === "string" || authority instanceof URL) {
    try {
      return new URL(authority);
    } catch {
      throw http2Error("ERR_INVALID_URL", `Invalid URL: ${authority}`);
    }
  }
  if (authority && typeof authority === "object") {
    const protocol = authority.protocol || options.protocol || "https:";
    if (protocol !== "http:" && protocol !== "https:") {
      throw http2Error(
        "ERR_HTTP2_UNSUPPORTED_PROTOCOL",
        `The protocol "${protocol}" is not supported`,
      );
    }
    // Node's port line is `'' + (authority.port !== '' ? authority.port :
    // (authority.protocol === 'http:' ? 80 : 443))` — a url.parse() result
    // or plain object with no port yields the strings "null"/"undefined",
    // which net.connect rejects synchronously (probe-proven:
    // ERR_SOCKET_BAD_PORT, "Port should be >= 0 and < 65536. Received
    // type string ('null').").
    let port;
    if (authority.port === "") {
      port = authority.protocol === "http:" ? 80 : 443;
    } else if (authority.port !== undefined && authority.port !== null) {
      port = authority.port;
    } else {
      throw http2Error(
        "ERR_SOCKET_BAD_PORT",
        `Port should be >= 0 and < 65536. Received type string ('${authority.port}').`,
      );
    }
    let hostname = authority.hostname;
    if (hostname === undefined || hostname === null) {
      const host = authority.host;
      if (typeof host === "string") {
        // Split "name", "name:port", "[::1]", "[::1]:port".
        const m = host.match(/^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/);
        if (m) hostname = m[1] || m[2];
      }
    }
    hostname = hostname || "localhost";
    if (hostname[0] === "[") hostname = hostname.slice(1, -1);
    const hostport = hostname.includes(":")
      ? `[${hostname}]:${port}`
      : `${hostname}:${port}`;
    try {
      return new URL(`${protocol}//${hostport}`);
    } catch {
      throw http2Error("ERR_INVALID_URL", `Invalid URL: ${authority}`);
    }
  }
  throw http2Error("ERR_INVALID_URL", `Invalid URL: ${authority}`);
}

export function performServerHandshake(socket, options) {
  // Noop: no real TLS handshake in the browser. Returns a server session
  // object with the right shape.
  void socket;
  void options;
  const session = new ServerHttp2Session({ encrypted: true });
  session._connecting = false;
  return session;
}

// ---------------------------------------------------------------------------
// 10. Runtime bridge: lets a host deliver emulated inbound requests.
//     Only installed when nothing else provides it (never clobbers).
// ---------------------------------------------------------------------------

async function handleRequest(port, method, url, headers = {}, body) {
  const server = lookupServer(port);
  if (!server) {
    throw http2Error(
      "ECONNREFUSED",
      `No active HTTP/2 server found for port ${port}`,
    );
  }
  return server._handleInboundRequest(method, url, headers, body);
}

function waitForAllServers() {
  // listen() registers synchronously, so there is never anything to wait for.
  return Promise.resolve();
}

if (RT) {
  RT.__http2ServerRunTime = {
    waitForAllServers,
    handleRequest,
  };
}

// ---------------------------------------------------------------------------
// 11. Default export.
// ---------------------------------------------------------------------------

export default {
  Http2Server,
  Http2SecureServer,
  Http2Session,
  ClientHttp2Session,
  ServerHttp2Session,
  Http2Stream,
  Http2ServerRequest,
  Http2ServerResponse,
  createServer,
  createSecureServer,
  connect,
  performServerHandshake,
  constants,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  sensitiveHeaders,
};
