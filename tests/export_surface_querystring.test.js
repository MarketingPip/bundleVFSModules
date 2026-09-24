// Export-surface parity: src/querystring.js  <->  node:querystring
// captured from real Node v24.20.0 (node:querystring)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/querystring.js';

const EXPECTED = ["decode","default","encode","escape","parse","stringify","unescape","unescapeBuffer"];

test('node:querystring export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
