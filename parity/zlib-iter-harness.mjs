// zlib/iter parity harness (parity/zlib-iter-harness.mjs).
//
// The zlib/iter shim (via src/stream/iter/transform.js → classic →
// readable → async_hooks → events) replaces the timer globals on import,
// which trips Node's official-test global-leak detector. Restore the
// originals snapshotted in preload.mjs: the shim keeps working (it
// captured its own references). Harness-only; src/ is untouched.
// Mirrors parity/stream-harness.mjs.
import * as zlibIter from "../src/zlib-iter.js";

// als-browser (pulled in via async_hooks → events → stream) replaces
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

// Re-export everything from the zlib/iter shim.
export * from "../src/zlib-iter.js";
export default zlibIter;
