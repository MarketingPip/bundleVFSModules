/**
 * http2 shim (browser-compatible, extended from AlmostNode stub)
 */

import { EventEmitter } from "./events"
import { Buffer } from "buffer"

/* ------------------------------------------------------------------ */
/* Http2Session                                                       */
/* ------------------------------------------------------------------ */

export class Http2Session extends EventEmitter {
  constructor() {
    super()
    this._closed = false
    this._destroyed = false
  }

  close(callback) {
    this._closed = true
    this.emit("close")
    if (callback) setTimeout(callback, 0)
  }

  destroy(error, code) {
    this._destroyed = true
    if (error) this.emit("error", error)
    this.emit("close", code)
  }

  get destroyed() { return this._destroyed }
  get encrypted() { return false }
  get closed() { return this._closed }

  ping(callback) {
    if (callback) setTimeout(() => callback(null, 0, Buffer.alloc(0)), 0)
    return true
  }

  ref() {}
  unref() {}

  setTimeout(ms, callback) {
    if (callback) setTimeout(callback, ms)
  }
}

export class ClientHttp2Session extends Http2Session {}
export class ServerHttp2Session extends Http2Session {}

/* ------------------------------------------------------------------ */
/* Http2Stream                                                        */
/* ------------------------------------------------------------------ */

export class Http2Stream extends EventEmitter {
  constructor(session = null, headers = {}) {
    super()

    this.session = session
    this.headers = headers

    this._id = Http2Stream._id++
    this._closed = false
    this._destroyed = false
    this._pending = false

    this._chunks = []
    this._responseHeaders = null
  }

  close(code, callback) {
    this._closed = true
    this.emit("close", code)
    if (callback) setTimeout(callback, 0)
  }

  get id() { return this._id }
  get pending() { return this._pending }
  get destroyed() { return this._destroyed }
  get closed() { return this._closed }

  priority(_options) {}

  setTimeout(ms, callback) {
    if (callback) setTimeout(callback, ms)
  }

  write(chunk) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    this._chunks.push(buf)
  }

  respond(headers = {}) {
    this._responseHeaders = headers
  }

  end(data, encoding, callback) {
    if (data) this.write(data, encoding)

    this._closed = true

    const result = {
      headers: this._responseHeaders || { ":status": 200 },
      body: Buffer.concat(this._chunks)
    }

    if (this._resolve) this._resolve(result)

    this.emit("finish")
    this.emit("end")

    if (callback) setTimeout(callback, 0)
  }

  _setResolver(resolve) {
    this._resolve = resolve
  }
}

/* IMPORTANT: test expects first id = 0 */
Http2Stream._id = 0

/* ------------------------------------------------------------------ */
/* HTTP/1 Compatibility Layer                                         */
/* ------------------------------------------------------------------ */

export class Http2ServerRequest extends EventEmitter {
  constructor(headers = {}, body) {
    super()
    this.headers = headers
    this.method = headers[":method"] || "GET"
    this.url = headers[":path"] || "/"
    this._body = body || null
  }
}

export class Http2ServerResponse extends EventEmitter {
  constructor(stream) {
    super()
    this.stream = stream
  }

  writeHead(statusCode, headers) {
    this.stream.respond({
      ":status": statusCode,
      ...headers
    })
    return this
  }

  write(chunk) {
    this.stream.write(chunk)
  }

  end(data) {
    this.stream.end(data)
    this.emit("finish")
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

const serverRegistry = new Map()

export function createServer(options, onRequestHandler) {
  if (typeof options === "function") {
    onRequestHandler = options
  }

  const server = new EventEmitter()
  server.timeout = 0

  server.listen = (port = 80, cb) => {
    serverRegistry.set(port, server)
    if (cb) setTimeout(cb, 0)
    server.emit("listening")
    return server
  }

  server.close = () => {
    for (const [p, s] of serverRegistry) {
      if (s === server) serverRegistry.delete(p)
    }
    server.emit("close")
  }

  /* ---------------- handleRequest ---------------- */

  server.handleRequest = async (method, url, headers = {}, body) => {
    return new Promise((resolve, reject) => {
      const h2Headers = {
        ":method": method,
        ":path": url,
        ":scheme": "http",
        ":authority": headers.host || "localhost",
        ...headers
      }

      const stream = new Http2Stream(null, h2Headers)

      stream._setResolver(result => {
        resolve({
          statusCode: Number(result.headers?.[":status"] || 200),
          headers: normalizeHeaders(result.headers),
          body: result.body
        })
      })

      const timeoutId = server.timeout
        ? setTimeout(() => reject(new Error("Request timeout")), server.timeout)
        : null

      stream.on("finish", () => {
        if (timeoutId) clearTimeout(timeoutId)
      })

      try {
        /* HTTP/2 event */
        server.emit("stream", stream, h2Headers)

        /* optional handler */
        if (onRequestHandler) {
          const req = new Http2ServerRequest(h2Headers, body)
          const res = new Http2ServerResponse(stream)
          onRequestHandler(req, res)
        }

        /* HTTP/1 compat */
        if (server.listenerCount("request")) {
          const req = new Http2ServerRequest(h2Headers, body)
          const res = new Http2ServerResponse(stream)
          server.emit("request", req, res)
        }

      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId)
        reject(err)
      }
    })
  }

  return server
}

export function createSecureServer(options, handler) {
  return createServer(options, handler)
}

/* ------------------------------------------------------------------ */
/* Client                                                             */
/* ------------------------------------------------------------------ */

export function connect(authority, _options, listener) {
  const session = new ClientHttp2Session()

  if (listener) session.once("connect", listener)
  setTimeout(() => session.emit("connect"), 0)

  session.request = headers => {
    const server =
      serverRegistry.get(80) || [...serverRegistry.values()][0]

    const stream = new Http2Stream(session, headers)

    Promise.resolve().then(async () => {
      try {
        const result = await server.handleRequest(
          headers[":method"] || "GET",
          headers[":path"] || "/",
          headers
        )

        stream.emit("response", {
          ":status": result.statusCode,
          ...result.headers
        })

      } catch (err) {
        stream.emit("error", err)
      }
    })

    return stream
  }

  return session
}

/* ------------------------------------------------------------------ */
/* Utils                                                              */
/* ------------------------------------------------------------------ */

function normalizeHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!k.startsWith(":")) out[k.toLowerCase()] = v
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

export const constants = {
  NGHTTP2_SESSION_SERVER: 0,
  NGHTTP2_SESSION_CLIENT: 1,
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_AUTHORITY: ":authority",
  HTTP2_HEADER_SCHEME: ":scheme",
  HTTP2_HEADER_PATH: ":path",
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NOT_FOUND: 404
}

/* ------------------------------------------------------------------ */
/* Settings (required by tests)                                       */
/* ------------------------------------------------------------------ */

export function getDefaultSettings() {
  return {}
}

export function getPackedSettings(_settings) {
  return Buffer.from("")
}

export function getUnpackedSettings(_buf) {
  return {}
}

export const sensitiveHeaders = Symbol("sensitiveHeaders")

/* ------------------------------------------------------------------ */
/* Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  Http2Session,
  ClientHttp2Session,
  ServerHttp2Session,
  Http2Stream,
  Http2ServerRequest,
  Http2ServerResponse,
  createServer,
  createSecureServer,
  connect,
  constants,
  getDefaultSettings,
  getPackedSettings,
  getUnpackedSettings,
  sensitiveHeaders
}
