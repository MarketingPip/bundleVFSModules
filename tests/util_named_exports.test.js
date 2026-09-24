// util.diff + util.setTraceSigInt (Node v24.20.0 parity).
import util, { diff, setTraceSigInt } from '../src/util.js';
import * as ns from '../src/util.js';
import nodeUtil from 'node:util';
import { describe, test, expect } from '@jest/globals';

describe('util named exports', () => {
  test('diff and setTraceSigInt are present and identical to the default object', () => {
    expect('diff' in ns).toBe(true);
    expect('setTraceSigInt' in ns).toBe(true);
    expect(diff).toBe(util.diff);
    expect(setTraceSigInt).toBe(util.setTraceSigInt);
  });

  test('setTraceSigInt is a noop returning undefined', () => {
    expect(setTraceSigInt(true)).toBe(undefined);
    expect(setTraceSigInt(false)).toBe(undefined);
    expect(setTraceSigInt()).toBe(undefined);
    expect(setTraceSigInt('junk')).toBe(undefined);
  });
});

describe('util.diff parity with real Node', () => {
  const cases = [
    ['a\nb\nc', 'a\nx\nc'],
    ['a', 'a'],
    ['', ''],
    ['a', 'b'],
    ['ab', ''],
    ['', 'ab'],
    ['hello world', 'hello brave new world'],
    [['a', 'b'], ['a', 'c']],
    [[], ['x']],
    [['x'], ['x', 'y']],
  ];

  for (const [actual, expected] of cases) {
    test(`diff(${JSON.stringify(actual)}, ${JSON.stringify(expected)})`, () => {
      expect(diff(actual, expected)).toEqual(nodeUtil.diff(actual, expected));
    });
  }

  test('diff([], []) throws exactly like real Node', () => {
    // Genuine Node edge case: myersDiff returns undefined for two empty
    // arrays and the generic Array.prototype.reverse throws
    // `TypeError: Cannot convert undefined or null to object`.
    const expected = (() => {
      try { nodeUtil.diff([], []); } catch (e) { return `${e.constructor.name}: ${e.message}`; }
    })();
    const actual = (() => {
      try { diff([], []); } catch (e) { return `${e.constructor.name}: ${e.message}`; }
    })();
    expect(actual).toBe(expected);
  });

  test('equal inputs produce []', () => {
    expect(diff('same', 'same')).toEqual([]);
    expect(nodeUtil.diff('same', 'same')).toEqual([]);
  });

  test('op codes mean the same as Node (-1/0/1)', () => {
    const out = diff(['a', 'b'], ['a', 'c']);
    expect(out).toEqual([[0, 'a'], [1, 'b'], [-1, 'c']]);
    expect(out).toEqual(nodeUtil.diff(['a', 'b'], ['a', 'c']));
  });

  test('rejects non-string/non-array with ERR_INVALID_ARG_TYPE', () => {
    expect(() => diff({}, 'x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => diff('x', {})).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    expect(() => diff(['a', 1], ['a'])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
    );
    expect(() => diff(null, 'x')).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }),
    );
  });

  test('error messages match real Node', () => {
    const expected = (() => {
      try { nodeUtil.diff({}, 'x'); } catch (e) { return e.message; }
    })();
    const actual = (() => {
      try { diff({}, 'x'); } catch (e) { return e.message; }
    })();
    expect(actual).toBe(expected);
  });
});
