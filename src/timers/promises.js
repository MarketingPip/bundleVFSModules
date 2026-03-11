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
 */

import timers from '../timers';

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
 * a one-shot abort listener that fires `onAbort`.
 *
 * @param {AbortSignal | undefined} signal
 * @param {(reject: (e: Error) => void) => void} onAbort  - called with reject on abort
 * @param {(resolve: Function, reject: Function) => (() => void)} body
 *   - executor body; must return a cleanup fn (called after settle or abort)
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
 * Passing an AbortSignal lets the caller cancel the pending timer.
 *
 * @template T
 * @param {number}  [delay=0]
 * @param {T}       [value]           - Value the promise resolves with.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 *
 * @example
 * await setTimeout(1_000);                          // wait 1 s
 * const v = await setTimeout(500, 'hello');         // resolves 'hello'
 *
 * const ac = new AbortController();
 * setTimeout(2_000, null, { signal: ac.signal });
 * ac.abort();  // → rejects with { code: 'ABORT_ERR' }
 */
export function setTimeout(delay = 0, value, { signal } = {}) {
  return guardedPromise(
    signal,
    reject => reject(abortError(signal)),
    (resolve) => {
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
    (resolve) => {
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
 * // Consume 5 ticks then stop
 * let n = 0;
 * for await (const _ of setInterval(200, 'tick')) {
 *   console.log(++n);
 *   if (n === 5) break;
 * }
 *
 * // Abort externally
 * const ac = new AbortController();
 * (async () => {
 *   try {
 *     for await (const _ of setInterval(100, null, { signal: ac.signal })) { }
 *   } catch (e) { console.log(e.code); } // 'ABORT_ERR'
 * })();
 * setTimeout(() => ac.abort(), 350);
 */
export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal);

  // A small queue so ticks that fire while the consumer is awaiting its
  // own work don't get lost — matches Node's back-pressure behaviour.
  const queue   = [];
  let resolve   = null;
  let done      = false;
  let error     = null;

  const enqueue = v => {
    if (resolve) { const r = resolve; resolve = null; r({ value: v, done: false }); }
    else queue.push(v);
  };

  const handle = timers.setInterval(() => enqueue(value), delay);

  const onAbort = () => {
    handle.close();
    error = abortError(signal);
    done  = true;
    if (resolve) { const r = resolve; resolve = null; r(Promise.reject(error)); }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done) {
      if (queue.length) { yield queue.shift(); continue; }
      // Park until the next tick or abort.
      const next = await new Promise(r => { resolve = r; });
      if (next.done) break;
      yield next.value;
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
 * - `scheduler.yield()`              — yields control, resuming on next
 *   task (approximated via setImmediate → setTimeout(0) fallback).
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
   * Resolves on the next available microtask/macrotask boundary.
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
// // setImmediate — deferred microtask
// const val = await setImmediate('next');   // → 'next'
//
// // setInterval — async iterator, break after 3 ticks
// let i = 0;
// for await (const tick of setInterval(200, i++)) {
//   console.log(tick);   // 0, 1, 2
//   if (i === 3) break;
// }
//
// // setInterval — abort mid-stream
// const ac2 = new AbortController();
// timers.setTimeout(() => ac2.abort(), 350);
// try {
//   for await (const _ of setInterval(100, null, { signal: ac2.signal })) { }
// } catch (e) { console.log(e.code); }  // 'ABORT_ERR'
//
// // scheduler
// await scheduler.wait(200);   // same as setTimeout(200)
// await scheduler.yield();     // hand control back to event loop
