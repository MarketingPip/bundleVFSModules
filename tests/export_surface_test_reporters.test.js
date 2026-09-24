// Export-surface parity: src/test/reporters.js  <->  node:test_reporters
// custom runtime module (no node:test_reporters counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/test/reporters.js';

const EXPECTED = ["default","dot","junit","lcov","spec","tap"];

test('node:test_reporters export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
