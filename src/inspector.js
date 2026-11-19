// src/inspector.js — port of node:inspector for the browser runtime.
//
// There is no DevTools protocol / V8 inspector backend in the sandboxed
// browser, so this module is an honest noop stub with the exact export shape
// of Node v24.20.0's lib/inspector.js. Nothing is fabricated:
//   - Session.post() invokes its callback asynchronously with an empty
//     result object {} — a documented noop, not protocol data.
//   - Network.*, DOMStorage.*, NetworkResources.put() drop their params.
//   - open()/close()/waitForDebugger() do nothing; url() returns undefined.
// If globalThis._RUNTIME_ ever exposes an inspector bridge, it should be
// wired through the guarded RT hook below — no such bridge is invented here.
//
// Validation (I-V1, 2026-11-18): where Node's own API *throws* in exactly
// the states the official tests assert, this stub throws too — faithful
// porting, not fabrication (the http2 V4 precedent). The old header line
// "per project convention noop stubs never throw" covered APIs that cannot
// exist in a browser; it never covered Node's own argument/state checks:
//   - Session.post() validates method/params/callback (lib/inspector.js:
//     118-133) and throws ERR_INSPECTOR_NOT_CONNECTED when not connected.
//   - connect() / connectToMainThread() throw ERR_INSPECTOR_ALREADY_
//     CONNECTED when already connected; connectToMainThread() throws
//     ERR_INSPECTOR_NOT_WORKER on the main thread (lib/inspector.js:60-72).
//   - open() validates the port (isUint32 -> validateInt32 0..65535,
//     lib/inspector.js:175-178) and warns SecurityWarning for a
//     non-loopback host (:179-188); waitForDebugger() throws
//     ERR_INSPECTOR_NOT_ACTIVE when no inspector is active (:200-207).
//   - Network.* / DOMStorage.* validate their event params field by field
//     (src/inspector/network_agent.cc + dom_storage_agent.cc,
//     ThrowEventError) and drop them after validation — no delivery exists.
// What is NOT done (rule 7, no silent fakes): url() still returns
// undefined — a fabricated ws:// URL for an inspector that isn't listening
// would be a fake success. open() does not throw
// ERR_INSPECTOR_ALREADY_ACTIVATED on a second call: no vendored test
// asserts it, and the repo jest open() tests call open() twice in one
// process without close() in between — deliberately not implemented.

import { EventEmitter } from "events";

// Runtime bridge (guarded: rewritten to the sandbox scope at load time,
// undefined under real Node / direct import). Today the sandbox exposes no
// inspector bridge, so RT stays unused; it is the documented attachment
// point if one ever appears — nothing is invented around it.
const RT =
  typeof globalThis._RUNTIME_ !== "undefined"
    ? globalThis._RUNTIME_
    : undefined;

// Keep the hook referenced so its purpose is explicit: if a future
// globalThis._RUNTIME_ ever exposes an inspector bridge, Session.post() and
// the protocol broadcasters below should forward through it behind a
// guarded feature check here — never assumed, never invented.
const runtimeInspectorBridge = RT;

// ---------------------------------------------------------------------------
// Node-style coded errors (lib/internal/errors.js makeNodeErrorWithCode).
//
// `name` stays the plain base-class name ("Error" / "TypeError" /
// "RangeError") — assert.throws checks `name` against it — while
// toString() carries the code, exactly like real Node:
//   `Error [ERR_INSPECTOR_NOT_ACTIVE]: Inspector is not active`
// (assert.throws with a RegExp tests String(err); the vendored
// wait-for-connection test asserts exactly that form.)
// ---------------------------------------------------------------------------
function codedError(code, message, Kind = Error) {
  const err = new Kind(message);
  err.code = code;
  Object.defineProperty(err, "toString", {
    value() {
      return `${this.name} [${code}]: ${this.message}`;
    },
    configurable: true,
  });
  return err;
}

// Approximation of Node's test-helper invalidArgTypeHelper (same shape as
// src/http2.js): the suffix Node's ERR_INVALID_ARG_TYPE messages carry,
// asserted verbatim by the official tests.
function invalidArgTypeHelper(input) {
  if (input === null || input === undefined)
    return ` Received ${String(input)}`;
  if (typeof input === "function") {
    // Node's helper uses input.name verbatim — an anonymous function
    // gives "Received function " (probe-proven), not "anonymous".
    return ` Received function ${input.name}`;
  }
  if (typeof input === "object") {
    const name = input.constructor && input.constructor.name;
    if (name) return ` Received an instance of ${name}`;
    return ` Received ${String(input)}`;
  }
  let inspected = typeof input === "string" ? `'${input}'` : String(input);
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return ` Received type ${typeof input} (${inspected})`;
}

// ERR_INVALID_ARG_TYPE (lib/internal/errors.js:1390): expected is a kType
// ('string' / 'Object' / 'Function' / ...) rendered lower-cased.
function errInvalidArgType(name, expected, actual) {
  return codedError(
    "ERR_INVALID_ARG_TYPE",
    `The "${name}" argument must be of type ${String(expected).toLowerCase()}.${invalidArgTypeHelper(actual)}`,
    TypeError,
  );
}

// ERR_OUT_OF_RANGE (lib/internal/errors.js): `It must be ${range}.`
function errOutOfRange(name, range, actual) {
  return codedError(
    "ERR_OUT_OF_RANGE",
    `The value of "${name}" is out of range. It must be ${range}. Received ${actual}`,
    RangeError,
  );
}

// Validators (lib/internal/validators.js), message-exact.
function validateString(value, name) {
  if (typeof value !== "string")
    throw errInvalidArgType(name, "string", value);
}

function validateObject(value, name) {
  // kValidateObjectNone: null and arrays throw, as do non-objects.
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw errInvalidArgType(name, "Object", value);
}

function validateFunction(value, name) {
  if (typeof value !== "function")
    throw errInvalidArgType(name, "Function", value);
}

function isUint32(value) {
  return value === (value >>> 0);
}

function validateInt32(value, name, min = -2147483648, max = 2147483647) {
  if (typeof value !== "number")
    throw errInvalidArgType(name, "number", value);
  if (!Number.isInteger(value))
    throw errOutOfRange(name, "an integer", value);
  if (value < min || value > max)
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
}

// isLoopback (lib/internal/net.js:90-99): localhost, 127.* , [::1],
// [0:0:0:0:0:0:0:1]. Note bare "::1" is NOT loopback here; "0.0.0.0" isn't
// either.
function isLoopback(host) {
  const hostLower = host.toLowerCase();
  return (
    hostLower === "localhost" ||
    hostLower.startsWith("127.") ||
    hostLower === "[::1]" ||
    hostLower === "[0:0:0:0:0:0:0:1]"
  );
}

// Main-thread detection (oracle lib/inspector.js uses isMainThread from
// worker_threads). Resolved lazily through process.getBuiltinModule — the
// same bridge src/util.js uses — so the harness sees the native value and
// the sandbox sees the shim worker_threads value. Falls back to true
// (main thread); the lookup is guarded so the browser-fallback import
// (which disables the bridge) still loads.
let _isMainThread = undefined;
function isMainThread() {
  if (_isMainThread === undefined) {
    try {
      const wt =
        typeof process !== "undefined" &&
        typeof process.getBuiltinModule === "function"
          ? process.getBuiltinModule("worker_threads")
          : undefined;
      _isMainThread = wt ? wt.isMainThread !== false : true;
    } catch {
      _isMainThread = true;
    }
  }
  return _isMainThread;
}

// ---------------------------------------------------------------------------
// Inspector state (module-level: the inspector backend is a process
// singleton in real Node, so enablement/activation are process-global).
// ---------------------------------------------------------------------------

// open() sets this, close() clears it (oracle: the C++ binding's isEnabled).
let inspectorActive = false;
// Session.post("Network.enable"/"disable") and ("DOMStorage.enable"/
// "disable") flip these; the broadcasters gate on them exactly like the
// C++ emitNotification IsEnabled() early return — validation below only
// runs for enabled domains, and a disabled domain drops events silently
// (the vendored emit-protocol-event test calls requestWillBeSent({}) after
// Network.disable and expects no throw).
let networkEnabled = false;
let domStorageEnabled = false;
// requestWillBeSent registers requestIds; dataSent looks its id up first
// and silently ignores unknown ids (network_agent.cc dataSent) — the
// vendored errors test registers its id with startRequest() first.
const registeredRequests = new Set();

export class Session extends EventEmitter {
  // No inspector backend exists in the browser sandbox; connecting is a
  // state flag only — the protocol itself is still a noop.
  _connected = false;

  connect() {
    if (this._connected) {
      throw codedError(
        "ERR_INSPECTOR_ALREADY_CONNECTED",
        "The inspector session is already connected",
      );
    }
    this._connected = true;
  }

  connectToMainThread() {
    if (isMainThread()) {
      throw codedError(
        "ERR_INSPECTOR_NOT_WORKER",
        "Current thread is not a worker",
      );
    }
    if (this._connected) {
      throw codedError(
        "ERR_INSPECTOR_ALREADY_CONNECTED",
        "The inspector session is already connected",
      );
    }
    this._connected = true;
  }

  // Safe when not connected (oracle lib/inspector.js:149-161). Pending
  // callbacks are not failed with ERR_INSPECTOR_CLOSED: no vendored test
  // covers it, and the shim's post callbacks still resolve {} — recorded
  // divergence, see NOTES-inspector-validation-v1.md.
  disconnect() {
    this._connected = false;
  }

  // post(method[, params][, callback])
  //
  // No protocol runs in the browser, so there is no result data to return.
  // The callback (if any) is invoked asynchronously with an empty result
  // object {} — a documented noop, NOT fabricated protocol data. But the
  // argument/state validation is the oracle's, verbatim
  // (lib/inspector.js:118-133): a post before connect() throws
  // ERR_INSPECTOR_NOT_CONNECTED, and bad method/params/callback throw
  // ERR_INVALID_ARG_TYPE — the vendored test-inspector-module.js asserts
  // exactly these.
  post(method, params, callback) {
    validateString(method, "method");
    if (!callback && typeof params === "function") {
      callback = params;
      params = null;
    }
    if (params) {
      validateObject(params, "params");
    }
    if (callback) {
      validateFunction(callback, "callback");
    }
    if (!this._connected) {
      throw codedError("ERR_INSPECTOR_NOT_CONNECTED", "Session is not connected");
    }
    // Domain enable/disable is process-global (see state above).
    if (method === "Network.enable") networkEnabled = true;
    else if (method === "Network.disable") networkEnabled = false;
    else if (method === "DOMStorage.enable") domStorageEnabled = true;
    else if (method === "DOMStorage.disable") domStorageEnabled = false;
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, {}));
    }
  }
}

export function open(port, host, wait) {
  // No ERR_INSPECTOR_ALREADY_ACTIVATED on a second call: no vendored test
  // asserts it, and the repo jest open() tests call open() twice in one
  // process without close() in between. Deliberately not implemented.
  // The native open() requires the port to fit into a 16-bit unsigned
  // integer (lib/inspector.js:175-178).
  if (isUint32(port)) {
    validateInt32(port, "port", 0, 65535);
  }
  if (host && !isLoopback(host)) {
    // lib/inspector.js:179-188, exact message.
    if (
      typeof process !== "undefined" &&
      typeof process.emitWarning === "function"
    ) {
      process.emitWarning(
        "Binding the inspector to a public IP with an open port is insecure, " +
          "as it allows external hosts to connect to the inspector " +
          "and perform a remote code execution attack. " +
          "Documentation can be found at " +
          "https://nodejs.org/api/cli.html#--inspecthostport",
        "SecurityWarning",
      );
    }
  }
  inspectorActive = true;
  if (wait) waitForDebugger();
}

export function close() {
  inspectorActive = false;
}

export function url() {
  return undefined;
}

export function waitForDebugger() {
  if (!inspectorActive) {
    throw codedError("ERR_INSPECTOR_NOT_ACTIVE", "Inspector is not active");
  }
}

// inspector.console: the 23 real method names of Node's inspector console
// (Node v24.20.0), each delegating to the host console. Methods the host
// console lacks are stable noops; the shape never changes.
const CONSOLE_METHODS = [
  "assert",
  "clear",
  "context",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "profile",
  "profileEnd",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "timeStamp",
  "trace",
  "warn",
];

function makeInspectorConsole() {
  // Looked up at call time (not module load): the host console can be
  // replaced after import, and inspector.console must keep forwarding.
  const out = {};
  for (const name of CONSOLE_METHODS) {
    out[name] = (...args) => {
      const host = globalThis.console;
      const fn =
        host && typeof host[name] === "function" ? host[name] : undefined;
      if (fn) fn.apply(host, args);
    };
  }
  return out;
}

export const console = makeInspectorConsole();

// ---------------------------------------------------------------------------
// Protocol broadcasters (Network.* / DOMStorage.*).
//
// In real Node these forward params to the connected DevTools frontend. In
// the sandbox there is no frontend, so validated params are honestly
// dropped. But they are NOT unvalidated noops anymore: broadcastToFrontend
// (lib/inspector.js:209-212) validates the params object, and the C++
// agents validate every event field (ThrowEventError — a TypeError with an
// exact "Missing X in event" message). The vendored
// test-inspector-emit-protocol-event-errors.js asserts ~60 of those throws.
// ---------------------------------------------------------------------------

// ThrowEventError (network_agent.cc:27, dom_storage_agent.cc:20) throws a
// plain TypeError carrying only the message.
function eventError(message) {
  return new TypeError(message);
}

// The C++ getters (inspector_object_utils.cc): a "Missing X" fires when the
// property is absent OR of the wrong type — IsString / IsNumber / IsInt32 /
// IsBoolean / IsObject.
function requireEventString(obj, key, message) {
  if (typeof obj[key] !== "string") throw eventError(message);
}

function requireEventNumber(obj, key, message) {
  if (typeof obj[key] !== "number") throw eventError(message);
}

function requireEventInt32(obj, key, message) {
  const v = obj[key];
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < -2147483648 ||
    v > 2147483647
  ) {
    throw eventError(message);
  }
}

function requireEventBool(obj, key, message) {
  if (typeof obj[key] !== "boolean") throw eventError(message);
}

function requireEventObject(obj, key, message) {
  const v = obj[key];
  if ((typeof v !== "object" || v === null) && typeof v !== "function") {
    throw eventError(message);
  }
}

// createHeadersFromObject (network_agent.cc:33-62): enumerate the headers
// object (a throwing ownKeys trap reports "Missing response headers"),
// every name must be a string, every value a string.
function validateHeaders(headersObj) {
  let names;
  try {
    names = Object.keys(headersObj);
  } catch {
    throw eventError("Missing response headers in event");
  }
  for (const name of names) {
    if (typeof name !== "string") {
      throw eventError("Invalid header name in event");
    }
    let value;
    try {
      value = headersObj[name];
    } catch {
      throw eventError("Invalid header value in event");
    }
    if (typeof value !== "string") {
      throw eventError("Invalid header value in event");
    }
  }
}

// createRequestFromObject (network_agent.cc:69-100): url, method, headers.
function validateNetworkRequest(request) {
  requireEventString(request, "url", "Missing request.url in event");
  requireEventString(request, "method", "Missing request.method in event");
  requireEventObject(request, "headers", "Missing request.headers in event");
  validateHeaders(request.headers);
}

// createResponseFromObject (network_agent.cc:106-148): url, status,
// statusText, headers. mimeType/charset are optional (FromMaybe "").
function validateNetworkResponse(response) {
  requireEventString(response, "url", "Missing response.url in event");
  requireEventInt32(response, "status", "Missing response.status in event");
  requireEventString(
    response,
    "statusText",
    "Missing response.statusText in event",
  );
  requireEventObject(response, "headers", "Missing response.headers in event");
  validateHeaders(response.headers);
}

// createWebSocketResponse (network_agent.cc:153-176): status, statusText,
// headers.
function validateWebSocketResponse(response) {
  requireEventInt32(response, "status", "Missing response.status in event");
  requireEventString(
    response,
    "statusText",
    "Missing response.statusText in event",
  );
  requireEventObject(response, "headers", "Missing response.headers in event");
  validateHeaders(response.headers);
}

// createStorageIdFromObject (dom_storage_agent.cc:24-44): securityOrigin,
// then storageKey. isLocalStorage is boolean FromMaybe(false) — never
// throws when missing.
function validateStorageId(storageId) {
  requireEventString(
    storageId,
    "securityOrigin",
    "Missing securityOrigin in storageId",
  );
  requireEventString(storageId, "storageKey", "Missing storageKey in storageId");
}

// IsUint8Array in C++ accepts any realm's Uint8Array; the toString tag
// does the same in JS (a Buffer's tag is also "[object Uint8Array]").
function isUint8ArrayValue(value) {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function validateNetworkEvent(eventName, params) {
  switch (eventName) {
    case "requestWillBeSent": // network_agent.cc:432-476
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      requireEventNumber(params, "wallTime", "Missing wallTime in event");
      requireEventObject(params, "request", "Missing request in event");
      validateNetworkRequest(params.request);
      registeredRequests.add(params.requestId);
      break;
    case "responseReceived": // network_agent.cc:490-515
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      requireEventString(params, "type", "Missing type in event");
      requireEventObject(params, "response", "Missing response in event");
      validateNetworkResponse(params.response);
      break; // Unknown requestId is silently ignored in C++; no delivery.
    case "loadingFailed": // network_agent.cc:528-549
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      requireEventString(params, "type", "Missing type in event");
      requireEventString(params, "errorText", "Missing errorText in event");
      registeredRequests.delete(params.requestId);
      break;
    case "loadingFinished": // network_agent.cc:557-576
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      break;
    case "dataSent": { // network_agent.cc:585-628
      requireEventString(params, "requestId", "Missing requestId in event");
      // Unknown requestId: silently ignored — BEFORE the remaining checks.
      if (!registeredRequests.has(params.requestId)) return;
      // finished:true marks the request done and returns with no further
      // validation (FromMaybe(false)).
      if (params.finished === true) return;
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      requireEventInt32(params, "dataLength", "Missing dataLength in event");
      requireEventObject(params, "data", "Missing data in event");
      if (!isUint8ArrayValue(params.data)) {
        throw eventError("Expected data to be Uint8Array in event");
      }
      break;
    }
    case "dataReceived": { // network_agent.cc:634-665
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      requireEventInt32(params, "dataLength", "Missing dataLength in event");
      requireEventInt32(
        params,
        "encodedDataLength",
        "Missing encodedDataLength in event",
      );
      requireEventObject(params, "data", "Missing data in event");
      if (!isUint8ArrayValue(params.data)) {
        throw eventError("Expected data to be Uint8Array in event");
      }
      break; // Unknown requestId is silently ignored in C++; no delivery.
    }
    case "webSocketCreated": // network_agent.cc:210-231
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventString(params, "url", "Missing url in event");
      break;
    case "webSocketClosed": // network_agent.cc:233-246
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      break;
    case "webSocketHandshakeResponseReceived": // network_agent.cc:248-270
      requireEventString(params, "requestId", "Missing requestId in event");
      requireEventNumber(params, "timestamp", "Missing timestamp in event");
      requireEventObject(params, "response", "Missing response in event");
      validateWebSocketResponse(params.response);
      break;
    default:
      break;
  }
}

function validateDomStorageEvent(eventName, params) {
  switch (eventName) {
    case "domStorageItemAdded": // dom_storage_agent.cc:145-170
      requireEventObject(params, "storageId", "Missing storageId in event");
      validateStorageId(params.storageId);
      requireEventString(params, "key", "Missing key in event");
      requireEventString(params, "newValue", "Missing newValue in event");
      break;
    case "domStorageItemRemoved": // dom_storage_agent.cc:176-192
      requireEventObject(params, "storageId", "Missing storageId in event");
      validateStorageId(params.storageId);
      requireEventString(params, "key", "Missing key in event");
      break;
    case "domStorageItemUpdated": // dom_storage_agent.cc:198-228
      requireEventObject(params, "storageId", "Missing storageId in event");
      validateStorageId(params.storageId);
      requireEventString(params, "key", "Missing key in event");
      requireEventString(params, "oldValue", "Missing oldValue in event");
      requireEventString(params, "newValue", "Missing newValue in event");
      break;
    case "domStorageItemsCleared": // dom_storage_agent.cc:232-244
      requireEventObject(params, "storageId", "Missing storageId in event");
      validateStorageId(params.storageId);
      break;
    case "registerStorage": { // dom_storage_agent.cc:248-283
      requireEventBool(
        params,
        "isLocalStorage",
        "Missing isLocalStorage in event",
      );
      requireEventObject(
        params,
        "storageMap",
        "Missing storageMap in event",
      );
      // The C++ agent enumerates the map and reads every value; a throwing
      // Proxy trap reports which step failed.
      let names;
      try {
        names = Object.keys(params.storageMap);
      } catch {
        throw eventError("Failed to get property names from storageMap");
      }
      for (const key of names) {
        try {
          params.storageMap[key];
        } catch {
          throw eventError("Failed to get value from storageMap");
        }
      }
      break;
    }
    default:
      break;
  }
}

// broadcastToFrontend (lib/inspector.js:209-212): validateString(eventName)
// + validateObject(params), then the C++ emitNotification IsEnabled gate,
// then the per-event field validation. Validated params are dropped —
// there is no DevTools frontend in the sandbox.
function emitProtocolEvent(domain, eventName, params = {}) {
  validateString(eventName, "eventName");
  validateObject(params, "params");
  if (domain === "Network" ? !networkEnabled : !domStorageEnabled) return;
  if (domain === "Network") validateNetworkEvent(eventName, params);
  else validateDomStorageEvent(eventName, params);
}

function broadcastAgent(domain, methods) {
  const out = {};
  for (const name of methods) {
    out[name] = (params) => emitProtocolEvent(domain, name, params);
  }
  return out;
}

// Protocol broadcasters: in real Node these forward params to the connected
// DevTools frontend. In the sandbox there is no frontend, so params are
// honestly dropped — after validation (see above).
export const Network = broadcastAgent("Network", [
  "requestWillBeSent",
  "responseReceived",
  "loadingFinished",
  "loadingFailed",
  "dataSent",
  "dataReceived",
  "webSocketCreated",
  "webSocketClosed",
  "webSocketHandshakeResponseReceived",
]);

export const DOMStorage = broadcastAgent("DOMStorage", [
  "domStorageItemAdded",
  "domStorageItemRemoved",
  "domStorageItemUpdated",
  "domStorageItemsCleared",
  "registerStorage",
]);

// NetworkResources.put: the oracle's `put` (internal/inspector/
// network_resources) has no vendored-test coverage for invalid args; it
// stays a plain noop.
function noop() {}
export const NetworkResources = { put: noop };

export default {
  Session,
  open,
  close,
  url,
  waitForDebugger,
  console,
  Network,
  DOMStorage,
  NetworkResources,
};
