// src/tls.js — port of node:tls for the browser runtime.
//
// Raw TLS is impossible in a browser (no access to the TLS handshake, no
// client certificates, no private-key operations). This module is an honest
// emulation: it exports the real node:tls surface (TLSSocket, Server,
// createServer, connect, createSecureContext, getCiphers, constants, ...)
// with correct shapes and argument validation, but no real cryptography
// happens. Anything that would be a security decision in real Node is
// stubbed to a safe, documented value — never silently fabricated.
//
// Browser strategy:
// - TLSSocket extends the project's EventEmitter (src/events.js) with
//   net.Socket-compatible method shapes (connect/write/end/destroy/sets).
// - connect() performs an *emulated* handshake: asynchronously emits
//   'connect' then 'secureConnect' and invokes the callback. It never
//   attempts real TCP and never emits 'error' for unreachable hosts.
// - Handshake-derived getters (getCipher, getProtocol, getPeerCertificate,
//   getSession, ...) return null/empty/undefined — never made-up data.
// - getCiphers() returns Node's real static cipher list (compile-time data).
// - checkServerIdentity() implements the pure hostname-matching part
//   (SAN dNSName/iPAddress + CN fallback, RFC 6125 wildcard rules). Chain
//   building and signature verification are browser-impossible, so a
//   returned `undefined` means "hostname matches", NOT "certificate trusted".
// - createSecureContext() returns an opaque SecureContext handle (noops).
//
// Runtime contract: uses globalThis._RUNTIME_ only via the guarded RT alias
// (currently unused — kept for future host-network hooks); no window/
// document at module scope; works standalone under real Node too.

import { EventEmitter } from './events.js';
import { SecureContext, createSecureContext } from './_tls_common.js';

const RT = (typeof globalThis._RUNTIME_ !== 'undefined')
  ? globalThis._RUNTIME_
  : undefined;
void RT;

// ---------------------------------------------------------------------------
// Static data (compile-time facts from Node v24.20.0, not fabricated)
// ---------------------------------------------------------------------------

// Real output of tls.getCiphers() on Node v24.20.0.
const CIPHER_LIST = [
  'aes128-gcm-sha256', 'aes128-sha', 'aes128-sha256', 'aes256-gcm-sha384',
  'aes256-sha', 'aes256-sha256', 'dhe-psk-aes128-cbc-sha',
  'dhe-psk-aes128-cbc-sha256', 'dhe-psk-aes128-gcm-sha256',
  'dhe-psk-aes256-cbc-sha', 'dhe-psk-aes256-cbc-sha384',
  'dhe-psk-aes256-gcm-sha384', 'dhe-psk-chacha20-poly1305',
  'dhe-rsa-aes128-gcm-sha256', 'dhe-rsa-aes128-sha', 'dhe-rsa-aes128-sha256',
  'dhe-rsa-aes256-gcm-sha384', 'dhe-rsa-aes256-sha', 'dhe-rsa-aes256-sha256',
  'dhe-rsa-chacha20-poly1305', 'ecdhe-ecdsa-aes128-gcm-sha256',
  'ecdhe-ecdsa-aes128-sha', 'ecdhe-ecdsa-aes128-sha256',
  'ecdhe-ecdsa-aes256-gcm-sha384', 'ecdhe-ecdsa-aes256-sha',
  'ecdhe-ecdsa-aes256-sha384', 'ecdhe-ecdsa-chacha20-poly1305',
  'ecdhe-psk-aes128-cbc-sha', 'ecdhe-psk-aes128-cbc-sha256',
  'ecdhe-psk-aes256-cbc-sha', 'ecdhe-psk-aes256-cbc-sha384',
  'ecdhe-psk-chacha20-poly1305', 'ecdhe-rsa-aes128-gcm-sha256',
  'ecdhe-rsa-aes128-sha', 'ecdhe-rsa-aes128-sha256',
  'ecdhe-rsa-aes256-gcm-sha384', 'ecdhe-rsa-aes256-sha',
  'ecdhe-rsa-aes256-sha384', 'ecdhe-rsa-chacha20-poly1305',
  'psk-aes128-cbc-sha', 'psk-aes128-cbc-sha256', 'psk-aes128-gcm-sha256',
  'psk-aes256-cbc-sha', 'psk-aes256-cbc-sha384', 'psk-aes256-gcm-sha384',
  'psk-chacha20-poly1305', 'rsa-psk-aes128-cbc-sha',
  'rsa-psk-aes128-cbc-sha256', 'rsa-psk-aes128-gcm-sha256',
  'rsa-psk-aes256-cbc-sha', 'rsa-psk-aes256-cbc-sha384',
  'rsa-psk-aes256-gcm-sha384', 'rsa-psk-chacha20-poly1305',
  'srp-aes-128-cbc-sha', 'srp-aes-256-cbc-sha', 'srp-rsa-aes-128-cbc-sha',
  'srp-rsa-aes-256-cbc-sha', 'tls_aes_128_ccm_8_sha256',
  'tls_aes_128_ccm_sha256', 'tls_aes_128_gcm_sha256',
  'tls_aes_256_gcm_sha384', 'tls_chacha20_poly1305_sha256',
];

export function getCiphers() {
  return [...CIPHER_LIST];
}

// Real tls.DEFAULT_CIPHERS from Node v24.20.0 (static config string).
export const DEFAULT_CIPHERS =
  'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:' +
  'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:' +
  'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:' +
  'DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:' +
  'ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:' +
  'DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA';

export const DEFAULT_ECDH_CURVE = 'auto';
export const DEFAULT_MAX_VERSION = 'TLSv1.3';
export const DEFAULT_MIN_VERSION = 'TLSv1.2';
export const CLIENT_RENEG_LIMIT = 3;
export const CLIENT_RENEG_WINDOW = 600;

// Gap: real Node bundles ~118 Mozilla CA certificates here. Embedding them
// would add ~250KB to the bundle and they would still be unverifiable in the
// browser (no chain building), so we ship the honest empty list and document
// it. Use fetch() against a host you trust if you need CA data.
export const rootCertificates = [];

// ---------------------------------------------------------------------------
// Error helpers (mirror Node's codes/messages for observable behaviour)
// ---------------------------------------------------------------------------

function errSocketBadPort(port) {
  const received = port === undefined ? 'undefined' : String(port);
  const err = new RangeError(
    `Port should be >= 0 and < 65536. Received ${received}.`);
  err.code = 'ERR_SOCKET_BAD_PORT';
  return err;
}

function errStreamDestroyed() {
  const err = new Error('Cannot call write after a stream was destroyed');
  err.code = 'ERR_STREAM_DESTROYED';
  return err;
}

function errOutOfRangeProtocol(index) {
  const err = new RangeError(
    `The byte length of the protocol at index ${index} exceeds the ` +
    'maximum length of 255 bytes.');
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) ||
      port < 0 || port > 65535) {
    throw errSocketBadPort(port);
  }
  return port;
}

// ---------------------------------------------------------------------------
// TLSSocket
// ---------------------------------------------------------------------------

const kOptions = Symbol('tls.options');

export class TLSSocket extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    // Support new TLSSocket(options) as well as new TLSSocket(socket, options).
    if (socket != null && !(socket instanceof EventEmitter) &&
        typeof socket === 'object' && Object.getPrototypeOf(socket) === Object.prototype &&
        (options == null || Object.keys(options).length === 0)) {
      options = socket;
      socket = null;
    }
    if (options == null || typeof options !== 'object') options = {};
    this[kOptions] = { ...options };
    this._parentSocket = socket instanceof EventEmitter ? socket : null;

    // net.Socket-compatible state fields.
    this.connecting = false;
    this.pending = true;
    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._idleTimeout = 0;

    // TLS state. `authorized` stays false: no verification ever happens in
    // the emulation, so claiming "authorized" would be a fabricated
    // security decision.
    this.authorized = false;
    this.authorizationError = null;
    this.encrypted = true;
    this.alpnProtocol = null;
    this.servername = options.servername ?? null;
    this._secureEstablished = false;
  }

  // -- connection ---------------------------------------------------------
  connect(...args) {
    let options;
    let callback = null;
    if (args.length === 0) {
      options = {};
    } else if (typeof args[0] === 'number' || typeof args[0] === 'string') {
      if (typeof args[args.length - 1] === 'function') {
        callback = args.pop();
      }
      if (typeof args[0] === 'string') {
        options = { path: args[0] };
      } else {
        options = { port: args[0] };
        if (typeof args[1] === 'string') options.host = args[1];
      }
    } else {
      if (typeof args[args.length - 1] === 'function') {
        callback = args.pop();
      }
      options = { ...args[0] };
    }

    if (options.path == null) {
      validatePort(options.port);
    } else if (typeof options.path !== 'string') {
      const err = new TypeError(
        `The "options.path" property must be of type string. Received ${options.path}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }

    if (callback !== null) this.once('secureConnect', callback);
    if (this.servername == null && typeof options.servername === 'string') {
      this.servername = options.servername;
    }

    this.destroyed = false;
    this.readable = true;
    this.writable = true;
    this.connecting = true;
    this.pending = true;

    if (options.signal != null && options.signal.aborted) {
      queueMicrotask(() => this.destroy(options.signal.reason));
      return this;
    }

    // Emulated handshake. No TCP/TLS packets are ever sent: the browser has
    // no API for a raw TLS handshake. We asynchronously report the
    // connection as established so callback/event-driven code works.
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.connecting = false;
      this.pending = false;
      this.emit('connect');
      queueMicrotask(() => {
        if (this.destroyed) return;
        this._secureEstablished = true;
        this.emit('secureConnect');
      });
    });
    return this;
  }

  // -- stream-compatible writes -------------------------------------------
  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    if (this.destroyed) {
      const err = errStreamDestroyed();
      if (typeof callback === 'function') queueMicrotask(() => callback(err));
      return false;
    }
    if (chunk != null) {
      this.bytesWritten += typeof chunk === 'string'
        ? chunk.length
        : (chunk.length ?? chunk.byteLength ?? 0);
    }
    if (typeof callback === 'function') queueMicrotask(() => callback(null));
    return true;
  }

  end(data, encoding, callback) {
    if (typeof data === 'function') {
      callback = data;
      data = undefined;
      encoding = undefined;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = undefined;
    }
    queueMicrotask(() => {
      this.emit('end');
      if (typeof callback === 'function') callback();
    });
    return this;
  }

  destroy(err) {
    if (this.destroyed) {
      if (err != null) this.emit('error', err);
      return this;
    }
    this.destroyed = true;
    this.readable = false;
    this.writable = false;
    this.connecting = false;
    queueMicrotask(() => {
      if (err != null) this.emit('error', err);
      this.emit('close', err != null);
    });
    return this;
  }

  // -- socket options (noops with correct shapes) --------------------------
  setNoDelay(_enable = true) { return this; }
  setKeepAlive(_enable = false, _initialDelay = 0) { return this; }
  setTimeout(timeout, callback) {
    this._idleTimeout = timeout;
    if (typeof callback === 'function') this.once('timeout', callback);
    return this;
  }
  ref() { return this; }
  unref() { return this; }

  address() { return null; }
  get remoteAddress() { return undefined; }
  get remotePort() { return undefined; }
  get localAddress() { return undefined; }
  get localPort() { return undefined; }
  get remoteFamily() { return undefined; }

  // -- TLS-specific API ----------------------------------------------------
  setServername(name) {
    this.servername = name;
  }

  renegotiate(_options, callback) {
    // No real renegotiation possible; report success asynchronously.
    if (typeof callback === 'function') queueMicrotask(() => callback(null));
    return true;
  }

  disableRenegotiation() {}
  enableTrace() {}
  setSession(_session) {}

  // Returns false: there is no session to fragment in the emulation.
  setMaxSendFragment(_size) { return false; }

  // Handshake-derived values: null/empty/undefined, never fabricated.
  getCipher() { return null; }
  getPeerCertificate(_detailed) { return {}; }
  getProtocol() { return null; }
  getSession() { return undefined; }
  isSessionReused() { return false; }
  getSharedSigalgs() { return []; }
  getEphemeralKeyInfo() { return null; }
  getFinished() { return undefined; }
  getPeerFinished() { return undefined; }
  getTLSTicket() { return undefined; }
  getPeerX509Certificate() { return undefined; }
  getX509Certificate() { return undefined; }
  getCertificate() { return {}; }
  exportKeyingMaterial(_length, _label, _context) { return null; }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class Server extends EventEmitter {
  constructor(options, connectionListener) {
    super();
    if (typeof options === 'function') {
      connectionListener = options;
      options = {};
    }
    this._options = { ...(options || {}) };
    this.listening = false;
    this._connections = 0;
    if (typeof connectionListener === 'function') {
      this.on('secureConnection', connectionListener);
    }
  }

  listen(...args) {
    const last = args[args.length - 1];
    if (typeof last === 'function') this.once('listening', last);
    // No real listener is bound: the browser cannot accept raw TCP/TLS.
    queueMicrotask(() => {
      this.listening = true;
      this.emit('listening');
    });
    return this;
  }

  close(callback) {
    queueMicrotask(() => {
      this.listening = false;
      this.emit('close');
      if (typeof callback === 'function') callback();
    });
    return this;
  }

  address() { return null; }

  getConnections(callback) {
    if (typeof callback === 'function') {
      queueMicrotask(() => callback(null, this._connections));
    }
    return this;
  }

  // Gap: there are no real session-ticket keys without a TLS stack.
  // Returning zeroed bytes would fabricate key material, so we return null.
  getTicketKeys() { return null; }
  setTicketKeys(_keys) { return this; }
  setSecureContext(_options) {}
  addContext(_hostname, _context) {}
}

export function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}

// ---------------------------------------------------------------------------
// connect / createConnection
// ---------------------------------------------------------------------------

export function connect(...args) {
  const socket = new TLSSocket();
  // No real encryption takes place in the emulation; mark it honestly.
  socket.encrypted = false;
  return socket.connect(...args);
}

// ---------------------------------------------------------------------------
// convertALPNProtocols — pure logic, real implementation
// ---------------------------------------------------------------------------

export function convertALPNProtocols(protocols, out) {
  const parts = [];
  let total = 0;
  let index = 0;
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  for (const protocol of protocols) {
    let bytes;
    if (typeof protocol === 'string') {
      bytes = encoder ? encoder.encode(protocol)
        : globalThis.Buffer.from(protocol, 'utf8');
    } else if (protocol instanceof Uint8Array) {
      bytes = protocol;
    } else {
      const err = new TypeError(
        'The "protocols" entries must be of type string or Buffer.' +
        ` Received ${protocol}`);
      err.code = 'ERR_INVALID_ARG_TYPE';
      throw err;
    }
    if (bytes.length > 255) throw errOutOfRangeProtocol(index);
    parts.push(bytes);
    total += 1 + bytes.length;
    index++;
  }
  const packed = new Uint8Array(total);
  let offset = 0;
  for (const bytes of parts) {
    packed[offset++] = bytes.length;
    packed.set(bytes, offset);
    offset += bytes.length;
  }
  // Assigning on null/undefined throws a plain TypeError, mirroring Node.
  out.ALPNProtocols = typeof globalThis.Buffer !== 'undefined'
    ? globalThis.Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength)
    : packed;
  return undefined;
}

// ---------------------------------------------------------------------------
// checkServerIdentity — pure hostname matching (no chain verification)
// ---------------------------------------------------------------------------

function isIPHost(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':');
}

// RFC 6125 §6.4.3 as implemented by Node: a wildcard may only be the entire
// left-most label and matches exactly one label.
function dnsNameMatches(host, pattern) {
  host = String(host).toLowerCase();
  pattern = String(pattern).toLowerCase();
  if (host === pattern) return true;
  if (!pattern.startsWith('*.')) return false;
  const rest = pattern.slice(2);
  if (rest.includes('*') || rest.length === 0) return false;
  if (!host.endsWith(`.${rest}`)) return false;
  const left = host.slice(0, host.length - rest.length - 1);
  return left.length > 0 && !left.includes('.');
}

// Mirrors Node's observable contract: returns undefined when the hostname
// matches the certificate's names, an Error describing the mismatch
// otherwise, and throws a plain TypeError for a null/undefined cert (same
// as real Node, which reads cert.subject unguarded).
//
// Honesty note: this checks the *hostname* only. Signature verification and
// chain building are browser-impossible, so `undefined` here means
// "hostname matches", NOT "certificate is trusted".
export function checkServerIdentity(hostname, cert) {
  const { subjectaltname = '', subject } = cert;
  const host = String(hostname);
  const dnsNames = [];
  const ipAddrs = [];
  if (typeof subjectaltname === 'string' && subjectaltname.length > 0) {
    for (const entry of subjectaltname.split(', ')) {
      if (entry.startsWith('DNS:')) dnsNames.push(entry.slice(4));
      else if (entry.startsWith('IP Address:')) ipAddrs.push(entry.slice(11));
    }
  }

  if (isIPHost(host)) {
    const lower = host.toLowerCase();
    if (ipAddrs.some((ip) => ip.toLowerCase() === lower)) return undefined;
    return new Error(
      `Hostname/IP does not match certificate's altnames: ` +
      `IP: ${host} is not in the cert's altnames: ${subjectaltname || '(none)'}`);
  }

  for (const name of dnsNames) {
    if (dnsNameMatches(host, name)) return undefined;
  }

  // CN fallback, only when no dNSName SANs are present (as in Node).
  const cn = subject != null && typeof subject === 'object' ? subject.CN : undefined;
  if (dnsNames.length === 0 && typeof cn === 'string') {
    if (dnsNameMatches(host, cn)) return undefined;
  }

  if (dnsNames.length === 0 && cn === undefined) {
    return new Error(
      `Hostname/IP does not match certificate's altnames: ` +
      'Cert does not contain a dNSName nor an iPAddress subjectAltName ' +
      'and has no commonName to fall back to');
  }
  return new Error(
    `Hostname/IP does not match certificate's altnames: ` +
    `Host: ${host}. is not in the cert's altnames: ${subjectaltname}`);
}

// ---------------------------------------------------------------------------
// Remaining namespace surface
// ---------------------------------------------------------------------------

// Gap: no CA store exists in the emulation (see rootCertificates).
export function getCACertificates() { return []; }

// Gap: certificate compression needs a real TLS stack.
export function getCertificateCompressionAlgorithms() { return []; }

export function setDefaultCACertificates(_certs) {}

export {
  SecureContext,
  createSecureContext,
};

export default {
  CLIENT_RENEG_LIMIT,
  CLIENT_RENEG_WINDOW,
  DEFAULT_CIPHERS,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  SecureContext,
  Server,
  TLSSocket,
  checkServerIdentity,
  connect,
  convertALPNProtocols,
  createSecureContext,
  createServer,
  getCACertificates,
  getCertificateCompressionAlgorithms,
  getCiphers,
  rootCertificates,
  setDefaultCACertificates,
};
