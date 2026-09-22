// src/_http_incoming.js — node:_http_incoming for the browser runtime.
//
// Single source of truth: src/http.js (IncomingMessage). The parser-driven
// readStart/readStop helpers have no native parser in the browser and are
// honest no-ops.

export { IncomingMessage } from './http.js';
import { IncomingMessage } from './http.js';

export const kDetachAbortSignal = Symbol('kDetachAbortSignal');

/** No-op: no native HTTP parser to start in the browser. */
export function readStart(/* socket */) {}

/** No-op: no native HTTP parser to stop in the browser. */
export function readStop(/* socket */) {}

export default { IncomingMessage, kDetachAbortSignal, readStart, readStop };
