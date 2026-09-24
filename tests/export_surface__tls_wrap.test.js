// Export-surface parity: src/_tls_wrap.js  <->  node:_tls_wrap
// captured from real Node v24.20.0 (node:_tls_wrap)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_tls_wrap.js';

const EXPECTED = ["Server","TLSSocket","connect","createServer","default"];

test('node:_tls_wrap export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
