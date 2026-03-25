// npm install events buffer stream

/*!
 * http2-web — Node.js `http2` shim for browsers & VFS runtimes
 * MIT License.
 *
 * Features:
 *   - Http2Session / Http2Stream API (subset)
 *   - stream.pipe() support (Readable/Writable interop)
 *   - Fake multiplexing scheduler (priority + concurrency)
 *   - HTTP/2 server push simulation
 *   - VFS / virtual server integration
 *
 * Notes:
 *   - This is NOT a real HTTP/2 transport (no binary framing / HPACK)
 *   - Designed for compatibility with Node-style libraries in browser
 */

// npm deps: events, stream, buffer

import { EventEmitter } from "./events"
import { Readable, Writable } from "stream"
import { Buffer } from "buffer"

/* ------------------------------------------------------------------ */
/* Scheduler (multiplexing)                                           */
/* ------------------------------------------------------------------ */

class Scheduler {
  constructor(max = 6) {
    this.max = max
    this.active = 0
    this.queue = []
  }

  schedule(task, priority = 0) {
    this.queue.push({ task, priority })
    this.queue.sort((a, b) => b.priority - a.priority)
    this._drain()
  }

  _drain() {
    while (this.active < this.max && this.queue.length) {
      const { task } = this.queue.shift()
      this.active++
      Promise.resolve()
        .then(task)
        .finally(() => {
          this.active--
          this._drain()
        })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Http2Session                                                       */
/* ------------------------------------------------------------------ */

export class Http2Session extends EventEmitter {
  constructor() {
    super()
    this._closed = false
    this._destroyed = false
  }

  close(cb) {
    this._closed = true
    this.emit("close")
    if (cb) queueMicrotask(cb)
  }

  destroy(err, code) {
    this._destroyed = true
    if (err) this.emit("error", err)
    this.emit("close", code)
  }

  get destroyed() { return this._destroyed }
  get closed() { return this._closed }
  get encrypted() { return false }

  ping(cb) {
    if (cb) queueMicrotask(() => cb(null, 0, Buffer.alloc(0)))
    return true
  }

  setTimeout(ms, cb) {
    if (cb) setTimeout(cb, ms)
  }

  ref() {}
  unref() {}
}

/* ------------------------------------------------------------------ */
/* Http2Stream                                                        */
/* ------------------------------------------------------------------ */

export class Http2Stream extends Readable {
  constructor(session, headers = {}) {
    super()

    this.session = session
    this.headers = headers
    this._id = Http2Stream._id++

    this._closed = false
    this._destroyed = false
    this._pending = true
    this._priority = 0

    this._body = []
    this._responseHeaders = null

    this._writable = new Writable({
      write: (chunk, enc, cb) => {
        this._body.push(
          typeof chunk === "string" ? Buffer.from(chunk) : chunk
        )
        cb()
      }
    })
  }

  get id() { return this._id }
  get pending() { return this._pending }
  get destroyed() { return this._destroyed }
  get closed() { return this._closed }

  priority(opts = {}) {
    this._priority = opts.weight || 0
  }

  write(chunk, enc, cb) {
    return this._writable.write(chunk, enc, cb)
  }

  end(data, enc, cb) {
    if (data) this.write(data, enc)

    this._closed = true
    this._pending = false

    const result = {
      headers: this._responseHeaders || { ":status": 200 },
      body: Buffer.concat(this._body)
    }

    if (this._resolve) this._resolve(result)

    this.push(result.body)
    this.push(null)

    this.emit("finish")
    this.emit("end")

    if (cb) queueMicrotask(cb)
  }

  respond(headers = {}) {
    this._responseHeaders = headers
  }

  pushStream(headers, cb) {
    const push = new Http2Stream(this.session, headers)
    queueMicrotask(() => {
      this.emit("push", push, headers)
      if (cb) cb(null, push)
    })
    return push
  }

  pipe(dest, opts) {
    return Readable.prototype.pipe.call(this, dest, opts)
  }

  _read() {}

  _setResolver(res) {
    this._resolve = res
  }
}

Http2Stream._id = 1

/* ------------------------------------------------------------------ */
/* HTTP/1 Compatibility                                               */
/* ------------------------------------------------------------------ */

export class Http2ServerRequest extends Readable {
  constructor(headers, body) {
    super()
    this.headers = headers

    if (body) this.push(body)
    this.push(null)
  }

  _read() {}
}

export class Http2ServerResponse extends Writable {
  constructor(stream) {
    super()
    this.stream = stream
  }

  writeHead(status, headers) {
    this.stream.respond({
      ":status": status,
      ...headers
    })
    return this
  }

  _write(chunk, enc, cb) {
    this.stream.write(chunk, enc, cb)
  }

  end(data) {
    this.stream.end(data)
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

const serverRegistry = new Map()

export function createServer(options, onStream) {
  if (typeof options === "function") onStream = options

  const server = new EventEmitter()
  server._scheduler = new Scheduler()
  server.timeout = 0

  server.listen = (port, cb) => {
    serverRegistry.set(port, server)
    if (cb) queueMicrotask(cb)
    server.emit("listening")
    return server
  }

  server.close = () => {
    for (const [p, s] of serverRegistry) {
      if (s === server) serverRegistry.delete(p)
    }
    server.emit("close")
  }

  /* ---------------- handleRequest (MAIN FEATURE) ---------------- */

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
        server.emit("stream", stream, h2Headers)

        if (onStream) onStream(stream, h2Headers)

        if (server.listenerCount("request")) {
          const req = new Http2ServerRequest(h2Headers, body)
          const res = new Http2ServerResponse(stream)
          server.emit("request", req, res)
        }

        if (body) {
          const buf = typeof body === "string" ? Buffer.from(body) : body
          stream.push(buf)
        }
        stream.push(null)

      } catch (err) {
        if (timeoutId) clearTimeout(timeoutId)
        reject(err)
      }
    })
  }

  return server
}

export function createSecureServer(opts, cb) {
  return createServer(opts, cb)
}

/* ------------------------------------------------------------------ */
/* Client                                                             */
/* ------------------------------------------------------------------ */

export class ClientHttp2Session extends Http2Session {
  constructor(authority) {
    super()
    this.authority = authority
    this._scheduler = new Scheduler()
  }

  request(headers = {}) {
    const stream = new Http2Stream(this, headers)

    this._scheduler.schedule(async () => {
      try {
        const server = resolveServer(this.authority)
        const result = await server.handleRequest(
          headers[":method"] || "GET",
          headers[":path"] || "/",
          headers
        )

        stream.emit("response", {
          ":status": result.statusCode,
          ...result.headers
        })

        stream.push(result.body)
        stream.push(null)

      } catch (err) {
        stream.emit("error", err)
      }
    }, stream._priority)

    return stream
  }
}

/* ------------------------------------------------------------------ */
/* VFS Hook                                                           */
/* ------------------------------------------------------------------ */

let vfsHandler = null

export function setVfsHandler(fn) {
  vfsHandler = fn
}

function resolveServer(authority) {
  if (vfsHandler) {
    return {
      handleRequest: async (method, url, headers, body) => {
        return vfsHandler({
          method,
          url,
          headers,
          body
        })
      }
    }
  }

  return serverRegistry.get(80) || [...serverRegistry.values()][0]
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
/* connect                                                            */
/* ------------------------------------------------------------------ */

export function connect(authority, opts, listener) {
  const session = new ClientHttp2Session(authority)
  if (listener) session.once("connect", listener)
  queueMicrotask(() => session.emit("connect"))
  return session
}

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

export const constants = {
  HTTP2_HEADER_STATUS: ":status",
  HTTP2_HEADER_METHOD: ":method",
  HTTP2_HEADER_PATH: ":path",
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NOT_FOUND: 404
}

export default {
  createServer,
  createSecureServer,
  connect,
  Http2Session,
  ClientHttp2Session,
  Http2Stream,
  Http2ServerRequest,
  Http2ServerResponse,
  constants,
}
