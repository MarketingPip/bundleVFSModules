// Parity adapter for `require('_http_server')` used by the official
// Node http tests test-http-server-async-dispose.js,
// test-http-server-clear-timer.js and
// test-http-server-close-destroy-timeout.js (the only http tests
// importing it; the https twins run under another target and keep the
// real module).
//
// In real Node, `_http_server` exports the `kConnectionsCheckingInterval`
// symbol keying the server's connections-checker interval slot. Product
// code cannot import Node internals — the browser build cannot resolve
// internal modules — so the shim's ServerBase carries the slot under a
// Symbol.for bridge instead (see src/http.js). This adapter exports
// that same bridge key, so the tests' `server[kConnectionsCheckingInterval]`
// reads see the shim's slot. Only `kConnectionsCheckingInterval` is
// exported: it is the only member the http tests use, and no other
// http-target importer touches this module.
export const kConnectionsCheckingInterval = Symbol.for(
  "bundleVFSModules.http.kConnectionsCheckingInterval",
);
