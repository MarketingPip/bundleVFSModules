// TTY parity harness (parity/tty-harness.mjs).
//
// The tty shim imports ./stream.js (via async_hooks → events → stream),
// which replaces the timer globals on import, tripping Node's official-test
// global-leak detector ("Unexpected global(s) found: setImmediate,
// setInterval, ..."). Restore the originals snapshotted in preload.mjs: the
// shim keeps working (it captured its own references). Harness-only; src/ is
// untouched.
//
// Mirrors parity/stream-harness.mjs and parity/async-hooks-harness.mjs.
import * as tty from "../src/tty.js";

// als-browser (pulled in via async_hooks → events → stream → tty) replaces
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

// Re-export everything from the tty shim.
export * from "../src/tty.js";
export default tty.default ?? tty;
