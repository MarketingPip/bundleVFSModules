// Export-surface parity: src/string_decoder.js  <->  node:string_decoder
// captured from real Node v24.20.0 (node:string_decoder)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/string_decoder.js';

const EXPECTED = ["StringDecoder","default"];

test('node:string_decoder export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
