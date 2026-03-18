import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import cluster from '../src/cluster.js';

describe('Cluster Browser Shim', () => {
  
  beforeEach(() => {
    // Clear the workers object between tests to prevent pollution
    Object.keys(cluster.workers).forEach(id => {
      delete cluster.workers[id];
    });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Initial State', () => {
    test('identifies as primary/master, never worker', () => {
      expect(cluster.isPrimary).toBe(true);
      expect(cluster.isMaster).toBe(true);
      expect(cluster.isWorker).toBe(false);
    });

    test('starts with no active workers', () => {
      expect(Object.keys(cluster.workers).length).toBe(0);
    });
  });

  describe('Worker Lifecycle', () => {
    test('forking creates a worker and triggers "online" event', () => {
      const onlineSpy = jest.fn();
      const clusterOnlineSpy = jest.fn();

      cluster.on('online', clusterOnlineSpy);
      
      const worker = cluster.fork({ ROLE: 'test' });
      worker.on('online', onlineSpy);

      expect(worker.id).toBeDefined();
      expect(cluster.workers[worker.id]).toBe(worker);
      expect(worker.process.env.ROLE).toBe('test');

      // Online event is inside a setTimeout(..., 0)
      jest.advanceTimersByTime(0);

      expect(onlineSpy).toHaveBeenCalled();
      expect(clusterOnlineSpy).toHaveBeenCalledWith(worker);
    });

    test('disconnecting a worker triggers cleanup', () => {
      const worker = cluster.fork();
      const exitSpy = jest.fn();
      
      worker.on('exit', exitSpy);
      worker.disconnect();

      expect(worker.isConnected()).toBe(false);
      expect(worker.exitedAfterDisconnect).toBe(true);

      // FinalizeExit is inside a setTimeout
      jest.advanceTimersByTime(0);

      expect(worker.isDead()).toBe(true);
      expect(cluster.workers[worker.id]).toBeUndefined();
      expect(exitSpy).toHaveBeenCalledWith(0, null);
    });

    test('killing a worker finishes it immediately', () => {
      const worker = cluster.fork();
      worker.kill('SIGKILL');

      expect(worker.isDead()).toBe(true);
      expect(worker.isConnected()).toBe(false);
      expect(cluster.workers[worker.id]).toBeUndefined();
    });
  });

  describe('IPC Simulation', () => {
    test('sending messages triggers event listeners asynchronously', () => {
      const worker = cluster.fork();
      const messageSpy = jest.fn();
      const clusterMessageSpy = jest.fn();

      worker.on('message', messageSpy);
      cluster.on('message', clusterMessageSpy);

      const payload = { hello: 'world' };
      const success = worker.send(payload);

      expect(success).toBe(true);
      expect(messageSpy).not.toHaveBeenCalled(); // Not yet...

      jest.advanceTimersByTime(0);

      expect(messageSpy).toHaveBeenCalledWith(payload);
      expect(clusterMessageSpy).toHaveBeenCalledWith(worker, payload);
    });

    test('cannot send messages to dead workers', () => {
      const worker = cluster.fork();
      worker.kill();
      expect(worker.send('test')).toBe(false);
    });
  });

  describe('Cluster Methods', () => {
    test('setupPrimary updates settings object', () => {
      const setupSpy = jest.fn();
      cluster.on('setup', setupSpy);

      cluster.setupPrimary({ exec: 'worker.js' });
      
      expect(cluster.settings.exec).toBe('worker.js');
      expect(setupSpy).toHaveBeenCalledWith(cluster.settings);
    });

    test('cluster.disconnect() disconnects all active workers', () => {
      const w1 = cluster.fork();
      const w2 = cluster.fork();
      
      cluster.disconnect();

      expect(w1.isConnected()).toBe(false);
      expect(w2.isConnected()).toBe(false);
    });
  });
});
