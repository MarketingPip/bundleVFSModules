// Export-surface parity: src/_http_server.js  <->  node:_http_server
// captured from real Node v24.20.0 (node:_http_server)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_http_server.js';

const EXPECTED = ["STATUS_CODES","Server","ServerResponse","_connectionListener","default","httpServerPreClose","kConnectionsCheckingInterval","kServerResponse","setupConnectionsTracking","storeHTTPOptions"];

test('node:_http_server export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
