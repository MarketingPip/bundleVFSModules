// Stream/iter parity harness (parity/stream-iter-harness.mjs).
//
// The stream/iter shim (via classic → readable → async_hooks → events)
// replaces the timer globals on import, which trips Node's official-test
// global-leak detector ("Unexpected global(s) found: setImmediate,
// setInterval, ..."). Restore the originals snapshotted in preload.mjs:
// the shim keeps working (it captured its own references). Harness-only;
// src/ is untouched. Mirrors parity/stream-harness.mjs — the plain
// `stream` harness does NOT cover `stream/iter`, which loads
// src/stream/iter.js directly (generic candidate in polyfillPath).
import * as iter from "../src/stream/iter.js";

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

// Re-export everything from the stream/iter shim.
export * from "../src/stream/iter.js";
export default iter;
