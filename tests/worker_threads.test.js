import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Browser lane: disable the native bridge BEFORE the shim module is
// evaluated, so every test below exercises the browser implementation
// (blob-URL workers, handshake protocol, eval bootstrap) — not Node's
// worker_threads. WT_BROWSER_LANE=1 additionally removes the host Buffer,
// proving the shim needs no Node builtins at all.
// ---------------------------------------------------------------------------
if (process.env.WT_BROWSER_LANE) {
  // @ts-ignore — deliberate lane-(c) condition
  delete globalThis.Buffer;
}
const _origGetBuiltinModule = process.getBuiltinModule.bind(process);
process.getBuiltinModule = () => {
  throw new Error('native builtins disabled (browser lane)');
};
const wtModule = await import('../src/worker_threads.js');
process.getBuiltinModule = _origGetBuiltinModule;

const wt = wtModule.default;
const {
  Worker, MessageChannel, MessagePort, BroadcastChannel,
  isMainThread, isInternalThread, threadId, threadName, workerData, parentPort,
  SHARE_ENV, resourceLimits, locks,
  setEnvironmentData, getEnvironmentData,
  markAsUntransferable, isMarkedAsUntransferable, markAsUncloneable,
  moveMessagePortToContext, receiveMessageOnPort, postMessageToThread,
} = wtModule;

// ---------------------------------------------------------------------------
// Fake browser globals. FakeWorker genuinely executes the shim's eval-blob
// bootstrap (the exact string built by buildEvalBlob) inside a vm module
// with a fake `self`, so the T_READY/T_INIT/T_ONLINE/T_EXIT handshake and
// user-code evaluation are real — only the OS thread is simulated.
// ---------------------------------------------------------------------------
const blobCodes = new Map();
let blobSeq = 0;

class FakeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options?.type;
  }
}
globalThis.Blob = FakeBlob;
URL.createObjectURL = (blob) => {
  const url = `blob:fake-${++blobSeq}`;
  blobCodes.set(url, blob.parts.join(''));
  return url;
};
URL.revokeObjectURL = (url) => { blobCodes.delete(url); };

class FakeWorker {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.terminated = false;
    this._mainListeners = new Map(); // main-side listeners (the shim's)
    this._selfListeners = new Map(); // worker-side `self` listeners
    const code = blobCodes.get(url);
    if (code === undefined) throw new Error(`FakeWorker: unknown blob URL ${url}`);
    // Defer so the shim can attach its listeners first (mirrors real Worker).
    setImmediate(() => this._start(code));
  }
  addEventListener(type, fn) {
    if (!this._mainListeners.has(type)) this._mainListeners.set(type, new Set());
    this._mainListeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._mainListeners.get(type)?.delete(fn);
  }
  _emitMain(type, event) {
    for (const fn of [...(this._mainListeners.get(type) ?? [])]) fn(event);
  }
  // main -> worker
  postMessage(data, transfer) {
    queueMicrotask(() => {
      if (this.terminated) return;
      for (const fn of [...(this._selfListeners.get('message') ?? [])]) fn({ data });
    });
  }
  terminate() {
    this.terminated = true;
  }
  async _start(code) {
    const selfListeners = this._selfListeners;
    const self = {
      // worker -> main (in a real Worker, self.postMessage goes to the parent)
      postMessage: (data) => {
        queueMicrotask(() => {
          if (!this.terminated) this._emitMain('message', { data });
        });
      },
      addEventListener: (type, fn) => {
        if (!selfListeners.has(type)) selfListeners.set(type, new Set());
        selfListeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => {
        selfListeners.get(type)?.delete(fn);
      },
      close: () => { this.terminated = true; },
    };
    try {
      const ctx = vm.createContext({ self, setTimeout, queueMicrotask });
      const mod = new vm.SourceTextModule(code, { identifier: this.url, context: ctx });
      await mod.link(() => {});
      await mod.evaluate();
    } catch (err) {
      // Mirrors a real browser: uncaught worker error -> 'error' on the Worker.
      // (The eval wrapper already posted T_EXIT with exitCode 1 in `finally`.)
      if (!this.terminated) {
        this.terminated = true;
        queueMicrotask(() => this._emitMain('error', { error: err, message: err?.message }));
      }
    }
  }
}
globalThis.Worker = FakeWorker;

// Helper: next occurrence of an event as a promise.
const once = (emitter, ev) =>
  new Promise((resolve) => emitter.once(ev, (...args) => resolve(args)));

describe('worker_threads browser implementation (native bridge disabled)', () => {
  test('identifies as main thread with null workerData/parentPort', () => {
    expect(isMainThread).toBe(true);
    expect(isInternalThread).toBe(false);
    expect(threadId).toBe(0);
    expect(threadName).toBeNull();
    expect(workerData).toBeNull();
    expect(parentPort).toBeNull();
    expect(typeof SHARE_ENV).toBe('symbol');
    expect(resourceLimits).toEqual({});
  });

  test('environment data store round-trips and deletes', () => {
    setEnvironmentData('wt-test-key', { n: 1 });
    expect(getEnvironmentData('wt-test-key')).toEqual({ n: 1 });
    setEnvironmentData('wt-test-key', undefined);
    expect(getEnvironmentData('wt-test-key')).toBeUndefined();
  });

  test('eval worker round-trips workerData and reports exit 0', async () => {
    const w = new Worker(`parentPort.postMessage(workerData * 2);`, {
      eval: true,
      workerData: 21,
    });
    const msgP = once(w, 'message');
    const exitP = once(w, 'exit');
    await Promise.race([once(w, 'online'), exitP]);
    const [msg] = await msgP;
    expect(msg).toBe(42);
    const [code] = await exitP;
    expect(code).toBe(0);
  });

  test('threadId, threadName and workerData propagate through the handshake', async () => {
    const w = new Worker(
      `parentPort.postMessage({ threadId, threadName, workerData, isMainThread });`,
      { eval: true, workerData: { greeting: 'hello' }, name: 'echo-worker' },
    );
    const msgP = once(w, 'message');
    const exitP = once(w, 'exit');
    const [msg] = await msgP;
    expect(msg.threadId).toBe(w.threadId);
    expect(msg.threadName).toBe('echo-worker');
    expect(w.threadName).toBe('echo-worker');
    expect(msg.workerData).toEqual({ greeting: 'hello' });
    expect(msg.isMainThread).toBe(false);
    const [code] = await exitP;
    expect(code).toBe(0);
  });

  test('main -> worker messaging via parentPort.on("message")', async () => {
    const w = new Worker(
      `parentPort.on('message', (m) => parentPort.postMessage(String(m).toUpperCase()));`,
      { eval: true },
    );
    await Promise.race([once(w, 'online'), once(w, 'exit')]);
    w.postMessage('ping');
    const [msg] = await once(w, 'message');
    expect(msg).toBe('PING');
    await w.terminate();
  });

  test('terminate() stops the worker and resolves the exit code', async () => {
    const w = new Worker(`await new Promise(() => {});`, { eval: true });
    await Promise.race([once(w, 'online'), once(w, 'exit')]);
    const exitP = once(w, 'exit');
    const code = await w.terminate();
    expect(code).toBe(1);
    const [exitCode] = await exitP;
    expect(exitCode).toBe(1);
  });

  test('uncaught worker error emits error and exits 1', async () => {
    const w = new Worker(`throw new Error('boom');`, { eval: true });
    const errP = once(w, 'error');
    const exitP = once(w, 'exit');
    const [err] = await errP;
    expect(err.message).toMatch('boom');
    const [code] = await exitP;
    expect(code).toBe(1);
  });

  test('constructor validates filename', () => {
    expect(() => new Worker(/** @type {any} */ (123))).toThrow(/filename/);
    try {
      new Worker(/** @type {any} */ (123));
    } catch (err) {
      expect(err.code).toBe('ERR_INVALID_ARG_TYPE');
    }
  });

  test('stdio is null and heap introspection is an honest noop', async () => {
    const w = new Worker(`parentPort.postMessage('x');`, { eval: true });
    const exitP = once(w, 'exit');
    expect(w.stdin).toBeNull();
    expect(w.stdout).toBeNull();
    expect(w.stderr).toBeNull();
    await expect(w.getHeapSnapshot()).resolves.toBeNull();
    await expect(w.getHeapStatistics()).resolves.toEqual({});
    await exitP;
  });

  test('markAsUntransferable blocks transferList entries', async () => {
    const w = new Worker(`parentPort.postMessage('x');`, { eval: true });
    const buf = new ArrayBuffer(8);
    expect(isMarkedAsUntransferable(buf)).toBe(false);
    markAsUntransferable(buf);
    expect(isMarkedAsUntransferable(buf)).toBe(true);
    try {
      w.postMessage(buf, [buf]);
      expect.unreachable('postMessage should have thrown');
    } catch (err) {
      expect(err.name).toBe('DataCloneError');
    }
    await once(w, 'exit');
  });

  test('markAsUncloneable blocks the message value', async () => {
    const w = new Worker(`parentPort.postMessage('x');`, { eval: true });
    const obj = { a: 1 };
    markAsUncloneable(obj);
    try {
      w.postMessage(obj);
      expect.unreachable('postMessage should have thrown');
    } catch (err) {
      expect(err.name).toBe('DataCloneError');
    }
    await once(w, 'exit');
  });

  test('MessageChannel/MessagePort round-trip and receiveMessageOnPort drains', async () => {
    expect(typeof MessageChannel).toBe('function');
    expect(typeof MessagePort).toBe('function');
    expect(typeof BroadcastChannel).toBe('function');
    const { port1, port2 } = new MessageChannel();
    // The shim's synchronous queue only sees messages that arrive after its
    // listener is attached, so drain once to attach, then post.
    expect(receiveMessageOnPort(port2)).toBeUndefined();
    port1.postMessage({ n: 1 });
    port1.postMessage({ n: 2 });
    await new Promise((r) => setTimeout(r, 20)); // let messages arrive
    expect(receiveMessageOnPort(port2)).toEqual({ message: { n: 1 } });
    expect(receiveMessageOnPort(port2)).toEqual({ message: { n: 2 } });
    expect(receiveMessageOnPort(port2)).toBeUndefined();
    port1.close();
    port2.close();
  });

  test('moveMessagePortToContext is a pass-through noop', () => {
    const { port1 } = new MessageChannel();
    expect(moveMessagePortToContext(port1)).toBe(port1);
    port1.close();
  });

  test('postMessageToThread rejects for the current thread', async () => {
    await expect(postMessageToThread(threadId, 'x')).rejects.toThrow(/current thread/i);
  });

  test('locks shim serializes exclusive access', async () => {
    const order = [];
    const gate = locks.request('wt-test-lock', async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('first-end');
    });
    const second = locks.request('wt-test-lock', async () => {
      order.push('second');
    });
    await Promise.all([gate, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    const q = await locks.query();
    expect(q.held).toEqual([]);
  });

  test('default export exposes the full module shape', () => {
    for (const key of [
      'Worker', 'MessageChannel', 'MessagePort', 'BroadcastChannel',
      'isMainThread', 'isInternalThread', 'SHARE_ENV', 'threadId', 'threadName',
      'workerData', 'parentPort', 'resourceLimits',
      'setEnvironmentData', 'getEnvironmentData',
      'markAsUntransferable', 'isMarkedAsUntransferable', 'markAsUncloneable',
      'moveMessagePortToContext', 'receiveMessageOnPort', 'postMessageToThread',
      'locks',
    ]) {
      expect(wt[key]).toBeDefined();
    }
    expect(wt.isMainThread).toBe(true);
    expect(wt.threadId).toBe(0);
  });

  test('native bridge is genuinely disabled in this file', () => {
    // The Worker under test is the browser implementation, not Node's.
    expect(Worker.name).toBe('BrowserWorker');
  });
});
