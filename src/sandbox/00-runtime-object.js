// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.



globalThis._RUNTIME__UUID___ = {globals: new Set(), process:"__PROCESS_JSON__", taskTracker:null, __USER_FILES__:"__USER_FILES_JSON__", __SEA_ASSETS__:"__SEA_ASSETS_JSON__", __SHELL_FIELD__};
// Stable alias for platform shims: they write globalThis._RUNTIME_ expecting the
// sandbox-scoped object, but the AST rewrite only applies to Node builtins, not
// VFS-loaded CJS. Per-realm (each sandbox has its own globalThis), so isolation
// is preserved.
globalThis._RUNTIME_ = globalThis._RUNTIME__UUID___;

// Builtin manifest for the sandbox-side sync require: createSyncRequire
// checks _builtinManifest/_builtinCache, but the parent-scope originals are
// not visible inside this generated script. The cache starts empty, so a
// sync require() of a builtin throws ERR_REQUIRE_ASYNC (load it async first).
const _builtinManifest = "__BUILTIN_MODULES_JSON__";
const _builtinCache = new Map();
// In-flight cold-require promises, keyed by manifest key. A synchronous
// require() cannot block on the async loader, so a cold builtin require()
// triggers loadModule() and returns its promise; this map lets concurrent
// cold requires for the same builtin share one load and resolve to the same
// instance. Entries are deleted on settle (success and failure), so a failed
// load is retried on the next call instead of caching a rejection.
var _bvmRequirePending = new Map();

// --- begin sync builtin require interop (gap #3) ---
// Single-default interop shared by the sync builtin consumers
// (createSyncRequire, process.getBuiltinModule): what a synchronous
// require() of a builtin returns. Mirrors the unwrap in 21-sync-require.
function _builtinRequireValue(mod) {
  // Every builtin port declares its CJS module.exports equivalent via
  // export default (events.js: export default EventEmitter). Sync require()
  // must return that value, not the ESM namespace, or
  // const E = require("events"); new E() dies with "not a constructor".
  // Unwrap only when the default is callable (a class like EventEmitter):
  // for object defaults the namespace must be preserved, because loadModule
  // returns an interop Proxy whose lazy getters (CJS named-export fallback,
  // star re-exports) live on the proxy, not on the plain target object.
  if (mod && typeof mod.default === 'function') return mod.default;
  return (mod && mod.default !== undefined && Object.keys(mod).length === 1)
    ? mod.default
    : mod;
}
// On-demand sync builtin require (transform-time hoisting companion):
// nested require() of a builtin that is already cached returns it
// synchronously; otherwise throws ERR_REQUIRE_ASYNC_MODULE directing the
// user to await import() first. String-concat only inside this block:
// it lives inside the outer sandbox template literal, so backticks and
// template placeholders are forbidden here.
function __bvmRequireSync(request) {
  var bare = (typeof request === 'string' && request.indexOf('node:') === 0) ? request.slice(5) : request;
  var key = Object.prototype.hasOwnProperty.call(_builtinManifest, bare) ? bare
    : Object.prototype.hasOwnProperty.call(_builtinManifest, request) ? request : null;
  if (key !== null && typeof _builtinCache !== 'undefined' && _builtinCache.has(key)) {
    return _builtinRequireValue(_builtinCache.get(key));
  }
  if (key !== null) {
    // Cold builtin: true lazy-on-call with a synchronous return is impossible
    // - JS has no primitive that blocks the event loop on a promise - so the
    // call triggers the async load now and returns its promise. The promise is
    // cached in _bvmRequirePending so concurrent cold requires share one
    // loadModule() call and resolve to the same instance. loadModule's own
    // _builtinCache hook makes every later require() of this builtin
    // synchronous, so the warm contract is unchanged; only the cold path
    // changes (previously it threw ERR_REQUIRE_ASYNC_MODULE telling the user
    // to await import() first - still valid, just no longer required).
    // NOTE: call loadModule via the runtime object, NOT the bare identifier.
    // The bare top-level loadModule binding is not reliably resolvable from
    // this scope in the executed sandbox module (es-module-shims execution
    // quirk: only some top-level function declarations survive as bindings -
    // verified live 2026-10-09: typeof loadModule === 'undefined' while
    // globalThis._RUNTIME_.loadModule === 'function'). The runtime-object
    // property path is the same one the transform emits for imports, and it
    // always works. globalThis._RUNTIME_ is the stable per-sandbox alias set
    // at the top of this template.
    if (!_bvmRequirePending.has(key)) {
      _bvmRequirePending.set(key, globalThis._RUNTIME_.loadModule(request).then(
        function (mod) { _bvmRequirePending.delete(key); return _builtinRequireValue(mod); },
        function (loadErr) { _bvmRequirePending.delete(key); throw loadErr; }
      ));
    }
    return _bvmRequirePending.get(key);
  }
  var err = new Error("[ERR_REQUIRE_ASYNC_MODULE] Cannot require '" + request + "' synchronously: unknown module '" + request + "' is not a Node builtin; dynamic require() of a non-builtin has no sync path, use import()");
  err.code = 'ERR_REQUIRE_ASYNC_MODULE';
  throw err;
}
// --- end sync builtin require interop (gap #3) ---

window._RUNTIME__UUID___ = globalThis._RUNTIME__UUID___;



// ─── Vitest/fork support patches ───
// 1. Force configurable:true on global defineProperty. All forks share one
//    globalThis, and vitest sets globals (like __vitest_index__) non-configurably
//    which crashes every re-run (watch mode). Neuter at the lowest level.
//
// maskFunction must be defined BEFORE its first use in source order: the
// template is injected as type="module-shim" and executed by es-module-shims,
// which does not hoist function declarations from later in the script to
// earlier call sites (2026-10-01: early call threw "ReferenceError:
// maskFunction is not defined", killing iframe bootstrap).
function maskFunction(patchedFn, originalFn) {
  Object.defineProperty(patchedFn, 'name', { value: originalFn.name });
  patchedFn.toString = () => originalFn.toString();
}
(function() {
  const origDefineProperty = Object.defineProperty;
  Object.defineProperty = function(obj, prop, descriptor) {
    if (obj === globalThis && descriptor && typeof descriptor === 'object') {
      descriptor = { ...descriptor, configurable: true };
    }
    return origDefineProperty.call(this, obj, prop, descriptor);
  };
  // Cloak the patch: it wraps a host builtin, so it must read as native.
  maskFunction(Object.defineProperty, origDefineProperty);
})();

// 2. process.exit semantics: in sync context throw to halt execution (like
//    real Node), in async context resolve silently. This lets forked workers
//    terminate cleanly without killing the parent realm.
(function() {
  const rt = globalThis._RUNTIME__UUID___;
  if (rt && rt.process) {
    const origExit = rt.process.exit;
    rt.process.exit = function(code) {
      code = code || 0;
      // Emit 'exit' event if listeners exist
      if (typeof rt.process.emit === 'function') {
        try { rt.process.emit('exit', code); } catch {}
      }
      // In async context (we're in a promise), resolve silently.
      // In sync context, throw to halt like real Node.
      // Heuristic: if we're inside a microtask, we're async.
      // For now, throw a special error that the runtime catches.
      const err = new Error('process.exit(' + code + ')');
      err.code = 'PROCESS_EXIT';
      err.exitCode = code;
      throw err;
    };
    // Cloak the patch: it replaces a host builtin, so it must read as native.
    Object.defineProperty(rt.process.exit, 'name', { value: 'exit' });
    rt.process.exit.toString = () => "function exit() { [native code] }";
  }
})();


if (!Array.prototype.toSorted) {
  Array.prototype.toSorted = function(compareFn) {
    // Create a shallow copy of the array and sort it in place
    const copy = [...this];
    copy.sort(compareFn);
    return copy;
  };
}
// Cloak the polyfill so it reads as native (matches the native toString
// shape on engines that already have toSorted).
// prettier-ignore
Array.prototype.toSorted.toString = () => "function toSorted() { [native code] }";
