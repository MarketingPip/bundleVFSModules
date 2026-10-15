// src/https.js — port of node:https (Node v24.20.0) for the browser runtime.
//
// Browser strategy: TLS is owned by the browser/fetch stack, so the https
// client reuses the http fetch bridge with https: defaults, and the https
// server reuses the virtual http server registry (same __httpServerRunTime).
// TLS options (key/cert/ca/rejectUnauthorized/...) are accepted and ignored:
// browsers do not let pages configure TLS.

import http, { Agent as HttpAgent } from "./http.js";

// ---------------------------------------------------------------------------
// Runtime bridge (guarded: rewritten to the sandbox scope at load time,
// undefined under real Node / direct import).
// ---------------------------------------------------------------------------
const RT =
  typeof globalThis._RUNTIME_ !== "undefined"
    ? globalThis._RUNTIME_
    : undefined;
void RT;

class HttpsServerBase extends http.Server {
  constructor(options, requestListener) {
    // options may carry key/cert/ca/etc.; the virtual server ignores them.
    super(options, requestListener);
    this._tlsOptions = options && typeof options === "object" ? options : {};
    // Store ALPNProtocols as a Buffer like Node's tls.convertALPNProtocols.
    // This is just option storage — no TLS handshake happens in the browser.
    // Node's rule: if ALPNProtocols is set, convert it; else if ALPNCallback
    // is set, leave undefined (callback handles ALPN); else default to
    // ["http/1.1"].
    const alpnOpt = this._tlsOptions.ALPNProtocols;
    if (alpnOpt !== undefined) {
      this.ALPNProtocols = _convertALPNProtocols(alpnOpt);
    } else if (this._tlsOptions.ALPNCallback === undefined) {
      this.ALPNProtocols = _convertALPNProtocols(["http/1.1"]);
    } else {
      this.ALPNProtocols = undefined;
    }
    // Store ALPNCallback if given (test expects server.ALPNCallback).
    if (this._tlsOptions.ALPNCallback !== undefined) {
      this.ALPNCallback = this._tlsOptions.ALPNCallback;
    }
  }

  setSecureContext(options) {
    if (options && typeof options === "object") {
      this._tlsOptions = { ...this._tlsOptions, ...options };
      if (options.ALPNProtocols !== undefined) {
        this.ALPNProtocols = _convertALPNProtocols(options.ALPNProtocols);
      }
    }
  }
}

/**
 * Convert ALPNProtocols option to a Buffer (length-prefixed wire format),
 * mirroring Node's tls.convertALPNProtocols. Accepts string, Buffer,
 * or array of strings/Buffers.
 */
function _convertALPNProtocols(protocols) {
  const list = Array.isArray(protocols) ? protocols : [protocols];
  const parts = [];
  for (const p of list) {
    const buf = Buffer.isBuffer(p) ? p : Buffer.from(String(p));
    if (buf.length === 0 || buf.length > 255) {
      throw new Error("ALPN protocol must be 1-255 bytes");
    }
    parts.push(Buffer.from([buf.length]), buf);
  }
  return Buffer.concat(parts);
}

/**
 * Node's https.Server is also callable without `new`
 * (lib/https.js: `if (!(this instanceof Server)) return new Server(...)`).
 */
export function Server(...args) {
  return Reflect.construct(HttpsServerBase, args, new.target ?? Server);
}
Object.setPrototypeOf(Server, HttpsServerBase);
Server.prototype = HttpsServerBase.prototype;

export function createServer(options, requestListener) {
  if (typeof options === "function") {
    requestListener = options;
    options = {};
  }
  return new Server(options, requestListener);
}

class HttpsAgentBase extends HttpAgent {
  constructor(options) {
    super({
      __proto__: null,
      ...(options || {}),
      defaultPort: options?.defaultPort ?? 443,
      protocol: options?.protocol ?? "https:",
    });
    this.maxCachedSessions = options?.maxCachedSessions ?? 100;
  }
}

/** Node's https.Agent is callable without `new` as well. */
export function Agent(...args) {
  return Reflect.construct(HttpsAgentBase, args, new.target ?? Agent);
}
Object.setPrototypeOf(Agent, HttpsAgentBase);
Agent.prototype = HttpsAgentBase.prototype;

export const globalAgent = new Agent({
  keepAlive: true,
  scheduling: "lifo",
  timeout: 5000,
});

export function request(urlOrOptions, optionsOrCallback, callback) {
  return http._createClientRequest(
    urlOrOptions,
    optionsOrCallback,
    callback,
    "https:",
    globalAgent,
  );
}

export function get(urlOrOptions, optionsOrCallback, callback) {
  const req = request(urlOrOptions, optionsOrCallback, callback);
  req.end();
  return req;
}

export default {
  Server,
  createServer,
  request,
  get,
  Agent,
  globalAgent,
};
