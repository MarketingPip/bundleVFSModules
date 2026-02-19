/**
 * Node.js net module shim
 * Basic Socket and Server classes for virtual networking
 */

import { EventEmitter } from "./events"
import { Duplex, Buffer } from "./stream"

/**
 * Virtual Socket implementation
 */
export class Socket extends Duplex {
  _connecting = false
  _connected = false
  _destroyed = false
  _remoteAddress = ""
  _remotePort = 0
  _localAddress = "127.0.0.1"
  _localPort = 0

  localAddress = "127.0.0.1"
  localPort = 0
  connecting = false
  destroyed = false
  readyState = "closed"

  constructor(options) {
    super()
  }

  connect(portOrOptions, hostOrCallback, callback) {
    let port
    let host = "127.0.0.1"
    let cb

    if (typeof portOrOptions === "number") {
      port = portOrOptions
      if (typeof hostOrCallback === "string") {
        host = hostOrCallback
        cb = callback
      } else {
        cb = hostOrCallback
      }
    } else {
      port = portOrOptions.port
      host = portOrOptions.host || "127.0.0.1"
      cb = typeof hostOrCallback === "function" ? hostOrCallback : callback
    }

    this._connecting = true
    this.connecting = true
    this._remoteAddress = host
    this._remotePort = port
    this.remoteAddress = host
    this.remotePort = port
    this.remoteFamily = "IPv4"
    this.readyState = "opening"

    // Simulate async connection
    queueMicrotask(() => {
      this._connecting = false
      this._connected = true
      this.connecting = false
      this.readyState = "open"
      this.emit("connect")
      if (cb) cb()
    })

    return this
  }

  address() {
    if (!this._connected) return null
    return {
      address: this._localAddress,
      family: "IPv4",
      port: this._localPort
    }
  }

  setEncoding(encoding) {
    return this
  }

  setTimeout(timeout, callback) {
    if (callback) {
      this.once("timeout", callback)
    }
    return this
  }

  setNoDelay(noDelay) {
    return this
  }

  setKeepAlive(enable, initialDelay) {
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  destroy(error) {
    if (this._destroyed) return this

    this._destroyed = true
    this._connected = false
    this.destroyed = true
    this.readyState = "closed"

    if (error) {
      this.emit("error", error)
    }

    queueMicrotask(() => {
      this.emit("close", !!error)
    })

    return this
  }

  // Internal: simulate receiving data from remote
  _receiveData(data) {
    const buffer = typeof data === "string" ? Buffer.from(data) : data
    this.push(buffer)
  }

  // Internal: signal end of remote data
  _receiveEnd() {
    this.push(null)
  }
}

/**
 * Virtual Server implementation
 */
export class Server extends EventEmitter {
  _listening = false
  _address = null
  _connections = new Set()
  _maxConnections = Infinity

  listening = false

  constructor(optionsOrConnectionListener, connectionListener) {
    super()

    let listener

    if (typeof optionsOrConnectionListener === "function") {
      listener = optionsOrConnectionListener
    } else {
      listener = connectionListener
    }

    if (listener) {
      this.on("connection", listener)
    }
  }

  listen(portOrOptions, hostOrCallback, backlogOrCallback, callback) {
    let port = 0
    let host = "0.0.0.0"
    let cb

    if (typeof portOrOptions === "number") {
      port = portOrOptions

      if (typeof hostOrCallback === "string") {
        host = hostOrCallback
        if (typeof backlogOrCallback === "function") {
          cb = backlogOrCallback
        } else {
          cb = callback
        }
      } else if (typeof hostOrCallback === "function") {
        cb = hostOrCallback
      } else if (typeof hostOrCallback === "number") {
        // backlog
        cb =
          typeof backlogOrCallback === "function" ? backlogOrCallback : callback
      } else {
        // hostOrCallback is undefined, check if callback is in third position
        if (typeof backlogOrCallback === "function") {
          cb = backlogOrCallback
        } else if (typeof callback === "function") {
          cb = callback
        }
      }
    } else if (portOrOptions) {
      port = portOrOptions.port || 0
      host = portOrOptions.host || "0.0.0.0"
      cb = typeof hostOrCallback === "function" ? hostOrCallback : callback
    }

    // Assign random port if 0
    if (port === 0) {
      port = 3000 + Math.floor(Math.random() * 1000)
    }

    this._address = {
      address: host,
      family: "IPv4",
      port
    }

    this._listening = true
    this.listening = true

    queueMicrotask(() => {
      this.emit("listening")
      if (cb) cb()
    })

    return this
  }

  address() {
    return this._address
  }

  close(callback) {
    this._listening = false
    this.listening = false

    // Close all connections
    for (const socket of this._connections) {
      socket.destroy()
    }
    this._connections.clear()

    queueMicrotask(() => {
      this.emit("close")
      if (callback) callback()
    })

    return this
  }

  getConnections(callback) {
    callback(null, this._connections.size)
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  // Internal: handle incoming connection
  _handleConnection(socket) {
    if (!this._listening) {
      socket.destroy()
      return
    }

    this._connections.add(socket)

    socket.on("close", () => {
      this._connections.delete(socket)
    })

    this.emit("connection", socket)
  }
}

export function createServer(optionsOrConnectionListener, connectionListener) {
  return new Server(optionsOrConnectionListener, connectionListener)
}

export function createConnection(portOrOptions, hostOrCallback, callback) {
  const socket = new Socket()
  return socket.connect(portOrOptions, hostOrCallback, callback)
}

export const connect = createConnection

export function isIP(input) {
  // Simple IPv4 check
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) {
    return 4
  }
  // Simple IPv6 check
  if (/^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(input)) {
    return 6
  }
  return 0
}

export function isIPv4(input) {
  return isIP(input) === 4
}

export function isIPv6(input) {
  return isIP(input) === 6
}

export default {
  Socket,
  Server,
  createServer,
  createConnection,
  connect,
  isIP,
  isIPv4,
  isIPv6
}
