// Stream parity harness (parity/stream-harness.mjs).
//
// The stream shim (via async_hooks → events → stream chain) replaces the
// timer globals on import, which trips Node's official-test global-leak
// detector ("Unexpected global(s) found: setImmediate, setInterval, ...").
// Restore the originals snapshotted in preload.mjs: the shim keeps working
// (it captured its own references). Harness-only; src/ is untouched.
//
// Mirrors the timer-restore section of parity/fs-harness.mjs.
import * as stream from "../src/stream.js";

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

// Re-export everything from the stream shim.
export * from "../src/stream.js";
export default stream.default ?? stream;
