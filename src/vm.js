/**
 * vm.js — Browser-compatible polyfill for Node.js `node:vm` module
 *
 * SYNC COMPATIBILITY
 * ------------------
 * All run* methods return a SyncPromise — a real Promise subclass that ALSO
 * exposes `.value` and `.syncError` synchronously for callers that don't await.
 *
 * Code without top-level await, timers, or network runs synchronously through
 * win.eval() and the result is available immediately on `.value`:
 *
 *   const result = vm.runInNewContext('a + 5', { a: 100 });
 *   console.log(result.value);   // 105 — available synchronously
 *   console.log(+result);        // 105 — valueOf() coercion
 *   await result;                // 105 — also awaitable
 *
 * The return value is intentionally a SyncPromise so that:
 *   (a) sync callers get result.value / valueOf() / toString()
 *   (b) async callers can await for deferred work (timers, fetch, top-level await)
 *   (c) the value is === to what Node.js would return for pure-sync scripts
 *
 * DEVIATIONS FROM NODE.JS
 * -----------------------
 * - Return type is SyncPromise, not a bare value. For pure-sync code the
 *   .value property equals what Node.js returns. For async code the caller
 *   must await.
 * - Synchronous infinite loops cannot be interrupted (single JS thread).
 * - compileFunction() ignores parsingContext / contextExtensions.
 * - vm.Module / vm.SourceTextModule throw "Not implemented".
 * - vm.SyntheticModule is a functional stub (correct status machine only).
 * - vm.measureMemory() rejects with ERR_CONTEXT_NOT_INITIALIZED.
 * - breakOnSigint, cachedData, produceCachedData are accepted but no-ops.
 * - iframe.sandbox = 'allow-scripts' (no allow-same-origin): null-origin
 *   sandbox — no localStorage, cookies, or same-origin DOM access inside.
 */

// ---------------------------------------------------------------------------
// Phase 0 — Capture host primitives at module load time
// ---------------------------------------------------------------------------

const _ST    = globalThis.setTimeout;
const _CT    = globalThis.clearTimeout;
const _SI    = globalThis.setInterval;
const _CI    = globalThis.clearInterval;
const _fetch = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis) : undefined;

// ---------------------------------------------------------------------------
// Phase 1 — SyncPromise
// A Promise subclass that runs the executor synchronously and exposes
// .value / .syncError for callers that don't await.
// ---------------------------------------------------------------------------

class SyncPromise extends Promise {
  #settled = false;
  #value   = undefined;
  #error   = undefined;
  #isError = false;

  constructor(executor) {
    let syncResolve, syncReject;
    super((res, rej) => {
      syncResolve = res;
      syncReject  = rej;
    });

    // Run executor synchronously — captures result before constructor returns
    try {
      executor(
        (v) => {
          if (!this.#settled) {
            this.#settled = true;
            this.#value   = v;
            syncResolve(v);
          }
        },
        (e) => {
          if (!this.#settled) {
            this.#settled = true;
            this.#isError = true;
            this.#error   = e;
            syncReject(e);
          }
        }
      );
    } catch (e) {
      if (!this.#settled) {
        this.#settled = true;
        this.#isError = true;
        this.#error   = e;
        syncReject(e);
      }
    }
  }

  /** True once the synchronous portion has settled. */
  get settled()    { return this.#settled; }

  /** The resolved value — populated synchronously if no top-level await. */
  get value()      { return this.#value; }

  /** The thrown error, or undefined. */
  get syncError()  { return this.#isError ? this.#error : undefined; }

  /** Coerce to the resolved value — lets `+result`, `String(result)` work. */
  valueOf()        { return this.#value; }
  toString()       { return String(this.#value); }

  // Preserve species so .then()/.catch() also return SyncPromise
  static get [Symbol.species]() { return SyncPromise; }
}

// ---------------------------------------------------------------------------
// Phase 2 — Timer registry
// ---------------------------------------------------------------------------

function makeTimerPatches(registry, hooks = {}) {
  const onError = hooks.onError
    ?? ((e) => console.error('[vm] timer callback error:', e));

  function patchedSetTimeout(fn, delay, ...args) {
    if (typeof fn !== 'function')
      throw new TypeError('setTimeout callback must be a function');
    let id;
    id = _ST(() => {
      registry.delete(id);
      try { fn(...args); } catch (e) { onError(e); }
    }, Math.max(0, delay ?? 0));
    registry.set(id, { type: 'timeout' });
    return id;
  }

  function patchedClearTimeout(id) {
    registry.delete(id);
    _CT(id);
  }

  function patchedSetInterval(fn, delay, ...args) {
    if (typeof fn !== 'function')
      throw new TypeError('setInterval callback must be a function');
    const id = _SI(() => {
      try { fn(...args); } catch (e) { onError(e); }
    }, Math.max(0, delay ?? 0));
    registry.set(id, { type: 'interval' });
    return id;
  }

  function patchedClearInterval(id) {
    registry.delete(id);
    _CI(id);
  }

  return { patchedSetTimeout, patchedClearTimeout, patchedSetInterval, patchedClearInterval };
}

// ---------------------------------------------------------------------------
// Phase 3 — Network tracking
// ---------------------------------------------------------------------------

function makeNetworkPatches(counters) {
  const patchedFetch = _fetch
    ? async (...args) => {
        counters.fetches++;
        try   { return await _fetch(...args); }
        finally { counters.fetches = Math.max(0, counters.fetches - 1); }
      }
    : undefined;

  const PatchedXHR = typeof XMLHttpRequest !== 'undefined'
    ? class extends XMLHttpRequest {
        send(...args) {
          counters.xhrs++;
          const done = () => { counters.xhrs = Math.max(0, counters.xhrs - 1); };
          this.addEventListener('loadend', done, { once: true });
          this.addEventListener('error',   done, { once: true });
          this.addEventListener('abort',   done, { once: true });
          super.send(...args);
        }
      }
    : undefined;

  return { patchedFetch, PatchedXHR };
}

// ---------------------------------------------------------------------------
// Phase 4 — waitForSettled
// ---------------------------------------------------------------------------

async function waitForSettled(registry, counters, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (registry.size > 0 || counters.fetches > 0 || counters.xhrs > 0) {
    if (Date.now() >= deadline) {
      const err = new Error(`Script execution timed out after ${timeoutMs}ms`);
      err.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      throw err;
    }
    await new Promise(r => _ST(r, 16));
    await Promise.resolve();
    await Promise.resolve();
  }
  await Promise.resolve();
  await Promise.resolve();
}

function clearAllPending(registry) {
  for (const [id, { type }] of registry) {
    if (type === 'timeout')  _CT(id);
    if (type === 'interval') _CI(id);
  }
  registry.clear();
}

// ---------------------------------------------------------------------------
// Phase 5 — Iframe lifecycle
// ---------------------------------------------------------------------------

function createSandboxIframe() {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'display:none;width:0;height:0;border:0;position:absolute';
  iframe.sandbox = 'allow-scripts';
  document.body.appendChild(iframe);
  return iframe;
}

function destroySandboxIframe(iframe) {
  iframe?.parentNode?.removeChild(iframe);
}

// ---------------------------------------------------------------------------
// Phase 6 — BROWSER_INTERNALS blocklist
// Keys that must never be copied from iframe window back to contextObject.
// ---------------------------------------------------------------------------

const BROWSER_INTERNALS = new Set([
  'window','self','top','parent','frames','frameElement','globalThis',
  'document','location','history','navigator','screen','performance',
  'crypto','indexedDB','sessionStorage','localStorage','caches',
  'opener','closed','length','name','origin','customElements',
  'alert','confirm','prompt','print','focus','blur','open','close',
  'postMessage','requestAnimationFrame','cancelAnimationFrame',
  'requestIdleCallback','cancelIdleCallback','queueMicrotask',
  'addEventListener','removeEventListener','dispatchEvent',
  'getComputedStyle','matchMedia','visualViewport',
  'MutationObserver','IntersectionObserver','ResizeObserver','PerformanceObserver',
  'setTimeout','clearTimeout','setInterval','clearInterval',
  'fetch','XMLHttpRequest','reportError','structuredClone',
  'Infinity','NaN','undefined','eval','isFinite','isNaN',
  'parseFloat','parseInt','decodeURI','decodeURIComponent',
  'encodeURI','encodeURIComponent','Object','Function','Boolean',
  'Symbol','Error','EvalError','RangeError','ReferenceError',
  'SyntaxError','TypeError','URIError','Number','BigInt','Math',
  'Date','String','RegExp','Array','Int8Array','Uint8Array',
  'Uint8ClampedArray','Int16Array','Uint16Array','Int32Array',
  'Uint32Array','Float32Array','Float64Array','BigInt64Array',
  'BigUint64Array','Map','Set','WeakMap','WeakSet','WeakRef',
  'ArrayBuffer','SharedArrayBuffer','Atomics','DataView','JSON',
  'Promise','Reflect','Proxy','Intl','WebAssembly',
  'console','AbortController','AbortSignal','Blob','File',
  'FormData','Headers','Request','Response','URL','URLSearchParams',
  'TextEncoder','TextDecoder','ReadableStream','WritableStream',
  'TransformStream','CompressionStream','DecompressionStream',
  'BroadcastChannel','MessageChannel','MessageEvent','EventTarget',
  'Event','CustomEvent','ErrorEvent','PromiseRejectionEvent',
]);

// ---------------------------------------------------------------------------
// Phase 7 — Context injection / extraction
// ---------------------------------------------------------------------------

function injectContext(win, contextObject, patches) {
  // User context first — timer patches always overwrite afterward
  for (const key of Object.keys(contextObject)) {
    try { win[key] = contextObject[key]; } catch (_) {}
  }
  win.setTimeout    = patches.patchedSetTimeout;
  win.clearTimeout  = patches.patchedClearTimeout;
  win.setInterval   = patches.patchedSetInterval;
  win.clearInterval = patches.patchedClearInterval;
  if (patches.patchedFetch) win.fetch = patches.patchedFetch;
  if (patches.PatchedXHR)   win.XMLHttpRequest = patches.PatchedXHR;
}

function extractContext(win, contextObject, preRunKeys) {
  let winKeys;
  try { winKeys = Object.keys(win); } catch (_) { return; }
  for (const key of winKeys) {
    if (BROWSER_INTERNALS.has(key)) continue;
    // Copy back if: key was in contextObject before run, OR it's new on win
    if (key in contextObject || !preRunKeys.has(key)) {
      try { contextObject[key] = win[key]; } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 8 — enrichError
// ---------------------------------------------------------------------------

function enrichError(err, filename) {
  if (filename && err?.stack) {
    err.stack = err.stack
      .replace(/evalmachine\.<anonymous>/g, filename)
      .replace(/<anonymous>/g, filename);
  }
}

// ---------------------------------------------------------------------------
// Phase 9 — Core execution engine
//
// Sync path (no top-level await, no timers):
//   win.eval(code) returns synchronously — SyncPromise.value is populated
//   before executeInIframe() returns.
//
// Async path (top-level await detected, or timers fire after sync return):
//   Wraps code in async IIFE, awaits it, then drains with waitForSettled.
//   SyncPromise.value is undefined until the caller awaits.
//
// Detection heuristic: scan for the token 'await' at the top level.
// This is intentionally loose — false positives (await in a string literal)
// just mean we take the async path unnecessarily, which is safe.
// ---------------------------------------------------------------------------

const HAS_TOP_LEVEL_AWAIT = /(?:^|[^.\w])await\s/;

function detectsTopLevelAwait(code) {
  return HAS_TOP_LEVEL_AWAIT.test(code);
}

/**
 * @param {string} code
 * @param {object} contextObject   mutated in-place with results
 * @param {object} options         { timeout, filename, onError }
 * @returns {SyncPromise}
 */
function executeInIframe(code, contextObject, options = {}) {
  const timeout = (typeof options.timeout === 'number' && options.timeout > 0)
    ? options.timeout : 30_000;
  const filename = options.filename ?? 'evalmachine.<anonymous>';

  return new SyncPromise((resolve, reject) => {
    const registry = new Map();
    const counters  = { fetches: 0, xhrs: 0 };
    const patches   = {
      ...makeTimerPatches(registry, { onError: options.onError }),
      ...makeNetworkPatches(counters),
    };

    const iframe = createSandboxIframe();
    const win    = iframe.contentWindow;
    const preRunKeys = new Set(Object.keys(win));

    injectContext(win, contextObject, patches);

    // --- Sync path ---
    if (!detectsTopLevelAwait(code)) {
      let syncResult;
      try {
        syncResult = win.eval(code);
      } catch (err) {
        enrichError(err, filename);
        extractContext(win, contextObject, preRunKeys);
        clearAllPending(registry);
        destroySandboxIframe(iframe);
        reject(err);
        return;
      }

      // Synchronous eval succeeded. The registry may still have timers queued
      // (e.g. setTimeout called during sync eval). If so, drain asynchronously
      // but resolve with the sync result immediately so .value is available.
      extractContext(win, contextObject, preRunKeys);

      if (registry.size === 0 && counters.fetches === 0 && counters.xhrs === 0) {
        // Pure sync — everything settles before this line
        destroySandboxIframe(iframe);
        resolve(syncResult);
        return;
      }

      // Resolve immediately with the sync result, then drain in the background.
      // The caller can await the returned SyncPromise to ensure timers finish,
      // but .value is already populated for sync callers.
      resolve(syncResult);
      waitForSettled(registry, counters, timeout)
        .catch((err) => console.warn('[vm] background drain error:', err))
        .finally(() => {
          extractContext(win, contextObject, preRunKeys);
          clearAllPending(registry);
          destroySandboxIframe(iframe);
        });
      return;
    }

    // --- Async path (top-level await detected) ---
    let timeoutId;
    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = _ST(() => {
        const e = new Error(`Script execution timed out after ${timeout}ms`);
        e.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
        rej(e);
      }, timeout);
    });

    let execPromise;
    try {
      execPromise = win.eval(`(async function __vmRun__() {\n${code}\n})()`);
    } catch (err) {
      _CT(timeoutId);
      enrichError(err, filename);
      extractContext(win, contextObject, preRunKeys);
      clearAllPending(registry);
      destroySandboxIframe(iframe);
      reject(err);
      return;
    }

    Promise.race([execPromise, timeoutPromise])
      .then(async (result) => {
        await waitForSettled(registry, counters, timeout);
        return result;
      })
      .then((result) => {
        extractContext(win, contextObject, preRunKeys);
        resolve(result);
      })
      .catch((err) => {
        enrichError(err, filename);
        extractContext(win, contextObject, preRunKeys);
        reject(err);
      })
      .finally(() => {
        _CT(timeoutId);
        clearAllPending(registry);
        destroySandboxIframe(iframe);
      });
  });
}

// ---------------------------------------------------------------------------
// Phase 10 — runInThisContext
// Patches host globals temporarily, runs indirect eval, always reverts.
// ---------------------------------------------------------------------------

function runInThisContext(code, options = {}) {
  if (typeof options === 'string') options = { filename: options };
  const timeout  = (typeof options.timeout === 'number' && options.timeout > 0)
    ? options.timeout : 30_000;
  const filename = options.filename ?? 'evalmachine.<anonymous>';

  return new SyncPromise((resolve, reject) => {
    const registry = new Map();
    const counters  = { fetches: 0, xhrs: 0 };
    const patches   = {
      ...makeTimerPatches(registry, { onError: options.onError }),
      ...makeNetworkPatches(counters),
    };

    // Save current values at THIS call's entry (supports re-entrant calls)
    const prev = {
      ST: globalThis.setTimeout, CT: globalThis.clearTimeout,
      SI: globalThis.setInterval, CI: globalThis.clearInterval,
      fetch: globalThis.fetch,
      XHR: typeof XMLHttpRequest !== 'undefined' ? globalThis.XMLHttpRequest : undefined,
    };

    globalThis.setTimeout    = patches.patchedSetTimeout;
    globalThis.clearTimeout  = patches.patchedClearTimeout;
    globalThis.setInterval   = patches.patchedSetInterval;
    globalThis.clearInterval = patches.patchedClearInterval;
    if (patches.patchedFetch) globalThis.fetch = patches.patchedFetch;
    if (patches.PatchedXHR)   globalThis.XMLHttpRequest = patches.PatchedXHR;

    function revert() {
      globalThis.setTimeout    = prev.ST;
      globalThis.clearTimeout  = prev.CT;
      globalThis.setInterval   = prev.SI;
      globalThis.clearInterval = prev.CI;
      if (prev.fetch !== undefined)      globalThis.fetch = prev.fetch;
      else if (patches.patchedFetch)     delete globalThis.fetch;
      if (prev.XHR !== undefined)        globalThis.XMLHttpRequest = prev.XHR;
      else if (patches.PatchedXHR)       delete globalThis.XMLHttpRequest;
      clearAllPending(registry);
    }

    // Sync path
    if (!detectsTopLevelAwait(code)) {
      let syncResult;
      try {
        // Indirect eval — no access to local polyfill variables
        syncResult = (0, eval)(code);
      } catch (err) {
        enrichError(err, filename);
        revert();
        reject(err);
        return;
      }

      if (registry.size === 0 && counters.fetches === 0 && counters.xhrs === 0) {
        revert();
        resolve(syncResult);
        return;
      }

      resolve(syncResult);
      waitForSettled(registry, counters, timeout)
        .catch((e) => console.warn('[vm] runInThisContext drain error:', e))
        .finally(() => revert());
      return;
    }

    // Async path
    let timeoutId;
    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = _ST(() => {
        const e = new Error(`Script execution timed out after ${timeout}ms`);
        e.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
        rej(e);
      }, timeout);
    });

    let execPromise;
    try {
      execPromise = (0, eval)(`(async function __vmRunThis__() {\n${code}\n})()`);
    } catch (err) {
      _CT(timeoutId);
      enrichError(err, filename);
      revert();
      reject(err);
      return;
    }

    Promise.race([execPromise, timeoutPromise])
      .then(async (r) => { await waitForSettled(registry, counters, timeout); return r; })
      .then(resolve)
      .catch((err) => { enrichError(err, filename); reject(err); })
      .finally(() => { _CT(timeoutId); revert(); });
  });
}

// ---------------------------------------------------------------------------
// Phase 11 — Context tracking
// ---------------------------------------------------------------------------

const CONTEXT_TAG = Symbol('vm.contextified');
let _ctxCounter = 0;

export function createContext(contextObject, options = {}) {
  if (contextObject === constants.DONT_CONTEXTIFY) {
    const bare = Object.create(null);
    Object.defineProperty(bare, CONTEXT_TAG, {
      value: { name: `VM Context ${++_ctxCounter}` },
      enumerable: false, configurable: false, writable: false,
    });
    return bare;
  }
  contextObject = contextObject ?? {};
  if (typeof contextObject !== 'object' || contextObject === null)
    throw new TypeError('contextObject must be an object');
  if (CONTEXT_TAG in contextObject) return contextObject; // idempotent
  if (typeof options === 'string') options = { name: options };
  Object.defineProperty(contextObject, CONTEXT_TAG, {
    value: { name: options.name ?? `VM Context ${++_ctxCounter}` },
    enumerable: false, configurable: false, writable: false,
  });
  return contextObject;
}

export function isContext(object) {
  return typeof object === 'object' && object !== null && CONTEXT_TAG in object;
}

// ---------------------------------------------------------------------------
// Phase 12 — Public run* API
// ---------------------------------------------------------------------------

/**
 * @param {string} code
 * @param {object} contextifiedObject
 * @param {object|string} [options]
 * @returns {SyncPromise}
 *
 * @example — sync usage (pure expression, no await/timers):
 *   const r = vm.runInContext('a + 5', ctx);
 *   el.textContent = r.value;   // immediate
 *
 * @example — async usage:
 *   const r = await vm.runInContext('a + 5', ctx);
 *   el.textContent = r;         // awaited result
 */
export function runInContext(code, contextifiedObject, options = {}) {
  if (!isContext(contextifiedObject))
    throw new TypeError('contextifiedObject must be a vm.Context — call vm.createContext() first');
  if (typeof options === 'string') options = { filename: options };
  return executeInIframe(code, contextifiedObject, options);
}

/**
 * @param {string} code
 * @param {object} [contextObject={}]
 * @param {object|string} [options]
 * @returns {SyncPromise}
 *
 * @example — matches Node.js sync usage:
 *   var res = vm.runInNewContext('a + 5', { a: 100 });
 *   document.querySelector('#res').textContent = res;  // coerces via valueOf()
 */
export function runInNewContext(code, contextObject, options = {}) {
  if (typeof options === 'string') options = { filename: options };
  const ctx = createContext(contextObject ?? {}, typeof options === 'object' ? options : {});
  return executeInIframe(code, ctx, options);
}

export { runInThisContext };

// ---------------------------------------------------------------------------
// Phase 13 — Script class
// ---------------------------------------------------------------------------

export class Script {
  #code;
  #options;

  /**
   * @param {string} code
   * @param {object|string} [options]
   */
  constructor(code, options = {}) {
    if (typeof code !== 'string') throw new TypeError('code must be a string');
    if (typeof options === 'string') options = { filename: options };
    this.#code    = code;
    this.#options = { ...options };
    // Expose for inspection (matches Node.js Script properties)
    this.cachedDataRejected = false;
  }

  get sourceMapURL() { return undefined; }

  createCachedData() { return new Uint8Array(0); }

  /** @returns {SyncPromise} */
  runInContext(ctx, opts = {}) {
    if (typeof opts === 'string') opts = { filename: opts };
    return runInContext(this.#code, ctx, { ...this.#options, ...opts });
  }

  /** @returns {SyncPromise} */
  runInNewContext(obj, opts = {}) {
    if (typeof opts === 'string') opts = { filename: opts };
    return runInNewContext(this.#code, obj, { ...this.#options, ...opts });
  }

  /** @returns {SyncPromise} */
  runInThisContext(opts = {}) {
    if (typeof opts === 'string') opts = { filename: opts };
    return runInThisContext(this.#code, { ...this.#options, ...opts });
  }
}

export function createScript(code, options) {
  return new Script(code, options);
}

// ---------------------------------------------------------------------------
// Phase 14 — compileFunction
// Implements Node's vm.compileFunction() signature.
// parsingContext / contextExtensions are accepted but ignored (browser limitation).
// ---------------------------------------------------------------------------

export function compileFunction(code, params = [], options = {}) {
  if (typeof code !== 'string') throw new TypeError('code must be a string');
  if (!Array.isArray(params))   throw new TypeError('params must be an array');
  const {
    filename = '',
    lineOffset = 0,  // accepted, not used
    columnOffset = 0, // accepted, not used
    // parsingContext, contextExtensions — accepted, ignored
  } = (typeof options === 'object' && options !== null) ? options : {};
  void filename; void lineOffset; void columnOffset;
  // eslint-disable-next-line no-new-func
  return new Function(...params, code);
}

// ---------------------------------------------------------------------------
// Phase 15 — measureMemory
// ---------------------------------------------------------------------------

export function measureMemory(_options) {
  return Promise.reject(
    Object.assign(
      new Error('vm.measureMemory is not available in browser environments'),
      { code: 'ERR_CONTEXT_NOT_INITIALIZED' }
    )
  );
}

// ---------------------------------------------------------------------------
// Phase 16 — constants
// ---------------------------------------------------------------------------

export const constants = Object.freeze({
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm.USE_MAIN_CONTEXT_DEFAULT_LOADER'),
  DONT_CONTEXTIFY: Symbol('vm.DONT_CONTEXTIFY'),
});

// ---------------------------------------------------------------------------
// Phase 17 — Module stubs
// ---------------------------------------------------------------------------

export class Module {
  constructor() { throw new Error('Not implemented: vm.Module'); }
}
export class SourceTextModule {
  constructor() { throw new Error('Not implemented: vm.SourceTextModule'); }
}

/**
 * SyntheticModule — functional stub.
 * Correct status machine + setExport, but no real cross-context ESM binding.
 */
export class SyntheticModule {
  #exportNames;
  #evaluateCallback;
  #exports = {};
  #status  = 'unlinked';
  #error   = undefined;
  #context;
  #identifier;

  constructor(exportNames, evaluateCallback, options = {}) {
    if (!Array.isArray(exportNames))       throw new TypeError('exportNames must be an array');
    if (typeof evaluateCallback !== 'function') throw new TypeError('evaluateCallback must be a function');
    this.#exportNames       = exportNames;
    this.#evaluateCallback  = evaluateCallback;
    this.#context           = options.context ?? createContext({});
    this.#identifier        = options.identifier ?? `vm:module(${_ctxCounter})`;
    for (const name of exportNames) this.#exports[name] = undefined;
  }

  get status()     { return this.#status; }
  get identifier() { return this.#identifier; }
  get context()    { return this.#context; }
  get namespace()  { return { ...this.#exports }; }
  get error() {
    if (this.#status !== 'errored')
      throw new Error('Module is not in errored state');
    return this.#error;
  }

  setExport(name, value) {
    if (!Object.prototype.hasOwnProperty.call(this.#exports, name))
      throw new ReferenceError(`"${name}" is not defined in this SyntheticModule`);
    this.#exports[name] = value;
  }

  link(_linker) {
    this.#status = 'linked';
    return Promise.resolve();
  }

  evaluate(_options) {
    if (this.#status !== 'linked')
      return Promise.reject(new Error('Module must be linked before evaluation'));
    this.#status = 'evaluating';
    try {
      this.#evaluateCallback.call(this);
      this.#status = 'evaluated';
      return Promise.resolve(undefined);
    } catch (err) {
      this.#status = 'errored';
      this.#error  = err;
      return Promise.reject(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default {
  createContext,
  createScript,
  isContext,
  runInContext,
  runInNewContext,
  runInThisContext,
  Script,
  compileFunction,
  measureMemory,
  constants,
  Module,
  SourceTextModule,
  SyntheticModule,
};
