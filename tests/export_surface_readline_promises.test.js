// Export-surface parity: src/readline/promises.js  <->  node:readline/promises
// captured from real Node v24.20.0 (node:readline/promises)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/readline/promises.js';

const EXPECTED = ["Interface","Readline","createInterface","default"];

test('node:readline/promises export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
