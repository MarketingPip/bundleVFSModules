#!/usr/bin/env node
// parity/headless/vm-sandbox.mjs — run the REAL sandbox template in
// node:vm instead of an iframe.
//
// The template (SANDBOX_TEMPLATE via SandboxRuntime.generate()) is authored
// for a browser iframe: it talks to the host through window.parent.postMessage
// and window.addEventListener('message'), and touches a handful of browser
// globals (document.createElement, Element, navigator.sendBeacon, ...).
// This module provides the minimal browser-global surface those sections
// need and routes the postMessage protocol to a host callback — the same
// message types the iframe path uses (interop_call / interop_response /
// interop_registered / interop_invoke / interop_result / function_results /
// function_error / sandbox_ready), so the host side of the protocol is
// exercised faithfully; only the transport differs (structured-clone hop
// instead of a real postMessage).
//
// Modules the sandbox loads go through the sandbox-side loadModule, which
// evaluates them via dynamic import() of data:text/javascript URLs. Under
// node:vm that needs vm.SourceTextModule with an importModuleDynamically
// hook; nested data: URL modules are compiled in the same context.
//
// Non-goal: emulating browser layout, CSS, or the DOM beyond what the
// template sections touch. Anything else throws honestly.
import vm from "node:vm";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { webcrypto } from "node:crypto";
import { MessageChannel } from "node:worker_threads";

const DATA_URL_RE = /^data:text\/javascript[^,]*,/;

/**
 * Build the browser-global surface the sandbox template needs.
 *
 * @param {string} uuid sandbox uuid (for the _RUNTIME<uuid>_ marker name)
 * @param {(msg: object) => void} onHostMessage host callback for
 *   window.parent.postMessage traffic
 * @returns {{ context: vm.Context, postToSandbox: (msg: object) => void,
 *   setDone: (v: any) => void, getDone: () => any }}
 */
export function createSandboxContext(uuid, onHostMessage) {
  const messageListeners = new Set();
  const box = { done: undefined };

  const windowListeners = {
    addEventListener(type, fn) {
      if (type === "message" && typeof fn === "function") {
        messageListeners.add(fn);
      }
    },
    removeEventListener(type, fn) {
      if (type === "message") messageListeners.delete(fn);
    },
  };

  // Element stub: 60-timers.js reads
  // Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set
  // and redefines the setter.
  class Element {}
  Object.defineProperty(Element.prototype, "innerHTML", {
    get() {
      return this.__innerHTML ?? "";
    },
    set(v) {
      this.__innerHTML = String(v);
    },
    configurable: true,
    enumerable: false,
  });

  const documentStub = {
    createElement(tagName) {
      return new Element();
    },
  };

  const navigatorStub = {
    userAgent: "Mozilla/5.0 (headless-sandbox; parity)",
    sendBeacon() {
      return false;
    },
  };

  // XMLHttpRequest: 71-xhr.js captures window.XMLHttpRequest and installs a
  // patched subclass. A minimal constructor keeps the section loadable;
  // parity tests that need HTTP use fetch (70-fetch.js -> window.fetch).
  class XMLHttpRequestStub {
    open() {}
    send() {}
    setRequestHeader() {}
    abort() {}
  }

  // WebSocket / EventSource exist in browsers; the template's 60-timers.js
  // wraps them (blocked.com guard) via maskFunction, which needs a real
  // constructor to read .name from. Honest stubs: constructing one throws
  // instead of faking a connection (AGENTS.md rule 7).
  class WebSocketStub {
    constructor() {
      throw new Error("[headless] WebSocket is not available in the headless sandbox");
    }
  }
  class EventSourceStub {
    constructor() {
      throw new Error("[headless] EventSource is not available in the headless sandbox");
    }
  }

  // Like a real browser realm, window === globalThis here: the template
  // relies on it (31-node-globals sets window.__INTEROP_VAR__ and
  // 85-keydecoder reads globalThis.__INTEROP_VAR__).
  const addEventListener = (type, fn) => {
    windowListeners.addEventListener(type, fn);
  };
  const removeEventListener = (type, fn) => {
    windowListeners.removeEventListener(type, fn);
  };

  const sandboxGlobal = {
    addEventListener,
    removeEventListener,
    // window.parent.postMessage(msg, origin) -> host. Structured-clone the
    // payload like a real postMessage would, so host and sandbox never
    // share mutable state across the boundary.
    parent: {
      postMessage(msg) {
        onHostMessage(structuredClone(msg));
      },
    },
    fetch: (...args) => globalThis.fetch(...args),
    XMLHttpRequest: XMLHttpRequestStub,
    WebSocket: WebSocketStub,
    EventSource: EventSourceStub,
    onerror: null,
    onunhandledrejection: null,
    // window/self are wired below: window === self === globalThis, like a
    // real browser realm.
    document: documentStub,
    Element,
    navigator: navigatorStub,
    location: { href: "sandbox://localhost/", protocol: "sandbox:" },
    // Timers: the host realm's, like an iframe's own timers are the
    // embedder's. 60-timers.js captures and wraps these.
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
    performance,
    PerformanceObserver,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    crypto: webcrypto,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    // Web-platform globals browsers provide natively and the dist bundles
    // reference (EventTarget, DOMException, fetch types, ...). Node's own
    // globals are the same web-platform implementations.
    EventTarget: globalThis.EventTarget,
    Event: globalThis.Event,
    MessageEvent: globalThis.MessageEvent,
    DOMException: globalThis.DOMException,
    File: globalThis.File,
    FormData: globalThis.FormData,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    structuredClone: globalThis.structuredClone,
    atob: globalThis.atob.bind(globalThis),
    btoa: globalThis.btoa.bind(globalThis),
    Blob: globalThis.Blob,
    // Browsers have MessageChannel natively; the template's task-tracker
    // section news one up at module scope.
    MessageChannel,
    console: undefined, // wired below
  };

  const context = vm.createContext(sandboxGlobal);

  // window === self === globalThis, like in a browser realm.
  context.window = context;
  context.self = context;
  // The template does `const originalConsole = { ...console }` and wraps
  // each method; give it a real console whose output lands in the host
  // process (useful when debugging the harness itself).
  const vmConsole = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    vmConsole[m] = (...args) => globalThis.console[m]("[sandbox]", ...args);
  }
  context.console = vmConsole;

  // Non-enumerable sandbox markers (roadmap §4 requirement b): the template
  // assigns globalThis._RUNTIME_ / globalThis._RUNTIME<uuid>_ in section 00.
  // Plain assignment to an existing non-enumerable property keeps it
  // non-enumerable, so pre-defining them here makes the markers invisible
  // to for..in / Object.keys enumeration — the same reason
  // parity/preload.mjs defines its stub marker non-enumerably (Node's
  // global-leak detector).
  for (const key of ["_RUNTIME_", `_RUNTIME${uuid}_`]) {
    Object.defineProperty(context, key, {
      value: undefined,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  const postToSandbox = (msg) => {
    const event = { data: structuredClone(msg), source: context.parent };
    for (const fn of [...messageListeners]) {
      try {
        fn(event);
      } catch (e) {
        globalThis.console.error("[headless] sandbox message listener threw:", e);
      }
    }
  };

  return {
    context,
    postToSandbox,
    setDone: (v) => {
      box.done = v;
    },
    getDone: () => box.done,
  };
}

function decodeDataUrl(specifier) {
  const comma = specifier.indexOf(",");
  return decodeURIComponent(specifier.slice(comma + 1));
}

/**
 * Run generated sandbox code in a fresh vm context.
 *
 * @param {object} opts
 * @param {string} opts.code sandbox script from SandboxRuntime.generate()
 * @param {string} opts.uuid sandbox uuid
 * @param {string} opts.fileName entry file name (for import.meta.url)
 * @param {(msg: object) => void} opts.onHostMessage
 * @returns {Promise<{ context, postToSandbox, setDone, getDone, evaluate: () => Promise<void> }>}
 */
export async function runInVmSandbox({ code, uuid, fileName, onHostMessage }) {
  const { context, postToSandbox, setDone, getDone } =
    createSandboxContext(uuid, onHostMessage);

  const importModuleDynamically = async (specifier, referencingModule) => {
    if (DATA_URL_RE.test(specifier)) {
      const src = decodeDataUrl(specifier);
      const nested = new vm.SourceTextModule(src, {
        context,
        importModuleDynamically,
        initializeImportMeta(meta) {
          meta.url = specifier;
        },
      });
      await nested.link(() => {
        throw new Error(
          `[headless] unexpected static import in data: URL module`,
        );
      });
      await nested.evaluate();
      return nested.namespace;
    }
    throw new Error(
      `[headless] cannot dynamically import ${JSON.stringify(
        String(specifier).slice(0, 80),
      )} in the sandbox (only data:text/javascript URLs are supported)`,
    );
  };

  const mod = new vm.SourceTextModule(code, {
    context,
    importModuleDynamically,
    initializeImportMeta(meta) {
      meta.url = `sandbox://${uuid}/${fileName || "index.js"}`;
    },
  });
  await mod.link(() => {
    throw new Error(
      "[headless] unexpected static import in the sandbox template",
    );
  });

  return {
    context,
    postToSandbox,
    setDone,
    getDone,
    evaluate: () => mod.evaluate(),
  };
}
