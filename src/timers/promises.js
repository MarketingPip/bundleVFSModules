// npm install setimmediate  (via ./timers)

/*!
 * timers-web/promises — node:timers/promises for browsers & bundlers
 * MIT License.
 * Node.js parity: node:timers/promises @ Node 15.0.0+
 * Dependencies: ./timers
 * Limitations:
 *   - .ref() / .unref() on Timeout/Immediate handles are no-ops.
 *   - scheduler.yield() approximated via setImmediate.
 */

/**
 * @packageDocumentation
 * Implements `node:timers/promises` using the captured native references
 * exported by `./timers`.
 *
 * Key design: promise bodies schedule via the raw `_setTimeout` /
 * `_setImmediate` / `_setInterval` captures exported from `./timers` —
 * NOT through the `Timeout`-wrapping exports. This avoids the extra
 * indirection layer that caused timers to silently never fire in bundled
 * environments where `globalThis.setTimeout` had already been shadowed by
 * our own export by the time the wrapper was called.
 */

import timers, {
  _setTimeout, _clearTimeout,
  _setInterval, _clearInterval,
  _setImmediate, _clearImmediate,
} from '../timers';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds an AbortError matching Node's shape.
 * @param {AbortSignal} signal
 * @returns {Error & { code: 'ABORT_ERR' }}
 */
const abortError = signal =>
  Object.assign(
    signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'),
    { code: 'ABORT_ERR' },
  );

/**
 * Wraps a simple cancel-on-abort pattern into a Promise.
 * `body` receives `(resolve, reject)` and returns a cancel function.
 * @param {AbortSignal | undefined} signal
 * @param {(resolve: Function, reject: Function) => () => void} body
 * @returns {Promise<any>}
 */
function withAbort(signal, body) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    const cancel = body(resolve, reject);

    signal?.addEventListener('abort', function onAbort() {
      cancel();
      reject(abortError(signal));
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// setTimeout
// ---------------------------------------------------------------------------

/**
 * Resolves with `value` after `delay` ms.
 *
 * Uses `_setTimeout` — the native reference captured at `./timers` load time,
 * guaranteed to be the real browser/Node setTimeout regardless of what any
 * bundler may have replaced on `globalThis` since then.
 *
 * @template T
 * @param {number} [delay=0]
 * @param {T} [value]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 *
 * @example
 * await setTimeout(2000);
 * const msg = await setTimeout(1000, 'hello');  // → 'hello'
 */
export function setTimeout(delay = 0, value, { signal } = {}) {
  return withAbort(signal, (resolve, reject) => {
    // Schedule directly on the captured native — no Timeout wrapper involved.
    // The native will call resolve(value) after delay ms.
    const id = _setTimeout(resolve, delay, value);
    return () => _clearTimeout(id);
  });
}

// ---------------------------------------------------------------------------
// setImmediate
// ---------------------------------------------------------------------------

/**
 * Resolves with `value` after the current poll phase.
 *
 * @template T
 * @param {T} [value]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T>}
 *
 * @example
 * const result = await setImmediate('done');  // → 'done'
 */
export function setImmediate(value, { signal } = {}) {
  return withAbort(signal, (resolve) => {
    const id = _setImmediate(resolve, value);
    return () => _clearImmediate(id);
  });
}

// ---------------------------------------------------------------------------
// setInterval — async iterator
// ---------------------------------------------------------------------------

/**
 * Async iterator that yields `value` on every `delay` ms tick.
 * Break or `return()` the iterator to clear the underlying interval.
 * An AbortSignal causes the iterator to throw `ABORT_ERR` and close.
 *
 * @template T
 * @param {number} [delay=0]
 * @param {T} [value]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<T>}
 *
 * @example
 * let n = 0;
 * for await (const _ of setInterval(200, 'tick')) {
 *   if (++n === 5) break;
 * }
 */
export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal);

  // Queue buffers ticks that fire while the consumer is busy.
  const queue  = [];
  let pending  = null; // { resolve, reject } for the parked await
  let done     = false;
  let abortErr = null;

  const tick = () => {
    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve(value);
    } else {
      queue.push(value);
    }
  };

  const onAbort = () => {
    abortErr = abortError(signal);
    done = true;
    _clearInterval(id);
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(abortErr);
    }
  };

  // Use _setInterval from ./timers — the captured native.
  const id = _setInterval(tick, delay);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done) {
      if (queue.length) { yield queue.shift(); continue; }
      yield await new Promise((resolve, reject) => { pending = { resolve, reject }; });
    }
  } finally {
    _clearInterval(id);
    signal?.removeEventListener('abort', onAbort);
    if (abortErr) throw abortErr;
  }
}

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

/**
 * Minimal `scheduler` matching `node:timers/promises`.
 * - `scheduler.wait(delay, options?)` — alias for {@link setTimeout}
 * - `scheduler.yield()`              — yields to the event loop
 */
export const scheduler = {
  /** @param {number} delay @param {{ signal?: AbortSignal }} [options] */
  wait: (delay, options) => setTimeout(delay, undefined, options),
  /** @returns {Promise<void>} */
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
// // These now resolve correctly
// await setTimeout(2000);
// const msg = await setTimeout(1000, 'hello after 1 second');
// console.log(msg); // 'hello after 1 second'
//
// // Cancellable
// const ac = new AbortController();
// const p  = setTimeout(5_000, 'late', { signal: ac.signal });
// ac.abort();
// await p.catch(e => console.log(e.code)); // 'ABORT_ERR'
//
// // setImmediate
// console.log(await setImmediate('next')); // 'next'
//
// // setInterval async iterator
// let i = 0;
// for await (const _ of setInterval(200, 'tick')) {
//   if (++i === 3) break;
// }
//
// // scheduler
// await scheduler.wait(200);
// await scheduler.yield();
