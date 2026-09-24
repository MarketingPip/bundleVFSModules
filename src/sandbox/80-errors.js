// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Enhanced error handling with stack traces
window.onerror = function(message, source, lineno, colno, error) {
  const errorMsg = error ? (error.stack || error.message || message) : message;
  console.error('Uncaught error:', errorMsg);

  // Parse all frames for parent-side source-map mapping.
  const frames = [];
  if (error?.stack) {
    for (const line of String(error.stack).split('\n')) {
      const loc = __parseStackLocation(line);
      if (loc) frames.push(loc);
    }
  }

  window.parent.postMessage({
    type: 'window_error',
    message: error ? (error.message || String(message)) : String(message),
    source,
    lineno,
    colno,
    stack: error?.stack || null,
    frames,
    errorName: error?.name || 'Error'
  }, '*');

  return true;
};

window.onunhandledrejection = function (event) {
  let reason = event.reason;

  // Normalize non-Error rejections
  if (!(reason instanceof Error)) {
    reason = new Error(typeof reason === 'string'
      ? reason
      : JSON.stringify(reason));
  }

  const stack = reason.stack || '';
  const message = reason.message || String(reason);

  // Extract the first stack frame (where it happened) with a parser that
  // understands URLs — no naive split(':').
  let loc = null;
  const frames = [];
  const stackLines = stack.split('\n');
  for (let i = 1; i < stackLines.length; i++) {
    const parsed = __parseStackLocation(stackLines[i]);
    if (parsed) {
      frames.push(parsed);
      if (!loc) loc = parsed;
    }
  }

window.parent.postMessage({
    type: 'unhandled_promise_rejection',
    reason: `Uncaught (in promise) ${reason.name || 'Error'}: ${message}`,
    stack: stack || null,
    file: loc?.file || null,
    line: loc?.line ?? null,
    column: loc?.column ?? null,
    location: loc ? `${loc.file}:${loc.line}:${loc.column}` : null,
    frames,
    errorName: reason?.name || 'Error'
  }, '*');

  event.preventDefault();
};


 

async function initSandboxState(){
let __initSandboxState = await globalThis.__INTEROP_VAR__.callParent('_getState');

__initSandboxState = `data:text/javascript;charset=utf-8,${encodeURIComponent(__initSandboxState)}`;

 
await import(__initSandboxState);

}


globalThis.__INTEROP_VAR__.expose('__stdin__', (args) => {
    const s = process?.stdin;
  const hasListeners = s && (s.listenerCount('data') > 0 || s.listenerCount('keypress') > 0); 
 
  if (s && hasListeners && !s.isPaused()) {
    return s.pushData(args);
  }
  
  
  // process.stdin.pushData(args)
   if(process && process.stdin && process.stdin.listenerCount('data') != 0 && process.stdin.isPaused() == false){
    return process.stdin.pushData(args);
   }
  
  