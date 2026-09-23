import { jest, describe, test, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';
import inspector, {
  Session,
  open,
  close,
  url,
  waitForDebugger,
  console as inspectorConsole,
  Network,
  DOMStorage,
  NetworkResources,
} from '../src/inspector.js';
import * as inspectorPromises from '../src/inspector/promises.js';
import { Session as PromisesSession } from '../src/inspector/promises.js';

describe('inspector shim', () => {
  describe('module shape', () => {
    test('default export contains all expected members', () => {
      expect(inspector.Session).toBe(Session);
      expect(inspector.open).toBe(open);
      expect(inspector.close).toBe(close);
      expect(inspector.url).toBe(url);
      expect(inspector.waitForDebugger).toBe(waitForDebugger);
      expect(inspector.console).toBe(inspectorConsole);
      expect(inspector.Network).toBe(Network);
      expect(inspector.DOMStorage).toBe(DOMStorage);
      expect(inspector.NetworkResources).toBe(NetworkResources);
    });

    test('named exports match real node:inspector keys', () => {
      // Node v24.20.0: DOMStorage, Network, NetworkResources, Session,
      // close, console, open, url, waitForDebugger
      const keys = [
        'DOMStorage', 'Network', 'NetworkResources', 'Session',
        'close', 'console', 'open', 'url', 'waitForDebugger',
      ];
      for (const key of keys) {
        expect(inspector[key]).toBeDefined();
      }
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

    test('prototype has the real method names', () => {
      const proto = Object.getPrototypeOf(session);
      for (const name of ['connect', 'connectToMainThread', 'disconnect', 'post']) {
        expect(typeof proto[name]).toBe('function');
      }
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

    test('post() shifts a function params slot into the callback slot', (done) => {
      session.post('Runtime.enable', (err, result) => {
        expect(err).toBeNull();
        expect(result).toEqual({});
        done();
      });
    });

    test('post() without callback does not throw', () => {
      expect(() => session.post('Runtime.enable')).not.toThrow();
      expect(() => session.post('Runtime.enable', {})).not.toThrow();
    });

    test('post() callback does not fire synchronously', (done) => {
      let fired = false;
      session.post('Debugger.enable', {}, () => {
        fired = true;
        done();
      });
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
    test('returns undefined (no inspector backend in the sandbox)', () => {
      expect(url()).toBeUndefined();
    });
  });

  describe('waitForDebugger()', () => {
    test('does not throw', () => {
      expect(() => waitForDebugger()).not.toThrow();
    });
  });

  describe('console', () => {
    const realMethodNames = [
      'assert', 'clear', 'context', 'count', 'countReset', 'debug', 'dir',
      'dirxml', 'error', 'group', 'groupCollapsed', 'groupEnd', 'info', 'log',
      'profile', 'profileEnd', 'table', 'time', 'timeEnd', 'timeLog',
      'timeStamp', 'trace', 'warn',
    ];

    test('has exactly the real method names of node:inspector console', () => {
      expect(Object.keys(inspectorConsole).sort()).toEqual(
        [...realMethodNames].sort(),
      );
    });

    test('all methods are functions', () => {
      for (const name of realMethodNames) {
        expect(typeof inspectorConsole[name]).toBe('function');
      }
    });

    test('delegates to the host console', () => {
      const spy = jest.spyOn(globalThis.console, 'log').mockImplementation(() => {});
      try {
        inspectorConsole.log('hello', 42);
        expect(spy).toHaveBeenCalledWith('hello', 42);
      } finally {
        spy.mockRestore();
      }
    });

    test('is a distinct object from the host console', () => {
      expect(inspectorConsole).not.toBe(globalThis.console);
    });
  });

  describe('protocol agents', () => {
    test('Network has the real method names and is a noop', () => {
      expect(Object.keys(Network).sort()).toEqual([
        'dataReceived', 'dataSent', 'loadingFailed', 'loadingFinished',
        'requestWillBeSent', 'responseReceived', 'webSocketClosed',
        'webSocketCreated', 'webSocketHandshakeResponseReceived',
      ].sort());
      expect(() => Network.requestWillBeSent({ requestId: '1' })).not.toThrow();
      expect(() => Network.webSocketClosed({})).not.toThrow();
    });

    test('DOMStorage has the real method names and is a noop', () => {
      expect(Object.keys(DOMStorage).sort()).toEqual([
        'domStorageItemAdded', 'domStorageItemRemoved', 'domStorageItemUpdated',
        'domStorageItemsCleared', 'registerStorage',
      ].sort());
      expect(() => DOMStorage.domStorageItemAdded({})).not.toThrow();
    });

    test('NetworkResources has put() and is a noop', () => {
      expect(Object.keys(NetworkResources)).toEqual(['put']);
      expect(() => NetworkResources.put({})).not.toThrow();
    });
  });

  describe('inspector/promises', () => {
    test('Session is a subclass of the callback Session', () => {
      const s = new PromisesSession();
      expect(s).toBeInstanceOf(Session);
    });

    test('post() returns a promise resolving to {}', async () => {
      const s = new PromisesSession();
      const result = await s.post('Runtime.enable', {});
      expect(result).toEqual({});
    });

    test('post() works with params omitted', async () => {
      const s = new PromisesSession();
      await expect(s.post('Debugger.enable')).resolves.toEqual({});
    });

    test('inherits connect()/disconnect() as noops', () => {
      const s = new PromisesSession();
      expect(() => s.connect()).not.toThrow();
      expect(() => s.disconnect()).not.toThrow();
    });

    test('re-exports the base module members with identical identity', () => {
      expect(inspectorPromises.open).toBe(open);
      expect(inspectorPromises.close).toBe(close);
      expect(inspectorPromises.url).toBe(url);
      expect(inspectorPromises.waitForDebugger).toBe(waitForDebugger);
      expect(inspectorPromises.console).toBe(inspectorConsole);
      expect(inspectorPromises.Network).toBe(Network);
      expect(inspectorPromises.DOMStorage).toBe(DOMStorage);
      expect(inspectorPromises.NetworkResources).toBe(NetworkResources);
    });

    test('Session is distinct from the callback Session', () => {
      expect(PromisesSession).not.toBe(Session);
    });

    test('has no default export (mirrors real node:inspector/promises CJS facade)', () => {
      expect(inspectorPromises.default).toBeUndefined();
    });
  });

  describe('browser fallback (no native delegation)', () => {
    const realGbm = process.getBuiltinModule;
    const hadBuffer = Object.prototype.hasOwnProperty.call(globalThis, 'Buffer');
    const realBuffer = globalThis.Buffer;
    let fb;
    let fbPromises;

    beforeAll(async () => {
      // Any native-delegation attempt throws: the import and every operation
      // below must work with zero native delegation.
      process.getBuiltinModule = () => {
        throw new Error('native delegation attempted');
      };
      delete globalThis.Buffer;
      try {
        fb = await import('../src/inspector.js?fallback=inspector');
        fbPromises = await import('../src/inspector/promises.js?fallback=inspector-promises');
      } finally {
        process.getBuiltinModule = realGbm;
        if (hadBuffer) globalThis.Buffer = realBuffer;
      }
    });

    test('module loads with the native bridge disabled', () => {
      expect(typeof fb.Session).toBe('function');
      expect(typeof fb.open).toBe('function');
    });

    test('session post() resolves (null, {}) without natives', (done) => {
      const s = new fb.Session();
      s.connect();
      s.post('Runtime.enable', {}, (err, result) => {
        expect(err).toBeNull();
        expect(result).toEqual({});
        done();
      });
    });

    test('promises Session resolves {} without natives', async () => {
      const s = new fbPromises.Session();
      await expect(s.post('Debugger.enable')).resolves.toEqual({});
    });

    test('console delegation works without natives', () => {
      expect(typeof fb.console.log).toBe('function');
      expect(Object.keys(fb.console)).toHaveLength(23);
    });
  });
});
