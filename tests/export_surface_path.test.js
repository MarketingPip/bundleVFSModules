// Export-surface parity: src/path.js  <->  node:path
// captured from real Node v24.20.0 (node:path)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/path.js';

const EXPECTED = ["_makeLong","basename","default","delimiter","dirname","extname","format","isAbsolute","join","matchesGlob","normalize","parse","posix","relative","resolve","sep","toNamespacedPath","win32"];

test('node:path export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
