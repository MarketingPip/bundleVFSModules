// Export-surface parity: src/domain.js  <->  node:domain
// captured from real Node v24.20.0 (node:domain)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/domain.js';

const EXPECTED = ["Domain","_stack","active","create","createDomain","default"];

test('node:domain export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
