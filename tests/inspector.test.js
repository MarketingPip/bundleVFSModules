import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import inspector, {
  Session,
  open,
  close,
  url,
  waitForDebugger,
  console as inspectorConsole,
} from '../src/inspector.js';

describe('inspector shim', () => {
  describe('module shape', () => {
    test('default export contains all expected members', () => {
      expect(inspector.Session).toBe(Session);
      expect(inspector.open).toBe(open);
      expect(inspector.close).toBe(close);
      expect(inspector.url).toBe(url);
      expect(inspector.waitForDebugger).toBe(waitForDebugger);
      expect(inspector.console).toBe(inspectorConsole);
    });
  });

  describe('Session', () => {
    let session;

    beforeEach(() => {
      session = new Session();
    });

    test('is an EventEmitter', () => {
      expect(typeof session.on).toBe('function');
      expect(typeof session.emit).toBe('function');
      expect(typeof session.removeListener).toBe('function');
    });

    test('connect() does not throw', () => {
      expect(() => session.connect()).not.toThrow();
    });

    test('connectToMainThread() does not throw', () => {
      expect(() => session.connectToMainThread()).not.toThrow();
    });

    test('disconnect() does not throw', () => {
      expect(() => session.disconnect()).not.toThrow();
    });

    test('post() invokes callback asynchronously with (null, {})', (done) => {
      session.post('Runtime.enable', {}, (err, result) => {
        expect(err).toBeNull();
        expect(result).toEqual({});
        done();
      });
    });

    test('post() without callback does not throw', () => {
      expect(() => session.post('Runtime.enable')).not.toThrow();
      expect(() => session.post('Runtime.enable', {})).not.toThrow();
    });

    test('post() callback fires after current microtask queue', (done) => {
      let fired = false;
      session.post('Debugger.enable', {}, () => {
        fired = true;
        done();
      });
      // callback must not fire synchronously
      expect(fired).toBe(false);
    });

    test('multiple post() calls each invoke their own callbacks', (done) => {
      const results = [];
      const finish = () => {
        if (results.length === 2) {
          expect(results).toEqual(['a', 'b']);
          done();
        }
      };
      session.post('A', {}, () => { results.push('a'); finish(); });
      session.post('B', {}, () => { results.push('b'); finish(); });
    });

    test('can emit and receive custom events', (done) => {
      session.on('inspectorNotification', (payload) => {
        expect(payload.method).toBe('Debugger.paused');
        done();
      });
      session.emit('inspectorNotification', { method: 'Debugger.paused' });
    });
  });

  describe('open()', () => {
    test('does not throw with no arguments', () => {
      expect(() => open()).not.toThrow();
    });

    test('does not throw with port, host, and wait arguments', () => {
      expect(() => open(9229, '127.0.0.1', false)).not.toThrow();
    });
  });

  describe('close()', () => {
    test('does not throw', () => {
      expect(() => close()).not.toThrow();
    });
  });

  describe('url()', () => {
    test('returns undefined', () => {
      expect(url()).toBeUndefined();
    });
  });

  describe('waitForDebugger()', () => {
    test('does not throw', () => {
      expect(() => waitForDebugger()).not.toThrow();
    });
  });

  describe('console', () => {
    test('is globalThis.console', () => {
      expect(inspectorConsole).toBe(globalThis.console);
    });

    test('has standard console methods', () => {
      expect(typeof inspectorConsole.log).toBe('function');
      expect(typeof inspectorConsole.warn).toBe('function');
      expect(typeof inspectorConsole.error).toBe('function');
    });
  });
});
