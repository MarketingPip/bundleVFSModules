// Named-export surface added for Node v24.20.0 parity:
// setMaxListeners, defaultMaxListeners, errorMonitor,
// EventEmitterAsyncResource, captureRejections, captureRejectionSymbol.
import EventEmitter, {
  setMaxListeners,
  defaultMaxListeners,
  errorMonitor,
  EventEmitterAsyncResource,
  captureRejections,
  captureRejectionSymbol,
  once,
  on,
} from '../src/events.js';
import * as ns from '../src/events.js';
import { describe, test, expect } from '@jest/globals';

describe('events named exports (Node v24.20.0 surface)', () => {
  test('all six names are present in the module namespace', () => {
    for (const k of [
      'setMaxListeners',
      'defaultMaxListeners',
      'errorMonitor',
      'EventEmitterAsyncResource',
      'captureRejections',
      'captureRejectionSymbol',
    ]) {
      expect(k in ns).toBe(true);
    }
  });

  test('named exports are identical to the EventEmitter statics', () => {
    expect(setMaxListeners).toBe(EventEmitter.setMaxListeners);
    expect(errorMonitor).toBe(EventEmitter.errorMonitor);
    expect(captureRejectionSymbol).toBe(EventEmitter.captureRejectionSymbol);
    expect(EventEmitterAsyncResource).toBe(EventEmitter.EventEmitterAsyncResource);
  });

  test('setMaxListeners sets the module default when called bare', () => {
    const prev = EventEmitter.defaultMaxListeners;
    try {
      setMaxListeners(42);
      expect(EventEmitter.defaultMaxListeners).toBe(42);
      expect(defaultMaxListeners).toBe(42);
      // And new emitters pick it up.
      expect(new EventEmitter().getMaxListeners()).toBe(42);
    } finally {
      setMaxListeners(prev);
    }
  });

  test('defaultMaxListeners is a live binding', () => {
    const prev = EventEmitter.defaultMaxListeners;
    try {
      EventEmitter.defaultMaxListeners = 33;
      expect(defaultMaxListeners).toBe(33);
    } finally {
      EventEmitter.defaultMaxListeners = prev;
    }
    expect(defaultMaxListeners).toBe(prev);
  });

  test('captureRejections is a live binding synced with the static', () => {
    const prev = EventEmitter.captureRejections;
    try {
      expect(captureRejections).toBe(false);
      EventEmitter.captureRejections = true;
      expect(captureRejections).toBe(true);
      expect(EventEmitter.captureRejections).toBe(true);
      // New emitters inherit the current default.
      const ee = new EventEmitter();
      ee.on('x', async () => {});
      expect(ee.getMaxListeners()).toBeGreaterThan(0); // sanity: emitter works
    } finally {
      EventEmitter.captureRejections = prev;
    }
    expect(captureRejections).toBe(prev);
  });

  test('errorMonitor / captureRejectionSymbol are the Node registry symbols', () => {
    expect(typeof errorMonitor).toBe('symbol');
    expect(typeof captureRejectionSymbol).toBe('symbol');
    expect(errorMonitor).toBe(Symbol.for('events.errorMonitor'));
    expect(captureRejectionSymbol).toBe(Symbol.for('nodejs.rejection'));
  });

  test('EventEmitterAsyncResource constructs and emits', () => {
    const r = new EventEmitterAsyncResource({ name: 'test' });
    expect(r).toBeInstanceOf(EventEmitter);
    expect(typeof r.asyncId).toBe('number');
    expect(typeof r.triggerAsyncId).toBe('number');
    let seen = false;
    r.on('ping', () => { seen = true; });
    r.emit('ping');
    expect(seen).toBe(true);
    expect(() => r.emitDestroy()).not.toThrow();
  });

  test('EventEmitterAsyncResource rejects bad options like Node', () => {
    // Real Node throws ERR_INVALID_ARG_TYPE for a missing name; we match.
    expect(() => new EventEmitterAsyncResource()).toThrow(/options\.name/);
  });

  test('pre-existing named exports still work', async () => {
    const ee = new EventEmitter();
    setImmediate(() => ee.emit('go', 7));
    const [v] = await once(ee, 'go');
    expect(v).toBe(7);
    expect(typeof on).toBe('function');
  });
});
