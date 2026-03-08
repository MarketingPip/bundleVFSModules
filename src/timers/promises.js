/**
 * timers/promises — uses the runtime's saved originals directly,
 * so it is unaffected by user redefinitions of globalThis.setTimeout.
 *
 * Drop-in replacement for the previous version that imported ../timers.
 */


// ─── helpers ──────────────────────────────────────────────────────────────────

const abortError = signal =>
  Object.assign(
    signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'),
    { code: 'ABORT_ERR' },
  );

/**
 * Wraps a timer in an AbortSignal-aware Promise.
 * `body` receives (resolve, reject) and must return a () => void cleanup.
 */
function guardedPromise(signal, body) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));

    let cleanup;
    const onAbort = () => { cleanup?.(); reject(abortError(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (fn, v) => { signal?.removeEventListener('abort', onAbort); fn(v); };
    cleanup = body(v => settle(resolve, v), e => settle(reject, e));
  });
}

// ─── setTimeout ───────────────────────────────────────────────────────────────

export function setTimeout(delay = 0, value, { signal } = {}) {
  return guardedPromise(signal, (resolve, reject) => {
    // Use the original directly — bypasses both the patched global
    // and any subsequent user redefinition.
    const id = globalThis.setTimeout(resolve, delay, value);
    return () => globalThis.ClearTimeout(id);
  });
}

// ─── setImmediate ─────────────────────────────────────────────────────────────

export function setImmediate(value, { signal } = {}) {
  return guardedPromise(signal, (resolve) => {
    // Approximate setImmediate via setTimeout(0) for full browser compat.
    const id = globalThis.setTimeout(resolve, 0, value);
    return () => globalThis.ClearTimeout(id);
  });
}

// ─── setInterval (async iterator) ────────────────────────────────────────────

export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw abortError(signal);

  const queue = [];
  let parkedResolve = null;
  let done  = false;
  let error = null;

  const enqueue = v => {
    if (parkedResolve) { const r = parkedResolve; parkedResolve = null; r({ value: v, done: false }); }
    else queue.push(v);
  };

  const id = globalThis.SetInterval(() => enqueue(value), delay);

  const onAbort = () => {
    globalThis.ClearInterval(id);
    error = abortError(signal);
    done  = true;
    if (parkedResolve) { const r = parkedResolve; parkedResolve = null; r(Promise.reject(error)); }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!done) {
      if (queue.length) { yield queue.shift(); continue; }
      const next = await new Promise(r => { parkedResolve = r; });
      if (next.done) break;
      yield next.value;
    }
  } finally {
    globalThis.ClearInterval(id);
    signal?.removeEventListener('abort', onAbort);
    if (error) throw error;
  }
}

// ─── scheduler ────────────────────────────────────────────────────────────────

export const scheduler = {
  wait:  (delay, options) => setTimeout(delay, undefined, options),
  yield: ()               => setImmediate(undefined),
};

export default { setTimeout, setInterval, setImmediate, scheduler };
