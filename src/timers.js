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

/** Resolved global scope */
const scope =
  (typeof global !== 'undefined' && global) ||
  (typeof self   !== 'undefined' && self)   ||
  globalThis;

// ─── FIX: snapshot the real browser APIs immediately, before any bundler
//          shim can overwrite globalThis.setTimeout / clearTimeout etc. ───
const _setTimeout    = scope.setTimeout.bind(scope);
const _clearTimeout  = scope.clearTimeout.bind(scope);
const _setInterval   = scope.setInterval.bind(scope);
const _clearInterval = scope.clearInterval.bind(scope);
// setImmediate is installed by the 'setimmediate' polyfill before this runs,
// so snapshot it the same way.
const _setImmediate   = scope.setImmediate.bind(scope);
const _clearImmediate = scope.clearImmediate.bind(scope);

const { apply } = Function.prototype;

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------
function Timeout(id, clearFn) {
  this._id      = id;
  this._clearFn = clearFn;   // always a snapshotted native, never our export
}
Timeout.prototype.ref   = function () { return this; };
Timeout.prototype.unref = function () { return this; };
Timeout.prototype[Symbol.toPrimitive] = function () { return this._id; };
Timeout.prototype.close = function () {
  this._clearFn(this._id);   // direct call — no .call(scope, …) needed
};

function Immediate(id) { this._id = id; }
Immediate.prototype.ref   = function () { return this; };
Immediate.prototype.unref = function () { return this; };
Immediate.prototype.close = function () { _clearImmediate(this._id); };

// ---------------------------------------------------------------------------
// Core exports — all delegate to the snapshotted natives
// ---------------------------------------------------------------------------
export function setTimeout(fn, delay, ...args) {
  return new Timeout(_setTimeout(fn, delay, ...args), _clearTimeout);
}

export function setInterval(fn, delay, ...args) {
  return new Timeout(_setInterval(fn, delay, ...args), _clearInterval);
}

export function clearTimeout(timeout) {
  if (!timeout) return;
  typeof timeout.close === 'function'
    ? timeout.close()
    : _clearTimeout(timeout);
}
export { clearTimeout as clearInterval };

export function setImmediate(fn, ...args) {
  return new Immediate(_setImmediate(fn, ...args));
}

export function clearImmediate(immediate) {
  if (!immediate) return;
  typeof immediate.close === 'function'
    ? immediate.close()
    : _clearImmediate(immediate);
}

// ---------------------------------------------------------------------------
// Legacy idle-timeout helpers
// ---------------------------------------------------------------------------
export function enroll(item, msecs) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
}

export function unenroll(item) {
  _clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
}

export function active(item) {
  _clearTimeout(item._idleTimeoutId);
  const ms = item._idleTimeout;
  if (ms >= 0) {
    item._idleTimeoutId = _setTimeout(() => {
      if (item._onTimeout) item._onTimeout();
    }, ms);
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
