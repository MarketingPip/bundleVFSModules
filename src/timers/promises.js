'use strict';

class ERR_INVALID_ARG_TYPE extends Error {
  constructor(name, expected) {
    super(`${name} must be of type ${expected}`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.type = 'AbortError';
  }
}

const validateAbortSignal = (signal, name) => {
  if (
    signal !== undefined &&
    (signal === null || typeof signal !== 'object' || !('aborted' in signal))
  ) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal');
  }
};

const promisesSetTimeout = (after, value, options = {}) => {
  const args = value !== undefined ? [value] : [];
  if (!options || typeof options !== 'object') {
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
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(value), after, ...args);
    if (!ref) timeout.unref?.();

    if (signal) {
      oncancel = () => {
        clearTimeout(timeout);
        reject(new AbortError());
      };
      signal.addEventListener('abort', oncancel);
    }
  });

  return oncancel ? promise.finally(() => signal.removeEventListener('abort', oncancel)) : promise;
};

const promisesSetImmediate = (value, options = {}) => {
  if (!options || typeof options !== 'object') {
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
  const promise = new Promise((resolve, reject) => {
    const immediate = setImmediate(() => resolve(value));
    if (!ref) immediate.unref?.();

    if (signal) {
      oncancel = () => {
        clearImmediate(immediate);
        reject(new AbortError());
      };
      signal.addEventListener('abort', oncancel);
    }
  });

  return oncancel ? promise.finally(() => signal.removeEventListener('abort', oncancel)) : promise;
};

export { promisesSetTimeout as setTimeout, promisesSetImmediate as setImmediate };
