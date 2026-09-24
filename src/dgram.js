// src/dgram.js — port of node:dgram for the browser runtime.
//
// Raw UDP does not exist in browsers, so this module is an honest emulation:
//   - Argument validation mirrors Node.js v24.20.0 exactly (same ERR_* codes
//     and messages) — everything checkable without a network is checked.
//   - The lifecycle state machine (unbound -> binding -> bound -> closed;
//     disconnected -> connecting -> connected) and the event names
//     ('listening', 'message', 'connect', 'error', 'close') match Node's
//     observable behavior.
//   - Anything requiring real network I/O is a documented noop: outgoing
//     datagrams are discarded (send callbacks fire asynchronously with
//     (null, 0) — zero bytes actually sent), 'message' events are never
//     emitted, and address()/remoteAddress() return null instead of
//     fabricated addresses.
//
// Runtime contract: this module needs no runtime services, so it references
// no _RUNTIME_ state. Async completion uses globalThis.setTimeout, which the
// host runtime wraps into its task tracker inside the sandbox. No
// window/document at module scope; no Buffer, no process.getBuiltinModule —
// the whole module works with zero native-Node delegation.

import { EventEmitter } from "./events.js";

// ---------------------------------------------------------------------------
// Error helpers (messages mirror Node v24.20.0 verbatim, verified against the
// real runtime).
// ---------------------------------------------------------------------------

function fmtReceived(value) {
  if (value === undefined) return "Received undefined";
  if (value === null) return "Received null";
  const t = typeof value;
  return `Received type ${t} (${t === "string" ? `'${value}'` : String(value)})`;
}

function nodeError(Base, code, message) {
  const e = new Base(message);
  e.code = code;
  return e;
}

function errSocketBadType() {
  return nodeError(TypeError, "ERR_SOCKET_BAD_TYPE",
    "Bad socket type specified. Valid types are: udp4, udp6");
}

function errSocketAlreadyBound() {
  return nodeError(Error, "ERR_SOCKET_ALREADY_BOUND", "Socket is already bound");
}

function errSocketNotRunning() {
  // Node v24 message for ERR_SOCKET_DGRAM_NOT_RUNNING.
  return nodeError(Error, "ERR_SOCKET_DGRAM_NOT_RUNNING", "Not running");
}

function errSocketIsConnected() {
  return nodeError(Error, "ERR_SOCKET_DGRAM_IS_CONNECTED", "Already connected");
}

function errSocketNotConnected() {
  return nodeError(Error, "ERR_SOCKET_DGRAM_NOT_CONNECTED", "Not connected");
}

function errSocketBadPort(name, port, allowZero) {
  return nodeError(RangeError, "ERR_SOCKET_BAD_PORT",
    `${name} should be ${allowZero ? ">= 0" : "> 0"} and < 65536. ${fmtReceived(port)}.`);
}

function errSocketBadBufferSize() {
  return nodeError(Error, "ERR_SOCKET_BAD_BUFFER_SIZE",
    "Buffer size must be a positive integer");
}

function errInvalidArgType(name, expected, value, what = "argument") {
  return nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
    `The "${name}" ${what} must be of type ${expected}. ${fmtReceived(value)}`);
}

function errInvalidBufferArg(value) {
  return nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
    `The "buffer" argument must be of type string or an instance of ` +
    `Buffer, TypedArray, or DataView. ${fmtReceived(value)}`);
}

function errBufferOutOfBounds(which) {
  return nodeError(RangeError, "ERR_BUFFER_OUT_OF_BOUNDS",
    `"${which}" is outside of buffer bounds`);
}

function errMissingArgs(name) {
  return nodeError(TypeError, "ERR_MISSING_ARGS",
    `The "${name}" argument must be specified`);
}

function errOutOfRange(name, value) {
  return nodeError(RangeError, "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be >= 0 && <= 4294967295. ` +
    `Received ${String(value)}`);
}

function errInvalidArgValue(kind, name, reason, value) {
  return nodeError(TypeError, "ERR_INVALID_ARG_VALUE",
    `The ${kind} '${name}' ${reason}. Received ${fmtValue(value)}`);
}

function fmtValue(value) {
  return typeof value === "string" ? `'${value}'` : String(value);
}

// errno-shaped error, mirroring Node's getsockname failure on an unbound socket.
function errGetsocknameEBADF() {
  const e = new Error("getsockname EBADF");
  e.code = "EBADF";
  e.errno = -9;
  e.syscall = "getsockname";
  return e;
}

// ---------------------------------------------------------------------------
// Validators (mirrors of node's internal/validators used by lib/dgram.js).
// ---------------------------------------------------------------------------

function validateString(value, name) {
  if (typeof value !== "string") throw errInvalidArgType(name, "string", value);
}

function validateNumber(value, name) {
  if (typeof value !== "number") throw errInvalidArgType(name, "number", value);
}

// Mirrors internal validatePort() for the dgram call sites:
// send()/connect() pass name 'Port', allowZero=false; bindSync() passes
// name 'options.port', allowZero=true.
function validatePort(port, name, allowZero = true) {
  if ((typeof port !== "number" && typeof port !== "string") ||
      (typeof port === "string" && port.trim().length === 0) ||
      +port !== (+port >>> 0) ||
      +port > 0xFFFF ||
      (+port === 0 && !allowZero)) {
    throw errSocketBadPort(name, port, allowZero);
  }
  return +port | 0;
}

// Mirrors the `if (options.recvBufferSize)` + validateUint32() pair in the
// Socket constructor.
function validateBufferSizeOption(value, name) {
  if (typeof value !== "number") throw errInvalidArgType(name, "number", value, "property");
  if (!(value >= 0 && value <= 4294967295 && Number.isInteger(value))) {
    throw errOutOfRange(name, value);
  }
}

// Conservative numeric-IP-literal check for bindSync()/connectSync().
// Node uses its internal isIP(); this accepts the common IPv4 and IPv6
// literal forms without DNS.
function isIPLiteral(s) {
  if (typeof s !== "string" || s.length === 0) return 0;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s) &&
      s.split(".").every((p) => +p <= 255)) return 4;
  // IPv6: full, compressed (::), and embedded-IPv4 forms.
  const h16 = "[0-9a-fA-F]{1,4}";
  const v6 = new RegExp(
    `^(${h16}:){7}${h16}$` +                    // full
    `|^:((:${h16}){1,7}|:)$` +                 // leading ::
    `|^(${h16}:){1,7}:$` +                     // trailing ::
    `|^(${h16}:){1,6}:${h16}$` +               // single ::
    `|^::(ffff(:0{1,4})?:)?(\\d{1,3}\\.){3}\\d{1,3}$` // embedded IPv4
  );
  if (v6.test(s)) return 6;
  return 0;
}

// Mirrors sliceBuffer()'s acceptance checks (offset/length bounds) without
// materializing a Buffer — there is no network to hand bytes to.
const _textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function byteLengthOf(value) {
  if (typeof value === "string") {
    return _textEncoder ? _textEncoder.encode(value).length : value.length;
  }
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return -1;
}

function checkBufferSlice(buffer, offset, length) {
  const byteLength = byteLengthOf(buffer);
  if (byteLength < 0) throw errInvalidBufferArg(buffer);
  const off = offset >>> 0;
  const len = length >>> 0;
  if (off > byteLength) throw errBufferOutOfBounds("offset");
  if (off + len > byteLength) throw errBufferOutOfBounds("length");
}

function checkBufferList(list) {
  for (const item of list) {
    if (typeof item !== "string" && !ArrayBuffer.isView(item)) {
      throw errInvalidArgType("buffer list arguments",
        "Buffer, TypedArray, DataView, or string", list);
    }
  }
}

// ---------------------------------------------------------------------------
// Socket state.
// ---------------------------------------------------------------------------

const kState = Symbol("dgramSocketState");

const BIND_UNBOUND = 0;
const BIND_BINDING = 1;
const BIND_BOUND = 2;

const CONN_DISCONNECTED = 0;
const CONN_CONNECTING = 1;
const CONN_CONNECTED = 2;

function defer(fn) {
  // globalThis.setTimeout: native in browsers and Node; inside Jared's
  // sandbox the runtime wraps timers into its task tracker.
  globalThis.setTimeout(fn, 0);
}

function healthCheck(socket) {
  if (socket[kState].closed) throw errSocketNotRunning();
}

// ---------------------------------------------------------------------------
// Socket.
// ---------------------------------------------------------------------------

export class Socket extends EventEmitter {
  constructor(type, listener) {
    super();

    let options = null;
    if (type !== null && typeof type === "object") {
      options = type;
      type = options.type;
    }
    if (type !== "udp4" && type !== "udp6") throw errSocketBadType();

    if (options) {
      // Mirrors Node: only validated when truthy.
      if (options.recvBufferSize) {
        validateBufferSizeOption(options.recvBufferSize, "options.recvBufferSize");
      }
      if (options.sendBufferSize) {
        validateBufferSizeOption(options.sendBufferSize, "options.sendBufferSize");
      }
      // receiveBlockList / sendBlockList: accepted and ignored — there is no
      // net.BlockList in a browser and no packets to filter. (Documented gap.)
    }

    this.type = type;
    this[kState] = {
      bindState: BIND_UNBOUND,
      connectState: CONN_DISCONNECTED,
      closed: false,
      closeQueued: false,
    };

    if (typeof listener === "function") this.on("message", listener);

    // options.signal: aborting closes the socket (mirrors Node).
    if (options && options.signal !== undefined) {
      const signal = options.signal;
      if (signal !== null && typeof signal === "object" &&
          typeof signal.addEventListener === "function") {
        if (signal.aborted) {
          this.close();
        } else {
          const onAbort = () => this.close();
          signal.addEventListener("abort", onAbort, { once: true });
          this.once("close", () => signal.removeEventListener("abort", onAbort));
        }
      } else {
        throw errInvalidArgType("options.signal", "AbortSignal", signal, "property");
      }
    }
  }

  // -- bind ---------------------------------------------------------------

  bind(port_, address_, callback_) {
    healthCheck(this);
    const state = this[kState];
    if (state.bindState !== BIND_UNBOUND) throw errSocketAlreadyBound();
    state.bindState = BIND_BINDING;

    // The callback is the last argument, whatever position it is in
    // (mirrors Node's `arguments[arguments.length - 1]` handling).
    const last = arguments.length > 0 ? arguments[arguments.length - 1] : undefined;
    const cb = typeof last === "function" ? last : undefined;
    if (cb) {
      const onListening = () => {
        this.removeListener("error", onBindError);
        cb.call(this);
      };
      const onBindError = () => {
        this.removeListener("listening", onListening);
      };
      this.once("listening", onListening);
      this.once("error", onBindError);
    }

    // Options-object form: bind({ port, address, exclusive, fd }).
    // `fd`/handle adoption is browser-impossible and treated as a plain bind
    // (documented gap). Port/address values need no validation here: Node's
    // async bind() performs no synchronous port validation either — real
    // bind failures surface as async 'error' events, which cannot occur
    // without a network.
    if (port_ !== null && typeof port_ === "object" &&
        typeof port_.recvStart !== "function") {
      address_ = port_.address; // eslint-disable-line no-param-reassign
    } else if (typeof address_ === "function") {
      address_ = undefined; // eslint-disable-line no-param-reassign
    }

    defer(() => {
      if (state.closed || state.bindState !== BIND_BINDING) return;
      state.bindState = BIND_BOUND;
      if (state.closeQueued) {
        this.close();
        return;
      }
      this.emit("listening");
    });
    return this;
  }

  // Synchronous counterpart of bind(). Validates like Node's bindSync()
  // (bad arguments leave the socket unbound), but no real bind happens:
  // the 'listening' event still fires on the next tick and address()
  // returns null — there is no local address to report.
  bindSync(options = {}) {
    healthCheck(this);
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw errInvalidArgType("options", "object", options);
    }
    const state = this[kState];
    if (state.bindState !== BIND_UNBOUND) throw errSocketAlreadyBound();

    const port = validatePort(options.port ?? 0, "options.port", true);
    void port;
    let address = options.address;
    if (address === undefined || address === null || address === "") {
      address = this.type === "udp4" ? "0.0.0.0" : "::";
    } else {
      validateString(address, "options.address");
      if (isIPLiteral(address) === 0) {
        throw errInvalidArgValue("property", "options.address",
          "must be a numeric IP address; bindSync does not perform DNS resolution", address);
      }
    }

    state.bindState = BIND_BOUND;
    defer(() => {
      if (!state.closed) this.emit("listening");
    });
    return this.address();
  }

  // -- connect / disconnect -------------------------------------------------

  connect(port, address, callback) {
    port = validatePort(port, "Port", false);
    if (typeof address === "function") {
      callback = address;
      address = "";
    } else if (address === undefined) {
      address = "";
    }
    validateString(address, "address");

    const state = this[kState];
    if (state.connectState !== CONN_DISCONNECTED) throw errSocketIsConnected();
    state.connectState = CONN_CONNECTING;

    if (state.bindState === BIND_UNBOUND) this.bind({ port: 0, exclusive: true });

    if (typeof callback === "function") this.once("connect", callback);

    defer(() => {
      if (state.closed || state.connectState !== CONN_CONNECTING) return;
      state.connectState = CONN_CONNECTED;
      this.emit("connect");
    });
    return this;
  }

  // Synchronous counterpart of connect(). Validates like Node's connectSync();
  // no real peer exists, so remoteAddress() returns null afterwards.
  connectSync(port, address) {
    healthCheck(this);
    port = validatePort(port, "Port", false);
    const state = this[kState];
    if (state.connectState !== CONN_DISCONNECTED) throw errSocketIsConnected();

    if (address === undefined || address === null || address === "") {
      address = this.type === "udp4" ? "127.0.0.1" : "::1";
    } else {
      validateString(address, "address");
      if (isIPLiteral(address) === 0) {
        throw errInvalidArgValue("argument", "address",
          "must be a numeric IP address; connectSync does not perform DNS resolution", address);
      }
    }

    if (state.bindState === BIND_UNBOUND) {
      state.bindState = BIND_BOUND;
      defer(() => {
        if (!state.closed) this.emit("listening");
      });
    }
    state.connectState = CONN_CONNECTED;
    defer(() => {
      if (!state.closed && state.connectState === CONN_CONNECTED) this.emit("connect");
    });
    return undefined;
  }

  disconnect() {
    const state = this[kState];
    if (state.connectState !== CONN_CONNECTED) throw errSocketNotConnected();
    state.connectState = CONN_DISCONNECTED;
    return undefined;
  }

  // -- send -----------------------------------------------------------------
  //
  // Valid combinations (mirrored from lib/dgram.js):
  //   connectionless: send(buf, offset, length, port, address[, cb])
  //                   send(buf, offset, length, port[, cb])
  //                   send(bufOrList, port, address[, cb])
  //                   send(bufOrList, port[, cb])
  //   connected:      send(buf, offset, length[, cb])
  //                   send(bufOrList[, cb])
  //
  // The datagram is validated, then discarded — browsers cannot emit UDP.
  // The callback fires asynchronously with (null, 0): zero bytes sent.

  send(buffer, offset, length, port, address, callback) {
    const state = this[kState];
    const connected = state.connectState === CONN_CONNECTED;

    if (!connected) {
      if (address || (port && typeof port !== "function")) {
        checkBufferSlice(buffer, offset, length);
      } else {
        callback = port;
        port = offset;
        address = length;
      }
    } else {
      if (typeof length === "number") {
        checkBufferSlice(buffer, offset, length);
        if (typeof port === "function") {
          callback = port;
          port = null;
        }
      } else {
        callback = offset;
      }
      if (port || address) throw errSocketIsConnected();
    }

    if (!Array.isArray(buffer)) {
      if (typeof buffer !== "string" && !ArrayBuffer.isView(buffer)) {
        throw errInvalidBufferArg(buffer);
      }
    } else {
      checkBufferList(buffer);
    }

    if (!connected) port = validatePort(port, "Port", false);

    if (typeof callback !== "function") callback = undefined;
    if (typeof address === "function") {
      callback = address;
      address = undefined;
    } else if (address != null) {
      validateString(address, "address");
    }

    healthCheck(this);

    if (state.bindState === BIND_UNBOUND) this.bind({ port: 0, exclusive: true });

    // Honest noop: the datagram is discarded; report zero bytes sent.
    defer(() => {
      if (callback) callback(null, 0);
    });
    return undefined;
  }

  // Thin wrapper around send() for dgram_legacy.js compatibility.
  sendto(buffer, offset, length, port, address, callback) {
    validateNumber(offset, "offset");
    validateNumber(length, "length");
    validateNumber(port, "port");
    validateString(address, "address");
    return this.send(buffer, offset, length, port, address, callback);
  }

  // -- close ----------------------------------------------------------------

  close(callback) {
    const state = this[kState];
    if (typeof callback === "function") this.on("close", callback);
    if (state.bindState === BIND_BINDING) {
      // Mirror Node: a close issued while binding is queued until the bind
      // settles, instead of throwing.
      state.closeQueued = true;
      return this;
    }
    healthCheck(this);
    state.closed = true;
    defer(() => this.emit("close"));
    return this;
  }

  async [Symbol.asyncDispose]() {
    if (this[kState].closed) return;
    await new Promise((resolve) => this.close(resolve));
  }

  // -- introspection ----------------------------------------------------------

  address() {
    const state = this[kState];
    if (state.closed) throw errSocketNotRunning();
    if (state.bindState !== BIND_BOUND) throw errGetsocknameEBADF();
    // No real local address exists in a browser — return null rather than
    // fabricating one (e.g. "0.0.0.0").
    return null;
  }

  remoteAddress() {
    const state = this[kState];
    if (state.closed) throw errSocketNotRunning();
    if (state.connectState !== CONN_CONNECTED) throw errSocketNotConnected();
    // No real peer exists in a browser — return null rather than echoing the
    // connect() arguments as if a connection had been established.
    return null;
  }

  // -- socket options (noops: no real socket to configure) --------------------

  setBroadcast(_flag) {
    return undefined;
  }

  setTTL(ttl) {
    validateNumber(ttl, "ttl");
    return ttl;
  }

  setMulticastTTL(ttl) {
    validateNumber(ttl, "ttl");
    return ttl;
  }

  setMulticastLoopback(flag) {
    return flag; // 0.4 compatibility, as in Node
  }

  setMulticastInterface(interfaceAddress) {
    healthCheck(this);
    validateString(interfaceAddress, "interfaceAddress");
    return undefined;
  }

  addMembership(multicastAddress, _multicastInterface) {
    healthCheck(this);
    if (!multicastAddress) throw errMissingArgs("multicastAddress");
    return undefined;
  }

  dropMembership(multicastAddress, _multicastInterface) {
    healthCheck(this);
    if (!multicastAddress) throw errMissingArgs("multicastAddress");
    return undefined;
  }

  addSourceSpecificMembership(sourceAddress, groupAddress, _interfaceAddress) {
    healthCheck(this);
    validateString(sourceAddress, "sourceAddress");
    validateString(groupAddress, "groupAddress");
    return undefined;
  }

  dropSourceSpecificMembership(sourceAddress, groupAddress, _interfaceAddress) {
    healthCheck(this);
    validateString(sourceAddress, "sourceAddress");
    validateString(groupAddress, "groupAddress");
    return undefined;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  setRecvBufferSize(size) {
    // Mirrors bufferSize(): `size >>> 0 !== size` -> ERR_SOCKET_BAD_BUFFER_SIZE.
    if (size >>> 0 !== size) throw errSocketBadBufferSize();
    return undefined;
  }

  setSendBufferSize(size) {
    if (size >>> 0 !== size) throw errSocketBadBufferSize();
    return undefined;
  }

  getRecvBufferSize() {
    // No real receive buffer exists — 0, not a fabricated size.
    return 0;
  }

  getSendBufferSize() {
    return 0;
  }

  getSendQueueSize() {
    return 0;
  }

  getSendQueueCount() {
    return 0;
  }
}

export function createSocket(type, listener) {
  return new Socket(type, listener);
}

// Node also exports the deprecated private `_createSocketHandle` (DEP0112)
export function _createSocketHandle(..._ignored) {
  // Impossible in a browser: no native UDP handle exists, so return an
  // honest noop stub (never throw).
  const noop = () => {};
  return {
    bind: noop, close: noop, send: noop,
    recvStart: noop, recvStop: noop,
    ref() { return this; },
    unref() { return this; },
  };
}

// Note: Node also exports the deprecated `_handle`/`_receiving`/`_bindState`/
// `_queue`/`_reuseAddr`/`_healthCheck()`/`_stopReceiving()` accessors on
// Socket instances. They are intentionally omitted: they expose the native
// handle, which cannot exist in a browser.

export default {
  Socket,
  createSocket,
};
