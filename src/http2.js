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

import { EventEmitter } from 'events'
import { Readable, Writable } from 'stream'
import { Buffer } from 'buffer'

/* ------------------------------------------------------------------ */
/* INTERNAL: scheduler (fake multiplexing)                            */
/* ------------------------------------------------------------------ */

class StreamScheduler {
  constructor(maxConcurrent = 6) {
    this.maxConcurrent = maxConcurrent
    this.active = 0
    this.queue = []
  }

  schedule(stream, fn, priority = 0) {
    this.queue.push({ stream, fn, priority })
    this.queue.sort((a, b) => b.priority - a.priority)
    this._drain()
  }

  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const { fn } = this.queue.shift()
      this.active++
      Promise.resolve()
        .then(fn)
        .finally(() => {
          this.active--
          this._drain()
        })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Http2Stream                                                        */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} Http2Headers
 * @property {string} [':method']
 * @property {string} [':path']
 * @property {string} [':status']
 */

/**
 * HTTP/2 stream (req + res combined)
 */
export class Http2Stream extends DuplexShim {
  constructor(session, headers = {}) {
    super()
    this.session = session
    this.headers = headers
    this.priorityWeight = 0

    this._responseHeaders = null
    this._body = []
    this._closed = false
  }

  respond(headers = {}) {
    this._responseHeaders = headers
  }

  priority(options = {}) {
    this.priorityWeight = options.weight || 0
  }

  pushStream(headers, callback) {
    const push = new Http2Stream(this.session, headers)

    queueMicrotask(() => {
      this.emit('push', push, headers)
      if (callback) callback(null, push)
    })

    return push
  }

  _write(chunk, _enc, cb) {
    this._body.push(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    )
    cb()
  }

  _read() {}

  end(chunk) {
    if (chunk) this.write(chunk)

    this._closed = true

    const result = {
      headers: this._responseHeaders || { ':status': 200 },
      body: Buffer.concat(this._body)
    }

    if (this._resolve) this._resolve(result)

    this.push(result.body)
    this.push(null)

    this.emit('finish')
    this.emit('end')
  }

  _setResolver(resolve) {
    this._resolve = resolve
  }
}

/* ------------------------------------------------------------------ */
/* Duplex shim (pipe support)                                         */
/* ------------------------------------------------------------------ */

class DuplexShim extends Readable {
  constructor() {
    super()
    this._writable = new Writable({
      write: (chunk, enc, cb) => this._write(chunk, enc, cb)
    })
  }

  write(chunk, enc, cb) {
    return this._writable.write(chunk, enc, cb)
  }

  pipe(dest, options) {
    return Readable.prototype.pipe.call(this, dest, options)
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

const serverRegistry = new Map()

export class Http2Server extends EventEmitter {
  constructor(onStream) {
    super()
    if (onStream) this.on('stream', onStream)
  }

  listen(port, cb) {
    serverRegistry.set(port, this)
    if (cb) queueMicrotask(cb)
    this.emit('listening')
    return this
  }

  close() {
    for (const [port, s] of serverRegistry) {
      if (s === this) serverRegistry.delete(port)
    }
    this.emit('close')
  }

  async _handle(headers, body) {
    return new Promise((resolve, reject) => {
      const stream = new Http2Stream(null, headers)
      stream._setResolver(resolve)

      try {
        this.emit('stream', stream, headers)

        if (body) {
          stream.push(body)
          stream.push(null)
        }
      } catch (err) {
        reject(err)
      }
    })
  }
}

/* ------------------------------------------------------------------ */
/* Client session                                                     */
/* ------------------------------------------------------------------ */

export class ClientHttp2Session extends EventEmitter {
  constructor(authority) {
    super()
    this.authority = authority
    this.scheduler = new StreamScheduler()
  }

  request(headers = {}) {
    const stream = new Http2Stream(this, headers)

    this.scheduler.schedule(
      stream,
      async () => {
        try {
          const server = resolveServer(this.authority)

          const result = await server._handle(headers)

          stream.emit('response', result.headers)

          stream.push(result.body)
          stream.push(null)
        } catch (err) {
          stream.emit('error', err)
        }
      },
      stream.priorityWeight
    )

    return stream
  }

  close(cb) {
    if (cb) queueMicrotask(cb)
  }
}

/* ------------------------------------------------------------------ */
/* VFS integration                                                    */
/* ------------------------------------------------------------------ */

let vfsHandler = null

/**
 * Set VFS request handler
 * @param {(headers: Http2Headers) => Promise<{headers: object, body: Buffer}>} fn
 */
export function setVfsHandler(fn) {
  vfsHandler = fn
}

function resolveServer(authority) {
  if (vfsHandler) {
    return {
      _handle: vfsHandler
    }
  }

  return serverRegistry.get(80) || [...serverRegistry.values()][0]
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

export function createServer(options, onStream) {
  if (typeof options === 'function') {
    onStream = options
  }
  return new Http2Server(onStream)
}

export function createSecureServer(options, onStream) {
  return createServer(options, onStream)
}

export function connect(authority) {
  return new ClientHttp2Session(authority)
}

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

export const constants = {
  HTTP2_HEADER_STATUS: ':status',
  HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_PATH: ':path',
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NOT_FOUND: 404
}

/* ------------------------------------------------------------------ */
/* default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  createServer,
  createSecureServer,
  connect,
  Http2Server,
  Http2Stream,
  ClientHttp2Session,
  setVfsHandler,
  constants
}
