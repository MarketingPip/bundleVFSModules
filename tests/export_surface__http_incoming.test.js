// Export-surface parity: src/_http_incoming.js  <->  node:_http_incoming
// captured from real Node v24.20.0 (node:_http_incoming)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_http_incoming.js';

const EXPECTED = ["IncomingMessage","default","kDetachAbortSignal","readStart","readStop"];

test('node:_http_incoming export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
