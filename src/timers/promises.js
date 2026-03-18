import timers from '../timers';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected) {
    super(`The "${name}" argument must be of type ${expected}.`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

function mkAbortError(signal) {
  const cause = signal?.reason;
  const msg   = 'The operation was aborted';
  const err   = cause !== undefined
    ? new Error(msg, { cause })
    : new Error(msg);
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateObject(v, name) {
  if (v === null || typeof v !== 'object') throw new ERR_INVALID_ARG_TYPE(name, 'Object');
}

function validateBoolean(v, name) {
  if (typeof v !== 'boolean') throw new ERR_INVALID_ARG_TYPE(name, 'boolean');
}

function validateNumber(v, name) {
  if (typeof v !== 'number') throw new ERR_INVALID_ARG_TYPE(name, 'number');
}

function validateAbortSignal(signal, name) {
  if (signal !== undefined &&
      (signal === null || typeof signal !== 'object' || !('aborted' in signal)))
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal');
}

// ---------------------------------------------------------------------------
// setTimeout
// ---------------------------------------------------------------------------

export function setTimeout(delay, value, options = {}) {
  try {
    if (delay !== undefined) validateNumber(delay, 'delay');
    validateObject(options, 'options');
    if (options.signal    !== undefined) validateAbortSignal(options.signal, 'options.signal');
    if (options.ref       !== undefined) validateBoolean(options.ref, 'options.ref');
  } catch (err) {
    return Promise.reject(err);
  }

  const { signal } = options;
  if (signal?.aborted) return Promise.reject(mkAbortError(signal));

  let oncancel;
  const ret = new Promise((resolve, reject) => {
    const handle = timers.setTimeout(resolve, delay, value);
    if (signal) {
      oncancel = () => {
        handle.close();
        reject(mkAbortError(signal));
      };
      signal.addEventListener('abort', oncancel, { once: true });
    }
  });

  return oncancel !== undefined
    ? ret.finally(() => signal.removeEventListener('abort', oncancel))
    : ret;
}

// ---------------------------------------------------------------------------
// setImmediate
// ---------------------------------------------------------------------------

export function setImmediate(value, options = {}) {
  try {
    validateObject(options, 'options');
    if (options.signal !== undefined) validateAbortSignal(options.signal, 'options.signal');
    if (options.ref    !== undefined) validateBoolean(options.ref, 'options.ref');
  } catch (err) {
    return Promise.reject(err);
  }

  const { signal } = options;
  if (signal?.aborted) return Promise.reject(mkAbortError(signal));

  let oncancel;
  const ret = new Promise((resolve, reject) => {
    const handle = timers.setImmediate(resolve, value);
    if (signal) {
      oncancel = () => {
        handle.close();
        reject(mkAbortError(signal));
      };
      signal.addEventListener('abort', oncancel, { once: true });
    }
  });

  return oncancel !== undefined
    ? ret.finally(() => signal.removeEventListener('abort', oncancel))
    : ret;
}

// ---------------------------------------------------------------------------
// setInterval — async iterator
// ---------------------------------------------------------------------------

export async function* setInterval(delay, value, options = {}) {
  if (delay !== undefined) validateNumber(delay, 'delay');
  validateObject(options, 'options');
  if (options.signal !== undefined) validateAbortSignal(options.signal, 'options.signal');
  if (options.ref    !== undefined) validateBoolean(options.ref, 'options.ref');

  const { signal } = options;
  if (signal?.aborted) throw mkAbortError(signal);

  let notYielded = 0;
  let callback = null;
  let onCancel;

  const handle = timers.setInterval(() => {
    notYielded++;
    if (callback) {
      const cb = callback;
      callback = null;
      cb(); // resolve the parked Promise
    }
  }, delay);

  if (signal) {
    onCancel = () => {
      handle.close();
      if (callback) {
        const cb = callback;
        callback = null;
        cb(mkAbortError(signal)); // pass error directly
      }
    };
    signal.addEventListener('abort', onCancel, { once: true });
  }

  try {
    while (!signal?.aborted) {
      if (notYielded === 0) {
        await new Promise((resolve, reject) => {
          callback = (err) => err ? reject(err) : resolve();
        });
      }
      for (; notYielded > 0; notYielded--) yield value;
    }
    throw mkAbortError(signal);
  } finally {
    handle.close();
    signal?.removeEventListener('abort', onCancel);
  }
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

const kScheduler = Symbol('kScheduler');

class Scheduler {
  constructor() {
    throw new TypeError('Illegal constructor');
  }

  yield() {
    if (!this[kScheduler]) throw new TypeError('Invalid receiver');
    return setImmediate(undefined);
  }

  wait(delay, options) {
    if (!this[kScheduler]) throw new TypeError('Invalid receiver');
    // Call underlying timers callback-based setTimeout
    return new Promise((resolve, reject) => {
      let handle;
      try {
        handle = timers.setTimeout(resolve, delay, undefined);
      } catch (err) {
        return reject(err);
      }

      if (options?.signal) {
        const onCancel = () => {
          handle.close();
          reject(mkAbortError(options.signal));
        };
        options.signal.addEventListener('abort', onCancel, { once: true });
        return handle;
      }
    });
  }
}

export const scheduler = (() => {
  const s = Object.create(Scheduler.prototype);
  s[kScheduler] = true;
  return s;
})();

export default { setTimeout, setInterval, setImmediate, scheduler };
