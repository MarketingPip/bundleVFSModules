/**
 * v8 shim - Spec-compliant stubs for Node.js v25.x (2026)
 * V8 engine internals are not available in browser.
 */

// --- Heap Statistics ---

/**
 * Generates mock heap statistics.
 * In a real Node environment, these values are dynamic.
 */
export function getHeapStatistics() {
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
    number_of_native_contexts: 1,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: 0,
    total_allocated_bytes: 0,
  };
}

/**
 * Returns an array of statistics for each V8 heap space.
 */
export function getHeapSpaceStatistics() {
  const spaces = [
    'read_only_space', 
    'new_space', 
    'old_space', 
    'code_space', 
    'shared_space', 
    'new_large_object_space', 
    'large_object_space', 
    'code_large_object_space', 
    'shared_large_object_space'
  ];
  return spaces.map(name => ({
    space_name: name,
    space_size: 0,
    space_used_size: 0,
    space_available_size: 0,
    physical_space_size: 0,
  }));
}

export function getHeapCodeStatistics() {
  return {
    code_and_metadata_size: 0,
    bytecode_and_metadata_size: 0,
    external_script_source_size: 0,
    cpu_profiler_metadata_size: 0,
  };
}

export function getCppHeapStatistics() {
  return {
    total_allocated_size: 0,
    used_size: 0,
  };
}

// --- Snapshots ---

export function getHeapSnapshot() {
  // In Node, this returns a Readable stream. 
  // We return null or a dummy object to prevent crashes.
  return null;
}

export function writeHeapSnapshot(filename) {
  return filename || `Heap-${Date.now()}.heapsnapshot`;
}

// --- Serialization ---
// Note: JSON is used here as a safe browser-compatible fallback for the 
// binary V8 wire format, though it doesn't support Map, Set, or BigInt.

export function serialize(value) {
  return Buffer.from(JSON.stringify(value));
}

export function deserialize(buffer) {
  return JSON.parse(buffer.toString());
}

export class Serializer {
  writeHeader() {}
  writeValue(value) {}
  writeUint32(value) {}
  writeUint64(hi, lo) {}
  writeDouble(value) {}
  writeRawBytes(buffer) {}
  transferArrayBuffer(id, arrayBuffer) {}
  releaseBuffer() {
    return Buffer.alloc(0);
  }
}

export class Deserializer {
  constructor(buffer) {
    this.buffer = buffer;
  }
  readHeader() { return true; }
  readValue() { return null; }
  readUint32() { return 0; }
  readUint64() { return [0, 0]; }
  readDouble() { return 0; }
  readRawBytes(length) { return Buffer.alloc(0); }
  transferArrayBuffer(id, arrayBuffer) {}
  getWireFormatVersion() { return 0; }
}

export class DefaultSerializer extends Serializer {}
export class DefaultDeserializer extends Deserializer {}

// --- Profiling & Diagnostics ---

export class GCProfiler {
  start() {}
  stop() {
    return { version: 1, startTime: Date.now(), statistics: [] };
  }
}

export function setFlagsFromString(flags) {}
export function takeCoverage() {}
export function stopCoverage() {}
export function cachedDataVersionTag() { return 0; }

// --- Startup Snapshot API ---

export const startupSnapshot = {
  addSerializeCallback: (cb, data) => {},
  addDeserializeCallback: (cb, data) => {},
  setDeserializeMainFunction: (cb, data) => {},
  isBuildingSnapshot: () => false,
};

// --- Promise Hooks ---

export const promiseHooks = {
  onInit: (cb) => ({ stop: () => {} }),
  onSettled: (cb) => ({ stop: () => {} }),
  onBefore: (cb) => ({ stop: () => {} }),
  onAfter: (cb) => ({ stop: () => {} }),
  createHook: (callbacks) => ({ enable: () => {}, disable: () => {} }),
};

// Default export for ESM compatibility
export default {
  getHeapStatistics,
  getHeapSpaceStatistics,
  getHeapCodeStatistics,
  getCppHeapStatistics,
  getHeapSnapshot,
  writeHeapSnapshot,
  setFlagsFromString,
  cachedDataVersionTag,
  serialize,
  deserialize,
  Serializer,
  Deserializer,
  DefaultSerializer,
  DefaultDeserializer,
  GCProfiler,
  startupSnapshot,
  promiseHooks,
  takeCoverage,
  stopCoverage,
};
