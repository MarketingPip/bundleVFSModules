// Export-surface parity: src/inspector/promises.js  <->  node:inspector/promises
// captured from real Node v24.20.0 (node:inspector/promises)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/inspector/promises.js';

const EXPECTED = ["DOMStorage","Network","NetworkResources","Session","close","console","default","open","url","waitForDebugger"];

test('node:inspector/promises export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
