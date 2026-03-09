/**
 * timers/promises — Node.js-compliant drop-in for browser/iframe runtimes.
 */

// ── Capture native timer primitives ──────────────────────────────────────────
// We bind these immediately to ensure we have the real browser implementation
// before any third-party scripts (or our own exports) can modify globalThis.

const _setTimeout      = globalThis.setTimeout.bind(globalThis);
const _clearTimeout    = globalThis.clearTimeout.bind(globalThis);
const _setInterval     = globalThis.setInterval.bind(globalThis);
const _clearInterval   = globalThis.clearInterval.bind(globalThis);

// setImmediate fallback logic
const _nativeSetImmediate = globalThis.setImmediate?.bind(globalThis);
const _nativeClearImmediate = globalThis.clearImmediate?.bind(globalThis);

const _setImmediate = _nativeSetImmediate ?? ((fn, ...a) => _setTimeout(fn, 0, ...a));
const _clearImmediate = _nativeClearImmediate ?? _clearTimeout;

// ── Internal helpers ──────────────────────────────────────────────────────────

function makeAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const msg =
    (reason && typeof reason === 'object' && reason.message) ||
    (typeof reason === 'string' && reason) ||
    'The operation was aborted';
  try {
    return new DOMException(msg, 'AbortError');
  } catch {
    const e = new Error(msg);
    e.name = 'AbortError';
    e.code = 20; 
    return e;
  }
}

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

export async function* setInterval(delay = 0, value, { signal } = {}) {
  if (signal?.aborted) throw makeAbortError(signal);

  const queue   = [];
  const waiters = [];

  let done     = false;
  let abortErr = null;
  let id;

  const push = (v) => {
    if (done) return;
    if (waiters.length) {
      waiters.shift()(v);
    } else {
      queue.push(v);
    }
  };

  const stop = () => {
    if (done) return;
    done = true;
    _clearInterval(id); // FIXED: Uses captured _clearInterval
    for (const w of waiters) w(Symbol.for('done'));
    waiters.length = 0;
  };

  // FIXED: Uses captured _setInterval instead of globalThis.setInterval
  id = _setInterval(() => push(value), delay);

  let onAbort;
  if (signal) {
    onAbort = () => {
      abortErr = makeAbortError(signal);
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
        tick = await new Promise(resolve => waiters.push(resolve));
      }

      if (tick === Symbol.for('abort')) throw abortErr ?? makeAbortError(signal);
      if (tick === Symbol.for('done'))  return;

      yield tick;
    }
  } finally {
    cleanup();
  }
}

export default { setTimeout, setImmediate, setInterval };
