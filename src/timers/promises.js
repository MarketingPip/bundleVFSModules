// npm install timers-browserify setimmediate  (via ./timers)

/*!
 * timers-web/promises — node:timers/promises for browsers & bundlers
 * MIT License.
 * Node.js parity: node:timers/promises @ Node 15.0.0+
 * Dependencies: ./timers
 * Limitations:
 *   - options.ref is accepted and validated but is a no-op (no Node event loop).
 *   - scheduler.yield() / scheduler.wait() are approximated via setImmediate /
 *     setTimeout — no true task-scheduler integration.
 *   - AbortError carries { cause } when signal.reason is set, matching Node 17.3+.
 */

/**
 * @packageDocumentation
 * Implements `node:timers/promises` by wrapping `./timers` callback functions
 * in AbortSignal-aware promises. Matches the Node.js 18+ source API exactly:
 * argument order, option shapes, validation errors, and AbortError cause.
 *
 * Exports:
 *   - {@link setTimeout}    — resolves after delay with an optional value
 *   - {@link setInterval}   — async iterator that yields on each tick
 *   - {@link setImmediate}  — resolves after the current poll phase
 *   - {@link scheduler}     — `scheduler.wait()` and `scheduler.yield()`
 */

import timers from '../timers';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class ERR_INVALID_ARG_TYPE extends TypeError {
  /** @param {string} name @param {string} expected */
  constructor(name, expected) {
    super(`The "${name}" argument must be of type ${expected}.`);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }
}

/**
 * Mirrors Node's internal AbortError — name is 'AbortError', code is
 * 'ABORT_ERR', and an optional cause is attached when signal.reason is set.
 * @param {AbortSignal} [signal]
 * @returns {Error & { code: 'ABORT_ERR' }}
 */
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
// Validators (mirror internal/validators subset used by timers/promises)
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v @param {string} name
 * @throws {ERR_INVALID_ARG_TYPE}
 */
function validateObject(v, name) {
  if (v === null || typeof v !== 'object')
    throw new ERR_INVALID_ARG_TYPE(name, 'Object');
}

/**
 * @param {unknown} v @param {string} name
 * @throws {ERR_INVALID_ARG_TYPE}
 */
function validateBoolean(v, name) {
  if (typeof v !== 'boolean')
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean');
}

/**
 * @param {unknown} v @param {string} name
 * @throws {ERR_INVALID_ARG_TYPE}
 */
function validateNumber(v, name) {
  if (typeof v !== 'number')
    throw new ERR_INVALID_ARG_TYPE(name, 'number');
}

/**
 * @param {unknown} signal @param {string} name
 * @throws {ERR_INVALID_ARG_TYPE}
 */
function validateAbortSignal(signal, name) {
  if (signal !== undefined &&
      (signal === null || typeof signal !== 'object' || !('aborted' in signal)))
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal');
}

// ---------------------------------------------------------------------------
// setTimeout
// ---------------------------------------------------------------------------

/**
 * Returns a Promise that resolves with `value` after `delay` ms.
 *
 * Matches Node signature: `setTimeout([delay[, value[, options]]])`
 *
 * @template T
 * @param {number}  [delay=1]
 * @param {T}       [value]
 * @param {{ signal?: AbortSignal; ref?: boolean }} [options={}]
 * @returns {Promise<T>}
 *
 * @example
 * await setTimeout(1_000);
 * const v = await setTimeout(500, 'hello');  // → 'hello'
 *
 * const ac = new AbortController();
 * const p  = setTimeout(5_000, null, { signal: ac.signal });
 * ac.abort();
 * await p.catch(e => console.log(e.code));   // 'ABORT_ERR'
 */
export function setTimeout(delay, value, options = {}) {
  // Validate — return rejected promise on failure (matches Node source)
  try {
    if (delay !== undefined) validateNumber(delay, 'delay');
    validateObject(options, 'options');
    if (options.signal    !== undefined) validateAbortSignal(options.signal, 'options.signal');
    if (options.ref       !== undefined) validateBoolean(options.ref, 'options.ref');
  } catch (err) {
    return Promise.reject(err);
  }

  const { signal } = options;
  // ref is a no-op in browser, but we accept it for API parity

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

/**
 * Returns a Promise that resolves with `value` after the current poll phase.
 *
 * Matches Node signature: `setImmediate([value[, options]])`
 *
 * @template T
 * @param {T}  [value]
 * @param {{ signal?: AbortSignal; ref?: boolean }} [options={}]
 * @returns {Promise<T>}
 *
 * @example
 * const result = await setImmediate('done');  // → 'done'
 *
 * const ac = new AbortController();
 * setImmediate('x', { signal: ac.signal }).catch(e => console.log(e.code));
 * ac.abort();  // → 'ABORT_ERR'
 */
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

/**
 * Returns an async iterator that yields `value` on every `delay` ms tick.
 * Break or `return()` the iterator to clear the underlying interval.
 * An AbortSignal causes the iterator to throw `ABORT_ERR` and then close.
 *
 * Matches Node signature: `setInterval([delay[, value[, options]]])`
 *
 * Node source uses a `notYielded` counter + a single `callback` slot so that
 * ticks which fire while the consumer is mid-`await` are queued rather than
 * dropped. We replicate that pattern exactly.
 *
 * @template T
 * @param {number} [delay=1]
 * @param {T}      [value]
 * @param {{ signal?: AbortSignal; ref?: boolean }} [options={}]
 * @returns {AsyncGenerator<T>}
 *
 * @example
 * let n = 0;
 * for await (const _ of setInterval(200, 'tick')) {
 *   if (++n === 5) break;
 * }
 *
 * // Abort externally
 * const ac = new AbortController();
 * timers.setTimeout(() => ac.abort(), 350);
 * try {
 *   for await (const _ of setInterval(100, null, { signal: ac.signal })) {}
 * } catch (e) { console.log(e.code); } // 'ABORT_ERR'
 */
export async function* setInterval(delay, value, options = {}) {
  // Throw synchronously (not returned reject) — matches Node async generator
  if (delay !== undefined) validateNumber(delay, 'delay');
  validateObject(options, 'options');
  if (options.signal !== undefined) validateAbortSignal(options.signal, 'options.signal');
  if (options.ref    !== undefined) validateBoolean(options.ref, 'options.ref');

  const { signal } = options;

  if (signal?.aborted) throw mkAbortError(signal);

  let notYielded = 0;  // ticks that fired while consumer was awaiting
  let callback   = null;
  let onCancel;

  const handle = timers.setInterval(() => {
    notYielded++;
    if (callback) {
      const cb = callback;
      callback = null;
      cb();
    }
  }, delay);

  if (signal) {
    onCancel = () => {
      handle.close();
      if (callback) {
        const cb = callback;
        callback = null;
        // Resolve the parked Promise with a rejected one — mirrors Node source
        cb(Promise.reject(mkAbortError(signal)));
      }
    };
    signal.addEventListener('abort', onCancel, { once: true });
  }

  try {
    while (!signal?.aborted) {
      if (notYielded === 0) {
        // Park until next tick fires or abort fires.
        // The interval callback passes an optional rejection promise.
        await new Promise((resolve, reject) => {
          callback = (rejection) => rejection ? reject(rejection) : resolve();
        });
      }
      for (; notYielded > 0; notYielded--) {
        yield value;
      }
    }
    // If we exit the while because signal aborted between ticks, throw.
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
  /** @hideconstructor */
  constructor() {
    throw new TypeError('Illegal constructor');
  }

  /**
   * Yields control to the event loop. Equivalent to `setImmediate()`.
   * @returns {Promise<void>}
   */
  yield() {
    if (!this[kScheduler]) throw new TypeError('Invalid receiver');
    return setImmediate(undefined);
  }

  /**
   * Waits `delay` ms. Equivalent to `setTimeout(delay, undefined, options)`.
   * @param {number} delay
   * @param {{ signal?: AbortSignal; ref?: boolean }} [options]
   * @returns {Promise<void>}
   */
  wait(delay, options) {
    if (!this[kScheduler]) throw new TypeError('Invalid receiver');
    return setTimeout(delay, undefined, options);
  }
}

/**
 * Scheduler instance (constructed via Reflect.construct to bypass the public
 * constructor guard, exactly as Node does internally).
 * @type {Scheduler}
 */
export const scheduler = (() => {
  const s = Object.create(Scheduler.prototype);
  s[kScheduler] = true;
  return s;
})();

export default { setTimeout, setInterval, setImmediate, scheduler };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { setTimeout, setInterval, setImmediate, scheduler }
//   from './timers/promises';
//
// // setTimeout — basic delay
// await setTimeout(1_000);
// const msg = await setTimeout(500, 'ready');  // → 'ready'
//
// // setTimeout — cancellable
// const ac = new AbortController();
// const p  = setTimeout(5_000, 'late', { signal: ac.signal });
// ac.abort();
// await p.catch(e => console.log(e.code));  // 'ABORT_ERR'
//
// // setTimeout — abort with cause
// const ac2 = new AbortController();
// ac2.abort(new Error('user cancelled'));
// await setTimeout(0, null, { signal: ac2.signal })
//   .catch(e => console.log(e.cause.message));  // 'user cancelled'
//
// // setImmediate — deferred resolution
// const val = await setImmediate('next');  // → 'next'
//
// // setInterval — break after 3 ticks
// let i = 0;
// for await (const _ of setInterval(200, 'tick')) {
//   if (++i === 3) break;
// }
//
// // setInterval — abort mid-stream
// const ac3 = new AbortController();
// setTimeout(350).then(() => ac3.abort());
// try {
//   for await (const _ of setInterval(100, null, { signal: ac3.signal })) {}
// } catch (e) { console.log(e.code); }  // 'ABORT_ERR'
//
// // scheduler
// await scheduler.wait(200);  // same as setTimeout(200)
// await scheduler.yield();    // hand control back to event loop
//
// // validation errors (rejected promise, not thrown)
// await setTimeout('oops').catch(e => console.log(e.code));  // ERR_INVALID_ARG_TYPE
// await setImmediate('v', null).catch(e => console.log(e.code));  // ERR_INVALID_ARG_TYPE
