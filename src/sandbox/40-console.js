// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Save the original console methods
const originalConsole = { ...console };


const stripAnsi = __STRIP_ANSI_FN__

 

// Patch each console method
for (const method in originalConsole) {
  if (typeof originalConsole[method] === 'function') {
    console[method] = function (...args) {
     // const cleanArgs = args.map(arg => typeof arg === 'string' ? stripAnsi(arg) : arg);

     // TODO STRIP ANSI 
     if(process && process.env?.FORCE_COLOR === 0){
     
     }
      emitMe("console", method, ...args);

      if (originalConsole[method]) {
        // originalConsole[method].apply(originalConsole, cleanArgs);
      }
    };
  }
}

 
// Example custom function that gets called before console methods
function serialize(...args) {
  const sanitized = args.map(arg => {
    if (arg === null) return "null";
    if (arg === undefined) return "undefined";
    
    // 1. If the argument is a function
    if (typeof arg === 'function') {
      return arg.toString();
    }
    
    
    // Handle all TypedArrays
if (ArrayBuffer.isView(arg) && !(arg instanceof DataView)) {
  

  
  return JSON.stringify({
    type: "binary",
    data: arg
  }); 
  
   
}

    
    function containsFunction(obj) {
  return Object.values(obj).some(v => typeof v === 'function');
}

     // 2. Check for our custom [object Process] or other native tags
     const tag = Object.prototype.toString.call(arg); 
    // 3. Check for arrays specifically
    if (Array.isArray(arg) || tag === '[object Object]' && typeof arg === 'object' && typeof tag != 'function' && !containsFunction(arg) || tag === '[object Module]' && typeof arg === 'object' && typeof tag != 'function' && !containsFunction(arg)) {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      } 
    }
     
 
    
    
    
     //if (tag !== '[object Objects]' && typeof arg === 'object') {
    
     if (tag && typeof arg === 'object') {
  const properties = Object.getOwnPropertyNames(arg)
    .map(p => {
      const val = arg[p];
      let valueStr;

      if (typeof val === 'function') {
        valueStr = val.toString();
      } else if (typeof val === 'object' && val !== null) {
        try {
          valueStr = JSON.stringify(val);
        } catch {
          valueStr = String(val);
        }
      } else {
        valueStr = JSON.stringify(val); // handles numbers, strings, booleans
      }

      return `
  "${p}": ${valueStr}`;
    })
    .join(',');

  return `${tag} {${properties}
}`;
}

    
    // 4. Normal object handling
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        // Fallback for circular structures
        return String(arg);
      }
    }
    
    // 5. Primitive values (Strings, Numbers, Booleans)
    return String(arg);
  });
  return sanitized;
}
 

function emitMe(fn, method, ...args) {
const sanitized = serialize(...args)



if(fn != "console" && fn != "fs"){
window.parent.postMessage({
    type: fn,
    message: sanitized.join(' ')
  }, '*');

}

 if(fn === "fs"){
  window.parent.postMessage({
    type: 'fs',
    method: method.replace("promises.", ''),
    filename: args[0],
    data: args[1]
  }, '*');
 }

function sanitizeArg(arg) {
  const type = typeof arg;

  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    arg === null ||
    arg === undefined
  ) {
    return arg; // primitives are safe
  }

  if (type === "object"){
  return serialize(arg)
  }

  return arg.toString();
}
globalThis.emitMe = emitMe;

globalThis[_BVM_RT_KEY_].emit = emitMe;

function sendConsoleMessage(method, args) {

const sanitizedArray = typeof serialize === 'function' ? serialize(...args) : args;
const message = sanitizedArray.join(' ');

  window.parent.postMessage({
    type: "stdout",
    method,
    message: message,
  }, "*");
}

 if(fn === "console"){
 sendConsoleMessage(method, args);
 }
}



// Console capture with multiple levels
const logs = [];
const errors = [];

class EventEmitter {
  constructor() { this._events = {}; }
  on(type, listener) {
    (this._events[type] || (this._events[type] = [])).push(listener);
    return this;
  }
  emit(type, ...args) {
    if (!this._events[type]) return false;
    this._events[type].forEach(fn => fn.apply(this, args));
    return true;
  }
  once(type, listener) {
    const selfClosing = (...args) => {
      this.off(type, selfClosing);
      listener.apply(this, args);
    };
    return this.on(type, selfClosing);
  }
  off(type, listener) {
    if (!this._events[type]) return this;
    this._events[type] = this._events[type].filter(fn => fn !== listener);
    return this;
  }
}
// Alias for Node compliance
EventEmitter.prototype.addListener = EventEmitter.prototype.on;
EventEmitter.prototype.removeListener = EventEmitter.prototype.off;

 
 const process2 = (function () {
  let _intervalId = null;
    const listeners = Object.create(null);
  let traceWarningHelperShown = false;
  