/*!
 * timers — node:timers for Node.js, browsers & bundlers.
 *
 * Faithful to Node.js v24.20.0 lib/timers.js behavior, dependency-free ESM.
 *
 * Strategy: the native timer functions are captured at module-evaluation
 * time (so bundlers that replace globalThis.setTimeout cannot cause
 * recursion). Where the host returns real timer objects (Node.js), the
 * Timeout/Immediate wrappers delegate ref/unref/hasRef/refresh/dispose to
 * them, giving exact event-loop semantics. Where the host returns numeric
 * ids (browsers), the wrappers keep the classic no-op ref/unref behavior and
 * Node's delay-clamping rules are applied manually.
 *
 * Browser-safe: no node: imports, no process/Buffer use on the hot path.
 * `process.emitWarning` is used only when present (delay-overflow warnings).
 */

/**
 * @packageDocumentation
 * Drop-in replacement for `node:timers` in browser/bundler environments,
 * with full Node.js v24.20.0 API parity when running under Node.js.
 */

import {
  validateFunction,
} from './timers/errors.js';
import * as promisesNamespace from './timers/promises.js';

/** Resolved global scope — avoids typeof window checks. */
const scope =
  (typeof global !== 'undefined' && global) ||
  (typeof self !== 'undefined' && self) ||
  globalThis;

// ---------------------------------------------------------------------------
// !! Capture native functions at module evaluation time !!
//
// This MUST happen before any export is defined. Bundlers (webpack, esbuild,
// Rollup) can replace globalThis.setTimeout with our own export after the
// module loads. If we looked up scope.setTimeout at call time we'd recurse
// infinitely. Capturing here freezes the native reference permanently.
// ---------------------------------------------------------------------------
const _setTimeout = scope.setTimeout.bind(scope);
const _clearTimeout = scope.clearTimeout.bind(scope);
const _setInterval = scope.setInterval.bind(scope);
const _clearInterval = scope.clearInterval.bind(scope);

// setImmediate: native when present; MessageChannel fallback otherwise
// (browsers without setImmediate). The fallback is unref-style: ids are
// numeric and ref()/unref() are no-ops, matching timers-browserify behavior.
let _setImmediate;
let _clearImmediate;
if (typeof scope.setImmediate === 'function' && typeof scope.clearImmediate === 'function') {
  _setImmediate = scope.setImmediate.bind(scope);
  _clearImmediate = scope.clearImmediate.bind(scope);
} else if (typeof MessageChannel !== 'undefined') {
  let nextImmediateId = 1;
  const pendingImmediates = new Map();
  const channel = new MessageChannel();
  // Assigning onmessage implicitly starts the port.
  channel.port1.onmessage = (event) => {
    const id = event.data;
    const entry = pendingImmediates.get(id);
    if (entry !== undefined) {
      pendingImmediates.delete(id);
      entry.fn(...entry.args);
    }
  };
  _setImmediate = (fn, ...args) => {
    const id = nextImmediateId++;
    pendingImmediates.set(id, { fn, args });
    channel.port2.postMessage(id);
    return id;
  };
  _clearImmediate = (id) => {
    pendingImmediates.delete(id);
  };
} else {
  // Last resort (very old browsers): macrotask fallback.
  _setImmediate = (fn, ...args) => _setTimeout(fn, 0, ...args);
  _clearImmediate = (id) => _clearTimeout(id);
}

// Detect whether native timers return real timer objects (Node.js) or
// numeric ids (browsers). Behavior-based so it also works under
// Deno/Bun/workers without user-agent sniffing.
const HAS_OBJECT_TIMER_HANDLES = (() => {
  try {
    const probe = _setTimeout(() => {}, 0);
    _clearTimeout(probe);
    return typeof probe === 'object' && probe !== null;
  } catch {
    return false;
  }
})();

const TIMEOUT_MAX = 2 ** 31 - 1;

// Once-per-process warning flags, mirroring Node's internal/timers.js.
let warnedNaNTimeout = false;
let warnedNegativeTimeout = false;

function emitTimerWarning(message, name) {
  if (
    typeof process !== 'undefined' &&
    typeof process.emitWarning === 'function'
  ) {
    process.emitWarning(message, name);
  } else if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`${name}: ${message}`);
  }
}

// Node's Timeout constructor delay handling (lib/internal/timers.js).
// Only needed where the host does not do it natively (browsers). Under
// Node.js the native timer applies these exact rules itself, so the raw
// value is passed through untouched.
function normalizeDelay(after) {
  if (after === undefined) return 1;
  after *= 1; // Coalesce to number or NaN
  if (!(after >= 1 && after <= TIMEOUT_MAX)) {
    if (after > TIMEOUT_MAX) {
      emitTimerWarning(
        `${after} does not fit into a 32-bit signed integer.\nTimeout duration was set to 1.`,
        'TimeoutOverflowWarning',
      );
    } else if (after < 0 && !warnedNegativeTimeout) {
      warnedNegativeTimeout = true;
      emitTimerWarning(
        `${after} is a negative number.\nTimeout duration was set to 1.`,
        'TimeoutNegativeWarning',
      );
    } else if (Number.isNaN(after) && !warnedNaNTimeout) {
      warnedNaNTimeout = true;
      emitTimerWarning(
        `${after} is not a number.\nTimeout duration was set to 1.`,
        'TimeoutNaNWarning',
      );
    }
    after = 1; // Schedule on next tick, follows browser behavior
  }
  return after;
}

// ---------------------------------------------------------------------------
// Timeout — Node-compatible timer handle.
//
// Wraps the host's native timer. Under Node.js the native Timeout is kept
// and ref/unref/hasRef/refresh/close/dispose delegate to it, so event-loop
// semantics (including unref letting the process exit) are exact. The
// wrapper additionally exposes `_id` and a numeric Symbol.toPrimitive, which
// the browser/bundler ecosystem relies on.
// ---------------------------------------------------------------------------
class Timeout {
  constructor(native) {
    this._native = native;
    // Mirror Node: coercing a Timeout to a primitive yields its numeric id
    // (and registers it for clearTimeout(id) lookups).
    this._id =
      typeof native === 'object' && native !== null ? Number(native) : native;
  }

  ref() {
    if (this._native !== null && typeof this._native === 'object') {
      this._native.ref();
    }
    return this;
  }

  unref() {
    if (this._native !== null && typeof this._native === 'object') {
      this._native.unref();
    }
    return this;
  }

  hasRef() {
    if (this._native !== null && typeof this._native === 'object') {
      return this._native.hasRef();
    }
    return true;
  }

  refresh() {
    if (this._native !== null && typeof this._native === 'object') {
      this._native.refresh();
    }
    return this;
  }

  close() {
    if (this._native !== null && typeof this._native === 'object') {
      this._native.close();
    } else {
      _clearTimeout(this._id);
    }
  }

  [Symbol.dispose]() {
    this.close();
  }

  [Symbol.toPrimitive]() {
    return this._id;
  }
}

// ---------------------------------------------------------------------------
// Immediate — Node-compatible immediate handle. Same delegation strategy as
// Timeout. Node's Immediate has no close(); we add one for ecosystem compat
// (the pre-existing public API of this module).
// ---------------------------------------------------------------------------
class Immediate {
  constructor(native) {
    this._native = native;
    this._id = native;
  }

  ref() {
    if (this._native !== null && typeof this._native === 'object') {
      this._native.ref();
    }
    return this;
  }

  unref() {
    if (this._native !== null && typeof this._native === 'object') {
      this._native.unref();
    }
    return this;
  }

  hasRef() {
    if (this._native !== null && typeof this._native === 'object') {
      return this._native.hasRef();
    }
    return true;
  }

  close() {
    _clearImmediate(this._native);
  }

  [Symbol.dispose]() {
    this.close();
  }
}

// ---------------------------------------------------------------------------
// Core timer exports
// ---------------------------------------------------------------------------

/**
 * Schedules `callback` to run after at least `delay` ms.
 * Mirrors Node v24 lib/timers.js setTimeout (incl. callback validation;
 * delay clamping/warnings are applied by the native timer under Node.js and
 * by normalizeDelay() in browsers).
 */
export function setTimeout(callback, after, ...args) {
  validateFunction(callback, 'callback');
  if (!HAS_OBJECT_TIMER_HANDLES) after = normalizeDelay(after);
  // Use _setTimeout — the reference captured at module load, never our own export.
  return new Timeout(_setTimeout(callback, after, ...args));
}

/**
 * Schedules `callback` to run repeatedly every `delay` ms.
 */
export function setInterval(callback, after, ...args) {
  validateFunction(callback, 'callback');
  if (!HAS_OBJECT_TIMER_HANDLES) after = normalizeDelay(after);
  return new Timeout(_setInterval(callback, after, ...args));
}

/**
 * Cancels a timeout/interval. Accepts our Timeout wrappers, native timer
 * objects, and numeric/string ids (Node resolves those via its id registry).
 * Never throws for nullish or foreign values.
 */
export function clearTimeout(timer) {
  if (timer === undefined || timer === null) return;
  if (timer instanceof Timeout) {
    timer.close();
    return;
  }
  _clearTimeout(timer);
}

/**
 * Cancels an interval. Interchangeable with clearTimeout per the HTML spec.
 */
export function clearInterval(timer) {
  clearTimeout(timer);
}

/**
 * Schedules `callback` to run after I/O callbacks (before timers).
 */
export function setImmediate(callback, ...args) {
  validateFunction(callback, 'callback');
  return new Immediate(_setImmediate(callback, ...args));
}

/**
 * Cancels an Immediate handle.
 */
export function clearImmediate(immediate) {
  if (immediate === undefined || immediate === null) return;
  if (immediate instanceof Immediate) {
    immediate.close();
    return;
  }
  _clearImmediate(immediate);
}

// Node exposes the promise variants as `timers.promises` (lazy getter in
// Node; here the module namespace, which is reference-identical to
// `import 'timers/promises'` / `require('timers/promises')`).
export { promisesNamespace as promises };

// util.promisify hooks, mirroring Node's customPromisify definitions.
const customPromisify = Symbol.for('nodejs.util.promisify.custom');
Object.defineProperty(setTimeout, customPromisify, {
  __proto__: null,
  enumerable: true,
  get() {
    return promisesNamespace.setTimeout;
  },
});
Object.defineProperty(setImmediate, customPromisify, {
  __proto__: null,
  enumerable: true,
  get() {
    return promisesNamespace.setImmediate;
  },
});

// ---------------------------------------------------------------------------
// Legacy idle-timeout helpers (node ecosystem compat)
// ---------------------------------------------------------------------------

/**
 * Prepares an object for idle-timeout tracking without starting the timer.
 * NOTE: local-only — real node:timers does not export enroll/unenroll/active.
 */
function enroll(item, msecs) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
}

/**
 * Cancels and removes an enrolled idle timer.
 */
function unenroll(item) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
}

/**
 * Starts (or restarts) the idle timer for an enrolled object.
 * Calls `item._onTimeout()` when the timer fires.
 */
function active(item) {
  _clearTimeout(item._idleTimeoutId);
  const ms = item._idleTimeout;
  if (ms >= 0) {
    item._idleTimeoutId = _setTimeout(() => {
      if (item._onTimeout) item._onTimeout();
    }, ms);
  }
}

/** Internal alias for the default export (not a named ESM export in real Node). */
const _unrefActive = active;

export default {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  enroll,
  unenroll,
  active,
  _unrefActive: active,
  promises: promisesNamespace,
};
