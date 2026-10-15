// child_process parity harness (parity/child_process-harness.mjs).
//
// The child_process shim imports ./events.js and ./stream.js, which pull
// in async_hooks → als-browser, replacing the timer globals on import and
// tripping Node's official-test global-leak detector
// ("Unexpected global(s) found: setImmediate, setInterval, ..."). Restore
// the originals snapshotted in preload.mjs: the shim keeps working (it
// captured its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/https-harness.mjs, parity/http-harness.mjs,
// parity/http2-harness.mjs, parity/stream-harness.mjs,
// parity/tty-harness.mjs, and parity/async-hooks-harness.mjs.
import * as child_process from "../src/child_process.js";

// als-browser (pulled in via events → async_hooks) replaces the timer
// globals on import. Restore the originals so Node's test/common
// global-leak detector doesn't fire.
const _origTimers = globalThis.__PARITY_ORIG_TIMERS__;
if (_origTimers) {
  for (const k of Object.keys(_origTimers)) {
    try {
      globalThis[k] = _origTimers[k];
    } catch {}
  }
}

// Re-export everything from the child_process shim.
export * from "../src/child_process.js";
export default child_process.default ?? child_process;
