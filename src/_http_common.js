/*!
 * _http_common-web — node:_http_common for browsers & bundlers
 * MIT License.
 * Node.js parity: node:_http_common @ Node 0.1.90+ (internal, stable surface)
 * Dependencies: none
 * Limitations:
 *   - _checkIsHttpToken / _checkInvalidHeaderChar are pure-JS ports of the
 *     C++ llhttp character-table lookups; they match Node's behaviour exactly
 *     for the ASCII range but rely on regex for simplicity above 0x7F.
 *   - chunkExpression / continueExpression are identical to Node's source.
 *   - kIncomingMessage is a Symbol used as a per-Server IncomingMessage
 *     constructor override; it carries no behaviour itself.
 *   - METHODS list matches Node 20+ (frozen, sorted as Node exports it).
 */

/**
 * @packageDocumentation
 * Browser-compatible port of Node's internal `_http_common` module.
 *
 * Exports the low-level HTTP utilities shared across the http.* family:
 *   - {@link _checkIsHttpToken}       — validates HTTP method / header-name tokens
 *   - {@link _checkInvalidHeaderChar} — detects illegal characters in header values
 *   - {@link chunkExpression}         — RegExp matching Transfer-Encoding: chunked
 *   - {@link continueExpression}      — RegExp matching Expect: 100-continue
 *   - {@link methods}                 — the full METHODS array
 *   - {@link kIncomingMessage}        — Symbol key for per-Server IncomingMessage class
 */

// ---------------------------------------------------------------------------
// HTTP token character table
// RFC 7230 §3.2.6 defines a "token" as:
//   token = 1*tchar
//   tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
//           "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
//
// Node implements this as a 128-entry lookup table in C++ (llhttp).
// We replicate the same set as a frozen Uint8Array for O(1) lookup.
// ---------------------------------------------------------------------------

// Characters that are valid tchar values (codepoints 0–127).
// 1 = valid token char, 0 = invalid.
const TOKEN_CHARS = new Uint8Array([
// NUL SOH STX ETX EOT ENQ ACK BEL  BS  HT  LF  VT  FF  CR  SO  SI
     0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
// DLE DC1 DC2 DC3 DC4 NAK SYN ETB CAN  EM SUB ESC  FS  GS  RS  US
     0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,  0,
// SPC  !   "   #   $   %   &   '   (   )   *   +   ,   -   .   /
     0,  1,  0,  1,  1,  1,  1,  1,  0,  0,  1,  1,  0,  1,  1,  0,
// 0   1   2   3   4   5   6   7   8   9   :   ;   <   =   >   ?
     1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  0,  0,  0,  0,  0,  0,
// @   A   B   C   D   E   F   G   H   I   J   K   L   M   N   O
     0,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,
// P   Q   R   S   T   U   V   W   X   Y   Z   [   \   ]   ^   _
     1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  0,  0,  0,  1,  1,
// `   a   b   c   d   e   f   g   h   i   j   k   l   m   n   o
     1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,
// p   q   r   s   t   u   v   w   x   y   z   {   |   }   ~  DEL
     1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  1,  0,  1,  0,  1,  0,
]);

// Invalid header-value characters per RFC 7230 §3.2.
// Node rejects: NUL, CR, LF, and the DEL character (0x7F).
// Obs-fold (CRLF + WSP) is also rejected.
const INVALID_HEADER_CHAR_RE = /[\x00\r\n\x7f]/;

// ---------------------------------------------------------------------------
// _checkIsHttpToken
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `val` is a valid HTTP token (method name, header name).
 * Matches Node's C++ implementation: any char outside the tchar set or
 * any codepoint > 127 makes the value invalid.
 *
 * @param {string} val
 * @returns {boolean}
 *
 * @example
 * _checkIsHttpToken('Content-Type')  // true
 * _checkIsHttpToken('Bad Header')    // false — space is not a tchar
 * _checkIsHttpToken('')              // false — empty
 * _checkIsHttpToken('GET')           // true
 */
export function _checkIsHttpToken(val) {
  if (typeof val !== 'string' || val.length === 0) return false;
  for (let i = 0; i < val.length; i++) {
    const code = val.charCodeAt(i);
    // Any codepoint > 127 is invalid; anything not in the tchar table is invalid.
    if (code > 127 || TOKEN_CHARS[code] === 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// _checkInvalidHeaderChar
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `val` contains at least one character that is illegal in
 * an HTTP header value (NUL, CR, LF, DEL).
 * Returns `false` for valid header values.
 *
 * @param {string} val
 * @returns {boolean}
 *
 * @example
 * _checkInvalidHeaderChar('application/json')  // false — ok
 * _checkInvalidHeaderChar('foo\r\nbar')         // true  — CRLF injection
 * _checkInvalidHeaderChar('foo\x00bar')         // true  — NUL
 */
export function _checkInvalidHeaderChar(val) {
  return INVALID_HEADER_CHAR_RE.test(val);
}

// ---------------------------------------------------------------------------
// chunkExpression
// ---------------------------------------------------------------------------

/**
 * Matches `Transfer-Encoding` header values that indicate chunked encoding.
 * Mirrors Node's source exactly.
 *
 * @type {RegExp}
 * @example
 * chunkExpression.test('chunked')            // true
 * chunkExpression.test('gzip, chunked')      // true
 * chunkExpression.test('gzip')               // false
 */
export const chunkExpression = /(?:^|\W)chunked(?:$|\W)/i;

// ---------------------------------------------------------------------------
// continueExpression
// ---------------------------------------------------------------------------

/**
 * Matches `Expect` header values indicating the client wants a 100-continue
 * interim response before sending the request body.
 * Taken verbatim from the Cloudflare / Node source.
 *
 * @type {RegExp}
 * @example
 * continueExpression.test('100-continue')   // true
 * continueExpression.test('200-ok')         // false
 */
export const continueExpression = /(?:^|\W)100-continue(?:$|\W)/i;

// ---------------------------------------------------------------------------
// kIncomingMessage
// ---------------------------------------------------------------------------

/**
 * Symbol key used by `http.Server` to store a per-server override for the
 * `IncomingMessage` constructor.  Consumers that need a custom request class:
 *
 * ```js
 * server[kIncomingMessage] = MyIncomingMessage;
 * ```
 *
 * Matches Node's internal `kIncomingMessage` symbol.
 *
 * @type {symbol}
 */
export const kIncomingMessage = Symbol('kIncomingMessage');

// ---------------------------------------------------------------------------
// methods
// ---------------------------------------------------------------------------

/**
 * Full list of HTTP methods supported by Node's http parser (llhttp).
 * Identical to `require('http').METHODS` / `_http_agent.METHODS`.
 * Frozen to match Node's read-only export.
 *
 * @type {readonly string[]}
 */
export const methods = Object.freeze([
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD',
  'LINK', 'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL',
  'MOVE', 'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH',
  'PURGE', 'PUT', 'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE',
  'TRACE', 'UNBIND', 'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
]);

export default {
  _checkIsHttpToken,
  _checkInvalidHeaderChar,
  chunkExpression,
  continueExpression,
  methods,
  kIncomingMessage,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import {
//   _checkIsHttpToken, _checkInvalidHeaderChar,
//   chunkExpression, continueExpression,
//   methods, kIncomingMessage,
// } from './_http_common';
//
// // ── _checkIsHttpToken ─────────────────────────────────────────────────────
// _checkIsHttpToken('Content-Type')   // true
// _checkIsHttpToken('GET')            // true
// _checkIsHttpToken('Bad Header')     // false — space disallowed
// _checkIsHttpToken('')               // false — empty
// _checkIsHttpToken('Héllo')          // false — non-ASCII
//
// // ── _checkInvalidHeaderChar ───────────────────────────────────────────────
// _checkInvalidHeaderChar('text/html')          // false — valid
// _checkInvalidHeaderChar('foo\r\nSet-Cookie:') // true  — CRLF injection
// _checkInvalidHeaderChar('foo\x00bar')         // true  — NUL byte
// _checkInvalidHeaderChar('foo\x7fbar')         // true  — DEL char
//
// // ── chunkExpression ───────────────────────────────────────────────────────
// chunkExpression.test('chunked')               // true
// chunkExpression.test('gzip, chunked')         // true
// chunkExpression.test('CHUNKED')               // true  — case-insensitive
// chunkExpression.test('gzip')                  // false
//
// // ── continueExpression ────────────────────────────────────────────────────
// continueExpression.test('100-continue')       // true
// continueExpression.test('foo, 100-continue')  // true
// continueExpression.test('200-ok')             // false
//
// // ── kIncomingMessage — per-server IncomingMessage override ────────────────
// import { createServer } from './http';  // hypothetical http shim
// const server = createServer();
// server[kIncomingMessage] = class MyRequest extends IncomingMessage {};
//
// // ── methods ───────────────────────────────────────────────────────────────
// methods.includes('GET')       // true
// methods.includes('PURGE')     // true
// methods.includes('INVENTED')  // false
// Object.isFrozen(methods)      // true
