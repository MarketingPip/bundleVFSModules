// npm install setimmediate

/*!
 * timers-web — node:timers for browsers & bundlers
 * MIT License. Adapted from timers-browserify (MIT, J. Buchanan)
 * Node.js parity: node:timers @ Node 0.0.1+
 * Dependencies: setimmediate
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

// ---------------------------------------------------------------------------
// !! Capture native functions at module evaluation time !!
//
// Must use `globalThis` directly — NOT `global || self || globalThis`.
// In webpack/esbuild/Rollup, `global` is a polyfill object that may not carry
// setTimeout, causing `_setTimeout` to be undefined and timers to silently hang.
// `globalThis` is the actual global object in every spec-compliant environment.
// Captured here, before any export can shadow them.
// ---------------------------------------------------------------------------
const _setTimeout     = globalThis.setTimeout.bind(globalThis);
const _clearTimeout   = globalThis.clearTimeout.bind(globalThis);
const _setInterval    = globalThis.setInterval.bind(globalThis);
const _clearInterval  = globalThis.clearInterval.bind(globalThis);
const _setImmediate   = (globalThis.setImmediate).bind(globalThis);
const _clearImmediate = (globalThis.clearImmediate).bind(globalThis);

// Expose captured natives so timers/promises can import them directly,
// bypassing the Timeout wrapper for promise-based scheduling.
export {
  _setTimeout, _clearTimeout,
  _setInterval, _clearInterval,
  _setImmediate, _clearImmediate,
};

// ---------------------------------------------------------------------------
// Timeout — wraps a native timer handle with the Node.js Timeout interface
// ---------------------------------------------------------------------------

/**
 * Node-compatible timer handle returned by setTimeout / setInterval.
 * @param {ReturnType<typeof setTimeout>} id  - Native browser timer id.
 * @param {(id: any) => void} clearFn         - Captured native clear function.
 */
function Timeout(id, clearFn) {
  this._id      = id;
  this._clearFn = clearFn;
}

Timeout.prototype.ref   = function () { return this; };
Timeout.prototype.unref = function () { return this; };

/** Returns the underlying numeric timer id (matches Node ≥ 14.9 behaviour). */
Timeout.prototype[Symbol.toPrimitive] = function () { return this._id; };

/**
 * Cancels the timer. Uses the captured native clear — never our exported wrapper.
 */
Timeout.prototype.close = function () { this._clearFn(this._id); };

/** @param {ReturnType<typeof setImmediate>} id */
function Immediate(id) { this._id = id; }
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
 * @param {...any} args
 * @returns {Timeout}
 * @example
 * const t = setTimeout(() => console.log('hi'), 500);
 * t.close(); // cancel
 */
export function setTimeout(fn, delay, ...args) {
  return new Timeout(_setTimeout(fn, delay, ...args), _clearTimeout);
}

/**
 * Schedules `fn` to run repeatedly every `delay` ms.
 * @param {(...args: any[]) => void} fn
 * @param {number} [delay=0]
 * @param {...any} args
 * @returns {Timeout}
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
  typeof timeout.close === 'function' ? timeout.close() : _clearTimeout(timeout);
}

export { clearTimeout as clearInterval };

/**
 * Schedules `fn` to run after the current poll phase.
 * @param {(...args: any[]) => void} fn
 * @param {...any} args
 * @returns {Immediate}
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
  typeof immediate.close === 'function' ? immediate.close() : _clearImmediate(immediate);
}

// ---------------------------------------------------------------------------
// Legacy idle-timeout helpers
// ---------------------------------------------------------------------------

/** @param {{ _idleTimeoutId?: any; _idleTimeout?: number }} item @param {number} msecs */
export function enroll(item, msecs) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
}

/** @param {{ _idleTimeoutId?: any; _idleTimeout?: number }} item */
export function unenroll(item) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
}

/** @param {{ _idleTimeoutId?: any; _idleTimeout?: number; _onTimeout?: () => void }} item */
export function active(item) {
  _clearTimeout(item._idleTimeoutId);
  const ms = item._idleTimeout;
  if (ms >= 0) {
    item._idleTimeoutId = _setTimeout(() => { item._onTimeout?.(); }, ms);
  }
}

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
// const t = timers.setTimeout(() => console.log('fired'), 500);
// t.close();
//
// const iv = timers.setInterval(() => console.log('tick'), 1_000);
// timers.setTimeout(() => iv.close(), 3_500);
//
// timers.setImmediate((a, b) => console.log(a + b), 1, 2); // 3
