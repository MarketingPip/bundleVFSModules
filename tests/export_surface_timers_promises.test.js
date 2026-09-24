// Export-surface parity: src/timers/promises.js  <->  node:timers/promises
// captured from real Node v24.20.0 (node:timers/promises)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/timers/promises.js';

const EXPECTED = ["default","scheduler","setImmediate","setInterval","setTimeout"];

test('node:timers/promises export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
