// Export-surface parity: src/async_hooks.js  <->  node:async_hooks
// captured from real Node v24.20.0 (node:async_hooks)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/async_hooks.js';

const EXPECTED = ["AsyncLocalStorage","AsyncResource","asyncWrapProviders","createHook","default","executionAsyncId","executionAsyncResource","triggerAsyncId"];

test('node:async_hooks export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
