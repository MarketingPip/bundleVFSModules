// HTTPS parity harness (parity/https-harness.mjs).
//
// The https shim imports ./http.js (for the client/server base), which pulls
// in async_hooks → als-browser, replacing the timer globals on import and
// tripping Node's official-test global-leak detector
// ("Unexpected global(s) found: setImmediate, setInterval, ..."). Restore
// the originals snapshotted in preload.mjs: the shim keeps working (it
// captured its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/http-harness.mjs, parity/http2-harness.mjs,
// parity/stream-harness.mjs, parity/tty-harness.mjs, and
// parity/async-hooks-harness.mjs.
import * as https from "../src/https.js";

// als-browser (pulled in via async_hooks → events → stream → http → https)
// replaces the timer globals on import. Restore the originals so Node's
// test/common global-leak detector doesn't fire.
const _origTimers = globalThis.__PARITY_ORIG_TIMERS__;
if (_origTimers) {
  for (const k of Object.keys(_origTimers)) {
    try {
      globalThis[k] = _origTimers[k];
    } catch {}
  }
}

// Re-export everything from the https shim.
export * from "../src/https.js";
export default https.default ?? https;
