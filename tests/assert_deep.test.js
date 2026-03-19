import assert, {
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  strictEqual,
  notStrictEqual,
  throws,
  AssertionError
} from '../src/assert.js';

describe('assert-web deep equality behavior', () => {
  test('Uint8Array vs Buffer', () => {
    const arr = new Uint8Array([120, 121, 122, 10]);
    const buf = Buffer.from(arr);

    expect(() => deepStrictEqual(arr, buf)).toThrow(AssertionError);
    expect(() => deepEqual(arr, buf)).not.toThrow();
  });

  test('extra properties break strict equality', () => {
    const buf1 = Buffer.from([1, 2]);
    const buf2 = Buffer.from([1, 2]);
    buf2.foo = 1;

    expect(() => deepStrictEqual(buf1, buf2)).toThrow(AssertionError);
    expect(() => notDeepEqual(buf1, buf2)).not.toThrow();
  });

  test('loose vs strict equality', () => {
    expect(() => deepEqual(4, '4')).not.toThrow();
    expect(() => deepStrictEqual(4, '4')).toThrow(AssertionError);
  });

  test('NaN handling', () => {
    expect(() => deepStrictEqual(NaN, NaN)).not.toThrow();
    expect(() => deepStrictEqual({ a: NaN }, { a: NaN })).not.toThrow();
  });

  test('Dates', () => {
    const a = new Date('2016');
    const b = new Date('2016');

    expect(() => deepStrictEqual(a, b)).not.toThrow();

    const c = new Date('2017');
    expect(() => deepStrictEqual(a, c)).toThrow(AssertionError);
  });

  test('RegExp', () => {
    expect(() => deepStrictEqual(/a/g, /a/g)).not.toThrow();
    expect(() => deepStrictEqual(/a/g, /a/)).toThrow(AssertionError);
  });

  test('Arrays', () => {
    expect(() => deepStrictEqual([1, 2], [1, 2])).not.toThrow();
    expect(() => deepStrictEqual([1, 2], [2, 1])).toThrow();
  });

  test('Objects', () => {
    expect(() => deepStrictEqual({ a: 1 }, { a: 1 })).not.toThrow();
    expect(() => deepStrictEqual({ a: 1 }, { b: 1 })).toThrow();
  });

  test('Set equality', () => {
    expect(() =>
      deepStrictEqual(new Set([1, 2]), new Set([2, 1]))
    ).not.toThrow();

    expect(() =>
      deepStrictEqual(new Set([1]), new Set([2]))
    ).toThrow();
  });

  test('Map equality', () => {
    expect(() =>
      deepStrictEqual(
        new Map([[1, 'a']]),
        new Map([[1, 'a']])
      )
    ).not.toThrow();

    expect(() =>
      deepStrictEqual(
        new Map([[1, 'a']]),
        new Map([[1, 'b']])
      )
    ).toThrow();
  });

  test('Errors', () => {
    expect(() =>
      deepStrictEqual(new Error('foo'), new Error('foo'))
    ).not.toThrow();

    expect(() =>
      deepStrictEqual(new Error('foo'), new Error('bar'))
    ).toThrow();
  });

  test('boxed primitives', () => {
    expect(() =>
      deepStrictEqual(Object(1), Object(1))
    ).not.toThrow();

    expect(() =>
      deepStrictEqual(Object(1), Object(2))
    ).toThrow();
  });

  test('symbols', () => {
    const s = Symbol();
    expect(() => deepStrictEqual(s, s)).not.toThrow();

    expect(() =>
      deepStrictEqual(Symbol(), Symbol())
    ).toThrow();
  });

  test('throws behavior', () => {
    expect(() =>
      throws(() => {
        throw new Error('boom');
      })
    ).not.toThrow();

    expect(() =>
      throws(() => {})
    ).toThrow(AssertionError);
  });

  test('strictEqual basics', () => {
    expect(() => strictEqual(1, 1)).not.toThrow();
    expect(() => strictEqual(1, '1')).toThrow();
  });

  test('notStrictEqual basics', () => {
    expect(() => notStrictEqual(1, 2)).not.toThrow();
    expect(() => notStrictEqual(1, 1)).toThrow();
  });
});
