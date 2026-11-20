// Events parity harness (parity/events-harness.mjs).
//
// The events shim (via async_hooks → als-browser) replaces the timer globals
// on import, which trips Node's official-test global-leak detector
// ("Unexpected global(s) found: setImmediate, setInterval, ..."). Restore the
// originals snapshotted in preload.mjs: the shim keeps working (it captured
// its own references). Harness-only; src/ is untouched.
//
// Mirrors parity/stream-harness.mjs.
import * as events from "../src/events.js";

// als-browser (pulled in via async_hooks → events) replaces the timer
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

// Re-export everything from the events shim.
export * from "../src/events.js";
export default events.default ?? events;
