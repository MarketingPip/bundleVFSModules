// Shared bridge between src/perf_hooks.js (which owns the PerformanceObserver
// registry) and src/http.js (which emits `http` performance entries).
//
// The bridge is filled by perf_hooks.js at import time and read by http.js at
// request time. It exists because the http entry points (`hasObserver` /
// `startPerf` / `stopPerf`, ports of Node's `lib/internal/perf/observe.js`)
// cannot be named ESM exports of src/perf_hooks.js: its export surface is
// pinned to real Node's by tests/export_surface_perf_hooks.test.js (exact
// equality). This follows the src/internals/http-symbols.js precedent —
// shared truth without leaking it as a named export of a public module.
//
// If perf_hooks.js is never loaded, all three stay null and http
// instrumentation is a no-op — matching Node, where http entries only exist
// when an observer is registered.
export const perfObserveBridge = {
  hasObserver: null,
  startPerf: null,
  stopPerf: null,
};
