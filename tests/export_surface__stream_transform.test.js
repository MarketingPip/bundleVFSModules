// Export-surface parity: src/_stream_transform.js  <->  node:_stream_transform
// captured from real Node v24.20.0 (node:_stream_transform)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_stream_transform.js';

const EXPECTED = ["default"];

test('node:_stream_transform export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
