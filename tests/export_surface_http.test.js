// Export-surface parity: src/http.js  <->  node:http
// captured from real Node v24.20.0 (node:http)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/http.js';

const EXPECTED = ["Agent","ClientRequest","CloseEvent","IncomingMessage","METHODS","MessageEvent","OutgoingMessage","STATUS_CODES","Server","ServerResponse","WebSocket","_connectionListener","createServer","default","get","globalAgent","maxHeaderSize","request","setGlobalProxyFromEnv","setMaxIdleHTTPParsers","validateHeaderName","validateHeaderValue"];

test('node:http export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
