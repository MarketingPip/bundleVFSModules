// Export-surface parity: src/worker_threads.js  <->  node:worker_threads
// captured from real Node v24.20.0 (node:worker_threads)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/worker_threads.js';

const EXPECTED = ["BroadcastChannel","MessageChannel","MessagePort","SHARE_ENV","Worker","default","getEnvironmentData","isInternalThread","isMainThread","isMarkedAsUntransferable","locks","markAsUncloneable","markAsUntransferable","moveMessagePortToContext","parentPort","postMessageToThread","receiveMessageOnPort","resourceLimits","setEnvironmentData","threadId","threadName","workerData"];

test('node:worker_threads export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
