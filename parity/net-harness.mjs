// Net parity harness (parity/net-harness.mjs).
//
// The net shim imports ./stream.js (for Socket via Duplex), which pulls in
// async_hooks → als-browser, replacing the timer globals on import and
// tripping Node's official-test global-leak detector
// ("Unexpected global(s) found: setImmediate, setInterval, ..."). Restore
// the originals snapshotted in preload.mjs: the shim keeps working (it
// captured its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/http-harness.mjs, parity/stream-harness.mjs, and
// parity/tty-harness.mjs.
import * as net from "../src/net.js";

// als-browser (pulled in via async_hooks → events → stream → net) replaces
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

// Re-export everything from the net shim.
export * from "../src/net.js";
export default net.default ?? net;
