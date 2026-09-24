// Export-surface parity: src/v8.js  <->  node:v8
// captured from real Node v24.20.0 (node:v8)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/v8.js';

const EXPECTED = ["DefaultDeserializer","DefaultSerializer","Deserializer","GCProfiler","Serializer","cachedDataVersionTag","default","deserialize","getCppHeapStatistics","getHeapCodeStatistics","getHeapSnapshot","getHeapSpaceStatistics","getHeapStatistics","isStringOneByteRepresentation","promiseHooks","queryObjects","serialize","setFlagsFromString","setHeapSnapshotNearHeapLimit","startCpuProfile","startupSnapshot","stopCoverage","takeCoverage","writeHeapSnapshot"];

test('node:v8 export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
