// FIX: use aliased named imports — bound at module link time,
// never re-pointed by bundler shims or globalThis reassignment.
import {
  setTimeout  as _setTimeout,
  setInterval as _setInterval,
  setImmediate as _setImmediate,
} from '../timers';

// ---------------------------------------------------------------------------
// Internal helpers (unchanged)
// ---------------------------------------------------------------------------
const abortError = signal =>
  Object.assign(
    signal.reason instanceof Error
      ? signal.reason
      : new Error('The operation was aborted'),
    { code: 'ABORT_ERR' },
  );

function guardedPromise(signal, onAbort, body) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    let cleanup;
    const handleAbort = () => { cleanup?.(); onAbort(reject); };
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
export function setTimeout(delay = 0, value, { signal } = {}) {
  return guardedPromise(
    signal,
    reject => reject(abortError(signal)),
    (resolve) => {
      // Uses aliased _setTimeout — never accidentally calls this module's
      // own setTimeout export, regardless of how the bundler wires things up.
      const handle = _setTimeout(resolve, delay, value);
      return () => handle.close();
    },
  );
}

// ---------------------------------------------------------------------------
// setImmediate
// ---------------------------------------------------------------------------
export function setImmediate(value, { signal } = {}) {
  return guardedPromise(
    signal,
    reject => reject(abortError(signal)),
    (resolve) => {
      const handle = _setImmediate(resolve, value);
      return () => handle.close();
    },
  );
}

// ---------------------------------------------------------------------------
// setInterval — async iterator
// ---------------------------------------------------------------------------
export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal);

  const queue = [];
  let resolve = null;
  let done    = false;
  let error   = null;

  const enqueue = v => {
    if (resolve) { const r = resolve; resolve = null; r({ value: v, done: false }); }
    else queue.push(v);
  };

  // Uses aliased _setInterval — same reasoning as above.
  const handle = _setInterval(() => enqueue(value), delay);

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
export const scheduler = {
  wait:  (delay, options) => setTimeout(delay, undefined, options),
  yield: () => setImmediate(undefined),
};

export default { setTimeout, setInterval, setImmediate, scheduler };
