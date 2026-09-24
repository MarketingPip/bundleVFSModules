// Export-surface parity: src/punycode.js  <->  node:punycode
// captured from real Node v24.20.0 (node:punycode)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/punycode.js';

const EXPECTED = ["decode","default","encode","toASCII","toUnicode","ucs2","version"];

test('node:punycode export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
