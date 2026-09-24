// Export-surface parity: src/readline.js  <->  node:readline
// captured from real Node v24.20.0 (node:readline)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/readline.js';

const EXPECTED = ["Interface","clearLine","clearScreenDown","createInterface","cursorTo","default","emitKeypressEvents","moveCursor","promises"];

test('node:readline export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
