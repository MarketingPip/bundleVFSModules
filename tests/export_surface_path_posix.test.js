// Export-surface parity: src/path/posix.js  <->  node:path_posix
// custom runtime module (no node:path_posix counterpart); surface below is the defined contract
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/path/posix.js';

const EXPECTED = ["_makeLong","basename","default","delimiter","dirname","extname","format","isAbsolute","join","matchesGlob","normalize","parse","posix","relative","resolve","sep","toNamespacedPath","win32"];

test('node:path_posix export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
