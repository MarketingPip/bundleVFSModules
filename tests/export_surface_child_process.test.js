// Export-surface parity: src/child_process.js  <->  node:child_process
// captured from real Node v24.20.0 (node:child_process)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/child_process.js';

const EXPECTED = ["ChildProcess","_forkChild","default","exec","execFile","execFileSync","execSync","fork","spawn","spawnSync"];

test('node:child_process export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
