// Export-surface parity: src/_http_outgoing.js  <->  node:_http_outgoing
// captured from real Node v24.20.0 (node:_http_outgoing)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_http_outgoing.js';

const EXPECTED = ["OutgoingMessage","default","kHighWaterMark","kUniqueHeaders","parseUniqueHeadersOption","validateHeaderName","validateHeaderValue"];

test('node:_http_outgoing export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
