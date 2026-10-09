// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.

globalThis.__INTEROP_VAR__.expose('__serverRequest__', async (port=8080, URL = "/", type = "GET", body= {}, headers = {}) => {
    const __RT = globalThis._RUNTIME__UUID___;
    const __h = { ...(headers || {}) };
    let __jarCtx = null;
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

// Host fetch bridge: revoke a lost port claim. The host calls this when
// another sandbox already owns the port, so the loser's listen() fails
// loudly with EADDRINUSE instead of silently shadowing the winner.
globalThis.__INTEROP_VAR__.expose('__closeServer__', async (port) => {
    const __RT = globalThis._RUNTIME__UUID___;
    if (__RT && __RT.__httpServerRunTime && typeof __RT.__httpServerRunTime.closeServer === 'function') {
      return __RT.__httpServerRunTime.closeServer(port);
    }
    return false;
});

// --- begin sync builtin preload (gap #3) ---
// DISABLED 2026-10-08: Preload causes random shim execution and 30s timeouts. Shims must load on-demand.
if (false) {
// Populate the SYNC builtin cache before user code runs. dist/module.js's
// loadBuiltinModule() can only use the sandbox RT.loadModule() when it
// returns synchronously — it never does — so sync require('fs') via
// createRequire()/Module._load falls through to process.getBuiltinModule(),
// which reads this cache. Without the preload every sync builtin require
// died with MODULE_NOT_FOUND (Vitest E2E: Rolldown's createRequire('fs')).
// Per-key try/catch: one unfetchable builtin must not abort the rest or
// sandbox init. Async import() of builtins keeps working independently of
// this cache (separate moduleRegistry path).
// Batched (not fully sequential, not fully concurrent): the interop channel
// times out under 51 concurrent loadModule calls, but sequential is too slow
// (15-23s for 49 modules). Batches of 10 are fast and reliable.
// ponytail: batch size 10, increase if interop channel proves stable
try {
  var _preloadKeys = Object.keys(_builtinManifest).filter(function(k) { return k.indexOf('RUNTIME') !== 0; });
  var _batchSize = 10;
  for (var _bi = 0; _bi < _preloadKeys.length; _bi += _batchSize) {
    var _batch = _preloadKeys.slice(_bi, _bi + _batchSize);
    await Promise.all(_batch.map(function(_pkey) {
      return globalThis._RUNTIME__UUID___.loadModule(_pkey, 'import').then(
        function(mod) { _builtinCache.set(_pkey, mod); },
        function(e) { console.warn('[bvm] sync-builtin preload skipped ' + _pkey + ': ' + String((e && e.message) || e)); }
      );
    }));
  }
} catch (e) {
  console.warn('[bvm] sync-builtin preload failed: ' + String((e && e.message) || e));
}
} // end if(false) - DISABLED preload
// --- end sync builtin preload (gap #3) ---
