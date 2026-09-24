// Export-surface parity: src/_stream_wrap.js  <->  node:_stream_wrap
// captured from real Node v24.20.0 (node:_stream_wrap)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/_stream_wrap.js';

const EXPECTED = ["default"];

test('node:_stream_wrap export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
