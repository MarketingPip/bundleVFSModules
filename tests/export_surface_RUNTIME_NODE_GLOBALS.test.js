// Export-surface parity: src/node_globals.js  <->  node:RUNTIME_NODE_GLOBALS
// custom runtime module (no node:RUNTIME_NODE_GLOBALS counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/node_globals.js';

const EXPECTED = [];

test('node:RUNTIME_NODE_GLOBALS export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
