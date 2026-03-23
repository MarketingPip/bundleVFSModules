'use strict';

import { codes } from './internals/errors';

const {
  ERR_ASYNC_CALLBACK,
  ERR_ASYNC_TYPE,
  ERR_INVALID_ASYNC_ID,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_ARG_VALUE,
} = codes;

// --- Internal state ---
let asyncIdCounter = 1;
const asyncResourceMap = new Map();
let currentAsyncId = 0;
const asyncHooks = [];

function generateAsyncId() { return asyncIdCounter++; }



// --- AsyncResource Class ---
export class AsyncResource {
  constructor(type, triggerAsyncId = currentAsyncId) {
    this._type = type;
    this._asyncId = generateAsyncId();
    this._triggerAsyncId = triggerAsyncId;

    // Register resource
    asyncResourceMap.set(this._asyncId, this);

    // Emit 'init' hook
    asyncHooks.forEach(h => {
      if (h.enabled && h.init) h.init(this._asyncId, this._type, this._triggerAsyncId, this);
    });
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const previousId = currentAsyncId;
    currentAsyncId = this._asyncId;

    // Emit 'before' hooks
    asyncHooks.forEach(h => { if (h.enabled && h.before) h.before(this._asyncId); });

    try {
      return fn.apply(thisArg, args);
    } finally {
      // Emit 'after' hooks
      asyncHooks.forEach(h => { if (h.enabled && h.after) h.after(this._asyncId); });
      currentAsyncId = previousId;
    }
  }

  emitDestroy() {
    asyncHooks.forEach(h => { if (h.enabled && h.destroy) h.destroy(this._asyncId); });
    asyncResourceMap.delete(this._asyncId);
  }

  asyncId() { return this._asyncId; }
  triggerAsyncId() { return this._triggerAsyncId; }

  static bind(fn, type = fn.name || 'bound-anonymous-fn', thisArg) {
    const resource = new AsyncResource(type);
    return function(...args) {
      return resource.runInAsyncScope(fn, thisArg, ...args);
    };
  }
}

// --- AsyncHook Class ---
export class AsyncHook {
  constructor({ init, before, after, destroy, promiseResolve, trackPromises } = {}) {
    if (init !== undefined && typeof init !== 'function') throw new ERR_ASYNC_CALLBACK('hook.init');
    if (before !== undefined && typeof before !== 'function') throw new ERR_ASYNC_CALLBACK('hook.before');
    if (after !== undefined && typeof after !== 'function') throw new ERR_ASYNC_CALLBACK('hook.after');
    if (destroy !== undefined && typeof destroy !== 'function') throw new ERR_ASYNC_CALLBACK('hook.destroy');
    if (promiseResolve !== undefined && typeof promiseResolve !== 'function') throw new ERR_ASYNC_CALLBACK('hook.promiseResolve');
    if (trackPromises !== undefined && typeof trackPromises !== 'boolean') throw new ERR_INVALID_ARG_TYPE('trackPromises', 'boolean', trackPromises);

    this.init = init;
    this.before = before;
    this.after = after;
    this.destroy = destroy;
    this.promiseResolve = promiseResolve;
    this.trackPromises = trackPromises === false ? false : true;
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

// --- Hook Factory ---
export function createHook(callbacks) { return new AsyncHook(callbacks); }

// --- Execution/Trigger API ---
export function executionAsyncId() { return currentAsyncId; }
export function triggerAsyncId() { 
  const res = asyncResourceMap.get(currentAsyncId); 
  return res ? res.triggerAsyncId() : 0; 
}
export function executionAsyncResource() { return asyncResourceMap.get(currentAsyncId) || null; }

// --- AsyncWrap Providers ---
export const asyncWrapProviders = Object.freeze({
  __proto__: null,
  Timeout: 'Timeout',
  Immediate: 'Immediate',
  TickObject: 'TickObject',
  PROMISE: 'PROMISE',
});

// --- Patch setTimeout ---
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

// --- Patch setImmediate if exists ---
if (typeof globalThis.setImmediate === 'function') {
  const nativeSetImmediate = globalThis.setImmediate;
  globalThis.setImmediate = (callback, ...args) => {
    const resource = new AsyncResource('Immediate');
    return nativeSetImmediate(() => {
      resource.runInAsyncScope(() => {
        callback(...args);
        resource.emitDestroy();
      });
    });
  };
}

// --- Patch process.nextTick if exists ---
if (typeof process !== 'undefined' && typeof process.nextTick === 'function') {
  const nativeNextTick = process.nextTick;
  process.nextTick = (callback, ...args) => {
    const resource = new AsyncResource('TickObject');
    return nativeNextTick(() => {
      resource.runInAsyncScope(() => {
        callback(...args);
        resource.emitDestroy();
      });
    });
  };
}

// --- Patch Promises if trackPromises enabled ---
const NativePromise = globalThis.Promise;
globalThis.Promise = class AsyncHookPromise extends NativePromise {
  constructor(executor) {
    let resolveFn, rejectFn;
    super((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const resource = new AsyncResource('PROMISE');

    try {
      executor(
        (value) => {
          resource.runInAsyncScope(() => {
            resolveFn(value);
            resource.emitDestroy();
          });
        },
        (reason) => {
          resource.runInAsyncScope(() => {
            rejectFn(reason);
            resource.emitDestroy();
          });
        }
      );
    } catch (err) {
      resource.runInAsyncScope(() => {
        rejectFn(err);
        resource.emitDestroy();
      });
    }
  }

  static get [Symbol.species]() { return NativePromise; }
};
