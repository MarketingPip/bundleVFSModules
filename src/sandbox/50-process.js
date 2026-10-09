// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// 1. Real logic
  const rawMethods = {
 
    async exit(code = 0) {
      emit('beforeExit', code);  // async breaks kill
      emit('exit', code);
       if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
      }
    const endTime = performance.now();
    const executionTime = (endTime - startTime).toFixed(2); 
     
      window.parent.postMessage({ type: 'kill', logs: logs || [], executionTime: parseFloat(executionTime), exitCode: code }, '*');
    },
    
    abort() {
    throw new Error('Process aborted');
    },
    // --- begin sandbox getBuiltinModule (gap #3) ---
    // Synchronous builtin access for createRequire()/Module._load: the
    // sandbox preloads every manifest builtin into _builtinCache at init
    // (see the preload block after RUNTIME:NODE_GLOBALS), so this never
    // needs to await. Matches Node v24: a non-string id throws
    // ERR_INVALID_ARG_TYPE; unknown ids return undefined (no throw).
    getBuiltinModule(id) {
      if (typeof id !== 'string') {
        const err = new TypeError(
          'The "id" argument must be of type string. Received type ' + typeof id + ' (' + String(id) + ')'
        );
        err.code = 'ERR_INVALID_ARG_TYPE';
        throw err;
      }
      const bare = id.startsWith('node:') ? id.slice(5) : id;
      if (typeof _builtinManifest === 'undefined' || typeof _builtinCache === 'undefined') {
        return undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(_builtinManifest, bare)) {
        return undefined;
      }
      if (!_builtinCache.has(bare)) {
        // Unified cache fallback (fix/ondemand-require, Worker A): the async
        // loader populates _builtinCache on completion (see the hook in
        // loadModule), but a builtin loaded through another path may live
        // only in moduleRegistry. Scan for a completed record of the same
        // builtin and return the same instance instead of throwing.
        // _builtinCache stays the O(1) fast path; this O(n) scan is the
        // safety net (kept deliberately after the fast path, not before).
        // Registry keys store the underscore-normalized modulePath
        // (entryPoint::fs_promises), so match both the slash-form bare and
        // its underscore form, each with and without the node: prefix.
        const bareUnderscored = bare.split('/').join('_');
        let registryHit = null;
        try {
          for (const entry of moduleRegistry) {
            const regKey = entry[0];
            const rec = entry[1];
            if (typeof regKey !== 'string' || !rec || rec.status !== 'done') continue;
            if (regKey.endsWith('::node:' + bare) || regKey.endsWith('::' + bare) ||
                regKey.endsWith('::node:' + bareUnderscored) || regKey.endsWith('::' + bareUnderscored)) {
              registryHit = rec;
              break;
            }
          }
        } catch (scanErr) { /* fall through to the explicit error below */ }
        if (registryHit) {
          return _builtinRequireValue(registryHit.exports);
        }
        // Manifest-listed but in neither cache (preload failed or was
        // skipped): a sync require() can never wait for the async loader,
        // so say so explicitly instead of the old silent undefined
        // that surfaced far away as MODULE_NOT_FOUND.
        const err = new Error(
          "[ERR_REQUIRE_ASYNC_MODULE] Cannot require builtin '" + id + "' synchronously: it was not preloaded into the sync builtin cache"
        );
        err.code = 'ERR_REQUIRE_ASYNC_MODULE';
        throw err;
      }
      return _builtinRequireValue(_builtinCache.get(bare));
    },
    // --- end sandbox getBuiltinModule (gap #3) ---
      // --- Timing ---
  uptime() {
    return (Date.now() - startTime) / 1000;
  },

  // --- Working directory ---
  cwd() {
    return cwd;
  }, 

  chdir(_cwd){
     if(!globalThis._RUNTIME__UUID___.__FS__.existsSync(_cwd)){
        throw new Error(`ENOENT: no such file or directory, chdir '${_cwd}'`)
     }
     cwd = _cwd
     // fs.chdir(cwd)
  },


  hrtime:function hrtime(previous) {
      const now = performance.now() / 1000;
      const sec = Math.floor(now);
      const nano = Math.floor((now - sec) * 1e9);

      if (!previous) return [sec, nano];

      let diffSec = sec - previous[0];
      let diffNano = nano - previous[1];

      if (diffNano < 0) {
        diffSec -= 1;
        diffNano += 1e9;
      }

  

      return [diffSec, diffNano];
    },
  
  // --- Memory ---
    memoryUsage() {
    return {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0
    };
   },

  // --- CPU ---
  cpuUsage() {
    return {
      user: 0,
      system: 0
    };
  },



  kill(pid, signal = 'SIGTERM') {
  if (typeof pid !== 'number') {
    throw new TypeError('The "pid" argument must be of type number');
  }

  if (typeof signal !== 'string') {
    throw new TypeError('The "signal" argument must be of type string');
  }
  
  
        const endTime = performance.now();
    const executionTime = (endTime - startTime).toFixed(2); 
     
      window.parent.postMessage({ type: 'process_kill', logs: logs || [], executionTime: parseFloat(executionTime) }, '*');
     //this.emit('kill', { pid, signal });
   },
   
   
       emitWarning,
    emitWarningSync,
    on,
    off,
    emit,
    listenerCount, 
    binding,
    nextTick,
    title:globalThis._RUNTIME__UUID___.process.title,
    arch:globalThis._RUNTIME__UUID___.process.arch,
    env:globalThis._RUNTIME__UUID___.process.env,
    platform:globalThis._RUNTIME__UUID___.process.platform,
    pid: globalThis._RUNTIME__UUID___.process.pid,
    ppid: globalThis._RUNTIME__UUID___.process.ppid,
    argv0: globalThis._RUNTIME__UUID___.process.argv,
    execPath: globalThis._RUNTIME__UUID___.process.execPath,
    execArgv: globalThis._RUNTIME__UUID___.process.execArgv,
    version: globalThis._RUNTIME__UUID___.process.version,
    versions: globalThis._RUNTIME__UUID___.process.versions,
    argv: globalThis._RUNTIME__UUID___.process.argv,
    once,
    prependListener,
    prependOnceListener,
    report: report(),
    cwd: function(){
     return cwd
    }
  };
   
   
  
  
       

  // 2. Cloak all methods
  const processBase = {};

  Object.getOwnPropertyNames(rawMethods).forEach(key => {
  
  const value = rawMethods[key];

    // If it's NOT a function, just copy it as-is
    if (typeof value !== "function") {
      processBase[key] = value;
      return;
    }
    const fn = function () {
      return rawMethods[key].apply(this, arguments);
    };

    Object.defineProperties(fn, {
      name: { value: key },
      toString: {
        value: function () {
          return `function ${key}() { [native code] }`;
        }
      }
    });

    processBase[key] = fn;
  });

  // 3. Create object with fake type
  const processFinal = Object.create({}, {
    [Symbol.toStringTag]: { value: 'Process', enumerable: false }
  });

  Object.assign(processFinal, processBase);
 // Object.freeze(processFinal);


   // Deprecation flags
  processFinal.noDeprecation = false;
  processFinal.throwDeprecation = false;
  processFinal.traceDeprecation = false;
  processFinal.traceProcessWarnings = false;
// Save restorable reference BEFORE the try block: the defineProperty on
// window may throw in some sandbox realms, which would skip everything in
// the try. The template's process (with getBuiltinModule) is authoritative.
try { globalThis.__bvm_process_final__ = processFinal; } catch (e) {}
try{
  // 4. Optionally expose globally
  
Object.defineProperty(window, 'process', {
    value: processFinal,
    writable: false,
    configurable: false,
   enumerable: true
  });
   
   globalThis.process = processFinal;
  }catch(err){
  
  }
  // Node.js global alias — installed OUTSIDE the try block above on purpose.
  // defineProperty(window, 'process') throws in some sandbox realms, which used
  // to skip this alias and left bare global (e.g. vite's bundled isexe,
  // global.TESTING_WINDOWS) as a ReferenceError. Platform-level: bare
  // global must resolve in the sandbox generally, like Node.
  if (typeof globalThis.global === 'undefined') {
    globalThis.global = globalThis;
  }
  return processFinal;
})(); 
  

  


 

const cloakedConsole = (function () {
  const logLevels = Object.getOwnPropertyNames(console).filter(k => typeof console[k] === 'function');

 

  // 1. Logic Storage (The "Raw" Methods)
  const rawMethods = {};
  logLevels.forEach(level => {
    const original = console[level];
    rawMethods[level] = function (...args) {
      const sanitizedArray = typeof serialize === 'function' ? serialize(...args) : args;
      const message = sanitizedArray.join(' ');
 
      if (level === 'error') errors.push(message);
      
      if (level != 'clear'){
      logs.push({type:level, args:message});
      }
      return original.apply(console, args);
    };
  });

  // 2. Cloak all methods (Mirroring your processBase logic)
  const consoleBase = {};
  Object.getOwnPropertyNames(rawMethods).forEach(key => {
    const fn = function () {
      return rawMethods[key].apply(this, arguments);
    };

    Object.defineProperties(fn, {
      name: { value: key },
      toString: {
        value: function () {
          return `function ${key}() { [native code] }`;
        }
      }
    });

    consoleBase[key] = fn;
  });

  // 3. Create the final object with the fake "Console" type
  const consoleFinal = Object.create({}, {
    [Symbol.toStringTag]: { value: 'Object', enumerable: false }
  });

  Object.assign(consoleFinal, consoleBase);
  
  // Note: We don't freeze it here because some 3rd party libs 
  // might try to add properties to console, which would crash the script.

  // 4. Swap the global console
  // We use defineProperty to overwrite the existing window.console
  Object.defineProperty(window, 'console', {
    value: consoleFinal,
    writable: true,
    configurable: true,
    enumerable: true
  });

  return consoleFinal;
})();

await globalThis._RUNTIME__UUID___.loadModule("RUNTIME:NODE_GLOBALS"); 
// Restore the template's process (with getBuiltinModule) if a dist shim
// overwrote globalThis.process during RUNTIME:NODE_GLOBALS import.
if (globalThis.__bvm_process_final__ && globalThis.process !== globalThis.__bvm_process_final__) {
  globalThis.process = globalThis.__bvm_process_final__;
}
      
// Interop exposes hoisted before the sync builtin preload: the preload
// does ~49 sequential loadModule interop calls and can exceed the
// execution timeout; these handlers must be available immediately.
globalThis.__INTEROP_VAR__.expose('__stdin__', (args) => {
    const s = process?.stdin;
  const hasListeners = s && (s.listenerCount('data') > 0 || s.listenerCount('keypress') > 0); 
 
  if (s && hasListeners && (typeof s.isPaused !== 'function' || !s.isPaused())) {
    return s.pushData(args);
  }
  
  
  // process.stdin.pushData(args)
   if(process && process.stdin && process.stdin.listenerCount('data') != 0 && (typeof process.stdin.isPaused !== 'function' || process.stdin.isPaused() == false)){
    return process.stdin.pushData(args);
   }
  
  // --- Key Decoder Function ---
  function decodeKeyPress(str) {
    if (!str) return null;

    // ANSI Escape sequences for arrow keys
    if (str === '\x1b[A' || str === '\x1bOA') return { name: 'up', sequence: str };
    if (str === '\x1b[B' || str === '\x1bOB') return { name: 'down', sequence: str };
    if (str === '\x1b[C' || str === '\x1bOC') return { name: 'right', sequence: str };
    if (str === '\x1b[D' || str === '\x1bOD') return { name: 'left', sequence: str };

    // Enter / Return keys
    if (str === '\r' || str === '\n') return { name: 'return', sequence: str };

    // Backspace
    if (str === '\x7f' || str === '\b') return { name: 'backspace', sequence: str };

    // Handle single characters & Ctrl combinations
    if (str.length === 1) {
      const code = str.charCodeAt(0);
      // Check for Ctrl+A through Ctrl+Z (ASCII codes 1 to 26)
      if (code >= 1 && code <= 26) {
        return {
          name: String.fromCharCode(code + 96),
          ctrl: true,
          sequence: str
        };
      }
      return { name: str, sequence: str };
    }

    // Fallback for complex/unrecognized sequences
    return { name: 'unknown', sequence: str };
  }
  
  function stripKeySequencesPreserveWhitespace(str) {
  if (!str) return "";

  return str
    // Remove ANSI escape sequences (arrow keys, function keys, CSI sequences)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[\(\)][0-9A-Za-z]/g, '')
    // Remove control characters except \n (\x0A) and \t (\x09)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
  // TODO: handle if buffered pass or possible remove if emulating node?
    // Buffer early input instead of silently dropping it: if the sandbox
    // hasn't attached a stdin listener yet (race between __stdin__ and
    // user code), queue the input and flush on first 'data' listener.
    if (s && !hasListeners) {
      s._pendingStdin = s._pendingStdin || [];
      s._pendingStdin.push(args);
      return;
    }
    try {   
              const cleanedCode = stripKeySequencesPreserveWhitespace(args);
              
               const keyEvent = decodeKeyPress(args);
              if (keyEvent) {
                // emitMe("key_event", null, keyEvent)
                return;  
              }
              
               if(!cleanedCode){
                return; 
               }
                const E = window.eval(cleanedCode);
                console.log(E)
            } catch (E) {
                return void console.error(E.message)
            }
});

 

// Runtime method (not reported via execution:interop_registered).
// Updates the sandbox TTY dimensions and emits Node's 'resize' event on
// stdout/stderr so readline and guest 'resize' listeners react.
globalThis.__INTEROP_VAR__.expose('__terminal_resize__', (args) => {
  const cols = Math.floor(Number(args && args.cols));
  const rows = Math.floor(Number(args && args.rows));
  if (!Number.isFinite(cols) || cols <= 0 || !Number.isFinite(rows) || rows <= 0) {
    throw new Error('__terminal_resize__ requires positive integer cols and rows');
  }
  for (const s of [process.stdout, process.stderr]) {
    if (!s) continue;
    s.columns = cols;
    s.rows = rows;
    if (typeof s.emit === 'function') s.emit('resize');
  }
  return { cols, rows };
});

globalThis.__INTEROP_VAR__.expose('__serverRequest__', async (port=8080, URL = "/", type = "GET", body= {}, headers = {}) => {
    const __RT = globalThis._RUNTIME__UUID___;
    const __h = { ...(headers || {}) };
    let __jarCtx = null;
    // Inject cookies from the virtual jar (RFC 6265). The jar must never
    // break a request, so every jar interaction is guarded.
    if (__RT.__cookieJar) {
      try {
        const __host = __h.host || __h.Host || "localhost";
        __jarCtx = { host: __host, path: URL, method: type };
        const __jarCookie = __RT.__cookieJar.cookieHeader("__UUID__", port, __jarCtx);
        const __merged = __RT.__mergeCookieHeaders(__h.cookie ?? __h.Cookie, __jarCookie);
        delete __h.Cookie;
        if (__merged) __h.cookie = __merged; else delete __h.cookie;
      } catch (__jarErr) { /* jar must not break requests */ }
    }
    const __res = await __RT.__httpServerRunTime.handleRequest(port, URL, type, body, __h);
    // Store any Set-Cookie response headers back into the jar.
    if (__RT.__cookieJar && __res && __res.headers) {
      try {
        __RT.__cookieJar.store("__UUID__", port, __res.headers["set-cookie"],
          __jarCtx || { host: (__h.host || __h.Host || "localhost"), path: URL });
      } catch (__jarErr) { /* jar must not break requests */ }
    }
    return __res;
});

// Host fetch bridge: revoke a lost port claim. The host calls this when
// another sandbox already owns the port, so the loser's listen() fails
// loudly with EADDRINUSE instead of silently shadowing the winner.
globalThis.__INTEROP_VAR__.expose('__closeServer__', async (port) => {
    const __RT = globalThis._RUNTIME__UUID___;
    if (__RT && __RT.__httpServerRunTime && typeof __RT.__httpServerRunTime.closeServer === 'function') {
      return __RT.__httpServerRunTime.closeServer(port);
    }
    return false;
});

// --- begin sync builtin preload (gap #3) ---
// DISABLED 2026-10-08: Preload causes random shim execution and 30s timeouts. Shims must load on-demand.
if (false) {
// Populate the SYNC builtin cache before user code runs. dist/module.js's
// loadBuiltinModule() can only use the sandbox RT.loadModule() when it
// returns synchronously — it never does — so sync require('fs') via
// createRequire()/Module._load falls through to process.getBuiltinModule(),
// which reads this cache. Without the preload every sync builtin require
// died with MODULE_NOT_FOUND (Vitest E2E: Rolldown's createRequire('fs')).
// Per-key try/catch: one unfetchable builtin must not abort the rest or
// sandbox init. Async import() of builtins keeps working independently of
// this cache (separate moduleRegistry path).
// Batched (not fully sequential, not fully concurrent): the interop channel
// times out under 51 concurrent loadModule calls, but sequential is too slow
// (15-23s for 49 modules). Batches of 10 are fast and reliable.
// ponytail: batch size 10, increase if interop channel proves stable
try {
  var _preloadKeys = Object.keys(_builtinManifest).filter(function(k) { return k.indexOf('RUNTIME') !== 0; });
  var _batchSize = 10;
  for (var _bi = 0; _bi < _preloadKeys.length; _bi += _batchSize) {
    var _batch = _preloadKeys.slice(_bi, _bi + _batchSize);
    await Promise.all(_batch.map(function(_pkey) {
      return globalThis._RUNTIME__UUID___.loadModule(_pkey, 'import').then(
        function(mod) { _builtinCache.set(_pkey, mod); },
        function(e) { console.warn('[bvm] sync-builtin preload skipped ' + _pkey + ': ' + String((e && e.message) || e)); }
      );
    }));
  }
} catch (e) {
  console.warn('[bvm] sync-builtin preload failed: ' + String((e && e.message) || e));
}
} // end if(false) - DISABLED preload
// --- end sync builtin preload (gap #3) ---
