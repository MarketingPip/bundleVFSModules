// Tests for src/perf_hooks.js — Node.js `perf_hooks` port.
//
// These tests exercise the pure-JS implementation (native delegation is
// disabled via `globalThis.__PERF_HOOKS_NO_NATIVE__` before import) and assert
// behavior verified against real Node v24.20.0. The official parity suite
// (parity/node-test/parallel/test-perf-hooks*) covers the native-delegation
// mode used when running under real Node.js.

// Must be set before the module is imported; use dynamic import because
// static imports are hoisted.
globalThis.__PERF_HOOKS_NO_NATIVE__ = true;

const perfHooks = (await import('../src/perf_hooks.js')).default;
const nativePerfHooks = await import('node:perf_hooks');

const {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  constants,
  createHistogram,
  eventLoopUtilization,
  monitorEventLoopDelay,
  performance,
  timerify,
} = perfHooks;

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('perf_hooks module surface', () => {
  test('exports match Node v24.20.0 (no Histogram)', () => {
    const expected = [
      'Performance',
      'PerformanceEntry',
      'PerformanceMark',
      'PerformanceMeasure',
      'PerformanceObserver',
      'PerformanceObserverEntryList',
      'PerformanceResourceTiming',
      'constants',
      'createHistogram',
      'eventLoopUtilization',
      'monitorEventLoopDelay',
      'performance',
      'timerify',
    ];
    expect(Object.keys(perfHooks).sort()).toEqual(expected.slice().sort());
    // The native namespace additionally carries a `default` key; the named
    // exports must otherwise match.
    expect(Object.keys(nativePerfHooks).filter((k) => k !== 'default').sort()).toEqual(
      expected.slice().sort(),
    );
    for (const name of expected) {
      expect(perfHooks[name]).toBeDefined();
    }
    expect(perfHooks.Histogram).toBeUndefined();
  });

  test('performance.timerify is the exported timerify', () => {
    expect(performance.timerify).toBe(timerify);
  });

  test('performance.eventLoopUtilization is the exported eventLoopUtilization', () => {
    expect(performance.eventLoopUtilization).toBe(eventLoopUtilization);
  });

  test('constants are frozen with expected values', () => {
    expect(constants.NODE_PERFORMANCE_GC_MAJOR).toBe(4);
    expect(Object.isFrozen(constants)).toBe(true);
  });

  test('Performance constructor throws', () => {
    expect(() => new Performance()).toThrow(
      expect.objectContaining({ code: 'ERR_ILLEGAL_CONSTRUCTOR' }),
    );
  });
});

describe('performance marks and measures', () => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  test('mark creates a PerformanceMark entry', () => {
    const m = performance.mark('a');
    expect(m).toBeInstanceOf(PerformanceMark);
    expect(m).toBeInstanceOf(PerformanceEntry);
    expect(m.name).toBe('a');
    expect(m.entryType).toBe('mark');
    expect(typeof m.startTime).toBe('number');
    expect(m.duration).toBe(0);
    expect(m.detail).toBeNull();
  });

  test('mark with explicit startTime', () => {
    const m = performance.mark('b', { startTime: 42 });
    expect(m.startTime).toBe(42);
  });

  test('mark rejects negative startTime', () => {
    expect(() => performance.mark('c', { startTime: -1 })).toThrow(
      expect.objectContaining({ code: 'ERR_PERFORMANCE_INVALID_TIMESTAMP' }),
    );
  });

  test('measure(name, startMark) uses now() - start', () => {
    performance.mark('s', { startTime: 10 });
    const m = performance.measure('m', 's');
    expect(m).toBeInstanceOf(PerformanceMeasure);
    expect(m.name).toBe('m');
    expect(m.entryType).toBe('measure');
    expect(m.startTime).toBe(10);
    expect(m.duration).toBeGreaterThan(0);
  });

  test('measure(name, startMark, endMark)', () => {
    performance.mark('s1', { startTime: 5 });
    performance.mark('e1', { startTime: 15 });
    const m = performance.measure('m', 's1', 'e1');
    expect(m.startTime).toBe(5);
    expect(m.duration).toBe(10);
  });

  test('measure with { start: markName } resolves the mark', () => {
    performance.mark('s2', { startTime: 7 });
    const m = performance.measure('m', { start: 's2' });
    expect(m.startTime).toBe(7);
    expect(m.duration).toBeGreaterThan(0);
  });

  test('measure with { end: number } starts at 0', () => {
    const m = performance.measure('m', { end: 100 });
    expect(m.startTime).toBe(0);
    expect(m.duration).toBe(100);
  });

  test('measure with { start, duration }', () => {
    const m = performance.measure('m', { start: 10, duration: 5 });
    expect(m.startTime).toBe(10);
    expect(m.duration).toBe(5);
  });

  test('measure with { end, duration } derives start', () => {
    const m = performance.measure('m', { end: 100, duration: 5 });
    expect(m.startTime).toBe(95);
    expect(m.duration).toBe(5);
  });

  test('measure with all three options throws', () => {
    expect(() => performance.measure('m', { start: 1, end: 2, duration: 3 })).toThrow(
      expect.objectContaining({ code: 'ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS' }),
    );
  });

  test('measure with missing mark throws DOMException SyntaxError', () => {
    let err;
    try {
      performance.measure('m', 'no-such-mark');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('SyntaxError');
    expect(err.code).toBe(12);
    expect(err.message).toBe('The "no-such-mark" performance mark has not been set');
  });

  test('measure with numeric start does not do a mark lookup', () => {
    // Verified against Node: a number is treated as start=0, not a mark name.
    const m = performance.measure('m', 123);
    expect(m.startTime).toBe(0);
    expect(m.duration).toBeGreaterThan(0);
  });

  test('clearMeasures does not clear marks', () => {
    performance.mark('keep');
    performance.measure('m1');
    performance.clearMeasures();
    expect(performance.getEntriesByType('measure')).toHaveLength(0);
    expect(performance.getEntriesByType('mark')).toHaveLength(1);
    // The mark timing is still usable for new measures.
    const m = performance.measure('m2', 'keep');
    expect(m.startTime).toBeGreaterThanOrEqual(0);
  });

  test('getEntriesByName / getEntriesByType filter', () => {
    performance.mark('x');
    performance.mark('y');
    performance.measure('x');
    expect(performance.getEntriesByName('x')).toHaveLength(2);
    expect(performance.getEntriesByType('mark')).toHaveLength(2);
    expect(performance.getEntriesByType('measure')).toHaveLength(1);
  });
});

describe('PerformanceObserver', () => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  test('delivers entries asynchronously and filters by entryTypes', async () => {
    const seen = [];
    const obs = new PerformanceObserver((list) => {
      seen.push(...list.getEntries().map((e) => e.entryType));
    });
    obs.observe({ entryTypes: ['mark'] });
    performance.mark('a');
    performance.measure('b');
    await nextTick();
    await nextTick();
    expect(seen).toEqual(['mark']);
    obs.disconnect();
  });

  test('disconnect allows re-observe', async () => {
    const seen = [];
    const obs = new PerformanceObserver((list) => {
      seen.push(list.getEntries().length);
    });
    obs.observe({ entryTypes: ['mark'] });
    obs.disconnect();
    // Must not throw; re-subscription works.
    obs.observe({ entryTypes: ['mark'] });
    performance.mark('a');
    await nextTick();
    await nextTick();
    expect(seen).toEqual([1]);
    obs.disconnect();
  });

  test('takeRecords works after disconnect', () => {
    const obs = new PerformanceObserver(() => {});
    obs.observe({ entryTypes: ['mark'] });
    obs.disconnect();
    expect(obs.takeRecords()).toEqual([]);
  });

  test('entry list supports getEntriesByType/getEntriesByName', async () => {
    let list;
    const obs = new PerformanceObserver((l) => {
      list = l;
    });
    obs.observe({ entryTypes: ['mark', 'measure'] });
    performance.mark('named');
    await nextTick();
    await nextTick();
    expect(list.getEntriesByType('mark')).toHaveLength(1);
    expect(list.getEntriesByName('named')).toHaveLength(1);
    expect(list.getEntriesByName('missing')).toHaveLength(0);
    obs.disconnect();
  });
});

describe('resource timing (pure JS)', () => {
  const timingInfo = {
    startTime: 10,
    redirectStartTime: 11,
    redirectEndTime: 12,
    postRedirectStartTime: 13,
    finalServiceWorkerStartTime: 14,
    finalNetworkRequestStartTime: 15,
    finalNetworkResponseStartTime: 16,
    endTime: 17,
    encodedBodySize: 100,
    decodedBodySize: 200,
    finalConnectionTimingInfo: {
      domainLookupStartTime: 21,
      domainLookupEndTime: 22,
      connectionStartTime: 23,
      connectionEndTime: 24,
      secureConnectionStartTime: 25,
      ALPNNegotiatedProtocol: ['h2'],
    },
  };

  beforeEach(() => {
    performance.clearResourceTimings();
  });

  test('maps timingInfo fields to getters (verified vs Node)', () => {
    const r = performance.markResourceTiming(
      timingInfo, 'http://x/', 'fetch', {}, '', {}, 200, 'cache',
    );
    expect(r).toBeInstanceOf(PerformanceResourceTiming);
    expect(r).toBeInstanceOf(PerformanceEntry);
    expect(r.name).toBe('http://x/');
    expect(r.entryType).toBe('resource');
    expect(r.startTime).toBe(10);
    expect(r.duration).toBe(7);
    expect(r.initiatorType).toBe('fetch');
    expect(r.nextHopProtocol).toEqual(['h2']);
    expect(r.workerStart).toBe(14);
    expect(r.redirectStart).toBe(11);
    expect(r.redirectEnd).toBe(12);
    expect(r.fetchStart).toBe(13);
    expect(r.domainLookupStart).toBe(21);
    expect(r.domainLookupEnd).toBe(22);
    expect(r.connectStart).toBe(23);
    expect(r.connectEnd).toBe(24);
    expect(r.secureConnectionStart).toBe(25);
    expect(r.requestStart).toBe(15);
    expect(r.responseStart).toBe(16);
    expect(r.responseEnd).toBe(17);
    expect(r.transferSize).toBe(400);
    expect(r.encodedBodySize).toBe(100);
    expect(r.decodedBodySize).toBe(200);
    expect(r.deliveryType).toBe('cache');
    expect(r.responseStatus).toBe(200);
  });

  test('toJSON key order matches Node', () => {
    const r = performance.markResourceTiming(
      timingInfo, 'http://x/', 'fetch', {}, '', {}, 200, '',
    );
    expect(Object.keys(r.toJSON())).toEqual([
      'name', 'entryType', 'startTime', 'duration', 'initiatorType',
      'nextHopProtocol', 'workerStart', 'redirectStart', 'redirectEnd',
      'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart',
      'connectEnd', 'secureConnectionStart', 'requestStart', 'responseStart',
      'responseEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize',
      'deliveryType', 'responseStatus',
    ]);
  });

  test('null finalConnectionTimingInfo yields undefined connection getters', () => {
    const r = performance.markResourceTiming(
      { ...timingInfo, finalConnectionTimingInfo: null },
      'http://x/', 'fetch', {}, '', {}, 200, '',
    );
    expect(r.domainLookupStart).toBeUndefined();
    expect(r.nextHopProtocol).toBeUndefined();
  });

  test('transferSize depends on cacheMode', () => {
    const mk = (cacheMode) =>
      performance.markResourceTiming(timingInfo, 'http://x/', 'fetch', {}, cacheMode, {}, 200, '');
    expect(mk('local').transferSize).toBe(0);
    expect(mk('validated').transferSize).toBe(300);
    expect(mk('').transferSize).toBe(400);
    performance.clearResourceTimings();
  });

  test('resource entries are buffered and retrievable', () => {
    performance.markResourceTiming(timingInfo, 'http://x/', 'fetch', {}, '', {}, 200, '');
    expect(performance.getEntriesByType('resource')).toHaveLength(1);
    performance.clearResourceTimings();
    expect(performance.getEntriesByType('resource')).toHaveLength(0);
  });
});

describe('histograms (pure JS)', () => {
  test('empty histogram matches Node', () => {
    const h = createHistogram();
    expect(h.min).toBe(9223372036854776000);
    expect(h.minBigInt).toBe(9223372036854775807n);
    expect(h.max).toBe(0);
    expect(h.maxBigInt).toBe(0n);
    expect(h.count).toBe(0);
    expect(Number.isNaN(h.mean)).toBe(true);
    expect(Number.isNaN(h.stddev)).toBe(true);
  });

  test('record values and statistics (Node-verified)', () => {
    const h = createHistogram();
    h.record(1);
    h.record(2);
    h.record(3);
    h.record(4);
    expect(h.min).toBe(1);
    expect(h.max).toBe(4);
    expect(h.mean).toBe(2.5);
    expect(h.percentile(50)).toBe(2);
    expect(h.count).toBe(4);
  });

  test('bucket quantization matches Node (figures:1)', () => {
    const h = createHistogram({ figures: 1 });
    h.record(1234);
    h.record(1239);
    expect(h.min).toBe(1216);
    expect(h.max).toBe(1279);
    expect(h.mean).toBe(1248);
  });

  test('record validation', () => {
    const h = createHistogram();
    for (const bad of [false, '', {}, undefined, null]) {
      expect(() => h.record(bad)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
      );
    }
    for (const bad of [0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => h.record(bad)).toThrow(
        expect.objectContaining({ code: 'ERR_OUT_OF_RANGE' }),
      );
    }
  });

  test('reset clears the histogram', () => {
    const h = createHistogram();
    h.record(5);
    h.reset();
    expect(h.count).toBe(0);
    expect(h.max).toBe(0);
  });

  test('percentiles map matches Node', () => {
    const h = createHistogram();
    h.record(1);
    expect(h.percentiles).toEqual(new Map([[0, 1], [100, 1]]));
    expect(h.percentilesBigInt).toEqual(new Map([[0, 1n], [100, 1n]]));
  });
});

describe('timerify (pure JS)', () => {
  test('wraps sync functions and records entries', async () => {
    const seen = [];
    const obs = new PerformanceObserver((list) => {
      seen.push(...list.getEntries());
    });
    obs.observe({ entryTypes: ['function'] });
    const add = timerify((a, b) => a + b);
    expect(add(2, 3)).toBe(5);
    await nextTick();
    await nextTick();
    expect(seen).toHaveLength(1);
    expect(seen[0].entryType).toBe('function');
    expect(typeof seen[0].duration).toBe('number');
    obs.disconnect();
  });

  test('does not mutate the original function name', () => {
    function original() {}
    timerify(original);
    expect(original.name).toBe('original');
  });

  test('validates arguments', () => {
    expect(() => timerify('nope')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
    );
  });
});

describe('browser-fallback approximations', () => {
  test('eventLoopUtilization returns zero shape without libuv', () => {
    expect(eventLoopUtilization()).toEqual({ idle: 0, active: 0, utilization: 0 });
  });

  test('nodeTiming reports loopStart/loopExit as -1 without libuv', () => {
    expect(performance.nodeTiming.loopStart).toBe(-1);
    expect(performance.nodeTiming.loopExit).toBe(-1);
  });

  test('monitorEventLoopDelay starts disabled and samples', async () => {
    const h = monitorEventLoopDelay({ resolution: 10 });
    expect(h.count).toBe(0);
    expect(h.enable()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.count).toBeGreaterThan(0);
    expect(h.disable()).toBe(true);
  });
});
