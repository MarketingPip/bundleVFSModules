// src/events.js — Direct ESM port of Node.js v24.20.0 `lib/events.js`.
//
// Porting notes:
// - Extracted verbatim from the Node v24.20.0 runtime via
//   `process.binding('natives')['events']` and transformed to dependency-free
//   ESM: primordials (ArrayPrototypePush, ReflectApply, ...) are replaced by
//   their native equivalents, and `require('internal/...')` helpers are
//   inlined below (validators, FixedQueue, error codes).
// - Browser-safe: `process.nextTick` is guarded (falls back to
//   `queueMicrotask`), `process.emitWarning` is guarded (falls back to
//   `console.warn`), `Error.captureStackTrace` is guarded, and `async_hooks`
//   is loaded lazily only when `EventEmitterAsyncResource` is requested.
// - Node private-symbol interop (`kResistStopPropagation`,
//   `events.maxEventTargetListeners`, `kEvents`) cannot be recreated with
//   public APIs because those symbols are module-local. Where a public API
//   cannot reproduce the behavior, this module bridges to the real builtin
//   via `process.getBuiltinModule('events')` when running under Node:
//     * `addAbortListener()` delegates to the real builtin so an abort
//       listener still fires even if an earlier listener called
//       `stopImmediatePropagation()` (guaranteed by Node's private
//       `kResistStopPropagation` symbol). In browsers it falls back to a
//       plain `AbortSignal.addEventListener('abort', listener, { once: true })`
//       plus a `queueMicrotask` for already-aborted signals; the
//       stop-propagation resistance is a Node-only guarantee there.
//     * `once()`/`on()` register their abort cleanup through the same
//       bridge for the same reason.
// - EventTarget helpers (`getEventListeners`, `getMaxListeners`,
//   `listenerCount`, static `setMaxListeners`) discover Node's real symbols
//   (`kEvents`, `events.maxEventTargetListeners`, ...) by symbol description
//   on the target instance; foreign EventTargets without those symbols fall
//   back to a WeakMap/defaults.
// - The returned disposable of `addAbortListener()` implements
//   `Symbol.dispose` (with a `Symbol.for('Symbol.dispose')` fallback).

'use strict';

// Fallback AsyncResource for the lazy `EventEmitterAsyncResource` getter:
// under Node the genuine builtin is preferred (true async-context
// semantics); everywhere else our own async_hooks port backs the class so the
// named export below is safe to resolve at module load in browsers.
import { AsyncResource as LocalAsyncResource } from './async_hooks.js';

// ---------------------------------------------------------------------------
// Local symbols (public-registry ones match Node; module-local ones are the
// port's own and are NOT identical to Node's private symbols).
// ---------------------------------------------------------------------------
const kRejection = Symbol.for('nodejs.rejection');
const kCapture = Symbol.for('kCapture');
const kErrorMonitor = Symbol.for('events.errorMonitor');
const kMaxEventTargetListeners = Symbol.for('events.maxEventTargetListeners');
const kMaxEventTargetListenersWarned = Symbol.for('events.maxEventTargetListenersWarned');
const kWatermarkData = Symbol.for('nodejs.watermarkData');
// Stand-in for Node's private kResistStopPropagation. It is accepted by real
// EventTargets as an unknown option (ignored), and meaningful only for the
// pure-JS fallback path.
const kResistStopPropagation = Symbol('kResistStopPropagation');
const kNewListener = Symbol('kNewListener');
const kRemoveListener = Symbol('kRemoveListener');
const kEnhanceStackBeforeInspector = Symbol.for('nodejs.enhanceStackBeforeInspector');
const kIsEventTarget = Symbol.for('nodejs.event_target');
const kEmptyObject = { __proto__: null };

const SymbolDispose = typeof Symbol.dispose === 'symbol' ? Symbol.dispose : Symbol.for('Symbol.dispose');
const AsyncIteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf(async function* () {}));

// ---------------------------------------------------------------------------
// Environment guards.
// ---------------------------------------------------------------------------
const hasProcess = typeof process !== 'undefined' && process !== null;

/** Reach the real builtin module without going through any loader patches. */
function getBuiltinModuleSafe(name) {
  try {
    if (hasProcess && typeof process.getBuiltinModule === 'function') {
      return process.getBuiltinModule(name);
    }
  } catch {
    // Continue regardless of error.
  }
  return undefined;
}

const deferNextTick = (hasProcess && typeof process.nextTick === 'function')
  ? process.nextTick.bind(process)
  : queueMicrotask;

function captureStackTrace(target, fn) {
  if (typeof Error.captureStackTrace === 'function') {
    Error.captureStackTrace(target, fn);
  }
}

function emitWarning(warning) {
  try {
    if (hasProcess && typeof process.emitWarning === 'function') {
      process.emitWarning(warning);
      return;
    }
  } catch {
    // Fall through to console.
  }
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`${warning.name}: ${warning.message}`);
  }
}

/** Minimal util.inspect stand-in (only used for warning text). */
function inspect(value) {
  try {
    if (typeof value === 'string') return `'${value}'`;
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return `[ ${value.map((v) => inspect(v)).join(', ')} ]`;
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{ ${keys.map((k) => `${k}: ${inspect(value[k])}`).join(', ')} }`;
  } catch {
    return '[object]';
  }
}

function genericNodeError(message, { name, ...rest } = {}) {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, rest);
  return err;
}

const hideStackFrames = (fn) => {
  function wrappedFn(...args) {
    try {
      return Reflect.apply(fn, this, args);
    } catch (error) {
      if (typeof Error.captureStackTrace === 'function' && Error.stackTraceLimit) {
        Error.captureStackTrace(error, wrappedFn);
      }
      throw error;
    }
  }
  wrappedFn.withoutStackTrace = fn;
  return wrappedFn;
};

// ---------------------------------------------------------------------------
// Error codes (from internal/errors, trimmed to what events needs).
// ---------------------------------------------------------------------------
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
const kTypes = [
  'string',
  'function',
  'number',
  'object',
  // Accept 'Function' and 'Object' as alternative to the lower cased version.
  'Function',
  'Object',
  'boolean',
  'bigint',
  'symbol',
];

function determineSpecificType(value) {
  if (value === null) {
    return 'null';
  } else if (value === undefined) {
    return 'undefined';
  }

  const type = typeof value;

  switch (type) {
    case 'bigint':
      return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) {
        return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      } else if (value !== value) { // eslint-disable-line no-self-compare
        return 'type number (NaN)';
      } else if (value === Infinity) {
        return 'type number (Infinity)';
      } else if (value === -Infinity) {
        return 'type number (-Infinity)';
      }
      return `type number (${value})`;
    case 'boolean':
      return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol':
      return `type symbol (${String(value)})`;
    case 'function':
      return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) {
        return `an instance of ${value.constructor.name}`;
      }
      return `${inspect(value)}`;
    case 'string':
      value.length > 28 && (value = `${value.slice(0, 25)}...`);
      if (value.indexOf("'") === -1) {
        return `type string ('${value}')`;
      }
      return `type string (${JSON.stringify(value)})`;
    default: {
      let inspected = inspect(value);
      if (inspected.length > 28) {
        inspected = `${inspected.slice(0, 25)}...`;
      }
      return `type ${type} (${inspected})`;
    }
  }
}

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${array.slice(0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    if (typeof name !== 'string') throw new Error("'name' must be a string");
    if (!Array.isArray(expected)) {
      expected = [expected];
    }

    let message = 'The ';
    if (name.endsWith(' argument')) {
      // For cases like 'first argument'
      message += `${name} `;
    } else {
      const type = name.includes('.') ? 'property' : 'argument';
      message += `"${name}" ${type} `;
    }
    message += 'must be ';

    const types = [];
    const instances = [];
    const other = [];

    for (const value of expected) {
      if (typeof value !== 'string') throw new Error('All expected values must be strings');
      if (kTypes.includes(value)) {
        types.push(value.toLowerCase());
      } else if (classRegExp.exec(value) === null) {
        other.push(value);
      } else {
        instances.push(value);
      }
    }

    // Special handle for `object` in case a value is mixed between type
    // and instance type.
    if (instances.length > 0) {
      const pos = types.indexOf('object');
      if (pos !== -1) {
        types.splice(pos, 1);
        instances.push('Object');
      }
    }

    if (types.length > 0) {
      message += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
      if (instances.length > 0 || other.length > 0)
        message += ' or ';
    }

    if (instances.length > 0) {
      message += `an instance of ${formatList(instances, 'or')}`;
      if (other.length > 0)
        message += ' or ';
    }

    if (other.length > 0) {
      if (other.length > 1) {
        message += `one of ${formatList(other, 'or')}`;
      } else {
        if (other[0].toLowerCase() !== other[0])
          message += 'an ';
        message += `${other[0]}`;
      }
    }

    message += `. Received ${determineSpecificType(actual)}`;

    super(message);
    this.code = 'ERR_INVALID_ARG_TYPE';
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }

  // This is a workaround for wpt tests that expect that the error
  // constructor has a `name` property of the base class.
  get ['constructor']() {
    return TypeError;
  }
}

function addNumericalSeparator(val) {
  let res = '';
  let i = val.length;
  const start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) {
    res = `_${val.slice(i - 3, i)}${res}`;
  }
  return `${val.slice(0, i)}${res}`;
}

class ERR_OUT_OF_RANGE extends RangeError {
  constructor(str, range, input, replaceDefaultBoolean = false) {
    if (!range) throw new Error('Missing "range" argument');
    let msg = replaceDefaultBoolean ? str : `The value of "${str}" is out of range.`;
    let received;
    if (Number.isInteger(input) && Math.abs(input) > 2 ** 32) {
      received = addNumericalSeparator(String(input));
    } else if (typeof input === 'bigint') {
      received = String(input);
      if (input > 2n ** 32n || input < -(2n ** 32n)) {
        received = addNumericalSeparator(received);
      }
      received += 'n';
    } else {
      received = inspect(input);
    }
    msg += ` It must be ${range}. Received ${received}`;
    super(msg);
    this.code = 'ERR_OUT_OF_RANGE';
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

class ERR_UNHANDLED_ERROR extends Error {
  constructor(err = undefined) {
    const msg = 'Unhandled error.';
    super(err === undefined ? msg : `${msg} (${err})`);
    this.code = 'ERR_UNHANDLED_ERROR';
  }

  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

class AbortError extends Error {
  constructor(message = 'The operation was aborted', options = undefined) {
    if (options !== undefined && typeof options !== 'object') {
      throw new ERR_INVALID_ARG_TYPE('options', 'Object', options);
    }
    super(message, options);
    this.code = 'ABORT_ERR';
    this.name = 'AbortError';
  }
}

// ---------------------------------------------------------------------------
// Validators (from internal/validators, trimmed to what events needs).
// ---------------------------------------------------------------------------
const validateObject = hideStackFrames((value, name) => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ERR_INVALID_ARG_TYPE(name, 'Object', value);
  }
});

const validateAbortSignal = hideStackFrames((signal, name) => {
  if (signal !== undefined &&
      (signal === null ||
       typeof signal !== 'object' ||
       !('aborted' in signal))) {
    throw new ERR_INVALID_ARG_TYPE(name, 'AbortSignal', signal);
  }
});

const validateFunction = hideStackFrames((value, name) => {
  if (typeof value !== 'function')
    throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
});

const validateString = hideStackFrames((value, name) => {
  if (typeof value !== 'string')
    throw new ERR_INVALID_ARG_TYPE(name, 'string', value);
});

const validateNumber = hideStackFrames((value, name, min = undefined, max) => {
  if (typeof value !== 'number')
    throw new ERR_INVALID_ARG_TYPE(name, 'number', value);

  if ((min != null && value < min) || (max != null && value > max) ||
    ((min != null || max != null) && Number.isNaN(value))) {
    throw new ERR_OUT_OF_RANGE(
      name,
      `${min != null ? `>= ${min}` : ''}${min != null && max != null ? ' && ' : ''}${max != null ? `<= ${max}` : ''}`,
      value);
  }
});

const validateInteger = hideStackFrames(
  (value, name, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
    if (typeof value !== 'number')
      throw new ERR_INVALID_ARG_TYPE(name, 'number', value);
    if (!Number.isInteger(value))
      throw new ERR_OUT_OF_RANGE(name, 'an integer', value);
    if (value < min || value > max)
      throw new ERR_OUT_OF_RANGE(name, `>= ${min} && <= ${max}`, value);
  },
);

// ---------------------------------------------------------------------------
// FixedQueue (from internal/fixed_queue).
// ---------------------------------------------------------------------------

// Currently optimal queue size, tested on V8 6.0 - 6.6. Must be power of two.
const kSize = 2048;
const kMask = kSize - 1;

class FixedCircularBuffer {
  constructor() {
    this.bottom = 0;
    this.top = 0;
    this.list = new Array(kSize).fill(undefined);
    this.next = null;
  }

  isEmpty() {
    return this.top === this.bottom;
  }

  isFull() {
    return ((this.top + 1) & kMask) === this.bottom;
  }

  push(data) {
    this.list[this.top] = data;
    this.top = (this.top + 1) & kMask;
  }

  shift() {
    const nextItem = this.list[this.bottom];
    if (nextItem === undefined)
      return null;
    this.list[this.bottom] = undefined;
    this.bottom = (this.bottom + 1) & kMask;
    return nextItem;
  }
}

class FixedQueue {
  static #pool = [];

  constructor() {
    this.head = this.tail = FixedQueue.#pool.pop() ?? new FixedCircularBuffer();
  }

  isEmpty() {
    return this.head.isEmpty();
  }

  push(data) {
    if (this.head.isFull()) {
      // Head is full: Creates a new queue, sets the old queue's `.next` to it,
      // and sets it as the new main queue.
      this.head = this.head.next = FixedQueue.#pool.pop() ?? new FixedCircularBuffer();
    }
    this.head.push(data);
  }

  shift() {
    const tail = this.tail;
    const next = tail.shift();
    if (tail.isEmpty() && tail.next !== null) {
      // If there is another queue, it forms the new tail.
      this.tail = tail.next;
      tail.next = null;
      tail.bottom = 0;
      tail.top = 0;

      if (FixedQueue.#pool.length < 64) {
        FixedQueue.#pool.push(tail); // Recycle old tail
      }
    }
    return next;
  }
}

// ---------------------------------------------------------------------------
// EventEmitter (verbatim port of Node v24.20.0 lib/events.js core).
// ---------------------------------------------------------------------------
let defaultMaxListeners = 10;
let EventEmitterAsyncResource;
// Live ESM binding for the `captureRejections` named export (Node's ESM
// exposes it too). This is the single store; the `EventEmitter.captureRejections`
// static below delegates to it and keeps `EventEmitter.prototype[kCapture]`
// in sync so instance construction (`init`) keeps working.
let captureRejections = false;

function _setMaxListeners(n, ...targets) {
  validateNumber(n, 'setMaxListeners', 0);
  if (targets.length === 0) {
    defaultMaxListeners = n;
  } else {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (isEventTarget(target)) {
        const sym = discoverOwnSymbol(target, 'events.maxEventTargetListeners');
        const warnedSym = discoverOwnSymbol(target, 'events.maxEventTargetListenersWarned');
        if (sym !== undefined) {
          target[sym] = n;
          if (warnedSym !== undefined) {
            target[warnedSym] = false;
          }
        } else {
          eventTargetMaxListenersFallback.set(target, n);
        }
      } else if (typeof target.setMaxListeners === 'function') {
        target.setMaxListeners(n);
      } else {
        throw new ERR_INVALID_ARG_TYPE(
          'eventTargets',
          ['EventEmitter', 'EventTarget'],
          target);
      }
    }
  }
}

function _getMaxListenersForTarget(emitterOrTarget) {
  if (typeof emitterOrTarget?.getMaxListeners === 'function') {
    return emitterOrTarget.getMaxListeners();
  }
  const sym = discoverOwnSymbol(emitterOrTarget, 'events.maxEventTargetListeners');
  if (sym !== undefined && typeof emitterOrTarget[sym] === 'number') {
    return emitterOrTarget[sym];
  }
  if (isEventTarget(emitterOrTarget)) {
    return eventTargetMaxListenersFallback.get(emitterOrTarget) ?? defaultMaxListeners;
  }
  throw new ERR_INVALID_ARG_TYPE(
    'emitter',
    ['EventEmitter', 'EventTarget'],
    emitterOrTarget);
}

// Fallback max-listener storage for EventTargets that do not carry Node's
// own `events.maxEventTargetListeners` symbol (e.g. foreign/browser ones).
const eventTargetMaxListenersFallback = new WeakMap();

class EventEmitter {
  constructor(opts) {
    EventEmitter.init.call(this, opts);
  }
}
EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
  __proto__: null,
  enumerable: true,
  get: function() {
    return defaultMaxListeners;
  },
  set: function(arg) {
    validateNumber(arg, 'defaultMaxListeners', 0);
    defaultMaxListeners = arg;
  },
});

EventEmitter.init = function(opts) {
  if (this._events === undefined ||
      this._events === Object.getPrototypeOf(this)._events) {
    this._events = { __proto__: null };
    this._eventsCount = 0;
  }

  this._maxListeners = this._maxListeners || undefined;

  if (opts?.captureRejections) {
    validateBoolean(opts.captureRejections, 'options.captureRejections');
    this[kCapture] = Boolean(opts.captureRejections);
  } else {
    // Assigning the kCapture property directly saves an expensive
    // prototype lookup in a very sensitive hot path.
    this[kCapture] = EventEmitter.prototype[kCapture];
  }

  if (opts?.signal !== undefined) {
    addAbortListener(opts.signal, () => {
      this.removeAllListeners();
    });
  }
};

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  validateNumber(n, 'setMaxListeners', 0);
  this._maxListeners = n;
  return this;
};

function _getMaxListenersForEmitter(that) {
  if (that._maxListeners === undefined)
    return defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return _getMaxListenersForEmitter(this);
};

EventEmitter.prototype.emit = function emit(type, ...args) {
  let doError = (type === 'error');

  const events = this._events;
  if (events !== undefined) {
    if (doError && events[kErrorMonitor] !== undefined)
      this.emit(kErrorMonitor, ...args);
    doError = (doError && events.error === undefined);
  } else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    const er = getUnhandledErrorException(this, args);
    // Note: The comments on the `throw` lines are intentional, they show
    // up in Node's output if this results in an unhandled exception.
    throw er; // Unhandled 'error' event
  }

  const handler = events[type];

  if (handler === undefined)
    return false;

  if (typeof handler === 'function') {
    const result = handler.apply(this, args);

    // We check if result is undefined first because that
    // is the most common case so we do not pay any perf
    // penalty
    if (result !== undefined && result !== null) {
      addCatch(this, result, type, args);
    }
  } else {
    const len = handler.length;
    const listeners = arrayClone(handler);
    for (let i = 0; i < len; ++i) {
      const result = listeners[i].apply(this, args);

      // We check if result is undefined first because that
      // is the most common case so we do not pay any perf
      // penalty.
      // This prevents the EventEmitter to unnecessarily have to
      // go through Await when there are no async listeners.
      if (result !== undefined && result !== null) {
        addCatch(this, result, type, args);
      }
    }
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  let m;
  let events;
  let existing;

  validateFunction(listener, 'listener');

  events = target._events;
  if (events === undefined) {
    events = target._events = { __proto__: null };
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener !== undefined) {
      target.emit('newListener', type,
                  listener.listener ?? listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (existing === undefined) {
    // Optimize the case of one listener. Don't need the extra array object.
    events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
        prepend ? [listener, existing] : [existing, listener];
      // If we've already got an array, just append.
    } else if (prepend) {
      existing.unshift(listener);
    } else {
      existing.push(listener);
    }

    // Check for listener leak
    m = _getMaxListenersForEmitter(target);
    if (m > 0 && existing.length > m && !existing.warned) {
      existing.warned = true;
      warnMaxListenersExceeded(target, type, existing, m);
    }
  }

  return target;
}

function warnMaxListenersExceeded(target, type, existing, m) {
  existing.warned = true;
  // No error code for this since it is a Warning
  const w = genericNodeError(
    `Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} listeners ` +
    `added to ${inspect(target)}. MaxListeners is ${m}. Use emitter.setMaxListeners() to increase limit`,
    { name: 'MaxListenersExceededWarning', emitter: target, type: type, count: existing.length });
  emitWarning(w);
}

/**
 * Adds a listener to the event emitter.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

/**
 * Adds the `listener` function to the beginning of
 * the listeners array.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function _onceWrap(target, type, listener) {
  let fired = false;
  function wrapper(...args) {
    if (fired) return;
    fired = true;
    target.removeListener(type, wrapper);
    return Reflect.apply(listener, target, args);
  }
  wrapper.listener = listener;
  return wrapper;
}

EventEmitter.prototype.once = function once(type, listener) {
  validateFunction(listener, 'listener');
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      validateFunction(listener, 'listener');
      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

/**
 * Removes a listener from the event emitter.
 * @param {string | symbol} type
 * @param {Function} listener
 * @returns {EventEmitter}
 */
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      validateFunction(listener, 'listener');

      const events = this._events;
      if (events === undefined)
        return this;

      const list = events[type];
      if (list === undefined)
        return this;

      if (list === listener || list.listener === listener) {
        if (--this._eventsCount === 0)
          this._events = { __proto__: null };
        else {
          delete events[type];
          if (events.removeListener !== undefined)
            this.emit('removeListener', type, list.listener ?? listener);
        }
      } else if (typeof list !== 'function') {
        let position = -1;

        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else {
          spliceOne(list, position);
        }

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener !== undefined)
          this.emit('removeListener', type, listener);
      }

      return this;
    };

EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      const events = this._events;
      if (events === undefined)
        return this;

      // Not listening for removeListener, no need to emit
      if (events.removeListener === undefined) {
        if (arguments.length === 0) {
          this._events = { __proto__: null };
          this._eventsCount = 0;
        } else if (events[type] !== undefined) {
          if (--this._eventsCount === 0)
            this._events = { __proto__: null };
          else
            delete events[type];
        }
        return this;
      }

      // Emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        for (const key of Object.keys(events)) {
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = { __proto__: null };
        this._eventsCount = 0;
        return this;
      }

      const listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners !== undefined) {
        // LIFO order
        for (let i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

function _listeners(target, type, unwrap) {
  const events = target._events;

  if (events === undefined)
    return [];

  const evlistener = events[type];
  if (evlistener === undefined)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ?
    unwrapListeners(evlistener) : arrayClone(evlistener);
}

EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};

EventEmitter.prototype.listenerCount = function listenerCount(type, listener) {
  const events = this._events;

  if (events !== undefined) {
    const evlistener = events[type];

    if (typeof evlistener === 'function') {
      if (listener != null) {
        return listener === evlistener || listener === evlistener.listener ? 1 : 0;
      }

      return 1;
    } else if (evlistener !== undefined) {
      if (listener != null) {
        let matching = 0;

        for (let i = 0, l = evlistener.length; i < l; i++) {
          if (evlistener[i] === listener || evlistener[i].listener === listener) {
            matching++;
          }
        }

        return matching;
      }

      return evlistener.length;
    }
  }

  return 0;
};

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

function arrayClone(arr) {
  // At least since V8 8.3, this implementation is faster than the previous
  // which used ArrayPrototypeSlice. See https://v8.dev/blog/elements-kinds
  // for details.
  const copy = new Array(arr.length);
  for (let i = 0; i < arr.length; ++i) {
    copy[i] = arr[i];
  }
  return copy;
}

function spliceOne(list, index) {
  for (; index + 1 < list.length; index++)
    list[index] = list[index + 1];
  list.pop();
}

function unwrapListeners(arr) {
  const ret = arrayClone(arr);
  for (let i = 0; i < ret.length; ++i) {
    const orig = ret[i].listener;
    if (typeof orig === 'function')
      ret[i] = orig;
  }
  return ret;
}

// About 1.5x faster than the two-arg version of Array#splice().
function identicalSequenceRange(a, b) {
  for (let i = 0; i < a.length - 3; i++) {
    // Find the first entry of b that matches the current entry of a.
    const pos = b.indexOf(a[i]);
    if (pos !== -1) {
      const rest = b.length - pos;
      if (rest > 3) {
        let len = 1;
        const maxLen = Math.min(a.length - i, rest);
        // Count the number of consecutive entries.
        while (maxLen > len && a[i + len] === b[pos + len]) {
          len++;
        }
        if (len > 3) {
          return [len, i];
        }
      }
    }
  }

  return [0, 0];
}

function enhanceStackTrace(err, own) {
  let ctorInfo = '';
  try {
    const { name } = this.constructor;
    if (name !== 'EventEmitter')
      ctorInfo = ` on ${name} instance`;
  } catch {
    // Continue regardless of error.
  }
  const sep = `\nEmitted 'error' event${ctorInfo} at:\n`;

  const errStack = err.stack.split('\n').slice(1);
  const ownStack = own.stack.split('\n').slice(1);

  const { len, offset } = identicalSequenceRange(ownStack, errStack);
  if (len > 0) {
    ownStack.splice(offset + 1, len - 2,
                    '    [... lines matching original stack trace ...]');
  }

  return err.stack + sep + ownStack.join('\n');
}

function getUnhandledErrorException(ee, args) {
  let er;
  if (args.length > 0)
    er = args[0];
  if (er instanceof Error) {
    try {
      const capture = {};
      captureStackTrace(capture, EventEmitter.prototype.emit);
      Object.defineProperty(er, kEnhanceStackBeforeInspector, {
        __proto__: null,
        value: enhanceStackTrace.bind(ee, er, capture),
        configurable: true,
      });
    } catch {
      // Continue regardless of error.
    }
    return er;
  }

  let stringifiedEr;
  try {
    stringifiedEr = inspect(er);
  } catch {
    stringifiedEr = er;
  }

  // At least give some kind of context to the user
  const err = new ERR_UNHANDLED_ERROR(stringifiedEr);
  err.context = er;
  return err;
}

function addCatch(that, promise, type, args) {
  if (!that[kCapture]) {
    return;
  }

  // Handle native promises and thenables that use the native promise
  // as a basis for their implementation.
  let then;
  try {
    then = promise.then;
  } catch {
    // If the then function throws, we consider the promise rejected.
    deferNextTick(emitUnhandledRejectionOrErr, that, promise, type, args);
    return;
  }

  // If the promise is rejected, handle the rejection.
  try {
    then.call(
      promise,
      undefined,
      function(err) {
        deferNextTick(emitUnhandledRejectionOrErr, that, err, type, args);
      },
    );
  } catch (err) {
    deferNextTick(emitUnhandledRejectionOrErr, that, err, type, args);
  }
}

function emitUnhandledRejectionOrErr(ee, err, type, args) {
  if (typeof ee[kRejection] === 'function') {
    ee[kRejection](err, type, ...args);
  } else {
    // We have to disable the capture rejections mechanism, otherwise
    // we might end up in an infinite loop.
    const prev = ee[kCapture];

    // If the error handler throws, it is not catchable and it
    // will end up in 'uncaughtException'. We restore the previous
    // value of kCapture in case the uncaughtException is present
    // and the exception is handled.
    try {
      ee[kCapture] = false;
      ee.emit('error', err);
    } finally {
      ee[kCapture] = prev;
    }
  }
}

// ---------------------------------------------------------------------------
// Promise / async-iterator helpers.
// ---------------------------------------------------------------------------
const kFirstEventParam = Symbol.for('nodejs.kFirstEventParam');

const validateBoolean = hideStackFrames((value, name) => {
  if (typeof value !== 'boolean')
    throw new ERR_INVALID_ARG_TYPE(name, 'boolean', value);
});

async function once(emitter, name, options = kEmptyObject) {
  validateObject(options, 'options');
  const { signal } = options;
  validateAbortSignal(signal, 'options.signal');
  if (signal?.aborted)
    throw new AbortError(undefined, { cause: signal.reason });
  return new Promise((resolve, reject) => {
    const errorListener = (err) => {
      emitter.removeListener(name, resolver);
      if (signal != null) {
        eventTargetAgnosticRemoveListener(signal, 'abort', abortListener);
      }
      reject(err);
    };
    const resolver = (...args) => {
      if (typeof emitter.removeListener === 'function') {
        emitter.removeListener('error', errorListener);
      }
      if (signal != null) {
        eventTargetAgnosticRemoveListener(signal, 'abort', abortListener);
      }
      resolve(args);
    };

    const opts = { __proto__: null, once: true, [kResistStopPropagation]: true };
    eventTargetAgnosticAddListener(emitter, name, resolver, opts);
    if (name !== 'error' && typeof emitter.once === 'function') {
      // EventTarget does not have `error` event semantics like Node
      // EventEmitters, we listen to `error` events only on EventEmitters.
      emitter.once('error', errorListener);
    }
    function abortListener() {
      eventTargetAgnosticRemoveListener(emitter, name, resolver);
      eventTargetAgnosticRemoveListener(emitter, 'error', errorListener);
      reject(new AbortError(undefined, { cause: signal?.reason }));
    }
    if (signal != null) {
      // Registered through the abort-listener bridge so the cleanup still
      // fires when an earlier abort listener stops propagation (Node-only
      // guarantee; plain addEventListener elsewhere).
      addAbortListenerInternal(signal, abortListener);
    }
  });
}

function createIterResult(value, done) {
  return { value, done };
}

function eventTargetAgnosticRemoveListener(emitter, name, listener, flags) {
  if (typeof emitter.removeListener === 'function') {
    emitter.removeListener(name, listener);
  } else if (typeof emitter.removeEventListener === 'function') {
    emitter.removeEventListener(name, listener);
  } else {
    throw new ERR_INVALID_ARG_TYPE('emitter', 'EventEmitter', emitter);
  }
}

function eventTargetAgnosticAddListener(emitter, name, listener, flags) {
  if (typeof emitter.on === 'function') {
    if (flags?.once) {
      emitter.once(name, listener);
    } else {
      emitter.on(name, listener);
    }
  } else if (typeof emitter.addEventListener === 'function') {
    emitter.addEventListener(name, listener, flags);
  } else {
    throw new ERR_INVALID_ARG_TYPE('emitter', 'EventEmitter', emitter);
  }
}

function on(emitter, event, options = kEmptyObject) {
  validateObject(options, 'options');
  const signal = options.signal;
  validateAbortSignal(signal, 'options.signal');
  if (signal?.aborted)
    throw new AbortError(undefined, { cause: signal.reason });

  // Support both highWaterMark and highWatermark for backward compatibility
  const highWatermark = options.highWaterMark ?? options.highWatermark ?? Number.MAX_SAFE_INTEGER;
  validateInteger(highWatermark, 'options.highWaterMark', 1);

  // Support both lowWaterMark and lowWatermark for backward compatibility
  const lowWatermark = options.lowWaterMark ?? options.lowWatermark ?? 1;
  validateInteger(lowWatermark, 'options.lowWaterMark', 1);

  // Preparing controlling queues and variables
  const unconsumedEvents = new FixedQueue();
  const unconsumedPromises = new FixedQueue();
  let paused = false;
  let error = null;
  let finished = false;
  let size = 0;

  const iterator = Object.setPrototypeOf({
    next() {
      // First, we consume all unread events
      if (size) {
        const value = unconsumedEvents.shift();
        size--;
        if (paused && size < lowWatermark) {
          emitter.resume(); // Can not be finished yet
          paused = false;
        }
        return Promise.resolve(createIterResult(value, false));
      }

      // Then we error, if an error happened
      // This happens one time if at all, because after 'error'
      // we stop listening
      if (error) {
        const p = Promise.reject(error);
        // Only the first element errors
        error = null;
        return p;
      }

      // If the iterator is finished, resolve to done
      if (finished) return closeHandler();

      // Wait until an event happens
      return new Promise(function(resolve, reject) {
        unconsumedPromises.push({ resolve, reject });
      });
    },

    return() {
      return closeHandler();
    },

    throw(err) {
      if (!err || !(err instanceof Error)) {
        throw new ERR_INVALID_ARG_TYPE('EventEmitter.AsyncIterator',
                                       'Error', err);
      }
      errorHandler(err);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [kWatermarkData]: {
      /**
       * The current queue size
       * @returns {number}
       */
      get size() {
        return size;
      },
      /**
       * The low watermark. The emitter is resumed every time size is lower than it
       * @returns {number}
       */
      get low() {
        return lowWatermark;
      },
      /**
       * The high watermark. The emitter is paused every time size is higher than it
       * @returns {number}
       */
      get high() {
        return highWatermark;
      },
      /**
       * It checks whether the emitter is paused by the watermark controller or not
       * @returns {boolean}
       */
      get isPaused() {
        return paused;
      },
    },
  }, AsyncIteratorPrototype);

  // Adding event handlers
  const { addEventListener, removeAll } = listenersController();
  addEventListener(emitter, event, options[kFirstEventParam] ? eventHandler : function(...args) {
    return eventHandler(args);
  });
  if (event !== 'error' && typeof emitter.on === 'function') {
    addEventListener(emitter, 'error', errorHandler);
  }
  const closeEvents = options?.close;
  if (closeEvents?.length) {
    for (let i = 0; i < closeEvents.length; i++) {
      addEventListener(emitter, closeEvents[i], closeHandler);
    }
  }

  const abortListenerDisposable = signal ? addAbortListenerInternal(signal, abortListener) : null;

  return iterator;

  function abortListener() {
    errorHandler(new AbortError(undefined, { cause: signal?.reason }));
  }

  function eventHandler(value) {
    if (unconsumedPromises.isEmpty()) {
      size++;
      if (!paused && size > highWatermark) {
        paused = true;
        emitter.pause();
      }
      unconsumedEvents.push(value);
    } else unconsumedPromises.shift().resolve(createIterResult(value, false));
  }

  function errorHandler(err) {
    if (unconsumedPromises.isEmpty()) error = err;
    else unconsumedPromises.shift().reject(err);

    closeHandler();
  }

  function closeHandler() {
    abortListenerDisposable?.[SymbolDispose]();
    removeAll();
    finished = true;
    paused = false;
    const doneResult = createIterResult(undefined, true);
    while (!unconsumedPromises.isEmpty()) {
      unconsumedPromises.shift().resolve(doneResult);
    }

    return Promise.resolve(doneResult);
  }
}

function listenersController() {
  const listeners = [];

  return {
    addEventListener(emitter, event, handler, flags) {
      eventTargetAgnosticAddListener(emitter, event, handler, flags);
      listeners.push([emitter, event, handler, flags]);
    },
    removeAll() {
      while (listeners.length > 0) {
        Reflect.apply(eventTargetAgnosticRemoveListener, undefined, listeners.pop());
      }
    },
  };
}

// ---------------------------------------------------------------------------
// EventTarget interop.
// ---------------------------------------------------------------------------
function isEventTarget(obj) {
  if (obj === null || obj === undefined) return false;
  try {
    if (obj.constructor?.[kIsEventTarget]) return true;
  } catch {
    // Continue regardless of error.
  }
  return typeof EventTarget === 'function' && obj instanceof EventTarget;
}

/** Find an own symbol of `target` by its description (e.g. Node's `kEvents`). */
function discoverOwnSymbol(target, description) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  const symbols = Object.getOwnPropertySymbols(target);
  for (let i = 0; i < symbols.length; i++) {
    if (symbols[i].description === description) return symbols[i];
  }
  return undefined;
}

/**
 * Pure-JS fallback for addAbortListener (used when the real Node builtin is
 * unavailable, e.g. in browsers). Note: unlike Node's version this cannot
 * resist an earlier listener calling `stopImmediatePropagation()`, because
 * that guarantee relies on Node's private `kResistStopPropagation` symbol.
 */
function pureAddAbortListener(signal, listener) {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE('signal', 'AbortSignal', signal);
  }
  validateAbortSignal(signal, 'signal');
  validateFunction(listener, 'listener');

  let removeEventListener;
  if (signal.aborted) {
    queueMicrotask(() => listener());
  } else {
    signal.addEventListener('abort', listener, { __proto__: null, once: true, [kResistStopPropagation]: true });
    removeEventListener = () => {
      signal.removeEventListener('abort', listener);
    };
  }

  return {
    __proto__: null,
    [SymbolDispose]() {
      removeEventListener?.();
    },
  };
}

let cachedRealAddAbortListener; // undefined = not probed yet, null = unavailable
function realAddAbortListener() {
  if (cachedRealAddAbortListener === undefined) {
    const mod = getBuiltinModuleSafe('events');
    const fn = mod?.addAbortListener;
    cachedRealAddAbortListener =
      (typeof fn === 'function' && fn !== addAbortListener) ? fn : null;
  }
  return cachedRealAddAbortListener;
}

/** Internal abort-listener registration: real builtin when available. */
function addAbortListenerInternal(signal, listener) {
  const real = realAddAbortListener();
  if (real) return real(signal, listener);
  return pureAddAbortListener(signal, listener);
}

function addAbortListener(signal, listener) {
  return addAbortListenerInternal(signal, listener);
}

function getEventListeners(emitterOrTarget, type) {
  // First, we check if the emitterOrTarget is an EventEmitter.
  if (typeof emitterOrTarget.listeners === 'function') {
    return emitterOrTarget.listeners(type);
  }
  // Then, we check if the emitterOrTarget is an EventTarget.
  if (isEventTarget(emitterOrTarget)) {
    const kEvents = discoverOwnSymbol(emitterOrTarget, 'kEvents');
    const root = kEvents === undefined ? undefined : emitterOrTarget[kEvents]?.get(type);
    const listeners = [];
    let handler = root?.next;
    while (handler?.listener !== undefined) {
      const listener = handler.listener?.deref ? handler.listener.deref() : handler.listener;
      listeners.push(listener);
      handler = handler.next;
    }
    return listeners;
  }
  throw new ERR_INVALID_ARG_TYPE(
    'emitter',
    ['EventEmitter', 'EventTarget'],
    emitterOrTarget);
}

function listenerCount(emitterOrTarget, type) {
  if (typeof emitterOrTarget.listenerCount === 'function') {
    return emitterOrTarget.listenerCount(type);
  }
  const kEvents = discoverOwnSymbol(emitterOrTarget, 'kEvents');
  if (kEvents === undefined) return 0;
  return emitterOrTarget[kEvents]?.get(type)?.size ?? 0;
}

// ---------------------------------------------------------------------------
// Statics.
// ---------------------------------------------------------------------------
EventEmitter.setMaxListeners = _setMaxListeners;

Object.defineProperty(EventEmitter, 'captureRejections', {
  __proto__: null,
  get() {
    return captureRejections;
  },
  set(value) {
    validateBoolean(value, 'EventEmitter.captureRejections');

    captureRejections = value;
    EventEmitter.prototype[kCapture] = value;
  },
  enumerable: true,
});

Object.defineProperty(EventEmitter, 'EventEmitterAsyncResource', {
  __proto__: null,
  enumerable: true,
  get: function lazyEventEmitterAsyncResource() {
    if (EventEmitterAsyncResource === undefined) {
      // Prefer the genuine builtin under Node; fall back to our own
      // async_hooks port so this stays constructible in browsers (backed by
      // the stub AsyncResource — honest, documented limits — instead of
      // throwing at import time).
      const mod = getBuiltinModuleSafe('async_hooks');
      const AsyncResource = mod?.AsyncResource ?? LocalAsyncResource;
      if (typeof AsyncResource !== 'function') {
        throw new Error(
          'EventEmitterAsyncResource requires the async_hooks module, which is unavailable in this environment');
      }

      class EventEmitterReferencingAsyncResource extends AsyncResource {
        #eventEmitter;

        /**
         * @param {EventEmitter} ee
         * @param {string} [type]
         * @param {{
         *   triggerAsyncId?: number,
         *   requireManualDestroy?: boolean,
         * }} [options]
         */
        constructor(ee, type, options) {
          super(type, options);
          this.#eventEmitter = ee;
        }

        /**
         * @type {EventEmitter}
         */
        get eventEmitter() {
          return this.#eventEmitter;
        }
      }

      EventEmitterAsyncResource =
        class EventEmitterAsyncResource extends EventEmitter {
          #asyncResource;

          /**
           * @param {{
           *   name?: string,
           *   triggerAsyncId?: number,
           *   requireManualDestroy?: boolean,
           * }} [options]
           */
          constructor(options = undefined) {
            let name;
            if (typeof options === 'string') {
              name = options;
              options = undefined;
            } else {
              validateString(options?.name, 'options.name');
              name = options?.name || 'EventEmitterAsyncResource';
            }
            super(options);

            this.#asyncResource = new EventEmitterReferencingAsyncResource(this, name, options);
          }

          /**
           * @param {symbol|string} event
           * @param {any[]} args
           * @returns {boolean}
           */
          emit(event, ...args) {
            const asyncResource = this.#asyncResource;
            args.unshift(super.emit, this, event);
            return Reflect.apply(asyncResource.runInAsyncScope, asyncResource,
                                 args);
          }

          /**
           * @returns {void}
           */
          emitDestroy() {
            this.#asyncResource.emitDestroy();
          }

          /**
           * @type {number}
           */
          get asyncId() {
            return this.#asyncResource.asyncId();
          }

          /**
           * @type {number}
           */
          get triggerAsyncId() {
            return this.#asyncResource.triggerAsyncId();
          }

          /**
           * @type {EventEmitterReferencingAsyncResource}
           */
          get asyncResource() {
            return this.#asyncResource;
          }
        };
      Object.defineProperty(EventEmitterAsyncResource, 'name', {
        __proto__: null,
        value: 'EventEmitterAsyncResource',
      });
    }
    return EventEmitterAsyncResource;
  },
  set: undefined,
  configurable: true,
});

EventEmitter.errorMonitor = kErrorMonitor;

// Mirror Node's `module.exports = EventEmitter` with helpers attached, so
// `require('events')` (which the parity preload maps to the default export)
// exposes the same surface as the real builtin.
EventEmitter.addAbortListener = addAbortListener;
EventEmitter.once = once;
EventEmitter.on = on;
EventEmitter.getEventListeners = getEventListeners;
EventEmitter.getMaxListeners = getMaxListeners;
EventEmitter.listenerCount = listenerCount;
EventEmitter.usingDomains = false;
EventEmitter.captureRejectionSymbol = kRejection;

// The default for captureRejections is false
Object.defineProperty(EventEmitter.prototype, kCapture, {
  __proto__: null,
  value: false,
  writable: true,
  enumerable: false,
});

function getMaxListeners(emitterOrTarget) {
  return _getMaxListenersForTarget(emitterOrTarget);
}

// ---------------------------------------------------------------------------
// Exports (mirror Node: `require('events')` is the EventEmitter class with
// the helpers attached as properties).
// ---------------------------------------------------------------------------
// Resolve the lazy `EventEmitterAsyncResource` class now so the named export
// below carries the class itself (Node's ESM namespace exposes it too).
// Safe in browsers: the getter falls back to our async_hooks port instead of
// throwing when the native builtin is unavailable.
void EventEmitter.EventEmitterAsyncResource;

export default EventEmitter;
// Node v24.20.0 also exposes `init` and `usingDomains` as named ESM exports
// (they are properties of the EventEmitter class, like the other statics).
const init = EventEmitter.init;
const usingDomains = EventEmitter.usingDomains;
export {
  EventEmitter,
  once,
  on,
  getEventListeners,
  getMaxListeners,
  listenerCount,
  addAbortListener,
  init,
  usingDomains,
  // Additional Node v24.20.0 named exports (all present on the default
  // `EventEmitter` as well, exactly like `require('events')`):
  _setMaxListeners as setMaxListeners,
  defaultMaxListeners, // live binding: reflects `EventEmitter.defaultMaxListeners = n`
  kErrorMonitor as errorMonitor,
  kRejection as captureRejectionSymbol,
  captureRejections, // live binding: reflects `EventEmitter.captureRejections = b`
  EventEmitterAsyncResource,
};
