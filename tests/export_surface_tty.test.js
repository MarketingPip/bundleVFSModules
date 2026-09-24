// Export-surface parity: src/tty.js  <->  node:tty
// captured from real Node v24.20.0 (node:tty)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/tty.js';

const EXPECTED = ["ReadStream","WriteStream","default","isatty"];

test('node:tty export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
