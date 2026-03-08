// npm install timers-browserify setimmediate

/*!
 * timers-web — node:timers for browsers & bundlers
 * MIT License. Adapted from timers-browserify (MIT, J. Buchanan)
 * Node.js parity: node:timers @ Node 0.0.1+
 * Dependencies: timers-browserify, setimmediate
 * Limitations:
 *   - .ref() / .unref() are no-ops (no Node event loop integration).
 *   - enroll / unenroll / active are legacy idle-timer helpers; included for
 *     ecosystem compat but rarely needed in new code.
 */

/**
 * @packageDocumentation
 * Drop-in replacement for `node:timers` in browser/bundler environments.
 * Wraps native browser timer APIs with Node.js-compatible Timeout objects
 * that expose `.close()`, `.ref()`, and `.unref()`.
 */

import 'setimmediate'; // installs setImmediate / clearImmediate onto globalThis

/** Resolved global scope — avoids typeof window checks. */
const scope =
  (typeof global !== 'undefined' && global) ||
  (typeof self   !== 'undefined' && self)   ||
  globalThis;

// ---------------------------------------------------------------------------
// !! Capture native functions at module evaluation time !!
//
// This MUST happen before any export is defined. Bundlers (webpack, esbuild,
// Rollup) can replace globalThis.setTimeout with our own export after the
// module loads. If we looked up scope.setTimeout at call time we'd recurse
// infinitely. Capturing here freezes the native reference permanently.
// ---------------------------------------------------------------------------
const _setTimeout    = scope.setTimeout.bind(scope);
const _clearTimeout  = scope.clearTimeout.bind(scope);
const _setInterval   = scope.setInterval.bind(scope);
const _clearInterval = scope.clearInterval.bind(scope);
const _setImmediate  = (scope.setImmediate  ?? globalThis.setImmediate).bind(scope);
const _clearImmediate= (scope.clearImmediate ?? globalThis.clearImmediate).bind(scope);

// ---------------------------------------------------------------------------
// Timeout — wraps a native timer handle with the Node.js Timeout interface
// ---------------------------------------------------------------------------

/**
 * Node-compatible timer handle.
 * @param {ReturnType<typeof setTimeout>} id  - Native browser timer id.
 * @param {(id: any) => void} clearFn         - Captured native clear function.
 */
function Timeout(id, clearFn) {
  this._id      = id;
  this._clearFn = clearFn;
}

/** No-ops — Node uses these to manage event-loop ref counts. */
Timeout.prototype.ref   = function () { return this; };
Timeout.prototype.unref = function () { return this; };

/** Returns the underlying numeric timer id (matches Node ≥ 14.9 behaviour). */
Timeout.prototype[Symbol.toPrimitive] = function () { return this._id; };

/**
 * Cancels the timer. Equivalent to clearTimeout / clearInterval.
 * Uses the captured native clear function — never our own exported wrapper.
 * @returns {void}
 */
Timeout.prototype.close = function () {
  this._clearFn(this._id);
};

/** @param {ReturnType<typeof setImmediate>} id */
function Immediate(id) {
  this._id = id;
}
Immediate.prototype.ref   = function () { return this; };
Immediate.prototype.unref = function () { return this; };
Immediate.prototype.close = function () { _clearImmediate(this._id); };

// ---------------------------------------------------------------------------
// Core timer exports
// ---------------------------------------------------------------------------

/**
 * Schedules `fn` to run after at least `delay` ms.
 * @param {(...args: any[]) => void} fn
 * @param {number} [delay=0]
 * @param {...any} args - Forwarded to fn when it fires.
 * @returns {Timeout}
 *
 * @example
 * const t = setTimeout(() => console.log('hi'), 500);
 * t.close(); // cancel
 */
export function setTimeout(fn, delay, ...args) {
  // Use _setTimeout — the reference captured at module load, never our own export.
  return new Timeout(_setTimeout(fn, delay, ...args), _clearTimeout);
}

/**
 * Schedules `fn` to run repeatedly every `delay` ms.
 * @param {(...args: any[]) => void} fn
 * @param {number} [delay=0]
 * @param {...any} args
 * @returns {Timeout}
 *
 * @example
 * const iv = setInterval(() => console.log('tick'), 1000);
 * setTimeout(() => iv.close(), 3500); // stop after ~3 ticks
 */
export function setInterval(fn, delay, ...args) {
  return new Timeout(_setInterval(fn, delay, ...args), _clearInterval);
}

/**
 * Cancels a Timeout or raw native handle.
 * @param {Timeout | number | undefined} timeout
 */
export function clearTimeout(timeout) {
  if (!timeout) return;
  if (typeof timeout.close === 'function') timeout.close();
  else _clearTimeout(timeout);
}

/** Alias — clearInterval and clearTimeout are interchangeable in browsers. */
export { clearTimeout as clearInterval };

/**
 * Schedules `fn` to run after the current poll phase (before I/O callbacks).
 * @param {(...args: any[]) => void} fn
 * @param {...any} args
 * @returns {Immediate}
 *
 * @example
 * const im = setImmediate(() => console.log('immediate'));
 * clearImmediate(im);
 */
export function setImmediate(fn, ...args) {
  return new Immediate(_setImmediate(fn, ...args));
}

/**
 * Cancels an Immediate handle.
 * @param {Immediate | any} immediate
 */
export function clearImmediate(immediate) {
  if (!immediate) return;
  if (typeof immediate.close === 'function') immediate.close();
  else _clearImmediate(immediate);
}

// ---------------------------------------------------------------------------
// Legacy idle-timeout helpers (node ecosystem compat)
// ---------------------------------------------------------------------------

/**
 * Prepares an object for idle-timeout tracking without starting the timer.
 * @param {{ _idleTimeoutId?: any; _idleTimeout?: number }} item
 * @param {number} msecs
 */
export function enroll(item, msecs) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
}

/**
 * Cancels and removes an enrolled idle timer.
 * @param {{ _idleTimeoutId?: any; _idleTimeout?: number }} item
 */
export function unenroll(item) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
}

/**
 * Starts (or restarts) the idle timer for an enrolled object.
 * Calls `item._onTimeout()` when the timer fires.
 * @param {{ _idleTimeoutId?: any; _idleTimeout?: number; _onTimeout?: () => void }} item
 */
export function active(item) {
  _clearTimeout(item._idleTimeoutId);
  const ms = item._idleTimeout;
  if (ms >= 0) {
    item._idleTimeoutId = _setTimeout(() => {
      if (item._onTimeout) item._onTimeout();
    }, ms);
  }
}

/** Alias preserved for older Node.js ecosystem code. */
export { active as _unrefActive };

export default {
  setTimeout, clearTimeout,
  setInterval, clearInterval,
  setImmediate, clearImmediate,
  enroll, unenroll, active, _unrefActive: active,
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
//
// import timers from './timers';
//
// // setTimeout / clearTimeout
// const t = timers.setTimeout(() => console.log('fired'), 500);
// t.close(); // cancel before firing — no handle leak
//
// // setInterval
// const iv = timers.setInterval(() => console.log('tick'), 1_000);
// timers.setTimeout(() => iv.close(), 3_500); // stop after ~3 ticks
//
// // setImmediate
// const im = timers.setImmediate(() => console.log('next iteration'));
// timers.clearImmediate(im); // cancel if not yet fired
//
// // Edge: extra args forwarded to callback
// timers.setTimeout((a, b) => console.log(a + b), 100, 1, 2); // logs 3
