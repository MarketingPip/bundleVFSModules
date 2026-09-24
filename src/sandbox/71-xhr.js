// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Enhanced XHR tracking
const originalXHR = window.XMLHttpRequest;
const pendingXhrs = new Map();

function PatchedXHR() {
  const xhr = new originalXHR();
  const xhrId = Math.random().toString(36).substr(2, 9);
  
  const originalOpen = xhr.open;
  const originalSend = xhr.send;

  let url = '';
  let method = '';

  xhr.open = function(m, u, ...args) {
    method = m;
    url = u;
    return originalOpen.apply(this, [m, u, ...args]);
  };

  xhr.send = function(body) {
    "__LOG_XHR_STARTED__";
    
    emitMe("network_request", null, {
      method,
      url,
      type:"xhr",
      status: xhr.status
    });
    

    const cleanup = () => {
      pendingXhrs.delete(xhrId);
      "__LOG_XHR_COMPLETED__";
    };

    xhr.addEventListener('loadend', cleanup);
    xhr.addEventListener('error', () => {
      pendingXhrs.delete(xhrId);
      "__LOG_XHR_FAILED__";
    });
    xhr.addEventListener('abort', () => {
      pendingXhrs.delete(xhrId);
      "__LOG_XHR_ABORTED__";
    });

    pendingXhrs.set(xhrId, xhr);
    return originalSend.apply(this, [body]);
  };

  return xhr;
  
}

function maskFunction(patchedFn, originalFn) {
  Object.defineProperty(patchedFn, 'name', { value: originalFn.name });
  patchedFn.toString = () => originalFn.toString();
}
maskFunction(PatchedXHR, originalXHR)
maskFunction(setTimeout, originalSetTimeout)
maskFunction(clearTimeout, originalClearTimeout)
maskFunction(setInterval, originalSetInterval)
maskFunction(clearInterval, originalClearInterval)
 
 Object.defineProperty(document.createElement, 'name', { value: 'createElement' });
document.createElement.toString = () => "function createElement() { [native code] }";

window.XMLHttpRequest = PatchedXHR;

function waitForAllXhrs() {
  return new Promise(resolve => {
    const check = () => {
      if (pendingXhrs.size === 0) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// __parseStackLocation is defined once at module scope (exported for
// unit tests) and inlined here so the iframe runs the identical code.
"__PARSE_STACK_LOCATION_FN__"

