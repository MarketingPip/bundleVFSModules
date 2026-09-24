// src/_http_outgoing.js — node:_http_outgoing for the browser runtime.
//
// Single source of truth: src/http.js (OutgoingMessage, header validators).
// The well-known symbols and parseUniqueHeadersOption are ported faithfully
// from Node v24.20.0's lib/_http_outgoing.js.

export {
  OutgoingMessage,
  validateHeaderName,
  validateHeaderValue,
} from './http.js';
export {
  kUniqueHeaders,
  kHighWaterMark,
} from './internals/http-symbols.js';
import {
  OutgoingMessage,
  validateHeaderName,
  validateHeaderValue,
} from './http.js';
import {
  kUniqueHeaders,
  kHighWaterMark,
} from './internals/http-symbols.js';

/**
 * Parse the `uniqueHeaders` server option into a Set of lowercased names
 * (null when the option is not an array), exactly like Node.
 */
export function parseUniqueHeadersOption(headers) {
  if (!Array.isArray(headers)) {
    return null;
  }
  const unique = new Set();
  for (const name of headers) {
    unique.add(String(name).toLowerCase());
  }
  return unique;
}

export default {
  OutgoingMessage,
  validateHeaderName,
  validateHeaderValue,
  kUniqueHeaders,
  kHighWaterMark,
  parseUniqueHeadersOption,
};
