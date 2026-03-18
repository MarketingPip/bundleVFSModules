// adjust path if needed
import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';

import timers, {
  setTimeout, clearTimeout,
  setInterval, clearInterval,
  setImmediate, clearImmediate,
  enroll, unenroll, active, _unrefActive
} from '../src/timers.js';



describe('timers-web', () => {
  // Move jest.useFakeTimers() **inside describe**
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
  });
  // -------------------------------------------------------------------------
  // setTimeout / clearTimeout
  // -------------------------------------------------------------------------
  describe('setTimeout / clearTimeout', () => {
    test('setTimeout returns Timeout with close', () => {
      const fn = jest.fn();
      const t = setTimeout(fn, 1000, 'a', 'b');
      expect(typeof t.close).toBe('function');
      t.close();
      jest.runAllTimers();
      expect(fn).not.toBeCalled();
    });

    test('timeout fires after delay with args', () => {
      const fn = jest.fn();
      setTimeout(fn, 1000, 1, 2);
      jest.advanceTimersByTime(1000);
      expect(fn).toHaveBeenCalledWith(1, 2);
    });

    test('Timeout ref/unref are no-ops', () => {
      const t = setTimeout(() => {}, 10);
      expect(t.ref()).toBe(t);
      expect(t.unref()).toBe(t);
    });

    test('Timeout Symbol.toPrimitive returns id', () => {
      const t = setTimeout(() => {}, 10);
      expect(+t).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // setInterval / clearInterval
  // -------------------------------------------------------------------------
  describe('setInterval / clearInterval', () => {
    test('interval fires repeatedly until cleared', () => {
      const fn = jest.fn();
      const iv = setInterval(fn, 1000);
      jest.advanceTimersByTime(3000);
      expect(fn).toHaveBeenCalledTimes(3);
      iv.close();
      jest.advanceTimersByTime(2000);
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // setImmediate / clearImmediate
  // -------------------------------------------------------------------------
  describe('setImmediate / clearImmediate', () => {
    test('setImmediate fires in next tick', () => {
      const fn = jest.fn();
      setImmediate(fn, 'arg');
      jest.runAllImmediates();
      expect(fn).toHaveBeenCalledWith('arg');
    });

    test('Immediate close cancels', () => {
      const fn = jest.fn();
      const im = setImmediate(fn);
      im.close();
      jest.runAllImmediates();
      expect(fn).not.toBeCalled();
    });

    test('Immediate ref/unref are no-ops', () => {
      const im = setImmediate(() => {});
      expect(im.ref()).toBe(im);
      expect(im.unref()).toBe(im);
    });
  });

  // -------------------------------------------------------------------------
  // clearTimeout / clearInterval with raw id
  // -------------------------------------------------------------------------
  describe('clearTimeout / clearInterval', () => {
    test('clears numeric timer id', () => {
      const fn = jest.fn();
      const id = setTimeout(fn, 1000);
      clearTimeout(+id);
      jest.advanceTimersByTime(1000);
      expect(fn).not.toBeCalled();
    });

    test('clears Timeout/Interval object', () => {
      const fn = jest.fn();
      const t = setTimeout(fn, 1000);
      clearTimeout(t);
      jest.advanceTimersByTime(1000);
      expect(fn).not.toBeCalled();
    });
  });

  // -------------------------------------------------------------------------
  // clearImmediate with raw id
  // -------------------------------------------------------------------------
  describe('clearImmediate', () => {
    test('clears numeric immediate id', () => {
      const fn = jest.fn();
      const id = setImmediate(fn);
      clearImmediate(id._id);
      jest.runAllImmediates();
      expect(fn).not.toBeCalled();
    });
  });

  // -------------------------------------------------------------------------
  // enroll / unenroll / active
  // -------------------------------------------------------------------------
  describe('legacy idle-timeout helpers', () => {
    let obj;
    beforeEach(() => {
      obj = { _idleTimeoutId: null, _idleTimeout: 0, _onTimeout: jest.fn() };
    });

    test('enroll sets _idleTimeout', () => {
      enroll(obj, 1234);
      expect(obj._idleTimeout).toBe(1234);
    });

    test('unenroll cancels timer and sets _idleTimeout to -1', () => {
      obj._idleTimeoutId = setTimeout(() => {}, 1000);
      unenroll(obj);
      expect(obj._idleTimeout).toBe(-1);
      jest.runAllTimers();
    });

    test('active schedules _onTimeout after _idleTimeout', () => {
      enroll(obj, 500);
      active(obj);
      jest.advanceTimersByTime(499);
      expect(obj._onTimeout).not.toBeCalled();
      jest.advanceTimersByTime(1);
      expect(obj._onTimeout).toBeCalled();
    });

    test('_unrefActive alias works', () => {
      enroll(obj, 10);
      _unrefActive(obj);
      jest.advanceTimersByTime(10);
      expect(obj._onTimeout).toBeCalled();
    });
  });

  // -------------------------------------------------------------------------
  // default export contains all
  // -------------------------------------------------------------------------
  describe('default export', () => {
    test('has all timer functions', () => {
      expect(typeof timers.setTimeout).toBe('function');
      expect(typeof timers.clearTimeout).toBe('function');
      expect(typeof timers.setInterval).toBe('function');
      expect(typeof timers.clearInterval).toBe('function');
      expect(typeof timers.setImmediate).toBe('function');
      expect(typeof timers.clearImmediate).toBe('function');
      expect(typeof timers.enroll).toBe('function');
      expect(typeof timers.unenroll).toBe('function');
      expect(typeof timers.active).toBe('function');
      expect(timers._unrefActive).toBe(timers.active);
    });
  });

});
