import { EventEmitter } from 'events';
import { Buffer } from 'buffer'; // ✅ Works with the 'buffer' package
import { Readable, Writable} from 'stream-browserify';
import { Socket, Server as NetServer, AddressInfo } from './net';
import { createHash } from 'crypto-browserify';


/**
 * Node.js http module shim
 * Provides IncomingMessage, ServerResponse, and Server for virtual HTTP handling
 */

// Save the browser's native WebSocket at module load time, BEFORE any CLI bundle
// can overwrite it (e.g. Convex CLI does `globalThis.WebSocket = bundledWs`).
// This ensures our WebSocket bridge always uses the real browser implementation.
// Only capture in a real browser — Node.js 21+ has native WebSocket but it connects
// to real servers, which isn't what the shim needs.
const _isBrowser =
  typeof window !== "undefined" && typeof window.document !== "undefined"
const _BrowserWebSocket =
  _isBrowser && typeof globalThis.WebSocket === "function"
    ? globalThis.WebSocket
    : null

/**
 * Incoming HTTP request (Node.js compatible)
 */
export class IncomingMessage extends Readable {
  httpVersion = "1.1"
  httpVersionMajor = 1
  httpVersionMinor = 1
  complete = false
  headers = {}
  rawHeaders = []
  trailers = {}
  rawTrailers = []

  _body = null

  constructor(socket) {
    super()
    this.socket = socket || new Socket()
  }

  setTimeout(msecs, callback) {
    if (callback) {
      this.once("timeout", callback)
    }
    return this
  }

  destroy(error) {
    super.destroy(error)
    return this
  }

  // Internal: set body data
  _setBody(body) {
    if (body === null) {
      this._body = null
    } else {
      this._body = typeof body === "string" ? Buffer.from(body) : body
    }

    if (this._body) {
      this.push(this._body)
    }
    this.push(null)
    this.complete = true
  }

  // Internal: initialize from raw request
  static fromRequest(method, url, headers, body) {
    const msg = new IncomingMessage()
    msg.method = method
    msg.url = url
    msg.headers = { ...headers }

    // Build raw headers
    for (const [key, value] of Object.entries(headers)) {
      msg.rawHeaders.push(key, value)
    }

    if (body) {
      msg._setBody(body)
    } else {
      msg.push(null)
      msg.complete = true
    }

    return msg
  }
}

/**
 * Outgoing HTTP response (Node.js compatible)
 */
export class ServerResponse extends Writable {
  statusCode = 200
  statusMessage = "OK"
  headersSent = false
  finished = false
  sendDate = true

  _headers = new Map()
  _body = []

  constructor(req) {
    super()
    this.socket = req.socket
  }

  // Internal: set resolver for async response handling
  _setResolver(resolve) {
    this._resolve = resolve
  }

  setHeader(name, value) {
    if (this.headersSent) {
      throw new Error("Cannot set headers after they are sent")
    }
    this._headers.set(name.toLowerCase(), String(value))
    return this
  }

  getHeader(name) {
    return this._headers.get(name.toLowerCase())
  }

  getHeaders() {
    const headers = {}
    for (const [key, value] of this._headers) {
      headers[key] = value
    }
    return headers
  }

  getHeaderNames() {
    return [...this._headers.keys()]
  }

  hasHeader(name) {
    return this._headers.has(name.toLowerCase())
  }

  removeHeader(name) {
    if (this.headersSent) {
      throw new Error("Cannot remove headers after they are sent")
    }
    this._headers.delete(name.toLowerCase())
  }

  writeHead(statusCode, statusMessageOrHeaders, headers) {
    this.statusCode = statusCode

    if (typeof statusMessageOrHeaders === "string") {
      this.statusMessage = statusMessageOrHeaders
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          this.setHeader(key, value)
        }
      }
    } else if (statusMessageOrHeaders) {
      for (const [key, value] of Object.entries(statusMessageOrHeaders)) {
        this.setHeader(key, value)
      }
    }

    return this
  }

  write(chunk, encodingOrCallback, callback) {
    this.headersSent = true
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    this._body.push(buffer)

    const cb =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback
    if (cb) {
      queueMicrotask(() => cb(null))
    }

    return true
  }

  end(chunkOrCallback, encodingOrCallback, callback) {
    if (typeof chunkOrCallback === "function") {
      callback = chunkOrCallback
    } else if (chunkOrCallback !== undefined) {
      this.write(chunkOrCallback)
    }

    if (typeof encodingOrCallback === "function") {
      callback = encodingOrCallback
    }

    this.headersSent = true
    this.finished = true

    // Resolve with response data
    if (this._resolve) {
      const headers = {}
      for (const [key, value] of this._headers) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value
      }

      this._resolve({
        statusCode: this.statusCode,
        statusMessage: this.statusMessage,
        headers,
        body: Buffer.concat(this._body)
      })
    }

    queueMicrotask(() => {
      this.emit("finish")
      if (callback) callback()
    })

    return this
  }

  // Convenience method for simple responses
  send(data) {
    if (typeof data === "object" && !Buffer.isBuffer(data)) {
      this.setHeader("Content-Type", "application/json")
      data = JSON.stringify(data)
    }

    if (!this.hasHeader("Content-Type")) {
      this.setHeader("Content-Type", "text/html")
    }

    this.write(typeof data === "string" ? data : data)
    return this.end()
  }

  // Express compatibility
  json(data) {
    this.setHeader("Content-Type", "application/json")
    return this.end(JSON.stringify(data))
  }

  status(code) {
    this.statusCode = code
    return this
  }

  redirect(urlOrStatus, url) {
    if (typeof urlOrStatus === "number") {
      this.statusCode = urlOrStatus
      this.setHeader("Location", url)
    } else {
      this.statusCode = 302
      this.setHeader("Location", urlOrStatus)
    }
    this.end()
  }

  // Get body for testing/debugging
  _getBody() {
    return Buffer.concat(this._body)
  }

  _getBodyAsString() {
    return this._getBody().toString("utf8")
  }
}

/**
 * HTTP Server (Node.js compatible)
 */
export class Server extends EventEmitter {
  _pendingRequests = new Map()

  listening = false
  maxHeadersCount = null
  timeout = 0
  keepAliveTimeout = 5000
  headersTimeout = 60000
  requestTimeout = 0

  constructor(requestListener) {
    super()
    this._requestListener = requestListener
    this._netServer = new NetServer()

    this._netServer.on("listening", () => {
      this.listening = true
      this.emit("listening")
    })

    this._netServer.on("close", () => {
      this.listening = false
      this.emit("close")
    })

    this._netServer.on("error", err => {
      this.emit("error", err)
    })
  }

  listen(portOrOptions, hostOrCallback, callback) {
    let port
    let host
    let cb

    if (typeof portOrOptions === "number") {
      port = portOrOptions
      if (typeof hostOrCallback === "string") {
        host = hostOrCallback
        cb = callback
      } else {
        cb = hostOrCallback
      }
    } else if (portOrOptions) {
      port = portOrOptions.port
      host = portOrOptions.host
      cb = typeof hostOrCallback === "function" ? hostOrCallback : callback
    }

    // Wrap callback to register server after listening
    const originalCb = cb
    const self = this
    cb = function() {
      const addr = self._netServer.address()
      if (addr) {
        _registerServer(addr.port, self)
      }
      if (originalCb) originalCb()
    }

    this._netServer.listen(port, host, cb)

    return this
  }

  close(callback) {
    const addr = this._netServer.address()
    if (addr) {
      _unregisterServer(addr.port)
    }
    this._netServer.close(callback)
    return this
  }

  address() {
    return this._netServer.address()
  }

  setTimeout(msecs, callback) {
    this.timeout = msecs || 0
    if (callback) {
      this.on("timeout", callback)
    }
    return this
  }

  ref() {
    this._netServer.ref()
    return this
  }

  unref() {
    this._netServer.unref()
    return this
  }

  /**
   * Handle an incoming request (used by server bridge)
   */
  async handleRequest(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const req = IncomingMessage.fromRequest(method, url, headers, body)
      const res = new ServerResponse(req)

      res._setResolver(resolve)

      // Set timeout
      const timeoutId = this.timeout
        ? setTimeout(() => {
            reject(new Error("Request timeout"))
          }, this.timeout)
        : null

      res.on("finish", () => {
        if (timeoutId) clearTimeout(timeoutId)
      })

      try {
        this.emit("request", req, res)

        if (this._requestListener) {
          this._requestListener(req, res)
        }
      } catch (error) {
        if (timeoutId) clearTimeout(timeoutId)
        reject(error)
      }
    })
  }
}

/**
 * Create an HTTP server
 */
export function createServer(requestListener) {
  return new Server(requestListener)
}

/**
 * HTTP status codes
 */
export const STATUS_CODES = {
  100: "Continue",
  101: "Switching Protocols",
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable"
}

/**
 * HTTP methods
 */
export const METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE"
]

// CORS proxy getter - checks localStorage for configured proxy
function getCorsProxy() {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem("__corsProxyUrl") || null
  }
  return null
}

/**
 * HTTP Client Request - makes real HTTP requests using fetch()
 */
export class ClientRequest extends Writable {
  _bodyChunks = []
  _aborted = false
  _timeout = null
  _timeoutId = null
  _requestEnded = false

  constructor(options, protocol = "http") {
    super()
    this._options = options
    this._protocol = protocol
    this.method = options.method || "GET"
    this.path = options.path || "/"
    this.headers = {}

    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        this.headers[key.toLowerCase()] = Array.isArray(value)
          ? value.join(", ")
          : value
      }
    }
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value
  }

  getHeader(name) {
    return this.headers[name.toLowerCase()]
  }

  removeHeader(name) {
    delete this.headers[name.toLowerCase()]
  }

  write(chunk, encodingOrCallback, callback) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    this._bodyChunks.push(buffer)

    const cb =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback
    if (cb) {
      queueMicrotask(() => cb(null))
    }

    return true
  }

  end(dataOrCallback, encodingOrCallback, callback) {
    if (this._requestEnded) return this
    this._requestEnded = true

    // Handle overloaded arguments
    let finalCallback = callback
    if (typeof dataOrCallback === "function") {
      finalCallback = dataOrCallback
    } else if (dataOrCallback !== undefined) {
      this.write(dataOrCallback)
    }

    if (typeof encodingOrCallback === "function") {
      finalCallback = encodingOrCallback
    }

    // Perform the actual request
    this._performRequest()
      .then(() => {
        if (finalCallback) finalCallback()
      })
      .catch(error => {
        this.emit("error", error)
      })

    return this
  }

  abort() {
    this._aborted = true
    if (this._timeoutId) {
      clearTimeout(this._timeoutId)
    }
    this.emit("abort")
  }

  setTimeout(ms, callback) {
    this._timeout = ms
    if (callback) {
      this.once("timeout", callback)
    }
    return this
  }

  async _performRequest() {
    if (this._aborted) return

    try {
      // Build URL — Node.js supports both `hostname` and `host` (host may include port)
      const protocol = this._protocol === "https" ? "https:" : "http:"
      let hostname = this._options.hostname || ""
      let port = this._options.port ? `:${this._options.port}` : ""
      if (!hostname && this._options.host) {
        // host can be "domain.com" or "domain.com:8080"
        const hostParts = this._options.host.split(":")
        hostname = hostParts[0]
        if (!port && hostParts[1]) {
          port = `:${hostParts[1]}`
        }
      }
      if (!hostname) hostname = "localhost"
      const path = this._options.path || "/"
      const url = `${protocol}//${hostname}${port}${path}`

      // WebSocket upgrade requests can't use fetch() — browsers strip
      // Connection/Upgrade headers. Bridge to the browser's native WebSocket.
      if (this.headers["upgrade"]?.toLowerCase() === "websocket") {
        this._handleWebSocketUpgrade(url)
        return
      }

      // Use CORS proxy if configured
      const corsProxy = getCorsProxy()
      const fetchUrl = corsProxy ? corsProxy + encodeURIComponent(url) : url

      // Build fetch options
      const fetchOptions = {
        method: this.method,
        headers: this.headers
      }

      // Add body if we have one (not for GET/HEAD)
      if (
        this._bodyChunks.length > 0 &&
        this.method !== "GET" &&
        this.method !== "HEAD"
      ) {
        fetchOptions.body = Buffer.concat(this._bodyChunks)
      }

      // Set up timeout with AbortController
      const controller = new AbortController()
      fetchOptions.signal = controller.signal

      if (this._timeout) {
        this._timeoutId = setTimeout(() => {
          controller.abort()
          this.emit("timeout")
        }, this._timeout)
      }

      // Make the request
      const response = await fetch(fetchUrl, fetchOptions)

      // Clear timeout
      if (this._timeoutId) {
        clearTimeout(this._timeoutId)
        this._timeoutId = null
      }

      if (this._aborted) return

      // Convert response to IncomingMessage
      const incomingMessage = await this._responseToIncomingMessage(response)

      // Emit response event
      this.emit("response", incomingMessage)
    } catch (error) {
      if (this._timeoutId) {
        clearTimeout(this._timeoutId)
      }
      if (this._aborted) return

      // Wrap abort errors
      if (error instanceof Error && error.name === "AbortError") {
        // Already emitted timeout event
        return
      }

      this.emit("error", error)
    }
  }

  async _responseToIncomingMessage(response) {
    const msg = new IncomingMessage()

    // Set status
    msg.statusCode = response.status
    msg.statusMessage =
      response.statusText || STATUS_CODES[response.status] || ""

    // Copy headers
    response.headers.forEach((value, key) => {
      msg.headers[key.toLowerCase()] = value
      msg.rawHeaders.push(key, value)
    })

    // Read body and push to stream
    const body = await response.arrayBuffer()
    msg._setBody(Buffer.from(body))

    return msg
  }

  /**
   * Bridge a WebSocket upgrade request to the browser's native WebSocket.
   *
   * The bundled ws library (inside the Convex CLI) creates WebSocket connections
   * via http.request() with Upgrade headers. It expects frame-level I/O on the
   * socket from the 'upgrade' event. This method bridges between:
   *   - ws library ↔ frame-level I/O on a mock Socket
   *   - browser native WebSocket ↔ message-level I/O
   */
  _handleWebSocketUpgrade(url) {
    // Convert http(s):// to ws(s)://
    const wsUrl = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:")

    // Get Sec-WebSocket-Key from request headers (sent by ws library)
    const wsKey = this.headers["sec-websocket-key"] || ""

    // Use the saved browser WebSocket (captured at module load time before CLI overrides)
    const NativeWS = _BrowserWebSocket

    if (!NativeWS) {
      // No native WebSocket (test env / Node.js) — emit TypeError like fetch would
      setTimeout(() => {
        this.emit("error", new TypeError("Failed to fetch"))
      }, 0)
      return
    }

    // Compute Sec-WebSocket-Accept using the same hash as the ws library.
    // The ws library (bundled in the Convex CLI) uses require("crypto") which
    // resolves to our crypto shim's createHash (syncHash). We must use the same
    // GUID as the bundled ws@8.18.0 (which differs from the standard RFC 6455 GUID).
    const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    const acceptValue = createHash("sha1")
      .update(wsKey + GUID)
      .digest("base64")

    let nativeWs
    try {
      nativeWs = new NativeWS(wsUrl)
      nativeWs.binaryType = "arraybuffer"
    } catch (e) {
      setTimeout(() => {
        this.emit("error", e instanceof Error ? e : new Error(String(e)))
      }, 0)
      return
    }

    // Create mock socket for the ws library's frame-level I/O
    const socket = new Socket()
    // ws library calls cork/uncork for batching — add as no-ops if missing
    if (typeof socket.cork !== "function") socket.cork = () => {}
    if (typeof socket.uncork !== "function") socket.uncork = () => {}
    // ws library checks _readableState and _writableState on socket close
    socket._readableState = { endEmitted: false }
    socket._writableState = { finished: false, errorEmitted: false }

    // Buffer for partial frame writes from ws library
    let writeBuffer = new Uint8Array(0)

    // Override socket.write to intercept outgoing frames from ws library
    socket.write = (chunk, encodingOrCallback, callback) => {
      const data =
        typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk)
      const cb =
        typeof encodingOrCallback === "function" ? encodingOrCallback : callback

      // Append to write buffer
      const newBuf = new Uint8Array(writeBuffer.length + data.length)
      newBuf.set(writeBuffer, 0)
      newBuf.set(data, writeBuffer.length)
      writeBuffer = newBuf

      // Parse and forward complete frames
      while (writeBuffer.length >= 2) {
        const parsed = _parseWsFrame(writeBuffer)
        if (!parsed) break // incomplete frame — wait for more data

        const { opcode, payload, totalLength } = parsed
        writeBuffer = writeBuffer.slice(totalLength)

        if (nativeWs.readyState !== NativeWS.OPEN) continue

        if (opcode === 0x08) {
          // Close frame
          nativeWs.close()
        } else if (opcode === 0x09) {
          // Ping — respond with pong (shouldn't happen from client but handle it)
          nativeWs.send(payload)
        } else if (opcode === 0x0a) {
          // Pong — ignore
        } else if (opcode === 0x01) {
          // Text frame
          const text = new TextDecoder().decode(payload)
          nativeWs.send(text)
        } else if (opcode === 0x02) {
          // Binary frame
          nativeWs.send(payload)
        }
      }

      if (cb) queueMicrotask(() => cb(null))
      return true
    }

    nativeWs.onopen = () => {
      // Create HTTP 101 response
      const response = new IncomingMessage(socket)
      response.statusCode = 101
      response.statusMessage = "Switching Protocols"
      response.headers = {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-accept": acceptValue
      }
      // Mark as complete so ws library doesn't wait for body
      response.complete = true
      response.push(null)

      // Emit upgrade event — ws library listens for this
      this.emit("upgrade", response, socket, Buffer.alloc(0))
    }

    nativeWs.onmessage = event => {
      // Create unmasked WebSocket frame and push to mock socket
      let payload
      let opcode

      if (typeof event.data === "string") {
        payload = new TextEncoder().encode(event.data)
        opcode = 0x01 // text
      } else if (event.data instanceof ArrayBuffer) {
        payload = new Uint8Array(event.data)
        opcode = 0x02 // binary
      } else {
        return
      }

      const frame = _createWsFrame(opcode, payload, false) // unmasked (server → client)
      socket._receiveData(Buffer.from(frame))
    }

    nativeWs.onclose = event => {
      // Send close frame to ws library
      const code = event.code || 1000
      const closePayload = new Uint8Array(2)
      closePayload[0] = (code >> 8) & 0xff
      closePayload[1] = code & 0xff
      const frame = _createWsFrame(0x08, closePayload, false)
      socket._receiveData(Buffer.from(frame))

      setTimeout(() => {
        socket._readableState.endEmitted = true
        socket._receiveEnd()
        socket.emit("close", false)
      }, 10)
    }

    nativeWs.onerror = () => {
      socket.emit("error", new Error("WebSocket connection error"))
      socket.destroy()
    }

    // Clean up native WS when socket is destroyed
    const origDestroy = socket.destroy.bind(socket)
    socket.destroy = error => {
      if (
        nativeWs.readyState === NativeWS.OPEN ||
        nativeWs.readyState === NativeWS.CONNECTING
      ) {
        nativeWs.close()
      }
      return origDestroy(error)
    }
  }
}

/**
 * Helper to parse URL/options arguments for request()
 */
function parseRequestArgs(urlOrOptions, optionsOrCallback, callback) {
  let options
  let cb = callback

  if (typeof urlOrOptions === "string" || urlOrOptions instanceof URL) {
    const parsed = new URL(urlOrOptions.toString())
    options = {
      hostname: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port) : undefined,
      path: parsed.pathname + parsed.search,
      method: "GET"
    }
    if (typeof optionsOrCallback === "function") {
      cb = optionsOrCallback
    } else if (optionsOrCallback) {
      options = { ...options, ...optionsOrCallback }
    }
  } else {
    options = urlOrOptions
    if (typeof optionsOrCallback === "function") {
      cb = optionsOrCallback
    }
  }

  return { options, callback: cb }
}

/**
 * Create an HTTP client request
 */
export function request(urlOrOptions, optionsOrCallback, callback) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions,
    optionsOrCallback,
    callback
  )
  const req = new ClientRequest(options, "http")
  if (cb) {
    req.once("response", cb)
  }
  return req
}

/**
 * Make an HTTP GET request
 */
export function get(urlOrOptions, optionsOrCallback, callback) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions,
    optionsOrCallback,
    callback
  )
  const req = new ClientRequest({ ...options, method: "GET" }, "http")
  if (cb) {
    req.once("response", cb)
  }
  req.end()
  return req
}

/**
 * Internal: create client request with specified protocol
 * Used by https module
 */
export function _createClientRequest(
  urlOrOptions,
  optionsOrCallback,
  callback,
  protocol
) {
  const { options, callback: cb } = parseRequestArgs(
    urlOrOptions,
    optionsOrCallback,
    callback
  )
  const req = new ClientRequest(options, protocol)
  if (cb) {
    req.once("response", cb)
  }
  return req
}

const serverRegistry = new Map()
let onServerListenCallback = null
let onServerCloseCallback = null

export function _registerServer(port, server) {
  serverRegistry.set(port, server)
  if (onServerListenCallback) {
    onServerListenCallback(port, server)
  }
}

export function _unregisterServer(port) {
  serverRegistry.delete(port)
  if (onServerCloseCallback) {
    onServerCloseCallback(port)
  }
}

export function getServer(port) {
  return serverRegistry.get(port)
}

export function getAllServers() {
  return new Map(serverRegistry)
}

export function setServerListenCallback(callback) {
  onServerListenCallback = callback
}

export function setServerCloseCallback(callback) {
  onServerCloseCallback = callback
}

export class Agent extends EventEmitter {
  constructor(opts) {
    super()
    this.options = opts || {}
    this.maxSockets = opts?.maxSockets ?? Infinity
    this.maxFreeSockets = opts?.maxFreeSockets ?? 256
    this.maxTotalSockets = opts?.maxTotalSockets ?? Infinity
    this.sockets = {}
    this.freeSockets = {}
    this.requests = {}
  }

  createConnection(_options, callback) {
    const socket = new Socket()
    if (callback) {
      callback(null, socket)
    }
    return socket
  }

  getName(options) {
    const host = options.host || "localhost"
    const port = options.port || 80
    return `${host}:${port}:${options.localAddress || ""}`
  }

  addRequest(_req, _options) {
    // Stub - in browser we use fetch instead
  }

  destroy() {
    // Clean up - stub
    this.sockets = {}
    this.freeSockets = {}
    this.requests = {}
  }
}

// Global agent instance
export const globalAgent = new Agent()

/**
 * Parse a WebSocket frame from raw bytes.
 * Returns null if the buffer doesn't contain a complete frame.
 */
export function _parseWsFrame(data) {
  if (data.length < 2) return null

  const opcode = data[0] & 0x0f
  const masked = (data[1] & 0x80) !== 0
  let payloadLength = data[1] & 0x7f
  let offset = 2

  if (payloadLength === 126) {
    if (data.length < 4) return null
    payloadLength = (data[2] << 8) | data[3]
    offset = 4
  } else if (payloadLength === 127) {
    if (data.length < 10) return null
    // Use lower 32 bits (sufficient for WebSocket messages)
    payloadLength = (data[6] << 24) | (data[7] << 16) | (data[8] << 8) | data[9]
    offset = 10
  }

  if (masked) {
    if (data.length < offset + 4 + payloadLength) return null
    const maskKey = data.slice(offset, offset + 4)
    offset += 4

    const payload = new Uint8Array(payloadLength)
    for (let i = 0; i < payloadLength; i++) {
      payload[i] = data[offset + i] ^ maskKey[i % 4]
    }

    return { opcode, payload, totalLength: offset + payloadLength }
  } else {
    if (data.length < offset + payloadLength) return null
    const payload = data.slice(offset, offset + payloadLength)
    return { opcode, payload, totalLength: offset + payloadLength }
  }
}

/**
 * Create a WebSocket frame.
 * @param opcode - Frame opcode (0x01=text, 0x02=binary, 0x08=close, 0x09=ping, 0x0A=pong)
 * @param payload - Frame payload
 * @param masked - Whether to mask the payload (client→server frames are masked)
 */
export function _createWsFrame(opcode, payload, masked) {
  const length = payload.length
  let headerSize = 2

  if (length > 125 && length <= 65535) {
    headerSize += 2
  } else if (length > 65535) {
    headerSize += 8
  }

  if (masked) {
    headerSize += 4
  }

  const frame = new Uint8Array(headerSize + length)
  frame[0] = 0x80 | opcode // FIN + opcode

  let offset = 2
  if (length <= 125) {
    frame[1] = (masked ? 0x80 : 0) | length
  } else if (length <= 65535) {
    frame[1] = (masked ? 0x80 : 0) | 126
    frame[2] = (length >> 8) & 0xff
    frame[3] = length & 0xff
    offset = 4
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127
    frame[2] = 0
    frame[3] = 0
    frame[4] = 0
    frame[5] = 0
    frame[6] = (length >> 24) & 0xff
    frame[7] = (length >> 16) & 0xff
    frame[8] = (length >> 8) & 0xff
    frame[9] = length & 0xff
    offset = 10
  }

  if (masked) {
    const maskKey = new Uint8Array(4)
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(maskKey)
    } else {
      for (let i = 0; i < 4; i++) maskKey[i] = Math.floor(Math.random() * 256)
    }
    frame.set(maskKey, offset)
    offset += 4
    for (let i = 0; i < length; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i % 4]
    }
  } else {
    frame.set(payload, offset)
  }

  return frame
}

export default {
  Server,
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  createServer,
  request,
  get,
  STATUS_CODES,
  METHODS,
  getServer,
  getAllServers,
  setServerListenCallback,
  setServerCloseCallback,
  _createClientRequest,
  Agent,
  globalAgent,
  _parseWsFrame,
  _createWsFrame
}
