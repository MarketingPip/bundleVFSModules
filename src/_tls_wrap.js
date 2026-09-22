// node:_tls_wrap — Node internal module.
// Real Node exports { TLSSocket, Server, createServer, connect }.
//
// INTERIM minimal shape-preserving stubs. The browser has no raw-TLS API and
// our tls port is being rebuilt by the tls worker (Wave C), which will rewire
// this file to the real implementation. Until then these are honest noops
// that never throw.
// Dependency-free ESM (imports only our events port), browser-safe,
// no _RUNTIME_ access needed.
import { EventEmitter } from './events.js';

export class TLSSocket extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this._socket = socket ?? null;
    this._options = options;
    this.encrypted = true;
    this.authorized = false;
  }
  getPeerCertificate(_detailed) { return {}; }
  getCipher() { return null; }
  getProtocol() { return null; }
}

export class Server extends EventEmitter {
  constructor(options = {}, connectionListener) {
    super();
    if (typeof options === 'function') {
      connectionListener = options;
      options = {};
    }
    this._options = options;
    if (typeof connectionListener === 'function') {
      this.on('secureConnection', connectionListener);
    }
  }
  listen(..._args) { return this; }
  close(cb) { if (typeof cb === 'function') queueMicrotask(cb); return this; }
  address() { return null; }
}

export function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}

export function connect(..._args) {
  // No raw-TLS in the browser: returns an unconnected socket, never throws.
  return new TLSSocket();
}

export default { TLSSocket, Server, createServer, connect };
