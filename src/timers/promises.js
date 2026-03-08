'use strict';

// Custom error classes for handling invalid argument types and abortion
class ERR_INVALID_ARG_TYPE extends Error {
  constructor(name, expected) {
    super(`${name} must be of type ${expected}`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

class AbortError extends Error {
  constructor(message) {
    super(message);
    this.type = 'AbortError';
    Error.captureStackTrace(this, this.constructor);
  }
}

// Helper function to validate AbortSignal
const validateAbortSignal = (signal, name) => {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal');
  }
};

// `setTimeout` implementation with Promise support
function promisesSetTimeout(after, value, options = {}) {
  if (typeof after !== 'number' || after < 0) {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('after', 'number'));
  }

  if (options && typeof options !== 'object') {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('options', 'object'));
  }

  const { signal, ref = true } = options;

  if (signal) {
    validateAbortSignal(signal, 'options.signal');
    if (signal.aborted) {
      return Promise.reject(new AbortError('The operation was aborted.'));
    }
  }

  let oncancel;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(value);
    }, after);

    if (!ref) timeout.unref();

    if (signal) {
      oncancel = () => {
        clearTimeout(timeout);
        reject(new AbortError('The operation was aborted.'));
      };
      signal.addEventListener('abort', oncancel);
    }
  });

  return oncancel
    ? promise.finally(() => signal.removeEventListener('abort', oncancel))
    : promise;
}

// `setImmediate` implementation with Promise support
function promisesSetImmediate(value, options = {}) {
  if (options && typeof options !== 'object') {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('options', 'object'));
  }

  const { signal, ref = true } = options;

  if (signal) {
    validateAbortSignal(signal, 'options.signal');
    if (signal.aborted) {
      return Promise.reject(new AbortError('The operation was aborted.'));
    }
  }

  let oncancel;
  const promise = new Promise((resolve, reject) => {
    const immediate = setImmediate(() => {
      resolve(value);
    });

    if (!ref) immediate.unref();

    if (signal) {
      oncancel = () => {
        clearImmediate(immediate);
        reject(new AbortError('The operation was aborted.'));
      };
      signal.addEventListener('abort', oncancel);
    }
  });

  return oncancel
    ? promise.finally(() => signal.removeEventListener('abort', oncancel))
    : promise;
}

// `setInterval` implementation with Promise support
function promisesSetInterval(after, value, options = {}) {
  if (typeof after !== 'number' || after < 0) {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('after', 'number'));
  }

  if (options && typeof options !== 'object') {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('options', 'object'));
  }

  const { signal, ref = true } = options;

  if (signal) {
    validateAbortSignal(signal, 'options.signal');
    if (signal.aborted) {
      return Promise.reject(new AbortError('The operation was aborted.'));
    }
  }

  let oncancel;
  const promise = new Promise((resolve, reject) => {
    let interval;
    let iterationCount = 0;

    const intervalHandler = () => {
      iterationCount++;
      resolve(value);

      if (signal && signal.aborted) {
        clearInterval(interval);
        reject(new AbortError('The operation was aborted.'));
      }
    };

    interval = setInterval(intervalHandler, after);

    if (!ref) interval.unref();

    if (signal) {
      oncancel = () => {
        clearInterval(interval);
        reject(new AbortError('The operation was aborted.'));
      };
      signal.addEventListener('abort', oncancel);
    }
  });

  return oncancel
    ? promise.finally(() => signal.removeEventListener('abort', oncancel))
    : promise;
}

// Custom scheduler class (a simple abstraction for now)
const kScheduler = Symbol('kScheduler');

class Scheduler {
  constructor() {
    this[kScheduler] = true;
  }

  yield() {
    return promisesSetImmediate();
  }

  wait(delay, options) {
    return promisesSetTimeout(delay, undefined, options);
  }
}

// ES6 Exporting the functions
export { promisesSetTimeout as setTimeout };
export { promisesSetImmediate as setImmediate };
export { promisesSetInterval as setInterval };
export const scheduler = new Scheduler();
