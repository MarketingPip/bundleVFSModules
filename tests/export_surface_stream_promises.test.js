// Export-surface parity: src/stream/promises.js  <->  node:stream_promises
// custom runtime module (no node:stream_promises counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/stream/promises.js';

const EXPECTED = ["default","finished","pipeline"];

test('node:stream_promises export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
