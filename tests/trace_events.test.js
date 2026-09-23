import { jest, describe, test, expect, afterEach } from '@jest/globals';
import * as trace_events from '../src/trace_events.js';

// Every Tracing created in a test is disabled afterwards so the
// module-level registry never leaks state between tests.
const live = [];
function make(options) {
  const t = trace_events.createTracing(options);
  live.push(t);
  return t;
}
afterEach(() => {
  while (live.length) {
    try { live.pop().disable(); } catch { /* ignore */ }
  }
  jest.restoreAllMocks();
});

describe('trace_events stub', () => {
  describe('export surface (matches node:trace_events)', () => {
    test('exports exactly createTracing and getEnabledCategories', () => {
      expect(typeof trace_events.createTracing).toBe('function');
      expect(typeof trace_events.getEnabledCategories).toBe('function');
      const keys = Object.keys(trace_events).filter((k) => k !== 'default');
      expect(keys.sort()).toEqual(['createTracing', 'getEnabledCategories']);
    });

    test('default export carries the same two functions', () => {
      expect(trace_events.default.createTracing).toBe(trace_events.createTracing);
      expect(trace_events.default.getEnabledCategories)
        .toBe(trace_events.getEnabledCategories);
    });
  });

  describe('createTracing() argument validation', () => {
    test.each([
      [undefined], [null], [1], ['str'], [true], [['node']], [() => {}],
    ])('rejects non-object options: %p', (options) => {
      expect(() => trace_events.createTracing(options)).toThrow(TypeError);
      expect(() => trace_events.createTracing(options)).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
      );
    });

    test('exact message for null options', () => {
      expect(() => trace_events.createTracing(null)).toThrow(
        'The "options" argument must be of type object. Received null',
      );
    });

    test('exact message for array options', () => {
      expect(() => trace_events.createTracing(['node'])).toThrow(
        'The "options" argument must be of type object. Received an instance of Array',
      );
    });

    test.each([
      [undefined], ['not-an-array'], [42], [true],
    ])('rejects non-array categories: %p', (categories) => {
      expect(() => trace_events.createTracing({ categories })).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),
      );
    });

    test('exact message for missing categories', () => {
      expect(() => trace_events.createTracing({})).toThrow(
        'The "options.categories" property must be an instance of Array. Received undefined',
      );
    });

    test('rejects non-string category entries without coercing', () => {
      for (const bad of [[42], [null], [undefined], [{}]]) {
        expect(() => trace_events.createTracing({ categories: bad })).toThrow(
          expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' }),
        );
      }
      expect(() => trace_events.createTracing({ categories: [42] })).toThrow(
        'The "options.categories[0]" property must be of type string. Received type number (42)',
      );
    });

    test('rejects an empty categories array with TypeError', () => {
      expect(() => trace_events.createTracing({ categories: [] })).toThrow(TypeError);
      expect(() => trace_events.createTracing({ categories: [] })).toThrow(
        expect.objectContaining({ code: 'ERR_TRACE_EVENTS_CATEGORY_REQUIRED' }),
      );
      expect(() => trace_events.createTracing({ categories: [] })).toThrow(
        'At least one category is required',
      );
    });
  });

  describe('Tracing object shape', () => {
    test('starts disabled with comma-joined categories', () => {
      const t = make({ categories: ['node', 'v8'] });
      expect(t.enabled).toBe(false);
      expect(t.categories).toBe('node,v8');
    });

    test('exposes enable/disable on the prototype', () => {
      const t = make({ categories: ['node'] });
      const proto = Object.getPrototypeOf(t);
      expect(typeof proto.enable).toBe('function');
      expect(typeof proto.disable).toBe('function');
      expect(typeof Object.getOwnPropertyDescriptor(proto, 'enabled').get).toBe('function');
      expect(typeof Object.getOwnPropertyDescriptor(proto, 'categories').get).toBe('function');
    });

    test('copies the categories array (later mutation is not reflected)', () => {
      const cats = ['node'];
      const t = make({ categories: cats });
      cats.push('v8');
      expect(t.categories).toBe('node');
    });
  });

  describe('enable()/disable() and getEnabledCategories()', () => {
    test('returns undefined when nothing is enabled', () => {
      expect(trace_events.getEnabledCategories()).toBeUndefined();
    });

    test('enable() activates categories; disable() deactivates them', () => {
      const t = make({ categories: ['node.perf'] });
      t.enable();
      expect(t.enabled).toBe(true);
      expect(trace_events.getEnabledCategories()).toBe('node.perf');
      t.disable();
      expect(t.enabled).toBe(false);
      expect(trace_events.getEnabledCategories()).toBeUndefined();
    });

    test('enable()/disable() are idempotent', () => {
      const t = make({ categories: ['node'] });
      t.enable();
      t.enable();
      expect(trace_events.getEnabledCategories()).toBe('node');
      t.disable();
      t.disable();
      expect(trace_events.getEnabledCategories()).toBeUndefined();
    });

    test('reports the union of categories across tracings', () => {
      const t1 = make({ categories: ['node', 'v8'] });
      const t2 = make({ categories: ['node.perf', 'node'] });
      t1.enable();
      t2.enable();
      const enabled = trace_events.getEnabledCategories();
      expect(enabled).toContain('node');
      expect(enabled).toContain('v8');
      expect(enabled).toContain('node.perf');
    });

    test('a category survives while any enabled Tracing still holds it', () => {
      const t1 = make({ categories: ['node'] });
      const t2 = make({ categories: ['node'] });
      t1.enable();
      t2.enable();
      t1.disable();
      expect(trace_events.getEnabledCategories()).toBe('node');
      t2.disable();
      expect(trace_events.getEnabledCategories()).toBeUndefined();
    });

    test('enabled Tracing objects survive garbage collection', async () => {
      // The registry holds enabled Tracings; disabling is explicit only.
      {
        const t = make({ categories: ['gc.probe'] });
        t.enable();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(trace_events.getEnabledCategories()).toContain('gc.probe');
    });
  });

  describe('memory-leak warning', () => {
    test('emits a warning past 10 enabled Tracing objects', () => {
      const spy = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
      const pool = [];
      for (let i = 0; i < 11; i++) {
        const t = make({ categories: [`cat${i}`] });
        pool.push(t);
        t.enable();
      }
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain(
        'Possible trace_events memory leak detected. There are more than 10 enabled Tracing objects.',
      );
    });

    test('no warning at exactly 10 enabled Tracing objects', () => {
      const spy = jest.spyOn(process, 'emitWarning').mockImplementation(() => {});
      for (let i = 0; i < 10; i++) make({ categories: [`quiet${i}`] }).enable();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('util.inspect support', () => {
    test('renders like Node: Tracing { enabled: …, categories: \'…\' }', () => {
      const t = make({ categories: ['v8'] });
      const custom = t[Symbol.for('nodejs.util.inspect.custom')];
      expect(typeof custom).toBe('function');
      expect(custom()).toBe("Tracing { enabled: false, categories: 'v8' }");
      t.enable();
      expect(custom()).toBe("Tracing { enabled: true, categories: 'v8' }");
    });
  });
});
