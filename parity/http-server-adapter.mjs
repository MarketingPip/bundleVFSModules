// Parity adapter for `require('_http_server')` used by the official
// Node http tests test-http-server-async-dispose.js,
// test-http-server-clear-timer.js and
// test-http-server-close-destroy-timeout.js, and the https twins
// test-https-server-async-dispose.js and
// test-https-server-close-destroy-timeout.js (the only http/https tests
// importing it). The shim https Server extends http's ServerBase, so it
// carries the identical slot (Node lib/https.js:79 shares
// setupConnectionsTracking); the preload redirects both targets here.
//
// In real Node, `_http_server` exports the `kConnectionsCheckingInterval`
// symbol keying the server's connections-checker interval slot. Product
// code cannot import Node internals — the browser build cannot resolve
// internal modules — so the shim's ServerBase carries the slot under a
// Symbol.for bridge instead (see src/http.js). This adapter exports
// that same bridge key, so the tests' `server[kConnectionsCheckingInterval]`
// reads see the shim's slot. Only `kConnectionsCheckingInterval` is
// exported: it is the only member the http/https tests use, and no other
// http- or https-target importer touches this module.
export const kConnectionsCheckingInterval = Symbol.for(
  "bundleVFSModules.http.kConnectionsCheckingInterval",
);
