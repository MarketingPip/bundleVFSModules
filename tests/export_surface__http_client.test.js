// Export-surface parity: src/_http_client.js  <->  node:_http_client
// captured from real Node v24.20.0 (node:_http_client)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_http_client.js';

const EXPECTED = ["ClientRequest","default"];

test('node:_http_client export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
