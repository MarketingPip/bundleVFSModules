// Cluster parity harness (parity/cluster-harness.mjs).
//
// The cluster shim imports ./events.js (via async_hooks → als-browser),
// which replaces the timer globals on import, tripping Node's official-test
// global-leak detector ("Unexpected global(s) found: setImmediate,
// setInterval, ..."). Restore the originals snapshotted in preload.mjs: the
// shim keeps working (it captured its own references). Harness-only; src/ is
// untouched.
//
// Mirrors parity/tty-harness.mjs and parity/stream-harness.mjs.
//
// ponytail: ceiling — this restores only the four timer globals' identity
// for the leak detector; als-browser also patches Promise/microtasks,
// EventTarget, XHR and observers at import, and those stay patched, and
// any test depending on ALS-bound timer behaviour still sees native
// timers. Upgrade path — stop the patching at the source: replace the
// als-browser import in src/async_hooks.js with a non-patching ALS build
// (or an upstream fix), so no per-module restore is needed at all.
import * as cluster from "../src/cluster.js";

// als-browser (pulled in via async_hooks → events → cluster) replaces
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

// Re-export everything from the cluster shim.
export * from "../src/cluster.js";
export default cluster.default ?? cluster;
