// Export-surface parity: src/wasi.js  <->  node:wasi
// captured from real Node v24.20.0 (node:wasi)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/wasi.js';

const EXPECTED = ["WASI","default"];

test('node:wasi export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
