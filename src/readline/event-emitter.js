// src/readline/event-emitter.js
//
// Self-contained EventEmitter for the readline port.
//
// Why not `../events.js`? That module statically imports `./async_hooks.js`,
// which imports the `als-browser` npm package — and `als-browser` replaces
// `globalThis.setTimeout/setInterval/setImmediate/queueMicrotask` at import
// time. Node's official test harness (`test/common`) fails any test file
// whose imports add or replace globals, so every readline test failed at the
// `process.on('exit')` leak check. This file implements the EventEmitter
// semantics the readline port actually needs (instance API plus the static
// `EventEmitter.on()` async iterator with watermark/close/abort support)
// with zero imports and zero global side effects.
//
// Faithful to Node.js v24.20.0 lib/events.js for the covered surface:
// newListener/removeListener events, once() wrapper identity, unhandled
// 'error' throws, max-listeners warning, and the events.on() iterator
// contract (buffering, highWaterMark pause, lowWaterMark resume,
// close events, error propagation, Symbol.for('nodejs.watermarkData')).

const kWatermarkData = Symbol.for("nodejs.watermarkData");
const kFirstEventParam = Symbol.for("nodejs.kFirstEventParam");
const kCapture = Symbol.for("nodejs.rejection");
const kDisposed = Symbol.dispose ?? Symbol("Symbol.dispose");

function makeAbortError(cause) {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  if (cause !== undefined) err.cause = cause;
  return err;
}

function emitWarning(warning) {
  try {
    const proc = globalThis.process;
    if (proc && typeof proc.emitWarning === "function") {
      proc.emitWarning(warning);
      return;
    }
  } catch {
    // ignore
  }
}

class EventEmitter {
  constructor() {
    EventEmitter.init.call(this);
  }

  static init(emitter) {
    const target = emitter ?? this;
    if (target._events !== undefined) return;
    target._events = Object.create(null);
    target._eventsCount = 0;
    target._maxListeners = undefined;
  }

  static get defaultMaxListeners() {
    return 10;
  }

  setMaxListeners(n) {
    if (typeof n !== "number" || n < 0 || Number.isNaN(n)) {
      const err = new RangeError(
        `The value of "n" is out of range. It must be a non-negative number. Received ${n}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    this._maxListeners = n;
    return this;
  }

  getMaxListeners() {
    return this._maxListeners ?? EventEmitter.defaultMaxListeners;
  }

  _addListener(type, listener, prepend) {
    if (typeof listener !== "function") {
      const err = new TypeError(
        `The "listener" argument must be of type function. Received type ${typeof listener}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    EventEmitter.init.call(this);
    // 'newListener' is emitted BEFORE the listener is added, and adding a
    // 'newListener' listener itself must not recurse.
    if (this._events.newListener !== undefined && type !== "newListener") {
      this.emit("newListener", type, listener);
    }
    const events = this._events;
    const existing = events[type];
    if (existing === undefined) {
      events[type] = listener;
      this._eventsCount++;
    } else if (typeof existing === "function") {
      events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) {
      existing.unshift(listener);
    } else {
      existing.push(listener);
    }
    const max = this.getMaxListeners();
    const count = Array.isArray(events[type]) ? events[type].length : 1;
    if (max > 0 && count > max && !events[type].warned) {
      events[type].warned = true;
      const warning = new Error(
        `Possible EventEmitter memory leak detected. ${count} ${String(type)} listeners added. Use emitter.setMaxListeners() to increase limit`,
      );
      warning.name = "MaxListenersExceededWarning";
      emitWarning(warning);
    }
    return this;
  }

  on(type, listener) {
    return this._addListener(type, listener, false);
  }
  addListener(type, listener) {
    return this.on(type, listener);
  }
  prependListener(type, listener) {
    return this._addListener(type, listener, true);
  }

  once(type, listener) {
    if (typeof listener !== "function") {
      const err = new TypeError(
        `The "listener" argument must be of type function. Received type ${typeof listener}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const state = { fired: false, target: this, type, listener };
    const wrapper = function (...args) {
      if (!state.fired) {
        state.fired = true;
        state.target.off(state.type, wrapper);
        Reflect.apply(state.listener, state.target, args);
      }
    };
    wrapper.listener = listener;
    return this.on(type, wrapper);
  }

  prependOnceListener(type, listener) {
    if (typeof listener !== "function") {
      const err = new TypeError(
        `The "listener" argument must be of type function. Received type ${typeof listener}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const state = { fired: false, target: this, type, listener };
    const wrapper = function (...args) {
      if (!state.fired) {
        state.fired = true;
        state.target.off(state.type, wrapper);
        Reflect.apply(state.listener, state.target, args);
      }
    };
    wrapper.listener = listener;
    return this.prependListener(type, wrapper);
  }

  off(type, listener) {
    return this.removeListener(type, listener);
  }

  removeListener(type, listener) {
    if (typeof listener !== "function") {
      const err = new TypeError(
        `The "listener" argument must be of type function. Received type ${typeof listener}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const events = this._events;
    if (events === undefined) return this;
    const list = events[type];
    if (list === undefined) return this;
    if (list === listener || list.listener === listener) {
      if (--this._eventsCount === 0) this._events = Object.create(null);
      else delete events[type];
      if (events.removeListener !== undefined) {
        this.emit("removeListener", type, list.listener ?? listener);
      }
    } else if (Array.isArray(list)) {
      let position = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i] === listener || list[i].listener === listener) {
          position = i;
          break;
        }
      }
      if (position !== -1) {
        const original = list[position].listener ?? listener;
        if (position === 0) list.shift();
        else list.splice(position, 1);
        if (list.length === 1) events[type] = list[0];
        if (events.removeListener !== undefined) {
          this.emit("removeListener", type, original);
        }
      }
    }
    return this;
  }

  removeAllListeners(type) {
    const events = this._events;
    if (events === undefined) return this;
    if (events.removeListener === undefined) {
      if (type === undefined) {
        this._events = Object.create(null);
        this._eventsCount = 0;
      } else if (events[type] !== undefined) {
        if (--this._eventsCount === 0) this._events = Object.create(null);
        else delete events[type];
      }
      return this;
    }
    if (type === undefined) {
      const keys = Object.keys(events);
      for (const key of keys) {
        if (key === "removeListener") continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners("removeListener");
      this._events = Object.create(null);
      this._eventsCount = 0;
      return this;
    }
    const listeners = events[type];
    if (typeof listeners === "function") {
      this.removeListener(type, listeners);
    } else if (Array.isArray(listeners)) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        this.removeListener(type, listeners[i]);
      }
    }
    return this;
  }

  emit(type, ...args) {
    const events = this._events;
    const handler = events?.[type];
    if (handler === undefined) {
      if (type === "error") {
        const err = args[0];
        if (err instanceof Error) throw err;
        const unhandled = new Error(`Unhandled 'error' event: ${err}`);
        unhandled.code = "ERR_UNHANDLED_ERROR";
        unhandled.context = err;
        throw unhandled;
      }
      return false;
    }
    if (typeof handler === "function") {
      Reflect.apply(handler, this, args);
    } else {
      const len = handler.length;
      const listeners = handler.slice();
      for (let i = 0; i < len; i++) {
        Reflect.apply(listeners[i], this, args);
      }
    }
    return true;
  }

  listenerCount(type) {
    const events = this._events;
    const list = events?.[type];
    if (typeof list === "function") return 1;
    return list?.length ?? 0;
  }

  listeners(type) {
    const list = this._events?.[type];
    if (typeof list === "function") return [list.listener ?? list];
    return (list ?? []).map((l) => l.listener ?? l);
  }

  rawListeners(type) {
    const list = this._events?.[type];
    if (typeof list === "function") return [list];
    return (list ?? []).slice();
  }

  eventNames() {
    return this._eventsCount > 0 ? Object.keys(this._events) : [];
  }

  // ── static events.on(): async iterator over emitter events ────────────
  // Faithful to Node's lib/events.js `on()`: buffering with high/low
  // watermarks driving pause()/resume(), close-event termination, error
  // propagation, abort-signal support, and the
  // Symbol.for('nodejs.watermarkData') introspection hook the official
  // readline backpressure test reads.
  static on(emitter, event, options = {}) {
    if (options !== null && typeof options !== "object") {
      const err = new TypeError(
        `The "options" argument must be of type object. Received type ${typeof options}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
    const signal = options.signal;
    if (signal !== undefined && signal !== null) {
      if (typeof signal !== "object" || typeof signal.aborted !== "boolean") {
        const err = new TypeError(
          `The "options.signal" argument must be of type AbortSignal.`,
        );
        err.code = "ERR_INVALID_ARG_TYPE";
        throw err;
      }
      if (signal.aborted) throw makeAbortError(signal.reason);
    }
    const highWatermark =
      options.highWaterMark ?? options.highWatermark ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(highWatermark) || highWatermark < 1) {
      const err = new RangeError(
        `The value of "options.highWaterMark" is out of range. It must be an integer >= 1. Received ${highWatermark}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }
    const lowWatermark = options.lowWaterMark ?? options.lowWatermark ?? 1;
    if (!Number.isInteger(lowWatermark) || lowWatermark < 1) {
      const err = new RangeError(
        `The value of "options.lowWaterMark" is out of range. It must be an integer >= 1. Received ${lowWatermark}`,
      );
      err.code = "ERR_OUT_OF_RANGE";
      throw err;
    }

    const unconsumedEvents = [];
    const unconsumedPromises = [];
    let paused = false;
    let error = null;
    let finished = false;
    let size = 0;

    const addListener = (em, ev, fn) => {
      if (typeof em.on === "function") em.on(ev, fn);
      else if (typeof em.addEventListener === "function") {
        em.addEventListener(ev, fn);
      } else {
        throw new TypeError("emitter must support .on()");
      }
    };
    const removeListener = (em, ev, fn) => {
      if (typeof em.off === "function") em.off(ev, fn);
      else if (typeof em.removeListener === "function")
        em.removeListener(ev, fn);
      else if (typeof em.removeEventListener === "function") {
        em.removeEventListener(ev, fn);
      }
    };

    function createIterResult(value, done) {
      return { value, done };
    }

    function eventHandler(value) {
      if (unconsumedPromises.length === 0) {
        size++;
        if (!paused && size > highWatermark) {
          paused = true;
          emitter.pause();
        }
        unconsumedEvents.push(value);
      } else {
        unconsumedPromises.shift().resolve(createIterResult(value, false));
      }
    }

    function errorHandler(err) {
      if (unconsumedPromises.length === 0) error = err;
      else unconsumedPromises.shift().reject(err);
      closeHandler();
    }

    function closeHandler() {
      if (signal && typeof abortOff === "function") abortOff();
      removeListener(emitter, event, onEvent);
      if (event !== "error") removeListener(emitter, "error", errorHandler);
      for (const ev of closeEvents) removeListener(emitter, ev, closeHandler);
      finished = true;
      paused = false;
      const doneResult = createIterResult(undefined, true);
      while (unconsumedPromises.length > 0) {
        unconsumedPromises.shift().resolve(doneResult);
      }
      return Promise.resolve(doneResult);
    }

    const onEvent = options[kFirstEventParam]
      ? eventHandler
      : (...args) => eventHandler(args);

    addListener(emitter, event, onEvent);
    if (event !== "error" && typeof emitter.on === "function") {
      addListener(emitter, "error", errorHandler);
    }
    const closeEvents = options.close ?? [];
    for (const ev of closeEvents) addListener(emitter, ev, closeHandler);

    let abortOff = null;
    if (signal) {
      const abortListener = () => errorHandler(makeAbortError(signal.reason));
      signal.addEventListener("abort", abortListener, { once: true });
      abortOff = () => signal.removeEventListener("abort", abortListener);
    }

    const iterator = {
      next() {
        if (size > 0) {
          const value = unconsumedEvents.shift();
          size--;
          if (paused && size < lowWatermark) {
            emitter.resume();
            paused = false;
          }
          return Promise.resolve(createIterResult(value, false));
        }
        if (error !== null) {
          const p = Promise.reject(error);
          error = null;
          return p;
        }
        if (finished) return closeHandler();
        return new Promise((resolve, reject) => {
          unconsumedPromises.push({ resolve, reject });
        });
      },
      return() {
        return closeHandler();
      },
      throw(err) {
        if (!err || !(err instanceof Error)) {
          const typeErr = new TypeError(
            `The "EventEmitter.AsyncIterator" argument must be of type Error.`,
          );
          typeErr.code = "ERR_INVALID_ARG_TYPE";
          throw typeErr;
        }
        errorHandler(err);
        return Promise.resolve(createIterResult(undefined, true));
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [kWatermarkData]: {
        get size() {
          return size;
        },
        get low() {
          return lowWatermark;
        },
        get high() {
          return highWatermark;
        },
        get isPaused() {
          return paused;
        },
      },
    };

    // Match Node: the iterator's prototype is %AsyncIteratorPrototype%
    // (proto of the async-generator object prototype's proto).
    let asyncIterProto = null;
    try {
      const genObjectProto = Object.getPrototypeOf(
        async function* () {}.prototype,
      );
      asyncIterProto = Object.getPrototypeOf(genObjectProto);
    } catch {
      // ignore — prototype shaping is cosmetic
    }
    if (asyncIterProto) Object.setPrototypeOf(iterator, asyncIterProto);

    void kCapture;
    void kDisposed;
    return iterator;
  }

  static listenerCount(emitter, event) {
    if (typeof emitter.listenerCount === "function") {
      return emitter.listenerCount(event);
    }
    const list = emitter._events?.[event];
    if (typeof list === "function") return 1;
    return list?.length ?? 0;
  }
}

export { EventEmitter };
export default EventEmitter;
