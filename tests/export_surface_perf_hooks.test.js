// Export-surface parity: src/perf_hooks.js  <->  node:perf_hooks
// captured from real Node v24.20.0 (node:perf_hooks)
// Regenerate: node ~/workspace/bvm-export-helpers/gen_export_surface_tests.mjs
import * as shim from '../src/perf_hooks.js';

const EXPECTED = ["Performance","PerformanceEntry","PerformanceMark","PerformanceMeasure","PerformanceObserver","PerformanceObserverEntryList","PerformanceResourceTiming","constants","createHistogram","default","eventLoopUtilization","monitorEventLoopDelay","performance","timerify"];

test('node:perf_hooks export surface matches the defined contract', () => {
  const actual = Object.keys(shim).sort();
  const missing = EXPECTED.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !EXPECTED.includes(k));
  expect({ missing, extra }).toEqual({ missing: [], extra: [] });
});
