// Export-surface parity: src/https.js  <->  node:https
// captured from real Node v24.20.0 (node:https)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/https.js';

const EXPECTED = ["Agent","Server","createServer","default","get","globalAgent","request"];

test('node:https export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
