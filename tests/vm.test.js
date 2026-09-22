// No imports needed for describe/test/expect in Jest
import vm from '../src/vm.js';
import nodeVm from 'node:vm';

describe('vm shim', () => {
  // -----------------------------------------------------------------------
  // Synchronous semantics (Node returns values directly, not thenables)
  // -----------------------------------------------------------------------
  describe('synchronous return values', () => {
    test('runInNewContext returns the completion value directly', () => {
      const result = vm.runInNewContext('a + 5', { a: 100 });
      expect(result).toBe(105);
      expect(result).not.toBeInstanceOf(Promise);
    });

    test('runInContext returns the completion value directly', () => {
      const ctx = vm.createContext({});
      expect(vm.runInContext('1 + 2', ctx)).toBe(3);
    });

    test('runInThisContext returns the completion value directly', () => {
      expect(vm.runInThisContext('2 * 3')).toBe(6);
    });

    test('Script methods return values directly', () => {
      const s = new vm.Script('40 + 2');
      expect(s.runInNewContext({})).toBe(42);
      expect(s.runInNewContext()).toBe(42);
      expect(s.runInThisContext()).toBe(42);
      const ctx = vm.createContext({});
      expect(s.runInContext(ctx)).toBe(42);
    });

    test('errors are thrown synchronously', () => {
      expect(() => vm.runInNewContext('throw new Error("boom")')).toThrow('boom');
      expect(() => vm.runInThisContext('throw new Error("boom")')).toThrow('boom');
    });
  });

  // -----------------------------------------------------------------------
  // Contexts
  // -----------------------------------------------------------------------
  describe('createContext / isContext', () => {
    test('createContext returns the same object and is idempotent', () => {
      const obj = { a: 1 };
      const ctx = vm.createContext(obj);
      expect(ctx).toBe(obj);
      expect(vm.createContext(ctx)).toBe(ctx);
      expect(vm.isContext(ctx)).toBe(true);
    });

    test('isContext is false for plain objects', () => {
      expect(vm.isContext({})).toBe(false);
      expect(vm.isContext([])).toBe(false);
    });

    test('isContext throws for non-objects', () => {
      expect(() => vm.isContext(null)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.isContext(123)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    });

    test('createContext validates its arguments', () => {
      expect(() => vm.createContext(null)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.createContext(123)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.createContext({}, { microtaskMode: 'bogus' }))
        .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }));
    });

    test('DONT_CONTEXTIFY creates a fresh context', () => {
      const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY);
      expect(vm.isContext(ctx)).toBe(true);
    });

    test('runInContext requires a contextified object', () => {
      expect(() => vm.runInContext('1', {})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.runInContext('1', null)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    });
  });

  // -----------------------------------------------------------------------
  // Declaration and assignment semantics
  // -----------------------------------------------------------------------
  describe('sandbox global semantics', () => {
    test('bare assignments land on the context object', () => {
      const ctx = vm.createContext({ a: 1 });
      vm.runInContext('b = a + 1', ctx);
      expect(ctx.b).toBe(2);
    });

    test('var declarations land on the context object', () => {
      const ctx = vm.createContext({});
      vm.runInContext('var c = 42;', ctx);
      expect(ctx.c).toBe(42);
    });

    test('function declarations land on the context and keep identity', () => {
      const ctx = vm.createContext({});
      const res = vm.runInContext('function b(){}; b;', ctx);
      expect(typeof ctx.b).toBe('function');
      expect(res).toBe(ctx.b);
    });

    test('let/const do not leak onto the context', () => {
      const ctx = vm.createContext({});
      vm.runInContext('let a = 1; const c = 2;', ctx);
      expect('a' in ctx).toBe(false);
      expect('c' in ctx).toBe(false);
    });

    test('reads of undeclared names throw ReferenceError', () => {
      expect(() => vm.runInNewContext('aBcDe')).toThrow(ReferenceError);
      expect(() => vm.runInNewContext('aBcDe')).toThrow('aBcDe is not defined');
    });

    test('delete on var-declared names is false (non-configurable)', () => {
      expect(vm.runInNewContext('var c = 1; delete c')).toBe(false);
    });

    test('this and globalThis at the top level are the context object', () => {
      const ctx = {};
      vm.runInNewContext('this.foo = 7;', ctx);
      expect(ctx.foo).toBe(7);
      const ctx2 = {};
      vm.runInNewContext('globalThis.bar = 8;', ctx2);
      expect(ctx2.bar).toBe(8);
    });

    test('host globals are not visible or polluted', () => {
      globalThis.__vmTestMarker = 'host';
      try {
        // Host globals are blocked: reads see undefined (not the host value),
        // and `typeof` yields 'undefined' like Node.
        expect(vm.runInNewContext('__vmTestMarker')).toBe(undefined);
        expect(vm.runInNewContext('typeof __vmTestMarker')).toBe('undefined');
        // Writes are sandboxed onto the context object.
        const ctx = {};
        vm.runInNewContext('__vmTestMarker = "sandbox"', ctx);
        expect(ctx.__vmTestMarker).toBe('sandbox');
        expect(globalThis.__vmTestMarker).toBe('host');
      } finally {
        delete globalThis.__vmTestMarker;
      }
    });

    test('standard globals are available', () => {
      expect(vm.runInNewContext('typeof Object')).toBe('function');
      expect(vm.runInNewContext('typeof Promise')).toBe('function');
      expect(vm.runInNewContext('Math.max(1, 2)')).toBe(2);
      expect(vm.runInNewContext('JSON.stringify({a:1})')).toBe('{"a":1}');
    });

    test('strict mode scripts work', () => {
      expect(vm.runInNewContext('"use strict"; var s = 1; s + 1')).toBe(2);
      expect(vm.runInNewContext('"use strict"; function f(){ return 3; } f()')).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Script
  // -----------------------------------------------------------------------
  describe('Script', () => {
    test('stringifies non-string code', () => {
      expect(new vm.Script(123).runInNewContext()).toBe(123);
    });

    test('accepts a filename string as options', () => {
      const s = new vm.Script('1', 'foo.js');
      expect(s.runInNewContext()).toBe(1);
    });

    test('runInContext string options are converted to filename', () => {
      const ctx = vm.createContext({});
      expect(vm.runInContext('1', ctx, 'bar.js')).toBe(1);
    });

    test('Script run-method options reject non-objects', () => {
      const ctx = vm.createContext({});
      const s = new vm.Script('1');
      expect(() => s.runInContext(ctx, null)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => s.runInContext(ctx, 'x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    });

    test('cachedData round-trip: matching source is not rejected', () => {
      const src = 'console.log("Hello, World!")';
      const produced = vm.compileFunction(src, [], { produceCachedData: true });
      expect(produced.cachedDataProduced).toBe(true);
      expect(produced.cachedData.length).toBeGreaterThan(0);
      const reused = vm.compileFunction(src, [], { cachedData: produced.cachedData });
      expect(reused.cachedDataRejected).toBe(false);
      const wrong = vm.compileFunction('console.log("wrong source")', [], { cachedData: produced.cachedData });
      expect(wrong.cachedDataRejected).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // compileFunction
  // -----------------------------------------------------------------------
  describe('compileFunction', () => {
    test('compiles and runs with params', () => {
      expect(vm.compileFunction('return a + b;', ['a', 'b'])(1, 2)).toBe(3);
    });

    test('params may be omitted', () => {
      expect(vm.compileFunction('return 7;')()).toBe(7);
    });

    test('contextExtensions are visible', () => {
      expect(vm.compileFunction('return a;', [], { contextExtensions: [{ a: 5 }] })()).toBe(5);
    });

    test('parsingContext is used as the scope', () => {
      const ctx = vm.createContext({ val: 9 });
      expect(vm.compileFunction('return val;', [], { parsingContext: ctx })()).toBe(9);
    });

    test('undeclared names throw ReferenceError', () => {
      expect(() => vm.compileFunction('return noSuchVar;', [])()).toThrow(ReferenceError);
    });

    test('validates arguments with Node error codes', () => {
      expect(() => vm.compileFunction(123)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.compileFunction('', 'nope')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.compileFunction('', [], null)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.compileFunction('', [], { parsingContext: {} }))
        .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
      expect(() => vm.compileFunction('', [], { contextExtensions: [0] }))
        .toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    });

    test('stack traces map to the compiled source', () => {
      const oldLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 1;
      try {
        try {
          vm.compileFunction('throw new Error("Sample Error")')();
          throw new Error('did not throw');
        } catch (e) {
          expect(e.stack).toBe('Error: Sample Error\n    at <anonymous>:1:7');
        }
        try {
          vm.compileFunction('throw new Error("Sample Error")', [], { lineOffset: 3 })();
          throw new Error('did not throw');
        } catch (e) {
          expect(e.stack).toBe('Error: Sample Error\n    at <anonymous>:4:7');
        }
      } finally {
        Error.stackTraceLimit = oldLimit;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Error enrichment for run*
  // -----------------------------------------------------------------------
  describe('error enrichment', () => {
    test('stack contains filename, line, column and source context', () => {
      const ctx = vm.createContext({});
      let stack = '';
      try {
        vm.runInContext(' throw new Error()', ctx, {
          filename: 'expected-filename.js',
          lineOffset: 32,
          columnOffset: 123,
        });
      } catch (e) {
        stack = e.stack;
      }
      expect(stack).toMatch(/^ \^/m);
      expect(stack).toMatch(/expected-filename\.js:33:131/);
      expect(stack).toMatch(/^expected-filename\.js:33$/m);
    });
  });

  // -----------------------------------------------------------------------
  // Validation parity with node:vm (differential spot checks)
  // -----------------------------------------------------------------------
  describe('differential validation vs node:vm', () => {
    const cases = [
      ['createContext null', (v) => v.createContext(null)],
      ['createContext array opts', (v) => v.createContext({}, [])],
      ['isContext null', (v) => v.isContext(null)],
      ['runInContext plain object', (v) => v.runInContext('1', {})],
      ['compileFunction bad code', (v) => v.compileFunction(1)],
      ['compileFunction bad params', (v) => v.compileFunction('', 42)],
      ['runInNewContext bad microtask', (v) => v.runInNewContext('1', {}, { microtaskMode: 'bogus' })],
      ['timeout zero', (v) => new v.Script('1').runInContext(v.createContext({}), { timeout: 0 })],
    ];
    test.each(cases)('%s throws the same code as node:vm', (_name, fn) => {
      let expected; let actual;
      try { fn(nodeVm); } catch (e) { expected = `${e.name}:${e.code}`; }
      try { fn(vm); } catch (e) { actual = `${e.name}:${e.code}`; }
      expect(actual).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // constants / measureMemory / Module stubs
  // -----------------------------------------------------------------------
  describe('misc API', () => {
    test('constants are frozen and expose both symbols', () => {
      expect(Object.isFrozen(vm.constants)).toBe(true);
      expect(typeof vm.constants.DONT_CONTEXTIFY).toBe('symbol');
      expect(typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER).toBe('symbol');
    });

    test('measureMemory resolves a summary shape', async () => {
      const mem = await vm.measureMemory({ execution: 'eager' });
      expect(mem.total.jsMemoryEstimate).toBe(0);
      expect(await vm.measureMemory().then((m) => m.total.jsMemoryRange)).toEqual([0, 0]);
      await expect(vm.measureMemory(null)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
      await expect(vm.measureMemory({ mode: 'bogus' })).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
    });

    test('ESM module classes are not exported (matches Node without --experimental-vm-modules)', () => {
      expect(vm.Module).toBe(undefined);
      expect(vm.SourceTextModule).toBe(undefined);
      expect(vm.SyntheticModule).toBe(undefined);
    });

    test('default export exposes the full API', () => {
      for (const key of ['Script', 'compileFunction', 'constants', 'createContext',
        'createScript', 'isContext', 'measureMemory', 'runInContext',
        'runInNewContext', 'runInThisContext']) {
        expect(vm[key]).toBeDefined();
      }
    });
  });
});
