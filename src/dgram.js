'use strict';

// ---------------------------------------------------------------------------
// Browser-compatible internal module shims
// ---------------------------------------------------------------------------

const {
  FunctionPrototypeBind,
  Symbol: PrimordialSymbol,
} = globalThis.primordials || {
  FunctionPrototypeBind: Function.prototype.bind,
  Symbol,
};



const { codes: {
  ERR_SOCKET_BAD_TYPE,
} } = (() => {
  class ERR_SOCKET_BAD_TYPE extends Error {
    constructor() {
      super('Bad socket type specified. Valid types are: udp4, udp6');
      this.code = 'ERR_SOCKET_BAD_TYPE';
    }
  }
  return { codes: { ERR_SOCKET_BAD_TYPE } };
})();

const { UV_EINVAL } = (() => ({ UV_EINVAL: -22 }))();

const { guessHandleType } = (() => {
  function guessHandleType(fd) {
    return 'UNKNOWN';
  }
  return { guessHandleType };
})();

const {
  isInt32,
  validateFunction,
} = (() => {
  function isInt32(value) {
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
  }
  function validateFunction(value, name) {
    if (typeof value !== 'function') {
      throw new TypeError(`The "${name}" argument must be of type function. Received type ${typeof value}`);
    }
  }
  return { isInt32, validateFunction };
})();

// ---------------------------------------------------------------------------
// internalBinding('udp_wrap') — Browser UDP Handle
// ---------------------------------------------------------------------------

const { UDP } = (() => {
  class UDP {
    constructor() {
      this._transport = null;
      this._writer = null;
      this._reader = null;
      this._connected = false;
      this._connecting = false;
      this._sendQueue = [];
      this._address = '0.0.0.0';
      this._port = 0;
      this._family = 'IPv4';
      this._recvBufferSize = 0;
      this._sendBufferSize = 0;
      this._ttl = 128;
      this._multicastTTL = 1;
      this._loopback = false;
      this._broadcast = false;
      this.lookup = null;
      // Callbacks installed by the public dgram module
      this.onmessage = null; // function(buffer, {address, port, family})
      this.onclose = null;   // function()
    }

    open(fd) {
      // File descriptors do not exist in browser environments
      return UV_EINVAL;
    }

    bind(ip, port, flags) {
      // True OS-level binding is impossible. We store the endpoint metadata
      // so that address() and the public API behave consistently.
      this._address = ip || '0.0.0.0';
      this._port = port || 0;
      return 0;
    }

    bind6(ip, port, flags) {
      this._family = 'IPv6';
      return this.bind(ip, port, flags);
    }

    connect(ip, port) {
      if (this._connected || this._connecting) return UV_EINVAL;
      if (typeof WebTransport === 'undefined') return UV_EINVAL;

      this._connecting = true;
      // WebTransport requires an HTTPS URL. This is the fundamental deviation
      // from raw UDP — we can only talk to an HTTP/3 server, not arbitrary
      // UDP endpoints.
      const url = `https://${ip}:${port}`;
      this._doConnect(url);
      return 0;
    }

    connect6(ip, port) {
      this._family = 'IPv6';
      return this.connect(ip, port);
    }

    async _doConnect(url) {
      try {
        this._transport = new WebTransport(url);
        await this._transport.ready;
        this._writer = this._transport.datagrams.writable.getWriter();
        this._reader = this._transport.datagrams.readable.getReader();
        this._connected = true;
        this._connecting = false;
        this._flushSendQueue();
        this._startReadLoop();
      } catch (e) {
        this._connecting = false;
        this._connected = false;
        // In a complete implementation the public socket would emit('error', e)
      }
    }

    // Node's handle API: returns 0 immediately, signals async completion via
    // req.oncomplete(err, bytesSent).
    send(req, data, length, port, ip, hasCallback) {
      if (!this._connected) {
        if (!this._connecting) {
          if (hasCallback && req.oncomplete) {
            queueMicrotask(() => req.oncomplete(UV_EINVAL));
          }
          return UV_EINVAL;
        }
        // Defer until WebTransport handshake finishes
        this._sendQueue.push({ req, data, length, hasCallback });
        return 0;
      }

      const chunk = data.slice(0, length);
      this._writer.write(chunk).then(() => {
        if (hasCallback && req.oncomplete) req.oncomplete(0, chunk.length);
      }).catch(() => {
        if (hasCallback && req.oncomplete) req.oncomplete(UV_EINVAL);
      });
      return 0;
    }

    send6(req, data, length, port, ip, hasCallback) {
      return this.send(req, data, length, port, ip, hasCallback);
    }

    _flushSendQueue() {
      while (this._sendQueue.length > 0) {
        const { req, data, length, hasCallback } = this._sendQueue.shift();
        this.send(req, data, length, 0, '', hasCallback);
      }
    }

    async _startReadLoop() {
      try {
        while (this._connected) {
          const { value, done } = await this._reader.read();
          if (done) break;
          if (this.onmessage) {
            // WebTransport does not expose a remote address per datagram.
            // We report the bound local metadata so the public API shape
            // remains intact, but this is NOT the packet's real sender.
            this.onmessage(value, {
              address: this._address,
              port: this._port,
              family: this._family,
            });
          }
        }
      } catch (e) {
        // Loop terminates on close() or transport error
      }
    }

    recvStart() {
      // In Node this arms the libuv read watcher. In the browser the read
      // loop is implicitly started once the transport connects.
      return 0;
    }

    recvStop() {
      // Cannot pause without destroying the reader, so this is a no-op.
      return 0;
    }

    close() {
      this._connected = false;
      if (this._reader) {
        this._reader.cancel().catch(() => {});
      }
      if (this._writer) {
        this._writer.close().catch(() => {});
      }
      if (this._transport) {
        this._transport.close();
      }
      if (this.onclose) this.onclose();
      return 0;
    }

    getsockname(out) {
      out.address = this._address;
      out.port = this._port;
      out.family = this._family;
      return 0;
    }

    addMembership(multicastAddress, interfaceAddress) {
      return UV_EINVAL;
    }

    dropMembership(multicastAddress, interfaceAddress) {
      return UV_EINVAL;
    }

    setMulticastInterface(interfaceAddress) {
      return UV_EINVAL;
    }

    setTTL(ttl) {
      this._ttl = ttl;
      return 0; // Browser does not expose IP_TTL
    }

    setMulticastTTL(ttl) {
      return UV_EINVAL;
    }

    setBroadcast(flag) {
      return UV_EINVAL;
    }

    setMulticastLoopback(flag) {
      return UV_EINVAL;
    }

    ref() {
      return this;
    }

    unref() {
      return this;
    }

    setRecvBufferSize(size) {
      this._recvBufferSize = size;
      return 0;
    }

    setSendBufferSize(size) {
      this._sendBufferSize = size;
      return 0;
    }

    getRecvBufferSize() {
      return this._recvBufferSize;
    }

    getSendBufferSize() {
      return this._sendBufferSize;
    }
  }

  return { UDP };
})();

// ---------------------------------------------------------------------------
// Node.js internal/dgram logic (preserved structurally)
// ---------------------------------------------------------------------------

const kStateSymbol = PrimordialSymbol('state symbol');
let dns;  // Lazy load for startup performance.

function lookup4(lookup, address, callback) {
  return lookup(address || '127.0.0.1', 4, callback);
}

function lookup6(lookup, address, callback) {
  return lookup(address || '::1', 6, callback);
}

function newHandle(type, lookup) {
  if (lookup === undefined) {
    if (dns === undefined) {
      // Browsers cannot perform raw DNS lookups. We provide a minimal shim
      // that resolves IP literals and fails on real hostnames.
      dns = {
        lookup: (hostname, options, callback) => {
          if (typeof options === 'function') {
            callback = options;
            options = {};
          }
          const ipv4Re = /^(?:\d{1,3}\.){3}\d{1,3}$/;
          const ipv6Re = /^(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}$/;

          if (ipv4Re.test(hostname)) {
            callback(null, hostname, 4);
            return;
          }
          if (ipv6Re.test(hostname)) {
            callback(null, hostname, 6);
            return;
          }
          const err = new Error(
            `Browser dgram shim cannot resolve hostnames via DNS. ` +
            `Provide an IP address or supply a custom lookup function.`
          );
          err.code = 'ENOTFOUND';
          err.hostname = hostname;
          callback(err, hostname, 4);
        }
      };
    }
    lookup = dns.lookup;
  } else {
    validateFunction(lookup, 'lookup');
  }

  if (type === 'udp4') {
    const handle = new UDP();
    handle.lookup = FunctionPrototypeBind(lookup4, handle, lookup);
    return handle;
  }

  if (type === 'udp6') {
    const handle = new UDP();
    handle.lookup = FunctionPrototypeBind(lookup6, handle, lookup);
    handle.bind = handle.bind6;
    handle.connect = handle.connect6;
    handle.send = handle.send6;
    return handle;
  }

  throw new ERR_SOCKET_BAD_TYPE();
}

function _createSocketHandle(address, port, addressType, fd, flags) {
  const handle = newHandle(addressType);
  let err;

  if (isInt32(fd) && fd > 0) {
    const type = guessHandleType(fd);
    if (type !== 'UDP') {
      err = UV_EINVAL;
    } else {
      err = handle.open(fd);
    }
  } else if (port || address) {
    err = handle.bind(address, port || 0, flags);
  }

  if (err) {
    handle.close();
    return err;
  }

  return handle;
}

export {
  kStateSymbol,
  _createSocketHandle,
  newHandle,
};

export default {
  kStateSymbol,
  _createSocketHandle,
  newHandle,
};
