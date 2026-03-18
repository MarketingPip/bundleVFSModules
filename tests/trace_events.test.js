import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as trace_events from '../src/trace_events.js';

describe('trace_events wrapper', () => {
  let consoleWarnSpy;

  beforeEach(() => {
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Reset global state if possible, or ensure clean slate between tests
    // Note: Since _enabledTracings is module-level, we manually disable 
    // any tracing objects we create to clear the refcounts.
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('createTracing()', () => {
    test('validates options is an object', () => {
      expect(() => trace_events.createTracing(null)).toThrow(/must be an Object/);
      expect(() => trace_events.createTracing(null)).toThrow(/ERR_INVALID_ARG_TYPE/);
    });

    test('validates categories is a string array', () => {
      expect(() => trace_events.createTracing({ categories: 'not-an-array' }))
        .toThrow(/must be an Array/);
      expect(() => trace_events.createTracing({ categories: ['valid', 123] }))
        .toThrow(/argument must be a string/);
    });

    test('throws if categories array is empty', () => {
      expect(() => trace_events.createTracing({ categories: [] }))
        .toThrow(/At least one category is required/);
      expect(() => trace_events.createTracing({ categories: [] }))
        .toThrow(/ERR_TRACE_EVENTS_CATEGORY_REQUIRED/);
    });

    test('returns a Tracing instance with correct properties', () => {
      const t = trace_events.createTracing({ categories: ['node', 'v8'] });
      expect(t.enabled).toBe(false);
      expect(t.categories).toBe('node,v8');
      t.disable(); // cleanup
    });
  });

  describe('getEnabledCategories() and Reference Counting', () => {
    test('accurately tracks union of enabled categories', () => {
      const t1 = trace_events.createTracing({ categories: ['node', 'v8'] });
      const t2 = trace_events.createTracing({ categories: ['node', 'perf'] });

      expect(trace_events.getEnabledCategories()).toBeUndefined();

      t1.enable();
      expect(trace_events.getEnabledCategories()).toBe('node,v8');

      t2.enable();
      // Union of both
      expect(trace_events.getEnabledCategories()).toContain('node');
      expect(trace_events.getEnabledCategories()).toContain('v8');
      expect(trace_events.getEnabledCategories()).toContain('perf');

      t1.disable();
      // 'node' remains because t2 still has it enabled
      expect(trace_events.getEnabledCategories()).toBe('node,perf');

      t2.disable();
      expect(trace_events.getEnabledCategories()).toBeUndefined();
    });
  });

  describe('Event Bus (onTraceEvent / emitTraceEvent)', () => {
    test('listeners receive events only when category is enabled', () => {
      const handler = jest.fn();
      const cat = 'custom.event';
      const t = trace_events.createTracing({ categories: [cat] });
      
      trace_events.onTraceEvent(cat, handler);
      
      // Should not fire (not enabled)
      trace_events.emitTraceEvent({ cat, name: 'test' });
      expect(handler).not.toHaveBeenCalled();

      t.enable();
      trace_events.emitTraceEvent({ cat, name: 'test', ph: 'i' });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ name: 'test' }));

      t.disable();
      trace_events.offTraceEvent(cat, handler);
    });

    test('isolates listener errors', () => {
      const cat = 'error.cat';
      const t = trace_events.createTracing({ categories: [cat] });
      const badHandler = () => { throw new Error('Boom'); };
      const goodHandler = jest.fn();

      trace_events.onTraceEvent(cat, badHandler);
      trace_events.onTraceEvent(cat, goodHandler);
      
      t.enable();
      expect(() => trace_events.emitTraceEvent({ cat, name: 'test' })).not.toThrow();
      expect(goodHandler).toHaveBeenCalled();
      
      t.disable();
    });
  });

  describe('PerformanceObserver Bridge', () => {
    test('activates PerformanceObserver when perf categories enabled', () => {
      // Mock global PerformanceObserver
      const mockObserve = jest.fn();
      const mockDisconnect = jest.fn();
      
      global.PerformanceObserver = jest.fn().mockImplementation(() => ({
        observe: mockObserve,
        disconnect: mockDisconnect,
      }));

      const perf = trace_events.createTracing({ categories: ['node.perf'] });
      
      perf.enable();
      expect(global.PerformanceObserver).toHaveBeenCalled();
      expect(mockObserve).toHaveBeenCalledWith({ entryTypes: ['mark', 'measure', 'function'] });

      perf.disable();
      expect(mockDisconnect).toHaveBeenCalled();
      
      delete global.PerformanceObserver;
    });
  });

  describe('Memory Leak Warning', () => {
    test('warns when more than 10 Tracing objects are enabled', async () => {
      const pool = [];
      for (let i = 0; i < 11; i++) {
        pool.push(trace_events.createTracing({ categories: [`cat${i}`] }));
      }

      pool.forEach(t => t.enable());

      // The warning is emitted via queueMicrotask
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Possible trace_events memory leak detected')
      );

      // Cleanup
      pool.forEach(t => t.disable());
    });
  });

  describe('util.inspect support', () => {
    test('returns correct string representation via custom symbol', () => {
      const t = trace_events.createTracing({ categories: ['v8'] });
      const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');
      const inspectFn = t[inspectSymbol];
      
      expect(typeof inspectFn).toBe('function');
      expect(inspectFn(1)).toBe("Tracing { enabled: false, categories: 'v8' }");
      
      t.enable();
      expect(inspectFn(1)).toBe("Tracing { enabled: true, categories: 'v8' }");
      
      t.disable();
    });
  });
});
