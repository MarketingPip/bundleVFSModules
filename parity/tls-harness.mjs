// TLS parity harness (parity/tls-harness.mjs).
//
// The tls shim imports ./events.js (for TLSSocket/Server), which pulls in
// async_hooks → als-browser, replacing the timer globals on import and
// tripping Node's official-test global-leak detector
// ("Unexpected global(s) found: setImmediate, setInterval, ..."). Restore
// the originals snapshotted in preload.mjs: the shim keeps working (it
// captured its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/net-harness.mjs, parity/http-harness.mjs, and
// parity/https-harness.mjs.
import * as tls from "../src/tls.js";

// als-browser (pulled in via async_hooks → events → tls) replaces
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

// Re-export everything from the tls shim.
export * from "../src/tls.js";
export default tls.default ?? tls;
