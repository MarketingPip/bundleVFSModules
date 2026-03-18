import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import perfHooks from '../src/perf_hooks.js';

describe('perf_hooks Browser Shim', () => {
  
  describe('performance object', () => {
    test('delegates to globalThis.performance if available', () => {
      expect(perfHooks.performance.now).toBeDefined();
      expect(typeof perfHooks.performance.now()).toBe('number');
    });

    test('provides necessary performance methods', () => {
      const p = perfHooks.performance;
      expect(typeof p.mark).toBe('function');
      expect(typeof p.measure).toBe('function');
      expect(Array.isArray(p.getEntries())).toBe(true);
    });
  });

  

  describe('PerformanceObserver', () => {
    test('instantiates and accepts a callback', () => {
      const cb = jest.fn();
      const observer = new perfHooks.PerformanceObserver(cb);
      
      expect(observer.callback).toBe(cb);
      expect(perfHooks.PerformanceObserver.supportedEntryTypes).toContain('mark');
    });

    test('observe() updates internal entryTypes', () => {
      const observer = new perfHooks.PerformanceObserver(() => {});
      observer.observe({ entryTypes: ['mark', 'measure'] });
      
      expect(observer.entryTypes).toEqual(['mark', 'measure']);
      
      observer.disconnect();
      expect(observer.entryTypes).toEqual([]);
    });
  });

  describe('Histogram & Event Loop Monitoring', () => {
    test('createHistogram returns a valid Histogram stub', () => {
      const histogram = perfHooks.createHistogram();
      
      expect(histogram.min).toBe(0);
      expect(histogram.mean).toBe(0);
      expect(typeof histogram.percentile).toBe('function');
      expect(histogram.percentile(99)).toBe(0);
    });

    test('monitorEventLoopDelay returns a histogram instance', () => {
      const monitor = perfHooks.monitorEventLoopDelay({ resolution: 10 });
      expect(monitor).toBeInstanceOf(perfHooks.Histogram);
    });

    

    test('histogram reset clears all values', () => {
      const h = perfHooks.createHistogram();
      h.min = 10;
      h.percentiles.set(50, 5);
      
      h.reset();
      
      expect(h.min).toBe(0);
      expect(h.percentiles.size).toBe(0);
    });
  });
});
