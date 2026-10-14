// Async-hooks parity harness (parity/async-hooks-harness.mjs).
//
// The async_hooks shim (als-browser) replaces the timer globals on import,
// which trips Node's official-test global-leak detector ("Unexpected
// global(s) found: setImmediate, setInterval, ..."). Restore the originals
// snapshotted in preload.mjs: the shim keeps working (it captured its own
// references). Harness-only; src/ is untouched.
//
// Mirrors parity/stream-harness.mjs.
import * as async_hooks from "../src/async_hooks.js";

// als-browser replaces the timer globals on import. Restore the originals
// so Node's test/common global-leak detector doesn't fire.
const _origTimers = globalThis.__PARITY_ORIG_TIMERS__;
if (_origTimers) {
  for (const k of Object.keys(_origTimers)) {
    try {
      globalThis[k] = _origTimers[k];
    } catch {}
  }
}

// Re-export everything from the async_hooks shim.
export * from "../src/async_hooks.js";
export default async_hooks.default ?? async_hooks;
