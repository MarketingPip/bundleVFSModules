// src/net.js — Port of Node.js v24.20.0 `lib/net.js` for the browser runtime.
//
// Dependency-free ESM. Pure parts (isIP/isIPv4/isIPv6, SocketAddress,
// BlockList, autoSelectFamily) are faithful ports of Node's algorithms.
// Transport parts (Socket/Server) run over a *virtual* in-process network
// because browsers cannot open raw TCP sockets:
//
//   * `net.createServer()` + `server.listen(port)` registers the server in a
//     module-local virtual registry (one registry per JS realm / sandbox).
//   * `net.connect(port[, host])` / `socket.connect()` looks the registry up
//     and, on a hit, pairs the client socket with a server-side socket as a
//     full-duplex in-memory pipe: writes on one side become 'data' on the
//     other, `end()` delivers a clean FIN, `destroy()` delivers EOF.
//   * On a miss the client fails exactly like Node does against a closed
//     port: async `error` with code `ECONNREFUSED`, then `close` with
//     `hadError === true`. Hostnames that are not IP literals and not
//     `localhost` cannot be DNS-resolved by a dependency-free browser shim,
//     so they fail async with `ENOTFOUND` (same shape as Node's getaddrinfo
//     failure).
//   * Host-runtime bridge: if `globalThis._RUNTIME_.__netConnectHook` is a
//     function, `connect()` offers it `{ host, port, path, socket }` first;
//     returning `true` means the hook drives the socket (emits
//     connect/error/close itself). This is the seam where Jared's runtime
//     can plug emulated/host networking later.
//
// What is deliberately NOT real: actual TCP to remote hosts, UNIX-domain
// sockets on disk, `fd`/`handle` adoption of OS handles (accepted and
// ignored), SO_KEEPALIVE/TCP_NODELAY socket options (accepted, stored,
// no-op). Per repo convention these are honest noops, never throws.
//
// The `_RUNTIME_` contract: `globalThis._RUNTIME_` (never bare), guarded for
// standalone use. No `window`/`document` at module scope. No
// `process.getBuiltinModule` anywhere in this file — the browser-fallback
// lane must work with native builtins disabled.

import { Duplex } from './stream.js';
import { EventEmitter } from './events.js';
import { undestroy as undestroyStream } from './stream/destroy.js';

// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
const RT = (typeof globalThis._RUNTIME_ !== 'undefined')
  ? globalThis._RUNTIME_
  : undefined;

// Buffer when available (Node global, or installed by RUNTIME_NODE_GLOBALS in
// the sandbox). Used so 'data' chunks are real Buffers like Node's net.
const BufferCtor = typeof globalThis.Buffer === 'function' ? globalThis.Buffer : undefined;

// process.nextTick where it exists, microtask fallback elsewhere.
const nextTick = (typeof process === 'object' && process !== null &&
  typeof process.nextTick === 'function')
  ? process.nextTick.bind(process)
  : (typeof queueMicrotask === 'function'
    ? queueMicrotask
    : (fn, ...args) => setTimeout(() => fn(...args), 0));

// Macrotask deferral (setImmediate where available). Virtual connects use
// this — not nextTick — so a virtual handshake takes event-loop turns like
// a real TCP handshake, and listeners attached after an `await` still catch
// 'connect'.
const defer = (typeof setImmediate === 'function')
  ? setImmediate
  : (fn, ...args) => setTimeout(() => fn(...args), 0);

// ---------------------------------------------------------------------------
// Error factories (mirror Node's internal/errors messages for net's codes).
// ---------------------------------------------------------------------------

function fmtReceived(value) {
  if (value === undefined) return 'Received undefined';
  if (value === null) return 'Received null';
  const t = typeof value;
  if (t === 'string') return `Received type string ('${value}')`;
  if (t === 'number' || t === 'boolean' || t === 'bigint') {
    return `Received type ${t} (${String(value)})`;
  }
  let name = null;
  try { name = value.constructor && value.constructor.name; } catch { /* ignore */ }
  if (name && name !== 'Object') return `Received an instance of ${name}`;
  // Node's determineSpecificType reports plain objects as "an instance of Object".
  return 'Received an instance of Object';
}

function fmtValue(value) {
  if (typeof value === 'string') return `'${value}'`;
  return String(value);
}

function errInvalidArgType(name, expected, actual) {
  const exp = Array.isArray(expected) ? expected.join(' or ') : expected;
  const e = new TypeError(`The "${name}" argument must be of type ${exp}. ${fmtReceived(actual)}`);
  e.code = 'ERR_INVALID_ARG_TYPE';
  return e;
}

function errInvalidArgValue(name, value, reason = 'is invalid') {
  const what = name.includes('.') ? 'property' : 'argument';
  const shown = value instanceof SocketAddress
    ? `SocketAddress { address: '${value.address}', port: ${value.port}, ` +
      `family: '${value.family}', flowlabel: ${value.flowlabel} }`
    : fmtValue(value);
  const e = new TypeError(`The ${what} '${name}' ${reason}. Received ${shown}`);
  e.code = 'ERR_INVALID_ARG_VALUE';
  return e;
}

function errOutOfRange(name, range, value) {
  const e = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${fmtValue(value)}`);
  e.code = 'ERR_OUT_OF_RANGE';
  return e;
}

function errSocketBadPort(name, value) {
  // Node: validatePort — message uses the *original* value and its type,
  // with a trailing period after the received part.
  const e = new RangeError(`${name} should be >= 0 and < 65536. ${fmtReceived(value)}.`);
  e.code = 'ERR_SOCKET_BAD_PORT';
  return e;
}

function errMissingArgs() {
  const e = new TypeError('The "options" or "port" or "path" argument must be specified');
  e.code = 'ERR_MISSING_ARGS';
  return e;
}

function errServerAlreadyListening() {
  const e = new Error('Listen method has been called more than once without closing.');
  e.code = 'ERR_SERVER_ALREADY_LISTEN';
  return e;
}

function errServerNotRunning() {
  const e = new Error('Server is not running.');
  e.code = 'ERR_SERVER_NOT_RUNNING';
  return e;
}

function errIpBlocked(address) {
  const e = new Error(`IP(${address}) is blocked by net.BlockList`);
  e.code = 'ERR_IP_BLOCKED';
  return e;
}

function errInvalidAddress() {
  const e = new Error('Invalid socket address');
  e.code = 'ERR_INVALID_ADDRESS';
  return e;
}

// errno-style errors (shapes mirror libuv failures in real Node).
function errnoError(code, syscall, message, fields) {
  const e = new Error(message);
  e.code = code;
  e.syscall = syscall;
  Object.assign(e, fields);
  return e;
}
function errConnRefused(address, port) {
  return errnoError('ECONNREFUSED', 'connect',
    `connect ECONNREFUSED ${address}:${port}`, { errno: -111, address, port });
}
function errConnRefusedBare() {
  // Node's connection failure without an IP literal host (the DNS /
  // autoSelectFamily path): a bare ECONNREFUSED with an empty message.
  return errnoError('ECONNREFUSED', undefined, '', { errno: -111 });
}
function errConnRefusedPipe(path) {
  // Matches Node: connecting to a missing pipe surfaces ENOENT.
  return errnoError('ENOENT', 'connect', `connect ENOENT ${path}`, { errno: -2, path });
}
function errConnReset() {
  return errnoError('ECONNRESET', 'read', 'read ECONNRESET', { errno: -104 });
}
function errNotFound(host) {
  return errnoError('ENOTFOUND', 'getaddrinfo',
    `getaddrinfo ENOTFOUND ${host}`, { errno: -3008, hostname: host });
}
function errAddrInUse(address, port) {
  return errnoError('EADDRINUSE', 'listen',
    `listen EADDRINUSE: address already in use ${address}:${port}`,
    { errno: -98, address, port });
}

// ---------------------------------------------------------------------------
// Validators (mirror internal/validators messages used by net).
// ---------------------------------------------------------------------------

function validateObject(value, name) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw errInvalidArgType(name, 'object', value);
  }
}
function validateString(value, name) {
  if (typeof value !== 'string') throw errInvalidArgType(name, 'string', value);
}
function validateNumber(value, name) {
  if (typeof value !== 'number') throw errInvalidArgType(name, 'number', value);
}
function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw errInvalidArgType(name, 'boolean', value);
}
function validateFunction(value, name) {
  if (typeof value !== 'function') throw errInvalidArgType(name, 'function', value);
}
function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== 'number') throw errInvalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw errOutOfRange(name, 'an integer', value);
  if (value < min || value > max) {
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
  }
  return value | 0;
}
function validateUint32(value, name, positive = false) {
  if (typeof value !== 'number') throw errInvalidArgType(name, 'number', value);
  if (!Number.isInteger(value)) throw errOutOfRange(name, 'an integer', value);
  const min = positive ? 1 : 0;
  const max = 4294967295;
  if (value < min || value > max) {
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
  }
  return value >>> 0;
}
// Node's validatePort: numeric strings coerce; blank strings and non-numbers
// throw, and the error always reports the *original* value.
function validatePort(port, name = 'Port', allowZero = true) {
  const original = port;
  if (typeof port === 'string') {
    if (port.trim().length === 0) throw errSocketBadPort(name, original);
    port = Number(port);
  }
  if (typeof port !== 'number' || !Number.isInteger(port) ||
      port < 0 || port > 65535 || (port === 0 && !allowZero)) {
    throw errSocketBadPort(name, original);
  }
  return port | 0;
}

// Node's toNumber: (x = Number(x)) >= 0 ? x : false.
function toNumberStrict(x) {
  const n = Number(x);
  return n >= 0 ? n : false;
}
function isPipeName(s) {
  return typeof s === 'string' && toNumberStrict(s) === false;
}

// ---------------------------------------------------------------------------
// isIP / isIPv4 / isIPv6 — exact port of lib/internal/net.js regexes.
// ---------------------------------------------------------------------------

const v4Seg = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
const IPv4Reg = new RegExp(`^${v4Str}$`);

const v6Seg = '(?:[0-9a-fA-F]{1,4})';
const IPv6Reg = new RegExp('^(?:' +
  `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
  `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
  `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
  `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
  `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
  `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
  `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
  `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
  ')(?:%[0-9a-zA-Z-.:]{1,})?$');

function isIPv4(s) {
  return IPv4Reg.test(s);
}
function isIPv6(s) {
  return IPv6Reg.test(s);
}
function isIP(s) {
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return 0;
}
function isLoopbackName(host) {
  return typeof host === 'string' && host.toLowerCase() === 'localhost';
}

// ---------------------------------------------------------------------------
// Numeric IP helpers (for BlockList / SocketAddress, pure).
// ---------------------------------------------------------------------------

function parseIPv4(s) {
  if (!isIPv4(s)) return null;
  const p = s.split('.');
  return (((+p[0]) * 16777216 + (+p[1]) * 65536 + (+p[2]) * 256 + (+p[3])) >>> 0);
}
function ipv4ToString(n) {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}
function stripZoneId(s) {
  const i = s.indexOf('%');
  return i === -1 ? s : s.slice(0, i);
}
// Assumes isIPv6(s). Returns the 128-bit value as a BigInt.
function parseIPv6(s) {
  s = stripZoneId(s);
  const halves = s.split('::');
  const headParts = halves[0] ? halves[0].split(':') : [];
  const tailParts = halves.length > 1 ? (halves[1] ? halves[1].split(':') : []) : [];
  const head = [];
  const tail = [];
  const push = (into, g) => {
    if (g.includes('.')) {
      const v4 = parseIPv4(g);
      into.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
    } else {
      into.push(parseInt(g, 16));
    }
  };
  headParts.forEach((g) => push(head, g));
  tailParts.forEach((g) => push(tail, g));
  const missing = 8 - head.length - tail.length;
  const groups = [...head, ...new Array(missing).fill(0), ...tail];
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}
// Canonical compressed text form (RFC 5952 style: longest zero run -> '::').
function ipv6ToString(n) {
  const groups = [];
  for (let i = 0; i < 8; i++) groups.unshift(Number((n >> BigInt(i * 16)) & 0xffffn));
  const hex = groups.map((g) => g.toString(16));
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (curStart === -1) { curStart = i; curLen = 1; } else { curLen++; }
    } else {
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}
function addressToNumber(address, family) {
  return family === 'ipv4' ? BigInt(parseIPv4(address)) : parseIPv6(address);
}
function numberToAddress(n, family) {
  return family === 'ipv4' ? ipv4ToString(Number(n)) : ipv6ToString(n);
}

// ---------------------------------------------------------------------------
// SocketAddress — port of internal/socketaddress.js.
// ---------------------------------------------------------------------------

function SocketAddress(options = {}) {
  validateObject(options, 'options');
  // NB: the address default is computed from the *raw* family value, before
  // lower-casing — mirroring internal/socketaddress.js exactly (so e.g.
  // { family: 'IPV4' } defaults address to '::' and then fails validation).
  let { family = 'ipv4' } = options;
  const {
    address = (family === 'ipv4' ? '127.0.0.1' : '::'),
    port = 0,
    flowlabel = 0,
  } = options;

  if (typeof family?.toLowerCase === 'function') family = family.toLowerCase();
  let fam;
  switch (family) {
    case 'ipv4': fam = 'ipv4'; break;
    case 'ipv6': fam = 'ipv6'; break;
    default:
      throw errInvalidArgValue('options.family', options.family);
  }
  validateString(address, 'options.address');
  const validPort = validatePort(port, 'options.port');
  validateUint32(flowlabel, 'options.flowlabel');

  const kind = isIP(address);
  if (kind !== 4 && kind !== 6) throw errInvalidAddress();
  if ((fam === 'ipv4') !== (kind === 4)) throw errInvalidAddress();

  this._address = numberToAddress(addressToNumber(address, fam), fam);
  this._family = fam;
  this._port = validPort;
  this._flowlabel = fam === 'ipv6' ? flowlabel : 0;
  Object.freeze(this);
}
Object.defineProperties(SocketAddress.prototype, {
  address: { get() { return this._address; }, enumerable: true, configurable: true },
  port: { get() { return this._port; }, enumerable: true, configurable: true },
  family: { get() { return this._family; }, enumerable: true, configurable: true },
  flowlabel: { get() { return this._flowlabel; }, enumerable: true, configurable: true },
  constructor: { value: SocketAddress, writable: true, configurable: true },
});
SocketAddress.prototype.toJSON = function toJSON() {
  return {
    address: this.address,
    port: this.port,
    family: this.family,
    flowlabel: this.flowlabel,
  };
};

// ---------------------------------------------------------------------------
// BlockList — port of internal/blocklist.js.
// ---------------------------------------------------------------------------

function BlockList() {
  this._rules = [];
}
function blockListRuleType(family) {
  return family === 'ipv6' ? 'IPv6' : 'IPv4';
}
// Mirrors internal/blocklist.js: the add* methods normalize through
// SocketAddress (accepting SocketAddress instances directly).
function blockListToSocketAddress(value, name, family) {
  if (value instanceof SocketAddress) return value;
  validateString(value, name);
  validateString(family, 'family');
  return new SocketAddress({ address: value, family });
}
BlockList.prototype.addAddress = function addAddress(address, family = 'ipv4') {
  const sa = blockListToSocketAddress(address, 'address', family);
  const fam = sa.family;
  const start = addressToNumber(sa.address, fam);
  this._rules.unshift({
    type: 'address', family: fam, start, end: start,
    toString: () => `Address: ${blockListRuleType(fam)} ${numberToAddress(start, fam)}`,
  });
};
BlockList.prototype.addRange = function addRange(start, end, family = 'ipv4') {
  const startAddr = blockListToSocketAddress(start, 'start', family);
  const endAddr = blockListToSocketAddress(end, 'end', family);
  if (startAddr.family !== endAddr.family) throw errInvalidAddress();
  const fam = startAddr.family;
  const s = addressToNumber(startAddr.address, fam);
  const e = addressToNumber(endAddr.address, fam);
  if (s > e) throw errInvalidArgValue('start', startAddr, 'must come before end');
  this._rules.unshift({
    type: 'range', family: fam, start: s, end: e,
    toString: () => `Range: ${blockListRuleType(fam)} ${numberToAddress(s, fam)}-${numberToAddress(e, fam)}`,
  });
};
BlockList.prototype.addSubnet = function addSubnet(network, prefix, family = 'ipv4') {
  const netAddr = blockListToSocketAddress(network, 'network', family);
  const fam = netAddr.family;
  const maxPrefix = fam === 'ipv4' ? 32 : 128;
  const pfx = validateInt32(prefix, 'prefix', 0, maxPrefix);
  const bits = fam === 'ipv4' ? 32n : 128n;
  const n = addressToNumber(netAddr.address, fam);
  const mask = pfx === 0 ? 0n : (((1n << BigInt(pfx)) - 1n) << (bits - BigInt(pfx)));
  const start = n & mask;
  const end = start | (((1n << bits) - 1n) ^ mask);
  this._rules.unshift({
    type: 'subnet', family: fam, start, end,
    toString: () => `Subnet: ${blockListRuleType(fam)} ${numberToAddress(start, fam)}/${pfx}`,
  });
};
BlockList.prototype.check = function check(address, family = 'ipv4') {
  let addr = address;
  if (!(addr instanceof SocketAddress)) {
    validateString(address, 'address');
    validateString(family, 'family');
    try {
      addr = new SocketAddress({ address, family });
    } catch {
      // Ignore the error. If it's not a valid address, return false.
      return false;
    }
  }
  const fam = addr.family;
  const n = addressToNumber(addr.address, fam);
  return this._rules.some((rule) =>
    rule.family === fam && n >= rule.start && n <= rule.end);
};
Object.defineProperty(BlockList.prototype, 'rules', {
  get() { return this._rules.map((r) => r.toString()); },
  enumerable: true,
  configurable: true,
});
BlockList.prototype.toJSON = function toJSON() {
  return this.rules;
};
BlockList.prototype.fromJSON = function fromJSON(json) {
  // Mirrors internal/blocklist.js: data is a JSON string or an array of
  // rule strings ("Address: IPv4 1.2.3.4", ...), parsed back into rules.
  let data = json;
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry !== 'string') {
        throw errInvalidArgType('data', ['string', 'string[]'], data);
      }
    }
  } else if (typeof data !== 'string') {
    throw errInvalidArgType('data', ['string', 'string[]'], data);
  } else {
    data = JSON.parse(data);
    if (!Array.isArray(data)) {
      throw errInvalidArgType('data', ['string', 'string[]'], data);
    }
    for (const entry of data) {
      if (typeof entry !== 'string') {
        throw errInvalidArgType('data', ['string', 'string[]'], data);
      }
    }
  }
  this._parseIPInfo(data);
};
BlockList.prototype._parseIPInfo = function _parseIPInfo(data) {
  for (const item of data) {
    if (item.includes('IPv4')) {
      const subnetMatch = item.match(
        /Subnet: IPv4 (\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})/,
      );
      if (subnetMatch) {
        this.addSubnet(subnetMatch[1], parseInt(subnetMatch[2], 10));
        continue;
      }
      const addressMatch = item.match(/Address: IPv4 (\d{1,3}(?:\.\d{1,3}){3})/);
      if (addressMatch) {
        this.addAddress(addressMatch[1]);
        continue;
      }
      const rangeMatch = item.match(
        /Range: IPv4 (\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})/,
      );
      if (rangeMatch) {
        this.addRange(rangeMatch[1], rangeMatch[2]);
        continue;
      }
    }
    if (item.includes('IPv6')) {
      const ipv6SubnetMatch = item.match(
        /Subnet: IPv6 ([0-9a-fA-F:]{1,39})\/([0-9]{1,3})/i,
      );
      if (ipv6SubnetMatch) {
        this.addSubnet(ipv6SubnetMatch[1], parseInt(ipv6SubnetMatch[2], 10), 'ipv6');
        continue;
      }
      const ipv6AddressMatch = item.match(/Address: IPv6 ([0-9a-fA-F:]{1,39})/i);
      if (ipv6AddressMatch) {
        this.addAddress(ipv6AddressMatch[1], 'ipv6');
        continue;
      }
      const ipv6RangeMatch = item.match(/Range: IPv6 ([0-9a-fA-F:]{1,39})-([0-9a-fA-F:]{1,39})/i);
      if (ipv6RangeMatch) {
        this.addRange(ipv6RangeMatch[1], ipv6RangeMatch[2], 'ipv6');
        continue;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Default auto-select-family knobs — mirrors lib/net.js.
// ---------------------------------------------------------------------------

let defaultAutoSelectFamily = true;
let defaultAutoSelectFamilyAttemptTimeout = 250;

function getDefaultAutoSelectFamily() {
  return defaultAutoSelectFamily;
}
function setDefaultAutoSelectFamily(value) {
  validateBoolean(value, 'value');
  defaultAutoSelectFamily = value;
}
function getDefaultAutoSelectFamilyAttemptTimeout() {
  return defaultAutoSelectFamilyAttemptTimeout;
}
function setDefaultAutoSelectFamilyAttemptTimeout(value) {
  validateInt32(value, 'value', 1);
  if (value < 10) value = 10;
  defaultAutoSelectFamilyAttemptTimeout = value;
}

// ---------------------------------------------------------------------------
// Virtual network registry.
//
// Browsers cannot open raw TCP sockets, so this shim runs an in-process
// virtual network: servers register (host, port) or pipe names; clients
// connect to a registered endpoint and get paired with a server-side socket
// as a full-duplex in-memory pipe. One registry per JS realm, so loopback
// works within a sandbox the way Node loopback works on a machine.
// ---------------------------------------------------------------------------

const tcpServers = new Map();   // "<host>:<port>" -> Server
const pipeServers = new Map();  // path -> Server

function serverKey(host, port) {
  return `${host}:${port}`;
}

// Ephemeral port pool for both listen(0) and client-side local ports,
// kept out of the real ephemeral range to avoid confusion.
let nextEphemeral = 40000;
function allocPort() {
  for (let i = 0; i < 20000; i++) {
    const p = nextEphemeral;
    nextEphemeral = nextEphemeral >= 59999 ? 40000 : nextEphemeral + 1;
    return p;
  }
  return nextEphemeral++;
}

function toBytes(chunk, encoding) {
  if (typeof chunk === 'string') {
    if (BufferCtor) return BufferCtor.from(chunk, encoding || 'utf8');
    return new TextEncoder().encode(chunk);
  }
  return chunk;
}
function byteLengthOf(chunk) {
  if (typeof chunk === 'string') {
    if (BufferCtor) return BufferCtor.byteLength(chunk);
    return new TextEncoder().encode(chunk).length;
  }
  return chunk ? chunk.length : 0;
}

// ---------------------------------------------------------------------------
// Socket — port of the virtual-transport half of lib/net.js Socket.
// Extends our own ./stream.js Duplex (NOT stream-browserify).
// ---------------------------------------------------------------------------

function Socket(options = {}) {
  if (!(this instanceof Socket)) return new Socket(options);
  if (options !== null && typeof options !== 'object') {
    throw errInvalidArgType('options', 'object', options);
  }
  options = { ...options };

  if (options.objectMode || options.readableObjectMode || options.writableObjectMode) {
    throw errInvalidArgValue('options', options, 'objectMode is not supported');
  }

  this.connecting = false;
  this._hadError = false;
  this._parent = null;
  this._host = null;
  this._sockname = null;
  this._peername = null;
  this._peer = null;
  this._connected = false;
  this._pendingWrites = [];
  this._finSent = false;
  this._bytesRead = 0;
  this._bytesWritten = 0;
  this._idleTimer = null;
  this._noDelay = false;
  this._keepAlive = false;
  this._keepAliveInitialDelay = 0;
  this._localPortEphemeral = 0;
  // Event-loop keep-alive: a real open socket holds the Node loop (unless
  // unref'd). The virtual socket does the same with a long, harmless timer
  // so parity tests don't see the process exit mid-connection.
  this._loopTimer = null;
  this._socketUnrefed = false;
  // Set when the peer's FIN arrives (readable EOF). Together with a ended
  // writable side this means the virtual transport can no longer move any
  // bytes — mirroring libuv, where a TCP handle with shut-down write side
  // and EOF'd read side goes inactive and stops keeping the loop alive.
  this._eofReceived = false;
  // Mirrors libuv: the virtual read watcher only activates once the stream
  // starts reading (_read invoked). A socket that never started reading
  // (e.g. paused before connect) has an inactive handle and does not keep
  // the event loop alive — lib/net.js skips its post-connect read(0) when
  // paused.
  this._readStarted = false;

  // Default to *not* allowing half open sockets (lib/net.js).
  options.allowHalfOpen = Boolean(options.allowHalfOpen);

  Duplex.call(this, {
    ...options,
    emitClose: false,   // Socket owns 'close' emission (Node: close(hadError))
    decodeStrings: false,
    autoDestroy: true,
    onwrite: (stream, er) => onwrite(stream, er),
  });

  // Shut down the writable side when the readable side ends, unless the
  // socket (or server) allows half-open connections (lib/net.js).
  this.on('end', onReadableStreamEnd);

  // Adopt a pre-bound BoundSocket as the local endpoint (virtual).
  if (options.handle instanceof BoundSocket) {
    const addr = options.handle.address();
    if (addr && typeof addr.port === 'number') {
      this._sockname = { address: addr.address, family: addr.family, port: addr.port };
    }
  }

  if (options.timeout) this.setTimeout(options.timeout);
}
Object.setPrototypeOf(Socket.prototype, Duplex.prototype);
Socket.prototype.constructor = Socket;
// The virtual transport has no OS handle; expose _handle as null like a
// closed real socket does (tests assert `socket._handle === null`).
Socket.prototype._handle = null;

function onwrite(stream, er) {
  // Mirrors lib/net.js onwrite: sync-flush state, then the stream continues.
  if (stream._connecting) return;
}

// Called when the 'end' event is emitted.
function onReadableStreamEnd() {
  if (!this.allowHalfOpen) {
    this.write = writeAfterFIN;
  }
}

function writeAfterFIN(chunk, encoding, cb) {
  if (!this.writableEnded) {
    return Duplex.prototype.write.call(this, chunk, encoding, cb);
  }

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  const er = new Error('This socket has been ended by the other party');
  er.code = 'EPIPE';
  if (typeof cb === 'function') {
    nextTick(cb, er);
  }
  this.destroy(er);
  return false;
}

// --- State ---------------------------------------------------------------

Object.defineProperties(Socket.prototype, {
  pending: {
    get() { return !this._connected || this.connecting; },
    enumerable: true, configurable: true,
  },
  readyState: {
    get() {
      if (this.connecting) return 'opening';
      if (this.readable && this.writable) return 'open';
      if (this.readable && !this.writable) return 'readOnly';
      if (!this.readable && this.writable) return 'writeOnly';
      return 'closed';
    },
    enumerable: true, configurable: true,
  },
  bytesRead: {
    get() { return this._bytesRead; },
    enumerable: true, configurable: true,
  },
  bytesWritten: {
    get() { return this._bytesWritten; },
    enumerable: true, configurable: true,
  },
  bufferSize: {
    get() { return this._connected ? this.writableLength : undefined; },
    enumerable: true, configurable: true,
  },
  localAddress: {
    get() { return this._sockname ? this._sockname.address : undefined; },
    enumerable: true, configurable: true,
  },
  localPort: {
    get() { return this._sockname ? this._sockname.port : undefined; },
    enumerable: true, configurable: true,
  },
  localFamily: {
    get() { return this._sockname ? this._sockname.family : undefined; },
    enumerable: true, configurable: true,
  },
  remoteAddress: {
    get() { return this._peername ? this._peername.address : undefined; },
    enumerable: true, configurable: true,
  },
  remotePort: {
    get() { return this._peername ? this._peername.port : undefined; },
    enumerable: true, configurable: true,
  },
  remoteFamily: {
    get() { return this._peername ? this._peername.family : undefined; },
    enumerable: true, configurable: true,
  },
});

Socket.prototype.address = function address() {
  if (!this._connected || !this._sockname) return {};
  const { address, family, port } = this._sockname;
  return { address, family, port };
};

Socket.prototype.ref = function ref() {
  this._socketUnrefed = false;
  if (this._loopTimer !== null && typeof this._loopTimer.ref === 'function') {
    try { this._loopTimer.ref(); } catch { /* ignore */ }
  }
  return this;
};
Socket.prototype.unref = function unref() {
  this._socketUnrefed = true;
  if (this._loopTimer !== null && typeof this._loopTimer.unref === 'function') {
    try { this._loopTimer.unref(); } catch { /* ignore */ }
  }
  return this;
};

// A connecting/connected socket keeps the event loop alive, like a real
// socket handle does. Released on destroy, when the transport goes
// inactive, or when reading never started (inactive handle).
Socket.prototype._needsLoopKeeper = function _needsLoopKeeper() {
  if (this.destroyed) return false;
  if (this._isTransportInactive()) return false;
  if (this.connecting) return true;
  if (this._pendingWrites !== null && this._pendingWrites.length > 0) return true;
  if (!this._readStarted) return false;
  return true;
};
Socket.prototype._keepLoopAlive = function _keepLoopAlive() {
  if (this._loopTimer !== null || this.destroyed) return;
  if (!this._needsLoopKeeper()) return;
  this._loopTimer = setInterval(() => {}, 3600000);
  if (this._socketUnrefed) this.unref();
};
Socket.prototype._refreshLoopKeeper = function _refreshLoopKeeper() {
  if (this._needsLoopKeeper()) this._keepLoopAlive();
  else this._releaseLoop();
};
Socket.prototype._releaseLoop = function _releaseLoop() {
  if (this._loopTimer !== null) {
    clearInterval(this._loopTimer);
    this._loopTimer = null;
  }
};
// True when the virtual transport is dead: the peer sent FIN (readable EOF),
// our writable side ended, nothing is still being written, and we are not
// mid-connect. The JS Socket object may outlive this (paused with buffered
// data, 'end' never emitted) exactly like a real half-closed TCP handle —
// and like that handle, it must not keep the event loop alive.
Socket.prototype._isTransportInactive = function _isTransportInactive() {
  if (this.destroyed || this.connecting) return false;
  if (!this._eofReceived || !this.writableEnded) return false;
  if (this._pendingWrites !== null && this._pendingWrites.length > 0) return false;
  return true;
};
Socket.prototype._maybeReleaseLoop = function _maybeReleaseLoop() {
  if (this._isTransportInactive()) this._releaseLoop();
};

// --- Timers --------------------------------------------------------------

Socket.prototype._clearIdleTimer = function _clearIdleTimer() {
  if (this._idleTimer !== null) {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }
};
Socket.prototype._refreshTimeout = function _refreshTimeout() {
  this._clearIdleTimer();
  if (this.timeout > 0 && !this.destroyed) {
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this.emit('timeout');
    }, this.timeout);
    // Matches Node: the socket idle timer is unref'd.
    if (this._idleTimer && typeof this._idleTimer.unref === 'function') {
      try { this._idleTimer.unref(); } catch { /* ignore */ }
    }
  }
};
// setStreamTimeout port: no-op on destroyed sockets; `timeout` is stored
// before validation; setTimeout(0, cb) removes that timeout listener.
Socket.prototype.setTimeout = function setTimeout(msecs, callback) {
  if (this.destroyed) return this;
  this.timeout = msecs;
  validateNumber(msecs, 'msecs');
  if (!(msecs >= 0) || !Number.isFinite(msecs)) {
    throw errOutOfRange('msecs', 'a non-negative finite number', msecs);
  }
  this._clearIdleTimer();
  if (msecs === 0) {
    if (callback !== undefined) {
      validateFunction(callback, 'callback');
      this.removeListener('timeout', callback);
    }
  } else {
    this._refreshTimeout();
    if (callback !== undefined) {
      validateFunction(callback, 'callback');
      this.once('timeout', callback);
    }
  }
  return this;
};

Socket.prototype.setNoDelay = function setNoDelay(enable) {
  // Backwards compatibility: assume true when `enable` is omitted.
  enable = Boolean(enable === undefined ? true : enable);
  this._noDelay = enable;
  return this;
};

Socket.prototype.setKeepAlive = function setKeepAlive(enable, initialDelayMsecs = 0) {
  this._keepAlive = Boolean(enable);
  this._keepAliveInitialDelay = initialDelayMsecs;
  return this;
};

// --- Connection setup ----------------------------------------------------

// _normalizeArgs port (also exported for compat).
const normalizedArgsSymbol = Symbol('normalizedArgs');
function _normalizeArgs(args) {
  let options;
  if (args.length === 0) return [{}, null];
  const arg0 = args[0];
  let cb = null;
  if (typeof args[args.length - 1] === 'function') {
    cb = args[args.length - 1];
    args = args.slice(0, -1);
  }
  if (typeof arg0 === 'number' || typeof arg0 === 'string') {
    if (isPipeName(arg0)) {
      options = { path: arg0 };
    } else {
      options = { port: arg0 };
      if (args.length > 1 && typeof args[1] === 'string') options.host = args[1];
    }
  } else {
    validateObject(arg0, 'options');
    options = { ...arg0 };
  }
  options = { ...options };
  return [options, cb];
}
function normalizeArgs(args) {
  if (Array.isArray(args) && args[normalizedArgsSymbol]) return args;
  const normalized = _normalizeArgs(args);
  Object.defineProperty(normalized, normalizedArgsSymbol, { value: true });
  return normalized;
}

Socket.prototype.connect = function connect(...args) {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  const cb = normalized[1];

  if (cb !== null) this.once('connect', cb);

  if (options.port === undefined && options.path == null) throw errMissingArgs();

  if (this.write !== Socket.prototype.write) {
    // If the user has overwritten .write, reset it so connect() works.
    this.write = Socket.prototype.write;
  }

  if (this.destroyed) {
    undestroyStream.call(this);
    this._connected = false;
    this._hadError = false;
  }

  this._sockname = null;
  this._peername = null;
  this._peer = null;
  this._pendingWrites = [];
  this._finSent = false;
  this._localPortEphemeral = 0;

  const path = options.path;
  const pipe = !!path;
  if (pipe) {
    validateString(path, 'options.path');
  } else {
    validatePort(options.port, 'Port');
  }

  // Host-runtime hook: Jared's runtime can take over connect() with
  // emulated/host networking. Returning true means the hook drives this
  // socket from here (it will emit connect/error/close itself).
  if (RT && typeof RT.__netConnectHook === 'function') {
    let handled = false;
    try {
      handled = RT.__netConnectHook({
        host: options.host, port: options.port, path: options.path, socket: this,
      }) === true;
    } catch { /* hook failures never break virtual connect */ }
    if (handled) return this;
  }

  // AbortSignal option (mirrors connect() honoring options.signal).
  if (options.signal !== undefined && options.signal !== null) {
    const signal = options.signal;
    if (typeof signal !== 'object' || typeof signal.addEventListener !== 'function' ||
        typeof signal.aborted !== 'boolean') {
      throw errInvalidArgType('options.signal', 'AbortSignal', signal);
    }
    if (signal.aborted) {
      nextTick(() => this.destroy(signal.reason));
      return this;
    }
    signal.addEventListener('abort', () => this.destroy(signal.reason), { once: true });
  }

  this.connecting = true;
  this._refreshTimeout();
  this._keepLoopAlive();
  // Deferred to a macrotask: a virtual handshake takes event-loop turns like
  // real TCP, so handlers attached after an `await` still catch 'connect'.
  defer(() => this._doConnect(options, pipe));
  return this;
};

Socket.prototype._connectFailed = function _connectFailed(err) {
  if (this.destroyed) return;
  this.connecting = false;
  this._clearIdleTimer();
  this.destroy(err);
};

// Error for a refused/over-capacity/blocked connection attempt, mirroring
// the client-side selection in _doConnect.
Socket.prototype._refusedError = function _refusedError(req) {
  if (req.pipe) return errConnRefusedPipe(req.path);
  return isIP(this._host) !== 0
    ? errConnRefused(req.address, req.port)
    : errConnRefusedBare();
};

Socket.prototype._doConnect = function _doConnect(options, pipe) {
  if (this.destroyed || !this.connecting) return;

  const host = options.host === undefined ? 'localhost' : options.host;

  let address;
  let family;
  let port = 0;
  if (pipe) {
    address = options.path;
  } else {
    port = options.port | 0;
    if (isIP(host)) {
      address = host;
      family = isIPv4(host) ? 'IPv4' : 'IPv6';
    } else if (isLoopbackName(host)) {
      address = '127.0.0.1';
      family = 'IPv4';
    } else {
      // No DNS resolver in a dependency-free browser shim.
      defer(() => this._connectFailed(errNotFound(host)));
      return;
    }
  }

  this.emit('connectionAttempt', address, port, family === 'IPv6' ? 6 : family === 'IPv4' ? 4 : undefined);

  // Client-side blockList check (mirrors lookupAndConnect).
  if (this.blockList && !pipe) {
    let blocked = false;
    try {
      blocked = this.blockList.check(address, `ipv${family === 'IPv6' ? 6 : 4}`);
    } catch { blocked = false; }
    if (blocked) {
      defer(() => this._connectFailed(errIpBlocked(address)));
      return;
    }
  }

  this._host = host;

  let server = null;
  if (pipe) {
    server = pipeServers.get(options.path);
    if (!server) {
      defer(() => this._connectFailed(errConnRefusedPipe(options.path)));
      return;
    }
  } else {
    const keys = [];
    const ipLiteral = isIP(host) !== 0;
    if (ipLiteral) keys.push(serverKey(host, port));
    else keys.push(serverKey('127.0.0.1', port));
    // A server bound to the wildcard also accepts loopback connections.
    keys.push(serverKey('::', port));
    keys.push(serverKey('0.0.0.0', port));
    for (const key of keys) {
      server = tcpServers.get(key);
      if (server) break;
    }
    if (!server) {
      // Matches Node: IP-literal hosts get a detailed ECONNREFUSED; anything
      // else (DNS path) surfaces a bare ECONNREFUSED with an empty message.
      const err = ipLiteral ? errConnRefused(address, port) : errConnRefusedBare();
      defer(() => this._connectFailed(err));
      return;
    }
  }

  const req = { address, family, port, pipe, path: options.path };
  // One more event-loop turn before the handshake completes, like a real
  // TCP handshake: handlers attached after an `await` still catch 'connect'.
  defer(() => {
    if (this.destroyed || !this.connecting) return;
    server._acceptConnection(this, req);
  });
};

// --- Virtual data path ---------------------------------------------------

Socket.prototype._read = function _read(_size) {
  // Push-driven; data arrives via _receiveFromPeer. Mark the read watcher
  // active (mirrors libuv readStart) so the loop keeper engages.
  this._readStarted = true;
  this._keepLoopAlive();
};

Socket.prototype._write = function _write(chunk, encoding, cb) {
  const peer = this._peer;
  if (!this._connected || !peer || peer.destroyed) {
    if (this.connecting) {
      // Buffer until the connection completes, like Node's write queue.
      this._pendingWrites.push({ chunk, encoding, cb });
      return;
    }
    const er = this.destroyed
      ? errnoError('ERR_STREAM_DESTROYED', 'write', 'Cannot call write after a stream was destroyed')
      : new Error('Socket is not connected');
    if (!this.destroyed) this.destroy(er);
    cb(er);
    return;
  }
  this._deliverToPeer(chunk, encoding, cb);
};

Socket.prototype._deliverToPeer = function _deliverToPeer(chunk, encoding, cb) {
  const peer = this._peer;
  const buf = toBytes(chunk, encoding);
  this._bytesWritten += buf ? buf.length : 0;
  this._refreshTimeout();
  if (peer && !peer.destroyed) peer._receiveFromPeer(buf);
  cb();
};

Socket.prototype._flushPendingWrites = function _flushPendingWrites() {
  const pending = this._pendingWrites;
  this._pendingWrites = [];
  for (const item of pending) this._deliverToPeer(item.chunk, item.encoding, item.cb);
};

Socket.prototype._receiveFromPeer = function _receiveFromPeer(buf) {
  if (this.destroyed) return;
  this._bytesRead += buf ? buf.length : 0;
  this._refreshTimeout();
  this.push(buf);
};

Socket.prototype._receiveEOF = function _receiveEOF() {
  if (this.destroyed) return;
  this._eofReceived = true;
  // Mirrors onStreamRead's EOF path: push(null) then read(0) so 'end' is
  // emitted even when the socket is paused.
  this.push(null);
  this.read(0);
  this._maybeReleaseLoop();
};

// _final port: end() half-closes; the peer sees a clean FIN ('end').
// The FIN is delivered on a later tick — on a real network FIN and data
// race, so a write the peer queued in its own 'connect' handler still lands.
// The link stays up: the peer may still write back (TCP half-close), and
// its own end() delivers the return FIN.
Socket.prototype._final = function _final(cb) {
  if (this.connecting) {
    this.once('connect', () => this._final(cb));
    return;
  }
  const peer = this._peer;
  this._finSent = true;
  if (peer && !peer.destroyed) {
    nextTick(() => {
      if (!peer.destroyed) peer._receiveEOF();
    });
  }
  cb();
  // The writable side is now ended; if the peer already sent FIN, the
  // transport is dead and must not keep the loop alive.
  this._maybeReleaseLoop();
};

// _destroy port: Socket owns 'close' emission so the event carries the
// Node-style hadError boolean (the stream port emits close() with no args,
// so emitClose is disabled and the socket emits 'close' itself after the
// machinery's async 'error' emission is queued — error always first).
Socket.prototype._destroy = function _destroy(exception, cb) {
  const hadError = exception !== undefined && exception !== null;
  this.connecting = false;
  this._clearIdleTimer();
  this._releaseLoop();

  const peer = this._peer;
  this._peer = null;
  this._connected = false;
  this._pendingWrites = [];

  // Virtual graceful close: the surviving peer sees EOF ('end'), exactly
  // like Node delivering a FIN when the remote destroys its socket. (When
  // this destroy was caused by _final, _finSent is already true and the FIN
  // path above owns the notification.) Delivery is deferred a tick because
  // a real network never signals the peer synchronously. The peer's link is
  // torn down — this socket is gone, so further peer writes fail.
  if (peer && !peer.destroyed && !this._finSent) {
    nextTick(() => {
      if (peer.destroyed) return;
      if (peer._peer === this) peer._peer = null;
      peer._receiveEOF();
    });
  }

  cb(exception);
  // Queued *after* the machinery's own nextTick (which emits 'error' for
  // exception), so 'error' always precedes 'close' in both Node and
  // browser microtask orderings.
  nextTick(() => this.emit('close', hadError));

  // Mirrors lib/net.js: a server-owned socket releases the server's
  // connection count (and possibly its 'close') from _destroy.
  if (this._server) {
    this._server._connections--;
    if (this._server._emitCloseIfDrained) this._server._emitCloseIfDrained();
  }
};

// Abortive close: the peer sees ECONNRESET instead of a graceful FIN.
Socket.prototype.resetAndDestroy = function resetAndDestroy(err) {
  const peer = this._peer;
  this._peer = null;
  this._connected = false;
  if (peer && !peer.destroyed) {
    nextTick(() => {
      if (peer.destroyed) return;
      if (peer._peer === this) peer._peer = null;
      peer._connected = false;
      peer.destroy(errConnReset());
    });
  }
  return this.destroy(err);
};

// ---------------------------------------------------------------------------
// Server — port of the virtual-transport half of lib/net.js Server.
// ---------------------------------------------------------------------------

function Server(options, connectionListener) {
  if (!(this instanceof Server)) return new Server(options, connectionListener);

  if (typeof options === 'function') {
    connectionListener = options;
    options = {};
    this.on('connection', connectionListener);
  } else if (options == null || typeof options === 'object') {
    options = { ...options };
    if (typeof connectionListener === 'function') {
      this.on('connection', connectionListener);
    }
  } else {
    throw errInvalidArgType('options', 'object', options);
  }

  if (options.keepAliveInitialDelay !== undefined) {
    validateNumber(options.keepAliveInitialDelay, 'options.keepAliveInitialDelay');
    if (options.keepAliveInitialDelay < 0) options.keepAliveInitialDelay = 0;
  }
  if (options.highWaterMark !== undefined) {
    validateNumber(options.highWaterMark, 'options.highWaterMark');
    if (options.highWaterMark < 0) options.highWaterMark = 16384;
  }

  // ./events.js EventEmitter is a class; construct it via Reflect and continue
  // initializing the returned instance (prototype is Server.prototype).
  const self = Reflect.construct(EventEmitter, [], Server);

  self._connections = 0;
  self._listening = false;
  self._bindPending = false;
  self._bindAddress = null;
  self._pipeName = null;
  self._unref = false;
  self._backlog = undefined;
  self._loopTimer = null;

  self.allowHalfOpen = options.allowHalfOpen || false;
  self.pauseOnConnect = !!options.pauseOnConnect;
  self.noDelay = Boolean(options.noDelay);
  self.keepAlive = Boolean(options.keepAlive);
  self.keepAliveInitialDelay = ~~(options.keepAliveInitialDelay / 1000);
  self.highWaterMark = options.highWaterMark ?? 16384;

  if (options.blockList) {
    if (!(options.blockList instanceof BlockList)) {
      throw errInvalidArgType('options.blockList', 'net.BlockList', options.blockList);
    }
    self.blockList = options.blockList;
  }

  if (typeof options === 'function') {
    self.on('connection', connectionListener);
  } else if (typeof connectionListener === 'function') {
    self.on('connection', connectionListener);
  }

  return self;
}
Object.setPrototypeOf(Server.prototype, EventEmitter.prototype);
Server.prototype.constructor = Server;

Object.defineProperty(Server.prototype, 'listening', {
  get() { return this._listening; },
  enumerable: true,
  configurable: true,
});

Server.prototype.ref = function ref() {
  this._unref = false;
  if (this._loopTimer !== null && typeof this._loopTimer.ref === 'function') {
    try { this._loopTimer.ref(); } catch { /* ignore */ }
  }
  return this;
};
Server.prototype.unref = function unref() {
  this._unref = true;
  if (this._loopTimer !== null && typeof this._loopTimer.unref === 'function') {
    try { this._loopTimer.unref(); } catch { /* ignore */ }
  }
  return this;
};

// A listening server keeps the event loop alive like a real bind handle.
// Released once the server fully closes.
Server.prototype._keepLoopAlive = function _keepLoopAlive() {
  if (this._loopTimer !== null) return;
  this._loopTimer = setInterval(() => {}, 3600000);
  if (this._unref) this.unref();
};
Server.prototype._releaseLoop = function _releaseLoop() {
  if (this._loopTimer !== null) {
    clearInterval(this._loopTimer);
    this._loopTimer = null;
  }
};

// Adopts a BoundSocket as this server's listen endpoint (virtual).
Server.prototype._adoptBoundSocket = function _adoptBoundSocket(bound) {
  const addr = bound.address();
  if (addr && typeof addr.path === 'string') {
    this._bindPending = true;
    nextTick(() => this._doListenPipe(addr.path));
  } else {
    this._bindPending = true;
    nextTick(() => this._doListenTCP(addr.port, addr.address));
  }
};

Server.prototype.listen = function listen(...args) {
  if (args.length > 0 && args[0] instanceof BoundSocket) {
    if (this._listening || this._bindPending) throw errServerAlreadyListening();
    const cb = typeof args[1] === 'function' ? args[1] : null;
    if (cb !== null) this.once('listening', cb);
    this._adoptBoundSocket(args[0]);
    return this;
  }

  const normalized = normalizeArgs(args);
  let options = normalized[0];
  const cb = normalized[1];

  if (this._listening || this._bindPending) throw errServerAlreadyListening();
  if (cb !== null) this.once('listening', cb);

  const backlog = toNumber(args.length > 1 && args[1]) ||
    toNumber(args.length > 2 && args[2]) || options.backlog;

  options = { ...options };
  if (args.length === 0 || typeof args[0] === 'function' ||
      (options.port === undefined && 'port' in options) || options.port === null) {
    options.port = 0;
  }

  if (typeof options.port === 'number' || typeof options.port === 'string') {
    const port = validatePort(options.port, 'options.port');
    const host = options.host;
    this._bindPending = true;
    nextTick(() => this._doListenTCP(port, host, backlog));
    return this;
  }

  if (options.path && typeof options.path === 'string') {
    validateString(options.path, 'options.path');
    this._bindPending = true;
    nextTick(() => this._doListenPipe(options.path, backlog));
    return this;
  }

  if (!(('port' in options) || ('path' in options))) {
    throw errInvalidArgValue('options', options, 'must have the property "port" or "path"');
  }
  throw errInvalidArgValue('options', options);
};

function toNumber(value) {
  if (value === false || value === undefined || value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

Server.prototype._doListenTCP = function _doListenTCP(port, host, backlog) {
  if (!this._bindPending) return;
  let bindHost;
  let family;
  if (host === undefined || host === null) {
    bindHost = '::';
    family = 'IPv6';
  } else if (isIP(host)) {
    bindHost = host;
    family = isIPv4(host) ? 'IPv4' : 'IPv6';
  } else if (isLoopbackName(host)) {
    bindHost = '127.0.0.1';
    family = 'IPv4';
  } else {
    this._bindPending = false;
    nextTick(() => this.emit('error', errNotFound(host)));
    return;
  }

  const actualPort = port === 0 ? allocPort() : port;
  const key = serverKey(bindHost, actualPort);
  if (tcpServers.has(key)) {
    this._bindPending = false;
    nextTick(() => this.emit('error', errAddrInUse(bindHost, actualPort)));
    return;
  }

  tcpServers.set(key, this);
  this._bindPending = false;
  this._listening = true;
  this._backlog = backlog;
  this._bindAddress = { address: bindHost, family, port: actualPort };
  this._keepLoopAlive();
  this.emit('listening');
};

Server.prototype._doListenPipe = function _doListenPipe(path, backlog) {
  if (!this._bindPending) return;
  if (pipeServers.has(path)) {
    this._bindPending = false;
    nextTick(() => this.emit('error',
      errnoError('EADDRINUSE', 'listen',
        `listen EADDRINUSE: address already in use ${path}`, { errno: -98, path })));
    return;
  }
  pipeServers.set(path, this);
  this._bindPending = false;
  this._listening = true;
  this._backlog = backlog;
  this._pipeName = path;
  this._bindAddress = { address: path };
  this._keepLoopAlive();
  this.emit('listening');
};

Server.prototype.address = function address() {
  if (this._pipeName) return this._pipeName;
  if (!this._listening || !this._bindAddress) return null;
  const { address, family, port } = this._bindAddress;
  return { address, family, port };
};

// Pairs an incoming client with a server-side Socket (virtual accept).
Server.prototype._acceptConnection = function _acceptConnection(client, req) {
  const bindAddr = this._bindAddress;

  // Server-side blockList: silently refused, like Node closing clientHandle.
  if (this.blockList) {
    let blocked = false;
    try { blocked = this.blockList.check('127.0.0.1', 'ipv4'); } catch { blocked = false; }
    if (blocked) {
      client._connectFailed(client._refusedError(req));
      return;
    }
  }

  if (this.maxConnections != null && this._connections >= this.maxConnections) {
    const data = {
      localAddress: bindAddr ? bindAddr.address : undefined,
      localPort: bindAddr ? bindAddr.port : undefined,
      localFamily: bindAddr ? bindAddr.family : undefined,
      remoteAddress: '127.0.0.1',
      remotePort: client._localPortEphemeral || undefined,
      remoteFamily: 'IPv4',
    };
    this.emit('drop', data);
    client._connectFailed(client._refusedError(req));
    return;
  }

  const serverSocket = new Socket({
    allowHalfOpen: this.allowHalfOpen,
    readableHighWaterMark: this.highWaterMark,
    writableHighWaterMark: this.highWaterMark,
  });
  if (this.pauseOnConnect) serverSocket.pause();
  serverSocket.setNoDelay(this.noDelay);
  if (this.keepAlive) serverSocket.setKeepAlive(true, this.keepAliveInitialDelay * 1000);

  const clientPort = allocPort();
  client._localPortEphemeral = clientPort;

  if (req.pipe) {
    client._sockname = { address: req.path };
    client._peername = { address: req.path };
    serverSocket._sockname = { address: req.path };
    serverSocket._peername = { address: req.path };
  } else {
    client._sockname = { address: '127.0.0.1', family: 'IPv4', port: clientPort };
    client._peername = {
      address: bindAddr.address, family: bindAddr.family, port: bindAddr.port,
    };
    serverSocket._sockname = {
      address: bindAddr.address, family: bindAddr.family, port: bindAddr.port,
    };
    serverSocket._peername = { address: '127.0.0.1', family: 'IPv4', port: clientPort };
  }

  client._peer = serverSocket;
  serverSocket._peer = client;
  client._connected = true;
  serverSocket._connected = true;
  serverSocket._server = this;
  serverSocket.server = this;
  serverSocket._keepLoopAlive();

  this._connections++;

  this.emit('connection', serverSocket);

  client.connecting = false;
  client._flushPendingWrites();
  client._refreshTimeout();
  client.emit('connect');
  // Mirrors lib/net.js: start the first read after connect, unless paused.
  // A paused socket never activates its read watcher (inactive handle).
  if (client.readable && !client.isPaused()) {
    client._readStarted = true;
  }
  client._refreshLoopKeeper();
};

Server.prototype._emitCloseIfDrained = function _emitCloseIfDrained() {
  if (this._listening || this._bindPending || this._connections > 0) return;
  this._releaseLoop();
  nextTick(() => this.emit('close'));
};

Server.prototype.close = function close(cb) {
  if (typeof cb === 'function') {
    if (!this._listening && !this._bindPending) {
      // Never listening: 'close' still fires; the callback gets
      // ERR_SERVER_NOT_RUNNING (mirrors lib/net.js).
      this.once('close', () => cb(errServerNotRunning()));
    } else {
      this.once('close', cb);
    }
  }

  if (this._listening || this._bindPending) {
    if (this._bindAddress) {
      if (this._pipeName) pipeServers.delete(this._pipeName);
      else tcpServers.delete(serverKey(this._bindAddress.address, this._bindAddress.port));
    }
    this._listening = false;
    this._bindPending = false;
    this._bindAddress = null;
    this._pipeName = null;
    // The listening handle is gone: like real net, the server no longer
    // keeps the loop alive. Outstanding connections keep their own
    // keep-alive; 'close' still waits for them via _emitCloseIfDrained.
    this._releaseLoop();
  }

  this._emitCloseIfDrained();
  return this;
};

Server.prototype[Symbol.asyncDispose] = async function asyncDispose() {
  if (!this._listening) return;
  await new Promise((resolve) => this.close(resolve));
};

Server.prototype.getConnections = function getConnections(cb) {
  if (typeof cb !== 'function') throw errInvalidArgType('cb', 'function', cb);
  nextTick(() => cb(null, this._connections));
  return this;
};

// ---------------------------------------------------------------------------
// connect / createConnection / createServer.
// ---------------------------------------------------------------------------

function connect(...args) {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  const socket = new Socket(options);
  if (options.timeout) socket.setTimeout(options.timeout);
  return socket.connect(normalized[0], normalized[1]);
}
const createConnection = connect;

function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}

// ---------------------------------------------------------------------------
// BoundSocket — virtual pre-bound endpoint (v24 export).
//
// In Node this wraps an OS socket handle bound to a port/path. Here it is a
// validated descriptor: `server.listen(boundSocket)` adopts its address, and
// `new Socket({ handle: boundSocket })` uses it as the local endpoint.
// ---------------------------------------------------------------------------

function BoundSocket(options = {}) {
  validateObject(options, 'options');
  if (options.path !== undefined) {
    validateString(options.path, 'options.path');
    this._path = options.path;
    this._address = { address: options.path };
    return;
  }
  const port = validatePort(options.port ?? 0, 'options.port');
  const ipv6Only = options.ipv6Only ?? false;
  validateBoolean(ipv6Only, 'options.ipv6Only');
  const reusePort = options.reusePort ?? false;
  validateBoolean(reusePort, 'options.reusePort');
  const host = options.host ?? '::';
  let address;
  let family;
  if (isIP(host)) {
    address = host;
    family = isIPv4(host) ? 'IPv4' : 'IPv6';
  } else if (isLoopbackName(host)) {
    address = '127.0.0.1';
    family = 'IPv4';
  } else {
    throw errNotFound(host);
  }
  this._port = port;
  this._host = address;
  this._ipv6Only = ipv6Only;
  this._reusePort = reusePort;
  this._address = { address, family, port };
}
BoundSocket.prototype.address = function address() {
  if (this._path !== undefined) return { address: this._path };
  const { address, family, port } = this._address;
  return { address, family, port };
};
BoundSocket.prototype.close = function close() {
  // Virtual endpoint descriptors hold no OS resources.
  return undefined;
};

// _createServerHandle — compat export; returns a virtual bound endpoint.
function _createServerHandle(...args) {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  if (options.path) return new BoundSocket({ path: options.path });
  return new BoundSocket({ port: options.port ?? 0, host: options.host, ipv6Only: !!options.ipv6Only });
}

// ---------------------------------------------------------------------------
// Exports.
// ---------------------------------------------------------------------------

const Stream = Socket;

export {
  BlockList,
  BoundSocket,
  Server,
  Socket,
  SocketAddress,
  Stream,
  _createServerHandle,
  _normalizeArgs,
  connect,
  createConnection,
  createServer,
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  isIP,
  isIPv4,
  isIPv6,
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
};

// Default export: the Node-style namespace object, so
// `import net from '../src/net.js'` works like `require('node:net')`.
export default {
  BlockList,
  BoundSocket,
  Server,
  Socket,
  SocketAddress,
  Stream,
  _createServerHandle,
  _normalizeArgs,
  connect,
  createConnection,
  createServer,
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  isIP,
  isIPv4,
  isIPv6,
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
};
