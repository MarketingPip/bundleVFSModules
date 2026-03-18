import { 
  AsyncResource, 
  AsyncLocalStorage, 
  createHook, 
  executionAsyncId, 
  triggerAsyncId 
} from '../src/async-hooks.js'; // adjust path as needed

describe('async-hooks-web', () => {

  // ---------------------------------------------------------------------------
  // AsyncResource
  // ---------------------------------------------------------------------------
  describe('AsyncResource', () => {
    test('generates unique asyncId and stores triggerAsyncId', () => {
      const ar1 = new AsyncResource('test1');
      const ar2 = new AsyncResource('test2', ar1.asyncId());
      expect(ar1.asyncId()).not.toBe(ar2.asyncId());
      expect(ar2.triggerAsyncId()).toBe(ar1.asyncId());
    });

    test('runInAsyncScope sets executionAsyncId correctly', () => {
      const ar = new AsyncResource('test');
      let insideId = 0;
      ar.runInAsyncScope(() => {
        insideId = executionAsyncId();
      });
      expect(insideId).toBe(ar.asyncId());
      expect(executionAsyncId()).toBe(0); // restored after
    });

    test('before and after hooks are called', () => {
      const calls = [];
      const hook = createHook({
        before: (id) => calls.push(`before-${id}`),
        after: (id) => calls.push(`after-${id}`)
      }).enable();

      const ar = new AsyncResource('test');
      ar.runInAsyncScope(() => {});
      expect(calls).toEqual([
        `before-${ar.asyncId()}`,
        `after-${ar.asyncId()}`
      ]);

      hook.disable();
    });

    test('emitDestroy calls destroy hook', () => {
      const called = [];
      const hook = createHook({ destroy: id => called.push(id) }).enable();
      const ar = new AsyncResource('test');
      ar.emitDestroy();
      expect(called).toContain(ar.asyncId());
      hook.disable();
    });
  });

  // ---------------------------------------------------------------------------
  // AsyncLocalStorage
  // ---------------------------------------------------------------------------
  describe('AsyncLocalStorage', () => {
    test('stores and retrieves values correctly', () => {
      const store = new AsyncLocalStorage();
      let valueInside;
      store.run({ foo: 'bar' }, () => {
        valueInside = store.getStore();
      });
      expect(valueInside).toEqual({ foo: 'bar' });
      expect(store.getStore()).toBeUndefined(); // outside callback
    });

    test('nested run contexts do not interfere', () => {
      const store = new AsyncLocalStorage();
      const results = [];
      store.run({ a: 1 }, () => {
        results.push(store.getStore());
        store.run({ b: 2 }, () => {
          results.push(store.getStore());
        });
        results.push(store.getStore());
      });
      expect(results).toEqual([{ a: 1 }, { b: 2 }, { a: 1 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // createHook, executionAsyncId, triggerAsyncId
  // ---------------------------------------------------------------------------
  describe('createHook / executionAsyncId / triggerAsyncId', () => {
    test('executionAsyncId returns current asyncId inside runInAsyncScope', () => {
      const ar = new AsyncResource('test');
      let currentId = 0;
      ar.runInAsyncScope(() => {
        currentId = executionAsyncId();
      });
      expect(currentId).toBe(ar.asyncId());
    });

    test('triggerAsyncId returns correct value', () => {
      const ar = new AsyncResource('test');
      expect(triggerAsyncId()).toBe(0); // nothing running outside
      ar.runInAsyncScope(() => {
        expect(triggerAsyncId()).toBe(ar.triggerAsyncId());
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Monkey-patched setTimeout
  // ---------------------------------------------------------------------------
  describe('monkey-patched setTimeout with AsyncResource', () => {
    test('setTimeout triggers AsyncResource hooks', (done) => {
      const calls = [];
      const hook = createHook({
        init: (id, type, triggerId) => calls.push(`init-${type}-${id}`),
        before: (id) => calls.push(`before-${id}`),
        after: (id) => calls.push(`after-${id}`),
        destroy: (id) => calls.push(`destroy-${id}`)
      }).enable();

      setTimeout(() => {
        calls.push('callback');
        expect(calls).toEqual([
          expect.stringMatching(/^init-Timeout-\d+$/),
          expect.stringMatching(/^before-\d+$/),
          'callback',
          expect.stringMatching(/^after-\d+$/),
          expect.stringMatching(/^destroy-\d+$/)
        ]);
        hook.disable();
        done();
      }, 10);
    });
  });
});
