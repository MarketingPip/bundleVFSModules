// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.
// Inject cookies from the virtual jar (RFC 6265). The jar must never
    // break a request, so every jar interaction is guarded.
    if (__RT.__cookieJar) {
      try {
        const __host = __h.host || __h.Host || "localhost";
        __jarCtx = { host: __host, path: URL, method: type };
        const __jarCookie = __RT.__cookieJar.cookieHeader("__UUID__", port, __jarCtx);
        const __merged = __RT.__mergeCookieHeaders(__h.cookie ?? __h.Cookie, __jarCookie);
        delete __h.Cookie;
        if (__merged) __h.cookie = __merged; else delete __h.cookie;
      } catch (__jarErr) { /* jar must not break requests */ }
    }
    const __res = await __RT.__httpServerRunTime.handleRequest(port, URL, type, body, __h);
    // Store any Set-Cookie response headers back into the jar.
    if (__RT.__cookieJar && __res && __res.headers) {
      try {
        __RT.__cookieJar.store("__UUID__", port, __res.headers["set-cookie"],
          __jarCtx || { host: (__h.host || __h.Host || "localhost"), path: URL });
      } catch (__jarErr) { /* jar must not break requests */ }
    }
    return __res;
});
 


 


  try {
  await initSandboxState();


  await globalThis[_BVM_RT_KEY_].loadModule("fs");

  // Virtual cookie jar (RFC 6265) for emulated HTTP servers. The IIFE bundle
  // is inlined (see COOKIE_JAR_IIFE) so no network fetch is needed. The jar
  // is keyed per sandbox instance + server port.
  try {
    "__COOKIE_JAR_IIFE__"
    globalThis[_BVM_RT_KEY_].__cookieJar =
      new globalThis.__cookieJarLib.VirtualCookieJar();
    globalThis[_BVM_RT_KEY_].__mergeCookieHeaders =
      globalThis.__cookieJarLib.mergeCookieHeaders;
  } catch (__jarInitErr) {
    console.warn("[cookieJar] init failed:", __jarInitErr && __jarInitErr.message);
  }

 window.parent.postMessage({ type: 'sandbox_ready' }, '*'); 

  
