// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Node.js Globals

const global = globalThis;

const setImmediate = globalThis.setImmediate || ((fn, ...args) => {
  return setTimeout(fn, 0, ...args);
});



 
 
})();
 
 
// Execute user code with comprehensive error handling
(async () => {
   



// globalThis?.__RUNTIME_FS__ = await globalThis._RUNTIME_.loadModule("RUNTIME:NODE_GLOBALS"); if emulating node (for import.meta.resolve && other fs ops.) 
 
// all interop.expose() will be hoisted here when code is running. 
 
window.__INTEROP_VAR__ =  globalThis[_BVM_INTEROP_KEY_];  // this sets marker & exposes.



//await _RUNTIME_SANDBOX_UUID_.loadModule("fs");
//await _RUNTIME_SANDBOX_UUID_.__FS__.promises.writeFile("/data.json", JSON.stringify({ hello: "worlds" }), "utf8", );
 /**
 * Runtime-compliant shim for import.meta.resolve
 * @param {string} specifier - The path to resolve (e.g., './utils.js')
 * @param {string} [parent=import.meta.url] - The base URL (defaults to current module)
 * @returns {string} - The absolute resolved URL string
 */
 function __RUNTIME_RESOLVE__HANDLE(specifier, parent = 'file:') {
  try {
  
  if(globalThis[_BVM_RT_KEY_]?.__FS__){
  const fs = globalThis[_BVM_RT_KEY_].__FS__;
  const parentDir = "./"
   if(process){
  parent = process.cwd();
  }
  if (!fs.existsSync(parentDir)) {
    throw new TypeError(
      `Failed to resolve module specifier "${specifier}" relative to "${parent}"`
    );
  } 
  if (fs.statSync(parentDir).isFile()) {
    // If parent is a file, strip the file name
    const lastSlash = parentDir.lastIndexOf('/');
    parentDir = lastSlash >= 0 ? parentDir.slice(0, lastSlash) : '.';
  }

  // Handle relative paths: ./ or ../
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    let parts = (parentDir + '/' + specifier).split('/');
    const resolvedParts = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') resolvedParts.pop();
      else resolvedParts.push(part);
    }
    const resolvedPath = '/' + resolvedParts.join('/');
    if (fs.existsSync(resolvedPath) || fs.existsSync(resolvedPath + '.js')) {
      return resolvedPath;
    }
    throw new TypeError(
      `Failed to resolve module specifier "${specifier}" relative to "${parent}"`
    );
  }
  
  
  throw new Error("Failed to find.")
  
  }

   return new URL(specifier, parent).href; // for browser emulation
   
  } catch (err) {
 
    // 2. The spec requires throwing a TypeError on resolution failure
   throw new TypeError(`Failed to resolve module specifier "${specifier}" relative to "${parent}"`);
  }
}

Object.defineProperty(__RUNTIME_RESOLVE__HANDLE, 'toString', {
  value: function() {
    return 'function resolve() { [native code] }';
  },
  writable: false,
  configurable: true
});

 


    
 const observer = new PerformanceObserver((list) => {
  list.getEntries().forEach((r) => {
   
   emitMe("resource_timing", null, {
      url: r.name,
      type: r.initiatorType,
      start: r.startTime,
      duration: r.duration,
      size: r.transferSize,
      encoded: r.encodedBodySize,
      decoded: r.decodedBodySize
    });
   return;
    console.log({
      url: r.name,
      type: r.initiatorType,
      start: r.startTime,
      duration: r.duration,
      size: r.transferSize,
      encoded: r.encodedBodySize,
      decoded: r.decodedBodySize
    });
  });
});

observer.observe({ type: "resource", buffered: true });


// Add to SandboxRuntime.generate() before user code execution:


 
