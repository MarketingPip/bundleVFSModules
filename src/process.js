// src/process.js — browser port of node:process.
//
// Serves explicit `import "node:process"` / `require("node:process")` inside
// Jared's runtime AND standalone (real Node, Web Workers, direct import).
// The runtime installs its OWN cloaked globalThis.process built from
// config.process; this module mirrors `globalThis._RUNTIME_.process` config
// values (title, arch, env, platform, pid, ppid, argv, argv0, execPath,
// execArgv, version, versions, debugPort) with standalone fallbacks, and
// implements the rest browser-natively.
//
// Rules honored (see docs/SHIM_AUTHORING.md, AGENTS.md):
// - `globalThis._RUNTIME_` (never bare), guarded for standalone use; the
//   guard survives the runtime's AST rewrite to `globalThis._RUNTIME<uuid>_`.
// - No window/document at module scope (worker-safe); window is only touched
//   inside a guarded function body for host-frame messaging.
// - Unimplementable APIs -> honest noops with correct shapes, never throws.
// - Dependency-free ESM. Native functions (queueMicrotask, performance.now)
//   are captured at module evaluation time.

import { stdin as _stdin } from "./internals/stdin.js";

import makeShim from './internals/stdout.js';
const _stdout = makeShim('stdout');
const _stderr = makeShim('stderr');

// ---------------------------------------------------------------------------
// Runtime bridge (guarded: rewritten to the sandbox scope at load time,
// undefined under real Node / direct import / workers without a host).
// ---------------------------------------------------------------------------
const RT = (typeof globalThis._RUNTIME_ !== "undefined" && globalThis._RUNTIME_ !== null)
  ? globalThis._RUNTIME_
  : undefined;
/** The host's config.process object (title, arch, env, platform, …), if any. */
const RTP = (RT && RT.process && typeof RT.process === "object") ? RT.process : {};

// ---------------------------------------------------------------------------
// !! Capture native functions at module evaluation time !!
//
// This MUST happen before any export is defined. Bundlers (webpack, esbuild,
// Rollup) can replace globals with our own exports after the module loads.
// Capturing here freezes the native reference permanently.
// ---------------------------------------------------------------------------
const _nowMs = (typeof performance !== "undefined" && performance !== null &&
  typeof performance.now === "function")
  ? () => performance.now()
  : () => Date.now();

const _queueMicrotask = (typeof queueMicrotask === "function")
  ? queueMicrotask
  : (fn) => Promise.resolve().then(fn);

const _perfMemory = () => {
  try {
    if (typeof performance !== "undefined" && performance !== null &&
        performance.memory && typeof performance.memory === "object") {
      return performance.memory;
    }
  } catch { /* ignore */ }
  return null;
};

// ---------------------------------------------------------------------------
// Node-style validation errors (exact codes/messages, verified against
// Node v24.20.0 so `assert.throws(..., { code })` style tests pass).
// ---------------------------------------------------------------------------
function _received(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return `type string ('${v}')`;
  if (t === "number" || t === "boolean" || t === "bigint") return `type ${t} (${String(v)})`;
  return `type ${t}`;
}
function _invalidArgType(name, expected, actual) {
  const err = new TypeError(`The "${name}" argument must be ${expected}. Received ${_received(actual)}`);
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}
function _outOfRange(name, condition, actual) {
  const err = new RangeError(`The value of "${name}" is out of range. It must be ${condition}. Received ${actual}`);
  err.code = "ERR_OUT_OF_RANGE";
  return err;
}
function _invalidArgValue(name, expected, actual) {
  const err = new TypeError(`The argument '${name}' must be ${expected}. Received '${actual}'`);
  err.code = "ERR_INVALID_ARG_VALUE";
  return err;
}

const process2 = (function () {
  let _intervalId = null;
  const listeners = Object.create(null);
  let traceWarningHelperShown = false;
  const startTime = _nowMs();
  const logs = [];
  let _exiting = false;
  let _umask = 0o022;
  let _cwd = "/";
  let _sourceMapsEnabled = false;
  let _uncaughtExceptionCapture = null;

  /** Lazily read the virtual-FS singleton our src/fs.js publishes (if loaded). */
  function _vfs() {
    return (RT && RT.__FS__ && typeof RT.__FS__ === "object") ? RT.__FS__ : undefined;
  }

  function _absPath(p) {
    const base = (p.charCodeAt(0) === 47 /* '/' */) ? "" : cwd();
    const parts = (base + "/" + p).split("/");
    const out = [];
    for (const s of parts) {
      if (!s || s === ".") continue;
      if (s === "..") out.pop();
      else out.push(s);
    }
    return "/" + out.join("/");
  }

  // Notify the host frame when the process exits/is killed. Guarded so this
  // module also imports and runs inside Web Workers (no `window` there).
  function postToParent(message) {
    try {
      if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
        window.parent.postMessage(message, '*');
        return;
      }
    } catch { /* cross-origin parent access can throw; fall through */ }
    if (typeof globalThis.postMessage === 'function') {
      try { globalThis.postMessage(message); } catch { /* host without a listener */ }
    }
  }

  // --- Minimal EventEmitter (synchronous, like Node's process.emit) ---
  function emit(event, ...args) {
    const handlers = listeners[event];
    if (!handlers || handlers.length === 0) return false;
    for (const fn of handlers.slice()) {
      if (fn._once) off(event, fn);
      try { fn.apply(processFinal, args); }
      catch (err) { console.error(`Error in listener for ${event}:`, err); }
    }
    return true;
  }

  function on(event, fn) {
    if (typeof fn !== "function") throw _invalidArgType("listener", "of type function", fn);
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return processFinal;
  }
  const addListener = on;

  function prependListener(event, fn) {
    if (typeof fn !== "function") throw _invalidArgType("listener", "of type function", fn);
    if (!listeners[event]) listeners[event] = [];
    listeners[event].unshift(fn);
    return processFinal;
  }

  function once(event, fn) { fn._once = true; return on(event, fn); }
  function prependOnceListener(event, fn) { fn._once = true; return prependListener(event, fn); }

  function off(event, fn) {
    const arr = listeners[event];
    if (!arr) return processFinal;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
    return processFinal;
  }
  const removeListener = off;

  function removeAllListeners(event) {
    if (event === undefined) { for (const k of Object.keys(listeners)) delete listeners[k]; }
    else delete listeners[event];
    return processFinal;
  }

  function listenerCount(event) { return listeners[event] ? listeners[event].length : 0; }

  /**
   * Schedules `callback` on the microtask queue (queueMicrotask), the closest
   * browser equivalent of Node's nextTick queue. Ordering relative to promise
   * jobs already queued is the same: FIFO within the microtask queue.
   * @since Node.js v0.1.26
   */
  function nextTick(callback, ...args) {
    if (typeof callback !== "function") throw _invalidArgType("callback", "of type function", callback);
    _queueMicrotask(() => {
      try {
        callback(...args);
      } catch (err) {
        if (_uncaughtExceptionCapture) {
          try { _uncaughtExceptionCapture(err); } catch { /* capture must not throw */ }
          return;
        }
        if (listenerCount("uncaughtException") > 0) { emit("uncaughtException", err); return; }
        throw err;
      }
    });
  }

  // --- Warning internals ---
  function createWarningObject(message, type, code, ctor, detail) {
    const warning = new Error(message);
    warning.name = type || "Warning";
    if (code !== undefined) warning.code = code;
    if (detail !== undefined) warning.detail = detail;
    if (Error.captureStackTrace) Error.captureStackTrace(warning, ctor || processFinal.emitWarning);
    return warning;
  }

  function formatWarning(warning) {
    const isDeprecation = warning.name === "DeprecationWarning";
    const trace = processFinal.traceProcessWarnings || (isDeprecation && processFinal.traceDeprecation);
    let msg = `(node:${processFinal.pid || 1}) `;
    if (warning.code) msg += `[${warning.code}] `;
    msg += trace && warning.stack ? warning.stack : warning.toString();
    if (typeof warning.detail === "string") msg += `\n${warning.detail}`;
    if (!trace && !traceWarningHelperShown) traceWarningHelperShown = true;
    return msg;
  }

  function defaultWarningHandler(warning) {
    if (!(warning instanceof Error)) return;
    if (warning.name === "DeprecationWarning" && processFinal.noDeprecation) return;
    console.error(formatWarning(warning));
  }

  function emitWarning(warning, type, code, ctor) {
    if (processFinal.noDeprecation && type === "DeprecationWarning") return;
    let detail;
    if (type && typeof type === "object" && !Array.isArray(type)) {
      ctor = type.ctor; code = type.code; detail = type.detail; type = type.type || "Warning";
    } else if (typeof type === "function") { ctor = type; type = "Warning"; code = undefined; }
    if (typeof code === "function") { ctor = code; code = undefined; }
    if (typeof warning === "string") warning = createWarningObject(warning, type, code, ctor, detail);
    else if (!(warning instanceof Error)) throw _invalidArgType("warning", "of type string or an instance of Error", warning);
    if (warning.name === "DeprecationWarning") {
      if (processFinal.throwDeprecation) return nextTick(() => { throw warning; });
      if (processFinal.noDeprecation) return;
    }
    nextTick(() => {
      if (listenerCount("warning") === 0) defaultWarningHandler(warning);
      emit("warning", warning);
    });
  }

  function emitWarningSync(warning, type, code, ctor) {
    if (typeof warning === "string") warning = createWarningObject(warning, type, code, ctor);
    else if (!(warning instanceof Error)) throw _invalidArgType("warning", "of type string or an instance of Error", warning);
    if (listenerCount("warning") === 0) defaultWarningHandler(warning);
    emit("warning", warning);
  }

  // --- Reporting (shape matches Node's process.report) ---
  const report = (function () {
    let _directory = "", _filename = "", _compact = false, _excludeNetwork = false;
    let _signal = null, _reportOnFatalError = false, _reportOnSignal = false;
    let _reportOnUncaughtException = false, _excludeEnv = false;
    const reports = [];

    function writeReport(file, err) {
      if (typeof file === "object" && file !== null) { err = file; file = undefined; }
      else if (file !== undefined && typeof file !== "string") throw new TypeError("file must be a string");
      if (err === undefined) err = new Error("Synthetic error");
      else if (typeof err !== "object" || err === null) throw new TypeError("err must be an object");
      const r = { source: "JavaScript API", type: "API", file: file || _filename || null,
        error: err, timestamp: Date.now(), compact: _compact, directory: _directory,
        excludeNetwork: _excludeNetwork, excludeEnv: _excludeEnv };
      reports.push(r);
      console.warn("Report written:", r);
      return r;
    }

    function getReport(err) {
      if (err === undefined) err = new Error("Synthetic error");
      else if (typeof err !== "object" || err === null) throw new TypeError("err must be an object");
      const r = reports.find(r => r.error === err);
      return r ? JSON.parse(JSON.stringify(r)) : null;
    }

    function signalHandler(sig) { writeReport(sig, { type: "Signal", message: "Signal received" }); }
    function addSignalHandler(sig) { if (_reportOnSignal) { if (typeof sig !== "string") sig = _signal; if (sig) on(sig, signalHandler); } }
    function removeSignalHandler() { if (_signal) removeListener(_signal, signalHandler); }

    return {
      writeReport, getReport,
      get directory() { return _directory; }, set directory(d) { _directory = String(d); },
      get filename()  { return _filename; },  set filename(n)  { _filename  = String(n); },
      get compact()   { return _compact; },   set compact(b)   { _compact   = Boolean(b); },
      get excludeNetwork() { return _excludeNetwork; }, set excludeNetwork(b) { _excludeNetwork = Boolean(b); },
      get signal() { return _signal; }, set signal(s) { removeSignalHandler(); _signal = String(s); addSignalHandler(s); },
      get reportOnFatalError() { return _reportOnFatalError; }, set reportOnFatalError(v) { _reportOnFatalError = Boolean(v); },
      get reportOnSignal() { return _reportOnSignal; }, set reportOnSignal(v) { _reportOnSignal = Boolean(v); removeSignalHandler(); addSignalHandler(); },
      get reportOnUncaughtException() { return _reportOnUncaughtException; }, set reportOnUncaughtException(v) { _reportOnUncaughtException = Boolean(v); },
      get excludeEnv() { return _excludeEnv; }, set excludeEnv(b) { _excludeEnv = Boolean(b); },
    };
  })();

  // --- hrtime via performance.now() (monotonic, like Node's) ---
  function hrtime(time) {
    if (time !== undefined) {
      if (!Array.isArray(time)) throw _invalidArgType("time", "an instance of Array", time);
      if (time.length !== 2) throw _outOfRange("time", "2", time.length);
    }
    const ms = _nowMs();
    let s = Math.floor(ms / 1000);
    let ns = Math.floor((ms - s * 1000) * 1e6);
    if (time !== undefined) {
      s -= time[0]; ns -= time[1];
      if (ns < 0) { s -= 1; ns += 1e9; }
    }
    return [s, ns];
  }
  hrtime.bigint = function hrtimeBigInt() {
    return BigInt(Math.floor(_nowMs() * 1e6));
  };

  // --- POSIX uid/gid noops (always 0 / root-like in a browser shim) ---
  const _uid = 0, _euid = 0, _gid = 0, _egid = 0;
  function getuid()  { return _uid;  }
  function geteuid() { return _euid; }
  function setuid()  { /* noop */ }
  function seteuid() { /* noop */ }
  function getgid()  { return _gid;  }
  function getegid() { return _egid; }
  function setgid()  { /* noop */ }
  function setegid() { /* noop */ }
  function getgroups()  { return []; }
  function setgroups()  { /* noop */ }
  function initgroups() { /* noop: no user database in a browser */ }

  /**
   * Get or set the file creation mask.
   * @since Node.js v0.1.19
   */
  function umask(mask) {
    if (mask === undefined) return _umask;
    let m = mask;
    if (typeof m === "string") {
      if (!/^[0-7]+$/.test(m)) throw _invalidArgValue("mask", "a 32-bit unsigned integer or an octal string", mask);
      m = parseInt(m, 8);
    } else if (typeof m === "number") {
      if (!Number.isInteger(m)) throw _outOfRange("mask", "an integer", m);
      if (m < 0 || m > 4294967295) throw _outOfRange("mask", ">= 0 && <= 4294967295", m);
    } else {
      throw _invalidArgValue("mask", "a 32-bit unsigned integer or an octal string", mask);
    }
    const prev = _umask;
    _umask = m & 0o777;
    return prev;
  }

  /** @since Node.js v0.1.8 */
  function cwd() {
    const fs_ = _vfs();
    if (fs_ && typeof fs_.cwd === "string" && fs_.cwd.length > 0) return fs_.cwd;
    return _cwd;
  }
  function chdir(directory) {
    if (typeof directory !== "string") throw _invalidArgType("directory", "of type string", directory);
    const target = _absPath(directory);
    const fs_ = _vfs();
    if (fs_ && typeof fs_.lookup === "function") {
      // Throws node-style ENOENT/ENOTDIR via the volume when missing.
      const found = fs_.lookup(target, "chdir");
      if (found && found.node && found.node.kind !== "dir") {
        const err = new Error(`ENOTDIR: not a directory, chdir '${directory}'`);
        err.code = "ENOTDIR"; err.syscall = "chdir"; err.path = directory;
        throw err;
      }
      fs_.cwd = target;
    }
    _cwd = target;
  }

  /** @since Node.js v0.5.0 */
  function uptime() { return (_nowMs() - startTime) / 1000; }

  /**
   * @since Node.js v0.1.16
   * heapTotal/heapUsed come from performance.memory where available
   * (Chrome); rss/external/arrayBuffers are unknowable in a browser → 0.
   */
  function memoryUsage() {
    const pm = _perfMemory();
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
    return {
      rss: 0,
      heapTotal: num(pm && pm.totalJSHeapSize),
      heapUsed: num(pm && pm.usedJSHeapSize),
      external: 0,
      arrayBuffers: 0,
    };
  }

  /**
   * @since Node.js v6.1.0
   * The browser cannot measure CPU time; returns honest zeros. Accepts an
   * optional previous value (validated like Node) and returns the diff.
   */
  function cpuUsage(prevValue) {
    if (prevValue !== undefined &&
        (prevValue === null || typeof prevValue !== "object" || Array.isArray(prevValue))) {
      throw _invalidArgType("prevValue", "of type object", prevValue);
    }
    return { user: 0, system: 0 };
  }

  /** @since Node.js v0.1.16 — approximate from performance.memory. */
  function availableMemory() {
    const pm = _perfMemory();
    if (pm && typeof pm.jsHeapSizeLimit === "number" && typeof pm.usedJSHeapSize === "number") {
      return Math.max(0, Math.round(pm.jsHeapSizeLimit - pm.usedJSHeapSize));
    }
    return 0;
  }
  function constrainedMemory() { return 0; }

  /** getrusage(2) has no browser equivalent; all counters stay 0. */
  function resourceUsage() {
    return {
      userCPUTime: 0, systemCPUTime: 0, maxRSS: 0, sharedMemorySize: 0,
      unsharedDataSize: 0, unsharedStackSize: 0, minorPageFault: 0, majorPageFault: 0,
      swappedOut: 0, fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0,
      signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
    };
  }

  function getActiveResourcesInfo() { return []; }

  function kill(pid, signal = "SIGTERM") {
    if (typeof pid !== "number")    throw _invalidArgType("pid", "of type number", pid);
    if (typeof signal !== "string") throw _invalidArgType("signal", "of type string", signal);
    emit("kill", { pid, signal });
    const executionTime = parseFloat((_nowMs() - startTime).toFixed(2));
    postToParent({ type: "process_kill", logs: logs || [], executionTime });
  }

  /**
   * Ends the "process". Like Node, runs 'exit' listeners synchronously, sets
   * exitCode, and notifies the host frame (there is no real OS process to
   * terminate in a browser). Code defaults to process.exitCode ?? 0.
   * @since Node.js v0.1.13
   */
  function exit(code) {
    if (code === undefined || code === null) code = processFinal.exitCode === undefined ? 0 : processFinal.exitCode;
    if (typeof code !== "number") throw _invalidArgType("code", "of type number", code);
    if (!Number.isInteger(code)) throw _outOfRange("code", "an integer", code);
    code = code & 0xff;
    if (_exiting) return undefined;
    _exiting = true;
    processFinal.exitCode = code;
    emit("exit", code);
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    const executionTime = parseFloat((_nowMs() - startTime).toFixed(2));
    postToParent({ type: "kill", logs: logs || [], executionTime, exitCode: code });
    return undefined;
  }

  /**
   * Like exit() but skips 'exit' listeners. Best-effort in a browser:
   * records the code and notifies the host.
   */
  function reallyExit(code) {
    if (code === undefined || code === null) code = processFinal.exitCode === undefined ? 0 : processFinal.exitCode;
    if (typeof code !== "number") throw _invalidArgType("code", "of type number", code);
    if (!Number.isInteger(code)) throw _outOfRange("code", "an integer", code);
    code = code & 0xff;
    _exiting = true;
    processFinal.exitCode = code;
    const executionTime = parseFloat((_nowMs() - startTime).toFixed(2));
    postToParent({ type: "kill", logs: logs || [], executionTime, exitCode: code });
    return undefined;
  }

  /**
   * Cannot abort a browser context; documented noop (never throws).
   * @since Node.js v0.1.13
   */
  function abort() { /* noop: no SIGABRT in a browser */ }

  /** @since Node.js v0.1.28 — deprecated in Node; stub returns undefined. */
  function binding() { return undefined; }

  /**
   * Cannot load native addons in a browser; noop after arg validation.
   * @since Node.js v0.1.100
   */
  function dlopen(module, filename) {
    if (module === null || (typeof module !== "object" && typeof module !== "function")) {
      throw _invalidArgType("module", "of type object", module);
    }
    if (typeof filename !== "string") throw _invalidArgType("filename", "of type string", filename);
    return undefined;
  }

  /**
   * No synchronous builtin registry exists in the browser; the runtime loads
   * builtins asynchronously via `globalThis._RUNTIME_.loadModule(name)`.
   * @since Node.js v22.3.0
   */
  function getBuiltinModule(id) {
    if (typeof id !== "string") throw _invalidArgType("id", "of type string", id);
    return undefined;
  }

  /** @since Node.js v0.1.13 — event-loop refcounts don't exist here; noops. */
  function ref()   { return undefined; }
  function unref() { return undefined; }

  function setSourceMapsEnabled(v) { _sourceMapsEnabled = Boolean(v); }

  function setUncaughtExceptionCaptureCallback(fn) {
    if (fn !== null && typeof fn !== "function") throw _invalidArgType("fn", "of type function or null", fn);
    _uncaughtExceptionCapture = fn;
  }
  function hasUncaughtExceptionCaptureCallback() { return _uncaughtExceptionCapture !== null; }

  /** @since Node.js v20.13.0 — no .env autoloading in a browser; noop. */
  function loadEnvFile() { /* noop */ }

  /** @since Node.js v0.1.13 — no exec in a browser; noop. */
  function execve() { /* noop */ }

  function openStdin() { return _stdin; }

  const rawMethods = {
    // ── Properties (mirrored from globalThis._RUNTIME_.process) ─────────────
    /** @since Node.js v0.1.13 */
    exitCode: undefined,

    /** @since Node.js v0.1.104 */
    title: (typeof RTP.title === "string" && RTP.title) || "node",

    /** CPU architecture string. @since Node.js v0.5.0 */
    arch: RTP.arch || "x64",

    /**
     * Set of flags allowed in NODE_OPTIONS. Empty here — a browser has no
     * NODE_OPTIONS to inspect. Shape (a Set) matches Node.
     * @since Node.js v10.10.0
     */
    allowedNodeEnvironmentFlags: (RTP.allowedNodeEnvironmentFlags instanceof Set)
      ? RTP.allowedNodeEnvironmentFlags
      : new Set(),

    /** Command-line arguments. @since Node.js v0.1.27 */
    argv: Array.isArray(RTP.argv) ? RTP.argv : [],

    /** Original argv[0]. @since Node.js v6.4.0 */
    argv0: RTP.argv0 || "",

    /** Environment variables (live-linked when the host provides an object). @since Node.js v0.1.27 */
    env: (RTP.env && typeof RTP.env === "object") ? RTP.env : {},

    /** Node.js exec arguments. @since Node.js v0.7.7 */
    execArgv: Array.isArray(RTP.execArgv) ? RTP.execArgv : [],

    /** Path to the Node executable. @since Node.js v0.1.100 */
    execPath: RTP.execPath || "",

    /** OS platform string. @since Node.js v0.1.16 */
    platform: RTP.platform || "browser",

    /** Node.js version string. @since Node.js v0.1.3 */
    version: RTP.version || "v0.0.0-shim",

    /** Node.js and dependency version info. @since Node.js v0.2.0 */
    versions: (RTP.versions && typeof RTP.versions === "object") ? RTP.versions : {
      node: "0.0.0-shim", v8: "", uv: "", zlib: "", brotli: "",
      ares: "", modules: "", nghttp2: "", napi: "", llhttp: "",
      openssl: "", cldr: "", icu: "", tz: "", unicode: "",
    },

    /** Node.js release metadata. @since Node.js v3.0.0 */
    release: (RTP.release && typeof RTP.release === "object") ? RTP.release : {
      name: "node", sourceUrl: "", headersUrl: "", lts: false,
    },

    /**
     * Build configuration. Mirrored from the host when provided; otherwise
     * an empty-but-shape-correct object.
     * @since Node.js v0.7.7
     */
    config: (RTP.config && typeof RTP.config === "object") ? RTP.config : {
      target_defaults: {
        cflags: [], default_configuration: "Release", defines: [],
        include_dirs: [], libraries: [], configurations: {},
      },
      variables: {},
    },

    /**
     * Compile-time feature flags. Static browser-plausible values with the
     * exact key set Node v24.20.0 exposes.
     * @since Node.js v18.0.0
     */
    features: (RTP.features && typeof RTP.features === "object") ? RTP.features : {
      inspector: false, debug: false, uv: false, ipv6: true,
      tls_alpn: false, tls_sni: false, tls_ocsp: false, tls: false,
      openssl_is_boringssl: false, cached_builtins: false,
      require_module: false, quic: false, typescript: false,
    },

    /** @since Node.js v11.8.0 */
    debugPort: (typeof RTP.debugPort === "number" ? RTP.debugPort : 9229),

    /** @since Node.js v0.12.0 — always null outside a domain context. */
    domain: null,

    pid:  (typeof RTP.pid === "number"  ? RTP.pid  : 1),
    ppid: (typeof RTP.ppid === "number" ? RTP.ppid : 0),

    /** @since Node.js v0.1.13 */
    moduleLoadList: [],

    get sourceMapsEnabled() { return _sourceMapsEnabled; },

    // ── Streams (runtime terminal shims) ────────────────────────────────────
    /** Readable stdin shim (line-buffered / raw modes). @since Node.js v0.1.3 */
    stdin: _stdin,
    /** Writable stdout shim backed by console.log. @since Node.js v0.1.3 */
    stdout: _stdout,
    /** Writable stderr shim backed by console.error. @since Node.js v0.1.3 */
    stderr: _stderr,

    // ── Methods ─────────────────────────────────────────────────────────────
    exit, reallyExit, abort, cwd, chdir, umask, uptime, hrtime,
    memoryUsage, cpuUsage, availableMemory, constrainedMemory, resourceUsage,
    getActiveResourcesInfo, kill, nextTick,
    binding, dlopen, getBuiltinModule, openStdin, ref, unref,
    setSourceMapsEnabled, setUncaughtExceptionCaptureCallback,
    hasUncaughtExceptionCaptureCallback, loadEnvFile, execve, initgroups,

    // POSIX user / group — noops, always returns 0
    /** @since Node.js v0.1.28 */ getuid,
    /** @since Node.js v2.0.0  */ geteuid,
    /** @since Node.js v0.1.28 */ setuid,
    /** @since Node.js v2.0.0  */ seteuid,
    /** @since Node.js v0.1.31 */ getgid,
    /** @since Node.js v2.0.0  */ getegid,
    /** @since Node.js v0.1.31 */ setgid,
    /** @since Node.js v2.0.0  */ setegid,
    /** @since Node.js v0.9.4  */ getgroups,
    /** @since Node.js v0.9.4  */ setgroups,

    // EventEmitter
    on, addListener, once, off, removeListener, removeAllListeners,
    prependListener, prependOnceListener,
    emit, listenerCount,

    emitWarning, emitWarningSync,
    report,
  };

  // Cloak functions as `[native code]` (matches the runtime's own process
  // shim convention) and install everything on the final object. Accessor
  // descriptors (e.g. sourceMapsEnabled) are preserved as live accessors.
  const processBase = {};
  Object.getOwnPropertyNames(rawMethods).forEach(key => {
    const desc = Object.getOwnPropertyDescriptor(rawMethods, key);
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      Object.defineProperty(processBase, key, {
        get: desc.get, set: desc.set, enumerable: true, configurable: true,
      });
      return;
    }
    const value = desc.value;
    if (typeof value !== "function") { processBase[key] = value; return; }
    const fn = function () { return rawMethods[key].apply(this, arguments); };
    Object.defineProperties(fn, {
      name:     { value: key },
      toString: { value: () => `function ${key}() { [native code] }` },
    });
    processBase[key] = fn;
  });
  // hrtime.bigint lives on the cloaked wrapper, like Node's process.hrtime.
  processBase.hrtime.bigint = hrtime.bigint;

  const processFinal = Object.create({}, { [Symbol.toStringTag]: { value: "process", enumerable: false } });
  // Descriptor-preserving copy: Object.assign would invoke getters (e.g.
  // sourceMapsEnabled) and freeze them as static values.
  for (const key of Object.getOwnPropertyNames(processBase)) {
    Object.defineProperty(processFinal, key, Object.getOwnPropertyDescriptor(processBase, key));
  }

  // Deprecated-flag toggles (absent on real Node unless flags are passed;
  // kept as data properties because emitWarning consults them).
  processFinal.noDeprecation        = false;
  processFinal.throwDeprecation     = false;
  processFinal.traceDeprecation     = false;
  processFinal.traceProcessWarnings = false;

 if (typeof globalThis !== "undefined") {
   try {
     Object.defineProperty(globalThis, "process", {
       value: processFinal,
       writable: true,
       configurable: true,
       enumerable: true,
     });
   } catch {
     // Host already owns a non-configurable process property.
   }
 }

  return processFinal;
})();

// ─── Named exports (mirrors what `import { … } from "process"` expects) ─────
// Data properties are import-time snapshots of the default export's values
// (they agree at import; `env`/`versions`/etc. share the same live object
// reference). Methods are this-safe wrappers around the default export.

export const arch                        = process2.arch;
export const allowedNodeEnvironmentFlags = process2.allowedNodeEnvironmentFlags;
export const argv                        = process2.argv;
export const argv0                       = process2.argv0;
export const env                         = process2.env;
export const execArgv                    = process2.execArgv;
export const execPath                    = process2.execPath;
export const exitCode                    = process2.exitCode;
export const platform                    = process2.platform;
export const version                     = process2.version;
export const versions                    = process2.versions;
export const release                     = process2.release;
export const config                      = process2.config;
export const features                    = process2.features;
export const debugPort                   = process2.debugPort;
export const domain                      = process2.domain;
export const sourceMapsEnabled           = process2.sourceMapsEnabled;
export const moduleLoadList              = process2.moduleLoadList;
export const pid                         = process2.pid;
export const ppid                        = process2.ppid;
export const title                       = process2.title;
export const stdin                       = process2.stdin;
export const stdout                      = process2.stdout;
export const stderr                      = process2.stderr;
export const report                      = process2.report;

// Methods
export const cwd                = (...a) => process2.cwd(...a);
export const chdir              = (...a) => process2.chdir(...a);
export const exit               = (...a) => process2.exit(...a);
export const reallyExit         = (...a) => process2.reallyExit(...a);
export const abort              = (...a) => process2.abort(...a);
export const umask              = (...a) => process2.umask(...a);
export const uptime             = (...a) => process2.uptime(...a);
export const hrtime             = (...a) => process2.hrtime(...a);
hrtime.bigint                   = (...a) => process2.hrtime.bigint(...a);
export const memoryUsage        = (...a) => process2.memoryUsage(...a);
export const cpuUsage           = (...a) => process2.cpuUsage(...a);
export const availableMemory    = (...a) => process2.availableMemory(...a);
export const constrainedMemory  = (...a) => process2.constrainedMemory(...a);
export const resourceUsage      = (...a) => process2.resourceUsage(...a);
export const getActiveResourcesInfo = (...a) => process2.getActiveResourcesInfo(...a);
export const kill               = (...a) => process2.kill(...a);
export const nextTick           = (...a) => process2.nextTick(...a);
export const on                 = (...a) => process2.on(...a);
export const off                = (...a) => process2.off(...a);
export const once               = (...a) => process2.once(...a);
export const addListener        = (...a) => process2.addListener(...a);
export const removeListener     = (...a) => process2.removeListener(...a);
export const removeAllListeners = (...a) => process2.removeAllListeners(...a);
export const prependListener    = (...a) => process2.prependListener(...a);
export const prependOnceListener= (...a) => process2.prependOnceListener(...a);
export const emit               = (...a) => process2.emit(...a);
export const listenerCount      = (...a) => process2.listenerCount(...a);
export const emitWarning        = (...a) => process2.emitWarning(...a);
export const emitWarningSync    = (...a) => process2.emitWarningSync(...a);
export const getuid             = (...a) => process2.getuid(...a);
export const geteuid            = (...a) => process2.geteuid(...a);
export const setuid             = (...a) => process2.setuid(...a);
export const seteuid            = (...a) => process2.seteuid(...a);
export const getgid             = (...a) => process2.getgid(...a);
export const getegid            = (...a) => process2.getegid(...a);
export const setgid             = (...a) => process2.setgid(...a);
export const setegid            = (...a) => process2.setegid(...a);
export const getgroups          = (...a) => process2.getgroups(...a);
export const setgroups          = (...a) => process2.setgroups(...a);
export const initgroups         = (...a) => process2.initgroups(...a);
export const binding            = (...a) => process2.binding(...a);
export const dlopen             = (...a) => process2.dlopen(...a);
export const getBuiltinModule   = (...a) => process2.getBuiltinModule(...a);
export const openStdin          = (...a) => process2.openStdin(...a);
export const ref                = (...a) => process2.ref(...a);
export const unref              = (...a) => process2.unref(...a);
export const setSourceMapsEnabled = (...a) => process2.setSourceMapsEnabled(...a);
export const setUncaughtExceptionCaptureCallback = (...a) => process2.setUncaughtExceptionCaptureCallback(...a);
export const hasUncaughtExceptionCaptureCallback = (...a) => process2.hasUncaughtExceptionCaptureCallback(...a);
export const loadEnvFile        = (...a) => process2.loadEnvFile(...a);
export const execve             = (...a) => process2.execve(...a);

export default process2;
