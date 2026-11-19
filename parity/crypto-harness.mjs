// Crypto parity harness (parity/crypto-harness.mjs).
//
// The crypto shim imports ./stream.js (for the createMac Transform, via
// events → async_hooks → als-browser), which replaces the timer globals
// on import, tripping Node's official-test global-leak detector
// ("Unexpected global(s) found: setImmediate, setInterval, ...").
// Restore the originals snapshotted in preload.mjs: the shim keeps working
// (it captured its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/http2-harness.mjs (same chain, same restore).
import * as crypto from "../src/crypto.js";

// als-browser (pulled in via events → async_hooks → stream) replaces the
// timer globals on import. Restore the originals so Node's test/common
// global-leak detector doesn't fire.
const _origTimers = globalThis.__PARITY_ORIG_TIMERS__;
if (_origTimers) {
  for (const k of Object.keys(_origTimers)) {
    try {
      globalThis[k] = _origTimers[k];
    } catch {}
  }
}

// Re-export everything from the crypto shim.
export * from "../src/crypto.js";
export default crypto.default ?? crypto;
