// src/worker_threads.js — port of node:worker_threads for the browser runtime.
//
// Workers run as real native Web Workers created from blob: URLs. Two modes:
//
// - eval: true — the first constructor argument is JavaScript source, evaluated
//   in the worker.
// - URL mode — the first argument is a filename. The file is read out of the
//   virtual filesystem (globalThis._RUNTIME_.__FS__ / __USER_FILES__) and its
//   source is bundled into the worker blob. A bare relative path handed
//   directly to the native Worker would resolve against the page's HTTP
//   origin (404 -> a load failure whose error event carries no error object),
//   which is exactly what produced gap #9's generic "Worker error" + exit 1.
//   Resolving through the VFS first is the faithful equivalent of Node
//   reading the file off disk.
//
// Absolute URLs (http:, https:, blob:, data:, …) bypass the VFS entirely and
// are passed straight to the native Worker.
//
// The parent and the worker bootstrap coordinate through a small handshake:
// the worker posts __wt_ready__, the parent replies with __wt_init__
// (workerData, threadId, threadName, environment data, resource limits), the
// worker posts __wt_online__, and user code runs. Task completion (or an
// uncaught exception) is reported with __wt_exit__ carrying the exit code and
// a serialized { message, name, stack } error. The parent re-raises the real
// error on 'error' BEFORE emitting 'exit', matching Node's ordering.
//
// Task files get a minimal require(): only 'worker_threads' (and
// 'node:worker_threads') resolve, to an object exposing the injected locals
// (parentPort, workerData, threadId, threadName, isMainThread,
// isInternalThread, SHARE_ENV). Any other specifier throws a clear
// MODULE_NOT_FOUND — a worker blob can resolve neither the VFS nor the
// network, so failing loudly beats a silent undefined.
//
// Known limitations (documented, not silent):
// - Static `import` statements in task files are not rewritten; use require().
// - Only the worker_threads require is supported (see above).
// - resourceLimits are accepted and echoed but not enforced.
// - Locks use navigator.locks when available, otherwise a JS fallback.
//
// When loaded under real Node (parity tests), the native worker_threads is
// preferred via process.getBuiltinModule; the browser implementation below
// is used only when there is no native module (or it is disabled).

import { maskAsNative } from "./_cloak.js";

// ── Minimal EventEmitter ─────────────────────────────────────────────────────
// Inlined (rather than importing ./events.js) because ./events.js pulls in
// ./async_hooks.js -> the 'als-browser' npm package, which is unavailable in
// the browser bundle. This covers the surface Worker needs: on/once/off,
// emit (throwing on unhandled 'error', per Node), and removeAllListeners.
class EventEmitter {
  constructor() {
    this._events = undefined;
    this._eventsCount = 0;
  }
  _getListeners(type, create) {
    if (this._events === undefined) {
      if (!create) return undefined;
      this._events = Object.create(null);
    }
    let list = this._events[type];
    if (list === undefined && create) {
      list = this._events[type] = [];
      this._eventsCount++;
    }
    return list;
  }
  on(type, listener) {
    if (typeof listener !== "function") {
      throw new TypeError(
        `The "listener" argument must be of type Function. Received type ${typeof listener}`,
      );
    }
    this._getListeners(type, true).push({ listener, once: false });
    return this;
  }
  once(type, listener) {
    if (typeof listener !== "function") {
      throw new TypeError(
        `The "listener" argument must be of type Function. Received type ${typeof listener}`,
      );
    }
    this._getListeners(type, true).push({ listener, once: true });
    return this;
  }
  off(type, listener) {
    return this.removeListener(type, listener);
  }
  removeListener(type, listener) {
    const list = this._getListeners(type, false);
    if (list) {
      for (let i = 0; i < list.length; i++) {
        if (list[i].listener === listener) {
          list.splice(i, 1);
          if (list.length === 0) {
            delete this._events[type];
            this._eventsCount--;
          }
          break;
        }
      }
    }
    return this;
  }
  removeAllListeners(type) {
    if (this._events === undefined) return this;
    if (type === undefined) {
      this._events = Object.create(null);
      this._eventsCount = 0;
    } else if (this._events[type] !== undefined) {
      delete this._events[type];
      this._eventsCount--;
    }
    return this;
  }
  emit(type, ...args) {
    const list = this._getListeners(type, false);
    if (!list || list.length === 0) {
      if (type === "error") {
        const err = args[0];
        throw err instanceof Error
          ? err
          : new Error(`Unhandled error. (${err})`);
      }
      return false;
    }
    // Copy: once() listeners remove themselves during emit.
    for (const entry of [...list]) {
      if (entry.once) this.removeListener(type, entry.listener);
      entry.listener.apply(this, args);
    }
    return true;
  }
  listenerCount(type) {
    return this._getListeners(type, false)?.length ?? 0;
  }
  static once(emitter, type) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        emitter.removeListener(type, onEvent);
        reject(err);
      };
      const onEvent = (...args) => {
        emitter.removeListener("error", onError);
        resolve(args);
      };
      emitter.once(type, onEvent);
      if (type !== "error") emitter.once("error", onError);
    });
  }
}

/**
 * Returns the native worker_threads module when one is available, else null.
 * Never throws: under the bundleVFS sandbox (or with the native bridge
 * disabled) this resolves to null and the browser implementation is used.
 */
function getNativeWorkerThreads() {
  try {
    const proc = globalThis.process;
    if (proc == null || typeof proc.getBuiltinModule !== "function")
      return null;
    return proc.getBuiltinModule("worker_threads");
  } catch {
    return null;
  }
}

const nativeWt = getNativeWorkerThreads();

// ── Parent <-> worker bootstrap protocol ─────────────────────────────────────
const T_READY = "__wt_ready__";
const T_INIT = "__wt_init__";
const T_ONLINE = "__wt_online__";
const T_EXIT = "__wt_exit__";

// ── Main-thread state ────────────────────────────────────────────────────────
// Inside a real Node worker (or a worker bootstrap created below) the native
// module supplies these; on the main thread they are the Node defaults.
const isWorkerScope = "WorkerGlobalScope" in globalThis;
let threadId = nativeWt ? nativeWt.threadId : 0;
let threadName = nativeWt ? (nativeWt.threadName ?? null) : null;
let workerData = nativeWt ? (nativeWt.workerData ?? null) : null;
let parentPort = nativeWt ? (nativeWt.parentPort ?? null) : null;

const isMainThread = nativeWt ? nativeWt.isMainThread : !isWorkerScope;
const isInternalThread = nativeWt ? nativeWt.isInternalThread : false;
const SHARE_ENV = nativeWt
  ? nativeWt.SHARE_ENV
  : Symbol("nodejs.worker_threads.SHARE_ENV");

// resourceLimits is a plain object snapshot on the main thread.
const _emptyLimits = {};
const resourceLimits = nativeWt ? nativeWt.resourceLimits : _emptyLimits;

// ── Environment data (setEnvironmentData / getEnvironmentData) ─────────────
const _envData = new Map();
function _setEnvironmentData(key, value) {
  if (value === undefined) _envData.delete(key);
  else _envData.set(key, value);
}
function _getEnvironmentData(key) {
  return _envData.get(key);
}
const setEnvironmentData = nativeWt
  ? nativeWt.setEnvironmentData
  : _setEnvironmentData;
const getEnvironmentData = nativeWt
  ? nativeWt.getEnvironmentData
  : _getEnvironmentData;

// ── Transfer/clone marking ───────────────────────────────────────────────────
const _untransferable = new WeakSet();
const _uncloneable = new WeakSet();
function _markAsUntransferable(obj) {
  if (obj !== null && typeof obj === "object") _untransferable.add(obj);
}
function _isMarkedAsUntransferable(obj) {
  return obj !== null && typeof obj === "object" && _untransferable.has(obj);
}
function _markAsUncloneable(obj) {
  if (obj !== null && typeof obj === "object") _uncloneable.add(obj);
}
const markAsUntransferable = nativeWt
  ? nativeWt.markAsUntransferable
  : _markAsUntransferable;
const isMarkedAsUntransferable = nativeWt
  ? nativeWt.isMarkedAsUntransferable
  : _isMarkedAsUntransferable;
const markAsUncloneable = nativeWt
  ? nativeWt.markAsUncloneable
  : _markAsUncloneable;

// ── receiveMessageOnPort ─────────────────────────────────────────────────────
// Synchronous drain of a MessagePort's queued messages. Attaches a listener
// on first use so messages arriving after that point are captured.
const _portQueues = new WeakMap();
function _ensurePortQueue(port) {
  if (_portQueues.has(port)) return;
  const queue = [];
  _portQueues.set(port, queue);
  port.addEventListener("message", (e) => queue.push(e.data));
  port.start?.();
}
function _receiveMessageOnPort(port) {
  _ensurePortQueue(port);
  const queue = _portQueues.get(port);
  return queue.length ? { message: queue.shift() } : undefined;
}
const receiveMessageOnPort = nativeWt
  ? nativeWt.receiveMessageOnPort
  : _receiveMessageOnPort;

function _moveMessagePortToContext(port) {
  return port;
}
const moveMessagePortToContext = nativeWt
  ? nativeWt.moveMessagePortToContext
  : _moveMessagePortToContext;

// ── postMessageToThread ──────────────────────────────────────────────────────
// Cross-thread messaging via a shared BroadcastChannel. Rejects when
// targeting the current thread, matching Node's ERR_WORKER_MESSAGING_* codes.
const _threadChannelName = "__wt_threads__";
let _threadChannel = null;
function _threadChannelLazy() {
  return (
    _threadChannel ||
    ((_threadChannel = new BroadcastChannel(_threadChannelName)),
    _threadChannel.addEventListener("message", (e) => {
      if (e.data?.targetId === threadId) {
        globalThis.dispatchEvent?.(
          new MessageEvent("workerMessage", { data: e.data.value }),
        );
      }
    }),
    _threadChannel)
  );
}
async function _postMessageToThread(
  threadIdTarget,
  value,
  transferList,
  timeout,
) {
  if (threadIdTarget === threadId) {
    throw Object.assign(
      new Error("Cannot postMessageToThread to the current thread"),
      { code: "ERR_WORKER_MESSAGING_SAME_THREAD" },
    );
  }
  return new Promise((resolve, reject) => {
    let timer;
    if (timeout != null) {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error("postMessageToThread timed out"), {
              code: "ERR_WORKER_MESSAGING_TIMEOUT",
            }),
          ),
        timeout,
      );
    }
    try {
      _threadChannelLazy().postMessage({
        targetId: threadIdTarget,
        sourceId: threadId,
        value,
      });
      clearTimeout(timer);
      resolve();
    } catch (err) {
      clearTimeout(timer);
      reject(Object.assign(err, { code: "ERR_WORKER_MESSAGING_FAILED" }));
    }
  });
}
const postMessageToThread = nativeWt
  ? nativeWt.postMessageToThread
  : _postMessageToThread;

// ── MessageChannel / MessagePort / BroadcastChannel ──────────────────────────
// Prefer the native worker_threads versions under Node; in the browser use
// the global constructors (real MessagePorts, backed by the platform).
function _globalOrNative(name) {
  return nativeWt && nativeWt[name] ? nativeWt[name] : globalThis[name];
}
const MessageChannel = _globalOrNative("MessageChannel");
const MessagePort = _globalOrNative("MessagePort");
const BroadcastChannel = _globalOrNative("BroadcastChannel");

// ── locks ────────────────────────────────────────────────────────────────────
// navigator.locks when available; otherwise a small JS fallback that
// serializes callbacks per name (enough for the test contract).
function _fallbackLocks() {
  const held = new Map(); // name -> [{ name, mode }]
  const waiting = new Map(); // name -> queue of { name, mode, resolve, ifAvailable }
  function pump(name) {
    const queue = waiting.get(name) ?? [];
    const owners = held.get(name) ?? [];
    if (!queue.length) return;
    const next = queue[0];
    const { mode, resolve, ifAvailable } = next;
    const blocked =
      mode === "exclusive"
        ? owners.length > 0
        : owners.some((o) => o.mode === "exclusive");
    if (blocked) {
      if (ifAvailable) {
        queue.shift();
        resolve(null);
        pump(name);
      }
      return;
    }
    queue.shift();
    const grant = { name, mode };
    owners.push(grant);
    held.set(name, owners);
    resolve(grant);
  }
  return {
    async request(name, optsOrCallback, maybeCallback) {
      let opts = {};
      let callback = maybeCallback;
      if (typeof optsOrCallback === "object" && optsOrCallback !== null) {
        opts = optsOrCallback;
      } else {
        callback = optsOrCallback;
      }
      const {
        mode = "exclusive",
        ifAvailable = false,
        steal = false,
        signal,
      } = opts;
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        new Promise((grantResolve) => {
          if (!waiting.has(name)) waiting.set(name, []);
          const entry = { name, mode, resolve: grantResolve, ifAvailable };
          if (steal) {
            held.set(name, []);
            waiting.get(name).unshift(entry);
          } else {
            waiting.get(name).push(entry);
          }
          if (signal) {
            signal.addEventListener(
              "abort",
              () => {
                const q = waiting.get(name);
                if (q) {
                  const i = q.indexOf(entry);
                  if (i !== -1) q.splice(i, 1);
                }
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          }
          pump(name);
        }).then(async (grant) => {
          try {
            resolve(await callback(grant));
          } catch (err) {
            reject(err);
          } finally {
            if (grant) {
              const owners = held.get(name) ?? [];
              const i = owners.indexOf(grant);
              if (i !== -1) owners.splice(i, 1);
            }
            pump(name);
          }
        });
      });
    },
    async query() {
      const heldOut = [];
      const pendingOut = [];
      for (const [, owners] of held) {
        heldOut.push(...owners.map((o) => ({ name: o.name, mode: o.mode })));
      }
      for (const [, queue] of waiting) {
        pendingOut.push(...queue.map((q) => ({ name: q.name, mode: q.mode })));
      }
      return { held: heldOut, pending: pendingOut };
    },
  };
}
const _locksImpl =
  (typeof navigator !== "undefined" && navigator.locks) || _fallbackLocks();
const locks = (nativeWt && nativeWt.locks) || _locksImpl;

// ── Worker-side parentPort ───────────────────────────────────────────────────
// When this module is loaded INSIDE a worker bootstrap (no native module),
// parentPort is a small EventEmitter facade over the global message channel.
// The parent's T_INIT payload fills in workerData/threadId/threadName and the
// environment data, then the worker posts T_ONLINE.
class _WorkerSideParentPort extends EventEmitter {
  constructor() {
    super();
    globalThis.addEventListener("message", (e) => {
      if (e.data?.__type__ !== T_INIT) this.emit("message", e.data);
    });
    globalThis.addEventListener("messageerror", (e) =>
      this.emit("messageerror", e),
    );
  }
  postMessage(value, transferOrOpts) {
    const transfer = Array.isArray(transferOrOpts)
      ? transferOrOpts
      : (transferOrOpts?.transfer ?? []);
    globalThis.postMessage(value, transfer);
  }
  start() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  hasRef() {
    return true;
  }
  close() {
    globalThis.close?.();
  }
}

if (!nativeWt && isWorkerScope) {
  parentPort = new _WorkerSideParentPort();
  const onInit = (e) => {
    if (e.data?.__type__ === T_INIT) {
      globalThis.removeEventListener("message", onInit);
      workerData = e.data.workerData ?? null;
      threadId = e.data.threadId ?? 1;
      threadName = e.data.threadName ?? null;
      for (const [k, v] of e.data.envData ?? []) _envData.set(k, v);
      Object.assign(_emptyLimits, e.data.resourceLimits ?? {});
      globalThis.postMessage({ __type__: T_ONLINE });
    }
  };
  globalThis.addEventListener("message", onInit);
  globalThis.postMessage({ __type__: T_READY });
  // If the worker is closed without running task code, still report an exit.
  globalThis.addEventListener("unload", () => {
    try {
      globalThis.postMessage({ __type__: T_EXIT, exitCode: 0 });
    } catch {}
  });
}

// ── Worker blob builder ──────────────────────────────────────────────────────
// Builds the `new Worker(blobUrl, { type: "module" })` source for a task.
// The bootstrap:
//  1. posts T_READY immediately;
//  2. top-level-awaits the T_INIT payload (workerData, threadId, …);
//  3. injects locals (workerData, threadId, threadName, isMainThread=false,
//     isInternalThread=false, SHARE_ENV, parentPort) plus a minimal
//     require('worker_threads');
//  4. posts T_ONLINE, runs the task code, and finally posts T_EXIT with the
//     exit code and a serialized error (if any).
function buildWorkerBlob(code, displayName) {
  const wrapper = `
const T_READY  = ${JSON.stringify(T_READY)};
const T_INIT   = ${JSON.stringify(T_INIT)};
const T_ONLINE = ${JSON.stringify(T_ONLINE)};
const T_EXIT   = ${JSON.stringify(T_EXIT)};

// Signal readiness before doing anything else.
self.postMessage({ __type__: T_READY });

// Wait (via top-level await) for the init payload.
const __init__ = await new Promise(resolve => {
  self.addEventListener('message', function h(e) {
    if (e.data && e.data.__type__ === T_INIT) {
      self.removeEventListener('message', h);
      resolve(e.data);
    }
  });
});

// Locals that task code can reference directly.
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

// Minimal require() for task files: only 'worker_threads' resolves (to
// the injected locals above). Anything else throws a clear MODULE_NOT_FOUND —
// task blobs can resolve neither the VFS nor the network.
const __wt_require__ = (spec) => {
  if (spec === 'worker_threads' || spec === 'node:worker_threads')
    return { parentPort, workerData, threadId, threadName, isMainThread, isInternalThread, SHARE_ENV };
  throw Object.assign(
    new Error("Cannot find module '" + spec + "' (worker task require() supports 'worker_threads' only)"),
    { code: 'MODULE_NOT_FOUND' },
  );
};

// ── Task code ──
let __exitCode__ = 0;
let __error__ = null;
try {
  // Task code runs with a worker_threads-only 'require' in scope.
  const require = __wt_require__;
  ${code}
} catch (err) {
  __exitCode__ = 1;
  __error__ = {
    message: err?.message ?? String(err),
    name: err?.name ?? 'Error',
    stack: err?.stack ?? null,
  };
} finally {
  self.postMessage({ __type__: T_EXIT, exitCode: __exitCode__, error: __error__ });
  // An uncaught exception terminates a Node worker; close on the next
  // microtask so the already-posted T_EXIT is delivered first.
  if (__exitCode__ !== 0) queueMicrotask(() => self.close());
}
`;
  // Append a devtools sourceURL marker. It is assembled without ever writing
  // a contiguous newline+marker byte sequence in this module's own source:
  // the sandbox loads builtin bundles through es-module-shims, which scans
  // module source for that exact sequence and feeds the rest of the line to
  // new URL() — an uninterpolated placeholder at scan time would break the
  // builtin import entirely. String.fromCharCode defeats esbuild's constant
  // folding, so the marker only ever exists in the worker blob at runtime.
  const nl = String.fromCharCode(10);
  const marked = wrapper + nl + "//# sourceURL=" + displayName + nl;
  return URL.createObjectURL(new Blob([marked], { type: "text/javascript" }));
}

// ---------------------------------------------------------------------------
// URL-mode task resolution — read the worker file out of the virtual FS.
// A bare relative path handed to the native Worker would resolve against the
// page's HTTP origin (404 -> a load failure with no error object -> the old
// generic "Worker error"). Resolving through the VFS first is the faithful
// equivalent of Node reading the file off disk.
// ---------------------------------------------------------------------------

/** Absolute URLs (http:, blob:, data:, …) bypass the VFS entirely. */
function _isAbsoluteUrl(s) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) || s.startsWith("//");
}

/** Minimal POSIX normalization for VFS paths (collapses . and ..). */
function _normalizeVfsPath(p) {
  const parts = [];
  for (const seg of String(p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** Read one file out of the virtual FS (guarded _RUNTIME_ + __USER_FILES__). */
function _readVfsFile(path) {
  try {
    const rt = globalThis._RUNTIME_;
    const fs = rt && rt.__FS__;
    if (fs && typeof fs.readFileSync === "function") {
      try {
        const text = fs.readFileSync(path, "utf8");
        if (typeof text === "string") return text;
      } catch {}
    }
    const userFiles = rt && rt.__USER_FILES__;
    if (userFiles && typeof userFiles === "object") {
      for (const key of [path, path.replace(/^\//, "")]) {
        if (typeof userFiles[key] === "string") return userFiles[key];
      }
    }
  } catch {}
  return null;
}

/**
 * Resolve a URL-mode filename to VFS source. Returns { code, name } or null
 * when the VFS has no such file (caller falls back to raw URL passthrough).
 */
function _resolveWorkerFile(filename) {
  let path;
  if (filename instanceof URL) {
    if (filename.protocol === "file:")
      path = decodeURIComponent(filename.pathname);
    else return null;
  } else {
    const s = String(filename);
    if (_isAbsoluteUrl(s)) return null;
    path = s;
  }
  // VFS lookup is rooted; try the process cwd first, then the site root.
  let cwd = "/";
  try {
    const proc = globalThis.process;
    if (proc && typeof proc.cwd === "function") {
      const c = proc.cwd();
      if (typeof c === "string" && c) cwd = c;
    }
  } catch {}
  const stripped = path.replace(/^\.\//, "");
  const candidates = path.startsWith("/")
    ? [path]
    : [
        _normalizeVfsPath(cwd + "/" + stripped),
        _normalizeVfsPath("/" + stripped),
      ];
  for (const candidate of candidates) {
    const code = _readVfsFile(candidate);
    if (code !== null) return { code, name: candidate };
  }
  return null;
}

/** Error for a native Worker load failure that carries no error object. */
function _workerLoadError(event) {
  const where = event?.filename
    ? ` (${event.filename}${event.lineno ? ":" + event.lineno : ""})`
    : "";
  const what = event?.message ? `: ${event.message}` : "";
  return new Error(`Worker failed to load${where}${what}`);
}

let _nextThreadId = 1;

/**
 * Browser implementation of Worker: a real native Web Worker driven by the
 * T_READY/T_INIT/T_ONLINE/T_EXIT handshake, emitting Node-style events.
 */
class BrowserWorker extends EventEmitter {
  #native;
  #threadId;
  #threadName;
  #resourceLimits;
  #blobUrl;
  #exitPromise;
  #resolveExit;
  #exited;

  constructor(filename, options = {}) {
    super();
    this.#exited = false;
    if (typeof filename !== "string" && !(filename instanceof URL)) {
      throw Object.assign(
        new TypeError(
          `The "filename" argument must be of type string or an instance of URL. ` +
            `Received type ${typeof filename} (${String(filename)})`,
        ),
        { code: "ERR_INVALID_ARG_TYPE" },
      );
    }
    this.#threadId = _nextThreadId++;
    this.#threadName = options.name ?? null;
    this.#resourceLimits = { ...options.resourceLimits };
    this.#blobUrl = null;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    // Resolve the task source: eval string, VFS file, or raw URL passthrough.
    let url;
    if (options.eval) {
      this.#blobUrl = buildWorkerBlob(String(filename), "(eval)");
      url = this.#blobUrl;
    } else {
      const resolved = _resolveWorkerFile(filename);
      if (resolved !== null) {
        this.#blobUrl = buildWorkerBlob(resolved.code, resolved.name);
        url = this.#blobUrl;
      } else {
        url = filename instanceof URL ? filename.href : String(filename);
      }
    }

    this.#native = new globalThis.Worker(url, {
      type: "module",
      name: options.name,
    });

    // Environment for the worker: SHARE_ENV clones process.env, otherwise
    // the explicit env object (or empty).
    const proc = globalThis.process;
    const env =
      options.env === SHARE_ENV
        ? typeof proc !== "undefined" && proc != null && proc.env
          ? { ...proc.env }
          : {}
        : (options.env ?? {});

    let initSent = false;
    this.#native.addEventListener("message", (e) => {
      const { __type__: type, ...rest } = e.data ?? {};
      if (type === T_READY && !initSent) {
        initSent = true;
        this.#native.postMessage(
          {
            __type__: T_INIT,
            workerData: options.workerData ?? null,
            threadId: this.#threadId,
            threadName: this.#threadName,
            envData: [..._envData.entries()],
            resourceLimits: this.#resourceLimits,
            env,
          },
          options.transferList ?? [],
        );
        return;
      }
      if (type === T_ONLINE) {
        this.emit("online");
        return;
      }
      if (type === T_EXIT) {
        const code = rest.exitCode ?? 0;
        const serialized = rest.error;
        if (code !== 0 && serialized) {
          // Re-raise the worker's real error BEFORE 'exit' (Node ordering).
          const err = new Error(
            serialized.message ?? `Worker stopped with exit code ${code}`,
          );
          if (serialized.name) err.name = serialized.name;
          if (serialized.stack) err.stack = serialized.stack;
          this.emit("error", err);
        }
        this.#finish(code);
        return;
      }
      try {
        this.emit("message", e.data);
      } catch (err) {
        this.emit("messageerror", e.data);
      }
    });
    this.#native.addEventListener("messageerror", (e) =>
      this.emit("messageerror", e),
    );
    this.#native.addEventListener("error", (e) => {
      // A native load failure (404, CSP, …) often carries e.error === null;
      // report where it failed instead of a generic "Worker error".
      if (!this.#exited) {
        this.emit("error", e.error ?? _workerLoadError(e));
        this.#finish(1);
      }
    });
  }

  #finish(code) {
    if (this.#exited) return;
    this.#exited = true;
    if (this.#blobUrl) {
      URL.revokeObjectURL(this.#blobUrl);
      this.#blobUrl = null;
    }
    this.emit("exit", code);
    this.#resolveExit(code);
  }

  postMessage(value, transferOrOpts) {
    if (_uncloneable.has(value)) {
      throw new DOMException(
        "The object could not be cloned.",
        "DataCloneError",
      );
    }
    if (Array.isArray(transferOrOpts)) {
      for (const item of transferOrOpts) {
        if (_untransferable.has(item)) {
          throw new DOMException(
            "Transfer of untransferable object attempted.",
            "DataCloneError",
          );
        }
      }
    }
    this.#native.postMessage(value, transferOrOpts ?? []);
  }

  terminate() {
    if (!this.#exited) {
      this.#native.terminate();
      this.#finish(1);
    }
    return this.#exitPromise;
  }

  get threadId() {
    return this.#threadId;
  }
  get threadName() {
    return this.#threadName;
  }
  get resourceLimits() {
    return { ...this.#resourceLimits };
  }
  get stdin() {
    return null;
  }
  get stdout() {
    return null;
  }
  get stderr() {
    return null;
  }
  get performance() {
    return {
      eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
    };
  }
  async getHeapSnapshot() {
    return null;
  }
  async getHeapStatistics() {
    return {};
  }
  async [Symbol.asyncDispose]() {
    await this.terminate();
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

// Prefer the native Worker under Node; the browser implementation otherwise.
const Worker = nativeWt ? nativeWt.Worker : BrowserWorker;

// ── Module shape ─────────────────────────────────────────────────────────────
// The default export is the native module when available, otherwise a getters
// object exposing this module's own bindings (so `import wt from
// 'worker_threads'` sees live values).
const _defaultExport = {
  get threadId() {
    return threadId;
  },
  get threadName() {
    return threadName;
  },
  get workerData() {
    return workerData;
  },
  get parentPort() {
    return parentPort;
  },
  get isMainThread() {
    return isMainThread;
  },
  get isInternalThread() {
    return isInternalThread;
  },
  get SHARE_ENV() {
    return SHARE_ENV;
  },
  get resourceLimits() {
    return resourceLimits;
  },
  get Worker() {
    return Worker;
  },
  get MessageChannel() {
    return MessageChannel;
  },
  get MessagePort() {
    return MessagePort;
  },
  get BroadcastChannel() {
    return BroadcastChannel;
  },
  get setEnvironmentData() {
    return setEnvironmentData;
  },
  get getEnvironmentData() {
    return getEnvironmentData;
  },
  get markAsUntransferable() {
    return markAsUntransferable;
  },
  get isMarkedAsUntransferable() {
    return isMarkedAsUntransferable;
  },
  get markAsUncloneable() {
    return markAsUncloneable;
  },
  get moveMessagePortToContext() {
    return moveMessagePortToContext;
  },
  get receiveMessageOnPort() {
    return receiveMessageOnPort;
  },
  get postMessageToThread() {
    return postMessageToThread;
  },
  get locks() {
    return locks;
  },
};

// Cloak the platform-backed constructors as native (sandbox fidelity).
maskAsNative(MessageChannel);
maskAsNative(MessagePort);
maskAsNative(moveMessagePortToContext, "moveMessagePortToContext");

export {
  BroadcastChannel,
  MessageChannel,
  MessagePort,
  SHARE_ENV,
  Worker,
  getEnvironmentData,
  isInternalThread,
  isMainThread,
  isMarkedAsUntransferable,
  locks,
  markAsUncloneable,
  markAsUntransferable,
  moveMessagePortToContext,
  parentPort,
  postMessageToThread,
  receiveMessageOnPort,
  resourceLimits,
  setEnvironmentData,
  threadId,
  threadName,
  workerData,
};
export default nativeWt ?? _defaultExport;
