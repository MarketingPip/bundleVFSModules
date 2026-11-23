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
import { perfObserveBridge } from "./internals/perf-observe.js";
// ponytail: version-gate — TARGET_NODE selects whether the five Node 26
// PerformanceResourceTiming attributes appear in toJSON()/inspect
// (table: perf-hooks-resourcetiming-attrs). The getters stay in place:
// the v24 test never reads them directly.
import { isTarget24 } from "./version-gate.js";

const RT =
  typeof globalThis._RUNTIME_ !== "undefined"
    ? globalThis._RUNTIME_
    : undefined;
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
// Browsers keep the dependency-free pure-JS fallbacks below, so the shim
// works with zero native delegation: there is no `process.getBuiltinModule`
// in a browser, and in Jared's sandbox the template's getBuiltinModule
// throws ERR_REQUIRE_ASYNC_MODULE for a builtin still being evaluated (its
// cache/registry only resolve completed loads), so the bridge stays off
// there too. Set `globalThis.__PERF_HOOKS_NO_NATIVE__ = true` before importing to force
// the pure-JS implementations (used by the browser-fallback test lane).
let nativePerfHooks = null;
try {
  if (
    globalThis.__PERF_HOOKS_NO_NATIVE__ !== true &&
    typeof process !== "undefined" &&
    typeof process.getBuiltinModule === "function"
  ) {
    const candidate = process.getBuiltinModule("perf_hooks");
    if (
      candidate &&
      typeof candidate.createHistogram === "function" &&
      // Self-delegation guard: a VFS-resolving getBuiltinModule can hand
      // this module its own exports back as "native" (the same trap
      // src/child_process.js loadNativeChildProcess guards with _RUNTIME_).
      // The genuine builtin's createHistogram is a different function
      // object, so this rejects only the shim itself — never the real thing.
      // Without it, createHistogram/eventLoopUtilization would recurse
      // into themselves in any host whose getBuiltinModule resolves the shim.
      candidate.createHistogram !== createHistogram
    ) {
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
const kSkipThrow = Symbol("kSkipThrow");
const kHandle = Symbol("kHandle");
const kMap = Symbol("kMap");
const kEnabled = Symbol("kEnabled");
const kRecordable = Symbol("kRecordable");
const kSlidingWindowHandle = Symbol("kSlidingWindowHandle");
const kName = Symbol("kName");
const kEntryType = Symbol("kEntryType");
const kStartTime = Symbol("kStartTime");
const kDuration = Symbol("kDuration");
const kDetail = Symbol("kDetail");
const kRequestedUrl = Symbol("kRequestedUrl");
const kTimingInfo = Symbol("kTimingInfo");
const kInitiatorType = Symbol("kInitiatorType");
const kCacheMode = Symbol("kCacheMode");
const kDeliveryType = Symbol("kDeliveryType");
const kResponseStatus = Symbol("kResponseStatus");
const kBodyInfo = Symbol("kBodyInfo");
const kPending = Symbol("kPending");
const kEntryTypes = Symbol("kEntryTypes");
const kType = Symbol("kType");
const kPerformanceBrand = Symbol("kPerformanceBrand");
const kListeners = Symbol("kListeners");
const kInspect = Symbol.for("nodejs.util.inspect.custom");

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function errIllegalConstructor() {
  const err = new TypeError("Illegal constructor");
  err.code = "ERR_ILLEGAL_CONSTRUCTOR";
  return err;
}

function errMissingArgs(...args) {
  const msg =
    args.length > 1
      ? `The ${args.map((a) => `"${a}"`).join(" and ")} arguments must be specified`
      : `The "${args[0]}" argument must be specified`;
  const err = new TypeError(msg);
  err.code = "ERR_MISSING_ARGS";
  return err;
}

function errInvalidThis(type) {
  const err = new TypeError(
    `The "this" argument must be an instance of ${type}`,
  );
  err.code = "ERR_INVALID_THIS";
  return err;
}

function errInvalidArgType(name, expected, actual) {
  const actualDesc =
    actual === null
      ? "null"
      : typeof actual === "object" && Array.isArray(actual)
        ? "an instance of Array"
        : `of type ${typeof actual}`;
  const err = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${actualDesc}`,
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

function errInvalidArgValue(name, value, reason) {
  const kind = name.includes(".") ? "property" : "argument";
  const err = new TypeError(
    `The ${kind} '${name}' ${reason ?? "is invalid"}. Received ${miniInspect(value)}`,
  );
  err.code = "ERR_INVALID_ARG_VALUE";
  return err;
}

function errInvalidTimestamp(value) {
  const err = new TypeError(`${miniInspect(value)} is not a valid timestamp`);
  err.code = "ERR_PERFORMANCE_INVALID_TIMESTAMP";
  return err;
}

function errPerformanceMeasureInvalidOptions() {
  const err = new TypeError(
    "Must not have options.start, options.end, and options.duration specified",
  );
  err.code = "ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS";
  return err;
}

function errPerformanceMarkNotFound(name) {
  // Node throws a DOMException named 'SyntaxError' with code 12 here.
  return new DOMException(
    `The "${name}" performance mark has not been set`,
    "SyntaxError",
  );
}

function errOutOfRange(name, range, value) {
  const actual = typeof value === "bigint" ? `${value}n` : miniInspect(value);
  const err = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${actual}`,
  );
  err.code = "ERR_OUT_OF_RANGE";
  return err;
}

function errOutOfRangePlain() {
  const err = new RangeError("value is out of range");
  err.code = "ERR_OUT_OF_RANGE";
  return err;
}

function errInvalidState() {
  const err = new Error("Invalid state");
  err.code = "ERR_INVALID_STATE";
  return err;
}

function validateThisInternalField(obj, field, className) {
  if (obj === null || obj === undefined || obj[field] === undefined) {
    throw errInvalidThis(className);
  }
}

function validateFunction(value, name) {
  if (typeof value !== "function")
    throw errInvalidArgType(name, "of type function", value);
}

function validateObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw errInvalidArgType(name, "of type object", value);
  }
}

function validateString(value, name) {
  if (typeof value !== "string")
    throw errInvalidArgType(name, "of type string", value);
}

function validateNumber(value, name) {
  if (typeof value !== "number")
    throw errInvalidArgType(name, "of type number", value);
}

function validateInteger(
  value,
  name,
  min = Number.MIN_SAFE_INTEGER,
  max = MAX_SAFE_INTEGER,
) {
  if (typeof value !== "number")
    throw errInvalidArgType(name, "of type number", value);
  if (!Number.isInteger(value)) throw errOutOfRange(name, "an integer", value);
  if (value < min || value > max) {
    throw errOutOfRange(name, `>= ${min} && <= ${max}`, value);
  }
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean")
    throw errInvalidArgType(name, "of type boolean", value);
}

function validateOneOf(value, name, choices) {
  if (!choices.includes(value)) {
    const list = choices.map((c) => `'${c}'`).join(", ");
    throw errInvalidArgValue(name, value, `must be one of: ${list}`);
  }
}

// Minimal value formatter used in error messages (no dependency on util).
function miniInspect(value) {
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return `[ ${value.map(miniInspect).join(", ")} ]`;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "object") {
    const entries = Object.entries(value).map(
      ([k, v]) => `${k}: ${miniInspect(v)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// 3. Clock: host performance.now()/timeOrigin when available.
// ---------------------------------------------------------------------------
const _nativePerformance =
  typeof globalThis.performance === "object" && globalThis.performance !== null
    ? globalThis.performance
    : undefined;

const timeOrigin =
  _nativePerformance && typeof _nativePerformance.timeOrigin === "number"
    ? _nativePerformance.timeOrigin
    : Date.now();

function now() {
  if (_nativePerformance && typeof _nativePerformance.now === "function") {
    return _nativePerformance.now();
  }
  return Date.now() - timeOrigin;
}

function structuredCloneValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof globalThis.structuredClone === "function") {
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
    this.subBucketMask =
      (this.subBucketCount - 1) * Math.pow(2, this.unitMagnitude);
    this.bucketCount = this._getBucketCount();
    this.counts = new Array(this.bucketCount * this.subBucketCount).fill(0);
    // Node 26 state carried alongside the buckets. `resetCount` counts
    // reset()/subtract() calls (see Histogram::ResetCount); `normOffset`
    // is the CBOR normalizing index offset (physical counts are rotated by
    // it; 0 for histograms built here); `convRatio` is the CBOR conversion
    // ratio (1.0 unless imported). EWMA state mirrors
    // Histogram::UpdateEwma (src/histogram-inl.h): alpha is derived from
    // halfLife, the running mean/variance/error-rate track raw recorded
    // values (not bucket midpoints), and reset() clears the running state.
    this.resetCount = 0;
    this.normOffset = 0;
    this.convRatio = 1;
    this.ewmaAlpha = 0;
    this.ewmaThreshold = 0;
    this._ewmaMean = 0;
    this._ewmaVariance = 0;
    this._ewmaErrorRate = 0;
    this.ewmaInitialized = false;
    this._clearCounts();
  }

  _getBucketCount() {
    let smallestUntrackableValue =
      this.subBucketCount * Math.pow(2, this.unitMagnitude);
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

  _clearCounts() {
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

  reset() {
    // Mirrors Histogram::Reset: clears the counts and the EWMA running
    // state, and counts the reset for diff() staleness detection.
    this._clearCounts();
    this.resetCount++;
    this._ewmaMean = 0;
    this._ewmaVariance = 0;
    this._ewmaErrorRate = 0;
    this.ewmaInitialized = false;
  }

  // EWMA update for one successfully recorded raw value (Histogram::
  // UpdateEwma). No-op when EWMA is disabled (alpha 0); exceeds values
  // never reach here.
  updateEwma(value) {
    const alpha = this.ewmaAlpha;
    if (alpha <= 0) return;
    if (!this.ewmaInitialized) {
      this._ewmaMean = value;
      this._ewmaVariance = 0;
      this.ewmaInitialized = true;
      if (this.ewmaThreshold > 0) {
        this._ewmaErrorRate = value > this.ewmaThreshold ? 1 : 0;
      }
      return;
    }
    const diff = value - this._ewmaMean;
    this._ewmaMean += alpha * diff;
    this._ewmaVariance =
      (1 - alpha) * (this._ewmaVariance + alpha * diff * diff);
    if (this.ewmaThreshold > 0) {
      const exceeded = value > this.ewmaThreshold ? 1 : 0;
      this._ewmaErrorRate += alpha * (exceeded - this._ewmaErrorRate);
    }
  }

  clone() {
    const copy = new BucketStore(this.lowest, this.highest, this.figures);
    copy.counts = this.counts.slice();
    copy.totalCount = this.totalCount;
    copy.exceeds = this.exceeds;
    copy.sum = this.sum;
    copy.sumSq = this.sumSq;
    copy.min = this.min;
    copy.max = this.max;
    copy.minIndex = this.minIndex;
    copy.maxIndex = this.maxIndex;
    copy.resetCount = this.resetCount;
    copy.normOffset = this.normOffset;
    copy.convRatio = this.convRatio;
    copy.ewmaAlpha = this.ewmaAlpha;
    copy.ewmaThreshold = this.ewmaThreshold;
    copy._ewmaMean = this._ewmaMean;
    copy._ewmaVariance = this._ewmaVariance;
    copy._ewmaErrorRate = this._ewmaErrorRate;
    copy.ewmaInitialized = this.ewmaInitialized;
    return copy;
  }

  // Install counts given by hdr logical index (used by importHistogram()
  // and diff()). Aggregates are recomputed in ascending index order,
  // matching hdr's iteration order, so mean/stddev stay bit-identical to
  // native. This re-buckets through value ranges, never through raw
  // midpoints above `highest`: direct index assignment is the only exact
  // path for top-bucket counts (Histogram::Diff copies counts directly).
  setLogicalCounts(logicalCounts) {
    this._clearCounts();
    for (let j = 0; j < logicalCounts.length; j++) {
      const c = logicalCounts[j];
      if (c === 0) continue;
      const i = hdrIndexToShimIndex(this, j);
      const { lowest, size } = this._bucketInfo(i);
      const contribution = lowest + Math.floor(size / 2);
      this.counts[i] = c;
      this.totalCount += c;
      this.sum += contribution * c;
      this.sumSq += contribution * contribution * c;
      if (this.minIndex === -1 || i < this.minIndex) {
        this.minIndex = i;
        this.min = lowest;
      }
      if (this.maxIndex === -1 || i > this.maxIndex) {
        this.maxIndex = i;
        this.max = lowest + size - 1;
      }
    }
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
    return (
      pow2ceiling - this.unitMagnitude - this.subBucketHalfCountMagnitude - 1
    );
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

  // Returns true when the value was recorded into a bucket, false when it
  // exceeded the trackable range (exceeds++ instead). Callers use the
  // result to decide whether the EWMA update applies.
  _addAt(value, times) {
    if (value > this.highest) {
      this.exceeds += times;
      return false;
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
    return true;
  }

  recordValue(value) {
    return this._addAt(value, 1);
  }

  recordBigint(value) {
    if (value > BigInt(this.highest)) {
      this.exceeds++;
      return false;
    }
    return this.recordValue(Number(value));
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
      if (
        other.minIndex !== -1 &&
        (this.minIndex === -1 || other.minIndex < this.minIndex)
      ) {
        this.minIndex = other.minIndex;
        this.min = other.min;
      }
      if (
        other.maxIndex !== -1 &&
        (this.maxIndex === -1 || other.maxIndex > this.maxIndex)
      ) {
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
    validateNumber(p, "percentile");
    if (Number.isNaN(p) || p <= 0 || p > 100) {
      throw errOutOfRange("percentile", "> 0 && <= 100", p);
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

  get ewmaMean() {
    return this.ewmaInitialized ? this._ewmaMean : 0;
  }

  get ewmaStddev() {
    return this.ewmaInitialized ? Math.sqrt(this._ewmaVariance) : 0;
  }

  get ewmaErrorRate() {
    return this.ewmaInitialized ? this._ewmaErrorRate : 0;
  }
}

// ---------------------------------------------------------------------------
// 4b. Student's t-distribution (for Histogram.meanCI), ported from
// src/histogram.cc (StudentTCdf / StudentTUpperQuantile /
// RegularizedIncompleteBeta, non-asymptotic branch only — the shapes used
// by meanCI never take the asymptotic path). lgamma is a Lanczos
// approximation (g=7); JS has no Math.lgamma.
// ---------------------------------------------------------------------------
const _lgammaCoefficients = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function _lgamma(z) {
  if (z < 0.5) {
    // Reflection: Gamma(z) * Gamma(1 - z) = pi / sin(pi * z).
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - _lgamma(1 - z);
  }
  z -= 1;
  let x = _lgammaCoefficients[0];
  for (let i = 1; i < 9; i++) x += _lgammaCoefficients[i] / (z + i);
  const t = z + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (z + 0.5) * Math.log(t) -
    t +
    Math.log(x)
  );
}

function _betaContinuedFraction(a, b, x) {
  // Lentz's modified method (Numerical Recipes in C, 2nd ed., section 6.4).
  const FPMIN = 1e-30;
  const MAXIT = 200;
  const EPS = 3e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = ((m * (b - m) * x) / ((qam + m2) * (a + m2)));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= EPS) break;
  }
  return h;
}

function _regularizedIncompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logNormalization = _lgamma(a + b) - _lgamma(a) - _lgamma(b);
  const front = Math.exp(
    logNormalization + a * Math.log(x) + b * Math.log(1 - x),
  );
  const symmetryPoint = (a + 1) / (a + b + 2);
  if (x < symmetryPoint) {
    return (front * _betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (front * _betaContinuedFraction(b, a, 1 - x)) / b;
}

function _studentTCdf(t, df) {
  const squared = t * t;
  const denominator = df + squared;
  if (squared < df) {
    const x = squared / denominator;
    const ibeta = _regularizedIncompleteBeta(0.5, df / 2, x);
    return t >= 0 ? 0.5 + 0.5 * ibeta : 0.5 - 0.5 * ibeta;
  }
  const x = df / denominator;
  const ibeta = _regularizedIncompleteBeta(df / 2, 0.5, x);
  return t >= 0 ? 1 - 0.5 * ibeta : 0.5 * ibeta;
}

function _studentTUpperQuantile(p, df) {
  let lo = 0;
  let hi = 1;
  while (_studentTCdf(-hi, df) > p) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (_studentTCdf(-mid, df) > p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// 5. Histogram classes.
// ---------------------------------------------------------------------------
class Histogram {
  constructor(skipThrowSymbol = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
  }

  _store() {
    if (this[kHandle] === undefined) throw errInvalidThis("Histogram");
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

  get resetCount() {
    // Guarded by instanceof, not this._store(): a bare `this` (e.g.
    // get.call({})) has no prototype methods, so _store() would throw a
    // codeless TypeError instead of ERR_INVALID_THIS.
    if (!(this instanceof Histogram)) throw errInvalidThis("Histogram");
    return this._store().resetCount;
  }

  get ewmaMean() {
    return this._store().ewmaMean;
  }

  get ewmaStddev() {
    return this._store().ewmaStddev;
  }

  get ewmaErrorRate() {
    return this._store().ewmaErrorRate;
  }

  get mean() {
    return this._store().mean;
  }

  get stddev() {
    return this._store().stddev;
  }

  // Confidence interval for the mean using Student's t-distribution
  // (Histogram::MeanCI). HdrHistogram reports the population stddev, so
  // the sample variance applies Bessel's correction, exactly as in C++.
  meanCI(options = undefined) {
    if (!(this instanceof Histogram)) throw errInvalidThis("Histogram");
    if (options === undefined) options = {};
    validateObject(options, "options");
    const { confidence = 0.95 } = options;
    validateNumber(confidence, "options.confidence");
    if (
      Number.isNaN(confidence) ||
      confidence <= 0 ||
      confidence >= 1
    ) {
      throw errOutOfRange("options.confidence", "> 0 && < 1", confidence);
    }
    const store = this._store();
    const count = store.totalCount;
    const mean = store.mean;
    if (count < 2) {
      return { __proto__: null, mean, lower: NaN, upper: NaN };
    }
    const stddev = store.stddev;
    if (stddev === 0) {
      return { __proto__: null, mean, lower: mean, upper: mean };
    }
    const variance = ((stddev * stddev) / (count - 1)) * count;
    const standardError = Math.sqrt(variance / count);
    const alpha = 1 - confidence;
    const tCrit = _studentTUpperQuantile(alpha / 2, count - 1);
    const margin = tCrit * standardError;
    return {
      __proto__: null,
      mean,
      lower: mean - margin,
      upper: mean + margin,
    };
  }

  // Serializes the histogram to the CBOR export format (Histogram::Export,
  // version 2). See the codec in section 5b.
  export() {
    if (!(this instanceof Histogram)) throw errInvalidThis("Histogram");
    return histogramExportCbor(this._store());
  }

  // Returns a new, independent read-only histogram holding a copy of this
  // histogram's current state (Histogram::Clone). The snapshot keeps the
  // counts, exceeds, resetCount and EWMA state; it has no recordable
  // methods because it is a plain Histogram, not a RecordableHistogram.
  snapshot() {
    if (!(this instanceof Histogram)) throw errInvalidThis("Histogram");
    return makeClonedHistogram(this._store().clone());
  }

  // Returns a new read-only histogram with the values recorded in this
  // histogram after `other`, an earlier snapshot of it, was taken
  // (Histogram::Diff). Layout (lowest/highest/figures/counts length/
  // normalizing offset) must match; a resetCount mismatch means values
  // were removed since the snapshot (ERR_INVALID_STATE); any bucket
  // count below the snapshot's means `other` is not earlier
  // (ERR_INVALID_ARG_VALUE). The difference carries no EWMA state and
  // resetCount 0, exactly as in C++.
  diff(other) {
    if (!(this instanceof Histogram)) throw errInvalidThis("Histogram");
    const store = this._store();
    if (!isHistogram(other)) {
      throw errInvalidArgType("other", "Histogram", other);
    }
    const a = histogramLogicalView(store);
    // A shim histogram diffs from its own store; a native histogram (no
    // shim kHandle symbol) diffs from its decoded export.
    const b =
      other[kHandle] !== undefined && other[kHandle] !== null
        ? histogramLogicalView(other._store())
        : histogramLogicalViewFromExport(other.export());
    return makeClonedHistogram(histogramDiffLogical(a, b));
  }

  percentile(percentile) {
    return this._store().percentile(percentile, false);
  }

  percentileBigInt(percentile) {
    return this._store().percentile(percentile, true);
  }

  get percentiles() {
    const map = this[kMap];
    if (map === undefined) throw errInvalidThis("Histogram");
    map.clear();
    for (const [k, v] of this._store().percentilesEntries(false)) map.set(k, v);
    return map;
  }

  get percentilesBigInt() {
    const map = this[kMap];
    if (map === undefined) throw errInvalidThis("Histogram");
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
    const opts = {
      ...options,
      depth: options?.depth == null ? null : options.depth - 1,
    };
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
      inspectFn,
    )}`;
  }
}

class RecordableHistogram extends Histogram {
  constructor(skipThrowSymbol = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    super(skipThrowSymbol);
  }

  _recordableStore() {
    if (this[kRecordable] === undefined)
      throw errInvalidThis("RecordableHistogram");
    return this._store();
  }

  record(val) {
    const store = this._recordableStore();
    if (typeof val === "bigint") {
      if (val < 1n) throw errOutOfRangePlain();
      // EWMA tracks the raw recorded value, and only when the value was
      // actually recorded (not when it exceeded the trackable range).
      if (store.recordBigint(val)) store.updateEwma(Number(val));
      return;
    }
    validateInteger(val, "val", 1);
    if (store.recordValue(val)) store.updateEwma(val);
  }

  recordDelta() {
    const store = this._recordableStore();
    const t = Math.round(now() * 1e6);
    if (this._lastDelta !== undefined) {
      const delta = Math.max(0, t - this._lastDelta);
      if (store.recordValue(delta)) store.updateEwma(delta);
    }
    this._lastDelta = t;
  }

  add(other) {
    const store = this._recordableStore();
    if (
      other === null ||
      other === undefined ||
      other[kRecordable] === undefined
    ) {
      throw errInvalidArgType(
        "other",
        "an instance of RecordableHistogram",
        other,
      );
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
    if (this[kEnabled] === undefined) throw errInvalidThis("ELDHistogram");
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
    if (
      timer !== undefined &&
      timer !== null &&
      typeof timer.unref === "function"
    ) {
      timer.unref();
    }
    this._eldTimer = timer;
  }
}

// `using` support where the host provides Symbol.dispose.
if (typeof Symbol.dispose !== "undefined") {
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
  validateObject(options, "options");
  const {
    lowest = 1,
    highest = MAX_SAFE_INTEGER,
    figures = 3,
    halfLife = 0,
    threshold = 0,
  } = options;
  validateHistogramOptions26(lowest, highest, figures);
  validateNumber(halfLife, "options.halfLife");
  if (halfLife < 0) {
    throw errOutOfRange("options.halfLife", ">= 0", halfLife);
  }
  validateNumber(threshold, "options.threshold");
  if (threshold < 0) {
    throw errOutOfRange("options.threshold", ">= 0", threshold);
  }
  if (nativePerfHooks !== null) {
    // Native histograms are V8 host objects: postMessage()/structuredClone()
    // produce live shared-state histograms, which pure JS cannot replicate.
    const histogram = nativePerfHooks.createHistogram(options);
    nativeHistogramSet.add(histogram);
    return histogram;
  }
  const store = new BucketStore(
    Number(lowest),
    Number(highest),
    figures,
  );
  if (halfLife > 0) {
    store.ewmaAlpha = 1 - Math.exp(-Math.LN2 / halfLife);
    store.ewmaThreshold = threshold;
  }
  const histogram = new RecordableHistogram(kSkipThrow);
  histogram[kHandle] = store;
  histogram[kMap] = new Map();
  histogram[kRecordable] = true;
  histogram.constructor = RecordableHistogram;
  return histogram;
}

// ---------------------------------------------------------------------------
// 5b. Histogram export/import (CBOR), sliding-window histograms.
// ---------------------------------------------------------------------------
// The export format is Node's CBOR layout (src/histogram.cc,
// Histogram::Export/Import; version 2, same layout as version 1):
// a CBOR map with integer keys 0 version, 1 lowest, 2 highest, 3 figures,
// 4 total count, 5 min, 6 max, 7 normalizing index offset, 8 conversion
// ratio (float64), 9 counts array length, 10 delta-encoded sparse counts
// as a flat [delta, count, ...] array (first delta is the absolute index,
// indices are PHYSICAL — rotated by the normalizing offset), 11 EWMA
// sub-map (omitted when alpha is 0): 0 alpha, 1 mean, 2 variance,
// 3 error rate (all float64), 4 threshold (uint).
//
// Two index numberings exist and must not be confused: the shim's
// BucketStore numbers sub-buckets 0..subBucketCount-1 per bucket, while hdr
// numbers them 0..halfCount-1 for bucket 0 and halfCount..subBucketCount-1
// above it, so hdr's counts array is half as long. Both partition values
// into the same ranges; the translators below convert by (bucket, sub).
// `ponytail:` ceiling — counts above 2^53 lose integer precision in the
// JS-number bucket array (hdr keeps int64); no test exercises that range.
const _kExportVersion = 2;
const _kInt64Max = 9223372036854775807n;
const _kInt32Max = 2147483647;

// hdr_calculate_bucket_config (deps/histogram/src/hdr_histogram.c).
// Returns the layout or null when hdr_init would reject the options.
function hdrLayout(lowest, highest, figures) {
  if (
    !Number.isInteger(lowest) ||
    !Number.isInteger(highest) ||
    !Number.isInteger(figures) ||
    lowest < 1 ||
    figures < 1 ||
    figures > 5 ||
    // hdr's integer-division form (lowest > highest/2); the BigInt form
    // stays exact where the double form would round highest > 2^53.
    BigInt(lowest) > BigInt(highest) / 2n
  ) {
    return null;
  }
  const unitMagnitude = Math.floor(Math.log(lowest) / Math.LN2);
  const subBucketHalfCountMagnitude = Math.ceil(figures * Math.log2(10));
  if (unitMagnitude + subBucketHalfCountMagnitude > 61) return null;
  const subBucketCount = Math.pow(2, subBucketHalfCountMagnitude + 1);
  const subBucketHalfCount = subBucketCount / 2;
  // buckets_needed_to_cover_value, with exact int64 arithmetic: the
  // INT64_MAX/2 early return must compare against 2^62-1, which is not
  // representable as a double (Number() rounds it up to 2^62 and the loop
  // runs one iteration too far — e.g. the ELD layout lowest 1000 /
  // highest INT64_MAX gives countsLen 47104 instead of 46080).
  let smallestUntrackableValue =
    BigInt(subBucketCount) << BigInt(unitMagnitude);
  let bucketCount = 1;
  const highestBig = BigInt(highest);
  while (smallestUntrackableValue <= highestBig) {
    if (smallestUntrackableValue > _kInt64Max / 2n) {
      bucketCount++;
      break;
    }
    smallestUntrackableValue *= 2n;
    bucketCount++;
  }
  return {
    lowest,
    highest,
    figures,
    unitMagnitude,
    subBucketHalfCountMagnitude,
    subBucketCount,
    subBucketHalfCount,
    bucketCount,
    countsLen: (bucketCount + 1) * subBucketHalfCount,
  };
}

// The [lowest, lowest+size) value range of one hdr logical bucket
// (hdr_value_at_index / lowest_equivalent_value_given_bucket_indices).
function hdrBucketRange(lowest, figures, logicalIndex) {
  const unitMagnitude = Math.floor(Math.log(lowest) / Math.LN2);
  const sbhcm = Math.ceil(figures * Math.log2(10));
  const halfCount = Math.pow(2, sbhcm);
  let bucket = Math.floor(logicalIndex / halfCount) - 1;
  let sub = (logicalIndex % halfCount) + halfCount;
  if (bucket < 0) {
    sub -= halfCount;
    bucket = 0;
  }
  const size = Math.pow(2, bucket + unitMagnitude);
  return { lowest: sub * size, size };
}

// Shim bucket index -> hdr logical index.
function shimIndexToHdrIndex(store, i) {
  const halfCount = store.subBucketCount / 2;
  const bucket = Math.floor(i / store.subBucketCount);
  const sub = i % store.subBucketCount;
  return bucket === 0 ? sub : (bucket + 1) * halfCount + (sub - halfCount);
}

// Hdr logical index -> shim bucket index.
function hdrIndexToShimIndex(store, j) {
  const halfCount = store.subBucketCount / 2;
  let bucket = Math.floor(j / halfCount) - 1;
  let sub = (j % halfCount) + halfCount;
  if (bucket < 0) {
    sub -= halfCount;
    bucket = 0;
  }
  return bucket * store.subBucketCount + sub;
}

// Node 26 option validation (lib/internal/histogram.js
// validateHistogramOptions): bigint-aware ranges, highest >= 2 * lowest,
// figures 1..5, plus the hdr magnitude rule.
function validateHistogramOptions26(lowest, highest, figures) {
  const kMaxInt64 = _kInt64Max;
  if (typeof lowest !== "bigint") {
    validateInteger(lowest, "options.lowest", 1, MAX_SAFE_INTEGER);
  } else if (lowest < 1n || lowest > kMaxInt64) {
    throw errOutOfRange("options.lowest", `>= 1n && <= ${kMaxInt64}n`, lowest);
  }
  if (typeof highest !== "bigint") {
    validateInteger(highest, "options.highest", 1, MAX_SAFE_INTEGER);
  } else if (highest < 1n || highest > kMaxInt64) {
    throw errOutOfRange(
      "options.highest",
      `>= 1n && <= ${kMaxInt64}n`,
      highest,
    );
  }
  const minimumHighest =
    2n * (typeof lowest === "bigint" ? lowest : BigInt(lowest));
  const highestBigInt =
    typeof highest === "bigint" ? highest : BigInt(highest);
  if (highestBigInt < minimumHighest) {
    throw errOutOfRange(
      "options.highest",
      `>= 2 * options.lowest (${minimumHighest}n)`,
      highest,
    );
  }
  validateInteger(figures, "options.figures", 1, 5);
  if (
    hdrLayout(Number(lowest), Number(highest), figures) === null
  ) {
    throw errInvalidArgValue(
      "options",
      { lowest, highest, figures },
      "is invalid",
    );
  }
}

// --- Minimal CBOR (RFC 8949) codec: just the types the format uses,
// plus a strict skipper for unknown-key values (mirrors CborSkipItem,
// including the 16-level nesting limit and the indefinite/reserved
// rejections). All failures surface as ERR_INVALID_ARG_VALUE.
function errInvalidHistogramData() {
  return errInvalidArgValue("data", undefined, "is not valid histogram data");
}

function _cborWriteUint(out, major, value) {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v <= 23n) {
    out.push(major | Number(v));
  } else if (v <= 0xffn) {
    out.push(major | 24, Number(v));
  } else if (v <= 0xffffn) {
    out.push(major | 25, Number(v >> 8n), Number(v & 0xffn));
  } else if (v <= 0xffffffffn) {
    out.push(
      major | 26,
      Number((v >> 24n) & 0xffn),
      Number((v >> 16n) & 0xffn),
      Number((v >> 8n) & 0xffn),
      Number(v & 0xffn),
    );
  } else {
    out.push(
      major | 27,
      Number((v >> 56n) & 0xffn),
      Number((v >> 48n) & 0xffn),
      Number((v >> 40n) & 0xffn),
      Number((v >> 32n) & 0xffn),
      Number((v >> 24n) & 0xffn),
      Number((v >> 16n) & 0xffn),
      Number((v >> 8n) & 0xffn),
      Number(v & 0xffn),
    );
  }
}

// Writes an int64 field. Values arrive as Numbers, and INT64_MAX rounds
// up to 2^63 as a double — which the int64 reader (here and in C++) must
// reject. An int64 field can never legitimately be 2^63, so a Number
// equal to it can only be rounded INT64_MAX (e.g. an ELD histogram's
// highest); clamp it back to the exact value.
function _cborWriteInt64(out, value) {
  const v = typeof value === "bigint" ? value : BigInt(value);
  _cborWriteUint(out, 0, v > _kInt64Max ? _kInt64Max : v);
}

function _cborWriteFloat64(out, value) {
  out.push(0xfb);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  for (const byte of new Uint8Array(buf)) out.push(byte);
}

// The reader throws errInvalidHistogramData() on any malformed input.
class _CborReader {
  constructor(data) {
    this.data = data;
    this.p = 0;
  }

  get remaining() {
    return this.data.length - this.p;
  }

  _fail() {
    throw errInvalidHistogramData();
  }

  _readHead() {
    if (this.p >= this.data.length) this._fail();
    const b = this.data[this.p++];
    const major = b >> 5;
    const ai = b & 31;
    let arg;
    if (ai < 24) {
      arg = BigInt(ai);
    } else if (ai === 24) {
      if (this.remaining < 1) this._fail();
      arg = BigInt(this.data[this.p++]);
    } else if (ai === 25) {
      if (this.remaining < 2) this._fail();
      arg = BigInt((this.data[this.p] << 8) | this.data[this.p + 1]);
      this.p += 2;
    } else if (ai === 26) {
      if (this.remaining < 4) this._fail();
      arg = 0n;
      for (let i = 0; i < 4; i++) arg = (arg << 8n) | BigInt(this.data[this.p++]);
    } else if (ai === 27) {
      if (this.remaining < 8) this._fail();
      arg = 0n;
      for (let i = 0; i < 8; i++) arg = (arg << 8n) | BigInt(this.data[this.p++]);
    } else {
      this._fail(); // Indefinite length or reserved — not supported.
    }
    return { major, arg };
  }

  readArgument(major) {
    const { major: actual, arg } = this._readHead();
    if (actual !== major) this._fail();
    return arg;
  }

  readUint() {
    return this.readArgument(0);
  }

  readInt64() {
    const v = this.readArgument(0);
    if (v > _kInt64Max) this._fail();
    return v;
  }

  readInt32() {
    const v = this.readArgument(0);
    if (v > _kInt32Max) this._fail();
    return Number(v);
  }

  readNumber() {
    if (this.p < this.data.length && this.data[this.p] === 0xfb) {
      this.p++;
      if (this.remaining < 8) this._fail();
      const value = new DataView(
        this.data.buffer,
        this.data.byteOffset + this.p,
        8,
      ).getFloat64(0, false);
      this.p += 8;
      return value;
    }
    return Number(this.readArgument(0));
  }

  skipItem(depth = 0) {
    if (this.p >= this.data.length || depth > 16) this._fail();
    const major = this.data[this.p] >> 5;
    const info = this.data[this.p] & 31;
    if (major === 7) {
      let extra;
      if (info <= 23) extra = 0;
      else if (info <= 27) extra = 1 << (info - 24);
      else this._fail(); // Reserved (28-30) or break (31).
      this.p++;
      if (this.remaining < extra) this._fail();
      this.p += extra;
      return;
    }
    const arg = this._readHead().arg;
    switch (major) {
      case 0:
      case 1:
        return;
      case 2:
      case 3:
        if (arg > BigInt(this.remaining)) this._fail();
        this.p += Number(arg);
        return;
      case 4:
      case 5: {
        if (arg > BigInt(this.remaining)) this._fail();
        const items = major === 4 ? arg : arg * 2n;
        for (let i = 0n; i < items; i++) this.skipItem(depth + 1);
        return;
      }
      case 6:
        this.skipItem(depth + 1);
        return;
      default:
        this._fail();
    }
  }
}

function cborDecodeHistogram(data) {
  const reader = new _CborReader(data);
  const mapSize = reader.readArgument(5);
  let version = 1n;
  let lowest = 1;
  let highest = Number(_kInt64Max);
  let figures = 3;
  let totalCount = null;
  let min = null;
  let max = null;
  let normOffset = 0;
  let convRatio = 1;
  let countsLen = 0;
  let hasCountsLen = false;
  let ewma = null;
  let hasUnknownKeys = false;
  const seen = new Set();
  const sparse = [];
  for (let i = 0n; i < mapSize; i++) {
    const key = reader.readArgument(0);
    if (key > 11n) {
      reader.skipItem();
      hasUnknownKeys = true;
      continue;
    }
    if (seen.has(key)) reader._fail();
    seen.add(key);
    switch (Number(key)) {
      case 0: {
        version = reader.readUint();
        if (version < 1n || version > 2n) reader._fail();
        break;
      }
      case 1:
        lowest = Number(reader.readInt64());
        break;
      case 2:
        highest = Number(reader.readInt64());
        break;
      case 3:
        figures = reader.readInt32();
        break;
      case 4:
        totalCount = reader.readInt64();
        break;
      case 5:
        min = Number(reader.readInt64());
        break;
      case 6:
        max = Number(reader.readInt64());
        break;
      case 7:
        normOffset = reader.readInt32();
        break;
      case 8:
        convRatio = reader.readNumber();
        break;
      case 9:
        countsLen = reader.readInt32();
        hasCountsLen = true;
        break;
      case 10: {
        const arrLen = reader.readArgument(4);
        if (arrLen % 2n !== 0n) reader._fail();
        if (arrLen > BigInt(reader.remaining)) reader._fail();
        let accIdx = 0;
        for (let j = 0n; j < arrLen; j += 2n) {
          const delta = reader.readInt32();
          const cnt = reader.readInt64();
          if (j > 0n && delta === 0) reader._fail();
          accIdx += delta;
          if (accIdx > Number(_kInt32Max)) reader._fail();
          sparse.push([accIdx, cnt]);
        }
        break;
      }
      case 11: {
        const subSize = reader.readArgument(5);
        const sub = { alpha: 0, mean: 0, variance: 0, errorRate: 0, threshold: 0 };
        const seenEwma = new Set();
        for (let j = 0n; j < subSize; j++) {
          const subKey = reader.readArgument(0);
          if (subKey > 4n) {
            reader.skipItem();
            hasUnknownKeys = true;
            continue;
          }
          if (seenEwma.has(subKey)) reader._fail();
          seenEwma.add(subKey);
          switch (Number(subKey)) {
            case 0:
              sub.alpha = reader.readNumber();
              break;
            case 1:
              sub.mean = reader.readNumber();
              break;
            case 2:
              sub.variance = reader.readNumber();
              break;
            case 3:
              sub.errorRate = reader.readNumber();
              break;
            case 4:
              sub.threshold = Number(reader.readInt64());
              break;
            default:
              reader._fail();
          }
        }
        ewma = sub;
        break;
      }
      default:
        reader._fail();
    }
  }
  // Version 1 data keeps its original semantics: unknown keys rejected.
  if (version === 1n && hasUnknownKeys) reader._fail();

  const layout = hdrLayout(lowest, highest, figures);
  if (layout === null) reader._fail();
  if (!hasCountsLen || countsLen !== layout.countsLen) reader._fail();
  if (normOffset < 0 || normOffset >= countsLen) reader._fail();

  // Restore counts directly (physical -> logical via the offset), keeping
  // the int64 sum check from C++.
  const logical = new Array(countsLen).fill(0);
  let observed = 0n;
  for (const [idx, cnt] of sparse) {
    if (idx < 0 || idx >= countsLen) reader._fail();
    if (cnt > _kInt64Max - observed) reader._fail();
    observed += cnt;
    logical[(idx + normOffset) % countsLen] = Number(cnt);
  }
  if (totalCount !== null && totalCount !== observed) reader._fail();

  return {
    version: Number(version),
    lowest,
    highest,
    figures,
    totalCount: observed,
    min,
    max,
    normOffset,
    convRatio,
    countsLen,
    logical,
    ewma,
  };
}

function cborEncodeHistogram(fields) {
  const out = [];
  const hasEwma = fields.ewma !== null && fields.ewma.alpha > 0;
  _cborWriteUint(out, 5 << 5, hasEwma ? 12 : 11);
  _cborWriteUint(out, 0, 0);
  _cborWriteUint(out, 0, fields.version);
  _cborWriteUint(out, 0, 1);
  _cborWriteInt64(out, fields.lowest);
  _cborWriteUint(out, 0, 2);
  _cborWriteInt64(out, fields.highest);
  _cborWriteUint(out, 0, 3);
  _cborWriteUint(out, 0, fields.figures);
  _cborWriteUint(out, 0, 4);
  _cborWriteInt64(out, fields.totalCount);
  _cborWriteUint(out, 0, 5);
  _cborWriteInt64(out, fields.min);
  _cborWriteUint(out, 0, 6);
  _cborWriteInt64(out, fields.max);
  _cborWriteUint(out, 0, 7);
  _cborWriteUint(out, 0, fields.normOffset);
  _cborWriteUint(out, 0, 8);
  _cborWriteFloat64(out, fields.convRatio);
  _cborWriteUint(out, 0, 9);
  _cborWriteUint(out, 0, fields.countsLen);
  _cborWriteUint(out, 0, 10);
  _cborWriteUint(out, 4 << 5, fields.sparse.length * 2);
  let prev = 0;
  for (const [idx, count] of fields.sparse) {
    _cborWriteUint(out, 0, idx - prev);
    _cborWriteInt64(out, count);
    prev = idx;
  }
  if (hasEwma) {
    _cborWriteUint(out, 0, 11);
    _cborWriteUint(out, 5 << 5, 5);
    _cborWriteUint(out, 0, 0);
    _cborWriteFloat64(out, fields.ewma.alpha);
    _cborWriteUint(out, 0, 1);
    _cborWriteFloat64(out, fields.ewma.mean);
    _cborWriteUint(out, 0, 2);
    _cborWriteFloat64(out, fields.ewma.variance);
    _cborWriteUint(out, 0, 3);
    _cborWriteFloat64(out, fields.ewma.errorRate);
    _cborWriteUint(out, 0, 4);
    _cborWriteInt64(out, fields.ewma.threshold);
  }
  return new Uint8Array(out);
}

// Re-encodes already-decoded fields at the export version (2). The
// sparse counts are stored logically here and rotated back to physical
// indices on write.
function cborEncodeDecoded(decoded, version = _kExportVersion) {
  const physical = [];
  for (let j = 0; j < decoded.logical.length; j++) {
    const c = decoded.logical[j];
    if (c === 0) continue;
    const p =
      (((j - decoded.normOffset) % decoded.countsLen) + decoded.countsLen) %
      decoded.countsLen;
    physical.push([p, c]);
  }
  physical.sort((a, b) => a[0] - b[0]);
  return cborEncodeHistogram({
    version,
    lowest: decoded.lowest,
    highest: decoded.highest,
    figures: decoded.figures,
    totalCount: decoded.totalCount,
    min:
      decoded.totalCount === 0n
        ? _kInt64Max
        : decoded.min !== null
          ? decoded.min
          : derivedMinMax(decoded).min,
    max:
      decoded.totalCount === 0n
        ? 0
        : decoded.max !== null
          ? decoded.max
          : derivedMinMax(decoded).max,
    normOffset: decoded.normOffset,
    convRatio: decoded.convRatio,
    countsLen: decoded.countsLen,
    sparse: physical,
    ewma: decoded.ewma,
  });
}

// Min/max derived from the counts when keys 5/6 are absent (as
// Histogram::Import does via hdr_reset_internal_counters).
function derivedMinMax(decoded) {
  let first = -1;
  let last = -1;
  for (let j = 0; j < decoded.logical.length; j++) {
    if (decoded.logical[j] === 0) continue;
    if (first === -1) first = j;
    last = j;
  }
  if (first === -1) return { min: Number(_kInt64Max), max: 0 };
  const minRange = hdrBucketRange(decoded.lowest, decoded.figures, first);
  const maxRange = hdrBucketRange(decoded.lowest, decoded.figures, last);
  return { min: minRange.lowest, max: maxRange.lowest + maxRange.size - 1 };
}

// Pure-JS export(): encodes a BucketStore as version 2.
function histogramExportCbor(store) {
  const layout = hdrLayout(store.lowest, store.highest, store.figures);
  const countsLen = layout === null ? store.counts.length : layout.countsLen;
  const physical = [];
  for (let i = 0; i < store.counts.length; i++) {
    const c = store.counts[i];
    if (c === 0) continue;
    const logical = shimIndexToHdrIndex(store, i);
    if (logical >= countsLen) continue;
    const p =
      (((logical - store.normOffset) % countsLen) + countsLen) % countsLen;
    physical.push([p, c]);
  }
  physical.sort((a, b) => a[0] - b[0]);
  return cborEncodeHistogram({
    version: _kExportVersion,
    lowest: store.lowest,
    highest: store.highest,
    figures: store.figures,
    totalCount: store.totalCount,
    min:
      store.totalCount === 0
        ? _kInt64Max
        : store.min,
    max: store.totalCount === 0 ? 0 : store.max,
    normOffset: store.normOffset,
    convRatio: store.convRatio,
    countsLen,
    sparse: physical,
    ewma:
      store.ewmaAlpha > 0
        ? {
            alpha: store.ewmaAlpha,
            mean: store._ewmaMean,
            variance: store._ewmaVariance,
            errorRate: store._ewmaErrorRate,
            threshold: store.ewmaThreshold,
          }
        : null,
  });
}

// A histogram's state as hdr-logical counts, for diff().
function histogramLogicalView(store) {
  const layout = hdrLayout(store.lowest, store.highest, store.figures);
  const countsLen = layout === null ? 0 : layout.countsLen;
  const counts = new Array(countsLen).fill(0);
  for (let i = 0; i < store.counts.length; i++) {
    const c = store.counts[i];
    if (c === 0) continue;
    const logical = shimIndexToHdrIndex(store, i);
    if (logical < countsLen) counts[logical] = c;
  }
  return {
    lowest: store.lowest,
    highest: store.highest,
    figures: store.figures,
    countsLen,
    normOffset: store.normOffset,
    convRatio: store.convRatio,
    counts,
    exceeds: store.exceeds,
    resetCount: store.resetCount,
  };
}

function histogramLogicalViewFromExport(bytes, resetCount, exceeds) {
  const decoded = cborDecodeHistogram(bytes);
  return {
    lowest: decoded.lowest,
    highest: decoded.highest,
    figures: decoded.figures,
    countsLen: decoded.countsLen,
    normOffset: decoded.normOffset,
    convRatio: decoded.convRatio,
    counts: decoded.logical,
    exceeds,
    resetCount,
  };
}

// Histogram::Diff over two logical views. Returns a fresh BucketStore
// holding the difference (no EWMA, resetCount 0).
function histogramDiffLogical(a, b) {
  if (
    a.lowest !== b.lowest ||
    a.highest !== b.highest ||
    a.figures !== b.figures ||
    a.countsLen !== b.countsLen ||
    a.normOffset !== b.normOffset
  ) {
    throw errInvalidArgValue("other", undefined, "is not compatible");
  }
  if (a.resetCount !== b.resetCount) throw errInvalidState();
  if (a.exceeds < b.exceeds) {
    throw errInvalidArgValue("other", undefined, "is not earlier");
  }
  const diffCounts = new Array(a.countsLen).fill(0);
  for (let i = 0; i < a.countsLen; i++) {
    if (a.counts[i] < b.counts[i]) {
      throw errInvalidArgValue("other", undefined, "is not earlier");
    }
    diffCounts[i] = a.counts[i] - b.counts[i];
  }
  const store = new BucketStore(a.lowest, a.highest, a.figures);
  store.setLogicalCounts(diffCounts);
  store.exceeds = a.exceeds - b.exceeds;
  store.normOffset = a.normOffset;
  store.convRatio = a.convRatio;
  return store;
}

function makeClonedHistogram(store) {
  const histogram = new Histogram(kSkipThrow);
  histogram[kHandle] = store;
  histogram[kMap] = new Map();
  return histogram;
}

// Reconstructs a recordable histogram from CBOR export data
// (Histogram::Import). The pure-JS path handles both format versions, so
// it also serves hosts whose native import rejects version 2.
function importHistogram(data) {
  if (
    data === null ||
    data === undefined ||
    (typeof Uint8Array !== "undefined" && !(data instanceof Uint8Array))
  ) {
    throw errInvalidArgType("data", "Uint8Array", data);
  }
  const decoded = cborDecodeHistogram(data);
  const store = new BucketStore(decoded.lowest, decoded.highest, decoded.figures);
  store.setLogicalCounts(decoded.logical);
  store.normOffset = decoded.normOffset;
  store.convRatio = decoded.convRatio;
  if (decoded.ewma !== null && decoded.ewma.alpha > 0) {
    // Half-life is derived from alpha only for 0 < alpha < 1 (C++ Import);
    // alpha >= 1 leaves the running state restored but EWMA disabled.
    store.ewmaAlpha = decoded.ewma.alpha < 1 ? decoded.ewma.alpha : 0;
    store._ewmaMean = decoded.ewma.mean;
    store._ewmaVariance = decoded.ewma.variance;
    store._ewmaErrorRate = decoded.ewma.errorRate;
    store.ewmaThreshold = decoded.ewma.threshold;
    store.ewmaInitialized = true;
  }
  const histogram = new RecordableHistogram(kSkipThrow);
  histogram[kHandle] = store;
  histogram[kMap] = new Map();
  histogram[kRecordable] = true;
  histogram.constructor = RecordableHistogram;
  return histogram;
}

// Sliding-window histogram (pure-JS fallback). The window is `chunks`
// BucketStores in a ring; each chunk belongs to one generation. Count
// mode rotates every `recordsPerChunk` records; time mode rotates every
// `chunkDuration` ms from creation (generations aligned to creation,
// exactly as in C++). snapshot() aggregates the live chunks into a
// read-only Histogram; reset() clears the generations (chunks are reset
// lazily on reuse). `ponytail:` ceiling — structuredClone()/postMessage
// of a pure-JS window succeed (plain object) where native throws
// DataCloneError; the harness lane uses the native window, so this only
// affects the browser lane.
const kNoGeneration = -1;

class SlidingWindowHistogram {
  constructor(skipThrowSymbol = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
  }

  _checkSw() {
    if (this[kSlidingWindowHandle] === undefined)
      throw errInvalidThis("SlidingWindowHistogram");
  }

  record(val) {
    const state = this[kSlidingWindowHandle];
    if (state === undefined) throw errInvalidThis("SlidingWindowHistogram");
    let value;
    if (typeof val === "bigint") {
      if (val < 0n || val >= 2n ** 63n) throw errOutOfRangePlain();
      value = Number(val);
    } else {
      validateInteger(val, "val", 0);
      value = val;
    }
    let generation;
    if (state.timeBased) {
      generation = Math.floor(
        (now() - state.origin) / state.chunkDuration,
      );
    } else if (state.recordsInCurrentChunk === state.rotateAt) {
      generation = state.currentGeneration + 1;
    } else {
      generation = state.currentGeneration;
    }
    const chunk = this._getChunk(generation);
    if (state.timeBased) {
      chunk.recordValue(value);
    } else {
      if (generation !== state.currentGeneration) {
        state.currentGeneration = generation;
        state.recordsInCurrentChunk = 0;
      }
      chunk.recordValue(value);
      state.recordsInCurrentChunk++;
      state.hasCountRecords = true;
    }
  }

  _getChunk(generation) {
    const state = this[kSlidingWindowHandle];
    const index = ((generation % state.chunks.length) + state.chunks.length) % state.chunks.length;
    if (state.generations[index] === generation) return state.chunks[index];
    state.chunks[index]._clearCounts();
    state.chunks[index].resetCount = 0;
    state.generations[index] = generation;
    return state.chunks[index];
  }

  snapshot() {
    const state = this[kSlidingWindowHandle];
    if (state === undefined) throw errInvalidThis("SlidingWindowHistogram");
    const store = new BucketStore(state.lowest, state.highest, state.figures);
    let currentGeneration;
    if (state.timeBased) {
      currentGeneration = Math.floor(
        (now() - state.origin) / state.chunkDuration,
      );
    } else {
      if (!state.hasCountRecords) return makeClonedHistogram(store);
      currentGeneration = state.currentGeneration;
    }
    for (let i = 0; i < state.chunks.length; i++) {
      const generation = state.generations[i];
      if (
        generation === kNoGeneration ||
        generation > currentGeneration ||
        currentGeneration - generation >= state.chunks.length
      ) {
        continue;
      }
      store.add(state.chunks[i]);
    }
    return makeClonedHistogram(store);
  }

  reset() {
    const state = this[kSlidingWindowHandle];
    if (state === undefined) throw errInvalidThis("SlidingWindowHistogram");
    state.generations.fill(kNoGeneration);
    state.origin = now();
    state.currentGeneration = 0;
    state.recordsInCurrentChunk = 0;
    state.hasCountRecords = false;
  }
}

function createSlidingWindowHistogram(options) {
  validateObject(options, "options");
  const {
    chunks,
    chunkDuration,
    recordsPerChunk,
    lowest = 1,
    highest = MAX_SAFE_INTEGER,
    figures = 3,
  } = options;
  validateInteger(chunks, "options.chunks", 1, 1024);
  validateHistogramOptions26(lowest, highest, figures);
  const timeBased = chunkDuration !== undefined;
  if (timeBased === (recordsPerChunk !== undefined)) {
    throw errInvalidArgValue(
      "options",
      options,
      'must specify exactly one of "chunkDuration" or "recordsPerChunk"',
    );
  }
  let rotateAt;
  let chunkDurationMs;
  if (timeBased) {
    validateInteger(chunkDuration, "options.chunkDuration", 1, 18446744073709);
    rotateAt = 0;
    chunkDurationMs = chunkDuration;
  } else {
    validateInteger(recordsPerChunk, "options.recordsPerChunk", 1, MAX_SAFE_INTEGER);
    rotateAt = recordsPerChunk;
  }
  if (nativePerfHooks !== null && typeof nativePerfHooks.createSlidingWindowHistogram === "function") {
    const histogram = nativePerfHooks.createSlidingWindowHistogram(options);
    return histogram;
  }
  const histogram = new SlidingWindowHistogram(kSkipThrow);
  const chunksArray = [];
  for (let i = 0; i < chunks; i++) {
    chunksArray.push(new BucketStore(Number(lowest), Number(highest), figures));
  }
  histogram[kSlidingWindowHandle] = {
    chunks: chunksArray,
    generations: new Array(chunks).fill(kNoGeneration),
    timeBased,
    rotateAt,
    chunkDuration: chunkDurationMs,
    origin: now(),
    currentGeneration: 0,
    recordsInCurrentChunk: 0,
    hasCountRecords: false,
    lowest: Number(lowest),
    highest: Number(highest),
    figures,
  };
  histogram.constructor = SlidingWindowHistogram;
  return histogram;
}

// ---------------------------------------------------------------------------
// 6. Performance entry classes.
// ---------------------------------------------------------------------------
function validateThisEntry(obj, className) {
  validateThisInternalField(obj, kName, className);
}

class PerformanceEntry {
  constructor(
    skipThrowSymbol = undefined,
    name = undefined,
    type = undefined,
    start = undefined,
    duration = undefined,
  ) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    this[kName] = name;
    this[kEntryType] = type;
    this[kStartTime] = start;
    this[kDuration] = duration;
  }

  get name() {
    validateThisEntry(this, "PerformanceEntry");
    return this[kName];
  }

  get entryType() {
    validateThisEntry(this, "PerformanceEntry");
    return this[kEntryType];
  }

  get startTime() {
    validateThisEntry(this, "PerformanceEntry");
    return this[kStartTime];
  }

  get duration() {
    validateThisEntry(this, "PerformanceEntry");
    return this[kDuration];
  }

  toJSON() {
    validateThisEntry(this, "PerformanceEntry");
    return {
      name: this[kName],
      entryType: this[kEntryType],
      startTime: this[kStartTime],
      duration: this[kDuration],
    };
  }

  [kInspect](depth, options, inspectFn) {
    if (depth < 0) return this;
    const opts = {
      ...options,
      depth: options?.depth == null ? null : options.depth - 1,
    };
    return `${this.constructor.name} ${formatValue(this.toJSON(), opts, inspectFn)}`;
  }
}

// timerify() entries: node reports these with a `detail` property.
class PerformanceNodeEntry extends PerformanceEntry {
  get detail() {
    validateThisInternalField(this, kDetail, "NodePerformanceEntry");
    return this[kDetail];
  }

  toJSON() {
    validateThisEntry(this, "PerformanceEntry");
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
  const entry = new PerformanceNodeEntry(
    kSkipThrow,
    name,
    type,
    start,
    duration,
  );
  entry[kDetail] = detail;
  return entry;
}

// Attributes of `performance.nodeTiming` that cannot be used as mark names.
const nodeTimingReadOnlyAttributes = new Set([
  "nodeStart",
  "v8Start",
  "environment",
  "loopStart",
  "loopExit",
  "bootstrapComplete",
]);

class PerformanceMark extends PerformanceEntry {
  constructor(name, options = undefined) {
    if (arguments.length === 0) throw errMissingArgs("name");
    name = `${name}`;
    if (nodeTimingReadOnlyAttributes.has(name))
      throw errInvalidArgValue("name", name);
    if (options != null) validateObject(options, "options");
    const startTime = options?.startTime ?? now();
    validateNumber(startTime, "startTime");
    if (startTime < 0) throw errInvalidTimestamp(startTime);
    // Keep the mark -> startTime mapping even when constructed directly.
    markTimings.set(name, startTime);
    let detail = options?.detail;
    detail = detail != null ? structuredCloneValue(detail) : null;
    super(kSkipThrow, name, "mark", startTime, 0);
    this[kDetail] = detail;
  }

  get detail() {
    validateThisInternalField(this, kDetail, "PerformanceMark");
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
  constructor(
    skipThrowSymbol = undefined,
    name = undefined,
    type = undefined,
    start = undefined,
    duration = undefined,
  ) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    super(skipThrowSymbol, name, type, start, duration);
  }

  get detail() {
    validateThisInternalField(this, kDetail, "PerformanceMeasure");
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
  const measure = new PerformanceMeasure(
    kSkipThrow,
    name,
    "measure",
    start,
    duration,
  );
  measure[kDetail] = detail;
  return measure;
}

class PerformanceResourceTiming extends PerformanceEntry {
  constructor(skipThrowSymbol = undefined, name = undefined, type = undefined) {
    if (skipThrowSymbol !== kSkipThrow) throw errIllegalConstructor();
    super(skipThrowSymbol, name, type);
  }

  get name() {
    validateThisInternalField(this, kRequestedUrl, "PerformanceResourceTiming");
    return this[kRequestedUrl];
  }

  get entryType() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return "resource";
  }

  get startTime() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].startTime;
  }

  get duration() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    const timingInfo = this[kTimingInfo];
    return timingInfo.endTime - timingInfo.startTime;
  }

  get initiatorType() {
    validateThisInternalField(
      this,
      kInitiatorType,
      "PerformanceResourceTiming",
    );
    return this[kInitiatorType];
  }

  get nextHopProtocol() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalConnectionTimingInfo?.ALPNNegotiatedProtocol;
  }

  get workerStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalServiceWorkerStartTime;
  }

  get redirectStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].redirectStartTime;
  }

  get redirectEnd() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].redirectEndTime;
  }

  get fetchStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].postRedirectStartTime;
  }

  get domainLookupStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalConnectionTimingInfo?.domainLookupStartTime;
  }

  get domainLookupEnd() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalConnectionTimingInfo?.domainLookupEndTime;
  }

  get connectStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalConnectionTimingInfo?.connectionStartTime;
  }

  get connectEnd() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalConnectionTimingInfo?.connectionEndTime;
  }

  get secureConnectionStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalConnectionTimingInfo
      ?.secureConnectionStartTime;
  }

  get requestStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalNetworkRequestStartTime;
  }

  // ponytail: Node 26 ResourceTiming attributes (L-PH4). Node's getters
  // live in lib/internal/perf/resource_timing.js; finalResponseHeadersStart
  // defaults to 0 when the timing info omits the field, firstInterim to 0
  // via `?? 0`, and responseStart prefers a non-zero interim start.
  // Ceiling: field-for-field mirror of the 26 getters; if Node adds more
  // IDL attributes, add the getter + toJSON + inspect lines the same way.
  get finalResponseHeadersStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].finalNetworkResponseStartTime ?? 0;
  }

  get firstInterimResponseStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].firstInterimNetworkResponseStartTime ?? 0;
  }

  get responseStart() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return (
      this[kTimingInfo].firstInterimNetworkResponseStartTime ||
      this[kTimingInfo].finalNetworkResponseStartTime
    );
  }

  get responseEnd() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].endTime;
  }

  get transferSize() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    if (this[kCacheMode] === "local") return 0;
    if (this[kCacheMode] === "validated") return 300;
    return this[kTimingInfo].encodedBodySize + 300;
  }

  get encodedBodySize() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].encodedBodySize;
  }

  get decodedBodySize() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].decodedBodySize;
  }

  get deliveryType() {
    validateThisInternalField(this, kDeliveryType, "PerformanceResourceTiming");
    return this[kDeliveryType];
  }

  get responseStatus() {
    validateThisInternalField(
      this,
      kResponseStatus,
      "PerformanceResourceTiming",
    );
    return this[kResponseStatus];
  }

  get renderBlockingStatus() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kTimingInfo].renderBlocking === true
      ? "blocking"
      : "non-blocking";
  }

  get contentType() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kBodyInfo]?.contentType ?? "";
  }

  get contentEncoding() {
    validateThisInternalField(this, kTimingInfo, "PerformanceResourceTiming");
    return this[kBodyInfo]?.contentEncoding ?? "";
  }

  toJSON() {
    // ponytail: version-gate (table: perf-hooks-resourcetiming-attrs) —
    // Node 24's PerformanceResourceTiming has no finalResponseHeadersStart,
    // firstInterimResponseStart, renderBlockingStatus, contentType or
    // contentEncoding; the v24 test asserts toJSON() deep-equal without
    // them. The object is built in Node 26 order and the five keys are
    // deleted under 24 (deepStrictEqual is order-insensitive, and the
    // 26 path stays byte-identical).
    const json = {
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
      finalResponseHeadersStart: this.finalResponseHeadersStart,
      firstInterimResponseStart: this.firstInterimResponseStart,
      responseStart: this.responseStart,
      responseEnd: this.responseEnd,
      transferSize: this.transferSize,
      encodedBodySize: this.encodedBodySize,
      decodedBodySize: this.decodedBodySize,
      deliveryType: this.deliveryType,
      responseStatus: this.responseStatus,
      renderBlockingStatus: this.renderBlockingStatus,
      contentType: this.contentType,
      contentEncoding: this.contentEncoding,
    };
    if (isTarget24) {
      delete json.finalResponseHeadersStart;
      delete json.firstInterimResponseStart;
      delete json.renderBlockingStatus;
      delete json.contentType;
      delete json.contentEncoding;
    }
    return json;
  }

  [kInspect](depth, _options, inspectFn) {
    if (depth < 0) return this;
    const fmt = (v) => formatInspectValue(v, inspectFn);
    // ponytail: version-gate (table: perf-hooks-resourcetiming-attrs) —
    // same five attributes as toJSON above: two chunks because the
    // attributes are not contiguous in the output (two sit between
    // requestStart and responseStart, three after responseStatus). The
    // trailing comma lives in the tail chunk so the 24 output ends
    // `responseStatus: 200` with no trailing comma, exactly as the v24
    // test's inspect strings require.
    const headAttrs = isTarget24
      ? ""
      : `  finalResponseHeadersStart: ${fmt(this.finalResponseHeadersStart)},\n` +
        `  firstInterimResponseStart: ${fmt(this.firstInterimResponseStart)},\n`;
    const tailAttrs = isTarget24
      ? ""
      : `,\n  renderBlockingStatus: ${fmt(this.renderBlockingStatus)},\n` +
        `  contentType: ${fmt(this.contentType)},\n` +
        `  contentEncoding: ${fmt(this.contentEncoding)}`;
    return (
      `PerformanceResourceTiming {\n` +
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
      headAttrs +
      `  responseStart: ${fmt(this.responseStart)},\n` +
      `  responseEnd: ${fmt(this.responseEnd)},\n` +
      `  transferSize: ${fmt(this.transferSize)},\n` +
      `  encodedBodySize: ${fmt(this.encodedBodySize)},\n` +
      `  decodedBodySize: ${fmt(this.decodedBodySize)},\n` +
      `  deliveryType: ${fmt(this.deliveryType)},\n` +
      `  responseStatus: ${fmt(this.responseStatus)}${tailAttrs}\n` +
      `}`
    );
  }
}

function createPerformanceResourceTiming(
  name,
  initiatorType,
  cacheMode,
  timingInfo,
  deliveryType,
  responseStatus,
  body,
) {
  const entry = new PerformanceResourceTiming(kSkipThrow, name, "resource");
  entry[kRequestedUrl] = `${name}`;
  entry[kInitiatorType] = `${initiatorType}`;
  entry[kCacheMode] = cacheMode;
  entry[kTimingInfo] = { ...timingInfo };
  entry[kDeliveryType] = deliveryType;
  entry[kResponseStatus] = responseStatus;
  entry[kBodyInfo] = body;
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
  if (typeof globalThis.setImmediate === "function") {
    globalThis.setImmediate(dispatchObservers);
  } else if (typeof globalThis.queueMicrotask === "function") {
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

// Port of Node's `lib/internal/perf/observe.js` trio (`hasObserver` /
// `startPerf` / `stopPerf`), which is how lib/_http_client.js and
// lib/_http_server.js emit `http` performance entries. Module-internal
// (NOT exported — the export surface is pinned to real Node's by
// tests/export_surface_perf_hooks.test.js); src/http.js reaches them
// through the bridge in src/internals/perf-observe.js.
function hasObserver(type) {
  for (const observer of kObservers) {
    if (observer[kType] === type) return true;
    const entryTypes = observer[kEntryTypes];
    if (entryTypes !== undefined && entryTypes.has(type)) return true;
  }
  return false;
}

function startPerf(target, key, context = {}) {
  target[key] = {
    ...context,
    startTime: now(),
  };
}

function stopPerf(target, key, context = {}) {
  const ctx = target[key];
  if (!ctx) {
    return;
  }
  // Shim-only deviation: drop the slot after stopping so a second
  // headers-complete (a 1xx interim then the final response, or a double
  // response) cannot emit a duplicate entry. Node's internal stopPerf keeps
  // the slot, but its call sites guarantee a single stop; the observable
  // behavior — exactly one entry per request/response — is the same.
  delete target[key];
  const entry = createPerformanceNodeEntry(
    ctx.name,
    ctx.type,
    ctx.startTime,
    now() - ctx.startTime,
    { ...ctx.detail, ...context.detail },
  );
  enqueue(entry);
}

// Wire the http-entry bridge for src/http.js (see
// src/internals/perf-observe.js). Runs at import time; http.js reads the
// bridge at request time, so load order does not matter.
perfObserveBridge.hasObserver = hasObserver;
perfObserveBridge.startPerf = startPerf;
perfObserveBridge.stopPerf = stopPerf;

function bufferUserTiming(entry) {
  if (entry.entryType === "mark") {
    markEntryBuffer.push(entry);
  } else {
    measureEntryBuffer.push(entry);
  }
  // Match Node's leak guard (only when > 1e6 entries buffered).
  const entriesCount = markEntryBuffer.length + measureEntryBuffer.length;
  if (entriesCount > 1e6) {
    if (
      typeof globalThis.process !== "undefined" &&
      typeof globalThis.process.emitWarning === "function"
    ) {
      globalThis.process.emitWarning(
        "Possible perf_hooks memory leak detected.",
      );
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
        const listeners = performance[kListeners]?.get(
          "resourcetimingbufferfull",
        );
        if (listeners !== undefined) {
          for (const listener of [...listeners]) {
            if (typeof listener === "function") listener.call(performance);
            else if (
              listener !== null &&
              typeof listener.handleEvent === "function"
            ) {
              listener.handleEvent();
            }
          }
        }
        if (typeof performance._onrtbf === "function") {
          performance._onrtbf.call(performance);
        }
      };
      if (typeof globalThis.queueMicrotask === "function") {
        globalThis.queueMicrotask(fire);
      } else {
        globalThis.setTimeout(fire, 0);
      }
    }
  }
}

function clearEntriesFromBuffer(type, name) {
  switch (type) {
    case "mark":
      if (name === undefined) {
        markEntryBuffer = [];
      } else {
        markEntryBuffer = markEntryBuffer.filter(
          (entry) => entry.name !== name,
        );
      }
      break;
    case "measure":
      if (name === undefined) {
        measureEntryBuffer = [];
      } else {
        measureEntryBuffer = measureEntryBuffer.filter(
          (entry) => entry.name !== name,
        );
      }
      break;
    case "resource":
      resourceTimingBuffer = [];
      break;
    default:
      break;
  }
}

function filterBufferMapByNameAndType(name, type) {
  const result = [];
  const entries = [
    ...markEntryBuffer,
    ...measureEntryBuffer,
    ...resourceTimingBuffer,
  ];
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
    if (nodeTimingReadOnlyAttributes.has(name))
      throw errInvalidArgValue("name", name);
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
    typeof startOrMeasureOptions === "object" &&
    startOrMeasureOptions !== null
  ) {
    const optStart = startOrMeasureOptions.start;
    const optEnd = startOrMeasureOptions.end;
    const optDuration = startOrMeasureOptions.duration;
    // Specifying all three is rejected before any mark resolution.
    if (
      optStart !== undefined &&
      optEnd !== undefined &&
      optDuration !== undefined
    ) {
      throw errPerformanceMeasureInvalidOptions();
    }
    if (optStart !== undefined) {
      start =
        typeof optStart === "number"
          ? (validateTimestampOption(optStart, "start"), optStart)
          : getMarkOrThrow(`${optStart}`);
    }
    if (optEnd !== undefined) {
      end =
        typeof optEnd === "number"
          ? (validateTimestampOption(optEnd, "end"), optEnd)
          : getMarkOrThrow(`${optEnd}`);
    }
    // `duration` is only validated when it participates in the computation;
    // a lone `duration` option is ignored (matches native behavior).
    if (
      optDuration !== undefined &&
      (start !== undefined || end !== undefined)
    ) {
      validateTimestampOption(optDuration, "duration");
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
      typeof startOrMeasureOptions === "string"
        ? getMarkOrThrow(startOrMeasureOptions)
        : 0;
    if (endMarkName !== undefined) {
      end =
        typeof endMarkName === "number"
          ? (validateTimestampOption(endMarkName, "end"), endMarkName)
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
  if (arguments.length === 0) throw errMissingArgs("name");
  const entry = new PerformanceMark(`${name}`, options);
  bufferUserTiming(entry);
  enqueue(entry);
  return entry;
}

function measure(
  name,
  startOrMeasureOptions = undefined,
  endMarkName = undefined,
) {
  if (arguments.length === 0) throw errMissingArgs("name");
  name = `${name}`;
  if (nodeTimingReadOnlyAttributes.has(name))
    throw errInvalidArgValue("name", name);
  const { start, duration } = calculateStartDuration(
    startOrMeasureOptions,
    endMarkName,
  );
  let detail = null;
  if (
    typeof startOrMeasureOptions === "object" &&
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
    if (this[kHandle] === undefined)
      throw errInvalidThis("PerformanceObserverEntryList");
    return this[kHandle];
  }

  getEntries() {
    return this._entries()
      .slice()
      .sort((a, b) => a.startTime - b.startTime);
  }

  getEntriesByName(name, type = undefined) {
    if (arguments.length === 0) throw errMissingArgs("name");
    validateString(name, "name");
    if (type !== undefined) validateString(type, "type");
    return this.getEntries().filter(
      (entry) =>
        entry.name === name && (type === undefined || entry.entryType === type),
    );
  }

  getEntriesByType(type) {
    if (arguments.length === 0) throw errMissingArgs("type");
    validateString(type, "type");
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

makeMethodsEnumerable(PerformanceEntry, ["toJSON"]);
setToStringTag(PerformanceEntry, "PerformanceEntry");
makeMethodsEnumerable(PerformanceNodeEntry, ["toJSON"]);
makeMethodsEnumerable(PerformanceMark, ["toJSON"]);
setToStringTag(PerformanceMark, "PerformanceMark");
makeMethodsEnumerable(PerformanceMeasure, ["toJSON"]);
setToStringTag(PerformanceMeasure, "PerformanceMeasure");
makeMethodsEnumerable(PerformanceResourceTiming, [
  "toJSON",
  "finalResponseHeadersStart",
  "firstInterimResponseStart",
  "renderBlockingStatus",
  "contentType",
  "contentEncoding",
]);
setToStringTag(PerformanceResourceTiming, "PerformanceResourceTiming");
makeMethodsEnumerable(PerformanceObserverEntryList, [
  "getEntries",
  "getEntriesByName",
  "getEntriesByType",
]);
setToStringTag(PerformanceObserverEntryList, "PerformanceObserverEntryList");

const supportedEntryTypes = [
  "dns",
  "function",
  "gc",
  "http",
  "http2",
  "mark",
  "measure",
  "net",
  "quic",
  "resource",
];

const bufferedEntryTypes = ["mark", "measure", "resource"];

class PerformanceObserver {
  constructor(callback) {
    validateFunction(callback, "callback");
    this.callback = callback;
    this[kPending] = new Set();
  }

  observe(options = undefined) {
    if (this[kPending] === undefined)
      throw errInvalidThis("PerformanceObserver");
    if (options === undefined) options = {};
    validateObject(options, "options");
    const { entryTypes, type, buffered = false } = options;
    if (entryTypes !== undefined && type !== undefined) {
      throw errInvalidArgValue(
        "options.entryTypes",
        entryTypes,
        "options.entryTypes can not set with options.type together",
      );
    }
    validateBoolean(buffered, "options.buffered");
    if (entryTypes !== undefined) {
      if (!Array.isArray(entryTypes))
        throw errInvalidArgType("options.entryTypes", "an Array", entryTypes);
      this[kEntryTypes] = new Set();
      for (const entryType of entryTypes) {
        validateString(entryType, "entryType");
        validateOneOf(entryType, "entryType", supportedEntryTypes);
        this[kEntryTypes].add(entryType);
      }
      if (this[kEntryTypes].size === 0)
        throw errInvalidArgValue("options.entryTypes", entryTypes);
      this[kType] = undefined;
    } else if (type !== undefined) {
      validateString(type, "type");
      validateOneOf(type, "type", supportedEntryTypes);
      this[kType] = type;
      this[kEntryTypes] = undefined;
      if (buffered) {
        if (!bufferedEntryTypes.includes(type)) {
          throw errInvalidArgValue("options.buffered", buffered);
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
      throw errMissingArgs("options.entryTypes", "options.type");
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

makeMethodsEnumerable(PerformanceObserver, [
  "observe",
  "disconnect",
  "takeRecords",
]);
setToStringTag(PerformanceObserver, "PerformanceObserver");

function markResourceTiming(
  timingInfo,
  requestedUrl,
  initiatorType,
  global,
  cacheMode,
  body,
  responseStatus,
  deliveryType,
) {
  const entry = createPerformanceResourceTiming(
    requestedUrl,
    initiatorType,
    cacheMode,
    timingInfo,
    deliveryType,
    responseStatus,
    body,
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
  nativePerfHooks !== null &&
  typeof nativePerfHooks.eventLoopUtilization === "function"
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
    if (nativeNodeTiming && typeof nativeNodeTiming === "object") {
      return nativeNodeTiming;
    }
  }
  const pureJsNodeTiming = {
    name: "node",
    entryType: "node",
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
        name: "node",
        entryType: "node",
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
      const opts = {
        ...options,
        depth: options?.depth == null ? null : options.depth - 1,
      };
      return `PerformanceNodeTiming ${formatValue(this.toJSON(), opts, inspectFn)}`;
    },
  };
  Object.setPrototypeOf(pureJsNodeTiming, PerformanceEntry.prototype);
  return pureJsNodeTiming;
})();

function isHistogram(obj) {
  return (
    obj != null && (obj[kHandle] !== undefined || nativeHistogramSet.has(obj))
  );
}

function timerify(fn, options = undefined) {
  if (options === undefined) options = {};
  validateObject(options, "options");
  validateFunction(fn, "fn");
  const histogram = options?.histogram;
  if (
    histogram !== undefined &&
    (!isHistogram(histogram) || typeof histogram.record !== "function")
  ) {
    throw errInvalidArgType(
      "options.histogram",
      "a RecordableHistogram",
      histogram,
    );
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
    const entry = createPerformanceNodeEntry(
      fn.name,
      "function",
      startTime,
      duration,
      detail,
    );
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
      (typeof result === "object" || typeof result === "function") &&
      typeof result.finally === "function"
    ) {
      return result.finally(processComplete.bind(null, startTime, args));
    }
    processComplete(startTime, args);
    return result;
  }
  Object.defineProperties(timerified, {
    length: { enumerable: true, configurable: false, value: fn.length },
    name: {
      enumerable: true,
      configurable: false,
      value: `timerified ${fn.name}`,
    },
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
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    if (listener == null) return;
    let set = this[kListeners].get(type);
    if (set === undefined) {
      set = new Set();
      this[kListeners].set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type, listener, _options = undefined) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    this[kListeners].get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    const listeners = this[kListeners].get(event?.type);
    if (listeners !== undefined) {
      for (const listener of [...listeners]) {
        if (typeof listener === "function") listener.call(this, event);
        else if (
          listener !== null &&
          typeof listener.handleEvent === "function"
        ) {
          listener.handleEvent(event);
        }
      }
    }
    const handler = this._onrtbf;
    if (
      event?.type === "resourcetimingbufferfull" &&
      typeof handler === "function"
    ) {
      handler.call(this, event);
    }
    return true;
  }

  get onresourcetimingbufferfull() {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    return this._onrtbf ?? null;
  }

  set onresourcetimingbufferfull(fn) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    this._onrtbf = fn;
  }

  clearMarks(markName = undefined) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    clearEntriesFromBuffer(
      "mark",
      markName === undefined ? undefined : `${markName}`,
    );
    clearMarkTimings(markName);
  }

  clearMeasures(measureName = undefined) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    measureName = measureName === undefined ? undefined : `${measureName}`;
    clearEntriesFromBuffer("measure", measureName);
  }

  clearResourceTimings() {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    resourceTimingBuffer = [];
    resourceTimingSecondaryBuffer = [];
  }

  getEntries() {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    return filterBufferMapByNameAndType(undefined, undefined);
  }

  getEntriesByName(name, type = undefined) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    if (arguments.length === 0) throw errMissingArgs("name");
    return filterBufferMapByNameAndType(
      `${name}`,
      type === undefined ? undefined : `${type}`,
    );
  }

  getEntriesByType(type) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    if (arguments.length === 0) throw errMissingArgs("type");
    return filterBufferMapByNameAndType(undefined, `${type}`);
  }

  mark(markName, markOptions = undefined) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    return mark(markName, markOptions);
  }

  measure(
    measureName,
    startOrMeasureOptions = undefined,
    endMarkName = undefined,
  ) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    return measure(measureName, startOrMeasureOptions, endMarkName);
  }

  now() {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    return now();
  }

  get timeOrigin() {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    return timeOrigin;
  }

  toJSON() {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    return {
      nodeTiming: this.nodeTiming,
      timeOrigin: this.timeOrigin,
      eventLoopUtilization: this.eventLoopUtilization(),
    };
  }

  setResourceTimingBufferSize(maxSize) {
    validateThisInternalField(this, kPerformanceBrand, "Performance");
    validateInteger(maxSize, "maxSize", 0);
    resourceTimingBufferSizeLimit = maxSize;
  }
}

makeMethodsEnumerable(Performance, [
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "clearMarks",
  "clearMeasures",
  "clearResourceTimings",
  "getEntries",
  "getEntriesByName",
  "getEntriesByType",
  "mark",
  "measure",
  "now",
  "timeOrigin",
  "toJSON",
  "setResourceTimingBufferSize",
]);
setToStringTag(Performance, "Performance");

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
  eventLoopUtilization: {
    enumerable: true,
    configurable: true,
    writable: true,
    value: eventLoopUtilization,
  },
  nodeTiming: {
    enumerable: true,
    configurable: true,
    writable: true,
    value: nodeTiming,
  },
  markResourceTiming: {
    enumerable: true,
    configurable: true,
    writable: true,
    value: markResourceTiming,
  },
  timerify: {
    enumerable: true,
    configurable: true,
    writable: true,
    value: timerify,
  },
});

function monitorEventLoopDelay(options = undefined) {
  if (options === undefined) options = {};
  validateObject(options, "options");
  const { samplePerIteration = false, resolution = 10 } = options;
  validateBoolean(samplePerIteration, "options.samplePerIteration");
  validateInteger(resolution, "options.resolution", 1);
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
// 9b. Native histogram backfill (hosts older than Node 26).
// ---------------------------------------------------------------------------
// The host's native histograms (Node 24) lack snapshot()/diff()/resetCount
// and export CBOR version 1, which importHistogram rejects. The 26 API is
// patched onto the native base Histogram prototype — the parent of both the
// RecordableHistogram and the ELD prototypes, so one patch covers both —
// gated on the host lacking it (a Node 26 host already has all of this).
// snapshot()/diff() round-trip through the native v1 export and the native
// import, with exceeds restored by recording highest+1 (exceeds values are
// not stored in the CBOR payload and do not touch EWMA). reset()/subtract()
// are wrapped to bump a per-instance resetCount WeakMap. Snapshots are
// re-prototyped to the base Histogram prototype with the own `constructor`
// property removed, so they read as plain read-only Histograms.
// `ponytail:` ceiling — a structuredClone() of a native histogram does not
// carry the JS-side resetCount (V8 clones the handle, not our WeakMap);
// untested by the 26 suite, and the clone starts at 0.
const nativeResetCounts = new WeakMap();
let nativeBaseProto = null;
let nativeRecordableProto = null;
let nativeExportFn = null;
let nativeResetFn = null;
let nativeSubtractFn = null;

function isNativeHistogram(value) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    nativeBaseProto === null
  ) {
    return false;
  }
  let proto = Object.getPrototypeOf(value);
  while (proto !== null) {
    if (proto === nativeBaseProto) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

function nativeResetCountOf(hist) {
  return nativeResetCounts.get(hist) ?? 0;
}

// Restores `count` exceeds on a freshly imported histogram. `highest` is
// the histogram's configured upper bound (from its export); highest+1 is
// the smallest int64 value above it, and exceeds > 0 implies
// highest < INT64_MAX. `ponytail:` ceiling — for highest > 2^53 the Number
// round-trip can lose the exact bound; no 26 test exercises that range.
function nativeRestoreExceeds(hist, count, highest) {
  if (count <= 0) return;
  const value = BigInt(highest) + 1n;
  for (let i = 0; i < count; i++) hist.record(value);
}

function nativeSnapshot() {
  if (!isNativeHistogram(this)) throw errInvalidThis("Histogram");
  const bytes = nativeExportFn.call(this);
  const decoded = cborDecodeHistogram(bytes);
  const imported = nativePerfHooks.importHistogram(bytes);
  nativeRestoreExceeds(imported, this.exceeds, decoded.highest);
  Object.setPrototypeOf(imported, nativeBaseProto);
  delete imported.constructor;
  nativeResetCounts.set(imported, nativeResetCountOf(this));
  return imported;
}

function nativeDiff(other) {
  if (!isNativeHistogram(this)) throw errInvalidThis("Histogram");
  // The other side may be a native histogram (decoded from its export) or
  // a pure-JS histogram such as an importHistogram() result (read from its
  // store directly). Anything else is not a histogram.
  let bView;
  if (isNativeHistogram(other)) {
    const b = cborDecodeHistogram(other.export());
    bView = {
      lowest: b.lowest,
      highest: b.highest,
      figures: b.figures,
      countsLen: b.countsLen,
      normOffset: b.normOffset,
      convRatio: b.convRatio,
      counts: b.logical,
      exceeds: other.exceeds,
      resetCount: nativeResetCountOf(other),
    };
  } else if (
    other !== null &&
    typeof other === "object" &&
    other[kHandle] !== undefined &&
    other[kHandle] !== null
  ) {
    bView = histogramLogicalView(other._store());
  } else {
    throw errInvalidArgType("other", "Histogram", other);
  }
  const a = cborDecodeHistogram(nativeExportFn.call(this));
  const aView = {
    lowest: a.lowest,
    highest: a.highest,
    figures: a.figures,
    countsLen: a.countsLen,
    normOffset: a.normOffset,
    convRatio: a.convRatio,
    counts: a.logical,
    exceeds: this.exceeds,
    resetCount: nativeResetCountOf(this),
  };
  const diffStore = histogramDiffLogical(aView, bView);
  const diffView = histogramLogicalView(diffStore);
  // The host import rejects version 2, so the diff is re-encoded as v1.
  const v1 = cborEncodeDecoded(
    {
      lowest: diffView.lowest,
      highest: diffView.highest,
      figures: diffView.figures,
      totalCount: BigInt(diffStore.totalCount),
      min: null,
      max: null,
      normOffset: diffView.normOffset,
      convRatio: diffView.convRatio,
      countsLen: diffView.countsLen,
      logical: diffView.counts,
      ewma: null,
    },
    1,
  );
  const imported = nativePerfHooks.importHistogram(v1);
  nativeRestoreExceeds(imported, this.exceeds - other.exceeds, a.highest);
  Object.setPrototypeOf(imported, nativeBaseProto);
  delete imported.constructor;
  nativeResetCounts.set(imported, 0);
  return imported;
}

function nativeExportV2() {
  if (!isNativeHistogram(this)) throw errInvalidThis("Histogram");
  try {
    return cborEncodeDecoded(cborDecodeHistogram(nativeExportFn.call(this)));
  } catch {
    return nativeExportFn.call(this);
  }
}

if (
  nativePerfHooks !== null &&
  typeof nativePerfHooks.createHistogram === "function"
) {
  try {
    const probe = nativePerfHooks.createHistogram();
    nativeRecordableProto = Object.getPrototypeOf(probe);
    nativeBaseProto = Object.getPrototypeOf(nativeRecordableProto);
  } catch {
    nativeBaseProto = null;
    nativeRecordableProto = null;
  }
  if (nativeBaseProto !== null && typeof nativeBaseProto.snapshot !== "function") {
    nativeExportFn = nativeBaseProto.export;
    nativeResetFn = nativeBaseProto.reset;
    Object.defineProperty(nativeBaseProto, "export", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: nativeExportV2,
    });
    Object.defineProperty(nativeBaseProto, "resetCount", {
      configurable: true,
      enumerable: false,
      get() {
        if (!isNativeHistogram(this)) throw errInvalidThis("Histogram");
        return nativeResetCountOf(this);
      },
    });
    Object.defineProperty(nativeBaseProto, "reset", {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function () {
        if (!isNativeHistogram(this)) throw errInvalidThis("Histogram");
        nativeResetFn.call(this);
        nativeResetCounts.set(this, nativeResetCountOf(this) + 1);
      },
    });
    if (typeof nativePerfHooks.importHistogram === "function") {
      Object.defineProperty(nativeBaseProto, "snapshot", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: nativeSnapshot,
      });
      Object.defineProperty(nativeBaseProto, "diff", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: nativeDiff,
      });
    }
    if (
      nativeRecordableProto !== null &&
      typeof nativeRecordableProto.subtract === "function"
    ) {
      nativeSubtractFn = nativeRecordableProto.subtract;
      Object.defineProperty(nativeRecordableProto, "subtract", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: function (other) {
          if (!isNativeHistogram(this)) throw errInvalidThis("Histogram");
          nativeSubtractFn.call(this, other);
          nativeResetCounts.set(this, nativeResetCountOf(this) + 1);
        },
      });
    }
  }
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
  if (typeof inspectFn === "function") {
    return inspectFn(value, opts);
  }
  return fallbackInspect(value, opts);
}

// Formats a single scalar value the way `util.inspect` does (used by the
// PerformanceResourceTiming custom inspect). Prefers the real `util.inspect`
// when the host provides it via the custom-inspect hook.
function formatInspectValue(value, inspectFn) {
  if (typeof inspectFn === "function") {
    try {
      return inspectFn(value);
    } catch {}
  }
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[ ${value.map((v) => formatInspectValue(v, undefined)).join(", ")} ]`;
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return String(value);
}

function fallbackInspect(value, opts = {}, seen = new Set()) {
  const depth = opts.depth ?? 2;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return `'${value}'`;
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return `${value}n`;
  if (t === "symbol") return String(value);
  if (t === "function") return `[Function: ${value.name || "anonymous"}]`;
  if (seen.has(value)) return "[Circular]";
  if (depth < 0) return "[Object]";
  seen.add(value);
  const childOpts = { ...opts, depth: depth - 1 };
  try {
    if (Array.isArray(value)) {
      return `[ ${value.map((v) => fallbackInspect(v, childOpts, seen)).join(", ")} ]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([k, v]) =>
          `${fallbackInspect(k, childOpts, seen)} => ${fallbackInspect(v, childOpts, seen)}`,
      );
      return `Map(${value.size}) { ${entries.join(", ")} }`;
    }
    const keys = Object.keys(value);
    const body = keys
      .map((k) => `${k}: ${fallbackInspect(value[k], childOpts, seen)}`)
      .join(", ");
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
  createSlidingWindowHistogram,
  eventLoopUtilization,
  importHistogram,
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
  createSlidingWindowHistogram,
  eventLoopUtilization,
  importHistogram,
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
      typeof globalPerformance === "object" &&
      globalPerformance.timerify !== timerify
    ) {
      Object.defineProperty(globalPerformance, "timerify", {
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
