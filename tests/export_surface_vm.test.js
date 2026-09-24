// Export-surface parity: src/vm.js  <->  node:vm
// captured from real Node v24.20.0 (node:vm)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/vm.js';

const EXPECTED = ["Script","compileFunction","constants","createContext","createScript","default","isContext","measureMemory","runInContext","runInNewContext","runInThisContext"];

test('node:vm export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
