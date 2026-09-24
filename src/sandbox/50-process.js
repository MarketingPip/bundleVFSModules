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
     
      window.parent.postMessage({ type: 'kill', logs: logs || [], executionTime: parseFloat(executionTime) }, '*');
    },
    
    abort() {
    throw new Error('Process aborted');
    },
      // --- Timing ---
  uptime() {
    return (Date.now() - startTime) / 1000;
  },

  // --- Working directory ---
  cwd() {
    return cwd;
  }, 

  chdir(_cwd){
     if(!globalThis[_BVM_RT_KEY_].__FS__.existsSync(_cwd)){
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
    title:globalThis[_BVM_RT_KEY_].process.title,
    arch:globalThis[_BVM_RT_KEY_].process.arch,
    env:globalThis[_BVM_RT_KEY_].process.env,
    platform:globalThis[_BVM_RT_KEY_].process.platform,
    pid: globalThis[_BVM_RT_KEY_].process.pid,
    ppid: globalThis[_BVM_RT_KEY_].process.ppid,
    argv0: globalThis[_BVM_RT_KEY_].process.argv,
    execPath: globalThis[_BVM_RT_KEY_].process.execPath,
    execArgv: globalThis[_BVM_RT_KEY_].process.execArgv,
    version: globalThis[_BVM_RT_KEY_].process.version,
    versions: globalThis[_BVM_RT_KEY_].process.versions,
    argv: globalThis[_BVM_RT_KEY_].process.argv,
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

await globalThis[_BVM_RT_KEY_].loadModule("RUNTIME:NODE_GLOBALS"); 
      
   
