/**
 * Hardened timers/promises — Node.js parity for browsers.
 * This version uses unique internal names to prevent recursion crashes.
 */

// 1. CAPTURE & RENAME
// We use "native" prefix to ensure no collision with the exported function names.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);

// Fallback for setImmediate
const nativeSetImmediate = (globalThis.setImmediate || ((fn, ...args) => nativeSetTimeout(fn, 0, ...args))).bind(globalThis);
const nativeClearImmediate = (globalThis.clearImmediate || nativeClearTimeout).bind(globalThis);

// 2. HELPER: ABORT LOGIC
function createAbortError(signal) {
  const error = new Error(signal?.reason || 'The operation was aborted');
  error.name = 'AbortError';
  return error;
}

// 3. EXPORTS
/**
 * Resolves after a delay.
 * Uses nativeSetTimeout internally to avoid calling itself.
 */
export function setTimeout(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      nativeClearTimeout(timerId);
      reject(createAbortError(signal));
    };

    const timerId = nativeSetTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }, delay);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Yields values at intervals.
 * Critical: Uses nativeSetInterval to avoid infinite recursion.
 */
export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw createAbortError(signal);

  const pullQueue = [];
  const pushQueue = [];
  let isDone = false;

  const timerId = nativeSetInterval(() => {
    if (pullQueue.length > 0) {
      pullQueue.shift()(value);
    } else {
      pushQueue.push(value);
    }
  }, delay);

  const cleanup = () => {
    isDone = true;
    nativeClearInterval(timerId);
  };

  try {
    if (signal) {
      signal.addEventListener('abort', cleanup, { once: true });
    }

    while (!isDone) {
      if (signal?.aborted) throw createAbortError(signal);
      
      if (pushQueue.length > 0) {
        yield pushQueue.shift();
      } else {
        yield await new Promise((resolve) => pullQueue.push(resolve));
      }
    }
  } finally {
    cleanup();
  }
}

export function setImmediate(value, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));
  return new Promise((resolve) => {
    nativeSetImmediate(() => resolve(value));
  });
}

export default { setTimeout, setInterval, setImmediate };
