// adjust path if needed
import {jest, describe, test, expect } from '@jest/globals';

import timers, {
  setTimeout, clearTimeout,
  setInterval, clearInterval,
  setImmediate, clearImmediate,
  enroll, unenroll, active, _unrefActive
} from '../src/timers.js';

describe('timers-web', () => {

  // -------------------------------------------------------------------------
  // setTimeout / clearTimeout
  // -------------------------------------------------------------------------
  describe('setTimeout / clearTimeout', () => {
    test('setTimeout returns Timeout with close', (done) => {
      const fn = jest.fn();
      const t = setTimeout(fn, 10, 'a', 'b');
      expect(typeof t.close).toBe('function');
      t.close();

      setTimeout(() => {
        expect(fn).not.toHaveBeenCalled();
        done();
      }, 20);
    });

    test('timeout fires after delay with args', (done) => {
      const fn = jest.fn((a, b) => {
        expect(a).toBe(1);
        expect(b).toBe(2);
        done();
      });
      setTimeout(fn, 10, 1, 2);
    });

    test('Timeout ref/unref are no-ops', () => {
      const t = setTimeout(() => {}, 10);
      expect(t.ref()).toBe(t);
      expect(t.unref()).toBe(t);
    });

    test('Timeout Symbol.toPrimitive returns id', () => {
      const t = setTimeout(() => {}, 10);
      expect(t._id).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // setInterval / clearInterval
  // -------------------------------------------------------------------------
  describe('setInterval / clearInterval', () => {
    test('interval fires repeatedly until cleared', (done) => {
      let count = 0;
      const iv = setInterval(() => {
        count++;
        if (count === 3) iv.close();
      }, 10);

      setTimeout(() => {
        expect(count).toBe(3);
        done();
      }, 50);
    });
  });

  // -------------------------------------------------------------------------
  // setImmediate / clearImmediate
  // -------------------------------------------------------------------------
  describe('setImmediate / clearImmediate', () => {
    test('setImmediate fires in next tick', (done) => {
      setImmediate((arg) => {
        expect(arg).toBe('arg');
        done();
      }, 'arg');
    });

    test('Immediate close cancels', (done) => {
      const fn = jest.fn();
      const im = setImmediate(fn);
      im.close();

      setTimeout(() => {
        expect(fn).not.toHaveBeenCalled();
        done();
      }, 20);
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
    test('clears numeric timer id', (done) => {
      const fn = jest.fn();
      const id = setTimeout(fn, 10);
      clearTimeout(id._id);

      setTimeout(() => {
        expect(fn).not.toHaveBeenCalled();
        done();
      }, 20);
    });

    test('clears Timeout/Interval object', (done) => {
      const fn = jest.fn();
      const t = setTimeout(fn, 10);
      clearTimeout(t);

      setTimeout(() => {
        expect(fn).not.toHaveBeenCalled();
        done();
      }, 20);
    });
  });

  // -------------------------------------------------------------------------
  // clearImmediate with raw id
  // -------------------------------------------------------------------------
  describe('clearImmediate', () => {
    test('clears numeric immediate id', (done) => {
      const fn = jest.fn();
      const id = setImmediate(fn);
      clearImmediate(id._id);

      setTimeout(() => {
        expect(fn).not.toHaveBeenCalled();
        done();
      }, 20);
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

    test('unenroll cancels timer and sets _idleTimeout to -1', (done) => {
      obj._idleTimeoutId = setTimeout(() => {}, 10);
      unenroll(obj);
      expect(obj._idleTimeout).toBe(-1);

      setTimeout(() => done(), 20);
    });

    test('active schedules _onTimeout after _idleTimeout', (done) => {
      enroll(obj, 20);
      active(obj);

      setTimeout(() => {
        expect(obj._onTimeout).toHaveBeenCalled();
        done();
      }, 25);
    });

    test('_unrefActive alias works', (done) => {
      enroll(obj, 10);
      _unrefActive(obj);

      setTimeout(() => {
        expect(obj._onTimeout).toHaveBeenCalled();
        done();
      }, 15);
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
