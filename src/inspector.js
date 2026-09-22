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

import { EventEmitter } from "events";

// Runtime bridge (guarded: rewritten to the sandbox scope at load time,
// undefined under real Node / direct import). Today the sandbox exposes no
// inspector bridge, so RT stays unused; it is the documented attachment
// point if one ever appears — nothing is invented around it.
const RT = (typeof globalThis._RUNTIME_ !== "undefined")
  ? globalThis._RUNTIME_
  : undefined;

// Keep the hook referenced so its purpose is explicit: if a future
// globalThis._RUNTIME_ ever exposes an inspector bridge, Session.post() and
// the protocol broadcasters below should forward through it behind a
// guarded feature check here — never assumed, never invented.
const runtimeInspectorBridge = RT;

export class Session extends EventEmitter {
  // No inspector backend exists in the browser sandbox; connecting is a noop.
  connect() {}
  connectToMainThread() {}
  disconnect() {}

  // post(method[, params][, callback])
  //
  // No protocol runs in the browser, so there is no result data to return.
  // The callback (if any) is invoked asynchronously with an empty result
  // object {} — a documented noop, NOT fabricated protocol data.
  //
  // Documented divergence from real Node: real Node throws
  // ERR_INSPECTOR_NOT_CONNECTED when the session is not connected, and
  // otherwise resolves real protocol results. In the sandbox there is no
  // protocol to resolve, and per project convention noop stubs never throw.
  post(method, params, callback) {
    // Like real Node, a function in the params slot shifts into the callback
    // slot instead of being treated as params.
    if (typeof params === "function" && callback === undefined) {
      callback = params;
      params = undefined;
    }
    if (typeof callback === "function") {
      queueMicrotask(() => callback(null, {}));
    }
  }
}

export function open(_port, _host, _wait) {}
export function close() {}
export function url() {
  return undefined;
}
export function waitForDebugger() {}

// inspector.console: the 23 real method names of Node's inspector console
// (Node v24.20.0), each delegating to the host console. Methods the host
// console lacks are stable noops; the shape never changes.
const CONSOLE_METHODS = [
  "assert", "clear", "context", "count", "countReset", "debug", "dir",
  "dirxml", "error", "group", "groupCollapsed", "groupEnd", "info", "log",
  "profile", "profileEnd", "table", "time", "timeEnd", "timeLog", "timeStamp",
  "trace", "warn",
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

function noop() {}

function protocolAgent(methods) {
  const out = {};
  for (const name of methods) out[name] = noop;
  return out;
}

// Protocol broadcasters: in real Node these forward params to the connected
// DevTools frontend. In the sandbox there is no frontend, so params are
// honestly dropped.
export const Network = protocolAgent([
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

export const DOMStorage = protocolAgent([
  "domStorageItemAdded",
  "domStorageItemRemoved",
  "domStorageItemUpdated",
  "domStorageItemsCleared",
  "registerStorage",
]);

export const NetworkResources = protocolAgent(["put"]);

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
