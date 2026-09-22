// src/_http_server.js — node:_http_server for the browser runtime.
//
// Single source of truth: src/http.js (Server, ServerResponse). Connection
// tracking and pre-close helpers have no TCP connections in the browser and
// are honest no-ops.

export {
  Server,
  ServerResponse,
  STATUS_CODES,
  _connectionListener,
} from './http.js';
import {
  Server,
  ServerResponse,
  STATUS_CODES,
  _connectionListener,
} from './http.js';

export const kServerResponse = Symbol('ServerResponse');
export const kConnectionsCheckingInterval =
  Symbol('http.server.connectionsCheckingInterval');

/** No-op: no connections to pre-close in the virtual server. */
export function httpServerPreClose(/* server */) {}

/** No-op: connection tracking needs real sockets. */
export function setupConnectionsTracking(/* server, options */) {}

/** No-op: virtual servers accept options directly in the constructor. */
export function storeHTTPOptions(/* options */) {}

export default {
  Server,
  ServerResponse,
  STATUS_CODES,
  _connectionListener,
  kServerResponse,
  kConnectionsCheckingInterval,
  httpServerPreClose,
  setupConnectionsTracking,
  storeHTTPOptions,
};
