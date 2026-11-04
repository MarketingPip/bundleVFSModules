// Parity adapter for `require('internal/timers')` used by the official
// Node http test test-http-client-timeout-on-connect.js (the only http
// test importing it; the http2/tls/child_process kTimeout readers run
// under other targets and keep the real module).
//
// In real Node, `internal/timers` requires `--expose-internals` and its
// `kTimeout` symbol keys the socket timeout slot (null when idle, the
// timer object when armed). Product code cannot import Node internals —
// the browser build cannot resolve internal modules — so the shim's
// socket carries the slot under a Symbol.for bridge instead (see
// src/net.js). This adapter exports that same bridge key, so the test's
// `socket[kTimeout]` reads see the shim's slot. Only `kTimeout` is
// exported: it is the only member the http test uses, and no other
// http-target importer touches this module.
export const kTimeout = Symbol.for("bundleVFSModules.net.kTimeout");
