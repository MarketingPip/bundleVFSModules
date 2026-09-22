// src/perf_hooks.js — Port of Node.js `node:perf_hooks` (Node v24.20.0).
//
// This module provides a self-contained, dependency-free implementation of the
// `node:perf_hooks` API that works in a browser-like sandbox as well as under
// real Node.js. It implements its own Node-like timeline (marks, measures,
// resource timings, observers, histograms) rather than exporting the host's
// native `globalThis.performance`, because the Node-specific classes, entry
// buffers, `timerify()`, resource timing, `createHistogram()` and observer
// semantics need to interoperate deterministically. The host's
// `performance.now()` and `performance.timeOrigin` are used as the clock when
// available.
//
// Browser fidelity gaps (honest approximations):
// - `monitorEventLoopDelay()` samples the event loop with `setInterval` and
//   records timer lateness in nanoseconds instead of libuv's internal
//   event-loop-delay tracking. Counts/min/max/percentiles are real, but the
//   absolute delay numbers reflect timer scheduling, not libuv loop latency.
// - `eventLoopUtilization()` has no libuv idle/active counters in the browser,
//   so it returns the same shape Node uses when idle metrics are unavailable
//   (`{ idle: 0, active: 0, utilization: 0 }`).
// - `performance.nodeTiming` reports `loopStart`/`loopExit` as `-1` (no libuv
//   loop here) and zeroes for other loop-dependent fields.
// - Histogram statistics replicate the HdrHistogram bucket model (quantized
//   buckets; mean/stddev accumulate bucket midpoints; min is the low bound of
//   the min bucket; max/percentiles are high bounds), so statistics for large
//   values follow native bucketing semantics.

// ---------------------------------------------------------------------------
// 1. Runtime bridge (rewritten per-sandbox by the runtime's _build_file).
// ---------------------------------------------------------------------------
const RT =
  typeof globalThis._RUNTIME_ !== 'undefined' ? globalThis._RUNTIME_ : undefined;
void RT;

// ---------------------------------------------------------------------------
// 1b. Native bridge (Node.js only).
// ---------------------------------------------------------------------------
// Follows the repo's "Native bridge" convention (see src/util.js): where the
// environment really is Node.js, delegate the features that pure JS cannot
// implement exactly to the genuine builtin:
// - `createHistogram()` / `monitorEventLoopDelay()`: histograms are V8 host
//   objects in Node; `postMessage()`/`structuredClone()` of a histogram
//   yields a live shared-state histogram on the receiving side. Pure JS
//   cannot hook the structured serializer, so the native histograms are used.
// - `eventLoopUtilization()`: needs libuv's idle/active loop counters.
// - `performance.nodeTiming`: `loopStart`/`idleTime` come from libuv.
// Browsers (and any host with `globalThis._RUNTIME_`) keep the dependency-free
// pure-JS fallbacks below, so the shim works with zero native delegation.
// Set `globalThis.__PERF_HOOKS_NO_NATIVE__ = true` before importing to force
// the pure-JS implementations (used by the browser-fallback test lane).
let nativePerfHooks = null;
try {
  if (
    typeof globalThis._RUNTIME_ === 'undefined' &&
    globalThis.__PERF_HOOKS_NO_NATIVE__ !== true &&
    typeof process !== 'undefined' &&
    typeof process.getBuiltinModule === 'function'
  ) {
    const candidate = process.getBuiltinModule('perf_hooks');
    if (candidate && typeof candidate.createHistogram === 'function') {
      nativePerfHooks = candidate;
    }
  }
} catch {
  nativePerfHooks = null;
}

// Tracks native histograms created through this shim so `timerify({ histogram })`
// validation accepts them alongside the pure-JS histograms.
const nativeHistogramSet = new WeakSet();

// ---------------------------------------------------------------------------
// 2. Internal symbols and helpers.
// ---------------------------------------------------------------------------
const kSkipThrow = Symbol('kSkipThrow');
const kHandle = Symbol('kHandle');
const kMap = Symbol('kMap');
const kEnabled = Symbol('kEnabled');
const kRecordable = Symbol('kRecordable');
const kName = Symbol('kName');
const kEntryType = Symbol('kEntryType');
const kStartTime = Symbol('kStartTime');
const kDuration = Symbol('kDuration');
const kDetail = Symbol('kDetail');
const kRequestedUrl = Symbol('kRequestedUrl');
const kTimingInfo = Symbol('kTimingInfo');
const kInitiatorType = Symbol('kInitiatorType');
const kCacheMode = Symbol('kCacheMode');
const kDeliveryType = Symbol('kDeliveryType');
const kResponseStatus = Symbol('kResponseStatus');
const kPending = Symbol('kPending');
const kEntryTypes = Symbol('kEntryTypes');
const kType = Symbol('kType');
const kPerformanceBrand = Symbol('kPerformanceBrand');
const kListeners = Symbol('kListeners');
const kInspect = Symbol.for('nodejs.util.inspect.custom');

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function errIllegalConstructor() {
  const err = new TypeError('Illegal constructor');
  err.code = 'ERR_ILLEGAL_CONSTRUCTOR';
  return err;
}

function errMissingArgs(...args) {
  const msg =
    args.length > 1
      ? `The ${args.map((a) => `"${a}"`).join(' and ')} arguments must be specified`
      : `The "${args[0]}" argument must be specified`;
  const err = new TypeError(msg);
  err.code = 'ERR_MISSING_ARGS';
  return err;
}

function errInvalidThis(type) {
  const err = new TypeError(`The "this" argument must be an instance of ${type}`);
  err.code = 'ERR_INVALID_THIS';
  return err;
}

function errInvalidArgType(name, expected, actual) {
  const actualDesc =
    actual === null
      ? 'null'
      : typeof actual === 'object' && Array.isArray(actual)
        ? 'an instance of Array'
        : `of type ${typeof actual}`;
  const err = new TypeError(`The "${name}" argument must be ${expected}. Received ${actualDesc}`);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function errInvalidArgValue(name, value, reason) {
  const kind = name.includes('.') ? 'property' : 'argument';
  const err = new TypeError(
    `The ${kind} '${name}' ${reason ?? 'is invalid'}. Received ${miniInspect(value)}`
  );
  err.code = 'ERR_INVALID_ARG_VALUE';
  return err;
}

function errInvalidTimestamp(value) {
  const err = new TypeError(`${miniInspect(value)} is not a valid timestamp`);
  err.code = 'ERR_PERFORMANCE_INVALID_TIMESTAMP';
  return err;
}

function errPerformanceMeasureInvalidOptions() {
  const err = new TypeError(
    'Must not have options.start, options.end, and options.duration specified'
  );
  err.code = 'ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS';
  return err;
}

function errPerformanceMarkNotFound(name) {
  // Node throws a DOMException named 'SyntaxError' with code 12 here.
  return new DOMException(`The "${name}" performance mark has not been set`, 'SyntaxError');
}

function errOutOfRange(name, range, value) {
  const actual = typeof value === 'bigint' ? `${value}n` : miniInspect(value);
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${actual}`
  );
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

function errOutOfRangePlain() {
  const err = new RangeError('value is out of range');
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

function validateThisInternalField(obj, field, className) {
  if (obj === null || obj === undefined || obj[field] === undefined) {
    throw errInvalidThis(className);
  }
}

function validateFunction(value, name) {
  if (typeof value !== 'function') throw errInvalidArgType(name, 'of type function', value);
}

function validateObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw errInvalidArgType(name, 'of type object', value);
  }
}

function validateString(value, name) {
  if (typeof value !== 'string') throw errInvalidArgType(name, 'of type string', value);
}

function validateNumber(value, name) {
  if (typeof value !== 'number') throw errInvalidArgType(name, 'of type number', value);
}

function validateInteger(value, name, min = Number.MIN_SAFE_INTEGER, max = MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw errInvalidArgType(name, 'of type number', value);
  if (!Number.isInteger(value)) throw errOutOfRange(name, 'an integer', value);
  if (value < min || value > max) {
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== 'boolean') throw errInvalidArgType(name, 'of type boolean', value);
}

function validateOneOf(value, name, choices) {
  if (!choices.includes(value)) {
    const list = choices.map((c) => `'${c}'`).join(', ');
    throw errInvalidArgValue(name, value, `must be one of: ${list}`);
  }
}

// Minimal value formatter used in error messages (no dependency on util).
function miniInspect(value) {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'bigint') return `${value}n`;
  if (Array.isArray(value)) return `[ ${value.map(miniInspect).join(', ')} ]`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => `${k}: ${miniInspect(v)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// 3. Clock: host performance.now()/timeOrigin when available.
// ---------------------------------------------------------------------------
const _nativePerformance =
  typeof globalThis.performance === 'object' && globalThis.performance !== null
    ? globalThis.performance
    : undefined;

const timeOrigin =
  _nativePerformance && typeof _nativePerformance.timeOrigin === 'number'
    ? _nativePerformance.timeOrigin
    : Date.now();

function now() {
  if (_nativePerformance && typeof _nativePerformance.now === 'function') {
    return _nativePerformance.now();
  }
  return Date.now() - timeOrigin;
}

function structuredCloneValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value);
  }
  // Fallback for exotic hosts without structuredClone: JSON round-trip.
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 4. HdrHistogram-style bucket store (C++ node_histogram.cc semantics).
// ---------------------------------------------------------------------------
// Buckets follow the HdrHistogram model used by Node's native histograms.
// Parameterization (derived from native behavior):
// - unitMagnitude = floor(log2(lowest)): sub-buckets in bucket 0 have size
//   2^unitMagnitude, so `lowest` itself is always representable.
// - subBucketHalfCountMagnitude = ceil(figures * log2(10)):
//   subBucketCount = 2^(sbhcm + 1) logarithmic sub-buckets per bucket.
// - bucket 0 covers [0, subBucketCount * 2^unitMagnitude) linearly;
//   bucket b > 0 covers [2^(b+unitMagnitude+sbhcm), 2^(b+unitMagnitude+sbhcm+1))
//   with sub-bucket size 2^(b+unitMagnitude).
// Reported statistics use the bucket model: `min` is the low bound of the min
// bucket, `max`/percentiles are the high (inclusive) bound of the
// corresponding bucket, and mean/stddev accumulate the midpoint
// (lowest + size/2, integer division) of each recorded bucket.
class BucketStore {
  constructor(lowest, highest, figures) {
    this.lowest = lowest;
    this.highest = highest;
    this.figures = figures;
    this.unitMagnitude = Math.floor(Math.log(lowest) / Math.LN2);
    this.subBucketHalfCountMagnitude = Math.ceil(figures * Math.log2(10));
    this.subBucketCount = Math.pow(2, this.subBucketHalfCountMagnitude + 1);
    this.subBucketMask = (this.subBucketCount - 1) * Math.pow(2, this.unitMagnitude);
    this.bucketCount = this._getBucketCount();
    this.counts = new Array(this.bucketCount * this.subBucketCount).fill(0);
    this.reset();
  }

  _getBucketCount() {
    let smallestUntrackableValue = this.subBucketCount * Math.pow(2, this.unitMagnitude);
    let bucketsNeeded = 1;
    while (smallestUntrackableValue <= this.highest) {
      if (smallestUntrackableValue > MAX_SAFE_INTEGER / 2) {
        bucketsNeeded++;
        break;
      }
      smallestUntrackableValue *= 2;
      bucketsNeeded++;
    }
    return bucketsNeeded;
  }

  reset() {
    this.counts.fill(0);
    this.totalCount = 0;
    this.exceeds = 0;
    this.sum = 0;
    this.sumSq = 0;
    this.min = 0;
    this.max = 0;
    this.minIndex = -1;
    this.maxIndex = -1;
  }

  _bucketIndex(value) {
    // HdrHistogram get_bucket_index: exponent of the smallest power of two
    // containing max(value, subBucketMask), minus unitMagnitude and the
    // sub-bucket shift. Implemented with a 64-bit clz so values up to
    // 2^53 - 1 work.
    const combined = Math.max(value, this.subBucketMask);
    const hi = Math.floor(combined / 4294967296);
    const clz = hi !== 0 ? Math.clz32(hi) : 32 + Math.clz32(combined >>> 0);
    const pow2ceiling = 64 - clz;
    return pow2ceiling - this.unitMagnitude - this.subBucketHalfCountMagnitude - 1;
  }

  _indexFor(value) {
    const b = this._bucketIndex(value);
    const size = Math.pow(2, b + this.unitMagnitude);
    const sub = Math.floor(value / size);
    const index = b * this.subBucketCount + sub;
    return { index, lowest: sub * size, size };
  }

  _bucketInfo(index) {
    const b = Math.floor(index / this.subBucketCount);
    const sub = index % this.subBucketCount;
    const size = Math.pow(2, b + this.unitMagnitude);
    return { lowest: sub * size, size };
  }

  _addAt(value, times) {
    if (value > this.highest) {
      this.exceeds += times;
      return;
    }
    const { index, lowest, size } = this._indexFor(value);
    const contribution = lowest + Math.floor(size / 2);
    this.counts[index] += times;
    this.totalCount += times;
    this.sum += contribution * times;
    this.sumSq += contribution * contribution * times;
    if (this.minIndex === -1 || index < this.minIndex) {
      this.minIndex = index;
      this.min = lowest;
    }
    if (this.maxIndex === -1 || index > this.maxIndex) {
      this.maxIndex = index;
      this.max = lowest + size - 1;
    }
  }

  recordValue(value) {
    this._addAt(value, 1);
  }

  recordBigint(value) {
    if (value > BigInt(this.highest)) {
      this.exceeds++;
      return;
    }
    this.recordValue(Number(value));
  }

  add(other) {
    if (
      other.lowest === this.lowest &&
      other.highest === this.highest &&
      other.figures === this.figures
    ) {
      for (let i = 0; i < this.counts.length; i++) {
        this.counts[i] += other.counts[i];
      }
      this.totalCount += other.totalCount;
      this.exceeds += other.exceeds;
      this.sum += other.sum;
      this.sumSq += other.sumSq;
      if (other.minIndex !== -1 && (this.minIndex === -1 || other.minIndex < this.minIndex)) {
        this.minIndex = other.minIndex;
        this.min = other.min;
      }
      if (other.maxIndex !== -1 && (this.maxIndex === -1 || other.maxIndex > this.maxIndex)) {
        this.maxIndex = other.maxIndex;
        this.max = other.max;
      }
    } else {
      // Different configuration: re-bucket the other store's values by their
      // bucket midpoints.
      for (let i = 0; i < other.counts.length; i++) {
        const c = other.counts[i];
        if (c === 0) continue;
        const { lowest, size } = other._bucketInfo(i);
        this._addAt(lowest + Math.floor(size / 2), c);
      }
    }
  }

  _lowestAtRank(rank) {
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i++) {
      cumulative += this.counts[i];
      if (cumulative >= rank) return this._bucketInfo(i).lowest;
    }
    return this.maxIndex === -1 ? 0 : this._bucketInfo(this.maxIndex).lowest;
  }

  percentile(p, asBigInt = false) {
    validateNumber(p, 'percentile');
    if (Number.isNaN(p) || p <= 0 || p > 100) {
      throw errOutOfRange('percentile', '> 0 && <= 100', p);
    }
    return this._percentileValue(p, asBigInt);
  }

  _percentileValue(p, asBigInt = false) {
    if (this.totalCount === 0) return asBigInt ? 0n : 0;
    const rank = Math.max(1, Math.round((p / 100) * this.totalCount));
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i++) {
      cumulative += this.counts[i];
      if (cumulative >= rank) {
        const { lowest, size } = this._bucketInfo(i);
        const highestEquivalent = lowest + size - 1;
        return asBigInt ? BigInt(highestEquivalent) : highestEquivalent;
      }
    }
    const { lowest, size } = this._bucketInfo(this.maxIndex);
    const highestEquivalent = lowest + size - 1;
    return asBigInt ? BigInt(highestEquivalent) : highestEquivalent;
  }

  percentilesEntries(asBigInt = false) {
    const entries = [];
    if (this.totalCount === 0) {
      entries.push([100, asBigInt ? 0n : 0]);
      return entries;
    }
    const toVal = (v) => (asBigInt ? BigInt(v) : v);
    entries.push([0, toVal(this.min)]);
    if (this.totalCount > 1) {
      // Node includes the "half-distance" ticks 50, 75, 87.5, ... up to
      // 100 - 50/2^floor(log2(count)), then 100. Unlike percentile(), which
      // returns the bucket's highest equivalent value, the map uses the
      // bucket's lowest value.
      const kMax = Math.floor(Math.log2(this.totalCount));
      for (let k = 0; k <= kMax; k++) {
        const tick = 100 - 50 / Math.pow(2, k);
        entries.push([tick, toVal(this._lowestAtPercentile(tick))]);
      }
    }
    entries.push([100, toVal(this._lowestAtPercentile(100))]);
    return entries;
  }

  _lowestAtPercentile(p) {
    if (this.totalCount === 0) return 0;
    // The percentiles map uses ceil (unlike percentile() which uses round).
    const rank = Math.max(1, Math.ceil((p / 100) * this.totalCount));
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i++) {
      cumulative += this.counts[i];
      if (cumulative >= rank) {
        return this._bucketInfo(i).lowest;
      }
    }
    return this.maxIndex === -1 ? 0 : this._bucketInfo(this.maxIndex).lowest;
  }

  get mean() {
    return this.totalCount === 0 ? NaN : this.sum / this.totalCount;
  }

  get stddev() {
    if (this.totalCount === 0) return NaN;
    const m = this.mean;
    return Math.sqrt(this.sumSq / this.totalCount - m * m);
  }

  get minBigInt() {
    return this.totalCount === 0 ? 9223372036854775807n : BigInt(this.min);
  }

  get maxBigInt() {
    return this.totalCount === 0 ? 0n : BigInt(this.max);
  }
}

// ---------------------------------------------------------------------------
// 5. Histogram classes.
// ---------------------------------------------------------------------------
class Histogram {
  constructor(skipThrowSymbol = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
  }

  _store() {
    if (this[kHandle] === undefined) throw errInvalidThis('Histogram');
    return this[kHandle];
  }

  get count() {
    return this._store().totalCount;
  }

  get countBigInt() {
    return BigInt(this._store().totalCount);
  }

  get min() {
    return this._store().totalCount === 0 ? 2 ** 63 : this._store().min;
  }

  get minBigInt() {
    return this._store().minBigInt;
  }

  get max() {
    return this._store().totalCount === 0 ? 0 : this._store().max;
  }

  get maxBigInt() {
    return this._store().maxBigInt;
  }

  get exceeds() {
    return this._store().exceeds;
  }

  get exceedsBigInt() {
    return BigInt(this._store().exceeds);
  }

  get mean() {
    return this._store().mean;
  }

  get stddev() {
    return this._store().stddev;
  }

  percentile(percentile) {
    return this._store().percentile(percentile, false);
  }

  percentileBigInt(percentile) {
    return this._store().percentile(percentile, true);
  }

  get percentiles() {
    const map = this[kMap];
    if (map === undefined) throw errInvalidThis('Histogram');
    map.clear();
    for (const [k, v] of this._store().percentilesEntries(false)) map.set(k, v);
    return map;
  }

  get percentilesBigInt() {
    const map = this[kMap];
    if (map === undefined) throw errInvalidThis('Histogram');
    map.clear();
    for (const [k, v] of this._store().percentilesEntries(true)) map.set(k, v);
    return map;
  }

  reset() {
    this._store().reset();
  }

  toJSON() {
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      percentiles: Object.fromEntries(this.percentiles),
    };
  }

  [kInspect](depth, options, inspectFn) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options?.depth == null ? null : options.depth - 1 };
    return `Histogram ${formatValue(
      {
        min: this.min,
        max: this.max,
        mean: this.mean,
        exceeds: this.exceeds,
        stddev: this.stddev,
        count: this.count,
        percentiles: this.percentiles,
      },
      opts,
      inspectFn
    )}`;
  }
}

class RecordableHistogram extends Histogram {
  constructor(skipThrowSymbol = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    super(skipThrowSymbol);
  }

  _recordableStore() {
    if (this[kRecordable] === undefined) throw errInvalidThis('RecordableHistogram');
    return this._store();
  }

  record(val) {
    const store = this._recordableStore();
    if (typeof val === 'bigint') {
      if (val < 1n) throw errOutOfRangePlain();
      store.recordBigint(val);
      return;
    }
    validateInteger(val, 'val', 1);
    store.recordValue(val);
  }

  recordDelta() {
    const store = this._recordableStore();
    const t = Math.round(now() * 1e6);
    if (this._lastDelta !== undefined) {
      store.recordValue(Math.max(0, t - this._lastDelta));
    }
    this._lastDelta = t;
  }

  add(other) {
    const store = this._recordableStore();
    if (other === null || other === undefined || other[kRecordable] === undefined) {
      throw errInvalidArgType('other', 'an instance of RecordableHistogram', other);
    }
    store.add(other[kHandle]);
  }
}

class ELDHistogram extends Histogram {
  constructor(skipThrowSymbol = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    super(skipThrowSymbol);
  }

  _checkEld() {
    if (this[kEnabled] === undefined) throw errInvalidThis('ELDHistogram');
  }

  enable() {
    this._checkEld();
    if (this[kEnabled]) return false;
    this[kEnabled] = true;
    this._startSampler();
    return true;
  }

  disable() {
    this._checkEld();
    if (!this[kEnabled]) return false;
    this[kEnabled] = false;
    if (this._eldTimer !== undefined) {
      globalThis.clearInterval(this._eldTimer);
      this._eldTimer = undefined;
    }
    return true;
  }

  _startSampler() {
    // Browser approximation of libuv event-loop-delay sampling: measure how
    // late each interval fires relative to its expected deadline.
    const resolution = this._resolution;
    let expected = now() + resolution;
    const timer = globalThis.setInterval(() => {
      if (!this[kEnabled]) return;
      const t = now();
      const delayNs = Math.max(0, Math.round((t - expected) * 1e6));
      expected += resolution;
      this[kHandle].recordValue(delayNs);
    }, resolution);
    if (timer !== undefined && timer !== null && typeof timer.unref === 'function') {
      timer.unref();
    }
    this._eldTimer = timer;
  }
}

// `using` support where the host provides Symbol.dispose.
if (typeof Symbol.dispose !== 'undefined') {
  Object.defineProperty(ELDHistogram.prototype, Symbol.dispose, {
    value: function () {
      this.disable();
    },
    writable: true,
    configurable: true,
  });
}

function createHistogram(options = undefined) {
  if (options === undefined) options = {};
  validateObject(options, 'options');
  const { lowest = 1, highest = MAX_SAFE_INTEGER, figures = 3 } = options;
  if (typeof lowest !== 'bigint') {
    validateInteger(lowest, 'options.lowest', 1, MAX_SAFE_INTEGER);
  }
  if (typeof highest !== 'bigint') {
    validateInteger(highest, 'options.highest', 2 * Number(lowest), MAX_SAFE_INTEGER);
  } else if (highest < 2n * BigInt(Number(lowest))) {
    const err = new RangeError('The value of "options.highest" is invalid.');
    err.code = 'ERR_INVALID_ARG_VALUE';
    throw err;
  }
  validateInteger(figures, 'options.figures', 1, 5);
  if (nativePerfHooks !== null) {
    // Native histograms are V8 host objects: postMessage()/structuredClone()
    // produce live shared-state histograms, which pure JS cannot replicate.
    const histogram = nativePerfHooks.createHistogram(options);
    nativeHistogramSet.add(histogram);
    return histogram;
  }
  const histogram = new RecordableHistogram(kSkipThrow);
  histogram[kHandle] = new BucketStore(Number(lowest), Number(highest), figures);
  histogram[kMap] = new Map();
  histogram[kRecordable] = true;
  histogram.constructor = RecordableHistogram;
  return histogram;
}

// ---------------------------------------------------------------------------
// 6. Performance entry classes.
// ---------------------------------------------------------------------------
function validateThisEntry(obj, className) {
  validateThisInternalField(obj, kName, className);
}

class PerformanceEntry {
  constructor(skipThrowSymbol = undefined, name = undefined, type = undefined, start = undefined, duration = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    this[kName] = name;
    this[kEntryType] = type;
    this[kStartTime] = start;
    this[kDuration] = duration;
  }

  get name() {
    validateThisEntry(this, 'PerformanceEntry');
    return this[kName];
  }

  get entryType() {
    validateThisEntry(this, 'PerformanceEntry');
    return this[kEntryType];
  }

  get startTime() {
    validateThisEntry(this, 'PerformanceEntry');
    return this[kStartTime];
  }

  get duration() {
    validateThisEntry(this, 'PerformanceEntry');
    return this[kDuration];
  }

  toJSON() {
    validateThisEntry(this, 'PerformanceEntry');
    return {
      name: this[kName],
      entryType: this[kEntryType],
      startTime: this[kStartTime],
      duration: this[kDuration],
    };
  }

  [kInspect](depth, options, inspectFn) {
    if (depth < 0) return this;
    const opts = { ...options, depth: options?.depth == null ? null : options.depth - 1 };
    return `${this.constructor.name} ${formatValue(this.toJSON(), opts, inspectFn)}`;
  }
}

// timerify() entries: node reports these with a `detail` property.
class PerformanceNodeEntry extends PerformanceEntry {
  get detail() {
    validateThisInternalField(this, kDetail, 'NodePerformanceEntry');
    return this[kDetail];
  }

  toJSON() {
    validateThisEntry(this, 'PerformanceEntry');
    return {
      name: this[kName],
      entryType: this[kEntryType],
      startTime: this[kStartTime],
      duration: this[kDuration],
      detail: this[kDetail],
    };
  }
}

function createPerformanceNodeEntry(name, type, start, duration, detail) {
  const entry = new PerformanceNodeEntry(kSkipThrow, name, type, start, duration);
  entry[kDetail] = detail;
  return entry;
}

// Attributes of `performance.nodeTiming` that cannot be used as mark names.
const nodeTimingReadOnlyAttributes = new Set([
  'nodeStart',
  'v8Start',
  'environment',
  'loopStart',
  'loopExit',
  'bootstrapComplete',
]);

class PerformanceMark extends PerformanceEntry {
  constructor(name, options = undefined) {
    if (arguments.length === 0) throw errMissingArgs('name');
    name = `${name}`;
    if (nodeTimingReadOnlyAttributes.has(name)) throw errInvalidArgValue('name', name);
    if (options != null) validateObject(options, 'options');
    const startTime = options?.startTime ?? now();
    validateNumber(startTime, 'startTime');
    if (startTime < 0) throw errInvalidTimestamp(startTime);
    // Keep the mark -> startTime mapping even when constructed directly.
    markTimings.set(name, startTime);
    let detail = options?.detail;
    detail = detail != null ? structuredCloneValue(detail) : null;
    super(kSkipThrow, name, 'mark', startTime, 0);
    this[kDetail] = detail;
  }

  get detail() {
    validateThisInternalField(this, kDetail, 'PerformanceMark');
    return this[kDetail];
  }

  toJSON() {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this[kDetail],
    };
  }
}

class PerformanceMeasure extends PerformanceEntry {
  constructor(skipThrowSymbol = undefined, name = undefined, type = undefined, start = undefined, duration = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    super(skipThrowSymbol, name, type, start, duration);
  }

  get detail() {
    validateThisInternalField(this, kDetail, 'PerformanceMeasure');
    return this[kDetail];
  }

  toJSON() {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this[kDetail],
    };
  }
}

function createPerformanceMeasure(name, start, duration, detail) {
  const measure = new PerformanceMeasure(kSkipThrow, name, 'measure', start, duration);
  measure[kDetail] = detail;
  return measure;
}

class PerformanceResourceTiming extends PerformanceEntry {
  constructor(skipThrowSymbol = undefined, name = undefined, type = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    super(skipThrowSymbol, name, type);
  }

  get name() {
    validateThisInternalField(this, kRequestedUrl, 'PerformanceResourceTiming');
    return this[kRequestedUrl];
  }

  get entryType() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return 'resource';
  }

  get startTime() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].startTime;
  }

  get duration() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    const timingInfo = this[kTimingInfo];
    return timingInfo.endTime - timingInfo.startTime;
  }

  get initiatorType() {
    validateThisInternalField(this, kInitiatorType, 'PerformanceResourceTiming');
    return this[kInitiatorType];
  }

  get nextHopProtocol() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalConnectionTimingInfo?.ALPNNegotiatedProtocol;
  }

  get workerStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalServiceWorkerStartTime;
  }

  get redirectStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].redirectStartTime;
  }

  get redirectEnd() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].redirectEndTime;
  }

  get fetchStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].postRedirectStartTime;
  }

  get domainLookupStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalConnectionTimingInfo?.domainLookupStartTime;
  }

  get domainLookupEnd() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalConnectionTimingInfo?.domainLookupEndTime;
  }

  get connectStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalConnectionTimingInfo?.connectionStartTime;
  }

  get connectEnd() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalConnectionTimingInfo?.connectionEndTime;
  }

  get secureConnectionStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalConnectionTimingInfo?.secureConnectionStartTime;
  }

  get requestStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalNetworkRequestStartTime;
  }

  get responseStart() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].finalNetworkResponseStartTime;
  }

  get responseEnd() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].endTime;
  }

  get transferSize() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    if (this[kCacheMode] === 'local') return 0;
    if (this[kCacheMode] === 'validated') return 300;
    return this[kTimingInfo].encodedBodySize + 300;
  }

  get encodedBodySize() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].encodedBodySize;
  }

  get decodedBodySize() {
    validateThisInternalField(this, kTimingInfo, 'PerformanceResourceTiming');
    return this[kTimingInfo].decodedBodySize;
  }

  get deliveryType() {
    validateThisInternalField(this, kDeliveryType, 'PerformanceResourceTiming');
    return this[kDeliveryType];
  }

  get responseStatus() {
    validateThisInternalField(this, kResponseStatus, 'PerformanceResourceTiming');
    return this[kResponseStatus];
  }

  toJSON() {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      initiatorType: this.initiatorType,
      nextHopProtocol: this.nextHopProtocol,
      workerStart: this.workerStart,
      redirectStart: this.redirectStart,
      redirectEnd: this.redirectEnd,
      fetchStart: this.fetchStart,
      domainLookupStart: this.domainLookupStart,
      domainLookupEnd: this.domainLookupEnd,
      connectStart: this.connectStart,
      connectEnd: this.connectEnd,
      secureConnectionStart: this.secureConnectionStart,
      requestStart: this.requestStart,
      responseStart: this.responseStart,
      responseEnd: this.responseEnd,
      transferSize: this.transferSize,
      encodedBodySize: this.encodedBodySize,
      decodedBodySize: this.decodedBodySize,
      deliveryType: this.deliveryType,
      responseStatus: this.responseStatus,
    };
  }

  [kInspect](depth, _options, inspectFn) {
    if (depth < 0) return this;
    const fmt = (v) => formatInspectValue(v, inspectFn);
    return `PerformanceResourceTiming {\n` +
      `  name: ${fmt(this.name)},\n` +
      `  entryType: ${fmt(this.entryType)},\n` +
      `  startTime: ${fmt(this.startTime)},\n` +
      `  duration: ${fmt(this.duration)},\n` +
      `  initiatorType: ${fmt(this.initiatorType)},\n` +
      `  nextHopProtocol: ${fmt(this.nextHopProtocol)},\n` +
      `  workerStart: ${fmt(this.workerStart)},\n` +
      `  redirectStart: ${fmt(this.redirectStart)},\n` +
      `  redirectEnd: ${fmt(this.redirectEnd)},\n` +
      `  fetchStart: ${fmt(this.fetchStart)},\n` +
      `  domainLookupStart: ${fmt(this.domainLookupStart)},\n` +
      `  domainLookupEnd: ${fmt(this.domainLookupEnd)},\n` +
      `  connectStart: ${fmt(this.connectStart)},\n` +
      `  connectEnd: ${fmt(this.connectEnd)},\n` +
      `  secureConnectionStart: ${fmt(this.secureConnectionStart)},\n` +
      `  requestStart: ${fmt(this.requestStart)},\n` +
      `  responseStart: ${fmt(this.responseStart)},\n` +
      `  responseEnd: ${fmt(this.responseEnd)},\n` +
      `  transferSize: ${fmt(this.transferSize)},\n` +
      `  encodedBodySize: ${fmt(this.encodedBodySize)},\n` +
      `  decodedBodySize: ${fmt(this.decodedBodySize)},\n` +
      `  deliveryType: ${fmt(this.deliveryType)},\n` +
      `  responseStatus: ${fmt(this.responseStatus)}\n` +
      `}`;
  }
}

function createPerformanceResourceTiming(name, initiatorType, cacheMode, timingInfo, deliveryType, responseStatus) {
  const entry = new PerformanceResourceTiming(kSkipThrow, name, 'resource');
  entry[kRequestedUrl] = `${name}`;
  entry[kInitiatorType] = `${initiatorType}`;
  entry[kCacheMode] = cacheMode;
  entry[kTimingInfo] = { ...timingInfo };
  entry[kDeliveryType] = deliveryType;
  entry[kResponseStatus] = responseStatus;
  return entry;
}

// ---------------------------------------------------------------------------
// 7. Entry buffers, observers and the Performance facade.
// ---------------------------------------------------------------------------
const markTimings = new Map();
let markEntryBuffer = [];
let measureEntryBuffer = [];
let resourceTimingBuffer = [];
let resourceTimingSecondaryBuffer = [];
let resourceTimingBufferSizeLimit = 250;
let resourceTimingBufferFullPending = false;

const kObservers = new Set();
let queuedObservers = new Set();
let queueScheduled = false;

function scheduleDispatch() {
  if (typeof globalThis.setImmediate === 'function') {
    globalThis.setImmediate(dispatchObservers);
  } else if (typeof globalThis.queueMicrotask === 'function') {
    globalThis.queueMicrotask(dispatchObservers);
  } else {
    globalThis.setTimeout(dispatchObservers, 0);
  }
}

function enqueue(entry) {
  for (const observer of kObservers) {
    if (observer[kPending] === undefined) continue;
    // Filter by the observer's subscription: entryTypes set or single type.
    const entryTypes = observer[kEntryTypes];
    if (entryTypes !== undefined) {
      if (!entryTypes.has(entry.entryType)) continue;
    } else {
      const type = observer[kType];
      if (type !== undefined && type !== entry.entryType) continue;
    }
    observer[kPending].add(entry);
    queuedObservers.add(observer);
  }
  if (queuedObservers.size > 0 && !queueScheduled) {
    queueScheduled = true;
    scheduleDispatch();
  }
}

function dispatchObservers() {
  queueScheduled = false;
  const toDispatch = [...queuedObservers];
  queuedObservers = new Set();
  for (const observer of toDispatch) {
    const pending = observer[kPending];
    if (pending === undefined || pending.size === 0) continue;
    const entries = [...pending];
    pending.clear();
    entries.sort((a, b) => a.startTime - b.startTime);
    const list = new PerformanceObserverEntryList(kSkipThrow);
    list[kHandle] = entries;
    try {
      observer.callback.call(observer, list, observer);
    } catch {
      // Observer callback exceptions must not break other observers.
    }
  }
}

function bufferUserTiming(entry) {
  if (entry.entryType === 'mark') {
    markEntryBuffer.push(entry);
  } else {
    measureEntryBuffer.push(entry);
  }
  // Match Node's leak guard (only when > 1e6 entries buffered).
  const entriesCount = markEntryBuffer.length + measureEntryBuffer.length;
  if (entriesCount > 1e6) {
    if (typeof globalThis.process !== 'undefined' && typeof globalThis.process.emitWarning === 'function') {
      globalThis.process.emitWarning('Possible perf_hooks memory leak detected.');
    }
    markEntryBuffer = [];
    measureEntryBuffer = [];
  }
}

function bufferResourceTiming(entry) {
  resourceTimingBuffer.push(entry);
  if (resourceTimingBuffer.length > resourceTimingBufferSizeLimit) {
    if (!resourceTimingBufferFullPending) {
      resourceTimingBufferFullPending = true;
      resourceTimingSecondaryBuffer = resourceTimingBuffer.slice();
      resourceTimingBuffer.length = 0;
      const fire = () => {
        resourceTimingBufferFullPending = false;
        const listeners = performance[kListeners]?.get('resourcetimingbufferfull');
        if (listeners !== undefined) {
          for (const listener of [...listeners]) {
            if (typeof listener === 'function') listener.call(performance);
            else if (listener !== null && typeof listener.handleEvent === 'function') {
              listener.handleEvent();
            }
          }
        }
        if (typeof performance._onrtbf === 'function') {
          performance._onrtbf.call(performance);
        }
      };
      if (typeof globalThis.queueMicrotask === 'function') {
        globalThis.queueMicrotask(fire);
      } else {
        globalThis.setTimeout(fire, 0);
      }
    }
  }
}

function clearEntriesFromBuffer(type, name) {
  switch (type) {
    case 'mark':
      if (name === undefined) {
        markEntryBuffer = [];
      } else {
        markEntryBuffer = markEntryBuffer.filter((entry) => entry.name !== name);
      }
      break;
    case 'measure':
      if (name === undefined) {
        measureEntryBuffer = [];
      } else {
        measureEntryBuffer = measureEntryBuffer.filter((entry) => entry.name !== name);
      }
      break;
    case 'resource':
      resourceTimingBuffer = [];
      break;
    default:
      break;
  }
}

function filterBufferMapByNameAndType(name, type) {
  const result = [];
  const entries = [...markEntryBuffer, ...measureEntryBuffer, ...resourceTimingBuffer];
  for (const entry of entries) {
    if (name !== undefined && entry.name !== name) continue;
    if (type !== undefined && entry.entryType !== type) continue;
    result.push(entry);
  }
  result.sort((a, b) => a.startTime - b.startTime);
  return result;
}

function clearMarkTimings(name) {
  if (name !== undefined) {
    name = `${name}`;
    if (nodeTimingReadOnlyAttributes.has(name)) throw errInvalidArgValue('name', name);
    markTimings.delete(name);
    return;
  }
  markTimings.clear();
}

function getMark(name) {
  if (nodeTimingReadOnlyAttributes.has(name)) return nodeTiming[name];
  return markTimings.get(name);
}

function getMarkOrThrow(name) {
  const ts = getMark(name);
  if (ts === undefined) throw errPerformanceMarkNotFound(name);
  return ts;
}

// Timestamp validation for measure options: must be a number, NaN is allowed,
// negatives throw ERR_PERFORMANCE_INVALID_TIMESTAMP.
function validateTimestampOption(value, name) {
  validateNumber(value, name);
  if (value < 0) throw errInvalidTimestamp(value);
}

function calculateStartDuration(startOrMeasureOptions, endMarkName) {
  let start;
  let end;
  let duration;
  if (
    startOrMeasureOptions !== undefined &&
    typeof startOrMeasureOptions === 'object' &&
    startOrMeasureOptions !== null
  ) {
    const optStart = startOrMeasureOptions.start;
    const optEnd = startOrMeasureOptions.end;
    const optDuration = startOrMeasureOptions.duration;
    // Specifying all three is rejected before any mark resolution.
    if (optStart !== undefined && optEnd !== undefined && optDuration !== undefined) {
      throw errPerformanceMeasureInvalidOptions();
    }
    if (optStart !== undefined) {
      start =
        typeof optStart === 'number'
          ? (validateTimestampOption(optStart, 'start'), optStart)
          : getMarkOrThrow(`${optStart}`);
    }
    if (optEnd !== undefined) {
      end =
        typeof optEnd === 'number'
          ? (validateTimestampOption(optEnd, 'end'), optEnd)
          : getMarkOrThrow(`${optEnd}`);
    }
    // `duration` is only validated when it participates in the computation;
    // a lone `duration` option is ignored (matches native behavior).
    if (optDuration !== undefined && (start !== undefined || end !== undefined)) {
      validateTimestampOption(optDuration, 'duration');
    }
    duration = optDuration;
    if (start !== undefined && end !== undefined) {
      duration = end - start;
    } else if (end !== undefined && duration !== undefined) {
      start = end - duration;
    } else if (start !== undefined && duration !== undefined) {
      // start and duration are used as given.
    } else {
      start ??= 0;
      duration = (end ?? now()) - start;
    }
  } else if (startOrMeasureOptions !== undefined) {
    // Non-object form: a string names a start mark; any other type means
    // "start at 0" (numbers are NOT mark lookups here).
    start =
      typeof startOrMeasureOptions === 'string'
        ? getMarkOrThrow(startOrMeasureOptions)
        : 0;
    if (endMarkName !== undefined) {
      end =
        typeof endMarkName === 'number'
          ? (validateTimestampOption(endMarkName, 'end'), endMarkName)
          : getMarkOrThrow(`${endMarkName}`);
      duration = end - start;
    } else {
      duration = now() - start;
    }
  } else {
    start = 0;
    duration = now();
  }
  return { start, duration };
}

function mark(name, options = undefined) {
  if (arguments.length === 0) throw errMissingArgs('name');
  const entry = new PerformanceMark(`${name}`, options);
  bufferUserTiming(entry);
  enqueue(entry);
  return entry;
}

function measure(name, startOrMeasureOptions = undefined, endMarkName = undefined) {
  if (arguments.length === 0) throw errMissingArgs('name');
  name = `${name}`;
  if (nodeTimingReadOnlyAttributes.has(name)) throw errInvalidArgValue('name', name);
  const { start, duration } = calculateStartDuration(startOrMeasureOptions, endMarkName);
  let detail = null;
  if (
    typeof startOrMeasureOptions === 'object' &&
    startOrMeasureOptions !== null &&
    startOrMeasureOptions.detail != null
  ) {
    detail = structuredCloneValue(startOrMeasureOptions.detail);
  }
  const entry = createPerformanceMeasure(name, start, duration, detail);
  bufferUserTiming(entry);
  enqueue(entry);
  return entry;
}

// The observers' entry list.
class PerformanceObserverEntryList {
  constructor(skipThrowSymbol = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
  }

  _entries() {
    if (this[kHandle] === undefined) throw errInvalidThis('PerformanceObserverEntryList');
    return this[kHandle];
  }

  getEntries() {
    return this._entries().slice().sort((a, b) => a.startTime - b.startTime);
  }

  getEntriesByName(name, type = undefined) {
    if (arguments.length === 0) throw errMissingArgs('name');
    validateString(name, 'name');
    if (type !== undefined) validateString(type, 'type');
    return this.getEntries().filter(
      (entry) => entry.name === name && (type === undefined || entry.entryType === type)
    );
  }

  getEntriesByType(type) {
    if (arguments.length === 0) throw errMissingArgs('type');
    validateString(type, 'type');
    return this.getEntries().filter((entry) => entry.entryType === type);
  }
}

// Node defines prototype methods as enumerable on these classes.
function makeMethodsEnumerable(ctor, names) {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, name);
    if (descriptor) {
      descriptor.enumerable = true;
      Object.defineProperty(ctor.prototype, name, descriptor);
    }
  }
}

function setToStringTag(ctor, value) {
  Object.defineProperty(ctor.prototype, Symbol.toStringTag, {
    writable: false,
    enumerable: false,
    configurable: true,
    value,
  });
}

makeMethodsEnumerable(PerformanceEntry, ['toJSON']);
setToStringTag(PerformanceEntry, 'PerformanceEntry');
makeMethodsEnumerable(PerformanceNodeEntry, ['toJSON']);
makeMethodsEnumerable(PerformanceMark, ['toJSON']);
setToStringTag(PerformanceMark, 'PerformanceMark');
makeMethodsEnumerable(PerformanceMeasure, ['toJSON']);
setToStringTag(PerformanceMeasure, 'PerformanceMeasure');
makeMethodsEnumerable(PerformanceResourceTiming, ['toJSON']);
setToStringTag(PerformanceResourceTiming, 'PerformanceResourceTiming');
makeMethodsEnumerable(PerformanceObserverEntryList, ['getEntries', 'getEntriesByName', 'getEntriesByType']);
setToStringTag(PerformanceObserverEntryList, 'PerformanceObserverEntryList');

const supportedEntryTypes = [
  'dns',
  'function',
  'gc',
  'http',
  'http2',
  'mark',
  'measure',
  'net',
  'quic',
  'resource',
];

const bufferedEntryTypes = ['mark', 'measure', 'resource'];

class PerformanceObserver {
  constructor(callback) {
    validateFunction(callback, 'callback');
    this.callback = callback;
    this[kPending] = new Set();
  }

  observe(options = undefined) {
    if (this[kPending] === undefined) throw errInvalidThis('PerformanceObserver');
    if (options === undefined) options = {};
    validateObject(options, 'options');
    const { entryTypes, type, buffered = false } = options;
    if (entryTypes !== undefined && type !== undefined) {
      throw errInvalidArgValue(
        'options.entryTypes',
        entryTypes,
        'options.entryTypes can not set with options.type together'
      );
    }
    validateBoolean(buffered, 'options.buffered');
    if (entryTypes !== undefined) {
      if (!Array.isArray(entryTypes)) throw errInvalidArgType('options.entryTypes', 'an Array', entryTypes);
      this[kEntryTypes] = new Set();
      for (const entryType of entryTypes) {
        validateString(entryType, 'entryType');
        validateOneOf(entryType, 'entryType', supportedEntryTypes);
        this[kEntryTypes].add(entryType);
      }
      if (this[kEntryTypes].size === 0) throw errInvalidArgValue('options.entryTypes', entryTypes);
      this[kType] = undefined;
    } else if (type !== undefined) {
      validateString(type, 'type');
      validateOneOf(type, 'type', supportedEntryTypes);
      this[kType] = type;
      this[kEntryTypes] = undefined;
      if (buffered) {
        if (!bufferedEntryTypes.includes(type)) {
          throw errInvalidArgValue('options.buffered', buffered);
        }
        const entries = filterBufferMapByNameAndType(undefined, type);
        if (entries.length > 0) {
          for (const entry of entries) this[kPending].add(entry);
          queuedObservers.add(this);
          if (!queueScheduled) {
            queueScheduled = true;
            scheduleDispatch();
          }
        }
      }
    } else {
      throw errMissingArgs('options.entryTypes', 'options.type');
    }
    kObservers.add(this);
  }

  disconnect() {
    // Node's disconnect() resets the observer so it can be re-observed later;
    // it does not permanently invalidate the instance.
    if (this[kPending] !== undefined) {
      this[kPending].clear();
    }
    this[kPending] = new Set();
    this[kEntryTypes] = undefined;
    this[kType] = undefined;
    kObservers.delete(this);
    queuedObservers.delete(this);
  }

  takeRecords() {
    if (this[kPending] === undefined) this[kPending] = new Set();
    const entries = [...this[kPending]];
    this[kPending].clear();
    queuedObservers.delete(this);
    return entries.sort((a, b) => a.startTime - b.startTime);
  }
}

makeMethodsEnumerable(PerformanceObserver, ['observe', 'disconnect', 'takeRecords']);
setToStringTag(PerformanceObserver, 'PerformanceObserver');

function markResourceTiming(timingInfo, requestedUrl, initiatorType, global, cacheMode, body, responseStatus, deliveryType) {
  const entry = createPerformanceResourceTiming(
    requestedUrl,
    initiatorType,
    cacheMode,
    timingInfo,
    deliveryType,
    responseStatus
  );
  enqueue(entry);
  bufferResourceTiming(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// 8. nodeTiming, eventLoopUtilization, timerify.
// ---------------------------------------------------------------------------
const moduleInitNow = now();

// `eventLoopUtilization` needs libuv's idle/active loop counters, which do not
// exist in pure JS. Under real Node.js we delegate to the genuine builtin;
// elsewhere we report the same shape Node uses when idle metrics are
// unavailable (`{ idle: 0, active: 0, utilization: 0 }`).
const eventLoopUtilization =
  nativePerfHooks !== null && typeof nativePerfHooks.eventLoopUtilization === 'function'
    ? nativePerfHooks.eventLoopUtilization
    : function eventLoopUtilization(_util1, _util2) {
        return { idle: 0, active: 0, utilization: 0 };
      };

// `nodeTiming`'s `loopStart`/`loopExit`/`idleTime` come from libuv. Under real
// Node.js we use the genuine `performance.nodeTiming` so `idleTime` stays
// consistent with the delegated `eventLoopUtilization()`; otherwise we use a
// pure-JS approximation with `loopStart`/`loopExit` as -1.
const nodeTiming = (() => {
  if (nativePerfHooks !== null) {
    const nativeNodeTiming = nativePerfHooks.performance?.nodeTiming;
    if (nativeNodeTiming && typeof nativeNodeTiming === 'object') {
      return nativeNodeTiming;
    }
  }
  const pureJsNodeTiming = {
    name: 'node',
    entryType: 'node',
    startTime: 0,
    get duration() {
      return now();
    },
    get nodeStart() {
      return 0;
    },
    get v8Start() {
      return 0;
    },
    get environment() {
      return moduleInitNow;
    },
    get loopStart() {
      // No libuv event loop in this environment.
      return -1;
    },
    get loopExit() {
      return -1;
    },
    get bootstrapComplete() {
      return moduleInitNow;
    },
    get idleTime() {
      return 0;
    },
    get uvMetricsInfo() {
      return { loopCount: 0, events: 0, eventsWaiting: 0 };
    },
    toJSON() {
      return {
        name: 'node',
        entryType: 'node',
        startTime: 0,
        duration: this.duration,
        nodeStart: this.nodeStart,
        v8Start: this.v8Start,
        bootstrapComplete: this.bootstrapComplete,
        environment: this.environment,
        loopStart: this.loopStart,
        loopExit: this.loopExit,
        idleTime: this.idleTime,
      };
    },
    [kInspect](depth, options, inspectFn) {
      if (depth < 0) return this;
      const opts = { ...options, depth: options?.depth == null ? null : options.depth - 1 };
      return `PerformanceNodeTiming ${formatValue(this.toJSON(), opts, inspectFn)}`;
    },
  };
  Object.setPrototypeOf(pureJsNodeTiming, PerformanceEntry.prototype);
  return pureJsNodeTiming;
})();

function isHistogram(obj) {
  return obj != null && (obj[kHandle] !== undefined || nativeHistogramSet.has(obj));
}

function timerify(fn, options = undefined) {
  if (options === undefined) options = {};
  validateObject(options, 'options');
  validateFunction(fn, 'fn');
  const histogram = options?.histogram;
  if (histogram !== undefined && (!isHistogram(histogram) || typeof histogram.record !== 'function')) {
    throw errInvalidArgType('options.histogram', 'a RecordableHistogram', histogram);
  }

  function processComplete(startTime, args) {
    const duration = now() - startTime;
    let detail = null;
    if (args.length > 0) {
      detail = Array.prototype.slice.call(args);
      for (let i = 0; i < detail.length; i++) detail[i] = `${detail[i]}`;
    }
    if (histogram !== undefined) {
      histogram.record(Math.ceil(duration * 1e6));
    }
    const entry = createPerformanceNodeEntry(fn.name, 'function', startTime, duration, detail);
    enqueue(entry);
  }

  // A real wrapper function (not a Proxy): defining `name`/`length` on a
  // Proxy would forward to and mutate the original function.
  function timerified(...args) {
    const startTime = now();
    if (new.target !== undefined) {
      const result = Reflect.construct(fn, args, fn);
      processComplete(startTime, args);
      return result;
    }
    const result = Reflect.apply(fn, this, args);
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      typeof result.finally === 'function'
    ) {
      return result.finally(processComplete.bind(null, startTime, args));
    }
    processComplete(startTime, args);
    return result;
  }
  Object.defineProperties(timerified, {
    length: { enumerable: true, configurable: false, value: fn.length },
    name: { enumerable: true, configurable: false, value: `timerified ${fn.name}` },
  });
  return timerified;
}

// ---------------------------------------------------------------------------
// 9. The Performance facade and its singleton.
// ---------------------------------------------------------------------------
class Performance {
  constructor() {
    throw errIllegalConstructor();
  }

  addEventListener(type, listener, _options = undefined) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    if (listener == null) return;
    let set = this[kListeners].get(type);
    if (set === undefined) {
      set = new Set();
      this[kListeners].set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type, listener, _options = undefined) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    this[kListeners].get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    const listeners = this[kListeners].get(event?.type);
    if (listeners !== undefined) {
      for (const listener of [...listeners]) {
        if (typeof listener === 'function') listener.call(this, event);
        else if (listener !== null && typeof listener.handleEvent === 'function') {
          listener.handleEvent(event);
        }
      }
    }
    const handler = this._onrtbf;
    if (event?.type === 'resourcetimingbufferfull' && typeof handler === 'function') {
      handler.call(this, event);
    }
    return true;
  }

  get onresourcetimingbufferfull() {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    return this._onrtbf ?? null;
  }

  set onresourcetimingbufferfull(fn) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    this._onrtbf = fn;
  }

  clearMarks(markName = undefined) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    clearEntriesFromBuffer('mark', markName === undefined ? undefined : `${markName}`);
    clearMarkTimings(markName);
  }

  clearMeasures(measureName = undefined) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    measureName = measureName === undefined ? undefined : `${measureName}`;
    clearEntriesFromBuffer('measure', measureName);
  }

  clearResourceTimings() {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    resourceTimingBuffer = [];
    resourceTimingSecondaryBuffer = [];
  }

  getEntries() {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    return filterBufferMapByNameAndType(undefined, undefined);
  }

  getEntriesByName(name, type = undefined) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    if (arguments.length === 0) throw errMissingArgs('name');
    return filterBufferMapByNameAndType(`${name}`, type === undefined ? undefined : `${type}`);
  }

  getEntriesByType(type) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    if (arguments.length === 0) throw errMissingArgs('type');
    return filterBufferMapByNameAndType(undefined, `${type}`);
  }

  mark(markName, markOptions = undefined) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    return mark(markName, markOptions);
  }

  measure(measureName, startOrMeasureOptions = undefined, endMarkName = undefined) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    return measure(measureName, startOrMeasureOptions, endMarkName);
  }

  now() {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    return now();
  }

  get timeOrigin() {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    return timeOrigin;
  }

  toJSON() {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    return {
      nodeTiming: this.nodeTiming,
      timeOrigin: this.timeOrigin,
      eventLoopUtilization: this.eventLoopUtilization(),
    };
  }

  setResourceTimingBufferSize(maxSize) {
    validateThisInternalField(this, kPerformanceBrand, 'Performance');
    validateInteger(maxSize, 'maxSize', 0);
    resourceTimingBufferSizeLimit = maxSize;
  }
}

makeMethodsEnumerable(Performance, [
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'clearMarks',
  'clearMeasures',
  'clearResourceTimings',
  'getEntries',
  'getEntriesByName',
  'getEntriesByType',
  'mark',
  'measure',
  'now',
  'timeOrigin',
  'toJSON',
  'setResourceTimingBufferSize',
]);
setToStringTag(Performance, 'Performance');

function createPerformance() {
  const p = Object.create(Performance.prototype);
  p[kPerformanceBrand] = true;
  p[kListeners] = new Map();
  p._onrtbf = null;
  return p;
}

const performance = createPerformance();

// Node extensions on the Performance prototype.
Object.defineProperties(Performance.prototype, {
  eventLoopUtilization: { enumerable: true, configurable: true, writable: true, value: eventLoopUtilization },
  nodeTiming: { enumerable: true, configurable: true, writable: true, value: nodeTiming },
  markResourceTiming: { enumerable: true, configurable: true, writable: true, value: markResourceTiming },
  timerify: { enumerable: true, configurable: true, writable: true, value: timerify },
});

function monitorEventLoopDelay(options = undefined) {
  if (options === undefined) options = {};
  validateObject(options, 'options');
  const { samplePerIteration = false, resolution = 10 } = options;
  validateBoolean(samplePerIteration, 'options.samplePerIteration');
  validateInteger(resolution, 'options.resolution', 1);
  if (nativePerfHooks !== null) {
    // Native ELD histograms participate in V8 structured serialization
    // (postMessage), which the pure-JS fallback cannot replicate.
    const histogram = nativePerfHooks.monitorEventLoopDelay(options);
    nativeHistogramSet.add(histogram);
    return histogram;
  }
  const histogram = new ELDHistogram(kSkipThrow);
  histogram[kHandle] = new BucketStore(1, MAX_SAFE_INTEGER, 3);
  histogram[kMap] = new Map();
  histogram[kEnabled] = false;
  histogram._resolution = resolution;
  histogram._eldTimer = undefined;
  histogram.constructor = ELDHistogram;
  return histogram;
}

// ---------------------------------------------------------------------------
// 10. Constants.
// ---------------------------------------------------------------------------
const constants = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP: 2,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
});

// ---------------------------------------------------------------------------
// 11. Value formatting for util.inspect custom symbols.
// ---------------------------------------------------------------------------
function formatValue(value, opts, inspectFn) {
  if (typeof inspectFn === 'function') {
    return inspectFn(value, opts);
  }
  return fallbackInspect(value, opts);
}

// Formats a single scalar value the way `util.inspect` does (used by the
// PerformanceResourceTiming custom inspect). Prefers the real `util.inspect`
// when the host provides it via the custom-inspect hook.
function formatInspectValue(value, inspectFn) {
  if (typeof inspectFn === 'function') {
    try {
      return inspectFn(value);
    } catch {}
  }
  if (typeof value === 'string') {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[ ${value.map((v) => formatInspectValue(v, undefined)).join(', ')} ]`;
  }
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return String(value);
}

function fallbackInspect(value, opts = {}, seen = new Set()) {
  const depth = opts.depth ?? 2;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') return `'${value}'`;
  if (t === 'number' || t === 'boolean') return String(value);
  if (t === 'bigint') return `${value}n`;
  if (t === 'symbol') return String(value);
  if (t === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (seen.has(value)) return '[Circular]';
  if (depth < 0) return '[Object]';
  seen.add(value);
  const childOpts = { ...opts, depth: depth - 1 };
  try {
    if (Array.isArray(value)) {
      return `[ ${value.map((v) => fallbackInspect(v, childOpts, seen)).join(', ')} ]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([k, v]) => `${fallbackInspect(k, childOpts, seen)} => ${fallbackInspect(v, childOpts, seen)}`
      );
      return `Map(${value.size}) { ${entries.join(', ')} }`;
    }
    const keys = Object.keys(value);
    const body = keys
      .map((k) => `${k}: ${fallbackInspect(value[k], childOpts, seen)}`)
      .join(', ');
    return `{ ${body} }`;
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// 12. Exports.
// ---------------------------------------------------------------------------
export {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  constants,
  createHistogram,
  eventLoopUtilization,
  monitorEventLoopDelay,
  performance,
  timerify,
};

export default {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  constants,
  createHistogram,
  eventLoopUtilization,
  monitorEventLoopDelay,
  performance,
  timerify,
};

// ---------------------------------------------------------------------------
// 13. Node.js global integration.
// ---------------------------------------------------------------------------
// The official tests use the global `performance` object and expect
// `performance.timerify` to be the same function as `perf_hooks.timerify`
// (in real Node the global `performance` comes from `perf_hooks`). When
// running under real Node.js, install our `timerify` on the global so the
// alias holds. This is Node-only; the browser's `performance` is untouched.
if (nativePerfHooks !== null) {
  try {
    const globalPerformance = globalThis.performance;
    if (
      globalPerformance !== null &&
      typeof globalPerformance === 'object' &&
      globalPerformance.timerify !== timerify
    ) {
      Object.defineProperty(globalPerformance, 'timerify', {
        value: timerify,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  } catch {
    // If the global cannot be patched, the alias test will fail; the rest of
    // the shim still works.
  }
}
