// adjust path if needed
import assertDefault, * as named from '../src/assert.js';

describe('assert-web (non-strict)', () => {

  // -------------------------------------------------------------------------
  // exports shape
  // -------------------------------------------------------------------------
  describe('exports shape', () => {
    test('default export exists', () => {
      expect(assertDefault).toBeDefined();
    });

    test('named exports exist', () => {
      expect(named.ok).toBeDefined();
      expect(named.equal).toBeDefined();
      expect(named.deepEqual).toBeDefined();
      expect(named.throws).toBeDefined();
    });

    test('default contains same methods', () => {
      expect(assertDefault.ok).toBe(named.ok);
      expect(assertDefault.equal).toBe(named.equal);
      expect(assertDefault.deepEqual).toBe(named.deepEqual);
    });
  });

  // -------------------------------------------------------------------------
  // reference identity
  // -------------------------------------------------------------------------
  describe('reference identity', () => {
    test.each([
      'ok',
      'equal',
      'deepEqual',
      'strictEqual',
      'throws',
      'match',
    ])('%s matches default reference', (method) => {
      expect(named[method]).toBe(assertDefault[method]);
    });
  });

  // -------------------------------------------------------------------------
  // equality (non-strict)
  // -------------------------------------------------------------------------
  describe('equality (non-strict)', () => {
    test('equal allows type coercion', () => {
      expect(() => named.equal(1, '1')).not.toThrow();
      expect(() => named.equal(1, 1)).not.toThrow();
    });

    test('notEqual allows type coercion', () => {
      expect(() => named.notEqual(1, 2)).not.toThrow();
      expect(() => named.notEqual(1, '1')).toThrow();
    });

    test('deepEqual compares structurally but non-strict', () => {
      expect(() => named.deepEqual({ a: 1 }, { a: 1 })).not.toThrow();
      // Non-strict deepEqual may coerce, e.g., 1 vs '1'
      expect(() => named.deepEqual({ a: 1 }, { a: '1' })).not.toThrow();
    });

    test('strictEqual still enforces strict equality', () => {
      expect(() => named.strictEqual(1, 1)).not.toThrow();
      expect(() => named.strictEqual(1, '1')).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // ok / fail / ifError
  // -------------------------------------------------------------------------
  describe('core assertions', () => {
    test('ok passes for truthy', () => {
      expect(() => named.ok(1)).not.toThrow();
    });

    test('ok throws for falsy', () => {
      expect(() => named.ok(0)).toThrow();
    });

    test('fail always throws', () => {
      expect(() => named.fail('boom')).toThrow();
    });

    test('ifError throws on truthy error', () => {
      expect(() => named.ifError(new Error('err'))).toThrow();
    });

    test('ifError does not throw on null/undefined', () => {
      expect(() => named.ifError(null)).not.toThrow();
      expect(() => named.ifError(undefined)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // throws / doesNotThrow
  // -------------------------------------------------------------------------
  describe('sync error assertions', () => {
    test('throws detects error', () => {
      expect(() => named.throws(() => {
        throw new TypeError('boom');
      }, TypeError)).not.toThrow();
    });

    test('throws fails when no error', () => {
      expect(() => named.throws(() => {})).toThrow();
    });

    test('doesNotThrow passes when no error', () => {
      expect(() => named.doesNotThrow(() => 42)).not.toThrow();
    });

    test('doesNotThrow fails when error thrown', () => {
      expect(() => named.doesNotThrow(() => {
        throw new Error('fail');
      })).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // async assertions
  // -------------------------------------------------------------------------
  describe('async assertions', () => {
    test('rejects detects rejection', async () => {
      await expect(
        named.rejects(Promise.reject(new Error('oops')))
      ).resolves.toBeUndefined();
    });

    test('rejects fails on resolve', async () => {
      await expect(
        named.rejects(Promise.resolve('ok'))
      ).rejects.toThrow();
    });

    test('doesNotReject passes on resolve', async () => {
      await expect(
        named.doesNotReject(Promise.resolve('ok'))
      ).resolves.toBeUndefined();
    });

    test('doesNotReject fails on rejection', async () => {
      await expect(
        named.doesNotReject(Promise.reject(new Error('fail')))
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // regex match
  // -------------------------------------------------------------------------
  describe('match / doesNotMatch', () => {
    test('match passes when regex matches', () => {
      expect(() => named.match('hello world', /world/)).not.toThrow();
    });

    test('match throws when no match', () => {
      expect(() => named.match('hello', /world/)).toThrow();
    });

    test('doesNotMatch passes when no match', () => {
      expect(() => named.doesNotMatch('hello', /world/)).not.toThrow();
    });

    test('doesNotMatch throws when matches', () => {
      expect(() => named.doesNotMatch('hello world', /world/)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // AssertionError exposure
  // -------------------------------------------------------------------------
  describe('AssertionError', () => {
    test('is exposed on default export', () => {
      expect(assertDefault.AssertionError).toBeDefined();
    });

    test('throws AssertionError instances', () => {
      try {
        named.equal(1, 2);
      } catch (err) {
        expect(err).toBeInstanceOf(assertDefault.AssertionError);
      }
    });
  });

});
