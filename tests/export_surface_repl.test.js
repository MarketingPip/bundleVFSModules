// Export-surface parity: src/repl.js  <->  node:repl
// captured from real Node v24.20.0 (node:repl)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/repl.js';

const EXPECTED = ["REPLServer","REPL_MODE_SLOPPY","REPL_MODE_STRICT","Recoverable","default","isValidSyntax","start","writer"];

test('node:repl export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
