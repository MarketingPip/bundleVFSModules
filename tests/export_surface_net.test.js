// Export-surface parity: src/net.js  <->  node:net
// captured from real Node v24.20.0 (node:net)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/net.js';

const EXPECTED = ["BlockList","BoundSocket","Server","Socket","SocketAddress","Stream","_createServerHandle","_normalizeArgs","connect","createConnection","createServer","default","getDefaultAutoSelectFamily","getDefaultAutoSelectFamilyAttemptTimeout","isIP","isIPv4","isIPv6","setDefaultAutoSelectFamily","setDefaultAutoSelectFamilyAttemptTimeout"];

test('node:net export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
