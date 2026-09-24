// Export-surface parity: src/trace_events.js  <->  node:trace
// custom runtime module (no node:trace counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/trace_events.js';

const EXPECTED = ["createTracing","default","getEnabledCategories"];

test('node:trace export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
