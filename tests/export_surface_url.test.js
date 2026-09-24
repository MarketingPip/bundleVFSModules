// Export-surface parity: src/url.js  <->  node:url
// captured from real Node v24.20.0 (node:url)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/url.js';

const EXPECTED = ["URL","URLPattern","URLSearchParams","Url","default","domainToASCII","domainToUnicode","fileURLToPath","fileURLToPathBuffer","format","parse","pathToFileURL","resolve","resolveObject","urlToHttpOptions"];

test('node:url export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
