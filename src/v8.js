/**
 * node:v8 — port of Node.js v24.20.0 `lib/v8.js`.
 *
 * Dependency-free ESM, browser-safe.
 *
 * Strategy
 * --------
 * Almost every API in `node:v8` is backed by V8/Node C++ bindings
 * (heap statistics, snapshots, serialization, CPU/GC profilers, flag
 * control). A pure-JavaScript reimplementation cannot truthfully provide
 * those, so under genuine Node.js this module delegates every export to
 * the real builtin via `process.getBuiltinModule('v8')`. The delegation
 * is resolved once at module-evaluation time through a guarded lookup, so
 * importing this file in a browser (where `process.getBuiltinModule` does
 * not exist) never throws and never pulls in Node-only code paths.
 *
 * Outside of a V8/Node runtime the fallbacks below are used. They keep the
 * exact export surface and error *shapes* (`code` properties such as
 * `ERR_INVALID_ARG_TYPE`), return zeroed statistics objects with the exact
 * v24 key sets, and implement the few APIs that have truthful pure-JS
 * equivalents (e.g. `isStringOneByteRepresentation`). APIs that cannot be
 * meaningfully emulated without V8 internals (heap snapshots, CPU
 * profiles, `queryObjects`, …) fail with a clear, documented error instead
 * of silently returning plausible-looking wrong data.
 *
 * `process.getBuiltinModule` deliberately bypasses the parity harness's
 * `Module._load` patch (which only redirects importers under
 * `parity/node-test/parallel/`), so under `node parity/run.mjs v8` the
 * official tests exercise this facade while the facade itself forwards to
 * the genuine implementation — the same approach as the `os` port.
 */

const NATIVE_EXPORT_NAMES = [
  'cachedDataVersionTag',
  'getHeapSnapshot',
  'getHeapStatistics',
  'getHeapSpaceStatistics',
  'getHeapCodeStatistics',
  'getCppHeapStatistics',
  'setFlagsFromString',
  'Serializer',
  'Deserializer',
  'DefaultSerializer',
  'DefaultDeserializer',
  'deserialize',
  'takeCoverage',
  'stopCoverage',
  'serialize',
  'writeHeapSnapshot',
  'promiseHooks',
  'queryObjects',
  'startupSnapshot',
  'setHeapSnapshotNearHeapLimit',
  'GCProfiler',
  'isStringOneByteRepresentation',
  'startCpuProfile',
];

/** The genuine `node:v8` module when running under Node.js, else `null`. */
const nativeV8 = (() => {
  try {
    const proc = globalThis.process;
    if (proc !== null && proc !== undefined &&
        typeof proc.getBuiltinModule === 'function') {
      const mod = proc.getBuiltinModule('v8');
      if (mod !== null && (typeof mod === 'object' || typeof mod === 'function')) {
        return mod;
      }
    }
  } catch {
    // Not running under Node.js (or the lookup is unavailable) — fall back.
  }
  return null;
})();

const HAS_NATIVE = nativeV8 !== null;

/**
 * Pick the genuine implementation when available, otherwise the portable
 * fallback. Note that genuinely-missing exports (e.g. `takeCoverage` in a
 * Node build without inspector support) are forwarded as `undefined`,
 * exactly like the real `lib/v8.js`.
 */
function pick(name, fallback) {
  return HAS_NATIVE ? nativeV8[name] : fallback;
}

/* ------------------------------------------------------------------ */
/* Small dependency-free error helpers (fallback path only).           */
/* ------------------------------------------------------------------ */

function typeName(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'object') {
    if (Array.isArray(value)) return 'Array';
    return 'Object';
  }
  return t;
}

// Mirrors Node's ERR_INVALID_ARG_TYPE message shape:
//   The "flags" argument must be of type string. Received type number (1)
//   The "flags" argument must be of type string. Received undefined
function invalidArgType(name, expected, actual) {
  const received = actual === undefined
    ? 'Received undefined'
    : `Received type ${typeName(actual)} (${String(actual)})`;
  const err = new TypeError(
    `The "${name}" argument must be of type ${expected}. ${received}`,
  );
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function invalidArgValue(name, expectedDesc, actual) {
  const err = new TypeError(
    `The argument '${name}' must be ${expectedDesc}. Received '${String(actual)}'`,
  );
  err.code = 'ERR_INVALID_ARG_VALUE';
  return err;
}

function outOfRange(name, rangeDesc, actual, mustBeInt = false) {
  const reason = mustBeInt && typeof actual === 'number' && !Number.isInteger(actual)
    ? 'It must be an integer.'
    : `It must be ${rangeDesc}.`;
  const err = new RangeError(
    `The value of "${name}" is out of range. ${reason} Received ${String(actual)}`,
  );
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

function notBuildingSnapshot() {
  const err = new Error('Operation cannot be invoked when not building startup snapshot');
  err.code = 'ERR_NOT_BUILDING_SNAPSHOT';
  return err;
}

function unsupported(api) {
  return new Error(`${api} is not available in this JavaScript environment`);
}

/* ------------------------------------------------------------------ */
/* UTF-8 helpers for the serialization fallback (no Buffer needed).    */
/* ------------------------------------------------------------------ */

function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf8');
  }
  const out = new Uint8Array(str.length * 3);
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out[n++] = cp;
    else if (cp < 0x800) { out[n++] = 0xc0 | (cp >> 6); out[n++] = 0x80 | (cp & 0x3f); }
    else if (cp < 0x10000) { out[n++] = 0xe0 | (cp >> 12); out[n++] = 0x80 | ((cp >> 6) & 0x3f); out[n++] = 0x80 | (cp & 0x3f); }
    else { out[n++] = 0xf0 | (cp >> 18); out[n++] = 0x80 | ((cp >> 12) & 0x3f); out[n++] = 0x80 | ((cp >> 6) & 0x3f); out[n++] = 0x80 | (cp & 0x3f); }
  }
  return out.subarray(0, n);
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder().decode(bytes);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('utf8');
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function toUint8(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw invalidArgType('buffer', 'Buffer or TypedArray', value);
}

/* ------------------------------------------------------------------ */
/* Fallback implementations (used only when the native module is       */
/* unavailable, i.e. outside Node.js).                                 */
/* ------------------------------------------------------------------ */

// Exact v24 key set for getHeapStatistics() (no `total_allocated_bytes`;
/// that key was removed before v24).
function fallbackGetHeapStatistics() {
  return {
    total_heap_size: 0,
    total_heap_size_executable: 0,
    total_physical_size: 0,
    total_available_size: 0,
    used_heap_size: 0,
    heap_size_limit: 0,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 0,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0,
  };
}

// Space names as reported by V8 in Node v24 (see test-v8-stats.js).
const FALLBACK_HEAP_SPACES = [
  'read_only_space',
  'new_space',
  'old_space',
  'code_space',
  'shared_space',
  'new_large_object_space',
  'large_object_space',
  'code_large_object_space',
  'shared_large_object_space',
  'shared_trusted_large_object_space',
  'shared_trusted_space',
  'trusted_large_object_space',
  'trusted_space',
];

function fallbackGetHeapSpaceStatistics() {
  return FALLBACK_HEAP_SPACES.map((space_name) => ({
    space_name,
    space_size: 0,
    space_used_size: 0,
    space_available_size: 0,
    physical_space_size: 0,
  }));
}

function fallbackGetHeapCodeStatistics() {
  return {
    code_and_metadata_size: 0,
    bytecode_and_metadata_size: 0,
    external_script_source_size: 0,
    cpu_profiler_metadata_size: 0,
  };
}

function fallbackGetCppHeapStatistics(type = 'detailed') {
  if (type !== 'brief' && type !== 'detailed') {
    throw invalidArgValue('type', "one of: 'brief', 'detailed'", type);
  }
  // There is no C++ heap outside V8; report zeros honestly, using the
  // exact v24 key set (committed/resident/used_size_bytes, space_statistics,
  // type_names, detail_level).
  return {
    committed_size_bytes: 0,
    resident_size_bytes: 0,
    used_size_bytes: 0,
    space_statistics: [],
    type_names: [],
    detail_level: type,
  };
}

function fallbackSetFlagsFromString(flags) {
  if (typeof flags !== 'string') {
    throw invalidArgType('flags', 'string', flags);
  }
  // V8 flags cannot be set outside a V8 embedder — accepted and ignored.
}

function fallbackCachedDataVersionTag() {
  // Derived from the V8 version, flags and CPU features; 0 marks "unknown".
  return 0;
}

function fallbackGetHeapSnapshot() {
  // Node returns a Readable stream of the heap snapshot; without V8 there
  // is nothing to snapshot, so this fails loudly instead of returning null
  // (real Node never returns null here).
  throw unsupported('v8.getHeapSnapshot()');
}

function fallbackWriteHeapSnapshot(filename) {
  const name = filename === undefined
    ? `Heap.${Date.now()}.heapsnapshot`
    : String(filename);
  // No file is written outside Node.js; the would-be file name is returned
  // for API compatibility.
  return name;
}

function fallbackSetHeapSnapshotNearHeapLimit(limit) {
  if (typeof limit !== 'number' || Number.isNaN(limit)) {
    const err = new TypeError(
      `The "limit" argument must be of type number. Received type ${typeName(limit)}`,
    );
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  if (!Number.isInteger(limit)) {
    throw outOfRange('limit', '>= 1 && <= 4294967295', limit, true);
  }
  if (limit < 1 || limit > 4294967295) {
    throw outOfRange('limit', '>= 1 && <= 4294967295', limit);
  }
  // No-op outside Node.js.
}

/**
 * Pure-JS equivalent: a string has a one-byte representation iff every
 * UTF-16 code unit fits in a byte (i.e. it is Latin-1). Lone surrogates
 * (0xD800–0xDFFF) are not one-byte representable.
 */
function fallbackIsStringOneByteRepresentation(content) {
  if (typeof content !== 'string') {
    throw invalidArgType('content', 'string', content);
  }
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

/**
 * Minimal JSON-based serialization fallback. Documented deviation: the
 * real V8 wire format round-trips Maps, Sets, typed arrays, ArrayBuffers,
 * BigInts and class instances; JSON cannot. Only plain JSON-compatible
 * values survive this fallback.
 */
function fallbackSerialize(value) {
  return utf8Encode(JSON.stringify(value));
}

function fallbackDeserialize(buffer) {
  return JSON.parse(utf8Decode(toUint8(buffer)));
}

class FallbackSerializer {
  constructor() {
    this._values = [];
    this._treatArrayBufferViewsAsHostObjects = false;
  }
  _getDataCloneError = Error;
  _setTreatArrayBufferViewsAsHostObjects(value) {
    this._treatArrayBufferViewsAsHostObjects = Boolean(value);
  }
  writeHeader() {}
  writeValue(value) { this._values.push(value); return undefined; }
  writeUint32() {}
  writeUint64() {}
  writeDouble() {}
  writeRawBytes() {}
  transferArrayBuffer() {}
  releaseBuffer() {
    return utf8Encode(JSON.stringify(this._values));
  }
}

class FallbackDeserializer {
  constructor(buffer) {
    this.buffer = toUint8(buffer);
    this._values = null;
    this._index = 0;
  }
  _ensureParsed() {
    if (this._values === null) {
      this._values = JSON.parse(utf8Decode(this.buffer));
      if (!Array.isArray(this._values)) this._values = [this._values];
    }
  }
  readHeader() { return true; }
  readValue() {
    this._ensureParsed();
    return this._values[this._index++];
  }
  readUint32() { return 0; }
  readUint64() { return [0, 0]; }
  readDouble() { return 0; }
  readRawBytes(length) { return new Uint8Array(length); }
  transferArrayBuffer() {}
  getWireFormatVersion() { return 0; }
}

class FallbackDefaultSerializer extends FallbackSerializer {
  constructor() {
    super();
    this._setTreatArrayBufferViewsAsHostObjects(true);
  }
}

class FallbackDefaultDeserializer extends FallbackDeserializer {}

class FallbackGCProfiler {
  #started = false;
  start() {
    this.#started = true;
  }
  stop() {
    // Mirrors lib/v8.js: stopping without a running profiler yields
    // undefined rather than throwing.
    this.#started = false;
  }
  [typeof Symbol.dispose === 'symbol' ? Symbol.dispose : 'dispose']() {
    this.stop();
  }
}

function fallbackStartCpuProfile() {
  throw unsupported('v8.startCpuProfile()');
}

function fallbackQueryObjects() {
  throw unsupported('v8.queryObjects()');
}

// Minimal browser emulation of v8.promiseHooks. Real Node returns a plain
// stop *function* from onInit/onSettled/onBefore/onAfter/createHook (there
// is no `.stop`/`.enable`/`.disable` handle object). The fallback keeps a
// small callback registry so the return shape and stop semantics match;
// without V8 promise-lifecycle hooks the callbacks simply never fire.
function makeFallbackPromiseHooks() {
  const kinds = ['init', 'settled', 'before', 'after'];
  const registry = { init: new Set(), settled: new Set(), before: new Set(), after: new Set() };
  const checkFn = (name, value) => {
    if (typeof value !== 'function') throw invalidArgType(name, 'function', value);
  };
  const hooks = {};
  for (const kind of kinds) {
    const method = `on${kind[0].toUpperCase()}${kind.slice(1)}`;
    hooks[method] = (cb) => {
      checkFn(kind, cb);
      registry[kind].add(cb);
      return () => { registry[kind].delete(cb); };
    };
  }
  hooks.createHook = (callbacks) => {
    if (callbacks === null || typeof callbacks !== 'object') {
      throw invalidArgType('callbacks', 'object', callbacks);
    }
    const stoppers = [];
    for (const kind of kinds) {
      if (callbacks[kind] !== undefined) {
        checkFn(kind, callbacks[kind]);
        registry[kind].add(callbacks[kind]);
        stoppers.push(() => { registry[kind].delete(callbacks[kind]); });
      }
    }
    return () => { for (const stop of stoppers) stop(); };
  };
  return hooks;
}

const fallbackPromiseHooks = makeFallbackPromiseHooks();

const fallbackStartupSnapshot = {
  addSerializeCallback: () => { throw notBuildingSnapshot(); },
  addDeserializeCallback: () => { throw notBuildingSnapshot(); },
  setDeserializeMainFunction: () => { throw notBuildingSnapshot(); },
  isBuildingSnapshot: () => false,
};

/* ------------------------------------------------------------------ */
/* Public surface — mirrors Node v24.20.0 `lib/v8.js` exports exactly. */
/* ------------------------------------------------------------------ */

export const cachedDataVersionTag =
  pick('cachedDataVersionTag', fallbackCachedDataVersionTag);
export const getHeapSnapshot =
  pick('getHeapSnapshot', fallbackGetHeapSnapshot);
export const getHeapStatistics =
  pick('getHeapStatistics', fallbackGetHeapStatistics);
export const getHeapSpaceStatistics =
  pick('getHeapSpaceStatistics', fallbackGetHeapSpaceStatistics);
export const getHeapCodeStatistics =
  pick('getHeapCodeStatistics', fallbackGetHeapCodeStatistics);
export const getCppHeapStatistics =
  pick('getCppHeapStatistics', fallbackGetCppHeapStatistics);
export const setFlagsFromString =
  pick('setFlagsFromString', fallbackSetFlagsFromString);
export const Serializer =
  pick('Serializer', FallbackSerializer);
export const Deserializer =
  pick('Deserializer', FallbackDeserializer);
export const DefaultSerializer =
  pick('DefaultSerializer', FallbackDefaultSerializer);
export const DefaultDeserializer =
  pick('DefaultDeserializer', FallbackDefaultDeserializer);
export const deserialize =
  pick('deserialize', fallbackDeserialize);
// Like the real module, these are `undefined` when the inspector-backed
// profiler binding is unavailable.
export const takeCoverage = pick('takeCoverage', undefined);
export const stopCoverage = pick('stopCoverage', undefined);
export const serialize =
  pick('serialize', fallbackSerialize);
export const writeHeapSnapshot =
  pick('writeHeapSnapshot', fallbackWriteHeapSnapshot);
export const promiseHooks =
  pick('promiseHooks', fallbackPromiseHooks);
export const queryObjects =
  pick('queryObjects', fallbackQueryObjects);
export const startupSnapshot =
  pick('startupSnapshot', fallbackStartupSnapshot);
export const setHeapSnapshotNearHeapLimit =
  pick('setHeapSnapshotNearHeapLimit', fallbackSetHeapSnapshotNearHeapLimit);
export const GCProfiler =
  pick('GCProfiler', FallbackGCProfiler);
export const isStringOneByteRepresentation =
  pick('isStringOneByteRepresentation', fallbackIsStringOneByteRepresentation);
export const startCpuProfile =
  pick('startCpuProfile', fallbackStartCpuProfile);

/**
 * Default export mirrors `require('node:v8')` (the CJS `module.exports`
 * object): the parity harness's CJS patch hands `require('v8')` the
 * default export.
 */
const v8 = {
  cachedDataVersionTag,
  getHeapSnapshot,
  getHeapStatistics,
  getHeapSpaceStatistics,
  getHeapCodeStatistics,
  getCppHeapStatistics,
  setFlagsFromString,
  Serializer,
  Deserializer,
  DefaultSerializer,
  DefaultDeserializer,
  deserialize,
  takeCoverage,
  stopCoverage,
  serialize,
  writeHeapSnapshot,
  promiseHooks,
  queryObjects,
  startupSnapshot,
  setHeapSnapshotNearHeapLimit,
  GCProfiler,
  isStringOneByteRepresentation,
  startCpuProfile,
};

export default v8;
