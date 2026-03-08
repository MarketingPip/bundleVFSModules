'use strict'

// --- Errors & Validators ---

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    super(`The "${name}" argument must be of type ${expected}. Received ${typeof actual}`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = {}) {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
    if (options.cause) this.cause = options.cause;
  }
}

const validateObject = (value, name) => {
  if (value === null || typeof value !== 'object') {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
}

const validateBoolean = (value, name) => {
  if (typeof value !== 'boolean') {
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
  }
}

const validateNumber = (value, name) => {
  if (typeof value !== 'number') {
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
  }
}

const validateAbortSignal = (signal, name) => {
  if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
}

// --- PromiseWithResolvers Helper ---

const promiseWithResolvers = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej });
  return { promise, resolve, reject };
}

// --- Timer Promises ---

export function setTimeoutPromise(after, value, options = {}) {
  try {
    if (after !== undefined) validateNumber(after, 'delay');
    validateObject(options, 'options');
    if (options.signal !== undefined) validateAbortSignal(options.signal, 'options.signal');
    if (options.ref !== undefined) validateBoolean(options.ref, 'options.ref');
  } catch (err) {
    return Promise.reject(err);
  }

  const { signal, ref = true } = options;

  if (signal?.aborted) {
    return Promise.reject(new AbortError(undefined, { cause: signal.reason }));
  }

  const { promise, resolve, reject } = promiseWithResolvers();
  const timerId = globalThis.setTimeout(() => resolve(value), after);

  // Node.js supports ref/unref; noop in browsers
  if (!ref && timerId.unref) timerId.unref?.();

  let oncancel;
  if (signal) {
    oncancel = () => {
      clearTimeout(timerId);
      reject(new AbortError(undefined, { cause: signal.reason }));
    }
    signal.addEventListener('abort', oncancel, { once: true });
  }

  return oncancel ? promise.finally(() => signal.removeEventListener('abort', oncancel)) : promise;
}

export function setImmediatePromise(value, options = {}) {
  try {
    validateObject(options, 'options');
    if (options.signal !== undefined) validateAbortSignal(options.signal, 'options.signal');
    if (options.ref !== undefined) validateBoolean(options.ref, 'options.ref');
  } catch (err) {
    return Promise.reject(err);
  }

  const { signal, ref = true } = options;

  if (signal?.aborted) {
    return Promise.reject(new AbortError(undefined, { cause: signal.reason }));
  }

  const { promise, resolve, reject } = promiseWithResolvers();
  const immediateId = globalThis.setTimeout(() => resolve(value), 0);

  if (!ref && immediateId.unref) immediateId.unref?.();

  let oncancel;
  if (signal) {
    oncancel = () => {
      clearTimeout(immediateId);
      reject(new AbortError(undefined, { cause: signal.reason }));
    }
    signal.addEventListener('abort', oncancel, { once: true });
  }

  return oncancel ? promise.finally(() => signal.removeEventListener('abort', oncancel)) : promise;
}

export async function* setIntervalPromise(after, value, options = {}) {
  if (after !== undefined) validateNumber(after, 'delay');
  validateObject(options, 'options');
  if (options.signal !== undefined) validateAbortSignal(options.signal, 'options.signal');

  const { signal, ref = true } = options;
  if (signal?.aborted) throw new AbortError(undefined, { cause: signal.reason });

  let callback;
  let notYielded = 0;
  const intervalId = globalThis.setInterval(() => {
    notYielded++;
    if (callback) { callback(); callback = undefined; }
  }, after);

  if (!ref && intervalId.unref) intervalId.unref?.();

  const cancel = () => {
    clearInterval(intervalId);
    if (callback) {
      callback(Promise.reject(new AbortError(undefined, { cause: signal?.reason })));
      callback = undefined;
    }
  };

  if (signal) signal.addEventListener('abort', cancel, { once: true });

  try {
    while (!signal?.aborted) {
      if (notYielded === 0) await new Promise(res => callback = res);
      while (notYielded > 0) { notYielded--; yield value; }
    }
    throw new AbortError(undefined, { cause: signal?.reason });
  } finally {
    clearInterval(intervalId);
    signal?.removeEventListener('abort', cancel);
  }
}

// --- Scheduler API ---

const kScheduler = Symbol('kScheduler');

export class Scheduler {
  constructor(secret) {
    if (secret !== kScheduler) throw new TypeError('Illegal constructor');
    this[kScheduler] = true;
  }

  yield() {
    if (!this[kScheduler]) throw new TypeError('Invalid this for Scheduler');
    return setImmediatePromise();
  }

  wait(delay, options) {
    if (!this[kScheduler]) throw new TypeError('Invalid this for Scheduler');
    return setTimeoutPromise(delay, undefined, options);
  }
}

export const scheduler = new Scheduler(kScheduler);
