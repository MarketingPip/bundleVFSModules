// Export-surface parity: src/stream/consumers.js  <->  node:stream_consumers
// custom runtime module (no node:stream_consumers counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/stream/consumers.js';

const EXPECTED = ["arrayBuffer","blob","buffer","bytes","default","json","text"];

test('node:stream_consumers export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
