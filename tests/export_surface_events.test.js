// Export-surface parity: src/events.js  <->  node:events
// captured from real Node v24.20.0 (node:events)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/events.js';

const EXPECTED = ["EventEmitter","EventEmitterAsyncResource","addAbortListener","captureRejectionSymbol","captureRejections","default","defaultMaxListeners","errorMonitor","getEventListeners","getMaxListeners","init","listenerCount","on","once","setMaxListeners","usingDomains"];

test('node:events export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
