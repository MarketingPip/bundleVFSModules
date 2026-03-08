/**
 * timers/promises — Node.js-compliant drop-in for browser/iframe runtimes.
 *
 * Node.js parity: node:timers/promises @ Node 15+
 *
 * API surface:
 *   setTimeout(delay?, value?, options?)  → Promise<value>
 *   setImmediate(value?, options?)        → Promise<value>
 *   setInterval(delay?, value?, options?) → AsyncGenerator<value>
 *
 * All three honour AbortSignal via `options.signal`, matching Node behaviour:
 *   - If the signal is already aborted the promise rejects immediately.
 *   - If it aborts mid-wait the promise rejects with signal.reason (an
 *     AbortError DOMException, same as Node ≥ 17.3).
 *   - The underlying timer is always cleared on abort — no handle leaks.
 *
 * Iframe notes:
 *   - We capture the iframe's own timer globals at module-evaluation time
 *     (same pattern as timers.js) to survive any host-frame patching.
 *   - ref / unref are irrelevant inside an iframe; the module stays clean.
 */

// ── Capture native iframe timer functions ─────────────────────────────────────
// Must happen at module load — before any export — so that if the host page
// replaces globalThis.setTimeout we still hold the real browser primitive.

const _setTimeout     = globalThis.setTimeout.bind(globalThis);
const _clearTimeout   = globalThis.clearTimeout.bind(globalThis);
const _setImmediate   = (globalThis.setImmediate ?? ((fn, ...a) => _setTimeout(fn, 0, ...a))).bind(globalThis);
const _clearImmediate = (globalThis.clearImmediate ?? _clearTimeout).bind(globalThis);

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Builds a normalised AbortError that matches what Node ≥ 17 throws.
 * Node uses `new DOMException(reason?.message ?? 'The operation was aborted', 'AbortError')`.
 */
function makeAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;           // already a proper error
  const msg =
    (reason && typeof reason === 'object' && reason.message) ||
    (typeof reason === 'string' && reason) ||
    'The operation was aborted';
  try {
    return new DOMException(msg, 'AbortError');          // browsers & Node 18+
  } catch {
    // Safari <15 / old environments without DOMException constructor
    const e = new Error(msg);
    e.name = 'AbortError';
    e.code = 20; // DOMException.ABORT_ERR
    return e;
  }
}

/**
 * Returns a Promise that rejects as soon as `signal` aborts.
 * Also returns a cleanup function that must be called when the main timer
 * resolves, so we don't leave a dangling abort listener.
 *
 * @param {AbortSignal} signal
 * @returns {{ rejectPromise: Promise<never>, cleanup: () => void }}
 */
function abortRace(signal) {
  let onAbort;
  const rejectPromise = new Promise((_, reject) => {
    onAbort = () => reject(makeAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  return { rejectPromise, cleanup };
}

// ── setTimeout ────────────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves with `value` after `delay` ms.
 *
 * @template T
 * @param {number}  [delay=0]
 * @param {T}       [value]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T | undefined>}
 *
 * @example
 * await timersPromises.setTimeout(1_000);              // sleep 1 s
 * const v = await timersPromises.setTimeout(500, 42); // resolves → 42
 *
 * // With AbortSignal:
 * const ac = new AbortController();
 * setTimeout(() => ac.abort(), 100);
 * await timersPromises.setTimeout(5_000, null, { signal: ac.signal }); // throws AbortError after 100ms
 */
export function setTimeout(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(makeAbortError(signal));

  let id;
  let cleanup = () => {};

  const timerPromise = new Promise((resolve, reject) => {
    id = _setTimeout(() => { cleanup(); resolve(value); }, delay);
    if (signal) {
      const race = abortRace(signal);
      cleanup = () => { _clearTimeout(id); race.cleanup(); };
      race.rejectPromise.catch(err => { _clearTimeout(id); reject(err); });
    }
  });

  return timerPromise;
}

// ── setImmediate ──────────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves with `value` after the current event-loop
 * iteration (equivalent to `setImmediate` in Node, `setTimeout(fn,0)` in
 * browsers that lack native setImmediate).
 *
 * @template T
 * @param {T}  [value]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<T | undefined>}
 *
 * @example
 * await timersPromises.setImmediate();       // yield to event loop
 * const v = await timersPromises.setImmediate('done'); // → 'done'
 */
export function setImmediate(value, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(makeAbortError(signal));

  let id;
  let cleanup = () => {};

  const timerPromise = new Promise((resolve, reject) => {
    id = _setImmediate(() => { cleanup(); resolve(value); });
    if (signal) {
      const race = abortRace(signal);
      cleanup = () => { _clearImmediate(id); race.cleanup(); };
      race.rejectPromise.catch(err => { _clearImmediate(id); reject(err); });
    }
  });

  return timerPromise;
}

// ── setInterval ───────────────────────────────────────────────────────────────

/**
 * Returns an async iterator that yields `value` every `delay` ms indefinitely
 * (or until the iterator is `return()`ed or the AbortSignal fires).
 *
 * Matches the Node.js AsyncGenerator contract:
 *   - `for await…of` works as expected.
 *   - `break` / early `return()` clears the underlying interval automatically.
 *   - AbortSignal causes the generator to throw an AbortError on the next tick.
 *
 * @template T
 * @param {number} [delay=0]
 * @param {T}      [value]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<T | undefined>}
 *
 * @example
 * // Log a timestamp every second for 5 iterations then stop:
 * let i = 0;
 * for await (const _ of timersPromises.setInterval(1_000, Date.now())) {
 *   console.log(Date.now());
 *   if (++i === 5) break;
 * }
 *
 * // Abort from outside:
 * const ac = new AbortController();
 * const gen = timersPromises.setInterval(500, 'tick', { signal: ac.signal });
 * for await (const v of gen) {
 *   console.log(v);          // 'tick' every 500 ms
 *   if (someCondition) ac.abort();
 * }
 */
export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw makeAbortError(signal);

  // A simple queue so ticks that fire while the consumer is awaiting the
  // previous yield are not dropped (matches Node's buffering behaviour).
  const queue   = [];         // pending resolved tick values
  const waiters = [];         // resolve fns from next() calls blocking on a tick

  let done     = false;
  let abortErr = null;
  let id;

  const push = (v) => {
    if (done) return;
    if (waiters.length) {
      waiters.shift()(v);     // hand directly to whoever is waiting
    } else {
      queue.push(v);          // buffer until consumer catches up
    }
  };

  const stop = () => {
    if (done) return;
    done = true;
    _clearTimeout(id);        // clearTimeout also clears interval ids in browsers
    // Drain any pending waiters with a "done" sentinel
    for (const w of waiters) w(Symbol.for('done'));
    waiters.length = 0;
  };

  // Start the interval
  id = globalThis.setInterval(() => push(value), delay);

  // Wire up AbortSignal
  let onAbort;
  if (signal) {
    onAbort = () => {
      abortErr = makeAbortError(signal);
      // Reject all outstanding next() calls
      for (const w of waiters) w(Symbol.for('abort'));
      waiters.length = 0;
      stop();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const cleanup = () => {
    stop();
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  };

  try {
    while (true) {
      if (abortErr) throw abortErr;
      if (done)     return;

      let tick;
      if (queue.length) {
        tick = queue.shift();
      } else {
        // Block until the interval fires or we're stopped/aborted
        tick = await new Promise(resolve => waiters.push(resolve));
      }

      if (tick === Symbol.for('abort')) throw abortErr ?? makeAbortError(signal);
      if (tick === Symbol.for('done'))  return;

      yield tick;
    }
  } finally {
    // Handles both `break` in for-await and thrown errors
    cleanup();
  }
}

// ── Default export ─────────────────────────────────────────────────────────────

export default { setTimeout, setImmediate, setInterval };
