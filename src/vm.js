/**
 * vm.js — Browser-compatible polyfill for Node.js `node:vm` module
 *
 * IMPORTANT DEVIATIONS FROM NODE.JS:
 * - All `run*` methods return Promises (Node.js returns synchronously).
 *   The browser cannot block the event loop; async drain is required.
 * - Synchronous infinite loops (`while(true)`) cannot be terminated.
 *   Use a Worker for CPU-bound sandboxing.
 * - `setTimeout` returns a numeric ID (same as native). It is NOT a function.
 *   Calling `.bind()` on it is a TypeError — this is spec-correct behaviour.
 *
 * NOT IMPLEMENTED (throws `Error('Not implemented: ...')`):
 * - vm.Module
 * - vm.SourceTextModule
 * - vm.SyntheticModule
 * - vm.compileFunction()
 * - vm.measureMemory()
 */

// ---------------------------------------------------------------------------
// Phase 0: Capture host primitives at module load time — immune to user code
// ---------------------------------------------------------------------------
const _ST    = globalThis.setTimeout;
const _CT    = globalThis.clearTimeout;
const _SI    = globalThis.setInterval;
const _CI    = globalThis.clearInterval;
const _fetch = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : undefined;

// ---------------------------------------------------------------------------
// Phase 1: Per-run timer registry
// ---------------------------------------------------------------------------

/**
 * Creates patched timer functions that track in-flight timers in a registry.
 * @param {Map} registry  - Fresh Map per run. Shape: Map<id, {type, created, delay}>
 * @param {object} [hooks] - Optional { onError(err) } for surfacing callback errors
 */
function makeTimerPatches(registry, hooks = {}) {
  const onError = hooks.onError ?? ((err) => console.error('[vm polyfill] timer callback error:', err));

  const patchedSetTimeout = function (fn, delay, ...args) {
    if (typeof fn !== 'function') {
      // Node.js accepts string code — not implemented in browser sandboxing context
      throw new Error('Not implemented: setTimeout with string code argument');
    }
    let id;
    id = _ST(() => {
      registry.delete(id);
      try { fn(...args); } catch (err) { onError(err); }
    }, Math.max(0, delay ?? 0));
    registry.set(id, { type: 'timeout', created: Date.now(), delay: delay ?? 0 });
    // Returns a numeric ID — NOT a function. .bind() on it will TypeError.
    return id;
  };

  const patchedClearTimeout = function (id) {
    registry.delete(id);
    _CT(id);
  };

  const patchedSetInterval = function (fn, delay, ...args) {
    if (typeof fn !== 'function') {
      throw new Error('Not implemented: setInterval with string code argument');
    }
    const id = _SI(() => {
      // Interval stays in registry until clearInterval is called
      try { fn(...args); } catch (err) { onError(err); }
    }, Math.max(0, delay ?? 0));
    registry.set(id, { type: 'interval', created: Date.now(), delay: delay ?? 0 });
    return id;
  };

  const patchedClearInterval = function (id) {
    registry.delete(id);
    _CI(id);
  };

  return { patchedSetTimeout, patchedClearTimeout, patchedSetInterval, patchedClearInterval };
}

// ---------------------------------------------------------------------------
// Phase 2: Fetch and XHR tracking
// ---------------------------------------------------------------------------

function makeNetworkPatches(counters) {
  // counters = { fetches: 0, xhrs: 0 }

  const patchedFetch = _fetch
    ? async (...args) => {
        counters.fetches++;
        try { return await _fetch(...args); }
        finally { counters.fetches--; }
      }
    : undefined;

  const PatchedXHR = typeof XMLHttpRequest !== 'undefined'
    ? class PatchedXHR extends XMLHttpRequest {
        send(...args) {
          counters.xhrs++;
          const done = () => { if (counters.xhrs > 0) counters.xhrs--; };
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
// Phase 3: waitForSettled — async drain loop
// ---------------------------------------------------------------------------

/**
 * Polls until the registry is empty and all network counters are zero,
 * or until the deadline is exceeded.
 *
 * Uses a 16ms poll interval (one frame) to allow the browser to process
 * batches of timer callbacks without starving other tasks.
 *
 * Nested timers are naturally handled: new IDs are added to `registry`
 * before `waitForSettled` can observe size === 0, so the loop continues.
 *
 * @param {Map}    registry   - Per-run timer registry
 * @param {object} counters   - { fetches, xhrs }
 * @param {number} timeoutMs  - Wall-clock deadline in ms
 */
async function waitForSettled(registry, counters, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  const hasWork = () =>
    registry.size > 0 ||
    counters.fetches > 0 ||
    counters.xhrs > 0;

  while (hasWork()) {
    if (Date.now() >= deadline) {
      const err = new Error(`Script execution timed out after ${timeoutMs}ms`);
      err.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      throw err;
    }
    // Yield one frame — lets queued timer callbacks and microtasks run
    // Uses _ST (host original) — never the patched version
    await new Promise(r => _ST(r, 16));
    // Flush microtask queue (promise continuations that just became ready)
    await Promise.resolve();
    await Promise.resolve();
  }

  // Final flush: catch any microtasks spawned by the last callback
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Phase 4: clearAllPending — safety valve
// ---------------------------------------------------------------------------

/**
 * Cancels all in-flight timers in the registry and clears it.
 * Called in every finally block.
 */
function clearAllPending(registry) {
  for (const [id, { type }] of registry) {
    if (type === 'timeout')  _CT(id);
    if (type === 'interval') _CI(id);
  }
  registry.clear();
}

// ---------------------------------------------------------------------------
// Phase 5: Iframe lifecycle — fresh iframe per run, never reused
// ---------------------------------------------------------------------------

function createSandboxIframe() {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'display:none;width:0;height:0;border:0;position:absolute;';
  // allow-scripts: strictest useful setting. Prevents localStorage, cookies, document.cookie.
  // Add allow-same-origin only if same-origin DOM access is explicitly required.
  iframe.sandbox = 'allow-scripts';
  document.body.appendChild(iframe);
  return iframe;
}

function destroySandboxIframe(iframe) {
  if (iframe && iframe.parentNode) {
    iframe.parentNode.removeChild(iframe);
  }
}

// ---------------------------------------------------------------------------
// Phase 6: Context injection and extraction
// ---------------------------------------------------------------------------

// Globals that must never be copied back from the sandbox window to contextObject.
// These are browser-specific and would pollute user context with iframe internals.
const BROWSER_INTERNALS = new Set([
  'window', 'self', 'top', 'parent', 'frames', 'frameElement', 'globalThis',
  'document', 'location', 'history', 'navigator', 'screen', 'performance',
  'crypto', 'indexedDB', 'sessionStorage', 'localStorage', 'caches',
  'opener', 'closed', 'length', 'name', 'origin', 'customElements',
  'alert', 'confirm', 'prompt', 'print', 'focus', 'blur', 'open', 'close',
  'postMessage', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'queueMicrotask',
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'getComputedStyle', 'matchMedia', 'visualViewport',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', // controlled by polyfill
  'fetch', 'XMLHttpRequest', // controlled by polyfill
  'reportError', 'structuredClone',
  'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN',
  'parseFloat', 'parseInt', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'Object', 'Function', 'Boolean',
  'Symbol', 'Error', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError', 'Number', 'BigInt', 'Math',
  'Date', 'String', 'RegExp', 'Array', 'Int8Array', 'Uint8Array',
  'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'ArrayBuffer', 'SharedArrayBuffer', 'Atomics', 'DataView', 'JSON',
  'Promise', 'Generator', 'GeneratorFunction', 'AsyncFunction',
  'Reflect', 'Proxy', 'Intl', 'WebAssembly',
  'console', 'AbortController', 'AbortSignal', 'Blob', 'File',
  'FormData', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream',
  'TransformStream', 'CompressionStream', 'DecompressionStream',
  'BroadcastChannel', 'MessageChannel', 'MessageEvent', 'EventTarget',
  'Event', 'CustomEvent', 'ErrorEvent', 'PromiseRejectionEvent',
]);

/**
 * Inject user context properties into the iframe window, then install
 * our patched timer/network functions (overriding whatever win has).
 *
 * NOTE: If contextObject has a property named 'setTimeout', it will be
 * written to win, then immediately overwritten by patches.patchedSetTimeout.
 * The user's value is effectively shadowed. This is intentional.
 */
function injectContext(win, contextObject, patches) {
  for (const key of Object.keys(contextObject)) {
    try { win[key] = contextObject[key]; } catch (_) { /* frozen win props */ }
  }
  win.setTimeout    = patches.patchedSetTimeout;
  win.clearTimeout  = patches.patchedClearTimeout;
  win.setInterval   = patches.patchedSetInterval;
  win.clearInterval = patches.patchedClearInterval;
  if (patches.patchedFetch) win.fetch = patches.patchedFetch;
  if (patches.PatchedXHR)   win.XMLHttpRequest = patches.PatchedXHR;
}

/**
 * Copy sandbox window state back to contextObject after the run.
 * Only copies:
 *  - keys that existed in contextObject before the run, OR
 *  - new keys created by user code that are not browser internals
 */
function extractContext(win, contextObject, preRunWinKeys) {
  let currentKeys;
  try {
    currentKeys = Object.keys(win);
  } catch (_) {
    // win may be inaccessible if iframe was already destroyed
    return;
  }
  for (const key of currentKeys) {
    if (BROWSER_INTERNALS.has(key)) continue;
    if (key in contextObject || !preRunWinKeys.has(key)) {
      try { contextObject[key] = win[key]; } catch (_) { /* read-only */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 7: Core execution engine
// ---------------------------------------------------------------------------

function enrichError(err, options) {
  if (options.filename && err && err.stack) {
    err.stack = err.stack.replace('evalmachine.<anonymous>', options.filename);
    err.stack = err.stack.replace(/<anonymous>/g, options.filename);
  }
}

/**
 * Execute code in a fresh sandboxed iframe with full async support.
 * @param {string} code           - JavaScript source to execute
 * @param {object} contextObject  - Variables to inject as globals; mutated in-place with results
 * @param {object} [options]      - { timeout, filename, onError }
 * @returns {Promise<*>}          - Resolves with the last expression value
 */
async function executeInIframe(code, contextObject, options = {}) {
  if (contextObject !== null && typeof contextObject !== 'object') {
    throw new TypeError('contextObject must be an object or undefined');
  }
  contextObject = contextObject ?? {};

  // options.timeout === 0 or negative → use default (Node.js omits these; we default to 30s)
  const timeout = (typeof options.timeout === 'number' && options.timeout > 0)
    ? options.timeout
    : 30_000;

  const registry = new Map();
  const counters  = { fetches: 0, xhrs: 0 };
  const hooks     = { onError: options.onError };
  const patches   = {
    ...makeTimerPatches(registry, hooks),
    ...makeNetworkPatches(counters),
  };

  const iframe = createSandboxIframe();
  const win    = iframe.contentWindow;
  const preRunWinKeys = new Set(Object.keys(win));

  // Set up the timeout promise using the host _ST (immune to sandboxing)
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = _ST(() => {
      const e = new Error(`Script execution timed out after ${timeout}ms`);
      e.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      reject(e);
    }, timeout);
  });

  let syncResult;
  try {
    injectContext(win, contextObject, patches);

    // Wrap ALL user code in async IIFE — supports top-level await transparently
    const wrappedCode = `(async function __vmRun__() {\n${code}\n})()`;

    let executionPromise;
    try {
      executionPromise = win.eval(wrappedCode);
    } catch (err) {
      // Syntax errors throw synchronously from eval
      enrichError(err, options);
      throw err;
    }

    // Race: user's async IIFE vs hard wall-clock timeout
    syncResult = await Promise.race([executionPromise, timeoutPromise]);

    // Drain remaining async work (nested timers, in-flight fetch, etc.)
    await waitForSettled(registry, counters, timeout);

  } finally {
    _CT(timeoutId); // cancel the timeout sentinel
    clearAllPending(registry);
    extractContext(win, contextObject, preRunWinKeys);
    destroySandboxIframe(iframe);
  }

  return syncResult;
}

// ---------------------------------------------------------------------------
// Phase 8: runInThisContext — no iframe, patches host globals temporarily
// ---------------------------------------------------------------------------

/**
 * Execute code in the host global scope.
 *
 * Uses indirect eval `(0, eval)(...)` so user code runs at global scope
 * and cannot access local variables from this polyfill — matching Node.js
 * `runInThisContext` guarantees.
 *
 * Host globals (setTimeout etc.) are temporarily patched and ALWAYS reverted
 * in the finally block, even if user code crashes or times out.
 *
 * CONCURRENT CALL SAFETY: Each call saves globalThis.setTimeout at its own
 * entry point (capturing the previous patch if any). The finally block reverts
 * to exactly that value, so the revert stack unwinds correctly regardless of
 * how many concurrent calls are in flight.
 */
async function runInThisContext(code, options = {}) {
  if (typeof options === 'string') options = { filename: options };

  const timeout = (typeof options.timeout === 'number' && options.timeout > 0)
    ? options.timeout
    : 30_000;

  const registry = new Map();
  const counters  = { fetches: 0, xhrs: 0 };
  const hooks     = { onError: options.onError };
  const patches   = {
    ...makeTimerPatches(registry, hooks),
    ...makeNetworkPatches(counters),
  };

  // Save whatever is current at THIS call's entry point (may be another patch)
  const prevST  = globalThis.setTimeout;
  const prevCT  = globalThis.clearTimeout;
  const prevSI  = globalThis.setInterval;
  const prevCI  = globalThis.clearInterval;
  const prevFetch = globalThis.fetch;
  const prevXHR   = typeof XMLHttpRequest !== 'undefined' ? globalThis.XMLHttpRequest : undefined;

  globalThis.setTimeout    = patches.patchedSetTimeout;
  globalThis.clearTimeout  = patches.patchedClearTimeout;
  globalThis.setInterval   = patches.patchedSetInterval;
  globalThis.clearInterval = patches.patchedClearInterval;
  if (patches.patchedFetch) globalThis.fetch = patches.patchedFetch;
  if (patches.PatchedXHR)   globalThis.XMLHttpRequest = patches.PatchedXHR;

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = _ST(() => {
      const e = new Error(`Script execution timed out after ${timeout}ms`);
      e.code = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      reject(e);
    }, timeout);
  });

  let result;
  try {
    // Wrap in async IIFE to support top-level await
    const wrappedCode = `(async function __vmRunThis__() {\n${code}\n})()`;

    let executionPromise;
    try {
      // Indirect eval — runs at global scope, no access to local polyfill vars
      // eslint-disable-next-line no-eval
      executionPromise = (0, eval)(wrappedCode);
    } catch (err) {
      enrichError(err, options);
      throw err;
    }

    result = await Promise.race([executionPromise, timeoutPromise]);
    await waitForSettled(registry, counters, timeout);

  } finally {
    // ALWAYS revert — even on crash or timeout
    _CT(timeoutId);
    globalThis.setTimeout    = prevST;
    globalThis.clearTimeout  = prevCT;
    globalThis.setInterval   = prevSI;
    globalThis.clearInterval = prevCI;
    if (prevFetch !== undefined) globalThis.fetch = prevFetch;
    else if (patches.patchedFetch) delete globalThis.fetch;
    if (prevXHR !== undefined) globalThis.XMLHttpRequest = prevXHR;
    else if (patches.PatchedXHR) delete globalThis.XMLHttpRequest;
    clearAllPending(registry);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Phase 9: Public API
// ---------------------------------------------------------------------------

const CONTEXT_TAG = Symbol('vm.contextified');
let contextCounter = 0;

/**
 * Mark an object as a vm context. Returns the same object.
 * @param {object} [contextObject={}]
 * @param {object} [options]           - { name }
 */
export function createContext(contextObject = {}, options = {}) {
  if (contextObject !== null && typeof contextObject !== 'object') {
    throw new TypeError('contextObject must be an object');
  }
  if (CONTEXT_TAG in contextObject) {
    // Already contextified — Node.js returns it unchanged
    return contextObject;
  }
  Object.defineProperty(contextObject, CONTEXT_TAG, {
    value: { name: options.name ?? `VM Context ${++contextCounter}` },
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return contextObject;
}

/**
 * Returns true if object was previously passed to createContext().
 */
export function isContext(object) {
  return typeof object === 'object' && object !== null && CONTEXT_TAG in object;
}

/**
 * Execute code in a contextified object's sandbox.
 * @param {string} code
 * @param {object} contextifiedObject  - Must be produced by createContext()
 * @param {object|string} [options]    - { timeout, filename } or filename string
 * @returns {Promise<*>}
 */
export async function runInContext(code, contextifiedObject, options = {}) {
  if (!isContext(contextifiedObject)) {
    throw new TypeError(
      'contextifiedObject must be a vm.Context — call vm.createContext() first'
    );
  }
  if (typeof options === 'string') options = { filename: options };
  return executeInIframe(code, contextifiedObject, options);
}

/**
 * Create a new context from contextObject, execute code in it, return result.
 * Mutations to contextObject are reflected back after the run.
 * @param {string} code
 * @param {object} [contextObject={}]
 * @param {object|string} [options]
 * @returns {Promise<*>}
 */
export async function runInNewContext(code, contextObject, options = {}) {
  if (typeof options === 'string') options = { filename: options };
  const ctx = createContext(contextObject ?? {}, options);
  return executeInIframe(code, ctx, options);
}

export { runInThisContext };

/**
 * A compiled script that can be run multiple times.
 * Unlike Node.js, each run*() call re-evaluates the source (no bytecode cache).
 */
export class Script {
  #code;
  #options;

  constructor(code, options = {}) {
    if (typeof code !== 'string') throw new TypeError('code must be a string');
    if (typeof options === 'string') options = { filename: options };
    this.#code    = code;
    this.#options = { ...options };
  }

  /** @returns {Promise<*>} */
  runInContext(ctx, opts = {}) {
    return runInContext(this.#code, ctx, { ...this.#options, ...opts });
  }

  /** @returns {Promise<*>} */
  runInNewContext(obj, opts = {}) {
    return runInNewContext(this.#code, obj, { ...this.#options, ...opts });
  }

  /** @returns {Promise<*>} */
  runInThisContext(opts = {}) {
    return runInThisContext(this.#code, { ...this.#options, ...opts });
  }
}

// Not implemented — throw rather than silently fail
export function compileFunction() {
  throw new Error('Not implemented: vm.compileFunction()');
}

export function measureMemory() {
  throw new Error('Not implemented: vm.measureMemory()');
}

export const constants = {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('USE_MAIN_CONTEXT_DEFAULT_LOADER'),
  DONT_CONTEXTIFY: Symbol('DONT_CONTEXTIFY'),
};

// Module types are not implementable without Node.js internals
export class Module {
  constructor() { throw new Error('Not implemented: vm.Module'); }
}

export class SourceTextModule {
  constructor() { throw new Error('Not implemented: vm.SourceTextModule'); }
}

export class SyntheticModule {
  constructor() { throw new Error('Not implemented: vm.SyntheticModule'); }
}

export default {
  createContext,
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
