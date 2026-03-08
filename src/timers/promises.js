'use strict';

// --- Custom Error Classes ---

export class ERR_INVALID_ARG_TYPE extends Error {
  constructor(name, expected) {
    super(`${name} must be of type ${expected}`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

export class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
    this.name = 'AbortError';
    this.type = 'AbortError';
  }
}

// --- Validation Helper ---

const validateAbortSignal = (signal, name) => {
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== 'object' || !('aborted' in signal))
  ) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal');
  }
};

// --- Exported Timer Functions ---

/**
 * Promise-based setTimeout
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

  // Simplified using optional chaining as per original TODO
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
        clearTimeout(timeout);
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
 * Promise-based setImmediate
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
        clearImmediate(immediate);
        reject(new AbortError());
      };
      signal.addEventListener('abort', oncancel, { once: true });
    }
  });

  return oncancel !== undefined
    ? ret.finally(() => signal.removeEventListener('abort', oncancel))
    : ret;
}

// Default export for convenience
export default {
  setTimeout,
  setImmediate
};
