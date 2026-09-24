// Export-surface parity: src/dgram.js  <->  node:dgram
// captured from real Node v24.20.0 (node:dgram)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/dgram.js';

const EXPECTED = ["Socket","_createSocketHandle","createSocket","default"];

test('node:dgram export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
