import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { unlinkSync } from 'node:fs';
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
    test('returns an object with the exact Node v24 numeric key set', () => {
      const stats = getHeapStatistics();
      // Real Node has exactly these 14 keys — notably there is no
      // `total_allocated_bytes` (removed long before v24).
      const expectedKeys = [
        'total_heap_size', 'total_heap_size_executable', 'total_physical_size',
        'total_available_size', 'used_heap_size', 'heap_size_limit',
        'malloced_memory', 'peak_malloced_memory', 'does_zap_garbage',
        'number_of_native_contexts', 'number_of_detached_contexts',
        'total_global_handles_size', 'used_global_handles_size',
        'external_memory',
      ];
      expect(Object.keys(stats).sort()).toEqual([...expectedKeys].sort());
      for (const key of expectedKeys) {
        expect(typeof stats[key]).toBe('number');
      }
    });
  });

  describe('getHeapSpaceStatistics()', () => {
    test('returns a non-empty array of space objects', () => {
      const spaces = getHeapSpaceStatistics();
      expect(Array.isArray(spaces)).toBe(true);
      // The count is V8-version-dependent (13 in Node v24.20.0), so assert
      // shape rather than an exact length.
      expect(spaces.length).toBeGreaterThan(0);
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
    test('returns object with the real v24 key set', () => {
      const stats = getCppHeapStatistics();
      expect(typeof stats.committed_size_bytes).toBe('number');
      expect(typeof stats.resident_size_bytes).toBe('number');
      expect(typeof stats.used_size_bytes).toBe('number');
      expect(Array.isArray(stats.space_statistics)).toBe(true);
      expect(Array.isArray(stats.type_names)).toBe(true);
      expect(stats.detail_level).toBe('detailed');
    });

    test("honours the 'brief' detail level", () => {
      expect(getCppHeapStatistics('brief').detail_level).toBe('brief');
    });

    test('rejects an invalid detail level like Node', () => {
      expect(() => getCppHeapStatistics('bogus')).toThrow(
        expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }),
      );
    });
  });

  describe('getHeapSnapshot()', () => {
    test('returns a readable stream of the snapshot (real Node behaviour)', () => {
      const snapshot = getHeapSnapshot();
      expect(typeof snapshot.pipe).toBe('function');
      expect(typeof snapshot.read).toBe('function');
      snapshot.destroy();
    });
  });

  describe('writeHeapSnapshot()', () => {
    const created = [];
    afterEach(() => {
      for (const f of created.splice(0)) {
        try { unlinkSync(f); } catch { /* already gone */ }
      }
    });

    test('returns provided filename when given', () => {
      const name = `test-${Date.now()}.heapsnapshot`;
      expect(writeHeapSnapshot(name)).toBe(name);
      created.push(name);
    });

    test('returns a generated filename when called without arguments', () => {
      const result = writeHeapSnapshot();
      expect(typeof result).toBe('string');
      expect(result).toMatch(/\.heapsnapshot$/);
      created.push(result);
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

    test('readHeader() throws on invalid data (matches Node)', () => {
      const d = new Deserializer(Buffer.alloc(8));
      expect(() => d.readHeader()).toThrow(/Unable to deserialize/);
    });

    test('reads back real Serializer output', () => {
      const d = new Deserializer(serialize({ a: 1 }));
      expect(d.readHeader()).toBe(true);
      expect(d.readValue()).toEqual({ a: 1 });
    });

    test('getWireFormatVersion() returns a number', () => {
      expect(typeof new Deserializer(serialize(1)).getWireFormatVersion()).toBe('number');
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

    test('isBuildingSnapshot() is falsy (real Node returns 0)', () => {
      expect(startupSnapshot.isBuildingSnapshot()).toBeFalsy();
    });

    test('callbacks throw when not building a snapshot (matches Node)', () => {
      expect(() => startupSnapshot.addSerializeCallback(() => {}, {}))
        .toThrow(/not building startup snapshot/);
      expect(() => startupSnapshot.addDeserializeCallback(() => {}, {}))
        .toThrow(/not building startup snapshot/);
      expect(() => startupSnapshot.setDeserializeMainFunction(() => {}, {}))
        .toThrow(/not building startup snapshot/);
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

    test('individual hooks return a stop function (matches Node)', () => {
      for (const method of ['onInit', 'onSettled', 'onBefore', 'onAfter']) {
        const stop = promiseHooks[method](() => {});
        expect(typeof stop).toBe('function');
        expect(() => stop()).not.toThrow();
      }
    });

    test('a registered init hook fires, then stops firing after stop()', async () => {
      let calls = 0;
      const stop = promiseHooks.onInit(() => { calls++; });
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBeGreaterThan(0);
      stop();
      const afterStop = calls;
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toBe(afterStop);
    });

    test('createHook() returns a stop function (matches Node)', () => {
      const stop = promiseHooks.createHook({ init: () => {} });
      expect(typeof stop).toBe('function');
      expect(() => stop()).not.toThrow();
    });
  });
});
