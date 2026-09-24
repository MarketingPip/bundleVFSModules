// tests/async_hooks.test.js — repo tests for src/async_hooks.js
//
// Lane A (top-level import): under real Node the shim delegates to the
//   genuine builtin via process.getBuiltinModule; assert true async semantics.
// Lane B: the export surface, identical in both lanes.
// Lane C ("browser fallback"): native delegation disabled
//   (process.getBuiltinModule stubbed to throw, host Buffer removed). The
//   dependency-free stub is exercised directly — including its documented
//   limitation that AsyncLocalStorage does NOT propagate across real async
//   boundaries in a browser.
import * as ah from '../src/async_hooks.js';

const NODE_EXPORTS = [
  'AsyncLocalStorage',
  'AsyncResource',
  'asyncWrapProviders',
  'createHook',
  'default',
  'executionAsyncId',
  'executionAsyncResource',
  'triggerAsyncId',
];

function expectCode(fn, code) {
  try {
    fn();
  } catch (e) {
    expect(e.code).toBe(code);
    return;
  }
  throw new Error(`expected a throw with code ${code}, but nothing threw`);
}

function nativeAvailable() {
  try {
    return (
      typeof process.getBuiltinModule === 'function' &&
      !!process.getBuiltinModule('async_hooks')
    );
  } catch {
    return false;
  }
}

describe('export surface (both lanes)', () => {
  test('exports exactly the Node v24.20.0 surface, including default export', () => {
    expect(Object.keys(ah).sort()).toEqual([...NODE_EXPORTS].sort());
    expect('default' in ah).toBe(true);
  });

  test('export types', () => {
    expect(typeof ah.AsyncLocalStorage).toBe('function');
    expect(typeof ah.AsyncResource).toBe('function');
    expect(typeof ah.asyncWrapProviders).toBe('object');
    expect(typeof ah.createHook).toBe('function');
    expect(typeof ah.executionAsyncId).toBe('function');
    expect(typeof ah.executionAsyncResource).toBe('function');
    expect(typeof ah.triggerAsyncId).toBe('function');
  });

  test('asyncWrapProviders is the frozen v24.20.0 enum', () => {
    expect(Object.isFrozen(ah.asyncWrapProviders)).toBe(true);
    expect(Object.getPrototypeOf(ah.asyncWrapProviders)).toBe(null);
    expect(ah.asyncWrapProviders.NONE).toBe(0);
    expect(ah.asyncWrapProviders.PROMISE).toBe(27);
    expect(ah.asyncWrapProviders.TCPWRAP).toBe(40);
    expect(Object.keys(ah.asyncWrapProviders)).toHaveLength(68);
  });
});

describe('node lane (native delegation)', () => {
  const itNative = nativeAvailable() ? test : test.skip;

  itNative('delegates to the genuine builtin', () => {
    const mod = process.getBuiltinModule('async_hooks');
    expect(ah.AsyncLocalStorage).toBe(mod.AsyncLocalStorage);
    expect(ah.AsyncResource).toBe(mod.AsyncResource);
    expect(ah.createHook).toBe(mod.createHook);
  });

  itNative('AsyncLocalStorage propagates across real async boundaries', async () => {
    const als = new ah.AsyncLocalStorage();
    const seen = await als.run('ctx', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return als.getStore();
    });
    expect(seen).toBe('ctx');
  });

  itNative('createHook observes real async resources (timers)', async () => {
    const types = [];
    const hook = ah.createHook({ init: (_id, type) => types.push(type) }).enable();
    try {
      await new Promise((r) => setTimeout(r, 5));
    } finally {
      hook.disable();
    }
    expect(types).toContain('Timeout');
  });

  itNative('executionAsyncId is a non-negative integer', () => {
    expect(Number.isInteger(ah.executionAsyncId())).toBe(true);
    expect(ah.executionAsyncId()).toBeGreaterThanOrEqual(0);
  });
});

describe('browser fallback (no native delegation)', () => {
  let fb;
  const realGbm = process.getBuiltinModule;
  const realBuffer = globalThis.Buffer;
  const hadBuffer = 'Buffer' in globalThis;
  let hostPromise;
  let hostSetTimeout;
  let hostNextTick;

  beforeAll(async () => {
    hostPromise = globalThis.Promise;
    hostSetTimeout = globalThis.setTimeout;
    hostNextTick = typeof process !== 'undefined' ? process.nextTick : undefined;
    // Any native-delegation attempt throws: the import and every operation
    // below must work with zero native delegation. Host Buffer is removed
    // to prove the stub never needs it.
    process.getBuiltinModule = () => {
      throw new Error('native delegation attempted');
    };
    try {
      if (hadBuffer) {
        try {
          delete globalThis.Buffer;
        } catch {
          /* non-configurable in some hosts; the gbm stub is the real gate */
        }
      }
      fb = await import('../src/async_hooks.js?fallback=async_hooks');
    } finally {
      process.getBuiltinModule = realGbm;
      if (hadBuffer) globalThis.Buffer = realBuffer;
    }
  });

  afterAll(() => {
    process.getBuiltinModule = realGbm;
    if (hadBuffer && globalThis.Buffer !== realBuffer) {
      globalThis.Buffer = realBuffer;
    }
  });

  test('module loads with the native bridge disabled', () => {
    expect(Object.keys(fb).sort()).toEqual([...NODE_EXPORTS].sort());
    expect('default' in fb).toBe(true);
  });

  test('does not patch host globals (Promise / setTimeout / nextTick)', () => {
    expect(globalThis.Promise).toBe(hostPromise);
    expect(globalThis.setTimeout).toBe(hostSetTimeout);
    if (hostNextTick !== undefined) {
      expect(process.nextTick).toBe(hostNextTick);
    }
  });

  test('asyncWrapProviders stub matches the real enum shape', () => {
    expect(Object.isFrozen(fb.asyncWrapProviders)).toBe(true);
    expect(Object.getPrototypeOf(fb.asyncWrapProviders)).toBe(null);
    expect(fb.asyncWrapProviders.PROMISE).toBe(27);
    expect(Object.keys(fb.asyncWrapProviders)).toHaveLength(68);
  });

  describe('createHook', () => {
    test('validates callback types with ERR_ASYNC_CALLBACK', () => {
      for (const key of ['init', 'before', 'after', 'destroy', 'promiseResolve']) {
        expectCode(() => fb.createHook({ [key]: 42 }), 'ERR_ASYNC_CALLBACK');
      }
    });

    test('validates trackPromises with ERR_INVALID_ARG_TYPE', () => {
      expectCode(() => fb.createHook({ trackPromises: 'yes' }), 'ERR_INVALID_ARG_TYPE');
    });

    test('missing callbacks object throws a plain TypeError (like Node)', () => {
      expect(() => fb.createHook()).toThrow(TypeError);
      expect(() => fb.createHook(null)).toThrow(TypeError);
      expect(() => fb.createHook()).toThrow(/destructure/);
    });

    test('enable()/disable() track state and are idempotent', () => {
      const hook = fb.createHook({});
      expect(hook.enable()).toBe(hook);
      expect(hook.disable()).toBe(hook);
      hook.enable();
      hook.enable();
      hook.disable();
      hook.disable();
    });

    test('init/before/after/destroy fire for stub resources, in order', () => {
      const events = [];
      const hook = fb
        .createHook({
          init: (id, type, triggerId) => events.push(['init', type, triggerId]),
          before: (id) => events.push(['before', id]),
          after: (id) => events.push(['after', id]),
          destroy: (id) => events.push(['destroy', id]),
        })
        .enable();
      const ar = new fb.AsyncResource('mytype');
      const id = ar.asyncId();
      ar.runInAsyncScope(() => {});
      ar.emitDestroy();
      hook.disable();

      expect(events[0][0]).toBe('init');
      expect(events[0][1]).toBe('mytype');
      expect(typeof events[0][2]).toBe('number');
      expect(events).toContainEqual(['before', id]);
      expect(events).toContainEqual(['after', id]);
      expect(events).toContainEqual(['destroy', id]);
      const kinds = events.map((e) => e[0]);
      expect(kinds).toEqual(['init', 'before', 'after', 'destroy']);
    });

    test('a disabled hook receives nothing', () => {
      const seen = [];
      const hook = fb.createHook({ init: (id) => seen.push(id) });
      new fb.AsyncResource('not-tracked'); // hook not enabled yet
      hook.enable();
      new fb.AsyncResource('tracked');
      hook.disable();
      new fb.AsyncResource('not-tracked-either');
      expect(seen).toHaveLength(1);
    });
  });

  describe('AsyncResource', () => {
    test('allocates unique async ids', () => {
      const a = new fb.AsyncResource('a');
      const b = new fb.AsyncResource('b');
      expect(a.asyncId()).not.toBe(b.asyncId());
      expect(Number.isInteger(a.asyncId())).toBe(true);
    });

    test('type is required to be a string', () => {
      expectCode(() => new fb.AsyncResource(), 'ERR_INVALID_ARG_TYPE');
      expectCode(() => new fb.AsyncResource(42), 'ERR_INVALID_ARG_TYPE');
    });

    test('triggerAsyncId defaults to the current execution id', () => {
      const outer = fb.executionAsyncId();
      const ar = new fb.AsyncResource('t');
      expect(ar.triggerAsyncId()).toBe(outer);
      const explicit = new fb.AsyncResource('t', { triggerAsyncId: 99 });
      expect(explicit.triggerAsyncId()).toBe(99);
    });

    test('non-integer triggerAsyncId throws ERR_INVALID_ASYNC_ID', () => {
      expectCode(
        () => new fb.AsyncResource('t', { triggerAsyncId: 1.5 }),
        'ERR_INVALID_ASYNC_ID'
      );
      expectCode(
        () => new fb.AsyncResource('t', { triggerAsyncId: 'x' }),
        'ERR_INVALID_ASYNC_ID'
      );
      // integers (even negative) are accepted, like Node
      expect(new fb.AsyncResource('t', { triggerAsyncId: -1 }).triggerAsyncId()).toBe(-1);
    });

    test('runInAsyncScope sets and restores the execution id', () => {
      const outer = fb.executionAsyncId();
      const ar = new fb.AsyncResource('t');
      let inside = -1;
      const ret = ar.runInAsyncScope(() => {
        inside = fb.executionAsyncId();
        return 'value';
      });
      expect(ret).toBe('value');
      expect(inside).toBe(ar.asyncId());
      expect(fb.executionAsyncId()).toBe(outer);
    });

    test('runInAsyncScope restores the id even when fn throws', () => {
      const outer = fb.executionAsyncId();
      const ar = new fb.AsyncResource('t');
      expect(() =>
        ar.runInAsyncScope(() => {
          throw new Error('boom');
        })
      ).toThrow('boom');
      expect(fb.executionAsyncId()).toBe(outer);
    });

    test('runInAsyncScope forwards thisArg and args', () => {
      const ar = new fb.AsyncResource('t');
      const thisArg = { marker: true };
      const result = ar.runInAsyncScope(
        function (a, b) {
          return [this.marker, a + b];
        },
        thisArg,
        2,
        3
      );
      expect(result).toEqual([true, 5]);
    });

    test('emitDestroy is idempotent', () => {
      const ar = new fb.AsyncResource('t');
      expect(ar.emitDestroy()).toBe(ar);
      expect(() => ar.emitDestroy()).not.toThrow();
    });

    test('executionAsyncResource / triggerAsyncId follow the scope', () => {
      const ar = new fb.AsyncResource('t');
      expect(fb.triggerAsyncId()).toBe(0);
      const outerResource = fb.executionAsyncResource();
      expect(outerResource).toBeDefined();
      ar.runInAsyncScope(() => {
        expect(fb.executionAsyncResource()).toBe(ar);
        expect(fb.triggerAsyncId()).toBe(ar.triggerAsyncId());
      });
      expect(fb.executionAsyncResource()).toBe(outerResource);
    });

    test('AsyncResource.bind runs fn in the resource scope', () => {
      const seen = [];
      const hook = fb.createHook({ init: (id, type) => seen.push([id, type]) }).enable();
      function named() {}
      const boundNamed = fb.AsyncResource.bind(named);
      const boundAnonId = seen[seen.length - 1][0];
      hook.disable();
      expect(seen.map(([, type]) => type)).toContain('named');
      // the bound function executes with the resource's async id
      expect(boundNamed()).toBeUndefined();
      const probeIds = [];
      const hook2 = fb.createHook({ init: (id) => probeIds.push(id) }).enable();
      const boundProbe = fb.AsyncResource.bind(function () {
        return fb.executionAsyncId();
      });
      const probeId = probeIds[probeIds.length - 1];
      hook2.disable();
      expect(boundProbe()).toBe(probeId);
      expect(boundAnonId).toBeGreaterThan(0);
    });

    test('AsyncResource.bind defaults anonymous functions to bound-anonymous-fn', () => {
      const seen = [];
      const hook = fb.createHook({ init: (id, type) => seen.push(type) }).enable();
      fb.AsyncResource.bind(function () {});
      hook.disable();
      expect(seen).toContain('bound-anonymous-fn');
    });
  });

  describe('AsyncLocalStorage', () => {
    test('run sets the store synchronously and restores it', () => {
      const als = new fb.AsyncLocalStorage();
      expect(als.getStore()).toBeUndefined();
      const ret = als.run('ctx', () => als.getStore());
      expect(ret).toBe('ctx');
      expect(als.getStore()).toBeUndefined();
    });

    test('nested run scopes do not interfere', () => {
      const als = new fb.AsyncLocalStorage();
      const seen = [];
      als.run({ a: 1 }, () => {
        seen.push(als.getStore());
        als.run({ b: 2 }, () => {
          seen.push(als.getStore());
        });
        seen.push(als.getStore());
      });
      expect(seen).toEqual([{ a: 1 }, { b: 2 }, { a: 1 }]);
    });

    test('run restores the store when the callback throws', () => {
      const als = new fb.AsyncLocalStorage();
      expect(() =>
        als.run('ctx', () => {
          throw new Error('boom');
        })
      ).toThrow('boom');
      expect(als.getStore()).toBeUndefined();
    });

    test('run passes through extra args and return values', () => {
      const als = new fb.AsyncLocalStorage();
      expect(
        als.run('s', (a, b) => [als.getStore(), a + b], 20, 22)
      ).toEqual(['s', 42]);
    });

    test('run with a non-function callback throws TypeError', () => {
      const als = new fb.AsyncLocalStorage();
      expect(() => als.run('x')).toThrow(TypeError);
    });

    test('DOCUMENTED LIMITATION: run does not propagate across awaits', async () => {
      const als = new fb.AsyncLocalStorage();
      let syncValue;
      let afterAwait;
      await als.run('ctx', async () => {
        syncValue = als.getStore();
        await new Promise((r) => setTimeout(r, 5));
        afterAwait = als.getStore();
      });
      expect(syncValue).toBe('ctx');
      expect(afterAwait).toBeUndefined();
      expect(als.getStore()).toBeUndefined();
    });

    test('enterWith sets the ambient store; exit runs outside it', () => {
      const als = new fb.AsyncLocalStorage();
      als.enterWith('ambient');
      expect(als.getStore()).toBe('ambient');
      const inner = als.exit(() => als.getStore());
      expect(inner).toBeUndefined();
      expect(als.getStore()).toBe('ambient');
    });

    test('disable makes getStore undefined, but run still works inside', () => {
      const als = new fb.AsyncLocalStorage();
      als.enterWith('ambient');
      als.disable();
      expect(als.getStore()).toBeUndefined();
      expect(als.run('ctx', () => als.getStore())).toBe('ctx');
      expect(als.getStore()).toBeUndefined();
    });

    test('constructor name option and name getter', () => {
      expect(new fb.AsyncLocalStorage().name).toBe('');
      expect(new fb.AsyncLocalStorage({ name: 'request' }).name).toBe('request');
      expectCode(() => new fb.AsyncLocalStorage('nope'), 'ERR_INVALID_ARG_TYPE');
      expectCode(
        () => new fb.AsyncLocalStorage({ name: 42 }),
        'ERR_INVALID_ARG_TYPE'
      );
    });

    test('static bind captures the current stores synchronously', () => {
      const als = new fb.AsyncLocalStorage();
      let captured;
      als.run('bound', () => {
        const fn = fb.AsyncLocalStorage.bind(() => als.getStore());
        captured = fn();
      });
      expect(captured).toBe('bound');
      expect(als.getStore()).toBeUndefined();
    });

    test('static snapshot runs a function within the captured stores', () => {
      const als = new fb.AsyncLocalStorage();
      let result;
      als.run('snap', () => {
        const snap = fb.AsyncLocalStorage.snapshot();
        result = snap(() => als.getStore());
      });
      expect(result).toBe('snap');
    });

    test('withScope().run behaves like run with a fixed store', () => {
      const als = new fb.AsyncLocalStorage();
      const scope = als.withScope('scoped');
      expect(scope.run(() => als.getStore())).toBe('scoped');
      expect(als.getStore()).toBeUndefined();
    });
  });
});
