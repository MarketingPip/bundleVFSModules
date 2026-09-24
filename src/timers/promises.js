// node:timers/promises — ported from Node v24.20.0 lib/timers/promises.js.
//
// Dependency-free ESM, browser-safe. The callback-based timers are imported
// from '../timers.js' (explicit extension: 'timers' is both a file and a
// directory under src/). Under Node.js the wrappers delegate to the native
// timers, so delay clamping, TimeoutNaNWarning/TimeoutOverflowWarning and
// ref/unref semantics are exact.

import {
  setTimeout as cbSetTimeout,
  setInterval as cbSetInterval,
  setImmediate as cbSetImmediate,
  clearTimeout as cbClearTimeout,
  clearInterval as cbClearInterval,
  clearImmediate as cbClearImmediate,
} from '../timers.js';
import {
  AbortError,
  ERR_ILLEGAL_CONSTRUCTOR,
  ERR_INVALID_THIS,
  validateAbortSignal,
  validateBoolean,
  validateNumber,
  validateObject,
} from './errors.js';

// ---------------------------------------------------------------------------
// ESM/CJS interop marker.
//
// Node's require(esm) synthesizes an `__esModule: true` export on the
// namespace it hands to CJS consumers, so `require('timers/promises')`
// always carries it. Re-exporting it here (a no-op for ESM importers, and
// the standard transpiler interop flag) keeps the ESM namespace deep-equal
// to the CJS require-view, which is what the official
// test-timers-promises.js asserts:
//   assert.deepStrictEqual(require('node:timers/promises'),
//                          require('node:timers').promises)
// ---------------------------------------------------------------------------
// NOTE: intentionally NOT a named export — real node:timers/promises ESM
// namespace has no __esModule key (require(esm) synthesizes it on the CJS
// side only). Kept as a local for the default-export interop below.
const __esModule = true;

// ---------------------------------------------------------------------------
// setTimeout
// ---------------------------------------------------------------------------

export function setTimeout(after, value, options = {}) {
  try {
    if (after !== undefined) {
      validateNumber(after, 'delay');
    }
    validateObject(options, 'options');
    if (options.signal !== undefined) {
      validateAbortSignal(options.signal, 'options.signal');
    }
    if (options.ref !== undefined) {
      validateBoolean(options.ref, 'options.ref');
    }
  } catch (err) {
    return Promise.reject(err);
  }

  const { signal, ref = true } = options;

  if (signal?.aborted) {
    return Promise.reject(new AbortError(undefined, { cause: signal.reason }));
  }

  let oncancel;
  let doResolve;
  let doReject;
  const promise = new Promise((resolve, reject) => {
    doResolve = resolve;
    doReject = reject;
  });
  const timeout = cbSetTimeout(doResolve, after, value);
  if (!ref) timeout.unref();
  if (signal) {
    oncancel = () => {
      cbClearTimeout(timeout);
      doReject(new AbortError(undefined, { cause: signal.reason }));
    };
    signal.addEventListener('abort', oncancel);
  }
  return oncancel !== undefined
    ? promise.finally(() => signal.removeEventListener('abort', oncancel))
    : promise;
}

// ---------------------------------------------------------------------------
// setImmediate
// ---------------------------------------------------------------------------

export function setImmediate(value, options = {}) {
  try {
    validateObject(options, 'options');
    if (options.signal !== undefined) {
      validateAbortSignal(options.signal, 'options.signal');
    }
    if (options.ref !== undefined) {
      validateBoolean(options.ref, 'options.ref');
    }
  } catch (err) {
    return Promise.reject(err);
  }

  const { signal, ref = true } = options;

  if (signal?.aborted) {
    return Promise.reject(new AbortError(undefined, { cause: signal.reason }));
  }

  let oncancel;
  let doResolve;
  let doReject;
  const promise = new Promise((resolve, reject) => {
    doResolve = resolve;
    doReject = reject;
  });
  const immediate = cbSetImmediate(doResolve, value);
  if (!ref) immediate.unref();
  if (signal) {
    oncancel = () => {
      cbClearImmediate(immediate);
      doReject(new AbortError(undefined, { cause: signal.reason }));
    };
    signal.addEventListener('abort', oncancel);
  }
  return oncancel !== undefined
    ? promise.finally(() => signal.removeEventListener('abort', oncancel))
    : promise;
}

// ---------------------------------------------------------------------------
// setInterval — async iterator
// ---------------------------------------------------------------------------

export async function* setInterval(after, value, options = {}) {
  if (after !== undefined) {
    validateNumber(after, 'delay');
  }
  validateObject(options, 'options');
  if (options.signal !== undefined) {
    validateAbortSignal(options.signal, 'options.signal');
  }
  if (options.ref !== undefined) {
    validateBoolean(options.ref, 'options.ref');
  }

  const { signal, ref = true } = options;

  if (signal?.aborted) {
    throw new AbortError(undefined, { cause: signal.reason });
  }

  let onCancel;
  let interval;
  try {
    let notYielded = 0;
    let callback;
    interval = cbSetInterval(() => {
      notYielded++;
      if (callback) {
        const cb = callback;
        callback = undefined;
        cb();
      }
    }, after);
    if (!ref) interval.unref();
    if (signal) {
      onCancel = () => {
        cbClearInterval(interval);
        if (callback) {
          const cb = callback;
          callback = undefined;
          // Resolve the parked promise with a rejected one so the `await`
          // below throws the AbortError (mirrors Node's implementation).
          cb(Promise.reject(new AbortError(undefined, { cause: signal.reason })));
        }
      };
      signal.addEventListener('abort', onCancel, { once: true });
    }

    while (!signal?.aborted) {
      if (notYielded === 0) {
        await new Promise((resolve) => {
          callback = resolve;
        });
      }
      for (; notYielded > 0; notYielded--) {
        yield value;
      }
    }
    throw new AbortError(undefined, { cause: signal?.reason });
  } finally {
    if (interval !== undefined) cbClearInterval(interval);
    signal?.removeEventListener('abort', onCancel);
  }
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

const kScheduler = Symbol('kScheduler');

class Scheduler {
  constructor() {
    throw ERR_ILLEGAL_CONSTRUCTOR();
  }

  yield() {
    if (!this[kScheduler]) throw ERR_INVALID_THIS('Scheduler');
    return setImmediate();
  }

  wait(delay, options) {
    if (!this[kScheduler]) throw ERR_INVALID_THIS('Scheduler');
    return setTimeout(delay, undefined, options);
  }
}

export const scheduler = Reflect.construct(
  function () {
    this[kScheduler] = true;
  },
  [],
  Scheduler,
);

export default { setTimeout, setInterval, setImmediate, scheduler, __esModule };
