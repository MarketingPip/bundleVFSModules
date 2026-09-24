// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Enhanced timer tracking with WeakMap for cleanup
const timerRegistry = new Map();
let timerIdCounter = 0;
const originalSetInterval = setInterval;
const originalClearInterval = clearInterval;
const originalSetTimeout = setTimeout;
const originalClearTimeout = clearTimeout;

function revertTrueOriginals(){
globalThis.setTimeout = originalSetTimeout;
globalThis.clearTimeout = originalClearTimeout;
globalThis.setInterval = originalSetInterval;
globalThis.clearInterval = originalClearInterval;
globalThis.console = originalConsole;
}

globalThis.setTimeout = (fn, delay, ...args) => {
  const timerId = originalSetTimeout(() => {
    timerRegistry.delete(timerId);
    try {
      fn(...args);
    } catch (err) {
      console.log(err.stack)
      console.error('Timer error:', err.message);
    }
  }, Math.max(0, delay || 0));
  
  timerRegistry.set(timerId, { type: 'timeout', created: Date.now() });
  return timerId;
};

globalThis.clearTimeout = (id) => {
  timerRegistry.delete(id);
  originalClearTimeout(id);
};
  
function waitForAllTimers() {
  return new Promise(resolve => {
    const check = () => {
      const pending = Array.from(timerRegistry.values())
        .filter(t => t.type === 'timeout');
      
      if (pending.length === 0) {
        resolve();
      } else {
        originalSetTimeout(check, 50);
      }
    };
    check();
  });
}



setInterval = (fn, delay, ...args) => {
  const id = originalSetInterval(() => {
    try {
      fn(...args);
    } catch (err) {
      console.error('Interval error:', err.message);
      clearInterval(id);
    }
  }, Math.max(0, delay || 0));
  
  timerRegistry.set(id, { type: 'interval', created: Date.now() });
  return id;
};

clearInterval = (id) => {
  timerRegistry.delete(id);
  originalClearInterval(id);
};

function clearAllIntervals() {
  timerRegistry.forEach((info, id) => {
    if (info.type === 'interval') {
      clearInterval(id);
    }
  });
}


const _realCreateElement = document.createElement;

document.createElement = function(tagName, options) {
  const tag = tagName.toLowerCase();
  if (tag === 'iframe' || tag === 'frame' || tag === 'object' || tag === 'embed') {
     // throw new SecurityError("Creation of frames/objects is disabled in this sandbox.");
  }
  return _realCreateElement.apply(document, [tagName, options]);
};

// Mask it
// Object.defineProperty(document.createElement, 'name', { value: 'createElement' });
// document.createElement.toString = () => "function createElement() { [native code] }";

const _originalInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set;

Object.defineProperty(Element.prototype, 'innerHTML', {
  set: function(value) {
    if (typeof value === 'string' && /<iframe|<frame|<object|<embed/i.test(value)) {
     // throw new SecurityError("Illegal HTML injection detected.");
    }
    _originalInnerHTML.call(this, value);
  },
  configurable: false
});


const OrigEventSource = window.EventSource;

globalThis.EventSource = function (url, options) {
  if (url.includes('blocked.com')) throw new Error(`Blocked EventSource to ${url}`);
  return new OrigEventSource(url, options);
};



const OrigWS = window.WebSocket;

globalThis.WebSocket = function (url, protocols) {
  if (url.includes('blocked.com')) throw new Error(`Blocked WebSocket to ${url}`);
  return new OrigWS(url, protocols);
};


const origBeacon = navigator.sendBeacon.bind(navigator);

globalThis.navigator.sendBeacon = (url, data) => {
  if (url.includes('blocked.com')) return false;
  return origBeacon(url, data);
};


