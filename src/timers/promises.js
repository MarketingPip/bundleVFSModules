'use strict';

/**
 * Custom Error for invalid argument types.
 */
class ERR_INVALID_ARG_TYPE extends Error {
  constructor(name, expected) {
    super(`${name} must be of type ${expected}`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

/**
 * Custom Error for operation cancellation.
 */
class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    this.name = 'AbortError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Validates that the provided signal is an AbortSignal.
 */
const validateAbortSignal = (signal, name) => {
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== 'object' || !('aborted' in signal))
  ) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal');
  }
};

/**
 * Promise-based setTimeout with AbortSignal support.
 */
export function setTimeout(after, value, options = {}) {
  if (options === null || typeof options !== 'object') {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('options', 'Object'));
  }

  const { signal, ref = true } = options;

  try {
    validateAbortSignal(signal, 'options.signal');
  } catch (err) {
    return Promise.reject(err);
  }

  if (typeof ref !== 'boolean') {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('options.ref', 'boolean'));
  }

  if (signal?.aborted) {
    return Promise.reject(new AbortError());
  }

  let oncancel;
  const ret = new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => resolve(value), after);

    if (!ref && typeof timeout.unref === 'function') {
      timeout.unref();
    }

    if (signal) {
      oncancel = () => {
        globalThis.clearTimeout(timeout);
        reject(new AbortError());
      };
      signal.addEventListener('abort', oncancel, { once: true });
    }
  });

  return oncancel !== undefined
    ? ret.finally(() => signal.removeEventListener('abort', oncancel))
    : ret;
}

/**
 * Promise-based setImmediate with AbortSignal support.
 */
export function setImmediate(value, options = {}) {
  if (options === null || typeof options !== 'object') {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('options', 'Object'));
  }

  const { signal, ref = true } = options;

  try {
    validateAbortSignal(signal, 'options.signal');
  } catch (err) {
    return Promise.reject(err);
  }

  if (typeof ref !== 'boolean') {
    return Promise.reject(new ERR_INVALID_ARG_TYPE('options.ref', 'boolean'));
  }

  if (signal?.aborted) {
    return Promise.reject(new AbortError());
  }

  let oncancel;
  const ret = new Promise((resolve, reject) => {
    const immediate = globalThis.setImmediate(() => resolve(value));

    if (!ref && typeof immediate.unref === 'function') {
      immediate.unref();
    }

    if (signal) {
      oncancel = () => {
        globalThis.clearImmediate(immediate);
        reject(new AbortError());
      };
      signal.addEventListener('abort', oncancel, { once: true });
    }
  });

  return oncancel !== undefined
    ? ret.finally(() => signal.removeEventListener('abort', oncancel))
    : ret;
}
