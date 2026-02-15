'use strict';

let asyncIdCounter = 1;
const asyncResourceMap = new Map();
let currentAsyncId = 0;
const asyncHooks = [];

function generateAsyncId() { return asyncIdCounter++; }

/**
 * Node.js Official: AsyncResource Class
 * This is the standard way to manually track custom async boundaries.
 */
export class AsyncResource {
  constructor(type, triggerAsyncId = currentAsyncId) {
    this._type = type;
    this._asyncId = generateAsyncId();
    this._triggerAsyncId = triggerAsyncId;

    // Emit 'init' hook
    asyncHooks.forEach(h => {
      if (h.enabled && h.callbacks.init) {
        h.callbacks.init(this._asyncId, this._type, this._triggerAsyncId, this);
      }
    });
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const previousId = currentAsyncId;
    currentAsyncId = this._asyncId;

    // Emit 'before'
    asyncHooks.forEach(h => {
      if (h.enabled && h.callbacks.before) h.callbacks.before(this._asyncId);
    });

    try {
      return fn.apply(thisArg, args);
    } finally {
      // Emit 'after'
      asyncHooks.forEach(h => {
        if (h.enabled && h.callbacks.after) h.callbacks.after(this._asyncId);
      });
      currentAsyncId = previousId;
    }
  }

  emitDestroy() {
    asyncHooks.forEach(h => {
      if (h.enabled && h.callbacks.destroy) h.callbacks.destroy(this._asyncId);
    });
  }

  asyncId() { return this._asyncId; }
  triggerAsyncId() { return this._triggerAsyncId; }
}

/**
 * Node.js Official: AsyncLocalStorage
 * Built on top of the hooks to provide scoped state.
 */
export class AsyncLocalStorage {
  constructor() {
    this._storeMap = new Map(); // asyncId -> store data
  }

  run(store, callback, ...args) {
    const resource = new AsyncResource('AsyncLocalStorage');
    return resource.runInAsyncScope(() => {
      this._storeMap.set(resource.asyncId(), store);
      try {
        return callback(...args);
      } finally {
        this._storeMap.delete(resource.asyncId());
      }
    });
  }

  getStore() {
    return this._storeMap.get(currentAsyncId);
  }
}

class AsyncHook {
  constructor(callbacks) {
    this.callbacks = callbacks || {};
    this.enabled = false;
  }
  enable() {
    if (!this.enabled) {
      this.enabled = true;
      if (!asyncHooks.includes(this)) asyncHooks.push(this);
    }
    return this;
  }
  disable() {
    this.enabled = false;
    const idx = asyncHooks.indexOf(this);
    if (idx !== -1) asyncHooks.splice(idx, 1);
    return this;
  }
}

export function createHook(callbacks) { return new AsyncHook(callbacks); }
export function executionAsyncId() { return currentAsyncId; }
export function triggerAsyncId() { 
  const res = asyncResourceMap.get(currentAsyncId);
  return res ? res.triggerAsyncId : 0; 
}

// Monkey-patching Timers (as previously discussed)
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  const resource = new AsyncResource('Timeout');
  return nativeSetTimeout(() => {
    resource.runInAsyncScope(() => {
      callback(...args);
      resource.emitDestroy();
    });
  }, delay);
};
