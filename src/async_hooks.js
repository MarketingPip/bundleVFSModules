// async-hooks-shim.mjs
'use strict';

/**
 * Async Hooks Shim (ESM)
 * Emulates Node.js async_hooks API for emulated runtime
 */


/**
 * Monkey-patch global timers to trigger our shim hooks
 */
const nativeSetTimeout = globalThis.setTimeout;

globalThis.setTimeout = (callback, delay, ...args) => {
  const triggerId = currentAsyncId;
  const id = generateAsyncId();
  const type = 'Timeout';
  const resource = { asyncId: id, type, triggerAsyncId: triggerId };

  asyncResourceMap.set(id, resource);

  // 1. Trigger 'init'
  asyncHooks.forEach(h => {
    if (h.enabled && h.callbacks.init) {
      h.callbacks.init(id, type, triggerId, resource);
    }
  });

  return nativeSetTimeout(async () => {
    const previousId = currentAsyncId;
    currentAsyncId = id;

    // 2. Trigger 'before'
    asyncHooks.forEach(h => {
      if (h.enabled && h.callbacks.before) h.callbacks.before(id);
    });

    try {
      await callback(...args);
    } finally {
      // 3. Trigger 'after'
      asyncHooks.forEach(h => {
        if (h.enabled && h.callbacks.after) h.callbacks.after(id);
      });

      // 4. Trigger 'destroy'
      asyncHooks.forEach(h => {
        if (h.enabled && h.callbacks.destroy) h.callbacks.destroy(id);
      });

      currentAsyncId = previousId;
      asyncResourceMap.delete(id);
    }
  }, delay);
};

let asyncIdCounter = 1; // global asyncId counter
const asyncResourceMap = new Map(); // asyncId -> resource info
let currentAsyncId = 0; // currently executing asyncId

/**
 * Generates a new asyncId for a resource
 */
function generateAsyncId() {
  return asyncIdCounter++;
}

/**
 * AsyncHook class
 */
class AsyncHook {
  constructor(callbacks) {
    this.callbacks = callbacks || {};
    this.enabled = false;
  }

  enable() {
    this.enabled = true;
    return this;
  }

  disable() {
    this.enabled = false;
    return this;
  }
}

/**
 * Create a new async hook
 * @param {*} callbacks object { init, before, after, destroy, promiseResolve }
 */
function createHook(callbacks) {
  return new AsyncHook(callbacks);
}

/**
 * Returns the currently executing asyncId
 */
function executionAsyncId() {
  return currentAsyncId;
}

/**
 * Returns the asyncId of the resource that triggered current execution
 */
function triggerAsyncId() {
  const resource = asyncResourceMap.get(currentAsyncId);
  return resource ? resource.triggerAsyncId : 0;
}

/**
 * Wraps a function to track async resource lifecycle
 */
function wrapAsyncResource(fn, type = 'Function', triggerId = currentAsyncId) {
  const id = generateAsyncId();
  const resource = { asyncId: id, type, triggerAsyncId: triggerId };
  asyncResourceMap.set(id, resource);

  // call init hooks
  asyncHooks.forEach(h => {
    if (h.enabled && h.callbacks.init) {
      try { h.callbacks.init(id, type, triggerId, resource); } catch {}
    }
  });

  return async function (...args) {
    const previousId = currentAsyncId;
    currentAsyncId = id;

    // call before hooks
    asyncHooks.forEach(h => {
      if (h.enabled && h.callbacks.before) {
        try { h.callbacks.before(id); } catch {}
      }
    });

    let result;
    try {
      result = await fn(...args);

      // call promiseResolve if function returns a Promise
      asyncHooks.forEach(h => {
        if (h.enabled && h.callbacks.promiseResolve) {
          try { h.callbacks.promiseResolve(id); } catch {}
        }
      });
    } catch (err) {
      throw err;
    } finally {
      // call after hooks
      asyncHooks.forEach(h => {
        if (h.enabled && h.callbacks.after) {
          try { h.callbacks.after(id); } catch {}
        }
      });

      // call destroy hooks
      asyncHooks.forEach(h => {
        if (h.enabled && h.callbacks.destroy) {
          try { h.callbacks.destroy(id); } catch {}
        }
      });

      asyncResourceMap.delete(id);
      currentAsyncId = previousId;
    }

    return result;
  };
}

// Internal: list of all active hooks
const asyncHooks = [];

/**
 * Register a hook globally
 */
function registerHook(hook) {
  asyncHooks.push(hook);
}

/**
 * Utility to wrap a Promise-returning function
 */
function wrapPromise(fn, type = 'Promise', triggerId = currentAsyncId) {
  const wrappedFn = wrapAsyncResource(fn, type, triggerId);
  return wrappedFn();
}

// --- ESM exports ---
export {
  createHook,
  executionAsyncId,
  triggerAsyncId,
  wrapAsyncResource,
  wrapPromise,
  registerHook,
};
