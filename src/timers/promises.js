// npm install timers-browserify setimmediate  (via ./timers)

/*!
 * timers-web/promises — node:timers/promises for browsers & bundlers
 * MIT License.
 * Node.js parity: node:timers/promises @ Node 15.0.0+
 * Dependencies: ./timers
 * Limitations:
 *   - .ref() / .unref() on the returned Timeout/Immediate are no-ops.
 *   - scheduler.yield() and scheduler.wait() are approximated (no true
 *     task-scheduler integration available in all browsers).
 */

/**
 * @packageDocumentation
 * Implements `node:timers/promises` by wrapping `./timers` callback functions
 * in AbortSignal-aware promises.
 *
 * Exports:
 *   - {@link setTimeout}    — resolves after delay with an optional value
 *   - {@link setInterval}   — async iterator that yields on each tick
 *   - {@link setImmediate}  — resolves after the current poll phase
 *   - {@link scheduler}     — `scheduler.wait()` and `scheduler.yield()`
 *
 * Note: named exports intentionally shadow the global setTimeout etc. inside
 * this module. The underlying native calls are safely isolated inside
 * ./timers which captures native references at its own evaluation time.
 */

import timers from '../timers.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a rejection for an aborted signal, matching Node's error shape.
 * @param {AbortSignal} signal
 * @returns {Error & { code: 'ABORT_ERR' }}
 */
const abortError = signal =>
  Object.assign(
    signal.reason instanceof Error
      ? signal.reason
      : new Error('The operation was aborted'),
    { code: 'ABORT_ERR' },
  );

/**
 * Guards a Promise executor against an already-aborted signal and wires up
 * a one-shot abort listener.
 *
 * @param {AbortSignal | undefined} signal
 * @param {(reject: (e: Error) => void) => void} onAbort
 * @param {(resolve: Function, reject: Function) => (() => void)} body
 *   Executor body — must return a cleanup fn invoked on settle or abort.
 * @returns {Promise<any>}
 */
function guardedPromise(signal, onAbort, body) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    let cleanup;

    const handleAbort = () => {
      cleanup?.();
      onAbort(reject);
    };

    signal?.addEventListener('abort', handleAbort, { once: true });

    const done = (fn, value) => {
      signal?.removeEventListener('abort', handleAbort);
      fn(value);
    };

    cleanup = body(
      v => done(resolve, v),
      e => done(reject, e),
    );
  });
}

// ---------------------------------------------------------------------------
// setTimeout
// ---------------------------------------------------------------------------

/**
 * Returns a Promise that resolves with `value` after `delay` ms.
 * Delegates the actual scheduling to `timers.setTimeout` whose native
 * reference was captured at module-load time — no risk of self-recursion.
 *
 * @template T
 * @param {number}  [delay=0]
 * @param {T}       [value]           - Value the promise resolves with.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 *
 * @example
 * await setTimeout(1_000);
 * const v = await setTimeout(500, 'hello');  // → 'hello'
 *
 * const ac = new AbortController();
 * setTimeout(2_000, null, { signal: ac.signal });
 * ac.abort();  // → rejects with { code: 'ABORT_ERR' }
 */
export function setTimeout(delay = 0, value, { signal } = {}) {
  return guardedPromise(
    signal,
    reject => reject(abortError(signal)),
    resolve => {
      // timers.setTimeout uses _setTimeout (native, captured at load time).
      // Passing `value` as an extra arg forwards it to the callback — native
      // setTimeout(fn, delay, ...args) calls fn(...args) when it fires.
      const handle = timers.setTimeout(resolve, delay, value);
      return () => handle.close();
    },
  );
}

// ---------------------------------------------------------------------------
// setImmediate
// ---------------------------------------------------------------------------

/**
 * Returns a Promise that resolves with `value` after the current poll phase.
 *
 * @template T
 * @param {T}  [value]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 *
 * @example
 * const result = await setImmediate('done');
 * console.log(result); // 'done'
 */
export function setImmediate(value, { signal } = {}) {
  return guardedPromise(
    signal,
    reject => reject(abortError(signal)),
    resolve => {
      const handle = timers.setImmediate(resolve, value);
      return () => handle.close();
    },
  );
}

// ---------------------------------------------------------------------------
// setInterval — async iterator
// ---------------------------------------------------------------------------

/**
 * Returns an async iterator that yields `value` on every `delay` ms tick.
 * Break or `return()` the iterator to clear the underlying interval.
 * An AbortSignal causes the iterator to throw `ABORT_ERR` and then close.
 *
 * @template T
 * @param {number} [delay=0]
 * @param {T}      [value]
 * @param {{ signal?: AbortSignal }} [options]
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
 *   for await (const _ of setInterval(100, null, { signal: ac.signal })) { }
 * } catch (e) { console.log(e.code); } // 'ABORT_ERR'
 */
export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal);

  // Small queue: ticks that fire while the consumer is busy are buffered
  // rather than dropped — matches Node's back-pressure behaviour.
  const queue = [];
  let pending = null; // resolve fn for the currently parked await, if any
  let done    = false;
  let error   = null;

  const enqueue = () => {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(value);
    } else {
      queue.push(value);
    }
  };

  const handle = timers.setInterval(enqueue, delay);

  const onAbort = () => {
    handle.close();
    error = abortError(signal);
    done  = true;
    if (pending) {
      const reject = pending;
      pending = null;
      // We stored a resolve but need to reject — use a small wrapper below.
      reject(Promise.reject(error));
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      // Park until the next tick enqueues a value (or abort fires).
      yield await new Promise((resolve, reject) => {
        pending = v => {
          // v may be a rejected promise if abort fired
          if (v && typeof v.then === 'function') v.then(resolve, reject);
          else resolve(v);
        };
      });
    }
  } finally {
    handle.close();
    signal?.removeEventListener('abort', onAbort);
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

/**
 * Minimal `scheduler` object matching the node:timers/promises scheduler API.
 *
 * - `scheduler.wait(delay, options?)` — alias for {@link setTimeout}
 * - `scheduler.yield()`              — yields control via setImmediate
 */
export const scheduler = {
  /**
   * @param {number} delay
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<void>}
   */
  wait: (delay, options) => setTimeout(delay, undefined, options),

  /**
   * Yields control to the event loop, allowing other tasks to run.
   * @returns {Promise<void>}
   */
  yield: () => setImmediate(undefined),
};

export default { setTimeout, setInterval, setImmediate, scheduler };

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import { setTimeout, setInterval, setImmediate, scheduler }
//   from './timers/promises';
//
// // Basic — these now work without stack overflow
// await setTimeout(1_000);
// const msg = await setTimeout(500, 'ready');  // → 'ready'
//
// // Cancellable setTimeout
// const ac = new AbortController();
// const p  = setTimeout(5_000, 'late', { signal: ac.signal });
// ac.abort();
// await p.catch(e => console.log(e.code));  // 'ABORT_ERR'
//
// // setImmediate
// const val = await setImmediate('next');   // → 'next'
//
// // setInterval async iterator — break after 3 ticks
// let i = 0;
// for await (const _ of setInterval(200)) {
//   if (++i === 3) break;
// }
//
// // scheduler
// await scheduler.wait(200);
// await scheduler.yield();
