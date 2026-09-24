// Export-surface parity: src/timers.js  <->  node:timers
// captured from real Node v24.20.0 (node:timers)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/timers.js';

const EXPECTED = ["clearImmediate","clearInterval","clearTimeout","default","promises","setImmediate","setInterval","setTimeout"];

test('node:timers export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
