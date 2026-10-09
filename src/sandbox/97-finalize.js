// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
    // Multiple drain cycles to catch cascading async operations
     for (let i = 0; i < 1; i++) {
       await Promise.resolve(); // Drain microtasks
       await new Promise(r => setTimeout(r, 100)); // Let macrotasks run
    } 
    
    
     
   
     
 
    await Promise.race([
  
      Promise.all([
       _RUNTIME__UUID___.taskTracker.waitForAll(),
        waitForAllFetches(),
        waitForAllXhrs(),
        waitForAllTimers(),
           typeof _RUNTIME__UUID___.__httpServerRunTime !== "undefined"
  ? _RUNTIME__UUID___.__httpServerRunTime.waitForAllServers?.() ?? Promise.resolve()
  : Promise.resolve()
      ]),
       
   
    ])

    // Sequential stdin wait (NOT in Promise.all): runs after main execution
    // completes, so async module loading has finished attaching listeners.
    // Event-driven via waitUntilNoListeners — no polling. If no listeners,
    // resolves immediately.
    if (typeof process?.stdin?.waitUntilNoListeners === "function") {
      await (process.stdin.waitUntilNoListeners() ?? Promise.resolve());
    }
    
    revertTrueOriginals();
    
    //clearAllIntervals();
   

  } catch (err) {
    const sanitized_logs = serialize(logs)
    revertTrueOriginals();
    console.error('Execution error:', err.stack);
    const endTime = performance.now();
    const executionTime = (endTime - startTime).toFixed(2); 
    
   // const stack = reason.stack || '';
 // const message = reason.message || String(reason);

  // Extract the first stack frame (where it happened) with a parser that
  // understands URLs — no naive split(':').
  let location = null;
  let loc = null;
  const frames = [];
  const stackLines = err.stack.split('\n');

  for (let i = 1; i < stackLines.length; i++) {
    const parsed = __parseStackLocationFn(stackLines[i]);
    if (parsed) {
      frames.push(parsed);
      if (!loc) {
        loc = parsed;
        location = `${loc.file}:${loc.line}:${loc.column}`;
      }
    }
  }

    window.parent.postMessage({
      type: 'function_error',
      error: err.message || String(err),
      stack: err.stack,
      location,
      line: loc?.line ?? null,
      column: loc?.column ?? null,
      frames,
      errorName: err?.name || 'Error',
      logs: logs,
      executionTime: parseFloat(executionTime)
    }, '*');
    return;
  } 
  
  
  
  console = originalConsole;
  const endTime = performance.now();
  const executionTime = (endTime - startTime).toFixed(2);
  
  const sanitized_logs = serialize(logs)

  // need a better way to do this - since dev use export {promises}

 const fs = globalThis._RUNTIME__UUID___.__FS__; // This is the fs-like object
const vol = fs?._vol;      // This is the underlying volume

const serializedFs = {};

// 1. Get all file paths in the volume
const files = vol?.toJSON?.() ?? {}; // We use this JUST to get the list of keys/paths

for (const path in files) {
  try {
    // 2. Read each file as a raw Buffer (no encoding = binary)
    // In the browser, memfs Buffers are actually Uint8Arrays
    const data = fs.readFileSync(path);
    
    // 3. Store it. postMessage handles Uint8Array perfectly.
    serializedFs[path] = data instanceof Uint8Array ? data : new Uint8Array(data);
  } catch (e) {
    
  }
}
 
 
 
 
  
  window.parent.postMessage({ 
    type: 'function_results', 
    logs,
    errors,
    fs: serializedFs,
    executionTime: parseFloat(executionTime)
  }, '*');
 })();

//# sourceURL=sandbox://__UUID__/__FILENAME__
