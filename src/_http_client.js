// src/_http_client.js — node:_http_client for the browser runtime.
//
// Single source of truth: src/http.js. This module re-exports ClientRequest
// so `node:_http_client` stays consistent with `node:http`.
// Browser note: backed by fetch(); no raw TCP socket.

export { ClientRequest } from './http.js';
import { ClientRequest } from './http.js';

export default { ClientRequest };
