// todo write acorn patch for globalthis _RUNTIME_ - grabb all host / config.
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
      try {
        return fn.apply(processFinal, args);
      } catch (err) {
        console.error(`Error in listener for ${event}:`, err);
      }
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

  function once(event, fn) {
    fn._once = true;
    return on(event, fn);
  }

  function prependOnceListener(event, fn) {
    fn._once = true;
    return prependListener(event, fn);
  }

  function off(event, fn) {
    const arr = listeners[event];
    if (!arr) return processFinal;
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
    return processFinal;
  }
  const removeListener = off;

  function listenerCount(event) {
    return listeners[event] ? listeners[event].length : 0;
  }

  function nextTick(fn, ...args) {
    Promise.resolve().then(() => fn(...args));
  }

  // --- Warning internals ---
  function createWarningObject(message, type, code, ctor, detail) {
    const warning = new Error(message);
    warning.name = type || "Warning";
    if (code !== undefined) warning.code = code;
    if (detail !== undefined) warning.detail = detail;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(warning, ctor || processFinal.emitWarning);
    }
    return warning;
  }

  function formatWarning(warning) {
    const isDeprecation = warning.name === "DeprecationWarning";
    const trace =
      processFinal.traceProcessWarnings ||
      (isDeprecation && processFinal.traceDeprecation);

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
      ctor = type.ctor;
      code = type.code;
      detail = type.detail;
      type = type.type || "Warning";
    } else if (typeof type === "function") {
      ctor = type;
      type = "Warning";
      code = undefined;
    }
    if (typeof code === "function") {
      ctor = code;
      code = undefined;
    }
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
    let _directory = "";
    let _filename = "";
    let _compact = false;
    let _excludeNetwork = false;
    let _signal = null;
    let _reportOnFatalError = false;
    let _reportOnSignal = false;
    let _reportOnUncaughtException = false;
    let _excludeEnv = false;

    const reports = [];

    function writeReport(file, err) {
      if (typeof file === "object" && file !== null) { err = file; file = undefined; }
      else if (file !== undefined && typeof file !== "string") throw new TypeError("file must be a string");

      if (err === undefined) err = new Error("Synthetic error");
      else if (typeof err !== "object" || err === null) throw new TypeError("err must be an object");

      const r = {
        source: "JavaScript API",
        type: "API",
        file: file || _filename || null,
        error: err,
        timestamp: Date.now(),
        compact: _compact,
        directory: _directory,
        excludeNetwork: _excludeNetwork,
        excludeEnv: _excludeEnv
      };

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

    function addSignalHandler(sig) {
      if (!_reportOnSignal) return;
      if (typeof sig !== "string") sig = _signal;
      if (sig) process.on(sig, signalHandler);
    }

    function removeSignalHandler() {
      if (_signal) process.removeListener(_signal, signalHandler);
    }

    function signalHandler(sig) {
      writeReport(sig, { type: "Signal", message: "Signal received" });
    }

    return {
      writeReport,
      getReport,
      get directory() { return _directory; },
      set directory(dir) { _directory = String(dir); },
      get filename() { return _filename; },
      set filename(name) { _filename = String(name); },
      get compact() { return _compact; },
      set compact(b) { _compact = Boolean(b); },
      get excludeNetwork() { return _excludeNetwork; },
      set excludeNetwork(b) { _excludeNetwork = Boolean(b); },
      get signal() { return _signal; },
      set signal(sig) { removeSignalHandler(); _signal = String(sig); addSignalHandler(sig); },
      get reportOnFatalError() { return _reportOnFatalError; },
      set reportOnFatalError(trigger) { _reportOnFatalError = Boolean(trigger); },
      get reportOnSignal() { return _reportOnSignal; },
      set reportOnSignal(trigger) { _reportOnSignal = Boolean(trigger); removeSignalHandler(); addSignalHandler(); },
      get reportOnUncaughtException() { return _reportOnUncaughtException; },
      set reportOnUncaughtException(trigger) { _reportOnUncaughtException = Boolean(trigger); },
      get excludeEnv() { return _excludeEnv; },
      set excludeEnv(b) { _excludeEnv = Boolean(b); }
    };
  });

  let cwd = "/";

  const rawMethods = {
    exitCode: 0,
    exiting: false,

    async exit(code = 0) {
      if (this.exiting) return;
      this.exiting = true;
      this.exitCode = code;

      const beforeExitHandlers = (listeners.beforeExit || []).slice();
      for (const fn of beforeExitHandlers) {
        try {
          const result = fn.call(this, code);
          if (result instanceof Promise) await result;
        } catch (err) {
          console.error("Error in beforeExit listener:", err);
        }
        if (fn._once) off("beforeExit", fn);
      }

      const exitHandlers = (listeners.exit || []).slice();
      for (const fn of exitHandlers) {
        try { fn.call(this, code); } 
        catch (err) { console.error("Error in exit listener:", err); }
        if (fn._once) off("exit", fn);
      }

      if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }

      const endTime = performance.now();
      const executionTime = (endTime - startTime).toFixed(2);

      window.parent.postMessage(
        { type: "kill", logs: logs || [], executionTime: parseFloat(executionTime), exitCode: this.exitCode },
        "*"
      );
    },

    abort() { throw new Error("Process aborted"); },
    uptime() { return (Date.now() - startTime) / 1000; },
    cwd() { return cwd; },
    chdir(_cwd) { cwd = _cwd; },

    memoryUsage() { return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }; },
    cpuUsage() { return { user: 0, system: 0 }; },

    kill(pid, signal = "SIGTERM") {
      if (typeof pid !== "number") throw new TypeError('The "pid" argument must be of type number');
      if (typeof signal !== "string") throw new TypeError('The "signal" argument must be of type string');
      emit("kill", { pid, signal });

      const endTime = performance.now();
      const executionTime = (endTime - startTime).toFixed(2);

      window.parent.postMessage(
        { type: "process_kill", logs: logs || [], executionTime: parseFloat(executionTime) },
        "*"
      );
    },

    emitWarning,
    emitWarningSync,
    on,
    off,
    emit,
    listenerCount,
    nextTick,
    title: "process title",
    arch: "x64",
    env: {},
    platform: "shim",
    pid: 1,
    ppid: 0,
    argv0: "",
    execPath: "",
    execArgv: [],
    version: "v0.0.0-shim",
    versions: {},
    argv: ${JSON.stringify(config.process?.argv)},
    once,
    prependListener,
    prependOnceListener,
    report: report()
  };

  const processBase = {};
  Object.getOwnPropertyNames(rawMethods).forEach(key => {
    const value = rawMethods[key];
    if (typeof value !== "function") { processBase[key] = value; return; }

    const fn = function () { return rawMethods[key].apply(this, arguments); };
    Object.defineProperties(fn, {
      name: { value: key },
      toString: { value: function () { return `function ${key}() { [native code] }`; } }
    });
    processBase[key] = fn;
  });

  const processFinal = Object.create({}, { [Symbol.toStringTag]: { value: "Process", enumerable: false } });
  Object.assign(processFinal, processBase);

  processFinal.noDeprecation = false;
  processFinal.throwDeprecation = false;
  processFinal.traceDeprecation = false;
  processFinal.traceProcessWarnings = false;

  Object.defineProperty(window, "process", { value: processFinal, writable: false, configurable: false, enumerable: true });
  globalThis.process = processFinal;

  return processFinal;
})();
