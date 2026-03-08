/*!
 * timers/promises — node:timers/promises for browsers
 * Built on top of timers-browserify
 */

import timers from 'timers-browserify';

const {
  setTimeout: _setTimeout,
  clearTimeout: _clearTimeout,
  setInterval: _setInterval,
  clearInterval: _clearInterval,
  setImmediate: _setImmediate,
  clearImmediate: _clearImmediate
} = timers;

// ------------------------------------------------
// AbortError helper
// ------------------------------------------------

function abortError(signal) {
  const err =
    signal?.reason instanceof Error
      ? signal.reason
      : new Error('The operation was aborted');

  err.code = 'ABORT_ERR';
  return err;
}

// ------------------------------------------------
// Abort wrapper
// ------------------------------------------------

function withAbort(signal, body) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    let cancel = () => {};

    const onAbort = () => {
      cancel();
      reject(abortError(signal));
    };

    cancel = body(
      value => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      }
    );

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ------------------------------------------------
// setTimeout
// ------------------------------------------------

export function setTimeout(delay = 0, value, { signal } = {}) {
  return withAbort(signal, resolve => {
    const id = _setTimeout(() => resolve(value), delay);

    return () => _clearTimeout(id);
  });
}

// ------------------------------------------------
// setImmediate
// ------------------------------------------------

export function setImmediate(value, { signal } = {}) {
  return withAbort(signal, resolve => {
    const id = _setImmediate(() => resolve(value));

    return () => _clearImmediate(id);
  });
}

// ------------------------------------------------
// setInterval async iterator
// ------------------------------------------------

export async function* setInterval(delay = 0, value, { signal } = {}) {

  if (signal?.aborted) throw abortError(signal);

  const queue = [];
  let pending = null;
  let done = false;

  const tick = () => {
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve(value);
    } else {
      queue.push(value);
    }
  };

  const id = _setInterval(tick, delay);

  const onAbort = () => {
    done = true;
    _clearInterval(id);

    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(abortError(signal));
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }

      yield await new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    }
  } finally {
    _clearInterval(id);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ------------------------------------------------
// scheduler
// ------------------------------------------------

export const scheduler = {
  wait: (delay, options) => setTimeout(delay, undefined, options),
  yield: () => setImmediate()
};

export default {
  setTimeout,
  setImmediate,
  setInterval,
  scheduler
};
