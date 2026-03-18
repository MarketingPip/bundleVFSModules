/**
 * tls shim - Wraps net.Socket to simulate encrypted connections
 */
import { Socket } from "./net"
import { EventEmitter } from "events"
import { Buffer } from 'buffer'

/**
 * TLSSocket inherits from net.Socket to provide stream capabilities
 */
export class TLSSocket extends Socket {
  authorized = true
  encrypted = true
  _secureEstablished = false

  constructor(socket, options = {}) {
    // If a raw socket is provided, we wrap it (Node.js behavior)
    // Otherwise, we act as a standalone socket
    super(options)
    
    if (socket instanceof Socket) {
      this._parentSocket = socket
    }

    // Node.js TLS sockets must emit 'secureConnect' after 'connect'
    this.on("connect", () => {
      queueMicrotask(() => {
        this._secureEstablished = true
        this.emit("secureConnect")
      })
    })
  }

  getPeerCertificate(detailed) {
    return {
      subject: { CN: "localhost" },
      issuer: { CN: "Browser Shim CA" },
      valid_from: new Date().toUTCString(),
      valid_to: "Dec 31 2099",
      fingerprint: "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00"
    }
  }

  getCipher() {
    return {
      name: "TLS_AES_256_GCM_SHA384",
      standardName: "TLS_AES_256_GCM_SHA384",
      version: "TLSv1.3"
    }
  }

  getProtocol() {
    return "TLSv1.3"
  }

  setServername(name) {
    this.servername = name
  }

  renegotiate(_options, callback) {
    if (callback) queueMicrotask(callback)
    return true
  }
}

/**
 * Virtual TLS Server
 */
export class Server extends EventEmitter {
  constructor(options, connectionListener) {
    super()
    if (connectionListener) this.on("secureConnection", connectionListener)
  }

  listen(...args) {
    // Return this for chaining, simulates starting a listener
    queueMicrotask(() => this.emit("listening"))
    return this
  }

  close(callback) {
    if (callback) queueMicrotask(callback)
    this.emit("close")
    return this
  }

  address() {
    return { port: 443, family: "IPv4", address: "127.0.0.1" }
  }

  getTicketKeys() {
    return Buffer.alloc(48)
  }

  setTicketKeys(_keys) {}
  setSecureContext(_options) {}
}

/**
 * Factory functions
 */
export function createServer(options, connectionListener) {
  return new Server(options, connectionListener)
}

export function connect(portOrOptions, hostOrCallback, callback) {
  const socket = new TLSSocket()
  
  // Reuse the connection logic from net.Socket
  let options = {}
  let cb = callback

  if (typeof portOrOptions === "object") {
    options = portOrOptions
    cb = hostOrCallback || callback
  } else {
    options.port = portOrOptions
    options.host = hostOrCallback
  }

  return socket.connect(options, cb)
}

// Constants and Helpers
export const createSecureContext = _options => ({})
export const getCiphers = () => ["TLS_AES_256_GCM_SHA384", "TLS_AES_128_GCM_SHA256"]
export const DEFAULT_ECDH_CURVE = "auto"
export const DEFAULT_MAX_VERSION = "TLSv1.3"
export const DEFAULT_MIN_VERSION = "TLSv1.2"
export const rootCertificates = []

export default {
  TLSSocket,
  Server,
  createServer,
  connect,
  createSecureContext,
  getCiphers,
  DEFAULT_ECDH_CURVE,
  DEFAULT_MAX_VERSION,
  DEFAULT_MIN_VERSION,
  rootCertificates
}
