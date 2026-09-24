// Export-surface parity: src/_stream_duplex.js  <->  node:_stream_duplex
// captured from real Node v24.20.0 (node:_stream_duplex)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_stream_duplex.js';

const EXPECTED = ["default","from","fromWeb","toWeb"];

test('node:_stream_duplex export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
