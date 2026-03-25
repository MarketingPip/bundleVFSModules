// todo write acorn patch for globalthis _RUNTIME_ - grabb all host / config.
import {stdin} from "./internals/stdin.js"
 
import makeShim from './internals/stdout.js';
const stdout = makeShim('stdout');
const stderr = makeShim('stderr');

export const process = (function () {
  let _intervalId = null;
  const listeners = Object.create(null);
  let traceWarningHelperShown = false;
  let startTime = performance.now();
  let logs = [];

  // --- Minimal EventEmitter ---
  async function emit(event, ...args) {
    const handlers = listeners[event];
    if (!handlers) return false;
    const results = handlers.slice().map(fn => {
      if (fn._once) off(event, fn);
      try { return fn.apply(processFinal, args); }
      catch (err) { console.error(`Error in listener for ${event}:`, err); }
    });
    await Promise.all(results.filter(r => r instanceof Promise));
    return true;
  }

  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
    return processFinal;
  }
  const addListener = on;

  function prependListener(event, fn) {
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

  function listenerCount(event) { return listeners[event] ? listeners[event].length : 0; }
  function nextTick(fn, ...args) { Promise.resolve().then(() => fn(...args)); }

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
    else if (!(warning instanceof Error)) throw new TypeError("warning must be a string or Error");
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
    if (listenerCount("warning") === 0) defaultWarningHandler(warning);
    emit("warning", warning);
  }

  // --- Reporting ---
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
  });

  // --- stdin / stdout / stderr noops ---
  // Minimal stream-shaped objects. readline, console, and similar tools
  // check for .write(), .on(), .isTTY, .fd, and .pause()/.resume().

  function _makeNoop() {
    const _ev = Object.create(null);
    function _on(ev, fn) { (_ev[ev] || (_ev[ev] = [])).push(fn); return obj; }
    function _off(ev, fn) { if (_ev[ev]) _ev[ev] = _ev[ev].filter(f => f !== fn); return obj; }
    function _emit(ev, ...a) { (_ev[ev] || []).slice().forEach(f => f(...a)); return obj; }
    function _lc(ev) { return (_ev[ev] || []).length; }
    const obj = {
      isTTY: false, fd: -1, readable: false, writable: false,
      encoding: null, destroyed: false,
      on: _on, once(ev, fn) { const w = (...a) => { _off(ev, w); fn(...a); }; return _on(ev, w); },
      off: _off, removeListener: _off,
      removeAllListeners(ev) { if (ev) delete _ev[ev]; else Object.keys(_ev).forEach(k => delete _ev[k]); return obj; },
      listenerCount: _lc, emit: _emit,
      write(_d, _enc, cb) { if (typeof cb === "function") cb(); return true; },
      read() { return null; },
      pause() { return obj; }, resume() { return obj; },
      destroy() { obj.destroyed = true; return obj; },
      pipe(dest) { return dest; },
      setEncoding(enc) { obj.encoding = enc; return obj; },
      end(chunk, enc, cb) { if (typeof chunk === "function") { chunk(); } else if (typeof enc === "function") { enc(); } else if (typeof cb === "function") { cb(); } return obj; },
    };
    return obj;
  }

  // stdout / stderr emit data via console so output is visible in the host env
  function _makeWritable(consoleFn) {
    const base = _makeNoop();
    base.writable = true;
    base.write = function (data, enc, cb) {
      if (data != null) consoleFn(typeof data === "string" ? data.replace(/\n$/, "") : data);
      if (typeof enc === "function") enc();
      else if (typeof cb === "function") cb();
      return true;
    };
    return base;
  }

  const stdin  = _makeNoop();   // readable noop; readline attaches its own 'data' listeners
  stdin.readable = true;

  const stdout = _makeWritable((...a) => console.log(...a));
  const stderr = _makeWritable((...a) => console.error(...a));

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

  // --- umask ---
  let _umask = 0o022;
  function umask(mask) {
    const prev = _umask;
    if (mask !== undefined) _umask = mask & 0o777;
    return prev;
  }

  let cwd = "/";

  const rawMethods = {
    // ── Properties ──────────────────────────────────────────────────────────
    exitCode:  0,
    exiting:   false,

    /** @since Node.js v0.1.104 */
    title: globalThis._RUNTIME_?.process?.title || "Node",

    /** CPU architecture string. @since Node.js v0.5.0 */
    arch: globalThis._RUNTIME_?.process?.arch || "x64",

    /**
     * Set of flags allowed in NODE_OPTIONS.
     * Returns an empty Set in this shim — no Node env to inspect.
     * @since Node.js v10.10.0
     */
    allowedNodeEnvironmentFlags: globalThis._RUNTIME_?.process?.allowedNodeEnvironmentFlags || new Set(),

    /** Command-line arguments. @since Node.js v0.1.27 */
    argv: globalThis._RUNTIME_?.process?.argv || [],

    /** Original argv[0]. @since Node.js v6.4.0 */
    argv0: globalThis._RUNTIME_?.process?.argv0 || "",

    /** Environment variables. @since Node.js v0.1.27 */
    env: globalThis._RUNTIME_?.process?.env || {},

    /** Node.js exec arguments. @since Node.js v0.7.7 */
    execArgv: globalThis._RUNTIME_?.process?.execArgv || [],

    /** Path to the Node executable. @since Node.js v0.1.100 */
    execPath: globalThis._RUNTIME_?.process?.execPath || "",

    /** OS platform string. @since Node.js v0.1.16 */
    platform: globalThis._RUNTIME_?.process?.platform || "browser",

    /** Node.js version string. @since Node.js v0.1.3 */
    version: globalThis._RUNTIME_?.process?.version || "v0.0.0-shim",

    /**
     * Node.js and dependency version info.
     * @since Node.js v0.2.0
     */
    versions: globalThis._RUNTIME_?.process?.versions || {
      node: "0.0.0-shim", v8: "", uv: "", zlib: "", brotli: "",
      ares: "", modules: "", nghttp2: "", napi: "", llhttp: "",
      openssl: "", cldr: "", icu: "", tz: "", unicode: "",
    },

    /**
     * Node.js release metadata.
     * @since Node.js v3.0.0
     */
    release: globalThis._RUNTIME_?.process?.release || {
      name: "node",
      sourceUrl: "",
      headersUrl: "",
      libUrl: "",
      lts: false,
    },

    pid:  globalThis._RUNTIME_?.process?.pid  || 1,
    ppid: globalThis._RUNTIME_?.process?.ppid || 0,

    // ── Streams ──────────────────────────────────────────────────────────────
    /** Readable stream noop (no TTY in browser). @since Node.js v0.1.3 */
    stdin,
    /** Writable stream backed by console.log. @since Node.js v0.1.3 */
    stdout,
    /** Writable stream backed by console.error. @since Node.js v0.1.3 */
    stderr,

    // ── Methods ──────────────────────────────────────────────────────────────
    async exit(code = 0) {
      if (this.exiting) return;
      this.exiting = true;
      this.exitCode = code;

      for (const fn of (listeners.beforeExit || []).slice()) {
        try { const r = fn.call(this, code); if (r instanceof Promise) await r; }
        catch (err) { console.error("Error in beforeExit listener:", err); }
        if (fn._once) off("beforeExit", fn);
      }
      for (const fn of (listeners.exit || []).slice()) {
        try { fn.call(this, code); }
        catch (err) { console.error("Error in exit listener:", err); }
        if (fn._once) off("exit", fn);
      }

      if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }

      const executionTime = parseFloat((performance.now() - startTime).toFixed(2));
      window.parent.postMessage({ type: "kill", logs: logs || [], executionTime, exitCode: this.exitCode }, "*");
    },

    abort() { throw new Error("Process aborted"); },

    /** @since Node.js v0.5.0 */
    uptime() { return (performance.now() - startTime) / 1000; },

    /** @since Node.js v0.1.8 */
    cwd()        { return cwd; },
    chdir(_cwd)  { cwd = _cwd; },

    /**
     * Get or set the file creation mask.
     * @since Node.js v0.1.19
     */
    umask,

    /** @since Node.js v0.1.16 */
    memoryUsage() { return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; },
    /** @since Node.js v6.1.0 */
    cpuUsage()    { return { user: 0, system: 0 }; },

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

    kill(pid, signal = "SIGTERM") {
      if (typeof pid !== "number")    throw new TypeError('The "pid" argument must be of type number');
      if (typeof signal !== "string") throw new TypeError('The "signal" argument must be of type string');
      emit("kill", { pid, signal });
      const executionTime = parseFloat((performance.now() - startTime).toFixed(2));
      window.parent.postMessage({ type: "process_kill", logs: logs || [], executionTime }, "*");
    },

    // EventEmitter
    on, addListener, once, off, removeListener,
    prependListener, prependOnceListener,
    emit, listenerCount, nextTick,

    emitWarning, emitWarningSync,
    report: report(),
  };

  const processBase = {};
  Object.getOwnPropertyNames(rawMethods).forEach(key => {
    const value = rawMethods[key];
    if (typeof value !== "function") { processBase[key] = value; return; }
    const fn = function () { return rawMethods[key].apply(this, arguments); };
    Object.defineProperties(fn, {
      name:     { value: key },
      toString: { value: () => `function ${key}() { [native code] }` },
    });
    processBase[key] = fn;
  });

  processBase.stdin = stdin;
  processBase.stdout = stdout;
   processBase.stdout = stderr;
  const processFinal = Object.create({}, { [Symbol.toStringTag]: { value: "Process", enumerable: false } });
  Object.assign(processFinal, processBase);

  processFinal.noDeprecation        = false;
  processFinal.throwDeprecation     = false;
  processFinal.traceDeprecation     = false;
  processFinal.traceProcessWarnings = false;

  Object.defineProperty(window,     "process", { value: processFinal, writable: false, configurable: false, enumerable: true });
  Object.defineProperty(globalThis, "process", { value: processFinal, writable: false, configurable: false, enumerable: true });

  return processFinal;
})();

// ─── Named exports (mirrors what `import { … } from "process"` expects) ──────

export const arch                        = process.arch;
export const allowedNodeEnvironmentFlags = process.allowedNodeEnvironmentFlags;
export const argv                        = process.argv;
export const argv0                       = process.argv0;
export const env                         = process.env;
export const execArgv                    = process.execArgv;
export const execPath                    = process.execPath;
export const exitCode                    = process.exitCode;
export const platform                    = process.platform;
export const version                     = process.version;
export const versions                    = process.versions;
export const release                     = process.release;
export const pid                         = process.pid;
export const ppid                        = process.ppid;
export const title                       = process.title;
export const stdin                       = process.stdin;
export const stdout                      = process.stdout;
export const stderr                      = process.stderr;

// Methods
export const cwd                = (...a) => process.cwd(...a);
export const chdir              = (...a) => process.chdir(...a);
export const exit               = (...a) => process.exit(...a);
export const umask              = (...a) => process.umask(...a);
export const uptime             = (...a) => process.uptime(...a);
export const memoryUsage        = (...a) => process.memoryUsage(...a);
export const cpuUsage           = (...a) => process.cpuUsage(...a);
export const kill               = (...a) => process.kill(...a);
export const nextTick           = (...a) => process.nextTick(...a);
export const on                 = (...a) => process.on(...a);
export const off                = (...a) => process.off(...a);
export const once               = (...a) => process.once(...a);
export const addListener        = (...a) => process.addListener(...a);
export const removeListener     = (...a) => process.removeListener(...a);
export const prependListener    = (...a) => process.prependListener(...a);
export const prependOnceListener= (...a) => process.prependOnceListener(...a);
export const emit               = (...a) => process.emit(...a);
export const listenerCount      = (...a) => process.listenerCount(...a);
export const emitWarning        = (...a) => process.emitWarning(...a);
export const getuid             = (...a) => process.getuid(...a);
export const geteuid            = (...a) => process.geteuid(...a);
export const setuid             = (...a) => process.setuid(...a);
export const seteuid            = (...a) => process.seteuid(...a);
export const getgid             = (...a) => process.getgid(...a);
export const getegid            = (...a) => process.getegid(...a);
export const setgid             = (...a) => process.setgid(...a);
export const setegid            = (...a) => process.setegid(...a);
export const getgroups          = (...a) => process.getgroups(...a);
export const setgroups          = (...a) => process.setgroups(...a);

export stdin;
export stderr;
export stdout;

export default process;
