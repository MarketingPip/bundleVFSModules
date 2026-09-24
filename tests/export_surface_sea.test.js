// Export-surface parity: src/sea.js  <->  node:sea
// captured from real Node v24.20.0 (node:sea)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/sea.js';

const EXPECTED = ["default","getAsset","getAssetAsBlob","getAssetKeys","getRawAsset","isSea"];

test('node:sea export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
