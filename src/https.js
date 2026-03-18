/**
 * https shim - Bridges http logic with tls stubs
 */
import http from "./http";
import tls from "./tls";
import { EventEmitter } from "./events";

export class Server extends http.Server {
  constructor(options, requestListener) {
    // In a real shim, we'd pass the secure context, 
    // but here we just initialize the base http server
    super(options, requestListener);
  }
}

export function createServer(options, requestListener) {
  return new Server(options, requestListener);
}

export function request(url, options, callback) {
  // Force the protocol to https and use the http.request logic
  // Our http shim uses fetch() under the hood, so it handles SSL via the browser
  const config = typeof url === 'string' ? new URL(url) : url;
  return http.request(config, options, callback);
}

export function get(url, options, callback) {
  const req = request(url, options, callback);
  req.end();
  return req;
}

// Reuse Agent but with TLS defaults
export class Agent extends http.Agent {
  defaultPort = 443;
  protocol = 'https:';
}

export const globalAgent = new Agent();

export default {
  Server,
  createServer,
  request,
  get,
  Agent,
  globalAgent,
  // Expose TLS constants that https users expect
  SupportedProtocols: ['h2', 'http/1.1']
};
