// SANDBOX SECTION — authored source. Edit freely.
// Built into src/sandbox-template.js by src/build-sandbox.mjs
// (npm run build:sandbox). Sections are ordered fragments of one script,
// not standalone modules — see the build script header.


// Symbol-keyed runtime global. Symbol.for is shared across realms, but each
// sandbox is its own iframe/realm with its own globalThis, so the key gives
// per-sandbox isolation. Symbol keys are invisible to string-key enumeration
// (Object.keys / for-in / JSON / `in`), which is the point: casual inspection
// of globalThis must not surface runtime internals. This is NOT secrecy — the
// UUID is visible in the generated script source, so devtools can always
// reconstruct the key. Defined non-enumerable so even symbol-aware copies
// (Object.assign / spread) don't pick it up.
const _BVM_RT_KEY_ = Symbol.for('bvm.runtime.__UUID__');
const _BVM_INTEROP_KEY_ = Symbol.for('bvm.interop');

Object.defineProperty(globalThis, _BVM_RT_KEY_, {
  value: {globals: new Set(), process:"__PROCESS_JSON__", taskTracker:null, __USER_FILES__:"__USER_FILES_JSON__", __SEA_ASSETS__:"__SEA_ASSETS_JSON__"},
  writable: true,
  enumerable: false,
  configurable: true,
});

// ─── Vitest/fork support patches ───
// 1. Force configurable:true on global defineProperty. All forks share one
//    globalThis, and vitest sets globals (like __vitest_index__) non-configurably
//    which crashes every re-run (watch mode). Neuter at the lowest level.
(function() {
  const origDefineProperty = Object.defineProperty;
  Object.defineProperty = function(obj, prop, descriptor) {
    if (obj === globalThis && descriptor && typeof descriptor === 'object') {
      descriptor = { ...descriptor, configurable: true };
    }
    return origDefineProperty.call(this, obj, prop, descriptor);
  };
})();

// 2. process.exit semantics: in sync context throw to halt execution (like
//    real Node), in async context resolve silently. This lets forked workers
//    terminate cleanly without killing the parent realm.
(function() {
  const rt = globalThis[_BVM_RT_KEY_];
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

