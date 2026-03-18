// adjust path if needed
import strict, * as named from '../src/assert/strict.js';

describe('assert-strict-web', () => {

  // -------------------------------------------------------------------------
  // shape / exports
  // -------------------------------------------------------------------------
  describe('exports shape', () => {
    test('default export exists', () => {
      expect(strict).toBeDefined();
    });

    test('named exports exist', () => {
      expect(named.ok).toBeDefined();
      expect(named.equal).toBeDefined();
      expect(named.deepEqual).toBeDefined();
      expect(named.throws).toBeDefined();
    });

    test('default contains same methods', () => {
      expect(strict.ok).toBe(named.ok);
      expect(strict.equal).toBe(named.equal);
      expect(strict.deepEqual).toBe(named.deepEqual);
    });

    test('self-referential strict', () => {
      expect(strict.strict).toBeDefined();
      expect(strict.strict).toBe(strict.strict.strict);
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
      expect(named[method]).toBe(strict[method]);
    });
  });

  // -------------------------------------------------------------------------
  // equality (strict behavior)
  // -------------------------------------------------------------------------
  describe('equality (strict)', () => {
    test('equal behaves like strictEqual', () => {
      expect(() => named.equal(1, '1')).toThrow();
      expect(() => named.equal(1, 1)).not.toThrow();
    });

    test('deepEqual behaves like deepStrictEqual', () => {
      expect(() => named.deepEqual({ a: 1 }, { a: 1 })).not.toThrow();
      expect(() => named.deepEqual(1, '1')).toThrow();
    });

    test('notEqual behaves like notStrictEqual', () => {
      expect(() => named.notEqual(1, 1)).toThrow();
      expect(() => named.notEqual(1, '1')).not.toThrow();
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

    test('ifError throws on truthy', () => {
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
      expect(strict.AssertionError).toBeDefined();
    });

    test('throws AssertionError instances', () => {
      try {
        named.equal(1, '1');
      } catch (err) {
        expect(err).toBeInstanceOf(strict.AssertionError);
      }
    });
  });

});
