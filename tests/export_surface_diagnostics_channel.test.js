// Export-surface parity: src/diagnostics_channel.js  <->  node:diagnostics_channel
// captured from real Node v24.20.0 (node:diagnostics_channel)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/diagnostics_channel.js';

const EXPECTED = ["Channel","channel","default","hasSubscribers","subscribe","tracingChannel","unsubscribe"];

test('node:diagnostics_channel export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
