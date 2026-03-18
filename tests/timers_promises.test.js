import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { setTimeout, setImmediate, clearTimeout, clearInterval, setInterval } from '../src/timers/promises.js'; // adjust path

describe('timers/promises shim', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // setTimeout returns a promise
  // -------------------------------------------------------------------------
  describe('setTimeout', () => {
    test('resolves after delay', async () => {
      const fn = jest.fn();
      const promise = setTimeout(() => {
        fn();
        return 'done';
      }, 1000);

      jest.advanceTimersByTime(1000);
      const result = await promise;
      expect(result).toBe('done');
      expect(fn).toHaveBeenCalled();
    });

    test('passes multiple arguments', async () => {
      const fn = jest.fn();
      const promise = setTimeout((a, b) => {
        fn(a, b);
        return a + b;
      }, 500, 2, 3);

      jest.advanceTimersByTime(500);
      const result = await promise;
      expect(result).toBe(5);
      expect(fn).toHaveBeenCalledWith(2, 3);
    });
  });

  // -------------------------------------------------------------------------
  // setImmediate returns a promise
  // -------------------------------------------------------------------------
  describe('setImmediate', () => {
    test('resolves on next tick', async () => {
      const fn = jest.fn();
      const promise = setImmediate(() => {
        fn();
        return 'immediate';
      });

      jest.runAllTimers();
      const result = await promise;
      expect(result).toBe('immediate');
      expect(fn).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // clearing timers
  // -------------------------------------------------------------------------
  describe('clearTimeout / clearInterval', () => {
    test('cancels setTimeout before firing', () => {
      const fn = jest.fn();
      const t = setTimeout(fn, 1000);
      clearTimeout(t);
      jest.advanceTimersByTime(1000);
      expect(fn).not.toHaveBeenCalled();
    });

    test('cancels setInterval after some calls', () => {
      const fn = jest.fn();
      const iv = setInterval(fn, 1000);
      jest.advanceTimersByTime(3000);
      expect(fn).toHaveBeenCalledTimes(3);

      clearInterval(iv);
      jest.advanceTimersByTime(2000);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // async/await behavior with multiple timers
  // -------------------------------------------------------------------------
  describe('async/await integration', () => {
    test('await multiple timers sequentially', async () => {
      const results = [];
      const p1 = setTimeout(() => { results.push(1); }, 100);
      const p2 = setTimeout(() => { results.push(2); }, 200);

      jest.advanceTimersByTime(100);
      await p1;
      jest.advanceTimersByTime(100);
      await p2;

      expect(results).toEqual([1, 2]);
    });
  });
});
