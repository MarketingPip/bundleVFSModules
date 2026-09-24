// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// ─── Interop Channel ──────────────────────────────────────────────────────────

const interopChannel = {
  // Call parent functions from sandbox
  callParent: async (method, ...args) => {
    const callId = Math.random().toString(36).substr(2, 9);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Interop call timeout'));
      }, 10000);
      
      const handler = (event) => {
     
        if (event.data.type === 'interop_response' && event.data.callId === callId) {
          clearTimeout(timeout);
          window.removeEventListener('message', handler);
          if (event.data.error) {
          // thinking we need to throw back to sandbox then reject?
            reject(new Error(event.data.error));
          } else {
            resolve(event.data.result);
          }
        }
      };
      
      window.addEventListener('message', handler);
      window.parent.postMessage({
        type: 'interop_call',
        callId,
        method,
        args
      }, '*');
    });
  },
  
  // Register functions that parent can call
  exports: {},
  
  
  expose: (name, fn) => {
    interopChannel.exports[name] = fn;
    const RUNTIME_METHODS = ['__check_exists__', '__stdin__', '__serverRequest__']
    if(!RUNTIME_METHODS.includes(name)){
    window.parent.postMessage({ type: 'interop_registered', name }, '*');
    };
  }
};

//  window.parent.postMessage({ type: 'sandbox_ready' }, '*'); 
 
// Listen for parent calling sandbox functions
window.addEventListener('message', (event) => {
  if (event.data.type === 'interop_invoke') {
    const { callId, method, args } = event.data;
     
    if (globalThis.__INTEROP_VAR__.exports[method]) {
      try {
        const result = globalThis.__INTEROP_VAR__.exports[method](...args);
         
        // Handle async functions
        Promise.resolve(result).then(res => {
          window.parent.postMessage({
            type: 'interop_result',
            callId,
            result: res
          }, '*');
        }).catch(err => {
          window.parent.postMessage({
            type: 'interop_result',
            callId,
            error: err.message
          }, '*');
        });
      } catch (err) {
      
      // Using STDIN error was thrown - pipe back into runtime
       if(method === "__stdin__"){
         throw err
       }
      
      if(method != "__stdin__"){
        window.parent.postMessage({
          type: 'interop_result',
          callId,
          error: err.message
        }, '*');
      }
     }
    } else {
      window.parent.postMessage({
        type: 'interop_result',
        callId,
        error: `Method '${method}' not found`
      }, '*');
    }
  }
}); 

interopChannel.expose('__check_exists__', (methodName) => {
  return typeof interopChannel.exports[methodName] === 'function';
});



 

// Make available globally under a Symbol key: invisible to Object.keys /
// for-in / `in` on globalThis (same rationale as _BVM_RT_KEY_ in
// 00-runtime-object.js). Non-enumerable so symbol-aware copies skip it too.
Object.defineProperty(globalThis, _BVM_INTEROP_KEY_, {
  value: interopChannel,
  writable: true,
  enumerable: false,
  configurable: true,
});


