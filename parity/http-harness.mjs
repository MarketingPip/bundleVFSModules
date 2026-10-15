// HTTP parity harness (parity/http-harness.mjs).
//
// The http shim imports ./stream.js (for OutgoingMessage/IncomingMessage),
// which pulls in async_hooks → als-browser, replacing the timer globals on
// import and tripping Node's official-test global-leak detector
// ("Unexpected global(s) found: setImmediate, setInterval, ..."). Restore
// the originals snapshotted in preload.mjs: the shim keeps working (it
// captured its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/stream-harness.mjs, parity/tty-harness.mjs, and
// parity/async-hooks-harness.mjs.
import * as http from "../src/http.js";

// als-browser (pulled in via async_hooks → events → stream → http) replaces
// the timer globals on import. Restore the originals so Node's
// test/common global-leak detector doesn't fire.
const _origTimers = globalThis.__PARITY_ORIG_TIMERS__;
if (_origTimers) {
  for (const k of Object.keys(_origTimers)) {
    try {
      globalThis[k] = _origTimers[k];
    } catch {}
  }
}

// Re-export everything from the http shim.
export * from "../src/http.js";
export default http.default ?? http;
