// npm install events

/*!
 * _http_agent-web — node:_http_agent for browsers & bundlers
 * MIT License.
 * Node.js parity: node:_http_agent @ Node 0.1.90+ (internal, stable surface)
 * Dependencies: events
 * Limitations:
 *   - Socket pooling is a no-op; browsers manage TCP connections natively.
 *   - createConnection() is not supported (no raw socket API in browsers).
 *   - keepAlive socket reuse is tracked in state but not enforced by the browser.
 *   - maxTotalSockets enforcement is best-effort via in-flight request count.
 *   - addRequest() wires fetch() instead of net.Socket — no direct socket access.
 *   - agent.sockets / agent.freeSockets contain synthetic placeholder entries,
 *     not real net.Socket objects.
 */

/**
 * @packageDocumentation
 * Browser-compatible implementation of Node's internal `_http_agent` module.
 *
 * `Agent` manages connection pooling metadata for `http.request()` calls.
 * In Node it controls TCP socket reuse; in browsers we approximate the same
 * observable API surface (constructor options, `keepAlive`, `maxSockets`,
 * `destroy()`, `getName()`, request queuing) while delegating actual I/O
 * to the Fetch API.
 *
 * `globalAgent` is the default singleton instance used by `http.request()`
 * when no explicit agent is specified.
 */

import EventEmitter from 'events';

// ---------------------------------------------------------------------------
// Constants — match Node exactly
// ---------------------------------------------------------------------------

export const METHODS = [
  'ACL','BIND','CHECKOUT','CONNECT','COPY','DELETE','GET','HEAD',
  'LINK','LOCK','M-SEARCH','MERGE','MKACTIVITY','MKCALENDAR','MKCOL',
  'MOVE','NOTIFY','OPTIONS','PATCH','POST','PROPFIND','PROPPATCH',
  'PURGE','PUT','REBIND','REPORT','SEARCH','SOURCE','SUBSCRIBE','TRACE',
  'UNBIND','UNLINK','UNLOCK','UNSUBSCRIBE',
];

/** Default maximum concurrent sockets per host:port key. */
const DEFAULT_MAX_SOCKETS = 256;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} name */
function validatePositiveInteger(v, name) {
  if (!Number.isInteger(v) || v < 1)
    throw Object.assign(
      new RangeError(`The "${name}" argument must be a positive integer. Received ${v}`),
      { code: 'ERR_OUT_OF_RANGE' },
    );
}

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

/**
 * HTTP Agent — manages connection-pool metadata for http.request() calls.
 *
 * @example
 * const agent = new Agent({ keepAlive: true, maxSockets: 10 });
 * fetch('https://example.com', { agent }); // agent metadata observed
 * agent.destroy();
 */
export class Agent extends EventEmitter {
  /**
   * @param {{
   *   keepAlive?:       boolean;
   *   keepAliveMsecs?:  number;
   *   maxSockets?:      number;
   *   maxFreeSockets?:  number;
   *   maxTotalSockets?: number;
   *   scheduling?:      'lifo' | 'fifo';
   *   timeout?:         number;
   * }} [options]
   */
  constructor(options = {}) {
    super();

    this.defaultPort   = 80;
    this.protocol      = 'http:';
    this.options       = { path: null, ...options };

    this.keepAlive      = options.keepAlive      ?? false;
    this.keepAliveMsecs = options.keepAliveMsecs ?? 1000;
    this.maxSockets     = options.maxSockets      ?? Agent.defaultMaxSockets;
    this.maxFreeSockets = options.maxFreeSockets  ?? 256;
    this.scheduling     = options.scheduling      ?? 'lifo';
    this.maxTotalSockets =
      options.maxTotalSockets !== undefined
        ? (validatePositiveInteger(options.maxTotalSockets, 'maxTotalSockets'), options.maxTotalSockets)
        : Infinity;
    this.totalSocketCount = 0;

    /**
     * Tracks in-flight "socket" slots per host key.
     * Values are arrays of synthetic placeholder objects (not real net.Sockets).
     * @type {Record<string, object[]>}
     */
    this.sockets = Object.create(null);

    /**
     * Tracks idle "socket" slots awaiting reuse per host key.
     * @type {Record<string, object[]>}
     */
    this.freeSockets = Object.create(null);

    /**
     * Pending request queues per host key.
     * @type {Record<string, Function[]>}
     */
    this.requests = Object.create(null);
  }

  // ── Static ────────────────────────────────────────────────────────────────

  static get defaultMaxSockets() { return DEFAULT_MAX_SOCKETS; }

  // ── getName ───────────────────────────────────────────────────────────────

  /**
   * Returns a string key that uniquely identifies a connection slot.
   * Matches Node's format: `host:port:localAddress:family:path`.
   *
   * @param {{
   *   host?:         string;
   *   port?:         number | string;
   *   localAddress?: string;
   *   family?:       number;
   *   path?:         string;
   * }} options
   * @returns {string}
   *
   * @example
   * agent.getName({ host: 'example.com', port: 443 });
   * // → 'example.com:443:::'
   */
  getName(options = {}) {
    const host         = options.host         ?? 'localhost';
    const port         = options.port         ?? this.defaultPort;
    const localAddress = options.localAddress ?? '';
    const family       = options.family       ?? '';
    const path         = options.path         ?? '';
    return `${host}:${port}:${localAddress}:${family}:${path}`;
  }

  // ── addRequest ────────────────────────────────────────────────────────────

  /**
   * Associates a request with this agent's connection pool.
   * In Node this assigns a socket; in the browser we queue the callback and
   * call it immediately (Fetch manages the real connection).
   *
   * @param {object} req   - An http.ClientRequest-like object.
   * @param {object} opts  - Request options (host, port, path, …).
   */
  addRequest(req, opts) {
    const name = this.getName(opts);

    // Track slot
    if (!this.sockets[name]) this.sockets[name] = [];

    const atMax = this.sockets[name].length >= this.maxSockets ||
                  this.totalSocketCount      >= this.maxTotalSockets;

    if (atMax) {
      // Queue until a slot opens.
      if (!this.requests[name]) this.requests[name] = [];
      this.requests[name].push(() => this._assignSocket(req, name));
    } else {
      this._assignSocket(req, name);
    }
  }

  /**
   * @param {object} req
   * @param {string} name
   * @private
   */
  _assignSocket(req, name) {
    const placeholder = { _agentKey: name, destroyed: false };
    this.sockets[name].push(placeholder);
    this.totalSocketCount++;

    // Notify req that a "socket" is available (mirrors Node's socket event).
    if (typeof req.onSocket === 'function') {
      req.onSocket(placeholder);
    } else {
      req.emit?.('socket', placeholder);
    }
  }

  // ── removeSocket ──────────────────────────────────────────────────────────

  /**
   * Removes a socket placeholder from the pool and drains the next queued
   * request for the same host key if one exists.
   *
   * @param {object} socket  - Placeholder returned by _assignSocket.
   * @param {object} options
   */
  removeSocket(socket, options) {
    const name    = this.getName(options);
    const slots   = this.sockets[name] ?? [];
    const idx     = slots.indexOf(socket);
    if (idx !== -1) { slots.splice(idx, 1); this.totalSocketCount--; }
    if (slots.length === 0) delete this.sockets[name];

    // Drain next pending request for this key.
    const queue = this.requests[name];
    if (queue?.length) {
      const next = queue.shift();
      if (!queue.length) delete this.requests[name];
      next();
    }
  }

  // ── keepSocketAlive / reuseSocket ────────────────────────────────────────
  // Called by http.ClientRequest after a response; no-op in browser context.

  /** @param {object} socket @param {object} _options */
  keepSocketAlive(socket, _options) {
    socket.setKeepAlive?.(true, this.keepAliveMsecs);
    return this.keepAlive; // returning false tells caller to destroy it
  }

  /** @param {object} _socket @param {object} _options */
  reuseSocket(_socket, _options) {}

  // ── createConnection ─────────────────────────────────────────────────────

  /**
   * Stub — browsers have no raw TCP socket API.
   * Throws a descriptive error rather than silently returning undefined.
   * @throws {Error} ERR_NOT_SUPPORTED
   */
  createConnection() {
    throw Object.assign(
      new Error(
        'Agent.createConnection() is not supported in browser environments. ' +
        'Use the Fetch API for HTTP requests.',
      ),
      { code: 'ERR_NOT_SUPPORTED' },
    );
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  /**
   * Destroys all tracked socket slots and clears pending request queues.
   * Mirrors Node's `agent.destroy()` — signals that this agent is no longer
   * needed and any pooled connections should be closed.
   *
   * @example
   * const agent = new Agent({ keepAlive: true });
   * // ... make requests ...
   * agent.destroy(); // release all resources
   */
  destroy() {
    for (const key of Object.keys(this.sockets)) {
      for (const sock of this.sockets[key]) sock.destroyed = true;
    }
    this.sockets      = Object.create(null);
    this.freeSockets  = Object.create(null);
    this.requests     = Object.create(null);
    this.totalSocketCount = 0;
    this.emit('destroy');
  }
}

// ---------------------------------------------------------------------------
// globalAgent — the default singleton (mirrors `http.globalAgent`)
// ---------------------------------------------------------------------------

/**
 * The default `Agent` instance used by `http.request()` when no agent is
 * passed explicitly. Equivalent to `http.globalAgent`.
 *
 * @type {Agent}
 */
export const globalAgent = new Agent({ keepAlive: true });

export default { Agent, globalAgent, METHODS };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { Agent, globalAgent } from './_http_agent';
//
// // ── Custom agent ──────────────────────────────────────────────────────────
// const agent = new Agent({
//   keepAlive:       true,
//   keepAliveMsecs:  3000,
//   maxSockets:      10,
//   maxTotalSockets: 50,
//   scheduling:      'fifo',
// });
//
// // ── getName ───────────────────────────────────────────────────────────────
// agent.getName({ host: 'example.com', port: 443 });
// // → 'example.com:443:::'
// agent.getName({ host: '::1', port: 80, family: 6 });
// // → '::1:80::6:'
//
// // ── addRequest / removeSocket (internal use by http.request) ──────────────
// const fakeReq = { emit: (ev, sock) => console.log(ev, sock) };
// agent.addRequest(fakeReq, { host: 'example.com', port: 80 });
// // → emits 'socket' with placeholder
// agent.removeSocket(
//   agent.sockets['example.com:80:::'][0],
//   { host: 'example.com', port: 80 },
// );
//
// // ── destroy ───────────────────────────────────────────────────────────────
// agent.destroy(); // clears all sockets / queues, emits 'destroy'
//
// // ── globalAgent ───────────────────────────────────────────────────────────
// console.log(globalAgent instanceof Agent);  // true
// console.log(globalAgent.keepAlive);         // true
//
// // ── createConnection throws ───────────────────────────────────────────────
// try { agent.createConnection(); }
// catch (e) { console.log(e.code); } // 'ERR_NOT_SUPPORTED'
//
// // ── maxTotalSockets validation ────────────────────────────────────────────
// new Agent({ maxTotalSockets: 0 }); // RangeError ERR_OUT_OF_RANGE
// new Agent({ maxTotalSockets: 100 }); // ✓
