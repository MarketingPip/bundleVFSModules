// Export-surface parity: src/assert/strict.js  <->  node:assert_strict
// custom runtime module (no node:assert_strict counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/assert/strict.js';

const EXPECTED = ["Assert","AssertionError","CallTracker","deepEqual","deepStrictEqual","default","doesNotMatch","doesNotReject","doesNotThrow","equal","fail","ifError","match","notDeepEqual","notDeepStrictEqual","notEqual","notStrictEqual","ok","partialDeepStrictEqual","rejects","strict","strictEqual","throws"];

test('node:assert_strict export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
