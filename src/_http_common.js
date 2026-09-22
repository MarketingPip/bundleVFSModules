// src/_http_common.js — port of node:_http_common (Node v24.20.0) for the browser runtime.
//
// Pure, dependency-free ESM. The character tables and validation helpers are
// ported verbatim from Node's lib/_http_common.js (llhttp-derived); the
// parser-pool machinery (HTTPParser, freeParser, parsers) has no browser
// equivalent and is stubbed honestly (see below).

// ---------------------------------------------------------------------------
// Runtime bridge (guarded: rewritten to the sandbox scope at load time,
// undefined under real Node / direct import).
// ---------------------------------------------------------------------------
const RT = (typeof globalThis._RUNTIME_ !== "undefined")
  ? globalThis._RUNTIME_
  : undefined;
void RT;

// ---------------------------------------------------------------------------
// HTTP token character table (RFC 7230 §3.2.6), verbatim from Node.
// ---------------------------------------------------------------------------
const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const validTokenChars = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 0-15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16-31
  0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, // 32-47 (!"#$%&'()*+,-./)
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // 48-63 (0-9:;<=>?)
  0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64-79 (@A-O)
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, // 80-95 (P-Z[\]^_)
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96-111 (`a-o)
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, // 112-127 (p-z{|}~)
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 128-143
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 144-159
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 160-175
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 176-191
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 192-207
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 208-223
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 224-239
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,  // 240-255
]);

/**
 * Verifies that the given val is a valid HTTP token per RFC 7230.
 * @param {string} val
 * @returns {boolean}
 */
export function _checkIsHttpToken(val) {
  if (val.length >= 10) {
    return tokenRegExp.test(val);
  }

  if (val.length === 0) return false;

  // Use lookup table for short strings, regex for longer ones
  for (let i = 0; i < val.length; i++) {
    if (!validTokenChars[val.charCodeAt(i)]) {
      return false;
    }
  }
  return true;
}

// Strict header value regex per RFC 7230 (default behavior):
// rejects control characters (0x00-0x1f except HTAB) and DEL (0x7f).
// eslint-disable-next-line no-control-regex
const strictHeaderCharRegex = /[^\t\x20-\x7e\x80-\xff]/;

// Lenient header value regex per the Fetch spec:
// must contain no NUL/CR/LF and must be byte sequences (0x00-0xff).
// eslint-disable-next-line no-control-regex
const lenientHeaderCharRegex = /[\x00\x0a\x0d]|[^\x00-\xff]/;

/**
 * True if val contains an invalid header value character.
 * @param {string} val
 * @param {boolean} [lenient] - Use lenient validation (Fetch spec rules)
 * @returns {boolean}
 */
export function _checkInvalidHeaderChar(val, lenient = false) {
  const regex = lenient ? lenientHeaderCharRegex : strictHeaderCharRegex;
  return regex.test(val);
}

export const chunkExpression = /(?:^|\W)chunked(?:$|\W)/i;
export const continueExpression = /(?:^|\W)100-continue(?:$|\W)/i;
export const CRLF = '\r\n'; // TODO: Deprecate this.

// Method list in llhttp's native order (matches node:_http_common exactly).
export const methods = [
  'DELETE', 'GET', 'HEAD', 'POST', 'PUT', 'CONNECT', 'OPTIONS', 'TRACE',
  'COPY', 'LOCK', 'MKCOL', 'MOVE', 'PROPFIND', 'PROPPATCH', 'SEARCH',
  'UNLOCK', 'BIND', 'REBIND', 'UNBIND', 'ACL', 'REPORT', 'MKACTIVITY',
  'CHECKOUT', 'MERGE', 'M-SEARCH', 'NOTIFY', 'SUBSCRIBE', 'UNSUBSCRIBE',
  'PATCH', 'PURGE', 'MKCALENDAR', 'LINK', 'UNLINK', 'SOURCE', 'QUERY',
];

export const kIncomingMessage = Symbol('IncomingMessage');
export const kSkipPendingData = Symbol('SkipPendingData');

// ---------------------------------------------------------------------------
// Parser-pool machinery: no llhttp in the browser. Honest stubs.
// ---------------------------------------------------------------------------

/** No-op: there is no native HTTP parser pool in the browser. */
export function freeParser(/* parser, req, socket */) {}

/** No parser pool exists in the browser. */
export const parsers = null;

/** The native HTTPParser binding does not exist in the browser. */
export const HTTPParser = undefined;

/** The --insecure-http-parser flag has no meaning in the browser. */
export function isLenient() {
  return false;
}

/** Lenient flags require the native parser; always strict (0) here. */
export function calculateLenientFlags(/* httpValidation, insecureHTTPParserOption */) {
  return 0;
}

/** Attach parse-error context the way Node does (without a native parser). */
export function prepareError(err, parser, rawPacket) {
  err.rawPacket = rawPacket || parser?.getCurrentBuffer?.();
  if (typeof err.reason === 'string') {
    err.message = `Parse Error: ${err.reason}`;
  }
  return err;
}

export default {
  _checkInvalidHeaderChar,
  _checkIsHttpToken,
  chunkExpression,
  continueExpression,
  CRLF,
  methods,
  kIncomingMessage,
  kSkipPendingData,
  freeParser,
  parsers,
  HTTPParser,
  isLenient,
  calculateLenientFlags,
  prepareError,
};
