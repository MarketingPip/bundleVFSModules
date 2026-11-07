// src/https.js — port of node:https (Node v24.20.0) for the browser runtime.
//
// Browser strategy: TLS is owned by the browser/fetch stack, so the https
// client reuses the http fetch bridge with https: defaults, and the https
// server reuses the virtual http server registry (same __httpServerRunTime).
// TLS options (key/cert/ca/rejectUnauthorized/...) are accepted and ignored:
// browsers do not let pages configure TLS.

import http, { Agent as HttpAgent } from "./http.js";
import { createSecureContext } from "./_tls_common.js";
import {
  checkServerIdentity as tlsCheckServerIdentity,
  TLSSocket,
} from "./tls.js";
// 3DES + SHA-1 for PKCS#12 PBE decryption in _extractClientCertificate
// below: the repo's crypto layer (native OpenSSL bridge under genuine
// Node, pure-JS hash fallback + honest "requires OpenSSL" error for
// ciphers in the browser). Used ONLY to read the client certificate out
// of a pfx bundle — never for a live handshake.
import { createDecipheriv, createHash } from "./crypto.js";

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
    // Marker for the shared virtual registry: the port registry is keyed
    // by port only, so an https client cannot tell a registered https
    // server from a plain-http one without it — the client must error
    // (EPROTO, like real Node's failed TLS handshake) instead of
    // delivering to a plain server (test-https-connecting-to-http).
    // src/http.js reads this in _performVirtualRequest; http.js cannot
    // import https.js (circular), so the marker lives here.
    this._isHttpsServer = true;
    this._tlsOptions = options && typeof options === "object" ? options : {};
    // Node: the TLS Server constructor builds its shared secure context,
    // which validates key/cert/ca types (lib/internal/tls/wrap.js:1626 via
    // createSecureContext -> configSecureContext). Validated here, result
    // discarded — no TLS stack exists to hold it.
    createSecureContext(this._tlsOptions);
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
    // Node: sockets accepted by an https server are TLSSockets.
    // _secureEstablished is false until the handshake completes and true
    // after it (test-https-timeout-server asserts false on the clientError
    // conn; test-http-url.parse-https.request asserts true in the request
    // handler). The virtual server performs no TLS handshake (browsers
    // cannot), so the handshake is emulated: false at connection, true
    // once a request is dispatched to the handler. The clientError path
    // never dispatches, so its conn stays false.
    // ponytail: ceiling — if a real TLS layer ever lands, these become
    // the handshake start/completion assignments instead.
    this.on("connection", (socket) => {
      socket._secureEstablished = false;
      // The accepted socket's .server is the backing net.Server, which
      // carries no ticket epoch — stash the TLS server itself so the
      // client agent can read its ticket epoch at connect time (the
      // session cache refuses resumption after setTicketKeys rotates).
      socket._tlsServer = this;
      // Node lib/internal/tls/wrap.js:1057-1058: the server-side socket
      // gets a handshake timeout (default 120s, wrap.js:1491); on expiry
      // _handleTimeout emits ERR_TLS_HANDSHAKE_TIMEOUT and the server
      // emits 'clientError' with the cleartext socket. A raw-TCP peer
      // that never sends a ClientHello (test-https-timeout-server) trips
      // it; a real request dispatch clears it (wrap.js:1201-1202).
      // Standalone timer, NOT socket.setTimeout: the net socket has ONE
      // timeout slot, shared with the server's own setTimeout — arming
      // or clearing the handshake timer through it would clobber the
      // server timeout (test-https-set-timeout-server regressed 1→124).
      const hsTimeout = this._tlsOptions.handshakeTimeout || 120 * 1000;
      if (typeof hsTimeout === "number" && hsTimeout > 0) {
        const onHandshakeTimeout = () => {
          socket._handshakeTimer = null;
          const err = new Error("TLS handshake timeout");
          err.code = "ERR_TLS_HANDSHAKE_TIMEOUT";
          this.emit("clientError", err, socket);
          socket.destroy();
        };
        socket._handshakeTimer = setTimeout(onHandshakeTimeout, hsTimeout);
        socket.once("close", () => {
          if (socket._handshakeTimer) {
            clearTimeout(socket._handshakeTimer);
            socket._handshakeTimer = null;
          }
        });
      }
      // Node: https.Server inherits tls.Server, which emits
      // 'secureConnection' per accepted connection with the TLSSocket
      // (test-https-timeout-server-2 asserts instanceof tls.TLSSocket).
      // The wrap shares the net socket with the http dispatch — it only
      // re-emits events, never consumes bytes.
      const tlsSocket = new TLSSocket(socket);
      tlsSocket._secureEstablished = false;
      this.emit("secureConnection", tlsSocket);
    });
    // Session-ticket epoch: bumped by setTicketKeys. A client session
    // cached under an older epoch cannot be resumed (Node: the ticket
    // no longer decrypts), so the agent checks the epoch at connect
    // time. The keys themselves are stored for getTicketKeys; they are
    // never used to encrypt anything in the emulation.
    this._ticketEpoch = 0;
    this._ticketKeys = null;
    const listener = this._requestListener;
    if (listener) {
      const wrapped = (req, res) => {
        if (req.socket) {
          req.socket._secureEstablished = true;
          // Handshake "completes" at first dispatch: clear the handshake
          // timeout (Node lib/internal/tls/wrap.js:1201-1202).
          if (req.socket._handshakeTimer) {
            clearTimeout(req.socket._handshakeTimer);
            req.socket._handshakeTimer = null;
          }
          _setSocketAuthSurface(this, req.socket);
          // The client certificate the peer presented (if any) is the
          // server socket's peer certificate (Node: TLSSocket
          // .getPeerCertificate on the accepted socket). The virtual
          // handshake carries no TLS records, so the agent stashes the
          // extracted client cert on the client socket (_tlsClientCert)
          // and it is surfaced here, per request.
          const peer = req.socket._peer;
          if (peer && peer._tlsClientCert) {
            req.socket._tlsPeerCertificate = peer._tlsClientCert;
          }
        }
        listener.call(this, req, res);
      };
      // Node's EventEmitter unwraps `.listener` in listeners() and
      // removeListener(), so the constructor listener keeps its identity
      // (test-https-argument-of-creating: listeners("request")[0] === fn).
      // `.call(this, ...)` keeps `this` the server inside the handler
      // (test-https-strict / test-https-host-headers), as EventEmitter
      // would invoke the listener directly.
      wrapped.listener = listener;
      this.off("request", listener);
      this._requestListener = wrapped;
      this.on("request", wrapped);
    }
  }

  setTicketKeys(keys) {
    // Node lib/internal/tls/secure-context.js (probed v24.22.1): a
    // non-Buffer/TypedArray/DataView throws ERR_INVALID_ARG_TYPE; a
    // wrong-length buffer throws ERR_INTERNAL_ASSERTION ("Session ticket
    // keys must be a 48-byte buffer").
    if (!Buffer.isBuffer(keys) && !ArrayBuffer.isView(keys)) {
      const received =
        keys === null ? "null" : Array.isArray(keys) ? "an array" : typeof keys;
      const err = new TypeError(
        'The "buffer" argument must be an instance of Buffer, TypedArray, ' +
          `or DataView. Received ${received}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const buf = Buffer.isBuffer(keys) ? keys : Buffer.from(keys);
    if (buf.length !== 48) {
      const err = new Error("Session ticket keys must be a 48-byte buffer");
      err.code = "ERR_INTERNAL_ASSERTION";
      throw err;
    }
    this._ticketKeys = buf;
    this._ticketEpoch++;
    return this;
  }

  getTicketKeys() {
    return this._ticketKeys === null ? null : Buffer.from(this._ticketKeys);
  }

  setSecureContext(options) {
    if (options && typeof options === "object") {
      createSecureContext(options);
      this._tlsOptions = { ...this._tlsOptions, ...options };
      if (options.ALPNProtocols !== undefined) {
        this.ALPNProtocols = _convertALPNProtocols(options.ALPNProtocols);
      }
    }
  }
}

/**
 * Port of Node's server-side TLS auth surface (lib/internal/tls/wrap.js
 * onServerSocketSecure + TLSSocket ctor :651-652): authorized starts
 * false, authorizationError starts null. Only when the server requested
 * a client cert (requestCert) is the presented cert verified: a
 * presented self-signed cert fails DEPTH_ZERO_SELF_SIGNED_CERT, no
 * presented cert fails UNABLE_TO_GET_ISSUER_CERT (both probed on real
 * Node v24.22.1). The virtual world has no CA to verify against, so a
 * presented cert can never verify (authorized stays false). The client
 * presents a cert iff its request options carried cert or pfx, recorded
 * on the ClientRequest as _tlsClientCertPresented and read here off the
 * loopback peer socket's _httpMessage; no peer / no message means no
 * presented cert (e.g. external handleRequest traffic).
 * ponytail: ceiling — a real TLS layer would set these from the actual
 * handshake verify result instead.
 */
function _setSocketAuthSurface(server, socket) {
  socket.authorized = false;
  if (!server._tlsOptions.requestCert) {
    socket.authorizationError = null;
    return;
  }
  const presented = !!socket._peer?._httpMessage?._tlsClientCertPresented;
  socket.authorizationError = presented
    ? "DEPTH_ZERO_SELF_SIGNED_CERT"
    : "UNABLE_TO_GET_ISSUER_CERT";
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

// Session-state prefix, Node lib/internal/tls/wrap.js
// kTLSSessionStatePrefix. Sessions issued here mirror wrapSessionState's
// shape (prefix + servername length + servername + session bytes).
const _TLS_SESSION_PREFIX = Buffer.from("\0nodejs:tls:session:1\0", "latin1");
let _tlsSessionCounter = 0;

function _fnv1a(value) {
  const buf =
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function _fnv1aHex(value) {
  return _fnv1a(value).toString(16).padStart(8, "0");
}

function _tlsKeyPart(value) {
  if (value === undefined || value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (typeof value === "function") return "";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return _fnv1aHex(value);
  }
  if (Array.isArray(value)) return value.map(_tlsKeyPart).join(",");
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

// Node lib/https.js:491 getPfxAgentKey, with the raw pfx bytes hashed
// instead of stringified (same distinguishing power, fixed size).
function _pfxAgentKey(pfx, passphrase) {
  if (!Array.isArray(pfx)) return _tlsKeyPart(pfx);
  let key = "";
  for (const entry of pfx) {
    const isObj =
      entry != null &&
      typeof entry === "object" &&
      !(entry instanceof Uint8Array) &&
      !Buffer.isBuffer(entry);
    const raw = isObj ? (entry.buf ?? entry) : entry;
    const pass = (isObj && entry.passphrase) || passphrase || "";
    key += `:${_tlsKeyPart(raw)}:${pass}`;
  }
  return key;
}

// Session-cache key. Node keys sessions by options._agentKey, which is
// the https Agent's getName (lib/https.js:515-594: the http name plus
// every TLS option). L4 owns the public getName port; this internal key
// mirrors its distinguishing dimensions so sessions are shared exactly
// where Node shares them, without touching getName.
function _httpsSessionKey(base, tls) {
  const host = base.host || base.hostname || "localhost";
  const port = base.port ?? "";
  let name = `${host}:${port}:${base.localAddress || ""}`;
  if (base.socketPath) name += `:${base.socketPath}`;
  else if (base.family === 4 || base.family === 6) name += `:${base.family}`;
  const parts = [
    tls.ca,
    tls.cert,
    tls.clientCertEngine,
    tls.ciphers,
    tls.key,
    _pfxAgentKey(tls.pfx, tls.passphrase),
    tls.rejectUnauthorized,
    tls.servername && tls.servername !== host ? tls.servername : undefined,
    tls.minVersion,
    tls.maxVersion,
    tls.secureProtocol,
    tls.crl,
    tls.honorCipherOrder,
    tls.ecdhCurve,
    tls.dhparam,
    tls.secureOptions,
    tls.sessionIdContext,
    tls.sigalgs,
    tls.privateKeyIdentifier,
    tls.privateKeyEngine,
  ];
  return name + ":" + parts.map(_tlsKeyPart).join(":");
}

function _newTlsSession(identity, epoch, sessionKey) {
  // The payload is synthetic — the virtual handshake has no TLS records
  // — but it is unique per issuance (monotonic counter), so two fresh
  // sessions never compare equal, while a resumed session returns the
  // cached bytes verbatim.
  const name = Buffer.from(String(identity), "utf8");
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(name.length, 0);
  const payload = Buffer.allocUnsafe(16);
  _tlsSessionCounter += 1;
  payload.writeBigUInt64BE(BigInt(_tlsSessionCounter), 0);
  payload.writeUInt32BE(epoch >>> 0, 8);
  payload.writeUInt32BE(_fnv1a(sessionKey), 12);
  return Buffer.concat([_TLS_SESSION_PREFIX, len, name, payload]);
}

// ---------------------------------------------------------------------------
// Client-certificate extraction (DER walk + PKCS#12 PBE decryption)
// ---------------------------------------------------------------------------
// The https agent needs the client certificate a request presents (pfx or
// cert option) so the server side can answer getPeerCertificate(). In the
// vendored fixtures the certBags live under PBE-encrypted PKCS7
// EncryptedData (pbeWithSHA1And3DES, verified with openssl pkcs12 -info),
// so the reader decrypts them with the PKCS#12 KDF + 3DES via the repo's
// crypto layer (native OpenSSL under genuine Node; in the browser
// createDecipheriv throws its honest "requires OpenSSL" error and
// extraction yields null). The shrouded keyBag is never touched and no
// private-key operation ever happens — only the certificate (public) is
// read. Same walker serves PEM certs (base64 DER). Returns { subject,
// issuer } (RDN short names) or null.
// ponytail: ceiling — a real TLS stack would also surface valid_from /
// valid_to / fingerprint; those need UTCTime + hash plumbing this lane
// does not need (no test reads them).

const _OID_SHORT_NAMES = {
  "2.5.4.3": "CN",
  "2.5.4.4": "SN",
  "2.5.4.5": "serialNumber",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.9": "street",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.12": "title",
  "2.5.4.17": "postalCode",
  "2.5.4.41": "name",
  "2.5.4.42": "GN",
  "1.2.840.113549.1.9.1": "emailAddress",
};

function _derRead(buf, offset) {
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  let pos = offset + 1;
  if (pos >= buf.length) return null;
  let length = buf[pos++];
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4 || pos + n > buf.length) return null;
    length = 0;
    for (let i = 0; i < n; i++) length = (length << 8) | buf[pos++];
  }
  const start = pos;
  const end = start + length;
  if (end > buf.length) return null;
  return { tag, length, start, end };
}

function _derChildren(buf, offset, end) {
  const out = [];
  let pos = offset;
  while (pos < end) {
    const t = _derRead(buf, pos);
    if (!t) break;
    out.push(t);
    pos = t.end;
  }
  return out;
}

function _derOID(buf, t) {
  const bytes = buf.subarray(t.start, t.end);
  if (bytes.length === 0) return "";
  const first = bytes[0];
  const a0 = Math.min(2, Math.floor(first / 40));
  const parts = [a0, first - a0 * 40];
  let v = 0;
  for (let i = 1; i < bytes.length; i++) {
    v = (v << 7) | (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

function _derString(buf, t) {
  if (t.tag === 0x0c) return buf.toString("utf8", t.start, t.end);
  if (t.tag === 0x1e) {
    // BMPString: UTF-16BE. Decode via a byte-swapped UTF-16LE read.
    const raw = buf.subarray(t.start, t.end);
    const swapped = Buffer.alloc(raw.length);
    for (let i = 0; i + 1 < raw.length; i += 2) {
      swapped[i] = raw[i + 1];
      swapped[i + 1] = raw[i];
    }
    return swapped.toString("utf16le");
  }
  // PrintableString / IA5String / TeletexString / anything else: latin1.
  return buf.toString("latin1", t.start, t.end);
}

function _parseRDN(buf, t) {
  const out = {};
  for (const set of _derChildren(buf, t.start, t.end)) {
    if (set.tag !== 0x31) continue;
    for (const atv of _derChildren(buf, set.start, set.end)) {
      if (atv.tag !== 0x30) continue;
      const parts = _derChildren(buf, atv.start, atv.end);
      if (parts.length < 2 || parts[0].tag !== 0x06) continue;
      const name = _OID_SHORT_NAMES[_derOID(buf, parts[0])];
      if (name !== undefined) out[name] = _derString(buf, parts[1]);
    }
  }
  return out;
}

function _parseCert(buf) {
  const top = _derRead(buf, 0);
  if (!top || top.tag !== 0x30) return null;
  const cert = _derChildren(buf, top.start, top.end);
  if (cert.length < 1 || cert[0].tag !== 0x30) return null;
  const tbs = _derChildren(buf, cert[0].start, cert[0].end);
  let i = 0;
  if (tbs[i] && tbs[i].tag === 0xa0) i++; // [0] version, optional
  // serial, signature, issuer, validity, subject
  if (tbs.length < i + 5) return null;
  const issuer = tbs[i + 2];
  const subject = tbs[i + 4];
  if (issuer.tag !== 0x30 || subject.tag !== 0x30) return null;
  return { subject: _parseRDN(buf, subject), issuer: _parseRDN(buf, issuer) };
}

function _certFromSafeContents(contents) {
  const top = _derRead(contents, 0);
  if (!top || top.tag !== 0x30) return null;
  for (const bag of _derChildren(contents, top.start, top.end)) {
    if (bag.tag !== 0x30) continue;
    const parts = _derChildren(contents, bag.start, bag.end);
    if (parts.length < 2 || parts[0].tag !== 0x06) continue;
    if (_derOID(contents, parts[0]) !== "1.2.840.113549.1.12.10.1.3") continue; // certBag
    if (parts[1].tag !== 0xa0) continue;
    const val = _derChildren(contents, parts[1].start, parts[1].end);
    if (val.length < 1 || val[0].tag !== 0x30) continue;
    const cv = _derChildren(contents, val[0].start, val[0].end);
    if (cv.length < 2 || cv[1].tag !== 0xa0) continue;
    const oct = _derChildren(contents, cv[1].start, cv[1].end);
    if (oct.length < 1 || oct[0].tag !== 0x04) continue;
    const cert = _parseCert(contents.subarray(oct[0].start, oct[0].end));
    if (cert) return cert;
  }
  return null;
}

function _certFromAuthenticatedSafe(safe, passphrase) {
  const top = _derRead(safe, 0);
  if (!top || top.tag !== 0x30) return null;
  for (const ci of _derChildren(safe, top.start, top.end)) {
    if (ci.tag !== 0x30) continue;
    const parts = _derChildren(safe, ci.start, ci.end);
    if (parts.length < 2 || parts[0].tag !== 0x06) continue;
    const oid = _derOID(safe, parts[0]);
    if (oid === "1.2.840.113549.1.7.1") {
      // data: [0] wraps an OCTET STRING holding the SafeContents bytes.
      if (parts[1].tag !== 0xa0) continue;
      const oct = _derChildren(safe, parts[1].start, parts[1].end);
      if (oct.length < 1 || oct[0].tag !== 0x04) continue;
      const cert = _certFromSafeContents(
        safe.subarray(oct[0].start, oct[0].end),
      );
      if (cert) return cert;
    } else if (oid === "1.2.840.113549.1.7.6") {
      // encryptedData: the cert bags are PBE-encrypted (the vendored
      // fixtures use pbeWithSHA1And3DES); decrypt and read them.
      if (parts[1].tag !== 0xa0) continue;
      const cert = _certFromEncryptedData(
        safe,
        parts[1].start,
        parts[1].end,
        passphrase,
      );
      if (cert) return cert;
    }
    // Any other ContentInfo type is skipped.
  }
  return null;
}

// PKCS#12 KDF (RFC 7292 Appendix B.2), SHA-1 (u = 20, v = 64).
// Derives `n` bytes for the given purpose id (1 = key, 2 = IV).
function _pkcs12KDF(password, salt, iterations, id, n) {
  const u = 20;
  const v = 64;
  const D = Buffer.alloc(v, id);
  const repeatTo = (src, len) => {
    if (src.length === 0 || len === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = src[i % src.length];
    return out;
  };
  const S = repeatTo(salt, v * Math.ceil(salt.length / v));
  // Password as UTF-16BE + NULL terminator; empty password means no P block.
  let P = Buffer.alloc(0);
  if (password !== undefined && password !== null && password !== "") {
    const le = Buffer.from(String(password), "utf16le");
    const be = Buffer.alloc(le.length + 2);
    for (let i = 0; i < le.length; i += 2) {
      be[i] = le[i + 1];
      be[i + 1] = le[i];
    }
    P = repeatTo(be, v * Math.ceil(be.length / v));
  }
  let I = Buffer.concat([S, P]);
  const sha1 = (data) => createHash("sha1").update(data).digest();
  const out = [];
  let generated = 0;
  while (generated < n) {
    let A = sha1(Buffer.concat([D, I]));
    for (let i = 1; i < iterations; i++) A = sha1(A);
    out.push(A);
    generated += u;
    if (generated >= n) break;
    // B = A repeated to v bytes; I_j = (I_j + B + 1) mod 2^(8v).
    const B = Buffer.alloc(v);
    for (let i = 0; i < v; i++) B[i] = A[i % u];
    const blocks = I.length / v;
    for (let j = 0; j < blocks; j++) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const sum = I[j * v + k] + B[k] + carry;
        I[j * v + k] = sum & 0xff;
        carry = sum >> 8;
      }
    }
  }
  return Buffer.concat(out).subarray(0, n);
}

// Decrypt one EncryptedData ContentInfo's [0] value (the EncryptedData
// SEQUENCE bytes live between start/end) and read a certificate from the
// decrypted SafeContents. Only pbeWithSHA1And3DES (1.2.840.113549.1.12.1.3,
// what the vendored fixtures use) is supported; anything else yields null.
function _certFromEncryptedData(buf, start, end, passphrase) {
  const enc = _derChildren(buf, start, end);
  if (enc.length < 1 || enc[0].tag !== 0x30) return null;
  const eci = _derChildren(buf, enc[0].start, enc[0].end);
  if (eci.length < 2 || eci[1].tag !== 0x30) return null;
  // EncryptedContentInfo children: OID contentType, SEQ algorithm, [0] data.
  const eciParts = _derChildren(buf, eci[1].start, eci[1].end);
  if (eciParts.length < 3 || eciParts[0].tag !== 0x06) return null;
  if (eciParts[1].tag !== 0x30) return null;
  const alg = _derChildren(buf, eciParts[1].start, eciParts[1].end);
  if (alg.length < 2 || alg[0].tag !== 0x06) return null;
  if (_derOID(buf, alg[0]) !== "1.2.840.113549.1.12.1.3") return null;
  if (alg[1].tag !== 0x30) return null;
  const params = _derChildren(buf, alg[1].start, alg[1].end);
  if (params.length < 2 || params[0].tag !== 0x04) return null;
  if (params[1].tag !== 0x02) return null;
  const salt = buf.subarray(params[0].start, params[0].end);
  let iterations = 0;
  for (let i = params[1].start; i < params[1].end; i++) {
    iterations = (iterations << 8) | buf[i];
  }
  if (iterations <= 0) return null;
  // Encrypted content: [0] IMPLICIT OCTET STRING — its bytes ARE the
  // ciphertext (no inner tag).
  if (eciParts[2].tag !== 0x80) return null;
  const ciphertext = buf.subarray(eciParts[2].start, eciParts[2].end);
  const key = _pkcs12KDF(passphrase, salt, iterations, 1, 24);
  const iv = _pkcs12KDF(passphrase, salt, iterations, 2, 8);
  // In the browser createDecipheriv throws its honest "requires OpenSSL"
  // error; the caller's try/catch turns that into "no certificate".
  const decipher = createDecipheriv("des-ede3-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return _certFromSafeContents(plain);
}

function _certFromPfx(buf, passphrase) {
  const top = _derRead(buf, 0);
  if (!top || top.tag !== 0x30) return null;
  const pfx = _derChildren(buf, top.start, top.end);
  if (pfx.length < 2 || pfx[1].tag !== 0x30) return null;
  const ci = _derChildren(buf, pfx[1].start, pfx[1].end);
  if (ci.length < 2 || ci[0].tag !== 0x06) return null;
  if (_derOID(buf, ci[0]) !== "1.2.840.113549.1.7.1") return null; // data
  if (ci[1].tag !== 0xa0) return null;
  const oct = _derChildren(buf, ci[1].start, ci[1].end);
  if (oct.length < 1 || oct[0].tag !== 0x04) return null;
  return _certFromAuthenticatedSafe(
    buf.subarray(oct[0].start, oct[0].end),
    passphrase,
  );
}

function _pemToDer(input) {
  let text;
  if (typeof input === "string") {
    text = input;
  } else if (input instanceof Uint8Array) {
    if (
      input.length >= 10 &&
      Buffer.from(input.subarray(0, 10))
        .toString("latin1")
        .startsWith("-----BEGIN")
    ) {
      text = Buffer.from(input).toString("latin1");
    } else {
      return Buffer.from(input); // raw DER
    }
  } else {
    return null;
  }
  const m = text.match(/-----BEGIN [^-]+-----\s*([A-Za-z0-9+/=\s]+)-----END/);
  if (!m) return null;
  return Buffer.from(m[1].replace(/\s+/g, ""), "base64");
}

function _extractClientCertificate(options) {
  try {
    const { pfx, cert, passphrase } = options || {};
    if (pfx !== undefined) {
      const list = Array.isArray(pfx) ? pfx : [pfx];
      for (const entry of list) {
        const isObj =
          entry != null &&
          typeof entry === "object" &&
          !(entry instanceof Uint8Array) &&
          !Buffer.isBuffer(entry);
        const raw = isObj ? (entry.buf ?? entry) : entry;
        if (raw == null || !(raw instanceof Uint8Array)) continue;
        const pass = (isObj && entry.passphrase) || passphrase;
        const found = _certFromPfx(Buffer.from(raw), pass);
        if (found) return found;
      }
      return null;
    }
    if (cert !== undefined) {
      const list = Array.isArray(cert) ? cert : [cert];
      for (const entry of list) {
        const der = _pemToDer(entry);
        if (!der) continue;
        const found = _parseCert(der);
        if (found) return found;
      }
    }
    return null;
  } catch {
    return null;
  }
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
    // Node lib/https.js:476: the TLS session cache. Entries are
    // { session, epoch, server } (Node stores the bare session Buffer;
    // the epoch + server let the agent refuse resumption after the
    // server rotated ticket keys, or when the port serves a different
    // server object).
    this._sessionCache = {
      map: {},
      list: [],
    };
  }

  // Node lib/https.js:604-636, ported apart from the entry shape (see above).
  _getSession(key) {
    return this._sessionCache.map[key];
  }

  _cacheSession(key, entry) {
    // Cache is disabled
    if (this.maxCachedSessions === 0) return;

    // Fast case - update existing entry
    if (this._sessionCache.map[key]) {
      this._sessionCache.map[key] = entry;
      return;
    }

    // Put new entry
    if (this._sessionCache.list.length >= this.maxCachedSessions) {
      const oldKey = this._sessionCache.list.shift();
      delete this._sessionCache.map[oldKey];
    }

    this._sessionCache.list.push(key);
    this._sessionCache.map[key] = entry;
  }

  _evictSession(key) {
    const index = this._sessionCache.list.indexOf(key);
    if (index === -1) return;

    this._sessionCache.list.splice(index, 1);
    delete this._sessionCache.map[key];
  }

  // Answer whether a request with these connect options would resume a
  // cached session against this server — the same lookup resolveSession
  // performs at connect time, usable before the socket exists (the
  // peer verifier needs it: a resumed session presents no new
  // certificate, so there is nothing to verify). Returns the cached
  // session Buffer, or null. A per-request checkServerIdentity (Node
  // lib/https.js:674-678) disables reuse for that request, so it also
  // yields null; an epoch rotation or a different server object yields
  // null (the ticket would not decrypt).
  _peekSession(connectOptions, server) {
    const tlsOptions = connectOptions._tlsOptions || {};
    const agentCheck = this.options && this.options.checkServerIdentity;
    const reqCheck = tlsOptions.checkServerIdentity;
    if (
      reqCheck !== undefined &&
      reqCheck !== tlsCheckServerIdentity &&
      agentCheck === undefined
    ) {
      return null;
    }
    const cached = this._getSession(
      _httpsSessionKey(connectOptions, tlsOptions),
    );
    if (!cached) return null;
    const epoch = server ? (server._ticketEpoch ?? 0) : 0;
    if (cached.server !== server || cached.epoch !== epoch) return null;
    return cached.session;
  }

  // Node lib/https.js createConnection (use sites :357-367, :426-440):
  // look a cached session up by the agent key, attach it to the connect,
  // and cache the session the handshake issues. The virtual handshake
  // has no TLS records, so the session is issued synthetically at
  // connect time (see resolveSession) and the client certificate is
  // extracted from the request's pfx/cert options for the server side.
  createConnection(options, callback) {
    const tlsOptions = options._tlsOptions || {};
    const sessionKey = _httpsSessionKey(options, tlsOptions);
    // Node lib/https.js:674-678 + :357-358: a per-request
    // checkServerIdentity (custom function, agent has none) disables
    // session reuse for that request — nothing is looked up or cached.
    const agentCheck = this.options && this.options.checkServerIdentity;
    const reqCheck = tlsOptions.checkServerIdentity;
    const perRequestCheck =
      reqCheck !== undefined &&
      reqCheck !== tlsCheckServerIdentity &&
      agentCheck === undefined;
    const reuseSession = !perRequestCheck;

    const socket = super.createConnection(options, callback);
    if (!socket) return socket;

    // Client certificate the request presents (pfx/cert option), for
    // the server side's getPeerCertificate(). Extracted from the real
    // option bytes; absent when no client certificate is presented.
    const peerCert = _extractClientCertificate(tlsOptions);
    if (peerCert) socket._tlsClientCert = peerCert;

    if (reuseSession) {
      // Node lib/https.js:432-440: cache new sessions, evict on error.
      socket.on("session", (session) => {
        this._cacheSession(sessionKey, {
          session,
          epoch: socket._tlsSessionEpoch ?? 0,
          server: socket._tlsSessionServer ?? null,
        });
      });
      socket.once("close", (hadError) => {
        if (hadError) this._evictSession(sessionKey);
      });
    }

    // Resolve the session once the virtual connection exists: the peer
    // server socket carries the server object and its ticket epoch. A
    // cached session resumes only under the same server + epoch (Node:
    // the ticket decrypts); otherwise a fresh session is issued and the
    // 'session' event carries it to the cache above.
    const resolveSession = () => {
      if (socket.destroyed) return;
      // The peer socket carries the TLS server (_tlsServer, stashed by
      // HttpsServerBase's connection listener); fall back to the backing
      // net.Server (.server) for non-https peers.
      const server =
        (socket._peer && (socket._peer._tlsServer || socket._peer.server)) ||
        null;
      const epoch = server ? (server._ticketEpoch ?? 0) : 0;
      // Session identity is servername-based (wrap.js:119
      // getSessionServerIdentity): servername, else host, else localhost.
      const identity = tlsOptions.servername || options.host || "localhost";
      const resumed = reuseSession ? this._peekSession(options, server) : null;
      if (resumed) {
        socket._tlsSession = resumed;
        socket._tlsSessionReused = true;
        socket._tlsSessionEpoch = epoch;
        socket._tlsSessionServer = server;
        socket.emit("session", resumed);
        return;
      }
      const session = _newTlsSession(identity, epoch, sessionKey);
      socket._tlsSession = session;
      socket._tlsSessionReused = false;
      socket._tlsSessionEpoch = epoch;
      socket._tlsSessionServer = server;
      socket.emit("session", session);
    };
    if (socket._connected) queueMicrotask(resolveSession);
    else socket.once("connect", resolveSession);
    return socket;
  }

  // Port of Node lib/https.js:515-594 (Agent.prototype.getName): the http
  // base name plus the TLS option fields, in Node's exact field order.
  // The http base (super.getName) already yields e.g. 'localhost::' for {}.
  // ponytail: ceiling — a real TLS layer would also need the per-request
  // checkServerIdentity symbol threaded from createConnection (L8); the
  // symbol key below is faithful to Node's tail but nothing sets it yet.
  getName(options = {}) {
    let name = super.getName(options);
    // The pool checkout (AgentBase.addRequest/createSocket) passes the
    // request's _agentOptions, where the TLS fields nest under
    // _tlsOptions (threaded there by ClientRequest); the public call
    // passes them top-level. Read from the nested bundle when present
    // so the pool key distinguishes pfx/cert/etc. either way — without
    // this, two requests with different pfx share a key and the second
    // reuses the first socket (test-https-agent-pfx-object-array-reuse).
    const tls = options._tlsOptions || options;

    name += ":";
    if (tls.ca) name += tls.ca;

    name += ":";
    if (tls.cert) name += tls.cert;

    name += ":";
    if (tls.clientCertEngine) name += tls.clientCertEngine;

    name += ":";
    if (tls.ciphers) name += tls.ciphers;

    name += ":";
    if (tls.key) name += tls.key;

    name += ":";
    if (tls.pfx) name += getPfxAgentKey(tls.pfx, tls.passphrase);

    name += ":";
    if (tls.rejectUnauthorized !== undefined) name += tls.rejectUnauthorized;

    name += ":";
    if (tls.servername && tls.servername !== options.host)
      name += tls.servername;

    name += ":";
    if (tls.minVersion) name += tls.minVersion;

    name += ":";
    if (tls.maxVersion) name += tls.maxVersion;

    name += ":";
    if (tls.secureProtocol) name += tls.secureProtocol;

    name += ":";
    if (tls.crl) name += tls.crl;

    name += ":";
    if (tls.honorCipherOrder !== undefined) name += tls.honorCipherOrder;

    name += ":";
    if (tls.ecdhCurve) name += tls.ecdhCurve;

    name += ":";
    if (tls.dhparam) name += tls.dhparam;

    name += ":";
    if (tls.secureOptions !== undefined) name += tls.secureOptions;

    name += ":";
    if (tls.sessionIdContext) name += tls.sessionIdContext;

    name += ":";
    if (tls.sigalgs) name += JSON.stringify(tls.sigalgs);

    name += ":";
    if (tls.privateKeyIdentifier) name += tls.privateKeyIdentifier;

    name += ":";
    if (tls.privateKeyEngine) name += tls.privateKeyEngine;

    if (options[kPerRequestCheckServerIdentity])
      name += `:${options[kPerRequestCheckServerIdentity]}`;

    return name;
  }
}

// Port of Node lib/https.js:52 (module-local symbol) and :491-503.
const kPerRequestCheckServerIdentity = Symbol(
  "per-request checkServerIdentity",
);

function getPfxAgentKey(pfx, passphrase) {
  if (!Array.isArray(pfx)) return pfx;

  let key = "";
  for (let i = 0; i < pfx.length; i++) {
    const value = pfx[i];
    const raw = value?.buf || value;
    const pass = value?.passphrase || passphrase;
    key += `:${raw}:${pass}`;
  }
  return key;
}

/** Node's https.Agent is callable without `new` as well. */
export function Agent(...args) {
  return Reflect.construct(HttpsAgentBase, args, new.target ?? Agent);
}
Object.setPrototypeOf(Agent, HttpsAgentBase);
Agent.prototype = HttpsAgentBase.prototype;

/** The default agent used when none is supplied. */
// ponytail: `let`, not `const` — Node exposes globalAgent as an accessor
// (lib/http.js:220 get/set, read by lib/https.js:649/681) so
// `https.globalAgent = agent` rebinds it; the default-export object below
// carries the matching setter, and the request path reads this binding
// (request() passes it as _createClientRequest's defaultAgent), so
// assignment routes new requests to the assigned agent. Unassigned, the
// default keep-alive agent stands.
export let globalAgent = new Agent({
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
  // ponytail: accessor, not a snapshot — matches Node's globalAgent
  // getter/setter (lib/http.js:220); assignment rebinds the module-scope
  // binding above, which the request path reads.
  get globalAgent() {
    return globalAgent;
  },
  set globalAgent(value) {
    globalAgent = value;
  },
};
