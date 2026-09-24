// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Enhanced fetch tracking with timeout and abort support




function wrapNetwork(fnName, origFn, blocker) {
  return function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (blocker(url)) throw new Error(`Blocked ${fnName} to ${url}`);
    return origFn(...args);
  };
}

const _realFetch = window.fetch;
const pendingFetches = new Map();

  // Create the patched fetch
  
const patchedFetch = async function (input, init = {}) {
  const requestInfo = typeof input === 'string' ? input : input?.url;
  const requestId = Math.random().toString(36).substr(2, 9);

 

  const blockedUrls = [
    'https://example.com/bad',
  ];

  const url = typeof input === 'string' ? input : input.url;

  if (
    blockedUrls.some(pattern =>
      typeof pattern === 'string'
        ? pattern === url
        : pattern.test(url)
    )
  ) {
    return Promise.reject(new Error(`Blocked fetch to ${url}`));
  }

  emitMe("network_request", null, {
    url: input,
    id: requestId,
    type: "fetch",
    status: "started",
    body: init
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const fetchInit = { ...init, signal: controller.signal };

  let hasError = null;
  let response;

  try {
const { signal, ...serializableInit } = fetchInit;

if (serializableInit.headers) {
  const h = serializableInit.headers;

  serializableInit.headers =
    h instanceof Headers
      ? Object.fromEntries(h.entries())
      : Array.isArray(h)
        ? Object.fromEntries(h)
        : { ...h };
}


    let fetchPromise;

    // pendingFetches.set(requestId, { url: requestInfo, promise: fetchPromise });

    try {
      // 🔥 FIRST: Try parent
      if(serializableInit.body){
       // serializableInit.body = JSON.parse(serializableInit.body)
       }
      const parentFetch = globalThis.__INTEROP_VAR__?.callParent?.(
        '_fetch_',
        input,
        serializableInit
      );

      if (parentFetch == null) {
        throw new Error('Parent declined fetch');
      }

       fetchPromise = parentFetch 

      self.operations?.fetches?.add(fetchPromise);
      fetchPromise.finally(() =>
        self.operations?.fetches?.delete(fetchPromise)
      );

      response = await fetchPromise;
      if(!response){
      throw new Error("Parent Fetch Returned Null")
      }
      
      const res = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers, 
            url: "test"
          })
      
      Object.defineProperty(res, 'url', { value: response.url });
      return res

    } catch (parentError) {
 
      // 🔥 Parent failed — fallback to real fetch
      "__LOG_FETCH_PARENT_FALLBACK__";

      fetchPromise = _realFetch.apply(window, [input, fetchInit]);

      self.operations?.fetches?.add(fetchPromise);
      fetchPromise.finally(() =>
        self.operations?.fetches?.delete(fetchPromise)
      );

      response = await fetchPromise;
    }

    // "__LOG_FETCH_COMPLETED__";

    return response;

  } catch (error) {
    hasError = error;

    if (error.name === 'AbortError') {
      "__LOG_FETCH_TIMEOUT__";
    } else {
      "__LOG_FETCH_FAILED__";
    }

    throw error;

  } finally {
    clearTimeout(timeoutId);

    if (!hasError) {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "finished"
      });
    } else {
      emitMe("network_request", null, {
        url: input,
        id: requestId,
        type: "fetch",
        status: "failed",
        error: hasError?.message || hasError
      });
    }

    pendingFetches.delete(requestId);
  }
};
  
  const patchedFetch2 = async function(input, init = {}) {
    const requestInfo = typeof input === 'string' ? input : input.url;
    const requestId = Math.random().toString(36).substr(2, 9);
    
    
    const blockedUrls = [
  'https://example.com/bad',
  //https:////malware.site///
];
       const url = input;

  // Check blocked URLs
  if (blockedUrls.some(pattern => 
    typeof pattern === 'string' ? pattern === url : pattern.test(url)
  )) {
    return Promise.reject(new Error(`Blocked fetch to ${url}`));
  }
    
    

    emitMe("network_request", null, {
      url:input,
      id:requestId,
      type:"fetch",
      status: "started",
      body:init
    });
    "__LOG_FETCH_STARTED__";
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    
    const fetchInit = { ...init, signal: controller.signal };
    
    // We use .apply(window) to ensure 'this' context is correct
    const fetchPromise = _realFetch.apply(window, [input, fetchInit]);
    
    pendingFetches.set(requestId, { url: requestInfo, promise: fetchPromise });
    let hasError = false;
    try {
      const response = await fetchPromise;
      "__LOG_FETCH_COMPLETED__";
      return response;
    } catch (error) {
      if (error.name === 'AbortError') {
        "__LOG_FETCH_TIMEOUT__";
      } else {
        "__LOG_FETCH_FAILED__";
      }
      hasError = error;
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if(!hasError){
      emitMe("network_request", null, {
      url:input,
      id:requestId,
      type:"fetch",
      status: "finished",
       
      });
     }
    if(hasError){
      emitMe("network_request", null, {
      url:input,
      id:requestId,
      type:"fetch",
      status: "failed",
      error: hasError?.message || hasError
      });
     }  

      pendingFetches.delete(requestId);
    }
  };
 
  // MASKING: Make the patched function look exactly like the native one
  Object.defineProperty(patchedFetch, 'name', { value: 'fetch' });
  patchedFetch.toString = () => "function fetch() { [native code] }";

  // LOCKING: Replace global fetch and prevent modification
  Object.defineProperty(window, 'fetch', {
    value: patchedFetch,
    writable: true,
    configurable: true,
    enumerable: true
  });
  


function waitForAllFetches() {
  const promises = Array.from(pendingFetches.values()).map(f => f.promise);
  return Promise.allSettled(promises);
}

