/**
 * Port of Node.js v24.20.0 lib/diagnostics_channel.js to dependency-free ESM.
 *
 * Browser-safe: uses only standard builtins (Map, Set, WeakRef,
 * FinalizationRegistry, Promise, Reflect). Node-internal helpers are
 * re-implemented below with identical observable behavior:
 *   - internal/errors ERR_INVALID_ARG_TYPE  -> local TypeError subclass
 *     (same message wording, same `.code`)
 *   - internal/validators validateFunction -> local check
 *   - internalBinding('errors').triggerUncaughtException ->
 *     process.nextTick(() => { throw err }) so subscriber errors surface
 *     through 'uncaughtException' exactly like Node
 *   - internalBinding('diagnostics_channel') -> inert stub. In Node this
 *     links native channels used by internal fast paths; the polyfill has
 *     no native channels, so `_index` stays undefined and the
 *     `dc_binding.subscribers` bookkeeping branches are skipped.
 *   - internal/util WeakReference -> local WeakRef + pin-set emulation
 *     (incRef/decRef keep channels with subscribers/stores alive, matching
 *     the GC semantics the official tests assert)
 */

import process from 'process';

// ---------------------------------------------------------------------------
// Primordial captures (defensive copies of builtins, evaluated once).
// ---------------------------------------------------------------------------

const ArrayPrototypeAt = Array.prototype.at;
const ArrayPrototypeIndexOf = Array.prototype.indexOf;
const ArrayPrototypePush = Array.prototype.push;
const ArrayPrototypeSlice = Array.prototype.slice;
const ArrayPrototypeSplice = Array.prototype.splice;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectSetPrototypeOf = Object.setPrototypeOf;
const PromisePrototypeThen = Promise.prototype.then;
const ReflectApply = Reflect.apply;
const SymbolHasInstance = Symbol.hasInstance;

function arrayPush(arr, ...items) {
  return ReflectApply(ArrayPrototypePush, arr, items);
}
function arraySlice(arr, start, end) {
  return ReflectApply(ArrayPrototypeSlice, arr, start === undefined ? [] : end === undefined ? [start] : [start, end]);
}
function arraySplice(arr, ...items) {
  return ReflectApply(ArrayPrototypeSplice, arr, items);
}

// ---------------------------------------------------------------------------
// ERR_INVALID_ARG_TYPE (port of the message builder in
// lib/internal/errors.js, Node v24.20.0).
// ---------------------------------------------------------------------------

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
const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;

function formatList(array, type = 'and') {
  switch (array.length) {
    case 0: return '';
    case 1: return `${array[0]}`;
    case 2: return `${array[0]} ${type} ${array[1]}`;
    case 3: return `${array[0]}, ${array[1]}, ${type} ${array[2]}`;
    default:
      return `${arraySlice(array, 0, -1).join(', ')}, ${type} ${array[array.length - 1]}`;
  }
}

function miniInspect(value) {
  // Fallback for the rare `determineSpecificType` object branch where no
  // constructor name is available (e.g. Object.create(null)). Only needs to
  // be non-crashing; the diagnostics_channel tests never reach it.
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

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
      return `${miniInspect(value)}`;
    case 'string':
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (!value.includes("'")) {
        return `type string ('${value}')`;
      }
      return `type string (${JSON.stringify(value)})`;
    default: {
      let inspected = miniInspect(value);
      if (inspected.length > 28) {
        inspected = `${inspected.slice(0, 25)}...`;
      }
      return `type ${type} (${inspected})`;
    }
  }
}

function buildInvalidArgTypeMessage(name, expected, actual) {
  if (!Array.isArray(expected)) {
    expected = [expected];
  }

  let msg = 'The ';
  if (name.endsWith(' argument')) {
    // For cases like 'first argument'
    msg += `${name} `;
  } else {
    const type = name.includes('.') ? 'property' : 'argument';
    msg += `"${name}" ${type} `;
  }
  msg += 'must be ';

  const types = [];
  const instances = [];
  const other = [];

  for (const value of expected) {
    if (kTypes.includes(value)) {
      arrayPush(types, value.toLowerCase());
    } else if (classRegExp.exec(value) !== null) {
      arrayPush(instances, value);
    } else {
      arrayPush(other, value);
    }
  }

  // Special handle `object` in case other instances are allowed to outline
  // the differences between each other.
  if (instances.length > 0) {
    const pos = types.indexOf('object');
    if (pos !== -1) {
      arraySplice(types, pos, 1);
      arrayPush(instances, 'Object');
    }
  }

  if (types.length > 0) {
    msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
    if (instances.length > 0 || other.length > 0)
      msg += ' or ';
  }

  if (instances.length > 0) {
    msg += `an instance of ${formatList(instances, 'or')}`;
    if (other.length > 0)
      msg += ' or ';
  }

  if (other.length > 0) {
    if (other.length > 1) {
      msg += `one of ${formatList(other, 'or')}`;
    } else {
      if (other[0].toLowerCase() !== other[0])
        msg += 'an ';
      msg += `${other[0]}`;
    }
  }

  msg += `. Received ${determineSpecificType(actual)}`;

  return msg;
}

class ERR_INVALID_ARG_TYPE extends TypeError {
  constructor(name, expected, actual) {
    super(buildInvalidArgTypeMessage(name, expected, actual));
    this.code = 'ERR_INVALID_ARG_TYPE';
  }

  // Mirrors NodeError.prototype.toString in lib/internal/errors.js, so
  // String(err) (and assert.throws regex matching) includes the code.
  toString() {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

// ---------------------------------------------------------------------------
// internal/validators (subset used by diagnostics_channel).
// ---------------------------------------------------------------------------

function validateFunction(value, name) {
  if (typeof value !== 'function') {
    throw new ERR_INVALID_ARG_TYPE(name, 'Function', value);
  }
}

// ---------------------------------------------------------------------------
// internalBinding('errors').triggerUncaughtException
// ---------------------------------------------------------------------------

function triggerUncaughtException(err) {
  // A throw inside a nextTick callback surfaces through
  // process 'uncaughtException' handlers (or crashes), matching Node.
  process.nextTick(() => {
    throw err;
  });
}

// ---------------------------------------------------------------------------
// internalBinding('diagnostics_channel') stub.
// In Node this exposes the native channel-subscriber table used by internal
// fast paths (`dc_binding.subscribers`) and `linkNativeChannel`. The polyfill
// has no native channels: `_index` stays undefined on every Channel, so the
// bookkeeping branches guarded by `this._index !== undefined` are skipped.
// ---------------------------------------------------------------------------

const dc_binding = {
  subscribers: [],
  linkNativeChannel() {},
};

// ---------------------------------------------------------------------------
// internal/util WeakReference emulation.
// A WeakRef plus an explicit pin set: incRef() pins the value strongly,
// decRef() releases it. Mirrors the GC semantics Node's C++ WeakReference
// provides (channels with subscribers/stores survive GC; idle channels are
// collectable and their map entries are cleaned by the FinalizationRegistry).
// ---------------------------------------------------------------------------

const pinnedChannelValues = new Set();

class WeakReference {
  #ref;
  #refCount = 0;
  constructor(value) {
    this.#ref = new WeakRef(value);
  }
  get() {
    return this.#ref.deref();
  }
  incRef() {
    if (this.#refCount++ === 0) {
      const value = this.#ref.deref();
      if (value !== undefined) pinnedChannelValues.add(value);
    }
  }
  decRef() {
    if (--this.#refCount === 0) {
      const value = this.#ref.deref();
      if (value !== undefined) pinnedChannelValues.delete(value);
    }
  }
}

// Can't delete when weakref count reaches 0 as it could increment again.
// Only GC can be used as a valid time to clean up the channels map.
class WeakRefMap extends Map {
  #finalizers = new FinalizationRegistry((key) => {
    // Check that the key doesn't have any value before deleting, as the WeakRef for the key
    // may have been replaced since finalization callbacks aren't synchronous with GC.
    if (!this.has(key)) this.delete(key);
  });

  set(key, value) {
    this.#finalizers.register(value, key);
    return super.set(key, new WeakReference(value));
  }

  get(key) {
    return super.get(key)?.get();
  }

  has(key) {
    return !!this.get(key);
  }

  incRef(key) {
    return super.get(key)?.incRef();
  }

  decRef(key) {
    return super.get(key)?.decRef();
  }
}

function markActive(channel) {
  ObjectSetPrototypeOf(channel, ActiveChannel.prototype);
  channel._subscribers = [];
  channel._stores = new Map();
}

function maybeMarkInactive(channel) {
  // When there are no more active subscribers or bound, restore to fast prototype.
  if (!channel._subscribers.length && !channel._stores.size) {
    ObjectSetPrototypeOf(channel, Channel.prototype);
    channel._subscribers = undefined;
    channel._stores = undefined;
  }
}

function defaultTransform(data) {
  return data;
}

function wrapStoreRun(store, data, next, transform = defaultTransform) {
  return () => {
    let context;
    try {
      context = transform(data);
    } catch (err) {
      process.nextTick(() => {
        triggerUncaughtException(err, false);
      });
      return next();
    }

    return store.run(context, next);
  };
}

// TODO(qard): should there be a C++ channel interface?
class ActiveChannel {
  subscribe(subscription) {
    validateFunction(subscription, 'subscription');
    this._subscribers = arraySlice(this._subscribers);
    arrayPush(this._subscribers, subscription);
    channels.incRef(this.name);
    if (this._index !== undefined) dc_binding.subscribers[this._index]++;
  }

  unsubscribe(subscription) {
    const index = ReflectApply(ArrayPrototypeIndexOf, this._subscribers, [subscription]);
    if (index === -1) return false;

    const before = arraySlice(this._subscribers, 0, index);
    const after = arraySlice(this._subscribers, index + 1);
    this._subscribers = before;
    for (const item of after) arrayPush(this._subscribers, item);

    channels.decRef(this.name);
    if (this._index !== undefined) dc_binding.subscribers[this._index]--;
    maybeMarkInactive(this);

    return true;
  }

  bindStore(store, transform) {
    const replacing = this._stores.has(store);
    if (!replacing) {
      channels.incRef(this.name);
      if (this._index !== undefined) dc_binding.subscribers[this._index]++;
    }
    this._stores.set(store, transform);
  }

  unbindStore(store) {
    if (!this._stores.has(store)) {
      return false;
    }

    this._stores.delete(store);

    channels.decRef(this.name);
    if (this._index !== undefined) dc_binding.subscribers[this._index]--;
    maybeMarkInactive(this);

    return true;
  }

  get hasSubscribers() {
    return true;
  }

  publish(data) {
    const subscribers = this._subscribers;
    for (let i = 0; i < (subscribers?.length || 0); i++) {
      try {
        const onMessage = subscribers[i];
        onMessage(data, this.name);
      } catch (err) {
        process.nextTick(() => {
          triggerUncaughtException(err, false);
        });
      }
    }
  }

  runStores(data, fn, thisArg, ...args) {
    let run = () => {
      this.publish(data);
      return ReflectApply(fn, thisArg, args);
    };

    for (const entry of this._stores.entries()) {
      const store = entry[0];
      const transform = entry[1];
      run = wrapStoreRun(store, data, run, transform);
    }

    return run();
  }
}

class Channel {
  constructor(name) {
    this._subscribers = undefined;
    this._stores = undefined;
    this.name = name;
    this._index = undefined;

    channels.set(name, this);
  }

  static [SymbolHasInstance](instance) {
    const prototype = ObjectGetPrototypeOf(instance);
    return prototype === Channel.prototype ||
           prototype === ActiveChannel.prototype;
  }

  subscribe(subscription) {
    markActive(this);
    this.subscribe(subscription);
  }

  unsubscribe() {
    return false;
  }

  bindStore(store, transform) {
    markActive(this);
    this.bindStore(store, transform);
  }

  unbindStore() {
    return false;
  }

  get hasSubscribers() {
    return false;
  }

  publish() {}

  runStores(data, fn, thisArg, ...args) {
    return ReflectApply(fn, thisArg, args);
  }
}

const channels = new WeakRefMap();

export function channel(name) {
  const chan = channels.get(name);
  if (chan) return chan;

  if (typeof name !== 'string' && typeof name !== 'symbol') {
    throw new ERR_INVALID_ARG_TYPE('channel', ['string', 'symbol'], name);
  }

  return new Channel(name);
}

export function subscribe(name, subscription) {
  return channel(name).subscribe(subscription);
}

export function unsubscribe(name, subscription) {
  return channel(name).unsubscribe(subscription);
}

export function hasSubscribers(name) {
  const chan = channels.get(name);
  if (!chan) return false;

  return chan.hasSubscribers;
}

const traceEvents = [
  'start',
  'end',
  'asyncStart',
  'asyncEnd',
  'error',
];

function assertChannel(value, name) {
  if (!(value instanceof Channel)) {
    throw new ERR_INVALID_ARG_TYPE(name, ['Channel'], value);
  }
}

function tracingChannelFrom(nameOrChannels, name) {
  if (typeof nameOrChannels === 'string') {
    return channel(`tracing:${nameOrChannels}:${name}`);
  }

  if (typeof nameOrChannels === 'object' && nameOrChannels !== null) {
    const chan = nameOrChannels[name];
    assertChannel(chan, `nameOrChannels.${name}`);
    return chan;
  }

  throw new ERR_INVALID_ARG_TYPE('nameOrChannels',
                                 ['string', 'object', 'TracingChannel'],
                                 nameOrChannels);
}

// Not exported: Node v24.20.0 exposes only the lowercase `tracingChannel`
// factory, never the class itself. Kept module-private for the factory below.
class TracingChannel {
  constructor(nameOrChannels) {
    for (let i = 0; i < traceEvents.length; ++i) {
      const eventName = traceEvents[i];
      ObjectDefineProperty(this, eventName, {
        __proto__: null,
        value: tracingChannelFrom(nameOrChannels, eventName),
      });
    }
  }

  get hasSubscribers() {
    return this.start?.hasSubscribers ||
      this.end?.hasSubscribers ||
      this.asyncStart?.hasSubscribers ||
      this.asyncEnd?.hasSubscribers ||
      this.error?.hasSubscribers;
  }

  subscribe(handlers) {
    for (let i = 0; i < traceEvents.length; ++i) {
      const name = traceEvents[i];
      if (!handlers[name]) continue;

      this[name]?.subscribe(handlers[name]);
    }
  }

  unsubscribe(handlers) {
    let done = true;

    for (let i = 0; i < traceEvents.length; ++i) {
      const name = traceEvents[i];
      if (!handlers[name]) continue;

      if (!this[name]?.unsubscribe(handlers[name])) {
        done = false;
      }
    }

    return done;
  }

  traceSync(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) {
      return ReflectApply(fn, thisArg, args);
    }

    const { start, end, error } = this;

    return start.runStores(context, () => {
      try {
        const result = ReflectApply(fn, thisArg, args);
        context.result = result;
        return result;
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  tracePromise(fn, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) {
      return ReflectApply(fn, thisArg, args);
    }

    const { start, end, asyncStart, asyncEnd, error } = this;

    function reject(err) {
      context.error = err;
      error.publish(context);
      asyncStart.publish(context);
      // TODO: Is there a way to have asyncEnd _after_ the continuation?
      asyncEnd.publish(context);
      return Promise.reject(err);
    }

    function resolve(result) {
      context.result = result;
      asyncStart.publish(context);
      // TODO: Is there a way to have asyncEnd _after_ the continuation?
      asyncEnd.publish(context);
      return result;
    }

    return start.runStores(context, () => {
      try {
        let promise = ReflectApply(fn, thisArg, args);
        // Convert thenables to native promises
        if (!(promise instanceof Promise)) {
          promise = Promise.resolve(promise);
        }
        return ReflectApply(PromisePrototypeThen, promise, [resolve, reject]);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }

  traceCallback(fn, position = -1, context = {}, thisArg, ...args) {
    if (!this.hasSubscribers) {
      return ReflectApply(fn, thisArg, args);
    }

    const { start, end, asyncStart, asyncEnd, error } = this;

    function wrappedCallback(err, res) {
      if (err) {
        context.error = err;
        error.publish(context);
      } else {
        context.result = res;
      }

      // Using runStores here enables manual context failure recovery
      asyncStart.runStores(context, () => {
        try {
          return ReflectApply(callback, this, arguments);
        } finally {
          asyncEnd.publish(context);
        }
      });
    }

    const callback = ReflectApply(ArrayPrototypeAt, args, [position]);
    validateFunction(callback, 'callback');
    arraySplice(args, position, 1, wrappedCallback);

    return start.runStores(context, () => {
      try {
        return ReflectApply(fn, thisArg, args);
      } catch (err) {
        context.error = err;
        error.publish(context);
        throw err;
      } finally {
        end.publish(context);
      }
    });
  }
}

export function tracingChannel(nameOrChannels) {
  return new TracingChannel(nameOrChannels);
}

// Keep in sync with setupDiagnosticsChannel() in pre_execution.js.
dc_binding.linkNativeChannel((name, index) => {
  const linkedChannel = channel(name);
  linkedChannel._index = index;
  dc_binding.subscribers[index] =
    (linkedChannel._subscribers?.length || 0) +
    (linkedChannel._stores?.size || 0);
  return linkedChannel;
});

export { Channel };

export default {
  channel,
  hasSubscribers,
  subscribe,
  tracingChannel,
  unsubscribe,
  Channel,
};
