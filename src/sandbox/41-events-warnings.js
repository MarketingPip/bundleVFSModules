// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// --- Minimal EventEmitter ---
  async function emit(event, ...args) {
    const handlers = listeners[event];
    if (!handlers) return false;

    // Make a copy to avoid mutation during iteration
    const results = handlers.slice().map(fn => {
      if (fn._once) off(event, fn);
      return fn.apply(processFinal, args);
    });

    // Await any promises returned by async functions
    await Promise.all(results);

    return true;
  }

function binding(name) {
    if (name === "natives") return {
      assert: true, buffer: true, child_process: true, constants: true,
      crypto: true, events: true, fs: true, http: true, https: true,
      module: true, os: true, path: true, process: true, stream: true,
      string_decoder: true, timers: true, tty: true, url: true, util: true, zlib: true
    };
    if (name === "config") return { exposeInternals: false };
    if (name === "constants")
      return {
        os: {
          UV_UDP_REUSEADDR: 4,
          signals: {
            SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
            SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
            SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
            SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
            SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
            SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
          },
          errno: {},
        },
        fs: {
          O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
          O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048,
          O_DSYNC: 4096, O_SYNC: 1052672, O_DIRECT: 16384, O_DIRECTORY: 65536,
          O_NOATIME: 262144, O_NOFOLLOW: 131072, O_CLOEXEC: 524288,
          UV_FS_O_FILEMAP: 0,
          S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
          S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
          F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
        },
        crypto: {},
        zlib: {},
      };
    if (name === "util") return {};
    if (name === "fs") return {};
    if (name === "buffer") return {};
    if (name === "stream_wrap") return {};
    if (name === "tcp_wrap") return {};
    if (name === "pipe_wrap") return {};
    
    // Throw for unknown bindings so callers fall back gracefully
    throw new Error(`No such module: ${name}`);
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
    warning.name = type || 'Warning';
    if (code !== undefined) warning.code = code;
    if (detail !== undefined) warning.detail = detail;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(warning, ctor || processFinal.emitWarning);
    }

    return warning;
  }

  function formatWarning(warning) {
    const isDeprecation = warning.name === 'DeprecationWarning';

    const trace =
      processFinal.traceProcessWarnings ||
      (isDeprecation && processFinal.traceDeprecation);

    let msg = `(node:${processFinal.pid || 1}) `;

    if (warning.code) {
      msg += `[${warning.code}] `;
    }

    if (trace && warning.stack) {
      msg += warning.stack;
    } else {
      msg += warning.toString();
    }

    if (typeof warning.detail === 'string') {
      msg += `
${warning.detail}`;
    }

    if (!trace && !traceWarningHelperShown) {
      const flag = isDeprecation
        ? '--trace-deprecation'
        : '--trace-warnings';

      const msg = `\n(Use \`node \${flag} ...\` to show where the warning was created)`;
      traceWarningHelperShown = true;
    }

    return msg;
  }

  function defaultWarningHandler(warning) {
    if (!(warning instanceof Error)) return;

    const isDeprecation = warning.name === 'DeprecationWarning';
    if (isDeprecation && processFinal.noDeprecation) return;

    console.error(formatWarning(warning));
  }

  function emitWarning(warning, type, code, ctor) {
    if (processFinal.noDeprecation && type === 'DeprecationWarning') {
      return;
    }

    let detail;

    if (type && typeof type === 'object' && !Array.isArray(type)) {
      ctor = type.ctor;
      code = type.code;
      detail = type.detail;
      type = type.type || 'Warning';
    } else if (typeof type === 'function') {
      ctor = type;
      type = 'Warning';
      code = undefined;
    }

    if (typeof code === 'function') {
      ctor = code;
      code = undefined;
    }

    if (typeof warning === 'string') {
      warning = createWarningObject(warning, type, code, ctor, detail);
    } else if (!(warning instanceof Error)) {
      throw new TypeError('warning must be a string or Error');
    }

    if (warning.name === 'DeprecationWarning') {
      if (processFinal.noDeprecation) return;

      if (processFinal.throwDeprecation) {
        return nextTick(() => { throw warning; });
      }
    }

    nextTick(() => {
      if (listenerCount('warning') === 0) {
        defaultWarningHandler(warning);
      }
      emit('warning', warning);
    });
  }

  function emitWarningSync(warning, type, code, ctor) {
    if (typeof warning === 'string') {
      warning = createWarningObject(warning, type, code, ctor);
    }

    if (listenerCount('warning') === 0) {
      defaultWarningHandler(warning);
    }

    emit('warning', warning);
  }


 // Report 
 
 const report = (function () {
  let _directory = '';
  let _filename = '';
  let _compact = false;
  let _excludeNetwork = false;
  let _signal = null;
  let _reportOnFatalError = false;
  let _reportOnSignal = false;
  let _reportOnUncaughtException = false;
  let _excludeEnv = false;

  // Internal store for reports
  const reports = [];

  function writeReport(file, err) {
    if (typeof file === 'object' && file !== null) {
      err = file;
      file = undefined;
    } else if (file !== undefined && typeof file !== 'string') {
      throw new TypeError('file must be a string');
    }

    if (err === undefined) {
      err = new Error('Synthetic error');
    } else if (typeof err !== 'object' || err === null) {
      throw new TypeError('err must be an object');
    }

    const r = {
      source: 'JavaScript API',
      type: 'API',
      file: file || _filename || null,
      error: err,
      timestamp: Date.now(),
      compact: _compact,
      directory: _directory,
      excludeNetwork: _excludeNetwork,
      excludeEnv: _excludeEnv,
    };

    reports.push(r);

    // For demo, log to console
    console.warn('Report written:', r);

    return r;
  }

  function getReport(err) {
    if (err === undefined) {
      err = new Error('Synthetic error');
    } else if (typeof err !== 'object' || err === null) {
      throw new TypeError('err must be an object');
    }

    // Return the latest report matching this error, if any
    const r = reports.find(r => r.error === err);
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }
 
  function addSignalHandler(sig) {
    if (!_reportOnSignal) return;

    if (typeof sig !== 'string') sig = _signal;

    if (sig) {
      process.on(sig, signalHandler);
    }
  }

  function removeSignalHandler() {
    if (_signal) {
      process.removeListener(_signal, signalHandler);
    }
  }

  function signalHandler(sig) {
    writeReport(sig, { type: 'Signal', message: 'Signal received' });
  }

   function hrtime(previous) {
  const now = performance.now() / 1000; // seconds
  const sec = Math.floor(now);
  const nano = Math.floor((now - sec) * 1e9);

  if (!previous) return [sec, nano];

  let diffSec = sec - previous[0];
  let diffNano = nano - previous[1];

  if (diffNano < 0) {
    diffSec -= 1;
    diffNano += 1e9;
  }

hrtime.bigint = () => {
  return BigInt(Math.floor(performance.now() * 1e6));
};

  return [diffSec, diffNano];
};




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
    set signal(sig) { 
      removeSignalHandler();
      _signal = String(sig); 
      addSignalHandler(sig);
    },

    get reportOnFatalError() { return _reportOnFatalError; },
    set reportOnFatalError(trigger) { _reportOnFatalError = Boolean(trigger); },

    get reportOnSignal() { return _reportOnSignal; },
    set reportOnSignal(trigger) { 
      _reportOnSignal = Boolean(trigger);
      removeSignalHandler();
      addSignalHandler();
    },

    get reportOnUncaughtException() { return _reportOnUncaughtException; },
    set reportOnUncaughtException(trigger) { _reportOnUncaughtException = Boolean(trigger); },

    get excludeEnv() { return _excludeEnv; },
    set excludeEnv(b) { _excludeEnv = Boolean(b); },
  };
})

  let cwd = "/"
  