import { jest, describe, test, expect } from '@jest/globals';
import v8, {
  getHeapStatistics,
  getHeapSpaceStatistics,
  getHeapCodeStatistics,
  getCppHeapStatistics,
  getHeapSnapshot,
  writeHeapSnapshot,
  serialize,
  deserialize,
  Serializer,
  Deserializer,
  DefaultSerializer,
  DefaultDeserializer,
  GCProfiler,
  setFlagsFromString,
  takeCoverage,
  stopCoverage,
  cachedDataVersionTag,
  startupSnapshot,
  promiseHooks,
} from '../src/v8.js';

describe('v8 shim', () => {
  describe('module shape', () => {
    test('default export contains all expected members', () => {
      expect(v8.getHeapStatistics).toBe(getHeapStatistics);
      expect(v8.getHeapSpaceStatistics).toBe(getHeapSpaceStatistics);
      expect(v8.getHeapCodeStatistics).toBe(getHeapCodeStatistics);
      expect(v8.getCppHeapStatistics).toBe(getCppHeapStatistics);
      expect(v8.getHeapSnapshot).toBe(getHeapSnapshot);
      expect(v8.writeHeapSnapshot).toBe(writeHeapSnapshot);
      expect(v8.serialize).toBe(serialize);
      expect(v8.deserialize).toBe(deserialize);
      expect(v8.Serializer).toBe(Serializer);
      expect(v8.Deserializer).toBe(Deserializer);
      expect(v8.DefaultSerializer).toBe(DefaultSerializer);
      expect(v8.DefaultDeserializer).toBe(DefaultDeserializer);
      expect(v8.GCProfiler).toBe(GCProfiler);
      expect(v8.startupSnapshot).toBe(startupSnapshot);
      expect(v8.promiseHooks).toBe(promiseHooks);
      expect(v8.takeCoverage).toBe(takeCoverage);
      expect(v8.stopCoverage).toBe(stopCoverage);
    });
  });

  describe('getHeapStatistics()', () => {
    test('returns an object with all expected numeric keys', () => {
      const stats = getHeapStatistics();
      const expectedKeys = [
        'total_heap_size', 'total_heap_size_executable', 'total_physical_size',
        'total_available_size', 'used_heap_size', 'heap_size_limit',
        'malloced_memory', 'peak_malloced_memory', 'does_zap_garbage',
        'number_of_native_contexts', 'number_of_detached_contexts',
        'total_global_handles_size', 'used_global_handles_size',
        'external_memory', 'total_allocated_bytes',
      ];
      for (const key of expectedKeys) {
        expect(stats).toHaveProperty(key);
        expect(typeof stats[key]).toBe('number');
      }
    });
  });

  describe('getHeapSpaceStatistics()', () => {
    test('returns an array of 9 space objects', () => {
      const spaces = getHeapSpaceStatistics();
      expect(Array.isArray(spaces)).toBe(true);
      expect(spaces).toHaveLength(9);
    });

    test('each space has correct shape', () => {
      for (const space of getHeapSpaceStatistics()) {
        expect(typeof space.space_name).toBe('string');
        expect(typeof space.space_size).toBe('number');
        expect(typeof space.space_used_size).toBe('number');
        expect(typeof space.space_available_size).toBe('number');
        expect(typeof space.physical_space_size).toBe('number');
      }
    });

    test('includes expected space names', () => {
      const names = getHeapSpaceStatistics().map(s => s.space_name);
      expect(names).toContain('old_space');
      expect(names).toContain('new_space');
      expect(names).toContain('code_space');
      expect(names).toContain('large_object_space');
    });
  });

  describe('getHeapCodeStatistics()', () => {
    test('returns object with expected numeric keys', () => {
      const stats = getHeapCodeStatistics();
      for (const key of [
        'code_and_metadata_size', 'bytecode_and_metadata_size',
        'external_script_source_size', 'cpu_profiler_metadata_size',
      ]) {
        expect(typeof stats[key]).toBe('number');
      }
    });
  });

  describe('getCppHeapStatistics()', () => {
    test('returns object with total_allocated_size and used_size', () => {
      const stats = getCppHeapStatistics();
      expect(typeof stats.total_allocated_size).toBe('number');
      expect(typeof stats.used_size).toBe('number');
    });
  });

  describe('getHeapSnapshot()', () => {
    test('returns null (no real V8 snapshot in browser)', () => {
      expect(getHeapSnapshot()).toBeNull();
    });
  });

  describe('writeHeapSnapshot()', () => {
    test('returns provided filename when given', () => {
      expect(writeHeapSnapshot('my.heapsnapshot')).toBe('my.heapsnapshot');
    });

    test('returns a generated filename when called without arguments', () => {
      const result = writeHeapSnapshot();
      expect(typeof result).toBe('string');
      expect(result).toMatch(/\.heapsnapshot$/);
    });
  });

  describe('serialize() / deserialize()', () => {
    test('round-trips a plain object', () => {
      const obj = { a: 1, b: 'hello', c: [1, 2, 3] };
      const buf = serialize(obj);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(deserialize(buf)).toEqual(obj);
    });

    test('round-trips primitives', () => {
      expect(deserialize(serialize(42))).toBe(42);
      expect(deserialize(serialize('str'))).toBe('str');
      expect(deserialize(serialize(null))).toBeNull();
      expect(deserialize(serialize(true))).toBe(true);
    });

    test('round-trips nested objects', () => {
      const nested = { x: { y: { z: 99 } } };
      expect(deserialize(serialize(nested))).toEqual(nested);
    });
  });

  describe('Serializer', () => {
    test('can be instantiated', () => {
      expect(() => new Serializer()).not.toThrow();
    });

    test('stub methods do not throw', () => {
      const s = new Serializer();
      expect(() => s.writeHeader()).not.toThrow();
      expect(() => s.writeValue(42)).not.toThrow();
      expect(() => s.writeUint32(1)).not.toThrow();
      expect(() => s.writeUint64(0, 0)).not.toThrow();
      expect(() => s.writeDouble(3.14)).not.toThrow();
      expect(() => s.writeRawBytes(Buffer.alloc(4))).not.toThrow();
      expect(() => s.transferArrayBuffer(1, new ArrayBuffer(8))).not.toThrow();
    });

    test('releaseBuffer() returns a Buffer', () => {
      expect(Buffer.isBuffer(new Serializer().releaseBuffer())).toBe(true);
    });
  });

  describe('Deserializer', () => {
    test('can be instantiated with a buffer', () => {
      expect(() => new Deserializer(Buffer.alloc(0))).not.toThrow();
    });

    test('stub methods return expected types', () => {
      const d = new Deserializer(Buffer.alloc(8));
      expect(d.readHeader()).toBe(true);
      expect(d.readValue()).toBeNull();
      expect(typeof d.readUint32()).toBe('number');
      expect(Array.isArray(d.readUint64())).toBe(true);
      expect(typeof d.readDouble()).toBe('number');
      expect(Buffer.isBuffer(d.readRawBytes(4))).toBe(true);
      expect(typeof d.getWireFormatVersion()).toBe('number');
    });
  });

  describe('DefaultSerializer / DefaultDeserializer', () => {
    test('DefaultSerializer extends Serializer', () => {
      expect(new DefaultSerializer()).toBeInstanceOf(Serializer);
    });

    test('DefaultDeserializer extends Deserializer', () => {
      expect(new DefaultDeserializer(Buffer.alloc(0))).toBeInstanceOf(Deserializer);
    });
  });

  describe('GCProfiler', () => {
    test('start() does not throw', () => {
      expect(() => new GCProfiler().start()).not.toThrow();
    });

    test('stop() returns expected shape', () => {
      const profiler = new GCProfiler();
      profiler.start();
      const result = profiler.stop();
      expect(result.version).toBe(1);
      expect(typeof result.startTime).toBe('number');
      expect(Array.isArray(result.statistics)).toBe(true);
    });
  });

  describe('setFlagsFromString()', () => {
    test('does not throw', () => {
      expect(() => setFlagsFromString('--harmony')).not.toThrow();
    });
  });

  describe('cachedDataVersionTag()', () => {
    test('returns a number', () => {
      expect(typeof cachedDataVersionTag()).toBe('number');
    });
  });

  describe('takeCoverage() / stopCoverage()', () => {
    test('do not throw', () => {
      expect(() => takeCoverage()).not.toThrow();
      expect(() => stopCoverage()).not.toThrow();
    });
  });

  describe('startupSnapshot', () => {
    test('has expected methods', () => {
      expect(typeof startupSnapshot.addSerializeCallback).toBe('function');
      expect(typeof startupSnapshot.addDeserializeCallback).toBe('function');
      expect(typeof startupSnapshot.setDeserializeMainFunction).toBe('function');
      expect(typeof startupSnapshot.isBuildingSnapshot).toBe('function');
    });

    test('isBuildingSnapshot() returns false', () => {
      expect(startupSnapshot.isBuildingSnapshot()).toBe(false);
    });

    test('callbacks do not throw', () => {
      expect(() => startupSnapshot.addSerializeCallback(() => {}, {})).not.toThrow();
      expect(() => startupSnapshot.addDeserializeCallback(() => {}, {})).not.toThrow();
      expect(() => startupSnapshot.setDeserializeMainFunction(() => {}, {})).not.toThrow();
    });
  });

  describe('promiseHooks', () => {
    test('has expected hook methods', () => {
      expect(typeof promiseHooks.onInit).toBe('function');
      expect(typeof promiseHooks.onSettled).toBe('function');
      expect(typeof promiseHooks.onBefore).toBe('function');
      expect(typeof promiseHooks.onAfter).toBe('function');
      expect(typeof promiseHooks.createHook).toBe('function');
    });

    test('individual hooks return a disposable with stop()', () => {
      for (const method of ['onInit', 'onSettled', 'onBefore', 'onAfter']) {
        const hook = promiseHooks[method](() => {});
        expect(typeof hook.stop).toBe('function');
        expect(() => hook.stop()).not.toThrow();
      }
    });

    test('createHook() returns enable/disable handle', () => {
      const handle = promiseHooks.createHook({ init: () => {} });
      expect(typeof handle.enable).toBe('function');
      expect(typeof handle.disable).toBe('function');
      expect(() => handle.enable()).not.toThrow();
      expect(() => handle.disable()).not.toThrow();
    });
  });
});
