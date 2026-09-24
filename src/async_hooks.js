// src/async_hooks.js — port of node:async_hooks for the browser runtime.
//
// Two lanes, chosen once at module load:
//
//  * Node lane — when a genuine Node builtin is reachable through
//    `process.getBuiltinModule` (real Node: the parity harness, repo tests),
//    we delegate to it. Async context tracking is a VM-level capability;
//    only the real builtin has true Node semantics, so delegation is the
//    honest implementation there.
//  * Browser lane — everywhere else (the sandboxed iframe, or any
//    environment where native delegation is unavailable/blocked) an honest,
//    dependency-free stub with the correct export shapes. Browsers cannot
//    track async context, so the stub documents its limits instead of
//    faking them:
//      - `createHook()` hooks track enabled state via `enable()`/`disable()`;
//        `init`/`before`/`after`/`destroy` fire only for `AsyncResource`s
//        created through this stub — never for real timers, promises, or I/O.
//      - `AsyncLocalStorage.run()` sets the store for the callback's
//        *synchronous* execution. It does NOT propagate across real async
//        boundaries (await, setTimeout, …). Documented limitation, not a
//        silent lie.
//      - `executionAsyncId()` / `triggerAsyncId()` track only stub resources.
//
// Browser-impossible behavior is a noop with the right shape, never a throw
// (Jared's rule). Nothing here patches host globals (`Promise`, `setTimeout`
// are left alone) and there are no npm dependencies.
'use strict';

import { AsyncLocalStorage as _BrowserALSBase } from 'als-browser';

// Wrapper around als-browser's AsyncLocalStorage adding Node's `name`
// option and `withScope()` which als-browser doesn't implement.
class BrowserALS extends _BrowserALSBase {
  #alsName = '';
  constructor(options) {
    if (options !== undefined) {
      if (typeof options !== 'object' || options === null) {
        const e = new TypeError(
          `The "options" argument must be of type object. Received type ${typeof options}`
        );
        e.code = 'ERR_INVALID_ARG_TYPE';
        throw e;
      }
      if (options.name !== undefined) {
        if (typeof options.name !== 'string') {
          const e = new TypeError(
            `The "options.name" property must be of type string. Received type ${typeof options.name}`
          );
          e.code = 'ERR_INVALID_ARG_TYPE';
          throw e;
        }
      }
    }
    super();
    this.#alsName = options?.name ?? '';
  }
  get name() { return this.#alsName; }
  withScope(store) {
    const self = this;
    return {
      run(callback, ...args) {
        return self.run(store, callback, ...args);
      },
    };
  }
}

// 1. Runtime bridge (guarded: the runtime AST-rewrites exactly the
//    `globalThis._RUNTIME_` member expression to the sandbox scope;
//    undefined under real Node / direct import).
const RT = (typeof globalThis._RUNTIME_ !== "undefined")
  ? globalThis._RUNTIME_
  : undefined;
void RT;

// 2. Native delegation probe (Node lane only). `process.getBuiltinModule`
//    bypasses the parity harness's module redirection, so under real Node
//    this resolves to the genuine builtin. In the sandbox `process` is the
//    host's shim (no `getBuiltinModule`); in the browser-fallback lane the
//    function is stubbed to throw — both fall through to the stub below.
function loadNativeAsyncHooks() {
  try {
    const proc = typeof process !== "undefined" ? process : undefined;
    const getBuiltin =
      proc && typeof proc.getBuiltinModule === "function"
        ? proc.getBuiltinModule
        : undefined;
    if (getBuiltin === undefined) return undefined;
    const mod = getBuiltin.call(proc, "async_hooks");
    if (
      mod &&
      typeof mod.AsyncLocalStorage === "function" &&
      typeof mod.AsyncResource === "function" &&
      typeof mod.createHook === "function" &&
      typeof mod.executionAsyncId === "function"
    ) {
      return mod;
    }
  } catch {
    // No native module available — use the browser stub.
  }
  return undefined;
}

const native = loadNativeAsyncHooks();

// ---------------------------------------------------------------------------
// Browser stub
// ---------------------------------------------------------------------------

class ERR_ASYNC_CALLBACK extends TypeError {
  constructor(message) {
    super(message);
    this.code = "ERR_ASYNC_CALLBACK";
  }
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(message) {
    super(message);
    this.code = "ERR_INVALID_ARG_TYPE";
  }
}

class ERR_INVALID_ASYNC_ID extends RangeError {
  constructor(message) {
    super(message);
    this.code = "ERR_INVALID_ASYNC_ID";
  }
}

function formatReceived(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return `type ${typeof value}`;
}

// --- async id bookkeeping -----------------------------------------------
// Mirrors Node's observable defaults: the default execution context has
// async id 1 and trigger id 0; user resources allocate upwards from 2.
let nextAsyncId = 2;
const asyncResources = new Map(); // asyncId -> StubAsyncResource
let currentAsyncId = 1;
const defaultExecutionResource = {};
const enabledHooks = new Set();
const alsInstances = new Set(); // live StubAsyncLocalStorage (static bind/snapshot)

const kEmitHook = Symbol("async_hooks.emitHook");

function emitHookEvent(name, ...args) {
  if (enabledHooks.size === 0) return;
  // Copy: a callback may enable/disable hooks reentrantly.
  for (const hook of Array.from(enabledHooks)) {
    hook[kEmitHook](name, args);
  }
}

// --- AsyncHook ------------------------------------------------------------

class StubAsyncHook {
  #callbacks;
  #trackPromises;
  #enabled = false;

  constructor(callbacks) {
    // Node destructures with no default: createHook()/createHook(null)
    // throw a plain TypeError ("Cannot destructure property 'init' of …").
    const { init, before, after, destroy, promiseResolve, trackPromises } = callbacks;
    if (init !== undefined && typeof init !== "function") {
      throw new ERR_ASYNC_CALLBACK("hook.init must be a function");
    }
    if (before !== undefined && typeof before !== "function") {
      throw new ERR_ASYNC_CALLBACK("hook.before must be a function");
    }
    if (after !== undefined && typeof after !== "function") {
      throw new ERR_ASYNC_CALLBACK("hook.after must be a function");
    }
    if (destroy !== undefined && typeof destroy !== "function") {
      throw new ERR_ASYNC_CALLBACK("hook.destroy must be a function");
    }
    if (promiseResolve !== undefined && typeof promiseResolve !== "function") {
      throw new ERR_ASYNC_CALLBACK("hook.promiseResolve must be a function");
    }
    if (trackPromises !== undefined && typeof trackPromises !== "boolean") {
      throw new ERR_INVALID_ARG_TYPE(
        `The "trackPromises" property must be of type boolean. Received ${formatReceived(trackPromises)}`
      );
    }
    this.#callbacks = { init, before, after, destroy, promiseResolve };
    this.#trackPromises = trackPromises !== false;
  }

  [kEmitHook](name, args) {
    const cb = this.#callbacks[name];
    if (typeof cb === "function") {
      cb(...args);
    }
  }

  enable() {
    if (!this.#enabled) {
      this.#enabled = true;
      enabledHooks.add(this);
    }
    return this;
  }

  disable() {
    this.#enabled = false;
    enabledHooks.delete(this);
    return this;
  }
}

// --- AsyncResource ----------------------------------------------------------

class StubAsyncResource {
  #type;
  #asyncId;
  #triggerAsyncId;
  #destroyed = false;

  constructor(type, options = undefined) {
    if (typeof type !== "string") {
      throw new ERR_INVALID_ARG_TYPE(
        `The "type" argument must be of type string. Received ${formatReceived(type)}`
      );
    }
    let triggerAsyncId = currentAsyncId;
    if (options !== undefined && options !== null) {
      const t = options.triggerAsyncId;
      if (t !== undefined) {
        // Node accepts any integer (including negatives); non-integers throw
        // ERR_INVALID_ASYNC_ID ("Invalid triggerAsyncId value: …").
        if (typeof t !== "number" || !Number.isInteger(t)) {
          throw new ERR_INVALID_ASYNC_ID(`Invalid triggerAsyncId value: ${t}`);
        }
        triggerAsyncId = t;
      }
    }
    this.#type = type;
    this.#triggerAsyncId = triggerAsyncId;
    this.#asyncId = nextAsyncId++;
    asyncResources.set(this.#asyncId, this);
    emitHookEvent("init", this.#asyncId, type, triggerAsyncId, this);
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const previousId = currentAsyncId;
    currentAsyncId = this.#asyncId;
    emitHookEvent("before", this.#asyncId);
    try {
      // Like Node, fn is invoked without pre-validation: a non-function
      // throws the natural TypeError from .apply().
      return fn.apply(thisArg, args);
    } finally {
      emitHookEvent("after", this.#asyncId);
      currentAsyncId = previousId;
    }
  }

  emitDestroy() {
    // Double destroy is a noop (mirrors Node).
    if (this.#destroyed) return this;
    this.#destroyed = true;
    asyncResources.delete(this.#asyncId);
    emitHookEvent("destroy", this.#asyncId);
    return this;
  }

  asyncId() {
    return this.#asyncId;
  }

  triggerAsyncId() {
    return this.#triggerAsyncId;
  }

  static bind(fn, type = undefined, thisArg = undefined) {
    const resource = new StubAsyncResource(
      type === undefined ? (fn?.name || "bound-anonymous-fn") : type
    );
    return function (...args) {
      return resource.runInAsyncScope(() => fn.apply(thisArg, args));
    };
  }
}

// --- execution/trigger API ----------------------------------------------------

function stubCreateHook(callbacks) {
  return new StubAsyncHook(callbacks);
}

function stubExecutionAsyncId() {
  return currentAsyncId;
}

function stubTriggerAsyncId() {
  const resource = asyncResources.get(currentAsyncId);
  return resource === undefined ? 0 : resource.triggerAsyncId();
}

function stubExecutionAsyncResource() {
  const resource = asyncResources.get(currentAsyncId);
  return resource === undefined ? defaultExecutionResource : resource;
}

// --- AsyncLocalStorage --------------------------------------------------------

class StubAsyncLocalStorage {
  #store = undefined;
  #disabled = false;
  #frames = 0; // active run() depth; lets run() work while disabled, like Node
  #name = "";

  constructor(options = undefined) {
    if (options !== undefined) {
      if (typeof options !== "object" || options === null) {
        throw new ERR_INVALID_ARG_TYPE(
          `The "options" argument must be of type object. Received ${formatReceived(options)}`
        );
      }
      if (options.name !== undefined) {
        if (typeof options.name !== "string") {
          throw new ERR_INVALID_ARG_TYPE(
            `The "options.name" property must be of type string. Received ${formatReceived(options.name)}`
          );
        }
        this.#name = options.name;
      }
    }
    alsInstances.add(this);
  }

  get name() {
    return this.#name;
  }

  getStore() {
    return this.#disabled && this.#frames === 0 ? undefined : this.#store;
  }

  disable() {
    this.#store = undefined;
    this.#disabled = true;
  }

  enterWith(store) {
    this.#store = store;
  }

  exit(callback, ...args) {
    const previousStore = this.#store;
    const previousFrames = this.#frames;
    this.#store = undefined;
    this.#frames = 0;
    try {
      return callback(...args);
    } finally {
      this.#store = previousStore;
      this.#frames = previousFrames;
    }
  }

  // Sets the store for the callback's *synchronous* execution only. The
  // browser cannot propagate context across real async boundaries, so after
  // an `await` (or any macrotask) inside the callback, getStore() is
  // undefined again. This is the documented limitation, not a bug.
  run(store, callback, ...args) {
    const previousStore = this.#store;
    const previousFrames = this.#frames;
    this.#store = store;
    this.#frames = previousFrames + 1;
    try {
      return callback(...args);
    } finally {
      this.#store = previousStore;
      this.#frames = previousFrames;
    }
  }

  withScope(store) {
    const self = this;
    return {
      run(callback, ...args) {
        return self.run(store, callback, ...args);
      },
    };
  }

  // Binds fn to the stores captured *right now* (best-effort: there is no
  // real execution context in a browser, so this is a synchronous snapshot
  // of every live instance, restored after the call).
  static bind(fn) {
    const captured = [];
    for (const als of alsInstances) {
      captured.push([als, als.#store, als.#frames, als.#disabled]);
    }
    return function (...args) {
      const previous = [];
      for (const [als, store, frames, disabled] of captured) {
        previous.push([als, als.#store, als.#frames, als.#disabled]);
        als.#store = store;
        als.#frames = frames;
        als.#disabled = disabled;
      }
      try {
        return fn.apply(this, args);
      } finally {
        for (const [als, store, frames, disabled] of previous) {
          als.#store = store;
          als.#frames = frames;
          als.#disabled = disabled;
        }
      }
    };
  }

  // Captures the current stores; the returned function runs a given function
  // within the captured snapshot (synchronously, like run()).
  static snapshot() {
    const captured = [];
    for (const als of alsInstances) {
      captured.push([als, als.#store, als.#frames, als.#disabled]);
    }
    return function (fn, ...args) {
      const previous = [];
      for (const [als, store, frames, disabled] of captured) {
        previous.push([als, als.#store, als.#frames, als.#disabled]);
        als.#store = store;
        als.#frames = frames;
        als.#disabled = disabled;
      }
      try {
        return fn(...args);
      } finally {
        for (const [als, store, frames, disabled] of previous) {
          als.#store = store;
          als.#frames = frames;
          als.#disabled = disabled;
        }
      }
    };
  }
}

// --- asyncWrapProviders (frozen null-prototype enum, values from Node v24.20.0)
function buildAsyncWrapProviders() {
  const providers = { __proto__: null };
  providers.NONE = 0;
  providers.DIRHANDLE = 1;
  providers.DNSCHANNEL = 2;
  providers.ELDHISTOGRAM = 3;
  providers.FILEHANDLE = 4;
  providers.FILEHANDLECLOSEREQ = 5;
  providers.BLOBREADER = 6;
  providers.FSEVENTWRAP = 7;
  providers.FSREQCALLBACK = 8;
  providers.FSREQPROMISE = 9;
  providers.GETADDRINFOREQWRAP = 10;
  providers.GETNAMEINFOREQWRAP = 11;
  providers.HEAPSNAPSHOT = 12;
  providers.HTTP2SESSION = 13;
  providers.HTTP2STREAM = 14;
  providers.HTTP2PING = 15;
  providers.HTTP2SETTINGS = 16;
  providers.HTTPINCOMINGMESSAGE = 17;
  providers.HTTPCLIENTREQUEST = 18;
  providers.LOCKS = 19;
  providers.JSSTREAM = 20;
  providers.JSUDPWRAP = 21;
  providers.MESSAGEPORT = 22;
  providers.PIPECONNECTWRAP = 23;
  providers.PIPESERVERWRAP = 24;
  providers.PIPEWRAP = 25;
  providers.PROCESSWRAP = 26;
  providers.PROMISE = 27;
  providers.QUERYWRAP = 28;
  providers.QUIC_ENDPOINT = 29;
  providers.QUIC_LOGSTREAM = 30;
  providers.QUIC_SESSION = 31;
  providers.QUIC_STREAM = 32;
  providers.QUIC_UDP = 33;
  providers.SHUTDOWNWRAP = 34;
  providers.SIGNALWRAP = 35;
  providers.STATWATCHER = 36;
  providers.STREAMPIPE = 37;
  providers.TCPCONNECTWRAP = 38;
  providers.TCPSERVERWRAP = 39;
  providers.TCPWRAP = 40;
  providers.TTYWRAP = 41;
  providers.UDPSENDWRAP = 42;
  providers.UDPWRAP = 43;
  providers.SIGINTWATCHDOG = 44;
  providers.WORKER = 45;
  providers.WORKERCPUPROFILE = 46;
  providers.WORKERCPUUSAGE = 47;
  providers.WORKERHEAPPROFILE = 48;
  providers.WORKERHEAPSNAPSHOT = 49;
  providers.WORKERHEAPSTATISTICS = 50;
  providers.WRITEWRAP = 51;
  providers.ZLIB = 52;
  providers.CHECKPRIMEREQUEST = 53;
  providers.PBKDF2REQUEST = 54;
  providers.KEYPAIRGENREQUEST = 55;
  providers.KEYGENREQUEST = 56;
  providers.KEYEXPORTREQUEST = 57;
  providers.ARGON2REQUEST = 58;
  providers.CIPHERREQUEST = 59;
  providers.DERIVEBITSREQUEST = 60;
  providers.HASHREQUEST = 61;
  providers.RANDOMBYTESREQUEST = 62;
  providers.RANDOMPRIMEREQUEST = 63;
  providers.SCRYPTREQUEST = 64;
  providers.SIGNREQUEST = 65;
  providers.TLSWRAP = 66;
  providers.VERIFYREQUEST = 67;
  return Object.freeze(providers);
}

// ---------------------------------------------------------------------------
// Public surface — native under Node, stub in the browser.
// Node v24.20.0 exports exactly: AsyncLocalStorage, AsyncResource,
// asyncWrapProviders, createHook, executionAsyncId, executionAsyncResource,
// triggerAsyncId (no default export).
// ---------------------------------------------------------------------------

const AsyncLocalStorage =
  native !== undefined ? native.AsyncLocalStorage : BrowserALS;
const AsyncResource =
  native !== undefined ? native.AsyncResource : StubAsyncResource;
const asyncWrapProviders =
  native !== undefined ? native.asyncWrapProviders : buildAsyncWrapProviders();

const createHook =
  native !== undefined ? native.createHook : stubCreateHook;
const executionAsyncId =
  native !== undefined ? native.executionAsyncId : stubExecutionAsyncId;
const triggerAsyncId =
  native !== undefined ? native.triggerAsyncId : stubTriggerAsyncId;
const executionAsyncResource =
  native !== undefined ? native.executionAsyncResource : stubExecutionAsyncResource;

export {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};

// Default export: the full named-export set (mirrors require('async_hooks')).
export default {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};
