import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks for Browser Globals
// ---------------------------------------------------------------------------

/**
 * Mocking the native Web Worker to simulate the handshake protocol.
 * We use setTimeout in the mock to allow the caller to set up listeners
 * before the messages are "delivered".
 */
class MockWorker extends EventTarget {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.terminated = false;
    
    this.postMessage = jest.fn((data) => {
      // Internal Handshake: If main thread sends T_INIT, respond with T_ONLINE
      if (data && data.__type__ === '__wt_init__') {
        setTimeout(() => {
          this.dispatchEvent(new MessageEvent('message', { 
            data: { __type__: '__wt_online__' } 
          }));
        }, 0);
      }
    });

    this.terminate = jest.fn(() => { this.terminated = true; });
    
    // Simulate the worker's initial T_READY signal as soon as it's "spawned"
    setTimeout(() => {
      this.dispatchEvent(new MessageEvent('message', { 
        data: { __type__: '__wt_ready__' } 
      }));
    }, 0);
  }
}

// Global environment setup
globalThis.Worker = MockWorker;
globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
globalThis.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
globalThis.URL.revokeObjectURL = jest.fn();

// Import the shim
import wt from '../src/worker_threads.js';

// Helper to flush the Promise (microtask) queue
const flushPromises = () => new Promise(jest.requireActual('timers').setImmediate);

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
      wt.setEnvironmentData('test-key', 'test-value');
      expect(wt.getEnvironmentData('test-key')).toBe('test-value');
    });
  });

describe('Worker Class Lifecycle', () => {
    test('forks an eval-mode worker and completes handshake', async () => {
      // Use real timers for async events
      jest.useRealTimers();
    
      const worker = new wt.Worker('parentPort.postMessage("ping")', { 
        eval: true, 
        workerData: { hello: 'world' } 
      });
    
      // Await the 'online' event
      const onlinePromise = new Promise(resolve => worker.once('online', resolve));
    
      // Simulate handshake if using a Mock Worker
      if (worker._mockTriggerReady) {
        // Trigger T_READY -> T_INIT -> T_ONLINE
        worker._mockTriggerReady(); 
      }
    
      // Await the online event
      await onlinePromise;
    
      // Checks
      expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
      expect(worker.threadId).toBeGreaterThan(0);
    });

    

    test('terminate() stops the native worker and emits exit', async () => {
      const worker = new wt.Worker('test.js');
      const exitPromise = new Promise(resolve => worker.on('exit', resolve));
      
      worker.terminate();

      jest.advanceTimersByTime(0);
      await flushPromises();
      
      const code = await exitPromise;
      expect(code).toBe(1);
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

    test('markAsUncloneable prevents messaging', () => {
      const worker = new wt.Worker('test.js');
      const obj = { data: 'secret' };
      
      wt.markAsUncloneable(obj);
      
      expect(() => {
        worker.postMessage(obj);
      }).toThrow(/could not be cloned/);
    });
  });

  describe('Locks Shim', () => {
    test('exclusive locks prevent concurrent access', async () => {
      // Switch to real timers: fake timers often deadlock with async/await locks
      jest.useRealTimers();

      let counter = 0;
      const task = async () => {
        return wt.locks.request('test-lock', async () => {
          const current = counter;
          // Simulated async work
          await new Promise(r => setTimeout(r, 10));
          counter = current + 1;
        });
      };

      // Execute two tasks that compete for the same exclusive lock
      await Promise.all([task(), task()]);

      // If locks work (exclusive), they run serially -> counter = 2
      // If locks failed (concurrent), both read current=0 -> counter = 1
      expect(counter).toBe(2);
    });
    
    
  });
});
