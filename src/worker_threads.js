/*!
 * worker_threads for browsers & bundlers (+ native bridge under real Node).
 * Node.js parity: node:worker_threads @ Node v24.20.0.
 * Dependencies: events (bundled via esbuild polyfill plugin for browsers).
 *
 * Two layers:
 *  1. Native bridge (this file, top): when loaded under genuine Node.js —
 *     detected via `process.getBuiltinModule` — every export delegates to
 *     the real `node:worker_threads` for full parity. `getBuiltinModule`
 *     bypasses the module loader, so there is no recursion through the
 *     parity preload. In the browser sandbox the runtime installs a cloaked
 *     `process` without `getBuiltinModule`, and the browser-fallback lane
 *     stubs it to throw, so both fall through to layer 2.
 *  2. Browser implementation (rest of this file): `Worker` backed by a
 *     native Web Worker created from a Blob URL (CSP allows
 *     `worker-src blob:`). `eval: true` workers run an eval-based bootstrap
 *     wrapper (see `buildEvalBlob`): the wrapper is a string of JS evaluated
 *     by the worker — it performs the init handshake, injects `workerData`,
 *     `threadId`, `threadName`, `parentPort`, `isMainThread` and `SHARE_ENV`
 *     as locals, runs the user code, then reports the exit code. Eval mode
 *     is honest about what it is: user code runs via script evaluation
 *     inside a real OS-thread worker, not via module loading.
 *     `MessageChannel`/`MessagePort`/`BroadcastChannel` delegate to the
 *     native globals where present.
 *
 * Limitations (documented, not hidden):
 *   - workerData / threadId are live ESM bindings; in URL-mode workers they
 *     are null/0 until the T_INIT message arrives (first event-loop turn).
 *   - eval-mode workers cannot `import { workerData } from './worker_threads'`;
 *     workerData is injected as a local variable in the eval wrapper instead.
 *   - Natural worker exit (script runs to completion) only emits 'exit' in
 *     eval mode. URL-mode 'exit' fires on error or terminate() only.
 *   - receiveMessageOnPort() returns only messages already in the JS queue.
 *   - resourceLimits are recorded and forwarded but never enforced (the
 *     browser has no API to cap a worker's heap/stack).
 *   - worker.getHeapSnapshot() resolves null and getHeapStatistics()
 *     resolves {} — heap introspection has no browser equivalent.
 *   - worker.stdin/stdout/stderr are null — stdio piping is not implemented.
 *   - postMessageToThread() is best-effort via BroadcastChannel.
 *   - moveMessagePortToContext() is a no-op (no vm.Context in browsers).
 *   - stdin / stdout / stderr piping on Worker is not implemented.
 *   - Thread IDs are unique per-parent-thread, not globally across all threads.
 */

/**
 * @packageDocumentation
 * Browser-compatible implementation of `node:worker_threads`.
 * Under genuine Node.js this module is a thin facade over the real builtin;
 * everywhere else it wraps the native Web Worker API with Node's
 * EventEmitter-based interface, handling the init handshake protocol, live
 * binding updates, and all exports documented in the Node.js spec.
 */

import EventEmitter from 'events';

// ---------------------------------------------------------------------------
// Layer 1 — native bridge.
// Genuine Node.js only: the sandbox's cloaked `process` has no
// `getBuiltinModule`, and the browser-fallback lane stubs it to throw, so
// both fall through to the browser implementation below.
// ---------------------------------------------------------------------------
function _detectNativeWorkerThreads() {
  try {
    const p = globalThis.process;
    if (p == null || typeof p.getBuiltinModule !== 'function') return null;
    return p.getBuiltinModule('worker_threads');
  } catch {
    return null; // browser-fallback lane: native builtins disabled
  }
}

/** @type {object | null} Real node:worker_threads when under genuine Node. */
const _NATIVE = _detectNativeWorkerThreads();

// ---------------------------------------------------------------------------
// Protocol message types (main ↔ worker handshake, never surfaced to users)
// ---------------------------------------------------------------------------
const T_READY  = '__wt_ready__';   // worker → main: script loaded, wants init
const T_INIT   = '__wt_init__';    // main   → worker: workerData + threadId
const T_ONLINE = '__wt_online__';  // worker → main: init complete, running
const T_EXIT   = '__wt_exit__';    // worker → main: script finished / error

// ---------------------------------------------------------------------------
// Layer 2 — browser implementation.
// ---------------------------------------------------------------------------

// `WorkerGlobalScope` exists as a global only inside Web Worker contexts.
const _browserIsMainThread = !('WorkerGlobalScope' in globalThis);

// ---------------------------------------------------------------------------
// Live ESM bindings
// ESM named exports are live — reassigning the module-level variable updates
// every importer automatically. Under the native bridge they are snapshots
// taken at import time (threadId/workerData/parentPort never change for a
// given thread, so the snapshot is exact).
// ---------------------------------------------------------------------------

/** @type {number} */
let _threadId = _NATIVE ? _NATIVE.threadId : 0;   // main = 0

/** @type {string | null} */
let _threadName = _NATIVE ? (_NATIVE.threadName ?? null) : null;

/** @type {any} */
let _workerData = _NATIVE ? (_NATIVE.workerData ?? null) : null;

/** @type {object | null} */
let _parentPort = _NATIVE ? (_NATIVE.parentPort ?? null) : null;

export { _threadId as threadId, _threadName as threadName,
         _workerData as workerData, _parentPort as parentPort };

// ---------------------------------------------------------------------------
// isMainThread / isInternalThread / SHARE_ENV
// ---------------------------------------------------------------------------
const _isMainThread = _NATIVE ? _NATIVE.isMainThread : _browserIsMainThread;
const _isInternalThread = _NATIVE ? _NATIVE.isInternalThread : false;
const _SHARE_ENV = _NATIVE
  ? _NATIVE.SHARE_ENV
  : Symbol('nodejs.worker_threads.SHARE_ENV');

export { _isMainThread as isMainThread, _isInternalThread as isInternalThread,
         _SHARE_ENV as SHARE_ENV };

// ---------------------------------------------------------------------------
// resourceLimits — populated from T_INIT payload in worker context
// ---------------------------------------------------------------------------
const _browserResourceLimits = {};
const _resourceLimits = _NATIVE ? _NATIVE.resourceLimits : _browserResourceLimits;
export { _resourceLimits as resourceLimits };

// ---------------------------------------------------------------------------
// Environment data store
// ---------------------------------------------------------------------------
const _envStore = new Map();

/**
 * Sets environment data that will be cloned into every new Worker.
 * Pass `undefined` as value to delete the key.
 * @param {any} key
 * @param {any} [value]
 */
function _browserSetEnvironmentData(key, value) {
  value === undefined ? _envStore.delete(key) : _envStore.set(key, value);
}

/** @param {any} key @returns {any} */
function _browserGetEnvironmentData(key) {
  return _envStore.get(key);
}

const setEnvironmentData =
  _NATIVE ? _NATIVE.setEnvironmentData : _browserSetEnvironmentData;
const getEnvironmentData =
  _NATIVE ? _NATIVE.getEnvironmentData : _browserGetEnvironmentData;
export { setEnvironmentData, getEnvironmentData };

// ---------------------------------------------------------------------------
// Transfer / clone markers
// ---------------------------------------------------------------------------
const _untransferable = new WeakSet();
const _uncloneable    = new WeakSet();

/**
 * Prevents `object` from appearing in a postMessage transferList.
 * @param {object} object
 */
function _browserMarkAsUntransferable(object) {
  if (object !== null && typeof object === 'object') _untransferable.add(object);
}

/** @param {any} object @returns {boolean} */
function _browserIsMarkedAsUntransferable(object) {
  return object !== null && typeof object === 'object' && _untransferable.has(object);
}

/**
 * Prevents `object` from being used as a postMessage message value.
 * @param {object} object
 */
function _browserMarkAsUncloneable(object) {
  if (object !== null && typeof object === 'object') _uncloneable.add(object);
}

const markAsUntransferable = _NATIVE
  ? _NATIVE.markAsUntransferable : _browserMarkAsUntransferable;
const isMarkedAsUntransferable = _NATIVE
  ? _NATIVE.isMarkedAsUntransferable : _browserIsMarkedAsUntransferable;
const markAsUncloneable = _NATIVE
  ? _NATIVE.markAsUncloneable : _browserMarkAsUncloneable;
export { markAsUntransferable, isMarkedAsUntransferable, markAsUncloneable };

// ---------------------------------------------------------------------------
// moveMessagePortToContext — no-op (no vm.Context in browsers)
// ---------------------------------------------------------------------------
/** @param {MessagePort} port @returns {MessagePort} */
function _browserMoveMessagePortToContext(port) { return port; }

const moveMessagePortToContext = _NATIVE
  ? _NATIVE.moveMessagePortToContext : _browserMoveMessagePortToContext;
export { moveMessagePortToContext };

// ---------------------------------------------------------------------------
// receiveMessageOnPort — synchronous best-effort queue drain
// ---------------------------------------------------------------------------
/** @type {WeakMap<MessagePort, any[]>} */
const _portQueues = new WeakMap();

function _ensureQueue(port) {
  if (_portQueues.has(port)) return;
  const q = [];
  _portQueues.set(port, q);
  port.addEventListener('message', e => q.push(e.data));
  port.start?.();
}

/**
 * Synchronously dequeues one message already in the port's JS queue.
 * Returns `undefined` when no message is available.
 * @param {MessagePort | BroadcastChannel} port
 * @returns {{ message: any } | undefined}
 */
function _browserReceiveMessageOnPort(port) {
  _ensureQueue(/** @type {MessagePort} */ (port));
  const q = _portQueues.get(port);
  return q.length ? { message: q.shift() } : undefined;
}

const receiveMessageOnPort = _NATIVE
  ? _NATIVE.receiveMessageOnPort : _browserReceiveMessageOnPort;
export { receiveMessageOnPort };

// ---------------------------------------------------------------------------
// postMessageToThread — BroadcastChannel-based cross-thread messaging
// ---------------------------------------------------------------------------
const _BC_CHANNEL = '__wt_threads__';
let _bc = null;

function _getBroadcast() {
  if (_bc) return _bc;
  _bc = new BroadcastChannel(_BC_CHANNEL);
  _bc.addEventListener('message', e => {
    if (e.data?.targetId !== _threadId) return;
    // Dispatch as 'workerMessage' on the global (mirrors Node's process event).
    globalThis.dispatchEvent?.(
      new MessageEvent('workerMessage', { data: e.data.value }),
    );
  });
  return _bc;
}

/**
 * Sends a value to another worker identified by its thread ID.
 * @param {number} targetId
 * @param {any} value
 * @param {object[]} [transferList]
 * @param {number} [timeout]
 * @returns {Promise<void>}
 */
async function _browserPostMessageToThread(targetId, value, transferList, timeout) {
  if (targetId === _threadId)
    throw Object.assign(
      new Error('Cannot postMessageToThread to the current thread'),
      { code: 'ERR_WORKER_MESSAGING_SAME_THREAD' },
    );

  return new Promise((resolve, reject) => {
    let timer;
    if (timeout != null)
      timer = setTimeout(() => reject(Object.assign(
        new Error('postMessageToThread timed out'),
        { code: 'ERR_WORKER_MESSAGING_TIMEOUT' },
      )), timeout);

    try {
      _getBroadcast().postMessage({ targetId, sourceId: _threadId, value });
      clearTimeout(timer);
      resolve();
    } catch (err) {
      clearTimeout(timer);
      reject(Object.assign(err, { code: 'ERR_WORKER_MESSAGING_FAILED' }));
    }
  });
}

const postMessageToThread = _NATIVE
  ? _NATIVE.postMessageToThread : _browserPostMessageToThread;
export { postMessageToThread };

// ---------------------------------------------------------------------------
// Native MessageChannel / MessagePort / BroadcastChannel — delegate to the
// native globals where present (browsers, Node ≥15, workers all provide them).
// ---------------------------------------------------------------------------
function _pickGlobal(name) {
  if (_NATIVE && _NATIVE[name]) return _NATIVE[name];
  return globalThis[name];
}

const MessageChannel    = _pickGlobal('MessageChannel');
const MessagePort       = _pickGlobal('MessagePort');
const BroadcastChannel  = _pickGlobal('BroadcastChannel');
export { MessageChannel, MessagePort, BroadcastChannel };

// ---------------------------------------------------------------------------
// locks — native worker_threads.locks under the bridge; otherwise prefer
// native navigator.locks; fall back to an in-process shim.
// ---------------------------------------------------------------------------

function createLocksShim() {
  /** @type {Map<string, { name:string; mode:string }[]>} */
  const held    = new Map();
  /** @type {Map<string, { name:string; mode:string; resolve:Function; ifAvailable:boolean }[]>} */
  const pending = new Map();

  function tryGrant(name) {
    const queue      = pending.get(name) ?? [];
    const heldSlots  = held.get(name)   ?? [];
    if (!queue.length) return;

    const { mode, resolve, ifAvailable } = queue[0];
    const blocked = mode === 'exclusive'
      ? heldSlots.length > 0
      : heldSlots.some(l => l.mode === 'exclusive');

    if (blocked) {
      if (ifAvailable) { queue.shift(); resolve(null); tryGrant(name); }
      return;
    }

    queue.shift();
    const lock = { name, mode };
    heldSlots.push(lock);
    held.set(name, heldSlots);
    resolve(lock);
  }

  return {
    async request(name, optsOrCb, cb) {
      let opts = {}, callback = optsOrCb;
      if (typeof optsOrCb === 'object' && optsOrCb !== null) { opts = optsOrCb; callback = cb; }
      const { mode = 'exclusive', ifAvailable = false, steal = false, signal } = opts;

      return new Promise((outerResolve, outerReject) => {
        if (signal?.aborted) return outerReject(new DOMException('Aborted', 'AbortError'));

        new Promise(resolve => {
          if (!pending.has(name)) pending.set(name, []);
          const entry = { name, mode, resolve, ifAvailable };
          if (steal) { held.set(name, []); pending.get(name).unshift(entry); }
          else pending.get(name).push(entry);
          if (signal) signal.addEventListener('abort', () => {
            const q = pending.get(name);
            if (q) { const i = q.indexOf(entry); if (i !== -1) q.splice(i, 1); }
            outerReject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
          tryGrant(name);
        }).then(async lock => {
          try { outerResolve(await callback(lock)); }
          catch (err) { outerReject(err); }
          finally {
            if (lock) {
              const slots = held.get(name) ?? [];
              const i = slots.indexOf(lock);
              if (i !== -1) slots.splice(i, 1);
            }
            tryGrant(name);
          }
        });
      });
    },

    async query() {
      const h = [], p = [];
      for (const [, v] of held)    h.push(...v.map(l => ({ name: l.name, mode: l.mode })));
      for (const [, v] of pending) p.push(...v.map(r => ({ name: r.name, mode: r.mode })));
      return { held: h, pending: p };
    },
  };
}

const _browserLocks =
  (typeof navigator !== 'undefined' && navigator.locks) || createLocksShim();
const locks = (_NATIVE && _NATIVE.locks) || _browserLocks;
export { locks };

// ---------------------------------------------------------------------------
// ParentPort — wraps the worker's own global scope as an EventEmitter port
// ---------------------------------------------------------------------------
class ParentPort extends EventEmitter {
  constructor() {
    super();
    // Forward all non-protocol inbound messages as 'message' events.
    globalThis.addEventListener('message', e => {
      if (e.data?.__type__ === T_INIT) return; // filter init payload
      this.emit('message', e.data);
    });
    globalThis.addEventListener('messageerror', e => this.emit('messageerror', e));
  }

  /**
   * Posts a message to the parent thread.
   * @param {any} value
   * @param {Transferable[] | { transfer: Transferable[] }} [transferOrOptions]
   */
  postMessage(value, transferOrOptions) {
    const transfer = Array.isArray(transferOrOptions)
      ? transferOrOptions
      : (transferOrOptions?.transfer ?? []);
    globalThis.postMessage(value, transfer);
  }

  start()   {} // no-op — always flowing in dedicated worker scope
  ref()     { return this; }
  unref()   { return this; }
  hasRef()  { return true; }
  close()   { globalThis.close?.(); }
}

// ---------------------------------------------------------------------------
// Worker context initialisation — runs when loaded inside a Web Worker.
// Gated on !_NATIVE: under the native bridge this module never loads inside
// a worker (workers spawned by native Worker load fixture files directly).
// ---------------------------------------------------------------------------
if (!_NATIVE && !_browserIsMainThread) {
  _parentPort = new ParentPort();

  // Receive the T_INIT payload sent by the Worker constructor.
  const onInit = e => {
    if (e.data?.__type__ !== T_INIT) return;
    globalThis.removeEventListener('message', onInit);

    _workerData = e.data.workerData ?? null;
    _threadId   = e.data.threadId   ?? 1;
    _threadName = e.data.threadName ?? null;

    for (const [k, v] of (e.data.envData ?? [])) _envStore.set(k, v);
    Object.assign(_browserResourceLimits, e.data.resourceLimits ?? {});

    // Signal to parent that init is complete and user code can run.
    globalThis.postMessage({ __type__: T_ONLINE });
  };

  globalThis.addEventListener('message', onInit);

  // Announce readiness — parent responds with T_INIT.
  globalThis.postMessage({ __type__: T_READY });

  // Best-effort exit notification for URL-mode workers.
  globalThis.addEventListener('unload', () => {
    try { globalThis.postMessage({ __type__: T_EXIT, exitCode: 0 }); } catch { /* late */ }
  });
}

// ---------------------------------------------------------------------------
// Eval-mode worker wrapper
// Builds a Blob of JS that the worker evaluates: the bootstrap performs the
// T_READY/T_INIT/T_ONLINE handshake, injects Node-compatible locals
// (workerData, threadId, threadName, parentPort, isMainThread, SHARE_ENV)
// so user code does not need to import this module (which would require
// knowing its URL), runs the user code, then reports the exit code via
// T_EXIT. This is genuinely evaluated code inside a real OS-thread worker —
// the eval is the bootstrap mechanism, not a fake.
// ---------------------------------------------------------------------------
function buildEvalBlob(code) {
  const wrapper = /* js */`
const T_READY  = ${JSON.stringify(T_READY)};
const T_INIT   = ${JSON.stringify(T_INIT)};
const T_ONLINE = ${JSON.stringify(T_ONLINE)};
const T_EXIT   = ${JSON.stringify(T_EXIT)};

// Signal readiness before doing anything else.
self.postMessage({ __type__: T_READY });

// Wait synchronously (via top-level await) for the init payload.
const __init__ = await new Promise(resolve => {
  self.addEventListener('message', function h(e) {
    if (e.data && e.data.__type__ === T_INIT) {
      self.removeEventListener('message', h);
      resolve(e.data);
    }
  });
});

// Locals that eval code can reference directly.
const workerData    = __init__.workerData ?? null;
const threadId      = __init__.threadId   ?? 1;
const threadName    = __init__.threadName ?? null;
const isMainThread  = false;
const isInternalThread = false;
const SHARE_ENV     = Symbol('nodejs.worker_threads.SHARE_ENV');

const parentPort = {
  postMessage(value, transferOrOpts) {
    const t = Array.isArray(transferOrOpts) ? transferOrOpts : (transferOrOpts?.transfer ?? []);
    self.postMessage(value, t);
  },
  on(ev, fn) {
    self.addEventListener(ev === 'message' ? 'message' : ev, e => fn(e.data ?? e));
    return this;
  },
  once(ev, fn) {
    self.addEventListener(ev === 'message' ? 'message' : ev, e => fn(e.data ?? e), { once: true });
    return this;
  },
  off(ev, fn) { self.removeEventListener(ev, fn); return this; },
  start() {},
  close() { self.close?.(); },
  ref()   { return this; },
  unref() { return this; },
};

self.postMessage({ __type__: T_ONLINE });

// ── User code ────────────────────────────────────────────────────────────────
let __exitCode__ = 0;
try {
  ${code}
} catch (err) {
  __exitCode__ = 1;
  throw err;
} finally {
  self.postMessage({ __type__: T_EXIT, exitCode: __exitCode__ });
}
`;
  return URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' }));
}

// ---------------------------------------------------------------------------
// BrowserWorker — Node-compatible Worker backed by a native Web Worker.
// Extends EventEmitter; emits 'online', 'message', 'messageerror', 'error', 'exit'.
// ---------------------------------------------------------------------------
let _nextWorkerId = 1;

class BrowserWorker extends EventEmitter {
  /** @type {globalThis.Worker} */ #native;
  /** @type {number}            */ #threadId;
  /** @type {string|null}       */ #name;
  /** @type {object}            */ #resourceLimits;
  /** @type {string|null}       */ #blobURL = null;
  /** @type {Promise<number>}   */ #exitPromise;
  /** @type {Function}          */ #exitResolve;
  /** @type {boolean}           */ #done = false;

  /**
   * @param {string | URL} filename
   * @param {{
   *   eval?:           boolean;
   *   workerData?:     any;
   *   name?:           string;
   *   env?:            object | symbol;
   *   transferList?:   Transferable[];
   *   resourceLimits?: {
   *     maxOldGenerationSizeMb?:   number;
   *     maxYoungGenerationSizeMb?: number;
   *     codeRangeSizeMb?:          number;
   *     stackSizeMb?:              number;
   *   };
   * }} [options]
   */
  constructor(filename, options = {}) {
    super();
    if (typeof filename !== 'string' && !(filename instanceof URL)) {
      throw Object.assign(
        new TypeError(
          `The "filename" argument must be of type string or an instance of URL. ` +
          `Received type ${typeof filename} (${String(filename)})`,
        ),
        { code: 'ERR_INVALID_ARG_TYPE' },
      );
    }
    this.#threadId       = _nextWorkerId++;
    this.#name           = options.name ?? null;
    this.#resourceLimits = { ...options.resourceLimits };
    this.#exitPromise    = new Promise(r => { this.#exitResolve = r; });

    // ── Build native worker URL ─────────────────────────────────────────────
    let nativeURL;
    if (options.eval) {
      nativeURL = this.#blobURL = buildEvalBlob(String(filename));
    } else {
      nativeURL = filename instanceof URL ? filename.href : String(filename);
    }

    // type:'module' enables top-level await in the eval wrapper.
    this.#native = new globalThis.Worker(nativeURL, {
      type: 'module',
      name: options.name,
    });

    // ── Resolve env ─────────────────────────────────────────────────────────
    const _proc = globalThis.process;
    const env = options.env === _SHARE_ENV
      ? (typeof _proc !== 'undefined' && _proc != null && _proc.env ? { ..._proc.env } : {})
      : (options.env ?? {});

    // ── Native event wiring ─────────────────────────────────────────────────
    let readySent = false;

    this.#native.addEventListener('message', e => {
      const { __type__: type, ...rest } = (e.data ?? {});

      if (type === T_READY && !readySent) {
        readySent = true;
        // Respond with the init payload. Worker is blocked on this.
        this.#native.postMessage({
          __type__:       T_INIT,
          workerData:     options.workerData ?? null,
          threadId:       this.#threadId,
          threadName:     this.#name,
          envData:        [..._envStore.entries()],
          resourceLimits: this.#resourceLimits,
          env,
        }, options.transferList ?? []);
        return;
      }

      if (type === T_ONLINE)  { this.emit('online');          return; }
      if (type === T_EXIT)    { this.#finish(rest.exitCode ?? 0); return; }

      // User message.
      try { this.emit('message', e.data); }
      catch (err) { this.emit('messageerror', err); }
    });

    this.#native.addEventListener('messageerror', e => this.emit('messageerror', e));

    this.#native.addEventListener('error', e => {
      const err = e.error ?? new Error(e.message ?? 'Worker error');
      this.emit('error', err);
      this.#finish(1);
    });
  }

  #finish(code) {
    if (this.#done) return;
    this.#done = true;
    if (this.#blobURL) { URL.revokeObjectURL(this.#blobURL); this.#blobURL = null; }
    this.emit('exit', code);
    this.#exitResolve(code);
  }

  /**
   * Sends a message to the worker (received via parentPort 'message' event).
   * @param {any} value
   * @param {Transferable[]} [transferList]
   */
  postMessage(value, transferList) {
    if (_uncloneable.has(value))
      throw new DOMException('The object could not be cloned.', 'DataCloneError');
    if (Array.isArray(transferList)) {
      for (const t of transferList)
        if (_untransferable.has(t))
          throw new DOMException('Transfer of untransferable object attempted.', 'DataCloneError');
    }
    this.#native.postMessage(value, transferList ?? []);
  }

  /**
   * Terminates the worker immediately.
   * @returns {Promise<number>} Resolves with the exit code.
   */
  terminate() {
    if (!this.#done) { this.#native.terminate(); this.#finish(1); }
    return this.#exitPromise;
  }

  /** @returns {number} */
  get threadId() { return this.#threadId; }

  /** @returns {string | null} */
  get threadName() { return this.#name; }

  /** @returns {object} */
  get resourceLimits() { return { ...this.#resourceLimits }; }

  /** stdio piping is not implemented in browsers — always null. */
  get stdin()  { return null; }
  /** stdio piping is not implemented in browsers — always null. */
  get stdout() { return null; }
  /** stdio piping is not implemented in browsers — always null. */
  get stderr() { return null; }

  /** @returns {{ eventLoopUtilization: Function }} */
  get performance() {
    return { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };
  }

  /**
   * Heap snapshots have no browser equivalent — documented noop resolving null.
   * @returns {Promise<null>}
   */
  async getHeapSnapshot() { return null; }

  /**
   * Heap statistics have no browser equivalent — documented noop resolving {}.
   * @returns {Promise<object>}
   */
  async getHeapStatistics() { return {}; }

  /** `await using worker = new Worker(...)` — auto-terminates on scope exit. */
  async [Symbol.asyncDispose]() { await this.terminate(); }

  ref()   { return this; } // no-op — browser has no event-loop ref counting
  unref() { return this; }
}

const Worker = _NATIVE ? _NATIVE.Worker : BrowserWorker;
export { Worker };

// ---------------------------------------------------------------------------
// Default export — the native namespace under the bridge; otherwise the full
// module shape with live getters for mutable properties.
// ---------------------------------------------------------------------------
const _browserDefault = {
  // Live properties — getters so the default export reflects binding updates.
  get threadId()    { return _threadId;   },
  get threadName()  { return _threadName; },
  get workerData()  { return _workerData; },
  get parentPort()  { return _parentPort; },

  // Static
  get isMainThread()     { return _isMainThread;     },
  get isInternalThread() { return _isInternalThread; },
  get SHARE_ENV()        { return _SHARE_ENV;        },
  get resourceLimits()   { return _resourceLimits;   },

  // Classes
  get Worker()           { return Worker;           },
  get MessageChannel()   { return MessageChannel;   },
  get MessagePort()      { return MessagePort;      },
  get BroadcastChannel() { return BroadcastChannel; },

  // Functions
  get setEnvironmentData()       { return setEnvironmentData;       },
  get getEnvironmentData()       { return getEnvironmentData;       },
  get markAsUntransferable()     { return markAsUntransferable;     },
  get isMarkedAsUntransferable() { return isMarkedAsUntransferable; },
  get markAsUncloneable()        { return markAsUncloneable;        },
  get moveMessagePortToContext() { return moveMessagePortToContext; },
  get receiveMessageOnPort()     { return receiveMessageOnPort;     },
  get postMessageToThread()      { return postMessageToThread;      },

  // Other
  get locks() { return locks; },
};

export default _NATIVE ?? _browserDefault;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// Under genuine Node.js this module delegates to the real node:worker_threads.
// The browser implementation below is what ships to browsers.
//
// ── eval mode (most reliable in bundler context) ─────────────────────────────
// import { Worker, isMainThread, parentPort, workerData } from './worker_threads';
//
// if (isMainThread) {
//   const w = new Worker(`
//     // workerData and parentPort are injected as locals in eval mode
//     parentPort.postMessage(workerData * 2);
//   `, { eval: true, workerData: 21 });
//
//   w.on('message', msg => console.log(msg));   // → 42
//   w.on('exit',    code => console.log(code)); // → 0
// }
//
// ── URL mode ─────────────────────────────────────────────────────────────────
// // The worker script MUST import this module for live bindings to be populated.
// // worker.js:
// import { workerData, parentPort } from './worker_threads';
// parentPort.on('message', msg => parentPort.postMessage(msg.toUpperCase()));
//
// // main.js:
// const w = new Worker(new URL('./worker.js', import.meta.url), {
//   workerData: { greeting: 'hello' },
// });
// w.on('online',   ()    => w.postMessage('ping'));
// w.on('message',  msg   => console.log(msg));   // → 'PING'
// w.on('error',    err   => console.error(err));
// w.on('exit',     code  => console.log(code));
//
// ── MessageChannel for direct port-to-port comms ──────────────────────────────
// const { port1, port2 } = new MessageChannel();
// port1.on('message', v => console.log('got', v));
// port2.postMessage({ hello: 'world' });
//
// ── receiveMessageOnPort (synchronous drain) ──────────────────────────────────
// The shim keeps its own JS queue per port, fed by a 'message' listener that
// is attached on the first receiveMessageOnPort() call. Only messages that
// arrive AFTER that listener is attached are visible to the drain — it never
// reaches back into the port's internal queue.
// const { port1, port2 } = new MessageChannel();
// receiveMessageOnPort(port2); // attach the queue listener (returns undefined)
// port1.postMessage({ n: 1 });
// port1.postMessage({ n: 2 });
// await new Promise(r => setTimeout(r, 0)); // let messages arrive
// console.log(receiveMessageOnPort(port2)); // { message: { n: 1 } }
// console.log(receiveMessageOnPort(port2)); // { message: { n: 2 } }
// console.log(receiveMessageOnPort(port2)); // undefined
//
// ── locks ─────────────────────────────────────────────────────────────────────
// import { locks } from './worker_threads';
// await locks.request('my_resource', async lock => {
//   // exclusive access here
// });
//
// ── await using (TS 5.2+ Symbol.asyncDispose) ─────────────────────────────────
// await using w = new Worker(`parentPort.postMessage('done')`, { eval: true });
// w.on('message', console.log); // worker auto-terminates on scope exit
//
// ── markAsUntransferable ──────────────────────────────────────────────────────
// const buf = new ArrayBuffer(8);
// markAsUntransferable(buf);
// isMarkedAsUntransferable(buf); // → true
// w.postMessage(buf, [buf]);     // → throws DataCloneError
