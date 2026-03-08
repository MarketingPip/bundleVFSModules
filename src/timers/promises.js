import timers from '../timers.js';

const { setTimeout: _setTimeout, setImmediate: _setImmediate, setInterval: _setInterval } = timers;

// ------------------------------------------------
// AbortError helper
// ------------------------------------------------
function abortError(signal) {
  const err = signal?.reason instanceof Error
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
    const timer = _setTimeout(() => resolve(value), delay);
    return () => timer.close();
  });
}

// ------------------------------------------------
// setImmediate
// ------------------------------------------------
export function setImmediate(value, { signal } = {}) {
  return withAbort(signal, resolve => {
    const id = _setImmediate(() => resolve(value));
    return () => timers.clearImmediate(id);
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

  const interval = _setInterval(() => {
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve(value);
    } else {
      queue.push(value);
    }
  }, delay);

  const onAbort = () => {
    done = true;
    interval.close();
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(abortError(signal));
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done) {
      if (queue.length) yield queue.shift();
      else yield await new Promise((resolve, reject) => { pending = { resolve, reject }; });
    }
  } finally {
    interval.close();
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

export default { setTimeout, setImmediate, setInterval, scheduler };
