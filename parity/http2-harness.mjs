// HTTP/2 parity harness (parity/http2-harness.mjs).
//
// The http2 shim (via events → async_hooks → als-browser) replaces the
// timer globals on import, which trips Node's official-test global-leak
// detector ("Unexpected global(s) found: setImmediate, setInterval, ...").
// Restore the originals snapshotted in preload.mjs: the shim keeps working
// (it captured its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/stream-harness.mjs.
import * as http2 from "../src/http2.js";

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

// Re-export everything from the http2 shim.
export * from "../src/http2.js";
export default http2.default ?? http2;
