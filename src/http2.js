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

import { EventEmitter } from './events.js';
import { Buffer } from 'buffer';

// ---------------------------------------------------------------------------
// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
// ---------------------------------------------------------------------------
const RT = (typeof globalThis._RUNTIME_ !== 'undefined')
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
  if (input === null || input === undefined) return ` Received ${String(input)}`;
  if (typeof input === 'function') {
    return ` Received function ${input.name || 'anonymous'}`;
  }
  if (typeof input === 'object') {
    const name = input.constructor && input.constructor.name;
    if (name) return ` Received an instance of ${name}`;
    return ` Received ${String(input)}`;
  }
  let inspected = typeof input === 'string' ? `'${input}'` : String(input);
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return ` Received type ${typeof input} (${inspected})`;
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
  HTTP2_HEADER_ACCEPT: 'accept',
  HTTP2_HEADER_ACCEPT_CHARSET: 'accept-charset',
  HTTP2_HEADER_ACCEPT_ENCODING: 'accept-encoding',
  HTTP2_HEADER_ACCEPT_LANGUAGE: 'accept-language',
  HTTP2_HEADER_ACCEPT_RANGES: 'accept-ranges',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_CREDENTIALS: 'access-control-allow-credentials',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_HEADERS: 'access-control-allow-headers',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_METHODS: 'access-control-allow-methods',
  HTTP2_HEADER_ACCESS_CONTROL_ALLOW_ORIGIN: 'access-control-allow-origin',
  HTTP2_HEADER_ACCESS_CONTROL_EXPOSE_HEADERS: 'access-control-expose-headers',
  HTTP2_HEADER_ACCESS_CONTROL_MAX_AGE: 'access-control-max-age',
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_HEADERS: 'access-control-request-headers',
  HTTP2_HEADER_ACCESS_CONTROL_REQUEST_METHOD: 'access-control-request-method',
  HTTP2_HEADER_AGE: 'age',
  HTTP2_HEADER_ALLOW: 'allow',
  HTTP2_HEADER_ALT_SVC: 'alt-svc',
  HTTP2_HEADER_AUTHORITY: ':authority',
  HTTP2_HEADER_AUTHORIZATION: 'authorization',
  HTTP2_HEADER_CACHE_CONTROL: 'cache-control',
  HTTP2_HEADER_CONNECTION: 'connection',
  HTTP2_HEADER_CONTENT_DISPOSITION: 'content-disposition',
  HTTP2_HEADER_CONTENT_ENCODING: 'content-encoding',
  HTTP2_HEADER_CONTENT_LANGUAGE: 'content-language',
  HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
  HTTP2_HEADER_CONTENT_LOCATION: 'content-location',
  HTTP2_HEADER_CONTENT_MD5: 'content-md5',
  HTTP2_HEADER_CONTENT_RANGE: 'content-range',
  HTTP2_HEADER_CONTENT_SECURITY_POLICY: 'content-security-policy',
  HTTP2_HEADER_CONTENT_TYPE: 'content-type',
  HTTP2_HEADER_COOKIE: 'cookie',
  HTTP2_HEADER_DATE: 'date',
  HTTP2_HEADER_DNT: 'dnt',
  HTTP2_HEADER_EARLY_DATA: 'early-data',
  HTTP2_HEADER_ETAG: 'etag',
  HTTP2_HEADER_EXPECT: 'expect',
  HTTP2_HEADER_EXPECT_CT: 'expect-ct',
  HTTP2_HEADER_EXPIRES: 'expires',
  HTTP2_HEADER_FORWARDED: 'forwarded',
  HTTP2_HEADER_FROM: 'from',
  HTTP2_HEADER_HOST: 'host',
  HTTP2_HEADER_HTTP2_SETTINGS: 'http2-settings',
  HTTP2_HEADER_IF_MATCH: 'if-match',
  HTTP2_HEADER_IF_MODIFIED_SINCE: 'if-modified-since',
  HTTP2_HEADER_IF_NONE_MATCH: 'if-none-match',
  HTTP2_HEADER_IF_RANGE: 'if-range',
  HTTP2_HEADER_IF_UNMODIFIED_SINCE: 'if-unmodified-since',
  HTTP2_HEADER_KEEP_ALIVE: 'keep-alive',
  HTTP2_HEADER_LAST_MODIFIED: 'last-modified',
  HTTP2_HEADER_LINK: 'link',
  HTTP2_HEADER_LOCATION: 'location',
  HTTP2_HEADER_MAX_FORWARDS: 'max-forwards',
  HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_ORIGIN: 'origin',
  HTTP2_HEADER_PATH: ':path',
  HTTP2_HEADER_PREFER: 'prefer',
  HTTP2_HEADER_PRIORITY: 'priority',
  HTTP2_HEADER_PROTOCOL: ':protocol',
  HTTP2_HEADER_PROXY_AUTHENTICATE: 'proxy-authenticate',
  HTTP2_HEADER_PROXY_AUTHORIZATION: 'proxy-authorization',
  HTTP2_HEADER_PROXY_CONNECTION: 'proxy-connection',
  HTTP2_HEADER_PURPOSE: 'purpose',
  HTTP2_HEADER_RANGE: 'range',
  HTTP2_HEADER_REFERER: 'referer',
  HTTP2_HEADER_REFRESH: 'refresh',
  HTTP2_HEADER_RETRY_AFTER: 'retry-after',
  HTTP2_HEADER_SCHEME: ':scheme',
  HTTP2_HEADER_SERVER: 'server',
  HTTP2_HEADER_SET_COOKIE: 'set-cookie',
  HTTP2_HEADER_STATUS: ':status',
  HTTP2_HEADER_STRICT_TRANSPORT_SECURITY: 'strict-transport-security',
  HTTP2_HEADER_TE: 'te',
  HTTP2_HEADER_TIMING_ALLOW_ORIGIN: 'timing-allow-origin',
  HTTP2_HEADER_TK: 'tk',
  HTTP2_HEADER_TRAILER: 'trailer',
  HTTP2_HEADER_TRANSFER_ENCODING: 'transfer-encoding',
  HTTP2_HEADER_UPGRADE: 'upgrade',
  HTTP2_HEADER_UPGRADE_INSECURE_REQUESTS: 'upgrade-insecure-requests',
  HTTP2_HEADER_USER_AGENT: 'user-agent',
  HTTP2_HEADER_VARY: 'vary',
  HTTP2_HEADER_VIA: 'via',
  HTTP2_HEADER_WARNING: 'warning',
  HTTP2_HEADER_WWW_AUTHENTICATE: 'www-authenticate',
  HTTP2_HEADER_X_CONTENT_TYPE_OPTIONS: 'x-content-type-options',
  HTTP2_HEADER_X_FORWARDED_FOR: 'x-forwarded-for',
  HTTP2_HEADER_X_FRAME_OPTIONS: 'x-frame-options',
  HTTP2_HEADER_X_XSS_PROTECTION: 'x-xss-protection',
  HTTP2_METHOD_ACL: 'ACL',
  HTTP2_METHOD_BASELINE_CONTROL: 'BASELINE-CONTROL',
  HTTP2_METHOD_BIND: 'BIND',
  HTTP2_METHOD_CHECKIN: 'CHECKIN',
  HTTP2_METHOD_CHECKOUT: 'CHECKOUT',
  HTTP2_METHOD_CONNECT: 'CONNECT',
  HTTP2_METHOD_COPY: 'COPY',
  HTTP2_METHOD_DELETE: 'DELETE',
  HTTP2_METHOD_GET: 'GET',
  HTTP2_METHOD_HEAD: 'HEAD',
  HTTP2_METHOD_LABEL: 'LABEL',
  HTTP2_METHOD_LINK: 'LINK',
  HTTP2_METHOD_LOCK: 'LOCK',
  HTTP2_METHOD_MERGE: 'MERGE',
  HTTP2_METHOD_MKACTIVITY: 'MKACTIVITY',
  HTTP2_METHOD_MKCALENDAR: 'MKCALENDAR',
  HTTP2_METHOD_MKCOL: 'MKCOL',
  HTTP2_METHOD_MKREDIRECTREF: 'MKREDIRECTREF',
  HTTP2_METHOD_MKWORKSPACE: 'MKWORKSPACE',
  HTTP2_METHOD_MOVE: 'MOVE',
  HTTP2_METHOD_OPTIONS: 'OPTIONS',
  HTTP2_METHOD_ORDERPATCH: 'ORDERPATCH',
  HTTP2_METHOD_PATCH: 'PATCH',
  HTTP2_METHOD_POST: 'POST',
  HTTP2_METHOD_PRI: 'PRI',
  HTTP2_METHOD_PROPFIND: 'PROPFIND',
  HTTP2_METHOD_PROPPATCH: 'PROPPATCH',
  HTTP2_METHOD_PUT: 'PUT',
  HTTP2_METHOD_REBIND: 'REBIND',
  HTTP2_METHOD_REPORT: 'REPORT',
  HTTP2_METHOD_SEARCH: 'SEARCH',
  HTTP2_METHOD_TRACE: 'TRACE',
  HTTP2_METHOD_UNBIND: 'UNBIND',
  HTTP2_METHOD_UNCHECKOUT: 'UNCHECKOUT',
  HTTP2_METHOD_UNLINK: 'UNLINK',
  HTTP2_METHOD_UNLOCK: 'UNLOCK',
  HTTP2_METHOD_UPDATE: 'UPDATE',
  HTTP2_METHOD_UPDATEREDIRECTREF: 'UPDATEREDIRECTREF',
  HTTP2_METHOD_VERSION_CONTROL: 'VERSION-CONTROL',
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
  1: 'headerTableSize',
  2: 'enablePush',
  3: 'maxConcurrentStreams',
  4: 'initialWindowSize',
  5: 'maxFrameSize',
  // 6 -> both maxHeaderListSize and maxHeaderSize (Node sets both on unpack)
  8: 'enableConnectProtocol',
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
const BOOLEAN_SETTINGS = new Set(['enablePush', 'enableConnectProtocol']);
// Custom settings ids 1..8 are remapped by Node's binding through this
// table (verified empirically against Node v24.20.0); id "3" maps to
// nothing, which makes the whole getPackedSettings call return undefined.
const CUSTOM_ID_REMAP = { 1: 2, 2: 4, 3: undefined, 4: 3, 5: 6, 6: 8, 7: 7, 8: 8 };
const MAX_CUSTOM_SETTINGS = 10;

function invalidSettingValue(name, value, Kind = RangeError) {
  return http2Error(
    'ERR_HTTP2_INVALID_SETTING_VALUE',
    `Invalid value for setting "${name}": ${value}`,
    Kind
  );
}

function normalizeSettingValue(name, value) {
  const range = SETTINGS_RANGES[name];
  if (BOOLEAN_SETTINGS.has(name)) {
    // Node requires real booleans here; numbers/strings/NaN throw TypeError.
    if (typeof value !== 'boolean') {
      throw invalidSettingValue(name, value, TypeError);
    }
    return value ? 1 : 0;
  }
  if (typeof value !== 'number') {
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
    if (name === 'customSettings') continue;
    const id = SETTINGS_NAME_TO_ID[name];
    if (id === undefined) continue; // unknown keys ignored, like Node
    const value = settings[name];
    if (value === undefined) continue; // undefined values skipped, like Node
    const normalized = normalizeSettingValue(name, value);
    if (Number.isNaN(normalized)) return undefined;
    if (id === 6) {
      if (name === 'maxHeaderSize' || id6 === undefined) {
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
  if (customSettings === null || typeof customSettings !== 'object' || Array.isArray(customSettings)) {
    throw typeError(
      'ERR_INVALID_ARG_TYPE',
      'The "customSettings" argument must be an instance of Number.' +
        invalidArgTypeHelper(customSettings)
    );
  }
  const keys = Object.keys(customSettings);
  if (keys.length > MAX_CUSTOM_SETTINGS) {
    throw http2Error(
      'ERR_HTTP2_TOO_MANY_CUSTOM_SETTINGS',
      'Number of custom settings exceeds MAX_ADDITIONAL_SETTINGS'
    );
  }
  const entries = [];
  for (const key of keys) {
    const value = customSettings[key];
    if (value === undefined || typeof value !== 'number') continue; // skipped, like Node
    if (Number.isNaN(value)) {
      throw invalidSettingValue('customSettings:value', value, RangeError);
    }
    let id = Math.trunc(Number(key));
    if (!Number.isFinite(id)) {
      throw invalidSettingValue('customSettings:id', key, RangeError);
    }
    if (id >= 1 && id <= 8) {
      const remapped = CUSTOM_ID_REMAP[id];
      if (remapped === undefined) return undefined; // id "3": whole call returns undefined
      id = remapped;
    } else if (id < 1 || id > 65535) {
      throw invalidSettingValue('customSettings:id', key, RangeError);
    }
    const num = Math.trunc(value);
    if (num < 0 || num > 0xffffffff) {
      throw invalidSettingValue('customSettings:value', value, RangeError);
    }
    entries.push([id, num >>> 0]);
  }
  return entries;
}

function readSettingsEntries(settings) {
  if (settings === undefined) return [];
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw typeError(
      'ERR_INVALID_ARG_TYPE',
      'The "settings" argument must be of type object.' +
        invalidArgTypeHelper(settings)
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
    throw invalidSettingValue('initialWindowSize', value, RangeError);
  }
  if (id === 5 && (value < 16384 || value > 16777215)) {
    throw invalidSettingValue('maxFrameSize', value, RangeError);
  }
}

export function getUnpackedSettings(buf, options) {
  const isView = typeof buf === 'object' && buf !== null &&
    typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buf) &&
    !(typeof DataView !== 'undefined' && buf instanceof DataView);
  if (!isView) {
    throw typeError(
      'ERR_INVALID_ARG_TYPE',
      'The "buf" argument must be an instance of Buffer or TypedArray.' +
        invalidArgTypeHelper(buf)
    );
  }
  const len = buf.length; // element count: Node reads TypedArray elements, not raw bytes
  if (len % 6 !== 0) {
    throw rangeError(
      'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH',
      'Packed settings length must be a multiple of six'
    );
  }
  // Element-wise byte view (matches Node: a Uint16Array's elements become
  // the byte stream, each truncated to uint8).
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = buf[i] & 0xff;
  const validate = !!(
    options !== null && typeof options === 'object' && options.validate
  );
  const settings = {};
  const customSettings = {};
  for (let i = 0; i < bytes.length; i += 6) {
    const id = (bytes[i] << 8) | bytes[i + 1];
    const value = (
      (bytes[i + 2] * 0x1000000) + (bytes[i + 3] << 16) +
      (bytes[i + 4] << 8) + bytes[i + 5]
    ) >>> 0;
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

export const sensitiveHeaders = Symbol('sensitiveHeaders');

// ---------------------------------------------------------------------------
// 5. Http2Session — real method shapes; I/O methods are honest noops or
//    virtual-loop wiring with the real callback/event signatures.
// ---------------------------------------------------------------------------

const kEncrypted = Symbol('http2.encrypted');

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
  }

  get closed() { return this._closed; }
  get destroyed() { return this._destroyed; }
  get connecting() { return this._connecting; }
  get encrypted() { return this[kEncrypted]; }
  get alpnProtocol() { return undefined; } // no real TLS handshake
  get originSet() { return undefined; } // origins not tracked in emulation
  get socket() { return null; } // no real socket
  get type() { return constants.NGHTTP2_SESSION_CLIENT; }
  get pendingSettingsAck() { return this._pendingSettingsAck; }
  get localSettings() { return { ...this._localSettings }; }
  get remoteSettings() { return { ...this._remoteSettings }; }
  get state() {
    // Emulated: plausible static values, nextStreamID is tracked for real.
    return {
      effectiveLocalWindowSize: 65535,
      effectiveReceiveDataLength: 0,
      nextStreamID: this._nextStreamID,
      localWindowSize: 65535,
      lastProcStreamID: 0,
      remoteWindowSize: 65535,
      outboundQueueSize: 0,
      deflateDynamicTableSize: 4096,
      inflateDynamicTableSize: 4096,
    };
  }

  _assertUsable() {
    if (this._destroyed || this._closed) {
      throw http2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
    }
  }

  close(callback) {
    if (typeof callback !== 'function' && callback !== undefined) {
      throw http2Error('ERR_INVALID_ARG_TYPE', 'The "callback" argument must be of type function');
    }
    if (!this._closed) {
      this._closed = true;
      this._connecting = false;
      this.emit('close');
    }
    if (callback) setTimeout(callback, 0);
  }

  destroy(error, code = constants.NGHTTP2_NO_ERROR) {
    if (!this._destroyed) {
      this._destroyed = true;
      this._closed = true;
      this._connecting = false;
      if (error) this.emit('error', error);
      this.emit('close', code);
    }
  }

  goaway(code = constants.NGHTTP2_NO_ERROR, lastStreamID = 0, opaqueData) {
    // Noop: nothing is sent on the wire in the browser emulation.
    void code; void lastStreamID; void opaqueData;
  }

  ping(payload, callback) {
    if (typeof payload === 'function') {
      callback = payload;
      payload = undefined;
    }
    this._assertUsable();
    const data = payload === undefined
      ? Buffer.alloc(8)
      : Buffer.from(payload);
    if (callback) {
      // Emulated: 0ms round-trip; no real PING frame is exchanged.
      setTimeout(() => callback(null, 0, data), 0);
    }
    return true;
  }

  ref() { return this; }
  unref() { return this; }

  setTimeout(msecs, callback) {
    // Noop: inactivity is not tracked, so no 'timeout' is ever emitted.
    // Kept for shape compatibility; the gap is documented.
    this._timeout = msecs;
    if (callback) this.once('timeout', callback);
  }

  settings(settings, callback) {
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
    queueMicrotask(() => this.emit('localSettings', snapshot));
    if (callback) setTimeout(() => callback(null, snapshot, 0), 0);
  }

  rstStream(stream, code = constants.NGHTTP2_NO_ERROR) {
    // Noop: tears down the local stream object only.
    if (stream && typeof stream.rstStream === 'function') stream.rstStream(code);
  }

  priority(stream, prioritySpec) {
    // Noop: no PRIORITY frame is sent.
    void stream; void prioritySpec;
  }

  setLocalWindowSize(windowSize) {
    // Noop: no WINDOW_UPDATE frame is sent.
    void windowSize;
  }

  setNextStreamID(id) {
    if (!Number.isInteger(id) || id <= 0) {
      throw http2Error('ERR_HTTP2_INVALID_STREAM', `Invalid stream id: ${id}`);
    }
    this._nextStreamID = id;
  }
}

class ClientHttp2Session extends Http2Session {
  constructor(options = {}) {
    super(options);
  }

  get type() { return constants.NGHTTP2_SESSION_CLIENT; }

  request(headers = {}, options = {}) {
    this._assertUsable();
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
      throw http2Error('ERR_INVALID_ARG_TYPE', 'The "headers" argument must be of type object');
    }
    const stream = new Http2Stream(this, { ...headers });
    stream._id = this._nextStreamID;
    this._nextStreamID += 2; // client-initiated streams use odd ids
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

  get type() { return constants.NGHTTP2_SESSION_SERVER; }
}

// ---------------------------------------------------------------------------
// 6. Http2Stream — real method shapes. In the virtual loop one stream object
//    is shared between the client and server sides (documented
//    simplification); the whole response body is delivered as one 'data'
//    chunk. Not a real Duplex: no backpressure, no 'data' flow on the server
//    side.
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
    this._sentHeaders = null;
    this._sentInfoHeaders = [];
    this._sentTrailers = null;
    this._requestChunks = []; // client -> server
    this._responseChunks = []; // server -> client
    this._requestEnded = false;
    this._responseDelivered = false;
    this._timeout = 0;
  }

  get id() { return this._id; }
  get closed() { return this._closed; }
  get destroyed() { return this._destroyed; }
  get pending() { return this._id === 0; }
  get rstCode() { return this._rstCode; }
  get aborted() { return this._aborted; }
  get headersSent() { return this._sentHeaders !== null; }
  get pushAllowed() { return false; } // push is impossible in the emulation
  get sentHeaders() { return this._sentHeaders ? { ...this._sentHeaders } : null; }
  get sentInfoHeaders() { return this._sentInfoHeaders.map((h) => ({ ...h })); }
  get sentTrailers() { return this._sentTrailers ? { ...this._sentTrailers } : null; }
  get headRequest() {
    return (this._requestHeaders[':method'] || '').toUpperCase() === 'HEAD';
  }
  get endAfterHeaders() { return false; }
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
    // Noop: informational headers are recorded locally only.
    if (headers && typeof headers === 'object') {
      this._sentInfoHeaders.push({ ...headers });
    }
  }

  info(headers) {
    this.additionalHeaders(headers);
  }

  close(code = constants.NGHTTP2_NO_ERROR, callback) {
    if (typeof code === 'function') {
      callback = code;
      code = constants.NGHTTP2_NO_ERROR;
    }
    if (!this._closed) {
      this._closed = true;
      this.emit('close', code);
    }
    if (callback) setTimeout(callback, 0);
  }

  destroy(error) {
    if (!this._destroyed) {
      this._destroyed = true;
      this._closed = true;
      if (error) this.emit('error', error);
      this.emit('close', this._rstCode);
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
    if (callback) this.once('timeout', callback);
  }

  respond(headers = {}, options = {}) {
    // Noop on the wire: records response headers locally. The virtual
    // server delivers them when the response is ended.
    this._sentHeaders = { ...headers };
    void options;
  }

  respondWithFD(fd, headers = {}, options = {}) {
    // Noop: no file descriptors in the browser.
    void fd; void headers; void options;
  }

  respondWithFile(path, headers = {}, options = {}) {
    // Noop: no filesystem file delivery in the browser.
    void path; void headers; void options;
  }

  sendTrailers(headers) {
    // Recorded locally; no trailers are transmitted.
    this._sentTrailers = { ...headers };
  }

  pushStream(headers, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    // Push is impossible in the browser emulation; report it asynchronously
    // rather than throwing, per the noop-over-throw rule.
    if (callback) {
      setTimeout(() => callback(
        http2Error('ERR_HTTP2_PUSH_DISABLED', 'Push streams are not supported in the browser emulation')
      ), 0);
    }
  }

  // -- shared write/end: route by side ------------------------------------
  // Client side (request body) until respond() starts the response; after
  // that, writes go to the response body. Server 'stream' handlers must call
  // respond() before end(), as in real Node.
  get _responseStarted() {
    return this._sentHeaders !== null || this._responseDelivered;
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (this._responseStarted) {
      this._writeResponse(chunk, encoding);
    } else {
      const buf = typeof chunk === 'string'
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk);
      this._requestChunks.push(buf);
    }
    if (callback) setTimeout(callback, 0);
    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === 'function') {
      callback = data; data = undefined; encoding = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding; encoding = undefined;
    }
    if (data !== undefined && data !== null) this.write(data, encoding);
    if (this._responseStarted) {
      this._deliverResponse();
    } else {
      this._requestEnded = true;
      this.emit('finish');
    }
    if (callback) setTimeout(callback, 0);
    return this;
  }

  // -- server side (used by Http2ServerResponse): response body -----------
  _writeResponse(chunk, encoding) {
    const buf = typeof chunk === 'string'
      ? Buffer.from(chunk, encoding)
      : Buffer.from(chunk);
    this._responseChunks.push(buf);
  }

  _endResponse(data, encoding) {
    if (data !== undefined && data !== null) this._writeResponse(data, encoding);
    this._deliverResponse();
  }

  _deliverResponse() {
    if (this._responseDelivered) return;
    this._responseDelivered = true;
    const headers = this._sentHeaders || { ':status': 200 };
    const body = Buffer.concat(this._responseChunks);
    // Client-side observable events, in real order.
    this.emit('response', { ...headers }, 0);
    if (body.length > 0 && !this.headRequest) this.emit('data', body);
    if (this._sentTrailers) this.emit('trailers', { ...this._sentTrailers }, 0);
    this.emit('end');
    this._closed = true;
    this.emit('close', constants.NGHTTP2_NO_ERROR);
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
    this.httpVersion = '2.0';
    this.httpVersionMajor = 2;
    this.httpVersionMinor = 0;
    this.method = headers[':method'] || 'GET';
    this.url = headers[':path'] || '/';
    this.scheme = headers[':scheme'] || 'http';
    this.authority = headers[':authority'];
    this.rawHeaders = [];
    for (const [k, v] of Object.entries(this.headers)) {
      if (!k.startsWith(':')) this.rawHeaders.push(k, v);
    }
    this._body = stream ? stream.requestBody : Buffer.alloc(0);
  }

  get body() { return this._body; }
  get aborted() { return this.stream ? this.stream.aborted : false; }
  get complete() { return this.stream ? this.stream._requestEnded : true; }
}

export class Http2ServerResponse extends EventEmitter {
  constructor(stream) {
    super();
    this.stream = stream;
    this.statusCode = 200;
    this.statusMessage = undefined;
    this._headers = {};
    this._headersSent = false;
    this.sendDate = true;
  }

  setHeader(name, value) {
    this._headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name) { return this._headers[name.toLowerCase()]; }
  getHeaders() { return { ...this._headers }; }
  getHeaderNames() { return Object.keys(this._headers); }
  hasHeader(name) { return name.toLowerCase() in this._headers; }
  removeHeader(name) { delete this._headers[name.toLowerCase()]; }

  writeHead(statusCode, statusMessage, headers) {
    if (typeof statusMessage === 'object' && statusMessage !== null) {
      headers = statusMessage;
      statusMessage = undefined;
    }
    this.statusCode = statusCode;
    if (statusMessage !== undefined) this.statusMessage = statusMessage;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    }
    const out = { ':status': statusCode, ...this._headers };
    this.stream.respond(out);
    this._headersSent = true;
    return this;
  }

  get headersSent() { return this._headersSent; }

  write(chunk, encoding, callback) {
    if (!this._headersSent) this.writeHead(this.statusCode);
    this.stream._writeResponse(chunk, encoding);
    if (typeof encoding === 'function') callback = encoding;
    if (callback) setTimeout(callback, 0);
    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === 'function') {
      callback = data; data = undefined; encoding = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding; encoding = undefined;
    }
    if (!this._headersSent) this.writeHead(this.statusCode);
    this.stream._endResponse(data, encoding);
    this.emit('finish');
    if (callback) setTimeout(callback, 0);
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
  return serverRegistry.size > 0 ? serverRegistry.values().next().value : undefined;
}

function dispatchVirtualRequest(session, stream) {
  if (stream._closed || stream._destroyed) return;
  const server = lookupServer(session._virtualPort);
  if (!server) {
    const err = http2Error(
      'ECONNREFUSED',
      `connect ECONNREFUSED 127.0.0.1:${session._virtualPort}`
    );
    err.code = 'ECONNREFUSED';
    err.errno = -111;
    err.syscall = 'connect';
    queueMicrotask(() => {
      session.emit('error', err);
      stream.emit('error', err);
    });
    return;
  }
  server._dispatchVirtualStream(session, stream);
}

class Http2Server extends EventEmitter {
  constructor(options = {}, requestListener) {
    super();
    if (typeof options === 'function') {
      requestListener = options;
      options = {};
    }
    this._options = { ...(options || {}) };
    this.timeout = 0;
    this._listening = false;
    this._port = null;
    this._sessions = new Set();
    if (requestListener) this.on('request', requestListener);
  }

  get listening() { return this._listening; }

  listen(...args) {
    // Supports listen(port[, host][, backlog][, callback]),
    // listen(options[, callback]) and listen(callback) like net.Server.
    let port;
    let callback;
    for (const arg of args) {
      if (typeof arg === 'function') callback = arg;
      else if (typeof arg === 'number') port = arg;
      else if (arg && typeof arg === 'object') {
        if (typeof arg.port === 'number') port = arg.port;
      }
    }
    if (port === undefined || port === 0) port = nextEphemeralPort++;
    this._port = port;
    this._listening = true;
    serverRegistry.set(port, this);
    queueMicrotask(() => {
      this.emit('listening');
      if (callback) callback();
    });
    return this;
  }

  address() {
    if (!this._listening) return null;
    return { address: '::', family: 'IPv6', port: this._port };
  }

  getConnections(callback) {
    if (typeof callback === 'function') setTimeout(() => callback(null, 0), 0);
  }

  setTimeout(msecs, callback) {
    // Noop: no real sockets, so no socket timeouts; documented gap.
    this.timeout = msecs;
    if (callback) this.on('timeout', callback);
    return this;
  }

  updateSettings(settings) {
    for (const session of this._sessions) session.settings(settings);
  }

  close(callback) {
    if (this._port !== null) {
      if (serverRegistry.get(this._port) === this) serverRegistry.delete(this._port);
    }
    this._listening = false;
    for (const session of this._sessions) session.close();
    this._sessions.clear();
    queueMicrotask(() => {
      this.emit('close');
      if (callback) callback();
    });
    return this;
  }

  ref() { return this; }
  unref() { return this; }

  // -- virtual loop -------------------------------------------------------
  _getServerSession() {
    if (!this._serverSession) {
      this._serverSession = new ServerHttp2Session({
        encrypted: this instanceof Http2SecureServer,
      });
      this._serverSession._connecting = false;
      this._sessions.add(this._serverSession);
      queueMicrotask(() => this.emit('session', this._serverSession));
    }
    return this._serverSession;
  }

  _dispatchVirtualStream(clientSession, stream) {
    this._getServerSession(); // ensure exactly one server session per server
    const headers = { ...stream._requestHeaders };
    const flags = 0;
    const rawHeaders = [];
    for (const [k, v] of Object.entries(headers)) {
      if (!k.startsWith(':')) rawHeaders.push(k, v);
    }
    queueMicrotask(() => {
      this.emit('stream', stream, headers, flags, rawHeaders);
      if (this.listenerCount('request') > 0 || this.listenerCount('checkContinue') > 0) {
        const req = new Http2ServerRequest(stream, headers);
        const res = new Http2ServerResponse(stream);
        if (this.listenerCount('checkContinue') > 0 && headers.expect === '100-continue') {
          this.emit('checkContinue', req, res);
        } else {
          this.emit('request', req, res);
        }
      }
    });
  }

  // Host-delivered inbound request (used by the __http2ServerRunTime bridge).
  _handleInboundRequest(method, url, headers = {}, body) {
    return new Promise((resolve, reject) => {
      const h2Headers = {
        ':method': method,
        ':path': url,
        ':scheme': 'http',
        ':authority': headers.host || headers[':authority'] || 'localhost',
        ...headers,
      };
      const stream = new Http2Stream(null, h2Headers);
      if (body !== undefined && body !== null) {
        stream._requestChunks.push(
          typeof body === 'string' ? Buffer.from(body) : Buffer.from(body)
        );
        stream._requestEnded = true;
      }
      const onResponse = (responseHeaders) => {
        const responseBody = Buffer.concat(stream._responseChunks);
        const outHeaders = {};
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (!k.startsWith(':')) outHeaders[k.toLowerCase()] = v;
        }
        resolve({
          statusCode: Number(responseHeaders[':status'] || 200),
          headers: outHeaders,
          body: responseBody,
        });
      };
      stream.once('response', onResponse);
      stream.once('error', reject);
      const timeoutId = this.timeout
        ? setTimeout(() => {
          const err = new Error('Request timeout');
          err.code = 'ETIMEDOUT';
          reject(err);
        }, this.timeout)
        : null;
      const clear = () => { if (timeoutId) clearTimeout(timeoutId); };
      stream.once('response', clear);
      stream.once('error', clear);
      try {
        this._dispatchVirtualStream({ _virtualPort: this._port }, stream);
      } catch (err) {
        clear();
        reject(err);
      }
    });
  }
}

class Http2SecureServer extends Http2Server {}

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
  if (typeof options === 'function') {
    listener = options;
    options = {};
  }
  options = options || {};
  let url;
  try {
    url = new URL(authority);
  } catch {
    throw http2Error('ERR_INVALID_URL', `Invalid URL: ${authority}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw http2Error(
      'ERR_HTTP2_UNSUPPORTED_PROTOCOL',
      `The protocol "${url.protocol}" is not supported`
    );
  }
  const session = new ClientHttp2Session({
    encrypted: url.protocol === 'https:',
  });
  session._virtualPort = url.port
    ? Number(url.port)
    : (url.protocol === 'https:' ? 443 : 80);
  if (options.settings) session.settings(options.settings);
  if (listener) session.once('connect', listener);
  queueMicrotask(() => {
    session._connecting = false;
    session.emit('connect', session, null);
  });
  return session;
}

export function performServerHandshake(socket, options) {
  // Noop: no real TLS handshake in the browser. Returns a server session
  // object with the right shape.
  void socket; void options;
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
    throw http2Error('ECONNREFUSED', `No active HTTP/2 server found for port ${port}`);
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
