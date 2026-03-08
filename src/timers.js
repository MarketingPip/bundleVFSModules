/*!
 * timers-web — node:timers for browsers & sandbox runtimes
 * MIT License.
 *
 * Node.js parity: node:timers
 *
 * Safe for:
 *  - iframes
 *  - workers
 *  - bundlers
 *  - sandbox runtimes
 *
 * Fixes:
 *  - removes fragile `setimmediate` dependency
 *  - prevents cross-realm timer capture bugs
 *  - uses MessageChannel for accurate setImmediate scheduling
 */

// ---------------------------------------------------------------------------
// Capture native timers from the CURRENT realm
// ---------------------------------------------------------------------------

const g = globalThis;

const _setTimeout    = g.setTimeout.bind(g);
const _clearTimeout  = g.clearTimeout.bind(g);
const _setInterval   = g.setInterval.bind(g);
const _clearInterval = g.clearInterval.bind(g);

// ---------------------------------------------------------------------------
// Robust setImmediate implementation
// ---------------------------------------------------------------------------

let _setImmediate;
let _clearImmediate;

if (typeof g.setImmediate === 'function') {
  _setImmediate   = g.setImmediate.bind(g);
  _clearImmediate = g.clearImmediate.bind(g);
} else {

  const queue = [];
  const tasks = new Map();
  let id = 1;

  const channel = new MessageChannel();

  channel.port1.onmessage = () => {
    const task = queue.shift();
    if (!task) return;

    if (!tasks.has(task.id)) return;

    tasks.delete(task.id);

    try {
      task.fn(...task.args);
    } catch (err) {
      // rethrow async like Node
      _setTimeout(() => { throw err; });
    }
  };

  _setImmediate = (fn, ...args) => {
    const taskId = id++;

    const task = { id: taskId, fn, args };

    tasks.set(taskId, task);
    queue.push(task);

    channel.port2.postMessage(0);

    return taskId;
  };

  _clearImmediate = (taskId) => {
    tasks.delete(taskId);
  };
}

// Export captured natives for timers/promises
export {
  _setTimeout, _clearTimeout,
  _setInterval, _clearInterval,
  _setImmediate, _clearImmediate
};

// ---------------------------------------------------------------------------
// Timeout wrapper (Node compatibility)
// ---------------------------------------------------------------------------

function Timeout(id, clearFn) {
  this._id = id;
  this._clearFn = clearFn;
}

Timeout.prototype.ref = function () { return this; };
Timeout.prototype.unref = function () { return this; };

Timeout.prototype.close = function () {
  this._clearFn(this._id);
};

Timeout.prototype[Symbol.toPrimitive] = function () {
  return this._id;
};

// ---------------------------------------------------------------------------
// Immediate wrapper
// ---------------------------------------------------------------------------

function Immediate(id) {
  this._id = id;
}

Immediate.prototype.ref = function () { return this; };
Immediate.prototype.unref = function () { return this; };

Immediate.prototype.close = function () {
  _clearImmediate(this._id);
};

// ---------------------------------------------------------------------------
// setTimeout
// ---------------------------------------------------------------------------

export function setTimeout(fn, delay = 0, ...args) {
  const id = _setTimeout(fn, delay, ...args);
  return new Timeout(id, _clearTimeout);
}

// ---------------------------------------------------------------------------
// setInterval
// ---------------------------------------------------------------------------

export function setInterval(fn, delay = 0, ...args) {
  const id = _setInterval(fn, delay, ...args);
  return new Timeout(id, _clearInterval);
}

// ---------------------------------------------------------------------------
// clearTimeout / clearInterval
// ---------------------------------------------------------------------------

export function clearTimeout(timeout) {
  if (!timeout) return;

  if (typeof timeout.close === 'function') {
    timeout.close();
  } else {
    _clearTimeout(timeout);
  }
}

export const clearInterval = clearTimeout;

// ---------------------------------------------------------------------------
// setImmediate
// ---------------------------------------------------------------------------

export function setImmediate(fn, ...args) {
  const id = _setImmediate(fn, ...args);
  return new Immediate(id);
}

// ---------------------------------------------------------------------------
// clearImmediate
// ---------------------------------------------------------------------------

export function clearImmediate(immediate) {
  if (!immediate) return;

  if (typeof immediate.close === 'function') {
    immediate.close();
  } else {
    _clearImmediate(immediate);
  }
}

// ---------------------------------------------------------------------------
// Legacy idle timeout helpers (rarely used but Node-compatible)
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
      item._onTimeout?.();
    }, ms);
  }
}

export const _unrefActive = active;

// ---------------------------------------------------------------------------
// Default export (Node style)
// ---------------------------------------------------------------------------

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
  _unrefActive
};
