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
