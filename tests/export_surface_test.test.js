// Export-surface parity: src/test.js  <->  node:test
// captured from real Node v24.20.0 (node:test)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/test.js';

const EXPECTED = ["after","afterEach","assert","before","beforeEach","default","describe","expectFailure","getTestContext","it","mock","only","run","skip","snapshot","suite","test","todo"];

test('node:test export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
