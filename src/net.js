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

import { Duplex } from "./stream.js";
import { EventEmitter } from "./events.js";
import { undestroy as undestroyStream } from "./stream/destroy.js";
import { constants as osConstants } from "./os.js";
// ponytail: node:fs is imported ONLY for existsSync on pipe-bind parent
// dirs (BoundSocket EACCES case). In the parity harness this resolves to
// real fs, so the check sees the real tmpdir; in the browser build esbuild
// externalizes node: builtins (same precedent as src/url.js importing
// node:path), so the sandbox resolves it to the memfs-backed shim fs and
// the check runs against the visible virtual filesystem. No other fs API
// is used here — the virtual transport never reads real disk.
import { existsSync as fsExistsSync } from "node:fs";

// 1. Runtime bridge (guarded: rewritten to the sandbox scope at load time,
//    undefined under real Node / direct import).
const RT =
  typeof globalThis._RUNTIME_ !== "undefined"
    ? globalThis._RUNTIME_
    : undefined;

// Buffer when available (Node global, or installed by RUNTIME_NODE_GLOBALS in
// the sandbox). Used so 'data' chunks are real Buffers like Node's net.
const BufferCtor =
  typeof globalThis.Buffer === "function" ? globalThis.Buffer : undefined;

// process.nextTick where it exists, microtask fallback elsewhere.
const nextTick =
  typeof process === "object" &&
  process !== null &&
  typeof process.nextTick === "function"
    ? process.nextTick.bind(process)
    : typeof queueMicrotask === "function"
      ? queueMicrotask
      : (fn, ...args) => setTimeout(() => fn(...args), 0);

// Macrotask deferral (setImmediate where available). Virtual connects use
// this — not nextTick — so a virtual handshake takes event-loop turns like
// a real TCP handshake, and listeners attached after an `await` still catch
// 'connect'.
const defer =
  typeof setImmediate === "function"
    ? setImmediate
    : (fn, ...args) => setTimeout(() => fn(...args), 0);

// Pending virtual accepts, drained as one batch. Real Node's kernel
// completes a burst of handshakes in parallel, so all of the burst's
// connections are accepted before any request handler runs. A per-socket
// defer interleaved a full round trip (microtask drain) between accepts,
// so the Nth connect of a burst could land after the server's close()
// in an earlier handler (test-https-agent-sni: the 5th of 5 parallel
// connects was refused). Batching keeps the one-extra-turn handshake —
// the drain still runs on a macrotask — and preserves the per-client
// destroyed/connecting guard, just evaluated at drain time. The
// server-side accept is what batches: each client's 'connect' tail still
// fires on its own macrotask (first item synchronously in the drain), so
// a microtask can run between two clients' 'connect' events and a
// listener registered while awaiting the first never misses the second
// (tests/net.test.js getConnections).
const _pendingAccepts = [];
let _acceptDrainScheduled = false;
function queueAccept(server, client, req) {
  _pendingAccepts.push({ server, client, req });
  if (_acceptDrainScheduled) return;
  _acceptDrainScheduled = true;
  defer(() => {
    _acceptDrainScheduled = false;
    const batch = _pendingAccepts.splice(0, _pendingAccepts.length);
    for (let i = 0; i < batch.length; i++) {
      const { server: s, client: c, req: r } = batch[i];
      if (c.destroyed || !c.connecting) continue;
      // The first accept connects synchronously (single-connect timing
      // unchanged); later ones defer the client 'connect' tail, so a
      // microtask can run between two clients' 'connect' events — while
      // every server-side accept in the batch completes here, before any
      // request handler runs (test-https-agent-sni).
      s._acceptConnection(c, r, i !== 0);
    }
  });
}

// ---------------------------------------------------------------------------
// Error factories (mirror Node's internal/errors messages for net's codes).
// ---------------------------------------------------------------------------

function fmtReceived(value) {
  if (value === undefined) return "Received undefined";
  if (value === null) return "Received null";
  const t = typeof value;
  if (t === "string") return `Received type string ('${value}')`;
  if (t === "number" || t === "boolean" || t === "bigint") {
    return `Received type ${t} (${String(value)})`;
  }
  let name = null;
  try {
    name = value.constructor && value.constructor.name;
  } catch {
    /* ignore */
  }
  if (name && name !== "Object") return `Received an instance of ${name}`;
  // Node's determineSpecificType reports plain objects as "an instance of Object".
  return "Received an instance of Object";
}

function fmtValue(value) {
  if (typeof value === "string") return `'${value}'`;
  return String(value);
}

function errInvalidArgType(name, expected, actual) {
  const exp = Array.isArray(expected) ? expected.join(" or ") : expected;
  const e = new TypeError(
    `The "${name}" argument must be of type ${exp}. ${fmtReceived(actual)}`,
  );
  e.code = "ERR_INVALID_ARG_TYPE";
  return e;
}

function errInvalidArgValue(name, value, reason = "is invalid") {
  const what = name.includes(".") ? "property" : "argument";
  const shown =
    value instanceof SocketAddress
      ? `SocketAddress { address: '${value.address}', port: ${value.port}, ` +
        `family: '${value.family}', flowlabel: ${value.flowlabel} }`
      : fmtValue(value);
  const e = new TypeError(`The ${what} '${name}' ${reason}. Received ${shown}`);
  e.code = "ERR_INVALID_ARG_VALUE";
  return e;
}

function errOutOfRange(name, range, value) {
  const e = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${fmtValue(value)}`,
  );
  e.code = "ERR_OUT_OF_RANGE";
  return e;
}

function errSocketBadPort(name, value) {
  // Node: validatePort — message uses the *original* value and its type,
  // with a trailing period after the received part.
  const e = new RangeError(
    `${name} should be >= 0 and < 65536. ${fmtReceived(value)}.`,
  );
  e.code = "ERR_SOCKET_BAD_PORT";
  return e;
}

function errMissingArgs() {
  const e = new TypeError(
    'The "options" or "port" or "path" argument must be specified',
  );
  e.code = "ERR_MISSING_ARGS";
  return e;
}

function errServerAlreadyListening() {
  const e = new Error(
    "Listen method has been called more than once without closing.",
  );
  e.code = "ERR_SERVER_ALREADY_LISTEN";
  return e;
}

function errServerNotRunning() {
  const e = new Error("Server is not running.");
  e.code = "ERR_SERVER_NOT_RUNNING";
  return e;
}

function errSocketHandleAdopted() {
  // Node lib/internal/errors.js: 'The bound socket has already been adopted
  // by a server or socket'.
  const e = new Error(
    "The bound socket has already been adopted by a server or socket",
  );
  e.code = "ERR_SOCKET_HANDLE_ADOPTED";
  return e;
}

function errIpBlocked(address) {
  const e = new Error(`IP(${address}) is blocked by net.BlockList`);
  e.code = "ERR_IP_BLOCKED";
  return e;
}

function errInvalidAddress() {
  const e = new Error("Invalid socket address");
  e.code = "ERR_INVALID_ADDRESS";
  return e;
}

function errInvalidIpAddress(address) {
  // Node lib/net.js lookupAndConnect: `Invalid IP address: <address>`.
  const e = new TypeError(`Invalid IP address: ${address}`);
  e.code = "ERR_INVALID_IP_ADDRESS";
  return e;
}

function errInvalidAddressFamily(addressType, host, port) {
  // Node lib/internal/errors.js:1385 (RangeError, host/port fields).
  const e = new RangeError(
    `Invalid address family: ${addressType} ${host}:${port}`,
  );
  e.code = "ERR_INVALID_ADDRESS_FAMILY";
  e.host = host;
  e.port = port;
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
  return errnoError(
    "ECONNREFUSED",
    "connect",
    `connect ECONNREFUSED ${address}:${port}`,
    { errno: -111, address, port },
  );
}

// libuv errno -> name, via the canonical os.constants.errno table (Linux
// values: ENETUNREACH 101, ECONNREFUSED 111, ...). NOTE: util's
// getSystemErrorName is NOT used here — its systemErrorMap is shifted by 7
// in the network range (-101 reads ESHUTDOWN there), so it would report the
// wrong code for connect errnos. Lazily built once; first name wins on
// duplicate values (EAGAIN before EWOULDBLOCK), matching Node.
let _errnoNameByValue = null;
function errnoNameForUv(errno) {
  if (_errnoNameByValue === null) {
    _errnoNameByValue = new Map();
    for (const [name, value] of Object.entries(osConstants.errno)) {
      if (!_errnoNameByValue.has(value)) _errnoNameByValue.set(value, name);
    }
  }
  return _errnoNameByValue.get(-errno);
}

// Mirrors Node lib/net.js internalConnect + ExceptionWithHostPort: a libuv
// errno from _handle.connect becomes `connect <CODE> <address>:<port>`.
function errConnectErrno(errno, address, port) {
  const code = errnoNameForUv(errno) ?? `Unknown system error ${errno}`;
  return errnoError(code, "connect", `connect ${code} ${address}:${port}`, {
    errno,
    address,
    port,
  });
}

// Normalizes a fake _handle.connect return / oncomplete status to an Error:
// a negative libuv errno maps to its code; anything else passes through
// (a real libuv handle only ever returns a negative errno or 0).
function connectFailureToError(err, address, port) {
  if (typeof err === "number" && err < 0) {
    return errConnectErrno(err, address, port);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}
function errConnRefusedBare() {
  // Node's connection failure without an IP literal host (the DNS /
  // autoSelectFamily path): a bare ECONNREFUSED with an empty message.
  return errnoError("ECONNREFUSED", undefined, "", { errno: -111 });
}
function errConnRefusedPipe(path) {
  // Matches Node: connecting to a missing pipe surfaces ENOENT.
  return errnoError("ENOENT", "connect", `connect ENOENT ${path}`, {
    errno: -2,
    path,
  });
}
function errConnReset() {
  return errnoError("ECONNRESET", "read", "read ECONNRESET", { errno: -104 });
}
function errNotFound(host) {
  return errnoError(
    "ENOTFOUND",
    "getaddrinfo",
    `getaddrinfo ENOTFOUND ${host}`,
    { errno: -3008, hostname: host },
  );
}
function errAddrInUse(address, port) {
  return errnoError(
    "EADDRINUSE",
    "listen",
    `listen EADDRINUSE: address already in use ${address}:${port}`,
    { errno: -98, address, port },
  );
}

// ---------------------------------------------------------------------------
// Validators (mirror internal/validators messages used by net).
// ---------------------------------------------------------------------------

function validateObject(value, name) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw errInvalidArgType(name, "object", value);
  }
}
function validateString(value, name) {
  if (typeof value !== "string") throw errInvalidArgType(name, "string", value);
}
function validateNumber(value, name) {
  if (typeof value !== "number") throw errInvalidArgType(name, "number", value);
}
function validateBoolean(value, name) {
  if (typeof value !== "boolean")
    throw errInvalidArgType(name, "boolean", value);
}
function validateFunction(value, name) {
  if (typeof value !== "function")
    throw errInvalidArgType(name, "function", value);
}
function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== "number") throw errInvalidArgType(name, "number", value);
  if (!Number.isInteger(value)) throw errOutOfRange(name, "an integer", value);
  if (value < min || value > max) {
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
  }
  return value | 0;
}
function validateUint32(value, name, positive = false) {
  if (typeof value !== "number") throw errInvalidArgType(name, "number", value);
  if (!Number.isInteger(value)) throw errOutOfRange(name, "an integer", value);
  const min = positive ? 1 : 0;
  const max = 4294967295;
  if (value < min || value > max) {
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
  }
  return value >>> 0;
}
// Node's validatePort: numeric strings coerce; blank strings and non-numbers
// throw, and the error always reports the *original* value.
function validatePort(port, name = "Port", allowZero = true) {
  const original = port;
  if (typeof port === "string") {
    if (port.trim().length === 0) throw errSocketBadPort(name, original);
    port = Number(port);
  }
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (port === 0 && !allowZero)
  ) {
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
  return typeof s === "string" && toNumberStrict(s) === false;
}

// ---------------------------------------------------------------------------
// isIP / isIPv4 / isIPv6 — exact port of lib/internal/net.js regexes.
// ---------------------------------------------------------------------------

const v4Seg = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])";
const v4Str = `(?:${v4Seg}\\.){3}${v4Seg}`;
const IPv4Reg = new RegExp(`^${v4Str}$`);

const v6Seg = "(?:[0-9a-fA-F]{1,4})";
const IPv6Reg = new RegExp(
  "^(?:" +
    `(?:${v6Seg}:){7}(?:${v6Seg}|:)|` +
    `(?:${v6Seg}:){6}(?:${v4Str}|:${v6Seg}|:)|` +
    `(?:${v6Seg}:){5}(?::${v4Str}|(?::${v6Seg}){1,2}|:)|` +
    `(?:${v6Seg}:){4}(?:(?::${v6Seg}){0,1}:${v4Str}|(?::${v6Seg}){1,3}|:)|` +
    `(?:${v6Seg}:){3}(?:(?::${v6Seg}){0,2}:${v4Str}|(?::${v6Seg}){1,4}|:)|` +
    `(?:${v6Seg}:){2}(?:(?::${v6Seg}){0,3}:${v4Str}|(?::${v6Seg}){1,5}|:)|` +
    `(?:${v6Seg}:){1}(?:(?::${v6Seg}){0,4}:${v4Str}|(?::${v6Seg}){1,6}|:)|` +
    `(?::(?:(?::${v6Seg}){0,5}:${v4Str}|(?::${v6Seg}){1,7}|:))` +
    ")(?:%[0-9a-zA-Z-.:]{1,})?$",
);

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
function isLoopbackAddress(s) {
  // The virtual layer has no real interfaces: only loopback is bindable
  // as a source address (127.0.0.0/8, ::1). Anything else fails the bind
  // (probed real Node v24.22.1: 1.2.3.4 and 0.0.0.0 both fail EINVAL).
  if (typeof s !== "string") return false;
  if (s === "::1") return true;
  if (!isIPv4(s)) return false;
  const first = Number(s.split(".")[0]);
  return first === 127;
}
function isLoopbackName(host) {
  return typeof host === "string" && host.toLowerCase() === "localhost";
}

// ---------------------------------------------------------------------------
// Numeric IP helpers (for BlockList / SocketAddress, pure).
// ---------------------------------------------------------------------------

function parseIPv4(s) {
  if (!isIPv4(s)) return null;
  const p = s.split(".");
  return (+p[0] * 16777216 + +p[1] * 65536 + +p[2] * 256 + +p[3]) >>> 0;
}
function ipv4ToString(n) {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}
function stripZoneId(s) {
  const i = s.indexOf("%");
  return i === -1 ? s : s.slice(0, i);
}
// Assumes isIPv6(s). Returns the 128-bit value as a BigInt.
function parseIPv6(s) {
  s = stripZoneId(s);
  const halves = s.split("::");
  const headParts = halves[0] ? halves[0].split(":") : [];
  const tailParts =
    halves.length > 1 ? (halves[1] ? halves[1].split(":") : []) : [];
  const head = [];
  const tail = [];
  const push = (into, g) => {
    if (g.includes(".")) {
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
  for (let i = 0; i < 8; i++)
    groups.unshift(Number((n >> BigInt(i * 16)) & 0xffffn));
  const hex = groups.map((g) => g.toString(16));
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 1;
      } else {
        curLen++;
      }
    } else {
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return hex.join(":");
  const left = hex.slice(0, bestStart).join(":");
  const right = hex.slice(bestStart + bestLen).join(":");
  return `${left}::${right}`;
}
function addressToNumber(address, family) {
  return family === "ipv4" ? BigInt(parseIPv4(address)) : parseIPv6(address);
}
function numberToAddress(n, family) {
  return family === "ipv4" ? ipv4ToString(Number(n)) : ipv6ToString(n);
}

// ---------------------------------------------------------------------------
// SocketAddress — port of internal/socketaddress.js.
// ---------------------------------------------------------------------------

function SocketAddress(options = {}) {
  validateObject(options, "options");
  // NB: the address default is computed from the *raw* family value, before
  // lower-casing — mirroring internal/socketaddress.js exactly (so e.g.
  // { family: 'IPV4' } defaults address to '::' and then fails validation).
  let { family = "ipv4" } = options;
  const {
    address = family === "ipv4" ? "127.0.0.1" : "::",
    port = 0,
    flowlabel = 0,
  } = options;

  if (typeof family?.toLowerCase === "function") family = family.toLowerCase();
  let fam;
  switch (family) {
    case "ipv4":
      fam = "ipv4";
      break;
    case "ipv6":
      fam = "ipv6";
      break;
    default:
      throw errInvalidArgValue("options.family", options.family);
  }
  validateString(address, "options.address");
  const validPort = validatePort(port, "options.port");
  validateUint32(flowlabel, "options.flowlabel");

  const kind = isIP(address);
  if (kind !== 4 && kind !== 6) throw errInvalidAddress();
  if ((fam === "ipv4") !== (kind === 4)) throw errInvalidAddress();

  this._address = numberToAddress(addressToNumber(address, fam), fam);
  this._family = fam;
  this._port = validPort;
  this._flowlabel = fam === "ipv6" ? flowlabel : 0;
  Object.freeze(this);
}
Object.defineProperties(SocketAddress.prototype, {
  address: {
    get() {
      return this._address;
    },
    enumerable: true,
    configurable: true,
  },
  port: {
    get() {
      return this._port;
    },
    enumerable: true,
    configurable: true,
  },
  family: {
    get() {
      return this._family;
    },
    enumerable: true,
    configurable: true,
  },
  flowlabel: {
    get() {
      return this._flowlabel;
    },
    enumerable: true,
    configurable: true,
  },
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
  return family === "ipv6" ? "IPv6" : "IPv4";
}
// Mirrors internal/blocklist.js: the add* methods normalize through
// SocketAddress (accepting SocketAddress instances directly).
function blockListToSocketAddress(value, name, family) {
  if (value instanceof SocketAddress) return value;
  validateString(value, name);
  validateString(family, "family");
  return new SocketAddress({ address: value, family });
}
BlockList.prototype.addAddress = function addAddress(address, family = "ipv4") {
  const sa = blockListToSocketAddress(address, "address", family);
  const fam = sa.family;
  const start = addressToNumber(sa.address, fam);
  this._rules.unshift({
    type: "address",
    family: fam,
    start,
    end: start,
    toString: () =>
      `Address: ${blockListRuleType(fam)} ${numberToAddress(start, fam)}`,
  });
};
BlockList.prototype.addRange = function addRange(start, end, family = "ipv4") {
  const startAddr = blockListToSocketAddress(start, "start", family);
  const endAddr = blockListToSocketAddress(end, "end", family);
  if (startAddr.family !== endAddr.family) throw errInvalidAddress();
  const fam = startAddr.family;
  const s = addressToNumber(startAddr.address, fam);
  const e = addressToNumber(endAddr.address, fam);
  if (s > e)
    throw errInvalidArgValue("start", startAddr, "must come before end");
  this._rules.unshift({
    type: "range",
    family: fam,
    start: s,
    end: e,
    toString: () =>
      `Range: ${blockListRuleType(fam)} ${numberToAddress(s, fam)}-${numberToAddress(e, fam)}`,
  });
};
BlockList.prototype.addSubnet = function addSubnet(
  network,
  prefix,
  family = "ipv4",
) {
  const netAddr = blockListToSocketAddress(network, "network", family);
  const fam = netAddr.family;
  const maxPrefix = fam === "ipv4" ? 32 : 128;
  const pfx = validateInt32(prefix, "prefix", 0, maxPrefix);
  const bits = fam === "ipv4" ? 32n : 128n;
  const n = addressToNumber(netAddr.address, fam);
  const mask =
    pfx === 0 ? 0n : ((1n << BigInt(pfx)) - 1n) << (bits - BigInt(pfx));
  const start = n & mask;
  const end = start | (((1n << bits) - 1n) ^ mask);
  this._rules.unshift({
    type: "subnet",
    family: fam,
    start,
    end,
    toString: () =>
      `Subnet: ${blockListRuleType(fam)} ${numberToAddress(start, fam)}/${pfx}`,
  });
};
BlockList.prototype.check = function check(address, family = "ipv4") {
  let addr = address;
  if (!(addr instanceof SocketAddress)) {
    validateString(address, "address");
    validateString(family, "family");
    try {
      addr = new SocketAddress({ address, family });
    } catch {
      // Ignore the error. If it's not a valid address, return false.
      return false;
    }
  }
  const fam = addr.family;
  const n = addressToNumber(addr.address, fam);
  return this._rules.some(
    (rule) => rule.family === fam && n >= rule.start && n <= rule.end,
  );
};
Object.defineProperty(BlockList.prototype, "rules", {
  get() {
    return this._rules.map((r) => r.toString());
  },
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
      if (typeof entry !== "string") {
        throw errInvalidArgType("data", ["string", "string[]"], data);
      }
    }
  } else if (typeof data !== "string") {
    throw errInvalidArgType("data", ["string", "string[]"], data);
  } else {
    data = JSON.parse(data);
    if (!Array.isArray(data)) {
      throw errInvalidArgType("data", ["string", "string[]"], data);
    }
    for (const entry of data) {
      if (typeof entry !== "string") {
        throw errInvalidArgType("data", ["string", "string[]"], data);
      }
    }
  }
  this._parseIPInfo(data);
};
BlockList.prototype._parseIPInfo = function _parseIPInfo(data) {
  for (const item of data) {
    if (item.includes("IPv4")) {
      const subnetMatch = item.match(
        /Subnet: IPv4 (\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})/,
      );
      if (subnetMatch) {
        this.addSubnet(subnetMatch[1], parseInt(subnetMatch[2], 10));
        continue;
      }
      const addressMatch = item.match(
        /Address: IPv4 (\d{1,3}(?:\.\d{1,3}){3})/,
      );
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
    if (item.includes("IPv6")) {
      const ipv6SubnetMatch = item.match(
        /Subnet: IPv6 ([0-9a-fA-F:]{1,39})\/([0-9]{1,3})/i,
      );
      if (ipv6SubnetMatch) {
        this.addSubnet(
          ipv6SubnetMatch[1],
          parseInt(ipv6SubnetMatch[2], 10),
          "ipv6",
        );
        continue;
      }
      const ipv6AddressMatch = item.match(
        /Address: IPv6 ([0-9a-fA-F:]{1,39})/i,
      );
      if (ipv6AddressMatch) {
        this.addAddress(ipv6AddressMatch[1], "ipv6");
        continue;
      }
      const ipv6RangeMatch = item.match(
        /Range: IPv6 ([0-9a-fA-F:]{1,39})-([0-9a-fA-F:]{1,39})/i,
      );
      if (ipv6RangeMatch) {
        this.addRange(ipv6RangeMatch[1], ipv6RangeMatch[2], "ipv6");
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
  validateBoolean(value, "value");
  defaultAutoSelectFamily = value;
}
function getDefaultAutoSelectFamilyAttemptTimeout() {
  return defaultAutoSelectFamilyAttemptTimeout;
}
function setDefaultAutoSelectFamilyAttemptTimeout(value) {
  validateInt32(value, "value", 1);
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

// Shared network registries across duplicate module copies.
//
// Same issue as src/http.js: the dist bundles are self-contained
// (esbuild `external: []`), so every builtin bundle that transitively
// includes this module carries its OWN tcpServers/pipeServers maps. An
// http server's listen() binds its in-memory socket server in one copy's
// registry while another copy's netConnect() looks it up -> ECONNREFUSED.
// Keep the registries on the per-sandbox RT object so all copies share
// one virtual network per realm. Under real Node / direct import (no RT)
// fall back to module-local maps, preserving existing behavior.
const _localNetShared = {
  tcpServers: new Map(), // "<host>:<port>" -> Server
  pipeServers: new Map(), // path -> Server
  boundPipes: new Map(), // path -> BoundSocket (not yet listening/adopted)
};
function _netShared() {
  if (RT) {
    if (!RT.__netSharedState) {
      RT.__netSharedState = {
        tcpServers: new Map(),
        pipeServers: new Map(),
        boundPipes: new Map(),
      };
    }
    return RT.__netSharedState;
  }
  return _localNetShared;
}
// Accessors: every use site goes through these so all duplicate module
// copies hit the realm-shared maps.
function _tcpServers() {
  return _netShared().tcpServers;
}
function _pipeServers() {
  return _netShared().pipeServers;
}
function _boundPipes() {
  return _netShared().boundPipes;
}

function serverKey(host, port) {
  return `${host}:${port}`;
}

// Whether a virtual TCP server is registered for (host, port), using the
// same lookup keys as Socket connect: an IP-literal host checks its own
// key first, any other host checks 127.0.0.1, and wildcard binds (::,
// 0.0.0.0) accept loopback connections. Used by the http client to route
// loopback requests to a raw net server over an agent socket (with real
// response parsing) instead of fetch(), which cannot reach the virtual
// network (test-http-client-reject-chunked-with-content-length,
// test-http-client-reject-cr-no-lf). Internal only: not a Node API, so
// it stays out of the default namespace export below.
// Whether a virtual pipe (unix-socket) server is registered for a path.
// Internal only, like hasTcpServer: the http client routes socketPath
// requests over an agent socket (with real response parsing) instead of
// fetch(), which cannot reach the virtual network.
export function hasPipeServer(path) {
  return _pipeServers().has(path);
}

export function hasTcpServer(host, port) {
  const keys = [];
  if (isIP(host) !== 0) keys.push(serverKey(host, port));
  else keys.push(serverKey("127.0.0.1", port));
  keys.push(serverKey("::", port));
  keys.push(serverKey("0.0.0.0", port));
  return keys.some((key) => _tcpServers().has(key));
}

// Whether a (host, port) bind conflicts with a live listener: an exact
// match, a wildcard listener covering the host, or a wildcard bind against
// any listener on the port. Used by BoundSocket construction (EADDRINUSE
// vs a live listener — role-neutral binds coexist, libuv SO_REUSEADDR)
// and by the client bind-twice check in _doConnect.
function _tcpListenerConflicts(host, family, port) {
  const servers = _tcpServers();
  if (servers.has(serverKey(host, port))) return true;
  if (family === "IPv4") {
    if (servers.has(serverKey("0.0.0.0", port))) return true;
  } else if (servers.has(serverKey("::", port))) {
    return true;
  }
  if (host === "0.0.0.0" || host === "::") {
    for (const key of servers.keys()) {
      if (key.endsWith(`:${port}`)) return true;
    }
  }
  return false;
}

// Virtual fds for BoundSocket.fd(): no OS descriptor exists in the browser,
// so each bound socket gets a synthetic descriptor (>= 100, clear of
// stdio). Ceiling: a test comparing it against a real OS fd (e.g. via
// fs.fstat) cannot pass — no such test exists in the vendored suite.
let nextVirtualFd = 100;
const _isWindows =
  typeof process !== "undefined" && process.platform === "win32";
const _isLinux = typeof process !== "undefined" && process.platform === "linux";

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
  if (typeof chunk === "string") {
    if (BufferCtor) return BufferCtor.from(chunk, encoding || "utf8");
    return new TextEncoder().encode(chunk);
  }
  return chunk;
}
function byteLengthOf(chunk) {
  if (typeof chunk === "string") {
    if (BufferCtor) return BufferCtor.byteLength(chunk);
    return new TextEncoder().encode(chunk).length;
  }
  return chunk ? chunk.length : 0;
}

// ---------------------------------------------------------------------------
// VirtualHandle — stands in for Node's TCPWrap handle.
//
// Real Node sockets have a `_handle` (TCPWrap) while connected, set to null
// after destroy. Tests mock `_handle.setKeepAlive`/`setNoDelay` to verify
// socket options are applied. The virtual handle accepts these calls as
// no-ops (no real TCP in the browser) but exists as a mockable object so
// `socket._handle !== null` while connected, matching Node's observable
// behavior.
// ---------------------------------------------------------------------------

function VirtualHandle() {
  this._keepAlive = false;
  this._keepAliveDelay = 0;
  this._noDelay = true;
}
VirtualHandle.prototype.setKeepAlive = function setKeepAlive(enable, delay) {
  this._keepAlive = Boolean(enable);
  this._keepAliveDelay = delay | 0;
};
VirtualHandle.prototype.setNoDelay = function setNoDelay(enable) {
  this._noDelay = Boolean(enable);
};
// Methods tests may call; honest no-ops for the virtual transport.
VirtualHandle.prototype.ref = function ref() {};
VirtualHandle.prototype.unref = function unref() {};
VirtualHandle.prototype.close = function close() {};

// ---------------------------------------------------------------------------
// Socket — port of the virtual-transport half of lib/net.js Socket.
// Extends our own ./stream.js Duplex (NOT stream-browserify).
// ---------------------------------------------------------------------------

// ponytail: the socket timeout slot is keyed by a Symbol.for bridge, not
// real Node's internal/timers kTimeout — product code cannot import Node
// internals (the browser build cannot resolve internal modules). The parity
// adapter parity/internal-timers-adapter.mjs exports this same key, so
// tests reading socket[kTimeout] see the slot. Real Node keeps the timer
// object in the slot on arm, re-arm, clear, fire, and destroy (cleared
// timers read _idleTimeout -1, _destroyed true) — it is never nulled after
// first arming, so this slot mirrors that instead of tracking _idleTimer.
// Ceiling: a test asserting symbol identity against real Node's kTimeout
// cannot pass through this bridge — that would need a harness-injected
// symbol, and no vendored test asserts it.
const kTimeout = Symbol.for("bundleVFSModules.net.kTimeout");

function Socket(options = {}) {
  if (!(this instanceof Socket)) return new Socket(options);
  if (options !== null && typeof options !== "object") {
    throw errInvalidArgType("options", "object", options);
  }
  options = { ...options };

  if (
    options.objectMode ||
    options.readableObjectMode ||
    options.writableObjectMode
  ) {
    throw errInvalidArgValue("options", options, "objectMode is not supported");
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
  this[kTimeout] = null;
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
  this._peerReset = false;
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
    emitClose: false, // Socket owns 'close' emission (Node: close(hadError))
    decodeStrings: false,
    autoDestroy: true,
    onwrite: (stream, er) => onwrite(stream, er),
  });

  // Shut down the writable side when the readable side ends, unless the
  // socket (or server) allows half-open connections (lib/net.js).
  this.on("end", onReadableStreamEnd);

  // Adopt a pre-bound BoundSocket as the local endpoint (virtual).
  if (options.handle instanceof BoundSocket) {
    // Remember the adoption: connect() rejects localAddress/localPort
    // on an adopted socket (Node lib/net.js lookupAndConnect), and the
    // bound endpoint is the socket's local endpoint from construction
    // (connect() is synchronous for an adopted handle, so localAddress/
    // localPort resolve in-tick). Consuming here transfers ownership:
    // the BoundSocket's address()/fd()/close() throw from now on.
    this._adoptedHandle = true;
    const addr = options.handle.address();
    options.handle._consume();
    if (typeof addr === "string") {
      this._boundPath = addr;
      this._sockname = { address: addr };
    } else if (addr && typeof addr.port === "number") {
      this._bindLocalAddress = addr.address;
      this._bindLocalPort = addr.port;
      this._sockname = {
        address: addr.address,
        family: addr.family,
        port: addr.port,
      };
    }
  }

  if (options.timeout) this.setTimeout(options.timeout);
}
Object.setPrototypeOf(Socket.prototype, Duplex.prototype);
Socket.prototype.constructor = Socket;
// Virtual transport: _handle is a VirtualHandle while connected, null after
// destroy (mirrors Node where _handle is a TCPWrap while connected, null
// after close). Tests assert `socket._handle === null` for closed sockets
// and mock `_handle.setKeepAlive`/`setNoDelay` on connected ones.
Socket.prototype._handle = null;

function onwrite(stream, er) {
  // Mirrors lib/net.js onwrite: sync-flush state, then the stream continues.
  if (stream._connecting) return;
}

// Called when the 'end' event is emitted.
function onReadableStreamEnd() {
  if (!this.allowHalfOpen) {
    this.write = writeAfterFIN;
    // Real Node (probed v24.22.1): with allowHalfOpen false, the socket
    // ends itself once EOF is delivered — the client sees 'end' then
    // 'close' with no user action, and the loop drains. Deferred a tick
    // so writes issued inside user 'end' handlers still land (also
    // probed: a write in the 'end' handler reaches the peer). Server
    // sockets are unaffected: the HTTP layer sets allowHalfOpen true
    // on accepted sockets, so half-closed request/response still works.
    if (!this.writableEnded && !this.destroyed) {
      const self = this;
      nextTick(() => {
        if (!self.destroyed && !self.writableEnded) self.end();
      });
    }
  }
}

function writeAfterFIN(chunk, encoding, cb) {
  if (!this.writableEnded) {
    return Duplex.prototype.write.call(this, chunk, encoding, cb);
  }

  if (typeof encoding === "function") {
    cb = encoding;
    encoding = null;
  }

  // A write after the peer destroyed its socket is ECONNRESET, not
  // EPIPE: destroy() is an abortive close (RST), while a graceful FIN
  // (peer end()) keeps the EPIPE shape (test-http-conn-reset vs the
  // repo net test 'write after local end and remote FIN fails with
  // EPIPE'). _destroy marks the peer with _peerReset when it delivers
  // the EOF, so this branch can tell the two apart.
  // ponytail: ceiling — the flag is set only by _destroy's EOF
  // delivery; resetAndDestroy already destroys the peer with
  // ECONNRESET directly and never goes through here.
  const er = this._peerReset
    ? errConnReset()
    : Object.assign(
        new Error("This socket has been ended by the other party"),
        { code: "EPIPE" },
      );
  if (typeof cb === "function") {
    nextTick(cb, er);
  }
  this.destroy(er);
  return false;
}

// --- State ---------------------------------------------------------------

Object.defineProperties(Socket.prototype, {
  pending: {
    get() {
      return !this._connected || this.connecting;
    },
    enumerable: true,
    configurable: true,
  },
  readyState: {
    get() {
      if (this.connecting) return "opening";
      if (this.readable && this.writable) return "open";
      if (this.readable && !this.writable) return "readOnly";
      if (!this.readable && this.writable) return "writeOnly";
      return "closed";
    },
    enumerable: true,
    configurable: true,
  },
  bytesRead: {
    get() {
      return this._bytesRead;
    },
    enumerable: true,
    configurable: true,
  },
  bytesWritten: {
    get() {
      // Streaming coalescing (#279) pends response frames in the
      // message's _pendingFrame instead of writing them to the socket
      // at once, so _bytesWritten lags until the flush runs — but the
      // shim delivers synchronously by design, and
      // test-http-byteswritten asserts bytesWritten > 0 mid-loop,
      // while the frame is still pended (it passed before #279, when
      // streaming writes went straight to the socket). Count the
      // current response's framed-pending bytes alongside the
      // delivered count: the dispatch stash on _httpState already
      // tracks the live response per server socket, and framedPending
      // drains to 0 at flush (or the stash is cleared), so the sum
      // never double-counts. ponytail: the getter reads the stash
      // rather than a new socket→response link; a pipelined deferred
      // response overwrites lastResponse while its predecessor is
      // unfinished, so the predecessor's pends are briefly invisible
      // here — they land in _bytesWritten at its finish flush.
      // Ceiling: if a future test reads bytesWritten mid-pipeline on
      // a deferred socket, the stash needs per-response accounting.
      return (
        this._bytesWritten +
        (this._httpState?.lastResponse?._framedPending || 0)
      );
    },
    enumerable: true,
    configurable: true,
  },
  bufferSize: {
    get() {
      return this._connected ? this.writableLength : undefined;
    },
    enumerable: true,
    configurable: true,
  },
  writableLength: {
    // Real Node's socket.writableLength counts bytes not yet accepted by
    // the receiver: on a virtual socket, delivery is synchronous into
    // the peer's readable buffer, so the stream queue alone always reads
    // 0 — yet a peer that never reads leaves the bytes queued (probed
    // v24.22.1: 192MB written to a paused peer still reads writableLength
    // 201326657 after end()). Count the stream's own queue, the current
    // request's unflushed buffer (outputData + Writable queue — only
    // until _performRequest drains it into the round trip), and the
    // peer's unread bytes beyond one kernel-scale receive window
    // (131072, the recvBufferSize observed on real Node: small writes
    // drain through it, huge ones do not — so a headers-only socket
    // still reads 0 while a 192MB socket reads undrained). The agent's
    // drained-only reuse veto reads this value.
    // ponytail: the 128KiB window approximates kernel buffer accounting,
    // it is not a protocol constant — if a future test pins an exact
    // kernel-buffer boundary, this needs the real capacity model.
    get() {
      const state = this._writableState;
      let len = state ? state.length : 0;
      const msg = this._httpMessage;
      if (msg) {
        if (typeof msg.outputSize === "number") len += msg.outputSize;
        const mstate = msg._writableState;
        if (mstate && typeof mstate.length === "number") len += mstate.length;
      }
      const peer = this._peer;
      if (peer && !peer.destroyed) {
        const unread =
          typeof peer.readableLength === "number" ? peer.readableLength : 0;
        if (unread > 131072) len += unread - 131072;
      }
      return len;
    },
    enumerable: true,
    configurable: true,
  },
  localAddress: {
    get() {
      return this._sockname ? this._sockname.address : undefined;
    },
    enumerable: true,
    configurable: true,
  },
  localPort: {
    get() {
      return this._sockname ? this._sockname.port : undefined;
    },
    enumerable: true,
    configurable: true,
  },
  localFamily: {
    get() {
      return this._sockname ? this._sockname.family : undefined;
    },
    enumerable: true,
    configurable: true,
  },
  remoteAddress: {
    get() {
      return this._peername ? this._peername.address : undefined;
    },
    enumerable: true,
    configurable: true,
  },
  remotePort: {
    get() {
      return this._peername ? this._peername.port : undefined;
    },
    enumerable: true,
    configurable: true,
  },
  remoteFamily: {
    get() {
      return this._peername ? this._peername.family : undefined;
    },
    enumerable: true,
    configurable: true,
  },
});

Socket.prototype.address = function address() {
  if (!this._connected || !this._sockname) return {};
  const { address, family, port } = this._sockname;
  return { address, family, port };
};

// -- TLS session surface (populated by the https/tls layers) -----------------
// Node's TLSSocket.getSession/getPeerCertificate/isSessionReused live on
// the socket the request used; the shim's https sockets are net.Sockets,
// so the methods live here and read the _tls* fields the https agent
// attaches at connection time. Defaults match src/tls.js's TLSSocket
// stubs (undefined/{}/false) — never fabricated.
Socket.prototype.getSession = function getSession() {
  return this._tlsSession ?? undefined;
};

Socket.prototype.isSessionReused = function isSessionReused() {
  return this._tlsSessionReused ?? false;
};

Socket.prototype.getPeerCertificate = function getPeerCertificate() {
  return this._tlsPeerCertificate ?? {};
};

Socket.prototype.ref = function ref() {
  this._socketUnrefed = false;
  if (this._loopTimer !== null && typeof this._loopTimer.ref === "function") {
    try {
      this._loopTimer.ref();
    } catch {
      /* ignore */
    }
  }
  return this;
};
Socket.prototype.unref = function unref() {
  this._socketUnrefed = true;
  if (this._loopTimer !== null && typeof this._loopTimer.unref === "function") {
    try {
      this._loopTimer.unref();
    } catch {
      /* ignore */
    }
  }
  return this;
};

// A connecting/connected socket keeps the event loop alive, like a real
// socket handle does. Released on destroy, when the transport goes
// inactive, or when reading never started (inactive handle).
Socket.prototype._needsLoopKeeper = function _needsLoopKeeper() {
  if (this.destroyed) return false;
  // A socket that never connected and isn't connecting has no handle
  // on real Node (nothing keeps the loop alive for it), even if the
  // read machinery ran: a custom createConnection may return a raw
  // socket that errors without ever connecting or being destroyed,
  // and pushing bytes into it schedules a read that used to arm the
  // keeper forever (test-http-client-read-in-error: the request
  // errors, "ignore" prints, but the process never exits).
  if (!this._connected && !this.connecting) return false;
  if (this._isTransportInactive()) return false;
  if (this.connecting) return true;
  if (this._pendingWrites !== null && this._pendingWrites.length > 0)
    return true;
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
  if (!this._eofReceived) return false;
  if (this._pendingWrites !== null && this._pendingWrites.length > 0)
    return false;
  if (this.writableEnded) return true;
  // The peer was destroyed (its _destroy nulled the link before notifying
  // EOF): no write from here can ever land, so the socket is dead even
  // though our writable side is still open. A graceful peer FIN does NOT
  // null the link — the peer stays alive to receive our writes — so
  // half-close drain (server still owes responses after a client FIN)
  // keeps its loop keeper. Without this, a client abandoned by a server
  // destroy holds the process open forever (test-http-server-
  // keep-alive-timeout: both sub-tests complete, yet the process never
  // exits because the two orphaned client sockets keep their timers).
  if (this._peer === null) return true;
  return false;
};
Socket.prototype._maybeReleaseLoop = function _maybeReleaseLoop() {
  if (this._isTransportInactive()) this._releaseLoop();
};

// --- Timers --------------------------------------------------------------

Socket.prototype._clearIdleTimer = function _clearIdleTimer() {
  if (this._idleTimer !== null) {
    const timer = this._idleTimer;
    clearTimeout(timer);
    this._idleTimer = null;
    // Probed on real Node: clearing keeps the (now _destroyed) timer in
    // socket[kTimeout]; the slot is never nulled after first arming.
    this[kTimeout] = timer;
  }
};
Socket.prototype._refreshTimeout = function _refreshTimeout() {
  this._clearIdleTimer();
  if (this.timeout > 0 && !this.destroyed) {
    this._idleTimer = setTimeout(() => {
      const timer = this._idleTimer;
      this._idleTimer = null;
      // Probed on real Node: the fired timer stays in socket[kTimeout].
      this[kTimeout] = timer;
      this.emit("timeout");
    }, this.timeout);
    // Matches Node: the socket idle timer is unref'd.
    if (this._idleTimer && typeof this._idleTimer.unref === "function") {
      try {
        this._idleTimer.unref();
      } catch {
        /* ignore */
      }
    }
    this[kTimeout] = this._idleTimer;
  }
};
// setStreamTimeout port: no-op on destroyed sockets; `timeout` is stored
// before validation; setTimeout(0, cb) removes that timeout listener.
Socket.prototype.setTimeout = function setTimeout(msecs, callback) {
  if (this.destroyed) return this;
  this.timeout = msecs;
  validateNumber(msecs, "msecs");
  if (!(msecs >= 0) || !Number.isFinite(msecs)) {
    throw errOutOfRange("msecs", "a non-negative finite number", msecs);
  }
  this._clearIdleTimer();
  if (msecs === 0) {
    if (callback !== undefined) {
      validateFunction(callback, "callback");
      this.removeListener("timeout", callback);
    }
  } else {
    this._refreshTimeout();
    if (callback !== undefined) {
      validateFunction(callback, "callback");
      this.once("timeout", callback);
    }
  }
  return this;
};

Socket.prototype.setNoDelay = function setNoDelay(enable) {
  // Backwards compatibility: assume true when `enable` is omitted.
  enable = Boolean(enable === undefined ? true : enable);
  this._noDelay = enable;
  // Mirrors lib/net.js: delegate to the handle when connected.
  if (this._handle) this._handle.setNoDelay(enable);
  return this;
};

Socket.prototype.setKeepAlive = function setKeepAlive(
  enable,
  initialDelayMsecs = 0,
) {
  this._keepAlive = Boolean(enable);
  this._keepAliveInitialDelay = initialDelayMsecs;
  // Mirrors lib/net.js: delegate to the handle when connected.
  if (this._handle) this._handle.setKeepAlive(enable, initialDelayMsecs);
  return this;
};

// --- Connection setup ----------------------------------------------------

// _normalizeArgs port (also exported for compat).
const normalizedArgsSymbol = Symbol("normalizedArgs");
function _normalizeArgs(args) {
  let options;
  if (args.length === 0) return [{}, null];
  const arg0 = args[0];
  let cb = null;
  if (typeof args[args.length - 1] === "function") {
    cb = args[args.length - 1];
    args = args.slice(0, -1);
  }
  if (typeof arg0 === "number" || typeof arg0 === "string") {
    if (isPipeName(arg0)) {
      options = { path: arg0 };
    } else {
      options = { port: arg0 };
      if (args.length > 1 && typeof args[1] === "string")
        options.host = args[1];
    }
  } else {
    validateObject(arg0, "options");
    options = { ...arg0 };
  }
  options = { ...options };
  return [options, cb];
}
function normalizeArgs(args) {
  // createConnection passes the already-normalized tuple straight
  // through to Socket.prototype.connect (real Node's internal call
  // shape — this is why a monkeypatched connect receives a single
  // array argument whose [0] is the options object, which
  // test-http-nodelay asserts on). Unpack it instead of
  // re-normalizing, which would spread the tuple into
  // { 0: options, 1: cb } garbage.
  if (
    args.length === 1 &&
    Array.isArray(args[0]) &&
    args[0][normalizedArgsSymbol]
  )
    return args[0];
  if (Array.isArray(args) && args[normalizedArgsSymbol]) return args;
  const normalized = _normalizeArgs(args);
  Object.defineProperty(normalized, normalizedArgsSymbol, { value: true });
  return normalized;
}

Socket.prototype.connect = function connect(...args) {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  const cb = normalized[1];

  if (cb !== null) this.once("connect", cb);

  if (options.port === undefined && options.path == null)
    throw errMissingArgs();

  // Mirrors Node lib/net.js lookupAndConnect, in Node's order: an adopted
  // bound socket rejects localAddress/localPort, then the address itself
  // is validated synchronously (test-net-localerror asserts both throws).
  if (
    this._adoptedHandle &&
    (options.localAddress !== undefined || options.localPort !== undefined)
  ) {
    throw errInvalidArgValue(
      "options",
      options,
      "localAddress and localPort cannot be used with an adopted bound socket",
    );
  }
  if (options.localAddress !== undefined && isIP(options.localAddress) === 0) {
    throw errInvalidIpAddress(options.localAddress);
  }
  if (
    options.localPort !== undefined &&
    typeof options.localPort !== "number"
  ) {
    throw errInvalidArgType("options.localPort", "number", options.localPort);
  }
  // Node lib/net.js lookupAndConnect: a non-function lookup is a
  // synchronous TypeError (test-net-options-lookup). `null` counts as
  // absent, like Node's `options.lookup != null` check.
  if (options.lookup != null && typeof options.lookup !== "function") {
    throw errInvalidArgType("options.lookup", "function", options.lookup);
  }
  // Stash the requested source endpoint for _doConnect/_acceptConnection:
  // the virtual layer has no real bind, so the pairing presents it as the
  // socket's local address (and the server side's remote address). An
  // adopted bound socket keeps its constructor-stashed endpoint (connect()
  // rejects localAddress/localPort on adopted sockets above).
  if (!this._adoptedHandle) {
    this._bindLocalAddress = options.localAddress;
    this._bindLocalPort = options.localPort;
  }

  if (this.write !== Socket.prototype.write) {
    // If the user has overwritten .write, reset it so connect() works.
    this.write = Socket.prototype.write;
  }

  if (this.destroyed) {
    undestroyStream.call(this);
    this._connected = false;
    this._hadError = false;
    // A previous lookup failure must not leak into the next connect.
    this._lookupError = undefined;
  }

  this._sockname = null;
  this._peername = null;
  this._peer = null;
  this._pendingWrites = [];
  this._finSent = false;
  this._localPortEphemeral = 0;

  // An adopted bound socket's local endpoint resolves synchronously:
  // connect(2) is synchronous for an adopted handle in Node, so
  // localAddress/localPort read in-tick, before the 'connect' event.
  if (this._adoptedHandle) {
    if (this._boundPath !== undefined) {
      this._sockname = { address: this._boundPath };
    } else if (this._bindLocalPort !== undefined) {
      this._sockname = {
        address: this._bindLocalAddress,
        family: isIP(this._bindLocalAddress) === 6 ? "IPv6" : "IPv4",
        port: this._bindLocalPort,
      };
    }
  }

  // Mirrors lib/net.js: connect options set socket properties applied on
  // successful connection (via _handle.setKeepAlive/setNoDelay).
  if (options.noDelay !== undefined) this._noDelay = Boolean(options.noDelay);
  if (options.keepAlive !== undefined)
    this._keepAlive = Boolean(options.keepAlive);
  if (options.keepAliveInitialDelay !== undefined) {
    const d = Number(options.keepAliveInitialDelay);
    this._keepAliveInitialDelay = d < 0 ? 0 : Math.floor(d);
  }
  // BlockList for connection filtering (checked in _doConnect).
  if (options.blockList !== undefined) this.blockList = options.blockList;

  const path = options.path;
  const pipe = !!path;
  if (pipe) {
    validateString(path, "options.path");
  } else {
    validatePort(options.port, "Port");
  }

  // Host-runtime hook: Jared's runtime can take over connect() with
  // emulated/host networking. Returning true means the hook drives this
  // socket from here (it will emit connect/error/close itself).
  if (RT && typeof RT.__netConnectHook === "function") {
    let handled = false;
    try {
      handled =
        RT.__netConnectHook({
          host: options.host,
          port: options.port,
          path: options.path,
          socket: this,
        }) === true;
    } catch {
      /* hook failures never break virtual connect */
    }
    if (handled) return this;
  }

  // AbortSignal option (mirrors connect() honoring options.signal).
  if (options.signal !== undefined && options.signal !== null) {
    const signal = options.signal;
    if (
      typeof signal !== "object" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.aborted !== "boolean"
    ) {
      throw errInvalidArgType("options.signal", "AbortSignal", signal);
    }
    if (signal.aborted) {
      nextTick(() => this.destroy(signal.reason));
      return this;
    }
    signal.addEventListener("abort", () => this.destroy(signal.reason), {
      once: true,
    });
  }

  this.connecting = true;
  this._refreshTimeout();
  // Mirrors Node: the handle exists from connect() onward (tests mock
  // _handle.setKeepAlive immediately after net.connect() returns).
  if (!this._handle) this._handle = new VirtualHandle();
  // Lookup option (mirrors Node's lookupAndConnect): a custom lookup
  // resolves the host before connecting. The resolved IP is threaded
  // into _doConnect (like Node's internalConnect receiving the resolved
  // ip): it drives the blockList check and the virtual-server lookup.
  // A lookup that never calls back keeps the socket pending (connecting)
  // with no error, exactly like Node (test-http-agent-timeout-option
  // relies on this shape). The loop keeper is armed only AFTER the
  // lookup resolves: a pending lookup performs no handle activity on
  // real Node, so it must not hold the loop open here either (otherwise
  // a never-resolving lookup hangs the process instead of draining).
  if (typeof options.lookup === "function") {
    const lookupHost = options.host === undefined ? "localhost" : options.host;
    let lookupDone = false;
    try {
      options.lookup(lookupHost, options, (err, ip, addressType) => {
        if (lookupDone || this.destroyed || !this.connecting) return;
        lookupDone = true;
        // Node's emitLookup (lib/net.js:1778, 1815): the socket emits
        // 'lookup' for every lookup outcome — once per address in the
        // `all` form, once otherwise.
        if (Array.isArray(ip)) {
          for (const entry of ip) {
            this.emit(
              "lookup",
              err,
              entry && entry.address,
              entry && entry.family,
              lookupHost,
            );
          }
        } else {
          this.emit("lookup", err, ip, addressType, lookupHost);
        }
        if (err) {
          // A custom-lookup failure is authoritative (real Node fails
          // the connect outright). Flag it on the socket: the http
          // layer's fetch-path guard must still forward it — a lookup
          // error is the request's outcome, unlike the background
          // ENOTFOUND of the agent socket for a fetched host
          // (test-http-client-req-error-dont-double-fire).
          this._lookupError =
            err instanceof Error ? err : new Error(String(err));
          this._connectFailed(this._lookupError);
          return;
        }
        // Node validates the resolved address (lib/net.js:1788-1796):
        // a non-string or non-IP result is ERR_INVALID_IP_ADDRESS,
        // and a family other than 4/6 is ERR_INVALID_ADDRESS_FAMILY.
        // The `all` form returns an array: the first entry with a
        // valid IP and family wins, else the first entry decides the
        // error — invalid IP first, bad family second
        // (lookupAndConnectMultiple, lib/net.js:1811+).
        // (test-net-dns-custom-lookup, test-net-options-lookup).
        let resolvedIp = ip;
        let resolvedFamily = addressType;
        if (Array.isArray(ip)) {
          const first = ip[0];
          const valid = ip.find(
            (entry) =>
              entry &&
              typeof entry.address === "string" &&
              isIP(entry.address) !== 0 &&
              (entry.family === 4 || entry.family === 6),
          );
          if (!valid) {
            const firstIp = first && first.address;
            if (typeof firstIp !== "string" || isIP(firstIp) === 0) {
              this._lookupError = errInvalidIpAddress(firstIp);
            } else {
              this._lookupError = errInvalidAddressFamily(
                first && first.family,
                lookupHost,
                options.port | 0,
              );
            }
            this._connectFailed(this._lookupError);
            return;
          }
          resolvedIp = valid.address;
          resolvedFamily = valid.family;
        }
        if (typeof resolvedIp !== "string" || isIP(resolvedIp) === 0) {
          this._lookupError = errInvalidIpAddress(resolvedIp);
          this._connectFailed(this._lookupError);
          return;
        }
        if (resolvedFamily !== 4 && resolvedFamily !== 6) {
          this._lookupError = errInvalidAddressFamily(
            resolvedFamily,
            lookupHost,
            options.port | 0,
          );
          this._connectFailed(this._lookupError);
          return;
        }
        this._keepLoopAlive();
        // Node's lookupAndConnect hands internalConnect the RESOLVED
        // ip (lib/net.js:1778 emitLookup -> internalConnect): the
        // blockList check and the address derivation run against it,
        // not the hostname — a blocked resolved IP must ERR_IP_BLOCKED
        // even when the hostname itself is not an IP literal
        // (test-http-request-lookup-error-catchable).
        const resolved = {
          address: resolvedIp,
          family: resolvedFamily === 6 || isIPv6(resolvedIp) ? "IPv6" : "IPv4",
        };
        defer(() => this._doConnect(options, pipe, resolved));
      });
    } catch (err) {
      // A synchronously-throwing lookup fails the connect async (Node
      // surfaces it as a connection error, not a connect() throw).
      defer(() =>
        this._connectFailed(
          err instanceof Error ? err : new Error(String(err)),
        ),
      );
    }
    return this;
  }
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

Socket.prototype._doConnect = function _doConnect(options, pipe, resolved) {
  if (this.destroyed || !this.connecting) return;

  const host = options.host === undefined ? "localhost" : options.host;

  let address;
  let family;
  let port = 0;
  if (pipe) {
    address = options.path;
  } else {
    port = options.port | 0;
    if (resolved) {
      // Lookup-resolved address (see connect(): Node's internalConnect
      // receives the resolved ip, not the hostname).
      address = resolved.address;
      family = resolved.family;
    } else if (isIP(host)) {
      address = host;
      family = isIPv4(host) ? "IPv4" : "IPv6";
    } else if (isLoopbackName(host)) {
      address = "127.0.0.1";
      family = "IPv4";
      // Node looks 'localhost' up like any hostname (lib/net.js
      // lookupAndConnect): the socket emits 'lookup' with the resolved
      // address (test-net-dns-lookup). IP literals skip lookup
      // entirely, so no emit there; the custom-lookup path emits in
      // connect() instead.
      this.emit("lookup", null, address, 4, host);
    } else {
      // No DNS resolver in a dependency-free browser shim: the lookup
      // fails (test-net-dns-error expects the 'lookup' event carrying
      // the error, then the socket error).
      const err = errNotFound(host);
      this.emit("lookup", err, undefined, undefined, host);
      defer(() => this._connectFailed(err));
      return;
    }
  }

  this.emit(
    "connectionAttempt",
    address,
    port,
    family === "IPv6" ? 6 : family === "IPv4" ? 4 : undefined,
  );

  // Bind emulation (Node lib/net.js internalConnect/checkBindError: the
  // bind happens before the connect attempt, and a failed bind destroys
  // the socket with the error). The virtual layer has no real interfaces,
  // so only a loopback source address can bind; anything else fails with
  // the probed shape (EINVAL, syscall bind, errno -22).
  if (!pipe && options.localAddress !== undefined) {
    if (!isLoopbackAddress(options.localAddress)) {
      const err = errnoError(
        "EINVAL",
        "bind",
        `bind EINVAL ${options.localAddress}`,
        {
          errno: -22,
          address: options.localAddress,
          port: options.localPort,
        },
      );
      defer(() => this._connectFailed(err));
      return;
    }
  }

  // A requested localPort that a live listener already holds fails the
  // bind (probed real Node v24.22.1: async EADDRINUSE, syscall bind,
  // errno -98). Role-neutral binds coexist, so only listening servers
  // conflict — never a BoundSocket-held port. No localAddress means a
  // wildcard bind, which conflicts with any listener on the port.
  if (!pipe && options.localPort !== undefined && options.localPort !== 0) {
    const bindHost = options.localAddress ?? "0.0.0.0";
    if (
      _tcpListenerConflicts(
        bindHost,
        isIP(bindHost) === 6 ? "IPv6" : "IPv4",
        options.localPort,
      )
    ) {
      const err = errnoError(
        "EADDRINUSE",
        "bind",
        `bind EADDRINUSE ${bindHost}:${options.localPort}`,
        { errno: -98, address: bindHost, port: options.localPort },
      );
      defer(() => this._connectFailed(err));
      return;
    }
  }

  // Client-side blockList check (mirrors lookupAndConnect).
  if (this.blockList && !pipe) {
    let blocked = false;
    try {
      blocked = this.blockList.check(
        address,
        `ipv${family === "IPv6" ? 6 : 4}`,
      );
    } catch {
      blocked = false;
    }
    if (blocked) {
      defer(() => this._connectFailed(errIpBlocked(address)));
      return;
    }
  }

  // Foreign-handle connect (Node lib/net.js internalConnect): a pre-existing
  // _handle with a `connect` drives the dial — a non-zero libuv return
  // destroys the socket with that errno (ExceptionWithHostPort). The shim's
  // own VirtualHandle has no `connect`, and adopted BoundSockets get a
  // VirtualHandle, so this only fires for foreign (e.g. test-faked) handles.
  // A zero return means the handle owns the connection from here (async
  // completion via req.oncomplete); never fall through to the virtual server
  // lookup, which would be a fake success.
  // ponytail: ceiling — a fake handle reporting async success has no
  // transport in the shim, so the socket stays connecting (as in Node, where
  // the handle would own I/O from here); no vendored test covers that path.
  if (typeof this._handle?.connect === "function") {
    const self = this;
    const req = {
      address,
      port,
      oncomplete(status) {
        if (status) {
          self._connectFailed(connectFailureToError(status, address, port));
        }
      },
    };
    let err;
    try {
      err = pipe
        ? this._handle.connect(req, address)
        : this._handle.connect(req, address, port);
    } catch (e) {
      // A throwing fake fails the connect async, like a sync-throwing lookup
      // — never a connect() throw.
      defer(() =>
        this._connectFailed(e instanceof Error ? e : new Error(String(e))),
      );
      return;
    }
    if (err) {
      const connectErr = connectFailureToError(err, address, port);
      defer(() => this._connectFailed(connectErr));
      return;
    }
    return;
  }

  this._host = host;

  let server = null;
  if (pipe) {
    server = _pipeServers().get(options.path);
    if (!server) {
      defer(() => this._connectFailed(errConnRefusedPipe(options.path)));
      return;
    }
  } else {
    const keys = [];
    const ipLiteral = isIP(host) !== 0;
    // Look the server up by the address we actually connect to: for a
    // lookup-resolved address that is the resolved IP, not the hostname
    // (a ::1 server was unreachable — the keys only ever named
    // 127.0.0.1 for a 'localhost' host; test-net-dns-custom-lookup
    // check(6)). For IP literals and loopback names address == host /
    // 127.0.0.1, so this is unchanged there.
    keys.push(serverKey(address, port));
    // A server bound to the wildcard also accepts loopback connections.
    keys.push(serverKey("::", port));
    keys.push(serverKey("0.0.0.0", port));
    for (const key of keys) {
      server = _tcpServers().get(key);
      if (server) break;
    }
    if (!server) {
      // Matches Node: IP-literal hosts get a detailed ECONNREFUSED; anything
      // else (DNS path) surfaces a bare ECONNREFUSED with an empty message.
      const err = ipLiteral
        ? errConnRefused(address, port)
        : errConnRefusedBare();
      defer(() => this._connectFailed(err));
      return;
    }
  }

  const req = { address, family, port, pipe, path: options.path };
  // One more event-loop turn before the handshake completes, like a real
  // TCP handshake: handlers attached after an `await` still catch 'connect'.
  // Accepts are batched (queueAccept) so a burst of connects is accepted
  // together, like the kernel's parallel handshakes — see the comment at
  // the queue.
  queueAccept(server, this, req);
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
    // A write to a peer that destroyed its socket is ECONNRESET
    // (test-http-conn-reset, test-http-destroyed-socket-write2):
    // destroy() is an abortive close (RST). Any other not-connected
    // state keeps the existing codeless error — no test pins it.
    const er = this.destroyed
      ? errnoError(
          "ERR_STREAM_DESTROYED",
          "write",
          "Cannot call write after a stream was destroyed",
        )
      : peer && peer.destroyed
        ? errConnReset()
        : new Error("Socket is not connected");
    if (!this.destroyed) this.destroy(er);
    cb(er);
    return;
  }
  this._deliverToPeer(chunk, encoding, cb);
};

Socket.prototype._writev = function _writev(chunks, cb) {
  // Corked-batch coalescing (test-http-response-cork vs the pipelined
  // raw-socket tests): real Node's net.Socket implements _writev, and
  // the Writable routes a corked batch of 2+ writes through it as ONE
  // call — on the wire those bytes leave as one TCP segment, so a raw
  // client sees ONE 'data' event per response. The shim's virtual
  // transport delivers per _write call, so without this the five
  // socket.write calls of a chunked end(chunk) response arrive as five
  // 'data' events and break pipelined clients that advance one request
  // per event (test-http-1.0-keep-alive,
  // test-http-server-keep-alive-defaults). The five calls still happen
  // — the cork test counts them — only the delivery coalesces. The
  // connecting case buffers the concatenated bytes as one pending write
  // whose callback is the batch callback, so onwrite fires exactly once
  // at flush (mirrors _write's connecting branch, which stores
  // state.onwrite as the pending item's cb).
  if (!this._connected || !this._peer || this._peer.destroyed) {
    if (this.connecting) {
      this._pendingWrites.push({
        chunk: Buffer.concat(
          chunks.map((item) => toBytes(item.chunk, item.encoding)),
        ),
        encoding: "",
        cb,
      });
      return;
    }
    // A write to a peer that destroyed its socket is ECONNRESET
    // (test-http-conn-reset, test-http-destroyed-socket-write2):
    // destroy() is an abortive close (RST). Any other not-connected
    // state keeps the existing codeless error — no test pins it.
    const er = this.destroyed
      ? errnoError(
          "ERR_STREAM_DESTROYED",
          "write",
          "Cannot call write after a stream was destroyed",
        )
      : this._peer && this._peer.destroyed
        ? errConnReset()
        : new Error("Socket is not connected");
    if (!this.destroyed) this.destroy(er);
    cb(er);
    return;
  }
  this._deliverToPeer(
    Buffer.concat(chunks.map((item) => toBytes(item.chunk, item.encoding))),
    "",
    cb,
  );
};

Socket.prototype._deliverToPeer = function _deliverToPeer(chunk, encoding, cb) {
  const peer = this._peer;
  const buf = toBytes(chunk, encoding);
  this._bytesWritten += buf ? buf.length : 0;
  // Writes refresh an ARMED idle timer only (probed real Node v24.22.1):
  // once the timer has fired (its callback nulls _idleTimer), a later
  // write must not re-arm it — otherwise a request's end() inside its
  // own 'timeout' handler fires 'timeout' a second time
  // (test-http-client-timeout-event expects exactly one). Reads
  // (_receiveFromPeer) still refresh unconditionally: a post-fire read
  // re-arms on real Node, as does an explicit setTimeout.
  if (this._idleTimer !== null) this._refreshTimeout();
  // Async delivery ONLY while a server socket is inside its 'upgrade'
  // handler (socket._upgradeDispatch, set around the emit in
  // _dispatchSocketRequest). A synchronous push would let the peer's
  // 'data' handler run inside the handler's socket.write(), before the
  // handler's next statement — so an upgrade handler that writes 101
  // and then records the upgrade head hands the client a null head
  // (test-http-upgrade-server). Scoped this narrowly on purpose: making
  // all server delivery async reordered writes against destroys by a
  // microtask and broke server-unconsume (the client's end() after the
  // response landed after the server's destroy-at-finish), and making
  // all delivery async broke 11 passing tests that depend on
  // synchronous throw propagation into writer catches (the
  // double-content-length clientError swallow, outgoing-destroyed
  // frame-error timing, pipeline/keep-alive write-vs-destroy order).
  // The write callback fires in the delivery microtask; a peer that
  // died before its delivery runs drops the bytes with a successful
  // callback (the write was accepted while the peer was alive). A
  // throw in the upgrade delivery chain surfaces as uncaughtException,
  // as on real Node (test-http-upgrade-server2's upgrade handler
  // throw) — the flag is cleared in a finally, so the throw path is
  // unaffected.
  if (this._upgradeDispatch) {
    if (!peer || peer.destroyed) {
      cb();
      return;
    }
    nextTick(() => {
      if (!peer.destroyed) peer._receiveFromPeer(buf);
      cb();
    });
    return;
  }
  // Base behavior, restored verbatim. A throw in the peer's 'data'
  // listener must not wedge this socket's write queue:
  // _receiveFromPeer -> push -> emit runs synchronously inside this
  // _write, so a listener throw used to skip cb() (the Writable
  // onwrite) and stall every later write forever, with the process
  // staying alive (test-http-server-keep-alive-defaults: the test's own
  // split-count assertion throws on a mid-response data event, and the
  // response's remaining bytes then never arrive). The finally
  // guarantees onwrite runs so the queue advances; the throw itself
  // still propagates to the writer's own catch (ServerResponse _write
  // swallows it) exactly as before.
  try {
    if (peer && !peer.destroyed) peer._receiveFromPeer(buf);
  } finally {
    cb();
  }
};

Socket.prototype._flushPendingWrites = function _flushPendingWrites() {
  const pending = this._pendingWrites;
  this._pendingWrites = [];
  for (const item of pending) {
    // A peer that died while an earlier flushed item was delivered
    // (e.g. the server destroyed its socket during the request head's
    // delivery) must error later items exactly like a post-connect
    // _write does, not silently drop them: _deliverToPeer's
    // peer-destroyed guard drops the bytes and calls back with no
    // error, so without this check a PUT client never sees 'error'
    // when the server destroys the response mid-request
    // (test-http-outgoing-destroyed). The peer is re-read per item
    // because it can die mid-loop.
    const peer = this._peer;
    if (!this._connected || !peer || peer.destroyed) {
      // A write to a peer that destroyed its socket is ECONNRESET
      // (test-http-conn-reset, test-http-destroyed-socket-write2):
      // destroy() is an abortive close (RST). Any other not-connected
      // state keeps the existing codeless error — no test pins it.
      const er = this.destroyed
        ? errnoError(
            "ERR_STREAM_DESTROYED",
            "write",
            "Cannot call write after a stream was destroyed",
          )
        : peer && peer.destroyed
          ? errConnReset()
          : new Error("Socket is not connected");
      if (!this.destroyed) this.destroy(er);
      item.cb(er);
      continue;
    }
    this._deliverToPeer(item.chunk, item.encoding, item.cb);
  }
};

Socket.prototype._receiveFromPeer = function _receiveFromPeer(buf) {
  if (this.destroyed) return;
  // Idle-socket read guard (test-http-agent-free-socket-data-guard,
  // HackerOne #3582376): unsolicited data on a pooled socket means
  // response-queue poisoning — destroy it instead of buffering the
  // bytes for the next request. The pooled close listener removes it
  // from the agent's free pool and drops the count. Reused sockets
  // have _inFreePool cleared (reuseSocket), so live responses are
  // unaffected.
  if (this._inFreePool) {
    this.destroy();
    return;
  }
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

// destroySoon port (lib/net.js:1084): half-close now, destroy once the
// writable side finishes — Node's resOnFinish calls this for last
// responses instead of destroy(), so socket.writableEnded is already
// true when user 'finish' handlers run
// (test-http-remove-header-stays-removed,
// test-http-remove-connection-header-persists-connection HTTP/1.0 leg).
// The arrow closure (not Node's bare `this.destroy` listener) keeps the
// socket bound even if a ported `once` calls listeners unbound.
// ponytail: ceiling — a socket whose 'finish' never fires (already
// destroyed, or end() skipped because !writable) is never destroyed by
// this; callers needing a guaranteed close must destroy() directly.
// The server finish path relies on the peer FIN-ing back to release the
// loop keeper if 'finish' stalls (see _isTransportInactive).
Socket.prototype.destroySoon = function destroySoon() {
  // Already destroyed: nothing left to end, and attaching a
  // finish listener to a dead socket only accumulates listeners
  // (test-http-many-ended-pipelines: the handler destroys the socket
  // per request, and all 20 pipelined responses still finish).
  if (this.destroyed) return;
  if (this.writable) this.end();

  if (this.writableFinished) this.destroy();
  else if (!this._destroySoonArmed) {
    // Arm the destroy-on-finish listener exactly once: several
    // last-responses can finish on the same socket (the pipelined
    // buffer keeps dispatching after the first end), and a
    // once-listener per response trips the MaxListeners warning
    // (test-http-many-ended-pipelines). Real Node never calls
    // destroySoon twice on one socket — its parser stops at the first
    // end — so single arming matches Node's observable exactly.
    this._destroySoonArmed = true;
    this.once("finish", () => {
      this._destroySoonArmed = false;
      this.destroy();
    });
  }
};

// _final port: end() half-closes; the peer sees a clean FIN ('end').
// The FIN is delivered on a later tick — on a real network FIN and data
// race, so a write the peer queued in its own 'connect' handler still lands.
// The link stays up: the peer may still write back (TCP half-close), and
// its own end() delivers the return FIN.
Socket.prototype._final = function _final(cb) {
  if (this.connecting) {
    this.once("connect", () => this._final(cb));
    return;
  }
  const peer = this._peer;
  this._finSent = true;
  if (peer && !peer.destroyed) {
    if (peer.connecting) {
      // The peer's 'connect' has not fired yet (deferred burst tail in
      // _acceptConnection): delivering EOF now would let its 'end' fire
      // before the connect callback attaches listeners
      // (test-net-connect-options-allowhalfopen: the server ends each
      // socket in its connection handler, the client's 'end' listener
      // is attached in 'connect'). On real Node nothing from the server
      // can arrive before the client's 'connect'. Wait for it; if the
      // peer dies first, the EOF is moot (its 'close' settles it).
      peer.once("connect", () => {
        if (!peer.destroyed) peer._receiveEOF();
      });
    } else {
      nextTick(() => {
        if (!peer.destroyed) peer._receiveEOF();
      });
    }
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
  // Mirrors Node: _handle becomes null after destroy (tests assert
  // `socket._handle === null` for closed sockets).
  this._handle = null;

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
    const notifyPeer = () => {
      if (peer.destroyed) return;
      if (peer._peer === this) peer._peer = null;
      // Abortive close: the peer's EOF came from a destroy, not a
      // graceful FIN — a later write fails ECONNRESET (see writeAfterFIN).
      peer._peerReset = true;
      peer._receiveEOF();
    };
    // Same connecting-peer guard as _final: a peer whose 'connect' has
    // not fired yet (deferred burst tail) must not see EOF before its
    // connect callback attaches listeners.
    if (peer.connecting) peer.once("connect", notifyPeer);
    else nextTick(notifyPeer);
  }

  cb(exception);
  // Queued *after* the machinery's own nextTick (which emits 'error' for
  // exception), so 'error' always precedes 'close' in both Node and
  // browser microtask orderings.
  nextTick(() => this.emit("close", hadError));

  // Mirrors lib/net.js: a server-owned socket releases the server's
  // connection count (and possibly its 'close') from _destroy.
  if (this._server) {
    this._server._connections--;
    if (this._server._emitCloseIfDrained) this._server._emitCloseIfDrained();
  }

  // HTTP CONNECT-detached sockets run their server-side close
  // bookkeeping from _destroy: no EventEmitter 'close' listener remains
  // after detach (real Node observes 0 at 'connect' time), mirroring
  // lib/net.js where the connection count releases from the handle
  // close, not an EE listener. Only set on such sockets.
  if (typeof this._onHttpSocketClose === "function") {
    const hook = this._onHttpSocketClose;
    this._onHttpSocketClose = null;
    try {
      hook();
    } catch {
      /* bookkeeping must not break close */
    }
  }
};

// autoDestroy as a real accessor (the ported streams define it only as
// a state bit, so a plain assignment created an inert own property and
// the socket kept auto-destroying on finish+end). Agent sockets set
// autoDestroy = false at creation (the agent owns their lifecycle);
// without this accessor that assignment did nothing, and a client
// socket died on its own finish+end before the response message's
// 'end' handlers ran (test-http-agent-destroyed-socket: 'end' handlers
// must see destroyed === false). Getter mirrors Node: true only when
// both sides auto-destroy.
Object.defineProperty(Socket.prototype, "autoDestroy", {
  enumerable: false,
  configurable: true,
  get() {
    return Boolean(
      this._readableState?.autoDestroy && this._writableState?.autoDestroy,
    );
  },
  set(value) {
    const v = Boolean(value);
    if (this._readableState) this._readableState.autoDestroy = v;
    if (this._writableState) this._writableState.autoDestroy = v;
  },
});

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
      // No-error reset to a peer that already ended its writable side:
      // real Node delivers no 'error' to that socket (probed v24.22.1:
      // client res.destroy() after server conn.end() leaves the server
      // conn with no 'error', no 'end', no 'close'). Destroying it with
      // ECONNRESET would surface an unhandled 'error' the app never sees
      // on real Node (test-http-multi-line-headers: the test's net
      // server attaches no conn 'error' listener). Destroy it cleanly
      // instead: 'close' with hadError=false releases the loop keeper
      // without an error event. Error-carrying resets and still-open
      // peers keep the ECONNRESET destroy (test-http-outgoing-destroyed
      // block 3 needs the server response 'close' that only a socket
      // close produces).
      if (!err && peer.writableEnded) {
        peer.destroy();
        return;
      }
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

  if (typeof options === "function") {
    connectionListener = options;
    options = {};
    this.on("connection", connectionListener);
  } else if (options == null || typeof options === "object") {
    options = { ...options };
    if (typeof connectionListener === "function") {
      this.on("connection", connectionListener);
    }
  } else {
    throw errInvalidArgType("options", "object", options);
  }

  if (options.keepAliveInitialDelay !== undefined) {
    validateNumber(
      options.keepAliveInitialDelay,
      "options.keepAliveInitialDelay",
    );
    if (options.keepAliveInitialDelay < 0) options.keepAliveInitialDelay = 0;
  }
  if (options.highWaterMark !== undefined) {
    validateNumber(options.highWaterMark, "options.highWaterMark");
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
      throw errInvalidArgType(
        "options.blockList",
        "net.BlockList",
        options.blockList,
      );
    }
    self.blockList = options.blockList;
  }

  if (typeof options === "function") {
    self.on("connection", connectionListener);
  } else if (typeof connectionListener === "function") {
    self.on("connection", connectionListener);
  }

  return self;
}
Object.setPrototypeOf(Server.prototype, EventEmitter.prototype);
Server.prototype.constructor = Server;

Object.defineProperty(Server.prototype, "listening", {
  get() {
    return this._listening;
  },
  enumerable: true,
  configurable: true,
});

Server.prototype.ref = function ref() {
  this._unref = false;
  if (this._loopTimer !== null && typeof this._loopTimer.ref === "function") {
    try {
      this._loopTimer.ref();
    } catch {
      /* ignore */
    }
  }
  return this;
};
Server.prototype.unref = function unref() {
  this._unref = true;
  if (this._loopTimer !== null && typeof this._loopTimer.unref === "function") {
    try {
      this._loopTimer.unref();
    } catch {
      /* ignore */
    }
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
// Consumes the bound socket synchronously (Node transfers the handle in
// listen()); its address()/fd()/close() throw from now on.
Server.prototype._adoptBoundSocket = function _adoptBoundSocket(bound) {
  const addr = bound.address();
  bound._consume();
  this._reusePortAdopted = !!bound._reusePort;
  if (typeof addr === "string") {
    this._bindPending = true;
    nextTick(() => this._doListenPipe(addr));
  } else {
    this._bindPending = true;
    nextTick(() => this._doListenTCP(addr.port, addr.address));
  }
};

Server.prototype.listen = function listen(...args) {
  if (args.length > 0 && args[0] instanceof BoundSocket) {
    if (this._listening || this._bindPending) throw errServerAlreadyListening();
    const cb = typeof args[1] === "function" ? args[1] : null;
    if (cb !== null) this.once("listening", cb);
    this._adoptBoundSocket(args[0]);
    return this;
  }

  const normalized = normalizeArgs(args);
  let options = normalized[0];
  const cb = normalized[1];

  if (this._listening || this._bindPending) throw errServerAlreadyListening();
  if (cb !== null) this.once("listening", cb);

  const backlog =
    toNumber(args.length > 1 && args[1]) ||
    toNumber(args.length > 2 && args[2]) ||
    options.backlog;

  options = { ...options };
  if (
    args.length === 0 ||
    typeof args[0] === "function" ||
    (options.port === undefined && "port" in options) ||
    options.port === null
  ) {
    options.port = 0;
  }

  if (typeof options.port === "number" || typeof options.port === "string") {
    const port = validatePort(options.port, "options.port");
    const host = options.host;
    this._bindPending = true;
    nextTick(() => this._doListenTCP(port, host, backlog));
    return this;
  }

  if (options.path && typeof options.path === "string") {
    validateString(options.path, "options.path");
    this._bindPending = true;
    nextTick(() => this._doListenPipe(options.path, backlog));
    return this;
  }

  if (!("port" in options || "path" in options)) {
    throw errInvalidArgValue(
      "options",
      options,
      'must have the property "port" or "path"',
    );
  }
  throw errInvalidArgValue("options", options);
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
    bindHost = "::";
    family = "IPv6";
  } else if (isIP(host)) {
    bindHost = host;
    family = isIPv4(host) ? "IPv4" : "IPv6";
  } else if (isLoopbackName(host)) {
    bindHost = "127.0.0.1";
    family = "IPv4";
  } else {
    this._bindPending = false;
    nextTick(() => this.emit("error", errNotFound(host)));
    return;
  }

  const actualPort = port === 0 ? allocPort() : port;
  const key = serverKey(bindHost, actualPort);
  const existing = _tcpServers().get(key);
  if (existing) {
    // SO_REUSEPORT: two servers adopted from reusePort BoundSockets may
    // share one port. The first entry stays for routing (the kernel
    // load-balances; this test never connects); the second server still
    // listens with its own _bindAddress.
    if (!(this._reusePortAdopted && existing._reusePortAdopted)) {
      this._bindPending = false;
      nextTick(() => this.emit("error", errAddrInUse(bindHost, actualPort)));
      return;
    }
  } else {
    _tcpServers().set(key, this);
  }
  this._bindPending = false;
  this._listening = true;
  this._backlog = backlog;
  this._bindAddress = { address: bindHost, family, port: actualPort };
  this._keepLoopAlive();
  this.emit("listening");
};

Server.prototype._doListenPipe = function _doListenPipe(path, backlog) {
  if (!this._bindPending) return;
  if (_pipeServers().has(path)) {
    this._bindPending = false;
    nextTick(() =>
      this.emit(
        "error",
        errnoError(
          "EADDRINUSE",
          "listen",
          `listen EADDRINUSE: address already in use ${path}`,
          { errno: -98, path },
        ),
      ),
    );
    return;
  }
  _pipeServers().set(path, this);
  this._bindPending = false;
  this._listening = true;
  this._backlog = backlog;
  this._pipeName = path;
  this._bindAddress = { address: path };
  this._keepLoopAlive();
  this.emit("listening");
};

Server.prototype.address = function address() {
  if (this._pipeName) return this._pipeName;
  if (!this._listening || !this._bindAddress) return null;
  const { address, family, port } = this._bindAddress;
  return { address, family, port };
};

// Pairs an incoming client with a server-side Socket, completes its
// handshake ('connect' then 'ready'), then destroys the server side
// gracefully — the client sees EOF ('end') + 'close' (hadError false).
// Probed real Node (v24.22.1). No 'connection' event fires and the socket
// is never counted; do NOT set _server or _connections++. Shared by the
// maxConnections drop path (which also emits 'drop') and the server-side
// blockList path (which does not). clientPort and bindAddr are passed in:
// the caller's 'drop'/'drop'-data read happens before this pairing, and a
// 'drop' listener may close the server (nulling _bindAddress), so the
// helper must not re-read them — and must not allocate a second ephemeral
// port (the drop data's remotePort is the paired port).
Server.prototype._dropPairedConnection = function _dropPairedConnection(
  client,
  req,
  srcAddress,
  srcFamily,
  clientPort,
  bindAddr,
) {
  client._localPortEphemeral = clientPort;
  const serverSocket = new Socket({
    allowHalfOpen: this.allowHalfOpen,
    readableHighWaterMark: this.highWaterMark,
    writableHighWaterMark: this.highWaterMark,
  });
  if (req.pipe) {
    // An adopted source pipe keeps its bound path as the local endpoint
    // (Node: localAddress is the source path); a plain pipe client has
    // no local name — the destination path stands in, as before.
    const localPath = client._boundPath ?? req.path;
    client._sockname = { address: localPath };
    client._peername = { address: req.path };
    serverSocket._sockname = { address: req.path };
    serverSocket._peername = { address: localPath };
  } else {
    client._sockname = {
      address: srcAddress,
      family: srcFamily,
      port: clientPort,
    };
    client._peername = {
      address: bindAddr.address,
      family: bindAddr.family,
      port: bindAddr.port,
    };
    serverSocket._sockname = {
      address: bindAddr.address,
      family: bindAddr.family,
      port: bindAddr.port,
    };
    serverSocket._peername = {
      address: srcAddress,
      family: srcFamily,
      port: clientPort,
    };
  }
  client._peer = serverSocket;
  serverSocket._peer = client;
  client._connected = true;
  serverSocket._connected = true;
  client.connecting = false;
  client._flushPendingWrites();
  client._refreshTimeout();
  if (!serverSocket._handle) serverSocket._handle = new VirtualHandle();
  client.emit("connect");
  client.emit("ready");
  if (client.readable && !client.isPaused()) {
    client._readStarted = true;
  }
  client._refreshLoopKeeper();
  serverSocket.destroy();
};

// Pairs an incoming client with a server-side Socket (virtual accept).
Server.prototype._acceptConnection = function _acceptConnection(
  client,
  req,
  deferConnect,
) {
  const bindAddr = this._bindAddress;

  // The accept is deferred a macrotask after the client's lookup; the server
  // may have closed in between (close() nulls _bindAddress and clears
  // _listening). Refuse cleanly instead of throwing on the nulled address.
  if (!this._listening || !bindAddr) {
    client._connectFailed(client._refusedError(req));
    return;
  }

  // The client's bound source address (Node: the socket's local endpoint
  // after bind) is what the server sees as remoteAddress; the client's
  // local port is its requested localPort when one was bound.
  const srcAddress = client._bindLocalAddress || "127.0.0.1";
  const srcFamily = isIP(srcAddress) === 6 ? "IPv6" : "IPv4";

  // Server-side blockList: Node accepts the connection, then closes the
  // accepted handle — the client sees 'connect' then 'end' + 'close'
  // (hadError false), never an 'error' (probed real Node v24.22.1). That
  // is exactly the drop pairing below, minus the 'drop' event.
  if (this.blockList && !req.pipe) {
    let blocked = false;
    try {
      blocked = this.blockList.check(
        srcAddress,
        srcFamily === "IPv6" ? "ipv6" : "ipv4",
      );
    } catch {
      blocked = false;
    }
    if (blocked) {
      this._dropPairedConnection(
        client,
        req,
        srcAddress,
        srcFamily,
        client._bindLocalPort ?? allocPort(),
        bindAddr,
      );
      return;
    }
  }

  if (this.maxConnections != null && this._connections >= this.maxConnections) {
    // The ephemeral port must be allocated BEFORE building the drop data:
    // the accept path only allocates it after this check, so an early
    // remotePort read was undefined (test-net-server-drop-connections
    // asserts it truthy).
    const clientPort = client._bindLocalPort ?? allocPort();
    client._localPortEphemeral = clientPort;
    const data = {
      localAddress: bindAddr ? bindAddr.address : undefined,
      localPort: bindAddr ? bindAddr.port : undefined,
      localFamily: bindAddr ? bindAddr.family : undefined,
      remoteAddress: srcAddress,
      remotePort: clientPort,
      remoteFamily: srcFamily,
    };
    this.emit("drop", data);
    this._dropPairedConnection(
      client,
      req,
      srcAddress,
      srcFamily,
      clientPort,
      bindAddr,
    );
    return;
  }

  const serverSocket = new Socket({
    allowHalfOpen: this.allowHalfOpen,
    readableHighWaterMark: this.highWaterMark,
    writableHighWaterMark: this.highWaterMark,
  });
  if (this.pauseOnConnect) serverSocket.pause();
  serverSocket.setNoDelay(this.noDelay);
  if (this.keepAlive)
    serverSocket.setKeepAlive(true, this.keepAliveInitialDelay * 1000);

  const clientPort = client._bindLocalPort ?? allocPort();
  client._localPortEphemeral = clientPort;

  if (req.pipe) {
    // An adopted source pipe keeps its bound path as the local endpoint
    // (Node: localAddress is the source path); a plain pipe client has
    // no local name — the destination path stands in, as before.
    const localPath = client._boundPath ?? req.path;
    client._sockname = { address: localPath };
    client._peername = { address: req.path };
    serverSocket._sockname = { address: req.path };
    serverSocket._peername = { address: localPath };
  } else {
    client._sockname = {
      address: srcAddress,
      family: srcFamily,
      port: clientPort,
    };
    client._peername = {
      address: bindAddr.address,
      family: bindAddr.family,
      port: bindAddr.port,
    };
    serverSocket._sockname = {
      address: bindAddr.address,
      family: bindAddr.family,
      port: bindAddr.port,
    };
    serverSocket._peername = {
      address: srcAddress,
      family: srcFamily,
      port: clientPort,
    };
  }

  client._peer = serverSocket;
  serverSocket._peer = client;
  client._connected = true;
  serverSocket._connected = true;
  serverSocket._server = this;
  serverSocket.server = this;

  client._peer = serverSocket;
  serverSocket._peer = client;
  client._connected = true;
  serverSocket._connected = true;
  serverSocket._server = this;
  serverSocket.server = this;
  serverSocket._keepLoopAlive();

  this._connections++;

  this.emit("connection", serverSocket);

  // Server-side socket gets a handle too (Node creates TCPWrap on accept).
  if (!serverSocket._handle) serverSocket._handle = new VirtualHandle();
  // The client-side 'connect' is the handshake completion: pre-connect
  // writes flush, options apply, and 'connect' + 'ready' fire here. In a
  // burst the drain defers this tail for every accept after the first, so
  // a microtask can run between two clients' 'connect' events (a listener
  // registered while awaiting the first must not miss the second), while
  // the server-side accepts all complete in the batch
  // (test-https-agent-sni). The drop path above keeps its synchronous
  // connect-then-destroy (atomic by design); only the normal tail defers.
  const emitClientConnect = () => {
    client.connecting = false;
    client._flushPendingWrites();
    client._refreshTimeout();
    // Mirrors lib/net.js: apply socket options to the handle on connect.
    // The handle may have been mocked by tests (e.g. test-net-connect-keepalive
    // replaces _handle.setKeepAlive to verify it's called).
    // Node's C++ TCPWrap takes keepalive delay in SECONDS; the JS API takes
    // milliseconds — convert here (tests assert the converted value).
    if (client._handle) {
      if (client._noDelay) client._handle.setNoDelay(true);
      if (client._keepAlive)
        client._handle.setKeepAlive(
          true,
          Math.floor(client._keepAliveInitialDelay / 1000),
        );
    }
    client.emit("connect");
    // Real Node emits 'ready' immediately after 'connect' on a client socket
    // (probed on v24.22.1: order is connect -> ready, exactly once, readyState
    // 'open' at both; a listener registered inside the 'connect' handler still
    // fires; refused and never-connected sockets never fire it). Server-side
    // accepted sockets do not observably emit 'ready' after 'connection', so
    // only the client side gets it here.
    client.emit("ready");
    // Mirrors lib/net.js: start the first read after connect, unless paused.
    // A paused socket never activates its read watcher (inactive handle).
    // Call read(0) rather than just setting the flag: the first read()
    // clears the readable state's sync guard, so a response that arrives
    // in the same tick chain emits 'data' synchronously (addChunk's
    // sync-emit path) instead of buffering it a tick — otherwise a server
    // that finishes and destroys the socket in that tick beats the
    // client's reply to the response (test-http-server-unconsume: the
    // deferred burst items' connects ran a macrotask after the drain, so
    // their resume nextTick had not run when the response arrived). On
    // real Node the read watcher is already active at 'connect' (libuv
    // readStart), so the sync guard is always clear by the time network
    // data can arrive; the virtual transport has no such RTT. _read is
    // trivial (sets _readStarted, engages the loop keeper), and push
    // clears the reading flag, so later reads are unaffected.
    if (client.readable && !client.isPaused()) {
      client.read(0);
    }
    client._refreshLoopKeeper();
  };
  if (deferConnect) defer(emitClientConnect);
  else emitClientConnect();
};

Server.prototype._emitCloseIfDrained = function _emitCloseIfDrained() {
  if (this._listening || this._bindPending || this._connections > 0) return;
  this._releaseLoop();
  nextTick(() => this.emit("close"));
};

Server.prototype.close = function close(cb) {
  if (typeof cb === "function") {
    if (!this._listening && !this._bindPending) {
      // Never listening: 'close' still fires; the callback gets
      // ERR_SERVER_NOT_RUNNING (mirrors lib/net.js).
      this.once("close", () => cb(errServerNotRunning()));
    } else {
      this.once("close", cb);
    }
  }

  if (this._listening || this._bindPending) {
    if (this._bindAddress) {
      // Only release the registry slot this server owns: with
      // SO_REUSEPORT two servers share one key and the first entry stays
      // for routing.
      if (this._pipeName) {
        if (_pipeServers().get(this._pipeName) === this)
          _pipeServers().delete(this._pipeName);
      } else if (
        _tcpServers().get(
          serverKey(this._bindAddress.address, this._bindAddress.port),
        ) === this
      ) {
        _tcpServers().delete(
          serverKey(this._bindAddress.address, this._bindAddress.port),
        );
      }
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
  if (typeof cb !== "function") throw errInvalidArgType("cb", "function", cb);
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
  // Pass the normalized tuple itself, matching real Node's internal
  // call shape: Socket.prototype.connect receives one array argument
  // whose [0] is the options object (and unpacks it via normalizeArgs).
  // Passing (options, cb) instead would break monkeypatched connect
  // implementations that read args[0].noDelay (test-http-nodelay).
  return socket.connect(normalized);
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
  validateObject(options, "options");
  if (options.path !== undefined) {
    this._bindPipe(options);
    return;
  }
  const port = validatePort(options.port ?? 0, "options.port");
  const ipv6Only = options.ipv6Only ?? false;
  validateBoolean(ipv6Only, "options.ipv6Only");
  const reusePort = options.reusePort ?? false;
  validateBoolean(reusePort, "options.reusePort");
  // No DNS: a non-IP host throws (Node lib/net.js BoundSocket).
  let host = options.host;
  let address;
  let family;
  if (host === undefined || host === null) {
    host = ipv6Only ? "::" : "0.0.0.0";
    address = host;
    family = ipv6Only ? "IPv6" : "IPv4";
  } else {
    validateString(host, "options.host");
    const type = isIP(host);
    if (type === 0) {
      throw errInvalidArgValue(
        "options.host",
        host,
        "must be a numeric IP address; net.BoundSocket does not perform DNS resolution",
      );
    }
    address = host;
    family = type === 6 ? "IPv6" : "IPv4";
  }
  // The virtual layer has no real interfaces: only loopback and the
  // wildcards are bindable; anything else is EADDRNOTAVAIL (Node binds a
  // local interface address, which cannot exist here). Ceiling: a test
  // binding the machine's real LAN IP cannot pass — no such test exists.
  if (
    !isLoopbackAddress(address) &&
    address !== "0.0.0.0" &&
    address !== "::"
  ) {
    throw errnoError("EADDRNOTAVAIL", "bind", `bind EADDRNOTAVAIL ${address}`, {
      errno: -99,
      address,
      port,
    });
  }
  if (
    port !== 0 &&
    port < 1024 &&
    typeof process !== "undefined" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0
  ) {
    throw errnoError("EACCES", "bind", `bind EACCES ${address}:${port}`, {
      errno: -13,
      address,
      port,
    });
  }
  // Port 0 allocates from the shared ephemeral pool (same pool as
  // listen(0)). A live listener on an explicit port conflicts
  // (EADDRINUSE); role-neutral binds coexist, so no registry of TCP
  // BoundSockets is kept.
  const actualPort = port === 0 ? allocPort() : port;
  if (port !== 0 && _tcpListenerConflicts(address, family, port)) {
    throw errnoError(
      "EADDRINUSE",
      "bind",
      `bind EADDRINUSE ${address}:${port}`,
      { errno: -98, address, port },
    );
  }
  this._port = actualPort;
  this._host = address;
  this._ipv6Only = ipv6Only;
  this._reusePort = reusePort;
  this._address = { address, family, port: actualPort };
}
// Bind a named unix-domain socket (or Windows named pipe). A leading '\0'
// selects the Linux abstract namespace. Path is mutually exclusive with
// the TCP options; conflicts and filesystem errors throw synchronously
// (Node lib/net.js BoundSocket #bindPipe; libuv maps a missing parent
// directory's ENOENT to EACCES, and an over-long path to EINVAL).
BoundSocket.prototype._bindPipe = function _bindPipe(options) {
  const { path, host, port, ipv6Only, reusePort } = options;
  if (
    host !== undefined ||
    port !== undefined ||
    ipv6Only !== undefined ||
    reusePort !== undefined
  ) {
    throw errInvalidArgValue(
      "options",
      options,
      "path is mutually exclusive with host, port, ipv6Only, and reusePort",
    );
  }
  validateString(path, "options.path");
  const isAbstract = path[0] === "\0";
  // Node: abstract socket paths are only supported on Linux.
  if (isAbstract && !_isLinux) {
    throw errInvalidArgValue(
      "options.path",
      path,
      "abstract socket paths are only supported on Linux",
    );
  }
  // sun_path is 108 bytes on Linux (107 usable); libuv binds with
  // UV_PIPE_NO_TRUNCATE, so an over-long path is EINVAL, not truncation.
  if (path.length > 107) {
    throw errnoError("EINVAL", "bind", `bind EINVAL ${path}`, {
      errno: -22,
      path,
    });
  }
  if (!isAbstract) {
    // Parent directory must exist in the filesystem this runtime sees
    // (real disk in the parity harness, memfs in the browser).
    const slash = path.lastIndexOf("/");
    const parent = slash > 0 ? path.slice(0, slash) : slash === 0 ? "/" : "";
    if (parent !== "" && !fsExistsSync(parent)) {
      throw errnoError("EACCES", "bind", `bind EACCES ${path}`, {
        errno: -13,
        path,
      });
    }
  }
  if (_boundPipes().has(path) || _pipeServers().has(path)) {
    throw errnoError("EADDRINUSE", "bind", `bind EADDRINUSE ${path}`, {
      errno: -98,
      path,
    });
  }
  _boundPipes().set(path, this);
  this._path = path;
  this._address = path;
};
BoundSocket.prototype.address = function address() {
  if (this._adopted || this._closed) throw errSocketHandleAdopted();
  if (this._path !== undefined) return this._path;
  const { address, family, port } = this._address;
  return { address, family, port };
};
// Reports whether this is a pipe (unix-domain) bind rather than TCP. Its
// mere presence on the prototype ('isPipe' in net.BoundSocket.prototype)
// is the capability signal that this build honors { path }.
Object.defineProperty(BoundSocket.prototype, "isPipe", {
  get() {
    return this._path !== undefined;
  },
  enumerable: true,
  configurable: true,
});
BoundSocket.prototype.fd = function fd() {
  if (this._adopted || this._closed) throw errSocketHandleAdopted();
  if (_isWindows) return -1;
  if (this._fd === undefined) this._fd = nextVirtualFd++;
  return this._fd;
};
BoundSocket.prototype.close = function close() {
  if (this._adopted || this._closed) throw errSocketHandleAdopted();
  this._closed = true;
  if (this._path !== undefined) _boundPipes().delete(this._path);
  return undefined;
};
// Internal: transfer ownership to exactly one Server (server.listen) or
// Socket (new Socket({ handle })). After this, address()/fd()/close()
// throw ERR_SOCKET_HANDLE_ADOPTED (Node [kBoundSocketConsume]).
BoundSocket.prototype._consume = function _consume() {
  if (this._adopted || this._closed) throw errSocketHandleAdopted();
  this._adopted = true;
  if (this._path !== undefined) _boundPipes().delete(this._path);
};

// _createServerHandle — compat export; returns a virtual bound endpoint.
function _createServerHandle(...args) {
  const normalized = normalizeArgs(args);
  const options = normalized[0];
  if (options.path) return new BoundSocket({ path: options.path });
  return new BoundSocket({
    port: options.port ?? 0,
    host: options.host,
    ipv6Only: !!options.ipv6Only,
  });
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
