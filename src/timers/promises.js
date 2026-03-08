'use strict';

class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

// Browser-safe setTimeout
export function setTimeout(after, value, options = {}) {
  const { signal } = options;

  if (signal?.aborted) {
    return Promise.reject(new AbortError());
  }

  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(value), after);

    if (signal) {
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(new AbortError());
      }, { once: true });
    }
  });
}

// Browser-safe "Immediate" (using 0ms delay)
export function setImmediate(value, options = {}) {
  return setTimeout(0, value, options);
}
