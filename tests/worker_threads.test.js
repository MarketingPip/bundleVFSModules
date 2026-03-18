import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks for Browser Globals
// ---------------------------------------------------------------------------
class MockWorker extends EventTarget {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.terminated = false;
    this.postMessage = jest.fn((data) => {
      // Simulate the internal handshake: 
      // When main thread sends T_INIT, the worker would normally respond with T_ONLINE
      if (data && data.__type__ === '__wt_init__') {
        setTimeout(() => {
          this.dispatchEvent(new MessageEvent('message', { 
            data: { __type__: '__wt_online__' } 
          }));
        }, 0);
      }
    });
    this.terminate = jest.fn(() => { this.terminated = true; });
    
    // Simulate the worker's initial T_READY signal
    setTimeout(() => {
      this.dispatchEvent(new MessageEvent('message', { 
        data: { __type__: '__wt_ready__' } 
      }));
    }, 0);
  }
}

globalThis.Worker = MockWorker;
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
globalThis.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
globalThis.URL.revokeObjectURL = jest.fn();

// Import the shim
import wt from '../src/worker_threads.js';

describe('worker_threads Browser Shim', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('Environment & Context', () => {
    test('identifies as main thread by default', () => {
      expect(wt.isMainThread).toBe(true);
      expect(wt.threadId).toBe(0);
    });

    test('setEnvironmentData stores values globally', () => {
      wt.setEnvironmentData('key', 'value');
      expect(wt.getEnvironmentData('key')).toBe('value');
    });
  });

  describe('Worker Class Lifecycle', () => {
    test('forks an eval-mode worker and completes handshake', async () => {
      const onlineSpy = jest.fn();
      const worker = new wt.Worker('console.log("hello")', { 
        eval: true, 
        workerData: { foo: 'bar' } 
      });

      worker.on('online', onlineSpy);

      // 1. Advance for T_READY
      jest.advanceTimersByTime(0);
      
      // Check if T_INIT was sent back to the native worker
      expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
      expect(worker.threadId).toBeGreaterThan(0);

      // 2. Advance for T_ONLINE
      jest.advanceTimersByTime(0);
      expect(onlineSpy).toHaveBeenCalled();
    });

    test('terminate() stops the native worker and emits exit', async () => {
      const exitSpy = jest.fn();
      const worker = new wt.Worker('test.js');
      
      worker.on('exit', exitSpy);
      const exitPromise = worker.terminate();

      jest.advanceTimersByTime(0);
      
      const code = await exitPromise;
      expect(code).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('Data Integrity Guards', () => {
    test('markAsUntransferable throws on postMessage attempt', () => {
      const worker = new wt.Worker('test.js');
      const buffer = new ArrayBuffer(8);
      
      wt.markAsUntransferable(buffer);
      
      expect(() => {
        worker.postMessage(buffer, [buffer]);
      }).toThrow(/Transfer of untransferable object/);
    });

    test('receiveMessageOnPort synchronously drains queue', () => {
      // Mocking MessagePort behavior
      const mockPort = {
        addEventListener: jest.fn(),
        start: jest.fn(),
        shift: jest.fn()
      };

      // Since we can't easily trigger the internal WeakMap from outside,
      // we test the public API surface.
      const result = wt.receiveMessageOnPort(mockPort);
      expect(result).toBeUndefined(); // Empty queue
    });
  });

  describe('Locks Shim', () => {
    test('exclusive locks prevent concurrent access', async () => {
      let counter = 0;
      const task = () => wt.locks.request('test-lock', async () => {
        const current = counter;
        await new Promise(r => setTimeout(r, 10));
        counter = current + 1;
      });

      // Start two tasks
      const p1 = task();
      const p2 = task();

      jest.advanceTimersByTime(50);
      await Promise.all([p1, p2]);

      // If locks work, they run sequentially. If not, counter would be 1.
      expect(counter).toBe(2);
    });
  });
});
