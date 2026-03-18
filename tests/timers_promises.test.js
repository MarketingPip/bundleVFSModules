import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { setTimeout, setImmediate, setInterval } from '../src/timers/promises.js';

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
      }, 100);

      jest.advanceTimersByTime(100);
      const result = await promise;
      expect(result).toBe('done');
      expect(fn).toHaveBeenCalled();
    });

    test('passes multiple arguments', async () => {
      const fn = jest.fn();
      const promise = setTimeout((a, b) => {
        fn(a, b);
        return a + b;
      }, 50, 2, 3);

      jest.advanceTimersByTime(50);
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

      jest.advanceTimersByTime(0); // instead of runAllTimers()
      const result = await promise;
      expect(result).toBe('immediate');
      expect(fn).toHaveBeenCalled();
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

  // -------------------------------------------------------------------------
  // setInterval returns a promise repeatedly
  // -------------------------------------------------------------------------
  describe('setInterval', () => {
    test('fires repeatedly until cleared', async () => {
      const fn = jest.fn();
      let count = 0;

      const interval = setInterval(() => {
        count++;
        fn(count);
        if (count >= 3) interval.close(); // stop after 3
        return count;
      }, 50);

      jest.advanceTimersByTime(50 * 3);
      const result = await interval;
      expect(fn).toHaveBeenCalledTimes(3);
      expect(fn).toHaveBeenNthCalledWith(1, 1);
      expect(fn).toHaveBeenNthCalledWith(2, 2);
      expect(fn).toHaveBeenNthCalledWith(3, 3);
      expect(result).toBe(3);
    });
  });
});
