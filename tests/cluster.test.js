import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import cluster, * as ns from '../src/cluster.js';
import { EventEmitter } from '../src/events.js';

const {
  fork,
  Worker,
  setupPrimary,
  setupMaster,
  disconnect,
  isPrimary,
  isMaster,
  isWorker,
  worker,
  workers,
  settings,
  SCHED_NONE,
  SCHED_RR,
} = ns;

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  // Reset shared module state between tests.
  for (const id of Object.keys(workers)) delete workers[id];
  for (const key of Object.keys(settings)) delete settings[key];
  cluster.removeAllListeners();
});

afterEach(() => {
  cluster.removeAllListeners();
});

describe('role flags (browser is always the primary)', () => {
  test('identifies as primary/master, never as a worker', () => {
    expect(isPrimary).toBe(true);
    expect(isMaster).toBe(true);
    expect(isWorker).toBe(false);
    expect(cluster.isPrimary).toBe(true);
    expect(cluster.isMaster).toBe(true);
    expect(cluster.isWorker).toBe(false);
  });

  test('default export is the cluster EventEmitter singleton', () => {
    expect(cluster).toBeInstanceOf(EventEmitter);
    expect(ns.default).toBe(cluster);
  });

  test('worker is undefined in the primary', () => {
    expect(worker).toBeUndefined();
    expect(cluster.worker).toBeUndefined();
  });

  test('starts with empty settings and no workers', () => {
    expect(settings).toEqual({});
    expect(workers).toEqual({});
    expect(cluster.settings).toBe(settings);
    expect(cluster.workers).toBe(workers);
  });

  test('scheduling constants and default policy', () => {
    expect(SCHED_NONE).toBe(1);
    expect(SCHED_RR).toBe(2);
    expect(cluster.schedulingPolicy).toBe(SCHED_RR);
  });

  test('schedulingPolicy is settable through the singleton', () => {
    cluster.schedulingPolicy = SCHED_NONE;
    expect(cluster.schedulingPolicy).toBe(SCHED_NONE);
    expect(ns.schedulingPolicy).toBe(SCHED_NONE);
    cluster.schedulingPolicy = SCHED_RR; // restore
  });
});

describe('Worker constructor (mirrors Node shape)', () => {
  test('bare construction matches Node: id 0, state none, no process', () => {
    const w = new Worker();
    expect(w).toBeInstanceOf(Worker);
    expect(w).toBeInstanceOf(EventEmitter);
    expect(w.id).toBe(0);
    expect(w.state).toBe('none');
    expect(w.process).toBeUndefined();
    expect(w.exitedAfterDisconnect).toBeUndefined();
  });

  test('accepts id/state/process options', () => {
    const fakeProc = new EventEmitter();
    const w = new Worker({ id: 3, state: 'online', process: fakeProc });
    expect(w.id).toBe(3);
    expect(w.state).toBe('online');
    expect(w.process).toBe(fakeProc);
    expect(w.exitedAfterDisconnect).toBeUndefined();
  });

  test('works without new (Node-compatible plain function)', () => {
    const w = Worker.call({}, { id: 5 });
    expect(w).toBeInstanceOf(Worker);
    expect(w.id).toBe(5);
  });

  test('null/non-object options are tolerated', () => {
    expect(new Worker(null).id).toBe(0);
    expect(new Worker('nope').id).toBe(0);
  });
});

describe('fork() — stub worker, no real process', () => {
  test('returns a Worker with id and pid stub, registered in workers', () => {
    const w1 = fork();
    const w2 = fork({ ROLE: 'web' });

    expect(w1).toBeInstanceOf(Worker);
    expect(w2.id).toBe(w1.id + 1);
    expect(typeof w1.process.pid).toBe('number');
    expect(workers[w1.id]).toBe(w1);
    expect(workers[w2.id]).toBe(w2);
    // Requested env is echoed on the stub (documented convenience).
    expect(w2.process.env).toEqual({ ROLE: 'web' });
    expect(w1.process.env).toEqual({});
  });

  test('emits "fork" on the cluster asynchronously, not synchronously', async () => {
    let seen = null;
    cluster.on('fork', (w) => { seen = w; });
    const w = fork();
    expect(seen).toBeNull(); // Node emits on nextTick, not synchronously
    await flushAsync();
    expect(seen).toBe(w);
  });

  test('does not fabricate online/message/exit/disconnect events', async () => {
    const calls = [];
    for (const e of ['online', 'message', 'exit', 'disconnect']) {
      cluster.on(e, () => calls.push(`cluster:${e}`));
    }
    const w = fork();
    for (const e of ['online', 'message', 'exit', 'disconnect']) {
      w.on(e, () => calls.push(`worker:${e}`));
    }
    w.send({ hello: 'world' });
    await flushAsync();
    expect(calls).toEqual([]);
  });

  test('never creates a real OS process', () => {
    const w = fork();
    // A real ChildProcess would have spawnfile/spawnargs/stdio; the stub has none.
    expect(w.process.spawnfile).toBeUndefined();
    expect(w.process.spawnargs).toBeUndefined();
    // …and it is not connected to anything.
    expect(w.process.connected).toBe(false);
  });
});

describe('worker lifecycle stubs (honest noops)', () => {
  test('send() delivers nothing and returns false', async () => {
    const w = fork();
    let got = null;
    w.on('message', (m) => { got = m; });
    expect(w.send({ hello: 'world' })).toBe(false);
    await flushAsync();
    expect(got).toBeNull();
  });

  test('kill()/destroy()/disconnect() are noops; worker never dies', () => {
    const w = fork();
    w.kill('SIGTERM');
    w.destroy('SIGKILL');
    w.disconnect();
    expect(w.isDead()).toBe(false);
    expect(w.isConnected()).toBe(false);
    expect(workers[w.id]).toBe(w); // still registered: nothing exited
    expect(w.exitedAfterDisconnect).toBeUndefined();
  });

  test('disconnect() returns the worker like Node', () => {
    const w = fork();
    expect(w.disconnect()).toBe(w);
  });
});

describe('setupPrimary()', () => {
  test('fills Node-compatible defaults and merges cumulatively', () => {
    setupPrimary();
    expect(settings.args).toEqual(process.argv.slice(2));
    expect(settings.exec).toBe(process.argv[1]);
    expect(settings.execArgv).toEqual(process.execArgv);
    expect(settings.silent).toBe(false);

    setupPrimary({ exec: 'overridden' });
    expect(settings.exec).toBe('overridden');
    expect(settings.args).toEqual(process.argv.slice(2));

    setupPrimary({ args: ['foo'] });
    expect(settings.exec).toBe('overridden');
    expect(settings.args).toEqual(['foo']);
  });

  test('emits "setup" asynchronously with the settings object', async () => {
    let seen = 'not-fired';
    let sync = true;
    cluster.once('setup', (s) => {
      seen = s;
      expect(sync).toBe(false); // must not fire synchronously
    });
    setupPrimary({ exec: 'worker.js' });
    sync = false;
    await flushAsync();
    expect(seen).toBe(settings);
    expect(seen.exec).toBe('worker.js');
  });

  test('setupMaster is the same function (deprecated alias)', () => {
    expect(setupMaster).toBe(setupPrimary);
    expect(cluster.setupMaster).toBe(cluster.setupPrimary);
  });
});

describe('cluster.disconnect()', () => {
  test('invokes the callback asynchronously, never synchronously', async () => {
    const w = fork();
    let fired = false;
    let sync = true;
    disconnect(() => {
      fired = true;
      expect(sync).toBe(false);
    });
    sync = false;
    expect(fired).toBe(false);
    await flushAsync();
    expect(fired).toBe(true);
    // Stub workers are untouched.
    expect(w.isConnected()).toBe(false);
    expect(workers[w.id]).toBe(w);
  });

  test('works without a callback and ignores non-function callbacks', async () => {
    fork();
    expect(() => disconnect()).not.toThrow();
    expect(() => disconnect('nope')).not.toThrow();
    await flushAsync();
  });
});

describe('emitter surface', () => {
  test('default export is the cluster EventEmitter singleton', async () => {
    const seen = [];
    cluster.on('x', (v) => seen.push(v));
    cluster.emit('x', 42);
    expect(seen).toEqual([42]);
    cluster.removeListener('x', seen.push); // different fn: no-op, must not throw
    const onceSeen = [];
    cluster.once('y', (v) => onceSeen.push(v));
    cluster.emit('y', 1);
    cluster.emit('y', 2);
    expect(onceSeen).toEqual([1]);
  });
});
