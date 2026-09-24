// Export-surface parity: src/cluster.js  <->  node:cluster
// captured from real Node v24.20.0 (node:cluster)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/cluster.js';

const EXPECTED = ["SCHED_NONE","SCHED_RR","Worker","_events","_eventsCount","_maxListeners","default","disconnect","fork","isMaster","isPrimary","isWorker","schedulingPolicy","settings","setupMaster","setupPrimary","workers"];

test('node:cluster export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
