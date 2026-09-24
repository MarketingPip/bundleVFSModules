// Export-surface parity: src/async_context.js  <->  node:async_context
// custom runtime module (no node:async_context counterpart); surface below is the defined contract
// Contract verified against the real runtime namespace (export * from als-browser + default).
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/async_context.js';

const EXPECTED = ["AsyncLocalStorage", "capture", "default", "restore"];

test('node:async_context export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
